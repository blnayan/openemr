<?php

/**
 * AgentForge upload entry point — POST /interface/agentforge/upload.php
 *
 * Single explicit entry into AgentForge extraction for the Document
 * Inbox tab. Replaces the legacy listener that hung off the Documents
 * tab's `PatientDocumentCreatedEvent`.
 *
 * Multipart form fields:
 *   - patient_id : numeric pid the upload is scoped to
 *   - doc_type   : 'lab_pdf' | 'intake_form' (explicit, no inference)
 *   - file       : the source PDF / PNG / JPEG / WebP bytes
 *
 * Authorization: requires `aclCheckCore('patients', 'docs', '', 'write')`
 * — the same scope the canonical Documents tab guards. Read access is
 * not enough.
 *
 * Response (JSON):
 *   200 → { job_uuid, document_id, patient_id, doc_type, extraction_dispatched }
 *   400 → { error: <UploadValidationReason::value>, message }
 *   403 → { error: 'forbidden' }
 *   413 → { error: 'oversized_payload', message }
 *   415 → { error: 'unsupported_mime_type', message }
 *   503 → { error: 'agentforge_not_configured' }
 *   500 → { error: 'internal' }
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

require_once __DIR__ . '/../globals.php';

use OpenEMR\AgentForge\Controller\UploadController;
use OpenEMR\AgentForge\Controller\UploadRequest;
use OpenEMR\AgentForge\Controller\UploadValidationReason;
use OpenEMR\AgentForge\Domain\UploadJobStatusMachine;
use OpenEMR\AgentForge\Exception\UploadValidationException;
use OpenEMR\AgentForge\Persistence\SidecarPersister;
use OpenEMR\AgentForge\Persistence\UploadJobsPersister;
use OpenEMR\BC\ServiceContainer;
use OpenEMR\Common\Acl\AclMain;
use OpenEMR\Common\Session\SessionWrapperFactory;
use OpenEMR\Common\Uuid\UuidRegistry;
use OpenEMR\Services\PatientService;

header('X-Content-Type-Options: nosniff');
header('Content-Type: application/json');
header('Cache-Control: private, no-store');

$logger = ServiceContainer::getLogger();

// $_SERVER / $_POST / $_FILES are the canonical surface for legacy
// PHP entry points; they are not reachable via Symfony Request from a
// raw <?php script. Mirrors interface/agentforge/chat.php.
// @phpstan-ignore openemr.forbiddenRequestGlobals
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    http_response_code(405);
    header('Allow: POST');
    echo json_encode(['error' => 'method_not_allowed']);
    return;
}

if (!AclMain::aclCheckCore('patients', 'docs', '', 'write')) {
    http_response_code(403);
    echo json_encode(['error' => 'forbidden']);
    return;
}

$activeSession = SessionWrapperFactory::getInstance()->getActiveSession();
$authUserRaw     = $activeSession->get('authUser');
$authProviderRaw = $activeSession->get('authProvider');
$authRoleRaw     = $activeSession->get('authUserID');
$authUser     = is_string($authUserRaw) ? $authUserRaw : '';
$authProvider = is_string($authProviderRaw) ? $authProviderRaw : '';
$authRole     = is_scalar($authRoleRaw) ? (string) $authRoleRaw : '';
$sessionId    = $activeSession->getId();

// @phpstan-ignore openemr.forbiddenRequestGlobals
$patientIdRaw = $_POST['patient_id'] ?? '';
$patientId = is_string($patientIdRaw) && ctype_digit($patientIdRaw) ? (int) $patientIdRaw
    : (is_int($patientIdRaw) ? $patientIdRaw : 0);
// @phpstan-ignore openemr.forbiddenRequestGlobals
$docTypeRaw = $_POST['doc_type'] ?? '';
$docType = is_string($docTypeRaw) ? $docTypeRaw : '';

if ($patientId <= 0) {
    http_response_code(400);
    echo json_encode([
        'error'   => UploadValidationReason::InvalidPatient->value,
        'message' => 'patient_id form field is required and must be positive',
    ]);
    return;
}

// @phpstan-ignore openemr.forbiddenRequestGlobals
$file = $_FILES['file'] ?? null;
if (!is_array($file) || !isset($file['tmp_name'], $file['name'], $file['error'])) {
    http_response_code(400);
    echo json_encode([
        'error'   => UploadValidationReason::EmptyPayload->value,
        'message' => 'file form field is required',
    ]);
    return;
}
$uploadError = is_int($file['error']) ? $file['error'] : UPLOAD_ERR_NO_FILE;
if ($uploadError !== UPLOAD_ERR_OK) {
    http_response_code($uploadError === UPLOAD_ERR_INI_SIZE || $uploadError === UPLOAD_ERR_FORM_SIZE ? 413 : 400);
    echo json_encode([
        'error'   => $uploadError === UPLOAD_ERR_INI_SIZE || $uploadError === UPLOAD_ERR_FORM_SIZE
            ? UploadValidationReason::OversizedPayload->value
            : UploadValidationReason::EmptyPayload->value,
        'message' => 'file upload failed (PHP upload error ' . $uploadError . ')',
    ]);
    return;
}

$tmpName = is_string($file['tmp_name']) ? $file['tmp_name'] : '';
$filename = is_string($file['name']) ? basename($file['name']) : '';
if ($tmpName === '' || !is_uploaded_file($tmpName)) {
    http_response_code(400);
    echo json_encode([
        'error'   => UploadValidationReason::EmptyPayload->value,
        'message' => 'file upload missing tmp_name',
    ]);
    return;
}
$bytes = file_get_contents($tmpName);
if (!is_string($bytes) || $bytes === '') {
    http_response_code(400);
    echo json_encode([
        'error'   => UploadValidationReason::EmptyPayload->value,
        'message' => 'file upload bytes unreadable',
    ]);
    return;
}
// Use the server-detected MIME type (mime_content_type sniffs the file
// magic) rather than the client-supplied type, so a misnamed extension
// or a hostile client cannot bypass the whitelist.
$detectedMime = function_exists('mime_content_type') ? mime_content_type($tmpName) : false;
$mimeType = is_string($detectedMime) && $detectedMime !== '' ? $detectedMime : '';

$patientService = new PatientService();
$rawUuid = $patientService->getUuid((string) $patientId);
if ($rawUuid === false) {
    http_response_code(400);
    echo json_encode([
        'error'   => UploadValidationReason::InvalidPatient->value,
        'message' => 'patient_uuid_unavailable',
    ]);
    return;
}
$patientUuid = UuidRegistry::uuidToString($rawUuid);

$jobs          = new UploadJobsPersister();
$sidecar       = new SidecarPersister();
$statusMachine = new UploadJobStatusMachine();

try {
    [$dispatch] = UploadController::defaultExtractionWiring(
        $jobs,
        $sidecar,
        $statusMachine,
        ServiceContainer::getClock(),
    );
} catch (\RuntimeException $e) {
    http_response_code(503);
    echo json_encode(['error' => 'agentforge_not_configured', 'message' => $e->getMessage()]);
    return;
}

$controller = new UploadController(
    jobs:               $jobs,
    logger:             $logger,
    documentPersister:  UploadController::defaultDocumentPersister(),
    extractionDispatch: $dispatch,
);

// Optional client-supplied job UUID. Lets the browser begin polling
// status.php with a known id BEFORE this synchronous extraction returns.
// Validation lives downstream in UploadJobsPersister::insertForDocument
// (32-hex-chars regex); falls back to a server-generated id otherwise.
// @phpstan-ignore openemr.forbiddenRequestGlobals
$jobUuidRaw = $_POST['job_uuid'] ?? '';
$jobUuidIn  = is_string($jobUuidRaw) ? $jobUuidRaw : '';

$request = new UploadRequest(
    patientId:    $patientId,
    patientUuid:  $patientUuid,
    docType:      $docType,
    filename:     $filename,
    mimeType:     $mimeType,
    bytes:        $bytes,
    authUser:     $authUser,
    authProvider: $authProvider,
    authRole:     $authRole,
    sessionId:    $sessionId,
    jobUuid:      $jobUuidIn,
);

try {
    $result = $controller->handle($request);
} catch (UploadValidationException $e) {
    $status = match ($e->reason) {
        UploadValidationReason::OversizedPayload    => 413,
        UploadValidationReason::UnsupportedMimeType => 415,
        UploadValidationReason::InvalidDocType,
        UploadValidationReason::InvalidPatient,
        UploadValidationReason::EmptyPayload        => 400,
    };
    http_response_code($status);
    echo json_encode(['error' => $e->reason->value, 'message' => $e->getMessage()]);
    return;
} catch (\RuntimeException $e) {
    $logger->error('AgentForge upload.php internal error', ['exception' => $e]);
    http_response_code(500);
    echo json_encode(['error' => 'internal']);
    return;
}

echo json_encode([
    'job_uuid'              => $result->jobUuid,
    'document_id'           => $result->documentId,
    'patient_id'            => $result->patientId,
    'doc_type'              => $result->docType,
    'extraction_dispatched' => $result->extractionDispatched,
]);
