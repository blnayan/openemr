/**
 * POST /chat — agent entry point. Two flows:
 *
 *   mode=previsit   → fan-out FHIR, compute encounter delta, single LLM call,
 *                     cache the transcript so follow-ups can reuse it.
 *   mode=followup   → reuse cached transcript; LLM may call additional tools
 *                     via native tool calling.
 *
 * SSE event sequence:
 *   conversation → evidence_catalog → summary → claim*
 *   → confidence → done
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FhirClient } from '../fhir/FhirClient.js';
import { OpenEmrTokenProvider } from '../fhir/OpenEmrTokenProvider.js';
import { runPrevisit, type PrevisitResult } from '../graph/runPrevisit.js';
import { LabPdfSchema } from '../schemas/LabPdfSchema.js';
import { IntakeFormSchema } from '../schemas/IntakeFormSchema.js';
import { runFollowup } from '../graph/runFollowup.js';
import type { ConversationRepository } from '../db/ConversationRepository.js';
import type { ConversationCache } from '../db/ConversationCache.js';
import { AgentLlmClient, type LlmInvoker } from '../llm/AgentLlmClient.js';
import type { Answer, Claim } from '../schemas/AnswerSchema.js';
import type { ToolContext, ToolResult } from '../tools/types.js';
import { SidecarOriginLookup } from '../tools/SidecarOriginLookup.js';
import type { EncounterDiff } from '../clinical/EncounterDiff.js';
import type { Retriever } from '../retrieval/types.js';
import { runSupervisor, type RunSupervisorDeps } from '../graph/supervisor/index.js';
import { buildSupervisorDeps } from '../bootstrap/buildSupervisorDeps.js';
import { SidecarHttpClient } from '../graph/supervisor/SidecarHttpClient.js';
import { classifyOutOfScope, type PatientName } from '../graph/nodes/refusalRouter.js';
import type { GuidelineCorpusSummary } from '../graph/supervisor/types.js';
import {
  evidenceRefsForCitationIds,
  materializeEvidenceCatalogForAnswer,
  type SidecarDocResolver,
} from '../streaming/evidenceCatalog.js';
import type {
  AccumulatedHandoff,
  ConflictItem,
  IntakeExtractorOutput,
  LabExtractorOutput,
  SidecarReader,
} from '../graph/supervisor/types.js';
import {
  PhiSetBuilder,
  withPhiContext,
  withRequestTraceContext,
} from '../observability/index.js';

const ChatRequestSchema = z.object({
  question: z.string().min(1).max(4000),
  conversation_id: z.string().uuid().nullable().optional(),
  encounter_id: z.number().int().positive().nullable().optional(),
  mode: z.enum(['previsit', 'followup']).optional(),
});

export interface ChatRouteOptions {
  repository: ConversationRepository;
  cache: ConversationCache;
  fhirBaseUrl: string;
  tokenProvider?: OpenEmrTokenProvider;
  tlsInsecure?: boolean;
  /** Optional LLM client for tests; falls back to env-loaded ChatOpenAI. */
  llmClient?: LlmInvoker | null;
  /**
   * Optional hybrid retriever for the guideline-grounded path. When
   * unset, the router falls back to the Week 1 clinical-data path even
   * for guideline-shaped questions. Reused by the supervisor's
   * evidence-retriever worker when supervisorDeps is wired.
   */
  retriever?: Retriever | null;
  /**
   * Optional pre-built RunSupervisorDeps. When provided, every followup
   * question routes through the Pattern A supervisor (issue 11) instead
   * of the Week 1 graph. When omitted (e.g. tests that don't inject it,
   * or production environments where the supervisor wiring is gated by
   * an env flag), the chat route falls back to the Week 1 followup
   * path so existing behavior is preserved.
   */
  supervisorDeps?: RunSupervisorDeps | null;
}

