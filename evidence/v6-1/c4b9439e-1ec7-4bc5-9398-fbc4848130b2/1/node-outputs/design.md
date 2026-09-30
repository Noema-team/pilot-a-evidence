 Below are the design-step deliverables derived exclusively from the authoritative Definition (pinned `definition:obj-108`) and the limited repository inspection performed during this step (directory listings confirming `apps/ai-server/{rag-worker-service,rag-api-service}/main.py` and `apps/ai-server/tests/` exist). Statements sourced solely from the Definition's repository claims cite those evidence refs verbatim; the F8/F11 assumption statuses are preserved as ASSUMED.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — Worker→RAG-API Failure Payload Contract Alignment

Scope authority: Definition `definition:obj-108` (WorkItem `wi-define-108-a8`, sha256 `71f1c39c…95cac5`). Cycle intent: *"rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage"*.

## 1. Problem statement

When a RAG processing job fails, the worker's exception handler publishes a one-key failure payload (`{"error": str(e)}`, Fact F3) while rag-api's failed branch in `run_transactional_update` reads three keys (`error_message`, `stage`, `retryable`, Fact F4). Result (Fact F5): every worker-originated failure persists —

| Persisted field | Value observed |
|---|---|
| `error` | fallback `"Processing failed"` (should be the real exception message) |
| `error_stage` | `None` (should be the failing pipeline stage) |
| `retryable` | silent default `True` (never derived) |

The `processing/summary` error subdocuments inherit the same fallbacks, with `error_code` permanently `"UNKNOWN"`. Three other writers — the worker's stale-lease sweep `_fail_if_still_stale`, rag-api's `/process` and `POST /resources` enqueue-failure paths — plus `models/resource.py` (`ResourceResponse`, `Resource` with `retryable=True` default) already speak the `error`/`error_stage`/`retryable` schema (Fact F6). The worker's status publisher is the sole non-conforming writer.

