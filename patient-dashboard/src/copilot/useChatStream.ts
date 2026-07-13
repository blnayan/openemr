/**
 * useChatStream — owns the lifecycle of one chat turn end-to-end.
 *
 * Responsibilities:
 *   1. POST the question to `/interface/agentforge/chat.php` with
 *      `credentials: 'include'` (the OpenEMR session cookie carries
 *      the authn).
 *   2. Read the SSE response off `response.body.getReader()`, decode
 *      chunks, feed them to `SseFrameParser`, parse each completed
 *      frame, and accumulate the running Answer snapshot.
 *   3. Re-render React with each delta so the answer bubble fills in
 *      live.
 *   4. Treat the `done` event as terminal-success and the `error`
 *      event (or any thrown error) as terminal-failure.
 *   5. Expose a `submit(question)` entry point and an `abort()`
 *      escape hatch backed by `AbortController`.
 *   6. On 401 / 403 from `chat.php` (session expired / no patient in
 *      session), surface a typed `ChatError` the dock renders as
 *      "Session expired".
 *
 * The hook stores a list of completed turns in `history` and the
 * in-progress streaming turn in `current`. The dock renders both: each
 * past turn as a `(question, answer)` pair, and `current` as the
 * trailing live bubble until the stream closes.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  applyEvent,
  emptyAnswer,
  parseSseEvent,
  type ChatAnswer,
} from './answerSchema';
import { SseFrameParser } from './sseParser';

export type ChatErrorReason =
  /** 401 / no session — the dock should show "Session expired". */
  | 'session_expired'
  /** 403 — ACL denied. Same UX as session_expired for v1. */
  | 'forbidden'
  /** chat.php is unreachable or the agent sidecar isn't configured. */
  | 'agent_unavailable'
  /** 4xx other than 401/403 — typically a malformed body. */
  | 'bad_request'
  /** Stream-time `error` SSE event from the agent. */
  | 'agent_error'
  /** Network failure / fetch threw / stream aborted unexpectedly. */
  | 'network'
  /** Caller-initiated abort. Distinct so callers can ignore it. */
  | 'aborted';

export interface ChatError {
  readonly reason: ChatErrorReason;
  /**
   * Human-safe message. NEVER includes server-side diagnostic detail —
   * the dock renders this directly.
   */
  readonly message: string;
}

export interface ChatTurn {
  readonly id: string;
  readonly question: string;
  readonly answer: ChatAnswer;
}

export type ChatStreamState = 'idle' | 'streaming' | 'done' | 'error';

export interface SubmitOptions {
  /**
   * Per-call mode override. Overrides the hook-level `mode` option
   * (which itself defaults to `'followup'`). Used so the dock can
   * auto-fire a one-shot `previsit` summary while user-typed follow-ups
   * keep flowing as `followup` through the same hook instance.
   */
  readonly mode?: 'previsit' | 'followup';
}

export interface UseChatStreamResult {
  readonly state: ChatStreamState;
  readonly history: ReadonlyArray<ChatTurn>;
  /** The in-flight turn while streaming, otherwise null. */
  readonly current: ChatTurn | null;
  /** The terminal error, or null. Cleared on the next `submit`. */
  readonly error: ChatError | null;
  /** The conversation id minted by the agent on the first turn. */
  readonly conversationId: string | null;
  submit(question: string, opts?: SubmitOptions): void;
  abort(): void;
}

export interface UseChatStreamOptions {
  /** Override the chat endpoint — used by tests. */
  readonly endpoint?: string;
  /** Optional fetch impl — used by tests to inject a stream mock. */
  readonly fetchImpl?: typeof fetch;
  /** Encounter id, threaded through to the agent if present. */
  readonly encounterId?: number | null;
  /** `previsit` or `followup`. Defaults to `followup`. */
  readonly mode?: 'previsit' | 'followup';
}

const DEFAULT_ENDPOINT = '/interface/agentforge/chat.php';

