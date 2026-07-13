/**
 * Production PageRenderer.
 *
 * Image uploads (PNG/JPEG/WebP) are normalized through `sharp` to a
 * single PNG with known dimensions — that's a safe, dependency-light
 * passthrough that gives the VLM a consistent input format.
 *
 * PDF uploads are rendered with `mupdf` (Artifex's MuPDF.js — a
 * WebAssembly port of the C MuPDF renderer). We previously used
 * pdfjs-dist + @napi-rs/canvas, but pdfjs's pure-JS fallback for
 * compiled PostScript color functions silently corrupted pages on
 * real lab PDFs (entire pages rendered as black with only a few
 * labels surviving). MuPDF is independently developed (Artifex) and
 * handles color functions, transparency groups, and ICC profiles
 * correctly. Pure-WASM, so no system packages or subprocesses are
 * required.
 *
 * One PNG per page at a configurable scale (default 3.0x for VLM
 * legibility), capped to MAX_PAGES so a malicious or accidentally-
 * massive PDF can't OOM the service. Bbox coordinates emitted by the
 * VLM are interpreted in image-pixel space (per the W2 PRD), which
 * matches the `imageWidth`/`imageHeight` we report here.
 *
 * Tests inject a stub PageRenderer for unit tests; the production
 * renderer is exercised both by unit tests (synthetic PNG/JPEG/WebP
 * via sharp + a tiny synthesized PDF) and by an integration smoke
 * test against a real fixture PDF.
 */

import sharp from 'sharp';
import type { PageRenderer, RenderedPage } from './types.js';

export class UnsupportedDocumentMimeError extends Error {
  constructor(mimeType: string) {
    super(`unsupported document mimeType for rendering: ${mimeType}`);
    this.name = 'UnsupportedDocumentMimeError';
  }
}

const PASSTHROUGH_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * Hard cap on rendered pages per upload. Exists to bound resource
 * usage from a worst-case input (1000-page document, accidental or
 * adversarial). Excess pages are dropped with a warning rather than
 * failing the whole extraction.
 */
const MAX_PAGES = 10;

/**
 * Default render scale. 3.0x trades payload size for legibility on lab
 * tables — small numerics on dense lab forms became unreadable at 2.0x
 * (the VLM under-extracted rows or returned null fields it could
 * partially see). MuPDF interprets the page space at 72 DPI by default
 * (a 1.0 matrix produces a 612×792 letter), so 3.0× = 216 DPI. A
 * US-letter page at 3.0× is 1836×2376 (~4.36M pixels), well under
 * MAX_PIXELS_PER_PAGE.
 */
const DEFAULT_RENDER_SCALE = 3.0;

/**
 * Cap on total pixels per rendered page. A defensive cap at 10M means
 * we'd downscale a 16x9 poster-size page rather than allocate hundreds
 * of MB.
 */
const MAX_PIXELS_PER_PAGE = 10_000_000;

