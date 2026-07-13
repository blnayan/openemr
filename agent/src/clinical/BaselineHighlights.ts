/**
 * BaselineHighlights — pulls the "always important" facts out of a tool
 * transcript so the pre-visit pull surfaces them even when nothing has
 * changed since the last encounter.
 *
 * Doctor opens the chart between rooms. They need to know:
 *   - the top active problems (chronic conditions)
 *   - current high-risk medications (anticoagulants, insulin, opioids…)
 *   - any high-criticality allergies
 *
 * Each highlight carries its tool:<name>:row-<n> citation id so Layer 1
 * grounding still works.
 */

import type { ToolResult } from '../tools/types.js';
import type { DeltaItem } from './EncounterDiff.js';
import { citationIdsForRow } from './rowCitations.js';

/**
 * RxNorm codes for high-risk outpatient medications. When any of these
 * are present in the active list, they get top billing in the baseline
 * highlights even if newer meds also exist.
 */
const HIGH_RISK_RXNORM = new Set<string>([
  // Anticoagulants
  '11289',  // Warfarin
  '855332', '855288', '1037045', '1037179', // Apixaban / rivaroxaban / dabigatran codes
  // Insulins
  '5856', '253182', '274783', '6138',
  // Opioids
  '7052', '161', '7804', '5489',  // Morphine / codeine / oxycodone / hydrocodone
  // High-risk cardiac
  '3407', '6135',  // Digoxin
  // Immunosuppressants
  '8633', '4337',  // Methotrexate / cyclosporine
  // Glucose-lowering with risk
  '6809',          // Metformin (worth showing — common but important)
]);

export interface BaselineHighlights {
  problems: DeltaItem[];
  medications: DeltaItem[];
  allergies: DeltaItem[];
}

const MAX_PROBLEMS = 3;
const MAX_MEDS = 3;
const MAX_ALLERGIES = 2;

interface OkRows {
  tool: string;
  rows: Array<Record<string, unknown> & { id: string }>;
}

function ok(toolResults: ToolResult[], name: string): OkRows | null {
  const r = toolResults.find(x => x.tool === name);
  if (!r || !r.ok) return null;
  return { tool: r.tool, rows: r.rows };
}

export function computeBaselineHighlights(toolResults: ToolResult[]): BaselineHighlights {
  return {
    problems: pickProblems(toolResults),
    medications: pickMedications(toolResults),
    allergies: pickAllergies(toolResults),
  };
}

function pickProblems(toolResults: ToolResult[]): DeltaItem[] {
  const problems = ok(toolResults, 'get_active_problems');
  if (!problems || problems.rows.length === 0) return [];
  return problems.rows.slice(0, MAX_PROBLEMS).map(row => ({
    text: `Active problem: ${row['condition'] ?? 'unspecified'}.`,
    citationIds: citationIdsForRow(row),
    severity: 'info' as const,
  }));
}

function pickMedications(toolResults: ToolResult[]): DeltaItem[] {
  const meds = ok(toolResults, 'get_medications');
  if (!meds || meds.rows.length === 0) return [];

  // Sort: high-risk first, then everything else preserving original order.
  const ranked = [...meds.rows].sort((a, b) => {
    const aHigh = HIGH_RISK_RXNORM.has(String(a['rxnorm_code'] ?? '')) ? 1 : 0;
    const bHigh = HIGH_RISK_RXNORM.has(String(b['rxnorm_code'] ?? '')) ? 1 : 0;
    return bHigh - aHigh;
  });

  return ranked.slice(0, MAX_MEDS).map(row => {
    const drug = String(row['drug_name'] ?? 'unspecified medication');
    const dose = row['dosage'] ?? (row['dose_mg'] ? `${row['dose_mg']} mg` : null);
    const isHighRisk = HIGH_RISK_RXNORM.has(String(row['rxnorm_code'] ?? ''));
    return {
      text: dose ? `On ${drug} ${dose}.` : `On ${drug}.`,
      citationIds: citationIdsForRow(row),
      severity: isHighRisk ? ('attention' as const) : ('info' as const),
    };
  });
}

function pickAllergies(toolResults: ToolResult[]): DeltaItem[] {
  const allergies = ok(toolResults, 'get_allergies');
  if (!allergies || allergies.rows.length === 0) return [];

  // Prioritise high-criticality entries.
  const sorted = [...allergies.rows].sort((a, b) => {
    const aHigh = String(a['criticality'] ?? '').toLowerCase() === 'high' ? 1 : 0;
    const bHigh = String(b['criticality'] ?? '').toLowerCase() === 'high' ? 1 : 0;
    return bHigh - aHigh;
  });

  return sorted.slice(0, MAX_ALLERGIES).map(row => {
    const allergen = String(row['allergen'] ?? 'unspecified allergen');
    const isHigh = String(row['criticality'] ?? '').toLowerCase() === 'high';
    const reaction = row['reaction'] ? ` (${row['reaction']})` : '';
    return {
      text: `Allergy: ${allergen}${reaction}.`,
      citationIds: citationIdsForRow(row),
      severity: isHigh ? ('attention' as const) : ('info' as const),
    };
  });
}

export function flattenBaseline(baseline: BaselineHighlights): DeltaItem[] {
  return [
    ...baseline.problems,
    ...baseline.medications,
    ...baseline.allergies,
  ];
}
