<?php

/**
 * Automatic OpenEMR install driven by environment variables.
 *
 * This file replaces the auto_configure.php that ships in the upstream
 * openemr/openemr Docker image. The upstream version instantiates the
 * Installer with a single argument; this fork's Installer requires a
 * PSR-3 logger as the second constructor argument, so the upstream copy
 * fatals with ArgumentCountError. Override it here so the COPY in our
 * Dockerfile picks up the corrected version when overlaying the repo
 * onto the upstream image.
 *
 * @package OpenEMR
 * @license https://github.com/openemr/openemr/blob/master/LICENSE GNU GPL 3
 */

declare(strict_types=1);

// Buffer all output so the demo-seed block at the bottom can still
// session_start() — the openemr/openemr:flex base image runs this script
// in a context where PHP would otherwise emit response headers eagerly.
// Without this, the seeder fails with "headers already sent" the moment
// it tries to wire SessionWrapperFactory.
if (!ob_get_level()) {
    ob_start();
}

require_once __DIR__ . '/vendor/autoload.php';

use OpenEMR\BC\ServiceContainer;

$envOrDefault = static function (string $key, string $default): string {
    $value = getenv($key);
    if ($value === false || $value === '') {
        return $default;
    }
    return $value;
};

$cgi = [
    'iuser'                    => $envOrDefault('OE_USER', 'admin'),
    'iuserpass'                => $envOrDefault('OE_PASS', 'pass'),
    'iuname'                   => $envOrDefault('OE_USER_LASTNAME', 'Administrator'),
    'iufname'                  => $envOrDefault('OE_USER_FIRSTNAME', 'Administrator'),
    'igroup'                   => $envOrDefault('OE_GROUP', 'Default'),
    'server'                   => $envOrDefault('MYSQL_HOST', 'localhost'),
    'loginhost'                => $envOrDefault('OPENEMR_HOST', '%'),
    'port'                     => $envOrDefault('MYSQL_PORT', '3306'),
    'root'                     => $envOrDefault('MYSQL_ROOT_USER', 'root'),
    'rootpass'                 => $envOrDefault('MYSQL_ROOT_PASS', ''),
    'login'                    => $envOrDefault('MYSQL_USER', 'openemr'),
    'pass'                     => $envOrDefault('MYSQL_PASS', 'openemr'),
    'dbname'                   => $envOrDefault('MYSQL_DATABASE', 'openemr'),
    'collate'                  => $envOrDefault('MYSQL_COLLATE', 'utf8mb4_general_ci'),
    'site'                     => $envOrDefault('OPENEMR_SITE', 'default'),
    'source_site_id'           => '',
    'clone_database'           => '',
    'no_root_db_access'        => $envOrDefault('NO_ROOT_DB_ACCESS', ''),
    'development_translations' => '',
];

$installer = new Installer($cgi, ServiceContainer::getLogger());

if (! $installer->quick_install()) {
    fwrite(STDERR, 'ERROR: ' . $installer->error_message . PHP_EOL);
    exit(1);
}

echo $installer->debug_message . PHP_EOL;
echo 'OpenEMR auto-configured successfully.' . PHP_EOL;

// AgentForge schema migrations — must run after the OpenEMR installer
// (which creates the categories table + categories_seq) but before the
// SMART client setup, the fixture seeders, or any chat-time code that
// touches agentforge_document_extractions / agentforge_resource_links /
// the AgentForge document categories. The runner is idempotent: tracks
// applied versions in agentforge_schema_migrations so a container
// restart re-runs only the unapplied migrations.
//
// We deliberately don't go through Doctrine's bin/console — both bin/
// console and ./cli call Symfony\Console\Application::addCommand(),
// which only exists in symfony/console 7.4+, and the upstream image
// ships 7.3. Running `composer install` to fix that would upgrade
// ~16 unrelated upstream packages (swagger-php 3 → 6, etc.) and risk
// breaking core OpenEMR. The flat PHP runner avoids both problems.
$migrationsScript = __DIR__ . '/contrib/agentforge/run_migrations.php';
if (is_file($migrationsScript)) {
    $cmd = 'php ' . escapeshellarg($migrationsScript) . ' 2>&1';
    $output = [];
    $rc = 0;
    exec($cmd, $output, $rc);
    if ($rc === 0) {
        echo 'AgentForge: schema migrations applied.' . PHP_EOL;
        if ($output !== []) {
            echo '  ' . implode(PHP_EOL . '  ', $output) . PHP_EOL;
        }
    } else {
        fwrite(
            STDERR,
            'AgentForge: run_migrations.php exited ' . $rc . ': '
            . implode("\n", $output) . PHP_EOL
        );
        // Don't abort — auto_configure.php traditionally treats AgentForge
        // hooks as non-fatal so a malformed env doesn't block the install.
    }
}

