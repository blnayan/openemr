<?php

/**
 * UploadValidationReason — closed enum naming each rejection case at the
 * Document Inbox upload boundary.
 *
 * Backing values are the wire identifiers the inbox UI displays via the
 * stepper's reject card. Adding a case requires a corresponding `match`
 * branch in {@see UploadController}, which PHPStan verifies because none
 * of those `match` blocks have a `default`.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Controller;

enum UploadValidationReason: string
{
    case InvalidPatient = 'invalid_patient';
    case InvalidDocType = 'invalid_doc_type';
    case UnsupportedMimeType = 'unsupported_mime_type';
    case OversizedPayload = 'oversized_payload';
    case EmptyPayload = 'empty_payload';
}
