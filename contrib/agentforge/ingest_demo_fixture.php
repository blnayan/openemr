#!/usr/bin/php
<?php

/**
 * AgentForge demo-fixture CLI ingestor (Document Inbox rework).
 *
 * Drives the new {@see UploadController} end-to-end for a single
 * fixture file: persists source bytes via Document::createDocument,
 * inserts the upload-job + sidecar rows, runs synchronous extraction,
 * and then auto-confirms via {@see ConfirmCommitter} with the
 * synthetic system reviewer (admin, user id 1) so a fresh deploy
 * boots into a state where the Document Inbox shows real committed
 * extractions for the demo patient without manual clicks.
 *
 * Replaces the legacy listener path (the AgentForge document category
 * is gone after migration `20260506130002`).
 *
 * The script is idempotent — if a sidecar row already exists for the
 * `(patient_id, document_id)` pair, the upload is skipped and the
 * existing document_id is reported as `skipped_exists`.
 *
 * Usage:
 *   php contrib/agentforge/ingest_demo_fixture.php
 *       --pubpid=AGENTFORGE-DEMO-PDF-001
 *       --doc-type=lab_pdf|intake_form
 *       --file=/abs/path/to/fixture.pdf
 *       [--site=default] [--quiet] [--no-confirm]
 *
 * Stdout: a single JSON object describing the outcome:
 *   {
 *     "pubpid": "AGENTFORGE-DEMO-PDF-001",
 *     "pid": 7,
 *     "document_id": 142,
 *     "job_uuid": "abcd...",
 *     "doc_type": "lab_pdf",
 *     "status": "uploaded" | "skipped_exists",
 *     "committed": true | false
 *   }
 *
 * Exit codes:
 *   0  success (uploaded or skipped)
 *   1  invalid CLI arguments
 *   2  patient not found / extraction wiring failure
 *
 * @package OpenEMR
 * @license https://github.com/openemr/openemr/blob/master/LICENSE GNU GPL 3
 */

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "This script must be run from the command line.\n");
    exit(1);
}

$args = getopt('', ['pubpid:', 'doc-type:', 'file:', 'site::', 'quiet', 'no-confirm']);
$pubpid    = is_string($args['pubpid'] ?? null) ? $args['pubpid'] : '';
$docType   = is_string($args['doc-type'] ?? null) ? $args['doc-type'] : '';
$file      = is_string($args['file'] ?? null) ? $args['file'] : '';
$siteRaw   = $args['site'] ?? null;
$site      = is_string($siteRaw) && $siteRaw !== '' ? $siteRaw : 'default';
$quiet     = isset($args['quiet']);
$noConfirm = isset($args['no-confirm']);

if ($pubpid === '' || $docType === '' || $file === '') {
    fwrite(STDERR, "Usage: ingest_demo_fixture.php --pubpid=... --doc-type=lab_pdf|intake_form --file=/abs/path\n");
    exit(1);
}
if (!in_array($docType, ['lab_pdf', 'intake_form'], true)) {
    fwrite(STDERR, "Invalid --doc-type: $docType (expected lab_pdf or intake_form)\n");
    exit(1);
}
if (!is_file($file)) {
    fwrite(STDERR, "File not found: $file\n");
    exit(1);
}

$webdir = dirname(__DIR__, 2);

// `interface/globals.php` reads `$_GET['site']` to pick the site.
// @phpstan-ignore openemr.forbiddenRequestGlobals
$_GET['site'] = $site;
$ignoreAuth = 1;
require_once $webdir . '/interface/globals.php';

