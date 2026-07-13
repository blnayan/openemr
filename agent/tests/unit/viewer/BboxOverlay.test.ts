/**
 * BboxOverlay unit tests — exercise the scaling math in
 * `agent/src/viewer/BboxOverlay.ts`.
 *
 * The module is pure (no DOM, no I/O), so these run in the default Node
 * Vitest environment.  The cases mirror the acceptance-criteria checklist
 * from issue 31:
 *
 *   - Portrait and landscape canvas viewports.
 *   - EXIF-rotated source where image_w/image_h match the rotated (swapped)
 *     dimensions recorded by issue 30.
 *   - Poster-page downscale case (image_w smaller than 2× PDF page width).
 *   - Bbox coordinates clipped to the canvas boundary.
 */

import { describe, expect, it } from 'vitest';
import {
  computeOverlayRect,
  recordsForPage,
  type BboxRecord,
} from '../../../src/viewer/BboxOverlay.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeBbox(
  page: number,
  x: number,
  y: number,
  w: number,
  h: number,
  image_w: number,
  image_h: number,
): BboxRecord {
  return {
    bbox: { page, x, y, w, h, image_w, image_h },
    fieldPath: `results[0].display_value`,
    label: 'Test Label',
  };
}

// ---------------------------------------------------------------------------
// Portrait viewport (canvas is taller than it is wide)
// ---------------------------------------------------------------------------

describe('computeOverlayRect — portrait viewport', () => {
  it('scales a centered bbox correctly when canvas matches image size', () => {
    // image_w = 400, image_h = 600  (portrait PNG rendered by the agent)
    // canvas displayed at exactly the same size → displayedScale = 1.0
    const record = makeBbox(0, 100, 200, 50, 30, 400, 600);
    const rect = computeOverlayRect(record, 400, 600);
    expect(rect).not.toBeNull();
    expect(rect!.left).toBeCloseTo(100);
    expect(rect!.top).toBeCloseTo(200);
    expect(rect!.width).toBeCloseTo(50);
    expect(rect!.height).toBeCloseTo(30);
  });

  it('scales a bbox when the canvas is half the image width (downscaled display)', () => {
    // image_w = 400, displayed canvas width = 200 → displayedScale = 0.5
    const record = makeBbox(0, 100, 200, 80, 40, 400, 600);
    const rect = computeOverlayRect(record, 200, 300);
    expect(rect).not.toBeNull();
    // 100 * 0.5 = 50, 200 * 0.5 = 100, 80 * 0.5 = 40, 40 * 0.5 = 20
    expect(rect!.left).toBeCloseTo(50);
    expect(rect!.top).toBeCloseTo(100);
    expect(rect!.width).toBeCloseTo(40);
    expect(rect!.height).toBeCloseTo(20);
  });
});

// ---------------------------------------------------------------------------
// Landscape viewport (canvas is wider than it is tall)
// ---------------------------------------------------------------------------

describe('computeOverlayRect — landscape viewport', () => {
  it('scales a bbox correctly for a landscape page', () => {
    // image_w = 600, image_h = 400  (landscape image)
    // canvas displayed at 300 × 200 → displayedScale = 300/600 = 0.5
    const record = makeBbox(0, 60, 40, 120, 80, 600, 400);
    const rect = computeOverlayRect(record, 300, 200);
    expect(rect).not.toBeNull();
    expect(rect!.left).toBeCloseTo(30);   // 60 * 0.5
    expect(rect!.top).toBeCloseTo(20);    // 40 * 0.5
    expect(rect!.width).toBeCloseTo(60);  // 120 * 0.5
    expect(rect!.height).toBeCloseTo(40); // 80 * 0.5
  });

  it('handles a landscape canvas wider than the image_w (upscaled display)', () => {
    // image_w = 300, displayed at 600 → displayedScale = 2.0
    const record = makeBbox(0, 10, 5, 30, 20, 300, 200);
    const rect = computeOverlayRect(record, 600, 400);
    expect(rect).not.toBeNull();
    expect(rect!.left).toBeCloseTo(20);   // 10 * 2
    expect(rect!.top).toBeCloseTo(10);    // 5 * 2
    expect(rect!.width).toBeCloseTo(60);  // 30 * 2
    expect(rect!.height).toBeCloseTo(40); // 20 * 2
  });
});

// ---------------------------------------------------------------------------
// EXIF-rotated source (issue 30 bakes EXIF into PNG before recording dims)
// ---------------------------------------------------------------------------

describe('computeOverlayRect — EXIF-rotated source', () => {
  it('uses post-rotation image_w/image_h for scale (landscape after 90° rotation)', () => {
    // The agent renders a phone-photo and bakes EXIF rotation:
    // raw pixel grid 600 × 800 (portrait), EXIF=90° CW → rendered as 800 × 600 (landscape).
    // bbox coords are in the post-rotation (800×600) space.
    // The browser displays the canvas at 400 × 300 → displayedScale = 400/800 = 0.5
    const record = makeBbox(0, 160, 120, 200, 100, 800, 600);
    const rect = computeOverlayRect(record, 400, 300);
    expect(rect).not.toBeNull();
    expect(rect!.left).toBeCloseTo(80);   // 160 * 0.5
    expect(rect!.top).toBeCloseTo(60);    // 120 * 0.5
    expect(rect!.width).toBeCloseTo(100); // 200 * 0.5
    expect(rect!.height).toBeCloseTo(50); // 100 * 0.5
  });

  it('correctly aligns a bbox near the post-rotation right edge', () => {
    // Post-rotation image: 800 × 600, bbox near right edge x=700, y=100, w=90, h=50
    // Canvas displayed at 400 × 300 → displayedScale = 0.5
    const record = makeBbox(0, 700, 100, 90, 50, 800, 600);
    const rect = computeOverlayRect(record, 400, 300);
    expect(rect).not.toBeNull();
    // Raw: left=350, right=395 (≤400 canvas width → no clip needed)
    expect(rect!.left).toBeCloseTo(350);
    expect(rect!.width).toBeCloseTo(45);
  });
});

