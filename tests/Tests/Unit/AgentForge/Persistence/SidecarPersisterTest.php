<?php

/**
 * SidecarPersister normalizePayload Unit Test
 *
 * Verifies the defensive narrowing of decoded extractor JSON to a
 * string-keyed array shape. This test stays isolated from the database
 * by exercising only the pure-logic helper.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Unit\AgentForge\Persistence;

use OpenEMR\AgentForge\Persistence\SidecarPersister;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;

final class SidecarPersisterTest extends TestCase
{
    #[Test]
    public function normalizePayloadCollapsesNullToEmptyArray(): void
    {
        self::assertSame([], (new SidecarPersister())->normalizePayload(null));
    }

    #[Test]
    public function normalizePayloadKeepsStringKeysOnly(): void
    {
        $out = (new SidecarPersister())->normalizePayload([
            'fields'  => ['a' => 1],
            0         => 'dropped',
            'results' => [],
        ]);
        self::assertSame(['fields' => ['a' => 1], 'results' => []], $out);
    }
}
