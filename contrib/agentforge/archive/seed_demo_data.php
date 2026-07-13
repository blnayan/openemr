#!/usr/bin/php
<?php

/**
 * AgentForge demo-data seeder CLI — Synthea CSV source.
 *
 * Usage:
 *   php contrib/agentforge/seed_demo_data.php [--reset] [--reset-only]
 *                                              [--limit=N] [--site=default]
 *                                              [--cache-dir=/path]
 *                                              [--quiet]
 *
 * Flags:
 *   --reset       Drop AGENTFORGE demo patients before re-seeding.
 *   --reset-only  Drop demo patients without re-seeding (for tear-down).
 *   --limit=N     Patient cap. Default 10. Pass --limit=0 to load every
 *                 Synthea patient (~117); any positive integer caps to
 *                 that many.
 *   --site        OpenEMR site directory (default "default").
 *   --cache-dir   Where the Synthea CSV zip is downloaded / extracted.
 *                 Defaults to the value of AGENTFORGE_SYNTHEA_DIR or
 *                 sites/<site>/documents/agentforge-synthea.
 *   --quiet       Suppress per-row log output.
 *
 * The upstream zip URL is the latest pinned to:
 *   https://synthetichealth.github.io/synthea-sample-data/downloads/latest/synthea_sample_data_csv_latest.zip
 *
 * @package OpenEMR
 * @license https://github.com/openemr/openemr/blob/master/LICENSE GNU GPL 3
 */

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "This script must be run from the command line.\n");
    exit(1);
}

const SYNTHEA_ZIP_URL = 'https://synthetichealth.github.io/synthea-sample-data/downloads/latest/synthea_sample_data_csv_latest.zip';

$args = getopt('', ['reset', 'reset-only', 'site::', 'limit::', 'cache-dir::', 'quiet']);
$site = isset($args['site']) && $args['site'] !== false ? (string) $args['site'] : 'default';
$reset = isset($args['reset']) || isset($args['reset-only']);
$resetOnly = isset($args['reset-only']);
$quiet = isset($args['quiet']);
// --limit absent → null → DemoDataSeeder applies its 10-patient default.
// --limit=0    → 0    → DemoDataSeeder loads every Synthea patient.
// --limit=N    → N    → DemoDataSeeder caps to N.
$limit = isset($args['limit']) && $args['limit'] !== false ? (int) $args['limit'] : null;

$webdir = dirname(__DIR__, 2);

$_GET['site'] = $site;
$ignoreAuth = 1;
require_once $webdir . '/interface/globals.php';
require_once __DIR__ . '/lib/synthea_download.php';
require_once __DIR__ . '/lib/SyntheaLoader.php';
require_once __DIR__ . '/lib/AppointmentScheduler.php';
require_once __DIR__ . '/lib/DemoDataSeeder.php';

use OpenEMR\AgentForge\DemoSeed\DemoDataSeeder;
use OpenEMR\AgentForge\DemoSeed\SyntheaDownloader;
use OpenEMR\Common\Session\SessionWrapperFactory;

// VitalsCalculatedService and similar post-save listeners read authUserID
// from the session and TypeError when null. Admin is guaranteed at id=1
// by Installer::add_initial_user.
SessionWrapperFactory::getInstance()->getActiveSession()->set('authUserID', 1);

$cacheDir = (string) (
    $args['cache-dir']
    ?? getenv('AGENTFORGE_SYNTHEA_DIR')
    ?: $webdir . '/sites/' . $site . '/documents/agentforge-synthea'
);

$seeder = new DemoDataSeeder();

try {
    if ($reset) {
        $deleted = $seeder->reset();
        if (!$quiet) {
            fwrite(STDOUT, "Reset: removed $deleted demo patient(s)\n");
        }
        if ($resetOnly) {
            exit(0);
        }
    }

    $csvDir = SyntheaDownloader::ensureCsvDir($cacheDir, $quiet);
    if (!$quiet) {
        fwrite(STDOUT, "Loading Synthea CSV pack from $csvDir\n");
    }

    $startedAt = microtime(true);
    $progress = $quiet ? null : static function (int $i, int $total, string $name): void {
        if ($i === 1 || ($total > 0 && $i === $total) || $i % 10 === 0) {
            $totalStr = $total > 0 ? sprintf('/%3d', $total) : '';
            fwrite(STDOUT, sprintf("  [%3d%s] %s\n", $i, $totalStr, $name));
        }
    };

    $result = $seeder->seed($csvDir, $limit, $progress);

    $elapsed = microtime(true) - $startedAt;
    fwrite(STDOUT, sprintf(
        "OK: loaded %d Synthea patient(s) (skipped %d, %d appointments) in %.1fs.\n",
        count($result['patients']),
        $result['skipped'],
        $result['appointments'] ?? 0,
        $elapsed
    ));
    if (!$quiet && !empty($result['log'])) {
        $tail = array_slice($result['log'], -8);
        foreach ($tail as $line) {
            fwrite(STDOUT, "  $line\n");
        }
    }
} catch (\Throwable $e) {
    fwrite(STDERR, "FAILED: " . $e->getMessage() . "\n");
    fwrite(STDERR, $e->getTraceAsString() . "\n");
    exit(1);
}

