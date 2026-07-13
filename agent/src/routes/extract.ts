/**
 * POST /extract — synchronous extraction endpoint called by the PHP
 * upload flow after the document has been persisted via DocumentService.
 *
 * Request body (JSON):
 *   {
 *     document_id: number,
 *     patient_id:  number,
 *     doc_type:    "lab_pdf" | "intake_form",
 *     mime_type:   string,
 *     bytes_base64: string,
 *   }
 *
 * Response:
 *   200 { extracted: <strict-schema JSON>, schema_version: string,
 *         page_count: number }
 *   400 { error: "invalid_body", issues: [...] }
 *   422 { error: "schema_validation_failed", attempts: number,
 *         message: string }
 *   500 { error: "internal", message: string }
 *
 * Persistence stays on the PHP side: this route's
 * ExtractionPipeline is constructed with a no-op SidecarStore. PHP
 * reads the response and writes the agentforge_document_extractions
 * row itself.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ExtractionPipeline } from '../extraction/ExtractionPipeline.js';
import { ImageAndPdfPageRenderer } from '../extraction/PageRenderer.js';
import { OpenRouterVlmInvoker } from '../extraction/OpenRouterVlmInvoker.js';
import { SchemaValidationFailed, VlmExtractor } from '../extraction/VlmExtractor.js';
import { GoogleVisionOcrService } from '../extraction/GoogleVisionOcrService.js';
import { OpenRouterBboxSelector, type LlmBboxSelector } from '../extraction/LlmBboxSelector.js';
import type { OcrService } from '../extraction/OcrService.js';
import type {
  ExtractionFailure,
  ExtractionResult,
  PageRenderer,
  SidecarStore,
  VlmInvoker,
} from '../extraction/types.js';

const ExtractRequestSchema = z.object({
  document_id: z.number().int().positive(),
  patient_id: z.number().int().positive(),
  doc_type: z.enum(['lab_pdf', 'intake_form']),
  mime_type: z.string().min(1),
  bytes_base64: z.string().min(1),
});

export interface ExtractRouteOptions {
  /** Override for tests. Defaults to ImageAndPdfPageRenderer. */
  renderer?: PageRenderer;
  /** Override for tests. Defaults to env-loaded OpenRouterVlmInvoker. */
  vlmInvoker?: VlmInvoker | null;
  /**
   * Override for tests. Defaults to GoogleVisionOcrService (env-loaded).
   * When the env-loader returns null (no API key), the pipeline runs
   * with no OCR-derived bboxes — locator emits zero-area placeholders.
   */
  ocrService?: OcrService | null;
  /**
   * Override for tests. Defaults to env-loaded OpenRouterBboxSelector.
   * When null, the locator falls back to mechanical token-overlap.
   */
  bboxSelector?: LlmBboxSelector | null;
}

class NullSidecarStore implements SidecarStore {
  async recordSuccess(_: ExtractionResult): Promise<void> { /* PHP owns this. */ }
  async recordFailure(_: ExtractionFailure): Promise<void> { /* PHP owns this. */ }
}

/**
 * No-op OCR service used when GOOGLE_VISION_API_KEY is unset. Returns
 * one empty OcrPage per rendered page so the BboxLocator can run
 * without crashing — every entity will fall back to a zero-area bbox.
 * Lets local dev / unit smoke tests proceed without a Google API key.
 */
class NoopOcrService implements OcrService {
  async recognize(pages: ReadonlyArray<import('../extraction/types.js').RenderedPage>) {
    return pages.map((p) => ({
      page: p.page,
      imageWidth: p.imageWidth,
      imageHeight: p.imageHeight,
      lines: [],
      words: [],
    }));
  }
}

export async function registerExtractRoute(
  app: FastifyInstance,
  opts: ExtractRouteOptions = {},
): Promise<void> {
  const renderer = opts.renderer ?? new ImageAndPdfPageRenderer();
  const vlmInvoker = opts.vlmInvoker !== undefined
    ? opts.vlmInvoker
    : await OpenRouterVlmInvoker.fromEnv();
  // Google Cloud Vision is the production OCR; one shared instance
  // per process. fromEnv() returns null when GOOGLE_VISION_API_KEY is
  // unset; we substitute a no-op service so the pipeline still runs
  // (the BboxLocator emits zero-area placeholders for every entity).
  const ocrService: OcrService = opts.ocrService !== undefined && opts.ocrService !== null
    ? opts.ocrService
    : (GoogleVisionOcrService.fromEnv() ?? new NoopOcrService());
  // LLM-driven bbox selector. Null when no API key — the locator
  // degrades gracefully to mechanical token-overlap.
  const bboxSelector: LlmBboxSelector | null = opts.bboxSelector !== undefined
    ? opts.bboxSelector
    : await OpenRouterBboxSelector.fromEnv();

  app.post('/extract', async (request, reply) => {
    const parsed = ExtractRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({
        error: 'invalid_body',
        issues: parsed.error.issues.map(i => ({
          path: i.path.map(String).join('.'),
          message: i.message,
        })),
      });
      return;
    }
    const body = parsed.data;

    if (vlmInvoker === null) {
      reply.code(503).send({ error: 'vlm_unavailable', message: 'OPENROUTER_API_KEY is unset' });
      return;
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.from(body.bytes_base64, 'base64');
      if (bytes.length === 0) throw new Error('empty buffer after base64 decode');
    } catch (err) {
      request.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'agentforge.extract base64 decode failed',
      );
      reply.code(400).send({ error: 'invalid_bytes' });
      return;
    }

    const pipeline = new ExtractionPipeline(
      renderer,
      ocrService,
      new VlmExtractor(vlmInvoker),
      new NullSidecarStore(),
      bboxSelector,
    );

    try {
      const result = await pipeline.extract({
        documentId: body.document_id,
        patientId: body.patient_id,
        docType: body.doc_type,
        bytes,
        mimeType: body.mime_type,
      });
      reply.code(200).send({
        extracted: result.extractedJson,
        schema_version: result.schemaVersion,
        page_count: result.pageCount,
      });
      return;
    } catch (err) {
      if (err instanceof SchemaValidationFailed) {
        reply.code(422).send({
          error: 'schema_validation_failed',
          attempts: err.attempts,
          message: err.lastIssues,
        });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      request.log.error({ err: message }, 'extraction failed');
      reply.code(500).send({ error: 'internal' });
      return;
    }
  });
}
