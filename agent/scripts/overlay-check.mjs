#!/usr/bin/env node
/**
 * Render a fixture PDF, run Gemini extraction, overlay every bbox the model
 * returned onto the rendered PNG, and write the result to disk so we can
 * eyeball whether the boxes land on the right values.
 */

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { ImageAndPdfPageRenderer } from '../src/extraction/PageRenderer.js';
import { LabPdfSchema } from '../src/schemas/LabPdfSchema.js';
import {
  EXTRACTION_SYSTEM_PROMPT,
  LAB_PDF_USER_INSTRUCTION,
} from '../src/extraction/prompts.js';

const FIXTURE = process.argv[2];
const OUT     = process.argv[3] ?? '/tmp/overlay.png';
if (!FIXTURE) { console.error('usage: overlay-check.mjs <pdf|png> [out.png]'); process.exit(1); }

const MIME = FIXTURE.toLowerCase().endsWith('.pdf') ? 'application/pdf'
            : FIXTURE.toLowerCase().endsWith('.png') ? 'image/png'
            : 'image/jpeg';

const bytes = readFileSync(FIXTURE);
const renderer = new ImageAndPdfPageRenderer();
const pages = await renderer.render({ bytes, mimeType: MIME });
console.error(`[overlay] rendered ${pages.length} page(s); page 0 is ${pages[0].imageWidth}x${pages[0].imageHeight}`);

