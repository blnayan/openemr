<?php

/**
 * UploadJobProvenance — closed enum encoding whether an extraction was
 * reviewed/edited by a human before commit.
 *
 * Computed by {@see \OpenEMR\AgentForge\Persistence\DocumentInboxQueryService}
 * from the `edited_field_paths` sidecar column landed by migration
 * `20260506130001`:
 *
 *   - `HumanCorrected` when `edited_field_paths` is non-null and the
 *     decoded JSON list has at least one entry — i.e. the reviewer
 *     changed at least one field away from the VLM's output.
 *   - `VlmOnly` otherwise — including the case where the row was
 *     committed verbatim (NULL or `[]`) and the case where the row has
 *     not yet reached a terminal state.
 *
 * The Document Inbox history pane renders this as a per-row provenance
 * badge (PRD user stories 19, 20). The same flag drives the
 * `provenance=human_corrected` filter chip the auditor uses to narrow
 * the table to extractions that needed intervention.
 *
 * The backing string values are the on-the-wire representation served
 * to the inbox React surface — they must remain stable across releases.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Domain;

enum UploadJobProvenance: string
{
    case VlmOnly = 'vlm_only';
    case HumanCorrected = 'human_corrected';
}