Additionally, the failure handler lacks stage awareness: `process_document` publishes named progress stages (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`, `completed`) but tracks none for failure reporting (Fact F9).

## 2. Functional requirements

FR-1 — Complete failure payload (Definition acceptance #1).
The worker's failed-status publication MUST contain all three contract keys:
- `error_message`: the actual exception message (`str(e)`),
- `stage`: the pipeline stage executing at failure time,
- `retryable`: a value deliberately computed by the worker.

No worker-originated failure payload MAY omit any of these keys nor depend operationally on rag-api's `details.get(...)` fallbacks (Constraint: must). Per F11 (ASSUMED hedged compatibility choice), the worker SHALL also retain the legacy `error` key carrying the same message as `error_message`.

FR-2 — Stage tracking through the pipeline (Acceptance #1).
`process_document` MUST maintain a current-stage indicator updated immediately before each pipeline step, whose reported name reuses the existing progress-vocabulary values: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`. Where execution could plausibly fail outside any tracked region (genuinely unknown), the reported stage SHALL be `"processing"` — the same sentinel used by the stale-lease sweep — ensuring `error_stage` never regresses to null.

FR-3 — Explicit retryable derivation (Constraints: must ×2).
The worker MUST compute `retryable` from `classify_error(e)` (Fact F7):

| Classification | Published/persisted `retryable` |
|---|---|
| Transient (incl. `TransientError`, type/status-code heuristic hits) | `true` |
| Permanent (incl. `PermanentError`, unclassified-unknown per conservative default) | `false` |

Rationale (F8, ASSUMED adopted default): mirrors the worker's own ACK/NACK decision — transient ⇒ Pub/Sub redelivery expected; permanent ⇒ acked, recovery via manual `POST /process`. Known consequence: previously-defaulted `retryable:true` for unrecognized exceptions becomes `false`; accepted by definition rationale.

FR-4 — rag-api passthrough fidelity (Acceptance #2, #3).
In the failed branch, rag-api MUST persist worker-supplied values unchanged:
- Main document: `error ← payload.error_message`, `error_stage ← payload.stage`, `retryable ← payload.retryable`.
- Processing/summary error subdoc: same message and stage; `error_code` remains `"UNKNOWN"` absent an explicit code (prefer-not constraint on introducing a taxonomy).

Neither service's persisted-schema names change (constraint: must_not migrate/rename/backfill).

FR-5 — Bidirectional contract test (Acceptance #4).
A contract test MUST exercise the worker's failure-payload construction AND rag-api's failed-branch persistence (Firestore emulator or fakes — Fact F10 confirms feasibility using existing fixtures/AST patterns in `tests/integration/test_api_contracts.py` and both services' `FIRESTORE_EMULATOR_HOST` branches) asserting persisted `error == worker error_message`, `error_stage == worker stage`, `retryable == worker retryable`. It MUST additionally pin the key-set shape of both producer and consumer such that adding/removing/drifting keys on either side breaks the suite. Coverage anchors: at minimum one early-stage failure and one late-stage failure scenario (anti-drift for FR-2 without ossifying every step).

## 3. Non-goals (from Definition)

- Stale-lease sweep behavior (already conformant direct write; its `retryable=true` remains correct — a dead worker is inherently transient, cf. F8).
- Retry/backoff mechanics: ACK/NACK policy, leases, heartbeats — only *reported* retryability changes.
- Frontend/mobile: `ResourceResponse` already exposes `error`/`error_stage`.
- Structured error-code taxonomy (`error.code` stays `"UNKNOWN"` unless actually sent).
- Companion D3 issue scope (unavailable here; deferred per F12, along with reconciliation to the missing `plans/upload-flow.md` D4 note).

## 4. Constraints & preferences recap

Must: worker aligns to API contract (no API-read/schema changes); retryable always explicit. Must-not: migrations/renames/backfills. Prefer: retain legacy `error` key. Prefer-not: error-code taxonomy.

## 5. Acceptance criteria (traceable to Definition acceptance list)

AC-1..AC-4 correspond verbatim to Definition acceptance items #1–#4; FR-1↔AC-1+2, FR-2↔AC-1/2(stage portion)+test anchor, FR-3↔AC-2(retryable), FR-4↔AC-2+3, FR-5↔AC-4. Each begins `met:false` until implemented.
<<<END-SLE-ARTIFACT>>>

<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — Worker→RAG-API Failure Payload Contract Alignment

Authority: Definition `definition:obj-108`; Facts cited as F#. Repo-layout confirmation from direct directory inspection of `apps/ai-server/` this step (both `rag-worker-service/main.py` and `rag-api-service/main.py` exist; `tests/` subtree present).

## 1. Contextual view

Two cooperating services exchange failure state asynchronously:

```
rag-worker-service                      rag-api-service
────────────────────                    ──────────────────
process_document                        status subscriber
  ├─ stage N ...                          └─ run_transactional_update
  │     (await steps)                           failed branch:
  └─ except e:                                  error        ← error_message
      publish_failure(status msg)               error_stage  ← stage
                                                retryable    ← retryable
stale-lease sweep  ──(direct write:              processing/summary err subdoc
   error/error_stage/retryable=true)             {message, stage, code:"UNKNOWN"}
enqueue-failures (/process, POST /resources)     Resource doc (persisted schema)
                                                 ResourceResponse (client surface)
```

Contract seam = the worker's failed-status message body vs. rag-api's read-and-persist mapping. Today's defect lives entirely at that seam (F3+F4+F5); all adjacent surfaces (`Resource`/`ResourceResponse` models, sweep, enqueue-failure paths) already agree on `error`/`error_stage`/`retryable` (F6). Therefore the architectural locus-of-change is confined to the worker publisher plus pass-through verification in rag-api — no cross-cutting refactor.

## 2. Component responsibilities after the fix

### 2.1 rag-worker-service / main.py

(a) Pipeline stage tracker (new internal concern inside `process_document`)
- Local mutable holder initialized to a pre-start sentinel resolving to `"processing"` on report-time uncertainty.
- Convention (design rule enforced by review + test anchoring): the holder is assigned *immediately before each awaited pipeline step*, using the existing progress-stage strings emitted by `_publish_status_update` (F9). Reusing this vocabulary keeps client-visible timelines coherent: a failure event naming `chunking_complete` sits naturally beside prior progress events of identical labels.
- The exception handler serializes this snapshot into the failure payload. Risk noted in Definition: future steps added without setting the tracker report a stale predecessor stage — accepted, guarded by representative-stage contract scenarios (early + late failure).

(b) Exception-handler payload builder (modified `except` arm)
Emitted object gains the worker-derived trio while preserving backward readability (per F11, ASSUMED-hedge retained):

```
{
  "status": "<failed>",
  "error":         <same string>,   # legacy key retained (compatibility hedge)
  "error_message": str(e),
  "stage":         <tracked stage>,
  "retryable":     classify_error(e) == TRANSIENT   # i.e., true iff transient
}
```

(c) Retryable derivation (reuses F7 machinery)
Single-source-of-truth call into existing `classify_error()`, which already powers ACK/NACK in `run_worker`. Mapping table per FR-3 above. Consequence documented in Definition: unclassified-unknown flips from implicit-`true` to explicit-`false` (conservative-by-design; manual reprocess unaffected). The sweep's independent `retryable=true` write is intentionally untouched (dead-worker ⇒ transient condition, per F8 rationale).

(d) Unchanged subsystems: transport/Publisher wiring, lease/heartbeat logic, ACK-NACK routing — purely observability additions; no control flow alters which messages get retried versus acknowledged.

### 2.2 rag-api-service / main.py

Failed branch of `run_transactional_update` keeps its existing key expectations (`error_message`, `stage`, `retryable`) and its persisted-field mapping (F4). Architecturally it becomes the *contract sink*: once FR-1 supplies real values, the branch behaves correctly as-is — the only permitted modification is whatever minimally guarantees faithful passthrough (i.e., no transformation/fallback dependence for these three keys under normal operation). Its `error_code="UNKNOWN"` default in the processing/summary subdoc stands (taxonomy avoided per prefer-not).

Persisted-document effect post-fix (target-state invariant asserted by AC-2/AC-3):

| Field | Before | After |
|---|---|---|
| `resource.error` | `"Processing failed"` | worker's `str(e)` |
| `resource.error_stage` | `null` | failing stage label |
| `resource.retryable` | `true` (default) | classifier verdict |
| proc/summary `{message, stage}` | fallback/null | mirrored worker values |
| proc/summary `error_code` | `"UNKNOWN"` | `"UNKNOWN"` (unchanged) |

### 2.3 Shared contract module consideration

Because producer (worker) and consumer (API) live in sibling packages under `apps/ai-server/`, the canonical key tuple may either remain duplicated-as-tested or be lifted into a shared constant imported by both production modules and the test. Recommended: lift to a small shared constants location IF such a package already exists between the two services (to be confirmed during implementation planning); otherwise duplication-with-pin is acceptable given the tiny surface. Decision criterion: avoid creating new packaging topology merely for five strings.

## 3. Testing architecture

Extends the existing fixture-/AST-pattern harness at `apps/ai-server/tests/integration/test_api_contracts.py` (F10):

Layer 1 — Producer conformance (unit/static): construct a synthetic exception deep in the pipeline; invoke the worker's failure-payload assembly; assert presence/exactness of `error_message`/`stage`/`retryable` (+legacy `error` equivalence). Optionally an AST check that each pipeline step site precedes a tracker assignment (cheap anti-regression supplement to behavioral cases).

Layer 2 — Consumer conformance (integration/hermetic): route Layer-1's produced dict through rag-api's failed branch inside `run_transactional_update` backed by either the Firestore emulator (leveraging both services' `FIRESTORE_EMULATOR_HOST` branches) or equivalent transaction-aware fake; assert the four persisted outcomes tabulated in §2.2.

Layer 3 — Drift guards: bidirectional key-shape assertions (producer emits superset-equal-to/consumer expects subset-equal-to the pinned triple+optional legacy key), so unilateral edits fail CI symmetrically.

Scenario matrix mandated by FR-5: ≥1 early-stage failure (verifies initial/sentinel handling and `starting`-adjacent labeling) and ≥1 late-stage failure (verifies tracker survives long pipelines, e.g. around `embeddings_complete`).

Hermiticity notes: no real GCP dependencies needed beyond whichever storage backing the chosen layer supports; deterministic exceptions injected rather than induced externally, keeping runtime fast and flake-free.

## 4. Data & compatibility posture

- Zero-migration guarantee honored: stored field names (`error`, `error_stage`, `retryable`) immutable; only their *values* become truthful (must-not constraint satisfied by construction — we touch neither names nor readers).
- Topic-compatibility hedge: extra `"error"` byte-string costs negligible bandwidth/topic size; removal deferred until any hypothetical secondary consumer audits confirm exclusivity (explicitly framed in Definition as possible follow-up cleanup, not part of this cycle).
- Backward data coexistence: historical rows bearing `"Processing failed"/null/true` remain valid under unchanged schema; no normalization duty arises.

## 5. Deployment & rollout

Both services deploy independently-safe orderings: shipping worker-first yields immediate correctness gain (payload keys land harmlessly unused until API ships — though API already consumes them, so either ordering works); there is no version-skew hazard because the wire addition is additive and the consumer predates it. Rollback safety likewise holds (extra keys ignored by older consumers).

## 6. Traceability

Requirement ↔ Design element ↔ Verification:
- FR-1 → §2.1(b) payload builder → L1 + L3 tests → AC-1.
- FR-2 → §2.1(a) tracker + convention → L1/L2 scenario pair → AC-1/AC-2 (stage aspect) + AC-4 anchor.
- FR-3 → §2.1(c) classifier hookup → L1 assertion + L2 persisted-value match → AC-2.
- FR-4 → §2.2 passthrough discipline → L2 assertions incl. mirror-subdoc equality → AC-2/AC-3.
- FR-5 → §3 layered suite w/ dual-sided drift pins → AC-4.

Deferred/out-of-scope placements respected throughout: no sweep modifications (§2.1d boundary), no retry-engine edits (§2.1d), no frontend coupling (consumption happens downstream of exposed `ResourceResponse`), no taxonomic expansion (§2.2), and companion-issue territory fenced off (framed as external dependency boundaries rather than interfaces defined herein).
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>