const { ChatOpenAI } = await import('@langchain/openai');
const model = new ChatOpenAI({
  model: process.env.OPENROUTER_VLM_MODEL ?? 'google/gemini-3-flash-preview',
  temperature: 0,
  apiKey: process.env.OPENROUTER_API_KEY,
  configuration: { baseURL: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1' },
});

const userContent = [
  { type: 'text', text: LAB_PDF_USER_INSTRUCTION },
  ...pages.map((p) => ({
    type: 'image_url',
    image_url: { url: `data:image/png;base64,${p.pngBytes.toString('base64')}` },
  })),
];
const messages = [
  { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
  { role: 'user', content: userContent },
];

const structured = model.withStructuredOutput(LabPdfSchema, { includeRaw: true });
const out = await structured.invoke(messages);
const args = out.raw?.tool_calls?.[0]?.args;
if (!args) { console.error('[overlay] no tool_call args returned'); process.exit(2); }

// Walk the model output and collect every bbox + a label.
const overlays = [];
function pushBbox(label, raw) {
  if (raw == null) return;
  let bbox = raw;
  if (typeof bbox === 'string' && bbox.trim().startsWith('{')) {
    try { bbox = JSON.parse(bbox); } catch { return; }
  }
  if (typeof bbox !== 'object' || bbox === null) return;
  const { x, y, w, h, image_w, image_h, page = 0 } = bbox;
  if ([x, y, w, h, image_w, image_h].some((n) => typeof n !== 'number')) return;

  // Mirror ExtractionPipeline.reconcileBboxDimensions exactly:
  //  1. aspect-correct frame, then
  //  2. translate to original (pre-trim) coords.
  const truth = pages[page];
  if (!truth) return;
  const trimmedAspect = truth.imageWidth / truth.imageHeight;
  const reportedAspect = image_w / image_h;
  const aspectOk = Math.abs(reportedAspect - trimmedAspect) / trimmedAspect <= 0.05;
  const frameW = aspectOk ? image_w : truth.imageWidth;
  const frameH = aspectOk ? image_h : truth.imageHeight;
  const sx = truth.imageWidth  / frameW;
  const sy = truth.imageHeight / frameH;
  const nx = (x * sx) + truth.trimOffsetLeft;
  const ny = (y * sy) + truth.trimOffsetTop;
  const nw = w * sx;
  const nh = h * sy;
  overlays.push({
    label, page,
    x: nx, y: ny, w: nw, h: nh,
    image_w: truth.originalWidth,
    image_h: truth.originalHeight,
  });
}

if (args.patient_on_document?.bbox) pushBbox(`patient: ${args.patient_on_document.name ?? ''}`, args.patient_on_document.bbox);
for (const [i, r] of (args.results ?? []).entries()) {
  pushBbox(`${i}: ${r.test_name} = ${r.display_value}`, r.bbox);
}

console.error(`[overlay] collected ${overlays.length} bbox(es)`);

// Reconstruct the ORIGINAL (rotated, untrimmed) PNG so the overlay
// renders on the same pixels the OpenEMR review page will display.
const originalRotated = (MIME === 'application/pdf')
  ? null
  : await sharp(bytes).rotate().png().toBuffer();

// For each page, scale bboxes from (image_w, image_h) → original dims and
// composite an SVG of red rectangles + labels onto the original (untrimmed) bytes.
for (const [pageIdx, page] of pages.entries()) {
  const pageOverlays = overlays.filter((o) => o.page === pageIdx);
  if (pageOverlays.length === 0) continue;

  const pageW = page.originalWidth;
  const pageH = page.originalHeight;
  const rects = pageOverlays.map((o, idx) => {
    const sx = pageW / o.image_w;
    const sy = pageH / o.image_h;
    const x = Math.round(o.x * sx);
    const y = Math.round(o.y * sy);
    const w = Math.round(o.w * sx);
    const h = Math.round(o.h * sy);
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgba(255,0,0,0.15)" stroke="red" stroke-width="2"/>` +
           `<text x="${x + 2}" y="${Math.max(y - 3, 12)}" font-family="sans-serif" font-size="14" fill="red">${idx}</text>`;
  }).join('\n');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pageW}" height="${pageH}">${rects}</svg>`;
  const overlayBuf = Buffer.from(svg);

  const outPath = pages.length === 1 ? OUT : OUT.replace(/(\.png)?$/, `-page${pageIdx}.png`);
  // For images, composite onto the original (rotated, untrimmed) bytes.
  // For PDFs, originalRotated is null and we still use the rendered page.
  const baseBytes = originalRotated ?? page.pngBytes;
  await sharp(baseBytes).composite([{ input: overlayBuf, top: 0, left: 0 }]).png().toFile(outPath);
  console.error(`[overlay] wrote ${outPath}  (${pageW}x${pageH}, ${pageOverlays.length} boxes)`);

  // ALSO write a no-scaling version: resize the rendered PNG to the
  // image_w/image_h the model claims, then draw boxes at literal x,y,w,h.
  // If boxes land correctly here but not in the scaled version, the
  // model's reported image_w/image_h disagree with the coordinate space.
  const o = pageOverlays[0];
  if (o) {
    const nativeW = o.image_w;
    const nativeH = o.image_h;
    const literalRects = pageOverlays.map((b, idx) =>
      `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="rgba(255,0,0,0.15)" stroke="red" stroke-width="2"/>` +
      `<text x="${b.x + 2}" y="${Math.max(b.y - 3, 12)}" font-family="sans-serif" font-size="14" fill="red">${idx}</text>`
    ).join('\n');
    const literalSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${nativeW}" height="${nativeH}">${literalRects}</svg>`;
    const literalOut = outPath.replace(/\.png$/, '-native.png');
    const resizedPng = await sharp(page.pngBytes).resize(nativeW, nativeH, { fit: 'fill' }).png().toBuffer();
    await sharp(resizedPng).composite([{ input: Buffer.from(literalSvg), top: 0, left: 0 }]).png().toFile(literalOut);
    console.error(`[overlay] wrote ${literalOut}  (native ${nativeW}x${nativeH}, no scaling)`);
  }
}

console.log('\n=== OVERLAY LEGEND ===');
overlays.forEach((o, i) => {
  console.log(`${i}\t${o.label}\t(page ${o.page}, ${o.x},${o.y} ${o.w}x${o.h} in ${o.image_w}x${o.image_h})`);
});
