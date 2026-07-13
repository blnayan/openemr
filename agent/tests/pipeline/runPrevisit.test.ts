/**
 * Eval suite — runPrevisit pipeline against the eight fixture scenarios.
 *
 * Each test exercises the full pipeline (fan-out → diff → rule engine →
 * Layer 1 grounding) without an LLM. The deterministic stub answer is
 * what gets evaluated, so these tests are stable across LLM upgrades and
 * can run in CI for free.
 *
 * For LLM-in-the-loop assertions, see evals/ (opt-in via npm run eval).
 */

import { describe, it, expect } from 'vitest';
import { runPrevisit } from '../../src/graph/runPrevisit.js';
import { TOOL_REGISTRY } from '../../src/tools/index.js';
import type { ToolResult } from '../../src/tools/types.js';
import {
  makeContext,
  STABLE_NO_CHANGES, NEW_MEDICATION, NEW_ABNORMAL_LAB,
  DDI_PRESENT, ALLERGY_CONFLICT, FIRST_VISIT, PARTIAL_FAILURE,
} from './fixtures.js';

/**
 * Patches TOOL_REGISTRY for one test by wrapping each tool's function so
 * it returns a fixture row instead of hitting FHIR. Restores at teardown.
 */
function withFixture(toolResults: ToolResult[]): () => void {
  const originals = new Map<string, typeof TOOL_REGISTRY[string]>();
  for (const result of toolResults) {
    const original = TOOL_REGISTRY[result.tool];
    if (original) {
      originals.set(result.tool, original);
      (TOOL_REGISTRY as Record<string, unknown>)[result.tool] = async () => result;
    }
  }
  return () => {
    for (const [name, fn] of originals) {
      (TOOL_REGISTRY as Record<string, unknown>)[name] = fn;
    }
  };
}

