/**
 * CitationSchema unit tests — discriminated-union round-trips for the
 * three source types defined in W2_PRD §"Citation contract".
 */

import { describe, it, expect } from 'vitest';
import {
  CitationSchema,
  GuidelineCitationSchema,
  PatientDocumentCitationSchema,
  PatientRecordCitationSchema,
} from '../../../src/schemas/CitationSchema.js';

describe('CitationSchema', () => {
  describe('guideline', () => {
    it('accepts a fully-populated guideline citation', () => {
      const c = {
        type: 'guideline' as const,
        chunk_id: 'ada-2026-6.3a',
        source: 'ADA Standards of Care in Diabetes—2026',
        section_id: '6.3a',
        quoted_span: 'An A1C goal of <7%',
        rerank_score: 0.91,
      };
      expect(CitationSchema.safeParse(c).success).toBe(true);
      expect(GuidelineCitationSchema.parse(c).chunk_id).toBe('ada-2026-6.3a');
    });

    it('accepts a guideline citation without rerank_score (optional)', () => {
      const c = {
        type: 'guideline' as const,
        chunk_id: 'k',
        source: 's',
        section_id: '1.0',
        quoted_span: 'q',
      };
      expect(CitationSchema.safeParse(c).success).toBe(true);
    });

    it('rejects empty quoted_span', () => {
      const c = {
        type: 'guideline' as const,
        chunk_id: 'k',
        source: 's',
        section_id: '1.0',
        quoted_span: '',
      };
      expect(CitationSchema.safeParse(c).success).toBe(false);
    });

    it('rejects missing chunk_id', () => {
      const c = { type: 'guideline', source: 's', section_id: '1.0', quoted_span: 'q' };
      expect(CitationSchema.safeParse(c).success).toBe(false);
    });
  });

  describe('patient_document', () => {
    it('accepts a fully-populated patient_document citation', () => {
      const c = {
        type: 'patient_document' as const,
        extraction_id: 'ext-1',
        document_id: 'doc-7',
        bbox: { page: 0, x: 10, y: 20, w: 100, h: 30, image_w: 1000, image_h: 1500 },
        citation_confidence: 0.86,
      };
      expect(CitationSchema.safeParse(c).success).toBe(true);
      expect(PatientDocumentCitationSchema.parse(c).bbox.page).toBe(0);
    });

    it('rejects citation_confidence outside [0,1]', () => {
      const c = {
        type: 'patient_document' as const,
        extraction_id: 'ext-1',
        bbox: { page: 0, x: 0, y: 0, w: 1, h: 1, image_w: 100, image_h: 100 },
        citation_confidence: 1.5,
      };
      expect(CitationSchema.safeParse(c).success).toBe(false);
    });

    it('rejects missing bbox', () => {
      const c = {
        type: 'patient_document',
        extraction_id: 'ext-1',
        citation_confidence: 0.5,
      };
      expect(CitationSchema.safeParse(c).success).toBe(false);
    });
  });

  describe('patient_record', () => {
    it('accepts tool:<name>:row-<n> citation_id', () => {
      const c = { type: 'patient_record' as const, citation_id: 'tool:get_medications:row-0' };
      expect(CitationSchema.safeParse(c).success).toBe(true);
      expect(PatientRecordCitationSchema.parse(c).citation_id).toMatch(/^tool:/);
    });

    it('accepts rule:<category>:<id> citation_id', () => {
      const c = { type: 'patient_record' as const, citation_id: 'rule:ddi:warfarin-ibuprofen' };
      expect(CitationSchema.safeParse(c).success).toBe(true);
    });

    it('rejects freeform citation_id', () => {
      const c = { type: 'patient_record', citation_id: 'just-some-string' };
      expect(CitationSchema.safeParse(c).success).toBe(false);
    });
  });

  describe('discriminator', () => {
    it('rejects unknown type', () => {
      expect(CitationSchema.safeParse({ type: 'something_else' }).success).toBe(false);
    });

    it('round-trips a mixed array of all three types', () => {
      const arr = [
        {
          type: 'guideline' as const,
          chunk_id: 'k',
          source: 's',
          section_id: '1.0',
          quoted_span: 'q',
        },
        {
          type: 'patient_document' as const,
          extraction_id: 'e',
          bbox: { page: 0, x: 0, y: 0, w: 1, h: 1, image_w: 100, image_h: 100 },
          citation_confidence: 0.5,
        },
        { type: 'patient_record' as const, citation_id: 'tool:get_labs:row-1' },
      ];
      for (const c of arr) {
        expect(CitationSchema.safeParse(c).success).toBe(true);
      }
    });
  });
});
