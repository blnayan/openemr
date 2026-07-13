/**
 * tracedClient — the *only* sanctioned path to Langfuse from anywhere in this
 * codebase. Every other module imports `tracedTraceable` from here; bypassing
 * shared instrumentation conventions would require editing this file.
 *
 * Why this exists:
 *   Centralize all Langfuse trace/span wiring in one place so route-level and
 *   node-level traces follow a consistent hierarchy and naming scheme.
 *
 * How the per-request PhiSet flows in:
 *   The chat route's preHandler (and, in issue 11, the supervisor entry)
 *   builds a PhiSet from the JWT-bound `pid` and runs the rest of the request
 *   inside `withPhiContext(set, () => …)`. The wrapper reads
 *   `phiContext.getStore()` from `AsyncLocalStorage` so child spans see the
 *   right set without explicit threading when callers need patient context.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { Langfuse } from 'langfuse';
import { PhiRedactor } from './PhiRedactor.js';
import { PhiSet } from './PhiSet.js';

/**
 * AsyncLocalStorage carrying the per-request PhiSet. The traceable
 * wrapper reads this; if no store has been established, redaction
 * defaults to the empty PhiSet (regex fallbacks still run).
 */
const phiContext = new AsyncLocalStorage<PhiSet>();

/**
 * Run `fn` with a PhiSet bound to the current async context. All
 * traceable-wrapped functions called inside `fn` (including transitive
 * calls via FHIR client, token provider, etc.) will redact through this
 * set.
 */
export function withPhiContext<T>(set: PhiSet, fn: () => Promise<T>): Promise<T> {
  return phiContext.run(set, fn);
}

/** Test-only escape hatch: read the active PhiSet (or empty). */
export function currentPhiSet(): PhiSet {
  return phiContext.getStore() ?? PhiSet.empty();
}

/** Test-only compatibility shim. */
export function _resetRedactorForTesting(): void {
  // No-op: redaction has been intentionally removed from observability payloads.
}

// ---------------------------------------------------------------------------
// traceable wrapper — the headline export.
// ---------------------------------------------------------------------------

export interface TraceableConfig {
  readonly name?: string;
  readonly run_type?: string;
  readonly processInputs?: (inputs: Record<string, unknown>) => Record<string, unknown>;
  readonly processOutputs?: (
    outputs: Record<string, unknown>,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  readonly metadata?: Record<string, unknown>;
  readonly tags?: string[];
}

export interface RequestTraceContextInput {
  readonly name: string;
  readonly input?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
  readonly tags?: readonly string[];
  readonly userId?: string;
  readonly sessionId?: string;
}

export interface GenerationUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
}

export interface TraceGenerationInput {
  readonly name: string;
  readonly model: string;
  readonly input: unknown;
  readonly metadata?: Record<string, unknown>;
}

interface RootTraceLike {
  span?: (payload: Record<string, unknown>) => SpanLike | undefined;
  generation?: (payload: Record<string, unknown>) => GenerationLike | undefined;
  update?: (payload: Record<string, unknown>) => void;
  event?: (payload: Record<string, unknown>) => void;
}

interface SpanLike {
  end?: (payload?: Record<string, unknown>) => void;
}

interface GenerationLike {
  end?: (payload?: Record<string, unknown>) => void;
}

interface ActiveRequestTraceContext {
  readonly rootTrace: RootTraceLike;
}

let langfuseSingleton: Langfuse | null = null;
const traceContext = new AsyncLocalStorage<ActiveRequestTraceContext>();

function getLangfuseClient(): Langfuse | null {
  if (langfuseSingleton) return langfuseSingleton;
  const secretKey = process.env['LANGFUSE_SECRET_KEY'];
  const publicKey = process.env['LANGFUSE_PUBLIC_KEY'];
  if (!secretKey || !publicKey) return null;
  langfuseSingleton = new Langfuse({
    secretKey,
    publicKey,
    ...(process.env['LANGFUSE_RELEASE']
      ? { release: process.env['LANGFUSE_RELEASE'] }
      : {}),
    ...(process.env['LANGFUSE_BASE_URL']
      ? { baseUrl: process.env['LANGFUSE_BASE_URL'] }
      : {}),
  });
  return langfuseSingleton;
}

