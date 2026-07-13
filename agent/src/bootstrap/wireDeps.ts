/**
 * wireDeps — server-wide dependency construction for the production
 * agent service.
 *
 * Today this builds the long-lived dependencies that don't need a
 * per-request JWT: the OpenRouter-backed LlmInvoker and the hybrid
 * Retriever (Pinecone + BM25 sidecar). The chat route assembles the
 * remaining per-request supervisor deps (intake/clinical workers +
 * patient-document verifier + JWT-bound SidecarHttpClient) on each
 * turn, because those carry an inbound scoped JWT that the agent
 * service must not see at boot.
 *
 * Each piece returns null gracefully when its required env vars are
 * unset, so a cold-start agent without a Pinecone API key still serves
 * /healthz and the Week-1 followup path.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pinecone } from '@pinecone-database/pinecone';
import {
  Bm25Index,
  createRealPineconeClient,
  createRetriever,
  DEFAULT_RETRIEVAL_CONFIG,
  type Retriever,
  type SerializedBm25,
  type Chunk,
} from '../retrieval/index.js';
import { AgentLlmClient, type LlmInvoker } from '../llm/AgentLlmClient.js';
import type { AgentConfig } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CORPUS_DIR = join(__dirname, '..', '..', 'data', 'corpus');
const BM25_SIDECAR_PATH = join(CORPUS_DIR, 'bm25-index.json');

/** Structured logger interface — pino-shaped, uses fastify's logger in prod. */
export interface BootstrapLogger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

export interface WiredProductionDeps {
  readonly llmClient: LlmInvoker | null;
  readonly retriever: Retriever | null;
  readonly chunks: readonly Chunk[];
  /**
   * One-line gap reasons. Empty when all features are reachable.
   * Surfaced in startup logs and on /bootstrap-status so operators
   * can spot a misconfigured deploy without grepping container logs.
   */
  readonly degraded: readonly string[];
}

/**
 * Build the long-lived agent-service dependencies from config + env.
 * Never throws — every failure mode degrades to null and is recorded
 * in `degraded`.
 */
