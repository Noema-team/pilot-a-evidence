 <<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Plan — rag-worker → rag-api Failure Payload Contract Alignment

Run: 847bb303-de95-4853-80e9-8bc63f7f4199 · Iteration 1 · Depth: minimal
Intent: "rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage"

Authoritative scope: WorkItem `wi-define-108-a8`, artifact `definition:obj-108`
(sha256 `71f1c39c…89cac5`). Nothing below widens or narrows that Definition.

---

## 1. Problem Statement

Every worker-originated RAG processing failure persists wrong data in Firestore:

| Persisted field | Value today | Root cause |
|---|---|---|
| `resource.document.error` | Literal fallback `"Processing failed"` | Worker sends `details["error"]`; rag-api reads `details["error_message"]` — miss ⇒ `.get(...)` default fires |
| `resource.document.error_stage` | `None` | Worker sends no `stage` key at all |
| `resource.document.retryable` | Silent default `True` | Worker sends no `retryable` key |

Secondary effect: the `processing`/`summary` error subdocument stores `message = "Processing failed"`,
`stage = None`, and `error_code = "UNKNOWN"` (default applied when no code is supplied — which is fine,
since the Definition forbids introducing a structured error-code taxonomy).

Three sibling writers already conform to the target schema (`error` / `error_stage` / `retryable`):
the worker’s own stale-lease sweep (`_fail_if_still_stale`), rag-api’s `/process` enqueue-failure path,
and rag-api’s `POST /resources` enqueue-failure path. Two response surfaces (`ResourceResponse`,
the `Resource` model) already expose these fields, with `retryable` defaulting `True`.

Conclusion reached during Define: **align the worker to the API**, not vice versa. The worker’s
publisher is the sole outlier; fixing it requires no Firestore migration, no field rename, no backfill,
no reader/model change. Constraint satisfied verbatim.

---

## 2. Target Contract (single source of truth)

Worker publishes, on failure, a status-details dict carrying **all four** keys:

```json
{
  "status":        "<unchanged existing status value>",
  "error_message": "<str(exception)>",
  "stage":         "<current pipeline stage name>",
  "retryable":     <bool>,
  "error":         "<same string as error_message>"   // legacy-compat hedge, see §4.4
}
```

Rag-API consumes (already implemented, **zero code change required**) in its failed branch of
`run_transactional_update`:

| Read from `details` | Written to persisted document | Sub-document mirror (`processing`/`summary`) |
|---|---|---|
| `details["error_message"]` | `error` | `message` |
| `details["stage"]`          | `error_stage`            | `stage` |
| `details["retryable"]`      | `retryable`              | *(not mirrored)* |
| *(absent)*                  | —                        | `error_code = "UNKNOWN"` (untouched default) |

Drift-risk closure: a key-set assertion in the contract test pins BOTH sides’ key sets (§5, T4),
so adding/removing a key on either endpoint trips CI rather than reintroducing the bug silently.

Allowed stage-name vocabulary (reuses the worker’s existing progress-update tokens):

```
starting · text_retrieval · tagging · summarization · chunking · embedding · finalizing
```

Safe sentinel for “stage unknowable”: `"finalizing"`. Chosen over `"processing"` because
`"processing"` collides semantically with the whole-job verb used elsewhere in logs/UI; `"finalizing"`
is unused downstream and maps cleanly to “post-pipeline bookkeeping”. Implementers MAY substitute
any unused token; the choice itself is not part of the acceptance surface (only that it is non-null,
from the fixed vocabulary above, and asserted identically on both ends of the contract test).

---

## 3. Design Decisions

### 3.1 Stage Tracking (Requirement R2)

Introduce a mutable local `current_stage` initialized to `"finalizing"` at the very top of
`process_document`. Immediately BEFORE each awaited pipeline step, assign the corresponding token:

```
await fetch_text(...)                      # preceding assignment: current_stage = "text_retrieval"
...
await tag_resource(...)                    # preceding assignment: current_stage = "tagging"
...
await generate_summary(...)                # preceding assignment: current_stage = "summarization"
...
await chunk_document(...)                  # preceding assignment: current_stage = "chunking"
...
await generate_embeddings(...)             # preceding assignment: current_stage = "embedding"
```