use OpenEMR\AgentForge\Controller\UploadController;
use OpenEMR\AgentForge\Controller\UploadRequest;
use OpenEMR\AgentForge\Domain\UploadJobStatus;
use OpenEMR\AgentForge\Domain\UploadJobStatusMachine;
use OpenEMR\AgentForge\Persistence\ConfirmCommitter;
use OpenEMR\AgentForge\Persistence\IntakeWriter;
use OpenEMR\AgentForge\Persistence\LabFhirWriter;
use OpenEMR\AgentForge\Persistence\SidecarPersister;
use OpenEMR\AgentForge\Persistence\UploadJobsPersister;
use OpenEMR\BC\ServiceContainer;
use OpenEMR\Common\Database\QueryUtils;
use OpenEMR\Common\Session\SessionUtil;
use OpenEMR\Common\Uuid\UuidRegistry;
use OpenEMR\Services\PatientService;

SessionUtil::setSession('authUserID', 1);
SessionUtil::setSession('authUser', 'admin');

/**
 * @param array<string, scalar|null> $context
 */
$log = static function (string $level, string $message, array $context = []) use ($quiet): void {
    if ($quiet && $level === 'info') {
        return;
    }
    $rendered = $message;
    if ($context !== []) {
        $parts = [];
        foreach ($context as $k => $v) {
            $parts[] = $k . '=' . (is_scalar($v) ? (string) $v : '');
        }
        $rendered .= ' [' . implode(' ', $parts) . ']';
    }
    fwrite(STDERR, "[ingest-fixture:$level] $rendered\n");
};

// Resolve patient by pubpid
$patientRow = QueryUtils::fetchRecords(
    "SELECT pid FROM patient_data WHERE pubpid = ? LIMIT 1",
    [$pubpid]
);
if ($patientRow === [] || !isset($patientRow[0]['pid'])) {
    $log('error', 'patient not found', ['pubpid' => $pubpid]);
    exit(2);
}
$pidRaw = $patientRow[0]['pid'];
$pid = is_int($pidRaw) || is_string($pidRaw) ? (int) $pidRaw : 0;
if ($pid <= 0) {
    $log('error', 'invalid pid resolved', ['pubpid' => $pubpid]);
    exit(2);
}

$patientService = new PatientService();
$rawUuid = $patientService->getUuid((string) $pid);
if ($rawUuid === false) {
    $log('error', 'patient uuid unavailable', ['pid' => $pid]);
    exit(2);
}
$patientUuid = UuidRegistry::uuidToString($rawUuid);

// MIME map
$ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
$mime = match ($ext) {
    'pdf'        => 'application/pdf',
    'png'        => 'image/png',
    'jpg', 'jpeg' => 'image/jpeg',
    'webp'       => 'image/webp',
    default      => '',
};
if ($mime === '') {
    $log('error', 'unsupported file extension', ['ext' => $ext]);
    exit(1);
}

$basename = basename($file);
$bytes = file_get_contents($file);
if ($bytes === false || $bytes === '') {
    $log('error', 'file unreadable or empty', ['file' => $file]);
    exit(1);
}

// Idempotency: if a document with this exact filename is already linked
// to this patient, skip — re-running the seed across deploys must not
// pile up duplicate document rows. Categories are no longer the
// idempotency key now that the AgentForge tree is gone (migration
// 20260506130002); filename + foreign_id + extraction-sidecar presence
// are the canonical signal.
$existing = QueryUtils::fetchRecords(
    "SELECT d.id FROM documents d
     WHERE d.foreign_id = ? AND d.name = ?
     LIMIT 1",
    [$pid, $basename]
);
if ($existing !== [] && isset($existing[0]['id'])) {
    $existingDocIdRaw = $existing[0]['id'];
    $existingDocId = is_int($existingDocIdRaw) || is_string($existingDocIdRaw) ? (int) $existingDocIdRaw : 0;
    $log('info', 'fixture already extracted, skipping', [
        'pubpid'      => $pubpid,
        'pid'         => $pid,
        'document_id' => $existingDocId,
    ]);
    fwrite(STDOUT, json_encode([
        'pubpid'      => $pubpid,
        'pid'         => $pid,
        'document_id' => $existingDocId,
        'doc_type'    => $docType,
        'status'      => 'skipped_exists',
        'committed'   => false,
    ], JSON_UNESCAPED_SLASHES) . "\n");
    exit(0);
}

