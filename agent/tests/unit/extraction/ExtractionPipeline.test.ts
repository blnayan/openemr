/**
 * ExtractionPipeline unit tests. Drives the pipeline with stubbed
 * collaborators (renderer, OCR service, VLM invoker, sidecar) so no
 * VLM, no Tesseract worker, no renderer, and no database is required.
 */

import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { ExtractionPipeline } from '../../../src/extraction/ExtractionPipeline.js';
import { VlmExtractor } from '../../../src/extraction/VlmExtractor.js';
import { LAB_PDF_SCHEMA_VERSION } from '../../../src/schemas/LabPdfSchema.js';
import type { OcrPage, OcrService } from '../../../src/extraction/OcrService.js';
import type {
  ExtractionFailure,
  ExtractionRequest,
  ExtractionResult,
  PageRenderer,
  RenderedPage,
  SidecarStore,
  VlmInvoker,
} from '../../../src/extraction/types.js';
import type { VlmLabPdf } from '../../../src/schemas/VlmLabPdfSchema.js';

const sampleVlmLab: VlmLabPdf = {
  doc_type: 'lab_pdf',
  schema_version: LAB_PDF_SCHEMA_VERSION,
  performing_lab: 'Quest',
  ordering_provider: 'Dr. Reyes',
  collection_date_default: '2026-04-15T08:30:00.000Z',
  patient_on_document: { name: 'Maria Reyes' },
  results: [
    {
      test_name: 'Hemoglobin A1c',
      loinc_code: '4548-4',
      numeric_value: 7.8,
      display_value: '7.8',
      unit: '%',
      reference_range: { low: null, high: 5.7, raw_text: '<5.7' },
      abnormal_flag: 'H',
      collection_date: null,
      vlm_confidence: 0.95,
      citation_confidence: 'unverifiable',
    },
  ],
  source_citation: { document_id: '42', page_count: 1 },
};

class CapturingSidecar implements SidecarStore {
  successes: ExtractionResult[] = [];
  failures: ExtractionFailure[] = [];
  async recordSuccess(r: ExtractionResult): Promise<void> { this.successes.push(r); }
  async recordFailure(f: ExtractionFailure): Promise<void> { this.failures.push(f); }
}

function makeRenderer(pages: RenderedPage[]): PageRenderer {
  return { render: async () => pages };
}

function makeInvoker(impl: (req: { userInstruction: string }) => unknown): VlmInvoker {
  return { invoke: async (req): Promise<never> => impl(req) as never };
}

class StubOcrService implements OcrService {
  constructor(private readonly pages: OcrPage[]) {}
  async recognize(): Promise<OcrPage[]> { return this.pages; }
}

function emptyOcr(page: number): OcrPage {
  return { page, imageWidth: 1000, imageHeight: 1400, lines: [], words: [] };
}

function sampleRequest(): ExtractionRequest {
  return {
    documentId: 42,
    patientId: 9,
    docType: 'lab_pdf',
    bytes: Buffer.from('fake-pdf'),
    mimeType: 'application/pdf',
  };
}

const onePage: RenderedPage = {
  page: 0, pngBytes: Buffer.from('p'),
  imageWidth: 1000, imageHeight: 1400,
  originalWidth: 1000, originalHeight: 1400,
  trimOffsetLeft: 0, trimOffsetTop: 0,
};

