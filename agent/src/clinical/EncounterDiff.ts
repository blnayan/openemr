/**
 * EncounterDiff — computes "what changed since the last encounter" from a
 * pre-visit tool transcript. The diff anchors on the second-most-recent
 * encounter's start date; everything created/active/observed AFTER that
 * date is a delta.
 *
 * If only one (or zero) prior encounters exist, returns a baseline view
 * with a flag so the UI can phrase it as a first-visit overview.
 *
 * D9: every delta finding carries the citation IDs of the rows it was
 * derived from, so Layer 1 grounding still works.
 */

import type { ToolResult } from '../tools/types.js';
import { citationIdsForRow } from './rowCitations.js';

export interface EncounterDiff {
  /** True when fewer than 2 prior encounters → no diff anchor available. */
  baseline: boolean;
  /** Date string we anchor against; null for baseline. */
  anchorDate: string | null;
  /** Description of the anchor encounter for the UI/LLM. */
  anchorLabel: string | null;
  /** Days between anchor and "today" (now). */
  daysSinceLastEncounter: number | null;

  newProblems:    DeltaItem[];
  medsAdded:      DeltaItem[];
  medsStopped:    DeltaItem[];
  newAbnormalLabs: DeltaItem[];
  newAllergies:   DeltaItem[];
  vitalChanges:   DeltaItem[];
}

export interface DeltaItem {
  text: string;
  /** Tool row IDs that this delta is grounded in. Always non-empty. */
  citationIds: string[];
  /** 'attention' for clinically meaningful changes; 'info' for everything else. */
  severity: 'attention' | 'info';
}

interface OkRows {
  tool: string;
  rows: Array<Record<string, unknown> & { id: string }>;
}

function ok(toolResults: ToolResult[], name: string): OkRows | null {
  const r = toolResults.find(x => x.tool === name);
  if (!r || !r.ok) return null;
  return { tool: r.tool, rows: r.rows };
}