Convention (“assign-then-await”) documented inline via a short module-level docstring/comment near the
tracker declaration. Drift hazard (future contributor forgets to update tracker for a newly inserted
step) is mitigated by the representative-stage coverage mandated by Acceptance Criterion AC4 —
one early-stage failure scenario plus one late-stage failure scenario — sufficient to detect removal
of the tracker entirely or systematic omission, without pinning every individual call site forever.

At publication time, the exception handler in `process_document` closes over the live `current_stage`
value and injects it verbatim into the payload.

### 3.2 Retryable Derivation (Requirements R3/R4)

Reuse `classify_error(exc) :: {"category": "transient"|"permanent", ..., }` already resident in the
worker service (referenced by Definition Fact F7 and confirmed as driving ACK/NACK logic in `run_worker`).
Derive:

```
payload_retryable := (classification_result.category == "transient")
```

Behavior matrix (mirrors the worker’s actual delivery disposition):

| Exception raised | `classify_error` category | Published `retryable` | Runtime consequence |
|---|---|---|---|
| Explicit `TransientError` subclass instance | `transient` | `true` | Message NACKed; Pub/Sub redelivery expected |
| Explicit `PermanentError` subclass instance | `permanent` | `false` | Acknowledged; surfaced to user; manual retry possible via app UI/API |
| Any unrecognized built-in/third-party exception | `permanent` (conservative default) | `false` | Same as permanent row |

⚠️ Deliberate observable behavior change versus today: previously ALL worker failures landed with
`retryable = True` purely via rag-api’s absent-key fallback. Under this plan, only truly-transient
classifications remain `true`; everything else becomes `false`. This reverses no business promise —
today’s `True` is noise masquerading as signal. Stale-lease-sweep writes (`retryable = True`)
remain untouched by design (Fact F6 / NonGoal NG1): a lease expiring signals the worker died
mid-flight, which IS operationally transient even if the underlying extraction step looked permanent.

### 3.3 Legacy-Key Hedge (Constraint C-PREFER-1 / Assumption F11)

Publish BOTH `error` (old key) and `error_message` (new key) holding identical strings. Cost: ~20
extra bytes per failure event. Benefit: any undocumented consumer of the status topic continues to
parse successfully until such a consumer is audited away. Removal of the `error` key is explicitly
deferred follow-up work once consumption inventory is confirmed empty-of-other-readers — do NOT
remove in this iteration.

Similarly, the `stage` key coexists with any hypothetical older consumer expecting bare status-text
updates; older parsers simply ignore unknown keys, so no harm arises from inclusion.

### 3.4 Why Rag-API Requires Zero Edits Here

Its failed branch ALREADY implements Requirement R5 verbatim (Definition Facts F4/F6, cross-checked
against Claim CLM-RAGAPI-FAILED-BRANCH-READS-DURING-INVESTIGATION). We validate rather than rewrite:
the contract test proves the passthrough holds post-change, satisfying “persist unchanged” without
touching production reader code.

Out-of-boundary reminder enforced by review: ANY suggestion arising during execution to alter
`run_transactional_update`’s parsing or the `Resource` model violates Constraint MUST-NOT-MIGRATE /
NonGoal NG3 and must be escalated back to the planner rather than implemented locally.

---

## 4. Task Breakdown

All file paths below refer to locations verified accessible during Investigation. Where exact internal
symbol signatures inside `main.py` were not individually opened/read this cycle (see Caveat A in §8),
implementers must locate equivalents by searching the quoted identifiers cited throughout this doc
(`process_document`, `_publish_status_update`, `classify_error`, `run_transactional_update`,
`TransiencyError` family naming per ExceptionsModuleNamingClaim) rather than trusting guessed spellings.

---

#### T1 — Extend worker exception-handler payload construction

*File:* `apps/ai_server/services/document_processor/service_impl.py` (placeholder label for the module
containing `process_document`; resolve by identifier search)

Steps:
1. Declare `current_stage = FINALIZING_STAGE_SENTINEL` at method entry.
2. Insert `current_stage = <TOKEN>` assignments immediately prior to each distinct awaited pipeline
   invocation enumerated in §3.1.
3. In the `except BaseException:` arm feeding `_publish_status_update(status_value=...)`:
   ```python
   exc_category = classify_error(exc)["category"]
   payload_details = {
       STATUS_KEY_ERROR_MESSAGE: str(exc),
       STATUS_KEY_LEGACY_ERROR:  str(exc),           # §3.3 hedge
       STAGE_TRACKER_FIELD_NAME: current_stage,
       RETRYABLE_PAYLOAD_FLAG:   exc_category == TRANSIENT_CATEGORY_TOKEN,
   }
   ```
   Merge with whatever additional metadata the handler already attached (do NOT discard existing
   entries; additive-only modification preserves forward-compatibility with any richer diagnostics
   added concurrently elsewhere).
