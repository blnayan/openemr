/**
 * LlmBboxSelector — text-only LLM step that maps each extracted
 * entity to the OCR line indices that visually constitute its bbox.
 *
 * Why this step exists: Tesseract's line analysis often splits a
 * single visual row across two or three OCR "lines" — most commonly
 * when a lab/intake form prints the test name on one line and its
 * value, units, and reference range on the next, OR when a long unit
 * string ("mL/min/1.73m²") wraps. Pure token-overlap matching can't
 * decide whether two adjacent half-lines belong to one row or two,
 * because tokens from each row legitimately appear in either half.
 *
 * The LLM gets:
 *   - the OCR line list (text + indices, per page)
 *   - the structured VLM extraction (entity text values)
 * and returns a BboxPlan saying, for each entity, which OCR lines on
 * which page form that entity's bbox. The locator unions those lines.
 *
 * Failure isolation: if the LLM call fails, returns invalid JSON,
 * fails Zod validation, or simply isn't configured (no API key), the
 * selector returns null and the locator falls back to its mechanical
 * token-overlap heuristic. Bbox quality degrades but extraction
 * continues — never block on a non-critical step.
 *
 * Cost note: this is a small TEXT-only call (no image), so the input
 * is just the OCR line list (~hundreds of tokens) plus the structured
 * extraction. Suitable for a cheaper model than the VLM (Haiku, GPT-4o
 * mini, Gemini Flash). Configurable via OPENROUTER_BBOX_SELECTOR_MODEL.
 */

import { z, ZodError } from 'zod';
import { BboxPlanSchema, type BboxPlan } from './BboxPlan.js';
import type { OcrPage } from './OcrService.js';

/** Minimal subset of LangChain's ChatModel surface we depend on. */
interface BboxSelectorModel {
  invoke(messages: ReadonlyArray<{ role: string; content: string }>): Promise<{ content: unknown }>;
  withStructuredOutput?<T>(schema: unknown, opts?: unknown): {
    invoke(messages: ReadonlyArray<{ role: string; content: string }>): Promise<T>;
  };
}

/** What the selector needs to know about the structured extraction. */
export interface BboxSelectorEntity {
  /** Stable JSON-path-like ID — see BboxPlan.ts for examples. */
  entity_id: string;
  /** "tight" → name/demographic value; "row" → table-row entity. */
  mode: 'tight' | 'row';
  /** Verbatim text the entity should anchor against. */
  text: string;
}

export interface BboxSelectorRequest {
  ocrPages: ReadonlyArray<OcrPage>;
  entities: ReadonlyArray<BboxSelectorEntity>;
}

export interface LlmBboxSelector {
  select(req: BboxSelectorRequest): Promise<BboxPlan | null>;
}

const SYSTEM_PROMPT = `You map clinical-document extraction entities to the OCR
line indices that form each entity's bounding box.

You receive:
  1. A list of OCR lines per page, each with an integer index and the verbatim
     text the OCR engine read.
  2. A list of entities the upstream extractor identified, each with an
     entity_id, a mode ("tight" or "row"), and the verbatim text.

For each entity, return ONE entry in the output plan:
  - page: the page index the entity lives on.
  - line_indices: the indices of every OCR line that visually constitutes the
    entity's row. When a row wraps across multiple OCR lines (test name on one
    line, value/units on the next; long units that overflow), include all of
    them. Single-line rows produce a single index.
  - word_indices (TIGHT mode only): the indices of just the words on the chosen
    line that hug the value (e.g. "Maria Reyes" not the whole "Patient Name:
    Maria Reyes" line).

Rules:
  - Output indices that exist in the input. Never invent.
  - Order line_indices in reading order (top to bottom).
  - If you cannot find a confident match for an entity, omit it from the plan
    rather than guessing — the locator falls back to a heuristic.
  - Return only valid JSON, no prose.`.trim();

export class OpenRouterBboxSelector implements LlmBboxSelector {
  constructor(private readonly model: BboxSelectorModel) {}

  /**
   * Boot a selector from env. Returns null when no API key is set so
   * the pipeline can degrade gracefully to mechanical matching.
   */
  static async fromEnv(env: NodeJS.ProcessEnv = process.env): Promise<OpenRouterBboxSelector | null> {
    if (!env['OPENROUTER_API_KEY']) return null;
    try {
      const mod = await import('@langchain/openai');
      const ChatOpenAI = (mod as { ChatOpenAI: new (cfg: object) => BboxSelectorModel }).ChatOpenAI;
      const model = env['OPENROUTER_BBOX_SELECTOR_MODEL']
        ?? env['OPENROUTER_VLM_MODEL']
        ?? 'google/gemini-2.5-flash';
      const baseURL = env['OPENROUTER_BASE_URL'] ?? 'https://openrouter.ai/api/v1';
      const defaultHeaders: Record<string, string> = {};
      if (env['OPENROUTER_REFERER']) defaultHeaders['HTTP-Referer'] = env['OPENROUTER_REFERER'];
      if (env['OPENROUTER_APP_TITLE']) defaultHeaders['X-Title'] = env['OPENROUTER_APP_TITLE'];
      return new OpenRouterBboxSelector(new ChatOpenAI({
        model, temperature: 0,
        apiKey: env['OPENROUTER_API_KEY'],
        configuration: {
          baseURL,
          ...(Object.keys(defaultHeaders).length > 0 ? { defaultHeaders } : {}),
        },
      }));
    } catch (err) {
      console.warn('[agentforge] failed to load ChatOpenAI for bbox selector', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async select(req: BboxSelectorRequest): Promise<BboxPlan | null> {
    if (req.entities.length === 0) return { entries: [] };
    const userPrompt = buildUserPrompt(req);
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ];

    try {
      if (typeof this.model.withStructuredOutput === 'function') {
        const structured = this.model.withStructuredOutput<BboxPlan>(BboxPlanSchema);
        return await structured.invoke(messages);
      }
      const response = await this.model.invoke(messages);
      const text = extractText(response.content);
      const parsed = JSON.parse(text) as unknown;
      return BboxPlanSchema.parse(parsed);
    } catch (err) {
      const summary = err instanceof ZodError
        ? err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
        : err instanceof Error ? err.message : String(err);
      console.warn('[agentforge] bbox selector failed; falling back to heuristic locator', {
        error: summary,
      });
      return null;
    }
  }
}

/**
 * Format the OCR pages + entities as a compact text payload the model
 * can reason about deterministically. Pages and lines are indexed
 * verbatim; entities carry their stable IDs so the model can look them
 * up in the response.
 */
export function buildUserPrompt(req: BboxSelectorRequest): string {
  const ocrSection = req.ocrPages.map((p) => {
    const lines = p.lines.map((line, idx) => {
      const wordList = line.words.map((w, wIdx) => `${wIdx}:"${w.text}"`).join(' ');
      return `  line ${idx}: "${line.text}" [words: ${wordList || '(none)'}]`;
    }).join('\n');
    return `PAGE ${p.page} (${p.lines.length} lines):\n${lines || '  (no OCR lines)'}`;
  }).join('\n\n');

  const entitiesSection = req.entities.map((e) =>
    `- ${e.entity_id} [mode=${e.mode}]: "${e.text.replace(/"/g, '\\"')}"`,
  ).join('\n');

  return `OCR LINES\n${ocrSection}\n\nENTITIES\n${entitiesSection}\n\nReturn the BboxPlan now.`;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text?: string } => typeof b === 'object' && b !== null)
      .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .join('');
  }
  return '';
}

export { z };
