/**
 * Idempotent guideline-corpus ingest.
 *
 * Behaviour:
 *   1. If AGENTFORGE_GUIDELINES_INGEST !== '1', log skip and exit.
 *   2. Read every committed corpus file under agent/data/corpus/.
 *      MVP scope: ADA Standards of Care only. The other three sources
 *      (AHA/ACC, USPSTF, KDIGO) ship in a follow-up issue (#14).
 *   3. Load chunks, derive a stable id per chunk, build an in-memory
 *      BM25 index over the same chunk set Pinecone receives.
 *   4. Ensure the integrated Pinecone index exists for the configured
 *      embed model.
 *   5. Upsert chunks in batches of 96. Stable ids mean re-runs
 *      overwrite rather than duplicate.
 *   6. Write the BM25 sidecar to agent/data/corpus/bm25-index.json so
 *      the runtime retriever can hot-load it without re-tokenising.
 *
 * Run with:
 *
 *   AGENTFORGE_GUIDELINES_INGEST=1 PINECONE_API_KEY=... \
 *     npm run ingest:guidelines
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pinecone } from '@pinecone-database/pinecone';
import { z } from 'zod';
import { loadConfig } from '../src/config.js';
import {
  Bm25Index,
  createRealPineconeClient,
} from '../src/retrieval/index.js';
import type { Chunk } from '../src/retrieval/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CORPUS_DIR = join(__dirname, '..', 'data', 'corpus');
const BM25_SIDECAR_PATH = join(CORPUS_DIR, 'bm25-index.json');

const RawCorpusFile = z.object({
  source: z.string().min(1),
  version: z.string().optional(),
  note: z.string().optional(),
  fetched_at: z.string().optional(),
  chunks: z.array(z.object({
    section_id: z.string().min(1),
    page: z.number().int().nonnegative(),
    body: z.string().min(1),
    grade: z.enum(['A', 'B', 'C', 'E']).optional(),
    source_url: z.string().url().optional(),
  })).min(1),
});

interface LoadedCorpus {
  readonly source: string;
  readonly chunks: readonly Chunk[];
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Build a stable, content-derived chunk id. Within a source, the
 * (section_id, body) tuple is unique by construction (each chunk is
 * one numbered recommendation). Different physical chunks under the
 * same section get a per-(source, section) ordinal.
 */
function buildChunks(file: z.infer<typeof RawCorpusFile>): readonly Chunk[] {
  const sourceSlug = slugify(file.source);
  const seen = new Map<string, number>();
  return file.chunks.map(c => {
    const key = `${sourceSlug}::${c.section_id}`;
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    // Encode the chapter number into the id for human readability so
    // re-ingest of the verbatim ADA corpus overwrites cleanly:
    //   {sourceSlug}::ch-{NN}::{section_id}::{ord}
    const chapter = c.section_id.split('.', 1)[0] ?? '';
    const chapterPad = chapter.padStart(2, '0');
    const id = `${sourceSlug}::ch-${chapterPad}::${c.section_id}::${ordinal}`;
    const chunk: Chunk = {
      id,
      source: file.source,
      section_id: c.section_id,
      page: c.page,
      body: c.body,
      ...(c.grade ? { grade: c.grade } : {}),
      ...(c.source_url ? { source_url: c.source_url } : {}),
    };
    return chunk;
  });
}

async function loadCorpora(): Promise<readonly LoadedCorpus[]> {
  const entries = await readdir(CORPUS_DIR);
  const out: LoadedCorpus[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    if (entry === 'bm25-index.json') continue; // sidecar — not a corpus.
    const raw = await readFile(join(CORPUS_DIR, entry), 'utf8');
    const parsed = RawCorpusFile.parse(JSON.parse(raw));
    out.push({
      source: parsed.source,
      chunks: buildChunks(parsed),
    });
  }
  return out;
}

function logInfo(message: string, fields: Record<string, unknown> = {}): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: 'info', component: 'ingest-guidelines', message, ...fields }));
}

function logWarn(message: string, fields: Record<string, unknown> = {}): void {
  // eslint-disable-next-line no-console
  console.warn(JSON.stringify({ level: 'warn', component: 'ingest-guidelines', message, ...fields }));
}

