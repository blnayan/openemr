/**
 * checkDrugInteractions — local DDI lookup. Inputs are RxNorm codes
 * sourced from this turn's get_medications result (never raw model
 * arguments). When RxNorm codes are unavailable (AUDIT.md §4) we emit
 * a degraded result rather than silently returning empty.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ToolContext, ToolResult, ToolRow } from './types.js';

const TOOL_NAME = 'check_drug_interactions';

interface DdiInteraction {
  id: string;
  rxnorm_a: string;
  rxnorm_b: string;
  severity: 'major' | 'moderate' | 'minor';
  description: string;
}

interface DdiTable {
  version: string;
  source: string;
  interactions: DdiInteraction[];
}

let cachedTable: DdiTable | null = null;

function loadDdiTable(): DdiTable {
  if (cachedTable) return cachedTable;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', '..', 'data', 'ddi-table.json'),
    join(here, '..', 'data', 'ddi-table.json'),
  ];
  for (const path of candidates) {
    try {
      const raw = readFileSync(path, 'utf-8');
      cachedTable = JSON.parse(raw) as DdiTable;
      return cachedTable;
    } catch {
      // try next candidate
    }
  }
  cachedTable = { version: 'empty', source: 'fallback', interactions: [] };
  return cachedTable;
}

export async function checkDrugInteractions(
  params: { rxnorm_codes: Array<string | null | undefined> } | Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolResult> {
  const rxnormCodes = Array.isArray((params as { rxnorm_codes?: unknown }).rxnorm_codes)
    ? (params as { rxnorm_codes: Array<string | null | undefined> }).rxnorm_codes
    : [];

  const codes = rxnormCodes.filter((c): c is string => typeof c === 'string' && c.trim() !== '');

  if (codes.length === 0) {
    return {
      ok: true,
      rows: [],
      tool: TOOL_NAME,
      degraded: true,
      degradation_reason: 'No RxNorm codes available — drug interaction check is incomplete',
    };
  }

  const table = loadDdiTable();
  const rows: ToolRow[] = [];

  const seen = new Set<string>();
  for (let i = 0; i < codes.length; i++) {
    for (let j = i + 1; j < codes.length; j++) {
      const a = codes[i]!;
      const b = codes[j]!;
      const interaction = table.interactions.find(d =>
        (d.rxnorm_a === a && d.rxnorm_b === b) ||
        (d.rxnorm_a === b && d.rxnorm_b === a)
      );
      if (interaction && !seen.has(interaction.id)) {
        seen.add(interaction.id);
        rows.push({
          id: `tool:${TOOL_NAME}:row-${rows.length}`,
          interaction_id: interaction.id,
          rxnorm_a: interaction.rxnorm_a,
          rxnorm_b: interaction.rxnorm_b,
          severity: interaction.severity,
          description: interaction.description,
        });
      }
    }
  }

  return { ok: true, rows, tool: TOOL_NAME };
}
