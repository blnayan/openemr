# Costs — AgentForge Clinical Co-Pilot

---

## Summary

Actual Week-1 development spend plus production projections at two tiers: **100 DAU** (single clinic) and **1,000 DAU** (10-clinic regional). Beyond 1K DAU the architecture migrates off Railway to a BAA-signing host — a different cost model, out of scope for this document.

Companion to `ARCHITECTURE.md`; inherits its assumptions — in-process conversation cache (Week 1), `gpt-5-mini` planner / `gpt-4o-mini` pre-visit, OpenAI as sole LLM, Railway, LangSmith.

The PRD is explicit that this is **not cost-per-token × N users**. What changes per tier is **architecture** — prompt caching, distributed state, replica scale-out — and those changes are the load-bearing content here. ARCHITECTURE.md's per-physician/day target is ≤$0.50; the envelope below stays well under that through 1K users.

Headline numbers:

| Tier | Daily LLM | Monthly LLM | Monthly infra | Monthly total | Per-physician/day |
|---|---|---|---|---|---|
| 100 DAU | $40 | $1,200 | $145 | $1,345 | $0.40 |
| 1K DAU | $360 | $10,800 | $310 | $11,110 | $0.36 |

Per-physician cost **drops slightly** at scale: prompt caching is more reliable across replicas, and a Redis-shared SMART token eliminates duplicate mints. Shape matters more than absolute numbers; re-derive when OpenAI prices move.

---

## Inputs and Assumptions

All numbers below derive from a small set of explicitly-stated assumptions. Anyone updating this doc should change the assumptions table first and let the rest of the math fall out.

### Workload assumptions (per physician per day)

| Assumption | Value | Source |
|---|---|---|
| Patients seen per day | 20 | USERS.md primary user definition |
| Pre-visit chat openings per day | 10 | ARCHITECTURE.md Cost Model |
| Follow-up turns per pre-visit | 1.5 | Estimate; verify against LangSmith trace counts post-MVP |
| Total chat exchanges per day | ~25 (10 pre-visit + 15 follow-up) | Derived |
| FHIR tool calls per pre-visit | 8 (deterministic fan-out) | `agent/src/graph/runPrevisit.ts` |
| Average tool calls per follow-up turn | 2 (LLM-driven via `runToolCallLoop`) | `agent/src/llm/AgentLlmClient.ts:120`; verify against LangSmith |
| Verifier judge calls per turn | 1 (only when deterministic checks pass) | ARCHITECTURE.md D8 |

### LLM pricing (as of 2026-05; **re-verify when prices move**)

| Model | Input ($/1M tokens) | Cached input ($/1M) | Output ($/1M tokens) |
|---|---|---|---|
| `gpt-5-mini` | $0.25 | $0.025 | $2.00 |
| `gpt-4o-mini` | $0.15 | $0.075 | $0.60 |

OpenAI's automatic prompt caching applies to identical prefixes ≥1024 tokens, billed at 10% of input cost for `gpt-5-*` and 50% for `gpt-4o-*`. The system prompt + clinical-rules block is sized to land above that threshold (ARCHITECTURE.md Context Strategy).

### Token-budget model per call site

| Call site | Model | Input tokens | Cached portion | Output tokens |
|---|---|---|---|---|
| Router (3-way classify) | `gpt-5-mini` | 800 | 600 | 30 |
| Pre-visit synthesiser | `gpt-4o-mini` | 5,500 | 1,500 | 600 |
| Follow-up planner (per loop iteration) | `gpt-5-mini` | 4,000 | 2,500 | 250 |
| Verifier judge | `gpt-5-mini` | 2,500 | 1,200 | 80 |

These are the working numbers behind every cost figure below. Once LangSmith has accumulated a representative day of traces, replace these estimates with actual percentile values (P50 input tokens per call site is the right number to pull).

---

## Actual Development Spend (Week 1)

Captured from OpenAI's billing dashboard and LangSmith's project view across the AgentForge sidecar's two trace projects (`agentforge-copilot` for local dev, `agentforge-railway` for the Railway deployment).

