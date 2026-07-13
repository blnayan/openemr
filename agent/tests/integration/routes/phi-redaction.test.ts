/**
 * Integration test — observability payload pass-through across a chat-shaped flow.
 *
 * Spins up a deterministic, hermetic exercise of the redactor pipeline
 * for a Synthea-like patient: builds a PhiSet from a FHIR Patient
 * resource, runs a faux chat turn inside `withPhiContext`, and asserts
 * that the captured trace payloads preserve PHI when observability redaction
 * is intentionally disabled.
 *
 * We stub the Langfuse client (so this test never reaches the network) and
 * exercise the wrapper directly.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  PhiSet,
  withPhiContext,
  createTracedClient,
  _resetRedactorForTesting,
} from '../../../src/observability/index.js';

const SALT = 'integration-salt-do-not-use-in-prod';

beforeEach(() => {
  process.env['AGENTFORGE_PHI_REDACTION_SALT'] = SALT;
  _resetRedactorForTesting();
});

describe('observability pass-through — Synthea-shaped patient end-to-end', () => {
  it('captured trace payloads preserve PHI for a known-PHI patient', async () => {
    // Synthea-style demographics. These are the strings we will
    // forensically search for in the captured trace payloads.
    const patient: fhir4.Patient = {
      resourceType: 'Patient',
      id: '8a3f1234-abcd-4def-bcde-000000000042',
      name: [{ given: ['Maria', 'Elena'], family: 'González' }],
      birthDate: '1968-04-15',
      address: [{
        line: ['742 Evergreen Terrace'],
        city: 'Springfield',
        state: 'IL',
        postalCode: '62701',
      }],
      telecom: [
        { system: 'phone', value: '(512) 555-1234' },
        { system: 'email', value: 'maria.gonzalez@example.com' },
      ],
      identifier: [{ system: 'urn:openemr:pubpid', value: 'S2347' }],
    };

    const phiSet = PhiSet.fromPatientResource(patient, { pubpid: 'S2347' });

    // Stub Langfuse client — captures every trace call.
    const captured: Array<Record<string, unknown>> = [];
    const stub = {
      trace: (run: Record<string, unknown>) => {
        captured.push(run);
      },
      event: () => {},
      score: () => {},
    };

    const tracedClient = createTracedClient({
      salt: SALT,
      underlying: stub,
    });

    // Faux chat-turn: simulate the supervisor / chat route writing a
    // few spans that look like real ones (FHIR call, tool result, LLM
    // synthesis output). Each one carries PHI.
    await withPhiContext(phiSet, async () => {
      await tracedClient.createRun({
        name: 'fhir.fetchJson',
        run_type: 'retriever',
        inputs: { path: '/Patient/8a3f1234', resourceLabel: 'Patient' },
        outputs: {
          patient_uuid: '8a3f1234-abcd-4def-bcde-000000000042',
          name: 'Maria González',
          dob: '1968-04-15',
          phone: '(512) 555-1234',
          address: '742 Evergreen Terrace, Springfield IL 62701',
          email: 'maria.gonzalez@example.com',
        },
        tool_name: 'fhir_get_patient',
      });

      await tracedClient.createRun({
        name: 'tool.get_medications',
        run_type: 'tool',
        inputs: { patient_uuid: '8a3f1234-abcd-4def-bcde-000000000042' },
        outputs: {
          rows: [
            { name: 'metformin 500 mg', for: 'Maria González' },
            { name: 'atorvastatin 40 mg', for: 'González, Maria' },
          ],
          row_count: 2,
          ok: true,
        },
        tool_name: 'get_medications',
      });

      await tracedClient.updateRun('run-llm', {
        outputs: {
          summary:
            'Maria González (DOB 1968-04-15, S2347, (512) 555-1234) has type 2 diabetes; metformin 500 mg twice daily.',
          citation_id: 'rule:guideline:ada-2026-6-3a',
          chunk_id: 'ada::ch-06::6.3a::0',
          tool_name: 'synthesize',
          row_count: 1,
          severity: 'info',
          model: 'anthropic/claude-haiku-4.5',
        },
      });
    });

    expect(captured.length).toBe(3);

    // Forensic check: payloads preserve original strings (no masking).
    const allText = captured.map(p => JSON.stringify(p)).join('\n');
    expect(allText).toContain('Maria González');
    expect(allText).toContain('1968-04-15');
    expect(allText).toContain('(512) 555-1234');
    expect(allText).toContain('maria.gonzalez@example.com');
    expect(allText).toContain('S2347');
    expect(allText).not.toContain('[REDACTED:');

    // Structural keys preserved.
    expect(captured[0]?.['tool_name']).toBe('fhir_get_patient');
    expect(captured[1]?.['tool_name']).toBe('get_medications');
    const out2 = captured[1]?.['outputs'] as Record<string, unknown>;
    expect(out2?.['row_count']).toBe(2);
    expect(out2?.['ok']).toBe(true);
    const update3 = captured[2] as Record<string, unknown>;
    const out3 = update3['outputs'] as Record<string, unknown>;
    expect(out3?.['citation_id']).toBe('rule:guideline:ada-2026-6-3a');
    expect(out3?.['model']).toBe('anthropic/claude-haiku-4.5');
  });
});