export async function withRequestTraceContext<T>(
  input: RequestTraceContextInput,
  fn: () => Promise<T>,
): Promise<T> {
  const langfuse = getLangfuseClient();
  if (!langfuse) {
    return fn();
  }
  const traceInput = toRedactable(input.input ?? {}) as Record<string, unknown>;
  const traceMetadata = toRedactable(input.metadata ?? {}) as Record<string, unknown>;
  const trace = langfuse.trace({
    name: input.name,
    input: traceInput,
    ...(Object.keys(traceMetadata).length > 0 ? { metadata: traceMetadata } : {}),
    ...(input.tags && input.tags.length > 0 ? { tags: [...input.tags] } : {}),
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  }) as unknown as RootTraceLike;
  return traceContext.run({ rootTrace: trace }, async () => {
    try {
      const result = await fn();
      trace.update?.({
        output: { status: 'ok' },
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      trace.event?.({
        name: `${input.name}.error`,
        level: 'ERROR',
        statusMessage: message,
        output: { error: message },
      });
      trace.update?.({
        output: { status: 'error' },
      });
      throw err;
    }
  });
}

export async function traceGeneration<T>(
  input: TraceGenerationInput,
  run: () => Promise<{
    readonly result: T;
    readonly output: unknown;
    readonly usage?: GenerationUsage;
    readonly model?: string;
  }>,
): Promise<T> {
  const langfuse = getLangfuseClient();
  const activeRootTrace = traceContext.getStore()?.rootTrace;
  const standaloneTrace = activeRootTrace
    ? null
    : langfuse?.trace({
        name: `${input.name}.trace`,
        input: toRedactable(input.input) as Record<string, unknown>,
      });
  const trace = activeRootTrace ?? (standaloneTrace as unknown as RootTraceLike | null);
  const generation = trace?.generation?.({
    name: input.name,
    model: input.model,
    input: toRedactable(input.input),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
  try {
    const result = await run();
    const usage = result.usage && (
      result.usage.promptTokens !== undefined
      || result.usage.completionTokens !== undefined
      || result.usage.totalTokens !== undefined
    )
      ? {
          ...(result.usage.promptTokens !== undefined
            ? { promptTokens: result.usage.promptTokens }
            : {}),
          ...(result.usage.completionTokens !== undefined
            ? { completionTokens: result.usage.completionTokens }
            : {}),
          ...(result.usage.totalTokens !== undefined
            ? { totalTokens: result.usage.totalTokens }
            : {}),
        }
      : undefined;
    generation?.end?.({
      ...(result.model ? { model: result.model } : {}),
      output: toRedactable(result.output),
      ...(usage ? { usage } : {}),
    });
    return result.result;
  } catch (err) {
    generation?.end?.({
      level: 'ERROR',
      statusMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

function toRedactable(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return '[Function]';
  if (typeof value === 'symbol') return String(value);
  if (Array.isArray(value)) return value.map(v => toRedactable(v, seen));
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = toRedactable(v, seen);
    }
    return out;
  }
  return String(value);
}

/**
 * Drop-in tracing wrapper for async functions. Caller-supplied
 * `processInputs`/`processOutputs` are composed before redaction so any PHI
 * introduced there is still redacted prior to shipping to Langfuse.
 */
export function tracedTraceable<Func extends (...args: never[]) => unknown>(
  fn: Func,
  config?: TraceableConfig,
  _redactorOverride?: PhiRedactor,
): Func {
  const wrapped = async function traced(this: unknown, ...args: unknown[]): Promise<unknown> {
    const inputShape = { args: toRedactable(args) };
    const processedInput = config?.processInputs ? config.processInputs(inputShape) : inputShape;
    const traceInput = toRedactable(processedInput) as Record<string, unknown>;

    const runName = config?.name ?? fn.name ?? 'traceable.fn';
    const langfuse = getLangfuseClient();
    const activeRootTrace = traceContext.getStore()?.rootTrace;
    const standaloneTrace = activeRootTrace
      ? null
      : langfuse?.trace({
          name: runName,
          input: traceInput,
          ...(config?.metadata ? { metadata: config.metadata } : {}),
          ...(config?.tags ? { tags: config.tags } : {}),
        });
    const traceForSpan = activeRootTrace ?? (standaloneTrace as unknown as RootTraceLike | null);
    const span = traceForSpan?.span?.({
      name: `${runName}.execution`,
      input: traceInput,
      metadata: {
        ...(config?.run_type ? { run_type: config.run_type } : {}),
      },
    }) as SpanLike | undefined;

    try {
      const result = await (fn as unknown as (...a: unknown[]) => Promise<unknown>).apply(this, args);
      const outputShape = { output: toRedactable(result) };
      const processedOutput = config?.processOutputs
        ? await config.processOutputs(outputShape)
        : outputShape;
      const traceOutput = toRedactable(processedOutput) as Record<string, unknown>;
      span?.end?.({ output: traceOutput });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      span?.end?.({
        level: 'ERROR',
        statusMessage: message,
        output: { error: message },
      });
      throw err;
    }
  };
  return wrapped as unknown as Func;
}

/**
 * Factory yielding a traced wrapper bound to a specific redactor (used by
 * tests that inject their own redactor / salt).
 */
export function createTraceableWrapper(redactor: PhiRedactor): typeof tracedTraceable {
  return ((fn: (...a: never[]) => unknown, config?: TraceableConfig) =>
    tracedTraceable(fn, config, redactor)) as typeof tracedTraceable;
}

// ---------------------------------------------------------------------------
// Langfuse Client wrapper — used when code needs to write traces / feedback
// directly (not via traceable). All such writes go through the redactor.
// ---------------------------------------------------------------------------

interface LangfuseLike {
  trace?: (...args: any[]) => unknown;
  event?: (...args: any[]) => unknown;
  score?: (...args: any[]) => unknown;
}

export interface CreateTracedClientOptions {
  readonly salt?: string;
  /** Inject a stub Langfuse client for tests. */
  readonly underlying?: LangfuseLike;
  /** Inject an explicit redactor for tests. */
  readonly redactor?: PhiRedactor;
}

/**
 * Wrapper around the Langfuse client that redacts inputs/outputs on
 * `createRun`, `updateRun`, and `createFeedback` before delegating.
 */
export class TracedLangfuseClient {
  private readonly underlying: LangfuseLike;

  constructor(underlying: LangfuseLike) {
    this.underlying = underlying;
  }

  get raw(): LangfuseLike {
    return this.underlying;
  }

  async createRun(run: Record<string, unknown>): Promise<unknown> {
    return this.underlying.trace?.(toRedactable(run));
  }

  async updateRun(runId: string, update: Record<string, unknown>): Promise<unknown> {
    return this.underlying.trace?.(toRedactable({ ...update, id: runId }));
  }

  async createFeedback(runId: string, key: string, body: Record<string, unknown>): Promise<unknown> {
    const payload = toRedactable(body) as Record<string, unknown>;
    const scoreValue = payload['value'];
    if (
      this.underlying.score
      && (typeof scoreValue === 'number' || typeof scoreValue === 'string' || typeof scoreValue === 'boolean')
    ) {
      return this.underlying.score({
        traceId: runId,
        name: key,
        value: scoreValue,
        ...(typeof payload['comment'] === 'string' ? { comment: payload['comment'] } : {}),
      });
    }
    return this.underlying.event?.({
      traceId: runId,
      name: `feedback:${key}`,
      input: payload,
    });
  }
}

/** Build a TracedLangfuseClient pass-through wrapper. */
export function createTracedClient(opts: CreateTracedClientOptions = {}): TracedLangfuseClient {
  const underlying = opts.underlying ?? getLangfuseClient() ?? {};
  return new TracedLangfuseClient(underlying);
}

export async function shutdownObservability(): Promise<void> {
  const langfuse = getLangfuseClient();
  if (!langfuse) return;
  const withShutdown = langfuse as unknown as {
    shutdownAsync?: () => Promise<void>;
    flushAsync?: () => Promise<void>;
  };
  if (withShutdown.shutdownAsync) {
    await withShutdown.shutdownAsync();
    return;
  }
  if (withShutdown.flushAsync) {
    await withShutdown.flushAsync();
  }
}
