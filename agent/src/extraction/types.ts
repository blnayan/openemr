/**
 * Public interfaces for the AgentForge document-extraction pipeline.
 *
 * The pipeline is built around a small set of seams so it can be
 * unit-tested without booting a VLM, a PDF renderer, or a database:
 *
 *   PageRenderer  — turns a raw upload buffer into a list of page
 *                   PNG buffers + metadata. Production renders PDFs
 *                   via pdfjs/canvas; pass-through for image uploads;
 *                   tests inject a fixture.
 *
 *   VlmInvoker    — sends a list of rendered pages plus a Zod schema
 *                   to the configured VLM, returns a Zod-parsed result
 *                   or throws on validation failure. Tests inject a
 *                   stub that returns canned objects.
 *
 *   SidecarStore  — persists a successful extraction into the
 *                   agentforge_document_extractions table. Tests
 *                   inject a recording fake.
 */

import type { ZodType } from 'zod';

export interface RenderedPage {
  page: number;
  pngBytes: Buffer;
  /** Width of pngBytes (post-trim, post-EXIF-rotate). */
  imageWidth: number;
  /** Height of pngBytes (post-trim, post-EXIF-rotate). */
  imageHeight: number;
  /**
   * Width of the original document bytes *before* the renderer trimmed
   * any borders. The browser displays the original bytes, so any bbox
   * coordinates emitted by the VLM (in `imageWidth × imageHeight`
   * trimmed space) must be translated back to this original frame for
   * the overlay to land correctly. Equal to `imageWidth` when no trim
   * happened.
   */
  originalWidth: number;
  /** Height counterpart to {@link originalWidth}. */
  originalHeight: number;
  /**
   * Pixel offset from the original image's top-left to the trimmed
   * image's top-left. Used to translate trimmed-frame bbox coords back
   * into the original-frame coords the browser displays in.
   */
  trimOffsetLeft: number;
  /** Top counterpart to {@link trimOffsetLeft}. */
  trimOffsetTop: number;
}

export interface PageRenderer {
  /**
   * Render every page of the input as a PNG. PDFs become one
   * RenderedPage per page; PNG/JPEG/WebP inputs become a single
   * RenderedPage at page 0.
   */
  render(input: { bytes: Buffer; mimeType: string }): Promise<RenderedPage[]>;
}

export interface VlmInvokeRequest<T> {
  pages: RenderedPage[];
  schema: ZodType<T>;
  systemPrompt: string;
  userInstruction: string;
}

export interface VlmInvoker {
  invoke<T>(req: VlmInvokeRequest<T>): Promise<T>;
}

export type DocType = 'lab_pdf' | 'intake_form';

export interface ExtractionRequest {
  documentId: number;
  patientId: number;
  docType: DocType;
  bytes: Buffer;
  mimeType: string;
}

export interface ExtractionResult {
  documentId: number;
  patientId: number;
  docType: DocType;
  schemaVersion: string;
  extractedJson: unknown;
  pageCount: number;
}

export interface ExtractionFailure {
  documentId: number;
  patientId: number;
  docType: DocType;
  error: string;
  attempts: number;
}

export interface SidecarStore {
  recordSuccess(result: ExtractionResult): Promise<void>;
  recordFailure(failure: ExtractionFailure): Promise<void>;
}
