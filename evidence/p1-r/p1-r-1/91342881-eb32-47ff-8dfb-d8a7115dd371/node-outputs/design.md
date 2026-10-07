Investigation closed. The two artifacts below are grounded in the authoritative definition (`wi-define-108-a8`) plus what I directly verified this session: the worker's `process_document` exception handler and `_publish_status_update` (one-key `{"error": str(e)}` payload, `jobId` enrichment, sequence reset), `classify_error`'s exact semantics, the stale-lease sweep's direct `error`/`error_stage`/`retryable` write, rag-api's `run_transactional_update` failed branch (reads `error_message`/`stage`/`retryable` with fallbacks; transition guard `processing→failed`), the `Resource` model's failure fields, and the existing contract-test patterns in `apps/ai-server/tests/integration/test_api_contracts.py`. Anything I could not read (conftest bootstrap, fixture contents, `models/processing_status.py`, `exceptions.py`, enqueue handlers) is preserved as explicitly unknown rather than invented.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api failure payload contract alignment

- **Cycle intent:** `rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage`
- **Run:** 91342881-eb32-47ff-8dfb-d8a7115dd371 · Iteration 1 · Step: design
- **Authoritative source:** define-work WorkItem `wi-define-108-a8`, artifact `definition:obj-108`
  (sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`). This document restates and
  refines that definition; on any disagreement, the definition wins.
- **Evidence legend:** `[V]` verified by direct repository read this cycle · `[D]` asserted by the authoritative
  definition · `[U]` unverified / unknown at design time.

Key pinned sources read this cycle:
- `apps/ai-server/rag-worker-service/main.py` (sha256 `7d7718bcbeb2e219dab14e285a66e62ea5883c209981a0be91cc29b490569988`)
- `apps/ai-server/rag-api-service/main.py` (sha256 `579b0bdfff8f97ee81112251ec7380b392f4aa7c38d216cd56d1782a34ed2744`)
- `apps/ai-server/rag-api-service/models/resource.py`
- `apps/ai-server/tests/integration/test_api_contracts.py` (sha256 `cb073c277ca5bed369e492916e258a24c60b0b01039fad6f65df9c1475bc5ea8`)

---

## 1. Problem statement

The worker's failure publisher and rag-api's failure consumer were written against different contracts, and no test
covers the seam.

- The worker's `process_document` exception handler publishes failed status with a one-key payload:
  `{"error": str(e)}`. `[V]`
- rag-api's failed branch (`run_transactional_update`) reads three keys — `error_message`, `stage`, `retryable` —
  and persists them as `error` / `error_stage` / `retryable` on the main resource document, with fallbacks
  `"Processing failed"`, `None`, and `True` respectively. It also writes `message`/`stage` (and `error_code`
  defaulting to `"UNKNOWN"`) into the `processing/summary` error subdocument. `[V]`
- Consequence `[V]`: every worker-originated failure persists `error = "Processing failed"` (fallback string),
  `error_stage = None`, and a fabricated `retryable = true`. The `processing/summary` subdocument inherits the same
  fallbacks with `error_code` always `"UNKNOWN"`.
- The persisted failure schema `error` / `error_stage` / `retryable` is already established across three other
  write paths and both response models: the worker's stale-lease sweep writes it directly `[V]`, rag-api's
  enqueue-failure paths write it directly `[D]`, and `Resource` (and per the definition `ResourceResponse`) expose
  it, with `retryable` defaulting `True`. `[V]` for the model; `[D]` for `ResourceResponse`.

The worker's status publisher is the only writer that does not speak the established schema.

## 2. Scope

**In scope**
- The worker's failure-payload construction: keys, stage tracking through `process_document`, and deliberate
  `retryable` derivation.
- Retention of the legacy `error` key in the worker's failure payload as a compatibility hedge.
- A contract test covering the worker failure → rag-api persistence path, including key-drift guards.
- Supporting unit verification of the stage-tracking mechanism.

**Out of scope (non-goals, from the definition)**
- Changing the stale-lease sweep's direct failure write (already schema-consistent).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the
  *reporting* of retryability changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage`.
- Introducing structured error codes or a failure taxonomy — `processing/summary` `error.code` remains `"UNKNOWN"`
  unless a code is actually sent (the worker will not send one).
- Any scope the companion D3 issue covers beyond this payload alignment (its content is unavailable in this
  context; deferred). `[D]`
- Reconciling this analysis with the D4 deviation note in `plans/upload-flow.md` (file not present in the current
  tree). `[D]`

## 3. Functional requirements

### FR-1 — Failure payload completeness
When document processing fails, the worker's failed status `details` payload **must** include:
- `error_message`: the actual exception message (`str(e)`),
- `stage`: the pipeline stage executing at failure time (per FR-2),
- `retryable`: a deliberately derived boolean (per FR-4).

The payload must never rely on rag-api's fallback defaults (`"Processing failed"`, `None`, `True`) for these keys.
Rationale: F1/F5 of the definition. Verification: TR-1–TR-4, TR-7.

### FR-2 — Stage tracking through `process_document`
The worker must track the currently executing pipeline stage so the failure handler reports the true failing stage.
- Stage names **must** reuse the existing progress-stage vocabulary: `starting`, `text_retrieved`,
  `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`. `[V]` — these are exactly
  the stage values the worker already publishes in progress updates.
- `processing` is the safe value when the stage is genuinely unknown (it is also the value the stale-lease sweep
  uses for `error_stage`, so the field never regresses to null). `[V]` for the sweep's value.
- `completed` is **not** a valid failure stage: a job that fails never reports stage `completed`.
- Convention: the tracker is set immediately before each pipeline step (see the mapping table in §4.3).
Verification: TR-7 (early and late pipeline positions), TR-5 (handler wiring).

### FR-3 — rag-api persistence fidelity (no rag-api production change)
rag-api's failed branch must persist the worker-provided values unchanged:
- main document: `error ← details.error_message`, `error_stage ← details.stage`, `retryable ← details.retryable`;
- `processing/summary` subdocument: `error.message` and `error.stage` carry the same message and stage; `error.code`
  remains the `"UNKNOWN"` default because the worker sends no `error_code`.

This is rag-api's **existing, verified** behavior `[V]`; the requirement is that the aligned system exhibits it and
that the contract test pins it. No rag-api production code changes. Verification: TR-1, TR-2.

### FR-4 — Explicit `retryable` derivation
The worker must derive `retryable` from its existing classifier `classify_error(e)` `[V]`:
- transient-classified errors → `retryable: true`,
- permanent-classified errors — including unclassified-unknown exceptions, per `classify_error`'s conservative
  default — → `retryable: false`.

The derivation must be explicit on every worker-originated failure; the API-side `details.get("retryable", True)`
fallback must not be the operative mechanism for worker failures. Rationale (definition F8): this aligns the
persisted record with the worker's actual ACK/NACK behavior in `run_worker` — transient errors are redelivered by
Pub/Sub; permanent errors are acked and require manual reprocess via `POST /process`. `[V]` for the ACK/NACK use
of `classify_error`; `[D]` for the manual-reprocess path.

### FR-5 — Legacy key retention
The worker's failure payload retains the legacy `error` key alongside `error_message` (same string value), for
continuity with any unknown existing consumers of the status topic and log tooling. (Definition constraint
`prefer`, adopted as a requirement per F11.) rag-api ignores the legacy key — it reads `error_message`. `[V]`

### FR-6 — Contract test on the worker→rag-api failure path
A contract test must:
- exercise the **worker's** failure-payload construction (real worker code, not a fixture restatement),
- exercise **rag-api's** failed-branch persistence (`run_transactional_update`) via the Firestore emulator or fakes,
- assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values,
- assert main-document / `processing/summary` parity (message and stage),
- cover an early-stage failure and a late-stage failure,
- fail if either side's payload keys drift.

Verification: TR-1–TR-5. Existing infrastructure: `apps/ai-server/tests/integration/test_api_contracts.py`
(fixture- and AST-based static contract tests) and Firestore-emulator branches in both services. `[V]`

## 4. Data contracts

### 4.1 Worker → status topic: failure message (envelope unchanged, `details` aligned)
Envelope (verified `_publish_status_update` behavior, unchanged): `user_id`, `course_id`, `resource_id`,
`status = "failed"`, `details`, `timestamp`, `sequence`; `details.jobId` is injected when a `job_id` is provided;
the per-resource sequence counter resets on terminal states.

`details` contract for `status = "failed"` (new):

| key             | type   | presence   | semantics                                                  |
|-----------------|--------|------------|------------------------------------------------------------|
| `error_message` | string | required   | actual exception message (`str(e)`)                        |
| `stage`         | string | required   | failing pipeline stage; vocabulary per §4.3                |
| `retryable`     | bool   | required   | derived per §4.4; never silently defaulted                 |
| `error`         | string | required   | legacy duplicate of `error_message` (compatibility hedge)  |

No `error_code` key is sent (prefer-not constraint; summary `error.code` stays `"UNKNOWN"` via the API default).

### 4.2 rag-api failed-branch persistence (unchanged; verified target behavior)
- Main document: `status = "failed"`, `error`, `error_stage`, `retryable`, `status_updated_at`,
  `updated_at`, `schema_version = 2`. Exact fallbacks today: `error ← details.get("error_message",
  "Processing failed")`; `error_stage ← details.get("stage")` (no fallback → `None` if absent);
  `retryable ← details.get("retryable", True)`.
- `processing/summary` subdocument: `stage ← details.get("stage", "unknown")`, `progress ← details.get("progress", 0)`,
  `updated_at`, and `error = {code: details.get("error_code", "UNKNOWN"), message: details.get("error_message",
  "Processing failed"), stage: details.get("stage")}`.
- Transition guard: `failed` is reachable only from `processing` (`ALLOWED_TRANSITIONS`); a `failed → failed`
  update no-ops. Contract tests must seed status `processing`.

### 4.3 Stage vocabulary and tracker mapping
Semantics: **`stage` names the pipeline phase that was executing at failure time**, using the vocabulary label of
that phase. A failure stage may therefore name a milestone whose progress event was never published (e.g. an
extraction failure reports `text_retrieved` although the `text_retrieved` progress update never fired) — this is
intentional.

| Pipeline phase (verified call sites in `process_document`)                       | Tracker set before | Value                |
|-----------------------------------------------------------------------------------|--------------------|----------------------|
| Request validation (`_validate_processing_request`) + initial publish             | yes                | `starting`           |
| Text retrieval (`_get_extracted_text`, incl. Firestore reads / extraction)        | yes                | `text_retrieved`     |
| Tagging (`content_tagger.generate_tags`)                                          | yes                | `tagging_complete`   |
| Summary generation + `ragDescription` Firestore write                             | yes                | `summary_generated`  |
| Chunking (`_create_enhanced_chunks`)                                              | yes                | `chunking_complete`  |
| Embedding generation (`_generate_embeddings_with_openrouter`)                     | yes                | `embeddings_complete`|
| Vector delete + vector store + metadata save (post-embedding window)              | no (inherits)      | `embeddings_complete`|
| Before the first assignment (defensive init)                                      | —                  | `processing`         |

Notes grounded in verified swallow behavior: tagging and the summary LLM call swallow their own exceptions (they
cannot raise into the handler); the raisable steps in the summary phase are the `ragDescription` Firestore writes;
in the post-embedding window, `delete_old_vectors_via_service` and `_save_processing_metadata_to_subcollection`
swallow, so `store_chunks_via_service` (partial-write `RuntimeError`, transport errors) is the realistic raisable
step reporting `embeddings_complete`. The post-embedding window has no dedicated vocabulary entry; inheriting
`embeddings_complete` is a documented, accepted imprecision (see architecture §7).

### 4.4 `retryable` derivation table
| Exception class at failure time                                  | `classify_error` | Published `retryable` | ACK/NACK behavior (unchanged)          |
|------------------------------------------------------------------|------------------|-----------------------|----------------------------------------|
| `TransientError`; `httpx.ConnectError/ConnectTimeout/ReadTimeout/WriteTimeout/PoolTimeout`; `ConnectionError`; `TimeoutError`; `asyncio.TimeoutError`; `HTTPStatusError` with 429/500/502/503/504 | transient | `true`  | NACK → Pub/Sub redelivers |
| `PermanentError`; other `HTTPStatusError` (4xx except 429)        | permanent        | `false`               | acked; manual reprocess via `POST /process` |
| Unclassified-unknown (conservative default)                       | permanent        | `false`               | acked; manual reprocess via `POST /process` |

The stale-lease sweep's direct write (`retryable: true`, `error_stage: "processing"`) is unchanged and stays
correct: a dead worker is a transient condition.

## 5. Constraints (from the authoritative definition)

- **must** — The worker aligns to rag-api's existing contract (`error_message`/`stage`/`retryable`); rag-api's
  reads and persisted schema are not changed.
- **must_not** — No Firestore migration, field rename, or backfill of existing documents; persisted fields
  (`error`, `error_stage`, `retryable`) keep their names and semantics.
- **must** — Every worker-originated failure payload carries `retryable` explicitly (deliberately derived); the
  API-side fallback must not be the operative mechanism for worker failures.
- **prefer** — Retain the legacy `error` key alongside `error_message`.
- **prefer_not** — Do not introduce a structured error-code taxonomy.

## 6. Behavioral change register

| Persisted field (failed job) | Before (verified)                          | After                              |
|------------------------------|--------------------------------------------|------------------------------------|
| `error`                      | `"Processing failed"` (fallback)           | actual exception message           |
| `error_stage`                | `None`                                     | failing stage per §4.3             |
| `retryable`                  | `true` (silent default)                    | derived per §4.4                   |
| summary `error.message`/`stage` | fallback message / `None`               | actual message / failing stage     |
| summary `error.code`         | `"UNKNOWN"`                                | `"UNKNOWN"` (unchanged)            |

Deliberate behavior change: unclassified-unknown failures move from persisted `retryable: true` to `false`
(conservatism of `classify_error`; prevents infinite retry loops; manual reprocess unaffected). No other behavior
changes: ACK/NACK policy, leases, heartbeats, the sweep, and all progress/completed publishes are untouched.

## 7. Acceptance criteria (from the definition) and verification mapping

1. **Payload completeness** — the worker's failed status message contains `error_message`, `stage`, `retryable`,
   none relying on rag-api's fallback defaults. → FR-1, FR-2, FR-4; TR-1–TR-4, TR-7.
2. **Persisted fidelity** — after a failed job, the resource document has `error` = actual message (not
   `"Processing failed"`), `error_stage` = failing stage (not `None`), `retryable` = worker-derived value.
   → FR-1, FR-3, FR-4; TR-1–TR-3.
3. **Subdocument parity** — `processing/summary` error carries the same message and stage as the main document.
   → FR-3; TR-1, TR-2.
4. **Contract test exists and passes** — exercises worker payload construction through rag-api failed-branch
   persistence, asserts persisted equality, fails on either side's key drift. → FR-6; TR-1–TR-5.

## 8. Test requirements

- **TR-1 (P0, contract)** Seam happy path, early stage: seed a `processing` resource (Firestore emulator or fake);
  build the failure payload through the worker's real payload builder with a distinctive message and stage
  `text_retrieved` and derived `retryable`; run rag-api's `run_transactional_update` with `new_status = "failed"`;
  assert main-doc `error`/`error_stage`/`retryable` equal the worker values and `summary.error` parity
  (`code == "UNKNOWN"`). Doubles as the API-side drift guard (an API-side key rename collapses to fallbacks and
  fails the equality asserts).
- **TR-2 (P0, contract)** Same as TR-1 with a late stage (`embeddings_complete`) and `retryable: false`.
- **TR-3 (P0, contract/derivation)** Retryable polarity: a transient-classified exception yields payload
  `retryable: true`; a permanent-classified and an unclassified-unknown exception each yield `false` — derived via
  the worker's real `classify_error`.
- **TR-4 (P0, contract)** Key-set drift guard: the builder's output key set is exactly
  `{error_message, error, stage, retryable}` (assert before `_publish_status_update`'s `jobId` enrichment).
  Catches worker-side shape changes in either direction.
- **TR-5 (P0, static)** Handler-wiring guard (AST, mirroring existing patterns in `test_api_contracts.py`): the
  `process_document` except handler's failed publish routes through the shared payload builder with the tracked
  stage and `classify_error`-derived retryable — catches regression to an inline `{"error": ...}` dict.
- **TR-6 (P2, static)** Envelope pass-through guard: `_process_status_message` forwards `payload["details"]` to
  `run_transactional_update` unfiltered (cheap AST check; hardening beyond the definition's minimum).
- **TR-7 (P0, unit)** Tracker mechanism: drive `process_document` with stubbed pipeline steps that raise at an
  early position (validation → stage `starting`) and a late position (vector store → stage `embeddings_complete`,
  proving the inheritance rule); capture the published failure details via a stubbed `_publish_status_update` and
  assert stage, key set, and derived retryable. Lives with the worker's unit tests
  (`apps/ai-server/rag-worker-service/tests/unit/`).

## 9. Unknowns and deferred items (preserved, not invented)

- `[U]` Contents of `apps/ai-server/tests/integration/conftest.py` (import bootstrap / emulator provisioning for
  the integration tests) — the new contract test must reuse whatever bootstrap makes
  `import main as rag_api_main` work in `test_api_contracts.py` today.
- `[U]` Contents of `apps/ai-server/tests/fixtures/api-contracts/` (the new test is expected to need no new
  fixtures because it exercises real code on both sides).
- `[U]` Contents of `apps/ai-server/rag-worker-service/models/processing_status.py` and
  `apps/ai-server/rag-worker-service/exceptions.py` (both exist; neither read).
- `[U]` The exact bootstrap by which worker unit tests import `main.py` (inferred to exist because
  `tests/unit/test_processing_lease.py` targets functions defined in `main.py`; specifics unread).
- `[U]` Identities of any status-topic consumers other than rag-api's subscriber (mitigated by FR-5's hedge).
- `[D]` Companion D3 issue scope — unavailable; deferred. `plans/upload-flow.md` absent from the tree; deferred.

## 10. Traceability matrix

| Requirement | Definition anchor | Acceptance | Verification |
|-------------|-------------------|------------|--------------|
| FR-1 | requirements 1; facts F1, F3, F4, F5 | 1, 2 | TR-1, TR-2, TR-4, TR-7 |
| FR-2 | requirements 2; facts F9 | 1, 2 | TR-5, TR-7 |
| FR-3 | requirements 3; facts F4, F6 | 2, 3 | TR-1, TR-2 |
| FR-4 | requirements 4; facts F7, F8 | 1, 2 | TR-3 |
| FR-5 | constraints (prefer); fact F11 | 1 (indirect) | TR-4 |
| FR-6 | requirements 5; fact F10 | 4 | TR-1–TR-5 |
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api failure payload contract alignment

- **Run:** 91342881-eb32-47ff-8dfb-d8a7115dd371 · Iteration 1 · Step: design
- **Companion document:** `docs/requirements.md` (FR/TR numbering used below is defined there).
- **Evidence legend:** `[V]` verified by direct repository read · `[D]` asserted by the authoritative definition ·
  `[U]` unverified / unknown at design time.

## 1. Design direction and principles

1. **The worker aligns to the API, not the reverse.** The persisted failure schema (`error`, `error_stage`,
   `retryable`) is already consistent across the worker's stale-lease sweep `[V]`, rag-api's enqueue-failure
   paths `[D]`, and the `Resource` model `[V]` (`ResourceResponse` per definition `[D]`). The worker's status
   publisher is the single deviating writer. Fixing the API side would ripple across every other writer and both
   response models and would flirt with a schema change — violating the `must_not` constraint. Fixing the worker
   is a single-sided change with zero migration, backfill, or reader changes.
2. **Derive, don't default.** `retryable` must be computed from the classifier the worker already trusts for
   ACK/NACK decisions, so the persisted record tells the truth about what Pub/Sub will do next.
3. **The seam is pinned by a test that imports both sides**, rather than a fixture that restates the contract and
   drifts with it.
4. **Failure reporting must not itself fail.** The payload builder is total (defensive normalization); a failure
   in failure reporting must never suppress the failed-status publish.

## 2. Verified system context: the failure path today

```
process_document (rag-worker-service/main.py)
  └─ try: pipeline steps, each followed by _publish_status_update(..., "processing", {"stage": <milestone>, ...})
     ├─ milestones published [V]: starting, text_retrieved, tagging_complete,
     │                            summary_generated, chunking_complete, embeddings_complete,
     │                            then "completed" (stage "completed", progress 100)
     └─ except Exception as e:
          metrics.error_message = str(e)
          _publish_status_update(..., "failed", {"error": str(e)}, job_id)   ← the entire bug [V]

_publish_status_update [V]:
  - injects details["jobId"] when job_id provided
  - envelope: {user_id, course_id, resource_id, status, details, timestamp, sequence}
  - sequence reset on "completed"/"failed"; lease heartbeat write (status_updated_at)
  - publishes JSON to RAG_STATUS_TOPIC; swallows its own publish errors

Pub/Sub rag-status-updates
  └─ rag-api _process_status_message [V]:
       - parses payload; resolves canonical path users/{uid}/resources/{rid} first,
         legacy course path as fallback
       - run_transactional_update(db, doc_ref, new_status, details, logger, user_id) in a thread
            └─ ALLOWED_TRANSITIONS: processing → {completed, failed}  [V]
               failed branch [V]:
                 main:  error   = details.get("error_message", "Processing failed")
                        error_stage = details.get("stage")                # no fallback → None
                        retryable = details.get("retryable", True)
                 summary/processing subdoc:
                        stage = details.get("stage", "unknown"); progress = details.get("progress", 0)
                        error = {code: details.get("error_code", "UNKNOWN"),
                                 message: details.get("error_message", "Processing failed"),
                                 stage: details.get("stage")}
```

Also verified and relevant:
- `classify_error(e) -> bool` in the worker: `True` (transient) for `TransientError`, the listed httpx connection/
  timeout types, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError`, and `HTTPStatusError` with 429/500/
  502/503/504; `False` (permanent) otherwise, **including unclassified-unknown exceptions** (conservative default
  against infinite retry loops). `run_worker` uses it for ACK/NACK: transient → omitted from ack batch
  (redelivered); permanent → acked. `[V]`
- Stale-lease sweep `_fail_if_still_stale` writes directly: `error = "processing lease expired without heartbeat —
  worker died or stalled"`, `error_stage = "processing"`, `retryable = True`. `[V]` Unchanged by this design.
- Both services have `FIRESTORE_EMULATOR_HOST` initialization branches (hermetic mode). `[V]`
- Import-time constraints in the worker's `main.py`: `GCP_PROJECT = os.environ["GCP_PROJECT"]` (hard `KeyError` if
  absent) and a `RuntimeError` when `GOOGLE_APPLICATION_CREDENTIALS` is unset; a `SubscriberClient` is built at
  module import. `[V]` — this shapes the test architecture (§5).

## 3. Target failure path (after)

```json
// published details for status "failed" (example uses the verified partial-write message)
{
  "error_message": "partial vector write: 3/5 chunks stored, 2 failed — refusing to mark the resource searchable on a partial index",
  "error":         "partial vector write: 3/5 chunks stored, 2 failed — ... (legacy duplicate, same string)",
  "stage":         "embeddings_complete",
  "retryable":     false,
  "jobId":         "job_xyz_123"
}
```

Persisted by rag-api's **unchanged** failed branch:
- main document: `status: "failed"`, `error: <message>`, `error_stage: "embeddings_complete"`,
  `retryable: false`, `schema_version: 2`, timestamps.
- `processing/summary`: `stage: "embeddings_complete"`, `progress: 0`, `updated_at`,
  `error: {code: "UNKNOWN", message: <message>, stage: "embeddings_complete"}`.

## 4. Component design

### 4.1 New pure contract module (worker): `models/failure_payload.py`
New file `apps/ai-server/rag-worker-service/models/failure_payload.py` — sibling of the existing `models/`
package (`pubsub_messages.py`, `processing_status.py`, `resource_map.py` `[V]` exist; `processing_status.py`
contents `[U]`, hence a **new** file rather than coupling to unread contents). It must import only lightweight
dependencies (no firebase, no pubsub, no ML stack) so tests can import it in isolation despite `main.py`'s
import-time environment requirements `[V]`.

Contents:
- `FAILURE_STAGE_VOCABULARY`: frozenset `{starting, text_retrieved, tagging_complete, summary_generated,
  chunking_complete, embeddings_complete}` — the single source of truth for FR-2's vocabulary.
- `UNKNOWN_STAGE = "processing"` — the safe value; deliberately identical to the stale-lease sweep's
  `error_stage` sentinel so the field never regresses to null and both writer paths share the fallback `[V]`.
- `LEGACY_ERROR_KEY = "error"`.
- `build_failure_payload(error_message: str, stage: str, retryable: bool) -> dict`:
  - returns exactly `{"error_message": …, "stage": …, "retryable": …, "error": <same string as error_message>}`;
  - coerces `error_message` to `str`; coerces any `stage` outside
    `FAILURE_STAGE_VOCABULARY ∪ {UNKNOWN_STAGE}` to `UNKNOWN_STAGE` (defensive normalization — the handler must
    never raise while reporting a failure; tracker bugs are caught by tests, not by production coercion).
- Deliberately does **not** classify exceptions: `classify_error` stays in `main.py` (no circular import; the
  handler supplies the derived boolean).

### 4.2 Stage tracker in `process_document`
- A plain local `current_stage = UNKNOWN_STAGE` initialized before the `try` block.
- Assignments follow the mapping table in requirements §4.3, per the convention **"set the tracker immediately
  before the await"** of each pipeline step. Steps without a vocabulary entry (the post-embedding vector window:
  `delete_old_vectors_via_service`, `store_chunks_via_service`, metadata save) make no assignment and inherit
  `embeddings_complete` — this both implements the window decision and keeps the convention exception-free.
