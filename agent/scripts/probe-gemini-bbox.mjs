#!/usr/bin/env node
/**
 * Probe script — calls Gemini through OpenRouter the SAME WAY
 * OpenRouterVlmInvoker does (function-calling withStructuredOutput),
 * BUT also emits the raw tool-call payload Gemini returned before
 * any Zod preprocess fires. This lets us see whether Gemini is
 * producing real bbox coords or still stuffing "None" / nulls.
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { ImageAndPdfPageRenderer } from '../src/extraction/PageRenderer.js';
import { LabPdfSchema } from '../src/schemas/LabPdfSchema.js';
import {
  EXTRACTION_SYSTEM_PROMPT,
  LAB_PDF_USER_INSTRUCTION,
} from '../src/extraction/prompts.js';

const FIXTURE = process.argv[2] ?? 'agent/data/fixtures/lab-results/p01-chen-lipid-panel.pdf';
const MIME = FIXTURE.endsWith('.pdf') ? 'application/pdf'
            : FIXTURE.endsWith('.png') ? 'image/png'
            : 'image/jpeg';

const bytes = readFileSync(FIXTURE);
console.error('[probe] rendering', FIXTURE, MIME, bytes.length, 'bytes');

const renderer = new ImageAndPdfPageRenderer();
const pages = await renderer.render({ bytes, mimeType: MIME });
console.error('[probe] rendered', pages.length, 'pages, first page',
  pages[0].imageWidth, 'x', pages[0].imageHeight);

const { ChatOpenAI } = await import('@langchain/openai');
const model = new ChatOpenAI({
  model: process.env.OPENROUTER_VLM_MODEL ?? 'google/gemini-2.5-pro',
  temperature: 0,
  apiKey: process.env.OPENROUTER_API_KEY,
  configuration: { baseURL: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1' },
});

const userContent = [
  { type: 'text', text: LAB_PDF_USER_INSTRUCTION },
  ...pages.map((p) => ({
    type: 'image_url',
    image_url: { url: `data:image/png;base64,${p.pngBytes.toString('base64')}` },
  })),
];
const messages = [
  { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
  { role: 'user', content: userContent },
];

console.error('[probe] calling', model.modelName, 'withStructuredOutput …');
const structured = model.withStructuredOutput(LabPdfSchema, { includeRaw: true });
const out = await structured.invoke(messages);

// includeRaw:true returns { raw, parsed } so we can see what Gemini ACTUALLY sent
// versus what Zod normalized.
console.log('=== RAW model output ===');
console.log(JSON.stringify(out.raw, null, 2));
console.log('\n=== PARSED (post-Zod-preprocess) ===');
console.log(JSON.stringify(out.parsed, null, 2));

// Surface bbox shapes specifically:
console.log('\n=== BBOX SHAPES IN RAW ===');
const rawJson = out.raw?.tool_calls?.[0]?.args ?? out.raw;
const bboxes = [];
function walk(v, path) {
  if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
  if (v && typeof v === 'object') {
    for (const [k, sub] of Object.entries(v)) {
      if (k === 'bbox') bboxes.push({ path: `${path}.${k}`, value: sub });
      else walk(sub, `${path}.${k}`);
    }
  }
}
walk(rawJson, '$');
for (const b of bboxes) {
  console.log(b.path, '→', typeof b.value, JSON.stringify(b.value));
}
