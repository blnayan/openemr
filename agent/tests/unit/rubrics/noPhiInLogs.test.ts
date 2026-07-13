/**
 * noPhiInLogs rubric tests.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs rubric is intentionally untyped for evals harness
import noPhiInLogs from '../../../evals/rubrics/noPhiInLogs.js';

const PHI_TOKENS = ['Maria González', '1968-04-15', '512-555-1234', 'maria@example.com'];

describe('noPhiInLogs rubric', () => {
  it('passes when payloads contain only redacted-form tokens', async () => {
    const captured = [
      { kind: 'tool_input', input: 'Patient [REDACTED:name:abcd1234] DOB [REDACTED:dob:11112222]' },
      { kind: 'tool_output', output: 'Phone [REDACTED:phone:33334444]' },
    ];
    const r = await noPhiInLogs({}, { vars: { phi_tokens: PHI_TOKENS, captured_traces: captured } });
    expect(r.pass).toBe(true);
  });

  it('passes when payloads simply do not mention the PHI tokens', async () => {
    const captured = [
      { kind: 'tool_input', input: 'A generic clinical question about diabetes.' },
    ];
    const r = await noPhiInLogs({}, { vars: { phi_tokens: PHI_TOKENS, captured_traces: captured } });
    expect(r.pass).toBe(true);
  });

  it('fails when raw PHI leaks (name)', async () => {
    const captured = [
      { kind: 'tool_input', input: 'Lookup labs for Maria González.' },
    ];
    const r = await noPhiInLogs({}, { vars: { phi_tokens: PHI_TOKENS, captured_traces: captured } });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/Maria González/);
  });

  it('fails when raw PHI leaks (DOB)', async () => {
    const captured = ['Patient DOB is 1968-04-15.'];
    const r = await noPhiInLogs({}, { vars: { phi_tokens: PHI_TOKENS, captured_traces: captured } });
    expect(r.pass).toBe(false);
  });

  it('fails when raw PHI leaks (email)', async () => {
    const captured = [{ note: 'Email maria@example.com on file.' }];
    const r = await noPhiInLogs({}, { vars: { phi_tokens: PHI_TOKENS, captured_traces: captured } });
    expect(r.pass).toBe(false);
  });

  it('fails when phi_tokens is missing', async () => {
    const r = await noPhiInLogs({}, { vars: {} });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/phi_tokens var/);
  });

  it('vacuously passes when no captured_traces are provided — defers to PhiRedactor unit tests', async () => {
    // Rationale (rubric body): the agent's user-facing response
    // legitimately echoes question PHI for the doctor's context (e.g.
    // "Patient identity mismatch: DOB 1971-04-12 doesn't match"). The
    // *trace* is the leak surface, not the response. Without a captured
    // trace, this rubric defers to PhiRedactor's exhaustive unit tests
    // rather than false-fail on response echo.
    const r = await noPhiInLogs(
      'The summary mentions Maria González by name.',
      { vars: { phi_tokens: PHI_TOKENS } },
    );
    expect(r.pass).toBe(true);
    expect(r.reason).toMatch(/trace capture unavailable/);
  });

  it('does not false-fail when PHI appears only inside a redacted token region', async () => {
    // Edge case: the token's hmac happens to contain a digit substring
    // that matches part of a PHI token — we strip redacted regions
    // before scanning so this still passes.
    const captured = ['Patient is [REDACTED:name:1968defa] today.'];
    const r = await noPhiInLogs({}, { vars: { phi_tokens: ['1968-04-15'], captured_traces: captured } });
    expect(r.pass).toBe(true);
  });
});
