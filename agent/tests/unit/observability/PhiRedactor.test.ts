/**
 * PhiRedactor unit tests
 *
 * Verifies that PHI fields are replaced with [REDACTED:type:hmac8] tokens
 * before any payload leaves the agent process to observability traces. The hmac8
 * suffix makes tokens stable per (value, salt) so cross-span joins
 * survive while still being one-way.
 *
 * Plan reference: §5.3 PhiRedactor.test.ts, M5 + issue 12.
 */

import { describe, it, expect } from 'vitest';
import { PhiRedactor } from '../../../src/observability/PhiRedactor.js';
import { PhiSet } from '../../../src/observability/PhiSet.js';

const SALT = 'test-salt-do-not-use-in-prod';
const TOKEN_RE = /\[REDACTED:([a-z]+):([0-9a-f]{8})\]/;

function r(): PhiRedactor {
  return new PhiRedactor({ salt: SALT });
}

describe('PhiRedactor — regex fallbacks', () => {
  it('redacts phone numbers in dash format', () => {
    const result = r().redact({ comment: 'Call 555-867-5309 for Maria.' }, PhiSet.empty());
    expect(result['comment']).not.toContain('555-867-5309');
    expect(result['comment']).toMatch(/\[REDACTED:phone:[0-9a-f]{8}\]/);
  });

  it('redacts phone numbers in dot format', () => {
    const result = r().redact({ comment: 'Phone: 555.867.5309' }, PhiSet.empty());
    expect(result['comment']).toMatch(/\[REDACTED:phone:[0-9a-f]{8}\]/);
  });

  it('redacts phone numbers in parenthesis format', () => {
    const result = r().redact({ comment: 'Contact (512) 555-1234' }, PhiSet.empty());
    expect(result['comment']).toMatch(/\[REDACTED:phone:[0-9a-f]{8}\]/);
  });

  it('redacts email addresses', () => {
    const result = r().redact({ info: 'Patient email: maria@example.com' }, PhiSet.empty());
    expect(result['info']).not.toContain('maria@example.com');
    expect(result['info']).toMatch(/\[REDACTED:email:[0-9a-f]{8}\]/);
  });

  it('redacts SSN patterns', () => {
    const result = r().redact({ note: 'SSN 123-45-6789 on file.' }, PhiSet.empty());
    expect(result['note']).not.toContain('123-45-6789');
    expect(result['note']).toMatch(/\[REDACTED:ssn:[0-9a-f]{8}\]/);
  });

  it('redacts street addresses', () => {
    const result = r().redact({ address: '123 Main St Austin' }, PhiSet.empty());
    expect(result['address']).toMatch(/\[REDACTED:address:[0-9a-f]{8}\]/);
  });

  it('redacts ISO DOB regardless of explicit set', () => {
    const result = r().redact({ note: 'DOB 1968-04-15 confirmed.' }, PhiSet.empty());
    expect(result['note']).toMatch(/\[REDACTED:dob:[0-9a-f]{8}\]/);
  });
});

describe('PhiRedactor — explicit-set replacements (PhiSet)', () => {
  it('redacts patient name in multiple forms', () => {
    const phi = PhiSet.fromExplicit({ names: ['Maria González', 'González', 'Maria'] });
    const result = r().redact(
      { comment: 'Maria González was seen by Dr. Smith. González reported no pain.' },
      phi,
    );
    const text = result['comment'] as string;
    expect(text).not.toContain('Maria González');
    expect(text).not.toContain('González');
    expect(text).toMatch(/\[REDACTED:name:[0-9a-f]{8}\]/);
  });

  it('redacts patient name case-insensitively', () => {
    const phi = PhiSet.fromExplicit({ names: ['Maria González'] });
    const result = r().redact({ comment: 'maria gonzález signed the form.' }, phi);
    expect(result['comment']).toMatch(/\[REDACTED:name:[0-9a-f]{8}\]/);
  });

  it('redacts pubpid (string identifier)', () => {
    const phi = PhiSet.fromExplicit({ pubpids: ['S2347'] });
    const result = r().redact({ note: 'Patient chart S2347 located.' }, phi);
    expect(result['note']).not.toContain('S2347');
    expect(result['note']).toMatch(/\[REDACTED:pubpid:[0-9a-f]{8}\]/);
  });

  it('redacts DOB in multiple chart formats when seeded from FHIR', () => {
    // PhiSet.fromPatientResource expands 1968-04-15 to 04/15/1968 etc.
    const phi = PhiSet.fromPatientResource({
      resourceType: 'Patient',
      id: 'p1',
      birthDate: '1968-04-15',
    });
    const r1 = r().redact({ note: 'DOB 1968-04-15.' }, phi);
    const r2 = r().redact({ note: 'DOB 04/15/1968.' }, phi);
    const r3 = r().redact({ note: 'DOB 4/15/1968.' }, phi);
    expect(r1['note']).toMatch(/\[REDACTED:dob:[0-9a-f]{8}\]/);
    expect(r2['note']).toMatch(/\[REDACTED:dob:[0-9a-f]{8}\]/);
    expect(r3['note']).toMatch(/\[REDACTED:dob:[0-9a-f]{8}\]/);
  });

  it('redacts addresses (street, city, state, postal)', () => {
    const phi = PhiSet.fromPatientResource({
      resourceType: 'Patient',
      id: 'p1',
      address: [{ line: ['742 Evergreen Terrace'], city: 'Springfield', state: 'IL', postalCode: '62701' }],
    });
    const result = r().redact(
      { note: 'Patient at 742 Evergreen Terrace, Springfield IL 62701.' },
      phi,
    );
    const text = result['note'] as string;
    expect(text).not.toContain('742 Evergreen Terrace');
    expect(text).not.toContain('Springfield');
    expect(text).not.toContain('62701');
  });

  it('redacts phones from explicit telecom (multiple formats)', () => {
    const phi = PhiSet.fromPatientResource({
      resourceType: 'Patient',
      id: 'p1',
      telecom: [{ system: 'phone', value: '(512) 555-1234' }],
    });
    const r1 = r().redact({ note: 'Reach at (512) 555-1234.' }, phi);
    const r2 = r().redact({ note: 'Reach at 5125551234.' }, phi);
    expect(r1['note']).toMatch(/\[REDACTED:phone:[0-9a-f]{8}\]/);
    expect(r2['note']).toMatch(/\[REDACTED:phone:[0-9a-f]{8}\]/);
  });

  it('redacts email from explicit telecom', () => {
    const phi = PhiSet.fromPatientResource({
      resourceType: 'Patient',
      id: 'p1',
      telecom: [{ system: 'email', value: 'maria@example.com' }],
    });
    const result = r().redact({ note: 'Email maria@example.com on file.' }, phi);
    expect(result['note']).toMatch(/\[REDACTED:email:[0-9a-f]{8}\]/);
  });
});

