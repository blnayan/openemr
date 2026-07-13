/**
 * BboxLocator unit tests.
 *
 * Exercises the two anchoring modes (TIGHT vs ROW), the trim-undo
 * translation, and the fallback to a zero-area bbox when OCR can't find
 * a textual anchor for a value.
 */

import { describe, expect, it } from 'vitest';
import { BboxLocator } from '../../../src/extraction/BboxLocator.js';
import type { OcrPage, OcrWord } from '../../../src/extraction/OcrService.js';
import type { RenderedPage } from '../../../src/extraction/types.js';
import type { VlmIntakeForm } from '../../../src/schemas/VlmIntakeFormSchema.js';
import type { VlmLabPdf } from '../../../src/schemas/VlmLabPdfSchema.js';

function word(text: string, x: number, y: number, w: number, h: number, lineIndex: number, page = 0): OcrWord {
  return { page, text, x, y, w, h, lineIndex, confidence: 95 };
}

function page0(): RenderedPage {
  return {
    page: 0, pngBytes: Buffer.from('p'),
    imageWidth: 1000, imageHeight: 1400,
    originalWidth: 1000, originalHeight: 1400,
    trimOffsetLeft: 0, trimOffsetTop: 0,
  };
}

function trimmedPage(): RenderedPage {
  return {
    page: 0, pngBytes: Buffer.from('p'),
    // Trimmed image is 800×1000; original is 900×1100 with a 50px left
    // and 80px top dark border that sharp's trim() removed before OCR.
    imageWidth: 800, imageHeight: 1000,
    originalWidth: 900, originalHeight: 1100,
    trimOffsetLeft: 50, trimOffsetTop: 80,
  };
}

const blankLabBase: Omit<VlmLabPdf, 'patient_on_document' | 'results'> = {
  doc_type: 'lab_pdf',
  schema_version: '1',
  performing_lab: null,
  ordering_provider: null,
  collection_date_default: null,
  source_citation: { document_id: '1', page_count: 1 },
};

describe('BboxLocator — TIGHT mode (names)', () => {
  it('hugs only the name words on the matching line', () => {
    const ocr: OcrPage = {
      page: 0, imageWidth: 1000, imageHeight: 1400,
      lines: [
        {
          page: 0, text: 'Patient Name: Maria Reyes',
          x: 0, y: 50, w: 600, h: 24,
          words: [
            word('Patient', 0, 50, 100, 24, 0),
            word('Name:', 110, 50, 80, 24, 0),
            word('Maria', 200, 50, 90, 24, 0),
            word('Reyes', 300, 50, 100, 24, 0),
          ],
        },
      ],
      words: [],
    };
    const locator = new BboxLocator([ocr], [page0()]);

    const located = locator.locateLabPdf({
      ...blankLabBase,
      patient_on_document: { name: 'Maria Reyes' },
      results: [],
    });

    expect(located.patient_on_document?.bbox).toEqual({
      page: 0, x: 200, y: 50, w: 200, h: 24, image_w: 1000, image_h: 1400,
    });
  });

  it('returns a null bbox when no OCR words match the patient name', () => {
    // PatientOnDocumentSchema explicitly allows bbox: null — so when OCR
    // can't anchor the name we surface that as null rather than fabricating
    // a zero-area rectangle. The overlay viewer treats null and zero-area
    // identically (no highlight), but null preserves "we don't know".
    const ocr: OcrPage = {
      page: 0, imageWidth: 1000, imageHeight: 1400,
      lines: [{ page: 0, text: 'No match here', x: 0, y: 0, w: 100, h: 20, words: [
        word('No', 0, 0, 30, 20, 0),
        word('match', 35, 0, 50, 20, 0),
        word('here', 90, 0, 40, 20, 0),
      ] }],
      words: [],
    };
    const locator = new BboxLocator([ocr], [page0()]);

    const located = locator.locateLabPdf({
      ...blankLabBase,
      patient_on_document: { name: 'Maria Reyes' },
      results: [],
    });

    expect(located.patient_on_document).toEqual({ name: 'Maria Reyes', bbox: null });
  });

  it('translates trimmed-frame bboxes back into the original frame', () => {
    const ocr: OcrPage = {
      page: 0, imageWidth: 800, imageHeight: 1000,
      lines: [{ page: 0, text: 'Maria Reyes', x: 100, y: 50, w: 200, h: 24, words: [
        word('Maria', 100, 50, 90, 24, 0),
        word('Reyes', 200, 50, 100, 24, 0),
      ] }],
      words: [],
    };
    const locator = new BboxLocator([ocr], [trimmedPage()]);

    const located = locator.locateLabPdf({
      ...blankLabBase,
      patient_on_document: { name: 'Maria Reyes' },
      results: [],
    });

    // x shifts by trimOffsetLeft (50), y shifts by trimOffsetTop (80),
    // image_w/h become the original dims.
    expect(located.patient_on_document?.bbox).toEqual({
      page: 0, x: 150, y: 130, w: 200, h: 24, image_w: 900, image_h: 1100,
    });
  });
});

