/**
 * Tiny pure-function renderer for `**bold**` markdown spans.
 *
 * Issue #34 instructs the agent to wrap concrete clinical values
 * (HbA1c, LDL, BP, doses) in markdown bold so the doctor's eye lands
 * on the actionable numerics. This renderer turns those `**…**` pairs
 * into `<strong>` nodes — and ONLY those. We intentionally do NOT pull
 * in a full markdown parser (`marked`, `remark`, `markdown-it`):
 *
 *   - The agent's summaries are short prose with at most a handful of
 *     bolded numerics. A 50KB markdown lib for that is overkill.
 *   - Our SSE answer schema treats `summary` as plain text. Honoring
 *     bold but not headings/lists/links keeps the contract obvious.
 *   - Less surface area = less to sanitize. We never produce HTML
 *     strings — only React nodes — so XSS by way of `dangerouslySet*`
 *     is impossible.
 *
 * Spec covered by tests in `__tests__/markdownBold.test.tsx`:
 *
 *   no bold:                'A1c is 7.4%'      → ['A1c is 7.4%']
 *   single bold:            'A1c is **7.4%**'  → ['A1c is ', <strong>7.4%</strong>]
 *   multiple bolds:         '**A1c** is **7.4%**'
 *                                              → [<strong>A1c</strong>, ' is ', <strong>7.4%</strong>]
 *   empty bold (`****`):    'foo **** bar'     → ['foo  bar']  (collapse to nothing)
 *   unmatched `**`:         'A1c **7.4'        → ['A1c **7.4']  (literal)
 *   escaped `\*`:           '2 \\* 3 = 6'      → ['2 * 3 = 6']  (escape consumed)
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

import React, { type ReactNode } from 'react';

/**
 * Render a string with `**…**` bold spans into a list of React nodes.
 *
 * The function is pure — the same input always produces structurally
 * equal output, modulo React keys (which are deterministic indices for
 * stable reconciliation).
 *
 * Edge-case rules (chosen deliberately for v1):
 *   - Empty bold (`****`): collapse to nothing. Not a meaningful clinical
 *     value, and emitting an empty `<strong/>` would just create dead
 *     DOM nodes.
 *   - Unmatched `**`: render the markers as literal text. Aborting the
 *     parse and leaking partial `<strong>` would be worse than
 *     "harmless ugly" — the doctor still sees the words.
 *   - Backslash escape (`\*`): consumes the `\` and emits the `*` as
 *     literal. This lets the agent emit a literal "5 * 3" without it
 *     being mistaken for the start of a bold span.
 */
export function renderMarkdownBold(text: string): ReactNode[] {
  if (text === '') {
    return [];
  }

  // First pass: walk the string char by char and emit a flat list of
  // "tokens" — either text segments or pairs of `**` markers. The
  // backslash escape is handled here so the second pass never sees it.
  type Token =
    | { kind: 'text'; value: string }
    | { kind: 'marker' };
  const tokens: Token[] = [];
  let buffer = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? '';
    if (ch === '\\' && i + 1 < text.length) {
      // Escape: consume the backslash, emit the next char literally.
      buffer += text[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (ch === '*' && text[i + 1] === '*') {
      if (buffer !== '') {
        tokens.push({ kind: 'text', value: buffer });
        buffer = '';
      }
      tokens.push({ kind: 'marker' });
      i += 2;
      continue;
    }
    buffer += ch;
    i++;
  }
  if (buffer !== '') {
    tokens.push({ kind: 'text', value: buffer });
  }

  // Second pass: pair up markers. A bold span is opened by the first
  // marker and closed by the next one. If the marker count is odd, the
  // final unmatched marker becomes literal `**` text — the user still
  // gets a readable result.
  const nodes: ReactNode[] = [];
  let nodeKey = 0;
  let markerCount = countMarkers(tokens);
  // If we have an odd number of markers, walk back from the end and
  // demote the trailing one to literal text so the surviving markers
  // form complete pairs.
  if (markerCount % 2 === 1) {
    for (let j = tokens.length - 1; j >= 0; j--) {
      if (tokens[j]?.kind === 'marker') {
        tokens[j] = { kind: 'text', value: '**' };
        markerCount--;
        break;
      }
    }
  }

  let inBold = false;
  let pending = '';
  const flushText = (): void => {
    if (pending === '') return;
    if (inBold) {
      // Empty bold (`****`) — pending is empty, skip emission entirely.
      // Otherwise emit a <strong> node.
      nodes.push(React.createElement('strong', { key: `b-${nodeKey++}` }, pending));
    } else {
      nodes.push(pending);
    }
    pending = '';
  };

  for (const token of tokens) {
    if (token.kind === 'text') {
      pending += token.value;
      continue;
    }
    // marker — flush whatever we've accumulated under the current mode,
    // then flip the mode.
    flushText();
    inBold = !inBold;
  }
  // Trailing buffer, if any. By construction we end outside a bold span
  // (the odd-marker fixup demoted the last unmatched marker to text).
  flushText();

  return nodes;
}

function countMarkers(
  tokens: ReadonlyArray<{ kind: 'text'; value: string } | { kind: 'marker' }>,
): number {
  let n = 0;
  for (const t of tokens) {
    if (t.kind === 'marker') n++;
  }
  return n;
}