export function useChatStream(
  options: UseChatStreamOptions = {},
): UseChatStreamResult {
  const [state, setState] = useState<ChatStreamState>('idle');
  const [history, setHistory] = useState<ReadonlyArray<ChatTurn>>([]);
  const [current, setCurrent] = useState<ChatTurn | null>(null);
  const [error, setError] = useState<ChatError | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);

  // Hold the AbortController in a ref so `abort()` can cancel an
  // in-flight fetch from a closure that hasn't seen the latest state.
  const controllerRef = useRef<AbortController | null>(null);

  // Track whether the component is still mounted. If the dock unmounts
  // mid-stream (user navigates away) we don't want to call setState on
  // a torn-down component.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  // The global `fetch` is a method on `Window` and throws "Illegal
  // invocation" when called with a `this` that isn't `Window` (which
  // happens as soon as we capture it as `args.fetchImpl` and invoke
  // through the property access `args.fetchImpl(...)`). Bind to the
  // global so the call site can stay simple. Tests inject their own
  // fetch impl, which we trust to be self-contained.
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  const mode = options.mode ?? 'followup';
  const encounterId = options.encounterId ?? null;

  // Latest conversationId in a ref so successive submits in the same
  // session re-use it without forcing the caller to thread it back.
  const conversationIdRef = useRef<string | null>(null);
  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  const abort = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  const submit = useCallback(
    (question: string, opts?: SubmitOptions) => {
      const trimmed = question.trim();
      if (trimmed === '') return;
      const effectiveMode = opts?.mode ?? mode;

      // Cancel any prior in-flight stream — the dock submits one turn
      // at a time but we can't enforce that at the call site, and a
      // stale stream would race with the new one to mutate `current`.
      controllerRef.current?.abort();

      const controller = new AbortController();
      controllerRef.current = controller;

      const turnId = makeTurnId();
      const initialTurn: ChatTurn = {
        id: turnId,
        question: trimmed,
        answer: emptyAnswer(),
      };

      setError(null);
      setCurrent(initialTurn);
      setState('streaming');

      void runStream({
        endpoint,
        fetchImpl,
        body: {
          question: trimmed,
          conversation_id: conversationIdRef.current,
          encounter_id: encounterId,
          mode: effectiveMode,
        },
        signal: controller.signal,
        onConversation: (cid) => {
          if (!mountedRef.current) return;
          conversationIdRef.current = cid;
          setConversationId(cid);
        },
        onAnswerDelta: (next) => {
          if (!mountedRef.current) return;
          setCurrent((prev) =>
            prev !== null && prev.id === turnId
              ? { ...prev, answer: next }
              : prev,
          );
        },
        onComplete: (finalAnswer) => {
          if (!mountedRef.current) return;
          setHistory((prev) => [
            ...prev,
            { id: turnId, question: trimmed, answer: finalAnswer },
          ]);
          setCurrent(null);
          setState('done');
        },
        onError: (chatError) => {
          if (!mountedRef.current) return;
          setError(chatError);
          setCurrent(null);
          setState('error');
        },
      });
    },
    [endpoint, fetchImpl, mode, encounterId],
  );

  return {
    state,
    history,
    current,
    error,
    conversationId,
    submit,
    abort,
  };
}

interface RunStreamArgs {
  endpoint: string;
  fetchImpl: typeof fetch;
  body: {
    question: string;
    conversation_id: string | null;
    encounter_id: number | null;
    mode: 'previsit' | 'followup';
  };
  signal: AbortSignal;
  onConversation(conversationId: string): void;
  onAnswerDelta(answer: ChatAnswer): void;
  onComplete(finalAnswer: ChatAnswer): void;
  onError(error: ChatError): void;
}

interface HttpErrorPayload {
  readonly error?: string;
  readonly issues?: ReadonlyArray<{
    readonly path?: string;
    readonly message?: string;
  }>;
}

