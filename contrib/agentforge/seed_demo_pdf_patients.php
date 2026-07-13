#!/usr/bin/php
<?php

/**
 * AgentForge demo-PDF patient seeder (Document Inbox rework).
 *
 * Creates the four demo patients used by the AgentForge fixture-PDF
 * demo flow. These are NOT Synthea patients — they own the eight
 * committed real example documents under `agent/data/fixtures/`
 * (`intake-forms/p{NN}-*` and `lab-results/p{NN}-*`). Demographics
 * are extracted verbatim from those source documents — no fabricated
 * MRNs, DOBs, or addresses.
 *
 * After this script runs, `agent/scripts/seed-demo-fixtures.mjs` walks
 * the fixture directories and shells into
 * `contrib/agentforge/ingest_demo_fixture.php`, which drives the new
 * {@see OpenEMR\AgentForge\Controller\UploadController} end-to-end and
 * auto-confirms each extraction via
 * {@see OpenEMR\AgentForge\Persistence\ConfirmCommitter} with the
 * synthetic system reviewer (admin). The legacy Documents-tab
 * subscriber path that previously routed by AgentForge category names
 * has been removed (issue 25).
 *
 *     AGENTFORGE-DEMO-PDF-001   Margaret L. Chen   (lipid panel + intake)
 *     AGENTFORGE-DEMO-PDF-002   James E. Whitaker  (CBC + intake)
 *     AGENTFORGE-DEMO-PDF-003   Sofia M. Reyes     (HbA1c PNG + intake)
 *     AGENTFORGE-DEMO-PDF-004   Robert Kowalski    (CMP + intake)
 *
 * The pubpids share the `AGENTFORGE-` umbrella that the existing
 * Synthea reset path matches with `pubpid LIKE 'AGENTFORGE-%'`,
 * so the four are picked up by `--reset-only` here and by
 * `seed_demo_data.php --reset-only` automatically.
 *
 * Re-running this script is idempotent — patients already present at
 * the right pubpid are reported as `skipped_exists`. A single JSON
 * array on stdout describes the outcome (consumed by
 * `agent/scripts/seed-demo-fixtures.mjs`).
 *
 * Usage:
 *   php contrib/agentforge/seed_demo_pdf_patients.php
 *                              [--site=default] [--quiet]
 *                              [--reset-only]
 *                              [--clear-all-patients]
 *
 * Flags:
 *   --reset-only           Delete every AGENTFORGE-* patient and exit.
 *                          Idempotent. Does NOT seed.
 *   --clear-all-patients   DESTRUCTIVE. Deletes every patient_data
 *                          row in the dev DB (not just AGENTFORGE-*),
 *                          then seeds the four demo patients. Required
 *                          for a clean MVP demo on a host that
 *                          previously had Synthea data. Logged loudly.
 *
 * Stdout shape:
 *   [
 *     {"pubpid":"AGENTFORGE-DEMO-PDF-001","pid":1234,
 *      "name":"Margaret Chen","status":"created"},
 *     ...
 *   ]
 *
 * @package OpenEMR
 * @license https://github.com/openemr/openemr/blob/master/LICENSE GNU GPL 3
 */

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "This script must be run from the command line.\n");
    exit(1);
}

$args = getopt('', ['site::', 'quiet', 'reset-only', 'clear-all-patients']);
$siteRaw = $args['site'] ?? null;
$site = is_string($siteRaw) && $siteRaw !== '' ? $siteRaw : 'default';
$quiet = isset($args['quiet']);
$resetOnly = isset($args['reset-only']);
$clearAllPatients = isset($args['clear-all-patients']);

$webdir = dirname(__DIR__, 2);

// `interface/globals.php` reads `$_GET['site']` to pick the OpenEMR site
// directory. CLI bootstrap is the one place a superglobal write is the
// established pattern (mirrors `seed_demo_data.php`).
// @phpstan-ignore openemr.forbiddenRequestGlobals
$_GET['site'] = $site;
$ignoreAuth = 1;
require_once $webdir . '/interface/globals.php';
require_once __DIR__ . '/lib/SyntheaLoader.php';
require_once __DIR__ . '/lib/AppointmentScheduler.php';
require_once __DIR__ . '/lib/DemoDataSeeder.php';

