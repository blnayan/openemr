/**
 * grounded-chat integration test — Tuesday-milestone acceptance.
 *
 * The system answers "what is the ADA A1c target for adults without
 * significant comorbidities?" and the response must:
 *   1. Parse as AnswerSchema.
 *   2. Carry at least one `guideline` citation whose source string is
 *      the ADA corpus name.
 *   3. Have its quoted_span be a substring of the body of the chunk
 *      identified by chunk_id.
 *   4. Survive the live verifier path (`verifyGuidelineCitations`
 *      keeps at least one claim).
 *
 * Hermetic: Pinecone is stubbed with chunks loaded from the real ADA
 * corpus JSON; OpenRouter is stubbed with a canned response that
 * quotes verbatim from the real chunk body.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runGroundedChat } from '../../src/graph/workers/runGroundedChat.js';
import { AnswerSchema, type Citation } from '../../src/schemas/AnswerSchema.js';
import type {
  Retriever,
  RankedChunk,
  Chunk,
} from '../../src/retrieval/types.js';
import type { LlmInvoker, ChatResponse } from '../../src/llm/AgentLlmClient.js';

const ADA_SOURCE = 'ADA Standards of Care in Diabetes—2026';

interface CorpusFile {
  readonly source: string;
  readonly chunks: ReadonlyArray<{
    readonly section_id: string;
    readonly page: number;
    readonly body: string;
    readonly grade?: 'A' | 'B' | 'C' | 'E';
    readonly source_url?: string;
  }>;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Mirrors `scripts/ingest-guidelines.ts#buildChunks` so our chunk ids
 *  match the live Pinecone ids byte-for-byte. */
function loadAdaChunks(): readonly Chunk[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const corpusPath = join(here, '..', '..', 'data', 'corpus', 'ada-standards-of-care-2026.json');
  const json = JSON.parse(readFileSync(corpusPath, 'utf8')) as CorpusFile;
  const sourceSlug = slugify(json.source);
  const seen = new Map<string, number>();
  return json.chunks.map(c => {
    const key = `${sourceSlug}::${c.section_id}`;
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    const chapter = c.section_id.split('.', 1)[0] ?? '';
    const chapterPad = chapter.padStart(2, '0');
    const id = `${sourceSlug}::ch-${chapterPad}::${c.section_id}::${ordinal}`;
    return {
      id,
      source: json.source,
      section_id: c.section_id,
      page: c.page,
      body: c.body,
      ...(c.grade !== undefined ? { grade: c.grade } : {}),
      ...(c.source_url !== undefined ? { source_url: c.source_url } : {}),
    };
  });
}

function pickChunk(corpus: readonly Chunk[], sectionId: string): Chunk {
  const c = corpus.find(x => x.section_id === sectionId);
  if (!c) throw new Error(`section_id ${sectionId} missing from corpus`);
  return c;
}

function rerankChunks(corpus: readonly Chunk[], sectionIds: readonly string[]): RankedChunk[] {
  return sectionIds.map((sid, i) => {
    const c = pickChunk(corpus, sid);
    return {
      id: c.id,
      source: c.source,
      section_id: c.section_id,
      page: c.page,
      body: c.body,
      score: 1 - i * 0.05,
      ...(c.grade !== undefined ? { grade: c.grade } : {}),
    };
  });
}

function makeStubRetriever(chunks: readonly RankedChunk[]): Retriever {
  return { retrieve: async () => chunks };
}

function makeStubLlm(responseJson: object): LlmInvoker {
  return {
    chat: async (): Promise<ChatResponse> => ({
      content: JSON.stringify(responseJson),
      toolCalls: [],
    }),
    chatWithTools: async (): Promise<ChatResponse> => ({ content: '', toolCalls: [] }),
  };
}

