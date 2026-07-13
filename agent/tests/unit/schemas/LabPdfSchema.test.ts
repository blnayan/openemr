/**
 * LabPdfSchema unit tests — schema validation only. Tests the public
 * Zod parse contract: well-formed payloads succeed, malformed payloads
 * fail with errors at the expected paths. Tests are deliberately
 * exhaustive on negative cases since the strict-schema-validates rubric
 * in the eval gate depends on this contract holding.
 */

import { describe, expect, it } from 'vitest';
import {
  LabPdfSchema,
  LabResultSchema,
  ReferenceRangeSchema,
  LAB_PDF_SCHEMA_VERSION,
} from '../../../src/schemas/LabPdfSchema.js';

const validBbox = {
  page: 0,
  x: 100,
  y: 200,
  w: 80,
  h: 24,
  image_w: 1000,
  image_h: 1400,
};

const validResult = {
  test_name: 'Hemoglobin A1c',
  loinc_code: '4548-4',
  numeric_value: 7.8,
  display_value: '7.8',
  unit: '%',
  reference_range: { low: null, high: 5.7, raw_text: '<5.7' },
  abnormal_flag: 'H',
  collection_date: '2026-04-15T08:30:00.000Z',
  bbox: validBbox,
  vlm_confidence: 0.92,
  citation_confidence: 'verified',
};

const validLabPdf = {
  doc_type: 'lab_pdf',
  schema_version: LAB_PDF_SCHEMA_VERSION,
  performing_lab: 'Quest Diagnostics',
  ordering_provider: 'Dr. Reyes',
  collection_date_default: '2026-04-15T08:30:00.000Z',
  patient_on_document: { name: 'Maria Reyes', bbox: validBbox },
  results: [validResult],
  source_citation: { document_id: 'doc_42', page_count: 1 },
};

describe('LabPdfSchema', () => {
  describe('happy paths', () => {
    it('parses a well-formed lab payload', () => {
      const parsed = LabPdfSchema.parse(validLabPdf);
      expect(parsed.doc_type).toBe('lab_pdf');
      expect(parsed.schema_version).toBe('1');
      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0]?.test_name).toBe('Hemoglobin A1c');
    });

    it('accepts a qualitative result with null numeric_value', () => {
      const qualitative = {
        ...validResult,
        test_name: 'Strep A culture',
        numeric_value: null,
        display_value: 'Negative',
        unit: null,
      };
      expect(() => LabResultSchema.parse(qualitative)).not.toThrow();
    });

    it('accepts a result with null collection_date (uses document default)', () => {
      const r = { ...validResult, collection_date: null };
      expect(() => LabResultSchema.parse(r)).not.toThrow();
    });

    it('accepts a result with no LOINC code', () => {
      const r = { ...validResult, loinc_code: null };
      expect(() => LabResultSchema.parse(r)).not.toThrow();
    });

    it('accepts a reference range with non-numeric raw_text', () => {
      const range = { low: null, high: null, raw_text: 'See report' };
      expect(() => ReferenceRangeSchema.parse(range)).not.toThrow();
    });

    it('accepts an empty results list (e.g. unreadable scan)', () => {
      expect(() => LabPdfSchema.parse({ ...validLabPdf, results: [] })).not.toThrow();
    });

    it('accepts null patient_on_document when name was unreadable', () => {
      expect(() => LabPdfSchema.parse({ ...validLabPdf, patient_on_document: null })).not.toThrow();
    });
  });

  describe('rejections', () => {
    it('rejects a wrong doc_type literal', () => {
      const bad = { ...validLabPdf, doc_type: 'intake_form' };
      expect(() => LabPdfSchema.parse(bad)).toThrow(/doc_type/);
    });

    it('rejects an unsupported schema_version', () => {
      const bad = { ...validLabPdf, schema_version: '2' };
      expect(() => LabPdfSchema.parse(bad)).toThrow(/schema_version/);
    });

    it('rejects a result with a non-FHIR abnormal flag', () => {
      const bad = { ...validResult, abnormal_flag: 'WEIRD' };
      expect(() => LabResultSchema.parse(bad)).toThrow(/abnormal_flag/);
    });

    it('rejects vlm_confidence outside [0, 1]', () => {
      const bad = { ...validResult, vlm_confidence: 1.5 };
      expect(() => LabResultSchema.parse(bad)).toThrow(/vlm_confidence/);
    });

    it('rejects an unknown citation_confidence label', () => {
      const bad = { ...validResult, citation_confidence: 'maybe' };
      expect(() => LabResultSchema.parse(bad)).toThrow(/citation_confidence/);
    });

    it('rejects empty test_name', () => {
      const bad = { ...validResult, test_name: '' };
      expect(() => LabResultSchema.parse(bad)).toThrow(/test_name/);
    });

    it('rejects empty display_value', () => {
      const bad = { ...validResult, display_value: '' };
      expect(() => LabResultSchema.parse(bad)).toThrow(/display_value/);
    });

    it('rejects bbox with negative coordinates', () => {
      const bad = { ...validResult, bbox: { ...validBbox, x: -1 } };
      expect(() => LabResultSchema.parse(bad)).toThrow(/x/);
    });

    it('rejects collection_date that is not ISO datetime', () => {
      const bad = { ...validResult, collection_date: '2026-04-15' };
      expect(() => LabResultSchema.parse(bad)).toThrow(/collection_date/);
    });

    it('rejects when source_citation.page_count is zero', () => {
      const bad = {
        ...validLabPdf,
        source_citation: { document_id: 'doc_42', page_count: 0 },
      };
      expect(() => LabPdfSchema.parse(bad)).toThrow(/page_count/);
    });
  });
});
