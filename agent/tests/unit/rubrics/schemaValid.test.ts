/**
 * schemaValid rubric tests — verify pass/fail behaviour on hand-crafted
 * Answer/LabPdf/IntakeForm payloads. These exercise the rubric directly,
 * with no promptfoo runtime.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs rubric is intentionally untyped for evals harness
import schemaValid from '../../../evals/rubrics/schemaValid.js';

const VALID_ANSWER = {
  summary: 'Patient is on metformin and lisinopril.',
  claims: [
    {
      text: 'Active medications include metformin 1000 mg twice daily.',
      citation_ids: ['tool:get_medications:row-1'],
      severity: 'info',
    },
  ],
  followup_suggestions: [],
  confidence: 'high',
} as const;

describe('schemaValid rubric — AnswerSchema', () => {
  it('passes for a valid AnswerSchema payload', async () => {
    const result = await schemaValid(VALID_ANSWER, {});
    expect(result.pass).toBe(true);
    expect(result.score).toBe(1);
  });

  it('fails when summary is missing', async () => {
    const bad = { ...VALID_ANSWER };
    // @ts-expect-error — intentional
    delete bad.summary;
    const result = await schemaValid(bad, {});
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/AnswerSchema invalid/);
  });

  it('fails for malformed citation type', async () => {
    const bad = {
      ...VALID_ANSWER,
      claims: [
        {
          text: 'Bad claim',
          citation_ids: ['not-a-valid-format'],
          severity: 'info',
        },
      ],
    };
    const result = await schemaValid(bad, {});
    expect(result.pass).toBe(false);
  });

  it('parses Answer from a JSON string output', async () => {
    const result = await schemaValid(JSON.stringify(VALID_ANSWER), {});
    expect(result.pass).toBe(true);
  });

  it('fails when output cannot be parsed into an Answer', async () => {
    const result = await schemaValid('not json', {});
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/no Answer-shaped payload/);
  });
});

describe('schemaValid rubric — LabPdfSchema', () => {
  const BBOX = { page: 1, x: 10, y: 10, w: 50, h: 20, image_w: 800, image_h: 1000 };
  const VALID_LAB = {
    doc_type: 'lab_pdf',
    schema_version: '1',
    performing_lab: 'Quest Diagnostics',
    ordering_provider: 'Dr. Smith',
    collection_date_default: '2026-01-15T00:00:00Z',
    patient_on_document: { name: 'Jane Doe', bbox: BBOX },
    results: [],
    source_citation: { document_id: 'doc-1', page_count: 1 },
  };

  it('passes for a valid lab_pdf payload', async () => {
    const result = await schemaValid(VALID_LAB, {});
    expect(result.pass).toBe(true);
  });

  it('fails when doc_type=lab_pdf but schema is malformed', async () => {
    const bad = { ...VALID_LAB, schema_version: '99' };
    const result = await schemaValid(bad, {});
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/LabPdfSchema invalid/);
  });
});
