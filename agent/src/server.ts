/**
 * Fastify server bootstrap. The build* helpers are exported so the
 * integration test suite can spin up an in-process app without forking
 * a real Node process.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { verifyJwt } from './middleware/verifyJwt.js';
import { registerChatRoute } from './routes/chat.js';
import { registerConversationRoute } from './routes/conversation.js';
import { registerExtractRoute } from './routes/extract.js';
import { loadConfig } from './config.js';
import { InMemoryConversationRepository, type ConversationRepository } from './db/ConversationRepository.js';
import { ConversationCache } from './db/ConversationCache.js';
import { OpenEmrTokenProvider } from './fhir/OpenEmrTokenProvider.js';
import type { LlmInvoker } from './llm/AgentLlmClient.js';
import type { Retriever } from './retrieval/types.js';
import type { RunSupervisorDeps } from './graph/supervisor/index.js';
import { wireProductionDeps, type BootstrapLogger } from './bootstrap/wireDeps.js';
import { runBootstrap, type BootstrapResult } from './bootstrap/index.js';
import { shutdownObservability } from './observability/index.js';
import { applyEvalFixturesFromEnv } from './eval/FixtureToolDispatcher.js';

export interface BuildServerOptions {
  config?: ReturnType<typeof loadConfig>;
  repository?: ConversationRepository;
  cache?: ConversationCache;
  fhirBaseUrl?: string;
  /**
   * Optional LLM client. Tests inject a deterministic stub; production
   * defers LLM construction to the chat route's per-turn factory.
   */
  llmClient?: LlmInvoker | null;
  /**
   * Optional retriever (issue 05/06). When wired, the supervisor's
   * evidence-retriever worker can dispatch over it.
   */
  retriever?: Retriever | null;
  /**
   * Optional pre-built supervisor deps. When provided, the chat route
   * routes every followup through the Pattern A supervisor (issue 11)
   * instead of the Week 1 graph. Production wiring is gated behind
   * AGENTFORGE_SUPERVISOR_ENABLED to keep cold-start safe; tests pass
   * stubs directly.
   */
  supervisorDeps?: RunSupervisorDeps | null;
  /**
   * Bootstrap step results. Surfaced by /bootstrap-status so operators
   * can verify a Railway deploy ran the env-validate / ingest steps
   * without grepping container logs.
   */
  bootstrapResult?: BootstrapResult | null;
}

export async function buildServer(opts: BuildServerOptions = {}): Promise<FastifyInstance> {
  const config = opts.config ?? loadConfig();
  const repository = opts.repository ?? new InMemoryConversationRepository();
  const cache = opts.cache ?? new ConversationCache();
  const fhirBaseUrl = opts.fhirBaseUrl ?? config.OPENEMR_FHIR_BASE_URL;

  const app = Fastify({ logger: { level: process.env['LOG_LEVEL'] ?? 'info' } });

  app.get('/healthz', async () => ({ status: 'ok', uptime: process.uptime() }));

  // Bootstrap status endpoint — operators hit this to see whether the
  // last cold-start successfully ran the env-validate / ingest steps.
  // Unauthenticated on purpose; the payload is summary-only and never
  // contains PHI.
  app.get('/bootstrap-status', async () => {
    const result = opts.bootstrapResult ?? null;
    return { result };
  });

  const tokenProvider = new OpenEmrTokenProvider();
  const tlsInsecure = process.env['OPENEMR_FHIR_TLS_INSECURE'] === '1';

  await app.register(async instance => {
    instance.addHook('preHandler', verifyJwt);
    registerChatRoute(instance, {
      repository,
      cache,
      fhirBaseUrl,
      tokenProvider,
      tlsInsecure,
      llmClient: opts.llmClient ?? null,
      retriever: opts.retriever ?? null,
      supervisorDeps: opts.supervisorDeps ?? null,
    });
    registerConversationRoute(instance, { repository });
    await registerExtractRoute(instance);
  });

  app.addHook('onClose', async () => {
    await shutdownObservability();
  });

  return app;
}

