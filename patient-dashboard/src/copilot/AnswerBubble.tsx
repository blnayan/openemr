/**
 * Left-aligned answer: narrative summary + per-claim supporting points with
 * scoped evidence chips (catalog-backed when available).
 *
 * Spec (W2 PRD §"Co-Pilot dock"): summary bubble styling; markdown-bold
 * clinical numerics via `renderMarkdownBold`.
 */

import React, { useState } from 'react';

import { readBootstrapConfigSafe } from '../auth/useAuth';
import { CitationChip } from './CitationChip';
import { dedupeCitationIds } from './citationChip';
import { DocumentCitationModal } from './DocumentCitationModal';
import { renderMarkdownBold } from './markdownBold';
import type {
  ChatAnswer,
  CitationBbox,
  ClaimEvent,
  EvidenceCatalogEntryWire,
} from './answerSchema';

interface AnswerBubbleProps {
  readonly answer: ChatAnswer;
  readonly isStreaming?: boolean;
}

const CLAIMS_HEADING = 'Supporting points';
const CONFLICTS_HEADING = 'Conflicts to reconcile';
const DATA_GAPS_HEADING = 'Data gaps';
const ASSUMPTIONS_HEADING = 'Assumptions';
const SEV_URGENT =
  'border-l-2 border-severe pl-2';
const SEV_ATTENTION =
  'border-l-2 border-amber-500 pl-2';
const SEV_INFO =
  'border-l border-border-soft pl-2';

function severityClass(s: ClaimEvent['severity']): string {
  if (s === 'urgent') return SEV_URGENT;
  if (s === 'attention') return SEV_ATTENTION;
  return SEV_INFO;
}

function severityBadgeClass(s: ClaimEvent['severity']): string {
  if (s === 'urgent')
    return 'text-severe font-semibold uppercase text-[10px] tracking-wide';
  if (s === 'attention')
    return 'text-amber-700 font-semibold uppercase text-[10px] tracking-wide';
  return 'text-ink-muted font-medium uppercase text-[10px] tracking-wide';
}

function chipPropsForRef(
  evId: string,
  catalog: ChatAnswer['evidence_catalog'],
  legacyFromClaim: readonly string[],
): {
  citationId: string;
  label?: string;
  facet?: 'clinical' | 'document';
  entry?: EvidenceCatalogEntryWire;
} {
  const entry: EvidenceCatalogEntryWire | undefined = catalog[evId];
  if (entry) {
    return {
      citationId: entry.legacy_pointer,
      label: entry.label,
      facet: entry.facet === 'document' ? 'document' : 'clinical',
      entry,
    };
  }
  const guess = legacyFromClaim.find(Boolean);
  return { citationId: guess ?? evId };
}

interface ModalTarget {
  readonly documentId: number;
  readonly documentName: string | null;
  readonly docKind: 'lab' | 'intake';
  readonly bbox: CitationBbox | null;
}

