/**
 * OpenRouterVlmInvoker unit tests.
 *
 * The invoker delegates to a LangChain-style model object, so the
 * tests inject a minimal stand-in to verify message-building and
 * schema-binding behavior without any network calls.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OpenRouterVlmInvoker } from '../../../src/extraction/OpenRouterVlmInvoker.js';

const sampleSchema = z.object({
  test_name: z.string(),
});

describe('OpenRouterVlmInvoker', () => {
  it('uses withStructuredOutput when the model supports it', async () => {
    const structured = { invoke: vi.fn().mockResolvedValue({ test_name: 'A1c' }) };
    const model = {
      invoke: vi.fn(),
      withStructuredOutput: vi.fn().mockReturnValue(structured),
    };
    const invoker = new OpenRouterVlmInvoker(model);

    const result = await invoker.invoke({
      pages: [{ page: 0, pngBytes: Buffer.from('hi'), imageWidth: 10, imageHeight: 10, originalWidth: 10, originalHeight: 10, trimOffsetLeft: 0, trimOffsetTop: 0 }],
      schema: sampleSchema,
      systemPrompt: 'sys',
      userInstruction: 'extract',
    });

    expect(result).toEqual({ test_name: 'A1c' });
    expect(model.withStructuredOutput).toHaveBeenCalledTimes(1);
    expect(structured.invoke).toHaveBeenCalledTimes(1);
    expect(model.invoke).not.toHaveBeenCalled();
  });

  it('embeds image_url blocks for each rendered page', async () => {
    const structured = { invoke: vi.fn().mockResolvedValue({ test_name: 'A1c' }) };
    const model = {
      invoke: vi.fn(),
      withStructuredOutput: vi.fn().mockReturnValue(structured),
    };
    const invoker = new OpenRouterVlmInvoker(model);

    await invoker.invoke({
      pages: [
        { page: 0, pngBytes: Buffer.from([1, 2, 3]), imageWidth: 10, imageHeight: 10, originalWidth: 10, originalHeight: 10, trimOffsetLeft: 0, trimOffsetTop: 0 },
        { page: 1, pngBytes: Buffer.from([4, 5, 6]), imageWidth: 10, imageHeight: 10, originalWidth: 10, originalHeight: 10, trimOffsetLeft: 0, trimOffsetTop: 0 },
      ],
      schema: sampleSchema,
      systemPrompt: 'sys',
      userInstruction: 'extract',
    });

    const firstCall = (structured.invoke as ReturnType<typeof vi.fn>).mock.calls[0];
    if (!firstCall) throw new Error('expected structured.invoke to be called');
    const messages = firstCall[0];
    expect(Array.isArray(messages)).toBe(true);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
    const userContent = messages[1].content;
    const imageBlocks = userContent.filter((b: { type: string }) => b.type === 'image_url');
    expect(imageBlocks).toHaveLength(2);
    expect(imageBlocks[0].image_url.url).toMatch(/^data:image\/png;base64,/);
  });

  it('falls back to JSON.parse + Zod when withStructuredOutput is unavailable', async () => {
    const model = {
      invoke: vi.fn().mockResolvedValue({ content: '{"test_name":"A1c"}' }),
    };
    const invoker = new OpenRouterVlmInvoker(model);

    const result = await invoker.invoke({
      pages: [{ page: 0, pngBytes: Buffer.from('hi'), imageWidth: 10, imageHeight: 10, originalWidth: 10, originalHeight: 10, trimOffsetLeft: 0, trimOffsetTop: 0 }],
      schema: sampleSchema,
      systemPrompt: 'sys',
      userInstruction: 'extract',
    });

    expect(result).toEqual({ test_name: 'A1c' });
  });

  it('throws when the fallback path receives non-JSON content', async () => {
    const model = {
      invoke: vi.fn().mockResolvedValue({ content: 'not json' }),
    };
    const invoker = new OpenRouterVlmInvoker(model);

    await expect(
      invoker.invoke({
        pages: [{ page: 0, pngBytes: Buffer.from('hi'), imageWidth: 10, imageHeight: 10, originalWidth: 10, originalHeight: 10, trimOffsetLeft: 0, trimOffsetTop: 0 }],
        schema: sampleSchema,
        systemPrompt: 'sys',
        userInstruction: 'extract',
      }),
    ).rejects.toThrow(/non-JSON/);
  });

  it('fromEnv returns null when OPENROUTER_API_KEY is unset', async () => {
    const result = await OpenRouterVlmInvoker.fromEnv({});
    expect(result).toBeNull();
  });
});
