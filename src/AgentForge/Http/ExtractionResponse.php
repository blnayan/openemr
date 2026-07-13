<?php

/**
 * ExtractionResponse — typed result of an /extract call.
 * Discriminated by `kind` so callers can switch on success vs failure
 * without inspecting fields.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Http;

final readonly class ExtractionResponse
{
    public const KIND_SUCCESS = 'success';
    public const KIND_FAILURE = 'failure';

    /**
     * @param array<mixed>|null $extracted
     */
    private function __construct(
        public string $kind,
        public ?array $extracted,
        public ?string $schemaVersion,
        public ?int $pageCount,
        public ?int $statusCode,
        public ?string $errorCode,
        public ?string $message,
        public ?int $attempts,
    ) {
    }

    /**
     * @param array<mixed> $extracted
     */
    public static function success(array $extracted, string $schemaVersion, int $pageCount): self
    {
        return new self(
            kind:          self::KIND_SUCCESS,
            extracted:     $extracted,
            schemaVersion: $schemaVersion,
            pageCount:     $pageCount,
            statusCode:    null,
            errorCode:     null,
            message:       null,
            attempts:      null,
        );
    }

    public static function failure(int $statusCode, string $errorCode, string $message, ?int $attempts): self
    {
        return new self(
            kind:          self::KIND_FAILURE,
            extracted:     null,
            schemaVersion: null,
            pageCount:     null,
            statusCode:    $statusCode,
            errorCode:     $errorCode,
            message:       $message,
            attempts:      $attempts,
        );
    }

    public function isSuccess(): bool
    {
        return $this->kind === self::KIND_SUCCESS;
    }
}
