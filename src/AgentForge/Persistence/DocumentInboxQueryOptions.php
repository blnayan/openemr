<?php

/**
 * DocumentInboxQueryOptions — typed input for
 * {@see DocumentInboxQueryService::listForPatient()}.
 *
 * Parses raw HTTP query-string scalars into typed values at the
 * boundary so the rest of the query path operates on enums and
 * bounded ints. Construction throws when any value is out of contract.
 *
 * Defaults (PRD §History pane and issue 27 acceptance):
 *   - default page size 25,
 *   - default sort uploaded-at descending,
 *   - no status / provenance filter (return both groups in full).
 *
 * Pagination is offset-based here; the HTTP layer (issue 28) is free
 * to translate a cursor token into an offset before constructing this
 * value object — issue 27 leaves either approach acceptable, and
 * offset is cheaper to test exhaustively (no opaque token state).
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Persistence;

use OpenEMR\AgentForge\Domain\UploadJobProvenance;
use OpenEMR\AgentForge\Domain\UploadJobStatus;

final readonly class DocumentInboxQueryOptions
{
    public const DEFAULT_PAGE_SIZE = 25;
    public const MAX_PAGE_SIZE = 200;

    public function __construct(
        public int $pageSize = self::DEFAULT_PAGE_SIZE,
        public int $offset = 0,
        public ?UploadJobStatus $statusFilter = null,
        public ?UploadJobProvenance $provenanceFilter = null,
    ) {
        if ($pageSize <= 0) {
            throw new \InvalidArgumentException(
                'DocumentInboxQueryOptions: pageSize must be positive'
            );
        }
        if ($pageSize > self::MAX_PAGE_SIZE) {
            throw new \InvalidArgumentException(
                'DocumentInboxQueryOptions: pageSize exceeds MAX_PAGE_SIZE'
            );
        }
        if ($offset < 0) {
            throw new \InvalidArgumentException(
                'DocumentInboxQueryOptions: offset must be non-negative'
            );
        }
    }
}