use OpenEMR\AgentForge\DemoSeed\DemoDataSeeder;
use OpenEMR\Common\Database\QueryUtils;
use OpenEMR\Common\Session\SessionUtil;
use OpenEMR\Common\Uuid\UuidRegistry;
use OpenEMR\Services\ConditionService;
use OpenEMR\Services\EncounterService;
use OpenEMR\Services\PatientService;
use OpenEMR\Services\PrescriptionService;

// VitalsCalculatedService and similar post-save listeners read authUserID
// from the session and TypeError when null.
SessionUtil::setSession('authUserID', 1);

/**
 * Demo patients — verbatim demographics from the eight real example
 * documents under agent/data/fixtures/. Address fields left empty
 * where the source document did not contain a street value (Whitaker,
 * Kowalski).
 *
 * @var list<array{
 *     pubpid: string,
 *     fname: string,
 *     mname: string,
 *     lname: string,
 *     sex: string,
 *     dob: string,
 *     mrn: string,
 *     phone_home: string,
 *     email: string,
 *     street: string,
 *     city: string,
 *     state: string,
 *     postal_code: string,
 *     narrative: string
 * }>
 */
$demoPatients = [
    [
        'pubpid'      => 'AGENTFORGE-DEMO-PDF-001',
        'fname'       => 'Margaret',
        'mname'       => 'L.',
        'lname'       => 'Chen',
        'sex'         => 'Female',
        'dob'         => '1967-08-14',
        'mrn'         => 'MRN-2026-04481',
        'phone_home'  => '(510) 555-0148',
        'email'       => 'mchen.demo@example.test',
        'street'      => '4421 Magnolia Ave, Apt 3B',
        'city'        => 'Berkeley',
        'state'       => 'CA',
        'postal_code' => '94705',
        'narrative'   => 'lipid panel (PDF) + typed intake — owns p01-chen-* fixtures',
    ],
    [
        'pubpid'      => 'AGENTFORGE-DEMO-PDF-002',
        'fname'       => 'James',
        'mname'       => 'E.',
        'lname'       => 'Whitaker',
        'sex'         => 'Male',
        'dob'         => '1958-11-03',
        'mrn'         => 'MRN-2026-04492',
        'phone_home'  => '(505) 555-0193',
        'email'       => 'jwhitaker.demo@example.test',
        'street'      => '',
        'city'        => 'Albuquerque',
        'state'       => 'NM',
        'postal_code' => '87110',
        'narrative'   => 'CBC (PDF) + typed intake — owns p02-whitaker-* fixtures',
    ],
    [
        'pubpid'      => 'AGENTFORGE-DEMO-PDF-003',
        'fname'       => 'Sofia',
        'mname'       => 'M.',
        'lname'       => 'Reyes',
        'sex'         => 'Female',
        'dob'         => '1983-12-19',
        'mrn'         => 'MRN-2026-04503',
        'phone_home'  => '(512) 555-0177',
        'email'       => 'sreyes.demo@example.test',
        'street'      => '1124 South Lamar Blvd, Apt 218',
        'city'        => 'Austin',
        'state'       => 'TX',
        'postal_code' => '78704',
        'narrative'   => 'HbA1c (PNG, scanned) + scanned intake — owns p03-reyes-* fixtures',
    ],
    [
        'pubpid'      => 'AGENTFORGE-DEMO-PDF-004',
        'fname'       => 'Robert',
        'mname'       => '',
        'lname'       => 'Kowalski',
        'sex'         => 'Male',
        'dob'         => '1971-06-08',
        'mrn'         => 'MRN-2026-04518',
        'phone_home'  => '(312) 555-0142',
        'email'       => 'rkowalski.demo@example.test',
        'street'       => '',
        'city'         => 'Chicago',
        'state'        => 'IL',
        'postal_code'  => '',
        'narrative'    => 'CMP (PDF) + handwritten intake (PNG) — owns p04-kowalski-* fixtures',
    ],
];

