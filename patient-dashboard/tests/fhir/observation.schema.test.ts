import { describe, expect, it } from 'vitest';

import { parseObservation } from '../../src/fhir/schemas/observation';

const A1C_HIGH = {
  resourceType: 'Observation',
  id: 'obs1',
  status: 'final',
  code: {
    coding: [
      {
        system: 'http://loinc.org',
        code: '4548-4',
        display: 'Hemoglobin A1c',
      },
    ],
  },
  valueQuantity: {
    value: 7.4,
    unit: '%',
    system: 'http://unitsofmeasure.org',
    code: '%',
  },
  interpretation: [
    {
      coding: [
        {
          system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
          code: 'H',
          display: 'High',
        },
      ],
    },
  ],
  referenceRange: [
    {
      low: { value: 4.0, unit: '%' },
      high: { value: 5.6, unit: '%' },
    },
  ],
  effectiveDateTime: '2024-03-12',
};

describe('parseObservation', () => {
  it('projects a well-formed FHIR Observation into a LabObservationDTO', () => {
    expect(parseObservation(A1C_HIGH)).toEqual({
      id: 'obs1',
      name: 'Hemoglobin A1c',
      valueDisplay: '7.4 %',
      flag: 'high',
      referenceRange: '4-5.6 %',
      effectiveDateTime: '2024-03-12',
      status: 'final',
    });
  });

  it('falls back to code.text when no coding[].display is present', () => {
    const dto = parseObservation({
      ...A1C_HIGH,
      code: { text: 'A1c (text fallback)' },
    });
    expect(dto.name).toBe('A1c (text fallback)');
  });

  it('returns empty name when code is absent', () => {
    const { code, ...rest } = A1C_HIGH;
    void code;
    const dto = parseObservation(rest);
    expect(dto.name).toBe('');
  });

  it('uses valueString when valueQuantity is absent', () => {
    const { valueQuantity, ...rest } = A1C_HIGH;
    void valueQuantity;
    const dto = parseObservation({
      ...rest,
      valueString: 'Negative',
    });
    expect(dto.valueDisplay).toBe('Negative');
  });

  it('uses valueCodeableConcept.coding[0].display when no quantity or string', () => {
    const { valueQuantity, ...rest } = A1C_HIGH;
    void valueQuantity;
    const dto = parseObservation({
      ...rest,
      valueCodeableConcept: {
        coding: [{ display: 'Reactive' }],
      },
    });
    expect(dto.valueDisplay).toBe('Reactive');
  });

  it('uses valueCodeableConcept.text as a final fallback', () => {
    const { valueQuantity, ...rest } = A1C_HIGH;
    void valueQuantity;
    const dto = parseObservation({
      ...rest,
      valueCodeableConcept: { text: 'Detected' },
    });
    expect(dto.valueDisplay).toBe('Detected');
  });

  it('returns "(no value)" placeholder when no value form is present', () => {
    const { valueQuantity, ...rest } = A1C_HIGH;
    void valueQuantity;
    const dto = parseObservation(rest);
    expect(dto.valueDisplay).toBe('(no value)');
  });

  it('formats valueQuantity without a unit when unit is absent', () => {
    const dto = parseObservation({
      ...A1C_HIGH,
      valueQuantity: { value: 42 },
    });
    expect(dto.valueDisplay).toBe('42');
  });

  it('flag is "normal" when interpretation is missing', () => {
    const { interpretation, ...rest } = A1C_HIGH;
    void interpretation;
    const dto = parseObservation(rest);
    expect(dto.flag).toBe('normal');
  });

  it('flag is "low" when interpretation code is L', () => {
    const dto = parseObservation({
      ...A1C_HIGH,
      interpretation: [{ coding: [{ code: 'L' }] }],
    });
    expect(dto.flag).toBe('low');
  });

  it('flag is "abnormal" when interpretation code is A', () => {
    const dto = parseObservation({
      ...A1C_HIGH,
      interpretation: [{ coding: [{ code: 'A' }] }],
    });
    expect(dto.flag).toBe('abnormal');
  });

  it('flag is "normal" when interpretation code is N', () => {
    const dto = parseObservation({
      ...A1C_HIGH,
      interpretation: [{ coding: [{ code: 'N' }] }],
    });
    expect(dto.flag).toBe('normal');
  });

  it('flag is "normal" when interpretation has only unrecognized codes', () => {
    const dto = parseObservation({
      ...A1C_HIGH,
      interpretation: [{ coding: [{ code: 'B' }] }],
    });
    expect(dto.flag).toBe('normal');
  });

  it('returns null referenceRange when omitted', () => {
    const { referenceRange, ...rest } = A1C_HIGH;
    void referenceRange;
    const dto = parseObservation(rest);
    expect(dto.referenceRange).toBeNull();
  });

  it('uses referenceRange[0].text when present', () => {
    const dto = parseObservation({
      ...A1C_HIGH,
      referenceRange: [
        {
          text: '< 5.7 %',
          low: { value: 4.0, unit: '%' },
          high: { value: 5.6, unit: '%' },
        },
      ],
    });
    expect(dto.referenceRange).toBe('< 5.7 %');
  });

  it('formats reference range with only a low bound as ">= ..."', () => {
    const dto = parseObservation({
      ...A1C_HIGH,
      referenceRange: [{ low: { value: 4.0, unit: '%' } }],
    });
    expect(dto.referenceRange).toBe('>= 4 %');
  });

  it('formats reference range with only a high bound as "<= ..."', () => {
    const dto = parseObservation({
      ...A1C_HIGH,
      referenceRange: [{ high: { value: 5.6, unit: '%' } }],
    });
    expect(dto.referenceRange).toBe('<= 5.6 %');
  });

  it('returns null effectiveDateTime when omitted', () => {
    const { effectiveDateTime, ...rest } = A1C_HIGH;
    void effectiveDateTime;
    const dto = parseObservation(rest);
    expect(dto.effectiveDateTime).toBeNull();
  });

  it('returns null status when omitted', () => {
    const { status, ...rest } = A1C_HIGH;
    void status;
    const dto = parseObservation(rest);
    expect(dto.status).toBeNull();
  });

  it('throws on the wrong resourceType', () => {
    expect(() =>
      parseObservation({ ...A1C_HIGH, resourceType: 'Patient' }),
    ).toThrow();
  });

  it('throws when id is missing', () => {
    const { id, ...rest } = A1C_HIGH;
    void id;
    expect(() => parseObservation(rest)).toThrow();
  });

  it('tolerates preliminary / cancelled / entered-in-error status (filtering is in the hook)', () => {
    for (const s of ['preliminary', 'cancelled', 'entered-in-error']) {
      const dto = parseObservation({ ...A1C_HIGH, status: s });
      expect(dto.status).toBe(s);
    }
  });
});