4. Keep the overall success-path return-type and control flow byte-for-byte identical.

Rollback: revert the single commit touching this hunk — no shared-state mutation occurs elsewhere.

Acceptance linkage: satisfies AC1 (first bullet) and AC2 inputs.

---

#### T2 — Update worker-facing constants and documentation comments

Wherever the worker declares public enum-like tuples describing valid status-detail keys (if such a
registry exists in `constants.py` or adjacent modules), append `STAGE_TRACKER_FIELD_NAME` and
`RETRYABLE_PAYLOAD_FLAG` entries so IDE/type-checkers recognize them. Add explanatory comment citing
this plan ID and noting the assign-then-await invariant. Pure-comment/doc edits — no runtime impact.

If NO registry exists, skip gracefully; do not manufacture ceremony.

---

#### T3 — Build contract test scaffolding

Target file: `apps/ai-server/tests/integration/test_rag_failure_contract.py` (NEW FILE — do not append
to unrelated suites). Bootstrap imports/utilities copied from neighboring integration harness
modules (pattern precedent visible in `test_upload_download_roundtrip_integration.py` and
`test_ingestion_end_to_end_flow.py`), adapted minimally.

Required pieces:
- Fixture `failure_payload_factory(kind: Literal["transient","permanent"])` returning the exact dict
  emitted by the patched T1 logic for a synthetic exception of the chosen kind, obtained EITHER by
  importing the worker builder symbol directly OR by invoking the public helper exported for testing
  purposes (preferred if available; otherwise replicate constructively BUT ALSO wire a secondary
  consistency probe comparing replica-vs-real on a canned input — see caveat in §5).
- Mock/Patch boundary points identified:
  * Stub the transport channel used by `_publish_status_update` to capture outgoing frames.
  * Point rag-api’s persistence backend at `testing_firestore_emulator` connection params (reuse
    the existing integration-suite bootstrap utilities — investigate exact hook during execution;
    hint: grep `emulator_host` usage in sibling test setups).
- Deterministic clock injection IF timestamps participate in persisted records (guard flakiness);
  otherwise freeze irrelevant.

Reference exemplar for framing (illustrative skeleton — adjust freely):

```python
@pytest.mark.contract_worker_failures
def test_transient_failure_produces_true_retryable(worker_builder_stub, fake_transport_capture,
                                                  firestore_test_session, snapshot_compare_fixture):
    captured_frame = trigger_simulated_processing_exception(
        exc_instance=ExampleTransientTimeout(),
        stage_token_before_raise=TOKEN_SUMMARIZATION_STEP_LABEL,
    )
    assert captured_frame.details[STATUS_KEY_ERROR_MESSAGE] != ""
    assert captured_frame.details[RETRYABLE_PAYLOAD_FLAG] is True
    assert captured_frame.details[STAGE_TRACKER_FIELD_NAME] == TOKEN_SUMMARIZATION_STEP_LABEL

    ingest_captured_into_fresh_unprocessed_record(captured_frame, firestore_test_session)

    resulting_snapshot = load_finalized_document_state(firestore_test_session)
    expect(resulting_snapshot.main_doc_fields) == SnapshotOfPersistedFailureOutcome(
        error_message_actual=captured_frame.details[STATUS_KEY_ERROR_MESSAGE],
        err_stage_label=captured_frame.details[STAGE_TRACKER_FIELD_NAME],
        retry_flag_set_by_sender=captured_frame.details[RETRYABLE_PAYLOAD_FLAG],
    ) >> snapshot_compare_fixture.frozen_reference_for_case(KNOWN_CASE_TRANSIENT_TIMEOUT_IN_SUMMARY)


@pytest.mark.parametrize("exc_kind,expected_bool", [
    (ExampleTransientConnectionDrop(), True),
    (ExamplePermanentValidationReject(), False),
    (UnregisteredOpaqueRuntimeFault(), False),
])
def test_classification_matrix_drives_published_boolean(exc_kind, expected_bool, ...):
    ...
```

(Dummy fixture names stand in for whichever concrete plumbing the existing conftests provide.)

---

#### T4 — Key-Set Drift Guard

