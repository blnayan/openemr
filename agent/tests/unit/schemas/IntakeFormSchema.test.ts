/**
 * IntakeFormSchema unit tests — schema validation only.
 */

import { describe, expect, it } from 'vitest';
import {
  IntakeFormSchema,
  IntakeMedicationSchema,
  FamilyHistoryEntrySchema,
  IntakeAllergySchema,
  INTAKE_FORM_SCHEMA_VERSION,
} from '../../../src/schemas/IntakeFormSchema.js';

const validBbox = {
  page: 0,
  x: 100,
  y: 200,
  w: 80,
  h: 24,
  image_w: 1000,
  image_h: 1400,
};

const validMedication = {
  name: 'Metformin',
  dose: '500 mg',
  frequency: 'twice daily',
  route: 'oral',
  is_otc_or_supplement: false,
  bbox: validBbox,
};

const validAllergy = {
  substance: 'Penicillin',
  reaction: 'Hives',
  severity: 'moderate',
  bbox: validBbox,
};

const validFamilyHistory = {
  relation: 'mother',
  conditions: ['Type 2 diabetes', 'Hypertension'],
  bbox: validBbox,
};

const validIntakeForm = {
  doc_type: 'intake_form',
  schema_version: INTAKE_FORM_SCHEMA_VERSION,
  demographics: {
    name: 'Maria Reyes',
    dob: '1980-07-22',
    sex: 'F',
    bbox_per_field: { name: validBbox, dob: validBbox, sex: validBbox },
  },
  chief_concern: { text: 'Blurred vision and fatigue', bbox: validBbox },
  current_medications: [validMedication],
  allergies: [validAllergy],
  family_history: [validFamilyHistory],
  source_citation: { document_id: 'doc_43', page_count: 1 },
};

describe('IntakeFormSchema', () => {
  describe('happy paths', () => {
    it('parses a well-formed intake form', () => {
      const parsed = IntakeFormSchema.parse(validIntakeForm);
      expect(parsed.doc_type).toBe('intake_form');
      expect(parsed.schema_version).toBe('1');
      expect(parsed.current_medications).toHaveLength(1);
    });

    it('accepts a null chief_concern (field present but blank)', () => {
      const ok = { ...validIntakeForm, chief_concern: null };
      expect(() => IntakeFormSchema.parse(ok)).not.toThrow();
    });

    it('accepts empty arrays for meds, allergies, family history', () => {
      const ok = {
        ...validIntakeForm,
        current_medications: [],
        allergies: [],
        family_history: [],
      };
      expect(() => IntakeFormSchema.parse(ok)).not.toThrow();
    });

    it('accepts demographics with nullable name/dob/sex', () => {
      const ok = {
        ...validIntakeForm,
        demographics: {
          name: null,
          dob: null,
          sex: null,
          bbox_per_field: {},
        },
      };
      expect(() => IntakeFormSchema.parse(ok)).not.toThrow();
    });

    it('accepts allergy with null severity', () => {
      const ok = { ...validAllergy, severity: null };
      expect(() => IntakeAllergySchema.parse(ok)).not.toThrow();
    });

    it('accepts is_otc_or_supplement true for a supplement', () => {
      const ok = { ...validMedication, name: 'Vitamin D', is_otc_or_supplement: true };
      expect(() => IntakeMedicationSchema.parse(ok)).not.toThrow();
    });

    it('accepts the "other" relation enum value', () => {
      const ok = { ...validFamilyHistory, relation: 'other' };
      expect(() => FamilyHistoryEntrySchema.parse(ok)).not.toThrow();
    });
  });

  describe('rejections', () => {
    it('rejects a wrong doc_type', () => {
      const bad = { ...validIntakeForm, doc_type: 'lab_pdf' };
      expect(() => IntakeFormSchema.parse(bad)).toThrow(/doc_type/);
    });

    it('rejects unsupported schema_version', () => {
      const bad = { ...validIntakeForm, schema_version: '2' };
      expect(() => IntakeFormSchema.parse(bad)).toThrow(/schema_version/);
    });

    it('rejects unknown relation values', () => {
      const bad = { ...validFamilyHistory, relation: 'cousin' };
      expect(() => FamilyHistoryEntrySchema.parse(bad)).toThrow(/relation/);
    });

    it('rejects unknown severity values', () => {
      const bad = { ...validAllergy, severity: 'extreme' };
      expect(() => IntakeAllergySchema.parse(bad)).toThrow(/severity/);
    });

    it('rejects empty medication name', () => {
      const bad = { ...validMedication, name: '' };
      expect(() => IntakeMedicationSchema.parse(bad)).toThrow(/name/);
    });

    it('rejects empty allergy substance', () => {
      const bad = { ...validAllergy, substance: '' };
      expect(() => IntakeAllergySchema.parse(bad)).toThrow(/substance/);
    });

    it('rejects malformed dob (not ISO date)', () => {
      const bad = {
        ...validIntakeForm,
        demographics: { ...validIntakeForm.demographics, dob: '07/22/1980' },
      };
      expect(() => IntakeFormSchema.parse(bad)).toThrow(/dob/);
    });

    it('rejects empty chief_concern.text when not null', () => {
      const bad = { ...validIntakeForm, chief_concern: { text: '', bbox: validBbox } };
      expect(() => IntakeFormSchema.parse(bad)).toThrow(/text/);
    });
  });
});
