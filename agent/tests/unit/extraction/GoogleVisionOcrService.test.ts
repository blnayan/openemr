/**
 * GoogleVisionOcrService unit tests — drive recognize() with a stub
 * fetch so we exercise the request shape and the Vision-response →
 * OcrPage normalization without hitting Google.
 */

import { describe, expect, it, vi } from 'vitest';
import { GoogleVisionOcrService } from '../../../src/extraction/GoogleVisionOcrService.js';
import type { RenderedPage } from '../../../src/extraction/types.js';

function rendered(page = 0, w = 1000, h = 1400): RenderedPage {
  return {
    page, pngBytes: Buffer.from('png-bytes'),
    imageWidth: w, imageHeight: h,
    originalWidth: w, originalHeight: h,
    trimOffsetLeft: 0, trimOffsetTop: 0,
  };
}

function vbox(x: number, y: number, w: number, h: number) {
  return {
    vertices: [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ],
  };
}

function symbols(text: string, breakType?: string) {
  // One symbol per character; only the LAST symbol carries a break.
  const chars = [...text];
  return chars.map((ch, idx) => {
    const isLast = idx === chars.length - 1;
    return {
      text: ch,
      ...(isLast && breakType
        ? { property: { detectedBreak: { type: breakType } } }
        : {}),
    };
  });
}

describe('GoogleVisionOcrService', () => {
  it('POSTs DOCUMENT_TEXT_DETECTION with base64 image and api key', async () => {
    let captured: { url: string; body: unknown } = { url: '', body: null };
    const stubFetch = vi.fn(async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify({ responses: [{ fullTextAnnotation: { pages: [{ blocks: [] }] } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const svc = new GoogleVisionOcrService({ apiKey: 'test-key', fetch: stubFetch as never });

    await svc.recognize([rendered()]);

    expect(captured.url).toContain('vision.googleapis.com');
    expect(captured.url).toContain('key=test-key');
    type RequestBody = { requests: Array<{ image: { content: string }; features: Array<{ type: string }> }> };
    const body = captured.body as RequestBody;
    expect(body.requests[0]?.features[0]?.type).toBe('DOCUMENT_TEXT_DETECTION');
    expect(body.requests[0]?.image.content).toBe(Buffer.from('png-bytes').toString('base64'));
  });

  it('splits a paragraph into lines using detectedBreak markers', async () => {
    // Two-row table: line 1 "HDL Cholesterol", line 2 "52 mg/dL >40"
    const responseBody = {
      responses: [{
        fullTextAnnotation: {
          pages: [{
            blocks: [{
              paragraphs: [{
                words: [
                  { boundingBox: vbox(50, 800, 60, 24),  symbols: symbols('HDL') },
                  { boundingBox: vbox(120, 800, 130, 24), symbols: symbols('Cholesterol', 'LINE_BREAK') },
                  { boundingBox: vbox(300, 830, 40, 24),  symbols: symbols('52') },
                  { boundingBox: vbox(350, 830, 80, 24),  symbols: symbols('mg/dL') },
                  { boundingBox: vbox(440, 830, 110, 24), symbols: symbols('>40', 'EOL_SURE_SPACE') },
                ],
              }],
            }],
          }],
        },
      }],
    };
    const stubFetch = vi.fn(async () =>
      new Response(JSON.stringify(responseBody), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const svc = new GoogleVisionOcrService({ apiKey: 'k', fetch: stubFetch as never });

    const [page] = await svc.recognize([rendered()]);

    expect(page!.lines).toHaveLength(2);
    expect(page!.lines[0]?.text).toBe('HDL Cholesterol');
    expect(page!.lines[0]?.x).toBe(50);
    expect(page!.lines[0]?.w).toBe(200);
    expect(page!.lines[1]?.text).toBe('52 mg/dL >40');
    expect(page!.lines[1]?.x).toBe(300);
    // Line 1 spans from x=300 to x=440+110=550 → width 250
    expect(page!.lines[1]?.w).toBe(250);
    // Per-word lineIndex is correct
    expect(page!.lines[0]?.words[0]?.lineIndex).toBe(0);
    expect(page!.lines[1]?.words[0]?.lineIndex).toBe(1);
  });

  it('returns an empty OcrPage when Vision returns no fullTextAnnotation', async () => {
    const stubFetch = vi.fn(async () =>
      new Response(JSON.stringify({ responses: [{}] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const svc = new GoogleVisionOcrService({ apiKey: 'k', fetch: stubFetch as never });

    const [page] = await svc.recognize([rendered()]);

    expect(page!.lines).toEqual([]);
    expect(page!.words).toEqual([]);
  });

  it('logs and continues on a per-page Vision error (other pages still recognized)', async () => {
    let calls = 0;
    const stubFetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response('nope', { status: 500, headers: {} });
      return new Response(JSON.stringify({ responses: [{ fullTextAnnotation: { pages: [{ blocks: [] }] } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const warns: string[] = [];
    const svc = new GoogleVisionOcrService({
      apiKey: 'k', fetch: stubFetch as never,
      warn: (msg) => { warns.push(msg); },
    });

    const result = await svc.recognize([rendered(0), rendered(1)]);

    expect(result).toHaveLength(2);
    expect(warns.some((w) => /Vision OCR failed/.test(w))).toBe(true);
  });

  it('fromEnv returns null when GOOGLE_VISION_API_KEY is unset', () => {
    const result = GoogleVisionOcrService.fromEnv({});
    expect(result).toBeNull();
  });
});
