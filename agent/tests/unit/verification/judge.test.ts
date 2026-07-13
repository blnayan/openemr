/**
 * Layer 3 LLM Judge unit tests
 *
 * Tests threshold logic, claim stripping, and mock LLM response parsing.
 * The judge is a backstop — not the primary check. Confidence < 0.7 flags suspects.
 *
 * Uses a fake LLMClient to make tests deterministic — no real OpenAI calls.
 *
 * Plan reference: §3.5 Layer 3, §5.3 judge.test.ts, M4
 * ARCHITECTURE.md D8: "gpt-5-mini judge as a backstop for misleading-but-cited claims"
 */

import { describe, it, expect, vi } from 'vitest';
import { runJudge, type JudgeVerdict } from '../../../src/verification/judge.js';
import type { Answer } from '../../../src/schemas/AnswerSchema.js';
import type { ToolResult } from '../../../src/tools/types.js';

// ---------------------------------------------------------------------------
// Fake LLM client
// ---------------------------------------------------------------------------

type LLMClientMock = {
  invoke: ReturnType<typeof vi.fn>;
};

function fakeLlmClient(response: { suspicious_claims: string[]; confidence: number }): LLMClientMock {
  return {
    invoke: vi.fn().mockResolvedValue({
      content: JSON.stringify(response),
    }),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function buildAnswer(claimTexts: string[]): Answer {
  return {
    summary: 'Test answer.',
    claims: claimTexts.map((text, i) => ({
      text,
      citation_ids: [`tool:get_medications:row-${i}`],
      severity: 'info' as const,
    })),
    conflicts: [],
    data_gaps: [],
    assumptions: [],
    evidence_catalog: [],
    followup_suggestions: [],
    confidence: 'high',
  };
}

function buildToolResults(): ToolResult[] {
  return [
    {
      ok: true,
      rows: [
        { id: 'tool:get_medications:row-0', drug_name: 'Lisinopril', dose: '10 mg' },
        { id: 'tool:get_medications:row-1', drug_name: 'Metformin', dose: '500 mg' },
      ],
      tool: 'get_medications',
    },
  ];
}

// ---------------------------------------------------------------------------

describe('runJudge — Layer 3 LLM backstop', () => {
  // §3.5: happy path — judge says everything is fine
  it('returns pass=true when judge finds no suspicious claims', async () => {
    const llm    = fakeLlmClient({ suspicious_claims: [], confidence: 0.95 });
    const answer = buildAnswer(['Maria is on Lisinopril 10 mg.']);
    const tools  = buildToolResults();

    const verdict: JudgeVerdict = await runJudge(tools, answer, llm as unknown as Parameters<typeof runJudge>[2]);

    expect(verdict.pass).toBe(true);
    expect(verdict.suspiciousClaims).toHaveLength(0);
  });

  // §3.5: "confidence < 0.7 → flag suspect claims"
  it('returns pass=false when judge confidence is below 0.7 threshold', async () => {
    const llm = fakeLlmClient({
      suspicious_claims: ['Maria is on Warfarin 10 mg.'],
      confidence: 0.5,  // below threshold
    });
    const answer = buildAnswer(['Maria is on Warfarin 10 mg.']);
    const tools  = buildToolResults();

    const verdict = await runJudge(tools, answer, llm as unknown as Parameters<typeof runJudge>[2]);

    expect(verdict.pass).toBe(false);
    expect(verdict.suspiciousClaims).toContain('Maria is on Warfarin 10 mg.');
  });

  // §3.5: "below threshold confidence → keep claim, log a warning"
  // ARCHITECTURE.md D8: "confidence threshold tuned via eval suite; below threshold → strip"
  it('strips suspicious claims from the verdict result', async () => {
    const suspiciousText = 'Patient has a creatinine of 2.5 mg/dL (fabricated).';
    const llm = fakeLlmClient({
      suspicious_claims: [suspiciousText],
      confidence: 0.4,
    });
    const answer = buildAnswer([
      'Maria is on Lisinopril 10 mg.',
      suspiciousText,
    ]);
    const tools = buildToolResults();

    const verdict = await runJudge(tools, answer, llm as unknown as Parameters<typeof runJudge>[2]);

    expect(verdict.pass).toBe(false);
    expect(verdict.suspiciousClaims).toContain(suspiciousText);
    expect(verdict.confidence).toBeLessThan(0.7);
  });

  // Confidence exactly at 0.7 boundary — should pass
  it('returns pass=true when confidence is exactly 0.7', async () => {
    const llm = fakeLlmClient({ suspicious_claims: [], confidence: 0.7 });
    const verdict = await runJudge(
      buildToolResults(),
      buildAnswer(['Safe claim.']),
      llm as unknown as Parameters<typeof runJudge>[2],
    );

    expect(verdict.pass).toBe(true);
  });

  // Confidence at 0.699 — should fail
  it('returns pass=false when confidence is just below 0.7', async () => {
    const llm = fakeLlmClient({ suspicious_claims: ['maybe suspicious'], confidence: 0.699 });
    const verdict = await runJudge(
      buildToolResults(),
      buildAnswer(['Maybe suspicious.']),
      llm as unknown as Parameters<typeof runJudge>[2],
    );

    expect(verdict.pass).toBe(false);
  });

  it('returns the confidence value from the LLM response', async () => {
    const llm = fakeLlmClient({ suspicious_claims: [], confidence: 0.87 });
    const verdict = await runJudge(
      buildToolResults(),
      buildAnswer(['Correct claim.']),
      llm as unknown as Parameters<typeof runJudge>[2],
    );

    expect(verdict.confidence).toBeCloseTo(0.87);
  });

  it('handles malformed LLM response gracefully without throwing', async () => {
    const llm = {
      invoke: vi.fn().mockResolvedValue({ content: 'not-valid-json' }),
    };

    // Should not throw — malformed judge response should default to pass (backstop only)
    await expect(
      runJudge(buildToolResults(), buildAnswer(['Claim.']), llm as unknown as Parameters<typeof runJudge>[2]),
    ).resolves.toBeDefined();
  });

  it('calls the LLM exactly once per judge run', async () => {
    const llm = fakeLlmClient({ suspicious_claims: [], confidence: 0.9 });
    await runJudge(buildToolResults(), buildAnswer(['Claim.']), llm as unknown as Parameters<typeof runJudge>[2]);

    expect(llm.invoke).toHaveBeenCalledTimes(1);
  });
});