export function registerChatRoute(app: FastifyInstance, opts: ChatRouteOptions): void {
  app.post('/chat', async (request, reply) => {
    const parsed = ChatRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({
        error: 'invalid_body',
        issues: parsed.error.issues.map(i => ({
          path: i.path.map(String).join('.'),
          message: i.message,
        })),
      });
      return;
    }
    const body = parsed.data;
    const claims = request.jwtClaims;
    const mode = body.mode ?? 'followup';

    // FHIR token: prefer the OAuth token (production) over the inbound JWT.
    const fhirJwt = opts.tokenProvider?.isConfigured()
      ? await opts.tokenProvider.getToken()
      : extractBearer(request.headers.authorization);

    const fhirClient = new FhirClient({
      baseUrl: opts.fhirBaseUrl,
      jwt: fhirJwt,
      tlsInsecure: opts.tlsInsecure ?? false,
    });
    const phiSet = await new PhiSetBuilder({ fhirClient })
      .fromPatientUuid(claims.patient_uuid);

    // SidecarOriginLookup hits OpenEMR's PHP sidecar with the inbound
    // chat JWT (the same token that authorized this request). It resolves
    // chart-row UUIDs back to the uploaded PDF/PNG they originated from
    // so tools can attribute citations like "(from p01-chen.pdf)". Best
    // effort — failures degrade silently to "unknown origin."
    const inboundJwt = extractBearer(request.headers.authorization);
    const openemrBaseUrlForSidecar = deriveOpenemrBaseUrl(opts.fhirBaseUrl);
    const originLookup = inboundJwt
      ? new SidecarOriginLookup({
        baseUrl: openemrBaseUrlForSidecar,
        jwt: inboundJwt,
        pid: claims.pid,
      })
      : undefined;
    // Sidecar reader for previsit/legacy-followup paths so they can
    // surface lab/intake bbox decorations on chips. The supervisor
    // path builds its own SidecarHttpClient via buildSupervisorDeps.
    const previsitSidecar: SidecarReader | null = inboundJwt
      ? new SidecarHttpClient({
        baseUrl: openemrBaseUrlForSidecar,
        jwt: inboundJwt,
        tlsInsecure: opts.tlsInsecure ?? false,
      })
      : null;

    const toolContext: ToolContext = {
      patientUuid: claims.patient_uuid,
      pid: claims.pid,
      jwt: fhirJwt,
      fhirClient,
      ...(originLookup ? { originLookup } : {}),
    };

    // Resolve LLM. Pre-visit defaults to NO LLM (sub-second deterministic
    // answer that already includes baseline highlights and deltas). Set
    // AGENTFORGE_PREVISIT_USE_LLM=1 to opt into an LLM-polished summary
    // (~5-7 s). Follow-ups always use the reasoning model.
    let llm: LlmInvoker | null;
    if (opts.llmClient !== undefined) {
      llm = opts.llmClient;
    } else if (mode === 'previsit') {
      const useLlm = process.env['AGENTFORGE_PREVISIT_USE_LLM'] === '1';
      if (useLlm) {
        // Default to the same Haiku slug used elsewhere; override via
        // AGENTFORGE_PREVISIT_MODEL with any OpenRouter slug.
        const fastModel = process.env['AGENTFORGE_PREVISIT_MODEL'] ?? 'anthropic/claude-haiku-4.5';
        llm = await AgentLlmClient.fromEnv(process.env, fastModel);
      } else {
        llm = null;
      }
    } else {
      llm = await AgentLlmClient.fromEnv();
    }

    // Optional synthesizer-only model override (e.g. Sonnet for stricter
    // instruction-following while the cheaper Haiku handles routing and
    // worker dispatch). Falls back to the main `llm` when unset.
    let synthesizerLlm: LlmInvoker | null = null;
    if (llm !== null && mode !== 'previsit') {
      const synthModel = process.env['AGENTFORGE_SYNTHESIZER_MODEL'];
      if (synthModel && synthModel !== process.env['AGENTFORGE_MODEL']) {
        synthesizerLlm = await AgentLlmClient.fromEnv(process.env, synthModel);
      }
    }

    // Get-or-create conversation id. If the client supplied an id we
    // don't recognize for this (user, pid) — common after the agent
    // restarts and the in-memory store is empty, but the browser still
    // has the old id in sessionStorage — silently mint a fresh one
    // instead of letting appendMessage throw `conversation_not_found`
    // mid-stream.
    let conversationId: string;
    if (body.conversation_id) {
      const known = await opts.repository.exists(
        body.conversation_id,
        claims.sub,
        claims.pid,
      );
      conversationId = known
        ? body.conversation_id
        : await opts.repository.create({
            userId: claims.sub,
            encounterId: claims.encounter_id,
            pid: claims.pid,
          });
    } else {
      conversationId = await opts.repository.create({
        userId: claims.sub,
        encounterId: claims.encounter_id,
        pid: claims.pid,
      });
    }

    // Open the SSE stream now that all pre-stream resolution is done.
    // Any error from this point on must NOT propagate up to Fastify's
    // error handler (which would call reply.send() and trip
    // ERR_HTTP_HEADERS_SENT, crashing the Node process); instead we
    // emit an SSE `error` event and end the stream cleanly. See the
    // catch at the bottom of this handler.
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    try {

    if (mode === 'previsit') {
      // Pre-visit pull uses a fast LLM (anthropic/claude-haiku-4.5 by
      // default, via OpenRouter) on a shrunk prompt that only includes the
      // encounter-delta items, not the full transcript. Target: <5 s
      // end-to-end. Falls back to the deterministic stub on LLM error or
      // schema mismatch.
      const t0 = Date.now();
      const previsit = await withPhiContext(
        phiSet,
        () => withRequestTraceContext(
          {
            name: 'chat.previsit',
            userId: claims.sub,
            sessionId: claims.session_id || conversationId,
            tags: ['agentforge', 'chat', 'previsit'],
            metadata: { route: '/chat', mode: 'previsit' },
            input: {
              question: body.question,
              conversation_id: conversationId,
              mode: 'previsit',
            },
          },
          () => runPrevisit(toolContext, llm, previsitSidecar),
        ),
      );
      // eslint-disable-next-line no-console
      console.log('[agentforge.previsit] complete', {
        elapsed_ms: Date.now() - t0,
        llm_driven: previsit.llmDriven,
      });
      opts.cache.set(conversationId, {
        pid: claims.pid,
        patientUuid: claims.patient_uuid,
        toolResults: previsit.toolResults,
        diff: previsit.diff,
        previsitSummary: previsit.answer.summary,
      });
      await opts.repository.appendMessage(conversationId, 'user', body.question);
      await opts.repository.appendMessage(
        conversationId,
        'assistant',
        previsit.answer.summary,
        buildPrevisitPayload(previsit),
      );
      streamPrevisitSections(reply, conversationId, previsit);
      reply.raw.end();
      return;
    }

    // Pattern A supervisor path (issue 11). When the supervisor deps
    // have been wired through, every followup question goes through the
    // multi-agent graph (intake-extractor + evidence-retriever +
    // clinical-data + synthesize + verify). The supervisor itself
    // decides which workers to dispatch based on the availability hint;
    // questions that route to clinical-data alone produce Week-1-equivalent
    // answers. When supervisorDeps is omitted (tests that don't inject
    // it, or production environments where live wiring is gated by an
    // env flag), the chat route falls through to the Week 1 followup
    // path below so existing behavior is preserved.
    //
    // Production wiring (issue 18): when the server-wide retriever +
    // llmClient are present and supervisorDeps was NOT explicitly
    // injected by a caller, build a per-request RunSupervisorDeps so
    // the live evidence-retriever path runs through Pinecone for
    // guideline-shaped questions.
    let liveSupervisorDeps: RunSupervisorDeps | null = opts.supervisorDeps ?? null;
    if (
      liveSupervisorDeps === null
      && mode === 'followup'
      && opts.retriever
      && llm
      && process.env['AGENTFORGE_SUPERVISOR_ENABLED'] !== '0'
    ) {
      // Need a cache for the clinical-data dispatcher. The dispatcher
      // calls runFollowup which requires the cached transcript.
      let cachedForSup = opts.cache.get(conversationId);
      if (!cachedForSup) {
        const previsit = await runPrevisit(toolContext, llm, previsitSidecar);
        cachedForSup = {
          pid: claims.pid,
          patientUuid: claims.patient_uuid,
          toolResults: previsit.toolResults,
          diff: previsit.diff,
          previsitSummary: previsit.answer.summary,
          createdAt: Date.now(),
          lastTouched: Date.now(),
        };
        opts.cache.set(conversationId, cachedForSup);
      }
      const priorMessagesForSup = await opts.repository.load(conversationId, claims.sub, claims.pid);
      const corpora: GuidelineCorpusSummary[] = [{
        source: 'ADA Standards of Care in Diabetes—2026',
        version: '2026',
        chunk_count: 515,
      }];
      const openemrBaseUrl = deriveOpenemrBaseUrl(opts.fhirBaseUrl);
      liveSupervisorDeps = buildSupervisorDeps({
        llm,
        ...(synthesizerLlm ? { synthesizerLlm } : {}),
        retriever: opts.retriever,
        corpora,
        request: {
          chatJwt: inboundJwt,
          openemrBaseUrl,
          tlsInsecure: opts.tlsInsecure ?? false,
          toolContext,
          cached: cachedForSup,
          priorMessages: priorMessagesForSup,
        },
      });
    }

    if (mode === 'followup' && liveSupervisorDeps) {
      // Out-of-scope guard. Same deterministic classifier the W1
      // followup path uses, hoisted ahead of the supervisor so a
      // refusal-shaped question never gets a chance to retrieve, fan
      // out tools, or hit the corpus. The classifier is regex-only —
      // no LLM call, can't itself hallucinate a refusal.
      //
      // Reach back into the cache for the pre-visit transcript: the
      // surrounding `if (mode === 'followup' && supervisor enabled)`
      // block above always populates it, so the get() can't return
      // undefined here. Defensive empty toolResults if it somehow does.
      const cachedForRefusal = opts.cache.get(conversationId);
      const refusal = classifyOutOfScope(
        body.question,
        extractPatientName({ toolResults: cachedForRefusal?.toolResults ?? [] }),
      );
      if (refusal !== null) {
        const refusalAnswer: Answer = {
          summary: refusal.message,
          claims: [],
          conflicts: [],
          data_gaps: [],
          assumptions: [],
          evidence_catalog: [],
          followup_suggestions: [],
          confidence: 'high',
        };
        const refusalToolResults = cachedForRefusal?.toolResults ?? [];
        const supervisorSignals = { conflicts: [] as readonly ConflictItem[] };
        await opts.repository.appendMessage(conversationId, 'user', body.question);
        await opts.repository.appendMessage(
          conversationId,
          'assistant',
          refusalAnswer.summary,
          buildFollowupPayload(refusalAnswer, null, true, refusalToolResults, supervisorSignals),
        );
        streamAnswer(reply, conversationId, refusalAnswer, null, true, 0, refusalToolResults, supervisorSignals);
        reply.raw.end();
        // eslint-disable-next-line no-console
        console.log('[agentforge.supervisor] refused before invoke', {
          conversation_id: conversationId,
          reason: refusal.reason,
        });
        return;
      }

      const t0 = Date.now();
      const supervised = await withPhiContext(
        phiSet,
        () => withRequestTraceContext(
          {
            name: 'chat.followup.supervisor',
            userId: claims.sub,
            sessionId: claims.session_id || conversationId,
            tags: ['agentforge', 'chat', 'followup', 'supervisor'],
            metadata: { route: '/chat', mode: 'followup' },
            input: {
              question: body.question,
              conversation_id: conversationId,
              mode: 'followup',
            },
          },
          () => runSupervisor(
            {
              question: body.question,
              pid: claims.pid,
              conversationId,
            },
            liveSupervisorDeps,
          ),
        ),
      );
      // eslint-disable-next-line no-console
      console.log('[agentforge.supervisor] complete', {
        conversation_id: conversationId,
        elapsed_ms: Date.now() - t0,
        handoffs: supervised.handoffs.length,
        dropped_claims: supervised.droppedClaims,
        confidence: supervised.answer.confidence,
        worker_sequence: supervised.handoffs.map(h => h.worker),
      });
      // Sidecar resolver: prefer supervisor handoffs (the routed workers
      // may have already parsed them); fall back to a fresh sidecar fetch
      // so chart-row-attribution chips still get bboxes when the
      // supervisor didn't route to the lab/intake extractors for this
      // turn.
      let supSidecar = extractSidecarResolver(supervised.handoffs);
      let supSidecarDocs = extractSidecarDocs(supervised.handoffs);
      if ((supSidecar === null || supSidecarDocs === null) && previsitSidecar !== null) {
        const fresh = await readSidecarForChatFallback(previsitSidecar, claims.pid);
        if (supSidecar === null) supSidecar = fresh.resolver;
        if (supSidecarDocs === null) supSidecarDocs = fresh.docs;
      }
      await opts.repository.appendMessage(conversationId, 'user', body.question);
      await opts.repository.appendMessage(
        conversationId,
        'assistant',
        supervised.answer.summary,
        buildFollowupPayload(
          supervised.answer,
          null,
          true,
          opts.cache.get(conversationId)?.toolResults ?? [],
          extractSupervisorSignals(supervised.handoffs),
          supSidecar,
          supSidecarDocs,
        ),
      );
      streamAnswer(
        reply,
        conversationId,
        supervised.answer,
        null,
        true,
        0,
        opts.cache.get(conversationId)?.toolResults ?? [],
        extractSupervisorSignals(supervised.handoffs),
        supSidecar,
        supSidecarDocs,
      );
      reply.raw.end();
      return;
    }

    // followup mode
    let cached = opts.cache.get(conversationId);
    if (!cached) {
      // Cache miss — re-run the pre-visit fan-out so we have something to ground on.
      const previsit = await runPrevisit(toolContext, llm, previsitSidecar);
      cached = {
        pid: claims.pid,
        patientUuid: claims.patient_uuid,
        toolResults: previsit.toolResults,
        diff: previsit.diff,
        previsitSummary: previsit.answer.summary,
        createdAt: Date.now(),
        lastTouched: Date.now(),
      };
      opts.cache.set(conversationId, cached);
    }

    // Load prior turns BEFORE appending the current question so the
    // history fed to the LLM excludes the in-flight question. Patient
    // context (pid) is enforced at the repository layer so a foreign
    // conversation_id resolves to an empty history rather than leaking
    // another patient's transcript.
    const priorMessages = await opts.repository.load(conversationId, claims.sub, claims.pid);

    const followup = await withPhiContext(
      phiSet,
      () => withRequestTraceContext(
        {
          name: 'chat.followup',
          userId: claims.sub,
          sessionId: claims.session_id || conversationId,
          tags: ['agentforge', 'chat', 'followup'],
          metadata: { route: '/chat', mode: 'followup' },
          input: {
            question: body.question,
            conversation_id: conversationId,
            mode: 'followup',
          },
        },
        () => runFollowup(body.question, cached, toolContext, llm, priorMessages),
      ),
    );
    // Refresh cache with any newly-fetched tool results.
    if (followup.newToolResults.length > 0) {
      opts.cache.set(conversationId, {
        ...cached,
        toolResults: followup.toolResults,
      });
    }
    // eslint-disable-next-line no-console
    console.log('[agentforge.followup] complete', {
      conversation_id: conversationId,
      prior_message_count: followup.priorMessageCount,
      llm_driven: followup.llmDriven,
    });
    await opts.repository.appendMessage(conversationId, 'user', body.question);
    await opts.repository.appendMessage(
      conversationId,
      'assistant',
      followup.answer.summary,
      buildFollowupPayload(followup.answer, cached.diff, followup.llmDriven, followup.toolResults),
    );
    streamAnswer(
      reply,
      conversationId,
      followup.answer,
      cached.diff,
      followup.llmDriven,
      followup.priorMessageCount,
      followup.toolResults,
      null,
    );
    reply.raw.end();

    } catch (err) {
      // Post-writeHead failure path. We can't reply.send() because the
      // SSE headers are already on the wire and Fastify's error handler
      // would trip ERR_HTTP_HEADERS_SENT and crash the process. Instead
      // emit an `error` SSE event the client can render and close the
      // stream cleanly. The browser's `agent_unavailable` UI handles
      // this reason verbatim.
      // eslint-disable-next-line no-console
      console.error('[agentforge.chat] stream failed', {
        conversation_id: conversationId,
        error: err instanceof Error ? err.message : String(err),
        cause: err instanceof Error ? (err as { cause?: unknown }).cause : undefined,
        stack: err instanceof Error ? err.stack : undefined,
      });
      try {
        reply.raw.write('event: error\n');
        reply.raw.write(`data: ${JSON.stringify({ reason: 'agent_internal_error' })}\n\n`);
      } catch { /* socket already closed — nothing we can do */ }
      try { reply.raw.end(); } catch { /* idem */ }
    }
  });
}

