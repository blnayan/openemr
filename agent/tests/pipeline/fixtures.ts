/**
 * Shared eval fixtures: synthetic ToolResult sets that simulate common
 * patient scenarios. Tests build a mock ToolContext that returns these
 * verbatim so the runPrevisit / runFollowup pipelines run end-to-end
 * without hitting any external service.
 */

import type { ToolResult, ToolContext } from '../../src/tools/types.js';

const FHIR_NOOP = { getPatient: async () => ({ resourceType: 'Patient', id: 'unused' }), searchBundle: async () => ({ resourceType: 'Bundle', type: 'searchset', entry: [] }) };

export function makeContext(): ToolContext {
  return {
    patientUuid: 'fixture-patient-uuid',
    pid: 9001,
    jwt: 'fixture-jwt',
    fhirClient: FHIR_NOOP as unknown as ToolContext['fhirClient'],
  };
}

const day = (n: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
};

export const PATIENT_SUMMARY: ToolResult = {
  ok: true,
  tool: 'get_patient_summary',
  rows: [{
    id: 'tool:get_patient_summary:row-0',
    given_name: 'Maria',
    family_name: 'González',
    sex: 'female',
    dob: '1965-04-15',
    patient_uuid: 'fixture-patient-uuid',
  }],
};

// ---------------------------------------------------------------------------
// Scenario 1 — Stable patient, no changes since last visit
// ---------------------------------------------------------------------------

export const STABLE_NO_CHANGES: ToolResult[] = [
  PATIENT_SUMMARY,
  {
    ok: true, tool: 'get_recent_encounters',
    rows: [
      { id: 'tool:get_recent_encounters:row-0', type: 'check up', start: day(60), end: day(60), class: 'AMB', reason: 'check up' },
      { id: 'tool:get_recent_encounters:row-1', type: 'check up', start: day(180), end: day(180), class: 'AMB', reason: 'check up' },
    ],
  },
  {
    ok: true, tool: 'get_active_problems',
    rows: [
      { id: 'tool:get_active_problems:row-0', condition: 'Hypertension', onset: '2018-05-01', active: true },
    ],
  },
  {
    ok: true, tool: 'get_medications',
    rows: [
      { id: 'tool:get_medications:row-0', drug_name: 'Lisinopril', rxnorm_code: '29046', dose_mg: 10, end_date: null, start_date: '2018-05-01', status: 'active' },
    ],
  },
  { ok: true, tool: 'get_recent_labs', rows: [] },
  { ok: true, tool: 'get_vitals', rows: [] },
  { ok: true, tool: 'get_allergies', rows: [] },
];

// ---------------------------------------------------------------------------
// Scenario 2 — New medication added since last visit
// ---------------------------------------------------------------------------

export const NEW_MEDICATION: ToolResult[] = [
  PATIENT_SUMMARY,
  {
    ok: true, tool: 'get_recent_encounters',
    rows: [
      { id: 'tool:get_recent_encounters:row-0', type: 'check up', start: day(7), end: day(7), class: 'AMB', reason: 'check up' },
      { id: 'tool:get_recent_encounters:row-1', type: 'check up', start: day(95), end: day(95), class: 'AMB', reason: 'check up' },
    ],
  },
  {
    ok: true, tool: 'get_active_problems',
    rows: [
      { id: 'tool:get_active_problems:row-0', condition: 'Hyperlipidemia', onset: '2010-01-01', active: true },
    ],
  },
  {
    ok: true, tool: 'get_medications',
    rows: [
      { id: 'tool:get_medications:row-0', drug_name: 'Atorvastatin', rxnorm_code: '41493', dose_mg: 20, start_date: day(30), end_date: null, status: 'active' },
    ],
  },
  { ok: true, tool: 'get_recent_labs', rows: [] },
  { ok: true, tool: 'get_vitals', rows: [] },
  { ok: true, tool: 'get_allergies', rows: [] },
];

// ---------------------------------------------------------------------------
// Scenario 3 — New abnormal lab since last visit
// ---------------------------------------------------------------------------

export const NEW_ABNORMAL_LAB: ToolResult[] = [
  PATIENT_SUMMARY,
  {
    ok: true, tool: 'get_recent_encounters',
    rows: [
      { id: 'tool:get_recent_encounters:row-0', type: 'check up', start: day(3), end: day(3), class: 'AMB' },
      { id: 'tool:get_recent_encounters:row-1', type: 'check up', start: day(120), end: day(120), class: 'AMB' },
    ],
  },
  { ok: true, tool: 'get_active_problems', rows: [] },
  { ok: true, tool: 'get_medications', rows: [] },
  {
    ok: true, tool: 'get_recent_labs',
    rows: [
      { id: 'tool:get_recent_labs:row-0', name: 'Creatinine', value: 3.4, unit: 'mg/dL', date: day(2), interpretation: 'high' },
      { id: 'tool:get_recent_labs:row-1', name: 'Creatinine', value: 1.0, unit: 'mg/dL', date: day(150), interpretation: 'normal' },
    ],
  },
  { ok: true, tool: 'get_vitals', rows: [] },
  { ok: true, tool: 'get_allergies', rows: [] },
];

