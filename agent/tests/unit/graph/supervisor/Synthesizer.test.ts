/**
 * Unit tests for SupervisorSynthesizer — verifies the prompt structure
 * (delimiters present, instructions separated from document content)
 * and the schema-parse retry behaviour.
 */

import { describe, it, expect } from 'vitest';
import {
  SupervisorSynthesizer,
  __test_only_buildUserPrompt,
} from '../../../../src/graph/supervisor/Synthesizer.js';
import type { LlmInvoker, ChatMessage, ChatResponse } from '../../../../src/llm/AgentLlmClient.js';
import type {
  AccumulatedHandoff,
} from '../../../../src/graph/supervisor/types.js';

function makeHandoffs(): AccumulatedHandoff[] {
  return [
    {
      worker: 'evidence_retriever',
      output: {
        worker: 'evidence_retriever',
        chunks: [{
          id: 'ada-2026-6.3a',
          source: 'ADA Standards of Care in Diabetes—2026',
          section_id: '6.3a',
          page: 100,
          body: 'An A1C goal of <7% (53 mmol/mol) is appropriate for many nonpregnant adults.',
          score: 0.95,
        }],
      },
      latency_ms: 320,
    },
  ];
}

describe('SupervisorSynthesizer prompt structure', () => {
  it('separates document content blocks from instructions via delimiters', () => {
    const prompt = __test_only_buildUserPrompt({
      question: 'what does the guideline say?',
      accumulated: makeHandoffs(),
      forcedSynthesis: false,
    });
    expect(prompt).toContain('<DOCUMENT_CONTENT_FROM_INTAKE>');
    expect(prompt).toContain('</DOCUMENT_CONTENT_FROM_INTAKE>');
    expect(prompt).toContain('<GUIDELINE_CHUNKS>');
    expect(prompt).toContain('</GUIDELINE_CHUNKS>');
    expect(prompt).toContain('<CLINICAL_TOOL_OUTPUTS>');
    expect(prompt).toContain('</CLINICAL_TOOL_OUTPUTS>');
    expect(prompt).toContain('<INSTRUCTIONS>');
    expect(prompt).toContain('</INSTRUCTIONS>');
    // The retrieved chunk body MUST appear inside GUIDELINE_CHUNKS, not
    // after </INSTRUCTIONS> (otherwise the structural separation is lost).
    const guidelineStart = prompt.indexOf('<GUIDELINE_CHUNKS>');
    const guidelineEnd = prompt.indexOf('</GUIDELINE_CHUNKS>');
    const instructionStart = prompt.indexOf('<INSTRUCTIONS>');
    expect(guidelineStart).toBeLessThan(guidelineEnd);
    expect(guidelineEnd).toBeLessThan(instructionStart);
    expect(prompt.slice(guidelineStart, guidelineEnd)).toContain('A1C goal of <7%');
  });

  it('marks forced-synthesis explicitly so the LLM can degrade confidence', () => {
    const prompt = __test_only_buildUserPrompt({
      question: 'q',
      accumulated: [],
      forcedSynthesis: true,
    });
    expect(prompt).toContain('handoff cap');
  });
});

describe('SupervisorSynthesizer schema-parse retry', () => {
  it('returns the parsed answer on the first try when valid', async () => {
    const validAnswer = {
      summary: 'ok',
      claims: [{
        text: 'a claim',
        citation_ids: ['rule:guideline:ada-2026-6-3a'],
        severity: 'info',
      }],
      followup_suggestions: [],
      confidence: 'medium',
    };
    let calls = 0;
    const llm: LlmInvoker = {
      async chat(_messages: ChatMessage[]): Promise<ChatResponse> {
        calls += 1;
        return { content: JSON.stringify(validAnswer), toolCalls: [] };
      },
      async chatWithTools(): Promise<ChatResponse> { return { content: '', toolCalls: [] }; },
    };
    const synth = new SupervisorSynthesizer(llm);
    const out = await synth.synthesize({
      question: 'q',
      accumulated: [],
      forcedSynthesis: false,
    });
    expect(out.summary).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries once with validation issues then returns the corrected answer', async () => {
    const validAnswer = {
      summary: 'ok',
      claims: [{
        text: 'a claim',
        citation_ids: ['rule:guideline:ada-2026-6-3a'],
        severity: 'info',
      }],
      followup_suggestions: [],
      confidence: 'low',
    };
    let calls = 0;
    const llm: LlmInvoker = {
      async chat(messages: ChatMessage[]): Promise<ChatResponse> {
        calls += 1;
        if (calls === 1) {
          return { content: 'not json at all', toolCalls: [] };
        }
        // The retry message should reference the prior validation failure.
        const last = messages[messages.length - 1];
        expect(last && typeof last.content === 'string' && last.content.includes('Validation issues')).toBe(true);
        return { content: JSON.stringify(validAnswer), toolCalls: [] };
      },
      async chatWithTools(): Promise<ChatResponse> { return { content: '', toolCalls: [] }; },
    };
    const synth = new SupervisorSynthesizer(llm);
    const out = await synth.synthesize({
      question: 'q',
      accumulated: [],
      forcedSynthesis: false,
    });
    expect(out.summary).toBe('ok');
    expect(calls).toBe(2);
  });

  it('throws on a second parse failure', async () => {
    const llm: LlmInvoker = {
      async chat(): Promise<ChatResponse> { return { content: '<<not json>>', toolCalls: [] }; },
      async chatWithTools(): Promise<ChatResponse> { return { content: '', toolCalls: [] }; },
    };
    const synth = new SupervisorSynthesizer(llm);
    await expect(synth.synthesize({
      question: 'q',
      accumulated: [],
      forcedSynthesis: false,
    })).rejects.toThrow(/AnswerSchema validation twice/);
  });
});