/**
 * Per-pointer bbox map drawn from the claim's rich `patient_document`
 * citations. The downstream Co-Pilot dock uses this to drive the
 * click-to-open modal: the user clicks a `Lab · …` / `Intake · …` chip,
 * the dock looks up `citation_bboxes[pointer]`, and renders that bbox
 * overlay on the source PDF/image.
 *
 * Only `patient_document` rich citations contribute — guideline and
 * patient_record citations don't carry a bbox. Pointers that have no
 * matching rich citation (e.g. the secondary `doc:lab-<source.document_id>`
 * attached to a chart-row claim) are intentionally absent so the chip
 * falls back to "open at page 1, no highlight".
 */
function bboxesForClaim(
  claim: Claim,
  sidecar: SidecarDocResolver | null,
  sidecarDocs: PrevisitSidecarDocs | null = null,
): Record<string, {
  page: number; x: number; y: number; w: number; h: number; image_w: number; image_h: number;
}> {
  const out: Record<string, {
    page: number; x: number; y: number; w: number; h: number; image_w: number; image_h: number;
  }> = {};
  if (!claim.citations) return out;
  for (const cit of claim.citations) {
    if (cit.type !== 'patient_document') continue;
    const bbox = cit.bbox;
    // Synthesizer drift recovery — Sonnet occasionally drops image_w /
    // image_h from rich `patient_document` citations (the BboxSchema
    // defaults them to 0, so it parses but the modal can't scale). When
    // the kind matches a known sidecar payload, borrow that doc's
    // canonical image dims from the first bbox we find on it. Same
    // PDF → same VLM rasterization → same image_w/image_h on every
    // bbox, so any one will do.
    let imageW = bbox.image_w;
    let imageH = bbox.image_h;
    if ((imageW <= 0 || imageH <= 0) && sidecarDocs !== null) {
      const docKindForCit = sidecar && sidecar.lab && sidecar.lab.extractionId === cit.extraction_id ? 'lab'
        : sidecar && sidecar.intake && sidecar.intake.extractionId === cit.extraction_id ? 'intake'
        : null;
      const fallback = docKindForCit === 'lab' ? sidecarDocs.lab : docKindForCit === 'intake' ? sidecarDocs.intake : null;
      if (fallback) {
        const dims = readImageDimsFromPayload(fallback.payload);
        if (dims) {
          imageW = imageW > 0 ? imageW : dims.image_w;
          imageH = imageH > 0 ? imageH : dims.image_h;
        }
      }
    }
    // Match the rich citation's extraction_id back to the legacy pointer.
    // The synthesizer emits `doc:<kind>-<extraction_id>` for sidecar
    // citations, so the canonical match is suffix === extraction_id.
    // We additionally allow the resolver's documentId fallback so the
    // chart-row attribution path (where pointer suffix === documents.id)
    // can pick up the bbox if the LLM happened to emit a rich citation
    // there too.
    const candidates: string[] = [];
    candidates.push(`doc:lab-${cit.extraction_id}`);
    candidates.push(`doc:intake-${cit.extraction_id}`);
    if (sidecar?.lab && sidecar.lab.documentId !== null && sidecar.lab.extractionId === cit.extraction_id) {
      candidates.push(`doc:lab-${sidecar.lab.documentId}`);
    }
    if (sidecar?.intake && sidecar.intake.documentId !== null && sidecar.intake.extractionId === cit.extraction_id) {
      candidates.push(`doc:intake-${sidecar.intake.documentId}`);
    }
    for (const pointer of candidates) {
      if (claim.citation_ids.includes(pointer)) {
        out[pointer] = {
          page: bbox.page,
          x: bbox.x,
          y: bbox.y,
          w: bbox.w,
          h: bbox.h,
          image_w: imageW,
          image_h: imageH,
        };
      }
    }
  }
  return out;
}

