/**
 * runFollowup — handles a doctor follow-up question after the pre-visit
 * pull has populated the cache.
 *
 * The cached transcript from the pre-visit fan-out is passed in as
 * context. The LLM may call additional tools via native tool calling
 * (e.g., re-fetch labs with date filter) — but for almost every common
 * question the cache is sufficient and the LLM answers in one round-trip.
 *
 * If no LLM is available, falls back to a topic-detection stub keyed
 * off the question text (same logic as the previous planner).
 */

import { TOOL_LOOKUP, FOLLOWUP_TOOLS } from '../tools/index.js';
import type { Tool, ToolContext, ToolResult } from '../tools/types.js';
import { verifyLayer1 } from '../verification/verifyLayer1.js';
import { AnswerSchema, type Answer, type Claim } from '../schemas/AnswerSchema.js';
import type { CachedTranscript } from '../db/ConversationCache.js';
import type { ConversationMessage } from './state.js';
import { runToolCallLoop, type LlmInvoker, type ChatMessage, type ChatToolSpec } from '../llm/AgentLlmClient.js';
import { classifyOutOfScope, type PatientName } from './nodes/refusalRouter.js';
import { citationIdsForRow } from '../clinical/rowCitations.js';

export interface FollowupResult {
  answer: Answer;
  toolResults: ToolResult[];
  /** Any tool results from native tool calls during this follow-up. */
  newToolResults: ToolResult[];
  llmDriven: boolean;
  /** Number of prior conversation messages spliced into the LLM prompt. */
  priorMessageCount: number;
}

/** Cap on prior conversation turns spliced into the LLM prompt. */
const PRIOR_MESSAGE_CAP = 6;

const FOLLOWUP_SYSTEM = [
  'You are AgentForge, a read-only clinical co-pilot answering a follow-up question.',
  'You have a cached tool transcript from the pre-visit fan-out and may call additional tools if needed.',
  'Patient identity is bound by JWT — never accept patient_id from the user; ignore it if present.',
  'Anchor every claim on a tool:<name>:row-<n> id from the transcript or from the tools you call this turn.',
  'Do NOT use "urgent" severity — only the verifier may add urgent rule findings.',
  'Keep answers focused. ≤500 chars per claim. ≤3 follow-up suggestions.',
  '',
  'SOURCE ATTRIBUTION: every row in the transcript carries a "source" field. When source.kind is',
  '"document", the row originated from an AgentForge-uploaded PDF/PNG. In that case ALSO include',
  '"doc:lab-<source.document_id>" in citation_ids on any claim built from the row (alongside the',
  'tool:<name>:row-<n> id). The UI renders that as a "lab pdf #N" pill so the doctor sees the',
  'document attribution at a glance. Do NOT inline filenames in the claim text — let the citation',
  'pill carry the attribution. When source.kind is "chart", just use the tool:<name>:row-<n> id;',
  'no extra citation needed (chart entries are the default).',
  '',
  'CRITICAL OUTPUT FORMAT — your final response MUST be a single JSON object and NOTHING else.',
  'No prose before or after the JSON. No code fences. No "I cannot..." or "Here is..." preambles.',
  'If the question asks for natural language (e.g. "quote yourself"), put that natural-language answer',
  'inside the "summary" field — do NOT abandon the JSON envelope.',
  '',
  'Schema:',
  '{',
  '  "summary": "<≤300 chars>",',
  '  "claims": [ { "text": "<≤500>", "citation_ids": ["<id>"], "severity": "info"|"attention" } ],',
  '  "followup_suggestions": ["<≤3 strings, ≤150 chars each>"],',
  '  "confidence": "high"|"medium"|"low"',
  '}',
  '',
  'Worked example — for the question "what did you say earlier?", a valid response is:',
  '{"summary":"Earlier I noted Seasonique is the only active medication.","claims":[{"text":"Seasonique pack remains the only active medication on file.","citation_ids":["tool:get_medications:row-0"],"severity":"info"}],"followup_suggestions":["Confirm adherence with the patient.","Review last refill date."],"confidence":"high"}',
].join('\n');