/**
 * Log a context-arrayed message to stderr. PSR-3-shaped (no string
 * interpolation of variables) so the script stays consistent with the
 * coding standard even though stderr is its only sink.
 *
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
    fwrite(STDERR, "[seed-demo-pdf:$level] $rendered\n");
};

// --reset-only: scope is the AGENTFORGE-* prefix (idempotent, safe).
// Reuses DemoDataSeeder::reset() so we get the same FK-safe cascade.
$seeder = new DemoDataSeeder();
if ($resetOnly) {
    $deleted = $seeder->reset();
    $log('info', 'reset-only complete', ['deleted' => $deleted]);
    fwrite(STDOUT, json_encode([
        'status'  => 'reset_only',
        'deleted' => $deleted,
    ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
    exit(0);
}

// --clear-all-patients: destructive global wipe before re-seeding. We
// reuse the same FK-safe cascade as DemoDataSeeder::reset() but apply
// it to every patient_data row, not just the AGENTFORGE-* prefix.
if ($clearAllPatients) {
    $log('warning', 'CLEAR-ALL-PATIENTS: destructive wipe of every patient_data row');
    $rows = QueryUtils::fetchRecords("SELECT pid FROM patient_data");
    $allPids = [];
    foreach ($rows as $row) {
        $pidRaw = $row['pid'] ?? null;
        if (is_int($pidRaw) || is_string($pidRaw)) {
            $allPids[] = (int) $pidRaw;
        }
    }
    $log('warning', 'patients found before wipe', ['count' => count($allPids)]);

    // Reflect into the per-pid cascade helper so we don't duplicate
    // the FK-safe DELETE chain. The cascade is the single source of
    // truth for the demo-data lifecycle; widening its scope to "every
    // pid" is the only delta from the AGENTFORGE-* path.
    $reflection = new \ReflectionClass($seeder);
    $cascade = $reflection->getMethod('deletePatientCascade');
    foreach ($allPids as $pid) {
        $cascade->invoke($seeder, $pid);
    }
    $log('warning', 'clear-all-patients complete', ['deleted' => count($allPids)]);
}

$patientService      = new PatientService();
$conditionService    = new ConditionService();
$prescriptionService = new PrescriptionService();
$encounterService    = new EncounterService();

const PDF_DEMO_PROVIDER_ID = 1;
const PDF_DEMO_FACILITY_ID = 3;

/**
 * Per-patient chart data. Designed to "semi-match" each patient's
 * fixture document — the pre-existing chart is what a clinician would
 * have seen *before* the new fixture lab/intake was processed, so
 * AgentForge ingest still has a meaningful delta to surface.
 *
 * Keys are pubpids matching $demoPatients above.
 *
 * Schema (per patient):
 *   conditions:   list<{title, code, system, begdate}>
 *   medications:  list<{drug, rxnorm, dosage, route, interval, start_date}>
 *   encounters:   list<{date, class_code, reason}>   // YYYY-MM-DD
 *   labs:         list<{loinc, name, value, units, date}>  // YYYY-MM-DD HH:MM:SS
 *
 * @var array<string, array{
 *     conditions: list<array{title:string,code:string,system:string,begdate:string}>,
 *     medications: list<array{drug:string,rxnorm:string,dosage:string,route:string,interval:string,start_date:string}>,
 *     encounters: list<array{date:string,class_code:string,reason:string}>,
 *     labs: list<array{loinc:string,name:string,value:string,units:string,date:string}>
 * }>
 */
