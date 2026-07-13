<?php

/**
 * AgentForge sidecar reader endpoint — GET /interface/agentforge/sidecar.php
 *
 * Serves the latest extracted-document sidecar row for a (pid, doc_type)
 * pair to the Node-side agent. The Node agent's SidecarHttpClient hits
 * this endpoint with the same scoped chat JWT the chat turn already
 * minted, and the supervisor's intake-extractor worker reads the JSON.
 *
 * Query parameters:
 *   - pid       (required, positive int)         Patient PID to query.
 *   - doc_type  (required when latest=1)         One of "lab_pdf"|"intake_form".
 *   - latest    (optional, "1")                  When set, returns the most
 *                                                 recent row; omit to list
 *                                                 every extraction for the
 *                                                 patient.
 *   - extraction_id (optional, positive int)     Existence check by id —
 *                                                 returns 200 iff the row
 *                                                 exists for this pid, 404
 *                                                 otherwise.
 *
 * Authorization:
 *   - HS256 JWT in `Authorization: Bearer ...` header, signed with the
 *     same AGENTFORGE_JWT_SECRET as upload.php / chat.php.
 *   - The JWT's `pid` claim MUST match the requested pid (cross-patient
 *     access is rejected with 403 — Patient A's JWT cannot read Patient
 *     B's sidecar).
 *
 * Response shapes:
 *   - latest=1, found:    200 { extraction_id, doc_type, extracted_json,
 *                                patient_match_status, created_at }
 *   - latest=1, no row:   404 (empty body)
 *   - extraction_id, found: 200 { extraction_id }
 *   - extraction_id, none:  404 (empty body)
 *   - list mode:          200 [ {extraction_id, doc_type,
 *                                patient_match_status, created_at}, ... ]
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

// JWT-only auth (Bearer token below); skip OpenEMR's session-cookie auth.
// Default the site to 'default' for the agent's server-to-server call —
// the agent has no session, only the scoped JWT.
$ignoreAuth = true;
if (!isset($_GET['site']) || $_GET['site'] === '') {
    $_GET['site'] = 'default';
}

require_once __DIR__ . '/../globals.php';

use Lcobucci\Clock\SystemClock;
use Lcobucci\JWT\Configuration;
use Lcobucci\JWT\Signer\Hmac\Sha256;
use Lcobucci\JWT\Signer\Key\InMemory;
use Lcobucci\JWT\UnencryptedToken;
use Lcobucci\JWT\Validation\Constraint\IssuedBy;
use Lcobucci\JWT\Validation\Constraint\PermittedFor;
use Lcobucci\JWT\Validation\Constraint\SignedWith;
use Lcobucci\JWT\Validation\Constraint\StrictValidAt;
use OpenEMR\AgentForge\Security\ScopedJwtMinter;
use OpenEMR\BC\ServiceContainer;
use OpenEMR\Common\Database\QueryUtils;
use Symfony\Component\HttpFoundation\Request;

header('X-Content-Type-Options: nosniff');

$request = Request::createFromGlobals();

if ($request->getMethod() !== 'GET') {
    http_response_code(405);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'method_not_allowed']);
    exit;
}

// ---------------------------------------------------------------------------
// JWT verification
// ---------------------------------------------------------------------------

$envSecret = $_ENV['AGENTFORGE_JWT_SECRET'] ?? null;
$secret = is_string($envSecret) ? $envSecret : '';
if ($secret === '') {
    $getenvSecret = getenv('AGENTFORGE_JWT_SECRET');
    $secret = is_string($getenvSecret) ? $getenvSecret : '';
}
if ($secret === '') {
    http_response_code(503);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'agentforge_not_configured']);
    exit;
}

$authHeaderRaw = $request->headers->get('Authorization', '');
$authHeader = is_string($authHeaderRaw) ? $authHeaderRaw : '';
// Apache + mod_php strips Authorization out of $_SERVER by default, so
// Symfony's Request::createFromGlobals() never sees it. Fall back to
// getallheaders() which preserves the original header. (mod_rewrite +
// E=HTTP_AUTHORIZATION would also work, but a per-script fallback keeps
// the fix scoped and avoids touching the apache config.)
if ($authHeader === '' && function_exists('getallheaders')) {
    $rawHeaders = getallheaders();
    foreach ($rawHeaders as $name => $value) {
        if (strcasecmp((string) $name, 'Authorization') === 0 && is_string($value)) {
            $authHeader = $value;
            break;
        }
    }
}
if (!str_starts_with($authHeader, 'Bearer ')) {
    http_response_code(401);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'unauthorized', 'reason' => 'missing_bearer_token']);
    exit;
}
$token = trim(substr($authHeader, strlen('Bearer ')));
if ($token === '') {
    http_response_code(401);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'unauthorized', 'reason' => 'empty_token']);
    exit;
}

$jwtPid = 0;
$jwtScope = '';
$jwtError = null;
try {
    $config = Configuration::forSymmetricSigner(
        new Sha256(),
        InMemory::plainText($secret),
    );
    $config->setValidationConstraints(
        new SignedWith($config->signer(), $config->signingKey()),
        new IssuedBy(ScopedJwtMinter::ISSUER),
        new PermittedFor(ScopedJwtMinter::AUDIENCE),
        new StrictValidAt(new SystemClock(new \DateTimeZone('UTC'))),
    );
    $parsed = $config->parser()->parse($token);
    if (!$parsed instanceof UnencryptedToken) {
        throw new \RuntimeException('parsed token is not an UnencryptedToken');
    }
    $config->validator()->assert($parsed, ...$config->validationConstraints());

    $claims = $parsed->claims();
    $rawPid = $claims->get('pid');
    if (is_int($rawPid)) {
        $jwtPid = $rawPid;
    }
    $rawScope = $claims->get('scope');
    if (is_string($rawScope)) {
        $jwtScope = $rawScope;
    }
} catch (\RuntimeException | \Lcobucci\JWT\Exception $e) {
    $jwtError = $e->getMessage();
}

if ($jwtError !== null) {
    ServiceContainer::getLogger()->warning('AgentForge sidecar.php JWT verify failed', ['error' => $jwtError]);
    http_response_code(401);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'unauthorized', 'reason' => 'invalid_token']);
    exit;
}

if ($jwtScope !== ScopedJwtMinter::SCOPE) {
    http_response_code(401);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'unauthorized', 'reason' => 'invalid_scope']);
    exit;
}

if ($jwtPid <= 0) {
    http_response_code(401);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'unauthorized', 'reason' => 'missing_pid_claim']);
    exit;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

$pidRaw = (string) ($request->query->get('pid', ''));
if ($pidRaw === '' || preg_match('/^[1-9][0-9]*$/', $pidRaw) !== 1) {
    http_response_code(400);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'invalid_pid']);
    exit;
}
$pid = (int) $pidRaw;

// JWT-pid-match guard: a JWT minted for one patient cannot read another
// patient's sidecar.
if ($pid !== $jwtPid) {
    http_response_code(403);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'forbidden', 'reason' => 'pid_jwt_mismatch']);
    exit;
}

$latest = ((string) $request->query->get('latest', '')) === '1';
$extractionIdRaw = (string) ($request->query->get('extraction_id', ''));
$action = (string) ($request->query->get('action', ''));

// "resource_origins" mode — given resource UUIDs (procedure_result for labs,
// lists for medications/allergies, pnotes for chief concerns), return a map
// of UUID → source-document info, or null when the row is a chart entry.
// Used by chat-time tools to attribute citations to uploaded PDFs.
if ($action === 'resource_origins') {
    $resourceType = (string) ($request->query->get('resource_type', ''));
    $uuidsRaw     = (string) ($request->query->get('uuids', ''));

    $allowedTables = [
        'procedure_result' => ['table' => 'procedure_result', 'docCol' => 'document_id'],
        'lists'            => ['table' => 'lists',            'docCol' => 'source_document_id'],
        'pnotes'           => ['table' => 'pnotes',           'docCol' => 'source_document_id'],
    ];
    if (!isset($allowedTables[$resourceType])) {
        http_response_code(400);
        echo json_encode(['error' => 'invalid_resource_type']);
        exit;
    }
    $tbl    = $allowedTables[$resourceType]['table'];
    $docCol = $allowedTables[$resourceType]['docCol'];

    // Comma-separated UUIDs, hex form (32 chars, no dashes) or canonical
    // (36 chars with dashes). Limit to 100 per call to bound query size.
    $uuids = array_filter(array_map('trim', explode(',', $uuidsRaw)), static fn(string $s): bool => $s !== '');
    if ($uuids === []) {
        http_response_code(200);
        echo json_encode(new \stdClass());
        exit;
    }
    if (count($uuids) > 100) {
        http_response_code(400);
        echo json_encode(['error' => 'too_many_uuids', 'limit' => 100]);
        exit;
    }
    foreach ($uuids as $u) {
        // Accept either the canonical 36-char UUID (with dashes) or the
        // bare 32-char hex form. Anything in between (33-35 chars) sneaks
        // past a {32,36} regex and then makes pack('H*') silently truncate.
        if (
            preg_match('/^[A-Fa-f0-9]{32}$/', $u) !== 1
            && preg_match('/^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}$/', $u) !== 1
        ) {
            http_response_code(400);
            echo json_encode(['error' => 'invalid_uuid', 'value' => substr($u, 0, 64)]);
            exit;
        }
    }

    // The uuid column is BINARY(16). Pre-convert each hex UUID to its
    // raw 16-byte form via pack('H*') and bind it directly — QueryUtils'
    // prepared-statement layer treats `UNHEX(?)` inside the SQL as a
    // string-typed bind and the comparison never matches, so we keep the
    // SQL placeholder a plain `?` and do the hex→binary conversion in PHP.
    $hexUuids = array_map(static fn(string $u): string => strtoupper(str_replace('-', '', $u)), $uuids);
    $binaryUuids = array_map(static fn(string $h): string => pack('H*', $h), $hexUuids);
    $placeholders = implode(',', array_fill(0, count($binaryUuids), '?'));

    // For lists/pnotes the patient column is `pid`; for procedure_result it's
    // procedure_report → procedure_order.patient_id (joined). Both need a
    // patient-scope check so the JWT can't reach into another patient.
    $rows = [];
    if ($resourceType === 'procedure_result') {
        /** @var array<int, array<string, mixed>> $rows */
        $rows = QueryUtils::fetchRecords(
            "SELECT HEX(pr.uuid) AS uuid, pr.{$docCol} AS document_id, "
            . "       d.name AS document_name, d.docdate AS document_date, "
            . "       po.patient_id AS patient_id "
            . "FROM procedure_result pr "
            . "INNER JOIN procedure_report prep ON prep.procedure_report_id = pr.procedure_report_id "
            . "INNER JOIN procedure_order po ON po.procedure_order_id = prep.procedure_order_id "
            . "LEFT JOIN documents d ON d.id = pr.{$docCol} "
            . "WHERE pr.uuid IN ({$placeholders}) AND po.patient_id = ?",
            [...$binaryUuids, $pid],
        );
    } else {
        /** @var array<int, array<string, mixed>> $rows */
        $rows = QueryUtils::fetchRecords(
            "SELECT HEX(t.uuid) AS uuid, t.{$docCol} AS document_id, "
            . "       d.name AS document_name, d.docdate AS document_date, "
            . "       t.pid AS patient_id "
            . "FROM {$tbl} t "
            . "LEFT JOIN documents d ON d.id = t.{$docCol} "
            . "WHERE t.uuid IN ({$placeholders}) AND t.pid = ?",
            [...$binaryUuids, $pid],
        );
    }

    $byUuid = [];
    foreach ($rows as $r) {
        $hex = is_string($r['uuid'] ?? null) ? strtoupper((string) $r['uuid']) : '';
        if ($hex === '') {
            continue;
        }
        $docIdRaw = $r['document_id'] ?? null;
        $docId = is_int($docIdRaw) ? $docIdRaw
            : (is_string($docIdRaw) && ctype_digit($docIdRaw) ? (int) $docIdRaw : 0);
        $byUuid[$hex] = $docId > 0
            ? [
                'document_id'   => $docId,
                'document_name' => is_string($r['document_name'] ?? null) ? $r['document_name'] : null,
                'document_date' => is_string($r['document_date'] ?? null) ? $r['document_date'] : null,
            ]
            : null;
    }

    // Project the response back keyed by the caller's request order /
    // canonical UUID format so the client can look up by what it asked for.
    $out = [];
    foreach ($uuids as $i => $original) {
        $hex = $hexUuids[$i];
        $out[$original] = $byUuid[$hex] ?? null;
    }
    http_response_code(200);
    echo json_encode($out);
    exit;
}