/**
 * Deterministic per-pointer bbox augmentation drawn from the latest
 * lab/intake sidecar payloads. Used by the previsit pipeline (whose
 * claims are built from FHIR rows, NOT the LLM synthesizer) so chips
 * still know which page + region to highlight when the user clicks
 * them. We match by the row's natural-language key:
 *
 *   - get_medications row.drug_name → intakeForm.current_medications[i].name
 *   - get_allergies   row.allergen   → intakeForm.allergies[i].substance
 *   - get_recent_labs row.test_name  → labPdf.results[i].test_name
 *
 * Match is name-equality after lowercasing + collapsing whitespace and
 * stripping trailing dose/strength tokens — defensive against the
 * "Lisinopril 10 MG Oral Tablet" vs "Lisinopril" naming gap between
 * FHIR MedicationRequest text and the intake form's free-text entry.
 */
/**
 * Walk a lab/intake sidecar payload for any bbox with non-zero
 * dimensions and return its image_w / image_h. The sidecar VLM extracts
 * a single rasterization per page so every bbox shares the same image
 * dims; we only need to find one. Returns null if the payload has no
 * usable bbox at all (defensive — shouldn't happen in practice).
 */
function readImageDimsFromPayload(
  payload:
    | import('../schemas/IntakeFormSchema.js').IntakeForm
    | import('../schemas/LabPdfSchema.js').LabPdf,
): { image_w: number; image_h: number } | null {
  // IntakeForm bboxes
  if ('current_medications' in payload) {
    const candidates = [
      ...payload.current_medications.map(m => m.bbox),
      ...payload.allergies.map(a => a.bbox),
      ...payload.family_history.map(f => f.bbox),
      ...(payload.chief_concern ? [payload.chief_concern.bbox] : []),
    ];
    for (const b of candidates) {
      if (b.image_w > 0 && b.image_h > 0) {
        return { image_w: b.image_w, image_h: b.image_h };
      }
    }
  }
  // LabPdf bboxes
  if ('results' in payload && Array.isArray(payload.results)) {
    for (const r of payload.results) {
      const b = (r as { bbox?: { image_w: number; image_h: number } }).bbox;
      if (b && b.image_w > 0 && b.image_h > 0) {
        return { image_w: b.image_w, image_h: b.image_h };
      }
    }
  }
  return null;
}