export interface ImageAndPdfPageRendererOptions {
  /** Render scale for PDFs (1.0 = 72 DPI). Defaults to 3.0. */
  scale?: number;
  /** Hard cap on page count. Defaults to MAX_PAGES (10). */
  maxPages?: number;
  /** Logger hook for the page-cap warning; defaults to console.warn. */
  warn?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export class ImageAndPdfPageRenderer implements PageRenderer {
  private readonly scale: number;
  private readonly maxPages: number;
  private readonly warn: (msg: string, ctx?: Record<string, unknown>) => void;

  constructor(opts: ImageAndPdfPageRendererOptions = {}) {
    this.scale = opts.scale ?? DEFAULT_RENDER_SCALE;
    this.maxPages = opts.maxPages ?? MAX_PAGES;
    this.warn = opts.warn ?? ((m, ctx) => console.warn(`[agentforge] ${m}`, ctx ?? {}));
  }

  async render(input: { bytes: Buffer; mimeType: string }): Promise<RenderedPage[]> {
    if (input.mimeType === 'application/pdf') {
      return this.renderPdf(input.bytes);
    }
    if (!PASSTHROUGH_MIMES.has(input.mimeType)) {
      throw new UnsupportedDocumentMimeError(input.mimeType);
    }
    // First pass: rotate to apply EXIF, then read the post-rotation dims.
    // We need these as the "original" dims for bbox translation later,
    // because the browser displays the original bytes (post-rotation but
    // pre-trim) via OpenEMR's document retrieve URL.
    const rotated = await sharp(input.bytes).rotate().png().toBuffer({ resolveWithObject: true });
    const originalWidth = rotated.info.width;
    const originalHeight = rotated.info.height;

    // Second pass: trim near-uniform borders. Phone photos and scanner
    // output often have a dark frame around the actual page (RGB ~50
    // vs document content ~200). Sonnet's spatial localization is much
    // more accurate when that dead area is gone. trim() reports
    // trimOffsetLeft/Top so we can translate trimmed-space bboxes back
    // into the original frame the browser will render.
    const trimmed = await sharp(rotated.data)
      .trim({ threshold: 50 })
      .png()
      .toBuffer({ resolveWithObject: true });
    const width = trimmed.info.width;
    const height = trimmed.info.height;
    if (width === 0 || height === 0) {
      throw new Error('image has zero width or height');
    }
    // sharp's trimOffsetLeft/Top are negative values: e.g. -100 means
    // 100 pixels were trimmed from the left edge. We want the offset
    // FROM original top-left TO trimmed top-left, which is positive.
    const trimOffsetLeft = -(trimmed.info.trimOffsetLeft ?? 0);
    const trimOffsetTop = -(trimmed.info.trimOffsetTop ?? 0);

    return [{
      page: 0,
      pngBytes: trimmed.data,
      imageWidth: width,
      imageHeight: height,
      originalWidth,
      originalHeight,
      trimOffsetLeft,
      trimOffsetTop,
    }];
  }

  private async renderPdf(bytes: Buffer): Promise<RenderedPage[]> {
    // Dynamic import keeps the WASM payload off the hot path for
    // image-only requests and matches the lazy-load pattern the
    // previous pdfjs implementation used.
    const mupdf = await import('mupdf');

    // MuPDF retains a Userdata handle per Document/Page/Pixmap that we
    // must explicitly destroy() to release the WASM-side memory. The
    // try/finally chain below mirrors that ownership.
    const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
    try {
      const totalPages = doc.countPages();
      const pagesToRender = Math.min(totalPages, this.maxPages);
      if (totalPages > this.maxPages) {
        this.warn('PDF exceeds page cap; rendering only the first MAX_PAGES', {
          totalPages,
          maxPages: this.maxPages,
        });
      }

      const out: RenderedPage[] = [];
      for (let i = 0; i < pagesToRender; i += 1) {
        const page = doc.loadPage(i);
        try {
          // Compute the scale, clamping so we never blow past the
          // pixel cap. MuPDF's identity matrix maps the page coord
          // space (72 DPI) 1:1 to image pixels, so width at scale=s
          // is pageWidth_pt * s.
          const [, , x1, y1] = page.getBounds();
          const baseW = Math.max(1, x1);
          const baseH = Math.max(1, y1);
          let scale = this.scale;
          if (baseW * baseH * scale * scale > MAX_PIXELS_PER_PAGE) {
            scale = Math.sqrt(MAX_PIXELS_PER_PAGE / (baseW * baseH));
          }

          const matrix = mupdf.Matrix.scale(scale, scale);
          // alpha=false → opaque white background, which matches the
          // pdfjs implementation we replaced and is what the VLM
          // expects when reasoning about "blank space" on the page.
          const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false);
          try {
            const png = pixmap.asPNG();
            const width = pixmap.getWidth();
            const height = pixmap.getHeight();
            if (width <= 0 || height <= 0) {
              throw new Error(`mupdf rendered page ${i} with zero dimensions`);
            }
            // asPNG returns a Uint8Array view into WASM memory; copy
            // into a Node Buffer so the bytes outlive the pixmap's
            // destroy() below.
            // PDF pages are rendered fresh by mupdf — no trim applied,
            // so the trimmed and original frames are identical.
            out.push({
              page: i,
              pngBytes: Buffer.from(png),
              imageWidth: width,
              imageHeight: height,
              originalWidth: width,
              originalHeight: height,
              trimOffsetLeft: 0,
              trimOffsetTop: 0,
            });
          } finally {
            pixmap.destroy();
          }
        } finally {
          page.destroy();
        }
      }
      return out;
    } finally {
      doc.destroy();
    }
  }
}
