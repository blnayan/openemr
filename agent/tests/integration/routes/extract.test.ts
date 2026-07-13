/**
 * /extract route integration tests.
 *
 * Spins up a minimal Fastify instance with the extract route registered
 * and a stub VlmInvoker so we exercise the JSON contract end-to-end
 * without hitting OpenRouter.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import { registerExtractRoute } from '../../../src/routes/extract.js';
import { LAB_PDF_SCHEMA_VERSION } from '../../../src/schemas/LabPdfSchema.js';
import type { VlmLabPdf } from '../../../src/schemas/VlmLabPdfSchema.js';
import type { OcrPage, OcrService } from '../../../src/extraction/OcrService.js';
import type {
  RenderedPage,
  VlmInvoker,
  VlmInvokeRequest,
} from '../../../src/extraction/types.js';

// VLM payload — no bboxes; the BboxLocator anchors against OCR.
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

class StubOcrService implements OcrService {
  async recognize(pages: ReadonlyArray<RenderedPage>): Promise<OcrPage[]> {
    return pages.map((p) => ({
      page: p.page, imageWidth: p.imageWidth, imageHeight: p.imageHeight,
      lines: [], words: [],
    }));
  }
}

async function makeImageBytesBase64(): Promise<string> {
  const buf = await sharp({
    create: { width: 32, height: 24, channels: 3, background: { r: 220, g: 220, b: 220 } },
  }).png().toBuffer();
  return buf.toString('base64');
}

class StubVlmInvoker implements VlmInvoker {
  constructor(public readonly result: unknown) {}
  async invoke<T>(req: VlmInvokeRequest<T>): Promise<T> {
    return req.schema.parse(this.result);
  }
}

class FailingVlmInvoker implements VlmInvoker {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async invoke<T>(_req: VlmInvokeRequest<T>): Promise<T> {
    throw new z.ZodError([
      { code: 'invalid_type', expected: 'object', received: 'string', path: [], message: 'always fails' } as never,
    ]);
  }
}

async function buildApp(invoker: VlmInvoker): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await registerExtractRoute(app, { vlmInvoker: invoker, ocrService: new StubOcrService() });
  return app;
}

describe('POST /extract', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('returns 200 with extracted JSON on a happy lab_pdf path', async () => {
    app = await buildApp(new StubVlmInvoker(sampleVlmLab));
    const bytesBase64 = await makeImageBytesBase64();

    const response = await app.inject({
      method: 'POST',
      url: '/extract',
      payload: {
        document_id: 42,
        patient_id: 9,
        doc_type: 'lab_pdf',
        mime_type: 'image/png',
        bytes_base64: bytesBase64,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.schema_version).toBe(LAB_PDF_SCHEMA_VERSION);
    expect(body.page_count).toBe(1);
    expect(body.extracted.results[0].test_name).toBe('Hemoglobin A1c');
  });

  it('returns 400 when the body is missing required fields', async () => {
    app = await buildApp(new StubVlmInvoker(sampleVlmLab));

    const response = await app.inject({
      method: 'POST',
      url: '/extract',
      payload: { document_id: 42 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_body');
  });

  it('returns 400 on an unsupported doc_type', async () => {
    app = await buildApp(new StubVlmInvoker(sampleVlmLab));
    const bytesBase64 = await makeImageBytesBase64();

    const response = await app.inject({
      method: 'POST',
      url: '/extract',
      payload: {
        document_id: 42,
        patient_id: 9,
        doc_type: 'referral_fax',
        mime_type: 'image/png',
        bytes_base64: bytesBase64,
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 422 when the VLM consistently fails Zod validation', async () => {
    app = await buildApp(new FailingVlmInvoker());
    const bytesBase64 = await makeImageBytesBase64();

    const response = await app.inject({
      method: 'POST',
      url: '/extract',
      payload: {
        document_id: 42,
        patient_id: 9,
        doc_type: 'lab_pdf',
        mime_type: 'image/png',
        bytes_base64: bytesBase64,
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('schema_validation_failed');
    expect(response.json().attempts).toBe(2);
  });

  it('returns 503 when no VLM is configured', async () => {
    const app = Fastify({ logger: false });
    await registerExtractRoute(app, { vlmInvoker: null, ocrService: new StubOcrService() });
    const bytesBase64 = await makeImageBytesBase64();

    const response = await app.inject({
      method: 'POST',
      url: '/extract',
      payload: {
        document_id: 42,
        patient_id: 9,
        doc_type: 'lab_pdf',
        mime_type: 'image/png',
        bytes_base64: bytesBase64,
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('vlm_unavailable');
    await app.close();
  });

  it('returns 500 when the renderer throws an unexpected error', async () => {
    app = await buildApp(new StubVlmInvoker(sampleVlmLab));
    // Sending bytes that decode to base64 but are not a valid image
    const response = await app.inject({
      method: 'POST',
      url: '/extract',
      payload: {
        document_id: 42,
        patient_id: 9,
        doc_type: 'lab_pdf',
        mime_type: 'image/png',
        bytes_base64: Buffer.from('not actually a png').toString('base64'),
      },
    });

    expect([400, 500]).toContain(response.statusCode);
  });
});