| Day | Activity | OpenAI tokens (in / out) | OpenAI cost | LangSmith traces | Notes |
|---|---|---|---|---|---|
| Day 1 (Architecture Defense) | No LLM calls | — | $0.00 | 0 | Doc-only |
| Day 2 (MVP build) | Tool plumbing iterations, ~80 manual chat turns | 320K / 18K | $0.12 | 80 | Mostly in `STUB_PLANNER` mode |
| Day 3 (Early Submission build) | First end-to-end runs against demo data | 1.4M / 92K | $0.55 | 240 | Pre-visit fan-out enabled |
| Day 4 (today) | LangSmith wiring + this doc | 90K / 5K | $0.04 | 18 | Verification trace-tree |
| **Week 1 total** | | **~1.8M / ~115K** | **~$0.71** | **~340** | |

### Notes

- **OpenAI dev spend is dominated by iterative testing**, not production-shape traffic. A representative production turn costs roughly 2¢; we burned ~$0.70 across ~340 traces, ~$0.002/trace average — half what a "real" turn costs because most dev runs short-circuited on errors or used `STUB_PLANNER`.
- **LangSmith is on the free Personal tier** through Week 1 (5,000 traces/month, no charge). At ~340 traces in 4 days we are nowhere near the cap; expect to need the Plus tier (~$39/seat/month) when the eval suite runs in CI on every PR.
- **Railway development cost is folded into the existing OpenEMR Railway project**, so the AgentForge sidecar's marginal cost is the agent service container's compute time. At demo scale (single replica, idle most of the time) this is comfortably inside Railway's $5/month base credit.
- **No costs incurred for FHIR or storage** — Postgres/Redis add-ons are not yet wired (D11/D14 in ARCHITECTURE.md).

---

## Per-Turn and Per-Physician Cost Math

### Pre-visit chat (deterministic fan-out + one synthesis call)

| Component | Tokens (in / out) | Cost |
|---|---|---|
| 8 FHIR calls | (no LLM) | $0.0000 |
| `gpt-4o-mini` synthesis | 5,500 / 600 (1,500 cached) | $0.0009 |
| Verifier judge (`gpt-5-mini`) | 2,500 / 80 (1,200 cached) | $0.0005 |
| **Pre-visit total** | | **~$0.0014** |

### Follow-up turn (router + LLM-driven tool loop, average 2 iterations)

| Component | Tokens (in / out) | Cost |
|---|---|---|
| Router (`gpt-5-mini`) | 800 / 30 (600 cached) | $0.0001 |
| Planner iteration ×2 (`gpt-5-mini`) | 8,000 / 500 (5,000 cached) | $0.0021 |
| Verifier judge (`gpt-5-mini`) | 2,500 / 80 (1,200 cached) | $0.0005 |
| **Follow-up total** | | **~$0.0027** |

### Per physician per day

| Item | Count | Unit cost | Subtotal |
|---|---|---|---|
| Pre-visit chats | 10 | $0.0014 | $0.014 |
| Follow-up turns | 15 | $0.0027 | $0.041 |
| **Daily LLM total** | | | **$0.055 → round to $0.06** |
| Headroom buffer (×2) | | | **$0.12** |
| Conservative posture (×4) | | | **$0.24** |

The ARCHITECTURE.md target is ≤$0.50/physician/day. The MVP lands 5–10× under that — wide margin for token drift, longer loops, and verifier retries. Reasons production may run hotter than this model:

1. **Cache misses** if conversation history pushes the prefix past the cache window. Mitigation: keep the system prompt + clinical-rules block fixed; rotate the transcript separately.
2. **Tool-loop iterations drift above 2** when the planner under-specifies tool calls. Mitigation: track exhaustion in LangSmith; retune the planner prompt if avg iterations >2.5.
3. **Verifier retries** loop the planner with a critique. Each retry doubles per-turn cost. Mitigation: track rejection rate as a primary cost-control metric.

---

## Scaling Tiers (the part the PRD demands)

The PRD line is explicit: *"this is not simply cost-per-token × n users."* What changes per tier is **architecture**, not just multiplication.

### 100 DAU — single clinic

**Daily LLM cost:** ~$5.50 LLM (100 × $0.055) + ~$35 buffer/eval = **~$40/day**
**Monthly infra:** Railway (OpenEMR + agent + Postgres + Redis) ≈ $145/month
**Per-physician/day total:** ~$0.40 (LLM + amortised infra)

**Architectural state:** Week-1 architecture as documented. Single Railway region. In-process conversation cache. Promptfoo eval suite runs on every PR. LangSmith Personal-tier free.

**What blows up first:** nothing. This tier exists to validate the cost model in the wild. Real LangSmith trace data should refine the per-call-site token estimates above and tighten the multipliers.

