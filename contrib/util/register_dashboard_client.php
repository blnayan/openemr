<?php

/**
 * Idempotent registration of the patient-dashboard SMART client.
 *
 * Creates (or updates) a pre-approved public PKCE SMART-on-FHIR client for
 * the React patient-dashboard SPA. The client is flagged as
 * skip_ehr_launch_authorization_flow=1 so the user is not shown a consent
 * screen during EHR launch (the global oauth_ehr_launch_authorization_flow_skip
 * must also be 1 — this script also enforces that).
 *
 * Usage (from inside the openemr container):
 *
 *     docker compose -f docker/development-easy/docker-compose.yml exec openemr \
 *         php contrib/util/register_dashboard_client.php
 *
 * Output: prints the client_id of the registered client. Re-running the script
 * is safe — it upserts the same client_id every time.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Nayan Bhut <nayanbhut03@gmail.com>
 * @copyright Copyright (c) 2026 Nayan Bhut
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "This script must be run from the command line.\n");
    exit(1);
}

// We need the ignoreAuth + cli sentinels before bootstrapping globals.php.
$ignoreAuth = true;
$sessionAllowWrite = true;
$_SERVER['HTTP_HOST'] = $_SERVER['HTTP_HOST'] ?? 'localhost';

require_once __DIR__ . '/../../interface/globals.php';

// Fixed, well-known client_id so the SPA can hardcode it.
const DASHBOARD_CLIENT_ID = 'patient-dashboard-spa';
const DASHBOARD_CLIENT_NAME = 'OpenEMR Patient Dashboard SPA';

// Same-origin redirect/launch URIs. The OpenEMR development-easy stack serves
// HTTP on 8300 and HTTPS on 9300. We register both so the script works against
// either dev URL.
$redirectUris = [
    'http://localhost:8300/interface/patient_file/summary/demographics.php',
    'https://localhost:9300/interface/patient_file/summary/demographics.php',
    // The selenium container accesses OpenEMR via the docker-internal
    // hostname `openemr`. Including this URL so e2e smoke tests against
    // the selenium hub work without a separate registration. Harmless on
    // production — `openemr` won't resolve from the public internet.
    'https://openemr/interface/patient_file/summary/demographics.php',
    'http://openemr/interface/patient_file/summary/demographics.php',
];
// EHR launch URI (where OpenEMR redirects when launching the app).
$launchUri = 'http://localhost:8300/interface/patient_file/summary/demographics.php';

// Production deployments (Railway) inject the public origin via
// OPENEMR_PUBLIC_URL. Append the matching redirect URI and prefer it as the
// launch URI so the SPA's OAuth authorize call validates against the same
// host the browser is actually on.
$publicUrl = getenv('OPENEMR_PUBLIC_URL');
if (is_string($publicUrl) && $publicUrl !== '') {
    $publicRedirect = rtrim($publicUrl, '/')
        . '/interface/patient_file/summary/demographics.php';
    if (!in_array($publicRedirect, $redirectUris, true)) {
        $redirectUris[] = $publicRedirect;
    }
    $launchUri = $publicRedirect;
}

$scopes = [
    'openid',
    'fhirUser',
    'launch',
    'launch/patient',
    'patient/Patient.rs',
    'patient/AllergyIntolerance.rs',
    'patient/Condition.rs',
    // OpenEMR's FHIR server does not implement MedicationStatement; the PRD
    // lists it for the Medications card but the actual Medications card will
    // need to read MedicationRequest until that resource is added. Leaving
    // MedicationStatement.rs out of the registered scope keeps the OAuth
    // authorize flow valid.
    'patient/MedicationRequest.rs',
    'patient/CareTeam.rs',
    'patient/Observation.rs',
    'offline_access',
];

$scopeString = implode(' ', $scopes);
$redirectString = implode('|', $redirectUris);
$grantTypes = 'authorization_code refresh_token';

$existing = sqlQueryNoLog(
    'SELECT client_id FROM oauth_clients WHERE client_id = ?',
    [DASHBOARD_CLIENT_ID]
);

if ($existing) {
    sqlStatement(
        'UPDATE oauth_clients SET '
        . 'client_name = ?, '
        . 'client_secret = NULL, '
        . 'contacts = ?, '
        . 'redirect_uri = ?, '
        . 'grant_types = ?, '
        . 'scope = ?, '
        . 'site_id = ?, '
        . 'is_confidential = 0, '
        . 'initiate_login_uri = ?, '
        . 'is_enabled = 1, '
        . 'skip_ehr_launch_authorization_flow = 1, '
        . 'dsi_type = 0 '
        . 'WHERE client_id = ?',
        [
            DASHBOARD_CLIENT_NAME,
            'admin@example.com',
            $redirectString,
            $grantTypes,
            $scopeString,
            $_SESSION['site_id'] ?? 'default',
            $launchUri,
            DASHBOARD_CLIENT_ID,
        ]
    );
    fwrite(STDOUT, "Updated existing dashboard SMART client.\n");
} else {
    sqlStatement(
        'INSERT INTO oauth_clients ('
        . 'client_id, client_role, client_name, client_secret, registration_token, '
        . 'registration_uri_path, register_date, revoke_date, contacts, redirect_uri, '
        . 'grant_types, scope, user_id, site_id, is_confidential, logout_redirect_uris, '
        . 'jwks_uri, jwks, initiate_login_uri, endorsements, policy_uri, tos_uri, '
        . 'is_enabled, skip_ehr_launch_authorization_flow, dsi_type'
        . ') VALUES (?, ?, ?, NULL, NULL, NULL, NOW(), NULL, ?, ?, ?, ?, NULL, ?, 0, NULL, '
        . 'NULL, NULL, ?, NULL, NULL, NULL, 1, 1, 0)',
        [
            DASHBOARD_CLIENT_ID,
            'user',
            DASHBOARD_CLIENT_NAME,
            'admin@example.com',
            $redirectString,
            $grantTypes,
            $scopeString,
            $_SESSION['site_id'] ?? 'default',
            $launchUri,
        ]
    );
    fwrite(STDOUT, "Inserted new dashboard SMART client.\n");
}

// Make absolutely sure the global skip-auth flag is on; the global is what
// allows the per-client skip_ehr_launch_authorization_flow flag to take effect.
$globalRow = sqlQueryNoLog(
    "SELECT gl_value FROM globals WHERE gl_name = 'oauth_ehr_launch_authorization_flow_skip'"
);
if ($globalRow === false || ($globalRow['gl_value'] ?? '') !== '1') {
    if ($globalRow === false) {
        sqlStatement(
            "INSERT INTO globals (gl_name, gl_index, gl_value) "
            . "VALUES ('oauth_ehr_launch_authorization_flow_skip', 0, '1')"
        );
    } else {
        sqlStatement(
            "UPDATE globals SET gl_value = '1' "
            . "WHERE gl_name = 'oauth_ehr_launch_authorization_flow_skip'"
        );
    }
    fwrite(STDOUT, "Enabled oauth_ehr_launch_authorization_flow_skip global.\n");
}

fwrite(
    STDOUT,
    "\nclient_id: " . DASHBOARD_CLIENT_ID . "\n"
    . "redirect_uri (paste into SPA config): " . $redirectUris[0] . "\n"
    . "launch_uri: " . $launchUri . "\n"
    . "scopes: " . $scopeString . "\n"
);
