<?php

/**
 * Care Team save endpoint for the patient-dashboard SPA.
 *
 * POST /interface/patient_file/summary/dashboard/care-team/save.php
 *
 * Accepts a JSON body of the form
 *   { pid, team_id, team_name, team_status, team: [...], csrf }
 * and persists via `CareTeamService::saveCareTeam()` — the same write path
 * the legacy `manage_care_team.html.twig` editor reaches through
 * `CareTeamViewCard::handleFormSubmission()`.
 *
 * Validates:
 *   - CSRF token (must match the active session's `csrf_token_form`)
 *   - `patients/demo` write ACL
 *   - the request's `pid` matches the active session's pid (no out-of-
 *     session writes via a stray URL).
 *
 * Returns `{ ok: true }` on success or `{ ok: false, error: "..." }` on
 * failure. Internal exception messages are logged but never echoed to the
 * client.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Nayan Bhut <nayanbhut03@gmail.com>
 * @copyright Copyright (c) 2026 Nayan Bhut
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

require_once '../../../globals.php';

use OpenEMR\Common\Acl\AclMain;
use OpenEMR\Common\Csrf\CsrfUtils;
use OpenEMR\Common\Session\SessionWrapperFactory;
use OpenEMR\Services\CareTeamService;

header('X-Content-Type-Options: nosniff');
header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'error' => 'method_not_allowed']);
    exit;
}

if (!AclMain::aclCheckCore('patients', 'demo', '', 'write')) {
    http_response_code(403);
    echo json_encode(['ok' => false, 'error' => 'forbidden']);
    exit;
}

$session = SessionWrapperFactory::getInstance()->getActiveSession();
$sessionPid = (int)($session->get('pid') ?? 0);

if ($sessionPid <= 0) {
    http_response_code(401);
    echo json_encode(['ok' => false, 'error' => 'no_active_patient']);
    exit;
}

$rawBody = file_get_contents('php://input') ?: '';
$decoded = json_decode($rawBody, true);
if (!is_array($decoded)) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'invalid_json']);
    exit;
}

$csrfToken = is_string($decoded['csrf'] ?? null) ? $decoded['csrf'] : '';
if (!CsrfUtils::verifyCsrfToken($csrfToken, $session)) {
    http_response_code(403);
    echo json_encode(['ok' => false, 'error' => 'invalid_csrf']);
    exit;
}

// The body's `pid` is informational only — the SPA threads through the
// FHIR puuid (UUID), while the session stores the integer pid. The session
// pid is the source of truth for the write; treat the body pid as a hint
// the client wants to write the active patient (which it must be, per the
// CSRF gate above). When the body pid is the integer pid we sanity-check
// the match; when it's a UUID or anything else we skip the check.
if (isset($decoded['pid']) && is_numeric($decoded['pid'])) {
    $bodyPid = (int)$decoded['pid'];
    if ($bodyPid !== $sessionPid) {
        http_response_code(403);
        echo json_encode(['ok' => false, 'error' => 'pid_mismatch']);
        exit;
    }
}

$rawTeamId = $decoded['team_id'] ?? null;
$teamId = null;
if (is_int($rawTeamId)) {
    $teamId = $rawTeamId > 0 ? $rawTeamId : null;
} elseif (is_string($rawTeamId) && is_numeric($rawTeamId)) {
    $teamId = (int)$rawTeamId > 0 ? (int)$rawTeamId : null;
}

$teamName = is_string($decoded['team_name'] ?? null) ? trim($decoded['team_name']) : '';
if ($teamName === '') {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'team_name_required']);
    exit;
}

$teamStatus = is_string($decoded['team_status'] ?? null) ? trim($decoded['team_status']) : 'active';
if ($teamStatus === '') {
    $teamStatus = 'active';
}

$rawTeam = $decoded['team'] ?? [];
if (!is_array($rawTeam)) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'team_invalid']);
    exit;
}

// Normalize the per-row payload into the shape `CareTeamService::saveCareTeam`
// expects. The service treats user_id as primary; rows that look like
// related-person/contact members route through contact_id.
$team = [];
foreach ($rawTeam as $row) {
    if (!is_array($row)) {
        continue;
    }

    $memberType = is_string($row['member_type'] ?? null) ? $row['member_type'] : 'user';
    $rawMemberId = $row['member_id'] ?? null;
    $memberId = '';
    if (is_int($rawMemberId)) {
        $memberId = (string)$rawMemberId;
    } elseif (is_string($rawMemberId)) {
        $memberId = trim($rawMemberId);
    }
    if ($memberId === '' || !is_numeric($memberId)) {
        // Skip blank rows silently — the editor permits transient empties.
        continue;
    }

    $entry = [
        'user_id' => null,
        'contact_id' => null,
        'role' => is_string($row['role'] ?? null) ? trim($row['role']) : '',
        'facility_id' => null,
        'provider_since' => is_string($row['provider_since'] ?? null) ? trim($row['provider_since']) : '',
        'status' => is_string($row['status'] ?? null) ? trim($row['status']) : 'active',
        'note' => is_string($row['note'] ?? null) ? trim($row['note']) : '',
    ];

    if ($memberType === 'contact') {
        $entry['contact_id'] = (int)$memberId;
    } else {
        $entry['user_id'] = (int)$memberId;
    }

    $rawFacility = $row['facility_id'] ?? null;
    if (is_string($rawFacility) && is_numeric($rawFacility) && (int)$rawFacility > 0) {
        $entry['facility_id'] = (int)$rawFacility;
    } elseif (is_int($rawFacility) && $rawFacility > 0) {
        $entry['facility_id'] = $rawFacility;
    }

    $team[] = $entry;
}

try {
    $careTeamService = new CareTeamService();
    $careTeamService->saveCareTeam($sessionPid, $teamId, $teamName, $team, $teamStatus);
    echo json_encode(['ok' => true]);
} catch (\Throwable $e) {
    error_log('care-team save failed: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => 'save_failed']);
}