function parseDate(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function isoDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function computeEncounterDiff(toolResults: ToolResult[]): EncounterDiff {
  const empty: EncounterDiff = {
    baseline: true,
    anchorDate: null,
    anchorLabel: null,
    daysSinceLastEncounter: null,
    newProblems: [],
    medsAdded: [],
    medsStopped: [],
    newAbnormalLabs: [],
    newAllergies: [],
    vitalChanges: [],
  };

  const encounters = ok(toolResults, 'get_recent_encounters');
  if (!encounters || encounters.rows.length < 2) {
    return empty;
  }

  // Encounters are returned newest-first by the FHIR `_sort=-date` parameter.
  // Index 0 = current/most recent. Index 1 = the prior encounter — our anchor.
  const anchor = encounters.rows[1];
  if (!anchor) return empty;

  const anchorTs = parseDate(anchor['start']);
  if (anchorTs === null) return empty;

  const now = Date.now();
  const daysSince = Math.max(0, Math.round((now - anchorTs) / (1000 * 60 * 60 * 24)));

  const out: EncounterDiff = {
    baseline: false,
    anchorDate: isoDate(anchorTs),
    anchorLabel: typeof anchor['type'] === 'string'
      ? `${anchor['type']} on ${isoDate(anchorTs)}`
      : `encounter on ${isoDate(anchorTs)}`,
    daysSinceLastEncounter: daysSince,
    newProblems: [],
    medsAdded: [],
    medsStopped: [],
    newAbnormalLabs: [],
    newAllergies: [],
    vitalChanges: [],
  };

  // ── New active problems ────────────────────────────────────────────────
  const problems = ok(toolResults, 'get_active_problems');
  if (problems) {
    for (const row of problems.rows) {
      const onsetTs = parseDate(row['onset']);
      if (onsetTs === null) continue;
      if (onsetTs > anchorTs) {
        out.newProblems.push({
          text: `New problem: ${row['condition'] ?? 'unspecified'} (onset ${isoDate(onsetTs)}).`,
          citationIds: citationIdsForRow(row),
          severity: 'attention',
        });
      }
    }
  }

  // ── Medication adds / discontinuations ─────────────────────────────────
  const meds = ok(toolResults, 'get_medications');
  if (meds) {
    for (const row of meds.rows) {
      const startTs = parseDate(row['start_date'] ?? row['authored_on']);
      if (startTs !== null && startTs > anchorTs) {
        out.medsAdded.push({
          text: `Medication added: ${row['drug_name'] ?? 'unspecified'}${
            row['dosage'] ? ` (${row['dosage']})` : row['dose_mg'] ? ` (${row['dose_mg']} mg)` : ''
          }.`,
          citationIds: citationIdsForRow(row),
          severity: 'attention',
        });
      }
      const endTs = parseDate(row['end_date']);
      const status = String(row['status'] ?? '').toLowerCase();
      if ((status === 'stopped' || status === 'completed') && endTs !== null && endTs > anchorTs) {
        out.medsStopped.push({
          text: `Medication discontinued: ${row['drug_name'] ?? 'unspecified'} (stopped ${isoDate(endTs)}).`,
          citationIds: citationIdsForRow(row),
          severity: 'attention',
        });
      }
    }
  }

  // ── New abnormal labs since anchor ─────────────────────────────────────
  const labs = ok(toolResults, 'get_recent_labs');
  if (labs) {
    for (const row of labs.rows) {
      const labTs = parseDate(row['date']);
      if (labTs === null || labTs <= anchorTs) continue;
      if (isAbnormal(row)) {
        out.newAbnormalLabs.push({
          text: `New abnormal: ${row['name'] ?? 'lab'} ${row['value'] ?? '?'} ${row['unit'] ?? ''} (${isoDate(labTs)}).`,
          citationIds: citationIdsForRow(row),
          severity: 'attention',
        });
      }
    }
  }

  // ── New allergies since anchor (best effort — many fixtures lack onset) ─
  const allergies = ok(toolResults, 'get_allergies');
  if (allergies) {
    for (const row of allergies.rows) {
      const onsetTs = parseDate(row['onset'] ?? row['recorded_date']);
      if (onsetTs !== null && onsetTs > anchorTs) {
        out.newAllergies.push({
          text: `New allergy on file: ${row['allergen'] ?? 'unspecified'}.`,
          citationIds: citationIdsForRow(row),
          severity: 'attention',
        });
      }
    }
  }

  // ── Vitals: compare most recent reading to the one closest to anchor ───
  const vitals = ok(toolResults, 'get_vitals');
  if (vitals && vitals.rows.length >= 2) {
    const trend = computeVitalTrend(vitals.rows, anchorTs);
    out.vitalChanges = trend;
  }

  return out;
}

const ABNORMAL_FLAGS = new Set(['high', 'low', 'critical', 'abnormal', 'h', 'l']);

function isAbnormal(row: Record<string, unknown>): boolean {
  const flag = String(row['interpretation'] ?? row['flag'] ?? '').toLowerCase();
  if (ABNORMAL_FLAGS.has(flag)) return true;
  // Heuristic: numeric value outside generic-reference bounds when interpretation
  // is missing. This is intentionally conservative (only flags the obvious
  // outliers) so we don't over-report. The judge layer catches false-positives.
  const value = typeof row['value'] === 'number' ? row['value'] : Number(row['value']);
  if (!Number.isFinite(value)) return false;
  const name = String(row['name'] ?? '').toLowerCase();
  if (name.includes('cholesterol') && (value as number) > 240) return true;
  if (name.includes('ldl') && (value as number) > 160) return true;
  if (name.includes('triglyceride') && (value as number) > 200) return true;
  if (name.includes('glucose') && (value as number) > 200) return true;
  if (name.includes('a1c') && (value as number) > 7) return true;
  if (name.includes('creatinine') && (value as number) > 1.5) return true;
  if (name.includes('hemoglobin') && ((value as number) > 17 || (value as number) < 11)) return true;
  return false;
}

function computeVitalTrend(
  rows: Array<Record<string, unknown> & { id: string }>,
  anchorTs: number,
): DeltaItem[] {
  // Buckets: rows post-anchor vs rows at/before anchor.
  const recent = rows.filter(r => {
    const t = parseDate(r['date']);
    return t !== null && t > anchorTs;
  });
  if (recent.length === 0) return [];

  // Only highlight the single most recent post-anchor vital row, with a
  // brief delta from the closest pre-anchor reading where applicable.
  const newest = recent[0];
  if (!newest) return [];

  const findSamePre = (name: string) => rows.find(r => {
    const t = parseDate(r['date']);
    return t !== null && t <= anchorTs && String(r['name'] ?? '').toLowerCase() === name.toLowerCase();
  });

  const name = String(newest['name'] ?? '');
  const prev = findSamePre(name);
  const date = isoDate(parseDate(newest['date'])!);

  if (prev && typeof newest['value'] === 'number' && typeof prev['value'] === 'number') {
    const delta = (newest['value'] as number) - (prev['value'] as number);
    if (Math.abs(delta) > 0.01) {
      const sign = delta > 0 ? '+' : '';
      return [{
        text: `Vitals trend: ${name} ${sign}${delta.toFixed(1)} ${newest['unit'] ?? ''} since last visit (${date}).`,
        citationIds: [String(newest.id), String(prev.id)],
        severity: 'info',
      }];
    }
  }
  return [{
    text: `New vital reading: ${name} ${newest['value'] ?? '?'} ${newest['unit'] ?? ''} (${date}).`,
    citationIds: [String(newest.id)],
    severity: 'info',
  }];
}

/** Render a one-line summary from a diff (used by the planner). */
export function describeDiff(diff: EncounterDiff, patientLabel: string): string {
  if (diff.baseline) {
    return `${patientLabel}. First documented visit on file — no prior encounter to compare against.`;
  }
  const counts = [
    diff.newProblems.length     > 0 ? `${diff.newProblems.length} new problem(s)`   : null,
    diff.medsAdded.length       > 0 ? `${diff.medsAdded.length} med add(s)`         : null,
    diff.medsStopped.length     > 0 ? `${diff.medsStopped.length} med stop(s)`      : null,
    diff.newAbnormalLabs.length > 0 ? `${diff.newAbnormalLabs.length} new abnormal lab(s)` : null,
    diff.newAllergies.length    > 0 ? `${diff.newAllergies.length} new allergy(s)`  : null,
  ].filter((x): x is string => x !== null);
  const days = diff.daysSinceLastEncounter ?? 0;
  const sinceText = `last visit ${days}d ago, ${diff.anchorDate ?? '?'}`;
  if (counts.length === 0) {
    return `${patientLabel}. No significant chart changes (${sinceText}).`;
  }
  return `${patientLabel}. Since ${sinceText}: ${counts.join(', ')}.`;
}

/** Flatten diff into a list of DeltaItems for the LLM to ground claims on. */
export function flattenDiff(diff: EncounterDiff): DeltaItem[] {
  return [
    ...diff.newProblems,
    ...diff.medsAdded,
    ...diff.medsStopped,
    ...diff.newAbnormalLabs,
    ...diff.newAllergies,
    ...diff.vitalChanges,
  ];
}