function previsitBboxesForClaim(
  claim: Claim,
  toolResults: readonly ToolResult[],
  sidecar: PrevisitSidecarDocs | null,
): Record<string, {
  page: number; x: number; y: number; w: number; h: number; image_w: number; image_h: number;
}> {
  const out: Record<string, {
    page: number; x: number; y: number; w: number; h: number; image_w: number; image_h: number;
  }> = {};
  if (sidecar === null) return out;

  for (const pointer of claim.citation_ids) {
    if (pointer.startsWith('doc:intake-') && sidecar.intake) {
      const docId = parseDocPointerId(pointer);
      if (docId !== sidecar.intake.documentId) continue;
      const bbox = matchIntakeBbox(claim, toolResults, sidecar.intake.payload);
      if (bbox) out[pointer] = bbox;
    } else if (pointer.startsWith('doc:lab-') && sidecar.lab) {
      const docId = parseDocPointerId(pointer);
      if (docId !== sidecar.lab.documentId) continue;
      const bbox = matchLabBbox(claim, toolResults, sidecar.lab.payload);
      if (bbox) out[pointer] = bbox;
    }
  }
  return out;
}

interface PrevisitSidecarDocs {
  readonly lab: { readonly documentId: number | null; readonly payload: import('../schemas/LabPdfSchema.js').LabPdf } | null;
  readonly intake: { readonly documentId: number | null; readonly payload: import('../schemas/IntakeFormSchema.js').IntakeForm } | null;
}