describe('PhiRedactor — token stability', () => {
  it('produces the same token for the same value across calls', () => {
    const phi = PhiSet.fromExplicit({ names: ['Maria González'] });
    const a = r().redact({ x: 'Maria González A' }, phi);
    const b = r().redact({ y: 'Maria González B' }, phi);
    const tokA = TOKEN_RE.exec(a['x'] as string);
    const tokB = TOKEN_RE.exec(b['y'] as string);
    expect(tokA?.[2]).toBeDefined();
    expect(tokA?.[2]).toBe(tokB?.[2]);
  });

  it('produces a different token under a different salt', () => {
    const phi = PhiSet.fromExplicit({ names: ['Maria González'] });
    const a = new PhiRedactor({ salt: 'salt-a' }).redact({ x: 'Maria González' }, phi);
    const b = new PhiRedactor({ salt: 'salt-b' }).redact({ x: 'Maria González' }, phi);
    expect(a['x']).not.toBe(b['x']);
  });

  it('produces a different token for different values under the same salt', () => {
    const phi = PhiSet.fromExplicit({ names: ['Alice', 'Bob'] });
    const result = r().redact({ x: 'Alice and Bob met.' }, phi);
    const matches = (result['x'] as string).match(/\[REDACTED:name:[0-9a-f]{8}\]/g) ?? [];
    expect(matches.length).toBe(2);
    expect(matches[0]).not.toBe(matches[1]);
  });
});

describe('PhiRedactor — structural pass-through', () => {
  it('preserves observability structural keys verbatim', () => {
    const result = r().redact(
      {
        tool_name: 'get_medications',
        row_count: 3,
        ok: true,
        latency_ms: 142,
        citation_id: 'rule:guideline:ada-2026-6-3a',
        chunk_id: 'ada::ch-06::6.3a::0',
        section_id: '6.3a',
        severity: 'info',
        status: 'ok',
        model: 'anthropic/claude-haiku-4.5',
      },
      PhiSet.empty(),
    );
    expect(result['tool_name']).toBe('get_medications');
    expect(result['row_count']).toBe(3);
    expect(result['ok']).toBe(true);
    expect(result['latency_ms']).toBe(142);
    expect(result['citation_id']).toBe('rule:guideline:ada-2026-6-3a');
    expect(result['chunk_id']).toBe('ada::ch-06::6.3a::0');
    expect(result['model']).toBe('anthropic/claude-haiku-4.5');
  });

  it('preserves patient_uuid (pseudonymous identifier)', () => {
    const uuid = '8a3f1234-abcd-4def-bcde-000000000042';
    const result = r().redact({ patient_uuid: uuid }, PhiSet.empty());
    expect(result['patient_uuid']).toBe(uuid);
  });

  it('passes through structural-only payloads untouched', () => {
    const payload = { tool_name: 'foo', row_count: 0, ok: false, severity: 'urgent' };
    const result = r().redact(payload, PhiSet.empty());
    expect(result).toEqual(payload);
  });
});

describe('PhiRedactor — deep walk', () => {
  it('walks nested objects, arrays of objects, objects within arrays', () => {
    const phi = PhiSet.fromExplicit({ names: ['Maria González'] });
    const payload = {
      span: {
        attributes: {
          messages: [
            { role: 'user', content: 'Tell me about Maria González' },
            { role: 'tool', tool_name: 'get_meds', content: 'Maria González: metformin 500 mg' },
          ],
        },
      },
    };
    const result = r().redact(payload, phi);
    const messages = (
      (result.span as Record<string, Record<string, unknown>>)['attributes'] as Record<string, unknown>
    )['messages'] as Array<Record<string, string>>;
    expect(messages[0]?.['content']).not.toContain('Maria González');
    expect(messages[1]?.['content']).not.toContain('Maria González');
    // Structural key inside the array element survives.
    expect(messages[1]?.['tool_name']).toBe('get_meds');
  });

  it('does not mutate the input object', () => {
    const original = { comment: 'Phone 555-555-1234', safe: 'value' };
    const cloned = JSON.parse(JSON.stringify(original)) as typeof original;
    r().redact(original, PhiSet.empty());
    expect(original).toEqual(cloned);
  });

  it('handles null and empty objects', () => {
    expect(() => r().redact({ value: null }, PhiSet.empty())).not.toThrow();
    expect(() => r().redact({}, PhiSet.empty())).not.toThrow();
  });
});

describe('PhiRedactor — construction', () => {
  it('throws when the salt is empty', () => {
    expect(() => new PhiRedactor({ salt: '' })).toThrow(/salt/);
  });
});
