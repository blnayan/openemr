/**
 * Shared bounding-box schema for citation overlays.
 *
 * Coordinates live in image-pixel space — the rendered PNG of the
 * source document page is the surface the bbox overlay viewer draws
 * over. We deliberately avoid the original PDF coordinate system so
 * the overlay viewer never has to do PDF-coord arithmetic.
 *
 * `image_w` / `image_h` are recorded at extraction time so the viewer
 * can scale the overlay correctly even if the renderer's DPI changes
 * later.
 *
 * Two model quirks are handled by the preprocess below — without these,
 * Gemini-3-flash-preview (our current VLM) produces bboxes that the
 * stricter object schema rejects, even though the underlying coords
 * are good:
 *
 *   1. Stringified objects. Gemini-3 emits the bbox slot for every
 *      array-nested field (e.g. `results[i].bbox`) as a JSON-encoded
 *      string like `"{\"page\":0,\"x\":388,...}"` rather than a real
 *      object. We JSON.parse strings that look like objects.
 *
 * Note: gemini-3-flash-preview has a separate quirk where it returns
 * coordinates on a 0-1000 normalized grid for BOTH axes despite
 * reporting an aspect-correct `image_h`. We do NOT compensate for that
 * here — different VLMs (Anthropic, Gemini-2.5, GPT-4o) emit honest
 * pixel-space coords against the reported `image_h`, and a one-size-
 * fits-all override breaks them. If we need to support gemini-3 again,
 * gate the override behind a model-id check instead.
 */

import { z } from 'zod';

// image_w / image_h are required for the overlay viewer to scale the
// rectangle correctly, but the supervisor's synthesizer doesn't have
// the original PNG pixel dimensions in scope when it emits a citation
// (the prompt hints at `bbox: {x,y,w,h,page}` only, and adding two more
// fields the model can't actually populate just makes synthesis flakier).
// Treat them as optional and default to 0 — the overlay code already
// short-circuits on `image_w <= 0 || image_h <= 0`, so a zero-dim bbox
// renders no overlay rather than failing the whole answer. Bboxes that
// come straight from the VLM extractor (which DOES know the page size)
// still carry real positive dims and render normally.
const BboxObjectSchema = z.object({
  page: z.number().int().nonnegative(),
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  w: z.number().nonnegative(),
  h: z.number().nonnegative(),
  image_w: z.number().int().nonnegative().default(0),
  image_h: z.number().int().nonnegative().default(0),
});

function normalizeBboxInput(value: unknown): unknown {
  // Quirk 1: parse stringified bbox objects.
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{')) return value;
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch {
      return value;
    }
  }

  return value;
}

export const BboxSchema = z.preprocess(normalizeBboxInput, BboxObjectSchema);

export type Bbox = z.infer<typeof BboxSchema>;
