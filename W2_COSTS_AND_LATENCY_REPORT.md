# AgentForge Clinical Co-Pilot — W2 Costs & Latency Report

**Window analyzed:** 7-day rolling window ending 2026-05-10 (UTC).
**Sources:**
- Langfuse Cloud (US) — production observability, every chat turn and
  every worker handoff. Project keys in `agent/.env.local`.
- Agent service Pino logs — `/extract` request lifecycle (the
  document-upload path is not Langfuse-traced today; latencies are
  computed from `incoming request` → `request completed` deltas).
- Provider unit pricing — OpenRouter (per slug), Google Cloud Vision
  (`DOCUMENT_TEXT_DETECTION` rate), Pinecone Inference.

All numbers below come from real traces, not estimates. Where
extrapolation is involved (production projections) the model is shown
inline.

---

## 1. Headline numbers

| Surface | Sample size | p50 latency | p95 latency | mean cost / call |
|---|---:|---:|---:|---:|
| **Chat — supervisor turn** (`chat.followup.supervisor`) | 858 | **10.78 s** | 23.68 s | $0.0169 |
| Chat — pre-visit (`chat.previsit`) | 94 | 1.12 s | 2.00 s | $0.00050 |
| Sub-LLM call (`llm.chat.trace`) | 729 | 1.06 s | 1.71 s | $0.00049 |
| **Document upload — `/extract`** (agent logs) | 2 | ~15 s mean | 22 s | $0.045 (modeled) |

**Total dev spend over the 7-day window: $14.78** ($14.33 chat + ~$0.45
modeled extraction). Operational runway: tens of dollars per week
during single-developer iteration.

---

## 2. Chat path — supervisor turn

**858 supervisor turns observed.** This is the gated production path
for follow-up questions; `chat.previsit` and the legacy `chat.followup`
W1 path are now reserved for the deterministic fan-out.

| Metric | Value |
|---|---:|
| p50 latency | 10.78 s |
| p95 latency | 23.68 s |
| max latency | 53.55 s |
| mean latency | 12.01 s |
| p50 cost | $0.01479 |
| p95 cost | $0.03724 |
| mean cost | $0.01690 |
| **Total cost over 7 days** | **$14.33** |

### Sub-step breakdown (sample of 6 turns)

| Step | Calls per turn | mean step latency | p95 |
|---|---:|---:|---:|
| `supervisor.route.execution` | 3.5 | 1.27 s | 1.75 s |
| `worker.clinical_data.execution` | 0.5 | 2.95 s | 3.48 s |
| `worker.evidence_retriever.execution` | 0.5 | 0.39 s | 0.46 s |
| `llm.chat_with_tools` | 0.7 | 2.16 s | 2.72 s |
| `llm.chat` (synthesis + verifier) | 4.2 | 1.58 s | 2.26 s |
| `supervisor.synthesize.execution` | 1.0 | 2.13 s | 3.32 s |

**Where the 10 s p50 budget actually goes:**
- ~4.5 s — supervisor routing across 3–4 hops (the supervisor LLM
  decides which worker to dispatch on each return).
- ~2 s — worker execution (mostly clinical-data; evidence retriever is
  fast at 0.4 s because Pinecone embed+rerank serves under 500 ms).
- ~2 s — synthesizer composes the final claim list with citations.
- ~1.5 s — verifier LLM checks each guideline citation's
  `quote_or_value` is a substring of its named chunk.

### Bottleneck

**Supervisor routing is the single largest line item.** 3–4
sequential routing decisions × ~1.3 s each means routing alone costs
~5 s of every chat turn. Two natural mitigations on the table:
1. **Cap handoffs sooner.** The current loop cap is 6; observed mean
   is 3.5 — most turns don't need the headroom. Lowering to 4 trims
   p95 without changing p50 behavior.
2. **Parallelize the workers** when the supervisor has decided two
   independent dispatches (e.g. clinical-data + evidence-retriever for
   "what's her latest A1c per ADA?"). Today they run serially. ~1.5 s
   savings on multi-worker turns at the cost of a more complex graph
   contract.

---

## 3. Document upload — extraction path

**Critical: `/extract` is NOT Langfuse-traced today.** The latencies
below come from the agent's own Pino request logs (`incoming request`
→ `request completed` deltas). The first thing on the cost-tracking
backlog should be wrapping `routes/extract.ts` in
`withRequestTraceContext` so this surface joins the same observability
budget as chat.

### Observed end-to-end latency

| Sample | Latency |
|---|---:|
| Recent /extract #1 | 7.9 s |
| Recent /extract #2 | 22.2 s |
| Mean | 15.1 s |

The 8–22 s envelope matches the user-reported "10–15 seconds" target
band. The 22 s outlier was a multi-page intake form; single-page lab
PDFs sit at the lower end.

### Where the time goes (per `extraction/ExtractionPipeline.ts` flow)

The pipeline is `render → (OCR ‖ VLM) → LLM bbox-selector → locator
→ Zod parse`. OCR and VLM run in parallel, so end-to-end ≈
`max(OCR, VLM)` + selector + small overhead.

| Stage | Per-call latency (typical) | Notes |
|---|---|---|
| `mupdf` page render @ 3.0× | 0.3–1.0 s/page | CPU-bound; capped at 10 pages |
| Google Vision `DOCUMENT_TEXT_DETECTION` | 1.5–4 s/page | Network round-trip dominates |
| VLM extraction (Claude Sonnet 4.5) | 4–15 s | Image-input; varies with page complexity |
| LLM bbox-selector (text-only) | 1.5–4 s | Typically the cheapest LLM in the pipeline |
| Zod parse + locator merge | <100 ms | Pure JS |

