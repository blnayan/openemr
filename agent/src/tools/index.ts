/**
 * Tool registry — both the legacy (name → function) map for the deterministic
 * pre-visit fan-out and the declarative Tool records used by native OpenAI
 * tool calling for follow-up turns.
 *
 * D5: every tool sources patient identity from ToolContext, never from
 * `params`. Schemas explicitly omit any patient-id parameter.
 */

import type { Tool, ToolFunction } from './types.js';
import { getPatientSummary } from './getPatientSummary.js';
import { getActiveProblems } from './getActiveProblems.js';
import { getMedications } from './getMedications.js';
import { getRecentLabs } from './getRecentLabs.js';
import { getVitals } from './getVitals.js';
import { getAllergies } from './getAllergies.js';
import { getRecentEncounters } from './getRecentEncounters.js';
import { checkDrugInteractions } from './checkDrugInteractions.js';

const noParams: Record<string, unknown> = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const ddiParams: Record<string, unknown> = {
  type: 'object',
  properties: {
    rxnorm_codes: {
      type: 'array',
      items: { type: 'string' },
      description: 'RxNorm codes for the patient\'s current medications. Sourced from the prior get_medications result.',
    },
  },
  required: ['rxnorm_codes'],
  additionalProperties: false,
};

export const TOOLS: Tool[] = [
  {
    name: 'get_patient_summary',
    description: 'Return demographics for the patient on screen (name, sex, DOB).',
    parameters: noParams,
    execute: getPatientSummary as ToolFunction,
  },
  {
    name: 'get_active_problems',
    description: 'Return the active problem list (clinical conditions) for the patient on screen.',
    parameters: noParams,
    execute: getActiveProblems as ToolFunction,
  },
  {
    name: 'get_medications',
    description: 'Return active medications (prescriptions) currently on file. Excludes stopped/expired.',
    parameters: noParams,
    execute: getMedications as ToolFunction,
  },
  {
    name: 'get_recent_labs',
    description: 'Return the most recent ~50 laboratory observations sorted by date descending.',
    parameters: noParams,
    execute: getRecentLabs as ToolFunction,
  },
  {
    name: 'get_vitals',
    description: 'Return the most recent ~20 vital sign observations sorted by date descending.',
    parameters: noParams,
    execute: getVitals as ToolFunction,
  },
  {
    name: 'get_allergies',
    description: 'Return all allergies and intolerances on file for the patient.',
    parameters: noParams,
    execute: getAllergies as ToolFunction,
  },
  {
    name: 'get_recent_encounters',
    description: 'Return the patient\'s most recent ~10 encounters sorted by date descending.',
    parameters: noParams,
    execute: getRecentEncounters as ToolFunction,
  },
  {
    name: 'check_drug_interactions',
    description: 'Look up known pairwise drug interactions for the supplied RxNorm codes against the local DDI table.',
    parameters: ddiParams,
    execute: checkDrugInteractions as ToolFunction,
  },
];

export const TOOL_REGISTRY: Record<string, ToolFunction> = Object.fromEntries(
  TOOLS.map(t => [t.name, t.execute]),
);

export const TOOL_LOOKUP: Record<string, Tool> = Object.fromEntries(
  TOOLS.map(t => [t.name, t]),
);

export const ALL_TOOL_NAMES = TOOLS.map(t => t.name);

/** Tools safe to call from a follow-up — excludes patient_summary which is cached. */
export const FOLLOWUP_TOOLS: Tool[] = TOOLS.filter(
  t => t.name !== 'get_patient_summary',
);
