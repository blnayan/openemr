<?php

/**
 * Loads the Synthea sample-data CSV pack into OpenEMR.
 *
 * Source: https://synthetichealth.github.io/synthea-sample-data/downloads/latest/synthea_sample_data_csv_latest.zip
 *
 * The CSV pack ships 18 flat files where rows reference each other by UUID.
 * This loader streams them in dependency order:
 *   1. patients.csv      → PatientService::insert
 *                          (builds SyntheaPatientId → pid map; --limit cuts here)
 *   2. encounters.csv    → EncounterService::insertEncounter
 *                          (builds SyntheaEncounterId → {eid,date,pid} map)
 *   3. conditions.csv    → ConditionService::insert        (active only — STOP empty)
 *   4. allergies.csv     → AllergyIntoleranceService::insert (active only — STOP empty)
 *   5. medications.csv   → PrescriptionService::insert
 *   6. observations.csv  → vital-signs   → batched into form_vitals per encounter
 *                          laboratory    → procedure_order/_code/_report/_result
 *
 * Inserts route through OpenEMR services where they exist. Direct SQL is
 * used only for the lab-result chain (no OpenEMR service exposes the
 * procedure_* insert chain).
 *
 * Streaming: every CSV is read with fgetcsv one row at a time, so peak
 * memory is bounded by the two ID maps (patient + encounter) regardless of
 * how large observations.csv gets.
 *
 * @package OpenEMR
 * @license https://github.com/openemr/openemr/blob/master/LICENSE GNU GPL 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\DemoSeed;

use OpenEMR\Common\Uuid\UuidRegistry;
use OpenEMR\Services\AllergyIntoleranceService;
use OpenEMR\Services\ConditionService;
use OpenEMR\Services\EncounterService;
use OpenEMR\Services\PatientService;
use OpenEMR\Services\PrescriptionService;

final class SyntheaLoader
{
    /** Sentinel prefix on patient_data.pubpid that tags every Synthea-loaded patient. */
    public const DEMO_PUBPID_PREFIX = 'AGENTFORGE-';

    private const DEFAULT_PROVIDER_ID  = 1;
    private const DEFAULT_FACILITY_ID  = 3;
    private const DEFAULT_USER         = 'admin';
    private const DEFAULT_GROUP        = 'Default';
    private const ENCOUNTER_PC_CATID   = 5;
    private const ENCOUNTER_CLASS_AMB  = 'AMB';

    /**
     * LOINC → form_vitals column. Source: HL7 vital-signs panel codes that
     * Synthea emits in observations.csv with CATEGORY=vital-signs.
     *
     * @var array<string, string>
     */
    private const VITAL_LOINC_TO_COLUMN = [
        '8302-2'  => 'height',
        '29463-7' => 'weight',
        '39156-5' => 'BMI',
        '8462-4'  => 'bpd',              // Diastolic BP
        '8480-6'  => 'bps',              // Systolic BP
        '8867-4'  => 'pulse',
        '9279-1'  => 'respiration',
        '8310-5'  => 'temperature',
        '2708-6'  => 'oxygen_saturation',
        '59408-5' => 'oxygen_saturation',
        '8287-5'  => 'head_circ',
    ];

    /**
     * Synthea ENCOUNTERCLASS values mapped to HL7 ActEncounterCode.
     * The OpenEMR installer seeds the right-hand column in
     * list_options._ActEncounterCode.
     *
     * @var array<string, string>
     */
    private const ENCOUNTER_CLASS_MAP = [
        'ambulatory'   => 'AMB',
        'wellness'     => 'AMB',
        'outpatient'   => 'AMB',
        'urgentcare'   => 'AMB',
        'emergency'    => 'EMER',
        'inpatient'    => 'IMP',
        'home'         => 'HH',
        'hospice'      => 'HH',
        'snf'          => 'IMP',
        'virtual'      => 'VR',
    ];

    /** Subset of HL7 ActEncounterCode allowed by OpenEMR's list_options. */
    private const ALLOWED_ENCOUNTER_CLASSES = [
        'AMB', 'EMER', 'FLD', 'HH', 'IMP', 'ACUTE', 'NONAC', 'OBSENC', 'PRENC', 'SS', 'VR',
    ];

    /**
     * SNOMED codes Synthea emits in conditions.csv that are *not* medical
     * conditions — they are social-determinants-of-health findings
     * (employment, housing, education, transport, stress, social
     * isolation, refugee status, etc.) emitted by Synthea's social-
     * determinants module. Without this denylist they pollute the
     * OpenEMR problem list with rows like "Full-time employment (finding)"
     * which clinicians have to mentally filter past.
     *
     * Extend this set when a future Synthea release surfaces new social-
     * determinant codes. Keep medical/disorder/situation codes here only
     * if they describe a non-clinical state (e.g. "Refugee (person)").
     *
     * @var array<string, true>
     */
    private const NON_MEDICAL_CONDITION_CODES = [
        '73438004'        => true, // Unemployed (finding)
        '73595000'        => true, // Stress (finding)
        '105531004'       => true, // Housing unsatisfactory (finding)
        '160903007'       => true, // Full-time employment (finding)
        '160904001'       => true, // Part-time employment (finding)
        '160968000'       => true, // Risk activity involvement (finding)
        '224295006'       => true, // Only received primary school education (finding)
        '224299000'       => true, // Received higher education (finding)
        '266934004'       => true, // Transport problem (finding)
        '266948004'       => true, // Has a criminal record (finding)
        '422650009'       => true, // Social isolation (finding)
        '423315002'       => true, // Limited social contact (finding)
        '424393004'       => true, // Reports of violence in the environment (finding)
        '446654005'       => true, // Refugee (person)
        '473461003'       => true, // Educated to high school level (finding)
        '706893006'       => true, // Victim of intimate partner abuse (finding)
        '713458007'       => true, // Lack of access to transportation (finding)
        '741062008'       => true, // Not in labor force (finding)
    ];

    /**
     * Synthea CSV race tokens → OpenEMR race string.
     *
     * @var array<string, string>
     */
    private const RACE_MAP = [
        'white'    => 'White',
        'black'    => 'Black or African American',
        'asian'    => 'Asian',
        'native'   => 'American Indian or Alaska Native',
        'hawaiian' => 'Native Hawaiian or Other Pacific Islander',
        'other'    => 'Other',
    ];

    private PatientService $patientService;
    private ConditionService $conditionService;
    private AllergyIntoleranceService $allergyService;
    private PrescriptionService $prescriptionService;
    private EncounterService $encounterService;

    /** @var list<string> */
    private array $log = [];

    public function __construct()
    {
        $this->patientService      = new PatientService();
        $this->conditionService    = new ConditionService();
        $this->allergyService      = new AllergyIntoleranceService();
        $this->prescriptionService = new PrescriptionService();
        $this->encounterService    = new EncounterService();
    }

    /**
     * Load the Synthea CSVs from $csvDir.
     *
     * @param int|null $limit Maximum number of patients to load. null = all.
     * @param \Closure|null $progress Receives ($current, $total, $patientName)
     *                                 after each patient finishes loading.
     *
     * @return array{patients: list<array{pid: int, uuid: string, name: string, pubpid: string}>, log: list<string>, skipped: int}
     */
    public function loadCsvDir(string $csvDir, ?int $limit = null, ?\Closure $progress = null): array
    {
        if (!is_dir($csvDir)) {
            throw new \RuntimeException("Synthea CSV directory not found: $csvDir");
        }
        $this->ensureProcedureProvider();

        // Pass 1: patients.csv → patientMap[Id] = ['pid'=>int,'puuid'=>string,'name'=>string,'pubpid'=>string]
        $patientMap = [];
        $patients = [];
        $skipped = 0;
        $this->streamCsv($csvDir . '/patients.csv', function (array $row) use (
            &$patientMap,
            &$patients,
            &$skipped,
            $limit,
            $progress
        ): bool {
            if ($limit !== null && count($patients) >= $limit) {
                return false; // stop the stream
            }
            $loaded = $this->insertPatientFromCsv($row);
            if ($loaded === null) {
                $skipped++;
                return true;
            }
            [$pid, $puuid, $name, $pubpid] = $loaded;
            $syntheaId = (string) ($row['Id'] ?? '');
            $patientMap[$syntheaId] = [
                'pid'    => $pid,
                'puuid'  => $puuid,
                'name'   => $name,
                'pubpid' => $pubpid,
            ];
            $patients[] = [
                'pid'    => $pid,
                'uuid'   => $puuid,
                'name'   => $name,
                'pubpid' => $pubpid,
            ];
            if ($progress !== null) {
                $progress(count($patients), $limit ?? 0, $name);
            }
            return true;
        });

        if ($patientMap === []) {
            return ['patients' => $patients, 'log' => $this->log, 'skipped' => $skipped];
        }

        // Pass 2: encounters.csv → encounterMap[Id] = ['eid'=>int,'date'=>string,'pid'=>int]
        $encounterMap = [];
        $this->streamCsv($csvDir . '/encounters.csv', function (array $row) use (&$encounterMap, $patientMap): bool {
            $patientId = (string) ($row['PATIENT'] ?? '');
            if (!isset($patientMap[$patientId])) {
                return true;
            }
            $puuid = $patientMap[$patientId]['puuid'];
            $info = $this->insertEncounterFromCsv($puuid, $row);
            if ($info === null) {
                return true;
            }
            $info['pid'] = $patientMap[$patientId]['pid'];
            $encounterMap[(string) ($row['Id'] ?? '')] = $info;
            return true;
        });

        // Pass 3a: conditions.csv
        $this->streamCsv($csvDir . '/conditions.csv', function (array $row) use ($patientMap): bool {
            $patientId = (string) ($row['PATIENT'] ?? '');
            if (!isset($patientMap[$patientId])) {
                return true;
            }
            $this->insertConditionFromCsv($patientMap[$patientId]['puuid'], $row);
            return true;
        });

        // Pass 3b: allergies.csv
        $this->streamCsv($csvDir . '/allergies.csv', function (array $row) use ($patientMap): bool {
            $patientId = (string) ($row['PATIENT'] ?? '');
            if (!isset($patientMap[$patientId])) {
                return true;
            }
            $this->insertAllergyFromCsv($patientMap[$patientId]['puuid'], $row);
            return true;
        });

        // Pass 3c: medications.csv
        $this->streamCsv($csvDir . '/medications.csv', function (array $row) use ($patientMap): bool {
            $patientId = (string) ($row['PATIENT'] ?? '');
            if (!isset($patientMap[$patientId])) {
                return true;
            }
            $this->insertMedicationFromCsv($patientMap[$patientId]['pid'], $row);
            return true;
        });

        // Pass 3d: observations.csv — vitals batched per encounter, labs streamed direct.
        $vitalsByEncounter = []; // eid → ['date'=>string,'fields'=>[col=>value]]
        $this->streamCsv($csvDir . '/observations.csv', function (array $row) use (
            $patientMap,
            $encounterMap,
            &$vitalsByEncounter
        ): bool {
            $patientId = (string) ($row['PATIENT'] ?? '');
            if (!isset($patientMap[$patientId])) {
                return true;
            }
            $category = strtolower((string) ($row['CATEGORY'] ?? ''));
            if ($category === 'vital-signs') {
                $this->collectVitalFromCsv($row, $encounterMap, $vitalsByEncounter);
            } elseif ($category === 'laboratory') {
                $this->insertLabFromCsv($patientMap[$patientId]['pid'], $row, $encounterMap);
            }
            return true;
        });

        // Persist the batched vitals (one form_vitals row per encounter).
        foreach ($vitalsByEncounter as $eid => $bucket) {
            $pid = $bucket['pid'];
            $this->encounterService->insertVital($pid, (int) $eid, array_merge(
                ['date' => $bucket['date']],
                $bucket['fields']
            ));
        }

        foreach ($patientMap as $entry) {
            $this->log[] = sprintf(
                'Loaded %s (pid=%d, uuid=%s)',
                $entry['name'],
                $entry['pid'],
                $entry['puuid']
            );
        }

        return ['patients' => $patients, 'log' => $this->log, 'skipped' => $skipped];
    }

    /**
     * Open a CSV file, read its header row, and dispatch each subsequent row
     * as an associative array to $rowHandler. The handler returns false to
     * short-circuit the stream (used by --limit on patients.csv).
     *
     * @param callable(array<string, string>): bool $rowHandler
     */
    private function streamCsv(string $path, callable $rowHandler): void
    {
        if (!is_file($path)) {
            // Some Synthea packs ship a subset (e.g. allergies.csv missing).
            // Treat absence as "no rows", not as an error.
            return;
        }
        $fp = fopen($path, 'r');
        if ($fp === false) {
            throw new \RuntimeException("could not open CSV: $path");
        }
        try {
            // Pass escape='' to opt into standards-compliant RFC-4180 CSV
            // parsing. PHP 8.4 deprecates the legacy default that treats
            // backslash as an escape — Synthea CSVs are RFC-4180 anyway.
            $header = fgetcsv($fp, null, ',', '"', '');
            if ($header === false) {
                return;
            }
            // Defensive: normalize header tokens (trim BOM and whitespace).
            $header = array_map(static function (string $h): string {
                return trim($h, " \t\n\r\0\x0B\xEF\xBB\xBF");
            }, $header);
            $headerCount = count($header);
            $lineNo = 1;
            while (($row = fgetcsv($fp, null, ',', '"', '')) !== false) {
                $lineNo++;
                if (count($row) !== $headerCount) {
                    // Synthea pads short rows; tolerate by truncate / extend.
                    if (count($row) < $headerCount) {
                        $row = array_pad($row, $headerCount, '');
                    } else {
                        $row = array_slice($row, 0, $headerCount);
                    }
                }
                $assoc = array_combine($header, $row);
                if ($rowHandler($assoc) === false) {
                    return;
                }
            }
        } finally {
            fclose($fp);
        }
    }

    /**
     * @param array<string, string> $row
     * @return array{0: int, 1: string, 2: string, 3: string}|null [pid, puuid, name, pubpid]
     */
    private function insertPatientFromCsv(array $row): ?array
    {
        $fname = self::stripSyntheaSuffix((string) ($row['FIRST'] ?? ''));
        $lname = self::stripSyntheaSuffix((string) ($row['LAST'] ?? ''));
        if ($fname === '' || $lname === '') {
            return null;
        }

        $sex = match (strtolower((string) ($row['GENDER'] ?? ''))) {
            'm' => 'Male',
            'f' => 'Female',
            'o' => 'Other',
            default => 'Unknown',
        };
        $dob = (string) ($row['BIRTHDATE'] ?? '');
        if ($dob === '') {
            return null;
        }

        $syntheaId = (string) ($row['Id'] ?? '');
        if ($syntheaId === '') {
            return null;
        }
        $pubpid = self::buildPubpid($syntheaId);

        $result = $this->patientService->insert([
            'pubpid'       => $pubpid,
            'fname'        => $fname,
            'lname'        => $lname,
            'sex'          => $sex,
            'DOB'          => $dob,
            'street'       => (string) ($row['ADDRESS'] ?? ''),
            'city'         => (string) ($row['CITY'] ?? ''),
            'state'        => (string) ($row['STATE'] ?? ''),
            'postal_code'  => (string) ($row['ZIP'] ?? ''),
            'country_code' => 'US',
            'phone_home'   => '',
            'language'     => 'English',
            'race'         => self::mapRace((string) ($row['RACE'] ?? '')),
            'ethnicity'    => self::mapEthnicity((string) ($row['ETHNICITY'] ?? '')),
        ]);

        if (!$result->isValid() || empty($result->getData())) {
            return null;
        }
        $rowOut = $result->getData()[0];
        return [
            (int) $rowOut['pid'],
            (string) $rowOut['uuid'],
            trim($fname . ' ' . $lname),
            $pubpid,
        ];
    }

    /**
     * @param array<string, string> $row
     * @return array{eid: int, date: string}|null
     */
    private function insertEncounterFromCsv(string $puuid, array $row): ?array
    {
        $start = (string) ($row['START'] ?? '');
        if ($start === '') {
            return null;
        }
        $date = $this->formatDateTime($start);

        $reason = (string) ($row['REASONDESCRIPTION'] ?? '');
        if ($reason === '') {
            $reason = (string) ($row['DESCRIPTION'] ?? '');
        }

        $classCode = self::mapEncounterClass((string) ($row['ENCOUNTERCLASS'] ?? ''));

        $result = $this->encounterService->insertEncounter($puuid, [
            'pc_catid'    => self::ENCOUNTER_PC_CATID,
            'class_code'  => $classCode,
            'date'        => $date,
            'onset_date'  => $date,
            'reason'      => $reason,
            'facility'    => 'AgentForge Demo Clinic',
            'facility_id' => self::DEFAULT_FACILITY_ID,
            'provider_id' => self::DEFAULT_PROVIDER_ID,
            'user'        => self::DEFAULT_USER,
            'group'       => self::DEFAULT_GROUP,
        ]);

        if (!$result->isValid() || empty($result->getData())) {
            return null;
        }
        $rowOut = $result->getData()[0];
        return ['eid' => (int) $rowOut['encounter'], 'date' => $date];
    }

    /**
     * @param array<string, string> $row
     */
    private function insertConditionFromCsv(string $puuid, array $row): void
    {
        if ((string) ($row['STOP'] ?? '') !== '') {
            return; // resolved condition, skip
        }
        if (self::isNonMedicalCondition((string) ($row['CODE'] ?? ''))) {
            // Skip Synthea social-determinant findings (employment status,
            // housing, education, etc.) so they do not pollute the
            // OpenEMR problem list.
            return;
        }
        $title = (string) ($row['DESCRIPTION'] ?? '');
        if (strlen($title) < 2) {
            return;
        }
        $begdate = $this->formatDate((string) ($row['START'] ?? date('Y-m-d')));
        $diagnosis = self::csvDiagnosis(
            (string) ($row['SYSTEM'] ?? ''),
            (string) ($row['CODE'] ?? '')
        );

        $this->conditionService->insert([
            'puuid'     => $puuid,
            'title'     => substr($title, 0, 255),
            'begdate'   => $begdate,
            'diagnosis' => $diagnosis,
        ]);
    }

    /**
     * @param array<string, string> $row
     */
    private function insertAllergyFromCsv(string $puuid, array $row): void
    {
        if ((string) ($row['STOP'] ?? '') !== '') {
            return; // resolved allergy, skip
        }
        $title = (string) ($row['DESCRIPTION'] ?? '');
        if (strlen($title) < 2) {
            return;
        }
        $begdate = $this->formatDate((string) ($row['START'] ?? date('Y-m-d')));
        $reaction = trim(
            (string) ($row['DESCRIPTION1'] ?? '')
            . (isset($row['DESCRIPTION2']) && (string) $row['DESCRIPTION2'] !== ''
                ? '; ' . (string) $row['DESCRIPTION2']
                : '')
        );

        $this->allergyService->insert([
            'puuid'     => $puuid,
            'title'     => substr($title, 0, 255),
            'begdate'   => $begdate,
            'diagnosis' => self::csvDiagnosis(
                (string) ($row['SYSTEM'] ?? ''),
                (string) ($row['CODE'] ?? '')
            ),
            'comments'  => $reaction,
        ]);
    }

    /**
     * @param array<string, string> $row
     */
    private function insertMedicationFromCsv(int $pid, array $row): void
    {
        $drug = (string) ($row['DESCRIPTION'] ?? '');
        if ($drug === '') {
            return;
        }
        // medications.csv has no SYSTEM column — CODE is RxNorm by Synthea convention.
        $rxnorm = (string) ($row['CODE'] ?? '');

        $start = (string) ($row['START'] ?? '');
        $startDate = $start !== '' ? $this->formatDate($start) : null;
        $now = date('Y-m-d H:i:s');
        $active = ((string) ($row['STOP'] ?? '') === '') ? 1 : 0;

        $this->prescriptionService->insert([
            'patient_id'      => $pid,
            'provider_id'     => self::DEFAULT_PROVIDER_ID,
            'drug'            => substr($drug, 0, 150),
            'rxnorm_drugcode' => $rxnorm !== '' ? $rxnorm : null,
            'dosage'          => '',
            'route'           => 'oral',
            'interval'        => '',
            'start_date'      => $startDate,
            'active'          => $active,
            'date_added'      => $now,
            'date_modified'   => $now,
        ]);
    }

    /**
     * @param array<string, string> $row
     * @param array<string, array{eid:int,date:string,pid:int}> $encounterMap
     * @param array<int, array{date:string,pid:int,fields:array<string,string>}> $vitalsByEncounter
     */
    private function collectVitalFromCsv(array $row, array $encounterMap, array &$vitalsByEncounter): void
    {
        $encounterId = (string) ($row['ENCOUNTER'] ?? '');
        if ($encounterId === '' || !isset($encounterMap[$encounterId])) {
            return;
        }
        $code = (string) ($row['CODE'] ?? '');
        if ($code === '' || !isset(self::VITAL_LOINC_TO_COLUMN[$code])) {
            return;
        }
        $value = (string) ($row['VALUE'] ?? '');
        if ($value === '') {
            return;
        }
        $info = $encounterMap[$encounterId];
        $eid = $info['eid'];
        if (!isset($vitalsByEncounter[$eid])) {
            $vitalsByEncounter[$eid] = [
                'date'   => $info['date'],
                'pid'    => $info['pid'],
                'fields' => [],
            ];
        }
        $vitalsByEncounter[$eid]['fields'][self::VITAL_LOINC_TO_COLUMN[$code]] = $value;
    }

    /**
     * @param array<string, string> $row
     * @param array<string, array{eid:int,date:string,pid:int}> $encounterMap
     */
    private function insertLabFromCsv(int $pid, array $row, array $encounterMap): void
    {
        $loinc = (string) ($row['CODE'] ?? '');
        if ($loinc === '') {
            return;
        }
        $name = (string) ($row['DESCRIPTION'] ?? $loinc);
        $value = (string) ($row['VALUE'] ?? '');
        if ($value === '') {
            return;
        }
        $units = (string) ($row['UNITS'] ?? '');
        $type = strtolower((string) ($row['TYPE'] ?? 'numeric'));
        $dataType = $type === 'numeric' ? 'N' : 'S';

        $encounterId = (string) ($row['ENCOUNTER'] ?? '');
        $eid = isset($encounterMap[$encounterId]) ? $encounterMap[$encounterId]['eid'] : 0;
        $when = $this->formatDateTime((string) ($row['DATE'] ?? date('c')));

        $this->writeLabRow($pid, $eid, $when, $loinc, $name, $value, $units, $dataType);
    }

    private function writeLabRow(
        int $pid,
        int $eid,
        string $when,
        string $loinc,
        string $name,
        string $value,
        string $units,
        string $dataType
    ): void {
        $orderUuid  = (new UuidRegistry(['table_name' => 'procedure_order']))->createUuid();
        $reportUuid = (new UuidRegistry(['table_name' => 'procedure_report']))->createUuid();
        $resultUuid = (new UuidRegistry(['table_name' => 'procedure_result']))->createUuid();

        $orderId = sqlInsert(
            "INSERT INTO procedure_order
                (uuid, provider_id, patient_id, encounter_id, date_collected,
                 date_ordered, order_status, activity, lab_id, procedure_order_type)
             VALUES (?, ?, ?, ?, ?, ?, 'complete', 1, ?, 'laboratory_test')",
            [$orderUuid, self::DEFAULT_PROVIDER_ID, $pid, $eid, $when, $when, $this->procedureProviderId()]
        );
        sqlInsert(
            "INSERT INTO procedure_order_code
                (procedure_order_id, procedure_order_seq, procedure_code, procedure_name)
             VALUES (?, 1, ?, ?)",
            [$orderId, $loinc, substr($name, 0, 255)]
        );
        $reportId = sqlInsert(
            "INSERT INTO procedure_report
                (uuid, procedure_order_id, procedure_order_seq, date_collected,
                 date_report, source, report_status, review_status)
             VALUES (?, ?, 1, ?, ?, ?, 'complete', 'reviewed')",
            [$reportUuid, $orderId, $when, $when, self::DEFAULT_PROVIDER_ID]
        );
        sqlInsert(
            "INSERT INTO procedure_result
                (uuid, procedure_report_id, result_data_type, result_code, result_text,
                 date, units, result, `range`, abnormal, result_status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'final')",
            [$resultUuid, $reportId, $dataType, $loinc, substr($name, 0, 255), $when,
             substr($units, 0, 31), substr($value, 0, 255), '', 'no']
        );
    }

    private function ensureProcedureProvider(): void
    {
        $row = sqlQuery(
            "SELECT ppid FROM procedure_providers WHERE name = ?",
            ['AgentForge Demo Lab']
        );
        if (!empty($row['ppid'])) {
            return;
        }
        sqlInsert(
            "INSERT INTO procedure_providers (name, npi, send_app_id, recv_app_id)
             VALUES (?, '', '', '')",
            ['AgentForge Demo Lab']
        );
    }

    private function procedureProviderId(): int
    {
        $row = sqlQuery(
            "SELECT ppid FROM procedure_providers WHERE name = ?",
            ['AgentForge Demo Lab']
        );
        return (int) ($row['ppid'] ?? 0);
    }

    /**
     * Build the OpenEMR diagnosis code string from a Synthea CSV (system, code)
     * pair. Most Synthea CSVs ship `SYSTEM` as either a URL or a token; we
     * also accept "SNOMED-CT" as a literal token because allergies.csv emits
     * it that way.
     *
     * Public static so the isolated test suite can exercise the mapping
     * without booting OpenEMR. Pure function — no `$this` state.
     */
    public static function csvDiagnosis(string $system, string $code): string
    {
        if ($code === '') {
            return '';
        }
        $sys = strtolower($system);
        $prefix = match (true) {
            $sys === ''                                   => 'SNOMED-CT',
            str_contains($sys, 'snomed')                  => 'SNOMED-CT',
            str_contains($sys, 'icd-10') || $sys === 'icd10' => 'ICD10',
            str_contains($sys, 'icd-9')  || $sys === 'icd9'  => 'ICD9',
            str_contains($sys, 'rxnorm')                  => 'RXNORM',
            str_contains($sys, 'loinc')                   => 'LOINC',
            default                                        => 'SNOMED-CT',
        };
        return substr("$prefix:$code", 0, 255);
    }

    /** Public static for isolated testing. Pure function. */
    public static function mapRace(string $raw): string
    {
        $key = strtolower(trim($raw));
        return self::RACE_MAP[$key] ?? '';
    }

    /** Public static for isolated testing. Pure function. */
    public static function mapEthnicity(string $raw): string
    {
        $key = strtolower(trim($raw));
        return match ($key) {
            'hispanic'    => 'hisp_or_latin',
            'nonhispanic' => 'not_hisp_or_latin',
            default       => '',
        };
    }

    /** Public static for isolated testing. Pure function. */
    public static function stripSyntheaSuffix(string $s): string
    {
        // Synthea suffixes names with random digits (e.g. "Percy315") to keep
        // them obviously synthetic. Strip the trailing digit run for legibility.
        return rtrim(preg_replace('/\d+$/', '', $s) ?? $s);
    }

    /**
     * Build the AGENTFORGE-* pubpid for a Synthea patient Id.
     * Public static for isolated testing. Pure function.
     */
    public static function buildPubpid(string $syntheaId): string
    {
        return self::DEMO_PUBPID_PREFIX . substr(str_replace('-', '', $syntheaId), 0, 24);
    }

    /**
     * Returns true if the SNOMED code refers to a Synthea social-
     * determinant finding (employment, housing, education, transport,
     * stress, social isolation, refugee status, etc.) that should not
     * land in the OpenEMR problem list.
     *
     * Public static for isolated testing. Pure function.
     */
    public static function isNonMedicalCondition(string $code): bool
    {
        return $code !== '' && isset(self::NON_MEDICAL_CONDITION_CODES[$code]);
    }

    /**
     * Resolve Synthea ENCOUNTERCLASS into an OpenEMR-allowed
     * ActEncounterCode. Unknown / empty input falls back to AMB.
     * Public static for isolated testing. Pure function.
     */
    public static function mapEncounterClass(string $raw): string
    {
        $rawLower = strtolower($raw);
        $candidate = self::ENCOUNTER_CLASS_MAP[$rawLower] ?? strtoupper($rawLower);
        if (!in_array($candidate, self::ALLOWED_ENCOUNTER_CLASSES, true)) {
            return self::ENCOUNTER_CLASS_AMB;
        }
        return $candidate;
    }

    private function formatDateTime(string $iso): string
    {
        try {
            return (new \DateTimeImmutable($iso))->format('Y-m-d H:i:s');
        } catch (\Throwable) {
            return date('Y-m-d H:i:s');
        }
    }

    private function formatDate(string $iso): string
    {
        try {
            return (new \DateTimeImmutable($iso))->format('Y-m-d');
        } catch (\Throwable) {
            return date('Y-m-d');
        }
    }
}