describe('ExtractionPipeline', () => {
  it('renders, runs OCR + VLM in parallel, locates bboxes, persists result on lab_pdf happy path', async () => {
    const renderer = makeRenderer([onePage]);
    const ocr = new StubOcrService([
      {
        page: 0, imageWidth: 1000, imageHeight: 1400,
        lines: [
          {
            page: 0, text: 'Maria Reyes',
            x: 100, y: 50, w: 200, h: 24,
            words: [
              { page: 0, text: 'Maria', x: 100, y: 50, w: 80, h: 24, lineIndex: 0, confidence: 95 },
              { page: 0, text: 'Reyes', x: 200, y: 50, w: 100, h: 24, lineIndex: 0, confidence: 95 },
            ],
          },
          {
            page: 0, text: 'Hemoglobin A1c 7.8 % <5.7 H',
            x: 50, y: 200, w: 800, h: 24,
            words: [
              { page: 0, text: 'Hemoglobin', x: 50, y: 200, w: 150, h: 24, lineIndex: 1, confidence: 95 },
              { page: 0, text: 'A1c', x: 210, y: 200, w: 60, h: 24, lineIndex: 1, confidence: 95 },
              { page: 0, text: '7.8', x: 400, y: 200, w: 60, h: 24, lineIndex: 1, confidence: 95 },
              { page: 0, text: '%', x: 470, y: 200, w: 20, h: 24, lineIndex: 1, confidence: 95 },
              { page: 0, text: '<5.7', x: 550, y: 200, w: 80, h: 24, lineIndex: 1, confidence: 95 },
              { page: 0, text: 'H', x: 700, y: 200, w: 20, h: 24, lineIndex: 1, confidence: 95 },
            ],
          },
        ],
        words: [],
      },
    ]);
    const invoker = makeInvoker(() => sampleVlmLab);
    const sidecar = new CapturingSidecar();
    const pipeline = new ExtractionPipeline(renderer, ocr, new VlmExtractor(invoker), sidecar);

    const result = await pipeline.extract(sampleRequest());

    expect(result.docType).toBe('lab_pdf');
    expect(result.schemaVersion).toBe(LAB_PDF_SCHEMA_VERSION);
    expect(result.pageCount).toBe(1);

    const stored = result.extractedJson as {
      patient_on_document: { name: string; bbox: { x: number; w: number } } | null;
      results: Array<{ bbox: { x: number; y: number; w: number } }>;
    };
    // TIGHT bbox hugs "Maria Reyes" (x=100, w spans both words).
    expect(stored.patient_on_document?.bbox.x).toBe(100);
    expect(stored.patient_on_document?.bbox.w).toBe(200);
    // ROW bbox covers the whole result line, not just "7.8".
    expect(stored.results[0]?.bbox.x).toBe(50);
    expect(stored.results[0]?.bbox.w).toBe(800);

    expect(sidecar.successes).toHaveLength(1);
    expect(sidecar.failures).toHaveLength(0);
  });

  it('embeds the document_id into the user instruction', async () => {
    const renderer = makeRenderer([onePage]);
    const ocr = new StubOcrService([emptyOcr(0)]);
    let capturedInstruction = '';
    const invoker: VlmInvoker = {
      invoke: async (req) => {
        capturedInstruction = req.userInstruction;
        return sampleVlmLab as never;
      },
    };
    const sidecar = new CapturingSidecar();
    const pipeline = new ExtractionPipeline(renderer, ocr, new VlmExtractor(invoker), sidecar);

    await pipeline.extract(sampleRequest());

    expect(capturedInstruction).toContain('"42"');
  });

  it('records a failure when the renderer returns zero pages', async () => {
    const renderer = makeRenderer([]);
    const ocr = new StubOcrService([]);
    const invoker = makeInvoker(() => sampleVlmLab);
    const sidecar = new CapturingSidecar();
    const pipeline = new ExtractionPipeline(renderer, ocr, new VlmExtractor(invoker), sidecar);

    await expect(pipeline.extract(sampleRequest())).rejects.toThrow(/zero pages/);
    expect(sidecar.failures).toHaveLength(1);
    expect(sidecar.failures[0]?.attempts).toBe(0);
    expect(sidecar.successes).toHaveLength(0);
  });

  it('records a failure when the VLM never produces valid JSON', async () => {
    const renderer = makeRenderer([onePage]);
    const ocr = new StubOcrService([emptyOcr(0)]);
    const zodErr = new ZodError([
      { code: 'invalid_type', expected: 'object', received: 'string', path: [], message: 'bad' } as never,
    ]);
    const invoker: VlmInvoker = {
      invoke: async () => { throw zodErr; },
    };
    const sidecar = new CapturingSidecar();
    const pipeline = new ExtractionPipeline(renderer, ocr, new VlmExtractor(invoker), sidecar);

    await expect(pipeline.extract(sampleRequest())).rejects.toThrow();
    expect(sidecar.failures).toHaveLength(1);
    expect(sidecar.failures[0]?.attempts).toBe(VlmExtractor.MAX_ATTEMPTS);
    expect(sidecar.successes).toHaveLength(0);
  });

  it('routes intake_form to the intake-form schema', async () => {
    const intakePayload = {
      doc_type: 'intake_form',
      schema_version: '1',
      demographics: { name: null, dob: null, sex: null, field_values: {} },
      chief_concern: null,
      current_medications: [],
      allergies: [],
      family_history: [],
      source_citation: { document_id: '42', page_count: 1 },
    };
    const renderer = makeRenderer([onePage]);
    const ocr = new StubOcrService([emptyOcr(0)]);
    const invoker = makeInvoker(() => intakePayload);
    const sidecar = new CapturingSidecar();
    const pipeline = new ExtractionPipeline(renderer, ocr, new VlmExtractor(invoker), sidecar);

    const result = await pipeline.extract({
      ...sampleRequest(), docType: 'intake_form',
    });

    expect(result.docType).toBe('intake_form');
    expect(result.schemaVersion).toBe('1');
    expect(sidecar.successes).toHaveLength(1);
  });
});