async function exercise(toolResults: ToolResult[]) {
  const restore = withFixture(toolResults);
  try {
    return await runPrevisit(makeContext(), null);
  } finally {
    restore();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runPrevisit (eval)', () => {
  it('Scenario 1 — stable patient: three sections render with baseline content', async () => {
    const result = await exercise(STABLE_NO_CHANGES);
    expect(result.diff.baseline).toBe(false);

    // Action items section is empty (no deltas), uses an empty message.
    expect(result.sections.actionItems.claims).toHaveLength(0);
    expect(result.sections.actionItems.emptyMessage).toMatch(/no new findings|stable/i);

    // Active problems present.
    const probsText = result.sections.activeProblems.claims.map(c => c.text.toLowerCase()).join(' ');
    expect(probsText).toContain('hypertension');

    // Current medications present.
    const medsText = result.sections.currentMedications.claims.map(c => c.text.toLowerCase()).join(' ');
    expect(medsText).toContain('lisinopril');

    // Section labels are correct.
    expect(result.sections.actionItems.label.toLowerCase()).toContain('action');
    expect(result.sections.activeProblems.label.toLowerCase()).toContain('problem');
    expect(result.sections.currentMedications.label.toLowerCase()).toContain('medication');
  });

  it('Scenario 2 — new medication appears in action items section', async () => {
    const result = await exercise(NEW_MEDICATION);
    expect(result.diff.medsAdded.length).toBeGreaterThan(0);
    const inActions = result.sections.actionItems.claims.some(c =>
      /atorvastatin/i.test(c.text) && c.citation_ids.includes('tool:get_medications:row-0'),
    );
    expect(inActions).toBe(true);
    // It should also appear in current medications (it IS active right now).
    const inMeds = result.sections.currentMedications.claims.some(c => /atorvastatin/i.test(c.text));
    expect(inMeds).toBe(true);
  });

  it('Scenario 3 — new abnormal lab flagged as attention', async () => {
    const result = await exercise(NEW_ABNORMAL_LAB);
    expect(result.diff.newAbnormalLabs.length).toBe(1);
    const flagged = result.answer.claims.find(c =>
      c.citation_ids.includes('tool:get_recent_labs:row-0'),
    );
    expect(flagged).toBeDefined();
    expect(flagged?.severity).toBe('attention');
  });

  it('Scenario 4 — DDI is the first action item with urgent severity', async () => {
    const result = await exercise(DDI_PRESENT);
    expect(result.ruleFindings.some(r => r.severity === 'urgent' && r.ruleId.startsWith('ddi:'))).toBe(true);
    const firstAction = result.sections.actionItems.claims[0];
    expect(firstAction).toBeDefined();
    expect(firstAction?.severity).toBe('urgent');
    expect(firstAction?.citation_ids[0]).toMatch(/^rule:ddi:/);
  });

  it('Scenario 5 — allergy/medication conflict surfaces in action items', async () => {
    const result = await exercise(ALLERGY_CONFLICT);
    expect(result.ruleFindings.some(r => r.ruleId.startsWith('allergy:'))).toBe(true);
    const urgentClaim = result.sections.actionItems.claims.find(c =>
      c.severity === 'urgent' && c.citation_ids[0]?.startsWith('rule:allergy:'),
    );
    expect(urgentClaim).toBeDefined();
  });

  it('Scenario 6 — first-visit (one encounter): baseline mode, low confidence', async () => {
    const result = await exercise(FIRST_VISIT);
    expect(result.diff.baseline).toBe(true);
    expect(result.answer.confidence).toBe('low');
    expect(result.answer.summary.toLowerCase()).toMatch(/first.*visit|no prior encounter/i);
  });

  it('Scenario 7 — partial FHIR failure: still returns a usable answer', async () => {
    const result = await exercise(PARTIAL_FAILURE);
    // We MUST return a non-throwing answer that respects citation grounding.
    expect(result.answer.claims.length).toBeGreaterThan(0);
    for (const claim of result.answer.claims) {
      for (const cid of claim.citation_ids) {
        // Allow rule:* and confirm tool:* IDs map to ok results.
        if (cid.startsWith('rule:')) continue;
        const found = result.toolResults.some(
          r => r.ok && r.rows.some(row => row.id === cid),
        );
        expect(found).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting safety properties (run on every scenario)
// ---------------------------------------------------------------------------

const ALL_SCENARIOS: Array<[string, ToolResult[]]> = [
  ['stable', STABLE_NO_CHANGES],
  ['new med', NEW_MEDICATION],
  ['abnormal lab', NEW_ABNORMAL_LAB],
  ['ddi', DDI_PRESENT],
  ['allergy', ALLERGY_CONFLICT],
  ['first visit', FIRST_VISIT],
  ['partial failure', PARTIAL_FAILURE],
];

describe('runPrevisit safety invariants', () => {
  for (const [name, fixture] of ALL_SCENARIOS) {
    it(`${name}: every tool: citation maps to an ok-result row`, async () => {
      const result = await exercise(fixture);
      for (const claim of result.answer.claims) {
        for (const cid of claim.citation_ids) {
          if (cid.startsWith('rule:')) continue;
          const found = result.toolResults.some(
            r => r.ok && r.rows.some(row => row.id === cid),
          );
          expect(found, `citation ${cid} not found in tool transcript (${name})`).toBe(true);
        }
      }
    });

    it(`${name}: ≤7 claims (brevity invariant including baseline)`, async () => {
      const result = await exercise(fixture);
      expect(result.answer.claims.length).toBeLessThanOrEqual(7);
    });

    it(`${name}: planner never self-emits urgent severity`, async () => {
      const result = await exercise(fixture);
      // Urgent claims may exist, but only with rule:* citations (verifier-injected).
      for (const claim of result.answer.claims) {
        if (claim.severity === 'urgent') {
          const isRuleClaim = claim.citation_ids.every(cid => cid.startsWith('rule:'));
          expect(isRuleClaim, `non-rule claim was urgent (${name})`).toBe(true);
        }
      }
    });

    it(`${name}: ≤3 follow-up suggestions`, async () => {
      const result = await exercise(fixture);
      expect(result.answer.followup_suggestions.length).toBeLessThanOrEqual(3);
    });

    it(`${name}: each section has ≤5 claims and a non-empty label`, async () => {
      const result = await exercise(fixture);
      for (const key of ['actionItems', 'activeProblems', 'currentMedications'] as const) {
        const section = result.sections[key];
        expect(section.label.length).toBeGreaterThan(0);
        expect(section.claims.length).toBeLessThanOrEqual(5);
        expect(section.emptyMessage.length).toBeGreaterThan(0);
      }
    });
  }
});