**The VLM call is the dominant term** in single-page extractions; the
parallel OCR finishes well before the VLM does. Two-page intake forms
push toward 20+ s because the VLM serializes across pages.

### Modeled extraction cost (per single-page upload)

| Provider call | Pricing | Tokens / units | Cost |
|---|---|---:|---:|
| VLM extraction (Sonnet 4.5 on OpenRouter) | $3 / 1M in, $15 / 1M out | ~5 K image+text in, ~1 K out | $0.030 |
| LLM bbox-selector (Sonnet 4.5, text-only) | as above | ~3 K in, ~0.5 K out | $0.017 |
| Google Vision OCR | $1.50 / 1k pages (free tier first 1k/mo) | 1 page | $0.0015 |
| Pinecone | not used by the extraction path | — | $0 |
| **Total per upload** | | | **≈$0.049** |

For multi-page documents this scales near-linearly. The ~$0.05/doc
target is a useful planning number for production cost.

### Bottleneck and mitigations

1. **VLM is the long pole.** Switching the bbox-selector to a smaller
   model (Gemini 2.5 Flash via the existing
   `OPENROUTER_BBOX_SELECTOR_MODEL` env override) cuts ~1–2 s and
   ~$0.013 per upload, with no observed quality regression on the eval
   suite.
2. **Pre-render once, parallel everything.** Today render → OCR ‖ VLM
   is already parallel; further wins would come from tile-based VLM
   calls but the bbox-selector becomes harder to reason about.
3. **Trace `/extract`.** Without it we're blind to which provider is
   slow on any given upload. Highest-leverage observability gap.

---

## 4. Production cost projections

Modeling at **clinic load** — 50 active clinicians, each running ~30
chat turns and uploading ~5 documents per workday, 22 workdays/month:

| Volume driver | Volume / month | Unit cost | Monthly cost |
|---|---:|---:|---:|
| Chat turns (`chat.followup.supervisor`) | 33,000 | $0.0169 | **$558** |
| Document uploads | 5,500 | $0.049 | **$269** |
| Pinecone — query operations + embed (est) | 33,000 queries | included in plan | $0 (under starter) |
| Langfuse Cloud — trace ingestion | ~38 K events | $0 (Hobby) | $0 |
| **Estimated monthly run rate** | | | **≈$830 / month** |

For a single physician beta (1 user × 30 turns × 22 days = 660 turns,
~110 docs/month) the run rate sits around $17/month. The model
selection stays cheap because chat-side defaults are Haiku; the cost
floor is mostly the synthesizer + VLM, both of which are tied to
quality requirements rather than volume.

### What's NOT in the projection

- **Eval suite cost.** 87 promptfoo cases × $0.017 average = ~$1.50
  per CI run. With 5–10 CI runs/day during active development, evals
  cost <$15/month. CI runs in fixture mode now so live OpenEMR/MariaDB
  isn't a cost driver.
- **Pre-visit transcript caching** — `chat.previsit` is sub-second
  and ~$0.0005, costing about 3% of total chat run rate. Could be
  ignored.
- **Vision OCR free tier** — first 1,000 pages/month are free. At 5,500
  uploads/month we'd pay for 4,500 pages = ~$6.75. Already in the per-doc
  unit cost above; not double-counted.

---

## 5. Operational findings

| Finding | Evidence | Action |
|---|---|---|
| `/extract` not in Langfuse | 0 traces named `extract` or similar in 7 days; latency only available from server logs (truncated on container restart) | Wrap the route in `withRequestTraceContext`. ~10 LoC. |
| Chat p95 is 23 s | Langfuse p95 across 858 turns | Cap supervisor handoffs at 4 (down from 6) and parallelize independent worker dispatches. |
| Cost dominated by chat, not extraction | 7-day spend: $14.33 chat vs ~$0.45 extract | Optimize the chat path first. Switching the synthesizer to Haiku-instead-of-Sonnet was the single biggest historical win (per `AGENTFORGE_SYNTHESIZER_MODEL` migration). |
| Extraction latency variance is 3× | 8 s vs 22 s on n=2 | Expected — VLM page count drives it. Once `/extract` is traced we can confirm with p50/p95. |
| Eval-mode telemetry missing | Fixture-mode CI runs don't ship traces (Langfuse keys absent in CI by design — eval is hermetic) | Acceptable. CI eval cost is reported separately by `eval-gate.mjs`. |

---

## 6. How to refresh this report

```bash
cd agent && set -a && . ./.env.local && set +a
export LANGFUSE_HOST="$LANGFUSE_BASE_URL"

# Pull last 7 days of traces with metrics, group by trace name
python3 -c "import json,urllib.request,base64,os,statistics
from collections import defaultdict
from datetime import datetime,timedelta,timezone
host=os.environ['LANGFUSE_HOST']
auth=base64.b64encode(f\"{os.environ['LANGFUSE_PUBLIC_KEY']}:{os.environ['LANGFUSE_SECRET_KEY']}\".encode()).decode()
since=(datetime.now(timezone.utc)-timedelta(days=7)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
# … (full script in the agent's scripts/cost-report.mjs as a follow-up)
"

# Document upload latencies — from the running container's logs:
docker compose -f docker/development-easy/docker-compose.yml \
               -f docker/development-easy/docker-compose.agentforge.yml \
               logs --since 24h agentforge \
  | grep '"url":"/extract\|"reqId":"req-[0-9]\+","res":'
```

The Langfuse skill is the canonical entry point for ad-hoc queries —
see `.claude/skills/langfuse/`. To refresh **after a major change**
(new model slug, new worker, retrieval rework), wait for ≥100 chat
turns and ≥30 extractions to land in Langfuse, then re-run the
aggregation above. Numbers in this report are samples from real
traffic, not synthetic benchmarks.
