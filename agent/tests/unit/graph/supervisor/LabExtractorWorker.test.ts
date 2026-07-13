/**
 * LabExtractorWorker unit tests — mirrors IntakeExtractorWorker tests.
 *
 * Exercises the three control-flow paths:
 *   1. Sidecar returns null  → worker returns { labPdf: null, extractionId: null }
 *   2. Sidecar returns a row that validates against LabPdfSchema → worker
 *      returns the parsed payload + extractionId
 *   3. Sidecar returns a row that fails LabPdfSchema → worker throws
 *      LabExtractorError so the supervisor can refuse rather than
 *      silently fabricate
 */

import { describe, it, expect } from 'vitest';
import { LabExtractorWorker, LabExtractorError } from '../../../../src/graph/supervisor/LabExtractorWorker.js';
import type { SidecarReader } from '../../../../src/graph/supervisor/types.js';

const VALID_LAB_PAYLOAD = {
  doc_type: 'lab_pdf',
  schema_version: '1',
  performing_lab: 'PACIFIC DIAGNOSTICS LAB',
  ordering_provider: 'RAO, ANJALI MD',
  collection_date_default: '2026-04-22T07:42:00-07:00',
  patient_on_document: {
    name: 'CHEN, MARGARET',
    bbox: { page: 0, x: 209, y: 251, w: 131, h: 11, image_w: 1000, image_h: 1000 },
  },
  results: [
    {
      test_name: 'Cholesterol, Total',
      loinc_code: null,
      numeric_value: 232,
      display_value: '232',
      unit: 'mg/dL',
      reference_range: { low: null, high: 200, raw_text: 'Desirable <200' },
      abnormal_flag: 'H' as const,
      collection_date: null,
      bbox: { page: 0, x: 388, y: 446, w: 30, h: 13, image_w: 1000, image_h: 1000 },
      vlm_confidence: 1,
      citation_confidence: 'unverifiable' as const,
    },
  ],
  source_citation: { document_id: 'PDX-26041815', page_count: 1 },
};

type SidecarRow = {
  extractionId: string;
  extractedJson: unknown;
  documentId: number | null;
  documentName: string | null;
};

function makeReader(row: SidecarRow | null): SidecarReader {
  return { readLatest: async () => row };
}

describe('LabExtractorWorker', () => {
  it('returns null shape when no sidecar row exists for the patient', async () => {
    const worker = new LabExtractorWorker(makeReader(null));
    const out = await worker.run({ pid: 1 });
    expect(out).toEqual({
      worker: 'lab_extractor',
      labPdf: null,
      extractionId: null,
      documentId: null,
      documentName: null,
    });
  });

  it('returns the parsed lab payload + extractionId on a schema-valid row', async () => {
    const worker = new LabExtractorWorker(makeReader({
      extractionId: 'extract-449',
      extractedJson: VALID_LAB_PAYLOAD,
      documentId: 530,
      documentName: 'p01-chen-lipid-panel.pdf',
    }));
    const out = await worker.run({ pid: 1 });
    expect(out.worker).toBe('lab_extractor');
    expect(out.extractionId).toBe('extract-449');
    expect(out.documentId).toBe(530);
    expect(out.documentName).toBe('p01-chen-lipid-panel.pdf');
    expect(out.labPdf?.doc_type).toBe('lab_pdf');
    expect(out.labPdf?.results).toHaveLength(1);
    expect(out.labPdf?.results[0]?.test_name).toBe('Cholesterol, Total');
    expect(out.labPdf?.patient_on_document?.name).toBe('CHEN, MARGARET');
  });

  it('throws LabExtractorError when the sidecar row fails LabPdfSchema', async () => {
    // Missing required `doc_type` literal — schema rejects.
    const corrupt = { ...VALID_LAB_PAYLOAD, doc_type: 'not_a_lab_pdf' };
    const worker = new LabExtractorWorker(makeReader({
      extractionId: 'extract-449',
      extractedJson: corrupt,
      documentId: 530,
      documentName: 'p01-chen-lipid-panel.pdf',
    }));
    await expect(worker.run({ pid: 1 })).rejects.toThrow(LabExtractorError);
  });

  it('forwards the patient pid to the sidecar reader', async () => {
    let seen: { pid: number; docType: string } | null = null;
    const worker = new LabExtractorWorker({
      async readLatest(input) {
        seen = input;
        return null;
      },
    });
    await worker.run({ pid: 42 });
    expect(seen).toEqual({ pid: 42, docType: 'lab_pdf' });
  });
});
