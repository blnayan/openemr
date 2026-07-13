/**
 * Unit tests for the pure `isActivePrescription` filter exported from
 * `usePrescriptions`. The hook itself is exercised end-to-end via
 * `<PrescriptionsCard>`'s component tests; this file pins the filter
 * semantics directly so the truth table is self-documenting.
 */

import { describe, expect, it } from 'vitest';

import { isActivePrescription } from '../../../src/fhir/hooks/usePrescriptions';
import type { MedicationRequestDTO } from '../../../src/fhir/schemas/medicationRequest';

function build(
  overrides: Partial<MedicationRequestDTO> = {},
): MedicationRequestDTO {
  return {
    id: 'rx-1',
    name: 'Lisinopril 10 MG Oral Tablet',
    dosingText: 'Take 1 tablet by mouth daily',
    status: 'active',
    intent: 'order',
    authoredOn: '2024-02-10',
    ...overrides,
  };
}

describe('isActivePrescription', () => {
  // Order-family intents — keep when status is active.
  const ORDER_INTENTS = [
    'order',
    'original-order',
    'reflex-order',
    'filler-order',
    'instance-order',
  ];

  for (const intent of ORDER_INTENTS) {
    it(`keeps active rows with intent="${intent}"`, () => {
      expect(isActivePrescription(build({ status: 'active', intent })))
        .toBe(true);
    });
  }

  // Non-order intents — drop even when active.
  const NON_ORDER_INTENTS = ['proposal', 'plan', 'option'];

  for (const intent of NON_ORDER_INTENTS) {
    it(`drops active rows with intent="${intent}"`, () => {
      expect(isActivePrescription(build({ status: 'active', intent })))
        .toBe(false);
    });
  }

  it('drops rows with a null intent (Prescriptions card is intent-driven)', () => {
    expect(isActivePrescription(build({ status: 'active', intent: null })))
      .toBe(false);
  });

  // Non-active statuses — drop regardless of intent.
  const NON_ACTIVE_STATUSES = [
    'on-hold',
    'cancelled',
    'completed',
    'entered-in-error',
    'stopped',
    'draft',
    'unknown',
  ];

  for (const status of NON_ACTIVE_STATUSES) {
    it(`drops rows with status="${status}" even when intent is "order"`, () => {
      expect(isActivePrescription(build({ status, intent: 'order' })))
        .toBe(false);
    });
  }

  it('drops rows with a null status', () => {
    expect(isActivePrescription(build({ status: null, intent: 'order' })))
      .toBe(false);
  });

  it('drops rows with an unknown intent value not in the order set', () => {
    expect(
      isActivePrescription(build({ status: 'active', intent: 'made-up' })),
    ).toBe(false);
  });
});