Add dedicated regression probes independent of happy-path flows:

```python
EXPECTED_WORKER_OUTBOUND_KEYS        = frozenset({"status", ERROR_MESSAGE_K, LEGACY_ERR_K, STAGE_K, RETRY_BOOL_K})
EXPECTED_API_CONSUMPTION_READSET     = frozenset({ERROR_MESSAGE_K, STAGE_K, RETRY_BOOL_K})

def test_no_new_keys_appear_without_tripwire():
    probe_frame = synth_minimal_valid_failure_event()
    observed_outbound = normalize(probe_frame.details.keys())
    unexpected_additions = observed_outbound - EXPECTED_WORKER_OUTBOUND_KEYS
    missing_expected     = EXPECTED_API_CONSUMption_READSET - observed_outbound
    assert not unexpected_additions and not missing_expected, \
        "Contract violation detected! Either drop the additions OR coordinate expansion."

def test_removed_key_blocks_ci_immediately(monkeypatch_gremlin):
    simulate_deletion_of_one_consumer_side_read(...)
    expect PipelineCrashSignal OR explicit SchemaMismatchAssertion raised upstream.
```

Registration location: alongside T3 within the same new file; marked with the SAME pytest marker group
for easy colocation-driven discovery.

---

#### T5 — Refresh impacted conventional-unit specs

Update narrowly scoped unit specs wherever they hard-coded the OLD outbound shape:

Likely candidates (confirm presence empirically before editing):
- `unit/workers/status_publisher_spec_module*.py`
- `unit/handlers/process_failure_handler_spec*.py`
- Shared contract dictionary fixtures living under `shared/testing_fixtures/rag_pipeline_events/*.yaml`
  or equivalent JSON twin — regenerate golden blobs reflecting expanded tuple width.

Principle: DO NOT delete superseded assertions wholesale; annotate obsolete ones with deprecation
comment pointing to this plan, then replace body with new-shape expectation to maintain historical
traceability for reviewers diffing blame history.

---

## 5. Validation Checklist ↔ Acceptance Mapping

Each criterion from the governing Definition receives ≥1 automated enforcement point AND a
human-executable spot procedure:

| Ref | Automated Enforcement Location(s) | Human Spot Check Procedure | Pass Condition |
|-----|------------------------------------|---------------------------|----------------|
| AC1 | T1 unit-spec; T4 outbound-keys tripline; T3 frame-capture assertions | Trigger forced timeout against staging deployment tail-kafka/topic listener dump | Frame contains populated `error_message`, plausible `stage` ∈ vocab, boolean typed `retryable` — none blank/null/default-filled |
| AC2 | T3 persistence roundtrip section; DB smoke script querying latest errored entity | Inspect Firestore console view of affected record | Stored triplet mirrors sender-supplied trio exactly; legacy filler string ABSENT from primary column |
| AC3 | T3 nested-subrecord deep-equality comparator extension | Expand record pane showing child lineage | Child copies equal parent originals bit-for-bit excluding generated IDs/timestamps |
| AC4 | Entirety of T3+T4 green badge in PR template checkbox region | Watch headless runner replay twice consecutively yielding stable outcomes | Suite exits 0; drift tripwires demonstrably fire upon induced mutation rehearsal (per §6 drill) |

Additionally enforce global hygiene gates inherited automatically: lint/format clean, dependency lock
integrity preserved, container image rebuild reproducibility intact (borrowing standard Make recipes
present in sibling pipelines — no bespoke additions required).

---

## 6. Pre-Landing Mutation Drill (Sanity Proof-of-Catchment)

Before declaring done, execute ONE throwaway experiment proving the tripwires bite:

1. Temporarily sabotage WORKER side: strip `stage` key from outbound frame.
2. Invoke targeted slice of T3 suite.
3. CONFIRM immediate abort citing missing-required-field clause.
4. Restore sabotage; repeat analogous strike against CONSUMER side (rename one expected lookup key).
5. Confirm symmetric detection. Document elapsed times + stack snippets appended to PR description
   as empirical evidence the net catches regressions bidirectionally.

Discard experimental modifications afterward (never land the sabotaged variants).

---

## 7. Sequencing / Coordination Notes

Recommended landing order minimizing intermediate breakage windows:

1. Land T2 (+ accompanying comment patches) FIRST — inert groundwork reducing cognitive load in reviews.
2. Follow with T3 scaffold registered behind temporary feature-flag/env-var toggle allowing opt-out
   during bringup instability (flag removable after stabilization window lapses, typically ≤1 sprint).
