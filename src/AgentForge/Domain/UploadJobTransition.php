<?php

/**
 * UploadJobTransition — closed enum naming every event that can advance
 * an UploadJobStatus.
 *
 * The Document Inbox rework treats the upload-job state machine as a
 * (status × transition) → status function. Modeling the transition as
 * its own closed enum (rather than as a free-form string) means PHPStan
 * level 10 catches typos at the call site, and `match` in
 * UploadJobStatusMachine::next() is exhaustive.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Domain;

enum UploadJobTransition
{
    /** Pending → Extracting: the dispatcher has begun the VLM call. */
    case StartExtraction;

    /** Extracting → ReadyForReview: extraction succeeded; awaiting human review. */
    case ExtractionSucceeded;

    /** Pending|Extracting → Failed: extraction or upload validation errored. */
    case Fail;

    /** ReadyForReview → Committed: clinician confirmed; FHIR write-through occurred. */
    case Confirm;

    /** ReadyForReview → Rejected: clinician rejected the whole document. */
    case Reject;
}
