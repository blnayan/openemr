<?php

/**
 * AgentForge demo data seeder — Synthea CSV source.
 *
 * The seeder loads the Synthea sample-data 100-patient CSV pack
 * (https://synthetichealth.github.io/synthea-sample-data/) into OpenEMR via
 * `SyntheaLoader`. Every seeded patient is tagged with `pubpid` prefix
 * `AGENTFORGE-` so the reset path can find and drop them all without
 * touching real data.
 *
 * UC-1 in `USERS.md` is illustrative — Maria González is a worked example,
 * not a row in the database. The agent's behaviour against any Synthea
 * patient with active conditions, meds, and labs covers the same workflow.
 *
 * Insert paths route through OpenEMR services where they exist
 * (PatientService, ConditionService, AllergyIntoleranceService,
 * PrescriptionService, EncounterService::insertEncounter,
 * EncounterService::insertVital). Direct SQL is used only for the lab-result
 * chain (no OpenEMR service exposes the procedure_order/_code/_report/_result
 * insert) and for the cascade delete on reset (no service exposes a per-pid
 * cascade either).
 *
 * @package OpenEMR
 * @license https://github.com/openemr/openemr/blob/master/LICENSE GNU GPL 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\DemoSeed;

final class DemoDataSeeder
{
    /**
     * Re-export of the loader's sentinel so callers can refer to a single
     * canonical constant.
     */
    public const DEMO_PUBPID_PREFIX = SyntheaLoader::DEMO_PUBPID_PREFIX;

    private SyntheaLoader $loader;
    private AppointmentScheduler $scheduler;

    /** @var list<string> */
    private array $log = [];

    public function __construct()
    {
        $this->loader = new SyntheaLoader();
        $this->scheduler = new AppointmentScheduler();
    }

    /**
     * Default patient cap when the caller passes null. The admin refresh
     * endpoint and the boot-time seeder hit this branch — they want the
     * "demo-friendly" 10-patient seed unless explicitly overridden. Pass
     * 0 to disable the cap and load every Synthea patient.
     */
    public const DEFAULT_PATIENT_LIMIT = 10;

    /**
     * Load Synthea CSVs from $csvDir, then write a 4-week appointment
     * schedule for the loaded patients.
     *
     * @param int|null $limit Patient cap. null → DEFAULT_PATIENT_LIMIT (10);
     *                        0 → no cap (load all 117 patients);
     *                        any positive integer → cap to that many.
     *
     * @return array{patients: list<array{pid: int, uuid: string, name: string, pubpid: string}>, log: list<string>, skipped: int, appointments: int}
     */
    public function seed(string $csvDir, ?int $limit = null, ?\Closure $progress = null): array
    {
        $effectiveLimit = match (true) {
            $limit === null => self::DEFAULT_PATIENT_LIMIT,
            $limit <= 0     => null, // load everything
            default         => $limit,
        };
        $result = $this->loader->loadCsvDir($csvDir, $effectiveLimit, $progress);

        $appointments = 0;
        if ($result['patients'] !== []) {
            $appointments = $this->scheduler->reschedule(array_map(
                static fn(array $p): array => ['pid' => $p['pid'], 'name' => $p['name']],
                $result['patients']
            ));
        }

        return [
            'patients'     => $result['patients'],
            'log'          => $result['log'],
            'skipped'      => $result['skipped'],
            'appointments' => $appointments,
        ];
    }

    /**
     * Remove every demo patient (pubpid LIKE 'AGENTFORGE-%') and every row
     * keyed off them. Returns the count of patients deleted.
     */
    public function reset(): int
    {
        $rows = sqlStatement(
            "SELECT pid FROM patient_data WHERE pubpid LIKE ?",
            [self::DEMO_PUBPID_PREFIX . '%']
        );

        $pids = [];
        while ($row = sqlFetchArray($rows)) {
            $pids[] = (int) $row['pid'];
        }

        foreach ($pids as $pid) {
            $this->deletePatientCascade($pid);
        }

        $this->log[] = sprintf('Deleted %d demo patient(s) and all linked rows.', count($pids));
        return count($pids);
    }

    private function deletePatientCascade(int $pid): void
    {
        // OpenEMR has no service-level cascade delete keyed by pid; calling
        // 30+ per-resource delete()s would be longer, slower, and still leave
        // uuid_registry orphans behind. UUIDs registered by createUuid() carry
        // table_id='' until OpenEMR's backfill sweep runs, so the only safe
        // cleanup key is the binary UUID itself (matched against the data
        // row's `uuid` column).
        $this->wipeUuidsByValue("SELECT uuid FROM patient_data WHERE pid = ?", [$pid]);
        $this->wipeUuidsByValue("SELECT uuid FROM form_encounter WHERE pid = ?", [$pid]);
        $this->wipeUuidsByValue("SELECT uuid FROM form_vitals WHERE pid = ?", [$pid]);
        $this->wipeUuidsByValue("SELECT uuid FROM lists WHERE pid = ?", [$pid]);
        $this->wipeUuidsByValue("SELECT uuid FROM prescriptions WHERE patient_id = ?", [$pid]);
        $this->wipeUuidsByValue("SELECT uuid FROM procedure_order WHERE patient_id = ?", [$pid]);
        $this->wipeUuidsByValue(
            "SELECT pr.uuid FROM procedure_report pr
             JOIN procedure_order po ON po.procedure_order_id = pr.procedure_order_id
             WHERE po.patient_id = ?",
            [$pid]
        );
        $this->wipeUuidsByValue(
            "SELECT prs.uuid FROM procedure_result prs
             JOIN procedure_report pr ON pr.procedure_report_id = prs.procedure_report_id
             JOIN procedure_order po ON po.procedure_order_id = pr.procedure_order_id
             WHERE po.patient_id = ?",
            [$pid]
        );

        // Delete data rows in FK-safe order (children before parents).
        sqlStatement(
            "DELETE prs FROM procedure_result prs
             JOIN procedure_report pr ON pr.procedure_report_id = prs.procedure_report_id
             JOIN procedure_order po ON po.procedure_order_id = pr.procedure_order_id
             WHERE po.patient_id = ?",
            [$pid]
        );
        sqlStatement(
            "DELETE pr FROM procedure_report pr
             JOIN procedure_order po ON po.procedure_order_id = pr.procedure_order_id
             WHERE po.patient_id = ?",
            [$pid]
        );
        sqlStatement(
            "DELETE poc FROM procedure_order_code poc
             JOIN procedure_order po ON po.procedure_order_id = poc.procedure_order_id
             WHERE po.patient_id = ?",
            [$pid]
        );
        sqlStatement("DELETE FROM procedure_order WHERE patient_id = ?", [$pid]);
        sqlStatement("DELETE FROM form_vitals WHERE pid = ?", [$pid]);
        sqlStatement("DELETE FROM forms WHERE pid = ?", [$pid]);
        sqlStatement("DELETE FROM form_encounter WHERE pid = ?", [$pid]);
        sqlStatement("DELETE FROM prescriptions WHERE patient_id = ?", [$pid]);
        sqlStatement("DELETE FROM lists WHERE pid = ?", [$pid]);
        // Calendar appointments (pc_pid is varchar, hence the string cast).
        sqlStatement("DELETE FROM openemr_postcalendar_events WHERE pc_pid = ?", [(string) $pid]);
        sqlStatement("DELETE FROM patient_data WHERE pid = ?", [$pid]);
    }

    /**
     * @param list<mixed> $bind
     */
    private function wipeUuidsByValue(string $selectSql, array $bind): void
    {
        $stmt = sqlStatement($selectSql, $bind);
        $uuids = [];
        while ($row = sqlFetchArray($stmt)) {
            if (!empty($row['uuid'])) {
                $uuids[] = $row['uuid'];
            }
        }
        if ($uuids === []) {
            return;
        }
        $placeholders = implode(',', array_fill(0, count($uuids), '?'));
        sqlStatement(
            "DELETE FROM uuid_registry WHERE uuid IN ($placeholders)",
            $uuids
        );
    }
}
