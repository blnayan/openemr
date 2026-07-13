/**
 * Supervisor multi-worker integration test (issue 11 acceptance #8).
 *
 * Question: "what changed and what should I pay attention to?"
 *
 * Asserts:
 *   1. The supervisor's accumulated handoffs cover all three workers
 *      (intake_extractor, evidence_retriever, clinical_data) — each
 *      surfacing as an inspectable run name.
 *   2. The final answer parses as AnswerSchema.
 *   3. The final answer cites all three source types (patient_document,
 *      guideline, patient_record).
 *   4. The fail-closed verifier did not drop more than half the claims
 *      (so the answer is the verified composition, not the refusal).
 *
 * Hermetic: every external (LLM, retriever, sidecar reader, FHIR client)
 * is stubbed. The retriever is fed real ADA corpus chunks loaded from
 * `data/corpus/ada-standards-of-care-2026.json` so the verifier's
 * substring check exercises the same body strings the live retriever
 * would surface.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AnswerSchema } from '../../../src/schemas/AnswerSchema.js';
import {
  FhirContextWorker,
  ConflictDetectorWorker,
  IntakeExtractorWorker,
  LabExtractorWorker,
  ClinicalDataWorker,
  SupervisorRouter,
  SupervisorSynthesizer,
  SupervisorVerifier,
  StaticGuidelineCorpusRegistry,
  runSupervisor,
  type RunSupervisorDeps,
  type SidecarReader,
  type ClinicalDataDispatcher,
  type FhirContextDispatcher,
  type PatientDocumentVerifier,
} from '../../../src/graph/supervisor/index.js';
import type {
  SidecarSummaryReader,
  ClinicalDataReachabilityProbe,
} from '../../../src/graph/supervisor/availabilityHint.js';
import { EvidenceRetrieverWorker } from '../../../src/graph/workers/EvidenceRetrieverWorker.js';
import type { LlmInvoker, ChatMessage, ChatResponse } from '../../../src/llm/AgentLlmClient.js';
import type { Retriever, RankedChunk, Chunk } from '../../../src/retrieval/types.js';
import type { ToolResult } from '../../../src/tools/types.js';
import type { IntakeForm } from '../../../src/schemas/IntakeFormSchema.js';

// ---------------------------------------------------------------------------
// ADA corpus loader — mirrors scripts/ingest-guidelines.ts so the chunk
// ids the integration test fabricates are the same shape the live
// retriever would emit.
// ---------------------------------------------------------------------------

interface CorpusFile {
  readonly source: string;
  readonly chunks: ReadonlyArray<{
    readonly section_id: string;
    readonly page: number;
    readonly body: string;
    readonly grade?: 'A' | 'B' | 'C' | 'E';
    readonly source_url?: string;
  }>;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function loadAdaChunks(): readonly Chunk[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const corpusPath = join(here, '..', '..', '..', 'data', 'corpus', 'ada-standards-of-care-2026.json');
  const json = JSON.parse(readFileSync(corpusPath, 'utf8')) as CorpusFile;
  const sourceSlug = slugify(json.source);
  const seen = new Map<string, number>();
  return json.chunks.map(c => {
    const key = `${sourceSlug}::${c.section_id}`;
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    const chapter = c.section_id.split('.', 1)[0] ?? '';
    const chapterPad = chapter.padStart(2, '0');
    const id = `${sourceSlug}::ch-${chapterPad}::${c.section_id}::${ordinal}`;
    return {
      id,
      source: json.source,
      section_id: c.section_id,
      page: c.page,
      body: c.body,
      ...(c.grade !== undefined ? { grade: c.grade } : {}),
      ...(c.source_url !== undefined ? { source_url: c.source_url } : {}),
    };
  });
}

function pickChunk(corpus: readonly Chunk[], sectionId: string): Chunk {
  const c = corpus.find(x => x.section_id === sectionId);
  if (!c) throw new Error(`section_id ${sectionId} missing from corpus`);
  return c;
}

function rerankChunks(corpus: readonly Chunk[], sectionIds: readonly string[]): RankedChunk[] {
  return sectionIds.map((sid, i) => {
    const c = pickChunk(corpus, sid);
    return {
      id: c.id,
      source: c.source,
      section_id: c.section_id,
      page: c.page,
      body: c.body,
      score: 1 - i * 0.05,
      ...(c.grade !== undefined ? { grade: c.grade } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Stub builders
// ---------------------------------------------------------------------------

const SAMPLE_BBOX = { x: 10, y: 20, w: 100, h: 30, page: 1, image_w: 1000, image_h: 1300 };

function makeIntakeForm(): IntakeForm {
  return {
    doc_type: 'intake_form',
    schema_version: '1',
    demographics: {
      name: 'Test Patient',
      dob: '1968-04-15',
      sex: 'F',
      bbox_per_field: { name: SAMPLE_BBOX, dob: SAMPLE_BBOX },
    },
    chief_concern: { text: 'morning fatigue', bbox: SAMPLE_BBOX },
    current_medications: [
      {
        name: 'metformin',
        dose: '500 mg',
        frequency: 'twice daily',
        route: 'po',
        is_otc_or_supplement: false,
        bbox: SAMPLE_BBOX,
      },
    ],
    allergies: [],
    family_history: [],
    source_citation: { document_id: 'doc-42', page_count: 2 },
  };
}

function makeStubSidecarReader(extractionId: string): SidecarReader {
  return {
    async readLatest(input) {
      if (input.docType === 'intake_form') {
        return {
          extractionId,
          extractedJson: makeIntakeForm(),
          documentId: null,
          documentName: null,
        };
      }
      return null;
    },
  };
}

function makeStubSidecarSummaryReader(extractionId: string): SidecarSummaryReader {
  return {
    async listForPatient() {
      return [{
        extraction_id: extractionId,
        doc_type: 'intake_form' as const,
        patient_match_status: 'verified' as const,
        created_at: '2026-05-01 10:00:00',
      }];
    },
  };
}

function makeStubClinicalDispatcher(): ClinicalDataDispatcher {
  return {
    async run() {
      const toolResults: readonly ToolResult[] = [
        {
          ok: true,
          tool: 'get_recent_labs',
          rows: [
            { id: 'tool:get_recent_labs:row-0', loinc: '4548-4', value: 7.4, unit: '%', date: '2026-04-01' },
          ],
        },
      ];
      return {
        answer: {
          summary: 'Recent A1C 7.4%; metformin only active medication.',
          claims: [{
            text: 'Most recent A1C is 7.4% (2026-04-01).',
            citation_ids: ['tool:get_recent_labs:row-0'],
            severity: 'info' as const,
          }],
          conflicts: [],
          data_gaps: [],
          assumptions: [],
          evidence_catalog: [],
          followup_suggestions: [],
          confidence: 'high' as const,
        },
        toolResults,
      };
    },
  };
}

function makeStubReachabilityProbe(): ClinicalDataReachabilityProbe {
  return { isReachable: async () => true };
}

function makeStubPatientDocumentVerifier(extractionId: string): PatientDocumentVerifier {
  return {
    async exists(input) {
      return input.extractionId === extractionId;
    },
  };
}

// Sequential-response stub LLM. Each `chat()` call advances through a
// fixed list of canned responses keyed by their order; this matches the
// supervisor's deterministic tick sequence (router → router → router →
// router → synthesizer).
function makeSequentialStubLlm(responses: readonly string[]): LlmInvoker {
  let i = 0;
  return {
    chat: async (_messages: ChatMessage[]): Promise<ChatResponse> => {
      const r = responses[i] ?? responses[responses.length - 1] ?? '';
      i += 1;
      return { content: r, toolCalls: [] };
    },
    chatWithTools: async (): Promise<ChatResponse> => ({ content: '', toolCalls: [] }),
  };
}

function makeStubRetriever(chunks: readonly RankedChunk[]): Retriever {
  return { retrieve: async () => chunks };
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

describe('supervisor multi-worker integration', () => {
  beforeAll(() => {
    // Keep test env explicit for parity with integration runtime env.
    if (!process.env['AGENTFORGE_PHI_REDACTION_SALT']) {
      process.env['AGENTFORGE_PHI_REDACTION_SALT'] = 'integration-test-salt';
    }
  });

  it('routes through all three workers and produces an answer citing all three source types', async () => {
    const corpus = loadAdaChunks();
    const targetChunk = pickChunk(corpus, '6.3a');
    expect(targetChunk.body).toContain('An A1C goal of <7%');

    const ranked = rerankChunks(corpus, ['6.3a', '6.3b', '6.4']);
    const extractionId = 'extract-77';

    // The synthesizer must produce an answer with claims that cite all
    // three source types so the verifier can prove its multi-source
    // resolution. quoted_span is verbatim from targetChunk.body so the
    // guideline verifier keeps the claim.
    const synthesizedAnswer = {
      summary:
        'Reviewed self-reported intake, recent labs, and ADA guidance: A1C is on target; '
        + 'self-reported metformin is the only active medication.',
      claims: [
        {
          text:
            'Patient self-reports metformin as their only active medication on the intake form.',
          citation_ids: ['rule:patient:self-reported-meds'],
          citations: [{
            type: 'patient_document',
            extraction_id: extractionId,
            bbox: SAMPLE_BBOX,
            citation_confidence: 0.92,
          }],
          severity: 'info',
        },
        {
          text: 'Most recent A1C is 7.4% (2026-04-01).',
          citation_ids: ['tool:get_recent_labs:row-0'],
          severity: 'info',
        },
        {
          text:
            'For many nonpregnant adults without severe hypoglycemia, the ADA recommends an A1C goal of <7% (53 mmol/mol).',
          citation_ids: ['rule:guideline:ada-2026-6-3a'],
          citations: [{
            type: 'guideline',
            chunk_id: targetChunk.id,
            source: targetChunk.source,
            section_id: targetChunk.section_id,
            quoted_span: 'An A1C goal of <7% (<53 mmol/mol) is appropriate for many nonpregnant adults',
          }],
          severity: 'info',
        },
      ],
      conflicts: [],
      data_gaps: [],
      assumptions: [],
      evidence_catalog: [],
      followup_suggestions: ['Confirm adherence to metformin.'],
      confidence: 'high',
    };

    const stubLlm = makeSequentialStubLlm([
      // Tick 1: route to fhir_context.
      JSON.stringify({
        next_action: 'call_worker',
        worker: 'fhir_context',
        reason: 'collect chart context snapshot',
      }),
      // Tick 2: fan out three independent evidence workers in parallel.
      JSON.stringify({
        next_action: 'call_workers',
        workers: ['intake_extractor', 'evidence_retriever', 'clinical_data'],
        reason: 'gather independent evidence surfaces concurrently',
      }),
      // Tick 3 — Synthesizer call.
      JSON.stringify(synthesizedAnswer),
    ]);

    const fhirContextDispatcher: FhirContextDispatcher = {
      async run() {
        return {
          hasPatientSummary: true,
          activeProblemsCount: 2,
          activeMedsCount: 1,
          recentLabsCount: 3,
          recentVitalsCount: 2,
          allergiesCount: 1,
          recentEncountersCount: 2,
          anchors: ['Maria Chen'],
        };
      },
    };
    const fhirContext = new FhirContextWorker(fhirContextDispatcher);
    const router = new SupervisorRouter(stubLlm);
    const intakeExtractor = new IntakeExtractorWorker(makeStubSidecarReader(extractionId));
    // Lab extractor wired to a sidecar reader that returns null for
    // lab_pdf — this test exercises only the intake/evidence/clinical
    // path; the lab worker is included so RunSupervisorDeps is complete.
    const labExtractor = new LabExtractorWorker({
      readLatest: async () => null,
    });
    const evidenceRetriever = new EvidenceRetrieverWorker(makeStubRetriever(ranked));
    const clinicalData = new ClinicalDataWorker(makeStubClinicalDispatcher());
    const conflictDetector = new ConflictDetectorWorker();
    const synthesizer = new SupervisorSynthesizer(stubLlm);
    const verifier = new SupervisorVerifier({
      patientDocumentVerifier: makeStubPatientDocumentVerifier(extractionId),
    });

    const deps: RunSupervisorDeps = {
      router,
      fhirContext,
      intakeExtractor,
      labExtractor,
      evidenceRetriever,
      clinicalData,
      conflictDetector,
      synthesizer,
      verifier,
      sidecarSummaryReader: makeStubSidecarSummaryReader(extractionId),
      clinicalDataProbe: makeStubReachabilityProbe(),
      corpusRegistry: new StaticGuidelineCorpusRegistry([{
        source: 'ADA Standards of Care in Diabetes—2026',
        version: '2026',
        chunk_count: corpus.length,
      }]),
    };

    const result = await runSupervisor(
      { question: 'what changed and what should I pay attention to?', pid: 42, conversationId: 'conv-1' },
      deps,
    );

    // 1. Handoff sequence covers the expanded worker graph.
    const workerSequence = result.handoffs.map(h => h.worker);
    expect(workerSequence).toEqual([
      'fhir_context',
      'intake_extractor',
      'evidence_retriever',
      'clinical_data',
      'conflict_detector',
    ]);

    // 2. Final answer parses as AnswerSchema.
    const parsed = AnswerSchema.safeParse(result.answer);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('answer did not parse');

    // 3. Final answer cites all three source types.
    const citationTypes = new Set<string>();
    for (const claim of parsed.data.claims) {
      for (const cit of claim.citations ?? []) {
        citationTypes.add(cit.type);
      }
      // patient_record citations live on citation_ids in the legacy form.
      for (const cid of claim.citation_ids) {
        if (cid.startsWith('tool:')) citationTypes.add('patient_record');
      }
    }
    expect(citationTypes).toContain('patient_document');
    expect(citationTypes).toContain('guideline');
    expect(citationTypes).toContain('patient_record');

    // 4. Verifier did not drop more than half the claims (no refusal).
    const totalClaimsDrafted = synthesizedAnswer.claims.length;
    expect(result.droppedClaims * 2).toBeLessThanOrEqual(totalClaimsDrafted);
    expect(parsed.data.summary).not.toContain('Refusing rather than presenting');
  });
});
