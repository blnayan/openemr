<?php

/**
 * IntakeWriteAdapter Isolated Test
 *
 * Mirrors LabFhirAdapterTest's posture: collaborator inserters are
 * closures that record their args, so the adapter is exercised without
 * a database. Covers the issue 23 acceptance criteria explicitly:
 *
 *   - medication round-trip → `lists` insert with `type='medication'`
 *     and a back-pointer in agentforge_resource_links.
 *   - allergy round-trip → `lists` insert with `type='allergy'` plus a
 *     back-pointer.
 *   - chief-concern → a single `pnotes` insert plus a back-pointer.
 *   - partial success → one bad row in any bucket does not block the
 *     others; per-bucket failure counts and a partial-success summary
 *     are exposed on the WriteOutcome.
 *   - demographics + family_history are NEVER written.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\AgentForge\Persistence;

use OpenEMR\AgentForge\Persistence\IntakeWriteAdapter;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;

final class IntakeWriteAdapterIsolatedTest extends TestCase
{
    /** @var list<array<string, mixed>> */
    private array $medicationInserts = [];

    /** @var list<array<string, mixed>> */
    private array $allergyInserts = [];

    /** @var list<array<string, mixed>> */
    private array $pnoteInserts = [];

    /** @var list<array<string, mixed>> */
    private array $linkInserts = [];

    private int $listsIdSeq  = 1000;
    private int $pnoteIdSeq  = 5000;

    #[Test]
    public function medicationRowsWriteToListsAndRecordBackPointers(): void
    {
        $adapter = $this->makeAdapter();

        $extracted = [
            'current_medications' => [
                [
                    'name' => 'Metformin',
                    'dose' => '500 mg',
                    'frequency' => 'twice daily',
                    'route' => 'oral',
                    'is_otc_or_supplement' => false,
                ],
                [
                    'name' => 'Vitamin D3',
                    'dose' => '1000 IU',
                    'frequency' => 'daily',
                    'route' => null,
                    'is_otc_or_supplement' => true,
                ],
            ],
            'allergies' => [],
            'chief_concern' => null,
        ];

        $outcome = $adapter->writeThrough(extractionId: 42, patientId: 7, extracted: $extracted);

        self::assertSame(2, $outcome->medicationSuccesses);
        self::assertSame(0, $outcome->medicationFailures);
        self::assertCount(2, $this->medicationInserts);
        self::assertSame([], $this->allergyInserts);
        self::assertSame([], $this->pnoteInserts);

        self::assertSame(7, $this->medicationInserts[0]['patientId']);
        self::assertSame('Metformin', $this->medicationInserts[0]['title']);
        $firstComments = $this->medicationInserts[0]['comments'];
        self::assertIsString($firstComments);
        self::assertStringContainsString('dose: 500 mg', $firstComments);
        self::assertStringContainsString('frequency: twice daily', $firstComments);
        self::assertStringContainsString('route: oral', $firstComments);
        self::assertStringNotContainsString('otc_or_supplement', $firstComments);

        self::assertSame('Vitamin D3', $this->medicationInserts[1]['title']);
        $secondComments = $this->medicationInserts[1]['comments'];
        self::assertIsString($secondComments);
        self::assertStringContainsString('otc_or_supplement: yes', $secondComments);

        // Two written link rows, both `medication`, with the right
        // extraction id and row indices preserved.
        self::assertCount(2, $this->linkInserts);
        foreach ($this->linkInserts as $i => $link) {
            self::assertSame(42, $link['extractionId']);
            self::assertSame(IntakeWriteAdapter::RESOURCE_MEDICATION, $link['resourceType']);
            self::assertSame('written', $link['status']);
            self::assertNull($link['errorMessage']);
            self::assertSame($i, $link['rowIndex']);
        }
    }

    #[Test]
    public function allergyRowsWriteToListsWithSubstanceReactionAndSeverity(): void
    {
        $adapter = $this->makeAdapter();

        $extracted = [
            'current_medications' => [],
            'allergies' => [
                [
                    'substance' => 'Penicillin',
                    'reaction' => 'rash',
                    'severity' => 'moderate',
                ],
                [
                    'substance' => 'Peanuts',
                    'reaction' => 'anaphylaxis',
                    'severity' => 'severe',
                ],
                [
                    'substance' => 'Latex',
                    'reaction' => null,
                    'severity' => null,
                ],
            ],
            'chief_concern' => null,
        ];

        $outcome = $adapter->writeThrough(extractionId: 99, patientId: 13, extracted: $extracted);

        self::assertSame(3, $outcome->allergySuccesses);
        self::assertSame(0, $outcome->allergyFailures);
        self::assertCount(3, $this->allergyInserts);
        self::assertSame([], $this->medicationInserts);
        self::assertSame([], $this->pnoteInserts);

        self::assertSame('Penicillin', $this->allergyInserts[0]['title']);
        self::assertSame('rash', $this->allergyInserts[0]['reaction']);
        self::assertSame('moderate', $this->allergyInserts[0]['severity']);
        self::assertSame('severe', $this->allergyInserts[1]['severity']);
        self::assertNull($this->allergyInserts[2]['severity']);
        self::assertSame('', $this->allergyInserts[2]['reaction']);

        self::assertCount(3, $this->linkInserts);
        foreach ($this->linkInserts as $i => $link) {
            self::assertSame(99, $link['extractionId']);
            self::assertSame(IntakeWriteAdapter::RESOURCE_ALLERGY, $link['resourceType']);
            self::assertSame('written', $link['status']);
            self::assertSame($i, $link['rowIndex']);
        }
    }

    #[Test]
    public function chiefConcernWritesASinglePnotesRowTaggedAsIntakeDerived(): void
    {
        $adapter = $this->makeAdapter();

        $extracted = [
            'current_medications' => [],
            'allergies' => [],
            'chief_concern' => [
                'text' => 'numbness in left hand for 3 days',
            ],
        ];

        $outcome = $adapter->writeThrough(extractionId: 7, patientId: 21, extracted: $extracted);

        self::assertSame(1, $outcome->chiefConcernSuccesses);
        self::assertSame(0, $outcome->chiefConcernFailures);
        self::assertNull($outcome->chiefConcernError);
        self::assertCount(1, $this->pnoteInserts);
        self::assertSame(21, $this->pnoteInserts[0]['patientId']);
        self::assertSame('AgentForge Intake Chief Concern', $this->pnoteInserts[0]['title']);
        self::assertSame('numbness in left hand for 3 days', $this->pnoteInserts[0]['body']);

        self::assertCount(1, $this->linkInserts);
        self::assertSame(IntakeWriteAdapter::RESOURCE_PNOTE, $this->linkInserts[0]['resourceType']);
        self::assertSame(7, $this->linkInserts[0]['extractionId']);
        self::assertSame('written', $this->linkInserts[0]['status']);
    }

    #[Test]
    public function nullChiefConcernProducesNoPnoteAndNoFailure(): void
    {
        $adapter = $this->makeAdapter();

        $outcome = $adapter->writeThrough(extractionId: 1, patientId: 1, extracted: [
            'current_medications' => [],
            'allergies' => [],
            'chief_concern' => null,
        ]);

        self::assertSame(0, $outcome->chiefConcernSuccesses);
        self::assertSame(0, $outcome->chiefConcernFailures);
        self::assertSame([], $this->pnoteInserts);
        self::assertSame([], $this->linkInserts);
        self::assertTrue($outcome->isClean());
    }

    #[Test]
    public function partialFailureInOneBucketDoesNotBlockOtherBuckets(): void
    {
        // Make the medication inserter throw on the second row; the
        // first medication, all allergies, and the chief concern must
        // still write.
        $medicationInserter = function (int $patientId, string $title, string $comments): int {
            $this->medicationInserts[] = compact('patientId', 'title', 'comments');
            if ($title === 'BadMed') {
                throw new \RuntimeException('SQL insert failed');
            }
            return $this->listsIdSeq++;
        };

        $adapter = new IntakeWriteAdapter(
            medicationInserter: $medicationInserter,
            allergyInserter:    $this->makeAllergyInserter(),
            pnoteInserter:      $this->makePnoteInserter(),
            linkInserter:       $this->makeLinkInserter(),
        );

        $extracted = [
            'current_medications' => [
                ['name' => 'GoodMed', 'dose' => '10 mg', 'frequency' => 'daily', 'route' => 'oral', 'is_otc_or_supplement' => false],
                ['name' => 'BadMed',  'dose' => null,    'frequency' => null,    'route' => null,    'is_otc_or_supplement' => false],
                ['name' => 'GoodMed2','dose' => null,    'frequency' => null,    'route' => null,    'is_otc_or_supplement' => false],
            ],
            'allergies' => [
                ['substance' => 'Penicillin', 'reaction' => 'rash', 'severity' => 'mild'],
            ],
            'chief_concern' => ['text' => 'cough'],
        ];

        $outcome = $adapter->writeThrough(extractionId: 42, patientId: 7, extracted: $extracted);

        self::assertSame(2, $outcome->medicationSuccesses);
        self::assertSame(1, $outcome->medicationFailures);
        self::assertSame(1, $outcome->allergySuccesses);
        self::assertSame(1, $outcome->chiefConcernSuccesses);
        self::assertSame(0, $outcome->allergyFailures);
        self::assertSame(0, $outcome->chiefConcernFailures);

        self::assertTrue($outcome->isPartialFailure());
        self::assertFalse($outcome->isClean());
        self::assertFalse($outcome->isTotalFailure());
        self::assertSame('partial: 1 medication(s) failed', $outcome->partialFailureSummary());

        self::assertArrayHasKey(1, $outcome->medicationErrors);
        self::assertSame('SQL insert failed', $outcome->medicationErrors[1]);

        // The bad row produced a `failed` link row with the captured
        // error message. The other rows produced `written` links.
        $failed = array_values(array_filter($this->linkInserts, static fn ($l): bool => $l['status'] === 'failed'));
        self::assertCount(1, $failed);
        self::assertSame(IntakeWriteAdapter::RESOURCE_MEDICATION, $failed[0]['resourceType']);
        self::assertSame(1, $failed[0]['rowIndex']);
        self::assertSame(0, $failed[0]['resourceId']);
        self::assertSame('SQL insert failed', $failed[0]['errorMessage']);

        $written = array_values(array_filter($this->linkInserts, static fn ($l): bool => $l['status'] === 'written'));
        // 2 medications + 1 allergy + 1 pnote = 4 written link rows.
        self::assertCount(4, $written);
    }

    #[Test]
    public function medicationRowMissingNameIsRejectedWithoutBlockingOthers(): void
    {
        $adapter = $this->makeAdapter();

        $extracted = [
            'current_medications' => [
                ['name' => '', 'dose' => null, 'frequency' => null, 'route' => null, 'is_otc_or_supplement' => false],
                ['name' => 'GoodMed', 'dose' => null, 'frequency' => null, 'route' => null, 'is_otc_or_supplement' => false],
            ],
            'allergies' => [],
            'chief_concern' => null,
        ];

        $outcome = $adapter->writeThrough(extractionId: 1, patientId: 1, extracted: $extracted);

        self::assertSame(1, $outcome->medicationSuccesses);
        self::assertSame(1, $outcome->medicationFailures);
        self::assertSame('medication name missing', $outcome->medicationErrors[0]);
        self::assertCount(1, $this->medicationInserts);
        self::assertSame('GoodMed', $this->medicationInserts[0]['title']);
    }

    #[Test]
    public function demographicsAndFamilyHistoryAreNeverWritten(): void
    {
        $adapter = $this->makeAdapter();

        $extracted = [
            'demographics' => [
                'name' => 'John Q. Public',
                'dob' => '1980-01-01',
                'sex' => 'M',
            ],
            'family_history' => [
                ['relation' => 'mother', 'conditions' => ['diabetes']],
                ['relation' => 'father', 'conditions' => ['hypertension']],
            ],
            'current_medications' => [],
            'allergies' => [],
            'chief_concern' => null,
        ];

        $outcome = $adapter->writeThrough(extractionId: 1, patientId: 1, extracted: $extracted);

        // Nothing was written because the in-scope buckets are empty —
        // demographics and family_history are explicitly out of scope
        // (PRD §"Out of Scope") and must never produce inserts.
        self::assertTrue($outcome->isClean());
        self::assertSame(0, $outcome->totalRows());
        self::assertSame([], $this->medicationInserts);
        self::assertSame([], $this->allergyInserts);
        self::assertSame([], $this->pnoteInserts);
        self::assertSame([], $this->linkInserts);
    }

    #[Test]
    public function emptyExtractionReturnsCleanZeroOutcome(): void
    {
        $adapter = $this->makeAdapter();
        $outcome = $adapter->writeThrough(extractionId: 1, patientId: 1, extracted: []);

        self::assertSame(0, $outcome->totalRows());
        self::assertTrue($outcome->isClean());
        self::assertSame([], $this->linkInserts);
    }

    #[Test]
    public function chiefConcernWriteFailureRecordsFailedLinkButOthersStillWrite(): void
    {
        $pnoteInserter = function (int $patientId, string $title, string $body): int {
            $this->pnoteInserts[] = compact('patientId', 'title', 'body');
            throw new \RuntimeException('pnotes insert failed');
        };

        $adapter = new IntakeWriteAdapter(
            medicationInserter: $this->makeMedicationInserter(),
            allergyInserter:    $this->makeAllergyInserter(),
            pnoteInserter:      $pnoteInserter,
            linkInserter:       $this->makeLinkInserter(),
        );

        $extracted = [
            'current_medications' => [
                ['name' => 'Metformin', 'dose' => null, 'frequency' => null, 'route' => null, 'is_otc_or_supplement' => false],
            ],
            'allergies' => [],
            'chief_concern' => ['text' => 'cough'],
        ];

        $outcome = $adapter->writeThrough(extractionId: 50, patientId: 9, extracted: $extracted);

        self::assertSame(1, $outcome->medicationSuccesses);
        self::assertSame(0, $outcome->chiefConcernSuccesses);
        self::assertSame(1, $outcome->chiefConcernFailures);
        self::assertSame('pnotes insert failed', $outcome->chiefConcernError);
        self::assertTrue($outcome->isPartialFailure());

        $failed = array_values(array_filter($this->linkInserts, static fn ($l): bool => $l['status'] === 'failed'));
        self::assertCount(1, $failed);
        self::assertSame(IntakeWriteAdapter::RESOURCE_PNOTE, $failed[0]['resourceType']);
    }

    private function makeAdapter(): IntakeWriteAdapter
    {
        return new IntakeWriteAdapter(
            medicationInserter: $this->makeMedicationInserter(),
            allergyInserter:    $this->makeAllergyInserter(),
            pnoteInserter:      $this->makePnoteInserter(),
            linkInserter:       $this->makeLinkInserter(),
        );
    }

    private function makeMedicationInserter(): \Closure
    {
        return function (int $patientId, string $title, string $comments): int {
            $this->medicationInserts[] = compact('patientId', 'title', 'comments');
            return $this->listsIdSeq++;
        };
    }

    private function makeAllergyInserter(): \Closure
    {
        return function (int $patientId, string $title, string $reaction, ?string $severity): int {
            $this->allergyInserts[] = compact('patientId', 'title', 'reaction', 'severity');
            return $this->listsIdSeq++;
        };
    }

    private function makePnoteInserter(): \Closure
    {
        return function (int $patientId, string $title, string $body): int {
            $this->pnoteInserts[] = compact('patientId', 'title', 'body');
            return $this->pnoteIdSeq++;
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

    // -----------------------------------------------------------------
    // Idempotency: dedup key + insert/update path + evidence trail
    // -----------------------------------------------------------------
    //
    // Locks in the contract that re-confirming an intake form (or a
    // new intake form that re-asserts the same drug/allergy) UPDATEs
    // the existing chart row instead of inserting a duplicate, while
    // the chief concern remains append-only (timeline semantics).

    /** @var list<array<string, mixed>> */
    private array $medicationUpdates = [];

    /** @var list<array<string, mixed>> */
    private array $allergyUpdates = [];

    /** @var list<array<string, mixed>> */
    private array $evidenceCalls = [];

    #[Test]
    public function dedupKeyNormalizesNameAndIsolatesByPatientAndBucket(): void
    {
        $a = IntakeWriteAdapter::dedupKey(7, IntakeWriteAdapter::RESOURCE_MEDICATION, 'Lisinopril');
        $b = IntakeWriteAdapter::dedupKey(7, IntakeWriteAdapter::RESOURCE_MEDICATION, '  LISINOPRIL ');
        self::assertSame($a, $b);

        // Different patient → different key.
        self::assertNotSame($a, IntakeWriteAdapter::dedupKey(8, IntakeWriteAdapter::RESOURCE_MEDICATION, 'Lisinopril'));
        // Different bucket → different key (a drug named "Penicillin"
        // and a substance named "Penicillin" must NEVER collide).
        self::assertNotSame($a, IntakeWriteAdapter::dedupKey(7, IntakeWriteAdapter::RESOURCE_ALLERGY, 'Lisinopril'));
    }

    #[Test]
    public function reCommittedMedicationUpdatesExistingListsRow(): void
    {
        $existingId = 4242;
        $finder = function (int $patientId, string $dedupKey) use ($existingId): ?int {
            $this->finderCalls[] = compact('patientId', 'dedupKey');
            return $existingId;
        };
        $updater = $this->makeMedicationUpdater();

        $adapter = new IntakeWriteAdapter(
            medicationInserter:        $this->makeMedicationInserter(),
            allergyInserter:           $this->makeAllergyInserter(),
            pnoteInserter:             $this->makePnoteInserter(),
            linkInserter:              $this->makeLinkInserter(),
            existingMedicationFinder:  $finder,
            medicationUpdater:         $updater,
            evidenceRecorder:          $this->makeEvidenceRecorder(),
        );

        $outcome = $adapter->writeThrough(extractionId: 60, patientId: 7, extracted: [
            'current_medications' => [
                ['name' => 'Lisinopril', 'dose' => '20 mg', 'frequency' => 'once daily', 'route' => 'oral', 'is_otc_or_supplement' => false],
            ],
            'allergies' => [],
            'chief_concern' => null,
        ]);

        self::assertSame(1, $outcome->medicationSuccesses);
        self::assertSame(0, $outcome->medicationFailures);
        self::assertSame(0, $outcome->medicationInserted);
        self::assertSame(1, $outcome->medicationUpdated);
        self::assertSame([], $this->medicationInserts, 'no INSERT on the dedup-hit path');
        self::assertCount(1, $this->medicationUpdates);
        self::assertSame($existingId, $this->medicationUpdates[0]['listsId']);
        self::assertStringContainsString('dose: 20 mg', $this->medicationUpdates[0]['comments']);

        // Evidence row records the dedup key and points at the existing
        // row id — the next commit can find this row again.
        self::assertCount(1, $this->evidenceCalls);
        self::assertSame('lists', $this->evidenceCalls[0]['chartTable']);
        self::assertSame($existingId, $this->evidenceCalls[0]['chartRowId']);

        // Resource link still recorded so the back-pointer trail is
        // complete on the update path.
        self::assertCount(1, $this->linkInserts);
        self::assertSame('written', $this->linkInserts[0]['status']);
        self::assertSame($existingId, $this->linkInserts[0]['resourceId']);
    }

    #[Test]
    public function reCommittedAllergyUpdatesExistingListsRow(): void
    {
        $existingId = 7777;
        $finder = function (int $patientId, string $dedupKey) use ($existingId): ?int {
            return $existingId;
        };

        $adapter = new IntakeWriteAdapter(
            medicationInserter:        $this->makeMedicationInserter(),
            allergyInserter:           $this->makeAllergyInserter(),
            pnoteInserter:             $this->makePnoteInserter(),
            linkInserter:              $this->makeLinkInserter(),
            existingAllergyFinder:     $finder,
            allergyUpdater:            $this->makeAllergyUpdater(),
            evidenceRecorder:          $this->makeEvidenceRecorder(),
        );

        $outcome = $adapter->writeThrough(extractionId: 61, patientId: 7, extracted: [
            'current_medications' => [],
            'allergies' => [
                ['substance' => 'Penicillin', 'reaction' => 'rash', 'severity' => 'severe'],
            ],
            'chief_concern' => null,
        ]);

        self::assertSame(1, $outcome->allergySuccesses);
        self::assertSame(1, $outcome->allergyUpdated);
        self::assertSame(0, $outcome->allergyInserted);
        self::assertSame([], $this->allergyInserts);
        self::assertCount(1, $this->allergyUpdates);
        self::assertSame($existingId, $this->allergyUpdates[0]['listsId']);
        self::assertSame('Penicillin', $this->allergyUpdates[0]['title']);
        self::assertSame('rash', $this->allergyUpdates[0]['reaction']);
        self::assertSame('severe', $this->allergyUpdates[0]['severity']);
    }

    #[Test]
    public function chiefConcernIsAlwaysAppendedNeverDeduped(): void
    {
        // Even if a finder is wired (which we deliberately don't pass
        // for chief concern — there's no finder slot), the adapter
        // MUST insert a fresh pnotes row on every commit. Two commits
        // of the same chief concern text → two pnote rows.
        $adapter = new IntakeWriteAdapter(
            medicationInserter:        $this->makeMedicationInserter(),
            allergyInserter:           $this->makeAllergyInserter(),
            pnoteInserter:             $this->makePnoteInserter(),
            linkInserter:              $this->makeLinkInserter(),
            evidenceRecorder:          $this->makeEvidenceRecorder(),
        );

        $extracted = [
            'current_medications' => [],
            'allergies' => [],
            'chief_concern' => ['text' => 'recurring headaches'],
        ];

        $first  = $adapter->writeThrough(extractionId: 70, patientId: 7, extracted: $extracted);
        $second = $adapter->writeThrough(extractionId: 71, patientId: 7, extracted: $extracted);

        self::assertSame(1, $first->chiefConcernSuccesses);
        self::assertSame(1, $second->chiefConcernSuccesses);
        // Two separate pnote rows were inserted — append-only contract.
        self::assertCount(2, $this->pnoteInserts);
        self::assertSame('recurring headaches', $this->pnoteInserts[0]['body']);
        self::assertSame('recurring headaches', $this->pnoteInserts[1]['body']);
        // Each commit produced its own evidence row.
        $pnoteEvidence = array_values(array_filter(
            $this->evidenceCalls,
            static fn ($e): bool => $e['chartTable'] === 'pnotes',
        ));
        self::assertCount(2, $pnoteEvidence);
    }

    #[Test]
    public function mixedBatchInsertsNewMedicationAndUpdatesExisting(): void
    {
        // Finder returns an id only for the second medication (the one
        // matching dedup key fragment "lisinopril"). The first ("Aspirin")
        // is brand-new.
        $finder = static fn (int $patientId, string $dedupKey): ?int =>
            str_contains($dedupKey, 'medication|lisinopril') ? 8888 : null;

        $adapter = new IntakeWriteAdapter(
            medicationInserter:        $this->makeMedicationInserter(),
            allergyInserter:           $this->makeAllergyInserter(),
            pnoteInserter:             $this->makePnoteInserter(),
            linkInserter:              $this->makeLinkInserter(),
            existingMedicationFinder:  $finder,
            medicationUpdater:         $this->makeMedicationUpdater(),
            evidenceRecorder:          $this->makeEvidenceRecorder(),
        );

        $outcome = $adapter->writeThrough(extractionId: 80, patientId: 7, extracted: [
            'current_medications' => [
                ['name' => 'Aspirin',     'dose' => '81 mg',  'frequency' => 'daily',       'route' => 'oral', 'is_otc_or_supplement' => true],
                ['name' => 'Lisinopril',  'dose' => '20 mg',  'frequency' => 'once daily',  'route' => 'oral', 'is_otc_or_supplement' => false],
            ],
            'allergies' => [],
            'chief_concern' => null,
        ]);

        self::assertSame(2, $outcome->medicationSuccesses);
        self::assertSame(1, $outcome->medicationInserted);
        self::assertSame(1, $outcome->medicationUpdated);
        self::assertCount(1, $this->medicationInserts);
        self::assertSame('Aspirin', $this->medicationInserts[0]['title']);
        self::assertCount(1, $this->medicationUpdates);
        self::assertSame(8888, $this->medicationUpdates[0]['listsId']);
    }

    #[Test]
    public function legacyConstructorWithoutFinderInsertsAlways(): void
    {
        // Adapter built without finder/updater/evidence closures must
        // behave like pre-idempotency: every row inserts. Locks in the
        // back-compat contract.
        $adapter = $this->makeAdapter();

        $outcome = $adapter->writeThrough(extractionId: 1, patientId: 1, extracted: [
            'current_medications' => [
                ['name' => 'Aspirin', 'dose' => '81 mg', 'frequency' => 'daily', 'route' => 'oral', 'is_otc_or_supplement' => true],
                ['name' => 'Aspirin', 'dose' => '81 mg', 'frequency' => 'daily', 'route' => 'oral', 'is_otc_or_supplement' => true],
            ],
            'allergies' => [],
            'chief_concern' => null,
        ]);

        self::assertSame(2, $outcome->medicationInserted);
        self::assertSame(0, $outcome->medicationUpdated);
        self::assertCount(2, $this->medicationInserts);
    }

    #[Test]
    public function receiptStringSummarizesPerBucket(): void
    {
        $finder = static fn (int $p, string $k): ?int => str_contains($k, 'medication|lisinopril') ? 1 : null;
        $adapter = new IntakeWriteAdapter(
            medicationInserter:        $this->makeMedicationInserter(),
            allergyInserter:           $this->makeAllergyInserter(),
            pnoteInserter:             $this->makePnoteInserter(),
            linkInserter:              $this->makeLinkInserter(),
            existingMedicationFinder:  $finder,
            medicationUpdater:         $this->makeMedicationUpdater(),
            evidenceRecorder:          $this->makeEvidenceRecorder(),
        );

        $outcome = $adapter->writeThrough(extractionId: 1, patientId: 1, extracted: [
            'current_medications' => [
                ['name' => 'Aspirin',    'dose' => null, 'frequency' => null, 'route' => null, 'is_otc_or_supplement' => false],
                ['name' => 'Lisinopril', 'dose' => null, 'frequency' => null, 'route' => null, 'is_otc_or_supplement' => false],
            ],
            'allergies' => [
                ['substance' => 'Penicillin', 'reaction' => null, 'severity' => null],
            ],
            'chief_concern' => null,
        ]);

        $receipt = $outcome->receipt();
        self::assertStringContainsString('1 added, 1 updated (medications)', $receipt);
        self::assertStringContainsString('1 added (allergies)', $receipt);
    }

    /** @var list<array<string, mixed>> */
    private array $finderCalls = [];

    private function makeMedicationUpdater(): \Closure
    {
        return function (int $listsId, string $title, string $comments): void {
            $this->medicationUpdates[] = compact('listsId', 'title', 'comments');
        };
    }

    private function makeAllergyUpdater(): \Closure
    {
        return function (int $listsId, string $title, string $reaction, ?string $severity): void {
            $this->allergyUpdates[] = compact('listsId', 'title', 'reaction', 'severity');
        };
    }

    private function makeEvidenceRecorder(): \Closure
    {
        return function (int $extractionId, int $patientId, string $chartTable, int $chartRowId, string $dedupKey): void {
            $this->evidenceCalls[] = compact('extractionId', 'patientId', 'chartTable', 'chartRowId', 'dedupKey');
        };
    }
}
