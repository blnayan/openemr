/**
 * GuidelineSynthesizer — turn (question + ranked guideline chunks) into
 * an `Answer` whose every claim carries a `guideline` citation with a
 * verbatim quoted_span.
 *
 * Invariants:
 *   - The synthesizer never invents chunk_ids or section_ids; it can only
 *     cite chunks supplied in `chunks`.
 *   - The synthesizer is told to copy the cited span verbatim. The
 *     downstream verifier (`guidelineVerifier`) substring-checks every
 *     `guideline` citation against the named chunk's body and drops any
 *     claim whose quote is not present.
 *   - On schema-parse failure the synthesizer retries ONCE with the Zod
 *     issues appended to the prompt, then fails loudly.
 *   - Document content and instructions are structurally separated by
 *     `<DOCUMENT_CONTENT>` and `<INSTRUCTIONS>` delimiters so a malicious
 *     guideline body can't trivially impersonate a system instruction
 *     (W2_PRD §"Security baseline").
 */

import type { LlmInvoker, ChatMessage } from '../../llm/AgentLlmClient.js';
import type { RankedChunk } from '../../retrieval/types.js';
import { AnswerSchema, type Answer } from '../../schemas/AnswerSchema.js';

export interface GuidelineSynthesizerInput {
  readonly question: string;
  readonly chunks: readonly RankedChunk[];
}

export class GuidelineSynthesisError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'GuidelineSynthesisError';
  }
}

export class GuidelineSynthesizer {
  constructor(private readonly llm: LlmInvoker) {}

  async synthesize(input: GuidelineSynthesizerInput): Promise<Answer> {
    const { question, chunks } = input;
    if (chunks.length === 0) {
      // No evidence — emit a low-confidence refusal that still satisfies
      // AnswerSchema (single rule:* citation marker).
      return refusal('No matching guideline chunks were retrieved for this question.');
    }

    const systemMessage: ChatMessage = {
      role: 'system',
      content: SYSTEM_PROMPT,
    };
    const userMessage: ChatMessage = {
      role: 'user',
      content: buildUserPrompt(question, chunks),
    };

    const first = await this.llm.chat([systemMessage, userMessage]);
    const firstParse = tryParse(first.content);
    if (firstParse.ok) return firstParse.answer;

    // Retry once with the validation feedback so the model can self-correct.
    const retry = await this.llm.chat([
      systemMessage,
      userMessage,
      { role: 'assistant', content: first.content },
      {
        role: 'user',
        content:
          'Your previous reply did not parse as the required JSON schema. ' +
          `Validation issues:\n${firstParse.issues}\n\n` +
          'Reply again with corrected JSON only — no prose, no code fences.',
      },
    ]);
    const secondParse = tryParse(retry.content);
    if (secondParse.ok) return secondParse.answer;

    throw new GuidelineSynthesisError(
      'GuidelineSynthesizer LLM output failed AnswerSchema validation twice',
      secondParse.issues,
    );
  }
}

interface ParseOk { readonly ok: true; readonly answer: Answer; }
interface ParseFail { readonly ok: false; readonly issues: string; }
type ParseResult = ParseOk | ParseFail;

function tryParse(raw: string): ParseResult {
  const stripped = stripJsonFences(raw).trim();
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(stripped);
  } catch (err) {
    return { ok: false, issues: `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const result = AnswerSchema.safeParse(parsedJson);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues
        .map(i => `- ${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('\n'),
    };
  }
  return { ok: true, answer: result.data };
}

function stripJsonFences(s: string): string {
  // Allow models that wrap JSON in ```json ... ``` despite our instructions.
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced && fenced[1]) return fenced[1];
  return s;
}

