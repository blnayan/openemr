/**
 * Planner node — decides between call_tools and respond. The first turn
 * always fans out to all eight tools so the planner has a full picture
 * before drafting an AnswerSchema response.
 */

import { ALL_TOOL_NAMES } from '../../tools/index.js';
import type { AgentStateType } from '../state.js';
import { AnswerSchema, type Answer } from '../../schemas/AnswerSchema.js';

export interface PlannerLlmClient {
  invoke(input: unknown): Promise<{ content: string }>;
}

const PREVISIT_PROMPT = [
  'You are AgentForge, a read-only clinical co-pilot for primary care BETWEEN ROOMS.',
  'The clinician has 90 seconds. Surface ONLY what could change today\'s plan.',
  '',
  'Include in claims (skip a category if nothing actionable):',
  '- Top 1-3 active problems',
  '- Current medication count + flag any DDI / allergy conflict (rule:* claims)',
  '- Allergies (just the allergens, mark severe ones as severity "attention")',
  '- The 1-3 MOST recent OR most ABNORMAL labs (skip routine in-range)',
  '- Most recent vital reading (BP/weight) only if abnormal or absent',
  '- Date of last encounter',
  '',
  'TOTAL: aim for 5-8 claims max. The summary line should be 1 short sentence',
  '("Established 60yo F seen Jan 2023 for check-up; on simvastatin; no urgent flags.").',
  'Do NOT enumerate every lab/vital — the doctor will ask follow-ups.',
  '',
  'Patient identity is bound by JWT. Never reference any other patient.',
].join('\n');

const FOLLOWUP_PROMPT_HEADER = [
  'You are AgentForge, a read-only clinical co-pilot for primary care between rooms.',
  'You answer based ONLY on the structured tool results provided in this turn.',
  'Patient identity is bound by JWT. Never reference any other patient.',
].join('\n');

const SCHEMA_BLOCK = [
  'OUTPUT FORMAT — reply with strict JSON only, no prose, no code fences:',
  '{',
  '  "summary":              <string, 1-1000 chars>,',
  '  "claims": [',
  '    {',
  '      "text":         <string, 1-500 chars>,',
  '      "citation_ids": [<string of form tool:<name>:row-<n>>, ...]   // at least 1',
  '      "severity":     "info" | "attention" | "urgent"',
  '    }, ...',
  '  ],',
  '  "followup_suggestions": [<string, max 150 chars>, ...]   // AT MOST 3',
  '  "confidence":           "high" | "medium" | "low"',
  '}',
  '',
  'HARD CONSTRAINTS:',
  '- Each "text" MUST be 500 characters or fewer. Split long facts into separate claims.',
  '- "followup_suggestions" MUST contain AT MOST 3 entries.',
  '- Every claim MUST cite at least one tool:<name>:row-<n> id from the transcript.',
  '- Do NOT mark claims as "urgent" yourself — the verifier injects urgent rule findings.',
  '- Do NOT fabricate citation IDs. Only cite ids that appear in the Tool transcript.',
].join('\n');

export async function runPlanner(
  state: AgentStateType,
  llmClient: PlannerLlmClient | null,
): Promise<Partial<AgentStateType>> {
  if (state.toolResults.length === 0 && state.retryCount === 0) {
    return {
      plannerAction: 'call_tools',
      toolCalls: ALL_TOOL_NAMES
        .filter(name => name !== 'check_drug_interactions')
        .map(name => ({ toolName: name, params: {} })),
    };
  }

  if (!hasInteractionsCheck(state) && hasMedications(state)) {
    const rxnormCodes = extractRxNormCodes(state);
    return {
      plannerAction: 'call_tools',
      toolCalls: [{
        toolName: 'check_drug_interactions',
        params: { rxnorm_codes: rxnormCodes },
      }],
    };
  }

  if (llmClient) {
    const draft = await callLlmForAnswer(state, llmClient);
    if (draft) {
      return { plannerAction: 'respond', draftAnswer: draft };
    }
  }

  return { plannerAction: 'respond', draftAnswer: stubAnswerFromTools(state) };
}

function hasMedications(state: AgentStateType): boolean {
  return state.toolResults.some(r => r.ok && r.tool === 'get_medications');
}

function hasInteractionsCheck(state: AgentStateType): boolean {
  return state.toolResults.some(r => r.tool === 'check_drug_interactions');
}

