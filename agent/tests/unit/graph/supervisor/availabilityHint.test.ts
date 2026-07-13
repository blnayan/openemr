/**
 * Unit tests for buildAvailabilityHint — verifies the hint builder
 * collects patient documents, guideline corpora, and reachability
 * info from its injected dependencies, and degrades safely when
 * any of those throws.
 */

import { describe, it, expect } from 'vitest';
import {
  buildAvailabilityHint,
  renderHintForPrompt,
  type AvailabilityHintDeps,
  type SidecarSummaryReader,
  type ClinicalDataReachabilityProbe,
  type GuidelineCorpusRegistry,
} from '../../../../src/graph/supervisor/availabilityHint.js';
import type {
  PatientDocumentSummary,
  GuidelineCorpusSummary,
} from '../../../../src/graph/supervisor/types.js';

const STUB_CORPUS: GuidelineCorpusSummary = {
  source: 'ADA Standards of Care in Diabetes—2026',
  version: '2026',
  chunk_count: 515,
};

function makeDeps(overrides: Partial<{
  docs: readonly PatientDocumentSummary[] | Error;
  reachable: boolean | Error;
  corpora: readonly GuidelineCorpusSummary[];
}>): AvailabilityHintDeps {
  const sidecarSummaryReader: SidecarSummaryReader = {
    async listForPatient(): Promise<readonly PatientDocumentSummary[]> {
      if (overrides.docs instanceof Error) throw overrides.docs;
      return overrides.docs ?? [];
    },
  };
  const clinicalDataProbe: ClinicalDataReachabilityProbe = {
    async isReachable(): Promise<boolean> {
      if (overrides.reachable instanceof Error) throw overrides.reachable;
      return overrides.reachable ?? true;
    },
  };
  const corpusRegistry: GuidelineCorpusRegistry = {
    list: () => overrides.corpora ?? [STUB_CORPUS],
  };
  return { sidecarSummaryReader, clinicalDataProbe, corpusRegistry };
}

describe('buildAvailabilityHint', () => {
  it('aggregates documents, corpora, and the reachability flag', async () => {
    const docs: PatientDocumentSummary[] = [
      { extraction_id: '7', doc_type: 'intake_form', patient_match_status: 'verified', created_at: '2026-05-01T10:00:00Z' },
      { extraction_id: '8', doc_type: 'lab_pdf', patient_match_status: 'unverifiable', created_at: '2026-05-02T10:00:00Z' },
    ];
    const hint = await buildAvailabilityHint(42, makeDeps({ docs, reachable: true }));
    expect(hint.patientDocuments).toEqual(docs);
    expect(hint.clinicalDataReachable).toBe(true);
    expect(hint.guidelineCorpora).toEqual([STUB_CORPUS]);
  });

  it('degrades to empty docs when the sidecar reader throws', async () => {
    const hint = await buildAvailabilityHint(42, makeDeps({
      docs: new Error('db offline'),
      reachable: true,
    }));
    expect(hint.patientDocuments).toEqual([]);
    expect(hint.clinicalDataReachable).toBe(true);
  });

  it('degrades to clinical_data_reachable=false when the probe throws', async () => {
    const hint = await buildAvailabilityHint(42, makeDeps({
      docs: [],
      reachable: new Error('fhir down'),
    }));
    expect(hint.clinicalDataReachable).toBe(false);
  });
});

describe('renderHintForPrompt', () => {
  it('renders all sections with patient_match_status visible', () => {
    const hint = {
      patientDocuments: [{
        extraction_id: '7',
        doc_type: 'intake_form' as const,
        patient_match_status: 'verified' as const,
        created_at: '2026-05-01T10:00:00Z',
      }],
      guidelineCorpora: [STUB_CORPUS],
      clinicalDataReachable: true,
    };
    const out = renderHintForPrompt(hint);
    expect(out).toContain('extraction_id=7');
    expect(out).toContain('match=verified');
    expect(out).toContain('ADA Standards of Care in Diabetes—2026');
    expect(out).toContain('515 chunks');
    expect(out).toContain('clinical_data_reachable: yes');
  });

  it('renders "(none)" when no documents', () => {
    const hint = {
      patientDocuments: [],
      guidelineCorpora: [STUB_CORPUS],
      clinicalDataReachable: false,
    };
    const out = renderHintForPrompt(hint);
    expect(out).toContain('patient_documents (0):');
    expect(out).toContain('(none)');
    expect(out).toContain('clinical_data_reachable: no');
  });
});