$jobs          = new UploadJobsPersister();
$sidecar       = new SidecarPersister();
$statusMachine = new UploadJobStatusMachine();
$logger        = ServiceContainer::getLogger();

$dispatch = null;
$wiringError = '';
try {
    [$dispatch] = UploadController::defaultExtractionWiring(
        $jobs,
        $sidecar,
        $statusMachine,
        ServiceContainer::getClock(),
    );
} catch (\RuntimeException $e) {
    $wiringError = $e->getMessage();
}
if ($dispatch === null) {
    $log('error', 'agent service not configured', ['error' => $wiringError]);
    exit(2);
}

$controller = new UploadController(
    jobs:               $jobs,
    logger:             $logger,
    documentPersister:  UploadController::defaultDocumentPersister(),
    extractionDispatch: $dispatch,
);

$uploadRequest = new UploadRequest(
    patientId:    $pid,
    patientUuid:  $patientUuid,
    docType:      $docType,
    filename:     $basename,
    mimeType:     $mime,
    bytes:        $bytes,
    authUser:     'admin',
    authProvider: 'Default',
    authRole:     '1',
    sessionId:    'demo-seed-cli',
);

$result = null;
$uploadError = '';
try {
    $result = $controller->handle($uploadRequest);
} catch (\RuntimeException | \DomainException | \LogicException $e) {
    $uploadError = $e->getMessage();
}
if ($result === null) {
    $log('error', 'upload controller failed', ['error' => $uploadError]);
    exit(2);
}

$log('info', 'upload accepted', [
    'pubpid'                => $pubpid,
    'pid'                   => $pid,
    'document_id'           => $result->documentId,
    'job_uuid'              => $result->jobUuid,
    'extraction_dispatched' => $result->extractionDispatched ? 'true' : 'false',
]);

$committed = false;
if (!$noConfirm && $result->extractionDispatched) {
    // Auto-confirm via the ConfirmCommitter so the inbox shows the
    // demo extraction in `committed`. The synthetic system reviewer
    // is admin (user id 1).
    $committer = new ConfirmCommitter(
        labWriter:        new LabFhirWriter(),
        writersByDocType: ['intake_form' => new IntakeWriter()],
        jobs:             $jobs,
        sidecar:          $sidecar,
        statusMachine:    $statusMachine,
    );

    $job = $jobs->loadJob($result->jobUuid);
    if ($job === null) {
        $log('warning', 'job vanished after extraction', ['job_uuid' => $result->jobUuid]);
    } elseif ($job->status === UploadJobStatus::ReadyForReview) {
        $extractionRow = $sidecar->loadByDocumentId($result->documentId);
        if ($extractionRow === null) {
            $log('warning', 'sidecar missing after extraction', ['document_id' => $result->documentId]);
        } else {
            try {
                $committer->confirm($result->jobUuid, $extractionRow->originalJson, 1);
                $committed = true;
                $log('info', 'auto-confirmed extraction', [
                    'pubpid'   => $pubpid,
                    'job_uuid' => $result->jobUuid,
                ]);
            } catch (\RuntimeException | \DomainException | \LogicException $e) {
                $log('warning', 'auto-confirm failed', [
                    'job_uuid' => $result->jobUuid,
                    'error'    => $e->getMessage(),
                ]);
            }
        }
    } else {
        $log('info', 'job not ready_for_review — auto-confirm skipped', [
            'job_uuid' => $result->jobUuid,
            'status'   => $job->status->value,
        ]);
    }
}

fwrite(STDOUT, json_encode([
    'pubpid'      => $pubpid,
    'pid'         => $pid,
    'document_id' => $result->documentId,
    'job_uuid'    => $result->jobUuid,
    'doc_type'    => $docType,
    'status'      => 'uploaded',
    'committed'   => $committed,
], JSON_UNESCAPED_SLASHES) . "\n");
exit(0);
