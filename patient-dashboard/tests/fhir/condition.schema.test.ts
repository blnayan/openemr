import { describe, expect, it } from 'vitest';

import { parseCondition } from '../../src/fhir/schemas/condition';

const HYPERTENSION = {
  resourceType: 'Condition',
  id: 'c1',
  clinicalStatus: {
    coding: [
      {
        system: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
        code: 'active',
      },
    ],
  },
  verificationStatus: {
    coding: [
      {
        system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status',
        code: 'confirmed',
      },
    ],
  },
  code: {
    coding: [
      {
        system: 'http://snomed.info/sct',
        code: '38341003',
        display: 'Hypertension',
      },
    ],
  },
  recordedDate: '2024-01-15',
};

describe('parseCondition', () => {
  it('projects a well-formed FHIR Condition into a ConditionDTO', () => {
    expect(parseCondition(HYPERTENSION)).toEqual({
      id: 'c1',
      name: 'Hypertension',
      clinicalStatus: 'active',
      verificationStatus: 'confirmed',
      recordedDate: '2024-01-15',
    });
  });

  it('falls back to code.text when no coding[].display is present', () => {
    const dto = parseCondition({
      ...HYPERTENSION,
      code: { text: 'Asthma' },
    });
    expect(dto.name).toBe('Asthma');
  });

  it('returns empty name when code is absent', () => {
    const { code, ...rest } = HYPERTENSION;
    void code;
    const dto = parseCondition(rest);
    expect(dto.name).toBe('');
  });

  it('returns null clinicalStatus when omitted (legacy rows)', () => {
    const { clinicalStatus, ...rest } = HYPERTENSION;
    void clinicalStatus;
    const dto = parseCondition(rest);
    expect(dto.clinicalStatus).toBeNull();
  });

  it('returns null verificationStatus when omitted', () => {
    const { verificationStatus, ...rest } = HYPERTENSION;
    void verificationStatus;
    const dto = parseCondition(rest);
    expect(dto.verificationStatus).toBeNull();
  });

  it('returns null recordedDate when omitted', () => {
    const { recordedDate, ...rest } = HYPERTENSION;
    void recordedDate;
    const dto = parseCondition(rest);
    expect(dto.recordedDate).toBeNull();
  });

  it('skips coding entries with empty display and falls through to text', () => {
    const dto = parseCondition({
      ...HYPERTENSION,
      code: {
        coding: [{ system: 'http://x', code: 'y' /* no display */ }],
        text: 'Fallback Condition',
      },
    });
    expect(dto.name).toBe('Fallback Condition');
  });

  it('throws on the wrong resourceType', () => {
    expect(() =>
      parseCondition({ ...HYPERTENSION, resourceType: 'Patient' }),
    ).toThrow();
  });

  it('throws when id is missing', () => {
    const { id, ...rest } = HYPERTENSION;
    void id;
    expect(() => parseCondition(rest)).toThrow();
  });

  it('tolerates resolved / inactive clinicalStatus codes (filtering is in the hook)', () => {
    const dto = parseCondition({
      ...HYPERTENSION,
      clinicalStatus: { coding: [{ code: 'resolved' }] },
    });
    expect(dto.clinicalStatus).toBe('resolved');
  });
});