function refusal(reason: string): Answer {
  return {
    summary: `I do not have sufficient guideline evidence to answer this. (${reason})`,
    claims: [
      {
        text: 'No verifiable guideline evidence was available for this question.',
        citation_ids: ['rule:no-data:guideline-corpus'],
        severity: 'info',
      },
    ],
    conflicts: [],
    data_gaps: [],
    assumptions: [],
    evidence_catalog: [],
    followup_suggestions: [],
    confidence: 'low',
  };
}

const SYSTEM_PROMPT = `You are AgentForge's guideline-grounded synthesizer.

You produce a single JSON object that conforms to the AnswerSchema below. Every
claim in your answer MUST be grounded in a chunk supplied in DOCUMENT_CONTENT.
You may not invent facts, chunk_ids, or section_ids.

For every claim include:
- "text": a concise statement (<=500 chars) about what the guideline says.
- "citation_ids": at least one entry of the form
  "rule:guideline:<a-z0-9-dash-only-slug-of-the-section_id>" — for example a
  citation pointing at section "6.3a" becomes "rule:guideline:section-6-3a".
  Only [a-zA-Z0-9_-] characters are allowed after the second colon.
- "citations": an array containing at least one object of shape
  {
    "type": "guideline",
    "chunk_id": "<exact chunk id from DOCUMENT_CONTENT>",
    "source": "<exact source string from DOCUMENT_CONTENT>",
    "section_id": "<exact section_id from DOCUMENT_CONTENT>",
    "quoted_span": "<verbatim slice of the chunk body that supports the claim>"
  }.
- "severity": one of "info" | "attention" | "urgent". Use "info" for guideline
  recommendations unless the question raises an immediate safety concern.

Rules:
- "quoted_span" MUST be a verbatim contiguous substring of the named chunk's
  body. A downstream verifier substring-checks this and drops any claim that
  fails. Do not paraphrase. Do not stitch together pieces.
- Prefer the shortest verbatim span that supports the claim; quotes that span
  unrelated sentences will be rejected.
- If the supplied chunks do not actually answer the question, say so plainly
  in the summary, set confidence to "low", and emit at most one claim citing
  the closest chunk verbatim — or no claims at all and a single
  "rule:no-data:guideline-corpus" citation_id.

Summary formatting — bold concrete clinical values:
- When the "summary" mentions a concrete clinical numeric (an A1c target like
  7.0%, an LDL cutoff like 100 mg/dL, a BP threshold like 130/80, a dose),
  wrap that value in markdown bold using \`**...**\`. Example:
    "ADA recommends an A1c goal of **<7.0%** for most non-pregnant adults."
- Bold only the value run, not surrounding prose, and apply it ONLY to the
  "summary" field (NOT to claim "text" — claims render separately and the
  asterisks would leak into the chip-row UI).

Reply with the JSON object only. No prose. No code fences.`;

function buildUserPrompt(question: string, chunks: readonly RankedChunk[]): string {
  const lines: string[] = [];
  lines.push('<DOCUMENT_CONTENT>');
  lines.push('The following ranked guideline chunks are the ONLY evidence you may cite.');
  lines.push('Each chunk is delimited by "<<<CHUNK>>>" markers.');
  lines.push('');
  for (const c of chunks) {
    lines.push('<<<CHUNK>>>');
    lines.push(`chunk_id: ${c.id}`);
    lines.push(`source: ${c.source}`);
    lines.push(`section_id: ${c.section_id}`);
    lines.push(`page: ${c.page}`);
    if (c.grade) lines.push(`grade: ${c.grade}`);
    lines.push(`rerank_score: ${c.score}`);
    lines.push('body:');
    lines.push(c.body);
    lines.push('<<<END_CHUNK>>>');
    lines.push('');
  }
  lines.push('</DOCUMENT_CONTENT>');
  lines.push('');
  lines.push('<INSTRUCTIONS>');
  lines.push(`Question: ${question}`);
  lines.push('');
  lines.push('Produce the AnswerSchema JSON object grounding every claim in the chunks above.');
  lines.push('</INSTRUCTIONS>');
  return lines.join('\n');
}
