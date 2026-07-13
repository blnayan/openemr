<?php

/**
 * Isolated ChatRequest DTO Test
 *
 * Tests ChatRequest::fromJson() parsing and validation without database or session.
 *
 * Plan reference: §5.1, §3.1 (ChatRequest contract), M1
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Test Generator
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\AgentForge\DTO;

use InvalidArgumentException;
use OpenEMR\AgentForge\DTO\ChatRequest;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;

#[CoversClass(ChatRequest::class)]
final class ChatRequestIsolatedTest extends TestCase
{
    #[Test]
    public function happyPathWithNullConversationId(): void
    {
        // §3.1: "null → new conversation"
        $request = ChatRequest::fromJson('{"question":"What are her labs?","conversation_id":null,"encounter_id":17}');

        self::assertSame('What are her labs?', $request->question);
        self::assertNull($request->conversationId);
        self::assertSame(17, $request->encounterId);
    }

    #[Test]
    public function happyPathWithExistingConversationId(): void
    {
        $conversationId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
        $request = ChatRequest::fromJson(sprintf(
            '{"question":"Any new labs?","conversation_id":"%s","encounter_id":42}',
            $conversationId
        ));

        self::assertSame($conversationId, $request->conversationId);
        self::assertSame(42, $request->encounterId);
    }

    #[Test]
    public function dashboardMountAcceptsNullEncounterId(): void
    {
        // D5 (post-pivot): the agent mounts on the patient dashboard between
        // rooms, where there is no active encounter. encounter_id is therefore
        // optional in the request body. patient_uuid (from JWT) stays mandatory.
        $request = ChatRequest::fromJson('{"question":"What changed since last visit?","conversation_id":null,"encounter_id":null}');

        self::assertSame('What changed since last visit?', $request->question);
        self::assertNull($request->encounterId);
    }

    #[Test]
    public function dashboardMountAcceptsOmittedEncounterIdField(): void
    {
        // The dashboard partial may omit encounter_id entirely instead of
        // sending null. Both shapes must be accepted.
        $request = ChatRequest::fromJson('{"question":"Hello","conversation_id":null}');

        self::assertNull($request->encounterId);
    }

    #[Test]
    public function emptyQuestionThrowsInvalidArgumentException(): void
    {
        // §3.1: "non-empty, ≤ 4000 chars"
        $this->expectException(InvalidArgumentException::class);
        $this->expectExceptionMessageMatches('/question/i');

        ChatRequest::fromJson('{"question":"","conversation_id":null,"encounter_id":17}');
    }

    #[Test]
    public function questionExceeding4000CharsThrowsInvalidArgumentException(): void
    {
        // §3.1: question must be ≤ 4000 chars
        $oversizedQuestion = str_repeat('a', 4001);
        $this->expectException(InvalidArgumentException::class);
        $this->expectExceptionMessageMatches('/question|4000/i');

        ChatRequest::fromJson(json_encode([
            'question' => $oversizedQuestion,
            'conversation_id' => null,
            'encounter_id' => 17,
        ]));
    }

    #[Test]
    public function exactly4000CharQuestionIsAccepted(): void
    {
        $maxQuestion = str_repeat('q', 4000);
        $request = ChatRequest::fromJson(json_encode([
            'question' => $maxQuestion,
            'conversation_id' => null,
            'encounter_id' => 17,
        ]));

        self::assertSame(4000, strlen($request->question));
    }

    #[Test]
    public function zeroEncounterIdThrowsInvalidArgumentException(): void
    {
        // §3.1: "when present, encounter_id must be > 0"
        // (null/missing is fine — that's the dashboard mount case.)
        $this->expectException(InvalidArgumentException::class);
        $this->expectExceptionMessageMatches('/encounter_id|encounter/i');

        ChatRequest::fromJson('{"question":"Hello","conversation_id":null,"encounter_id":0}');
    }

    #[Test]
    public function negativeEncounterIdThrowsInvalidArgumentException(): void
    {
        $this->expectException(InvalidArgumentException::class);

        ChatRequest::fromJson('{"question":"Hello","conversation_id":null,"encounter_id":-5}');
    }

    #[Test]
    public function malformedJsonThrowsInvalidArgumentException(): void
    {
        $this->expectException(InvalidArgumentException::class);

        ChatRequest::fromJson('{not-valid-json}');
    }

    #[Test]
    public function missingQuestionFieldThrowsInvalidArgumentException(): void
    {
        $this->expectException(InvalidArgumentException::class);

        ChatRequest::fromJson('{"conversation_id":null,"encounter_id":17}');
    }

    // (missingEncounterIdFieldThrowsInvalidArgumentException was removed when
    // the agent mount moved from the encounter screen to the patient dashboard.
    // Dashboard chats have no encounter_id; see dashboardMountAccepts*.)

    #[Test]
    public function chatRequestIsReadonly(): void
    {
        // §4.4: "readonly on DTOs"
        $request = ChatRequest::fromJson('{"question":"Hello","conversation_id":null,"encounter_id":17}');

        // Reflection check: all public properties are readonly
        $reflection = new \ReflectionClass($request);
        foreach ($reflection->getProperties(\ReflectionProperty::IS_PUBLIC) as $property) {
            self::assertTrue(
                $property->isReadOnly(),
                "Property {$property->getName()} must be readonly on ChatRequest"
            );
        }
    }

    /**
     * @return array<string, array{string}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function invalidJsonProvider(): array
    {
        return [
            'empty string'             => [''],
            'null literal'             => ['null'],
            'array root'               => ['[]'],
            'missing all fields'       => ['{}'],
            'non-string question'      => ['{"question":123,"conversation_id":null,"encounter_id":1}'],
            'non-integer encounter_id' => ['{"question":"hi","conversation_id":null,"encounter_id":"abc"}'],
            // null is fine (dashboard); a non-numeric string is still rejected.
        ];
    }

    #[DataProvider('invalidJsonProvider')]
    #[Test]
    public function fromJsonRejectsInvalidInput(string $json): void
    {
        $this->expectException(InvalidArgumentException::class);

        ChatRequest::fromJson($json);
    }
}
