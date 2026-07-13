/**
 * Environment-loaded configuration. Centralised so the rest of the agent
 * never reaches into process.env directly.
 */

import { z } from 'zod';

const ConfigSchema = z.object({
  AGENTFORGE_JWT_SECRET: z.string().min(32),
  // OpenRouter is the only LLM provider. The sidecar talks to OpenRouter via
  // ChatOpenAI (OpenAI-compatible API) using OPENROUTER_API_KEY +
  // OPENROUTER_BASE_URL.
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().url().optional(),
  OPENROUTER_REFERER: z.string().optional(),
  OPENROUTER_APP_TITLE: z.string().optional(),
  OPENEMR_FHIR_BASE_URL: z.string().url().default('http://localhost/apis/fhir/R4'),
  AGENT_SERVICE_PORT: z.coerce.number().int().positive().default(3000),
  STUB_PLANNER: z.string().optional(),
  // Default routes Claude Haiku 4.5 through OpenRouter. Any OpenRouter slug
  // works (e.g. anthropic/claude-sonnet-4, openai/gpt-4o-mini,
  // google/gemini-2.5-flash).
  AGENTFORGE_MODEL: z.string().default('anthropic/claude-haiku-4.5'),
  // Pinecone — used by the hybrid retriever (issue 05). The index name is
  // versioned (`-v1` suffix); changing the chunking strategy requires a new
  // index version, never a poisoned existing one. Model slugs are pinned —
  // never `latest`.
  PINECONE_API_KEY: z.string().optional(),
  PINECONE_INDEX_NAME: z.string().default('agentforge-guidelines-v1'),
  PINECONE_EMBED_MODEL: z.string().default('llama-text-embed-v2'),
  PINECONE_RERANK_MODEL: z.string().default('cohere-rerank-3.5'),
  PINECONE_RERANK_FALLBACK_MODEL: z.string().default('bge-reranker-v2-m3'),
  PINECONE_CLOUD: z.string().default('aws'),
  PINECONE_REGION: z.string().default('us-east-1'),
  PINECONE_NAMESPACE: z.string().default('__default__'),
  // Set to 1 to enable the (idempotent) guideline ingest at boot or via
  // `npm run ingest:guidelines`. Default off so a cold-start agent
  // service does not attempt to ingest in environments without a
  // Pinecone API key. Auto-set to "1" by the bootstrap module when
  // RAILWAY_ENVIRONMENT is non-empty (mirrors the Synthea seed gate).
  AGENTFORGE_GUIDELINES_INGEST: z.string().optional(),
  // Set to 1 to enable the (idempotent) demo-fixture ingest at boot.
  // Auto-set to "1" by the bootstrap module when RAILWAY_ENVIRONMENT
  // is non-empty.
  AGENTFORGE_FIXTURE_INGEST: z.string().optional(),
  // Base URL the agent uses when reaching the OpenEMR sidecar reader
  // endpoint (interface/agentforge/sidecar.php). Defaults to deriving
  // from OPENEMR_FHIR_BASE_URL's origin when unset.
  OPENEMR_SIDECAR_BASE_URL: z.string().url().optional(),
  // Used by the bootstrap module to short-circuit the OpenEMR readiness
  // probe in environments where polling is unwanted (e.g. an isolated
  // unit-test harness). Defaults: probe runs.
  AGENTFORGE_BOOTSTRAP_SKIP_OPENEMR_PROBE: z.string().optional(),
  // Railway sets this automatically on every deploy. The bootstrap
  // module reads it to decide whether to auto-enable ingest gates.
  RAILWAY_ENVIRONMENT: z.string().optional(),
});

export type AgentConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const formatted = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error('Invalid agent config: ' + formatted);
  }
  return parsed.data;
}

export function isStubPlanner(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['STUB_PLANNER'] === 'true' || env['AGENTFORGE_MODEL'] === 'stub';
}