function parseDocPointerId(pointer: string): number | null {
  const m = /^doc:(?:lab|intake)-(\d+)$/.exec(pointer);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function normalizeMedName(s: string): string {
  // "Lisinopril 10 MG Oral Tablet" → "lisinopril"
  // First strip dose/route suffixes by truncating at the first numeric run.
  const lower = s.toLowerCase().trim();
  const stripped = lower.replace(/\s+\d.*$/, '').trim();
  return stripped.replace(/\s+/g, ' ');
}

function matchIntakeBbox(
  claim: Claim,
  toolResults: readonly ToolResult[],
  intake: import('../schemas/IntakeFormSchema.js').IntakeForm,
): { page: number; x: number; y: number; w: number; h: number; image_w: number; image_h: number } | null {
  // Iterate the claim's tool-row pointers; for each one, find the row,
  // map its name field to a sidecar-form bbox.
  for (const pointer of claim.citation_ids) {
    const m = /^tool:([a-z_]+):row-(\d+)$/.exec(pointer);
    if (!m) continue;
    const tool = m[1];
    const rowIdx = Number(m[2]);
    const result = toolResults.find(r => r.ok && r.tool === tool);
    if (!result || !result.ok) continue;
    const row = result.rows[rowIdx];
    if (!row) continue;
    if (tool === 'get_medications' || tool === 'medication_list') {
      const drug = String(row['drug_name'] ?? '');
      const target = normalizeMedName(drug);
      if (!target) continue;
      const match = intake.current_medications.find(m =>
        normalizeMedName(m.name) === target);
      if (match) return match.bbox;
    } else if (tool === 'get_allergies') {
      const allergen = String(row['allergen'] ?? '').toLowerCase().trim();
      if (!allergen) continue;
      const match = intake.allergies.find(a => a.substance.toLowerCase().trim() === allergen);
      if (match) return match.bbox;
    }
  }
  return null;
}

function matchLabBbox(
  claim: Claim,
  toolResults: readonly ToolResult[],
  lab: import('../schemas/LabPdfSchema.js').LabPdf,
): { page: number; x: number; y: number; w: number; h: number; image_w: number; image_h: number } | null {
  for (const pointer of claim.citation_ids) {
    const m = /^tool:([a-z_]+):row-(\d+)$/.exec(pointer);
    if (!m) continue;
    const tool = m[1];
    const rowIdx = Number(m[2]);
    if (tool !== 'get_recent_labs' && tool !== 'lab_results') continue;
    const result = toolResults.find(r => r.ok && r.tool === tool);
    if (!result || !result.ok) continue;
    const row = result.rows[rowIdx];
    if (!row) continue;
    // get_recent_labs stores the test label as `name` (mirrors FHIR
    // Observation.code.text). LabPdfSchema uses `test_name` on its
    // results entries — match the two by case-insensitive equality.
    const labelRaw = row['name'] ?? row['test_name'];
    const label = typeof labelRaw === 'string' ? labelRaw.toLowerCase().trim() : '';
    if (!label) continue;
    const match = lab.results.find(r => r.test_name.toLowerCase().trim() === label);
    if (match) return match.bbox;
  }
  return null;
}

function enrichClaimWire(
  claim: Claim,
  pointerToEvidenceId: ReadonlyMap<string, string>,
  sidecar: SidecarDocResolver | null = null,
  previsitArgs: {
    toolResults: readonly ToolResult[];
    sidecarDocs: PrevisitSidecarDocs | null;
  } | null = null,
): Record<string, unknown> {
  const richBboxes = bboxesForClaim(claim, sidecar, previsitArgs?.sidecarDocs ?? null);
  const previsitBboxes = previsitArgs
    ? previsitBboxesForClaim(claim, previsitArgs.toolResults, previsitArgs.sidecarDocs)
    : {};
  // Rich citation (synthesizer) bboxes win over deterministic fallbacks
  // — when both fire, the LLM-emitted region is the more specific one
  // (it can pinpoint a sub-field; the fallback only knows the row).
  const citationBboxes = { ...previsitBboxes, ...richBboxes };
  return {
    text: claim.text,
    citation_ids: claim.citation_ids,
    severity: claim.severity,
    evidence_refs: evidenceRefsForCitationIds(claim.citation_ids, pointerToEvidenceId),
    ...(Object.keys(citationBboxes).length > 0 ? { citation_bboxes: citationBboxes } : {}),
    ...(claim.finding_confidence ? { finding_confidence: claim.finding_confidence } : {}),
    ...(claim.uncertainty_reason ? { uncertainty_reason: claim.uncertainty_reason } : {}),
  };
}

function buildPrevisitPayload(previsit: PrevisitResult): object {
  const sectionOrder: Array<keyof PrevisitResult['sections']> = [
    'actionItems', 'activeProblems', 'currentMedications',
  ];
  const sidecarResolver = sidecarResolverFromPrevisit(previsit);
  const sidecarDocs = sidecarDocsFromPrevisit(previsit);
  const catalog = materializeEvidenceCatalogForAnswer(
    previsit.answer,
    previsit.toolResults,
    sidecarResolver,
  );
  const pointerMap = catalog.pointerToEvidenceId;
  return {
    kind: 'previsit',
    summary: previsit.answer.summary,
    llm_driven: previsit.llmDriven,
    anchor: previsit.diff.anchorDate ?? null,
    days_since_last_visit: previsit.diff.daysSinceLastEncounter ?? null,
    evidence_catalog: { entries: catalog.entries },
    confidence: previsit.answer.confidence,
    sections: sectionOrder.map(key => {
      const section = previsit.sections[key];
      const sortedClaims = [...section.claims].sort(
        (a, b) => severityRank(b.severity) - severityRank(a.severity),
      );
      return {
        key,
        label: section.label,
        empty: section.claims.length === 0,
        empty_message: section.emptyMessage ?? null,
        claims: sortedClaims.map(c => enrichClaimWire(c, pointerMap, sidecarResolver, {
          toolResults: previsit.toolResults,
          sidecarDocs,
        })),
      };
    }),
  };
}

function sidecarResolverFromPrevisit(previsit: PrevisitResult): SidecarDocResolver {
  return {
    lab: previsit.sidecar.lab
      ? {
          extractionId: previsit.sidecar.lab.extractionId,
          documentId: previsit.sidecar.lab.documentId,
          documentName: previsit.sidecar.lab.documentName,
        }
      : null,
    intake: previsit.sidecar.intake
      ? {
          extractionId: previsit.sidecar.intake.extractionId,
          documentId: previsit.sidecar.intake.documentId,
          documentName: previsit.sidecar.intake.documentName,
        }
      : null,
  };
}

function sidecarDocsFromPrevisit(previsit: PrevisitResult): PrevisitSidecarDocs {
  return {
    lab: previsit.sidecar.lab
      ? { documentId: previsit.sidecar.lab.documentId, payload: previsit.sidecar.lab.payload }
      : null,
    intake: previsit.sidecar.intake
      ? { documentId: previsit.sidecar.intake.documentId, payload: previsit.sidecar.intake.payload }
      : null,
  };
}

function buildFollowupPayload(
  answer: Answer,
  diff: EncounterDiff | null,
  llmDriven: boolean,
  toolResults: readonly ToolResult[],
  supervisorSignals: {
    conflicts: readonly ConflictItem[];
  } | null = null,
  sidecar: SidecarDocResolver | null = null,
  sidecarDocs: PrevisitSidecarDocs | null = null,
): object {
  const sortedClaims = [...answer.claims].sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity),
  );
  const catalog = materializeEvidenceCatalogForAnswer(answer, toolResults, sidecar);
  const pointerMap = catalog.pointerToEvidenceId;
  const conflicts = supervisorSignals?.conflicts.length
    ? supervisorSignals.conflicts
    : answer.conflicts;
  return {
    kind: 'followup',
    summary: answer.summary,
    llm_driven: llmDriven,
    anchor: diff?.anchorDate ?? null,
    evidence_catalog: { entries: catalog.entries },
    confidence: answer.confidence,
    claims: sortedClaims.map(c => enrichClaimWire(c, pointerMap, sidecar, {
      toolResults,
      sidecarDocs,
    })),
    conflicts,
    data_gaps: answer.data_gaps,
    assumptions: answer.assumptions,
  };
}

