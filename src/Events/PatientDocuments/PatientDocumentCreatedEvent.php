<?php

/**
 * PatientDocumentCreatedEvent — fires after Document::createDocument has
 * persisted the row, written its bytes to storage, and linked it to a
 * category. Subscribers can react to a successful local upload (e.g. to
 * trigger downstream extraction pipelines) without touching the upload
 * codepath.
 *
 * Carries the raw uploaded bytes base64-encoded so subscribers don't
 * have to re-read from disk and race the legacy tmp-file cleanup.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Events\PatientDocuments;

use Symfony\Contracts\EventDispatcher\Event;

final class PatientDocumentCreatedEvent extends Event
{
    public const EVENT_NAME = 'patient.document.created';

    public function __construct(
        private readonly int $documentId,
        private readonly int $patientId,
        private readonly ?int $categoryId,
        private readonly string $mimeType,
        private readonly string $filename,
        private readonly int $sizeBytes,
        private readonly string $bytesBase64,
    ) {
    }

    public function getDocumentId(): int
    {
        return $this->documentId;
    }

    public function getPatientId(): int
    {
        return $this->patientId;
    }

    public function getCategoryId(): ?int
    {
        return $this->categoryId;
    }

    public function getMimeType(): string
    {
        return $this->mimeType;
    }

    public function getFilename(): string
    {
        return $this->filename;
    }

    public function getSizeBytes(): int
    {
        return $this->sizeBytes;
    }

    public function getBytesBase64(): string
    {
        return $this->bytesBase64;
    }
}
