<?php

/**
 * Isolated tests for UploadJobStatusMachine.
 *
 * Closed enum × closed transitions = a small finite matrix; this
 * suite covers every legal transition, every illegal transition
 * (which must throw a typed exception), and the terminal-state
 * property: every transition out of a terminal status throws.
 *
 * Tests run without database, container, or Docker.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\AgentForge\Domain;

use OpenEMR\AgentForge\Domain\UploadJobStatus;
use OpenEMR\AgentForge\Domain\UploadJobStatusMachine;
use OpenEMR\AgentForge\Domain\UploadJobTransition;
use OpenEMR\AgentForge\Exception\InvalidUploadJobTransitionException;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;

final class UploadJobStatusMachineIsolatedTest extends TestCase
{
    private UploadJobStatusMachine $machine;

    protected function setUp(): void
    {
        $this->machine = new UploadJobStatusMachine();
    }

    /**
     * @return iterable<string, array{UploadJobStatus, UploadJobTransition, UploadJobStatus}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function legalTransitionProvider(): iterable
    {
        yield 'Pending → Extracting via StartExtraction' => [
            UploadJobStatus::Pending,
            UploadJobTransition::StartExtraction,
            UploadJobStatus::Extracting,
        ];
        yield 'Pending → Failed via Fail' => [
            UploadJobStatus::Pending,
            UploadJobTransition::Fail,
            UploadJobStatus::Failed,
        ];
        yield 'Extracting → ReadyForReview via ExtractionSucceeded' => [
            UploadJobStatus::Extracting,
            UploadJobTransition::ExtractionSucceeded,
            UploadJobStatus::ReadyForReview,
        ];
        yield 'Extracting → Failed via Fail' => [
            UploadJobStatus::Extracting,
            UploadJobTransition::Fail,
            UploadJobStatus::Failed,
        ];
        yield 'ReadyForReview → Committed via Confirm' => [
            UploadJobStatus::ReadyForReview,
            UploadJobTransition::Confirm,
            UploadJobStatus::Committed,
        ];
        yield 'ReadyForReview → Rejected via Reject' => [
            UploadJobStatus::ReadyForReview,
            UploadJobTransition::Reject,
            UploadJobStatus::Rejected,
        ];
    }

    #[Test]
    #[DataProvider('legalTransitionProvider')]
    public function legalTransitionReturnsExpectedStatus(
        UploadJobStatus $current,
        UploadJobTransition $transition,
        UploadJobStatus $expected,
    ): void {
        self::assertSame($expected, $this->machine->next($current, $transition));
    }

    /**
     * @return iterable<string, array{UploadJobStatus, UploadJobTransition}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function illegalTransitionProvider(): iterable
    {
        // Illegal from Pending: anything except StartExtraction and Fail.
        yield 'Pending + ExtractionSucceeded' => [
            UploadJobStatus::Pending,
            UploadJobTransition::ExtractionSucceeded,
        ];
        yield 'Pending + Confirm' => [
            UploadJobStatus::Pending,
            UploadJobTransition::Confirm,
        ];
        yield 'Pending + Reject' => [
            UploadJobStatus::Pending,
            UploadJobTransition::Reject,
        ];

        // Illegal from Extracting: anything except ExtractionSucceeded and Fail.
        yield 'Extracting + StartExtraction' => [
            UploadJobStatus::Extracting,
            UploadJobTransition::StartExtraction,
        ];
        yield 'Extracting + Confirm' => [
            UploadJobStatus::Extracting,
            UploadJobTransition::Confirm,
        ];
        yield 'Extracting + Reject' => [
            UploadJobStatus::Extracting,
            UploadJobTransition::Reject,
        ];

        // Illegal from ReadyForReview: anything except Confirm and Reject.
        yield 'ReadyForReview + StartExtraction' => [
            UploadJobStatus::ReadyForReview,
            UploadJobTransition::StartExtraction,
        ];
        yield 'ReadyForReview + ExtractionSucceeded' => [
            UploadJobStatus::ReadyForReview,
            UploadJobTransition::ExtractionSucceeded,
        ];
        yield 'ReadyForReview + Fail' => [
            UploadJobStatus::ReadyForReview,
            UploadJobTransition::Fail,
        ];
    }

    #[Test]
    #[DataProvider('illegalTransitionProvider')]
    public function illegalTransitionThrowsTypedException(
        UploadJobStatus $current,
        UploadJobTransition $transition,
    ): void {
        $this->expectException(InvalidUploadJobTransitionException::class);
        $this->machine->next($current, $transition);
    }

    /**
     * Every transition out of every terminal status must throw —
     * regardless of which transition is requested. This is the
     * terminal-state property the issue calls out explicitly.
     *
     * @return iterable<string, array{UploadJobStatus, UploadJobTransition}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function terminalStateProvider(): iterable
    {
        $terminals = [UploadJobStatus::Committed, UploadJobStatus::Rejected, UploadJobStatus::Failed];
        foreach ($terminals as $terminal) {
            foreach (UploadJobTransition::cases() as $transition) {
                $key = sprintf('%s + %s rejects', $terminal->value, $transition->name);
                yield $key => [$terminal, $transition];
            }
        }
    }

    #[Test]
    #[DataProvider('terminalStateProvider')]
    public function terminalStatusRejectsEveryTransition(
        UploadJobStatus $terminal,
        UploadJobTransition $transition,
    ): void {
        self::assertTrue(
            $terminal->isTerminal(),
            'guard: provider must only yield terminal statuses',
        );
        $this->expectException(InvalidUploadJobTransitionException::class);
        $this->machine->next($terminal, $transition);
    }

    #[Test]
    public function exceptionCarriesCurrentStatusAndTransition(): void
    {
        try {
            $this->machine->next(UploadJobStatus::Committed, UploadJobTransition::Confirm);
            self::fail('expected InvalidUploadJobTransitionException');
        } catch (InvalidUploadJobTransitionException $e) {
            self::assertSame(UploadJobStatus::Committed, $e->currentStatus);
            self::assertSame(UploadJobTransition::Confirm, $e->transition);
            self::assertStringContainsString('committed', $e->getMessage());
            self::assertStringContainsString('Confirm', $e->getMessage());
        }
    }

    #[Test]
    public function isTerminalReturnsTrueOnlyForTerminalStatuses(): void
    {
        self::assertTrue(UploadJobStatus::Committed->isTerminal());
        self::assertTrue(UploadJobStatus::Rejected->isTerminal());
        self::assertTrue(UploadJobStatus::Failed->isTerminal());

        self::assertFalse(UploadJobStatus::Pending->isTerminal());
        self::assertFalse(UploadJobStatus::Extracting->isTerminal());
        self::assertFalse(UploadJobStatus::ReadyForReview->isTerminal());
    }

}
