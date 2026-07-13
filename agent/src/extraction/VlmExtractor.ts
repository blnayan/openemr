/**
 * VlmExtractor — runs a single-pass VLM extraction with one retry on
 * Zod-validation failure. Decoupled from the OpenRouter client (a
 * VlmInvoker is injected) so unit tests can drive the retry path
 * deterministically.
 *
 * Retry policy: at most one retry per call. The retry feeds the Zod
 * validation error back into the VLM as a system message ("your
 * previous response failed validation: <issue>; return only valid
 * JSON conforming to the schema"). A second failure throws and the
 * caller marks the extraction failed.
 */

import { ZodError, type ZodType } from 'zod';
import type { VlmInvoker, VlmInvokeRequest } from './types.js';

export class SchemaValidationFailed extends Error {
  constructor(
    public readonly attempts: number,
    public readonly lastIssues: string,
  ) {
    super(`VLM extraction failed schema validation after ${attempts} attempt(s): ${lastIssues}`);
    this.name = 'SchemaValidationFailed';
  }
}

export class VlmExtractor {
  public static readonly MAX_ATTEMPTS = 2;

  constructor(private readonly invoker: VlmInvoker) {}

  /**
   * Invoke the VLM with the supplied schema. Retries once if the
   * first attempt fails Zod validation, feeding the validation
   * error back into the VLM as additional context.
   */
  async extract<T>(req: ExtractRequest<T>): Promise<T> {
    let lastIssues = '';
    let attempt = 0;
    while (attempt < VlmExtractor.MAX_ATTEMPTS) {
      attempt += 1;
      const userInstruction = attempt === 1
        ? req.userInstruction
        : `${req.userInstruction}\n\nNOTE — your previous response failed schema validation:\n${lastIssues}\nReturn only valid JSON strictly conforming to the schema.`;
      try {
        return await this.invoker.invoke<T>({
          pages: req.pages,
          schema: req.schema,
          systemPrompt: req.systemPrompt,
          userInstruction,
        });
      } catch (err) {
        if (err instanceof ZodError) {
          lastIssues = formatZodIssues(err);
          continue;
        }
        if (isZodLikeError(err)) {
          lastIssues = (err as Error).message;
          continue;
        }
        throw err;
      }
    }
    throw new SchemaValidationFailed(VlmExtractor.MAX_ATTEMPTS, lastIssues);
  }
}

export interface ExtractRequest<T> {
  pages: VlmInvokeRequest<T>['pages'];
  schema: ZodType<T>;
  systemPrompt: string;
  userInstruction: string;
}

function formatZodIssues(err: ZodError): string {
  return err.issues
    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ');
}

function isZodLikeError(err: unknown): boolean {
  // The OpenAI structured-output path can surface schema failures as
  // wrapped errors whose name is "ZodError" but whose constructor has
  // travelled through the LangChain runtime and is no longer the same
  // identity. Fall back to a name + shape sniff so we still treat it
  // as retryable.
  return (
    err instanceof Error
    && (err.name === 'ZodError' || /failed.*valid|schema.*invalid/i.test(err.message))
  );
}
