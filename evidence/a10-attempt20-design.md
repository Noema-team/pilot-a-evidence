<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api: failure payload contract alignment

Cycle: `f33835d5-f24d-4368-bab4-3155bf6a1fab` (iteration 1, step: design)
Intent: "rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage"

## 0. Source of truth

The authoritative specification is the define-work WorkItem `wi-define-108-a8`
(artifact `definition:obj-108`, sha256
`71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`). Its facts,
constraints, requirements, non-goals, and acceptance criteria are binding and are
restated here without widening, narrowing, or reinterpretation. Repository
evidence cited below was verified by direct reads during investigation.

## 1. Problem statement

The worker's failure publisher and rag-api's failure consumer were written
against different contracts, and no test covers the seam.

- Worker (`apps/ai-server/rag-worker-service/main.py`, `process_document`
  exception handler) publishes the failed status with a one-key details payload:
  `{"error": str(e)}`.
- rag-api (`apps/ai-server/rag-api-service/main.py`, `run_transactional_update`
  failed branch) reads three keys — `error_message`, `stage`, `retryable` — and
  persists them as `error` / `error_stage` / `retryable` on the main resource
  document, and as `message` / `stage` (with `error_code` defaulting to
  `"UNKNOWN"`) in the `processing/summary` error subdocument.

Consequence (verified): every worker-originated failure persists `error` as the
fallback string `"Processing failed"`, `error_stage` as `None`, and `retryable`
as the silent default `True`. Users and support cannot disambiguate failures.

The persisted schema (`error`, `error_stage`, `retryable`) is already consistent
across three other write paths — the worker's stale-lease sweep
(`_fail_if_still_stale`), rag-api's enqueue-failure paths (`/process`,
`POST /resources`) — and is exposed by `ResourceResponse` and the `Resource`
model (`retryable` defaults `True`). The worker's status publisher is the only
writer that does not speak this contract.

## 2. Scope

**In scope**
- rag-worker failure-path changes only: stage tracking through
  `process_document`, failure-payload key alignment, deliberate `retryable`
  derivation, retention of the legacy `error` key.
- A contract test covering the worker failure → rag-api persistence path.
- rag-api is read/imported by the contract test but is **not modified**.

**Out of scope** — see §6 (Non-goals).

## 3. Functional requirements

### FR-1 — Failure payload keys
When document processing fails, the worker's failed status payload details must
include:
- `error_message` — the actual exception message (`str(e)`),
- `stage` — the pipeline stage executing at failure time (see FR-2),
- `retryable` — a deliberately derived boolean (see FR-3),

and must never rely on rag-api's fallback defaults for these keys (i.e. rag-api's
`details.get(...)` fallbacks `"Processing failed"` / `None` / `True` must never be
the operative mechanism for worker-originated failures).

### FR-2 — Stage tracking
- The worker must track the currently executing pipeline stage through
  `process_document` so the failure handler reports the true failing stage.
- Stage names must reuse the existing progress-stage vocabulary:
  `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`,
  `chunking_complete`, `embeddings_complete`.
- `"processing"` is the safe value when the stage is genuinely unknown (failure
  before the first tracked segment, or in the post-embeddings finalization
  segment that has no milestone name). `error_stage` must never regress to
  `None`; `"processing"` matches the value the stale-lease sweep already uses.
- Convention: the tracker is set immediately before each pipeline step's await.
  A future pipeline step added without updating the tracker reports a stale
  stage; the contract test pins the mechanism on representative stages (an
  early-stage and a late-stage failure) without ossifying every step.

### FR-3 — Deliberate retryable derivation
- `retryable` must be derived explicitly from the worker's existing
  `classify_error(e)` classification (verified: returns `True` for
  `TransientError`, transient httpx/connection/timeout types, and HTTP
  429/500/502/503/504; `False` for `PermanentError`, other 4xx, and —
  conservatively — unknown exceptions):
  - classified transient → `retryable: true`
  - classified permanent, including unclassified-unknown → `retryable: false`
- Every worker-originated failure payload must carry `retryable` explicitly; it
  must never be silently defaulted.