describe('BboxLocator — ROW mode (lab results)', () => {
  it('returns the full line bbox for the row, not just the matched cell', () => {
    const ocr: OcrPage = {
      page: 0, imageWidth: 1000, imageHeight: 1400,
      lines: [
        {
          page: 0, text: 'Hemoglobin A1c 7.8 % <5.7 H',
          x: 50, y: 200, w: 800, h: 24,
          words: [
            word('Hemoglobin', 50, 200, 150, 24, 0),
            word('A1c', 210, 200, 60, 24, 0),
            word('7.8', 400, 200, 60, 24, 0),
            word('%', 470, 200, 20, 24, 0),
            word('5.7', 550, 200, 60, 24, 0),
            word('H', 700, 200, 20, 24, 0),
          ],
        },
      ],
      words: [],
    };
    const locator = new BboxLocator([ocr], [page0()]);

    const located = locator.locateLabPdf({
      ...blankLabBase,
      patient_on_document: null,
      results: [
        {
          test_name: 'Hemoglobin A1c',
          loinc_code: null,
          numeric_value: 7.8,
          display_value: '7.8',
          unit: '%',
          reference_range: { low: null, high: 5.7, raw_text: '<5.7' },
          abnormal_flag: 'H',
          collection_date: null,
          vlm_confidence: 0.95,
          citation_confidence: 'unverifiable',
        },
      ],
    });

    expect(located.results[0]?.bbox).toEqual({
      page: 0, x: 50, y: 200, w: 800, h: 24, image_w: 1000, image_h: 1400,
    });
  });

  it('picks the line with the highest token-overlap when several lines partially match', () => {
    const ocr: OcrPage = {
      page: 0, imageWidth: 1000, imageHeight: 1400,
      lines: [
        // Line 0 — only "7.8" matches.
        { page: 0, text: 'Other 7.8 reading', x: 0, y: 100, w: 300, h: 24, words: [
          word('Other', 0, 100, 80, 24, 0),
          word('7.8', 90, 100, 50, 24, 0),
          word('reading', 150, 100, 100, 24, 0),
        ] },
        // Line 1 — "Hemoglobin" + "A1c" + "7.8" match (best score).
        { page: 0, text: 'Hemoglobin A1c 7.8', x: 50, y: 200, w: 400, h: 24, words: [
          word('Hemoglobin', 50, 200, 150, 24, 1),
          word('A1c', 210, 200, 60, 24, 1),
          word('7.8', 280, 200, 60, 24, 1),
        ] },
      ],
      words: [],
    };
    const locator = new BboxLocator([ocr], [page0()]);

    const located = locator.locateLabPdf({
      ...blankLabBase,
      patient_on_document: null,
      results: [
        {
          test_name: 'Hemoglobin A1c',
          loinc_code: null,
          numeric_value: 7.8,
          display_value: '7.8',
          unit: null,
          reference_range: { low: null, high: null, raw_text: '' },
          abnormal_flag: null,
          collection_date: null,
          vlm_confidence: 1,
          citation_confidence: 'unverifiable',
        },
      ],
    });

    expect(located.results[0]?.bbox.y).toBe(200);
    expect(located.results[0]?.bbox.w).toBe(400);
  });
});

