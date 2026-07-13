<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Http;

final readonly class ExtractionRequest
{
    public function __construct(
        public int $documentId,
        public int $patientId,
        public string $docType,
        public string $mimeType,
        public string $bytes,
        public string $jwt,
    ) {
    }
}
