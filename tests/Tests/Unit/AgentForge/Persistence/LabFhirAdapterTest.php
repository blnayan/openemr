<?php

/**
 * LabFhirAdapter Unit Test
 *
 * Verifies translation of LabResult rows to procedure_*-chain inserts
 * and back-pointer recording. Uses closures as collaborator stand-ins
 * so the adapter is exercised without a database. Covers:
 *
 *  - happy-path: every row produces an order/report/result with three
 *    `written` resource-link rows
 *  - partial failure: one bad row produces a `failed` link row but
 *    does not abort the rest of the document
 *  - back-pointer association: the extraction id and row index are
 *    preserved on every link row (forward-trace from extraction to
 *    chart, backward-trace from chart to source PDF)
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Unit\AgentForge\Persistence;

use OpenEMR\AgentForge\Persistence\LabFhirAdapter;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;

final class LabFhirAdapterTest extends TestCase
{
    /** @var list<array<string, mixed>> */
    private array $orderInserts = [];

    /** @var list<array<string, mixed>> */
    private array $reportInserts = [];

    /** @var list<array<string, mixed>> */
    private array $resultInserts = [];

    /** @var list<array<string, mixed>> */
    private array $linkInserts = [];

    private int $orderIdSeq  = 1000;
    private int $reportIdSeq = 2000;
    private int $resultIdSeq = 3000;

    #[Test]
    public function writesEveryRowAndRecordsBackPointers(): void
    {
        $adapter = $this->makeAdapter();

        $extracted = [
            'collection_date_default' => '2026-01-15T08:00:00Z',
            'results' => [
                [
                    'test_name'       => 'Hemoglobin A1c',
                    'loinc_code'      => '4548-4',
                    'numeric_value'   => 7.2,
                    'display_value'   => '7.2',
                    'unit'            => '%',
                    'reference_range' => ['low' => 4.0, 'high' => 5.6, 'raw_text' => '4.0-5.6'],
                    'abnormal_flag'   => 'H',
                    'collection_date' => '2026-01-15T08:00:00Z',
                ],
                [
                    'test_name'       => 'Glucose, fasting',
                    'loinc_code'      => '1558-6',
                    'numeric_value'   => 110,
                    'display_value'   => '110',
                    'unit'            => 'mg/dL',
                    'reference_range' => ['low' => 70, 'high' => 99, 'raw_text' => '70-99 mg/dL'],
                    'abnormal_flag'   => 'H',
                    'collection_date' => null,
                ],
            ],
        ];

        $outcome = $adapter->writeThrough(extractionId: 42, patientId: 7, extracted: $extracted);

        self::assertSame(2, $outcome->successes);
        self::assertSame(0, $outcome->failures);
        self::assertTrue($outcome->isClean());
        self::assertCount(2, $this->orderInserts);
        self::assertCount(2, $this->reportInserts);
        self::assertCount(2, $this->resultInserts);
        // 3 links per row × 2 rows = 6 link rows.
        self::assertCount(6, $this->linkInserts);

        // First row's order: LOINC and test_name passed through.
        self::assertSame('4548-4', $this->orderInserts[0]['loinc']);
        self::assertSame('Hemoglobin A1c', $this->orderInserts[0]['testName']);
        // Second row used document default since collection_date was null.
        self::assertSame('2026-01-15 08:00:00', $this->orderInserts[1]['collectedAt']);

        // Result row carries the numeric value, units, range, abnormal flag.
        self::assertSame('7.2', $this->resultInserts[0]['value']);
        self::assertSame('%', $this->resultInserts[0]['units']);
        self::assertSame('4.0-5.6', $this->resultInserts[0]['range']);
        self::assertSame('yes', $this->resultInserts[0]['abnormal']);
        self::assertSame('N', $this->resultInserts[0]['dataType']);

        // Back-pointers — every link row carries extraction_id=42 and the
        // correct row_index, with status='written'.
        foreach ($this->linkInserts as $link) {
            self::assertSame(42, $link['extractionId']);
            self::assertSame('written', $link['status']);
            self::assertNull($link['errorMessage']);
            self::assertGreaterThan(0, $link['resourceId']);
        }
        // First two rows should each have one link per resource type.
        $row0Links = array_filter($this->linkInserts, static fn ($l) => $l['rowIndex'] === 0);
        $row1Links = array_filter($this->linkInserts, static fn ($l) => $l['rowIndex'] === 1);
        self::assertCount(3, $row0Links);
        self::assertCount(3, $row1Links);
        self::assertSame(
            [
                LabFhirAdapter::RESOURCE_PROCEDURE_ORDER,
                LabFhirAdapter::RESOURCE_PROCEDURE_REPORT,
                LabFhirAdapter::RESOURCE_PROCEDURE_RESULT,
            ],
            array_values(array_map(static fn ($l) => $l['resourceType'], $row0Links)),
        );
    }

    #[Test]
    public function badRowDoesNotBlockRestOfDocument(): void
    {
        // Make the order inserter throw on the second row so we can
        // confirm the loop continues to the third row and records a
        // failure for the second.
        $orderInserter = function (int $patientId, string $loinc, string $testName, string $collectedAt, int $labProviderId): int {
            $this->orderInserts[] = compact('patientId', 'loinc', 'testName', 'collectedAt', 'labProviderId');
            if ($testName === 'Bad Row') {
                throw new \RuntimeException('SQL insert failed');
            }
            return $this->orderIdSeq++;
        };

        $adapter = new LabFhirAdapter(
            orderInserter:             $orderInserter,
            reportInserter:            $this->makeReportInserter(),
            resultInserter:            $this->makeResultInserter(),
            linkInserter:              $this->makeLinkInserter(),
            procedureProviderResolver: fn (): int => 99,
        );

        $extracted = [
            'collection_date_default' => '2026-01-15T08:00:00Z',
            'results' => [
                ['test_name' => 'Good Row 1', 'loinc_code' => 'X', 'numeric_value' => 1.0, 'display_value' => '1', 'unit' => null, 'reference_range' => ['low' => null, 'high' => null, 'raw_text' => ''], 'abnormal_flag' => 'N', 'collection_date' => null],
                ['test_name' => 'Bad Row',    'loinc_code' => 'X', 'numeric_value' => 2.0, 'display_value' => '2', 'unit' => null, 'reference_range' => ['low' => null, 'high' => null, 'raw_text' => ''], 'abnormal_flag' => 'N', 'collection_date' => null],
                ['test_name' => 'Good Row 3', 'loinc_code' => 'X', 'numeric_value' => 3.0, 'display_value' => '3', 'unit' => null, 'reference_range' => ['low' => null, 'high' => null, 'raw_text' => ''], 'abnormal_flag' => 'N', 'collection_date' => null],
            ],
        ];

        $outcome = $adapter->writeThrough(extractionId: 42, patientId: 7, extracted: $extracted);

        self::assertSame(2, $outcome->successes);
        self::assertSame(1, $outcome->failures);
        self::assertTrue($outcome->isPartialFailure());
        self::assertArrayHasKey(1, $outcome->rowErrors);
        self::assertSame('SQL insert failed', $outcome->rowErrors[1]);

        // 3 link rows for each good row + 1 failure link for the bad row.
        self::assertCount(7, $this->linkInserts);

        $failedLinks = array_filter($this->linkInserts, static fn ($l) => $l['status'] === 'failed');
        self::assertCount(1, $failedLinks);
        $failed = array_values($failedLinks)[0];
        self::assertSame(1, $failed['rowIndex']);
        self::assertSame(0, $failed['resourceId']);
        self::assertSame('SQL insert failed', $failed['errorMessage']);
    }

    #[Test]
    public function emptyResultsListReturnsCleanZeroOutcome(): void
    {
        $adapter = $this->makeAdapter();
        $outcome = $adapter->writeThrough(extractionId: 42, patientId: 7, extracted: ['results' => []]);

        self::assertSame(0, $outcome->successes);
        self::assertSame(0, $outcome->failures);
        self::assertTrue($outcome->isClean());
        self::assertSame(0, $outcome->totalRows());
        self::assertSame([], $this->orderInserts);
        self::assertSame([], $this->linkInserts);
    }

    #[Test]
    public function nonNumericValueWritesAsStringDataType(): void
    {
        $adapter = $this->makeAdapter();

        $outcome = $adapter->writeThrough(extractionId: 1, patientId: 1, extracted: [
            'results' => [
                [
                    'test_name'       => 'Urine culture',
                    'loinc_code'      => null,
                    'numeric_value'   => null,
                    'display_value'   => 'No growth',
                    'unit'            => null,
                    'reference_range' => ['low' => null, 'high' => null, 'raw_text' => ''],
                    'abnormal_flag'   => null,
                    'collection_date' => null,
                ],
            ],
        ]);

        self::assertSame(1, $outcome->successes);
        self::assertSame('S', $this->resultInserts[0]['dataType']);
        self::assertSame('No growth', $this->resultInserts[0]['value']);
        self::assertSame('', $this->resultInserts[0]['units']);
        self::assertSame('no', $this->resultInserts[0]['abnormal']);
    }

    // -----------------------------------------------------------------
    // Idempotency: dedup key + insert/update path + evidence trail
    // -----------------------------------------------------------------
    //
    // Locks in the contract for re-uploading the same lab document
    // (or a different document that asserts the same lab row): the
    // second commit MUST update the existing chart row instead of
    // inserting a duplicate, AND it MUST append a fresh evidence row
    // so the audit trail captures every assertion.

    #[Test]
    public function dedupKeyPrefersLoincOverTestNameAndIsDateOnly(): void
    {
        // LOINC present → key uses LOINC; collection time is dropped to
        // YYYY-MM-DD so a same-day re-upload at a different hour still
        // dedups.
        $a = LabFhirAdapter::dedupKey(7, '4548-4', 'Hemoglobin A1c', '2026-01-15 08:00:00');
        $b = LabFhirAdapter::dedupKey(7, '4548-4', 'HEMOGLOBIN A1C',  '2026-01-15 14:30:00');
        self::assertSame($a, $b);
        self::assertStringContainsString('loinc:4548-4', $a);
        self::assertStringEndsWith('|2026-01-15', $a);

        // No LOINC → key falls back to a normalized lowercase test_name.
        $c = LabFhirAdapter::dedupKey(7, null, 'HDL Cholesterol', '2026-01-15 00:00:00');
        $d = LabFhirAdapter::dedupKey(7, '',   'hdl cholesterol', '2026-01-15 00:00:00');
        self::assertSame($c, $d);
        self::assertStringContainsString('name:hdl cholesterol', $c);

        // Patient + key isolation: same test, different patient → different key.
        self::assertNotSame($a, LabFhirAdapter::dedupKey(8, '4548-4', 'Hemoglobin A1c', '2026-01-15 08:00:00'));
    }

    #[Test]
    public function secondCommitOfSameRowUpdatesExistingResultAndRecordsEvidence(): void
    {
        $existingId = 9001;
        $finder = function (int $patientId, string $dedupKey) use ($existingId): ?int {
            // Prove the adapter consults the finder with the right
            // patient + key by stashing the args for the caller to
            // inspect.
            $this->finderCalls[] = compact('patientId', 'dedupKey');
            return $existingId;
        };
        $updaterCalls = [];
        $updater = function (int $resultId, string $units, string $value, string $range, string $abnormal, string $dataType, string $resultedAt) use (&$updaterCalls): void {
            $updaterCalls[] = compact('resultId', 'units', 'value', 'range', 'abnormal', 'dataType', 'resultedAt');
        };
        $evidenceCalls = [];
        $evidence = function (int $extractionId, int $patientId, int $resultId, string $dedupKey) use (&$evidenceCalls): void {
            $evidenceCalls[] = compact('extractionId', 'patientId', 'resultId', 'dedupKey');
        };

        $adapter = new LabFhirAdapter(
            orderInserter:             $this->makeOrderInserter(),
            reportInserter:            $this->makeReportInserter(),
            resultInserter:            $this->makeResultInserter(),
            linkInserter:              $this->makeLinkInserter(),
            procedureProviderResolver: fn (): int => 99,
            existingResultFinder:      $finder,
            resultUpdater:             $updater,
            evidenceRecorder:          $evidence,
        );

        $outcome = $adapter->writeThrough(extractionId: 50, patientId: 7, extracted: [
            'collection_date_default' => '2026-01-15T08:00:00Z',
            'results' => [
                [
                    'test_name'       => 'HDL Cholesterol',
                    'loinc_code'      => '2085-9',
                    'numeric_value'   => 58,
                    'display_value'   => '58',
                    'unit'            => 'mg/dL',
                    'reference_range' => ['low' => 40, 'high' => null, 'raw_text' => '>40'],
                    'abnormal_flag'   => 'N',
                    'collection_date' => null,
                ],
            ],
        ]);

        // Dedup hit → no INSERT chain ran, just an UPDATE on the
        // existing chart row plus an evidence row.
        self::assertSame(1, $outcome->successes);
        self::assertSame(0, $outcome->failures);
        self::assertSame(0, $outcome->insertedCount());
        self::assertSame(1, $outcome->updatedCount());
        self::assertCount(0, $this->orderInserts);
        self::assertCount(0, $this->reportInserts);
        self::assertCount(0, $this->resultInserts);
        self::assertCount(1, $updaterCalls);
        self::assertSame($existingId, $updaterCalls[0]['resultId']);
        self::assertSame('58', $updaterCalls[0]['value']);

        // Evidence row references the right dedup key so the next
        // commit can find this row again.
        self::assertCount(1, $evidenceCalls);
        self::assertSame($existingId, $evidenceCalls[0]['resultId']);
        self::assertStringContainsString('loinc:2085-9', $evidenceCalls[0]['dedupKey']);
        self::assertStringEndsWith('|2026-01-15', $evidenceCalls[0]['dedupKey']);

        // Resource link still records 'written' on the result so the
        // back-pointer trail is complete even on the update path.
        $resultLinks = array_values(array_filter(
            $this->linkInserts,
            static fn ($l): bool => $l['resourceType'] === LabFhirAdapter::RESOURCE_PROCEDURE_RESULT,
        ));
        self::assertCount(1, $resultLinks);
        self::assertSame($existingId, $resultLinks[0]['resourceId']);
        self::assertSame('written', $resultLinks[0]['status']);
    }

    #[Test]
    public function mixedBatchInsertsNewAndUpdatesExistingRows(): void
    {
        // Finder returns an existing id ONLY for the row whose dedup
        // key contains "loinc:4548-4" (Hemoglobin A1c). Everything else
        // is a fresh insert. Models a real second commit where one row
        // was already on the chart but a second row is brand new.
        $finder = static fn (int $patientId, string $dedupKey): ?int =>
            str_contains($dedupKey, 'loinc:4548-4') ? 5500 : null;
        $updates = 0;
        $updater = function () use (&$updates): void { $updates++; };
        $evidence = function (): void {};

        $adapter = new LabFhirAdapter(
            orderInserter:             $this->makeOrderInserter(),
            reportInserter:            $this->makeReportInserter(),
            resultInserter:            $this->makeResultInserter(),
            linkInserter:              $this->makeLinkInserter(),
            procedureProviderResolver: fn (): int => 99,
            existingResultFinder:      $finder,
            resultUpdater:             $updater,
            evidenceRecorder:          $evidence,
        );

        $outcome = $adapter->writeThrough(extractionId: 51, patientId: 7, extracted: [
            'collection_date_default' => '2026-01-15T08:00:00Z',
            'results' => [
                ['test_name' => 'Hemoglobin A1c',  'loinc_code' => '4548-4', 'numeric_value' => 7.2, 'display_value' => '7.2', 'unit' => '%', 'reference_range' => ['low' => null, 'high' => 5.6, 'raw_text' => ''], 'abnormal_flag' => 'H', 'collection_date' => null],
                ['test_name' => 'New Test Row',    'loinc_code' => '9999-9', 'numeric_value' => 1,   'display_value' => '1',   'unit' => 'x', 'reference_range' => ['low' => null, 'high' => null, 'raw_text' => ''], 'abnormal_flag' => 'N', 'collection_date' => null],
            ],
        ]);

        self::assertSame(2, $outcome->successes);
        self::assertSame(1, $outcome->insertedCount());
        self::assertSame(1, $outcome->updatedCount());
        self::assertSame(1, $updates);
        // Only the inserted row produced order/report/result inserts.
        self::assertCount(1, $this->orderInserts);
        self::assertSame('New Test Row', $this->orderInserts[0]['testName']);
    }

    #[Test]
    public function legacyConstructorWithoutFinderInsertsAlways(): void
    {
        // Adapter built without the new optional closures must behave
        // like the pre-idempotency adapter: every row is an insert.
        // Locks in the back-compat contract callers depend on.
        $adapter = $this->makeAdapter();

        $outcome = $adapter->writeThrough(extractionId: 1, patientId: 1, extracted: [
            'results' => [
                ['test_name' => 'X', 'loinc_code' => null, 'numeric_value' => 1, 'display_value' => '1', 'unit' => null, 'reference_range' => ['low' => null, 'high' => null, 'raw_text' => ''], 'abnormal_flag' => null, 'collection_date' => null],
                ['test_name' => 'X', 'loinc_code' => null, 'numeric_value' => 1, 'display_value' => '1', 'unit' => null, 'reference_range' => ['low' => null, 'high' => null, 'raw_text' => ''], 'abnormal_flag' => null, 'collection_date' => null],
            ],
        ]);

        self::assertSame(2, $outcome->successes);
        self::assertSame(2, $outcome->insertedCount());
        self::assertSame(0, $outcome->updatedCount());
        self::assertCount(2, $this->orderInserts);
    }

    #[Test]
    public function receiptStringSummarizesInsertedAndUpdatedCounts(): void
    {
        // dedup key lowercases LOINC, so match the lowercased fragment.
        $finder = static fn (int $p, string $k): ?int => str_contains($k, 'loinc:a') ? 10 : null;
        $adapter = new LabFhirAdapter(
            orderInserter:             $this->makeOrderInserter(),
            reportInserter:            $this->makeReportInserter(),
            resultInserter:            $this->makeResultInserter(),
            linkInserter:              $this->makeLinkInserter(),
            procedureProviderResolver: fn (): int => 99,
            existingResultFinder:      $finder,
            resultUpdater:             function (): void {},
            evidenceRecorder:          function (): void {},
        );

        $outcome = $adapter->writeThrough(extractionId: 1, patientId: 1, extracted: [
            'collection_date_default' => '2026-01-15T08:00:00Z',
            'results' => [
                ['test_name' => 'AA', 'loinc_code' => 'A', 'numeric_value' => 1, 'display_value' => '1', 'unit' => null, 'reference_range' => ['low' => null, 'high' => null, 'raw_text' => ''], 'abnormal_flag' => null, 'collection_date' => null],
                ['test_name' => 'BB', 'loinc_code' => 'B', 'numeric_value' => 2, 'display_value' => '2', 'unit' => null, 'reference_range' => ['low' => null, 'high' => null, 'raw_text' => ''], 'abnormal_flag' => null, 'collection_date' => null],
            ],
        ]);

        self::assertSame('1 added, 1 updated (lab results)', $outcome->receipt());
    }

    /** @var list<array<string, mixed>> */
    private array $finderCalls = [];

    private function makeAdapter(): LabFhirAdapter
    {
        return new LabFhirAdapter(
            orderInserter:             $this->makeOrderInserter(),
            reportInserter:            $this->makeReportInserter(),
            resultInserter:            $this->makeResultInserter(),
            linkInserter:              $this->makeLinkInserter(),
            procedureProviderResolver: fn (): int => 99,
        );
    }

    private function makeOrderInserter(): \Closure
    {
        return function (int $patientId, string $loinc, string $testName, string $collectedAt, int $labProviderId): int {
            $this->orderInserts[] = compact('patientId', 'loinc', 'testName', 'collectedAt', 'labProviderId');
            return $this->orderIdSeq++;
        };
    }

    private function makeReportInserter(): \Closure
    {
        return function (int $orderId, string $reportedAt): int {
            $this->reportInserts[] = compact('orderId', 'reportedAt');
            return $this->reportIdSeq++;
        };
    }

    private function makeResultInserter(): \Closure
    {
        return function (
            int $reportId,
            string $loinc,
            string $testName,
            string $resultedAt,
            string $units,
            string $value,
            string $range,
            string $abnormal,
            string $dataType,
        ): int {
            $this->resultInserts[] = compact(
                'reportId',
                'loinc',
                'testName',
                'resultedAt',
                'units',
                'value',
                'range',
                'abnormal',
                'dataType',
            );
            return $this->resultIdSeq++;
        };
    }

    private function makeLinkInserter(): \Closure
    {
        return function (
            int $extractionId,
            int $rowIndex,
            string $resourceType,
            int $resourceId,
            string $status,
            ?string $errorMessage,
        ): void {
            $this->linkInserts[] = compact(
                'extractionId',
                'rowIndex',
                'resourceType',
                'resourceId',
                'status',
                'errorMessage',
            );
        };
    }
}
