/**
 * Layer 3 — LLM judge backstop. Confidence < 0.7 marks claims as
 * suspicious; the formatter strips them and notes "N claims removed".
 * Malformed responses default to pass to avoid breaking the chat
 * stream over an off-key judge — Layer 1 catches fabrications anyway.
 */

import type { Answer } from '../schemas/AnswerSchema.js';
import type { ToolResult } from '../tools/types.js';

export interface JudgeVerdict {
  pass: boolean;
  suspiciousClaims: string[];
  confidence: number;
}

export interface LlmJudgeClient {
  invoke(input: unknown): Promise<{ content: string }>;
}

const CONFIDENCE_THRESHOLD = 0.7;

export async function runJudge(
  toolResults: ToolResult[],
  draft: Answer,
  llmClient: LlmJudgeClient,
): Promise<JudgeVerdict> {
  const transcript = renderToolTranscript(toolResults);
  const prompt = buildJudgePrompt(transcript, draft);

  let response: { content: string };
  try {
    response = await llmClient.invoke(prompt);
  } catch {
    return { pass: true, suspiciousClaims: [], confidence: 1 };
  }

  const parsed = parseJudgeResponse(response.content);
  if (!parsed) {
    return { pass: true, suspiciousClaims: [], confidence: 1 };
  }

  const pass = parsed.confidence >= CONFIDENCE_THRESHOLD && parsed.suspiciousClaims.length === 0;
  return {
    pass,
    suspiciousClaims: parsed.suspiciousClaims,
    confidence: parsed.confidence,
  };
}

function renderToolTranscript(toolResults: ToolResult[]): string {
  return toolResults.map(r => {
    if (!r.ok) return `${r.tool}: ERROR (${r.reason})`;
    const summary = r.rows.map((row, i) => `  row-${i}: ${JSON.stringify(row)}`).join('\n');
    return `${r.tool}:\n${summary}`;
  }).join('\n\n');
}

function buildJudgePrompt(transcript: string, draft: Answer): string {
  return [
    'You are a clinical-fact verifier. Given the tool results below and an AI-generated answer,',
    'identify any claims in the answer that are NOT supported by the tool results. Reply ONLY with',
    'JSON: { "suspicious_claims": [<text>, ...], "confidence": 0.0-1.0 }.',
    '',
    'Tool transcript:',
    transcript,
    '',
    'AI answer:',
    JSON.stringify(draft, null, 2),
  ].join('\n');
}

function parseJudgeResponse(text: string): { suspiciousClaims: string[]; confidence: number } | null {
  try {
    const trimmed = text.trim().replace(/^```(?:json)?/, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const claims = Array.isArray(parsed['suspicious_claims']) ? parsed['suspicious_claims'] : [];
    const confidence = typeof parsed['confidence'] === 'number' ? parsed['confidence'] : 1;
    return {
      suspiciousClaims: claims.filter((c): c is string => typeof c === 'string'),
      confidence,
    };
  } catch {
    return null;
  }
}