function streamPrevisitSections(
  reply: { raw: { write(chunk: string): boolean } },
  conversationId: string,
  previsit: PrevisitResult,
): void {
  const sidecarResolver = sidecarResolverFromPrevisit(previsit);
  const sidecarDocs = sidecarDocsFromPrevisit(previsit);
  const catalog = materializeEvidenceCatalogForAnswer(
    previsit.answer,
    previsit.toolResults,
    sidecarResolver,
  );
  const pointerMap = catalog.pointerToEvidenceId;

  reply.raw.write('event: conversation\n');
  reply.raw.write(`data: ${JSON.stringify({
    conversation_id: conversationId,
    llm_driven: previsit.llmDriven,
    anchor: previsit.diff.anchorDate ?? null,
    days_since_last_visit: previsit.diff.daysSinceLastEncounter ?? null,
    mode: 'previsit',
  })}\n\n`);

  reply.raw.write('event: evidence_catalog\n');
  reply.raw.write(`data: ${JSON.stringify({ entries: catalog.entries })}\n\n`);

  reply.raw.write('event: summary\n');
  reply.raw.write(`data: ${JSON.stringify({ text: previsit.answer.summary })}\n\n`);

  // Stream the three sections in order.
  const sectionOrder: Array<keyof PrevisitResult['sections']> = [
    'actionItems', 'activeProblems', 'currentMedications',
  ];

  for (const key of sectionOrder) {
    const section = previsit.sections[key];

    reply.raw.write('event: section\n');
    reply.raw.write(`data: ${JSON.stringify({
      key,
      label: section.label,
      empty: section.claims.length === 0,
      empty_message: section.emptyMessage,
    })}\n\n`);

    // Sort within section: urgent → attention → info.
    const sorted = [...section.claims].sort(
      (a, b) => severityRank(b.severity) - severityRank(a.severity),
    );
    for (const claim of sorted) {
      reply.raw.write('event: claim\n');
      reply.raw.write(`data: ${JSON.stringify({
        section: key,
        ...enrichClaimWire(claim, pointerMap, sidecarResolver, {
          toolResults: previsit.toolResults,
          sidecarDocs,
        }),
      })}\n\n`);
    }
  }

  reply.raw.write('event: confidence\n');
  reply.raw.write(`data: ${JSON.stringify({ value: previsit.answer.confidence })}\n\n`);

  reply.raw.write('event: done\n');
  reply.raw.write('data: {}\n\n');
}

function streamAnswer(
  reply: { raw: { write(chunk: string): boolean } },
  conversationId: string,
  answer: Answer,
  diff: EncounterDiff | null,
  llmDriven: boolean,
  priorMessageCount: number,
  toolResults: readonly ToolResult[],
  supervisorSignals: {
    conflicts: readonly ConflictItem[];
  } | null = null,
  sidecar: SidecarDocResolver | null = null,
  sidecarDocs: PrevisitSidecarDocs | null = null,
): void {
  const catalog = materializeEvidenceCatalogForAnswer(answer, toolResults, sidecar);
  const pointerMap = catalog.pointerToEvidenceId;
  const supervisorConflicts = asArray<ConflictItem>(supervisorSignals?.conflicts);
  const conflicts = supervisorConflicts.length > 0
    ? supervisorConflicts
    : asArray<ConflictItem>(answer.conflicts);

  reply.raw.write(`event: conversation\n`);
  reply.raw.write(`data: ${JSON.stringify({
    conversation_id: conversationId,
    llm_driven: llmDriven,
    anchor: diff?.anchorDate ?? null,
    prior_message_count: priorMessageCount,
  })}\n\n`);

  reply.raw.write('event: evidence_catalog\n');
  reply.raw.write(`data: ${JSON.stringify({ entries: catalog.entries })}\n\n`);

  reply.raw.write(`event: summary\n`);
  reply.raw.write(`data: ${JSON.stringify({ text: answer.summary })}\n\n`);

  // Sort: urgent → attention → info.
  const sorted = [...answer.claims].sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity),
  );
  for (const claim of sorted) {
    reply.raw.write(`event: claim\n`);
    reply.raw.write(`data: ${JSON.stringify(enrichClaimWire(claim, pointerMap, sidecar, {
      toolResults,
      sidecarDocs,
    }))}\n\n`);
  }

  for (const conflict of conflicts) {
    reply.raw.write('event: conflict\n');
    reply.raw.write(`data: ${JSON.stringify(conflict)}\n\n`);
  }
  for (const gap of asArray(answer.data_gaps)) {
    reply.raw.write('event: data_gap\n');
    reply.raw.write(`data: ${JSON.stringify(gap)}\n\n`);
  }
  for (const assumption of asArray(answer.assumptions)) {
    reply.raw.write('event: assumption\n');
    reply.raw.write(`data: ${JSON.stringify(assumption)}\n\n`);
  }

  reply.raw.write(`event: confidence\n`);
  reply.raw.write(`data: ${JSON.stringify({ value: answer.confidence })}\n\n`);

  reply.raw.write(`event: done\n`);
  reply.raw.write(`data: {}\n\n`);
}

function severityRank(s: 'info' | 'attention' | 'urgent'): number {
  if (s === 'urgent') return 2;
  if (s === 'attention') return 1;
  return 0;
}

/**
 * Pull the JWT-bound patient's display name out of the cached transcript
 * so the refusal router can detect wrong-patient mentions. Mirrors the
 * private helper of the same name in runFollowup.ts (kept duplicated
 * rather than shared to avoid hauling CachedTranscript through a new
 * module just for two lines).
 */
function extractPatientName(cached: { toolResults: ToolResult[] }): PatientName {
  const summary = cached.toolResults.find(r => r.ok && r.tool === 'get_patient_summary');
  if (!summary || !summary.ok || summary.rows.length === 0) {
    return { given: null, family: null };
  }
  const row = summary.rows[0]!;
  const given = typeof row['given_name'] === 'string' ? row['given_name'] : null;
  const family = typeof row['family_name'] === 'string' ? row['family_name'] : null;
  return { given, family };
}

