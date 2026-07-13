/**
 * PhiSet unit tests
 *
 * Verifies that the multi-form name expansion, DOB chart-format
 * variants, and explicit-set construction work as advertised.
 */

import { describe, it, expect } from 'vitest';
import { PhiSet } from '../../../src/observability/PhiSet.js';

describe('PhiSet.fromPatientResource', () => {
  it('expands name into family/given/full/last-first/lowercase variants', () => {
    const set = PhiSet.fromPatientResource({
      resourceType: 'Patient',
      id: 'p1',
      name: [{ given: ['Maria'], family: 'González' }],
    });
    expect(set.names.has('Maria')).toBe(true);
    expect(set.names.has('González')).toBe(true);
    expect(set.names.has('Maria González')).toBe(true);
    expect(set.names.has('González, Maria')).toBe(true);
    expect(set.names.has('maria gonzález')).toBe(true);
  });

  it('expands DOB to ISO + chart formats', () => {
    const set = PhiSet.fromPatientResource({
      resourceType: 'Patient',
      id: 'p1',
      birthDate: '1968-04-15',
    });
    expect(set.dobs.has('1968-04-15')).toBe(true);
    expect(set.dobs.has('04/15/1968')).toBe(true);
    expect(set.dobs.has('4/15/1968')).toBe(true);
    expect(set.dobs.has('19680415')).toBe(true);
  });

  it('captures address line, city, state, postalCode', () => {
    const set = PhiSet.fromPatientResource({
      resourceType: 'Patient',
      id: 'p1',
      address: [{
        line: ['742 Evergreen Terrace'],
        city: 'Springfield',
        state: 'IL',
        postalCode: '62701',
      }],
    });
    expect(set.addresses.has('742 Evergreen Terrace')).toBe(true);
    expect(set.addresses.has('Springfield')).toBe(true);
    expect(set.addresses.has('IL')).toBe(true);
    expect(set.addresses.has('62701')).toBe(true);
  });

  it('separates phones and emails from telecom', () => {
    const set = PhiSet.fromPatientResource({
      resourceType: 'Patient',
      id: 'p1',
      telecom: [
        { system: 'phone', value: '(512) 555-1234' },
        { system: 'email', value: 'maria@example.com' },
      ],
    });
    expect(set.phones.has('(512) 555-1234')).toBe(true);
    expect(set.phones.has('5125551234')).toBe(true);
    expect(set.emails.has('maria@example.com')).toBe(true);
  });

  it('seeds pubpid from the explicit option', () => {
    const set = PhiSet.fromPatientResource(
      { resourceType: 'Patient', id: 'p1' },
      { pubpid: 'S2347' },
    );
    expect(set.pubpids.has('S2347')).toBe(true);
  });
});

describe('PhiSet.empty', () => {
  it('produces an empty set with all categories present', () => {
    const set = PhiSet.empty();
    expect(set.names.size).toBe(0);
    expect(set.dobs.size).toBe(0);
    expect(set.pubpids.size).toBe(0);
    expect(set.addresses.size).toBe(0);
    expect(set.phones.size).toBe(0);
    expect(set.emails.size).toBe(0);
  });
});
