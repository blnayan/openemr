<?php

/**
 * DocType — closed enum naming the two AgentForge document types the
 * Document Inbox upload entry point accepts.
 *
 * Replaces the legacy substring-match-on-category-name routing in
 * `DocumentExtractionSubscriber`. The clinician now picks the doc type
 * explicitly at upload time (see W2_DOCUMENT_INBOX_PRD §"Upload entry
 * point and listener removal"); the enum's backing string is what
 * lands on the upload-job and sidecar rows.
 *
 * Backed by string so the value persists to and round-trips from the
 * `agentforge_upload_jobs.doc_type` and
 * `agentforge_document_extractions.doc_type` columns. ConfirmCommitter
 * also keys its writer map on these strings.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Domain;

enum DocType: string
{
    case LabPdf = 'lab_pdf';
    case IntakeForm = 'intake_form';
}