describe('BboxLocator — intake form', () => {
  it('emits TIGHT bboxes for each demographic field_value', () => {
    const ocr: OcrPage = {
      page: 0, imageWidth: 1000, imageHeight: 1400,
      lines: [
        {
          page: 0, text: 'Name: Jane Doe', x: 0, y: 50, w: 300, h: 24,
          words: [
            word('Name:', 0, 50, 80, 24, 0),
            word('Jane', 90, 50, 80, 24, 0),
            word('Doe', 180, 50, 80, 24, 0),
          ],
        },
        {
          page: 0, text: 'DOB: 01/14/1982', x: 0, y: 80, w: 300, h: 24,
          words: [
            word('DOB:', 0, 80, 60, 24, 1),
            word('01/14/1982', 70, 80, 200, 24, 1),
          ],
        },
      ],
      words: [],
    };
    const locator = new BboxLocator([ocr], [page0()]);

    const intake: VlmIntakeForm = {
      doc_type: 'intake_form',
      schema_version: '1',
      demographics: {
        name: 'Jane Doe', dob: '1982-01-14', sex: null,
        field_values: { name: 'Jane Doe', dob: '01/14/1982' },
      },
      chief_concern: null,
      current_medications: [],
      allergies: [],
      family_history: [],
      source_citation: { document_id: '7', page_count: 1 },
    };
    const located = locator.locateIntakeForm(intake);

    // name → tight around "Jane Doe" (x=90 → x+w=260)
    expect(located.demographics.bbox_per_field['name']).toEqual({
      page: 0, x: 90, y: 50, w: 170, h: 24, image_w: 1000, image_h: 1400,
    });
    // dob → tight around the date token
    expect(located.demographics.bbox_per_field['dob']).toEqual({
      page: 0, x: 70, y: 80, w: 200, h: 24, image_w: 1000, image_h: 1400,
    });
  });

  it('emits ROW bboxes for medications, allergies, and family history', () => {
    const ocr: OcrPage = {
      page: 0, imageWidth: 1000, imageHeight: 1400,
      lines: [
        {
          page: 0, text: 'Lisinopril 10mg daily oral',
          x: 0, y: 100, w: 600, h: 24,
          words: [
            word('Lisinopril', 0, 100, 200, 24, 0),
            word('10mg', 210, 100, 100, 24, 0),
            word('daily', 320, 100, 100, 24, 0),
            word('oral', 430, 100, 100, 24, 0),
          ],
        },
        {
          page: 0, text: 'Penicillin rash severe',
          x: 0, y: 200, w: 500, h: 24,
          words: [
            word('Penicillin', 0, 200, 200, 24, 1),
            word('rash', 210, 200, 100, 24, 1),
            word('severe', 320, 200, 150, 24, 1),
          ],
        },
        {
          page: 0, text: 'mother diabetes hypertension',
          x: 0, y: 300, w: 600, h: 24,
          words: [
            word('mother', 0, 300, 100, 24, 2),
            word('diabetes', 110, 300, 200, 24, 2),
            word('hypertension', 320, 300, 250, 24, 2),
          ],
        },
      ],
      words: [],
    };
    const locator = new BboxLocator([ocr], [page0()]);

    const located = locator.locateIntakeForm({
      doc_type: 'intake_form',
      schema_version: '1',
      demographics: { name: null, dob: null, sex: null, field_values: {} },
      chief_concern: null,
      current_medications: [
        { name: 'Lisinopril', dose: '10mg', frequency: 'daily', route: 'oral', is_otc_or_supplement: false },
      ],
      allergies: [
        { substance: 'Penicillin', reaction: 'rash', severity: 'severe' },
      ],
      family_history: [
        { relation: 'mother', conditions: ['diabetes', 'hypertension'] },
      ],
      source_citation: { document_id: '7', page_count: 1 },
    });

    expect(located.current_medications[0]?.bbox.y).toBe(100);
    expect(located.current_medications[0]?.bbox.w).toBe(600);
    expect(located.allergies[0]?.bbox.y).toBe(200);
    expect(located.allergies[0]?.bbox.w).toBe(500);
    expect(located.family_history[0]?.bbox.y).toBe(300);
    expect(located.family_history[0]?.bbox.w).toBe(600);
  });
});