describe('grounded chat — ADA A1C target end-to-end', () => {
  it('answers with at least one verified guideline citation pointing at the ADA corpus', async () => {
    const corpus = loadAdaChunks();
    const targetChunk = pickChunk(corpus, '6.3a');
    // Sanity: the chunk we'll cite is the canonical A1C target sentence.
    expect(targetChunk.body).toContain('An A1C goal of <7%');

    const ranked = rerankChunks(corpus, ['6.3a', '6.3b', '6.4']);

    // Canned synthesizer output that quotes verbatim from the chunk above.
    const cannedAnswer = {
      summary:
        'The ADA recommends an A1C goal of <7% for many nonpregnant adults without severe hypoglycemia or factors that would justify a less stringent goal.',
      claims: [
        {
          text: 'For many nonpregnant adults without severe hypoglycemia, the ADA recommends an A1C goal of <7% (53 mmol/mol).',
          citation_ids: ['rule:guideline:ada-2026-6-3a'],
          citations: [
            {
              type: 'guideline',
              chunk_id: targetChunk.id,
              source: targetChunk.source,
              section_id: targetChunk.section_id,
              quoted_span: 'An A1C goal of <7% (<53 mmol/mol) is appropriate for many nonpregnant adults',
            },
          ],
          severity: 'info',
        },
      ],
      followup_suggestions: ['Consider less stringent goals for older or frail patients.'],
      confidence: 'high',
    };

    const result = await runGroundedChat(
      'What is the ADA A1c target for adults without significant comorbidities?',
      {
        retriever: makeStubRetriever(ranked),
        llm: makeStubLlm(cannedAnswer),
      },
    );

    // 1. Parse as AnswerSchema.
    const parsed = AnswerSchema.safeParse(result.answer);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('answer did not parse');

    // 2. At least one guideline citation with source = ADA corpus.
    const guidelineCits: Citation[] = [];
    for (const c of parsed.data.claims) {
      for (const cit of c.citations ?? []) {
        if (cit.type === 'guideline') guidelineCits.push(cit);
      }
    }
    expect(guidelineCits.length).toBeGreaterThanOrEqual(1);
    const adaCit = guidelineCits.find(c => c.type === 'guideline' && c.source === ADA_SOURCE);
    expect(adaCit).toBeDefined();
    if (!adaCit || adaCit.type !== 'guideline') throw new Error('no ADA cite');

    // 3. quoted_span is a substring of the chunk body identified by chunk_id.
    const citedChunk = corpus.find(c => c.id === adaCit.chunk_id);
    expect(citedChunk).toBeDefined();
    expect(citedChunk?.body).toContain(adaCit.quoted_span);

    // 4. The verifier kept the claim (no claims dropped → grounded result).
    expect(result.droppedClaims).toBe(0);
    expect(result.answer.claims.length).toBeGreaterThanOrEqual(1);
  });

  it('degrades to a low-confidence refusal when every claim is paraphrased (verifier drops all)', async () => {
    const corpus = loadAdaChunks();
    const ranked = rerankChunks(corpus, ['6.3a']);

    const targetChunkId = pickChunk(corpus, '6.3a').id;
    const cannedAnswer = {
      summary: 'Per ADA, the A1C target for healthy adults is below seven percent.',
      claims: [
        {
          text: 'ADA recommends A1C below seven percent.',
          citation_ids: ['rule:guideline:ada-2026-6-3a'],
          citations: [
            {
              type: 'guideline',
              chunk_id: targetChunkId,
              source: ADA_SOURCE,
              section_id: '6.3a',
              // Not a verbatim substring — a paraphrase. The verifier drops it.
              quoted_span: 'A1C below seven percent for healthy adults',
            },
          ],
          severity: 'info',
        },
      ],
      followup_suggestions: [],
      confidence: 'high',
    };

    const result = await runGroundedChat('ADA A1c target for healthy adults?', {
      retriever: makeStubRetriever(ranked),
      llm: makeStubLlm(cannedAnswer),
    });

    expect(result.droppedClaims).toBe(1);
    expect(result.answer.confidence).toBe('low');
    // The refusal carries a single rule:no-data citation_id, no rich citations.
    const allRichCits = result.answer.claims.flatMap(c => c.citations ?? []);
    expect(allRichCits.length).toBe(0);
  });
});
