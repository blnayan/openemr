/**
 * OpenRouterVlmInvoker — production VLM invoker that calls Qwen 2.5 VL
 * (or whatever OPENROUTER_VLM_MODEL points at) via OpenRouter using the
 * existing OpenAI-compatible @langchain/openai client.
 *
 * Strategy:
 * 1. Build a multimodal message: system prompt + user instruction +
 *    an image_url block per rendered page (PNGs converted to data
 *    URIs in-process).
 * 2. Use LangChain's `withStructuredOutput(zodSchema)` to bind the
 *    Zod schema as the expected response shape. Under the hood that
 *    surface coerces the response into the schema or throws ZodError,
 *    which is exactly what VlmExtractor's retry loop expects.
 *
 * Falls back to manual JSON.parse + Zod parse if the model adapter
 * does not support `withStructuredOutput` (e.g. providers that don't
 * expose tool-calling). The fallback still surfaces ZodError on
 * validation failure so the retry loop works identically.
 */

import { ZodError, type ZodType } from 'zod';
import type { VlmInvokeRequest, VlmInvoker } from './types.js';

interface StructuredModelLike<T> {
  invoke(messages: unknown): Promise<T>;
}

interface RawModelLike {
  invoke(messages: unknown): Promise<{ content: unknown }>;
  withStructuredOutput?<T>(schema: unknown, opts?: unknown): StructuredModelLike<T>;
}

const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
// Default VLM is google/gemini-2.5-pro. Gemini 2.5 Flash (the prior
// default) under-read dense lab tables — entire result rows were
// dropped or returned with null numerics. Pro is meaningfully better at
// reading small lab numerics and table rows, at a higher per-call cost
// that is still bounded for the MVP demo. Vision + tool-use are both
// supported on OpenRouter, and running a different provider from the
// chat model (anthropic via AGENTFORGE_MODEL) avoids one provider
// being a single point of failure. The VlmExtractor binds an `extract`
// tool via withStructuredOutput, so a model with tool-use is required;
// we previously tried qwen/qwen2.5-vl-72b-instruct but OpenRouter
// returned `404 No endpoints found that support tool use` because no
// tool-calling endpoint is advertised for that model.
//
// Override at runtime with OPENROUTER_VLM_MODEL.
const OPENROUTER_DEFAULT_VLM_MODEL = 'google/gemini-2.5-pro';

export class OpenRouterVlmInvoker implements VlmInvoker {
  constructor(private readonly model: RawModelLike) {}

  static async fromEnv(env: NodeJS.ProcessEnv = process.env): Promise<OpenRouterVlmInvoker | null> {
    if (!env['OPENROUTER_API_KEY']) {
      console.warn('[agentforge] OPENROUTER_API_KEY unset; VLM extraction disabled');
      return null;
    }
    try {
      const mod = await import('@langchain/openai');
      const ChatOpenAI = (mod as { ChatOpenAI: new (cfg: object) => RawModelLike }).ChatOpenAI;
      const model = env['OPENROUTER_VLM_MODEL'] ?? OPENROUTER_DEFAULT_VLM_MODEL;
      const baseURL = env['OPENROUTER_BASE_URL'] ?? OPENROUTER_DEFAULT_BASE_URL;
      const defaultHeaders: Record<string, string> = {};
      if (env['OPENROUTER_REFERER']) defaultHeaders['HTTP-Referer'] = env['OPENROUTER_REFERER'];
      if (env['OPENROUTER_APP_TITLE']) defaultHeaders['X-Title'] = env['OPENROUTER_APP_TITLE'];
      const config: Record<string, unknown> = {
        model,
        temperature: 0,
        apiKey: env['OPENROUTER_API_KEY'],
        configuration: {
          baseURL,
          ...(Object.keys(defaultHeaders).length > 0 ? { defaultHeaders } : {}),
        },
      };
      return new OpenRouterVlmInvoker(new ChatOpenAI(config));
    } catch (err) {
      console.warn('[agentforge] failed to load ChatOpenAI for VLM', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async invoke<T>(req: VlmInvokeRequest<T>): Promise<T> {
    const messages = this.buildMessages(req);

    if (typeof this.model.withStructuredOutput === 'function') {
      // We omit the `method` flag intentionally — LangChain defaults
      // to function-calling, which is what OpenRouter accepts most
      // reliably across providers. `jsonSchema` mode is rejected by
      // Gemini through OpenRouter (400 Provider returned error) and
      // `jsonMode` doesn't enforce nested-object types. Gemini still
      // sometimes serializes required bbox fields as strings under
      // function-calling, so the BboxSchema preprocess normalizes
      // those forms downstream.
      const structured = this.model.withStructuredOutput<T>(req.schema);
      try {
        return await structured.invoke(messages);
      } catch (err) {
        // LangChain may surface upstream errors as plain Errors with
        // ZodError-style messages. Re-throw as-is; VlmExtractor sniffs
        // for ZodError or zod-like errors to drive retry.
        throw err;
      }
    }

    const response = await this.model.invoke(messages);
    const text = extractText(response.content);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (jsonErr) {
      throw new Error(`VLM returned non-JSON content: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`);
    }
    return req.schema.parse(parsed);
  }

  private buildMessages<T>(req: VlmInvokeRequest<T>): Array<Record<string, unknown>> {
    const userContent: Array<Record<string, unknown>> = [
      { type: 'text', text: req.userInstruction },
      ...req.pages.map((p) => ({
        type: 'image_url',
        image_url: { url: pageToDataUri(p.pngBytes) },
      })),
    ];
    return [
      { role: 'system', content: req.systemPrompt },
      { role: 'user', content: userContent },
    ];
  }
}

function pageToDataUri(pngBytes: Buffer): string {
  return `data:image/png;base64,${pngBytes.toString('base64')}`;
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

// Re-export for callers
export { ZodError };
