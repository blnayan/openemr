/**
 * VlmExtractor unit tests — exercises the retry-on-validation-failure
 * contract with a mock VlmInvoker.
 */

import { describe, expect, it, vi } from 'vitest';
import { z, ZodError } from 'zod';
import { VlmExtractor, SchemaValidationFailed } from '../../../src/extraction/VlmExtractor.js';
import type { VlmInvoker } from '../../../src/extraction/types.js';

const sampleSchema = z.object({
  test_name: z.string(),
  numeric_value: z.number(),
});

type Sample = z.infer<typeof sampleSchema>;

const samplePages = [
  {
    page: 0,
    pngBytes: Buffer.from('fake-png'),
    imageWidth: 1000,
    imageHeight: 1400,
    originalWidth: 1000,
    originalHeight: 1400,
    trimOffsetLeft: 0,
    trimOffsetTop: 0,
  },
];

const sampleRequest = {
  pages: samplePages,
  schema: sampleSchema,
  systemPrompt: 'You are an extractor.',
  userInstruction: 'Extract the lab result.',
};

describe('VlmExtractor', () => {
  it('returns the parsed object on a happy first attempt', async () => {
    const expected: Sample = { test_name: 'A1c', numeric_value: 7.8 };
    const invoker: VlmInvoker = {
      invoke: vi.fn().mockResolvedValueOnce(expected),
    };

    const extractor = new VlmExtractor(invoker);
    const result = await extractor.extract(sampleRequest);

    expect(result).toEqual(expected);
    expect(invoker.invoke).toHaveBeenCalledTimes(1);
  });

  it('retries once when the first attempt throws ZodError', async () => {
    const expected: Sample = { test_name: 'A1c', numeric_value: 7.8 };
    const zodErr = new ZodError([
      { code: 'invalid_type', expected: 'number', received: 'string', path: ['numeric_value'], message: 'Expected number, received string' } as never,
    ]);
    const invoker: VlmInvoker = {
      invoke: vi.fn()
        .mockRejectedValueOnce(zodErr)
        .mockResolvedValueOnce(expected),
    };

    const extractor = new VlmExtractor(invoker);
    const result = await extractor.extract(sampleRequest);

    expect(result).toEqual(expected);
    expect(invoker.invoke).toHaveBeenCalledTimes(2);
  });

  it('feeds the validation error back into the second attempt', async () => {
    const expected: Sample = { test_name: 'A1c', numeric_value: 7.8 };
    const zodErr = new ZodError([
      { code: 'invalid_type', expected: 'number', received: 'string', path: ['numeric_value'], message: 'Expected number, received string' } as never,
    ]);
    const invoker: VlmInvoker = {
      invoke: vi.fn()
        .mockRejectedValueOnce(zodErr)
        .mockResolvedValueOnce(expected),
    };

    const extractor = new VlmExtractor(invoker);
    await extractor.extract(sampleRequest);

    const secondCallArgs = (invoker.invoke as ReturnType<typeof vi.fn>).mock.calls[1];
    if (!secondCallArgs) throw new Error('expected invoker.invoke to be called twice');
    const secondCall = secondCallArgs[0];
    expect(secondCall.userInstruction).toContain(sampleRequest.userInstruction);
    expect(secondCall.userInstruction).toContain('previous response failed schema validation');
    expect(secondCall.userInstruction).toMatch(/numeric_value/);
  });

  it('throws SchemaValidationFailed when both attempts fail', async () => {
    const zodErr = new ZodError([
      { code: 'invalid_type', expected: 'number', received: 'string', path: ['numeric_value'], message: 'bad type' } as never,
    ]);
    const invoker: VlmInvoker = {
      invoke: vi.fn().mockRejectedValue(zodErr),
    };

    const extractor = new VlmExtractor(invoker);

    await expect(extractor.extract(sampleRequest)).rejects.toThrow(SchemaValidationFailed);
    expect(invoker.invoke).toHaveBeenCalledTimes(2);
  });

  it('does not retry on non-validation errors', async () => {
    const networkErr = new Error('ECONNREFUSED');
    const invoker: VlmInvoker = {
      invoke: vi.fn().mockRejectedValue(networkErr),
    };

    const extractor = new VlmExtractor(invoker);

    await expect(extractor.extract(sampleRequest)).rejects.toThrow('ECONNREFUSED');
    expect(invoker.invoke).toHaveBeenCalledTimes(1);
  });
});
