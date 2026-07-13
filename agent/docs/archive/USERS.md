# Users — AgentForge Clinical Co-Pilot

---

If, after a week of using it, the user closes the sidebar and goes back to skimming the chart, this project failed. Everything below is written with that bar in mind.

---

## Target User

**Dr. M — a primary-care physician (PCP) at an outpatient clinic, with a 20-patient day.**

A real, narrow user — not "physicians" in the abstract.

- **Schedule:** 15–20-minute appointment slots, ~20 patients, runs 5–10 minutes behind by mid-morning.
- **Time between rooms:** **about 90 seconds** — most of it is hand hygiene, hallway conversation, and walking. Maybe 30 seconds at the workstation.
- **Mix of patients:** established patients she knows (chronic disease management, refills, follow-up labs) and patients she is meeting for the first time covering for a colleague.
- **Tooling:** comfortable with the EHR but not an AI specialist. Seen enough confidently-wrong AI to be skeptical. Will not trust uncited model output.
- **Constraints:** HIPAA-bound. Screen often visible to the patient or family.
- **Tolerance:** low. If the tool is slow, wrong, or makes her second-guess herself, she stops using it within a week.

**Why this user, not another.** A hospitalist rounding before noon, an ED resident on overnight intake, an oncologist with deep specialty context — same word "physician," entirely different workflows, latency budgets, and trust postures. The Co-Pilot's surface, scope, and verification posture are tuned for Dr. M. A different user would change the design.

---

## The Workflow Moment

The 90-second between-rooms window, walked through end-to-end.

### The 30 seconds before she opens the agent

Dr. M closes the visit she just finished, sanitises her hands, and walks toward the next exam room. She knows the next patient is *Maria González, 58, established, 3-month follow-up.* In her head: *"What is this visit for, and is there anything I should not miss?"*

Today the answer comes from skimming the last encounter note (often written by a covering colleague), scanning the meds list, and glancing at recent labs. Fast but lossy. The note rarely flags *what changed*. The meds list is long enough that she scans, not reads. She walks into the room with a partial picture.

### What she needs from the agent

One question: *"What's the picture for this patient today, and is there anything I'd be embarrassed to miss?"* Not a dashboard. Not every fact. The **delta since last visit**, the **reason for today**, **anything urgent** — fast, with click-through citations.

### What she does with the output

She reads the auto pre-visit summary. If something stands out (a new abnormal lab, a med change, a flagged interaction), she clicks the citation, confirms the source, and decides whether to raise it in the room. If a follow-up question hits her, she asks it (UC-2..UC-6). Then she walks in.

After the visit she may close the loop with one more question. Then the chart closes and the conversation TTLs out 30 minutes later.

---

## Use Case — UC-1: The Between-Rooms Pre-Visit Pull

**The specific moment.** Dr. M opens a patient chart in the ~30 seconds between rooms, immediately before walking in. She does not type anything.

**The trigger.** The `<agent-sidebar>` mounts on the patient dashboard with the patient already loaded. The agent **auto-fires a single pre-visit pull** before Dr. M has a chance to ask anything — the answer is on screen by the time her eyes reach the sidebar. No prompt typed, no button clicked. UC-1 is a *zero-input* use case.

Drill-down follow-ups (*"what changed since last visit?"*, *"any drug interactions?"*, *"latest A1c?"*) are not UC-1 — they are UC-2..UC-6, which fire when Dr. M types a question after reading the pre-visit summary. UC-1 is the answer that's already there when she looks.

**What she gets back.** A short, structured pre-visit summary in three fixed sections, each with citation chips. Example (real output from the demo against patient pid=6):

