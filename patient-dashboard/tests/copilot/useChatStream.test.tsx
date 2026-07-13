import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useChatStream } from '../../src/copilot/useChatStream';

/**
 * Build a Response-like object with a controllable SSE stream body.
 * The returned `controller` exposes:
 *   - emit(chunk)  → enqueues a UTF-8 text chunk
 *   - close()      → ends the stream
 *   - error(err)   → errors the stream (mid-flight network failure)
 *
 * We don't use `new Response(stream)` because jsdom's fetch polyfill
 * varies — building the response shape useChatStream consumes is more
 * reliable across vitest environments.
 */
function makeStreamResponse(status = 200): {
  response: Response;
  emit(text: string): void;
  close(): void;
} {
  let onPush: ((chunk: Uint8Array) => void) | null = null;
  let onClose: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      onPush = (chunk) => c.enqueue(chunk);
      onClose = () => c.close();
    },
  });
  const encoder = new TextEncoder();
  const response = {
    status,
    ok: status >= 200 && status < 300,
    body: stream,
  } as unknown as Response;
  return {
    response,
    emit: (text: string) => {
      if (onPush !== null) onPush(encoder.encode(text));
    },
    close: () => {
      if (onClose !== null) onClose();
    },
  };
}

describe('useChatStream', () => {
  it('starts in idle state', () => {
    const { result } = renderHook(() => useChatStream({ fetchImpl: vi.fn() as unknown as typeof fetch }));
    expect(result.current.state).toBe('idle');
    expect(result.current.history).toEqual([]);
    expect(result.current.current).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('streams incremental deltas and completes on done', async () => {
    const { response, emit, close } = makeStreamResponse(200);
    const fetchImpl = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;

    const { result } = renderHook(() => useChatStream({ fetchImpl }));

    act(() => {
      result.current.submit('How is the patient doing?');
    });

    expect(result.current.state).toBe('streaming');
    expect(result.current.current?.question).toBe('How is the patient doing?');

    // Conversation event arrives first.
    act(() => {
      emit(
        'event: conversation\ndata: '
          + JSON.stringify({ conversation_id: 'abc' })
          + '\n\n',
      );
    });
    await waitFor(() => {
      expect(result.current.conversationId).toBe('abc');
    });

    // Summary streams in.
    act(() => {
      emit(
        'event: summary\ndata: '
          + JSON.stringify({ text: 'Patient is stable.' })
          + '\n\n',
      );
    });
    await waitFor(() => {
      expect(result.current.current?.answer.summary).toBe(
        'Patient is stable.',
      );
    });

    // Two claims (with two citation IDs each).
    act(() => {
      emit(
        'event: claim\ndata: '
          + JSON.stringify({
            text: 'A1c at goal.',
            citation_ids: ['tool:lab_results:row-1'],
            severity: 'info',
          })
          + '\n\n',
      );
    });
    await waitFor(() => {
      expect(result.current.current?.answer.claims).toHaveLength(1);
    });

    act(() => {
      emit(
        'event: claim\ndata: '
          + JSON.stringify({
            text: 'BP elevated.',
            citation_ids: ['tool:lab_results:row-2', 'rule:hypertension:1.1'],
            severity: 'attention',
          })
          + '\n\n',
      );
    });
    await waitFor(() => {
      expect(result.current.current?.answer.claims).toHaveLength(2);
    });

    // Done.
    act(() => {
      emit('event: done\ndata: {}\n\n');
      close();
    });

    await waitFor(() => {
      expect(result.current.state).toBe('done');
    });
    expect(result.current.history).toHaveLength(1);
    expect(result.current.history[0]?.answer.summary).toBe(
      'Patient is stable.',
    );
    expect(result.current.history[0]?.answer.claims).toHaveLength(2);
    expect(result.current.current).toBeNull();
  });

  it('accumulates partial JSON across chunk boundaries', async () => {
    const { response, emit, close } = makeStreamResponse(200);
    const fetchImpl = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;

    const { result } = renderHook(() => useChatStream({ fetchImpl }));

    act(() => {
      result.current.submit('Q?');
    });

    // Push the summary frame split across three chunks. The parser
    // should buffer until the terminator and only then surface a frame.
    act(() => {
      emit('event: summa');
    });
    act(() => {
      emit('ry\ndata: {"text":"P');
    });
    act(() => {
      emit('artial OK"}\n\n');
    });
    await waitFor(() => {
      expect(result.current.current?.answer.summary).toBe('Partial OK');
    });

    act(() => {
      emit('event: done\ndata: {}\n\n');
      close();
    });
    await waitFor(() => {
      expect(result.current.state).toBe('done');
    });
  });

  it('aborts the stream when abort() is called', async () => {
    // Build a stream whose body cancels when the abort signal fires —
    // mirrors browser fetch semantics where the body stream is bound
    // to the request signal.
    let onPush: ((c: Uint8Array) => void) | null = null;
    let onError: ((err: unknown) => void) | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        onPush = (chunk) => c.enqueue(chunk);
        onError = (err) => c.error(err);
      },
    });
    const encoder = new TextEncoder();
    const response = {
      status: 200,
      ok: true,
      body: stream,
    } as unknown as Response;

    let capturedSignal: AbortSignal | null = null;
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      capturedSignal = init.signal ?? null;
      // Bind the stream cancellation to the abort signal — when the
      // hook calls controller.abort(), the body stream errors with an
      // AbortError, which propagates through reader.read().
      capturedSignal?.addEventListener('abort', () => {
        const e = new DOMException('aborted', 'AbortError');
        if (onError !== null) onError(e);
      });
      return response;
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useChatStream({ fetchImpl }));

    act(() => {
      result.current.submit('Q?');
    });
    await waitFor(() => {
      expect(capturedSignal).not.toBeNull();
    });

    act(() => {
      if (onPush !== null) {
        onPush(
          encoder.encode(
            'event: summary\ndata: '
              + JSON.stringify({ text: 'partial' })
              + '\n\n',
          ),
        );
      }
    });

    act(() => {
      result.current.abort();
    });

    await waitFor(() => {
      expect(result.current.state).toBe('error');
    });
    expect(result.current.error?.reason).toBe('aborted');
    expect((capturedSignal as AbortSignal | null)?.aborted).toBe(true);
  });

  it('surfaces a session_expired error on 401', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 401,
      ok: false,
      body: null,
    } as unknown as Response) as unknown as typeof fetch;

    const { result } = renderHook(() => useChatStream({ fetchImpl }));

    act(() => {
      result.current.submit('Q?');
    });

    await waitFor(() => {
      expect(result.current.state).toBe('error');
    });
    expect(result.current.error?.reason).toBe('session_expired');
    expect(result.current.error?.message).toMatch(/Session expired/i);
  });

  it('surfaces a forbidden error on 403', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 403,
      ok: false,
      body: null,
    } as unknown as Response) as unknown as typeof fetch;

    const { result } = renderHook(() => useChatStream({ fetchImpl }));

    act(() => {
      result.current.submit('Q?');
    });

    await waitFor(() => {
      expect(result.current.state).toBe('error');
    });
    expect(result.current.error?.reason).toBe('forbidden');
  });

  it('surfaces a patient-selection message on no_patient_in_session', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 400,
      ok: false,
      body: null,
      text: async () => JSON.stringify({ error: 'no_patient_in_session' }),
    } as unknown as Response) as unknown as typeof fetch;

    const { result } = renderHook(() => useChatStream({ fetchImpl }));

    act(() => {
      result.current.submit('Q?');
    });

    await waitFor(() => {
      expect(result.current.state).toBe('error');
    });
    expect(result.current.error?.reason).toBe('bad_request');
    expect(result.current.error?.message).toContain('Select a patient chart first');
  });

  it('surfaces server validation issue text for invalid_body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 400,
      ok: false,
      body: null,
      text: async () => JSON.stringify({
        error: 'invalid_body',
        issues: [{ path: 'conversation_id', message: 'Invalid UUID' }],
      }),
    } as unknown as Response) as unknown as typeof fetch;

    const { result } = renderHook(() => useChatStream({ fetchImpl }));

    act(() => {
      result.current.submit('Q?');
    });

    await waitFor(() => {
      expect(result.current.state).toBe('error');
    });
    expect(result.current.error?.reason).toBe('bad_request');
    expect(result.current.error?.message).toBe('Invalid UUID');
  });

  it('surfaces an agent_error when the stream emits an error event', async () => {
    const { response, emit, close } = makeStreamResponse(200);
    const fetchImpl = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;

    const { result } = renderHook(() => useChatStream({ fetchImpl }));

    act(() => {
      result.current.submit('Q?');
    });

    act(() => {
      emit(
        'event: error\ndata: '
          + JSON.stringify({ reason: 'agent_internal_error' })
          + '\n\n',
      );
      close();
    });

    await waitFor(() => {
      expect(result.current.state).toBe('error');
    });
    expect(result.current.error?.reason).toBe('agent_error');
  });

  it('surfaces a network error when fetch rejects', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(
      new TypeError('Failed to fetch'),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useChatStream({ fetchImpl }));

    act(() => {
      result.current.submit('Q?');
    });

    await waitFor(() => {
      expect(result.current.state).toBe('error');
    });
    expect(result.current.error?.reason).toBe('network');
  });

  it('binds the global fetch to its host so the call site does not lose `this`', async () => {
    // Regression test for issue #37 — when the dock omits a custom
    // `fetchImpl`, the hook used to capture the global `fetch` as a
    // bare reference and invoke it through a property access
    // (`args.fetchImpl(...)`), which detached `this` from `Window` and
    // tripped the browser's "Illegal invocation" guard. The fetch call
    // would throw and the dock rendered "Could not reach the Clinical
    // Co-Pilot service. Try again." even though the network was fine.
    //
    // We replicate the failure by installing a global `fetch` that
    // throws "Illegal invocation" unless invoked with `this === globalThis`,
    // matching Chrome's actual behavior. The hook MUST bind to the
    // global before delegating, or the test fails.
    const originalFetch = globalThis.fetch;
    let capturedThis: unknown = undefined;
    const guardedFetch = function (
      this: unknown,
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> {
      capturedThis = this;
      if (this !== globalThis) {
        throw new TypeError(
          "Failed to execute 'fetch' on 'Window': Illegal invocation",
        );
      }
      const { response, emit, close } = makeStreamResponse(200);
      // Drain a minimal `done` frame so the hook reaches the terminal
      // state instead of hanging the test.
      queueMicrotask(() => {
        emit('event: done\ndata: {}\n\n');
        close();
      });
      return Promise.resolve(response);
    };
    // Object.defineProperty to side-step the typing strictness while
    // still resetting cleanly afterwards.
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: guardedFetch,
    });

    try {
      const { result } = renderHook(() => useChatStream());
      act(() => {
        result.current.submit('Q?');
      });
      await waitFor(() => {
        expect(result.current.state).toBe('done');
      });
      expect(capturedThis).toBe(globalThis);
    } finally {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
    }
  });

  it('handles the canonical backend SSE shape captured from agent/src/routes/chat.ts', async () => {
    // Regression test for issue #37 — uses the EXACT response body
    // captured from a live `POST /interface/agentforge/chat.php` against
    // the running AgentForge sidecar (see chat.ts → streamAnswer). If
    // the schema or parser ever drifts away from this shape, this test
    // fails fast instead of the dock silently rendering "Could not
    // reach the Clinical Co-Pilot service."
    const { response, emit, close } = makeStreamResponse(200);
    const fetchImpl = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;

    const { result } = renderHook(() => useChatStream({ fetchImpl }));

    act(() => {
      result.current.submit("What is the patient's latest A1c?");
    });

    // Verbatim-shaped events from the backend. Conversation event
    // includes `llm_driven`, `anchor`, `prior_message_count` (the
    // schema must accept these optional fields). Claim payload has the
    // exact three fields the agent emits. The terminal `done` carries `{}`.
    act(() => {
      emit(
        'event: conversation\n'
          + 'data: ' + JSON.stringify({
            conversation_id: '1ab59ac4-4d85-4c46-86ba-67b598e236b1',
            llm_driven: true,
            anchor: null,
            prior_message_count: 0,
          })
          + '\n\n'
          + 'event: evidence_catalog\n'
          + 'data: '
          + JSON.stringify({
            entries: [
              {
                kind: 'chart_row',
                id: 'ev_1',
                label: 'Labs · HbA1c 7.4%',
                facet: 'clinical',
                legacy_pointer: 'tool:get_recent_labs:row-0',
                tool: 'get_recent_labs',
                row_index: 0,
                document_hint: null,
              },
            ],
          })
          + '\n\n'
          + 'event: summary\n'
          + 'data: ' + JSON.stringify({
            text: "Margaret Chen's most recent hemoglobin A1c is 7.4%, measured on February 10, 2026.",
          })
          + '\n\n'
          + 'event: claim\n'
          + 'data: ' + JSON.stringify({
            text: 'Latest hemoglobin A1c is 7.4% from February 10, 2026.',
            citation_ids: ['tool:get_recent_labs:row-0'],
            evidence_refs: ['ev_1'],
            severity: 'info',
          })
          + '\n\n'
          + 'event: confidence\n'
          + 'data: ' + JSON.stringify({ value: 'high' })
          + '\n\n'
          + 'event: done\n'
          + 'data: {}\n\n',
      );
      close();
    });

    await waitFor(() => {
      expect(result.current.state).toBe('done');
    });
    const turn = result.current.history[0];
    expect(turn).toBeDefined();
    expect(turn?.answer.summary).toContain('A1c is 7.4%');
    expect(turn?.answer.claims).toHaveLength(1);
    expect(turn?.answer.claims[0]?.severity).toBe('info');
    expect(turn?.answer.claims[0]?.citation_ids).toEqual([
      'tool:get_recent_labs:row-0',
    ]);
    expect(turn?.answer.claims[0]?.evidence_refs).toEqual(['ev_1']);
    expect(turn?.answer.evidence_catalog['ev_1']?.label).toContain('HbA1c');
    expect(turn?.answer.confidence).toBe('high');
    expect(result.current.conversationId).toBe(
      '1ab59ac4-4d85-4c46-86ba-67b598e236b1',
    );
    expect(result.current.error).toBeNull();
  });

  it('sends the expected request body and credentials', async () => {
    const { response, emit, close } = makeStreamResponse(200);
    const fetchImpl = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useChatStream({ fetchImpl, encounterId: 42, mode: 'followup' }),
    );

    act(() => {
      result.current.submit('What is the latest A1c?');
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toBe('/interface/agentforge/chat.php');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['question']).toBe('What is the latest A1c?');
    expect(body['encounter_id']).toBe(42);
    expect(body['mode']).toBe('followup');
    expect(body['conversation_id']).toBeNull();

    // Clean up so the test doesn't leak the open stream.
    act(() => {
      emit('event: done\ndata: {}\n\n');
      close();
    });
    await waitFor(() => {
      expect(result.current.state).toBe('done');
    });
  });
});
