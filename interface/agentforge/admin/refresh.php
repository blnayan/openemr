<?php

/**
 * AgentForge demo-data refresh endpoint.
 *
 * Lets a Railway-deployed demo be re-seeded from outside the container without
 * `railway run` / exec access. Authenticated by a single shared secret in the
 * AGENTFORGE_ADMIN_TOKEN environment variable. Disabled (404) when that env
 * var is not set, so accidental upstream merges that re-introduce a demo flag
 * cannot expose this endpoint in a production HIPAA deployment.
 *
 * Authorisation: header `X-AgentForge-Admin-Token: <secret>`.
 *
 * Methods:
 *   POST  /interface/agentforge/admin/refresh.php          → reset + seed
 *   POST  /interface/agentforge/admin/refresh.php?reset=1  → reset only
 *
 * Returns JSON:
 *   { "status": "ok", "patients": [{ "name": "...", "pid": N, "uuid": "...",
 *                                    "pubpid": "AGENTFORGE-..." }, ...] }
 *
 * Why this lives outside the agent service: the agent container has no
 * database access (D11). The seeder runs in the OpenEMR PHP context where
 * the DB is already configured.
 *
 * @package OpenEMR
 * @license https://github.com/openemr/openemr/blob/master/LICENSE GNU GPL 3
 */

declare(strict_types=1);

// Bootstrap OpenEMR with no session / no auth — we are validating against an
// out-of-band shared secret, not an OpenEMR user.
$ignoreAuth = 1;
require_once dirname(__DIR__, 3) . '/interface/globals.php';
require_once dirname(__DIR__, 3) . '/contrib/agentforge/lib/SyntheaLoader.php';
require_once dirname(__DIR__, 3) . '/contrib/agentforge/lib/AppointmentScheduler.php';
require_once dirname(__DIR__, 3) . '/contrib/agentforge/lib/DemoDataSeeder.php';

use OpenEMR\AgentForge\DemoSeed\DemoDataSeeder;
use OpenEMR\Common\Session\SessionWrapperFactory;
use Symfony\Component\Process\Process;

header('Content-Type: application/json');
header('Cache-Control: no-store');

$expected = (string) (getenv('AGENTFORGE_ADMIN_TOKEN') ?: '');
if ($expected === '') {
    http_response_code(404);
    echo json_encode(['error' => 'not_found']);
    return;
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    http_response_code(405);
    header('Allow: POST');
    echo json_encode(['error' => 'method_not_allowed']);
    return;
}

$presented = (string) ($_SERVER['HTTP_X_AGENTFORGE_ADMIN_TOKEN'] ?? '');
if ($presented === '' || !hash_equals($expected, $presented)) {
    http_response_code(401);
    echo json_encode(['error' => 'unauthorized']);
    return;
}

$resetOnly = isset($_GET['reset']) && $_GET['reset'] !== '0';

try {
    // Suppress post-save listener noise.
    SessionWrapperFactory::getInstance()->getActiveSession()->set('authUserID', 1);

    $seeder = new DemoDataSeeder();
    $deleted = $seeder->reset();

    if ($resetOnly) {
        echo json_encode(['status' => 'ok', 'reset_only' => true, 'deleted' => $deleted]);
        return;
    }

    $patientScript = dirname(__DIR__, 3) . '/contrib/agentforge/seed_demo_pdf_patients.php';
    $patientProcess = new Process(['php', $patientScript, '--quiet']);
    $patientProcess->setTimeout(600);
    $patientProcess->run();
    if (!$patientProcess->isSuccessful()) {
        throw new \RuntimeException('seed_demo_pdf_patients.php exited ' . $patientProcess->getExitCode());
    }
    $patientsRaw = json_decode($patientProcess->getOutput(), true);
    $patients = is_array($patientsRaw) ? $patientsRaw : [];

    // Drive the new UploadController + ConfirmCommitter chain for every
    // committed fixture under agent/data/fixtures/. The Node helper
    // walks the corpus and shells back into ingest_demo_fixture.php
    // (which auto-confirms via ConfirmCommitter), so a successful
    // refresh leaves the demo patients with committed inbox rows.
    $fixtureScript = dirname(__DIR__, 3) . '/agent/scripts/seed-demo-fixtures.mjs';
    $fixtures = ['skipped' => true];
    if (is_file($fixtureScript)) {
        $fixtureProcess = new Process(['node', $fixtureScript]);
        $fixtureProcess->setTimeout(600);
        $fixtureProcess->run();
        $fixtureLines = preg_split('/\r?\n/', $fixtureProcess->getErrorOutput()) ?: [];
        $fixtures = [
            'rc'     => (int) $fixtureProcess->getExitCode(),
            'stderr' => array_slice($fixtureLines, -20),
        ];
    }

    echo json_encode([
        'status'   => 'ok',
        'deleted'  => $deleted,
        'patients' => $patients,
        'fixtures' => $fixtures,
    ]);
} catch (\Throwable $e) {
    http_response_code(500);
    error_log('agentforge_refresh_failed: ' . $e->getMessage());
    echo json_encode(['status' => 'error', 'error' => 'seed_failed']);
}