// Enable the REST/FHIR API + OAuth password-grant globals. The fork's
// installer leaves these at 0, which makes /oauth2/default/registration
// return "API is disabled" and blocks the AgentForge sidecar from
// fetching FHIR data. Flipping them here is idempotent — re-running the
// auto-config on a redeploy just sets them back to 1.
try {
    $apiGlobalsDsn = sprintf(
        'mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4',
        $envOrDefault('MYSQL_HOST', 'localhost'),
        $envOrDefault('MYSQL_PORT', '3306'),
        $envOrDefault('MYSQL_DATABASE', 'openemr'),
    );
    $apiGlobalsPdo = new PDO(
        $apiGlobalsDsn,
        $envOrDefault('MYSQL_USER', 'openemr'),
        $envOrDefault('MYSQL_PASS', 'openemr'),
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION],
    );
    $apiGlobalsPdo
        ->prepare(
            "UPDATE globals SET gl_value = '1'
             WHERE gl_name IN ('rest_api','rest_fhir_api','rest_system_scopes_api','oauth_password_grant')",
        )
        ->execute();
    echo "AgentForge: enabled rest_api, rest_fhir_api, rest_system_scopes_api, oauth_password_grant." . PHP_EOL;

    // SMART backend-services validates the OAuth `aud` claim against
    // globals.site_addr_oath. The fork's installer leaves it as just
    // "https:" on a fresh install, which makes every client_credentials
    // token request fail with 400 invalid_client. Pin it to the public
    // URL so the AgentForge sidecar's token round-trip works on first
    // boot. Idempotent: re-runs just refresh the value.
    $publicUrl = (string) (
        getenv('OPENEMR_PUBLIC_URL')
        ?: (getenv('RAILWAY_PUBLIC_DOMAIN') ? 'https://' . getenv('RAILWAY_PUBLIC_DOMAIN') : '')
    );
    if ($publicUrl !== '') {
        $apiGlobalsPdo
            ->prepare(
                "INSERT INTO globals (gl_name, gl_index, gl_value)
                 VALUES ('site_addr_oath', 0, ?)
                 ON DUPLICATE KEY UPDATE gl_value = VALUES(gl_value)"
            )
            ->execute([$publicUrl]);
        echo "AgentForge: site_addr_oath pinned to $publicUrl" . PHP_EOL;
    }
} catch (\Throwable $e) {
    fwrite(STDERR, 'AgentForge: failed to enable API globals (non-fatal): ' . $e->getMessage() . PHP_EOL);
}

// Register the SMART backend-services system OAuth client so the
// AgentForge sidecar can mint FHIR tokens on first request. This
// requires both the JWKS (public key) and a stable client_id to be
// supplied via env — without both, skip silently and let the operator
// run setup_system_client.php manually for local dev.
if (
    getenv('OPENEMR_AGENTFORGE_JWKS_JSON')
    && getenv('OPENEMR_FHIR_CLIENT_ID')
) {
    $script = __DIR__ . '/contrib/agentforge/setup_system_client.php';
    $cmd = 'php ' . escapeshellarg($script) . ' --quiet 2>&1';
    $output = [];
    $rc = 0;
    exec($cmd, $output, $rc);
    if ($rc === 0) {
        echo 'AgentForge: SMART system client registered.' . PHP_EOL;
    } else {
        fwrite(STDERR, 'AgentForge: setup_system_client.php exited ' . $rc . ': ' . implode("\n", $output) . PHP_EOL);
    }
}

$railwayEnv = getenv('RAILWAY_ENVIRONMENT');

// Synthea demo seed has been archived to contrib/agentforge/archive/. The
// active demo-data flow is the demo-PDF block below.

// AgentForge demo-PDF seed gate. The MVP demo-data default for Railway deploys.
//
//   1. AGENTFORGE_DEMO_PDF_SEED set explicitly → that value wins.
//      An operator setting it to "0" disables the seed even on Railway.
//   2. Else if RAILWAY_ENVIRONMENT is non-empty → default to on. Railway
//      deploys land on the four-patient real-document demo automatically.
//   3. Else (local dev, plain `docker run`, CI) → off.
//
// The demo-PDF seeder creates the four AGENTFORGE-DEMO-PDF-001..004 patients
// that own the eight committed real example documents under
// `agent/data/fixtures/{intake-forms,lab-results}/`. It is idempotent —
// patients already present at the right pubpid are left alone. Rerunning
// is safe.
$rawDemoPdfSeed = getenv('AGENTFORGE_DEMO_PDF_SEED');
if ($rawDemoPdfSeed !== false && $rawDemoPdfSeed !== '') {
    $shouldSeedDemoPdf = $rawDemoPdfSeed === '1';
    $demoPdfTriggerSource = "AGENTFORGE_DEMO_PDF_SEED=$rawDemoPdfSeed";
} elseif ($railwayEnv !== false && $railwayEnv !== '') {
    $shouldSeedDemoPdf = true;
    $demoPdfTriggerSource = "RAILWAY_ENVIRONMENT=$railwayEnv";
} else {
    $shouldSeedDemoPdf = false;
    $demoPdfTriggerSource = '';
}

if ($shouldSeedDemoPdf) {
    echo "AgentForge demo-PDF seed: triggered by $demoPdfTriggerSource" . PHP_EOL;
    $script = __DIR__ . '/contrib/agentforge/seed_demo_pdf_patients.php';
    if (!is_file($script)) {
        fwrite(STDERR, 'AgentForge demo-PDF seed: script not found at ' . $script . PHP_EOL);
    } else {
        // Run in a fresh PHP process so it can boot its own globals stack
        // without colliding with the in-process Synthea seeder above. The
        // script prints a JSON array on stdout that the Node-side ingest
        // step (handled separately by the agent service bootstrap) can
        // consume; here we just want it to register the patients.
        $cmd = 'php ' . escapeshellarg($script) . ' --quiet 2>&1';
        $output = [];
        $rc = 0;
        exec($cmd, $output, $rc);
        if ($rc === 0) {
            echo 'AgentForge demo-PDF seed: complete.' . PHP_EOL;
        } else {
            fwrite(STDERR, 'AgentForge demo-PDF seed exited ' . $rc . ' (non-fatal): '
                . implode("\n", $output) . PHP_EOL);
        }
    }
}
