import { describe, expect, it } from 'vitest';

import { parseMedicationRequest } from '../../src/fhir/schemas/medicationRequest';

const LISINOPRIL = {
  resourceType: 'MedicationRequest',
  id: 'm1',
  status: 'active',
  intent: 'order',
  medicationCodeableConcept: {
    coding: [
      {
        system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
        code: '314076',
        display: 'Lisinopril 10 MG Oral Tablet',
      },
    ],
  },
  dosageInstruction: [
    {
      text: 'Take 1 tablet by mouth daily',
    },
  ],
  authoredOn: '2024-02-10',
};

describe('parseMedicationRequest', () => {
  it('projects a well-formed FHIR MedicationRequest into a MedicationRequestDTO', () => {
    expect(parseMedicationRequest(LISINOPRIL)).toEqual({
      id: 'm1',
      name: 'Lisinopril 10 MG Oral Tablet',
      dosingText: 'Take 1 tablet by mouth daily',
      status: 'active',
      intent: 'order',
      authoredOn: '2024-02-10',
    });
  });

  it('falls back to medicationReference.display when codeableConcept is absent', () => {
    const dto = parseMedicationRequest({
      resourceType: 'MedicationRequest',
      id: 'm2',
      status: 'active',
      intent: 'order',
      medicationReference: {
        reference: 'Medication/abc',
        display: 'Atorvastatin 20 MG',
      },
    });
    expect(dto.name).toBe('Atorvastatin 20 MG');
    expect(dto.dosingText).toBeNull();
  });

  it('falls back to medicationCodeableConcept.text when no coding[].display is present', () => {
    const dto = parseMedicationRequest({
      ...LISINOPRIL,
      medicationCodeableConcept: { text: 'Metformin 500mg' },
    });
    expect(dto.name).toBe('Metformin 500mg');
  });

  it('prefers coding[].display over reference.display over text', () => {
    const dto = parseMedicationRequest({
      ...LISINOPRIL,
      medicationCodeableConcept: {
        coding: [{ display: 'Coded Display' }],
        text: 'Text Display',
      },
      medicationReference: { display: 'Ref Display' },
    });
    expect(dto.name).toBe('Coded Display');
  });

  it('skips coding entries with empty display and falls through', () => {
    const dto = parseMedicationRequest({
      ...LISINOPRIL,
      medicationCodeableConcept: {
        coding: [{ system: 'http://x', code: 'y' /* no display */ }],
        text: 'Fallback Med',
      },
    });
    expect(dto.name).toBe('Fallback Med');
  });

  it('returns "(unknown medication)" when nothing identifies the drug', () => {
    const dto = parseMedicationRequest({
      resourceType: 'MedicationRequest',
      id: 'm-x',
      status: 'active',
    });
    expect(dto.name).toBe('(unknown medication)');
  });

  it('falls back to structured doseQuantity when dosageInstruction[0].text is missing', () => {
    const dto = parseMedicationRequest({
      ...LISINOPRIL,
      dosageInstruction: [
        {
          doseAndRate: [
            {
              doseQuantity: { value: 10, unit: 'mg' },
            },
          ],
        },
      ],
    });
    expect(dto.dosingText).toBe('10 mg');
  });

  it('emits just the value when doseQuantity has no unit', () => {
    const dto = parseMedicationRequest({
      ...LISINOPRIL,
      dosageInstruction: [
        {
          doseAndRate: [{ doseQuantity: { value: 5 } }],
        },
      ],
    });
    expect(dto.dosingText).toBe('5');
  });

  it('returns null dosingText when no dosing info is present at all', () => {
    const dto = parseMedicationRequest({
      ...LISINOPRIL,
      dosageInstruction: undefined,
    });
    expect(dto.dosingText).toBeNull();
  });

  it('returns null dosingText when dosageInstruction is empty', () => {
    const dto = parseMedicationRequest({
      ...LISINOPRIL,
      dosageInstruction: [],
    });
    expect(dto.dosingText).toBeNull();
  });

  it('returns null status / intent / authoredOn when omitted', () => {
    const dto = parseMedicationRequest({
      resourceType: 'MedicationRequest',
      id: 'm3',
      medicationCodeableConcept: { text: 'Some Drug' },
    });
    expect(dto.status).toBeNull();
    expect(dto.intent).toBeNull();
    expect(dto.authoredOn).toBeNull();
  });

  it('tolerates non-active status (filtering is in the hook)', () => {
    const dto = parseMedicationRequest({
      ...LISINOPRIL,
      status: 'completed',
    });
    expect(dto.status).toBe('completed');
  });

  it('throws on the wrong resourceType', () => {
    expect(() =>
      parseMedicationRequest({ ...LISINOPRIL, resourceType: 'Patient' }),
    ).toThrow();
  });

  it('throws when id is missing', () => {
    const { id, ...rest } = LISINOPRIL;
    void id;
    expect(() => parseMedicationRequest(rest)).toThrow();
  });

  it('tolerates extra unknown fields', () => {
    const dto = parseMedicationRequest({
      ...LISINOPRIL,
      meta: { lastUpdated: '2024-01-01' },
      subject: { reference: 'Patient/xyz' },
    });
    expect(dto.id).toBe('m1');
  });
});