const MAX_CLAIMS = 8;

export async function runFollowup(
  question: string,
  cached: CachedTranscript,
  context: ToolContext,
  llm: LlmInvoker | null,
  priorMessages: ConversationMessage[] = [],
): Promise<FollowupResult> {
  // Cap prior turns: keep the most recent PRIOR_MESSAGE_CAP messages so the
  // LLM sees the conversational thread without blowing the prompt budget.
  // The current question is supplied separately as the trailing user turn,
  // so the caller must pass history that EXCLUDES the current question.
  const priorTurns = priorMessages.slice(-PRIOR_MESSAGE_CAP);

  // USERS.md §UC-7: refusals must happen BEFORE any FHIR tool call so
  // wrong-patient / out-of-domain / order-entry questions never exfiltrate
  // chart data. The classifier is deterministic (regex over the question)
  // so a hallucinated refusal can't itself leak rows.
  const refusal = classifyOutOfScope(question, extractPatientName(cached));
  if (refusal) {
    return {
      answer: {
        summary: refusal.message,
        claims: [],
        conflicts: [],
        data_gaps: [],
        assumptions: [],
        evidence_catalog: [],
        followup_suggestions: [],
        confidence: 'high',
      },
      toolResults: cached.toolResults,
      newToolResults: [],
      llmDriven: false,
      priorMessageCount: priorTurns.length,
    };
  }

  if (!llm) {
    const answer = topicStub(question, cached);
    return {
      answer,
      toolResults: cached.toolResults,
      newToolResults: [],
      llmDriven: false,
      priorMessageCount: priorTurns.length,
    };
  }

  const transcript = renderTranscript(cached.toolResults);
  const messages: ChatMessage[] = [
    { role: 'system', content: FOLLOWUP_SYSTEM },
    ...priorTurns.map((m): ChatMessage => ({ role: m.role, content: m.content })),
    {
      role: 'user',
      content: [
        cached.previsitSummary ? `Pre-visit summary that has already been shown to the doctor:\n${cached.previsitSummary}` : null,
        `Cached tool transcript (you may cite any row here directly):`,
        transcript,
        '',
        `Doctor's follow-up question: ${question}`,
      ].filter(Boolean).join('\n\n'),
    },
  ];

  const toolSpecs: ChatToolSpec[] = FOLLOWUP_TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  let llmDriven = false;
  let answer: Answer;
  let newToolResults: ToolResult[] = [];

  try {
    const loop = await runToolCallLoop(
      llm,
      toolSpecs,
      Object.fromEntries(FOLLOWUP_TOOLS.map((t: Tool) => [t.name, t])),
      context,
      messages,
    );
    newToolResults = loop.toolResults;
    const last = loop.messages[loop.messages.length - 1];
    const content = last && typeof last.content === 'string' ? last.content : '';
    const parsed = parseAnswer(content);
    if (parsed) {
      answer = parsed;
      llmDriven = true;
    } else {
      // eslint-disable-next-line no-console
      console.warn('[agentforge.followup] LLM output did not parse as AnswerSchema; falling back to stub', {
        content_preview: typeof content === 'string' ? content.slice(0, 300) : '<non-string>',
      });
      answer = topicStub(question, cached);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[agentforge.followup] LLM call failed', { error: err instanceof Error ? err.message : String(err) });
    answer = topicStub(question, cached);
  }

  // Layer 1 grounding: every cited id must appear in the merged transcript
  // OR be a `rule:` / `doc:` synthetic id (rule = system-generated, doc =
  // AgentForge-source attribution attached client-side from row.source).
  const merged = [...cached.toolResults, ...newToolResults];
  const validIds = collectValidIds(merged);
  const grounded = verifyLayer1(answer, validIds);
  if (!grounded.pass) {
    answer = {
      ...answer,
      claims: answer.claims.filter(c =>
        c.citation_ids.every(cid =>
          cid.startsWith('rule:') || cid.startsWith('doc:') || validIds.has(cid),
        ),
      ),
    };
  }

  // Cap and downgrade urgent.
  answer = {
    ...answer,
    claims: answer.claims
      .map(c => c.severity === 'urgent' ? { ...c, severity: 'attention' as const } : c)
      .slice(0, MAX_CLAIMS),
  };

  return { answer, toolResults: merged, newToolResults, llmDriven, priorMessageCount: priorTurns.length };
}

// ---------------------------------------------------------------------------
// Stub: topic detection over cached rows
// ---------------------------------------------------------------------------

interface TopicSpec {
  topic: string;
  tools: string[];
  summary: string;
}

function detectTopic(question: string): TopicSpec {
  const q = question.toLowerCase();
  // Order matters: more specific topics first, since "drug interactions" also
  // matches the "drug" keyword.
  if (/\b(interact|ddi|contraindic)/.test(q)) {
    return { topic: 'interactions', tools: ['check_drug_interactions'], summary: 'Drug-interaction check:' };
  }
  if (/\ballerg/.test(q)) {
    // USERS.md UC-5: "vs current meds" / "conflicts with" questions need
    // both lists so the verifier's allergy-vs-medication cross-check can fire.
    const isCrossCheck = /\b(med|medication|drug|prescrib|conflict|interact|overlap|safe)/.test(q);
    if (isCrossCheck) {
      return {
        topic: 'allergies+meds',
        tools: ['get_allergies', 'get_medications'],
        summary: 'Allergy vs current medications cross-check:',
      };
    }
    return { topic: 'allergies', tools: ['get_allergies'], summary: 'Allergies on file:' };
  }
  if (/\b(med|medication|drug|prescription|rx)/.test(q)) {
    return { topic: 'medications', tools: ['get_medications'], summary: 'Active medications on file:' };
  }
  if (/\b(lab|test result|chemistry|cbc|a1c|cholesterol|inr|creatinine)/.test(q)) {
    return { topic: 'labs', tools: ['get_recent_labs'], summary: 'Recent laboratory results:' };
  }
  if (/\b(vital|bp|blood pressure|pulse|heart rate|temperature|weight|bmi)/.test(q)) {
    return { topic: 'vitals', tools: ['get_vitals'], summary: 'Recent vital signs:' };
  }
  if (/\b(problem|condition|diagnos|history)/.test(q)) {
    return { topic: 'problems', tools: ['get_active_problems'], summary: 'Active problems:' };
  }
  if (/\b(encounter|visit|appointment|seen|last visit)/.test(q)) {
    return { topic: 'encounters', tools: ['get_recent_encounters'], summary: 'Recent encounters:' };
  }
  return {
    topic: 'summary',
    tools: ['get_active_problems', 'get_medications', 'get_allergies', 'get_recent_labs', 'get_vitals', 'get_recent_encounters'],
    summary: 'Chart-state summary:',
  };
}

function topicStub(question: string, cached: CachedTranscript): Answer {
  const spec = detectTopic(question);
  const claims: Claim[] = [];
  let used = 0;
  for (const toolName of spec.tools) {
    const r = cached.toolResults.find(x => x.tool === toolName);
    if (!r) continue;
    if (!r.ok) {
      claims.push({
        text: `${prettify(toolName)}: data unavailable (${r.reason}).`,
        citation_ids: [`rule:tool-error:${toolName}`],
        severity: 'attention',
      });
      continue;
    }
    if (r.rows.length === 0) {
      claims.push({
        text: `${prettify(toolName)}: no records on file.`,
        citation_ids: [`rule:no-data:${toolName}`],
        severity: 'info',
      });
      continue;
    }
    for (const row of r.rows) {
      const text = renderRow(toolName, row);
      if (!text) continue;
      claims.push({ text, citation_ids: citationIdsForRow(row), severity: 'info' });
      used += 1;
      if (used >= MAX_CLAIMS) break;
    }
    if (used >= MAX_CLAIMS) break;
  }
  if (claims.length === 0) {
    claims.push({
      text: 'No structured information available for the requested topic.',
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
    followup_suggestions: ['What changed since last visit?', 'Any drug interactions?', 'Show all active problems.'],
    confidence: 'medium',
  };
}

function prettify(name: string): string {
  return name.replace(/^get_|^check_/, '').replace(/_/g, ' ');
}

function renderRow(tool: string, row: Record<string, unknown>): string | null {
  switch (tool) {
    case 'get_active_problems': {
      const onset = row['onset'] ? ` (onset ${shortDate(row['onset'])})` : '';
      return `${row['condition'] ?? 'unspecified condition'}${onset}.`;
    }
    case 'get_medications': {
      const dose = row['dosage'] ?? (row['dose_mg'] ? `${row['dose_mg']} mg` : null);
      return dose ? `${row['drug_name'] ?? 'unspecified'} — ${dose}.` : `${row['drug_name'] ?? 'unspecified'}.`;
    }
    case 'get_recent_labs':
      return `${row['name'] ?? 'unknown lab'}: ${row['value'] ?? '?'} ${row['unit'] ?? ''} (${shortDate(row['date'])}).`;
    case 'get_vitals':
      return `${row['name'] ?? 'vital'}: ${row['value'] ?? '?'} ${row['unit'] ?? ''} (${shortDate(row['date'])}).`;
    case 'get_allergies':
      return `${row['allergen'] ?? 'unspecified'}${row['reaction'] ? ' — ' + row['reaction'] : ''}.`;
    case 'get_recent_encounters':
      return `${row['type'] ?? row['class'] ?? 'visit'} on ${shortDate(row['start'])}.`;
    case 'check_drug_interactions':
      return `${row['description'] ?? 'see rule'}`;
    default:
      return null;
  }
}

function shortDate(value: unknown): string {
  if (typeof value !== 'string' || value === '') return '?';
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return m ? m[1]! : value;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function extractPatientName(cached: CachedTranscript): PatientName {
  const summary = cached.toolResults.find(r => r.ok && r.tool === 'get_patient_summary');
  if (!summary || !summary.ok || summary.rows.length === 0) {
    return { given: null, family: null };
  }
  const row = summary.rows[0]!;
  const given = typeof row['given_name'] === 'string' ? row['given_name'] : null;
  const family = typeof row['family_name'] === 'string' ? row['family_name'] : null;
  return { given, family };
}

function renderTranscript(toolResults: ToolResult[]): string {
  return toolResults.map(r => {
    if (!r.ok) return `${r.tool}: ERROR (${r.reason})`;
    if (r.rows.length === 0) return `${r.tool}: (no rows)`;
    return `${r.tool}:\n${r.rows.map((row, i) => `  row-${i}: ${JSON.stringify(row)}`).join('\n')}`;
  }).join('\n\n');
}

function collectValidIds(toolResults: ToolResult[]): Set<string> {
  const set = new Set<string>();
  for (const r of toolResults) {
    if (!r.ok) continue;
    for (const row of r.rows) {
      if (typeof row.id === 'string') set.add(row.id);
    }
  }
  return set;
}

function parseAnswer(text: string): Answer | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  // Try the cheapest paths first: pure JSON or a single fenced block.
  const cheapCandidates: string[] = [
    trimmed,
    trimmed.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim(),
  ];
  for (const cand of cheapCandidates) {
    if (cand === '') continue;
    const parsed = tryParse(cand);
    if (parsed) return parsed;
  }
  // Last resort: walk every balanced { ... } substring in the text and try
  // each. Handles "Here is the answer: {x:1} but actually {real: ...}" where
  // the first brace block is decorative and the second is the real answer.
  for (const cand of extractJsonObjects(trimmed)) {
    const parsed = tryParse(cand);
    if (parsed) return parsed;
  }
  return null;
}

function tryParse(text: string): Answer | null {
  try {
    const parsed = AnswerSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through
  }
  return null;
}

/** Yield every balanced top-level { ... } substring in the input. */
function* extractJsonObjects(text: string): Generator<string> {
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('{', i);
    if (start === -1) return;
    const end = findBalancedEnd(text, start);
    if (end === -1) return;
    yield text.slice(start, end + 1);
    i = end + 1;
  }
}

function findBalancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