$chartDefs = [
    // p01 Chen — diabetic + hypertensive baseline; lipid panel fixture
    // (Total Cholesterol 232) becomes the new finding to surface.
    'AGENTFORGE-DEMO-PDF-001' => [
        'conditions' => [
            ['title' => 'Essential hypertension',         'code' => 'I10',     'system' => 'icd10',     'begdate' => '2021-04-12'],
            ['title' => 'Type 2 diabetes mellitus',       'code' => 'E11.9',   'system' => 'icd10',     'begdate' => '2022-09-08'],
        ],
        'medications' => [
            ['drug' => 'Lisinopril 10 MG Oral Tablet',    'rxnorm' => '314076',  'dosage' => '10 mg', 'route' => 'oral', 'interval' => 'daily',         'start_date' => '2021-04-20'],
            ['drug' => 'Metformin 500 MG Oral Tablet',    'rxnorm' => '860975',  'dosage' => '500 mg','route' => 'oral', 'interval' => 'twice daily',   'start_date' => '2022-09-15'],
        ],
        'encounters' => [
            ['date' => '2025-11-04', 'class_code' => 'AMB', 'reason' => 'Annual physical exam'],
            ['date' => '2026-02-10', 'class_code' => 'AMB', 'reason' => 'Diabetes follow-up'],
        ],
        'labs' => [
            ['loinc' => '4548-4', 'name' => 'Hemoglobin A1c',        'value' => '7.4', 'units' => '%',     'date' => '2026-02-10 09:15:00'],
        ],
    ],
    // p02 Whitaker — AFib + BPH; CBC fixture (subtle anemia hints)
    // becomes the delta.
    'AGENTFORGE-DEMO-PDF-002' => [
        'conditions' => [
            ['title' => 'Atrial fibrillation',            'code' => 'I48.91',  'system' => 'icd10',     'begdate' => '2019-06-22'],
            ['title' => 'Benign prostatic hyperplasia',   'code' => 'N40.1',   'system' => 'icd10',     'begdate' => '2020-03-14'],
        ],
        'medications' => [
            ['drug' => 'Apixaban 5 MG Oral Tablet',       'rxnorm' => '1364430', 'dosage' => '5 mg',  'route' => 'oral', 'interval' => 'twice daily', 'start_date' => '2019-07-02'],
            ['drug' => 'Tamsulosin 0.4 MG Oral Capsule',  'rxnorm' => '316222',  'dosage' => '0.4 mg','route' => 'oral', 'interval' => 'daily',       'start_date' => '2020-03-20'],
        ],
        'encounters' => [
            ['date' => '2026-01-08', 'class_code' => 'AMB', 'reason' => 'Cardiology follow-up — atrial fibrillation'],
        ],
        'labs' => [
            ['loinc' => '6301-6', 'name' => 'INR (Coagulation tissue factor induced)', 'value' => '2.4', 'units' => '{INR}', 'date' => '2026-02-18 10:30:00'],
        ],
    ],
    // p03 Reyes — T2DM + depression; HbA1c fixture (8.2) shows trend
    // up from prior 7.8.
    'AGENTFORGE-DEMO-PDF-003' => [
        'conditions' => [
            ['title' => 'Type 2 diabetes mellitus',       'code' => 'E11.9',   'system' => 'icd10',     'begdate' => '2020-08-11'],
            ['title' => 'Major depressive disorder, recurrent', 'code' => 'F33.1', 'system' => 'icd10', 'begdate' => '2023-02-04'],
        ],
        'medications' => [
            ['drug' => 'Metformin 1000 MG Oral Tablet',   'rxnorm' => '860975',  'dosage' => '1000 mg','route' => 'oral', 'interval' => 'twice daily', 'start_date' => '2020-08-20'],
            ['drug' => 'Sertraline 50 MG Oral Tablet',    'rxnorm' => '312940',  'dosage' => '50 mg', 'route' => 'oral', 'interval' => 'daily',       'start_date' => '2023-02-15'],
        ],
        'encounters' => [
            ['date' => '2025-10-06', 'class_code' => 'AMB', 'reason' => 'Endocrinology follow-up'],
            ['date' => '2026-01-22', 'class_code' => 'AMB', 'reason' => 'Primary care visit — diabetes management'],
        ],
        'labs' => [
            ['loinc' => '4548-4', 'name' => 'Hemoglobin A1c',        'value' => '7.8', 'units' => '%',     'date' => '2025-10-06 08:45:00'],
        ],
    ],
    // p04 Kowalski — hypertension only; CMP fixture is from an evening
    // ED visit, so prior chart is sparse.
    'AGENTFORGE-DEMO-PDF-004' => [
        'conditions' => [
            ['title' => 'Essential hypertension',         'code' => 'I10',     'system' => 'icd10',     'begdate' => '2024-05-09'],
        ],
        'medications' => [],
        'encounters' => [
            ['date' => '2026-04-15', 'class_code' => 'EMER', 'reason' => 'Emergency department visit — abdominal pain'],
        ],
        'labs' => [
            ['loinc' => '2160-0', 'name' => 'Creatinine [Mass/volume] in Serum or Plasma', 'value' => '0.96', 'units' => 'mg/dL', 'date' => '2025-12-03 11:20:00'],
        ],
    ],
];

