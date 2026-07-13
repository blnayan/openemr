import { describe, expect, it } from 'vitest';

import { parseAllergy } from '../../src/fhir/schemas/allergyIntolerance';

const PENICILLIN = {
  resourceType: 'AllergyIntolerance',
  id: 'a1',
  criticality: 'high',
  clinicalStatus: {
    coding: [
      {
        system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical',
        code: 'active',
      },
    ],
  },
  code: {
    coding: [
      {
        system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
        code: '7980',
        display: 'Penicillin',
      },
    ],
  },
  reaction: [
    {
      manifestation: [{ text: 'Hives' }],
      severity: 'severe',
    },
  ],
};

describe('parseAllergy', () => {
  it('projects a well-formed FHIR AllergyIntolerance into an AllergyDTO', () => {
    expect(parseAllergy(PENICILLIN)).toEqual({
      id: 'a1',
      name: 'Penicillin',
      criticality: 'high',
      reactionSeverity: 'severe',
      clinicalStatus: 'active',
    });
  });

  it('falls back to code.text when no coding[].display is present', () => {
    const dto = parseAllergy({
      ...PENICILLIN,
      code: { text: 'Sulfa drugs' },
    });
    expect(dto.name).toBe('Sulfa drugs');
  });

  it('returns empty name when code is absent', () => {
    const { code, ...rest } = PENICILLIN;
    void code;
    const dto = parseAllergy(rest);
    expect(dto.name).toBe('');
  });

  it('returns null criticality when omitted', () => {
    const { criticality, ...rest } = PENICILLIN;
    void criticality;
    const dto = parseAllergy(rest);
    expect(dto.criticality).toBeNull();
  });

  it('returns null reactionSeverity when reaction array is empty', () => {
    const dto = parseAllergy({ ...PENICILLIN, reaction: [] });
    expect(dto.reactionSeverity).toBeNull();
  });

  it('returns null reactionSeverity when reaction is omitted', () => {
    const { reaction, ...rest } = PENICILLIN;
    void reaction;
    const dto = parseAllergy(rest);
    expect(dto.reactionSeverity).toBeNull();
  });

  it('uses the first reaction’s severity', () => {
    const dto = parseAllergy({
      ...PENICILLIN,
      reaction: [{ severity: 'mild' }, { severity: 'severe' }],
    });
    expect(dto.reactionSeverity).toBe('mild');
  });

  it('returns null clinicalStatus when omitted (legacy rows)', () => {
    const { clinicalStatus, ...rest } = PENICILLIN;
    void clinicalStatus;
    const dto = parseAllergy(rest);
    expect(dto.clinicalStatus).toBeNull();
  });

  it('throws on the wrong resourceType', () => {
    expect(() => parseAllergy({ ...PENICILLIN, resourceType: 'Patient' })).toThrow();
  });

  it('throws when id is missing', () => {
    const { id, ...rest } = PENICILLIN;
    void id;
    expect(() => parseAllergy(rest)).toThrow();
  });

  it('skips coding entries with empty display and falls through to text', () => {
    const dto = parseAllergy({
      ...PENICILLIN,
      code: {
        coding: [{ system: 'http://x', code: 'y' /* no display */ }],
        text: 'Fallback Allergen',
      },
    });
    expect(dto.name).toBe('Fallback Allergen');
  });

  // Regression: issue #36. OpenEMR's FHIR server serializes the
  // "no severity recorded" case as a literal JSON `null` for `criticality`,
  // not by omitting the key. The same applies to other optional fields the
  // PHP serializer emits — `null` must round-trip through Zod without
  // throwing or the entire Allergies card renders the error state.
  // The shape below is the actual on-the-wire body captured from
  // /apis/default/fhir/AllergyIntolerance for the seeded demo patient,
  // sanitized to remove patient/uuid identifiers.
  it('parses the real OpenEMR response shape with criticality: null', () => {
    const realShape = {
      id: 'aaaa1111-1111-1111-1111-111111111111',
      meta: {
        versionId: '1',
        lastUpdated: '2026-05-07T20:24:29+00:00',
      },
      resourceType: 'AllergyIntolerance',
      text: {
        status: 'additional',
        div: '<div xmlns=\'http://www.w3.org/1999/xhtml\'>shellfish</div>',
      },
      clinicalStatus: {
        coding: [
          {
            system:
              'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical',
            code: 'active',
            display: 'Active',
          },
        ],
      },
      verificationStatus: {
        coding: [
          {
            system:
              'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification',
            code: 'unconfirmed',
            display: 'Unconfirmed',
          },
        ],
      },
      category: ['medication'],
      // The bug: this used to be `criticality: z.string().optional()`, which
      // rejects literal null. The server emits null when `severity_al` was
      // never set on the underlying allergy row.
      criticality: null,
      code: {
        coding: [
          {
            system:
              'http://terminology.hl7.org/CodeSystem/data-absent-reason',
            code: 'unknown',
            display: 'Unknown',
          },
        ],
      },
      patient: {
        reference: 'Patient/bbbb2222-2222-2222-2222-222222222222',
      },
      reaction: [{ manifestation: [{ text: '' }] }],
    };
    expect(() => parseAllergy(realShape)).not.toThrow();
    const dto = parseAllergy(realShape);
    expect(dto.criticality).toBeNull();
    // Issue #38: the data-absent-reason "Unknown" coding must be skipped,
    // and the real allergen name pulled from `text.div`'s narrative wrapper.
    expect(dto.name).toBe('shellfish');
    expect(dto.clinicalStatus).toBe('active');
    expect(dto.reactionSeverity).toBeNull();
  });

  // Issue #38 fixtures — OpenEMR's PHP mapper substitutes a data-absent-reason
  // placeholder coding when no SNOMED/RxNorm is on file, parking the real
  // allergen name in `text.div`. The schema must skip the placeholder and
  // fall back to the narrative.
  it('skips data-absent-reason coding and reads narrative text.div (Penicillin)', () => {
    const dto = parseAllergy({
      resourceType: 'AllergyIntolerance',
      id: 'a-data-absent-with-narrative',
      criticality: 'low',
      clinicalStatus: { coding: [{ code: 'active' }] },
      code: {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/data-absent-reason',
            code: 'unknown',
            display: 'Unknown',
          },
        ],
      },
      text: {
        status: 'additional',
        div: "<div xmlns='http://www.w3.org/1999/xhtml'>Penicillin</div>",
      },
    });
    expect(dto.name).toBe('Penicillin');
  });

  it('returns empty name when data-absent coding has no narrative fallback', () => {
    const dto = parseAllergy({
      resourceType: 'AllergyIntolerance',
      id: 'a-data-absent-no-narrative',
      code: {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/data-absent-reason',
            code: 'unknown',
            display: 'Unknown',
          },
        ],
      },
    });
    // The card consumer renders "(unnamed allergen)" for empty name.
    expect(dto.name).toBe('');
  });

  it('uses real coding[0].display when system is not data-absent-reason', () => {
    const dto = parseAllergy({
      resourceType: 'AllergyIntolerance',
      id: 'a-real-coding',
      code: {
        coding: [
          {
            system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
            code: '7980',
            display: 'Penicillin',
          },
        ],
        // Even with a narrative present, the real coded display wins.
        text: undefined,
      },
      text: {
        status: 'additional',
        div: "<div xmlns='http://www.w3.org/1999/xhtml'>ignored</div>",
      },
    });
    expect(dto.name).toBe('Penicillin');
  });

  it('handles narrative div with question marks and special chars verbatim', () => {
    const dto = parseAllergy({
      resourceType: 'AllergyIntolerance',
      id: 'a-narrative-special',
      code: {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/data-absent-reason',
            code: 'unknown',
            display: 'Unknown',
          },
        ],
      },
      text: {
        status: 'additional',
        div: "<div xmlns='http://www.w3.org/1999/xhtml'>shellfish?? maybe iodine</div>",
      },
    });
    expect(dto.name).toBe('shellfish?? maybe iodine');
  });

  it('returns empty name when narrative text.div is itself empty', () => {
    const dto = parseAllergy({
      resourceType: 'AllergyIntolerance',
      id: 'a-empty-narrative',
      code: {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/data-absent-reason',
            code: 'unknown',
            display: 'Unknown',
          },
        ],
      },
      text: {
        status: 'additional',
        div: "<div xmlns='http://www.w3.org/1999/xhtml'></div>",
      },
    });
    expect(dto.name).toBe('');
  });

  it('tolerates literal null on every nullish-allowed field', () => {
    const dto = parseAllergy({
      resourceType: 'AllergyIntolerance',
      id: 'a-null-shaped',
      criticality: null,
      clinicalStatus: null,
      verificationStatus: null,
      code: null,
      reaction: null,
    });
    expect(dto).toEqual({
      id: 'a-null-shaped',
      name: '',
      criticality: null,
      reactionSeverity: null,
      clinicalStatus: null,
    });
  });
});
