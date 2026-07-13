/**
 * BboxOverlay — pure scaling-math module for citation bounding-box overlays.
 *
 * This module is deliberately free of DOM dependencies so the scaling
 * arithmetic can be tested in a Node.js Vitest environment without a
 * browser.  The browser-side component in
 * `public/assets/agentforge/document-viewer.js` calls `computeOverlayRect`
 * to position each overlay `<div>` and delegates rendering to the caller.
 *
 * Coordinate contract (matches `agent/src/schemas/Bbox.ts`):
 *   - `bbox.x`, `bbox.y`, `bbox.w`, `bbox.h`  — pixel coordinates in the
 *     image the agent rendered at extraction time.
 *   - `bbox.image_w`, `bbox.image_h` — dimensions of that rendered image
 *     (post-EXIF-rotation, post-MAX_PIXELS_PER_PAGE downscale).
 *   - `canvasWidth`, `canvasHeight` — the CSS pixel dimensions of the
 *     `<canvas>` or `<img>` as actually displayed in the browser.
 *
 * The displayed scale is:
 *   displayedScale = canvasWidth / bbox.image_w
 *
 * This keeps overlays aligned even when:
 *   - The server downscaled a poster-sized page below 2×.
 *   - The browser displays the canvas smaller or larger than the rendered
 *     PNG.
 *   - EXIF rotation changed width/height (issue 30 baked EXIF into the
 *     rendered PNG before recording image_w/image_h, so coordinates here
 *     are already in post-rotation space).
 *
 * Coordinates are clamped to `[0, canvasWidth]` / `[0, canvasHeight]` so
 * a bbox that barely overflows due to floating-point rounding does not
 * produce a visible mis-alignment.
 */

/** One overlay record as consumed by BboxOverlay. */
export interface BboxRecord {
  bbox: {
    page: number;
    x: number;
    y: number;
    w: number;
    h: number;
    image_w: number;
    image_h: number;
  };
  /** JSON path back into the extraction (e.g. "results[0].display_value"). */
  fieldPath: string;
  /** Human-readable label shown in the tooltip. */
  label: string;
}

/** The CSS-pixel rectangle to apply to an absolutely-positioned overlay div. */
export interface OverlayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Compute the CSS-pixel rectangle for a single `BboxRecord` given the
 * dimensions of the container canvas or image element.
 *
 * Returns `null` when the bbox has zero area or the image dimensions are
 * zero (defensive — should not happen with a valid extraction).
 */
export function computeOverlayRect(
  record: BboxRecord,
  canvasWidth: number,
  canvasHeight: number,
): OverlayRect | null {
  const { bbox } = record;

  if (bbox.image_w <= 0 || bbox.image_h <= 0) {
    return null;
  }
  if (bbox.w <= 0 || bbox.h <= 0) {
    return null;
  }
  if (canvasWidth <= 0 || canvasHeight <= 0) {
    return null;
  }

  // The scale is derived from image_w (width) only — matching the PRD's
  // displayedScale = canvasWidth / bbox.image_w.  A single uniform scale
  // preserves aspect ratio because bbox.image_w / bbox.image_h already
  // matches the rendered PNG's aspect ratio after any downscaling.
  const displayedScale = canvasWidth / bbox.image_w;

  const rawLeft   = bbox.x * displayedScale;
  const rawTop    = bbox.y * displayedScale;
  const rawRight  = (bbox.x + bbox.w) * displayedScale;
  const rawBottom = (bbox.y + bbox.h) * displayedScale;

  // Clamp to canvas bounds.
  const left   = Math.max(0, rawLeft);
  const top    = Math.max(0, rawTop);
  const right  = Math.min(canvasWidth, rawRight);
  const bottom = Math.min(canvasHeight, rawBottom);

  const width  = right - left;
  const height = bottom - top;

  // After clamping, a zero-area rect means the bbox was entirely outside
  // the canvas — skip it.
  if (width <= 0 || height <= 0) {
    return null;
  }

  return { left, top, width, height };
}

/**
 * Filter a list of BboxRecords to those that fall on the given page index.
 *
 * Pages whose index is >= source_citation.page_count (i.e. beyond the
 * agent's 10-page extraction cap) are not in the extraction and therefore
 * produce no records; the caller renders the "not processed" banner instead.
 */
export function recordsForPage(
  records: readonly BboxRecord[],
  pageIndex: number,
): BboxRecord[] {
  return records.filter((r) => r.bbox.page === pageIndex);
}