async function runStream(args: RunStreamArgs): Promise<void> {
  let response: Response;
  try {
    response = await args.fetchImpl(args.endpoint, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(args.body),
      signal: args.signal,
    });
  } catch (err) {
    if (isAbort(err, args.signal)) {
      args.onError({ reason: 'aborted', message: 'Request cancelled.' });
      return;
    }
    args.onError({
      reason: 'network',
      message: 'Could not reach the Clinical Co-Pilot service. Try again.',
    });
    return;
  }

  if (response.status === 401) {
    args.onError({
      reason: 'session_expired',
      message: 'Session expired — please reload.',
    });
    return;
  }
  if (response.status === 403) {
    args.onError({
      reason: 'forbidden',
      message: 'Session expired — please reload.',
    });
    return;
  }
  if (response.status === 503) {
    args.onError({
      reason: 'agent_unavailable',
      message: 'The Clinical Co-Pilot service is offline. Try again later.',
    });
    return;
  }
  if (response.status >= 400 && response.status < 500) {
    const payload = await readHttpErrorPayload(response);
    if (payload?.error === 'no_patient_in_session') {
      args.onError({
        reason: 'bad_request',
        message: 'Select a patient chart first, then ask again.',
      });
      return;
    }
    if (payload?.error === 'invalid_body' && Array.isArray(payload.issues) && payload.issues.length > 0) {
      const firstIssue = payload.issues.find((i) => typeof i?.message === 'string' && i.message.trim() !== '');
      args.onError({
        reason: 'bad_request',
        message: firstIssue?.message ?? 'Could not process that question. Please rephrase and try again.',
      });
      return;
    }
    if (payload?.error === 'bad_request') {
      args.onError({
        reason: 'bad_request',
        message: 'Request was rejected. Refresh the page and try again.',
      });
      return;
    }
    args.onError({
      reason: 'bad_request',
      message: 'Could not process that question. Please rephrase and try again.',
    });
    return;
  }
  if (!response.ok || response.body === null) {
    args.onError({
      reason: 'agent_unavailable',
      message: 'The Clinical Co-Pilot service is offline. Try again later.',
    });
    return;
  }

  let answer: ChatAnswer = emptyAnswer();
  const parser = new SseFrameParser();
  const decoder = new TextDecoder('utf-8');
  const reader = response.body.getReader();

  // Drive the stream loop. We intentionally don't `await` the entire
  // stream from the caller — the hook returns immediately and the
  // updates land via the on* callbacks.
  try {
    let sawDone = false;
    let streamErrored = false;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        // Drain any partial frame the server didn't terminate.
        const tail = parser.flush();
        if (tail !== null) {
          const event = parseSseEvent(tail.event, tail.data);
          if (event !== null) {
            const result = applyAndDispatch(event, answer, args);
            if (result.kind === 'updated') answer = result.next;
            if (result.kind === 'done') sawDone = true;
            if (result.kind === 'error') {
              streamErrored = true;
              break;
            }
          }
        }
        break;
      }
      const text = decoder.decode(chunk.value, { stream: true });
      const frames = parser.push(text);
      let breakOut = false;
      for (const frame of frames) {
        const event = parseSseEvent(frame.event, frame.data);
        if (event === null) continue;
        const result = applyAndDispatch(event, answer, args);
        if (result.kind === 'updated') {
          answer = result.next;
        } else if (result.kind === 'done') {
          sawDone = true;
        } else if (result.kind === 'error') {
          streamErrored = true;
          breakOut = true;
          break;
        }
      }
      if (breakOut) break;
    }
    if (streamErrored) {
      // onError already fired inside applyAndDispatch.
      return;
    }
    if (!sawDone) {
      // Stream closed without a `done` event. Treat as best-effort
      // success — the user still sees whatever streamed in.
      args.onComplete(answer);
      return;
    }
    args.onComplete(answer);
  } catch (err) {
    if (isAbort(err, args.signal)) {
      args.onError({ reason: 'aborted', message: 'Request cancelled.' });
      return;
    }
    args.onError({
      reason: 'network',
      message: 'The Clinical Co-Pilot stream was interrupted.',
    });
  }
}

async function readHttpErrorPayload(response: Response): Promise<HttpErrorPayload | null> {
  try {
    const text = await response.text();
    if (text.trim() === '') return null;
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as HttpErrorPayload;
  } catch {
    return null;
  }
}

type DispatchResult =
  | { kind: 'updated'; next: ChatAnswer }
  | { kind: 'noop' }
  | { kind: 'done' }
  | { kind: 'error' };

function applyAndDispatch(
  event: ReturnType<typeof parseSseEvent>,
  answer: ChatAnswer,
  args: RunStreamArgs,
): DispatchResult {
  if (event === null) return { kind: 'noop' };

  if (event.kind === 'conversation') {
    args.onConversation(event.payload.conversation_id);
    return { kind: 'noop' };
  }
  if (event.kind === 'done') {
    return { kind: 'done' };
  }
  if (event.kind === 'error') {
    args.onError({
      reason: 'agent_error',
      message: errorMessageFor(event.payload.reason),
    });
    return { kind: 'error' };
  }
  if (
    event.kind === 'summary'
    || event.kind === 'evidence_catalog'
    || event.kind === 'confidence'
    || event.kind === 'claim'
    || event.kind === 'section'
    || event.kind === 'conflict'
    || event.kind === 'data_gap'
    || event.kind === 'assumption'
  ) {
    const next = applyEvent(answer, event);
    args.onAnswerDelta(next);
    return { kind: 'updated', next };
  }
  return { kind: 'noop' };
}

function errorMessageFor(reason: string): string {
  // Translate the small, known set of agent-side reason codes into
  // user-safe copy. Anything else falls through to a generic apology.
  if (reason === 'agent_internal_error') {
    return 'The Clinical Co-Pilot ran into a problem. Try again.';
  }
  if (reason === 'agent_unavailable') {
    return 'The Clinical Co-Pilot service is offline. Try again later.';
  }
  return 'The Clinical Co-Pilot ran into a problem. Try again.';
}

function isAbort(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  if (
    typeof err === 'object'
    && err !== null
    && 'name' in err
    && (err as { name: unknown }).name === 'AbortError'
  ) {
    return true;
  }
  return false;
}

function makeTurnId(): string {
  // No need for crypto strength — id is for React keys and turn
  // matching, never persisted or shown to the user.
  return `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
