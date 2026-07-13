/**
 * GoogleVisionOcrService — production OcrService backed by Google
 * Cloud Vision's `images:annotate` endpoint with DOCUMENT_TEXT_DETECTION.
 *
 * Replaces the tesseract.js implementation. Tesseract was workable but
 * required a 6 MB WASM core + a 4 MB English language model fetched on
 * first use, plus per-page recognition latency that scaled poorly on
 * dense lab tables. Vision API's dedicated document model reads small
 * lab numerics, multi-column tables, and superscript units (mL/min/
 * 1.73m²) far more reliably, and the auth/transport story is just an
 * HTTPS POST with an API key — no native modules in the container.
 *
 * Auth: GOOGLE_VISION_API_KEY (preferred — single env var) or any
 * caller can supply an explicit `fetch` and `apiKey` for tests.
 *
 * Bbox normalization: Vision returns a hierarchy of
 *     page → block → paragraph → word → symbol
 * with each level carrying a `boundingBox.vertices` (4-point polygon
 * in pixel space). We axis-align by taking min/max of the 4 vertices.
 *
 * Lines: Vision doesn't expose a "line" level natively — it uses
 * symbol-level `property.detectedBreak` to mark line endings inside a
 * paragraph (LINE_BREAK, EOL_SURE_SPACE, HYPHEN). We split paragraphs
 * into OcrLine groups at those breaks. This recovers the same
 * line/word abstraction TesseractOcrService produced, so the
 * BboxLocator and LlmBboxSelector logic above stays identical.
 *
 * PHI note: lab and intake content WILL be sent to Google Cloud
 * Vision. A signed Google Cloud BAA is required for production use
 * with PHI. Local dev / non-PHI inputs work without one. The pipeline
 * degrades gracefully when no API key is set (returns null from
 * `fromEnv`) — the BboxLocator just emits zero-area bboxes.
 */

import type { OcrLine, OcrPage, OcrService, OcrWord } from './OcrService.js';
import type { RenderedPage } from './types.js';

const VISION_ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate';

/** Subset of Vision's response shape that we actually consume. */
interface VisionVertex { x?: number; y?: number; }
interface VisionBox { vertices?: VisionVertex[]; }
interface VisionDetectedBreak {
  type?: 'UNKNOWN' | 'SPACE' | 'SURE_SPACE' | 'EOL_SURE_SPACE' | 'LINE_BREAK' | 'HYPHEN';
  isPrefix?: boolean;
}
interface VisionSymbolProperty { detectedBreak?: VisionDetectedBreak; }
interface VisionSymbol {
  text?: string;
  confidence?: number;
  property?: VisionSymbolProperty;
  boundingBox?: VisionBox;
}
interface VisionWord {
  symbols?: VisionSymbol[];
  confidence?: number;
  boundingBox?: VisionBox;
}
interface VisionParagraph {
  words?: VisionWord[];
  boundingBox?: VisionBox;
}
interface VisionBlock {
  paragraphs?: VisionParagraph[];
  boundingBox?: VisionBox;
}
interface VisionPageNode {
  blocks?: VisionBlock[];
  width?: number;
  height?: number;
}
interface VisionFullText { pages?: VisionPageNode[]; }
interface VisionResponseBody {
  responses?: Array<{ fullTextAnnotation?: VisionFullText; error?: { message?: string } }>;
}

export interface GoogleVisionOcrServiceOptions {
  apiKey: string;
  /** Override for tests; defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Logger; defaults to console.warn. */
  warn?: (msg: string, ctx?: Record<string, unknown>) => void;
  /** Override the endpoint base URL (used by tests / GovCloud). */
  endpoint?: string;
}

export class GoogleVisionOcrService implements OcrService {
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly warn: (msg: string, ctx?: Record<string, unknown>) => void;
  private readonly endpoint: string;

  constructor(opts: GoogleVisionOcrServiceOptions) {
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.warn = opts.warn ?? ((m, ctx) => console.warn(`[agentforge] ${m}`, ctx ?? {}));
    this.endpoint = opts.endpoint ?? VISION_ENDPOINT;
  }

