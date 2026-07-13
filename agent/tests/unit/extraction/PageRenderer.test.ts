/**
 * PageRenderer unit tests — exercise the image-passthrough path with
 * sharp-generated fixture PNG/JPEG/WebP bytes, the unsupported-MIME
 * rejection, and the PDF rendering path (single-page, multi-page, and
 * the page-cap behavior). PDF tests use synthesized PDF buffers so
 * they don't depend on any committed fixture file.
 */

import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import {
  ImageAndPdfPageRenderer,
  UnsupportedDocumentMimeError,
} from '../../../src/extraction/PageRenderer.js';

async function makePngFixture(width = 32, height = 24): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 200, b: 200 } },
  }).png().toBuffer();
}

/**
 * Build a minimal valid PDF buffer with the given number of pages.
 * Hand-rolled so the test doesn't pull in another PDF library; the
 * structure is just enough for the renderer to parse a Catalog/Pages
 * tree and walk page count.
 */
function makeMinimalPdf(pageCount: number, pageWidth = 200, pageHeight = 300): Buffer {
  const objects: string[] = [];
  // Object 1: Catalog
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  // Object 2: Pages root
  const kidsRefs: string[] = [];
  for (let i = 0; i < pageCount; i += 1) {
    // Page objects start at object index 3 (1=Catalog, 2=Pages)
    kidsRefs.push(`${3 + i} 0 R`);
  }
  objects.push(
    `<< /Type /Pages /Count ${pageCount} /Kids [ ${kidsRefs.join(' ')} ] >>`,
  );
  // Page objects
  for (let i = 0; i < pageCount; i += 1) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << >> >>`,
    );
  }

  // Assemble the PDF body with a cross-reference table.
  const header = '%PDF-1.4\n%âãÏÓ\n';
  const offsets: number[] = [];
  let body = '';
  let cursor = Buffer.byteLength(header, 'binary');
  objects.forEach((obj, idx) => {
    offsets.push(cursor);
    const block = `${idx + 1} 0 obj\n${obj}\nendobj\n`;
    body += block;
    cursor += Buffer.byteLength(block, 'binary');
  });

  const xrefOffset = cursor;
  let xref = `xref\n0 ${objects.length + 1}\n`;
  xref += '0000000000 65535 f \n';
  for (const off of offsets) {
    xref += `${off.toString().padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(header + body + xref + trailer, 'binary');
}

describe('ImageAndPdfPageRenderer', () => {
  const renderer = new ImageAndPdfPageRenderer();

  it('renders a PNG upload as a single page with measured dimensions', async () => {
    const bytes = await makePngFixture(40, 30);
    const pages = await renderer.render({ bytes, mimeType: 'image/png' });
    expect(pages).toHaveLength(1);
    expect(pages[0]?.page).toBe(0);
    expect(pages[0]?.imageWidth).toBe(40);
    expect(pages[0]?.imageHeight).toBe(30);
    expect(pages[0]?.pngBytes.length).toBeGreaterThan(0);
  });

  it('renders a JPEG upload as a single page', async () => {
    const png = await makePngFixture(32, 32);
    const jpeg = await sharp(png).jpeg().toBuffer();
    const pages = await renderer.render({ bytes: jpeg, mimeType: 'image/jpeg' });
    expect(pages).toHaveLength(1);
    expect(pages[0]?.imageWidth).toBe(32);
  });

  it('renders a WebP upload as a single page', async () => {
    const png = await makePngFixture(32, 32);
    const webp = await sharp(png).webp().toBuffer();
    const pages = await renderer.render({ bytes: webp, mimeType: 'image/webp' });
    expect(pages).toHaveLength(1);
  });

  it('renders a single-page PDF to a PNG with non-zero dimensions', async () => {
    const pdf = makeMinimalPdf(1, 200, 300);
    const pages = await renderer.render({ bytes: pdf, mimeType: 'application/pdf' });
    expect(pages).toHaveLength(1);
    expect(pages[0]?.page).toBe(0);
    expect(pages[0]?.imageWidth).toBeGreaterThan(0);
    expect(pages[0]?.imageHeight).toBeGreaterThan(0);
    expect(pages[0]?.pngBytes.length).toBeGreaterThan(0);
    // Default scale is 3.0x, so a 200x300 page renders at 600x900.
    expect(pages[0]?.imageWidth).toBe(600);
    expect(pages[0]?.imageHeight).toBe(900);
  });

  it('renders a multi-page PDF as one RenderedPage per page', async () => {
    const pdf = makeMinimalPdf(3, 100, 150);
    const pages = await renderer.render({ bytes: pdf, mimeType: 'application/pdf' });
    expect(pages).toHaveLength(3);
    expect(pages.map((p) => p.page)).toEqual([0, 1, 2]);
    pages.forEach((p) => {
      expect(p.imageWidth).toBeGreaterThan(0);
      expect(p.imageHeight).toBeGreaterThan(0);
      expect(p.pngBytes.length).toBeGreaterThan(0);
    });
  });

  it('caps a PDF at maxPages and warns on the overflow', async () => {
    const warn = vi.fn();
    const cappedRenderer = new ImageAndPdfPageRenderer({ maxPages: 2, warn });
    const pdf = makeMinimalPdf(5, 100, 150);
    const pages = await cappedRenderer.render({ bytes: pdf, mimeType: 'application/pdf' });
    expect(pages).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('exceeds page cap'),
      expect.objectContaining({ totalPages: 5, maxPages: 2 }),
    );
  });

  it('rejects unsupported MIME types', async () => {
    await expect(
      renderer.render({ bytes: Buffer.from('foo'), mimeType: 'application/octet-stream' }),
    ).rejects.toThrow(UnsupportedDocumentMimeError);
  });

  it('applies EXIF rotation to image uploads so dimensions match post-rotation', async () => {
    // Create a portrait JPEG (100 wide × 200 tall pixels — no EXIF orientation tag).
    const portraitBuffer = await sharp({
      create: { width: 100, height: 200, channels: 3, background: { r: 100, g: 100, b: 100 } },
    }).jpeg().toBuffer();

    // Create an EXIF-tagged version: the pixel grid stays portrait (100×200) but
    // the EXIF orientation flag is set to 6 ("rotate 90° CW before display").
    // withMetadata({ orientation: 6 }) writes the EXIF tag without touching pixel
    // data, so the stored pixels are still 100 wide × 200 tall.
    // A renderer that calls sharp().rotate() will auto-apply the EXIF tag and
    // report 200×100 (landscape). A renderer that skips .rotate() will see the
    // raw pixel dimensions 100×200 — identical to the un-tagged portrait above.
    // That contrast is what proves .rotate() is doing real work.
    const exifTaggedBuffer = await sharp(portraitBuffer)
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    // Render both through the page renderer.
    const portraitPages = await renderer.render({ bytes: portraitBuffer, mimeType: 'image/jpeg' });
    const exifTaggedPages = await renderer.render({ bytes: exifTaggedBuffer, mimeType: 'image/jpeg' });

    // Un-tagged portrait: pixel grid is 100×200, no EXIF to apply → 100×200.
    expect(portraitPages[0]?.imageWidth).toBe(100);
    expect(portraitPages[0]?.imageHeight).toBe(200);

    // EXIF-tagged: pixel grid is still 100×200 but orientation=6 tells sharp to
    // rotate 90° CW, swapping width and height → 200×100 (landscape).
    expect(exifTaggedPages[0]?.imageWidth).toBe(200);
    expect(exifTaggedPages[0]?.imageHeight).toBe(100);
  });
});
