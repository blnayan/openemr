import { describe, expect, it } from 'vitest';

import { parsePatient } from '../../src/fhir/schemas/patient';

const margaretChen = {
  resourceType: 'Patient',
  id: '9b9da0b6-1234-4abc-9def-cafef00d0001',
  active: true,
  name: [
    {
      use: 'official',
      family: 'Chen',
      given: ['Margaret', 'L.'],
    },
  ],
  gender: 'female',
  birthDate: '1962-03-14',
  identifier: [
    {
      use: 'official',
      type: {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/v2-0203',
            code: 'PT',
          },
        ],
      },
      system: 'http://terminology.hl7.org/CodeSystem/v2-0203',
      value: '00012847',
    },
  ],
};

describe('parsePatient', () => {
  it('projects a well-formed FHIR Patient into a PatientDTO', () => {
    const dto = parsePatient(margaretChen);

    expect(dto).toEqual({
      id: '9b9da0b6-1234-4abc-9def-cafef00d0001',
      name: 'Margaret L. Chen',
      given: 'Margaret L.',
      family: 'Chen',
      birthDate: '1962-03-14',
      gender: 'female',
      mrn: '00012847',
      active: true,
    });
  });

  it('defaults active=true when FHIR omits the field', () => {
    const { active, ...rest } = margaretChen;
    void active;
    const dto = parsePatient(rest);
    expect(dto.active).toBe(true);
  });

  it('falls back to the first identifier when no PT-coded one exists', () => {
    const dto = parsePatient({
      ...margaretChen,
      identifier: [{ value: 'fallback-id-1' }],
    });
    expect(dto.mrn).toBe('fallback-id-1');
  });

  it('returns empty mrn when identifier list is missing', () => {
    const { identifier, ...rest } = margaretChen;
    void identifier;
    const dto = parsePatient(rest);
    expect(dto.mrn).toBe('');
  });

  it('throws on a missing resourceType', () => {
    expect(() => parsePatient({ ...margaretChen, resourceType: 'Bundle' })).toThrow();
  });

  it('throws on a missing id', () => {
    const { id, ...rest } = margaretChen;
    void id;
    expect(() => parsePatient(rest)).toThrow();
  });

  it('throws on a non-string given name in the array', () => {
    expect(() =>
      parsePatient({
        ...margaretChen,
        name: [{ family: 'Chen', given: ['Margaret', 42] }],
      }),
    ).toThrow();
  });

  it('handles a missing name array gracefully', () => {
    const { name, ...rest } = margaretChen;
    void name;
    const dto = parsePatient(rest);
    expect(dto.name).toBe('');
    expect(dto.given).toBe('');
    expect(dto.family).toBe('');
  });
});