  /**
   * Boot from env. Returns null when GOOGLE_VISION_API_KEY is unset so
   * the pipeline can degrade gracefully (no OCR-derived bboxes).
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): GoogleVisionOcrService | null {
    const apiKey = env['GOOGLE_VISION_API_KEY'];
    if (!apiKey) {
      console.warn('[agentforge] GOOGLE_VISION_API_KEY unset; OCR disabled');
      return null;
    }
    return new GoogleVisionOcrService({ apiKey });
  }

  async recognize(pages: ReadonlyArray<RenderedPage>): Promise<OcrPage[]> {
    if (pages.length === 0) return [];
    const out: OcrPage[] = [];
    for (const page of pages) {
      try {
        out.push(await this.recognizeOne(page));
      } catch (err) {
        this.warn('Vision OCR failed for page; continuing with empty OCR', {
          page: page.page,
          error: err instanceof Error ? err.message : String(err),
        });
        out.push({
          page: page.page,
          imageWidth: page.imageWidth,
          imageHeight: page.imageHeight,
          lines: [], words: [],
        });
      }
    }
    return out;
  }

  private async recognizeOne(page: RenderedPage): Promise<OcrPage> {
    const body = {
      requests: [{
        image: { content: page.pngBytes.toString('base64') },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }],
      }],
    };
    const url = `${this.endpoint}?key=${encodeURIComponent(this.apiKey)}`;
    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '<unreadable>');
      throw new Error(`Vision API ${response.status}: ${text.slice(0, 300)}`);
    }
    const json = await response.json() as VisionResponseBody;
    const first = json.responses?.[0];
    if (first?.error?.message) {
      throw new Error(`Vision API error: ${first.error.message}`);
    }
    const fullText = first?.fullTextAnnotation;
    if (!fullText || !fullText.pages || fullText.pages.length === 0) {
      return {
        page: page.page,
        imageWidth: page.imageWidth,
        imageHeight: page.imageHeight,
        lines: [], words: [],
      };
    }
    return toOcrPage(page, fullText.pages[0]!);
  }

  // shutdown is a no-op; the HTTPS client has no persistent state.
}

/**
 * Convert a Vision page node to our OcrPage shape, splitting each
 * paragraph into lines using symbol-level `detectedBreak` markers.
 */
function toOcrPage(rendered: RenderedPage, vp: VisionPageNode): OcrPage {
  const lines: OcrLine[] = [];
  const allWords: OcrWord[] = [];

  for (const block of vp.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      // Split paragraph words into lines whenever the LAST symbol of a
      // word carries a LINE_BREAK / EOL_SURE_SPACE / HYPHEN break.
      let currentWords: OcrWord[] = [];
      const flush = () => {
        if (currentWords.length === 0) return;
        const lineIndex = lines.length;
        const fixed = currentWords.map((w) => ({ ...w, lineIndex }));
        lines.push({
          page: rendered.page,
          text: fixed.map((w) => w.text).join(' '),
          ...unionRect(fixed),
          words: fixed,
        });
        allWords.push(...fixed);
        currentWords = [];
      };

      for (const w of para.words ?? []) {
        const text = (w.symbols ?? []).map((s) => s.text ?? '').join('');
        if (text.length === 0) continue;
        const rect = vertexRect(w.boundingBox);
        const ocrWord: OcrWord = {
          page: rendered.page,
          text,
          x: rect.x, y: rect.y, w: rect.w, h: rect.h,
          lineIndex: -1, // overwritten by flush() once the line index is known
          confidence: typeof w.confidence === 'number' ? Math.round(w.confidence * 100) : 0,
        };
        currentWords.push(ocrWord);
        const lastSym = w.symbols?.[w.symbols.length - 1];
        const brk = lastSym?.property?.detectedBreak?.type;
        if (brk === 'LINE_BREAK' || brk === 'EOL_SURE_SPACE' || brk === 'HYPHEN') {
          flush();
        }
      }
      flush();
    }
  }

  return {
    page: rendered.page,
    imageWidth: rendered.imageWidth,
    imageHeight: rendered.imageHeight,
    lines,
    words: allWords,
  };
}

/**
 * Convert a Vision boundingBox.vertices polygon to an axis-aligned
 * {x, y, w, h}. Vertices may be missing fields when at the origin;
 * default missing fields to 0.
 */
function vertexRect(box: VisionBox | undefined): { x: number; y: number; w: number; h: number } {
  const vs = box?.vertices ?? [];
  if (vs.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const v of vs) {
    const x = v.x ?? 0;
    const y = v.y ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) };
}

function unionRect(words: ReadonlyArray<OcrWord>): { x: number; y: number; w: number; h: number } {
  if (words.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const w of words) {
    if (w.x < minX) minX = w.x;
    if (w.y < minY) minY = w.y;
    if (w.x + w.w > maxX) maxX = w.x + w.w;
    if (w.y + w.h > maxY) maxY = w.y + w.h;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
