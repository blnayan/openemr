/**
 * BboxLocator — plan-driven path.
 *
 * Verifies that:
 *   - The locator unions multiple OCR lines into a single bbox when
 *     the plan says a row spans them (the eGFR / HDL multi-line case).
 *   - TIGHT entities use word_indices to hug the value tokens.
 *   - When the plan is missing a row, the mechanical fallback runs.
 *   - When the plan names an out-of-range index, the entity falls
 *     back rather than crashing.
 */

import { describe, expect, it } from 'vitest';
import { BboxLocator } from '../../../src/extraction/BboxLocator.js';
import type { BboxPlan } from '../../../src/extraction/BboxPlan.js';
import type { OcrPage, OcrWord } from '../../../src/extraction/OcrService.js';
import type { RenderedPage } from '../../../src/extraction/types.js';
import type { VlmLabPdf } from '../../../src/schemas/VlmLabPdfSchema.js';

function word(text: string, x: number, y: number, w: number, h: number, lineIndex: number, page = 0): OcrWord {
  return { page, text, x, y, w, h, lineIndex, confidence: 95 };
}

function pageMeta(): RenderedPage {
  return {
    page: 0, pngBytes: Buffer.from('p'),
    imageWidth: 1000, imageHeight: 1400,
    originalWidth: 1000, originalHeight: 1400,
    trimOffsetLeft: 0, trimOffsetTop: 0,
  };
}

const blankLab: Omit<VlmLabPdf, 'patient_on_document' | 'results'> = {
  doc_type: 'lab_pdf',
  schema_version: '1',
  performing_lab: null,
  ordering_provider: null,
  collection_date_default: null,
  source_citation: { document_id: '1', page_count: 1 },
};

/**
 * Two OCR lines that visually form a single lab row:
 *   line 0:  "HDL Cholesterol" (test name on its own line, x=50, y=800)
 *   line 1:  "52 mg/dL >40"    (value/unit/range on next line, x=300, y=830)
 * The two-line union is the correct row bbox.
 */
function multiLineHdlPage(): OcrPage {
  return {
    page: 0, imageWidth: 1000, imageHeight: 1400,
    lines: [
      {
        page: 0, text: 'HDL Cholesterol', x: 50, y: 800, w: 200, h: 24,
        words: [
          word('HDL', 50, 800, 60, 24, 0),
          word('Cholesterol', 120, 800, 130, 24, 0),
        ],
      },
      {
        page: 0, text: '52 mg/dL >40', x: 300, y: 830, w: 250, h: 24,
        words: [
          word('52', 300, 830, 40, 24, 1),
          word('mg/dL', 350, 830, 80, 24, 1),
          word('>40', 440, 830, 110, 24, 1),
        ],
      },
    ],
    words: [],
  };
}

const hdlVlm: VlmLabPdf = {
  ...blankLab,
  patient_on_document: null,
  results: [
    {
      test_name: 'HDL Cholesterol',
      loinc_code: null,
      numeric_value: 52,
      display_value: '52',
      unit: 'mg/dL',
      reference_range: { low: 40, high: null, raw_text: '>40' },
      abnormal_flag: null,
      collection_date: null,
      vlm_confidence: 0.97,
      citation_confidence: 'unverifiable',
    },
  ],
};

