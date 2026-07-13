<?php

/**
 * Patient Dashboard SPA entry point.
 *
 * This single endpoint serves three roles in the SMART-on-FHIR EHR launch
 * flow:
 *
 *   1. EHR launch initiator — when clicked from the OpenEMR patient menu the
 *      request has no SMART query params, so we mint a SMARTLaunchToken
 *      using the active session's `pid` and redirect back to this URL with
 *      `iss` and `launch` parameters.
 *   2. SMART launch landing page — when `iss` + `launch` are present we
 *      simply serve the SPA shell. The SPA's `useAuth` hook reads the
 *      params from `window.location` and redirects the browser to
 *      `/oauth2/default/authorize` with PKCE.
 *   3. OAuth callback — when `code` + `state` are present we serve the same
 *      SPA shell. The SPA detects the params, POSTs the code to the token
 *      endpoint, and stores the access token in memory.
 *
 * Replaces the legacy server-rendered patient summary that previously
 * lived at this URL. The original is preserved at
 * `archive/legacy-patient-summary/demographics.php` for reference / rollback.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Nayan Bhut <nayanbhut03@gmail.com>
 * @copyright Copyright (c) 2026 Nayan Bhut
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

// The OAuth callback (mode 3) lands on this URL with `code` and `state` query
// params *after* the SMART authorize flow has invalidated the OpenEMR
// session. We must therefore bootstrap globals.php in a mode that does not
// require an authenticated session for that case. For the launch initiator
// (mode 1) we still need the session so we can read `pid`.
$hasLaunch = isset($_GET['iss'], $_GET['launch']);
$hasCallback = isset($_GET['code'], $_GET['state']);

if ($hasCallback) {
    // Skip session-bound auth — the SPA performs OAuth code exchange
    // client-side and is the page's only consumer in this mode.
    $ignoreAuth = true;
}

require_once '../../globals.php';

use OpenEMR\Common\Acl\AclMain;
use OpenEMR\Common\Session\SessionWrapperFactory;
use OpenEMR\Common\Uuid\UuidRegistry;
use OpenEMR\FHIR\Config\ServerConfig;
use OpenEMR\FHIR\SMART\SMARTLaunchToken;
use OpenEMR\Menu\PatientMenuRole;
use OpenEMR\Services\PatientService;

// ---------------------------------------------------------------------------
// HTTPS gate.
//
// The SMART EHR launch flow funnels through OpenEMR's OAuth provider, which
// signs tokens with an issuer derived from `site_addr_oath`. When that global
// is HTTPS-canonical (e.g. https://localhost:9300) but the user reached this
// page over HTTP, the authorize controller would auto-submit a cross-origin
// form to the canonical HTTPS host — where no `authserverOpenEMR` OAuth-
// server session cookie exists, so the provider would render its own Sign-In
// page mid-flow.
//
// Rather than silently redirect (which masks the protocol mismatch and bakes
// the canonical host into a 302), refuse to serve the SPA over HTTP at all.
// The user gets a clear message and reaches the dashboard the next time they
// load OpenEMR over HTTPS. In production behind a TLS-terminating proxy
// (Railway, Nginx, etc.) the request arrives without `HTTPS=on` but with
// `X-Forwarded-Proto: https`, which we honor — so this branch only fires for
// genuinely-plaintext access. Skips entirely when site_addr_oath is unset or
// HTTP-canonical (operators serving HTTP-only by intention shouldn't see
// this gate). See GitLab issue #40.
// ---------------------------------------------------------------------------
$siteAddrOath = $GLOBALS['site_addr_oath'] ?? '';
$isHttps = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
    || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
$canonicalIsHttps = str_starts_with($siteAddrOath, 'https://');

if ($canonicalIsHttps && !$isHttps) {
    http_response_code(403);
    header('Content-Type: text/html; charset=utf-8');
    $canonicalUrl = htmlspecialchars($siteAddrOath, ENT_QUOTES, 'UTF-8');
    echo <<<HTML
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>HTTPS required</title>
    <style>
        body { font-family: system-ui, sans-serif; max-width: 540px; margin: 80px auto; padding: 0 24px; color: #1c2330; }
        h1 { font-size: 18px; margin-bottom: 12px; }
        p { font-size: 14px; line-height: 1.5; color: #2a3340; }
        code { background: #f4f6f9; padding: 1px 6px; border-radius: 3px; font-family: ui-monospace, monospace; }
    </style>
</head>
<body>
    <h1>This dashboard requires HTTPS</h1>
    <p>The patient dashboard's authentication flow only operates over a secure connection. Please access OpenEMR at <code>{$canonicalUrl}</code> and try again.</p>
</body>
</html>
HTML;
    exit;
}

if (!$hasCallback) {
    if (!AclMain::aclCheckCore('patients', 'demo')) {
        echo xlt('Not authorized');
        exit;
    }
}

$session = SessionWrapperFactory::getInstance()->getActiveSession();

// Mirror the legacy demographics.php behavior: when an `?set_pid=N` query
// param is present (typically from the patient finder), update the session's
// active pid before reading it. Lets deep links land directly on the
// dashboard for a specific patient. Skipped in mode 3 (OAuth callback)
// since the session is already locked to the launch-bound patient.
if (!$hasCallback && isset($_GET['set_pid']) && is_numeric($_GET['set_pid'])) {
    require_once $GLOBALS['srcdir'] . '/pid.inc.php';
    setpid((int)$_GET['set_pid']);
    $patientService = new PatientService();
    $newPatient = $patientService->findByPid((string)(int)$_GET['set_pid']);
    if (!empty($newPatient)) {
        $patientService->touchRecentPatientList($newPatient);
    }
}

$pid = $session->get('pid');

// ---------------------------------------------------------------------------
// Mode 1: EHR launch initiator. Mint a launch token and redirect.
// ---------------------------------------------------------------------------
if (!$hasLaunch && !$hasCallback) {
    if (empty($pid)) {
        echo xlt('No patient is currently selected.');
        exit;
    }

    $patientService = new PatientService();
    UuidRegistry::createMissingUuidsForTables(['patient_data']);
    $puuid = UuidRegistry::uuidToString($patientService->getUuid((string) $pid));

    $launchToken = new SMARTLaunchToken($puuid);
    $launchToken->setIntent(SMARTLaunchToken::INTENT_PATIENT_DEMOGRAPHICS_DIALOG);
    $serializedLaunch = $launchToken->serialize();

    $issuer = (new ServerConfig())->getFhirUrl();

    $appUrl = $GLOBALS['webroot'] . '/interface/patient_file/summary/demographics.php';
    $redirect = $appUrl
        . '?iss=' . urlencode($issuer)
        . '&launch=' . urlencode((string) $serializedLaunch);

    header('Location: ' . $redirect);
    exit;
}

// ---------------------------------------------------------------------------
// Mode 2 + 3: serve the SPA shell. The SPA reads the query params and either
// kicks off the OAuth authorize redirect or completes the code exchange.
//
// The OpenEMR patient nav (Dashboard / History / Assessments ▾ / Report /
// Documents / Document Inbox / Transactions) is rendered by the React SPA
// itself. We resolve the menu structure server-side from
// PatientMenuRole::getMenu() and pass it through the bootstrap blob so the
// SPA has the same data the legacy demographics.php had — without
// re-fetching it over the network and without making the SPA aware of
// OpenEMR's per-user/per-role menu JSON.
//
// Mode 3 lands here with $ignoreAuth=true and a possibly-invalidated
// session. PatientMenuRole reads the session under the hood, so we try and
// swallow errors — the SPA falls back to an empty menu when the resolution
// fails (the cards still render).
// ---------------------------------------------------------------------------
$dashboardMenu = [];
try {
    $menuPatient = new PatientMenuRole();
    $dashboardMenu = $menuPatient->getMenu();
} catch (Throwable $e) {
    error_log('dashboard menu resolve failed: ' . $e->getMessage());
}
$dashboardMenuJson = json_encode($dashboardMenu, JSON_UNESCAPED_SLASHES);
$dashboardPidJson = json_encode((string)($pid ?? ''));
$dashboardWebrootJson = json_encode($GLOBALS['webroot'] ?? '');
?><!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title><?php echo xlt('Patient Dashboard'); ?></title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="<?php echo $GLOBALS['webroot']; ?>/public/assets/patient-dashboard/assets/index.css" />
    <script>
      // Bootstrap config consumed by the SPA at startup. Keeping it on the
      // page (rather than hardcoded in the bundle) lets ops change the
      // client_id or scopes without rebuilding.
      window.__OPENEMR_DASHBOARD__ = {
        clientId: 'patient-dashboard-spa',
        redirectUri: window.location.origin + '/interface/patient_file/summary/demographics.php',
        authorizeEndpoint: window.location.origin + '/oauth2/default/authorize',
        tokenEndpoint: window.location.origin + '/oauth2/default/token',
        menu: <?php echo $dashboardMenuJson; ?>,
        webroot: <?php echo $dashboardWebrootJson; ?>,
        pid: <?php echo $dashboardPidJson; ?>,
        scopes: [
          'openid',
          'fhirUser',
          'launch',
          'launch/patient',
          'patient/Patient.rs',
          'patient/AllergyIntolerance.rs',
          'patient/Condition.rs',
          // MedicationStatement is in the PRD but not implemented by
          // OpenEMR's FHIR server; using MedicationRequest until added.
          'patient/MedicationRequest.rs',
          'patient/CareTeam.rs',
          'patient/Observation.rs',
          'offline_access',
        ],
      };
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/public/assets/patient-dashboard/index.js"></script>
  </body>
</html>