3. Ship T1 core logic gated similarly; enable flag internally; watch dashboards for anomaly spikes.
4. Once steady-state telemetry looks sane (~24h soak), remove toggles permanently via small follow-on
   commit bundling T5 refresh together with flag-scrap deletion.
5. Schedule T4 tripwire activation LAST so accidental collisions during bringup don’t spam alerts.

Total estimated calendar duration assuming solo engineer focus-block availability: ≈ 3.5 focused days
inclusive of soak monitoring overhead.

---

## 8. Known Unknowns / Deferred Items

Caveat A: Certain granular internals (precise parameter orders, private helper mnemonics, embedded
logging tags) remained unexamined because Investigation budget prioritized breadth-across-surfaces
over micro-depth-per-file. Resolution protocol: resolve ambiguously-named symbols nearest-match by
semantic role described herein; escalate genuine contradictions encountered between reality and
description to orchestrator for adjudication BEFORE proceeding further down conflicting paths.

Deferred Backlogs Spawned (track separately; OUT OF SCOPE HERE):
- [ ] Audit ledger enumerating every external subscriber to the relevant notification bus, aiming toward eventual retirement of the LEGACY duplication crutch introduced in §3.3.
- [ ] Proposal draft exploring structured severity taxonomies replacing freeform descriptive prose long-term (explicitly rejected for THIS engagement per mandate).
- [ ] Reconcile terminology glossaries between platform-wide wiki pages and localized team jargon scattered historically.

Companion ticket D3 mentioned obliquely in higher-level roadmaps remains administratively decoupled;
coordination handshake limited strictly to agreeing on the SHARED FIELD NAMES memorialized in §2 —
nothing more.
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
# Test Plan — rag-worker → rag-api Failure Payload Contract Alignment

Scope anchor: WorkItem `wi-define-108-a8` / artifact `definition:obj-108`
(sha256 `71f1c39c…89cac5`). Companion document: `docs/plan.md`.

---

## 1. Goal

Prove — mechanically, continuously, and bidirectionally — that whenever the RAG ingestion worker emits
a terminal-failure announcement, the receiving API ingests and persists a faithful copy of the
sender’s declared `(message, stage, retryable)` triple WITHOUT inserting placeholder junk, losing
information, or fabricating optimistic booleans; and conversely, that neither party can silently
alter the agreed communication envelope without triggering an obvious alarm.

Success metric: 100% automation coverage across the enumerated scenario grid (§3), with zero reliance
on manual eyeballing for routine regression defense.

---

## 2. Layered Coverage Strategy

Four complementary tiers, ordered cheapest-fastest first, collectively eliminating blind spots left
by any single technique:

| Tier | Technique | Primary Artifacts Produced | Speed Class | Flakiness Exposure |
|------|-----------|----------------------------|-------------|--------------------|
| L0 | Pure-function whitebox checks | Direct call-return comparisons | Milliseconds | Negligible (fully deterministic) |
| L1 | Component isolation w/ doubles | Captured-frame inspections | Seconds | Low (controlled stubbing) |
| L2 | Cross-component seam walkthrough | End-to-end transaction traces | Minutes | Moderate (timing-sensitive IO) |
| L3 | Production-shaped environment boot | Live-container behavioral snapshots | Many minutes | Higher (real network/storage quirks) |

Execution cadence recommendation: L0/L1 run pre-commit locally & intra-PR repeatedly; L2 gates merge
queue admission nightly-or-push-triggered; L3 reserved weekly cadence + release candidate builds only.

Environment prerequisites common to upper tiers:
- Local ephemeral storage emulator reachable at predictable coordinates (mirroring settings proven
  functional in adjacent e-commerce ingestion test rig located nearby — borrow bootstrap glue liberally
  rather than reinventing).
- Network namespace sandbox preventing unintended chatter with live cloud endpoints.
- Seeded baseline dataset representing pristine pre-event universe state enabling delta computations.

---

## 3. Scenario Grid (Exhaustive Enumerations)

Legend: ✅ = affirmative outcome desired · ❌ = inverse assertion · ⚠️ = nuanced dual-mode handling.

### Group A — Sender-Side Envelope Integrity (Tier L0/L1)

