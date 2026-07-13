/**
 * ExtractionPipeline — orchestrates the OCR-anchored document extraction
 * flow end-to-end. Single public entry: `extract(request)`.
 *
 * Pipeline:
 *   1. Render the upload bytes to one or more page PNGs (PageRenderer).
 *   2. In parallel:
 *        a. Run Tesseract OCR over each rendered page (OcrService).
 *        b. Ask the VLM to extract structured text per the doc_type's
 *           VLM-only schema (VlmExtractor) — no bboxes are requested.
 *   3. Hand both results to the BboxLocator, which anchors each
 *      extracted value against the OCR words it came from. Names use
 *      a TIGHT bbox; lab/intake table rows use a ROW-level bbox.
 *   4. Persist the final stored-shape JSON to the sidecar; on failure
 *      record a failure row so the upload-jobs SSE observer can surface
 *      the error.
 *
 * The VLM no longer emits coordinates, so the old aspect-ratio
 * reconciliation lives in the BboxLocator (trim-undo only — no aspect
 * divergence is possible when the locator runs on the same pixel grid
 * as the OCR engine that produced the boxes).
 *
 * Every collaborator is injected (PageRenderer, OcrService, VlmExtractor
 * via the VlmInvoker passed to it, SidecarStore) so the pipeline is
 * fully unit-testable without a VLM, an OCR engine, a renderer, or a
 * database.
 */

import type { ZodType } from 'zod';
import type { IntakeForm } from '../schemas/IntakeFormSchema.js';
import { LAB_PDF_SCHEMA_VERSION, type LabPdf } from '../schemas/LabPdfSchema.js';
import { INTAKE_FORM_SCHEMA_VERSION } from '../schemas/IntakeFormSchema.js';
import {
  VlmIntakeFormSchema,
  type VlmIntakeForm,
} from '../schemas/VlmIntakeFormSchema.js';
import {
  VlmLabPdfSchema,
  type VlmLabPdf,
} from '../schemas/VlmLabPdfSchema.js';
import {
  BboxLocator,
  entitiesFromIntakeForm,
  entitiesFromLabPdf,
} from './BboxLocator.js';
import type { BboxPlan } from './BboxPlan.js';
import type { LlmBboxSelector } from './LlmBboxSelector.js';
import {
  EXTRACTION_SYSTEM_PROMPT,
  INTAKE_FORM_USER_INSTRUCTION,
  LAB_PDF_USER_INSTRUCTION,
} from './prompts.js';
import { SchemaValidationFailed, VlmExtractor } from './VlmExtractor.js';
import type { OcrService } from './OcrService.js';
import type {
  DocType,
  ExtractionFailure,
  ExtractionRequest,
  ExtractionResult,
  PageRenderer,
  SidecarStore,
} from './types.js';

interface VlmSchemaSpec<T> {
  schema: ZodType<T>;
  schemaVersion: string;
  userInstruction: string;
}

export class ExtractionPipeline {
  constructor(
    private readonly renderer: PageRenderer,
    private readonly ocr: OcrService,
    private readonly extractor: VlmExtractor,
    private readonly sidecar: SidecarStore,
    /**
     * Optional. When provided, the LLM picks OCR line/word indices
     * per entity (the primary path) and the locator unions them.
     * When null, the locator falls back to mechanical token-overlap.
     */
    private readonly selector: LlmBboxSelector | null = null,
  ) {}

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    const pages = await this.renderer.render({
      bytes: request.bytes,
      mimeType: request.mimeType,
    });

    if (pages.length === 0) {
      const failure: ExtractionFailure = {
        documentId: request.documentId,
        patientId: request.patientId,
        docType: request.docType,
        error: 'renderer produced zero pages',
        attempts: 0,
      };
      await this.sidecar.recordFailure(failure);
      throw new Error(failure.error);
    }

    const spec = this.specFor(request.docType);

    // OCR + VLM run in parallel — neither depends on the other and both
    // operate on the rendered pages. OCR latency (~0.5s/page on a 1k×1.4k
    // PNG with the cached worker) overlaps the VLM round trip.
    let ocrPages, vlmExtracted: unknown;
    try {
      [ocrPages, vlmExtracted] = await Promise.all([
        this.ocr.recognize(pages),
        this.extractor.extract({
          pages,
          schema: spec.schema,
          systemPrompt: EXTRACTION_SYSTEM_PROMPT,
          userInstruction: this.tagInstruction(spec.userInstruction, request),
        }),
      ]);
    } catch (err) {
      const attempts = err instanceof SchemaValidationFailed ? err.attempts : 1;
      const failure: ExtractionFailure = {
        documentId: request.documentId,
        patientId: request.patientId,
        docType: request.docType,
        error: err instanceof Error ? err.message : String(err),
        attempts,
      };
      await this.sidecar.recordFailure(failure);
      throw err;
    }

    // Optional LLM-driven bbox selection. The locator falls back to
    // mechanical token-overlap when this returns null.
    const plan: BboxPlan | null = await this.runSelector(request.docType, vlmExtracted, ocrPages);

    const locator = new BboxLocator(ocrPages, pages, plan);
    const located: LabPdf | IntakeForm = request.docType === 'lab_pdf'
      ? locator.locateLabPdf(vlmExtracted as VlmLabPdf)
      : locator.locateIntakeForm(vlmExtracted as VlmIntakeForm);

    const result: ExtractionResult = {
      documentId: request.documentId,
      patientId: request.patientId,
      docType: request.docType,
      schemaVersion: spec.schemaVersion,
      extractedJson: located,
      pageCount: pages.length,
    };
    await this.sidecar.recordSuccess(result);
    return result;
  }

  private async runSelector(
    docType: DocType,
    vlmExtracted: unknown,
    ocrPages: ReadonlyArray<import('./OcrService.js').OcrPage>,
  ): Promise<BboxPlan | null> {
    if (this.selector === null) return null;
    const entities = docType === 'lab_pdf'
      ? entitiesFromLabPdf(vlmExtracted as VlmLabPdf)
      : entitiesFromIntakeForm(vlmExtracted as VlmIntakeForm);
    if (entities.length === 0) return { entries: [] };
    return this.selector.select({ ocrPages, entities });
  }

  private specFor(docType: DocType): VlmSchemaSpec<unknown> {
    switch (docType) {
      case 'lab_pdf':
        return {
          schema: VlmLabPdfSchema as ZodType<VlmLabPdf>,
          schemaVersion: LAB_PDF_SCHEMA_VERSION,
          userInstruction: LAB_PDF_USER_INSTRUCTION,
        };
      case 'intake_form':
        return {
          schema: VlmIntakeFormSchema as ZodType<VlmIntakeForm>,
          schemaVersion: INTAKE_FORM_SCHEMA_VERSION,
          userInstruction: INTAKE_FORM_USER_INSTRUCTION,
        };
      default:
        throw new Error(`unknown doc_type: ${String(docType)}`);
    }
  }

  private tagInstruction(base: string, request: ExtractionRequest): string {
    return `${base}\n\nFor source_citation.document_id use the literal value: "${request.documentId}".`;
  }
}