/**
 * Result returned by the programmatic `ingestGuidelines` entry point.
 * Used by the bootstrap module to decide whether the ingest actually
 * touched Pinecone or short-circuited.
 */
export interface IngestGuidelinesResult {
  readonly skipped: boolean;
  readonly reason?: string;
  readonly totalChunks: number;
  readonly sources: number;
  readonly bm25SidecarPath: string;
  readonly pineconeUpserted: boolean;
}

/**
 * Programmatic ingest entry point. Always writes the BM25 sidecar
 * (cheap, local I/O) so the runtime retriever can hot-load it even
 * when Pinecone is unreachable.
 *
 * Idempotency note: the bootstrap caller is expected to short-circuit
 * via `describeIndexStats` BEFORE calling here when the existing index
 * already has the expected chunk count. This function unconditionally
 * upserts when Pinecone is configured — re-runs overwrite cleanly
 * because chunk ids are content-derived.
 */
export async function ingestGuidelines(env: NodeJS.ProcessEnv = process.env): Promise<IngestGuidelinesResult> {
  const config = loadConfig(env);
  const corpora = await loadCorpora();
  if (corpora.length === 0) {
    logWarn('no corpus files found', { dir: CORPUS_DIR });
    return {
      skipped: true,
      reason: 'no_corpus_files',
      totalChunks: 0,
      sources: 0,
      bm25SidecarPath: BM25_SIDECAR_PATH,
      pineconeUpserted: false,
    };
  }

  const allChunks: Chunk[] = [];
  for (const c of corpora) allChunks.push(...c.chunks);

  // Build BM25 sidecar regardless of whether Pinecone is reachable so
  // local-only runs (no API key) still produce the artefact tests rely
  // on.
  const bm25 = new Bm25Index();
  bm25.add(allChunks);
  await writeFile(BM25_SIDECAR_PATH, JSON.stringify(bm25.serialize(), null, 2), 'utf8');
  logInfo('wrote bm25 sidecar', { path: BM25_SIDECAR_PATH, chunks: allChunks.length });

  if (!config.PINECONE_API_KEY) {
    logWarn('PINECONE_API_KEY unset — skipping Pinecone upsert', {
      bm25_sidecar_path: BM25_SIDECAR_PATH,
    });
    return {
      skipped: false,
      totalChunks: allChunks.length,
      sources: corpora.length,
      bm25SidecarPath: BM25_SIDECAR_PATH,
      pineconeUpserted: false,
    };
  }

  const pinecone = new Pinecone({ apiKey: config.PINECONE_API_KEY });
  const client = createRealPineconeClient(pinecone, config.PINECONE_CLOUD, config.PINECONE_REGION);

  await client.ensureIndex(config.PINECONE_INDEX_NAME, config.PINECONE_EMBED_MODEL);
  logInfo('index ready', {
    name: config.PINECONE_INDEX_NAME,
    embed_model: config.PINECONE_EMBED_MODEL,
  });

  for (const corpus of corpora) {
    await client.upsertChunks(config.PINECONE_INDEX_NAME, config.PINECONE_NAMESPACE, corpus.chunks);
    logInfo('upserted corpus', {
      source: corpus.source,
      chunks: corpus.chunks.length,
      namespace: config.PINECONE_NAMESPACE,
    });
  }

  logInfo('ingest complete', { total_chunks: allChunks.length, sources: corpora.length });
  return {
    skipped: false,
    totalChunks: allChunks.length,
    sources: corpora.length,
    bm25SidecarPath: BM25_SIDECAR_PATH,
    pineconeUpserted: true,
  };
}

/**
 * Total chunks that would be upserted if `ingestGuidelines` were
 * called now. Used by the bootstrap idempotency check to compare
 * against the live Pinecone index stats.
 */
export async function expectedChunkCount(): Promise<number> {
  const corpora = await loadCorpora();
  let total = 0;
  for (const c of corpora) total += c.chunks.length;
  return total;
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env['AGENTFORGE_GUIDELINES_INGEST'] !== '1') {
    logInfo('skipping ingest', { reason: 'AGENTFORGE_GUIDELINES_INGEST != 1' });
    return;
  }
  await ingestGuidelines(env);
}

const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ level: 'error', component: 'ingest-guidelines', message }));
    process.exit(1);
  });
}