| # | Input Stimulus | Expected Observable Outcome | Maps To ReqID |
|---|----------------|------------------------------|---------------|
| A1 | Raise registered transient fault subtype mid-way through typical journey | Emitted frame carries non-empty `err_msg_body`, truthful stage stamp, `should_attempt_again=True` | REQ-WORKER-STAMP-STAGE / REQ-CLASSIFY-DRIVES-BOOL |
| A2 | Raise recognized unrecoverable domain rejection | Identical triplet topology except `should_attempt_again=False` | REQ-CLASSIFY-DRIVES-BOOL |
| A3 | Throw completely alien runtime object never seen by classifier subsystem | Conservative interpretation kicks in ⇒ `False`, preserving safety bias | REQ-CONSERVATIVE-FALLBACK |
| A4 | Interrupt occurring BEFORE any meaningful computation begins (immediate entry trapdoor) | Sentinel `"finalizing"` substituted for undefined positionality — NEVER raw null | REQ-VOCABULARY-CONSTRAINT |
| A5 | Interrupt AFTER every conceivable checkpoint traversed (terminal zone) | Last assigned legit descriptor retained faithfully | REQ-STAGE-TRACK-CORRECTNESS |
| A6 | Simulate interstitial gap: raise BETWEEN two consecutive checkpoints (artificially wedged) | Prior checkpoint designation carried onward — verifies sticky-last-known-good semantics | REQ-STICKINESS-INVARIANT |
| A7 | Exercise legacy alias channel simultaneously active | Duplicate string appears beside modern counterpart, both matching | REQ-HEDGE-CONTINUITY |

Negative-space complements:
- A8 ❌ Absence of forbidden placeholders: assert emitted blob DOES NOT contain magic words
  “generic”, “unknown”, “misc”, or empty-string sentinel anywhere in message slot.
- A9 ❌ Type discipline: reject possibility of numeric/string coercion sneaking past intended boolean.
- A10 ❌ Vocabulary membership whitelist: assert stage descriptor belongs exclusively to sanctioned
  seven-token roster defined earlier; foreign intrusions blocked outright.

### Group B — Receiver-Side Faithful Reproduction (Tier L1/L2)

For EACH sender variation in Group A, route synthesized traffic through authentic receiver pathway
into isolated backing store, then interrogate resultant durable record:

| # | Focus Dimension | Assertion Family | Maps To ReqID |
|---|------------------|------------------|---------------|
| B1 | Top-level fidelity | Exact equality among stored `err_desc_main`, incoming `msg_content`, and derived-from-sender counterparts | REQ-FAITHFUL-ECHO |
| B2 | Positional attribution accuracy | Stored positional tag IDENTICAL to sender-labeled origin point | REQ-POSITIONAL-ACCURACY |
| B3 | Boolean propagation honesty | Persisted attempt-flag EQUALS transmitted intention (never coerced/inverted) | REQ-BOOLEAN-INTEGRITY |
| B4 | Descendant synchronization | Nested children replicas exhibit perfect congruence regarding textual message + spatial cue | REQ-DESCENDANT-CONSISTENCY |
| B5 | Default suppression proof | Construct adversarial variant OMITTING optional knobs ⇒ confirm absence triggers graceful degradation WITHOUT resurrecting bogus optimism flags | REQ-NO-SILENT-FILLERS |
| B6 | Idempotent replays | Feeding identical stimulus twice consecutively produces indistinguishable persistent outcomes (modulo volatile metadata excluded canonically) | General Robustness |

Special attention corner-case:
- B7 ⚠️ Mixed-generation fleet simulation: pair NEW-style emitter speaking enhanced dialect AGAINST
  UNPATCHED legacy interpreter binary retained intentionally for comparison purposes. Expect partial
  comprehension (core concept understood, novel embellishments politely discarded) confirming smooth
  rolling-upgrade trajectory viability.

### Group C — Bidirectional Tripwire Effectiveness (Meta-Level Guards)

Purpose-built self-tests validating the validation apparatus itself:

| # | Sabotage Injected | Anticipated Reaction |
|---|-------------------|----------------------|
| C1 | Excise one REQUIRED member from producer enumeration | Immediate loud refusal citing specific deficit nomenclature |
| C2 | Rename singular anticipated retrieval handle on consumer introspection layer | Symmetric detonation pinpointing renegade transformation locus |
| C3 | Append innocuous-looking supplementary attribute onto outgoing blob | Permissive-yet-vocal warning logged; NOT treated as fatal breach (grace accommodates benign enrichment) |
| C4 | Swap ordinal positions of arguments fed downward chain | Caught by positional-binding sanity inspector raising complaint about misalignment |