/**
 * Ensure the procedure_providers row used for demo lab orders exists.
 * Returns the ppid. Idempotent.
 */
$ensureProcedureProvider = static function (): int {
    $row = QueryUtils::querySingleRow(
        "SELECT ppid FROM procedure_providers WHERE name = ?",
        ['AgentForge Demo Lab']
    );
    if (is_array($row) && isset($row['ppid']) && (is_int($row['ppid']) || (is_string($row['ppid']) && ctype_digit($row['ppid'])))) {
        $existingId = (int) $row['ppid'];
        if ($existingId > 0) {
            return $existingId;
        }
    }
    QueryUtils::sqlInsert(
        "INSERT INTO procedure_providers (name, npi, send_app_id, recv_app_id) VALUES (?, '', '', '')",
        ['AgentForge Demo Lab']
    );
    $row = QueryUtils::querySingleRow(
        "SELECT ppid FROM procedure_providers WHERE name = ?",
        ['AgentForge Demo Lab']
    );
    if (is_array($row) && isset($row['ppid']) && (is_int($row['ppid']) || (is_string($row['ppid']) && ctype_digit($row['ppid'])))) {
        return (int) $row['ppid'];
    }
    return 0;
};

/**
 * Build the OpenEMR diagnosis string. Mirror of SyntheaLoader::csvDiagnosis
 * but inlined here so the PDF seeder is self-contained for chart writes.
 */
$diagnosisCode = static function (string $system, string $code): string {
    if ($code === '') {
        return '';
    }
    $sys = strtolower($system);
    $prefix = match (true) {
        str_contains($sys, 'snomed')                           => 'SNOMED-CT',
        str_contains($sys, 'icd-10') || $sys === 'icd10'       => 'ICD10',
        str_contains($sys, 'icd-9')  || $sys === 'icd9'        => 'ICD9',
        str_contains($sys, 'rxnorm')                           => 'RXNORM',
        str_contains($sys, 'loinc')                            => 'LOINC',
        default                                                 => 'SNOMED-CT',
    };
    return substr("$prefix:$code", 0, 255);
};

/**
 * Insert one lab row (procedure_order + _code + _report + _result).
 * Mirrors SyntheaLoader::writeLabRow with a fresh procedure_provider lookup.
 */
$writeLabRow = static function (
    int $pid,
    int $eid,
    string $when,
    string $loinc,
    string $name,
    string $value,
    string $units,
    int $procedureProviderId
): void {
    $orderUuid  = (new UuidRegistry(['table_name' => 'procedure_order']))->createUuid();
    $reportUuid = (new UuidRegistry(['table_name' => 'procedure_report']))->createUuid();
    $resultUuid = (new UuidRegistry(['table_name' => 'procedure_result']))->createUuid();

    $orderId = QueryUtils::sqlInsert(
        "INSERT INTO procedure_order
            (uuid, provider_id, patient_id, encounter_id, date_collected,
             date_ordered, order_status, activity, lab_id, procedure_order_type)
         VALUES (?, ?, ?, ?, ?, ?, 'complete', 1, ?, 'laboratory_test')",
        [$orderUuid, PDF_DEMO_PROVIDER_ID, $pid, $eid, $when, $when, $procedureProviderId]
    );
    QueryUtils::sqlInsert(
        "INSERT INTO procedure_order_code
            (procedure_order_id, procedure_order_seq, procedure_code, procedure_name)
         VALUES (?, 1, ?, ?)",
        [$orderId, $loinc, substr($name, 0, 255)]
    );
    $reportId = QueryUtils::sqlInsert(
        "INSERT INTO procedure_report
            (uuid, procedure_order_id, procedure_order_seq, date_collected,
             date_report, source, report_status, review_status)
         VALUES (?, ?, 1, ?, ?, ?, 'complete', 'reviewed')",
        [$reportUuid, $orderId, $when, $when, PDF_DEMO_PROVIDER_ID]
    );
    QueryUtils::sqlInsert(
        "INSERT INTO procedure_result
            (uuid, procedure_report_id, result_data_type, result_code, result_text,
             date, units, result, `range`, abnormal, result_status)
         VALUES (?, ?, 'N', ?, ?, ?, ?, ?, '', 'no', 'final')",
        [$resultUuid, $reportId, $loinc, substr($name, 0, 255), $when,
         substr($units, 0, 31), substr($value, 0, 255)]
    );
};

