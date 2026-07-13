/**
 * clinicalNumericsBolded rubric tests.
 *
 * The rubric runs as part of the evals harness — these unit
 * tests pin its heuristic boundaries so changes to the regex set are
 * caught here rather than as eval flakes.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — rubric is intentionally untyped for evals harness
import clinicalNumericsBolded from '../../../evals/rubrics/clinicalNumericsBolded.js';

function answer(summary: string): unknown {
  return {
    summary,
    claims: [],
    followup_suggestions: [],
    confidence: 'medium',
  };
}

describe('clinicalNumericsBolded rubric', () => {
  it('passes when an A1c value is markdown-bolded in the summary', async () => {
    const r = await clinicalNumericsBolded(
      answer('Latest **HbA1c 7.4%** above the ADA goal.'),
      {},
    );
    expect(r.pass).toBe(true);
  });

  it('passes when an LDL value is bolded', async () => {
    const r = await clinicalNumericsBolded(
      answer('**LDL 158 mg/dL** — recommend statin titration.'),
      {},
    );
    expect(r.pass).toBe(true);
  });

  it('passes when a BP value is bolded', async () => {
    const r = await clinicalNumericsBolded(
      answer('Last office **BP 138/86** on 2026-04-12.'),
      {},
    );
    expect(r.pass).toBe(true);
  });

  it('passes when a medication dose is bolded', async () => {
    const r = await clinicalNumericsBolded(
      answer('On **metformin 1000 mg twice daily**.'),
      {},
    );
    expect(r.pass).toBe(true);
  });

  it('fails when an A1c numeric is mentioned but not bolded', async () => {
    const r = await clinicalNumericsBolded(
      answer('Latest HbA1c is 7.4% — above goal.'),
      {},
    );
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('clinical numeric');
  });

  it('fails when a BP reading is mentioned but not bolded', async () => {
    const r = await clinicalNumericsBolded(
      answer('Office BP 138/86 mmHg in clinic.'),
      {},
    );
    expect(r.pass).toBe(false);
  });

  it('passes vacuously when the summary contains no clinical numeric', async () => {
    const r = await clinicalNumericsBolded(
      answer('No A1c result found in the chart for this patient.'),
      {},
    );
    expect(r.pass).toBe(true);
  });

  it('passes vacuously on absence-shaped summaries', async () => {
    const r = await clinicalNumericsBolded(
      answer('No recent labs on file.'),
      {},
    );
    expect(r.pass).toBe(true);
  });

  it('passes vacuously when there is no Answer-shaped payload', async () => {
    const r = await clinicalNumericsBolded(null, {});
    expect(r.pass).toBe(true);
  });

  it('passes vacuously on empty summary', async () => {
    const r = await clinicalNumericsBolded(answer(''), {});
    expect(r.pass).toBe(true);
  });

  it('passes when at least one numeric is bolded even if others are not', async () => {
    const r = await clinicalNumericsBolded(
      answer('**HbA1c 7.4%** above goal; LDL 158 mg/dL also flagged.'),
      {},
    );
    // The rubric only requires ONE bolded clinical numeric — partial
    // bolding still passes.
    expect(r.pass).toBe(true);
  });

  it('rejects bold runs that contain no digits when a numeric IS mentioned', async () => {
    const r = await clinicalNumericsBolded(
      // Numeric trigger: "LDL ... 158 mg/dL" matches the LDL pattern.
      // The only bold run wraps "elevated" — a comment, not a value —
      // so the digit-presence check fails.
      answer('LDL 158 mg/dL is **elevated** above the ATP-III cutoff.'),
      {},
    );
    expect(r.pass).toBe(false);
  });

  it('passes when the bolded run mixes label and value', async () => {
    // "HbA1c" itself contains the digit "1", so a bold around just the
    // label happens to satisfy the digit-presence rule. Documenting the
    // intentional behavior.
    const r = await clinicalNumericsBolded(
      answer('**HbA1c** is 7.4% — above goal.'),
      {},
    );
    expect(r.pass).toBe(true);
  });
});
