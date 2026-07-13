/**
 * ClinicalRuleEngine — Layer 2 deterministic checks. Fires regardless
 * of what the planner said. All rule findings are severity 'urgent';
 * the planner cannot self-elevate to urgent (downgraded by the
 * formatter to prevent gaming).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ToolResult } from '../tools/types.js';

export interface RuleResult {
  ruleId: string;
  citationId: string;
  severity: 'urgent';
  description: string;
}

interface DdiInteraction {
  id: string;
  rxnorm_a: string;
  rxnorm_b: string;
  severity: string;
  description: string;
}

interface DoseEntry {
  rxnorm: string;
  drug: string;
  min_mg: number;
  max_mg: number;
  unit: string;
}

let ddiCache: DdiInteraction[] | null = null;
let doseCache: DoseEntry[] | null = null;

function loadJson<T>(filename: string, fallback: T): T {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', '..', 'data', filename),
    join(here, '..', 'data', filename),
  ];
  for (const path of candidates) {
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as T;
    } catch {
      // try next
    }
  }
  return fallback;
}

function loadDdi(): DdiInteraction[] {
  if (ddiCache) return ddiCache;
  const table = loadJson<{ interactions?: DdiInteraction[] }>('ddi-table.json', { interactions: [] });
  ddiCache = table.interactions ?? [];
  return ddiCache;
}

function loadDoseTable(): DoseEntry[] {
  if (doseCache) return doseCache;
  doseCache = loadJson<DoseEntry[]>('dose-table.json', []);
  return doseCache;
}

interface MedicationRow {
  id: string;
  drug_name?: unknown;
  rxnorm_code?: unknown;
  dose_mg?: unknown;
  active?: unknown;
  end_date?: unknown;
}

interface AllergyRow {
  id: string;
  allergen?: unknown;
}

function isOk(r: ToolResult): r is Extract<ToolResult, { ok: true }> {
  return r.ok === true;
}

export class ClinicalRuleEngine {
  evaluate(toolResults: ToolResult[]): RuleResult[] {
    const findings: RuleResult[] = [];

    const meds = toolResults
      .filter(r => r.ok && r.tool === 'get_medications')
      .flatMap(r => isOk(r) ? r.rows as unknown as MedicationRow[] : []);

    const allergies = toolResults
      .filter(r => r.ok && r.tool === 'get_allergies')
      .flatMap(r => isOk(r) ? r.rows as unknown as AllergyRow[] : []);

    findings.push(...this.evaluateDdi(meds));
    findings.push(...this.evaluateAllergyConflicts(meds, allergies));
    findings.push(...this.evaluateDoseRanges(meds));

    return findings;
  }

  private evaluateDdi(meds: MedicationRow[]): RuleResult[] {
    const codes = meds
      .map(m => (typeof m.rxnorm_code === 'string' ? m.rxnorm_code : null))
      .filter((c): c is string => c !== null && c !== '');

    if (codes.length === 0 && meds.length > 0) {
      return [{
        ruleId: 'ddi:no-rxnorm',
        citationId: 'rule:ddi:no-rxnorm',
        severity: 'urgent',
        description:
          'RxNorm codes unavailable for the medications on file — drug interaction check is incomplete.',
      }];
    }

    const table = loadDdi();
    const seen = new Set<string>();
    const findings: RuleResult[] = [];

    for (let i = 0; i < codes.length; i++) {
      for (let j = i + 1; j < codes.length; j++) {
        const a = codes[i]!;
        const b = codes[j]!;
        const hit = table.find(d =>
          (d.rxnorm_a === a && d.rxnorm_b === b) ||
          (d.rxnorm_a === b && d.rxnorm_b === a),
        );
        if (hit && !seen.has(hit.id)) {
          seen.add(hit.id);
          findings.push({
            ruleId: `ddi:${hit.id}`,
            citationId: `rule:ddi:${hit.id}`,
            severity: 'urgent',
            description: hit.description,
          });
        }
      }
    }

    return findings;
  }

  private evaluateAllergyConflicts(meds: MedicationRow[], allergies: AllergyRow[]): RuleResult[] {
    if (meds.length === 0 || allergies.length === 0) return [];

    const findings: RuleResult[] = [];
    const seen = new Set<string>();

    for (const med of meds) {
      const drug = typeof med.drug_name === 'string' ? med.drug_name.toLowerCase() : '';
      if (drug === '') continue;
      for (const allergy of allergies) {
        const allergen = typeof allergy.allergen === 'string' ? allergy.allergen.toLowerCase() : '';
        if (allergen === '') continue;
        if (drug.includes(allergen) || allergen.includes(drug)) {
          const ruleId = `allergy:${allergen.replace(/[^a-z0-9-]/g, '-')}`;
          if (seen.has(ruleId)) continue;
          seen.add(ruleId);
          findings.push({
            ruleId,
            citationId: `rule:${ruleId}`,
            severity: 'urgent',
            description: `Patient allergy "${allergy.allergen}" conflicts with prescribed "${med.drug_name}".`,
          });
        }
      }
    }

    return findings;
  }

  private evaluateDoseRanges(meds: MedicationRow[]): RuleResult[] {
    const findings: RuleResult[] = [];
    const table = loadDoseTable();
    const seen = new Set<string>();

    for (const med of meds) {
      const rx = typeof med.rxnorm_code === 'string' ? med.rxnorm_code : null;
      const dose = typeof med.dose_mg === 'number' ? med.dose_mg : null;
      if (rx === null || dose === null) continue;
      const entry = table.find(d => d.rxnorm === rx);
      if (!entry) continue;
      if (dose < entry.min_mg || dose > entry.max_mg) {
        const ruleId = `dose:${entry.drug.toLowerCase()}-out-of-range`;
        if (seen.has(ruleId)) continue;
        seen.add(ruleId);
        findings.push({
          ruleId,
          citationId: `rule:${ruleId}`,
          severity: 'urgent',
          description:
            `${entry.drug} dose ${dose} ${entry.unit} is outside the typical therapeutic range ` +
            `(${entry.min_mg}-${entry.max_mg} ${entry.unit}).`,
        });
      }
    }

    return findings;
  }
}