describe('BboxLocator — plan-driven', () => {
  it('unions two OCR lines into a single bbox when the plan spans them', () => {
    const plan: BboxPlan = {
      entries: [
        { entity_id: 'results[0]', page: 0, line_indices: [0, 1] },
      ],
    };
    const locator = new BboxLocator([multiLineHdlPage()], [pageMeta()], plan);

    const located = locator.locateLabPdf(hdlVlm);

    // Union spans x=50 (HDL left edge) to x=550 (>40 right edge),
    // y=800 (top of test name) to y=854 (bottom of value line).
    expect(located.results[0]?.bbox).toEqual({
      page: 0, x: 50, y: 800, w: 500, h: 54, image_w: 1000, image_h: 1400,
    });
  });

  it('uses word_indices to emit a TIGHT bbox for the patient name', () => {
    const ocr: OcrPage = {
      page: 0, imageWidth: 1000, imageHeight: 1400,
      lines: [{
        page: 0, text: 'Patient Name: Maria Reyes', x: 0, y: 50, w: 600, h: 24,
        words: [
          word('Patient', 0, 50, 100, 24, 0),
          word('Name:', 110, 50, 80, 24, 0),
          word('Maria', 200, 50, 90, 24, 0),
          word('Reyes', 300, 50, 100, 24, 0),
        ],
      }],
      words: [],
    };
    const plan: BboxPlan = {
      entries: [
        {
          entity_id: 'patient_on_document',
          page: 0,
          line_indices: [0],
          word_indices: [2, 3], // "Maria", "Reyes"
        },
      ],
    };
    const locator = new BboxLocator([ocr], [pageMeta()], plan);

    const located = locator.locateLabPdf({
      ...blankLab,
      patient_on_document: { name: 'Maria Reyes' },
      results: [],
    });

    // Hugs only the two named words: x=200..400, y=50..74
    expect(located.patient_on_document?.bbox).toEqual({
      page: 0, x: 200, y: 50, w: 200, h: 24, image_w: 1000, image_h: 1400,
    });
  });

  it('falls back to mechanical row scoring when the plan omits an entity', () => {
    // Plan only covers results[0]; results[1] should fall back.
    const ocr: OcrPage = {
      page: 0, imageWidth: 1000, imageHeight: 1400,
      lines: [
        {
          page: 0, text: 'HDL Cholesterol 52 mg/dL', x: 50, y: 800, w: 500, h: 24,
          words: [
            word('HDL', 50, 800, 60, 24, 0),
            word('Cholesterol', 120, 800, 130, 24, 0),
            word('52', 260, 800, 40, 24, 0),
            word('mg/dL', 310, 800, 80, 24, 0),
          ],
        },
        {
          page: 0, text: 'LDL Cholesterol 130 mg/dL', x: 50, y: 830, w: 500, h: 24,
          words: [
            word('LDL', 50, 830, 60, 24, 1),
            word('Cholesterol', 120, 830, 130, 24, 1),
            word('130', 260, 830, 50, 24, 1),
            word('mg/dL', 320, 830, 80, 24, 1),
          ],
        },
      ],
      words: [],
    };
    const plan: BboxPlan = {
      entries: [{ entity_id: 'results[0]', page: 0, line_indices: [0] }],
    };
    const locator = new BboxLocator([ocr], [pageMeta()], plan);

    const located = locator.locateLabPdf({
      ...blankLab,
      patient_on_document: null,
      results: [
        { ...hdlVlm.results[0]! },
        {
          test_name: 'LDL Cholesterol',
          loinc_code: null,
          numeric_value: 130,
          display_value: '130',
          unit: 'mg/dL',
          reference_range: { low: null, high: null, raw_text: '' },
          abnormal_flag: null,
          collection_date: null,
          vlm_confidence: 0.95,
          citation_confidence: 'unverifiable',
        },
      ],
    });

    // results[0] from plan (line 0 union)
    expect(located.results[0]?.bbox.y).toBe(800);
    // results[1] from mechanical fallback (line 1 won via token overlap)
    expect(located.results[1]?.bbox.y).toBe(830);
  });

  it('falls back when the plan names an out-of-range line index', () => {
    const plan: BboxPlan = {
      entries: [
        { entity_id: 'results[0]', page: 0, line_indices: [99] }, // bogus
      ],
    };
    const locator = new BboxLocator([multiLineHdlPage()], [pageMeta()], plan);

    const located = locator.locateLabPdf(hdlVlm);

    // Mechanical fallback ran. The value/unit line carries more
    // matching tokens (52, mg, dl, 40) than the test-name line (hdl,
    // cholesterol), so it wins on score. The point of the assertion
    // is that the locator did NOT crash on the bogus index — it fell
    // back to the heuristic, which produces a single-line bbox (not
    // the union the plan would have given).
    expect(located.results[0]?.bbox.y).toBe(830);
    expect(located.results[0]?.bbox.h).toBe(24);
  });
});