> **Pre-visit pull**
>
> Taina Stark, female, DOB 2009-04-07. 1 action item(s), 1 active problem(s), 1 active med(s) (last visit 401d ago, 2025-03-27).
>
> **ACTION ITEMS SINCE LAST VISIT (401D AGO)**
> - New vital reading: Vital signs, weight, height, head circumference, oxygen saturation and BMI panel (2025-07-08). [vitals #1]
>
> **ACTIVE MEDICAL PROBLEMS**
> - Adolescent idiopathic scoliosis (disorder). [active problems #1]
>
> **CURRENT MEDICATIONS**
> - {7 (ethinyl estradiol 0.01 MG Oral Tablet) / 84 (ethinyl estradiol 0.03 MG / levonorgestrel 0.15 MG Oral Tablet) } Pack [Seasonique]. [medications #1]

The shape is fixed (3 sections, in this order) regardless of patient. Variation is in *content*, not *layout* — Dr. M can scan the same three places every time without re-orienting.

**What she does with it.** Reads it in ≤5 seconds. If anything in the action-items section needs deeper context, she clicks the citation to see the source row, or types a follow-up (which becomes UC-2..UC-6). Then she walks in.

**Pass criteria.**

1. Fires automatically on chart mount — no user action required.
2. Renders the three sections in fixed order (Action Items → Active Problems → Current Medications) so Dr. M's scanning pattern is consistent across patients.
3. Empty sections render as `"Nothing to report."` rather than being silently omitted — Dr. M needs to know an absence is real, not infer it.
4. Anchors the summary on a concrete date (`last visit Nd ago, YYYY-MM-DD`) so "since last visit" is unambiguous.
5. Every action-item / problem / medication carries a citation chip that resolves to a real row the agent retrieved this turn.
6. P95 end-to-end latency under **8 seconds** (target sub-2s on the deterministic path that does not invoke an LLM).
7. The agent never invents a medication, lab value, or date. A patient with no recent encounters yields *"No prior visit on file in the last 12 months"* — not a fabricated anchor.

**Failure modes Dr. M explicitly accepts.**

- *Missing data is fine.* "No recent labs on file" is a correct answer. Fabricating a value is not.
- *Free-text notes are out of scope.* If a clinical detail lives only in a narrative note, the pre-visit summary will not include it; the agent does not paraphrase prose.
- *Service unavailable is fine.* Sidebar shows an amber "Co-Pilot unavailable" indicator; the EHR works exactly as before. The agent is **additive**.

### Why an agent — not a dashboard tile, not a static summary widget

This is the load-bearing question for UC-1 specifically. Dr. M already has dashboards and chart panels. Why is the auto pre-visit pull a *chat agent's* output and not a fixed widget?

- **Not a dashboard tile.** A dashboard tile shows the same fields for every patient. UC-1 needs to surface the *delta since last visit, ranked by clinical relevance* — which is patient-specific reasoning across encounters + meds + labs + vitals + problems. The fields a tile would show for a diabetes follow-up are different from the fields it would show for a post-discharge visit. A tile cannot adapt; the agent fans out tools and synthesises per patient.
- **Not a static summary widget.** A widget that just lists "current meds, current problems, last lab" is what the chart already provides. UC-1's value is the *anchor + delta* (action items since the last visit) and the *prioritisation* of which deltas matter. That is reasoning, not rendering.
- **The chat shape is what makes UC-2..UC-6 cheap.** UC-1 emits a summary into the same chat surface that the drill-down follow-ups (UC-2..UC-6) live in. If Dr. M wants to drill into "what's the trend on that A1c?", she types one line into the same sidebar — no context switch, no new tab, no chart navigation. The auto pre-visit pull is the *seed* of the conversation, not a separate widget.
- **Citations are what make it usable.** Every claim in the pre-visit summary carries a click-through to the source row. That is the trust model that lets Dr. M use the answer at all without manually verifying every fact. A black-box widget would not pass her sniff test on day two.

**The bar test.** Would Dr. M close the sidebar and go back to skimming after a week? Only if the auto pre-visit is wrong, slow, or omits the things she actually needs to know between rooms. The design above — fast, cited, scoped, fixed-shape, additive — is built to pass that test.

---

## Use Case — UC-2: What Changed Since Last Visit

**The specific moment.** Dr. M has read the pre-visit summary (UC-1) and wants the *delta* — what's new since her last note, not the full chart state.

**The trigger.** Free-form follow-up turn after the auto pre-visit. Real examples:

- "What's changed since 2026-03-12?"
- "Anything new since I last saw her?"
- "What's different from the last note?"

**Capabilities used.** `get_recent_encounters` + `get_recent_labs` + `get_medications` + `get_active_problems` joined on the encounter-anchor date (`EncounterDiff.anchorDate`), filtered to records *strictly after* the anchor.

**What she gets back.** The delta organised by clinical impact, with citations:

> Since 2026-03-12: **HbA1c 8.1%** on 2026-03-09 (up from 7.4% in December) [obs:lab-119]; **atorvastatin 40 mg** added at that visit [med:rx-87]; **2 new BP readings** averaging 142/88 [obs:vital-201, obs:vital-205]. *No new problems on the problem list.*

**Pass criteria.**

1. Every "new" claim post-dates the anchor date (no items from before).
2. Sections that have no changes render as `"No new problems on the problem list."`, not silently omitted — Dr. M needs to know nothing changed, not infer it from absence.
3. The anchor date is shown in the answer so Dr. M can verify what "since" means.

**Why an agent.** A "recent activity" feed shows chronology; this answer shows *change ranked by relevance*. A new statin is more important than a new BP reading; a new diagnosis is more important than a refill. Ranking that requires reasoning across resource types, which a sorted list cannot do.

---

## Use Case — UC-3: Active-Medication Check with Drug-Drug Interactions

**The specific moment.** Dr. M is about to prescribe (or continue) something. She wants the active med list *and* a safety check, in one breath.

**The trigger.**

- "Any drug interactions to flag?"
- "Is the new statin OK with what she's already on?"
- "Walk me through her current meds."

**Capabilities used.** `get_medications` followed by `check_drug_interactions` (chained — DDIs need RxNorm codes from the med list). The verification layer flags any DDI as `severity: urgent` regardless of how the question was phrased.

**What she gets back.**

> 4 active medications on file: **metformin 1000 mg BID** [med:rx-44], **lisinopril 10 mg daily** [med:rx-58], **atorvastatin 40 mg daily** [med:rx-87], **levothyroxine 75 mcg daily** [med:rx-91]. *No drug-drug interactions detected* against the local DDI table.

**Pass criteria.**

1. RxNorm codes from the med list are passed as the *only* DDI input — never patient name, never free text.
2. If the DDI table flags an interaction, the corresponding claim is `severity: urgent` and renders in the alert lane.
3. If the med list is empty, the agent does not call DDI at all — it answers "no active medications on file" and stops.

**Why an agent.** A med list view shows what's prescribed; it does not cross-reference against an interaction table. The agent's value is *chaining* two tools so the answer Dr. M needs ("is this safe?") arrives in one turn instead of three clicks.

---

## Use Case — UC-4: Lab-Value Lookup with Trend

**The specific moment.** A specific lab matters today (A1c for diabetes, LDL for lipid management, eGFR for renal dosing). Dr. M wants the latest value *and* whether it's moving the right way.

**The trigger.**

- "What's her latest A1c, and is it trending?"
- "LDL — what was last and the one before?"
- "When was her last creatinine and what was it?"

**Capabilities used.** `get_recent_labs` filtered by LOINC family for the named lab, returned in chronological order so the planner can pick the latest two.

**What she gets back.**

> Latest **HbA1c** is **8.1%** on 2026-03-09 [obs:lab-119]. Prior value was **7.4%** on 2025-12-04 [obs:lab-088] — **rising**.

**Pass criteria.**

1. Both the latest value and at least one prior value are returned when available, with explicit dates.
2. "Rising / stable / falling" is stated only when there are ≥2 values; otherwise "no prior value on file."
3. Values render with units. Bare numbers without units are a fail.
4. Missing-data fallback is honest: *"No A1c on file in the last 12 months."*

**Why an agent.** The labs tab shows a list. *Reading the trend* — picking the two most recent values for a specific test, comparing them, naming the direction — is the synthesis the doctor does in her head today. Doing it for her in one turn is the time saving.

---

## Use Case — UC-5: Allergy + Medication Safety

**The specific moment.** Before prescribing anything, Dr. M wants a one-shot answer to *"is there anything she's allergic to that overlaps with what I'm thinking about giving her?"*

**The trigger.**

- "Any allergies I should know about?"
- "Is she allergic to penicillin?"
- "Anything on the allergy list that conflicts with her current meds?"

**Capabilities used.** `get_allergies` (always); `get_medications` only if the question is "vs current meds." A deterministic allergy-vs-medication cross-check rule fires when both lists are present.

**What she gets back.**

> **Penicillin allergy** on file [aller:1] — reaction: hives, severity: moderate. Current med list contains **no beta-lactam antibiotics**. *No overlap.*

**Pass criteria.**

1. Allergy reactions and severities render alongside the allergen — *"penicillin"* alone is insufficient.
2. The cross-check rule renders as `severity: urgent` if any current med matches an allergy class.
3. If the allergy list is empty, the agent answers `"No allergies recorded — confirm with the patient."` and does not infer absence as safety.

**Why an agent.** The allergy list and the med list live in different chart panels. Combining them into one safety statement — *with the absence-of-evidence caveat* — is exactly the cognitive work Dr. M does today between rooms. A static UI cannot deliver that combined answer because the question is conditional on what she plans to prescribe.

---

## Use Case — UC-6: Vital-Trend Snapshot

**The specific moment.** Dr. M wants the last few readings of a specific vital, fast — usually BP for a hypertension follow-up or weight for a heart-failure check.

**The trigger.**

- "Last three BP readings?"
- "What's her weight trend over the last 6 months?"
- "Any fevers in the last week?"

**Capabilities used.** `get_vitals` filtered by vital type, sorted by date descending, capped at the requested count (default 3 if unspecified).

**What she gets back.**

> **BP — last 3 readings:** 142/88 (2026-04-15) [obs:vital-205], 138/86 (2026-03-12) [obs:vital-198], 144/90 (2026-02-04) [obs:vital-189]. *Consistently elevated above target (130/80).*

**Pass criteria.**

1. Each reading has its date and a clickable citation.
2. The agent never invents intermediate readings to "fill" a series.
3. If fewer than the requested count exist, the answer says so explicitly: *"Only 2 BP readings on file in the last 12 months."*
4. Optional: a one-sentence interpretation against guideline targets (130/80 for adults with diabetes), tagged as a `rule:` citation, not a chart citation.

**Why an agent.** The vitals graph view shows everything. *"Last three BP readings, are they trending up?"* is a much narrower question than the graph supports — and the doctor doesn't have time to mouse over each point. A scoped, time-bounded answer is exactly the agent's lane.

---

## Use Case — UC-7: Out-of-Scope Refusal

**The specific moment.** A question lands that the agent should *not* answer — either it's about a different patient, or it's outside the read-only structured-data scope.

**The trigger** — three classes:

- **Wrong-patient.** "Tell me about James Lee" while Maria's chart is open.
- **Out-of-domain.** "What's a normal A1c for an adult?" (general medical knowledge — should come from a textbook or guideline, not from this patient's chart).
- **Out-of-permission.** "Order a basic metabolic panel for today." (Read-only by design.)

**Capabilities used.** The router classifies the question as `out_of_scope` *before* any tool calls. The JWT's `pid` claim is the patient identity; any name in the question that doesn't match is treated as wrong-patient.

**What she gets back.**

> *I can only answer questions about the patient currently on screen (pid in your session). For James Lee, please open his chart.*

> *I'm scoped to this patient's structured chart data — labs, meds, vitals, problems, encounters, allergies. General clinical guidance isn't in scope; please consult your institution's reference.*

> *I'm read-only. Use the orders panel to place that.*

**Pass criteria.**

1. Refusal happens **before** any FHIR tool is called — no patient data is exfiltrated even partially.
2. The refusal message names *why* (wrong-patient / out-of-scope / read-only), not just "I can't help."
3. The refusal renders without citations and with `severity: info` — it is not an error.
4. The conversation continues — Dr. M can ask a valid follow-up immediately on the next turn.

**Why an agent.** A search bar would happily search any patient. A general-purpose chatbot would happily quote textbook ranges. The Co-Pilot's value is *bounded behavior*: explicit refusal is a feature, not a fallback. This is the use case that makes finding #1 from the security review (cross-patient binding) load-bearing rather than nice-to-have.

---

## Out of Scope for Week 1 (and why)

Each exclusion is a *decision*, not an oversight.

- **Notes RAG / encounter narrative summarisation.** Adds a vector store, embeddings, chunking, and a second class of verification failures (passage attribution, not row attribution). Structured-data scope answers ~80% of Dr. M's pre-visit questions; the rest are honestly surfaced as "open the note." Week 2+.
- **Order entry, prescriptions, chart writes.** Read-only is the blast-radius cap that makes the system deployable. The agent can mislead; it cannot prescribe.
- **Multi-patient queries / panel-level views.** Cross-patient questions are routed to refusal in MVP. A "morning huddle" or "patients with overdue A1c" use case is a different user (clinic ops) and a different shape (dashboard).
- **Voice input.** Sidebar accepts text in MVP. Voice is interaction-layer, not architectural.
- **Other roles** (nurse, resident, hospitalist, ED). Different workflows, different latency budgets, different verification postures. Each would extend or refine this document — none replace it.

---

## Traceability — Every Agent Capability Maps to a Use Case

The contract: if a capability is built and isn't in this table, it's feature creep. If a use case is added, a capability must be added to address it.

UC-1..UC-6 fire within Dr. M's 90-second between-rooms window. UC-1 is the auto pre-visit pull; UC-2..UC-6 are drill-downs; UC-7 is the safety floor that bounds every turn.

| Capability | UCs served | Why |
| --- | --- | --- |
| Auto pre-visit pull on chart mount | UC-1 | She walks in with an answer already on screen — no prompt typed |
| Multi-turn conversation | UC-2, UC-3, UC-4, UC-6 | Drill-downs ("anything new since…?", "now check the LDL trend") in the same window |
| Tool chaining (parallel FHIR fan-out) | UC-1, UC-2 | "What changed since last visit?" needs encounters + meds + labs + vitals joined on an anchor date |
| Tool chaining (serial: meds → DDI) | UC-3 | DDI needs RxNorm codes from the prior `get_medications` call |
| Tool chaining (serial: allergies + meds → rule) | UC-5 | The cross-check rule needs both lists present |
| Source-grounded citations | UC-1..UC-6 | Click-through verification is the trust model. UC-7 refusals intentionally render without citations |
| Deterministic clinical-rule layer | UC-3, UC-5, UC-6 | Rules fire as `severity: urgent` regardless of LLM phrasing — a safety floor independent of wording |
| Structured FHIR-resource scope | UC-1..UC-6 | ~80% of pre-visit questions are answerable from structured data; narrative notes route to UC-7 refusal |
| Encounter-anchored delta | UC-2 | "Since last visit" is meaningless without a deterministic anchor date the answer can quote |
| Topic-detection deterministic stub | UC-4, UC-6 | Single-resource lookups skip the LLM entirely — sub-second answers |
| Read-only | UC-7 | The agent can mislead but cannot prescribe |
| Router with `out_of_scope` branch | UC-7 | Refusal happens before any tool call; no patient data is exfiltrated even partially |
| Per-patient scoped JWT (pid binding) | UC-7 | "Tell me about James Lee while Maria's chart is open" resolves to refusal because pid in JWT ≠ patient named |
| Sub-8s P95 latency | UC-1..UC-6 | The 90-second budget. Synthesis questions get the reasoning model; lookups get the deterministic stub |
| Graceful degradation | UC-1..UC-7 | "Co-Pilot unavailable; EHR unaffected" — Dr. M's tooling tolerance is low |
| 30-min conversation TTL | UC-1..UC-7 | PHI exposure window is bounded between rooms |
| Same-patient replay on iframe refresh | UC-1..UC-6 | Refresh / panel re-mount preserves the thread instead of dropping it |


---