function extractRxNormCodes(state: AgentStateType): string[] {
  const meds = state.toolResults.find(r => r.ok && r.tool === 'get_medications');
  if (!meds || !meds.ok) return [];
  const codes = meds.rows
    .map(r => (typeof r['rxnorm_code'] === 'string' ? r['rxnorm_code'] as string : null))
    .filter((c): c is string => c !== null && c !== '');
  return codes;
}

async function callLlmForAnswer(
  state: AgentStateType,
  llmClient: PlannerLlmClient,
): Promise<Answer | null> {
  const transcript = state.toolResults.map(r => {
    if (!r.ok) return `${r.tool}: ERROR (${r.reason})`;
    return `${r.tool}:\n${r.rows.map((row, i) => `  row-${i}: ${JSON.stringify(row)}`).join('\n')}`;
  }).join('\n\n');

  const systemPrompt = state.mode === 'previsit'
    ? `${PREVISIT_PROMPT}\n\n${SCHEMA_BLOCK}`
    : `${FOLLOWUP_PROMPT_HEADER}\n\n${SCHEMA_BLOCK}`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...(state.verifyCritique
      ? [{ role: 'system', content: `Previous answer rejected: ${state.verifyCritique}. Try again.` }]
      : []),
    { role: 'user', content: `Question: ${state.question}\n\nTool transcript:\n${transcript}\n\nReturn AnswerSchema JSON only.` },
  ];

  try {
    const response = await llmClient.invoke(messages);
    const cleaned = response.content.trim().replace(/^```(?:json)?/, '').replace(/```$/, '').trim();
    const parsedJson = JSON.parse(cleaned);
    const parsed = AnswerSchema.safeParse(parsedJson);
    if (parsed.success) return parsed.data;
    // eslint-disable-next-line no-console
    console.warn('[agentforge] LLM response did not match AnswerSchema', {
      issues: parsed.error.issues.slice(0, 5),
      preview: cleaned.slice(0, 400),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[agentforge] LLM call failed, falling back to stub', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
}

interface TopicSpec {
  topic: 'medications' | 'labs' | 'vitals' | 'allergies' | 'problems' | 'encounters' | 'interactions' | 'summary';
  tools: string[];
  summary: string;
}

function detectTopic(question: string): TopicSpec {
  const q = question.toLowerCase();
  if (/\b(med|medication|drug|prescription|rx)/.test(q)) {
    return { topic: 'medications', tools: ['get_medications'], summary: 'Active medications on file:' };
  }
  if (/\b(lab|test result|chemistry|cbc|a1c|cholesterol|inr)/.test(q)) {
    return { topic: 'labs', tools: ['get_recent_labs'], summary: 'Recent laboratory results:' };
  }
  if (/\b(vital|bp|blood pressure|pulse|heart rate|temperature|weight|bmi)/.test(q)) {
    return { topic: 'vitals', tools: ['get_vitals'], summary: 'Recent vital signs:' };
  }
  if (/\ballerg/.test(q)) {
    return { topic: 'allergies', tools: ['get_allergies'], summary: 'Allergies on file:' };
  }
  if (/\b(problem|condition|diagnos|history)/.test(q)) {
    return { topic: 'problems', tools: ['get_active_problems'], summary: 'Active problems:' };
  }
  if (/\b(encounter|visit|appointment|seen|last visit)/.test(q)) {
    return { topic: 'encounters', tools: ['get_recent_encounters'], summary: 'Recent encounters:' };
  }
  if (/\b(interact|ddi|contraindic)/.test(q)) {
    return { topic: 'interactions', tools: ['check_drug_interactions'], summary: 'Drug-interaction check:' };
  }
  return {
    topic: 'summary',
    tools: ['get_patient_summary', 'get_active_problems', 'get_medications', 'get_allergies', 'get_recent_labs', 'get_vitals', 'get_recent_encounters', 'check_drug_interactions'],
    summary: 'Pre-visit summary based on the chart on screen:',
  };
}

function stubAnswerFromTools(state: AgentStateType): Answer {
  if (state.mode === 'previsit') {
    return previsitStub(state);
  }
  const spec = detectTopic(state.question);
  const claims: Answer['claims'] = [];
  let rowsRendered = 0;
  const ROW_CAP = spec.topic === 'summary' ? 16 : 24;

  for (const toolName of spec.tools) {
    const result = state.toolResults.find(r => r.tool === toolName);
    if (!result) continue;
    if (!result.ok) {
      claims.push({
        text: `${prettifyTool(toolName)}: data unavailable (${result.reason}).`,
        citation_ids: [`rule:tool-error:${toolName}`],
        severity: 'attention',
      });
      continue;
    }
    if (result.rows.length === 0) {
      claims.push({
        text: `${prettifyTool(toolName)}: no records on file.`,
        citation_ids: [`rule:no-data:${toolName}`],
        severity: 'info',
      });
      continue;
    }
    for (const row of result.rows) {
      const text = renderRowText(toolName, row);
      if (!text) continue;
      claims.push({
        text,
        citation_ids: [String(row.id)],
        severity: 'info',
      });
      rowsRendered += 1;
      if (rowsRendered >= ROW_CAP) break;
    }
    if (rowsRendered >= ROW_CAP) break;
  }

  if (claims.length === 0) {
    claims.push({
      text: 'No structured information was available from this patient\'s record for the requested topic.',
      citation_ids: ['rule:no-data:empty'],
      severity: 'info',
    });
  }

  return {
    summary: spec.summary,
    claims,
    conflicts: [],
    data_gaps: [],
    assumptions: [],
    evidence_catalog: [],
    followup_suggestions: buildFollowups(spec.topic),
    confidence: 'medium',
  };
}

function prettifyTool(name: string): string {
  return name.replace(/^get_|^check_/, '').replace(/_/g, ' ');
}

function previsitStub(state: AgentStateType): Answer {
  const claims: Answer['claims'] = [];
  const find = (tool: string) => state.toolResults.find(r => r.ok && r.tool === tool);

  // Patient one-liner
  const summaryRow = find('get_patient_summary');
  const patientLine = summaryRow && summaryRow.ok && summaryRow.rows[0]
    ? renderRowText('get_patient_summary', summaryRow.rows[0])
    : null;

  // Top 3 active problems
  const problems = find('get_active_problems');
  if (problems && problems.ok) {
    for (const row of problems.rows.slice(0, 3)) {
      const text = renderRowText('get_active_problems', row);
      if (text) claims.push({ text, citation_ids: [String(row.id)], severity: 'attention' });
    }
  }

  // Active medication count + first 3 names
  const meds = find('get_medications');
  if (meds && meds.ok) {
    if (meds.rows.length === 0) {
      claims.push({
        text: 'No active medications on file.',
        citation_ids: ['rule:no-data:get_medications'],
        severity: 'info',
      });
    } else {
      for (const row of meds.rows.slice(0, 3)) {
        const text = renderRowText('get_medications', row);
        if (text) claims.push({ text, citation_ids: [String(row.id)], severity: 'info' });
      }
      if (meds.rows.length > 3) {
        claims.push({
          text: `+ ${meds.rows.length - 3} more active medication(s) — ask "show all meds".`,
          citation_ids: [String(meds.rows[0]!.id)],
          severity: 'info',
        });
      }
    }
  }

  // Allergies
  const allergies = find('get_allergies');
  if (allergies && allergies.ok && allergies.rows.length > 0) {
    for (const row of allergies.rows.slice(0, 3)) {
      const text = renderRowText('get_allergies', row);
      const sev = String(row['criticality'] ?? '').toLowerCase() === 'high' ? 'attention' as const : 'info' as const;
      if (text) claims.push({ text, citation_ids: [String(row.id)], severity: sev });
    }
  }

  // Most recent encounter
  const encs = find('get_recent_encounters');
  if (encs && encs.ok && encs.rows[0]) {
    const text = renderRowText('get_recent_encounters', encs.rows[0]);
    if (text) {
      claims.push({
        text: 'Last visit: ' + text,
        citation_ids: [String(encs.rows[0].id)],
        severity: 'info',
      });
    }
  }

  // Most recent vital — only one row
  const vitals = find('get_vitals');
  if (vitals && vitals.ok && vitals.rows[0]) {
    const text = renderRowText('get_vitals', vitals.rows[0]);
    if (text) claims.push({ text, citation_ids: [String(vitals.rows[0].id)], severity: 'info' });
  }

  if (claims.length === 0) {
    claims.push({
      text: 'No structured chart data was loadable for this patient.',
      citation_ids: ['rule:no-data:empty'],
      severity: 'info',
    });
  }

  return {
    summary: patientLine ?? 'Pre-visit snapshot:',
    claims,
    conflicts: [],
    data_gaps: [],
    assumptions: [],
    evidence_catalog: [],
    followup_suggestions: [
      'What changed since last visit?',
      'Any drug-interaction concerns?',
      'Show recent labs.',
    ],
    confidence: 'medium',
  };
}

function buildFollowups(topic: TopicSpec['topic']): string[] {
  switch (topic) {
    case 'medications':
      return ['Any drug-interaction concerns?', 'When were these last refilled?', 'What are the active problems?'];
    case 'labs':
      return ['Show vitals trend.', 'Compare to last visit values.', 'Any abnormal results?'];
    case 'vitals':
      return ['Show recent labs.', 'Compare to last visit.', 'BP trend?'];
    case 'allergies':
      return ['Conflicts with current meds?', 'Show medications.'];
    case 'problems':
      return ['What meds address these?', 'Most recent encounter for each?'];
    case 'encounters':
      return ['What changed since last visit?', 'Any open referrals?'];
    case 'interactions':
      return ['Show full medication list.', 'Suggest alternatives?'];
    case 'summary':
      return ['What changed since last visit?', 'Any drug-interaction concerns?', 'Most recent labs?'];
  }
}

function renderRowText(tool: string, row: Record<string, unknown>): string | null {
  switch (tool) {
    case 'get_patient_summary': {
      const name = `${row['given_name'] ?? ''} ${row['family_name'] ?? ''}`.trim() || 'unknown';
      return `${name}, sex ${row['sex'] ?? 'unknown'}, DOB ${row['dob'] ?? 'unknown'}.`;
    }
    case 'get_active_problems': {
      const c = row['condition'] ?? 'unspecified condition';
      const onset = row['onset'] ? ` (onset ${shortDate(row['onset'])})` : '';
      return `${c}${onset}.`;
    }
    case 'get_medications': {
      const drug = row['drug_name'] ?? 'unspecified medication';
      const dose = row['dosage'] ?? (row['dose_mg'] ? `${row['dose_mg']} mg` : null);
      const rx = row['rxnorm_code'] ? ` [RxNorm ${row['rxnorm_code']}]` : '';
      return dose ? `${drug} — ${dose}${rx}.` : `${drug}${rx}.`;
    }
    case 'get_recent_labs': {
      const name = row['name'] ?? 'unknown lab';
      const val = row['value'] ?? '?';
      const unit = row['unit'] ?? '';
      const date = shortDate(row['date']);
      return `${name}: ${val} ${unit} (${date}).`;
    }
    case 'get_vitals': {
      const name = row['name'] ?? 'vital';
      const val = row['value'] ?? '?';
      const unit = row['unit'] ?? '';
      const date = shortDate(row['date']);
      const components = Array.isArray(row['components']) ? row['components'] as Array<Record<string, unknown>> : [];
      const compText = components.length > 0
        ? components.map(c => `${c['name'] ?? ''} ${c['value'] ?? '?'} ${c['unit'] ?? ''}`).join('; ')
        : null;
      const valueText = compText ?? `${val} ${unit}`;
      return `${name}: ${valueText} (${date}).`;
    }
    case 'get_allergies': {
      const a = row['allergen'] ?? 'unspecified';
      const reaction = row['reaction'] ? ` — ${row['reaction']}` : '';
      const crit = row['criticality'] && row['criticality'] !== 'unknown' ? ` [${row['criticality']}]` : '';
      return `${a}${reaction}${crit}.`;
    }
    case 'get_recent_encounters': {
      const type = row['type'] ?? row['class'] ?? 'visit';
      const reason = row['reason'] ? ` — ${row['reason']}` : '';
      const date = shortDate(row['start']);
      return `${type}${reason} on ${date}.`;
    }
    case 'check_drug_interactions':
      return `${row['description'] ?? 'see rule'}`;
    default:
      return null;
  }
}

function shortDate(value: unknown): string {
  if (typeof value !== 'string' || value === '') return '?';
  // YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS+ZZ:ZZ → YYYY-MM-DD
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return m ? m[1]! : value;
}