- Semantics note (intentional): `stage` names the failing *phase*; it may name a milestone whose progress event
  never fired (e.g. extraction failure → `text_retrieved`). `completed` is never a failure stage.
- Out-of-scope observation, documented as a boundary: the `langfuse` trace creation line sits **before** the
  `try`, so an exception there bypasses failure publishing entirely — pre-existing behavior, unchanged.

### 4.3 Failure handler rewrite (the only behavioral edit in the hot path)
The `except Exception as e:` block in `process_document` becomes:

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    retryable = classify_error(e)                     # existing classifier, unchanged [V]
    failure_details = build_failure_payload(str(e), current_stage, retryable)
    self.logger.error("document_processing_failed", ..., error=str(e), stage=current_stage, retryable=retryable)
    await self._publish_status_update(user_id, course_id, resource_id, "failed", failure_details, job_id)
    ...
```

`_publish_status_update` is untouched (it already passes `details` through, enriches `jobId`, resets the sequence,
and heartbeats the lease). Edge note: `str(e)` may be an empty string for exotic exceptions; the persisted
`error` is then `""` — truthful, and still not the API fallback. Accepted.

### 4.4 `retryable` derivation
- Reuses `classify_error` verbatim — no new classification logic, no drift between ACK/NACK behavior and the
  persisted flag. `run_worker`'s ACK/NACK code is untouched.
- Behavior change (deliberate, from definition F8): unclassified-unknown failures now persist `retryable: false`
  (previously the silent `True` default). Rationale: alignment with actual redelivery behavior; conservatism
  against retry loops; manual reprocess via `POST /process` `[D]` unaffected.
- The sweep's separate `retryable: true` write is untouched and remains correct (a dead worker is transient by
  nature).

### 4.5 Compatibility hedge (legacy `error` key)
The builder emits `error` duplicating `error_message`. rag-api ignores it (reads `error_message` `[V]`). Any
unknown consumer of the status topic continues to see the key it sees today. Cleanup path: if a later audit
confirms rag-api is the only consumer, deleting one line in the builder (and adjusting TR-4's expected key set)
is the entire change.

### 4.6 rag-api: zero production changes
`run_transactional_update`, `_process_status_message`, `models/resource.py`, and all endpoints are untouched.
The alignment constraint (`must`) is satisfied by construction; the contract is enforced by the test (§5).

## 5. Contract test architecture

**Location:** new file `apps/ai-server/tests/integration/test_worker_failure_contract.py`, sibling of
`test_api_contracts.py` `[V]`, sharing that directory's `conftest.py` and import bootstrap. The existing file
demonstrates the two house patterns this design reuses: importing `main as rag_api_main` and exercising real
model fields, and AST-based static checks over service sources. `[V]` Being in the same directory guarantees
discovery by whatever runner executes `test_api_contracts.py` today `[U]` (runner specifics unknown; same-dir
placement is the safe structural bet).

**Import strategy (two tiers):**
1. *Light tier (always available):* import `models/failure_payload.py` for the builder and vocabulary — no heavy
   deps, sidesteps `main.py`'s import-time env requirements `[V]`.
2. *Full tier (for `classify_error` in TR-3):* import worker `main.py` via the bootstrap the worker's unit tests
   already rely on (inferred from `tests/unit/test_processing_lease.py` targeting `main.py` functions; specifics
   `[U]`). Contingency, sanctioned if the bootstrap proves brittle: relocate `ProcessingError`/
   `TransientError`/`PermanentError`/`classify_error` into `models/failure_payload.py` and re-export from
   `main.py` (`from models.failure_payload import classify_error`) — behavior-identical, drift-safe, still
   worker-only.

**Persistence mode:** Firestore emulator primary (both services' `FIRESTORE_EMULATOR_HOST` branches verified
`[V]`); the test seeds `users/{test-user}/resources/{test-res}` with `status: "processing"` (required by the
`processing → failed` transition guard `[V]`), calls `rag_api_main.run_transactional_update(db, doc_ref,
"failed", details, logger, user_id)` directly (the verified persistence seam), then reads back the main document
and asserts:

- main document: `status == "failed"`, `error == <worker message>`, `error_stage == <worker stage>`,
  `retryable == <worker value>`;
- `processing/summary`: `stage == <worker stage>`, `error.message == <worker message>`,
  `error.stage == <worker stage>`, `error.code == "UNKNOWN"`.

A fake-Firestore fallback is sanctioned if the emulator cannot be provisioned in a given environment, but
emulator-first is preferred because it exercises the real transactional path. Either way, **production code from
both services is what runs** — only the transport is substitutable.

Sentinel discipline: test messages are distinctive strings (e.g. `"sentinel: contract probe 7f3a"`), never
`"Processing failed"`, so a fallback default can never satisfy an equality assertion; `retryable` values are
chosen opposite to the API default in each case (`True` in the early case, `False` in the late case) so a silent
default is detectable in both directions. This is what makes the test the API-side drift guard as well: any
rename of `error_message`/`stage`/`retryable` on the rag-api side collapses the persisted values to fallbacks
and fails the equality asserts.

### 5.1 Verification coverage matrix

| # | Level | Worker side | rag-api side | Catches |
|---|-------|-------------|--------------|---------|
| TR-1 | contract | `build_failure_payload("sentinel…", "text_retrieved", True)` through the real handler path | `run_transactional_update(..., "failed", details, …)` on emulator-seeded `processing` doc | early-stage seam; API-side key drift; summary parity |
| TR-2 | contract | same, stage `"embeddings_complete"`, `retryable=False` | same | late-stage seam incl. the inheritance window; `False` survives the `True` default |
| TR-3 | contract | real `classify_error` on `TransientError` / `PermanentError` / unclassified `ValueError` | payload-only assertion | retryable polarity (true / false / false) |
| TR-4 | contract | `set(build_failure_payload(...)) == {"error_message", "error", "stage", "retryable"}` | — | worker-side shape drift in either direction |
| TR-5 | static (AST) | `process_document` except-handler publishes `build_failure_payload(...)` with tracked stage + `classify_error` result; no inline dict | — | regression to `{"error": str(e)}`; tracker bypassed in handler |
| TR-6 | static (AST) | — | `_process_status_message` forwards `payload["details"]` unfiltered to `run_transactional_update` | envelope filtering that would drop keys |
| TR-7 | unit (worker test dir) | stubbed pipeline steps raising early and late; stubbed `_publish_status_update` captures details | — | tracker mechanism, set-before-await convention, inheritance rule |

TR-5's AST shape mirrors the static patterns already used in `test_api_contracts.py` `[V]`; TR-7 lives in
`apps/ai-server/rag-worker-service/tests/unit/` next to the existing lease unit tests.

## 6. Runtime sequence (after)

1. Pipeline step raises → `process_document`'s handler runs; `current_stage` holds the last set-before-await value
   (or `processing` if never set).
2. Handler calls `classify_error(e)` (existing, unchanged) → boolean.
3. Handler calls `build_failure_payload(str(e), current_stage, retryable)` → 4-key details dict.
4. `_publish_status_update(..., "failed", details, job_id)` (untouched) enriches `jobId`, resets the sequence,
   heartbeats the lease, publishes to `rag-status-updates`.
5. rag-api `_process_status_message` (untouched) resolves the doc path and calls `run_transactional_update`
   (untouched), whose failed branch persists the worker's values verbatim on main doc and `processing/summary`.

## 7. Why the payload construction lives in `process_document`'s handler

Two verified structural facts drive this:
- `process_document` catches all exceptions internally and returns `ProcessingMetrics`; it never re-raises. `[V]`
- `run_worker` applies `classify_error` for ACK/NACK inside its per-message except branch — reachable for errors
  raised outside `process_fn` (e.g. payload decode), not for pipeline failures. `[V]`

Consequences: the failure publish must be built in (or called from) the `process_document` handler — moving it to
`run_worker` would observe no pipeline exception at all. The published `retryable` is therefore a **policy
verdict from the same classifier the ACK/NACK machinery uses**, not a transport promise; retry mechanics (ACK/NACK
policy, redelivery) are an explicit non-goal of this fix and are not modified.

Design note: the `langfuse` trace creation sits before the `try` in `process_document` `[V]`; an exception there
bypasses failure publishing entirely. Pre-existing, out of scope, documented so it is not mistaken for a
regression introduced here.

## 8. Rollout and compatibility

- **Single-service deploy (rag-worker only).** rag-api is unchanged, so there is no cross-service ordering: the
  first worker deploy after the change immediately persists real values. In-flight status messages carry full
  payloads, so drain-on-restart is clean.
- **No migration/backfill.** Historical failed documents keep their fallback values; the `must_not` constraint
  forbids touching them.
- **Rollback.** Revert the worker deploy; the payload reverts to the legacy single-key shape, which unchanged
  rag-api tolerates (persisting fallbacks — the pre-fix behavior). The retained legacy `error` key keeps any
  unknown status-topic consumer working in both directions during the window.
- **CI.** The contract test rides the existing integration suite location; no new infrastructure beyond what
  `test_api_contracts.py` already relies on.

## 9. Alternatives considered and rejected

1. **Align rag-api to the worker** (read `details["error"]`) — rejected: violates the `must` constraint; would
   ripple to three already-consistent writers and both response models.
2. **Dual-read on rag-api** (`error_message` or `error`) — rejected: widens the contract instead of fixing the
   deviating writer; leaves two canonical keys; the test would pin a union, which is weaker than pinning one.
3. **Structured error-code taxonomy** — rejected (`prefer_not`); `error.code` stays `"UNKNOWN"`.
4. **Context-var or decorator-based stage tracking** — rejected: heavier than a plain local; the local plus the
   set-before-await convention is grep-able and pinned by TR-5/TR-7.
5. **Emitting the failure payload from `run_worker`** — rejected per §7: pipeline exceptions never reach it.

## 10. Unknowns carried into implementation

Same set as requirements §9 (conftest bootstrap; fixture-dir contents; `models/processing_status.py` and
`exceptions.py` contents; worker unit-test import mechanism; identities of other topic consumers). Each has a
sanctioned contingency in §5 (light-tier import, two-tier import with the `classify_error` relocation fallback,
same-directory placement). None blocks the design; all are resolvable during implementation without widening
scope.

## 11. Component → requirement traceability

| Component | Requirements served |
|-----------|---------------------|
| `models/failure_payload.py` (builder, vocabulary, `UNKNOWN_STAGE`, legacy key) | FR-1, FR-2, FR-5 |
| Stage tracker + handler rewrite in `process_document` | FR-1, FR-2, FR-4 |
| `classify_error` reuse (no new classification logic) | FR-4 |
| rag-api: zero production changes | FR-3 |
| `test_worker_failure_contract.py` (emulator seam + static guards) | FR-6 |
| Worker unit test (tracker mechanism) | FR-2 |

<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>