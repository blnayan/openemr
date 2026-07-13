<?php

/**
 * DocumentInboxQueryService Isolated Test.
 *
 * Issue 27 lands the read-side projection that powers the Document
 * Inbox tab. This isolated suite exercises the contract enumerated in
 * the issue's acceptance criteria — empty result, mixed
 * active+history grouping, default sort, provenance filter, status
 * filter, and the page-size boundary — without a real database.
 *
 * The service constructs around a row-fetcher closure; the test
 * substitutes a recording closure that:
 *   - asserts the SQL the service emits respects bind-arity, the
 *     active/history grouping conventions, and the LIMIT/OFFSET the
 *     options imply,
 *   - returns hand-crafted raw rows that exercise the hydration path
 *     end-to-end (status enum tryFrom, edited_field_paths decoder,
 *     uploader display-name fallback, datetime parse).
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\AgentForge\Persistence;

use Closure;
use OpenEMR\AgentForge\Domain\UploadJobProvenance;
use OpenEMR\AgentForge\Domain\UploadJobStatus;
use OpenEMR\AgentForge\Persistence\DocumentInboxQueryOptions;
use OpenEMR\AgentForge\Persistence\DocumentInboxQueryService;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;

final class DocumentInboxQueryServiceIsolatedTest extends TestCase
{
    private const PID = 17;

    /** @var list<array{sql: string, binds: list<scalar|null>}> */
    private array $issuedQueries = [];

    /** @var list<list<array<string, mixed>>> */
    private array $stubResponses = [];

    protected function setUp(): void
    {
        $this->issuedQueries = [];
        $this->stubResponses = [];
    }

    #[Test]
    public function emptyResultGroupsAreBothEmpty(): void
    {
        $this->stubResponses = [[], []];

        $svc = new DocumentInboxQueryService($this->fetcher());
        $result = $svc->listForPatient(self::PID, new DocumentInboxQueryOptions());

        self::assertSame([], $result->active);
        self::assertSame([], $result->history);
        self::assertCount(2, $this->issuedQueries, 'one query per group');
    }

    #[Test]
    public function groupsRowsByPhaseFromMixedStatuses(): void
    {
        $this->stubResponses = [
            [
                $this->row('uuid-extracting', 'extracting', '2026-05-04 10:00:00'),
                $this->row('uuid-pending',    'pending',    '2026-05-04 09:00:00'),
            ],
            [
                $this->row('uuid-committed', 'committed', '2026-05-03 11:00:00'),
                $this->row('uuid-failed',    'failed',    '2026-05-03 10:00:00'),
                $this->row('uuid-rejected',  'rejected',  '2026-05-03 09:00:00'),
            ],
        ];

        $svc    = new DocumentInboxQueryService($this->fetcher());
        $result = $svc->listForPatient(self::PID, new DocumentInboxQueryOptions());

        self::assertCount(2, $result->active);
        self::assertSame(UploadJobStatus::Extracting, $result->active[0]->status);
        self::assertSame(UploadJobStatus::Pending,    $result->active[1]->status);

        self::assertCount(3, $result->history);
        self::assertSame(UploadJobStatus::Committed, $result->history[0]->status);
        self::assertSame(UploadJobStatus::Failed,    $result->history[1]->status);
        self::assertSame(UploadJobStatus::Rejected,  $result->history[2]->status);
    }

    #[Test]
    public function defaultSortIsUploadedAtDescending(): void
    {
        $this->stubResponses = [[], []];

        $svc = new DocumentInboxQueryService($this->fetcher());
        $svc->listForPatient(self::PID, new DocumentInboxQueryOptions());

        foreach ($this->issuedQueries as $q) {
            self::assertStringContainsString('ORDER BY j.started_at DESC', $q['sql']);
        }
    }

    #[Test]
    public function provenanceFlagIsHumanCorrectedWhenEditedFieldPathsIsNonEmpty(): void
    {
        $this->stubResponses = [
            [
                $this->row(
                    'uuid-1',
                    'ready_for_review',
                    '2026-05-04 09:00:00',
                    extractionId:    501,
                    editedFieldPaths: '["tests.0.numeric_value"]',
                ),
                $this->row(
                    'uuid-2',
                    'ready_for_review',
                    '2026-05-04 08:00:00',
                    extractionId:    502,
                    editedFieldPaths: null,
                ),
                $this->row(
                    'uuid-3',
                    'ready_for_review',
                    '2026-05-04 07:00:00',
                    extractionId:    503,
                    editedFieldPaths: '[]',
                ),
            ],
            [],
        ];

        $svc    = new DocumentInboxQueryService($this->fetcher());
        $result = $svc->listForPatient(self::PID, new DocumentInboxQueryOptions());

        self::assertSame(UploadJobProvenance::HumanCorrected, $result->active[0]->provenance);
        self::assertSame(['tests.0.numeric_value'], $result->active[0]->editedFieldPaths);

        self::assertSame(UploadJobProvenance::VlmOnly, $result->active[1]->provenance);
        self::assertNull($result->active[1]->editedFieldPaths);

        self::assertSame(UploadJobProvenance::VlmOnly, $result->active[2]->provenance);
        self::assertSame([], $result->active[2]->editedFieldPaths);
    }

    #[Test]
    public function provenanceFilterAddsHumanCorrectedClause(): void
    {
        $this->stubResponses = [[], []];

        $opts = new DocumentInboxQueryOptions(
            provenanceFilter: UploadJobProvenance::HumanCorrected,
        );
        $svc = new DocumentInboxQueryService($this->fetcher());
        $svc->listForPatient(self::PID, $opts);

        foreach ($this->issuedQueries as $q) {
            self::assertStringContainsString(
                'JSON_LENGTH(e.edited_field_paths) > 0',
                $q['sql'],
            );
            self::assertStringContainsString(
                'edited_field_paths IS NOT NULL',
                $q['sql'],
            );
        }
    }

    #[Test]
    public function provenanceFilterVlmOnlyAddsNullOrEmptyClause(): void
    {
        $this->stubResponses = [[], []];

        $opts = new DocumentInboxQueryOptions(
            provenanceFilter: UploadJobProvenance::VlmOnly,
        );
        $svc = new DocumentInboxQueryService($this->fetcher());
        $svc->listForPatient(self::PID, $opts);

        foreach ($this->issuedQueries as $q) {
            self::assertStringContainsString('JSON_LENGTH(e.edited_field_paths) = 0', $q['sql']);
        }
    }

    #[Test]
    public function statusFilterRestrictsToTheFilteredGroupOnly(): void
    {
        // status=ready_for_review is an active-bucket status.
        // The service must skip the history query entirely.
        $this->stubResponses = [
            [
                $this->row('uuid-rfr', 'ready_for_review', '2026-05-04 09:00:00'),
            ],
        ];

        $opts = new DocumentInboxQueryOptions(statusFilter: UploadJobStatus::ReadyForReview);
        $svc  = new DocumentInboxQueryService($this->fetcher());
        $result = $svc->listForPatient(self::PID, $opts);

        self::assertCount(1, $this->issuedQueries, 'history group is skipped entirely');
        self::assertCount(1, $result->active);
        self::assertSame(UploadJobStatus::ReadyForReview, $result->active[0]->status);
        self::assertSame([], $result->history);
    }

    #[Test]
    public function statusFilterForHistoryStatusSkipsActiveQuery(): void
    {
        $this->stubResponses = [
            [
                $this->row('uuid-c', 'committed', '2026-05-04 09:00:00'),
            ],
        ];

        $opts = new DocumentInboxQueryOptions(statusFilter: UploadJobStatus::Committed);
        $svc  = new DocumentInboxQueryService($this->fetcher());
        $result = $svc->listForPatient(self::PID, $opts);

        self::assertCount(1, $this->issuedQueries);
        self::assertSame([], $result->active);
        self::assertCount(1, $result->history);
    }

    #[Test]
    public function defaultPageSizeAppearsInLimitClause(): void
    {
        $this->stubResponses = [[], []];

        $svc = new DocumentInboxQueryService($this->fetcher());
        $svc->listForPatient(self::PID, new DocumentInboxQueryOptions());

        foreach ($this->issuedQueries as $q) {
            self::assertStringContainsString('LIMIT 25', $q['sql']);
            self::assertStringContainsString('OFFSET 0', $q['sql']);
        }
    }

    #[Test]
    public function customPageSizeAndOffsetAppearInLimitClause(): void
    {
        $this->stubResponses = [[], []];

        $svc = new DocumentInboxQueryService($this->fetcher());
        $svc->listForPatient(self::PID, new DocumentInboxQueryOptions(pageSize: 50, offset: 100));

        foreach ($this->issuedQueries as $q) {
            self::assertStringContainsString('LIMIT 50', $q['sql']);
            self::assertStringContainsString('OFFSET 100', $q['sql']);
        }
    }

    #[Test]
    public function pageSizeBoundaryRejectsZero(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        new DocumentInboxQueryOptions(pageSize: 0);
    }

    #[Test]
    public function pageSizeBoundaryRejectsNegative(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        new DocumentInboxQueryOptions(pageSize: -1);
    }

    #[Test]
    public function pageSizeBoundaryRejectsAboveMax(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        new DocumentInboxQueryOptions(pageSize: DocumentInboxQueryOptions::MAX_PAGE_SIZE + 1);
    }

    #[Test]
    public function offsetBoundaryRejectsNegative(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        new DocumentInboxQueryOptions(offset: -1);
    }

    #[Test]
    public function pageSizeBoundaryAcceptsMaxExactly(): void
    {
        $this->stubResponses = [[], []];

        $opts = new DocumentInboxQueryOptions(pageSize: DocumentInboxQueryOptions::MAX_PAGE_SIZE);
        $svc  = new DocumentInboxQueryService($this->fetcher());
        $result = $svc->listForPatient(self::PID, $opts);

        self::assertSame([], $result->active);
        self::assertSame([], $result->history);
        foreach ($this->issuedQueries as $q) {
            self::assertStringContainsString(
                'LIMIT ' . DocumentInboxQueryOptions::MAX_PAGE_SIZE,
                $q['sql'],
            );
        }
    }

    #[Test]
    public function rowsWithUnknownStatusAreFilteredOut(): void
    {
        $this->stubResponses = [
            [
                $this->row('uuid-bad', 'mystery', '2026-05-04 09:00:00'),
                $this->row('uuid-ok',  'pending', '2026-05-04 08:00:00'),
            ],
            [],
        ];

        $svc = new DocumentInboxQueryService($this->fetcher());
        $result = $svc->listForPatient(self::PID, new DocumentInboxQueryOptions());

        self::assertCount(1, $result->active);
        self::assertSame('uuid-ok', $result->active[0]->jobUuid);
    }

    #[Test]
    public function uploadedByDisplayNameFallsBackToUsernameWhenFullnameIsBlank(): void
    {
        $this->stubResponses = [
            [
                $this->row(
                    'uuid-fullname-blank',
                    'pending',
                    '2026-05-04 09:00:00',
                    fullname: '',
                    username: 'dr.smith',
                ),
            ],
            [],
        ];

        $svc = new DocumentInboxQueryService($this->fetcher());
        $result = $svc->listForPatient(self::PID, new DocumentInboxQueryOptions());

        self::assertSame('dr.smith', $result->active[0]->uploadedByDisplayName);
    }

    #[Test]
    public function bindsIncludePatientIdAndStatusValues(): void
    {
        $this->stubResponses = [[], []];

        $svc = new DocumentInboxQueryService($this->fetcher());
        $svc->listForPatient(self::PID, new DocumentInboxQueryOptions());

        // First query: active group binds (pid + 3 active statuses).
        $first = $this->issuedQueries[0];
        self::assertSame(
            [self::PID, 'pending', 'extracting', 'ready_for_review'],
            $first['binds'],
        );

        // Second query: history group binds (pid + 3 history statuses).
        $second = $this->issuedQueries[1];
        self::assertSame(
            [self::PID, 'committed', 'rejected', 'failed'],
            $second['binds'],
        );
    }

    /**
     * Build a recording row-fetcher closure. Each call records its
     * (sql, binds) pair and returns the next stubbed row list in
     * order. Tests pre-stage `stubResponses` with one entry per
     * expected query.
     *
     * @return Closure(string, list<scalar|null>): list<array<string, mixed>>
     */
    private function fetcher(): Closure
    {
        return function (string $sql, array $binds): array {
            /** @var list<scalar|null> $binds */
            $this->issuedQueries[] = ['sql' => $sql, 'binds' => $binds];
            $i = count($this->issuedQueries) - 1;
            if (!isset($this->stubResponses[$i])) {
                throw new \LogicException(
                    "DocumentInboxQueryServiceIsolatedTest: no stub response for query index {$i}",
                );
            }
            return $this->stubResponses[$i];
        };
    }

    /**
     * Build a single raw-row associative array shaped like the SELECT
     * the service emits, with sensible defaults so tests can override
     * just the columns they care about.
     *
     * @return array<string, mixed>
     */
    private function row(
        string $jobUuid,
        string $status,
        string $uploadedAt,
        int $documentId = 1234,
        ?int $extractionId = null,
        string $docType = 'lab_pdf',
        string $filename = 'labs.pdf',
        ?int $uploaderUserId = 7,
        ?string $fullname = 'Alice Provider',
        ?string $username = 'alice',
        ?string $errorMessage = null,
        ?string $editedFieldPaths = null,
    ): array {
        return [
            'job_uuid'                => $jobUuid,
            'document_id'             => $documentId,
            'patient_id'              => self::PID,
            'doc_type'                => $docType,
            'status'                  => $status,
            'error_message'           => $errorMessage,
            'uploaded_at'             => $uploadedAt,
            'filename'                => $filename,
            'uploaded_by_user_id'     => $uploaderUserId,
            'uploaded_by_username'    => $username,
            'uploaded_by_fullname'    => $fullname,
            'extraction_id'           => $extractionId,
            'edited_field_paths'      => $editedFieldPaths,
        ];
    }
}