function extractBearer(header: string | undefined): string {
  if (typeof header !== 'string') return '';
  if (header.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
  return '';
}

/**
 * Derive the OpenEMR base URL (origin only) from the configured FHIR
 * base. The SidecarHttpClient appends `/interface/agentforge/sidecar.php`
 * itself, so we must strip the FHIR path here. OPENEMR_SIDECAR_BASE_URL
 * overrides the derivation when set.
 */
function deriveOpenemrBaseUrl(fhirBaseUrl: string): string {
  const override = process.env['OPENEMR_SIDECAR_BASE_URL'];
  if (override) return override.replace(/\/$/, '');
  try {
    const u = new URL(fhirBaseUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return fhirBaseUrl.replace(/\/$/, '');
  }
}

function extractSupervisorSignals(handoffs: readonly AccumulatedHandoff[]): {
  conflicts: readonly ConflictItem[];
} {
  let conflicts: readonly ConflictItem[] = [];
  for (let i = handoffs.length - 1; i >= 0; i--) {
    const h = handoffs[i];
    if (conflicts.length === 0 && h?.output.worker === 'conflict_detector') {
      conflicts = asArray<ConflictItem>(h.output.conflicts);
    }
    if (conflicts.length > 0) break;
  }
  return { conflicts };
}

/**
 * Pull lab + intake worker outputs from the supervisor handoff trail and
 * shape them into a SidecarDocResolver the evidence-catalog materializer
 * can use to map `doc:lab-<extraction_id>` / `doc:intake-<extraction_id>`
 * pointers to the real OpenEMR `documents.id` + `documents.name`. Returns
 * null when neither extractor ran (previsit, refusal, etc.).
 */
function extractSidecarResolver(handoffs: readonly AccumulatedHandoff[]): SidecarDocResolver | null {
  let lab: LabExtractorOutput | null = null;
  let intake: IntakeExtractorOutput | null = null;
  for (let i = handoffs.length - 1; i >= 0; i--) {
    const h = handoffs[i];
    if (!h) continue;
    if (lab === null && h.output.worker === 'lab_extractor') lab = h.output;
    if (intake === null && h.output.worker === 'intake_extractor') intake = h.output;
    if (lab !== null && intake !== null) break;
  }
  if (lab === null && intake === null) return null;
  return {
    lab: lab && lab.extractionId !== null
      ? {
          extractionId: lab.extractionId,
          documentId: lab.documentId,
          documentName: lab.documentName,
        }
      : null,
    intake: intake && intake.extractionId !== null
      ? {
          extractionId: intake.extractionId,
          documentId: intake.documentId,
          documentName: intake.documentName,
        }
      : null,
  };
}

/**
 * Parsed lab/intake sidecar payloads pulled from supervisor handoffs.
 * These let the deterministic `previsitBboxesForClaim` resolver walk
 * the structured fields and match by name to attach bboxes onto chips
 * for chart-row-attribution claims (where the synthesizer emits the
 * `doc:lab-<id>` / `doc:intake-<id>` pointer but no rich citation).
 */
/**
 * Fallback path used when the supervisor didn't route to lab/intake
 * extractors but the answer still contains chart-row-attribution
 * pointers (e.g. `doc:lab-<source.document_id>`). Reads the latest
 * sidecar payloads directly so bbox decoration still works.
 */
async function readSidecarForChatFallback(
  reader: SidecarReader,
  pid: number,
): Promise<{ resolver: SidecarDocResolver | null; docs: PrevisitSidecarDocs | null }> {
  const [labRow, intakeRow] = await Promise.all([
    reader.readLatest({ pid, docType: 'lab_pdf' }).catch(() => null),
    reader.readLatest({ pid, docType: 'intake_form' }).catch(() => null),
  ]);
  const lab = (() => {
    if (labRow === null) return null;
    const parsed = LabPdfSchema.safeParse(labRow.extractedJson);
    if (!parsed.success) return null;
    return { row: labRow, payload: parsed.data };
  })();
  const intake = (() => {
    if (intakeRow === null) return null;
    const parsed = IntakeFormSchema.safeParse(intakeRow.extractedJson);
    if (!parsed.success) return null;
    return { row: intakeRow, payload: parsed.data };
  })();
  if (lab === null && intake === null) return { resolver: null, docs: null };
  const resolver: SidecarDocResolver = {
    lab: lab ? {
      extractionId: lab.row.extractionId,
      documentId: lab.row.documentId,
      documentName: lab.row.documentName,
    } : null,
    intake: intake ? {
      extractionId: intake.row.extractionId,
      documentId: intake.row.documentId,
      documentName: intake.row.documentName,
    } : null,
  };
  const docs: PrevisitSidecarDocs = {
    lab: lab ? { documentId: lab.row.documentId, payload: lab.payload } : null,
    intake: intake ? { documentId: intake.row.documentId, payload: intake.payload } : null,
  };
  return { resolver, docs };
}

function extractSidecarDocs(handoffs: readonly AccumulatedHandoff[]): PrevisitSidecarDocs | null {
  let lab: LabExtractorOutput | null = null;
  let intake: IntakeExtractorOutput | null = null;
  for (let i = handoffs.length - 1; i >= 0; i--) {
    const h = handoffs[i];
    if (!h) continue;
    if (lab === null && h.output.worker === 'lab_extractor') lab = h.output;
    if (intake === null && h.output.worker === 'intake_extractor') intake = h.output;
    if (lab !== null && intake !== null) break;
  }
  if ((lab === null || lab.labPdf === null) && (intake === null || intake.intakeForm === null)) return null;
  return {
    lab: lab && lab.labPdf !== null
      ? { documentId: lab.documentId, payload: lab.labPdf }
      : null,
    intake: intake && intake.intakeForm !== null
      ? { documentId: intake.documentId, payload: intake.intakeForm }
      : null,
  };
}

function asArray<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? value as readonly T[] : [];
}

/** Re-export the schema so other modules can validate request shapes. */
export { ChatRequestSchema };

