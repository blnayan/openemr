/**
 * Unit tests for SupervisorVerifier — verifies the fail-closed citation
 * resolution policy:
 *   - guideline citations: substring-checked against the named chunk body
 *   - patient_document citations: existence-checked via PatientDocumentVerifier
 *   - patient_record citations: matched against the clinical-data tool transcript
 *   - >50% drop → low-confidence refusal
 */

import { describe, it, expect } from 'vitest';
import {
  SupervisorVerifier,
  type PatientDocumentVerifier,
} from '../../../../src/graph/supervisor/Verifier.js';
import type { Answer } from '../../../../src/schemas/AnswerSchema.js';
import type { AccumulatedHandoff } from '../../../../src/graph/supervisor/types.js';

const CHUNK_BODY = 'An A1C goal of <7% (<53 mmol/mol) is appropriate for many nonpregnant adults without significant hypoglycemia.';
const ANSWER_EXTRAS = {
  conflicts: [],
  data_gaps: [],
  assumptions: [],
  evidence_catalog: [],
};

function evidence(): AccumulatedHandoff {
  return {
    worker: 'evidence_retriever',
    output: {
      worker: 'evidence_retriever',
      chunks: [{
        id: 'ada-2026-6.3a',
        source: 'ADA Standards of Care in Diabetes—2026',
        section_id: '6.3a',
        page: 100,
        body: CHUNK_BODY,
        score: 0.9,
      }],
    },
    latency_ms: 100,
  };
}

function clinical(): AccumulatedHandoff {
  return {
    worker: 'clinical_data',
    output: {
      worker: 'clinical_data',
      answer: {
        summary: 's',
        claims: [],
        ...ANSWER_EXTRAS,
        followup_suggestions: [],
        confidence: 'high',
      },
      toolResults: [{
        ok: true,
        tool: 'get_medications',
        rows: [{ id: 'tool:get_medications:row-0', drug_name: 'metformin' }],
      }],
    },
    latency_ms: 200,
  };
}

const yesPdv: PatientDocumentVerifier = { async exists() { return true; } };
const noPdv: PatientDocumentVerifier = { async exists() { return false; } };

function makeVerifier(pdv: PatientDocumentVerifier = yesPdv): SupervisorVerifier {
  return new SupervisorVerifier({ patientDocumentVerifier: pdv });
}

