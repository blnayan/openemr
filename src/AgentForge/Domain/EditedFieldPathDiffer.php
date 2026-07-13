<?php

/**
 * EditedFieldPathDiffer — pure JSON-path diff between the VLM's
 * original extraction JSON and the user-edited JSON.
 *
 * The Document Inbox rework (W2_DOCUMENT_INBOX_PRD.md) persists the
 * resulting list in the new `agentforge_document_extractions
 * .edited_field_paths` column so the inbox history can filter to
 * "human-corrected only" extractions without diffing payloads.
 *
 * Pure structural diff. No I/O, no database, no schema awareness;
 * the differ does not know that `tests` is a lab row or that
 * `current_medications` is an intake list. PHI never leaves the
 * function — input maps are not logged.
 *
 * Diff semantics:
 *
 * - Two values are equal when their decoded shape is equal: same
 *   primitive value (===), same associative-array keys with equal
 *   values pairwise, same list length with equal values pairwise.
 * - For lists (numeric-indexed arrays), if the original and edited
 *   lists are permutations of one another by deep value equality,
 *   no element-level paths are emitted (the user reordered without
 *   editing). Otherwise per-index diffs are emitted.
 * - When list lengths differ, the trailing additions or removals
 *   appear as paths to the affected indices.
 * - Object-key additions and removals emit a path to the added or
 *   removed key.
 *
 * Path syntax matches the Document Inbox PRD's "JSON path list"
 * description: dotted keys with bracketed numeric indices, e.g.
 * `tests[2].value`, `current_medications[0].dose`,
 * `source_citation.document_id`.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Domain;

final class EditedFieldPathDiffer
{
    /**
     * Returns the list of dotted JSON paths into `$editedJson` whose
     * values differ from `$originalJson`. Order in the returned list
     * is deterministic: a depth-first walk of `$originalJson` keys in
     * iteration order, followed by keys present only in `$editedJson`
     * in iteration order.
     *
     * @param array<array-key, mixed> $originalJson
     * @param array<array-key, mixed> $editedJson
     * @return list<string>
     */
    public static function diff(array $originalJson, array $editedJson): array
    {
        $paths = [];
        self::walk('', $originalJson, $editedJson, $paths);
        return $paths;
    }

    /**
     * Walk two arrays in parallel, appending paths to `$paths` by
     * reference. The recursion is internal and never exposes
     * intermediate state.
     *
     * @param array<array-key, mixed> $original
     * @param array<array-key, mixed> $edited
     * @param list<string> $paths
     */
    private static function walk(string $prefix, array $original, array $edited, array &$paths): void
    {
        if (self::isList($original) && self::isList($edited)) {
            self::walkList($prefix, $original, $edited, $paths);
            return;
        }

        // Treat as associative map. Keys present in $original first
        // (in iteration order), then keys only in $edited. This gives
        // a deterministic order that mirrors the original document's
        // shape.
        foreach ($original as $key => $originalValue) {
            $childPath = self::appendKey($prefix, (string) $key);
            if (!array_key_exists($key, $edited)) {
                $paths[] = $childPath;
                continue;
            }
            self::compareValues($childPath, $originalValue, $edited[$key], $paths);
        }
        foreach ($edited as $key => $editedValue) {
            if (array_key_exists($key, $original)) {
                continue;
            }
            $paths[] = self::appendKey($prefix, (string) $key);
        }
    }

    /**
     * @param list<mixed> $original
     * @param list<mixed> $edited
     * @param list<string> $paths
     */
    private static function walkList(string $prefix, array $original, array $edited, array &$paths): void
    {
        if (self::listsAreReorderingsByValue($original, $edited)) {
            return;
        }

        $sharedLength = min(count($original), count($edited));
        for ($i = 0; $i < $sharedLength; $i++) {
            $childPath = $prefix . '[' . $i . ']';
            self::compareValues($childPath, $original[$i], $edited[$i], $paths);
        }

        // Trailing insertions or deletions surface as paths to the
        // affected indices on whichever side carries them.
        if (count($edited) > count($original)) {
            for ($i = $sharedLength; $i < count($edited); $i++) {
                $paths[] = $prefix . '[' . $i . ']';
            }
        } elseif (count($original) > count($edited)) {
            for ($i = $sharedLength; $i < count($original); $i++) {
                $paths[] = $prefix . '[' . $i . ']';
            }
        }
    }

    /**
     * @param list<string> $paths
     */
    private static function compareValues(string $path, mixed $originalValue, mixed $editedValue, array &$paths): void
    {
        $originalIsArray = is_array($originalValue);
        $editedIsArray = is_array($editedValue);

        if ($originalIsArray && $editedIsArray) {
            self::walk($path, $originalValue, $editedValue, $paths);
            return;
        }

        if ($originalIsArray !== $editedIsArray) {
            // Type mismatch (array vs scalar). The whole subtree is
            // considered changed; emit one path at this level rather
            // than synthesizing fake child paths.
            $paths[] = $path;
            return;
        }

        if (!self::scalarsEqual($originalValue, $editedValue)) {
            $paths[] = $path;
        }
    }

    /**
     * Strict scalar equality: same type, same value. `null === null`
     * is treated as equal; `0 !== false`; `"1" !== 1`.
     */
    private static function scalarsEqual(mixed $a, mixed $b): bool
    {
        return $a === $b;
    }

    /**
     * Two lists are "reorderings of each other" when their multisets
     * of values are equal under deep compare. Used to suppress false
     * positives when a reviewer drags rows but does not edit values.
     *
     * @param list<mixed> $a
     * @param list<mixed> $b
     */
    private static function listsAreReorderingsByValue(array $a, array $b): bool
    {
        if (count($a) !== count($b)) {
            return false;
        }
        if (count($a) === 0) {
            // Both empty — equal by definition; no reordering needed.
            return true;
        }
        $matched = array_fill(0, count($b), false);
        foreach ($a as $av) {
            $foundIndex = -1;
            foreach ($b as $j => $bv) {
                if ($matched[$j]) {
                    continue;
                }
                if (self::deepEqual($av, $bv)) {
                    $foundIndex = $j;
                    break;
                }
            }
            if ($foundIndex === -1) {
                return false;
            }
            $matched[$foundIndex] = true;
        }
        return true;
    }

    /**
     * Deep equality for arbitrary JSON-decoded values. Used by the
     * list-reordering check; the rest of the differ uses this only
     * via `scalarsEqual` for non-array leaves.
     */
    private static function deepEqual(mixed $a, mixed $b): bool
    {
        if (is_array($a) && is_array($b)) {
            if (self::isList($a) !== self::isList($b)) {
                return false;
            }
            if (count($a) !== count($b)) {
                return false;
            }
            if (self::isList($a)) {
                // Lists compare positionally for deep-equal.
                foreach ($a as $i => $av) {
                    if (!self::deepEqual($av, $b[$i])) {
                        return false;
                    }
                }
                return true;
            }
            foreach ($a as $key => $av) {
                if (!array_key_exists($key, $b)) {
                    return false;
                }
                if (!self::deepEqual($av, $b[$key])) {
                    return false;
                }
            }
            return true;
        }
        if (is_array($a) || is_array($b)) {
            return false;
        }
        return $a === $b;
    }

    /**
     * @param array<array-key, mixed> $value
     * @phpstan-assert-if-true list<mixed> $value
     */
    private static function isList(array $value): bool
    {
        return array_is_list($value);
    }

    /**
     * Append a string key to the path. Keys that are not safe
     * unquoted identifiers (alnum + underscore) are emitted with
     * bracket-quote syntax so the path remains parseable. Numeric
     * keys on associative arrays are also emitted as bracketed
     * identifiers to avoid collision with list-index syntax.
     */
    private static function appendKey(string $prefix, string $key): string
    {
        $safe = preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $key) === 1;
        if ($prefix === '') {
            return $safe ? $key : '["' . self::escapeKey($key) . '"]';
        }
        return $safe ? $prefix . '.' . $key : $prefix . '["' . self::escapeKey($key) . '"]';
    }

    private static function escapeKey(string $key): string
    {
        return str_replace(['\\', '"'], ['\\\\', '\\"'], $key);
    }
}
