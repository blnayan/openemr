<?php

/**
 * DocumentInboxResult — grouped projection returned by
 * {@see DocumentInboxQueryService::listForPatient()}.
 *
 * Two phase-grouped lists, in the order the inbox UI renders them
 * (PRD §History pane: "in-progress uploads above the history list when
 * any are present"):
 *
 *   - `active`  — rows in {pending, extracting, ready_for_review}.
 *                 The stepper polls these every 1.5s (PRD §State
 *                 machine and progress UI).
 *   - `history` — rows in {committed, rejected, failed}. Read-only.
 *
 * Both lists are already sorted, paginated, and filtered per the
 * provided {@see DocumentInboxQueryOptions}. The HTTP layer (issue
 * 28) maps this object to JSON 1:1.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Persistence;

final readonly class DocumentInboxResult
{
    /**
     * @param list<DocumentInboxRow> $active
     * @param list<DocumentInboxRow> $history
     */
    public function __construct(
        public array $active,
        public array $history,
    ) {
    }
}