describe('SupervisorVerifier', () => {
  it('keeps a claim whose guideline quoted_span is a verbatim substring of the chunk body', async () => {
    const draft: Answer = {
      summary: 's',
      claims: [{
        text: 'A1C target',
        citation_ids: ['rule:guideline:ada-2026-6-3a'],
        citations: [{
          type: 'guideline',
          chunk_id: 'ada-2026-6.3a',
          source: 'ADA Standards of Care in Diabetes—2026',
          section_id: '6.3a',
          quoted_span: 'An A1C goal of <7%',
        }],
        severity: 'info',
      }],
      ...ANSWER_EXTRAS,
      followup_suggestions: [],
      confidence: 'high',
    };
    const result = await makeVerifier().verify(draft, [evidence()], 1);
    expect(result.refused).toBe(false);
    expect(result.droppedClaims).toBe(0);
    expect(result.answer.claims).toHaveLength(1);
  });

  it('drops a claim whose guideline quoted_span is not present in the chunk body', async () => {
    const draft: Answer = {
      summary: 's',
      claims: [{
        text: 'fabricated',
        citation_ids: ['rule:guideline:ada-2026-6-3a'],
        citations: [{
          type: 'guideline',
          chunk_id: 'ada-2026-6.3a',
          source: 'ADA Standards of Care in Diabetes—2026',
          section_id: '6.3a',
          quoted_span: 'something the chunk does not actually say',
        }],
        severity: 'info',
      }, {
        text: 'real',
        citation_ids: ['rule:guideline:ada-2026-6-3a'],
        citations: [{
          type: 'guideline',
          chunk_id: 'ada-2026-6.3a',
          source: 'ADA Standards of Care in Diabetes—2026',
          section_id: '6.3a',
          quoted_span: 'An A1C goal of <7%',
        }],
        severity: 'info',
      }],
      ...ANSWER_EXTRAS,
      followup_suggestions: [],
      confidence: 'high',
    };
    const result = await makeVerifier().verify(draft, [evidence()], 1);
    expect(result.refused).toBe(false);
    expect(result.droppedClaims).toBe(1);
    expect(result.answer.claims).toHaveLength(1);
    expect(result.answer.claims[0]?.text).toBe('real');
    // Confidence should drop one notch when any claim was dropped.
    expect(result.answer.confidence).toBe('medium');
  });

  it('drops a patient_document claim when no sidecar row exists', async () => {
    const draft: Answer = {
      summary: 's',
      claims: [{
        text: 'patient self-reported',
        citation_ids: ['rule:guideline:no-data'],
        citations: [{
          type: 'patient_document',
          extraction_id: 'extract-7',
          bbox: { x: 0, y: 0, w: 1, h: 1, page: 1, image_w: 1000, image_h: 1300 },
          citation_confidence: 0.9,
        }],
        severity: 'info',
      }, {
        text: 'survives',
        citation_ids: ['rule:no-data:foo'],
        severity: 'info',
      }],
      ...ANSWER_EXTRAS,
      followup_suggestions: [],
      confidence: 'high',
    };
    const result = await makeVerifier(noPdv).verify(draft, [], 1);
    expect(result.refused).toBe(false);
    expect(result.droppedClaims).toBe(1);
    expect(result.answer.claims).toHaveLength(1);
    expect(result.answer.claims[0]?.text).toBe('survives');
  });

  it('keeps a patient_record citation that matches a tool row', async () => {
    const draft: Answer = {
      summary: 's',
      claims: [{
        text: 'medication noted',
        citation_ids: ['tool:get_medications:row-0'],
        severity: 'info',
      }],
      ...ANSWER_EXTRAS,
      followup_suggestions: [],
      confidence: 'high',
    };
    const result = await makeVerifier().verify(draft, [clinical()], 1);
    expect(result.droppedClaims).toBe(0);
    expect(result.answer.claims).toHaveLength(1);
  });

  it('drops a patient_record citation when no matching tool row exists', async () => {
    const draft: Answer = {
      summary: 's',
      claims: [{
        text: 'fabricated medication',
        citation_ids: ['tool:get_medications:row-99'],
        severity: 'info',
      }, {
        text: 'real medication',
        citation_ids: ['tool:get_medications:row-0'],
        severity: 'info',
      }],
      ...ANSWER_EXTRAS,
      followup_suggestions: [],
      confidence: 'high',
    };
    const result = await makeVerifier().verify(draft, [clinical()], 1);
    expect(result.droppedClaims).toBe(1);
    expect(result.answer.claims).toHaveLength(1);
    expect(result.answer.claims[0]?.text).toBe('real medication');
  });

  it('refuses with low confidence when more than half of claims are dropped', async () => {
    const draft: Answer = {
      summary: 's',
      claims: [
        // Two bad, one good → 2/3 dropped (>50%) → refusal.
        { text: 'bad-1', citation_ids: ['tool:nope:row-0'], severity: 'info' },
        { text: 'bad-2', citation_ids: ['tool:nope:row-1'], severity: 'info' },
        { text: 'good', citation_ids: ['tool:get_medications:row-0'], severity: 'info' },
      ],
      ...ANSWER_EXTRAS,
      followup_suggestions: [],
      confidence: 'high',
    };
    const result = await makeVerifier().verify(draft, [clinical()], 1);
    expect(result.refused).toBe(true);
    expect(result.droppedClaims).toBe(2);
    expect(result.answer.confidence).toBe('low');
    expect(result.answer.claims).toHaveLength(1);
    expect(result.answer.claims[0]?.text).toContain('failed citation resolution');
  });

  it('strips doc:lab-<X> citations whose id matches no extractor or chart row', async () => {
    // The synthesizer may have hallucinated `doc:lab-99` onto a chart-only
    // lab row. With no lab-extractor and no clinical row carrying
    // source.document_id=99, the verifier should strip the bogus doc id
    // but keep the underlying tool: citation so the claim survives under
    // its original "recent labs #N" pill.
    const draft: Answer = {
      summary: 's',
      claims: [{
        text: 'A1c 7.4%',
        citation_ids: ['tool:get_medications:row-0', 'doc:lab-99'],
        severity: 'info',
      }],
      ...ANSWER_EXTRAS,
      followup_suggestions: [],
      confidence: 'high',
    };
    const result = await makeVerifier().verify(draft, [clinical()], 1);
    expect(result.refused).toBe(false);
    expect(result.droppedClaims).toBe(0);
    expect(result.answer.claims).toHaveLength(1);
    expect(result.answer.claims[0]?.citation_ids).toEqual(['tool:get_medications:row-0']);
  });

  it('keeps doc:lab-<X> when X matches the lab extractor extractionId', async () => {
    const labHandoff: AccumulatedHandoff = {
      worker: 'lab_extractor',
      output: {
        worker: 'lab_extractor',
        labPdf: null,
        extractionId: '39',
        documentId: null,
        documentName: null,
      },
      latency_ms: 100,
    };
    const draft: Answer = {
      summary: 's',
      claims: [{
        text: 'Hemoglobin A1c 8.2%',
        citation_ids: ['doc:lab-39'],
        severity: 'info',
      }],
      ...ANSWER_EXTRAS,
      followup_suggestions: [],
      confidence: 'high',
    };
    const result = await makeVerifier().verify(draft, [labHandoff], 1);
    expect(result.refused).toBe(false);
    expect(result.droppedClaims).toBe(0);
    expect(result.answer.claims[0]?.citation_ids).toEqual(['doc:lab-39']);
  });

  it('keeps doc:lab-<X> when X matches a clinical row source.document_id', async () => {
    const handoff: AccumulatedHandoff = {
      worker: 'clinical_data',
      output: {
        worker: 'clinical_data',
        answer: {
          summary: 's',
          claims: [],
          ...ANSWER_EXTRAS,
          followup_suggestions: [],
          confidence: 'high',
        },
        toolResults: [{
          ok: true,
          tool: 'get_recent_labs',
          rows: [{
            id: 'tool:get_recent_labs:row-0',
            name: 'A1c',
            value: 8.2,
            unit: '%',
            source: { kind: 'document', document_id: 39 },
          }],
        }],
      },
      latency_ms: 100,
    };
    const draft: Answer = {
      summary: 's',
      claims: [{
        text: 'A1c 8.2%',
        citation_ids: ['tool:get_recent_labs:row-0', 'doc:lab-39'],
        severity: 'info',
      }],
      ...ANSWER_EXTRAS,
      followup_suggestions: [],
      confidence: 'high',
    };
    const result = await makeVerifier().verify(draft, [handoff], 1);
    expect(result.droppedClaims).toBe(0);
    expect(result.answer.claims[0]?.citation_ids).toEqual([
      'tool:get_recent_labs:row-0',
      'doc:lab-39',
    ]);
  });

  it('keeps everything when all citations resolve', async () => {
    const draft: Answer = {
      summary: 's',
      claims: [{
        text: 'guideline-grounded',
        citation_ids: ['rule:guideline:ada-2026-6-3a'],
        citations: [{
          type: 'guideline',
          chunk_id: 'ada-2026-6.3a',
          source: 'ADA Standards of Care in Diabetes—2026',
          section_id: '6.3a',
          quoted_span: 'An A1C goal of <7%',
        }],
        severity: 'info',
      }, {
        text: 'patient-doc-grounded',
        citation_ids: ['rule:no-data:doc'],
        citations: [{
          type: 'patient_document',
          extraction_id: 'extract-7',
          bbox: { x: 0, y: 0, w: 1, h: 1, page: 1, image_w: 1000, image_h: 1300 },
          citation_confidence: 0.9,
        }],
        severity: 'info',
      }, {
        text: 'chart-grounded',
        citation_ids: ['tool:get_medications:row-0'],
        severity: 'info',
      }],
      ...ANSWER_EXTRAS,
      followup_suggestions: [],
      confidence: 'high',
    };
    const result = await makeVerifier(yesPdv).verify(draft, [evidence(), clinical()], 1);
    expect(result.refused).toBe(false);
    expect(result.droppedClaims).toBe(0);
    expect(result.answer.claims).toHaveLength(3);
    expect(result.answer.confidence).toBe('high');
  });
});
