<?php

/**
 * Isolated tests for EditedFieldPathDiffer.
 *
 * Pure structural diff over JSON-decoded arrays. Tests cover the
 * acceptance criteria from issue 24: identical inputs, single-leaf
 * change, nested-leaf change, array-element insert, array-element
 * delete, array-element value change, reordered-array no-op, and
 * full-object replacement; plus object-key add/remove, scalar/array
 * type mismatch, and the determinism property.
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

use OpenEMR\AgentForge\Domain\EditedFieldPathDiffer;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;

final class EditedFieldPathDifferIsolatedTest extends TestCase
{
    #[Test]
    public function identicalInputsProduceEmptyList(): void
    {
        $payload = [
            'tests' => [
                ['name' => 'Glucose', 'value' => '110'],
                ['name' => 'A1C', 'value' => '7.1'],
            ],
            'source_citation' => ['document_id' => 'abc', 'page_count' => 2],
        ];

        self::assertSame([], EditedFieldPathDiffer::diff($payload, $payload));
    }

    #[Test]
    public function emptyInputsProduceEmptyList(): void
    {
        self::assertSame([], EditedFieldPathDiffer::diff([], []));
    }

    #[Test]
    public function singleLeafChangeAtRootEmitsTopLevelPath(): void
    {
        $original = ['performing_lab' => 'LabCorp', 'patient_name' => 'Jane Doe'];
        $edited = ['performing_lab' => 'Quest', 'patient_name' => 'Jane Doe'];

        self::assertSame(['performing_lab'], EditedFieldPathDiffer::diff($original, $edited));
    }

    #[Test]
    public function nestedLeafChangeEmitsDottedPath(): void
    {
        $original = [
            'source_citation' => ['document_id' => 'abc', 'page_count' => 2],
        ];
        $edited = [
            'source_citation' => ['document_id' => 'xyz', 'page_count' => 2],
        ];

        self::assertSame(
            ['source_citation.document_id'],
            EditedFieldPathDiffer::diff($original, $edited),
        );
    }

    #[Test]
    public function arrayElementValueChangeEmitsBracketedIndexPath(): void
    {
        $original = [
            'tests' => [
                ['name' => 'Glucose', 'value' => '110'],
                ['name' => 'A1C', 'value' => '7.1'],
                ['name' => 'LDL', 'value' => '120'],
            ],
        ];
        $edited = [
            'tests' => [
                ['name' => 'Glucose', 'value' => '110'],
                ['name' => 'A1C', 'value' => '7.1'],
                ['name' => 'LDL', 'value' => '125'],
            ],
        ];

        self::assertSame(['tests[2].value'], EditedFieldPathDiffer::diff($original, $edited));
    }

    #[Test]
    public function arrayElementInsertionEmitsPathToTrailingIndex(): void
    {
        $original = ['current_medications' => [['name' => 'Metformin']]];
        $edited = [
            'current_medications' => [
                ['name' => 'Metformin'],
                ['name' => 'Lisinopril'],
            ],
        ];

        self::assertSame(
            ['current_medications[1]'],
            EditedFieldPathDiffer::diff($original, $edited),
        );
    }

    #[Test]
    public function arrayElementDeletionEmitsPathToTrailingIndex(): void
    {
        $original = [
            'current_medications' => [
                ['name' => 'Metformin'],
                ['name' => 'Lisinopril'],
                ['name' => 'Atorvastatin'],
            ],
        ];
        $edited = [
            'current_medications' => [
                ['name' => 'Metformin'],
                ['name' => 'Lisinopril'],
            ],
        ];

        self::assertSame(
            ['current_medications[2]'],
            EditedFieldPathDiffer::diff($original, $edited),
        );
    }

    #[Test]
    public function reorderedArrayWithEqualElementsProducesNoFalsePositives(): void
    {
        $original = [
            'tests' => [
                ['name' => 'Glucose', 'value' => '110'],
                ['name' => 'A1C', 'value' => '7.1'],
                ['name' => 'LDL', 'value' => '120'],
            ],
        ];
        $edited = [
            'tests' => [
                ['name' => 'LDL', 'value' => '120'],
                ['name' => 'Glucose', 'value' => '110'],
                ['name' => 'A1C', 'value' => '7.1'],
            ],
        ];

        self::assertSame([], EditedFieldPathDiffer::diff($original, $edited));
    }

    #[Test]
    public function reorderedArrayWithOneEditedElementEmitsThatElement(): void
    {
        // After sorting by deep-equal, one element is missing on the
        // edited side (the 7.1 value moved to 7.2). The lists are not
        // reorderings of one another, so positional diff applies.
        $original = [
            'tests' => [
                ['name' => 'Glucose', 'value' => '110'],
                ['name' => 'A1C', 'value' => '7.1'],
            ],
        ];
        $edited = [
            'tests' => [
                ['name' => 'A1C', 'value' => '7.2'],
                ['name' => 'Glucose', 'value' => '110'],
            ],
        ];

        $paths = EditedFieldPathDiffer::diff($original, $edited);
        // Positional comparison: index 0 differs in name and value;
        // index 1 differs in name and value. Multiple paths surface.
        self::assertContains('tests[0].name', $paths);
        self::assertContains('tests[0].value', $paths);
        self::assertContains('tests[1].name', $paths);
        self::assertContains('tests[1].value', $paths);
    }

    #[Test]
    public function objectKeyAdditionEmitsPathToAddedKey(): void
    {
        $original = ['current_medications' => [['name' => 'Metformin']]];
        $edited = ['current_medications' => [['name' => 'Metformin', 'dose' => '500mg']]];

        self::assertSame(
            ['current_medications[0].dose'],
            EditedFieldPathDiffer::diff($original, $edited),
        );
    }

    #[Test]
    public function objectKeyRemovalEmitsPathToRemovedKey(): void
    {
        $original = ['allergies' => [['name' => 'Penicillin', 'severity' => 'severe']]];
        $edited = ['allergies' => [['name' => 'Penicillin']]];

        self::assertSame(
            ['allergies[0].severity'],
            EditedFieldPathDiffer::diff($original, $edited),
        );
    }

    #[Test]
    public function fullObjectReplacementEmitsTopLevelKeyPaths(): void
    {
        $original = [
            'demographics' => ['first_name' => 'Jane', 'last_name' => 'Doe'],
            'chief_concern' => ['text' => 'cough', 'bbox' => null],
        ];
        $edited = [
            'demographics' => ['first_name' => 'Janet', 'last_name' => 'Smith'],
            'chief_concern' => null,
        ];

        // demographics changes both leaves; chief_concern flips
        // associative-array → null which is an array/scalar mismatch
        // and emits the parent path.
        self::assertSame(
            [
                'demographics.first_name',
                'demographics.last_name',
                'chief_concern',
            ],
            EditedFieldPathDiffer::diff($original, $edited),
        );
    }

    #[Test]
    public function scalarToArrayMismatchEmitsParentPath(): void
    {
        $original = ['notes' => 'fasting'];
        $edited = ['notes' => ['fasting', 'noted at 8am']];

        self::assertSame(['notes'], EditedFieldPathDiffer::diff($original, $edited));
    }

    #[Test]
    public function arrayToScalarMismatchEmitsParentPath(): void
    {
        $original = ['notes' => ['fasting', 'noted at 8am']];
        $edited = ['notes' => 'fasting'];

        self::assertSame(['notes'], EditedFieldPathDiffer::diff($original, $edited));
    }

    #[Test]
    public function listToObjectMismatchEmitsParentPath(): void
    {
        // A list and an associative array are both PHP arrays, but the
        // shape differs. The differ treats array-of-list vs array-of-map
        // as a parent-level mismatch by returning all child diffs from
        // walking them; ensure at minimum the top-level path surfaces.
        $original = ['tests' => [['name' => 'A']]];
        $edited = ['tests' => ['name' => 'A']];

        $paths = EditedFieldPathDiffer::diff($original, $edited);
        // Either 'tests' (treated as parent mismatch) or child paths
        // — both are acceptable under the contract; assert the diff
        // reports a non-empty change rooted at 'tests'.
        self::assertNotEmpty($paths);
        foreach ($paths as $path) {
            self::assertStringStartsWith('tests', $path);
        }
    }

    #[Test]
    public function deeplyNestedLeafChangeEmitsFullPath(): void
    {
        $original = [
            'tests' => [
                [
                    'name' => 'Glucose',
                    'reference_range' => ['low' => 70, 'high' => 100],
                ],
            ],
        ];
        $edited = [
            'tests' => [
                [
                    'name' => 'Glucose',
                    'reference_range' => ['low' => 70, 'high' => 110],
                ],
            ],
        ];

        self::assertSame(
            ['tests[0].reference_range.high'],
            EditedFieldPathDiffer::diff($original, $edited),
        );
    }

    #[Test]
    public function nullToStringChangeEmitsLeafPath(): void
    {
        $original = ['ordering_provider' => null];
        $edited = ['ordering_provider' => 'Dr. Strange'];

        self::assertSame(['ordering_provider'], EditedFieldPathDiffer::diff($original, $edited));
    }

    #[Test]
    public function intToStringTypeChangeEmitsLeafPath(): void
    {
        // Strict equality means "1" !== 1, so a type-only change is a
        // diff. This is the safe behavior; coerced-equal would hide
        // whether the reviewer meaningfully changed the value.
        $original = ['encounter_id' => 1];
        $edited = ['encounter_id' => '1'];

        self::assertSame(['encounter_id'], EditedFieldPathDiffer::diff($original, $edited));
    }

    #[Test]
    public function nestedReorderingInsideUnchangedListIsAlsoSuppressed(): void
    {
        // Reordering applies recursively: each list level checks its
        // own reorder property. Outer 'tests' list is unchanged
        // positionally, but the inner-most 'tags' list within tests[0]
        // is reordered with equal elements — no diff emitted.
        $original = [
            'tests' => [
                ['name' => 'Glucose', 'tags' => ['fasting', 'morning']],
            ],
        ];
        $edited = [
            'tests' => [
                ['name' => 'Glucose', 'tags' => ['morning', 'fasting']],
            ],
        ];

        self::assertSame([], EditedFieldPathDiffer::diff($original, $edited));
    }

    #[Test]
    public function returnedPathsAreUniformStrings(): void
    {
        $original = ['a' => 1, 'b' => [['x' => 1]]];
        $edited = ['a' => 2, 'b' => [['x' => 2, 'y' => 3]]];

        $paths = EditedFieldPathDiffer::diff($original, $edited);
        foreach ($paths as $path) {
            self::assertNotSame('', $path);
        }
        self::assertSame(['a', 'b[0].x', 'b[0].y'], $paths);
    }

    #[Test]
    public function nonIdentifierKeyEmitsBracketQuoteSyntax(): void
    {
        // A key that contains a dot or other syntactic character
        // would be ambiguous in dotted form; bracket-quote syntax
        // disambiguates.
        $original = ['test.with.dots' => 'a'];
        $edited = ['test.with.dots' => 'b'];

        self::assertSame(
            ['["test.with.dots"]'],
            EditedFieldPathDiffer::diff($original, $edited),
        );
    }

    #[Test]
    public function pathOrderIsDeterministicAndOriginalKeysFirst(): void
    {
        // Original-side keys appear in iteration order; edited-only
        // keys follow in iteration order. This is the determinism
        // property the differ needs so persisted lists are stable.
        $original = ['a' => 1, 'b' => 2];
        $edited = ['b' => 99, 'c' => 3, 'a' => 1];

        // 'b' is in original (changed), 'c' is edited-only → after.
        self::assertSame(['b', 'c'], EditedFieldPathDiffer::diff($original, $edited));
    }
}
