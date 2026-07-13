/**
 * Table-driven tests for the `**bold**` markdown renderer.
 *
 * The renderer is the entire surface for issue #34's "bold key values"
 * story — if it mishandles an edge case, the doctor either misses a
 * bolded numeric or sees a partially-rendered bubble. Each row in the
 * table here corresponds to one of the documented edge cases in
 * `markdownBold.ts`'s docblock.
 */

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';

import { renderMarkdownBold } from '../../src/copilot/markdownBold';

interface Case {
  readonly label: string;
  readonly input: string;
  /** Expected rendered HTML inside the host span. */
  readonly expectedHtml: string;
}

const CASES: ReadonlyArray<Case> = [
  {
    label: 'empty string',
    input: '',
    expectedHtml: '',
  },
  {
    label: 'no bold',
    input: 'A1c is 7.4%',
    expectedHtml: 'A1c is 7.4%',
  },
  {
    label: 'single bold span',
    input: 'A1c is **7.4%**',
    expectedHtml: 'A1c is <strong>7.4%</strong>',
  },
  {
    label: 'leading bold span',
    input: '**HbA1c 7.4%** above goal',
    expectedHtml: '<strong>HbA1c 7.4%</strong> above goal',
  },
  {
    label: 'multiple bold spans',
    input: '**A1c** is **7.4%**',
    expectedHtml: '<strong>A1c</strong> is <strong>7.4%</strong>',
  },
  {
    label: 'three bolds with text between',
    input: '**BP 138/86**, **LDL 158 mg/dL**, **A1c 7.4%**',
    expectedHtml:
      '<strong>BP 138/86</strong>, <strong>LDL 158 mg/dL</strong>, <strong>A1c 7.4%</strong>',
  },
  {
    label: 'empty bold (****) collapses to nothing',
    input: 'foo **** bar',
    expectedHtml: 'foo  bar',
  },
  {
    label: 'unmatched trailing ** renders literally',
    input: 'A1c **7.4',
    expectedHtml: 'A1c **7.4',
  },
  {
    label: 'unmatched leading ** renders literally',
    input: '**A1c is 7.4',
    expectedHtml: '**A1c is 7.4',
  },
  {
    label: 'three markers — first pair bolds, third is literal',
    input: 'a **b** c **d',
    expectedHtml: 'a <strong>b</strong> c **d',
  },
  {
    label: 'escaped \\* renders as literal *',
    input: '2 \\* 3 = 6',
    expectedHtml: '2 * 3 = 6',
  },
  {
    label: 'escaped \\* prevents bold span from opening',
    input: 'A1c \\*\\*7.4%\\*\\*',
    expectedHtml: 'A1c **7.4%**',
  },
  {
    label: 'escape preserves bold elsewhere',
    input: '2 \\* 3 and **A1c 7.4%**',
    expectedHtml: '2 * 3 and <strong>A1c 7.4%</strong>',
  },
];

describe('renderMarkdownBold', () => {
  for (const c of CASES) {
    it(c.label, () => {
      const nodes = renderMarkdownBold(c.input);
      const { container } = render(
        // Wrap in a host element so we can read `innerHTML` on the
        // single span and compare against the expected literal HTML.
        React.createElement('span', { 'data-testid': 'host' }, ...nodes),
      );
      const host = container.firstElementChild;
      expect(host).not.toBeNull();
      expect(host?.innerHTML).toBe(c.expectedHtml);
    });
  }

  it('empty input returns []', () => {
    expect(renderMarkdownBold('')).toEqual([]);
  });

  it('returns React nodes (not raw HTML strings)', () => {
    const nodes = renderMarkdownBold('A1c is **7.4%**');
    // Two nodes: text segment + a <strong> ReactElement.
    expect(nodes.length).toBe(2);
    expect(nodes[0]).toBe('A1c is ');
    const strong = nodes[1] as React.ReactElement<{ children?: React.ReactNode }>;
    expect(React.isValidElement(strong)).toBe(true);
    expect(strong.type).toBe('strong');
    expect(strong.props.children).toBe('7.4%');
  });
});