// ---------------------------------------------------------------------------
// Scenario 4 — DDI present (warfarin + ibuprofen)
// ---------------------------------------------------------------------------

export const DDI_PRESENT: ToolResult[] = [
  PATIENT_SUMMARY,
  {
    ok: true, tool: 'get_recent_encounters',
    rows: [
      { id: 'tool:get_recent_encounters:row-0', type: 'check up', start: day(15), end: day(15), class: 'AMB' },
      { id: 'tool:get_recent_encounters:row-1', type: 'check up', start: day(110), end: day(110), class: 'AMB' },
    ],
  },
  { ok: true, tool: 'get_active_problems', rows: [] },
  {
    ok: true, tool: 'get_medications',
    rows: [
      { id: 'tool:get_medications:row-0', drug_name: 'Warfarin', rxnorm_code: '11289', dose_mg: 5, start_date: '2020-03-01', end_date: null, status: 'active' },
      { id: 'tool:get_medications:row-1', drug_name: 'Ibuprofen', rxnorm_code: '5640', dose_mg: 400, start_date: day(8), end_date: null, status: 'active' },
    ],
  },
  { ok: true, tool: 'get_recent_labs', rows: [] },
  { ok: true, tool: 'get_vitals', rows: [] },
  { ok: true, tool: 'get_allergies', rows: [] },
  {
    ok: true, tool: 'check_drug_interactions',
    rows: [{
      id: 'tool:check_drug_interactions:row-0',
      interaction_id: 'warfarin-ibuprofen',
      rxnorm_a: '11289', rxnorm_b: '5640',
      severity: 'major',
      description: 'Warfarin + NSAIDs (ibuprofen): increased bleeding risk.',
    }],
  },
];

// ---------------------------------------------------------------------------
// Scenario 5 — Allergy / medication conflict (penicillin → amoxicillin)
// ---------------------------------------------------------------------------

export const ALLERGY_CONFLICT: ToolResult[] = [
  PATIENT_SUMMARY,
  {
    ok: true, tool: 'get_recent_encounters',
    rows: [
      { id: 'tool:get_recent_encounters:row-0', type: 'sick visit', start: day(1), end: day(1), class: 'AMB' },
      { id: 'tool:get_recent_encounters:row-1', type: 'check up', start: day(200), end: day(200), class: 'AMB' },
    ],
  },
  { ok: true, tool: 'get_active_problems', rows: [] },
  {
    ok: true, tool: 'get_medications',
    rows: [
      { id: 'tool:get_medications:row-0', drug_name: 'Amoxicillin', rxnorm_code: '723', dose_mg: 500, start_date: day(1), end_date: null, status: 'active' },
    ],
  },
  { ok: true, tool: 'get_recent_labs', rows: [] },
  { ok: true, tool: 'get_vitals', rows: [] },
  {
    ok: true, tool: 'get_allergies',
    rows: [
      { id: 'tool:get_allergies:row-0', allergen: 'amoxicillin', reaction: 'anaphylaxis', criticality: 'high' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Scenario 6 — First visit on file (only one encounter → baseline view)
// ---------------------------------------------------------------------------

export const FIRST_VISIT: ToolResult[] = [
  PATIENT_SUMMARY,
  {
    ok: true, tool: 'get_recent_encounters',
    rows: [
      { id: 'tool:get_recent_encounters:row-0', type: 'new patient', start: day(1), end: day(1), class: 'AMB' },
    ],
  },
  { ok: true, tool: 'get_active_problems', rows: [] },
  { ok: true, tool: 'get_medications', rows: [] },
  { ok: true, tool: 'get_recent_labs', rows: [] },
  { ok: true, tool: 'get_vitals', rows: [] },
  { ok: true, tool: 'get_allergies', rows: [] },
];

// ---------------------------------------------------------------------------
// Scenario 7 — Failed FHIR (graceful degradation)
// ---------------------------------------------------------------------------

export const PARTIAL_FAILURE: ToolResult[] = [
  PATIENT_SUMMARY,
  {
    ok: true, tool: 'get_recent_encounters',
    rows: [
      { id: 'tool:get_recent_encounters:row-0', type: 'check up', start: day(10), end: day(10), class: 'AMB' },
      { id: 'tool:get_recent_encounters:row-1', type: 'check up', start: day(120), end: day(120), class: 'AMB' },
    ],
  },
  { ok: false, reason: 'fhir_500', tool: 'get_active_problems' },
  {
    ok: true, tool: 'get_medications',
    rows: [
      { id: 'tool:get_medications:row-0', drug_name: 'Lisinopril', rxnorm_code: '29046', dose_mg: 10, start_date: '2018-05-01', end_date: null, status: 'active' },
    ],
  },
  { ok: false, reason: 'fhir_timeout', tool: 'get_recent_labs' },
  { ok: true, tool: 'get_vitals', rows: [] },
  { ok: true, tool: 'get_allergies', rows: [] },
];