export function AnswerBubble({
  answer,
  isStreaming = false,
}: AnswerBubbleProps): React.JSX.Element {
  const isPlaceholder = answer.summary === '' && isStreaming;
  const summaryNodes = isPlaceholder
    ? ['Thinking…']
    : renderMarkdownBold(answer.summary);

  const showConfidenceFooter =
    !isStreaming
    && (answer.summary !== '' || answer.claims.length > 0);

  // Modal owns its open state at the bubble level (not per-chip), so
  // clicking a different chip in the same answer just retargets — no
  // close-then-reopen flicker. The bootstrap config carries the OpenEMR
  // numeric pid and webroot the document-bytes URL needs.
  const [modalTarget, setModalTarget] = useState<ModalTarget | null>(null);
  const bootstrap = readBootstrapConfigSafe();

  return (
    <div
      className="flex flex-col items-start gap-2"
      data-testid="copilot-answer-row"
    >
      <div
        className="max-w-[92%] bg-bg-answer border border-border-soft rounded-4 py-2 px-2.75 text-xs leading-normal text-ink break-words [overflow-wrap:anywhere] whitespace-pre-wrap"
        data-testid="copilot-answer-bubble"
      >
        {summaryNodes}
      </div>

      {showConfidenceFooter && (
        <div
          className="text-[10px] text-ink-muted font-medium"
          data-testid="copilot-confidence-line"
        >
          {`Confidence: ${answer.confidence}`}
        </div>
      )}

      {answer.claims.length > 0 && (
        <div className="flex flex-col gap-1.5 w-full max-w-[92%]">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
            {CLAIMS_HEADING}
          </div>
          <ul className="list-none m-0 p-0 flex flex-col gap-2" data-testid="copilot-claim-list">
            {answer.claims.map((claim, idx) => {
              const refs = claim.evidence_refs?.length
                ? claim.evidence_refs
                : [];
              const citationIds = dedupeCitationIds(claim.citation_ids);

              return (
                <li
                  key={`claim-${idx}-${claim.text.slice(0, 24)}`}
                  className={`rounded-3 bg-bg-rail/60 py-1.5 px-2 text-xs text-ink ${severityClass(claim.severity)}`}
                  data-testid="copilot-claim-block"
                >
                  {claim.section !== undefined && (
                    <div className="text-[10px] text-ink-muted font-mono mb-0.5">
                      {answer.section_labels[claim.section] ?? claim.section}
                    </div>
                  )}
                  <div className="flex flex-wrap items-baseline gap-1.5 mb-1">
                    <span className={severityBadgeClass(claim.severity)}>
                      {claim.severity}
                    </span>
                    <span className="leading-normal break-words [overflow-wrap:anywhere]">
                      {claim.text}
                    </span>
                  </div>
                  {claim.finding_confidence !== undefined && (
                    <div className="text-[10px] text-ink-muted mb-1">
                      {`finding confidence: ${claim.finding_confidence}`}
                    </div>
                  )}
                  {claim.uncertainty_reason !== undefined && claim.uncertainty_reason.trim() !== '' && (
                    <div className="text-[10px] text-ink-muted mb-1">
                      {`uncertainty: ${claim.uncertainty_reason}`}
                    </div>
                  )}
                  {(refs.length > 0 || citationIds.length > 0) && (
                    <div
                      className="flex flex-wrap gap-1"
                      data-testid="copilot-citation-row"
                    >
                      {refs.length > 0
                        ? refs.map((evId, i) => {
                            const { citationId, label, facet, entry } = chipPropsForRef(
                              evId,
                              answer.evidence_catalog,
                              citationIds,
                            );
                            const onActivate = entry && entry.kind === 'patient_document'
                              ? () => setModalTarget({
                                  documentId: entry.document_id,
                                  documentName: extractDocName(entry.label, entry.doc_kind),
                                  docKind: entry.doc_kind,
                                  bbox: claim.citation_bboxes?.[citationId] ?? null,
                                })
                              : undefined;
                            return (
                              <CitationChip
                                key={`c${idx}-e${i}`}
                                citationId={citationId}
                                {...(label !== undefined ? { labelFromCatalog: label } : {})}
                                {...(facet !== undefined ? { facetFromCatalog: facet } : {})}
                                {...(onActivate ? { onActivate } : {})}
                              />
                            );
                          })
                        : citationIds.map((citationId, i) => (
                            <CitationChip
                              key={`c${idx}-k${i}`}
                              citationId={citationId}
                            />
                          ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {answer.conflicts.length > 0 && (
        <div className="flex flex-col gap-1.5 w-full max-w-[92%]" data-testid="copilot-conflict-list">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
            {CONFLICTS_HEADING}
          </div>
          <ul className="list-none m-0 p-0 flex flex-col gap-1.5">
            {answer.conflicts.map((c, idx) => (
              <li key={`conf-${idx}`} className={`rounded-3 bg-bg-rail/70 py-1.5 px-2 text-xs text-ink ${severityClass(c.severity)}`}>
                <div className="font-medium">{c.message}</div>
                <div className="text-[10px] text-ink-muted mt-0.5">{c.type}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {answer.data_gaps.length > 0 && (
        <div className="flex flex-col gap-1.5 w-full max-w-[92%]" data-testid="copilot-data-gap-list">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
            {DATA_GAPS_HEADING}
          </div>
          <ul className="list-none m-0 p-0 flex flex-col gap-1.5">
            {answer.data_gaps.map((gap, idx) => (
              <li key={`gap-${idx}`} className={`rounded-3 bg-bg-rail/70 py-1.5 px-2 text-xs text-ink ${severityClass(gap.severity)}`}>
                <div className="font-medium">{gap.message}</div>
                {Array.isArray(gap.blocks) && gap.blocks.length > 0 && (
                  <div className="text-[10px] text-ink-muted mt-0.5">
                    {`blocks: ${gap.blocks.join(', ')}`}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {answer.assumptions.length > 0 && (
        <div className="flex flex-col gap-1.5 w-full max-w-[92%]" data-testid="copilot-assumption-list">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
            {ASSUMPTIONS_HEADING}
          </div>
          <ul className="list-none m-0 p-0 flex flex-col gap-1.5">
            {answer.assumptions.map((a, idx) => (
              <li key={`assume-${idx}`} className="rounded-3 bg-bg-rail/60 py-1.5 px-2 text-xs text-ink">
                {a.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {modalTarget && bootstrap && typeof bootstrap.pid === 'string' && (
        <DocumentCitationModal
          open
          onClose={() => setModalTarget(null)}
          pid={bootstrap.pid}
          webroot={bootstrap.webroot ?? ''}
          documentId={modalTarget.documentId}
          documentName={modalTarget.documentName}
          docKind={modalTarget.docKind}
          bbox={modalTarget.bbox}
        />
      )}
    </div>
  );
}

/**
 * Pull the source-document filename out of the catalog entry's label.
 * The catalog formats the label as `Lab · <name> · #<id>` (after the
 * sidecar resolver landed) or `Lab · Lab document · #<id>` when the
 * name was unavailable; this helper recovers the middle slice so the
 * modal title shows the actual filename instead of the generic prefix.
 */
function extractDocName(label: string, kind: 'lab' | 'intake'): string | null {
  // Expected shape: "<Prefix> · <hint> · #<id>"
  const parts = label.split(' · ');
  if (parts.length >= 2) {
    const candidate = parts[1]?.trim() ?? '';
    const generic = kind === 'lab' ? 'Lab document' : 'Intake form';
    if (candidate !== '' && candidate !== generic) return candidate;
  }
  return null;
}