- Deliberate behavior change (accepted): unclassified-unknown exceptions
  previously persisted `retryable: true` (the silent default) and will now
  persist `false`. Manual reprocess via `POST /process` (transition
  `failed → queued`, allowed per rag-api's `ALLOWED_TRANSITIONS`) remains
  available.
- The stale-lease sweep's direct write keeps `retryable: true` unchanged (a dead
  worker is a transient condition); it is explicitly out of scope.

### FR-4 — rag-api persistence unchanged
rag-api's failed branch persists the worker-provided values unchanged:
- main document: `error` ← payload `error_message`; `error_stage` ← payload
  `stage`; `retryable` ← payload `retryable`;
- `processing/summary` error subdocument: `message` ← payload `error_message`;
  `stage` ← payload `stage`; `code` remains `"UNKNOWN"` (rag-api default) because
  the worker sends no `error_code`.
No changes to rag-api's reads, persisted field names, or schema.

### FR-5 — Legacy key retention (compatibility hedge)
The worker's failure payload retains the legacy `error` key alongside
`error_message`, with the same value (`str(e)`), so any unknown consumer of the
status topic (only rag-api's status subscriber is a verified consumer) keeps
working. Dropping the duplicate later is trivial cleanup after a consumer audit.

### FR-6 — No regression to other paths
- `_publish_status_update`'s existing behaviors are unchanged apart from the
  failure details content: envelope keys (`user_id`, `course_id`, `resource_id`,
  `status`, `details`, `timestamp`, `sequence`), `jobId` injection when a job id
  is provided, sequence bookkeeping (reset on terminal states), and the
  best-effort lease heartbeat write.
- `_fail_if_still_stale`, `run_worker` ACK/NACK logic, `classify_error`, retry
  counts/backoff, leases, and heartbeat intervals are unchanged.
- Existing tests must keep passing, including
  `rag-worker-service/tests/unit/test_processing_lease.py` (which asserts the
  sweep's `retryable is True` write) and
  `tests/integration/test_api_contracts.py`.

### FR-7 — Error-message fidelity
The persisted `error_message` must be the actual exception message. Where a
retry decorator wraps the underlying failure (verified `@retry` decorators on
`_generate_embeddings_with_openrouter` and `store_chunks_via_service`;
`generate_document_summary` is best-effort and returns `None` on internal
failure rather than raising), the implementation must ensure the message that
reaches the payload is the underlying error's message, not a wrapper artifact —
e.g. tenacity `reraise=True` (retry counts/waits unchanged) or unwrapping the
wrapper's cause in the handler. Retry/backoff mechanics themselves are out of
scope; only reporting changes.

## 4. Data contract

### 4.1 Worker failure payload (`details` of the `failed` status message)

| Key | Value | Read by rag-api → persisted as |
|---|---|---|
| `error_message` | `str(e)` | main doc `error`; summary `error.message` |
| `stage` | tracker value (FR-2) | main doc `error_stage`; summary `stage` and `error.stage` |
| `retryable` | `classify_error(e)` (FR-3) | main doc `retryable` |
| `error` | `str(e)` (legacy hedge, FR-5) | not read by rag-api |
| `jobId` | injected by `_publish_status_update` when a job id is provided (pre-existing) | summary `job_id` only on `processing` status |

No `error_code` is sent → summary `error.code` stays `"UNKNOWN"` (rag-api
default; no error-code taxonomy, per prefer-not constraint).

### 4.2 Message envelope (unchanged, verified)
Top-level keys: `user_id`, `course_id`, `resource_id`, `status` (`"failed"`),
`details`, `timestamp`, `sequence`. rag-api's `_process_status_message` reads
exactly these.

### 4.3 Stage vocabulary and safe value
Allowed `stage` values in failure payloads:
`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`,
`chunking_complete`, `embeddings_complete`, and the safe value `processing`.
Nothing else; `stage` is never absent or null.

## 5. Constraints (binding, from the definition)

1. **must** — The worker is aligned to rag-api's existing contract
   (`error_message`/`stage`/`retryable`); rag-api's reads and persisted schema
   are not changed.
2. **must_not** — No Firestore migration, field rename, or backfill of existing
   documents; persisted fields (`error`, `error_stage`, `retryable`) keep their
   names and semantics.
3. **must** — Every worker-originated failure payload carries `retryable`
   explicitly (deliberately derived); rag-api's `details.get("retryable", True)`
   fallback must not be the operative mechanism for worker failures.
4. **prefer** — Retain the legacy `error` key in the worker's failure payload
   alongside `error_message`, for continuity with existing consumers of the
   status topic and log tooling.
5. **prefer_not** — Do not introduce a structured error-code taxonomy
   (`error_code` values) in this fix.

## 6. Non-goals

- Changing the stale-lease sweep's direct failure write (already consistent).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases,
  heartbeat intervals — only the *reporting* of retryability changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and
  `error_stage`.
- Introducing structured error codes or a failure taxonomy — summary
  `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure
  payload alignment (its content is unavailable in this context; deferred), and
  reconciling this analysis with the D4 deviation note referenced in
  `plans/upload-flow.md` (that file is not present in the current tree).

## 7. Acceptance criteria

- **AC-1** — A failed job's status message published by the worker contains
  `error_message` (actual exception message), `stage` (failing pipeline stage),
  and `retryable` (deliberately derived) — none relying on rag-api's fallback
  defaults. *Verified by the contract test's payload assertions.*
- **AC-2** — After a failed job, the persisted resource document has
  `error` = the worker's actual error message (not `"Processing failed"`),
  `error_stage` = the failing stage (not `None`), and `retryable` = the worker's
  derived value. *Verified by the contract test's persistence assertions.*
- **AC-3** — The `processing/summary` error subdocument for the failed job
  carries the same message and stage as the main document. *Verified by the
  contract test.*
- **AC-4** — A contract test covering the worker failure → rag-api persistence
  path exists and passes: it exercises the worker's failure-payload construction
  through rag-api's failed-branch persistence and asserts the persisted `error`,
  `error_stage`, and `retryable` equal the worker's values, failing if either
  side's payload keys drift. *Verified by the new test in the suite.*

## 8. Test requirements

- **TR-1** — The contract test must import both real sides (worker
  `process_document` failure handler; rag-api `run_transactional_update`) rather
  than restate the contract in a fixture. The failure payload must be obtained
  by running the worker's real handler (with stubbed pipeline steps and a
  recording publisher), not by reconstructing the dict in the test.
- **TR-2** — It must cover a representative early-stage failure and a
  representative late-stage failure, exercising both `retryable` branches
  (permanent-classified → `false`, transient-classified → `true`).
- **TR-3** — It must assert persisted `error`, `error_stage`, `retryable` equal
  the worker's values, plus the summary error subdocument's `message`/`stage`
  and `code == "UNKNOWN"`.
- **TR-4** — It must include a key-set drift guard on the worker payload (exact
  expected key set, accounting for the conditional `jobId`), and its persisted-
  value assertions act as the rag-api read-drift guard (a renamed read surfaces
  a fallback value, which fails the assertions).
- **TR-5** — It must run hermetically (fakes and/or the services' existing
  `FIRESTORE_EMULATOR_HOST` branches) without real GCP credentials, following
  the house patterns in `tests/integration/test_api_contracts.py` and
  `rag-worker-service/tests/unit/test_processing_lease.py`.

## 9. Unknowns and deferred items

- The companion D3 issue's content is unavailable in this context; anything it
  covers beyond this alignment is deferred.
- `plans/upload-flow.md` (referenced as the original D4 deviation analysis) is
  not present in the current tree; reconciliation is deferred.
- Exact CI invocation of `apps/ai-server/tests/integration/` was not verified
  (no root `pytest.ini` was observed); the test must be runnable by the same
  command that runs the existing integration suite — to be confirmed at build.
- Availability of `fastapi` / `langchain_text_splitters` / `sklearn` in every
  environment the contract test runs in is unverified; the import bootstrap must
  stub-on-missing (see architecture §5).
- tenacity's deployed default for `reraise` (library default wraps exhausted
  retries in `RetryError`) is assumed, not repo-verified; confirm at build when
  implementing FR-7.
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api failure payload contract alignment

Cycle: `f33835d5-f24d-4368-bab4-3155bf6a1fab` (iteration 1, step: design)
Binding spec: WorkItem `wi-define-108-a8` → artifact `definition:obj-108`
(sha256 `71f1c39c…`). Companion document: `docs/requirements.md`.

## 1. Verified current behavior (the seam)

### 1.1 Worker side — `apps/ai-server/rag-worker-service/main.py`
- `process_document` is one large `try` block. On success it publishes progress
  status updates through `_publish_status_update` with the stage vocabulary
  `starting`, `text_retrieved` (progress 20), `tagging_complete` (40),
  `summary_generated` (50), `chunking_complete` (60), `embeddings_complete`
  (80), then a terminal `completed` (100).
- The exception handler sets `metrics.error_message = str(e)`, logs
  `document_processing_failed`, and publishes:
  `await self._publish_status_update(user_id, course_id, resource_id, "failed", {"error": str(e)}, job_id)`
  — then returns normally (does not re-raise).
- `_publish_status_update` builds the envelope (`user_id`, `course_id`,
  `resource_id`, `status`, `details`, `timestamp`, `sequence`), injects `jobId`
  into details when a job id is provided, resets the per-resource sequence on
  terminal states (`completed`, `failed`), performs a best-effort lease
  heartbeat (`status_updated_at` merge on the first existing resource path), and
  publishes JSON to topic `rag_status_topic` in project `gcp_project`.
- `classify_error(e)` returns `True` (transient) for `TransientError`, the
  httpx connect/timeout family, `ConnectionError`, `TimeoutError`,
  `asyncio.TimeoutError`, and HTTP 429/500/502/503/504; `False` (permanent) for
  `PermanentError`, other 4xx, and — conservatively — unknown exceptions.
- `run_worker` uses `classify_error` for ACK/NACK on exceptions reaching the
  message loop (transient → omitted from acks → Pub/Sub redelivers; permanent →
  acked to avoid poison pills).
- `_fail_if_still_stale` (stale-lease sweep) already writes the target schema
  directly: `status: "failed"`, `error: "processing lease expired without
  heartbeat — worker died or stalled"`, `error_stage: "processing"`,
  `retryable: True`.
- `@retry` (tenacity) decorates `generate_document_summary`,
  `_generate_embeddings_with_openrouter`, `store_chunks_via_service`;
  `generate_document_summary` catches its own exceptions and returns `None`
  (best-effort summary), so it does not normally fail the job.
- Module import has side effects: reads `GCP_PROJECT` and
  `GOOGLE_APPLICATION_CREDENTIALS` (raises if the latter is unset) and
  constructs a Pub/Sub `SubscriberClient`. The worker test bootstrap
  (`rag-worker-service/tests/conftest.py`) exists precisely to neutralize this
  (env defaults + module stubs).

### 1.2 rag-api side — `apps/ai-server/rag-api-service/main.py`
- `run_transactional_update` failed branch (verified verbatim):
  - `main_update["error"] = details.get("error_message", "Processing failed")`
  - `main_update["error_stage"] = details.get("stage")`
  - `main_update["retryable"] = details.get("retryable", True)`
  - summary: `stage = details.get("stage", "unknown")`,
    `progress = details.get("progress, 0")`-shaped default `0`, and
    `error = {"code": details.get("error_code", "UNKNOWN"),
    "message": details.get("error_message", "Processing failed"),
    "stage": details.get("stage")}`.
- Transitions: `processing → failed` allowed; `failed → queued` allowed
  (manual reprocess path).
- `_process_status_message` reads the envelope's top-level keys and routes to
  the canonical or legacy document path.
- `FIRESTORE_EMULATOR_HOST` branch exists for hermetic runs.
- `ResourceResponse` exposes `error` and `error_stage` (not `retryable`);
  `models/resource.py` `Resource` carries `error`, `error_stage`,
  `retryable: bool = True`.

### 1.3 The mismatch
Worker publishes `{"error": …}`; rag-api reads `error_message`/`stage`/
`retryable`. Every worker failure therefore persists the fallbacks:
`"Processing failed"`, `None`, `True` — on the main document and, inherited,
in the `processing/summary` error subdocument (`code` always `"UNKNOWN"`).

## 2. Design decisions

### D1 — The worker aligns to the API (rag-api unchanged)
The persisted field names are already consistent across three other write paths
and two response models; rag-api is the contract's center of gravity. The worker
is the odd writer out. Fix the odd one out: zero reader changes, zero schema
changes, no migration/backfill. rag-api appears in this change only as the
imported counterpart in the contract test.

### D2 — Stage tracking: a local tracker with a set-before-await convention
A local variable (e.g. `current_stage`) in `process_document`, initialized to
`"processing"` before the `try`, reassigned immediately before each pipeline
step, and read by the exception handler. No shared state, no new abstraction.

Segment → tracker mapping (uses only the existing progress vocabulary):

| Pipeline segment (code) | Tracker value | Milestone published on success |
|---|---|---|
| function entry (before `try`) | `"processing"` | — |
| `_validate_processing_request` | `"starting"` | `processing` / stage `starting` |
| `_get_extracted_text` | `"text_retrieved"` | stage `text_retrieved`, progress 20 |
| `content_tagger.generate_tags` | `"tagging_complete"` | 40 |
| `generate_document_summary` + `ragDescription` doc update | `"summary_generated"` | 50 |
| `_create_enhanced_chunks` | `"chunking_complete"` | 60 |
| `_generate_embeddings_with_openrouter` | `"embeddings_complete"` | 80 |
| post-embeddings finalization (`delete_old_vectors_via_service`, `store_chunks_via_service`, `_save_processing_metadata_to_subcollection`, completed publish, `_update_user_usage`, `_generate_resource_map`) | `"processing"` (reset to safe value — no milestone name exists for this segment) | `completed` / 100 |

Rationale for the finalization reset: reporting `"embeddings_complete"` for a
vector-storage failure would be factually wrong (embeddings succeeded and their
milestone was already published). `"processing"` is the honest, defined safe
value and matches the sweep's convention, so `error_stage` never regresses to
null. Note: `generate_document_summary` is best-effort (returns `None` on
internal failure), so a `"summary_generated"`-stage failure typically
originates in the `ragDescription` Firestore update or an exception escaping
the summary call.

Drift risk (accepted, from the definition): a future pipeline step added
without updating the tracker reports a stale stage. Mitigation is the
convention ("set the tracker immediately before the await") plus representative
coverage in the contract test — enough to catch the tracker being removed or
bypassed without ossifying every step.

### D3 — `retryable` derived, never defaulted
The failure handler computes `retryable = classify_error(e)`:

| Exception | `classify_error` | persisted `retryable` |
|---|---|---|
| `TransientError`; httpx connect/timeout family; `ConnectionError`; `TimeoutError`; `asyncio.TimeoutError`; HTTP 429/500/502/503/504 | transient | `true` |
| `PermanentError`; other httpx 4xx | permanent | `false` |
| anything else (unclassified-unknown) | permanent (conservative default) | `false` — deliberate change from the previous silent default `true` |

This makes the persisted record report the classification the worker's own
error machinery already computes, and the conservative unknown→`false` mapping
prevents blind auto-retry affordances for unrecognized failures; manual
reprocess via `POST /process` (`failed → queued`) is unaffected. The stale-lease
sweep's separate `retryable: true` write stays correct and untouched (a dead
worker is transient by nature).

Semantics note (verified observation, scope-bounded): `process_document`'s
handler currently returns normally after publishing the failure, so
`run_worker`'s classify-driven ACK/NACK governs exceptions arising outside
`process_document` (claim, decode, regenerate-map); pipeline failures are acked
after the failed status is published. The `retryable` flag reports
`classify_error`'s verdict for the pipeline exception exactly as the binding
definition mandates; any change to ACK behavior is explicitly a non-goal.

### D4 — Legacy `error` key retained
The failure payload carries both `error_message` and `error` (same value,
`str(e)`). Only rag-api's status subscriber is a verified consumer, but other
services and tooling share the topic; one redundant string per failure message
is cheap insurance. If a later audit confirms worker→rag-api is the only
producer→consumer pair, dropping the duplicate is trivial cleanup.

### D5 — Error-message fidelity (FR-7)
With tenacity's default (`reraise=False`), an exhausted retry on
`_generate_embeddings_with_openrouter` / `store_chunks_via_service` surfaces as
`RetryError`, whose `str()` is not the underlying message. To satisfy "the
actual exception message": either pass `reraise=True` to the affected
`@retry` decorators (attempt counts and waits unchanged — retry mechanics are
not being altered) or unwrap the wrapper's `__cause__` in the failure handler.
Confirm tenacity's deployed default at build; pick one mechanism and cover it
in the late-failure test scenario.

### D6 — Contract test imports both sides; fakes primary, emulator optional
The test drives the real `process_document` failure handler and the real
`run_transactional_update` — no contract restated in a fixture. Hermetic fakes
are the primary mode (matching `test_processing_lease.py`'s established fake
pattern and both conftests' stub approach); the Firestore-emulator mode both
services already support is an acceptable alternative.

## 3. Target data flow

```
process_document (worker)
  ├─ current_stage set before each step          (D2)
  ├─ step raises
  └─ except handler
       ├─ metrics.error_message = str(e); log failure (+ stage)
       ├─ details = {error_message, stage, retryable=classify_error(e), error}
       └─ _publish_status_update(..., "failed", details, job_id)
            └─ Pub/Sub topic rag-status-updates   (envelope unchanged)
                 └─ rag-api _process_status_message
                      └─ run_transactional_update   (UNCHANGED)
                           ├─ main doc: status=failed,
                           │    error←error_message, error_stage←stage,
                           │    retryable←retryable
                           └─ processing/summary: stage←stage,
                                progress←0 (default), error={code:"UNKNOWN",
                                message←error_message, stage←stage}
```

## 4. Component change list

| File | Change |
|---|---|
| `apps/ai-server/rag-worker-service/main.py` | `process_document`: add `current_stage` local (init `"processing"`), set before each step per D2 table; exception handler builds the D1-aligned details (`error_message`, `stage`, `retryable=classify_error(e)`, legacy `error`) and logs the stage; optionally unwrap retry wrappers (D5). No changes to `classify_error`, `_publish_status_update` semantics, `_fail_if_still_stale`, `run_worker`, leases/heartbeats. |
| `apps/ai-server/tests/integration/conftest.py` | Extend with a worker-import bootstrap: env defaults + module stubs mirroring `rag-worker-service/tests/conftest.py` (applied only for missing modules, so real installs win). Needed because worker `main.py` has import-time side effects. |
| `apps/ai-server/tests/integration/test_worker_failure_contract.py` | New contract test (see §5). |
| `apps/ai-server/rag-worker-service/tests/unit/` | Recommended: small unit tests for the stage-mapping table and the `classify_error → retryable` mapping, including the safe value. |
| `apps/ai-server/rag-api-service/*` | **No changes.** |

## 5. Contract test architecture

Location: `apps/ai-server/tests/integration/test_worker_failure_contract.py`,
alongside the existing house contract tests; bootstrap added to that directory's
`conftest.py`.

**Bootstrap.** Worker `main.py` import requires the env defaults
(`GCP_PROJECT`, `GOOGLE_APPLICATION_CREDENTIALS`, `RAG_PROCESS_SUB`,
`RAG_STATUS_TOPIC`, OpenRouter/Firebase/Weaviate vars) and module stubs
(`openai`, `langfuse`, `firebase_admin.*`, `google.cloud.pubsub_v1`,
`google.cloud.firestore`, `google.cloud.storage`, `spacy`, `tiktoken`,
`tenacity` as no-op retry, conditional `langchain.text_splitter`). Mirror
`rag-worker-service/tests/conftest.py`; stub only what is missing so real
installs are used when present. rag-api's import bootstrap already exists in
this conftest (mocks + `sys.path` insertion) and is proven by
`test_api_contracts.py`.

**Fakes.**
- Publisher: records `(topic, bytes)` and returns a pre-resolved
  `concurrent.futures.Future` so `asyncio.wrap_future(future)` in
  `_publish_status_update` succeeds.
- Firestore: `FakeDb`/`FakeRef`/`FakeSnap`/`FakeTx` per the
  `test_processing_lease.py` pattern; refs need `get`/`update`/`set` (the
  heartbeat path and the `ragDescription` update must be tolerable; a snapshot
  with `exists=False` cleanly skips the heartbeat write).
- Processor: constructed without running `_init_services` (e.g. via `__new__`
  plus attribute injection: `langfuse=None`, fake db, fake publisher);
  succeeding pipeline steps are stubbed on the instance with minimal fakes so
  only the target step raises — this keeps the stub surface small (no
  text-splitter/tokenizer exercise needed).
- Monkeypatches (established pattern): worker `main.firestore.SERVER_TIMESTAMP`
  → sentinel; rag-api `main.firestore.transactional` → identity decorator and
  `SERVER_TIMESTAMP` → sentinel.

**Scenarios.**
1. Early-stage failure: steps succeed through the `starting` publish;
   `_get_extracted_text` raises e.g. `ValueError("boom-extract")`
   (permanent-classified). Expect `stage == "text_retrieved"`,
   `retryable is False`.
2. Late-stage failure: steps succeed through chunking;
   `_generate_embeddings_with_openrouter` raises e.g.
   `httpx.ConnectTimeout("boom-embed")` (transient-classified). Expect
   `stage == "embeddings_complete"`, `retryable is True`.

**Assertions.**
- Envelope: `status == "failed"`, correct `user_id`/`resource_id`.
- Payload drift guard (worker side): details key set is exactly
  `{"error_message", "stage", "retryable", "error", "jobId"}` (with a job id
  passed so `jobId` presence is deterministic). Adding a key later means
  touching this test — that is the point.
- Values: `error_message == error == str(raised)`; `stage` per scenario;
  `retryable` is the exact expected bool.
- Persistence (rag-api side): fake doc seeded with `status: "processing"` (so
  `processing → failed` is an allowed transition); after
  `run_transactional_update`: main doc `error == "boom-*"` (explicitly not
  `"Processing failed"`), `error_stage == <stage>` (not `None`),
  `retryable` identical to the worker's value; summary `stage == <stage>`,
  `error.message == "boom-*"`, `error.stage == <stage>`, `error.code ==
  "UNKNOWN"`.
- The persisted-value assertions double as the rag-api read-drift guard: if
  rag-api's reads are renamed, the fallbacks reappear and these assertions fail.

Optional hardening: an AST guard (house pattern: `_get_agent_shapes` in
`test_api_contracts.py`) asserting `process_document`'s handler still publishes
the aligned keys — only if the dynamic assertions prove insufficient.

**Regression guard:** existing suites must keep passing — notably
`test_processing_lease.py` (sweep writes `retryable is True` — untouched) and
`test_api_contracts.py`.

## 6. Compatibility and consumers

- rag-api's subscriber is unaffected (it already reads the new keys; the
  fallbacks simply stop being operative).
- Unknown consumers of `rag-status-updates` keep working via the retained
  legacy `error` key (D4). Residual risk of an unknown consumer depending on
  the *absence* of the new keys is accepted as negligible.
- Persisted schema, field names, and `ResourceResponse`/`Resource` exposure are
  unchanged; clients see richer `error`/`error_stage` values with no shape
  change.

## 7. Risks and tradeoffs

- **Unknown status-topic consumers** reading the old key set — mitigated by
  retaining `error`; residual risk accepted as low.
- **Stage-tracker drift** as the pipeline evolves — mitigated by the
  set-before-await convention and representative-stage contract coverage.
- **`retryable=false` for unclassified errors** may reduce auto-retry
  affordances for genuinely transient-but-unrecognized failures — accepted;
  widening `classify_error` is out of scope, and manual reprocess
  (`POST /process`) remains.
- **Contract test ossifies the payload** — intentional; that is the drift guard
  doing its job.
- **Retry-wrapper message fidelity** (D5) — if unaddressed, `error_message`
  could persist a wrapper string for exhausted retries; handled per FR-7 with
  retry mechanics unchanged.

## 8. Out of scope

As listed in `docs/requirements.md` §6: stale-lease sweep behavior; ACK/NACK
policy, leases, heartbeats, retry/backoff mechanics (only the *reporting* of
retryability changes); frontend/mobile; error-code taxonomy; companion D3
issue scope; `plans/upload-flow.md` D4 reconciliation (file absent from tree).

## 9. Open questions for build

1. Confirm the CI invocation for `apps/ai-server/tests/integration/` so the new
   test runs with the existing suite (no root `pytest.ini` was observed).
2. Confirm tenacity's deployed `reraise` default and choose the D5 mechanism.
3. Confirm the bootstrap's stub set covers every environment the contract test
   runs in (stub-on-missing strategy makes this low-risk).
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>