export async function startServer(): Promise<void> {
  const config = loadConfig();
  // Pino-shaped console logger so wireDeps + runBootstrap can structure
  // their output the same way the eventual Fastify logger will.
  const bootLogger: BootstrapLogger = {
    // eslint-disable-next-line no-console
    info: (obj, msg) => console.log(JSON.stringify(typeof obj === 'string'
      ? { level: 'info', msg: obj }
      : { level: 'info', ...obj, msg })),
    // eslint-disable-next-line no-console
    warn: (obj, msg) => console.warn(JSON.stringify(typeof obj === 'string'
      ? { level: 'warn', msg: obj }
      : { level: 'warn', ...obj, msg })),
    // eslint-disable-next-line no-console
    error: (obj, msg) => console.error(JSON.stringify(typeof obj === 'string'
      ? { level: 'error', msg: obj }
      : { level: 'error', ...obj, msg })),
  };

  // Step 0: opt-in eval fixture mode. When AGENTFORGE_EVAL_FIXTURE_PATH
  // is set, override TOOL_REGISTRY chart tools with fixture-backed
  // implementations BEFORE any FHIR client is constructed. Same pattern
  // as `withFixture` in the pipeline tests, just at process startup.
  // Crashes loudly if the path is set but the file is missing/malformed
  // — fixture mode is opt-in, so a misconfigured run should fail at
  // boot, not silently fall through to live FHIR.
  const fixtureMode = applyEvalFixturesFromEnv(process.env, (msg, ctx) =>
    bootLogger.warn({ ...(ctx ?? {}) }, msg),
  );
  if (fixtureMode.active) {
    bootLogger.info(
      { tools_overridden: fixtureMode.toolsOverridden, fixture_path: fixtureMode.path },
      '[agentforge.eval] fixture mode applied at boot',
    );
  }

  // Step 1: build long-lived dependencies (LLM client + retriever).
  const wired = await wireProductionDeps(config, bootLogger);

  // Step 2: run the bootstrap module — env validation, OpenEMR
  // readiness probe, and conditional ingests. Bootstrap NEVER blocks
  // server start; failures are logged.
  const bootstrapResult = await runBootstrap(config, bootLogger).catch(err => {
    bootLogger.error(
      { error: err instanceof Error ? err.message : String(err) },
      '[agentforge.bootstrap] runBootstrap threw — continuing with server start',
    );
    return null;
  });

  const app = await buildServer({
    config,
    llmClient: wired.llmClient,
    retriever: wired.retriever,
    bootstrapResult,
  });
  // Railway injects PORT and probes the service on it. Prefer PORT when set,
  // fall back to AGENT_SERVICE_PORT for local dev / Docker compose.
  const railwayPort = process.env['PORT'];
  const parsedRailwayPort = railwayPort ? Number.parseInt(railwayPort, 10) : NaN;
  const port = railwayPort && Number.isInteger(parsedRailwayPort) && parsedRailwayPort > 0 && parsedRailwayPort < 65536
    ? parsedRailwayPort
    : config.AGENT_SERVICE_PORT;
  // Bind dual-stack (`::`) so Railway's IPv6-only private network
  // (`<service>.railway.internal`) can reach us. Listening on `0.0.0.0`
  // alone makes openemr → agentforge connect-refused on Railway because
  // the internal DNS resolves to AAAA only.
  await app.listen({ port, host: '::' });

  // Graceful shutdown: Fastify does not install signal handlers itself,
  // so SIGTERM (Railway redeploy) / SIGINT (Ctrl-C) would exit before
  // the `onClose` hook runs and the Langfuse client could flush its
  // batched events. Closing the app explicitly here triggers `onClose`,
  // which awaits `shutdownObservability()`.
  const shutdown = (signal: NodeJS.Signals): void => {
    app.log.info({ signal }, '[agentforge] received signal — closing server');
    app.close().finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch(err => {
    // eslint-disable-next-line no-console
    console.error('Failed to start agent server', err);
    process.exit(1);
  });
}
