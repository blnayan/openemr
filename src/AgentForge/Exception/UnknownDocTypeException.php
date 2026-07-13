<?php

/**
 * UnknownDocTypeException — thrown by ConfirmCommitter when the
 * upload-job carries a `doc_type` that has no registered writer in the
 * writer-by-doc-type map.
 *
 * In practice this is a deployment/configuration error (a new doc type
 * was introduced without updating the writer map) rather than a
 * recoverable state, but it is modeled as a typed domain exception so
 * the HTTP layer can surface it consistently.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Exception;

use DomainException;

final class UnknownDocTypeException extends DomainException
{
    public function __construct(public readonly string $docType)
    {
        parent::__construct(sprintf('No writer registered for doc_type "%s"', $docType));
    }
}