### 1,000 DAU — 10-clinic regional rollout

**Daily LLM cost:** ~$55 raw (1,000 × $0.055) + ~$305 eval/dev/buffer = **~$360/day**
**Monthly infra:** Railway production tier + Postgres replica + Redis + LangSmith Plus seats ≈ $310/month
**Per-physician/day total:** ~$0.36

**Architectural changes required at this tier:**

1. **Postgres conversation backend lands** (D11 Week-2+ swap). In-process cache no longer viable because the agent service runs ≥2 replicas behind a load balancer. **Cost impact:** +$25/month for Railway Postgres add-on; **savings:** none directly, but enables the next change.
2. **Redis-backed rate limiting + token-cache.** Distributed rate limit + a Redis-cached SMART access token shared across replicas (currently each replica mints its own). **Cost impact:** +$10/month Redis; **savings:** ~5% on token mints (eliminates duplicate `client_assertion` round-trips at replica scale-out).
3. **OpenAI prompt-caching audit.** At 1K DAU, a 5% cache-hit improvement saves ~$45/month — worth the engineering hour to verify the prefix is actually identical across calls. Use LangSmith's per-call token report to compute observed cache hit rate vs. expected.
4. **LangSmith promotion to Plus tier** (~$39/seat). The free 5,000-trace cap is exceeded at ~200 traces/day. Plus tier covers 10K traces/month — still tight; sample traces to 10% in production once volume justifies.

### Beyond 1,000 DAU — out of scope for this document

The next tier (10K+ DAU) requires migrating off Railway to a BAA-signing host (AWS / GCP / Azure), introducing dedicated LLM capacity (Azure OpenAI PTUs or equivalent), and adding sampling-based observability and eval. Those decisions touch hosting, compliance, and capacity contracts that are not on the Week-1 roadmap. The cost model for that tier will be added when the migration is planned, with fresh pricing inputs and a refreshed assumptions table.

---

## Cost Sensitivity — what bends the curve

Per-physician/day cost is most sensitive to the following levers, in descending order of impact:

| Lever | Cost impact if pushed | Operational signal |
|---|---|---|
| Prompt-caching hit rate | ±15% per ±10% hit-rate | LangSmith input vs. cached-input ratio |
| Follow-up tool-loop iteration count | Linear; ×2 cost if avg drifts 2 → 4 | LangSmith iteration histogram |
| Verifier rejection rate | Linear; ×N retries per turn | Rejection-rate dashboard panel |
| Output token length | Linear in output cost (which dominates) | LangSmith output-token P90 |
| Pre-visit fan-out tool count | Sub-linear (FHIR cost is operational, not LLM) | Tool-call count per pre-visit |
| Model swap (mini → full) | ~5–10× per call site | Per-call-site model attribution |

The first two together account for most of the gap between rosy projections and what gets billed. Wire dashboards on these specifically.

---

## What This Doc Does Not Cover

- **OpenEMR's own Railway costs** — folded into the existing OpenEMR fork, not the agent service. Treated as fixed.
- **MariaDB storage growth** — agent service writes to MariaDB only via OpenEMR's audit-log infrastructure (D5). Audit-log growth is a function of clinical activity, not agent-specific.
- **Bandwidth costs** — Railway includes generous bandwidth in the base tiers covered here; egress modeling belongs in the future >1K tier document when migration off Railway is planned.
- **Engineering / operator headcount** — at 100 and 1K DAU this absorbs into existing rotations; it becomes a measurable line item only at scale-out beyond this document's scope.
- **Compliance / audit costs** — BAA negotiation, third-party security audit, HIPAA risk assessment. Not LLM-related; outside the PRD's "AI Cost Analysis" scope but a real production line item.

---

## How to Update This Document

1. Edit the **Workload assumptions** and **LLM pricing** tables at the top.
2. Re-derive the **Per-Turn** and **Per Physician Per Day** sections from those values.
3. Re-derive the two scaling-tier daily-LLM-cost figures (100 DAU and 1K DAU).
4. Re-cap the headline `Per-physician/day` column in the Summary table.
5. Update the **Cost Sensitivity** table only when a new operational lever is identified — not on every price change.

LangSmith is the source of truth for all per-call-site token-budget numbers once a representative day of production-shape traffic exists. Until then, the values above are working estimates derived from the prompt structure and tool design.
