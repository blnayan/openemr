/**
 * One citation pill rendered in the chip row beneath an answer bubble.
 * Color split is driven by the chip's `kind`:
 *
 *   - clinical → solid blue, white text       (chart/rule citations)
 *   - document → solid amber, dark-ink text   (lab PDFs / intake forms)
 *
 * The chip's full citation_id is exposed via the title attribute so a
 * debugging clinician can hover to see exactly what the agent cited.
 *
 * Document chips (`facet === 'document'`) are interactive: clicking
 * opens a modal that shows the source PDF/image with the cited bbox
 * highlighted. The parent supplies an `onActivate` callback when the
 * chip references a known patient document; clinical chips remain
 * non-interactive spans.
 */

import React from 'react';

import { resolveCitationChip } from './citationChip';
import type { CitationChipKind } from './citationChip';

const CHIP_BASE =
  'inline-flex items-center py-0.5 px-1.75 rounded-3 text-xs font-medium tracking-cite whitespace-nowrap font-sans select-none';
const CHIP_STATIC = 'cursor-default';
const CHIP_INTERACTIVE = 'cursor-pointer hover:brightness-110 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue';
const CHIP_CLINICAL = 'bg-blue text-white';
const CHIP_DOCUMENT = 'bg-cite-doc text-cite-doc-ink';

interface CitationChipProps {
  /** The raw citation_id from the answer's claim list (title + fallback resolver). */
  readonly citationId: string;
  /** When the server sent an evidence-catalog label, use it instead of client heuristics. */
  readonly labelFromCatalog?: string;
  /** Evidence facet from the server (`clinical` vs `document`). */
  readonly facetFromCatalog?: CitationChipKind;
  /** Provided by AnswerBubble for document chips → renders as button + click handler. */
  readonly onActivate?: () => void;
}

export function CitationChip({
  citationId,
  labelFromCatalog,
  facetFromCatalog,
  onActivate,
}: CitationChipProps): React.JSX.Element {
  const fallback = resolveCitationChip(citationId);
  const label = labelFromCatalog ?? fallback.label;
  const kind = facetFromCatalog ?? fallback.kind;
  const palette = kind === 'document' ? CHIP_DOCUMENT : CHIP_CLINICAL;
  const interactivity = onActivate ? CHIP_INTERACTIVE : CHIP_STATIC;
  const className = `${CHIP_BASE} ${palette} ${interactivity}`;

  if (onActivate) {
    return (
      <button
        type="button"
        className={className}
        title={citationId}
        onClick={onActivate}
        data-testid="copilot-citation-chip"
      >
        {label}
      </button>
    );
  }
  return (
    <span className={className} title={citationId} data-testid="copilot-citation-chip">
      {label}
    </span>
  );
}