export async function wireProductionDeps(
  config: AgentConfig,
  logger: BootstrapLogger,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WiredProductionDeps> {
  const degraded: string[] = [];

  const llmClient = await buildLlmClient(env, logger, degraded);
  const { retriever, chunks } = await buildRetriever(config, logger, degraded);

  if (degraded.length > 0) {
    logger.warn(
      { degraded },
      '[agentforge.bootstrap] some features are degraded — see reasons',
    );
  } else {
    logger.info({}, '[agentforge.bootstrap] production deps wired (llm + retriever)');
  }

  return { llmClient, retriever, chunks, degraded };
}

async function buildLlmClient(
  env: NodeJS.ProcessEnv,
  logger: BootstrapLogger,
  degraded: string[],
): Promise<LlmInvoker | null> {
  if (!env['OPENROUTER_API_KEY']) {
    const reason = 'llm disabled: OPENROUTER_API_KEY unset';
    degraded.push(reason);
    logger.warn({ reason }, '[agentforge.bootstrap] LLM client not constructed');
    return null;
  }
  try {
    const client = await AgentLlmClient.fromEnv(env);
    if (client === null) {
      const reason = 'llm disabled: AgentLlmClient.fromEnv returned null';
      degraded.push(reason);
      logger.warn({ reason }, '[agentforge.bootstrap] LLM client construction returned null');
      return null;
    }
    logger.info({ model: env['AGENTFORGE_MODEL'] ?? 'anthropic/claude-haiku-4.5' },
      '[agentforge.bootstrap] LLM client ready');
    return client;
  } catch (err) {
    const reason = `llm disabled: ${stringifyError(err)}`;
    degraded.push(reason);
    logger.warn({ reason }, '[agentforge.bootstrap] LLM client construction threw');
    return null;
  }
}

async function buildRetriever(
  config: AgentConfig,
  logger: BootstrapLogger,
  degraded: string[],
): Promise<{ retriever: Retriever | null; chunks: readonly Chunk[] }> {
  if (!config.PINECONE_API_KEY) {
    const reason = 'retriever disabled: PINECONE_API_KEY unset';
    degraded.push(reason);
    logger.warn({ reason }, '[agentforge.bootstrap] retriever not constructed');
    return { retriever: null, chunks: [] };
  }

  const chunks = await loadCorpusChunks(logger, degraded);
  const bm25 = await loadBm25Index(chunks, logger);

  try {
    const pinecone = new Pinecone({ apiKey: config.PINECONE_API_KEY });
    const pineconeClient = createRealPineconeClient(
      pinecone,
      config.PINECONE_CLOUD,
      config.PINECONE_REGION,
    );
    const retriever = createRetriever(
      {
        ...DEFAULT_RETRIEVAL_CONFIG,
        indexName: config.PINECONE_INDEX_NAME,
        embedModel: config.PINECONE_EMBED_MODEL,
        rerankModel: config.PINECONE_RERANK_MODEL,
        rerankFallbackModel: config.PINECONE_RERANK_FALLBACK_MODEL,
        namespace: config.PINECONE_NAMESPACE,
      },
      { pinecone: pineconeClient, bm25, chunks },
    );
    logger.info(
      {
        index: config.PINECONE_INDEX_NAME,
        embed_model: config.PINECONE_EMBED_MODEL,
        rerank_model: config.PINECONE_RERANK_MODEL,
        chunks: chunks.length,
      },
      '[agentforge.bootstrap] retriever ready',
    );
    return { retriever, chunks };
  } catch (err) {
    const reason = `retriever disabled: ${stringifyError(err)}`;
    degraded.push(reason);
    logger.warn({ reason }, '[agentforge.bootstrap] retriever construction threw');
    return { retriever: null, chunks };
  }
}

interface RawCorpusFile {
  readonly source: string;
  readonly chunks: ReadonlyArray<{
    readonly section_id: string;
    readonly page: number;
    readonly body: string;
    readonly grade?: 'A' | 'B' | 'C' | 'E';
    readonly source_url?: string;
  }>;
}

async function loadCorpusChunks(
  logger: BootstrapLogger,
  degraded: string[],
): Promise<readonly Chunk[]> {
  if (!existsSync(CORPUS_DIR)) {
    const reason = `corpus dir missing: ${CORPUS_DIR}`;
    degraded.push(reason);
    logger.warn({ reason }, '[agentforge.bootstrap] corpus dir missing');
    return [];
  }
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(CORPUS_DIR);
  const chunks: Chunk[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    if (entry === 'bm25-index.json') continue;
    try {
      const raw = await readFile(join(CORPUS_DIR, entry), 'utf8');
      const parsed = JSON.parse(raw) as RawCorpusFile;
      if (!parsed.source || !Array.isArray(parsed.chunks)) continue;
      const sourceSlug = slugify(parsed.source);
      const seen = new Map<string, number>();
      for (const c of parsed.chunks) {
        const key = `${sourceSlug}::${c.section_id}`;
        const ordinal = seen.get(key) ?? 0;
        seen.set(key, ordinal + 1);
        const chapter = c.section_id.split('.', 1)[0] ?? '';
        const chapterPad = chapter.padStart(2, '0');
        const id = `${sourceSlug}::ch-${chapterPad}::${c.section_id}::${ordinal}`;
        chunks.push({
          id,
          source: parsed.source,
          section_id: c.section_id,
          page: c.page,
          body: c.body,
          ...(c.grade ? { grade: c.grade } : {}),
          ...(c.source_url ? { source_url: c.source_url } : {}),
        });
      }
    } catch (err) {
      logger.warn({ file: entry, error: stringifyError(err) },
        '[agentforge.bootstrap] failed to load corpus file');
    }
  }
  return chunks;
}

async function loadBm25Index(
  chunks: readonly Chunk[],
  logger: BootstrapLogger,
): Promise<Bm25Index> {
  if (existsSync(BM25_SIDECAR_PATH)) {
    try {
      const raw = await readFile(BM25_SIDECAR_PATH, 'utf8');
      const data = JSON.parse(raw) as SerializedBm25;
      const idx = Bm25Index.deserialize(data);
      logger.info({ path: BM25_SIDECAR_PATH }, '[agentforge.bootstrap] BM25 sidecar hot-loaded');
      return idx;
    } catch (err) {
      logger.warn({ error: stringifyError(err) },
        '[agentforge.bootstrap] BM25 sidecar load failed; rebuilding from chunks');
    }
  } else {
    logger.warn({ path: BM25_SIDECAR_PATH },
      '[agentforge.bootstrap] BM25 sidecar missing; rebuilding from chunks');
  }
  const idx = new Bm25Index();
  if (chunks.length > 0) idx.add(chunks);
  return idx;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