$out = [];

foreach ($demoPatients as $p) {
    $existing = QueryUtils::fetchRecords(
        "SELECT pid FROM patient_data WHERE pubpid = ? LIMIT 1",
        [$p['pubpid']]
    );

    if ($existing !== [] && isset($existing[0]['pid'])) {
        $pidRaw = $existing[0]['pid'];
        $pid = is_int($pidRaw) || is_string($pidRaw) ? (int) $pidRaw : 0;
        $out[] = [
            'pubpid' => $p['pubpid'],
            'pid'    => $pid,
            'name'   => trim($p['fname'] . ' ' . $p['lname']),
            'status' => 'skipped_exists',
        ];
        $log('info', 'patient already exists', [
            'pubpid'    => $p['pubpid'],
            'pid'       => $pid,
            'narrative' => $p['narrative'],
        ]);
        continue;
    }

    $insertPayload = [
        'pubpid'       => $p['pubpid'],
        'fname'        => $p['fname'],
        'mname'        => $p['mname'],
        'lname'        => $p['lname'],
        'sex'          => $p['sex'],
        'DOB'          => $p['dob'],
        'street'       => $p['street'],
        'city'         => $p['city'],
        'state'        => $p['state'],
        'postal_code'  => $p['postal_code'],
        'country_code' => 'US',
        'phone_home'   => $p['phone_home'],
        'email'        => $p['email'],
        'language'     => 'English',
        'race'         => '',
        'ethnicity'    => '',
    ];

    $result = $patientService->insert($insertPayload);

    $resultData = $result->getData();
    if (!$result->isValid() || $resultData === []) {
        $messages = $result->getValidationMessages();
        $msgStr = is_array($messages)
            ? implode('; ', array_map(static fn(mixed $m): string => is_scalar($m) ? (string) $m : '', $messages))
            : '';
        $log('error', 'insert FAILED', [
            'pubpid' => $p['pubpid'],
            'errors' => $msgStr,
        ]);
        exit(2);
    }

    $rowOut = is_array($resultData) ? ($resultData[0] ?? null) : null;
    $pidOutRaw = is_array($rowOut) ? ($rowOut['pid'] ?? 0) : 0;
    $pid = is_int($pidOutRaw) || is_string($pidOutRaw) ? (int) $pidOutRaw : 0;
    $puuidRaw = is_array($rowOut) ? ($rowOut['uuid'] ?? '') : '';
    $puuid = is_string($puuidRaw) ? $puuidRaw : '';

    $out[] = [
        'pubpid' => $p['pubpid'],
        'pid'    => $pid,
        'name'   => trim($p['fname'] . ' ' . $p['lname']),
        'status' => 'created',
    ];

    $log('info', 'patient created', [
        'pubpid'    => $p['pubpid'],
        'pid'       => $pid,
        'narrative' => $p['narrative'],
    ]);

    // Seed the per-patient chart. Each block is best-effort — a single
    // failure is logged and skipped rather than aborting the whole seed.
    $chart = $chartDefs[$p['pubpid']] ?? null;
    if ($chart === null || $puuid === '') {
        continue;
    }

    $procedureProviderId = $ensureProcedureProvider();
    $now = date('Y-m-d H:i:s');

    foreach ($chart['conditions'] as $c) {
        try {
            $conditionService->insert([
                'puuid'     => $puuid,
                'title'     => $c['title'],
                'begdate'   => $c['begdate'],
                'diagnosis' => $diagnosisCode($c['system'], $c['code']),
            ]);
        } catch (\RuntimeException | \LogicException | \PDOException | \Doctrine\DBAL\Exception $e) {
            $log('warning', 'condition insert failed', ['pid' => $pid, 'title' => $c['title'], 'err' => $e->getMessage()]);
        }
    }

    foreach ($chart['medications'] as $m) {
        try {
            $prescriptionService->insert([
                'patient_id'      => $pid,
                'provider_id'     => PDF_DEMO_PROVIDER_ID,
                'drug'            => $m['drug'],
                'rxnorm_drugcode' => $m['rxnorm'] !== '' ? $m['rxnorm'] : null,
                'dosage'          => $m['dosage'],
                'route'           => $m['route'],
                'interval'        => $m['interval'],
                'start_date'      => $m['start_date'],
                'active'          => 1,
                'date_added'      => $now,
                'date_modified'   => $now,
            ]);
        } catch (\RuntimeException | \LogicException | \PDOException | \Doctrine\DBAL\Exception $e) {
            $log('warning', 'medication insert failed', ['pid' => $pid, 'drug' => $m['drug'], 'err' => $e->getMessage()]);
        }
    }

    // Track encounter ids by date so labs collected on the same day
    // attach to the right encounter (some labs do not fall on an
    // encounter day — those get eid=0).
    $encountersByDate = [];
    foreach ($chart['encounters'] as $e) {
        try {
            $encDate = $e['date'] . ' 09:00:00';
            $encResult = $encounterService->insertEncounter($puuid, [
                'pc_catid'    => 5,
                'class_code'  => $e['class_code'],
                'date'        => $encDate,
                'onset_date'  => $encDate,
                'reason'      => $e['reason'],
                'facility'    => 'AgentForge Demo Clinic',
                'facility_id' => PDF_DEMO_FACILITY_ID,
                'provider_id' => PDF_DEMO_PROVIDER_ID,
                'user'        => 'admin',
                'group'       => 'Default',
            ]);
            if ($encResult->isValid()) {
                $encData = $encResult->getData();
                if (is_array($encData) && isset($encData[0]) && is_array($encData[0])) {
                    $encId = $encData[0]['encounter'] ?? null;
                    if (is_int($encId) || (is_string($encId) && ctype_digit($encId))) {
                        $encountersByDate[$e['date']] = (int) $encId;
                    }
                }
            }
        } catch (\RuntimeException | \LogicException | \PDOException | \Doctrine\DBAL\Exception $err) {
            $log('warning', 'encounter insert failed', ['pid' => $pid, 'reason' => $e['reason'], 'err' => $err->getMessage()]);
        }
    }

    foreach ($chart['labs'] as $lab) {
        try {
            $labDay = substr($lab['date'], 0, 10);
            $eid = $encountersByDate[$labDay] ?? 0;
            $writeLabRow(
                $pid,
                $eid,
                $lab['date'],
                $lab['loinc'],
                $lab['name'],
                $lab['value'],
                $lab['units'],
                $procedureProviderId
            );
        } catch (\RuntimeException | \LogicException | \PDOException | \Doctrine\DBAL\Exception $err) {
            $log('warning', 'lab insert failed', ['pid' => $pid, 'name' => $lab['name'], 'err' => $err->getMessage()]);
        }
    }

    $log('info', 'chart seeded', [
        'pid'          => $pid,
        'conditions'   => count($chart['conditions']),
        'medications'  => count($chart['medications']),
        'encounters'   => count($chart['encounters']),
        'labs'         => count($chart['labs']),
    ]);
}

fwrite(STDOUT, json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
exit(0);