// ---------------------------------------------------------------------------
// Poster-page downscale case (MAX_PIXELS_PER_PAGE cap)
// ---------------------------------------------------------------------------

describe('computeOverlayRect — poster-page downscale', () => {
  it('aligns when image_w is smaller than 2× the nominal PDF page width', () => {
    // A large poster PDF page at scale=2.0 would be 2400×3200 (12M pixels).
    // The renderer clamps it to √(10M/800/1100)×(800,1100) ≈ 1732×2309.
    // The browser canvas displays at 866×1154 → displayedScale = 866/1732 ≈ 0.5.
    const image_w = 1732;
    const image_h = 2309;
    const canvasW = 866;
    const canvasH = 1154;
    const record = makeBbox(0, 200, 300, 400, 150, image_w, image_h);
    const rect = computeOverlayRect(record, canvasW, canvasH);
    expect(rect).not.toBeNull();
    const scale = canvasW / image_w;
    expect(rect!.left).toBeCloseTo(200 * scale);
    expect(rect!.top).toBeCloseTo(300 * scale);
    expect(rect!.width).toBeCloseTo(400 * scale);
    expect(rect!.height).toBeCloseTo(150 * scale);
  });
});

// ---------------------------------------------------------------------------
// Bbox coordinates clipped to the canvas
// ---------------------------------------------------------------------------

describe('computeOverlayRect — clipping to canvas bounds', () => {
  it('clips a bbox that overflows the right edge', () => {
    // image_w = 400, canvas = 400 (scale=1.0)
    // bbox x=380, w=40 → right edge at 420, which is clipped to 400
    const record = makeBbox(0, 380, 10, 40, 20, 400, 600);
    const rect = computeOverlayRect(record, 400, 600);
    expect(rect).not.toBeNull();
    expect(rect!.left).toBeCloseTo(380);
    expect(rect!.width).toBeCloseTo(20);   // clipped from 40 to 20
  });

  it('clips a bbox that overflows the bottom edge', () => {
    const record = makeBbox(0, 10, 580, 20, 40, 400, 600);
    const rect = computeOverlayRect(record, 400, 600);
    expect(rect).not.toBeNull();
    expect(rect!.top).toBeCloseTo(580);
    expect(rect!.height).toBeCloseTo(20);  // clipped from 40 to 20
  });

  it('clips a bbox that starts at or before the left edge', () => {
    // bbox x=-10 (fractional pixel rounding on a very left-edge value)
    const record = makeBbox(0, -5, 10, 30, 20, 400, 600);
    const rect = computeOverlayRect(record, 400, 600);
    expect(rect).not.toBeNull();
    expect(rect!.left).toBeCloseTo(0);
    expect(rect!.width).toBeCloseTo(25);   // 0..25 (original right = -5+30=25)
  });

  it('returns null for a bbox entirely outside the right edge', () => {
    // bbox entirely to the right of the canvas after scale
    const record = makeBbox(0, 450, 10, 30, 20, 400, 600);
    const rect = computeOverlayRect(record, 400, 600);
    expect(rect).toBeNull();
  });

  it('returns null for a bbox with zero width', () => {
    const record = makeBbox(0, 10, 10, 0, 20, 400, 600);
    const rect = computeOverlayRect(record, 400, 600);
    expect(rect).toBeNull();
  });

  it('returns null for a bbox with zero height', () => {
    const record = makeBbox(0, 10, 10, 20, 0, 400, 600);
    const rect = computeOverlayRect(record, 400, 600);
    expect(rect).toBeNull();
  });

  it('returns null when image_w is zero', () => {
    const record = makeBbox(0, 10, 10, 20, 20, 0, 600);
    const rect = computeOverlayRect(record, 400, 600);
    expect(rect).toBeNull();
  });

  it('returns null when canvasWidth is zero', () => {
    const record = makeBbox(0, 10, 10, 20, 20, 400, 600);
    const rect = computeOverlayRect(record, 0, 600);
    expect(rect).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// recordsForPage
// ---------------------------------------------------------------------------

describe('recordsForPage', () => {
  const records: BboxRecord[] = [
    makeBbox(0, 10, 10, 50, 30, 400, 600),
    makeBbox(0, 100, 200, 60, 40, 400, 600),
    makeBbox(1, 10, 10, 50, 30, 400, 600),
    makeBbox(2, 10, 10, 50, 30, 400, 600),
  ];

  it('returns only records for the requested page', () => {
    const page0 = recordsForPage(records, 0);
    expect(page0).toHaveLength(2);
    expect(page0.every((r) => r.bbox.page === 0)).toBe(true);
  });

  it('returns records for page 1', () => {
    const page1 = recordsForPage(records, 1);
    expect(page1).toHaveLength(1);
  });

  it('returns empty array for a page with no records', () => {
    const page9 = recordsForPage(records, 9);
    expect(page9).toHaveLength(0);
  });
});