Post-run obligation: attach captured diagnostic excerpts demonstrating each triggered reaction as
appendices inside associated pull-request commentary, furnishing tangible receipts.

### Group D — Longitudinal Stability & Performance Sanity (Tier L3, periodic)

Recurring scheduled evaluations ensuring sustained health beyond initial novelty horizon:

- D1 Throughput benchmark measuring sustained events/sec achievable under nominal operating posture,
  compared against trailing-week median trendline tolerance band ±15%.
- D2 Memory residency growth curve monitored across extended endurance loop detecting slow leak onset.
- D3 Chaos drilling occasionally severing connectivity mid-stream verifying resilient buffering +
  subsequent reconciliation completes correctly upon restoration, leaving zero stranded phantom rows.

Frequency & ownership assigned quarterly rotation duty among squad members sharing accountability.

---

## 4. Toolchain Configuration Specifics

Harness libraries presumed present already (leveraging installed dependencies within monorepo):
- Async orchestration driver compatible with contemporary Python concurrency idioms prevailing herein.
- Property/random-input generators supplying diverse malformed corpus specimens stressing parser
  resiliency edges (complementary fuzz-lite dimension augmenting hand-curated catalogue above).
- Golden-master archival utility storing blessed reference imagery permitting pixel/data-level
  differential inspection afterward.

Configuration knobs exposed for tunability:
```
ENV_VAR_STORAGE_ENDPOINT_OVERRIDE   # redirect backing-store destination dynamically
ENV_VAR_CLOCK_SKEW_SIMULATION_MS    # inject artificial temporal displacement stressors
ENV_VAR_LOG_VERBOSITY_CEILING       # dampen noisy chatty components during bulk sweeps
```

Invocation cheatsheet distilled for newcomer convenience:
```bash
make -f contrib/devtools.mk test-tier-low || echo "quick feedback loop interrupted"
./gradlew :platform-core:testSeamWalkthrough --rerun-tasks --info
docker compose --profile ci-full up --abort-on-container-exit --exit-code-from verifier-agent
```

(Substitute concrete recipe labels matching whatever canonical command interface governs this particular
corner of the organization — inspect neighbor configuration repositories for stylistic conformity cues
rather than inventing divergent syntax gratuitously.)

Reporting destinations configured to funnel summarized verdicts into centralized dashboard tile
dedicated specifically to pipeline-integrity metrics visibility, supplementing traditional textual
console spew with graphical glance-value for managerial oversight accessibility.

---

## 5. Defect Classification Rubric (When Failures Occur)

Standardized categorization streamlining triage responsiveness:

| Severity Band | Operational Meaning | Prescribed Response Window |
|---------------|---------------------|----------------------------|
| SEV-1 BLOCKER | Blocks merge queue advancement entirely | Hotfix priority resolution ASAP same-day |
| SEV-2 MAJOR | Functional correctness compromised yet workaround feasible manually | Address within current sprint cadence commitment |
| SEV-3 MINOR | Cosmetic/polish blemishes lacking functional bearing | Queue opportunistically amid slack capacity pockets |
| SEV-4 OBSERVATIONAL | Informational instrumentation tweaks suggested | Log improvement backlog indefinitely pending natural uptake opportunity |

Escalation ladder applies recursively upward whenever customer-visible symptomatology correlates
strongly with underlying technical glitch origins traced via correlation-ID breadcrumbs sprinkled
liberally throughout logging statements authored contemporaneously with the fixes themselves.

---

## 6. Sign-off Gate Criteria

Release readiness contingent upon simultaneous satisfaction of EVERY condition enumerated beneath:

✓ Full scenario-grid traversal executed freshly atop tip-of-tree revision hash recorded immutably.
✓ Cumulative defect tally standing ZERO unresolved items ranked SEV-1 or SEV-2 magnitude classes.
✓ Empirical receipt trail documenting successful tripwire demonstrations included visibly within
  associated changelog annotations for posterity’s sake.
✓ Peer reviewer endorsement secured acknowledging sufficiency adequacy judgment rendered honestly.
✓ Downstream stakeholder briefing delivered communicating implications succinctly ahead of rollout
  commencement notice broadcast widely.

Upon unconditional attainment thereof, formal promotion authorization granted instantiating production
propagation sequence initiation forthwith.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>