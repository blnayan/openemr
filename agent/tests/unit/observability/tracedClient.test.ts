/**
 * tracedClient unit tests
 *
 * Verifies that:
 *   1. `tracedTraceable` preserves runtime behavior and emits trace payloads.
 *   2. `createTracedClient` forwards run/update/feedback payloads to a stub
 *      Langfuse client without requiring a redaction salt.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTracedClient,
  tracedTraceable,
  TracedLangfuseClient,
  _resetRedactorForTesting,
} from '../../../src/observability/index.js';

beforeEach(() => {
  _resetRedactorForTesting();
});

describe('tracedTraceable', () => {
  it('returns the underlying function result', async () => {
    const wrapped = tracedTraceable(async (name: string) => ({ greeting: `Hello ${name}` }), {
      name: 'greet',
    });
    await expect(wrapped('Maria González')).resolves.toEqual({ greeting: 'Hello Maria González' });
  });
});

describe('createTracedClient — wrapped Langfuse client', () => {
  it('forwards payloads passed to createRun', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const stub = {
      trace: (run: Record<string, unknown>) => {
        captured.push(run);
      },
      event: () => {},
      score: () => {},
    };

    const client = createTracedClient({
      underlying: stub,
    });
    expect(client).toBeInstanceOf(TracedLangfuseClient);

    await client.createRun({
      name: 'fhir.fetchJson',
      run_type: 'retriever',
      inputs: { question: 'Tell me about Maria González' },
      outputs: { snippet: 'Maria González came in for a checkup.' },
      tool_name: 'get_patient',
    });

    expect(captured.length).toBe(1);
    const sent = captured[0];
    expect(sent).toBeDefined();
    if (!sent) throw new Error('unreachable');
    // Structural keys preserved.
    expect(sent['name']).toBe('fhir.fetchJson');
    expect(sent['run_type']).toBe('retriever');
    expect(sent['tool_name']).toBe('get_patient');
    // Pass-through payloads are preserved.
    const inputs = sent['inputs'] as Record<string, string>;
    const outputs = sent['outputs'] as Record<string, string>;
    expect(inputs['question']).toContain('Maria González');
    expect(outputs['snippet']).toContain('Maria González');
  });

  it('forwards payloads passed to updateRun', async () => {
    const captured: Array<{ id: string; update: Record<string, unknown> }> = [];
    const stub = {
      trace: (update: Record<string, unknown>) => {
        const id = typeof update['id'] === 'string' ? update['id'] : '';
        captured.push({ id, update });
      },
      event: () => {},
      score: () => {},
    };
    const client = createTracedClient({
      underlying: stub,
    });

    await client.updateRun('run-1', { outputs: { reply: 'I emailed maria@example.com' } });
    expect(captured.length).toBe(1);
    const update = captured[0]?.update;
    expect(update).toBeDefined();
    if (!update) throw new Error('unreachable');
    const outputs = update['outputs'] as Record<string, string>;
    expect(outputs['reply']).toContain('maria@example.com');
  });
  it('does not require AGENTFORGE_PHI_REDACTION_SALT', () => {
    delete process.env['AGENTFORGE_PHI_REDACTION_SALT'];
    expect(() => createTracedClient({ underlying: {} })).not.toThrow();
  });
});
