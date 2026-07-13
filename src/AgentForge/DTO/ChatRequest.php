<?php

/**
 * ChatRequest — readonly DTO parsed from the JSON POST body of
 * /interface/agentforge/chat. Validates field shape at the system
 * boundary so the rest of the controller works with typed values.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\DTO;

use InvalidArgumentException;

final readonly class ChatRequest
{
    public const MAX_QUESTION_LENGTH = 4000;
    public const MODE_PREVISIT = 'previsit';
    public const MODE_FOLLOWUP = 'followup';

    public function __construct(
        public string $question,
        public ?string $conversationId,
        public ?int $encounterId,
        public ?string $mode = null,
    ) {
    }

    /**
     * Parse the POST body JSON.
     *
     * @throws InvalidArgumentException on validation failure
     */
    public static function fromJson(string $json): self
    {
        $decoded = json_decode($json, true);
        if (!is_array($decoded)) {
            throw new InvalidArgumentException('Request body is not a JSON object');
        }

        if (!array_key_exists('question', $decoded)) {
            throw new InvalidArgumentException('Missing required field: question');
        }
        $question = $decoded['question'];
        if (!is_string($question)) {
            throw new InvalidArgumentException('question must be a string');
        }
        if ($question === '') {
            throw new InvalidArgumentException('question must not be empty');
        }
        if (strlen($question) > self::MAX_QUESTION_LENGTH) {
            throw new InvalidArgumentException(
                'question exceeds maximum of ' . self::MAX_QUESTION_LENGTH . ' characters'
            );
        }

        $conversationId = null;
        if (array_key_exists('conversation_id', $decoded) && $decoded['conversation_id'] !== null) {
            if (!is_string($decoded['conversation_id'])) {
                throw new InvalidArgumentException('conversation_id must be a string or null');
            }
            $conversationId = $decoded['conversation_id'];
        }

        $encounterId = null;
        if (array_key_exists('encounter_id', $decoded) && $decoded['encounter_id'] !== null) {
            if (!is_int($decoded['encounter_id'])) {
                throw new InvalidArgumentException('encounter_id must be an integer or null');
            }
            if ($decoded['encounter_id'] <= 0) {
                throw new InvalidArgumentException('encounter_id must be > 0 when present');
            }
            $encounterId = $decoded['encounter_id'];
        }

        $mode = null;
        if (array_key_exists('mode', $decoded) && $decoded['mode'] !== null) {
            if (!is_string($decoded['mode']) || !in_array($decoded['mode'], [self::MODE_PREVISIT, self::MODE_FOLLOWUP], true)) {
                throw new InvalidArgumentException('mode must be "previsit" or "followup"');
            }
            $mode = $decoded['mode'];
        }

        return new self($question, $conversationId, $encounterId, $mode);
    }
}