// Existence-check mode (PatientDocumentVerifier path).
if ($extractionIdRaw !== '') {
    if (preg_match('/^[1-9][0-9]*$/', $extractionIdRaw) !== 1) {
        http_response_code(400);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'invalid_extraction_id']);
        exit;
    }
    $extractionId = (int) $extractionIdRaw;
    /** @var array<int, array<string, mixed>> $rows */
    $rows = QueryUtils::fetchRecords(
        "SELECT id FROM agentforge_document_extractions WHERE id = ? AND patient_id = ? LIMIT 1",
        [$extractionId, $pid],
    );
    if ($rows === []) {
        http_response_code(404);
        header('Content-Type: application/json');
        echo json_encode(null);
        exit;
    }
    $row = $rows[0];
    $rowId = $row['id'] ?? 0;
    http_response_code(200);
    header('Content-Type: application/json');
    echo json_encode(['extraction_id' => is_int($rowId) || is_string($rowId) ? (int) $rowId : 0]);
    exit;
}

// "latest by doc_type" mode.
if ($latest) {
    $docType = (string) ($request->query->get('doc_type', ''));
    if (!in_array($docType, ['lab_pdf', 'intake_form'], true)) {
        http_response_code(400);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'invalid_doc_type']);
        exit;
    }
    /** @var array<int, array<string, mixed>> $rows */
    $rows = QueryUtils::fetchRecords(
        "SELECT e.id, e.doc_type, e.extracted_json, e.patient_match_status, e.created_at, "
        . "       e.document_id, d.name AS document_name "
        . "FROM agentforge_document_extractions e "
        . "LEFT JOIN documents d ON d.id = e.document_id "
        . "WHERE e.patient_id = ? AND e.doc_type = ? AND e.extraction_status = 'complete' "
        . "ORDER BY e.created_at DESC, e.id DESC LIMIT 1",
        [$pid, $docType],
    );
    if ($rows === []) {
        http_response_code(404);
        header('Content-Type: application/json');
        echo json_encode(null);
        exit;
    }
    $row = $rows[0];
    $extractedRaw = $row['extracted_json'] ?? '';
    $extractedJsonStr = is_string($extractedRaw) ? $extractedRaw : '';
    $decoded = $extractedJsonStr === '' ? null : json_decode($extractedJsonStr, true);
    $rowId = $row['id'] ?? 0;
    $docIdRaw = $row['document_id'] ?? null;
    $docNameRaw = $row['document_name'] ?? null;
    http_response_code(200);
    header('Content-Type: application/json');
    echo json_encode([
        'extraction_id'        => is_int($rowId) || is_string($rowId) ? (int) $rowId : 0,
        'doc_type'             => is_string($row['doc_type'] ?? null) ? (string) $row['doc_type'] : '',
        'extracted_json'       => $decoded,
        'patient_match_status' => is_string($row['patient_match_status'] ?? null)
            ? (string) $row['patient_match_status']
            : 'unverifiable',
        'created_at'           => is_string($row['created_at'] ?? null) ? (string) $row['created_at'] : '',
        'document_id'          => is_int($docIdRaw) || is_string($docIdRaw) ? (int) $docIdRaw : null,
        'document_name'        => is_string($docNameRaw) && $docNameRaw !== '' ? $docNameRaw : null,
    ]);
    exit;
}

// "list all" mode (availability hint).
/** @var array<int, array<string, mixed>> $allRows */
$allRows = QueryUtils::fetchRecords(
    "SELECT id, doc_type, patient_match_status, created_at "
    . "FROM agentforge_document_extractions "
    . "WHERE patient_id = ? AND extraction_status = 'complete' "
    . "ORDER BY created_at DESC, id DESC",
    [$pid],
);

$out = [];
foreach ($allRows as $r) {
    $rowId = $r['id'] ?? 0;
    $out[] = [
        'extraction_id'        => is_int($rowId) || is_string($rowId) ? (int) $rowId : 0,
        'doc_type'             => is_string($r['doc_type'] ?? null) ? (string) $r['doc_type'] : '',
        'patient_match_status' => is_string($r['patient_match_status'] ?? null)
            ? (string) $r['patient_match_status']
            : 'unverifiable',
        'created_at'           => is_string($r['created_at'] ?? null) ? (string) $r['created_at'] : '',
    ];
}

http_response_code(200);
header('Content-Type: application/json');
echo json_encode($out);
