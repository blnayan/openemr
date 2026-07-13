/**
 * LlmBboxSelector unit tests.
 *
 * Drives the selector with a stub model that captures the request and
 * returns canned plans, so we exercise prompt formatting and response
 * validation without hitting OpenRouter.
 */

import { describe, expect, it } from 'vitest';
import {
  buildUserPrompt,
  OpenRouterBboxSelector,
} from '../../../src/extraction/LlmBboxSelector.js';
import type { OcrPage } from '../../../src/extraction/OcrService.js';

function ocr(): OcrPage {
  return {
    page: 0, imageWidth: 1000, imageHeight: 1400,
    lines: [
      {
        page: 0, text: 'HDL Cholesterol', x: 50, y: 800, w: 200, h: 24,
        words: [
          { page: 0, text: 'HDL', x: 50, y: 800, w: 60, h: 24, lineIndex: 0, confidence: 95 },
          { page: 0, text: 'Cholesterol', x: 120, y: 800, w: 130, h: 24, lineIndex: 0, confidence: 95 },
        ],
      },
      {
        page: 0, text: '52 mg/dL >40', x: 300, y: 805, w: 250, h: 24,
        words: [
          { page: 0, text: '52', x: 300, y: 805, w: 40, h: 24, lineIndex: 1, confidence: 95 },
          { page: 0, text: 'mg/dL', x: 350, y: 805, w: 80, h: 24, lineIndex: 1, confidence: 95 },
          { page: 0, text: '>40', x: 440, y: 805, w: 110, h: 24, lineIndex: 1, confidence: 95 },
        ],
      },
    ],
    words: [],
  };
}

describe('LlmBboxSelector', () => {
  it('formats the prompt with indexed pages, lines, words, and entities', () => {
    const text = buildUserPrompt({
      ocrPages: [ocr()],
      entities: [
        { entity_id: 'results[0]', mode: 'row', text: 'HDL Cholesterol | 52 | mg/dL | >40' },
      ],
    });

    expect(text).toContain('PAGE 0 (2 lines)');
    expect(text).toContain('line 0: "HDL Cholesterol"');
    expect(text).toContain('line 1: "52 mg/dL >40"');
    expect(text).toContain('0:"HDL"');
    expect(text).toContain('- results[0] [mode=row]: "HDL Cholesterol | 52 | mg/dL | >40"');
  });

  it('uses withStructuredOutput when supported and returns the parsed plan', async () => {
    const captured: ReadonlyArray<{ role: string; content: string }>[] = [];
    const model = {
      invoke: async () => ({ content: '{}' }),
      withStructuredOutput: <T>() => ({
        invoke: async (msgs: ReadonlyArray<{ role: string; content: string }>): Promise<T> => {
          captured.push(msgs);
          return {
            entries: [
              { entity_id: 'results[0]', page: 0, line_indices: [0, 1] },
            ],
          } as T;
        },
      }),
    };
    const selector = new OpenRouterBboxSelector(model);

    const plan = await selector.select({
      ocrPages: [ocr()],
      entities: [
        { entity_id: 'results[0]', mode: 'row', text: 'HDL Cholesterol 52 mg/dL >40' },
      ],
    });

    expect(plan).not.toBeNull();
    expect(plan!.entries).toHaveLength(1);
    expect(plan!.entries[0]?.line_indices).toEqual([0, 1]);
    expect(captured).toHaveLength(1);
    expect(captured[0]![0]?.role).toBe('system');
    expect(captured[0]![1]?.role).toBe('user');
  });

  it('parses raw JSON when withStructuredOutput is unavailable', async () => {
    const model = {
      invoke: async () => ({
        content: JSON.stringify({
          entries: [{ entity_id: 'results[0]', page: 0, line_indices: [0] }],
        }),
      }),
    };
    const selector = new OpenRouterBboxSelector(model);

    const plan = await selector.select({
      ocrPages: [ocr()],
      entities: [{ entity_id: 'results[0]', mode: 'row', text: 'HDL' }],
    });

    expect(plan?.entries[0]?.entity_id).toBe('results[0]');
  });

  it('returns null on Zod validation failure (does not throw)', async () => {
    const model = {
      invoke: async () => ({
        content: JSON.stringify({ entries: [{ entity_id: 'r', page: 0 }] /* missing line_indices */ }),
      }),
    };
    const selector = new OpenRouterBboxSelector(model);

    const plan = await selector.select({
      ocrPages: [ocr()],
      entities: [{ entity_id: 'r', mode: 'row', text: 'x' }],
    });

    expect(plan).toBeNull();
  });

  it('returns an empty plan immediately when no entities supplied', async () => {
    let called = false;
    const model = {
      invoke: async () => { called = true; return { content: '{}' }; },
    };
    const selector = new OpenRouterBboxSelector(model);

    const plan = await selector.select({ ocrPages: [ocr()], entities: [] });

    expect(plan).toEqual({ entries: [] });
    expect(called).toBe(false);
  });
});
