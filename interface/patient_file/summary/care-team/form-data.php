<?php

/**
 * Care Team form-data endpoint for the patient-dashboard SPA.
 *
 * GET /interface/patient_file/summary/dashboard/care-team/form-data.php
 *
 * Returns the same option set the legacy `manage_care_team.html.twig`
 * editor consumes (member candidates, role list, facility list, status
 * options) plus the existing team's persisted shape, in a JSON wire
 * format the React `<CareTeamEditor>` can consume directly.
 *
 * Bootstraps via the shared OpenEMR session-cookie auth (require_once
 * globals.php) and gates on `patients/demo` ACL — the same gate that
 * protects demographics.php where the legacy editor lives.
 *
 * The active session's `pid` is the source of truth — query-param `pid`
 * is accepted but only honored when it matches. This mirrors the same-
 * origin SPA's binding to the active patient and avoids letting a stray
 * URL param diverge from the session-bound patient.
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
use OpenEMR\Common\Database\QueryUtils;
use OpenEMR\Common\Session\SessionWrapperFactory;
use OpenEMR\Services\CareTeamService;
use OpenEMR\Services\ListService;

header('X-Content-Type-Options: nosniff');
header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'error' => 'method_not_allowed']);
    exit;
}

if (!AclMain::aclCheckCore('patients', 'demo')) {
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

// `pid` query param is informational — the SPA thinks in FHIR puuid
// (UUID) while the session stores the integer pid. We don't try to
// reconcile them here; the session pid is authoritative for which
// patient's data we return. When the param is the integer pid and
// doesn't match the session, that is a real mismatch and we refuse.
if (isset($_GET['pid']) && is_numeric($_GET['pid'])) {
    $queryPid = (int)$_GET['pid'];
    if ($queryPid !== $sessionPid) {
        http_response_code(403);
        echo json_encode(['ok' => false, 'error' => 'pid_mismatch']);
        exit;
    }
}

try {
    $careTeamService = new CareTeamService();
    $careTeamResult = $careTeamService->getCareTeamData($sessionPid);

    $teamId = $careTeamResult['team_id'] ?? null;
    $teamName = $careTeamResult['team_name'] ?? '';
    $teamStatus = $careTeamResult['team_status'] ?? 'active';

    $members = [];
    foreach (($careTeamResult['members'] ?? []) as $member) {
        $memberType = $member['member_type'] ?? 'user';
        $memberId = $memberType === 'user'
            ? (string)($member['user_id'] ?? '')
            : (string)($member['contact_id'] ?? '');
        $members[] = [
            'member_type' => $memberType,
            'member_id' => $memberId,
            'role' => (string)($member['role'] ?? ''),
            'facility_id' => $member['facility_id'] !== null ? (string)$member['facility_id'] : '',
            'provider_since' => (string)($member['provider_since'] ?? ''),
            'status' => (string)($member['status'] ?? ''),
            'note' => (string)($member['note'] ?? ''),
            'display_name' => $memberType === 'user'
                ? (string)($member['user_name'] ?? '')
                : (string)($member['contact_name'] ?? ''),
        ];
    }

    // Member option set: active users with a username + first name.
    $usersResult = QueryUtils::sqlStatementThrowException(
        "SELECT u.id, u.fname, u.lname, u.physician_type
         FROM users u
         WHERE active = 1 AND username IS NOT NULL AND fname IS NOT NULL
         ORDER BY lname, fname",
        []
    );
    $memberUsers = [];
    while ($u = QueryUtils::fetchArrayFromResultSet($usersResult)) {
        $name = trim(((string)($u['lname'] ?? '')) . ', ' . ((string)($u['fname'] ?? '')));
        $physicianType = (string)($u['physician_type'] ?? '');
        $label = $physicianType !== '' ? $name . ' (' . $physicianType . ')' : $name;
        $memberUsers[] = [
            'id' => (string)$u['id'],
            'label' => $label,
        ];
    }

    // Facilities scoped the same way the legacy editor scopes them.
    $facilitiesResult = QueryUtils::sqlStatementThrowException(
        "SELECT id, name, facility_npi
         FROM facility
         WHERE service_location = 1 OR billing_location = 1
         ORDER BY name",
        []
    );
    $facilities = [];
    while ($f = QueryUtils::fetchArrayFromResultSet($facilitiesResult)) {
        $name = (string)($f['name'] ?? '');
        $npi = (string)($f['facility_npi'] ?? '');
        $label = $npi !== '' ? $name . ' (NPI: ' . $npi . ')' : $name;
        $facilities[] = [
            'id' => (string)$f['id'],
            'label' => $label,
        ];
    }

    // Roles + statuses come from the same list_options the legacy editor uses.
    $listService = new ListService();
    $rolesRaw = $listService->getOptionsByListName('care_team_roles');
    $roles = [];
    foreach ($rolesRaw as $r) {
        $roles[] = [
            'code' => (string)($r['option_id'] ?? ''),
            'label' => (string)($r['title'] ?? ''),
        ];
    }

    $statusesRaw = $listService->getOptionsByListName('Care_Team_Status');
    $statuses = [];
    foreach ($statusesRaw as $s) {
        $statuses[] = [
            'code' => (string)($s['option_id'] ?? ''),
            'label' => (string)($s['title'] ?? ''),
        ];
    }

    $payload = [
        'ok' => true,
        'team_id' => $teamId !== null ? (int)$teamId : null,
        'team_name' => (string)$teamName,
        'team_status' => (string)$teamStatus,
        'members' => $members,
        'options' => [
            'member_users' => $memberUsers,
            // Practitioner candidates currently mirror member_users — the SPA
            // editor v1 only writes user-typed members. Wire kept stable so a
            // future expansion can populate the list without a client change.
            'member_practitioners' => [],
            'roles' => $roles,
            'facilities' => $facilities,
            'statuses' => $statuses,
        ],
        'csrf' => CsrfUtils::collectCsrfToken(session: $session),
    ];

    echo json_encode($payload);
} catch (\Throwable $e) {
    error_log('care-team form-data failed: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => 'internal_error']);
}
