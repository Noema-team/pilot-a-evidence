I've verified the authoritative definition against the actual code: the worker's exception handler in `process_document` publishes `{"error": str(e)}` while rag-api's `run_transactional_update` failed branch reads `error_message`/`stage`/`retryable` and persists `error`/`error_stage`/`retryable`; `classify_error()` exists for ACK/NACK; the stage vocabulary and stale-lease sweep are as pinned; and the contract-test house pattern (fixture/AST static tests in `tests/integration/test_api_contracts.py`, transaction fakes in the worker's `test_processing_lease.py`) supports the seam test. The design below aligns the worker to the API with zero API-side changes and pins the seam with a contract test.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api failure payload contract alignment

- **Source of truth:** WorkItem `wi-define-108-a8` (artifact `definition:obj-108`, sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`). This document restates that definition as implementable requirements; where wording differs, the definition is binding.
- **Cycle intent:** "rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage"
- **Status:** design (iteration 1)

---

## 1. Problem statement

A failed RAG processing job must persist the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag. Today it does not:

- The worker's `process_document` exception handler (`apps/ai-server/rag-worker-service/main.py`) publishes a failed status with a **one-key** payload: `{"error": str(e)}`.
- rag-api's failed branch (`run_transactional_update` in `apps/ai-server/rag-api-service/main.py`) reads **three** keys from `details`: `error_message`, `stage`, `retryable`.
- Because of the key mismatch, every worker-originated failure currently persists:
  - `error` = fallback string `"Processing failed"`,
  - `error_stage` = `None`,
  - `retryable` = silent default `True`,
  - and a `processing/summary` error subdocument of `{code: "UNKNOWN", message: "Processing failed", stage: null}`.

Users and support cannot disambiguate failures. The worker is the only failure writer that does not speak the established `error`/`error_stage`/`retryable` persisted schema (the stale-lease sweep, rag-api's enqueue-failure paths, and the `Resource` model all already use it).

## 2. Goal

Align the rag-worker's failure status payload with rag-api's failed-branch contract so that a failed RAG processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag — locked in by a contract test on the worker→rag-api failure path.

**Direction (binding):** the **worker** aligns to rag-api's existing contract (`error_message`/`stage`/`retryable`). rag-api's reads and the persisted schema are **not** changed. No Firestore migration, field rename, or backfill.

## 3. Glossary

| Term | Meaning |
|---|---|
| **Failure payload** | The `details` dict the worker publishes inside a `failed` status message on the `rag-status-updates` Pub/Sub topic. |
| **Failed branch** | The `if new_status == "failed":` blocks in rag-api's `run_transactional_update` (main-doc update and summary-subdocument update). |
| **Stage** | The pipeline stage executing at failure time, drawn from the existing progress-stage vocabulary. |
| **Stage tracker** | A local variable in `process_document` set immediately before each pipeline step and read by the exception handler. |
| **classify_error** | The worker's existing exception classifier (`TransientError`/`PermanentError` + type/status-code heuristics; unknown → permanent). Returns `True` for transient, `False` for permanent. |
| **Drift guard** | A test assertion that fails the build when either side's payload/persisted key set changes. |

## 4. Data contract (normative)

### 4.1 Worker → rag-api failure payload (`details` of a `failed` status message)

| Key | Type | Required | Producer | Consumer / persisted target |
|---|---|---|---|---|
| `error_message` | string (non-empty) | **yes** | worker | → main doc `error`; → `processing/summary.error.message` |
| `stage` | string (non-empty, vocabulary §4.2) | **yes** | worker | → main doc `error_stage`; → `processing/summary.error.stage` |
| `retryable` | boolean | **yes** | worker (derived, §4.3) | → main doc `retryable` |
| `error` | string | yes (legacy, retained) | worker | not read by rag-api; hedge for unknown consumers of the status topic |
| `error_code` | string | **no — not sent** | — | `processing/summary.error.code` stays `"UNKNOWN"` (rag-api default) |
| `jobId` | string | optional | `_publish_status_update` injects it | existing behavior, unchanged |

Normative statements:

- **C-1.** Every worker-originated failure payload MUST contain `error_message`, `stage`, and `retryable` with non-fallback values. The payload MUST NOT rely on rag-api's `details.get(...)` fallbacks (`"Processing failed"`, `None`, `True`) for these keys.
- **C-2.** The builder's exact key set MUST be `{error, error_message, stage, retryable}`. Adding or removing a key is a contract change and MUST require touching the contract test (that is the drift guard working as intended). The published `details` MAY be a superset of the builder output solely due to the publisher's `jobId` injection.
- **C-3.** `error` and `error_message` MUST carry the same string.
- **C-4.** `error_message` MUST be non-empty; if `str(e)` is empty or whitespace, the builder MUST substitute the exception type name (e.g. `"ValueError"`) so a useless empty string never reaches Firestore and the rag-api fallback is never operative.
- **C-5.** `stage` MUST be a non-empty string from the vocabulary in §4.2; `"processing"` is the safe value when the stage is genuinely unknown.
- **C-6.** `retryable` MUST be a JSON boolean, explicitly derived (§4.3), never absent and never defaulted by the consumer.

### 4.2 Stage vocabulary (closed set)

Reuses the existing progress-stage vocabulary exactly; no new names are introduced:

```
starting | text_retrieved | tagging_complete | summary_generated |
chunking_complete | embeddings_complete | processing   (safe/unknown)
```

(`completed` exists in the progress vocabulary but is a success stage; it is not a valid failure stage.)

### 4.3 retryable derivation (normative)

- **D-1.** `retryable = classify_error(e)` — the worker's existing classifier is the single source of truth:
  - classified **transient** (`TransientError`, connection/timeout types, HTTP 429/500/502/503/504) → `retryable: true`;
  - classified **permanent** (`PermanentError`, other 4xx, and **unclassified-unknown**, per `classify_error`'s conservative default) → `retryable: false`.
- **D-2.** The derivation MUST be explicit in the payload. rag-api's `details.get("retryable", True)` fallback MAY remain in code for non-worker senders but MUST NOT be the operative mechanism for worker failures.
- **D-3.** Accepted behavior change: unclassified-unknown exceptions flip from persisted `retryable: true` (today's silent default) to `retryable: false`. This is the conservatism `classify_error` was written for; manual reprocess via `POST /process` is unaffected. Widening `classify_error` is out of scope.
- **D-4.** The stale-lease sweep's direct write (`retryable: true`, `error_stage: "processing"`) is unchanged and remains correct: a dead worker is a transient condition.

### 4.4 rag-api persistence mapping (unchanged code, pinned by test)

For a `failed` status message, rag-api's existing failed branch persists:

| Persisted location | Source |
|---|---|
| main doc `error` | `details["error_message"]` |
| main doc `error_stage` | `details["stage"]` |
| main doc `retryable` | `details["retryable"]` |
| `processing/summary.error.message` | `details["error_message"]` |
| `processing/summary.error.stage` | `details["stage"]` |
| `processing/summary.error.code` | `details.get("error_code", "UNKNOWN")` → `"UNKNOWN"` (worker sends none) |

Worker-provided values MUST be persisted unchanged — no transformation, no re-defaulting when the keys are present.

## 5. Functional requirements

Priority legend: **MUST** = binding (definition `must`/requirement), **SHOULD** = strong preference (definition `prefer`).

### FR-1 (MUST) — Failure payload carries the contract keys
When document processing fails, the worker's failed status payload MUST include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload MUST never rely on rag-api's fallback defaults for these keys. *(Definition R1; facts F3, F4, F5; constraints C-1..C-6.)*

### FR-2 (MUST) — Stage tracking through `process_document`
The worker MUST track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage. Stage names MUST reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown. The tracker MUST be set immediately before each pipeline step (the "set before the await" convention). *(Definition R2; fact F9.)*

### FR-3 (MUST) — rag-api persists worker values unchanged
rag-api's failed branch MUST persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing/summary` error subdocument MUST carry the same message and stage. This is satisfied by the **existing** rag-api code once the worker sends the contract keys; rag-api's reads and persisted schema MUST NOT change. *(Definition R3; facts F4, F6; constraint "must not change rag-api's reads or persisted schema".)*

### FR-4 (MUST) — Explicit retryable derivation aligned with classification
The retryable derivation MUST be explicit and aligned with the worker's error classification: errors classified transient by `classify_error` → `retryable: true`; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable: false`. *(Definition R4; facts F7, F8.)*

### FR-5 (MUST) — Contract test on the worker failure → rag-api persistence path
A contract test MUST cover the worker failure → rag-api persistence path. It MUST exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values. It MUST fail if either side's payload keys drift. It MUST cover at least an early-stage failure and a late-stage failure (representative stages), and both a transient-classified and a permanent-classified exception. *(Definition R5; fact F10.)*

### FR-6 (SHOULD) — Retain the legacy `error` key
The worker's failure payload SHOULD retain the legacy `error` key alongside `error_message` (same value) for continuity with any existing consumers of the status topic and log tooling. *(Definition R-prefer; fact F11.)*

### FR-7 (SHOULD) — Non-empty message guard
The failure-payload builder MUST guarantee a non-empty `error_message` (see C-4) so an empty `str(e)` can never silently degrade the persisted error. *(Strengthens FR-1; prevents an empty-string bypass of the fallback.)*

### FR-8 (SHOULD) — Failure log carries stage and retryable
The worker's `document_processing_failed` log event SHOULD include the failing `stage` and derived `retryable` so support can disambiguate failures from logs alone, without Firestore access. *(Serves fact F1's "users and support can disambiguate failures".)*

## 6. Non-functional requirements

- **NFR-1 (MUST)** — No Firestore migration, field rename, or backfill of existing documents. Persisted fields keep their names (`error`, `error_stage`, `retryable`) and semantics. *(Definition constraint must_not.)*
- **NFR-2 (MUST)** — Deploy-order safety: because rag-api already reads the contract keys, a worker-only deploy immediately fixes behavior; there is no coordinated rollout, no API deploy, and no dual-write window.
- **NFR-3 (MUST)** — The contract test MUST run hermetically (fakes by default; Firestore emulator acceptable where available) with no real GCP credentials.
- **NFR-4 (MUST NOT)** — No structured error-code taxonomy is introduced; `processing/summary.error.code` remains `"UNKNOWN"` unless a code is actually sent (the worker sends none). *(Definition prefer_not.)*
- **NFR-5 (SHOULD)** — No new runtime dependencies, configuration keys, or Pub/Sub topic/subscription changes.
- **NFR-6 (SHOULD)** — Payload size impact negligible (one duplicated error string per failure message).

## 7. Constraints (from the authoritative definition)

| # | Type | Constraint |
|---|---|---|
| K-1 | must | Align the worker to rag-api's existing contract (`error_message`/`stage`/`retryable`); do not change rag-api's reads or persisted schema. |
| K-2 | must_not | No Firestore migration, field rename, or backfill; persisted fields (`error`, `error_stage`, `retryable`) keep names and semantics. |
| K-3 | must | Every worker-originated failure payload carries `retryable` explicitly; the API-side `details.get("retryable", True)` fallback must not be operative for worker failures. |
| K-4 | prefer | Retain the legacy `error` key alongside `error_message`. |
| K-5 | prefer_not | Do not introduce a structured error-code taxonomy. |

## 8. Acceptance criteria

| # | Criterion (from definition acceptance) | Verified by |
|---|---|---|
| A-1 | A failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults. | CT-1, CT-2, UT-1..UT-4 |
| A-2 | After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not `None`), and `retryable` = the worker's derived value. | CT-3 |
| A-3 | The `processing/summary` error subdocument for the failed job carries the same message and stage as the main document. | CT-4 |
| A-4 | A contract test covering the worker failure → rag-api persistence path exists and passes: it exercises the worker's failure-payload construction through rag-api's failed-branch persistence and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, failing if either side's payload keys drift. | CT-1..CT-6 (incl. drift guards CT-5, CT-6) |

## 9. Traceability matrix

| Definition requirement | FR | Acceptance | Tests |
|---|---|---|---|
| R1 (payload keys, no fallback reliance) | FR-1, FR-6, FR-7 | A-1 | UT-1, UT-2, CT-1, CT-2 |
| R2 (stage tracking, vocabulary, safe value) | FR-2 | A-1, A-2 | UT-3, UT-4, CT-2 |
| R3 (rag-api persists unchanged) | FR-3 | A-2, A-3 | CT-3, CT-4, CT-6 |
| R4 (retryable derivation) | FR-4 | A-1, A-2 | UT-2, CT-3 |
| R5 (contract test + drift guard) | FR-5 | A-4 | CT-1..CT-6 |
| Constraint K-4 (legacy `error` key) | FR-6 | A-1 | UT-1, CT-5 |
| Constraint K-2 (no migration) | NFR-1 | — | design review |
| Constraint K-5 (no error-code taxonomy) | NFR-4 | — | CT-4 asserts `code == "UNKNOWN"` |

## 10. Out of scope (non-goals, binding)

- Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the **reporting** of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — `processing/summary.error.code` remains `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable in this context; deferred), and reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` (file not present in the current tree).
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api failure payload contract alignment

- **Source of truth:** WorkItem `wi-define-108-a8` (artifact `definition:obj-108`, sha256 `71f1c39c…`). Requirements: `docs/requirements.md`.
- **Status:** design (iteration 1)

---

## 1. Context: the seam as it exists today

```
rag-worker (process_document)
    │  try: 6 pipeline steps, each followed by
    │       _publish_status_update(..., "processing", {"stage": <name>, "progress": n})
    │
    │  except Exception as e:                         ← ONE try block around everything
    │      _publish_status_update(..., "failed", {"error": str(e)})   ← 1-key payload
    ▼
Pub/Sub topic rag-status-updates
    ▼
rag-api subscriber (_process_status_message)
    ▼
run_transactional_update(db, doc_ref, "failed", details, ...)
    ├─ main_update["error"]       = details.get("error_message", "Processing failed")  ← never present
    ├─ main_update["error_stage"] = details.get("stage")                              ← always None
    ├─ main_update["retryable"]   = details.get("retryable", True)                    ← silent default
    └─ processing/summary ← {error: {code: "UNKNOWN", message: "Processing failed", stage: None}}
```

**Root cause:** the worker's failure publisher and rag-api's failure consumer were written against different contracts, and nothing tests the seam. The persisted `error`/`error_stage`/`retryable` schema is already consistent across three other write paths (worker stale-lease sweep `_fail_if_still_stale`, rag-api's `POST /process` and `POST /resources` enqueue-failure writes) and two read models (`Resource` dataclass, `ResourceResponse`) — the worker's status publisher is the only writer that doesn't speak it.

**Why the worker aligns to the API (not vice versa):** the persisted field names are already consistent everywhere else, so changing the API side is the change that ripples (readers, models, mobile contract fixtures in `tests/integration/test_api_contracts.py`). The worker is the odd one out; fix the odd one out. No migration, no backfill, no reader changes.

## 2. Design principles

1. **Align the worker to the API's existing contract** — `error_message`/`stage`/`retryable` in, `error`/`error_stage`/`retryable` persisted, values passed through unchanged.
2. **Derive, don't default** — every failure payload field is deliberately produced by the worker; the consumer's fallbacks become dead code on this path.
3. **Reuse existing vocabulary** — stage names come from the progress-update timeline clients already see; retryable comes from the existing `classify_error`.
4. **Test the seam, not a copy of the seam** — the contract test imports both sides and runs the real payload through the real failed branch rather than restating the contract in a fixture.
5. **Minimal diff** — rag-api: zero code changes. Worker: stage tracker + payload builder + handler rewiring + log fields.

## 3. Target design

### 3.1 Worker changes (`apps/ai-server/rag-worker-service/main.py`)

**(a) Failure-payload builder** — a module-level function next to `classify_error`, so the handler stays thin and the builder is directly testable:

```python
UNKNOWN_STAGE = "processing"          # safe value; same as the stale-lease sweep's error_stage
FAILURE_PAYLOAD_KEYS = {"error", "error_message", "stage", "retryable"}

def build_failure_details(e: Exception, stage: Optional[str]) -> Dict[str, Any]:
    """Contract payload for a failed status update.

    Keys are pinned by tests/integration contract test (drift guard):
    rag-api's failed branch reads error_message / stage / retryable.
    The legacy `error` key is retained for unknown consumers of the topic.
    """
    message = str(e).strip() or type(e).__name__          # never an empty string
    return {
        "error": message,             # legacy key, same value (compat hedge)
        "error_message": message,     # contract key → persisted `error`
        "stage": stage or UNKNOWN_STAGE,
        "retryable": classify_error(e),   # transient → True, permanent/unknown → False
    }
```

**(b) Stage tracker in `process_document`** — one local, set immediately before each pipeline step (the "set before the await" convention), read by the exception handler:

```python
current_stage = UNKNOWN_STAGE
try:
    current_stage = "starting"
    await self._validate_processing_request(...)
    await self._publish_status_update(..., "processing", {"stage": "starting"}, job_id)

    current_stage = "text_retrieved"
    text_content, doc_metadata = await self._get_extracted_text(...)
    ...
    current_stage = "tagging_complete"
    tags, confidence_scores = await self.content_tagger.generate_tags(...)
    ...
    current_stage = "summary_generated"
    summary_data = await self.generate_document_summary(...)
    ... (doc update + publish)
    current_stage = "chunking_complete"
    chunks = await self._create_enhanced_chunks(...)
    ...
    current_stage = "embeddings_complete"
    vectors = await self._generate_embeddings_with_openrouter(chunks)
    ...
    # steps 6a/6b (delete old vectors, store chunks), metadata save,
    # completed publish, usage update, resource map:
    # tracker intentionally stays at "embeddings_complete" (see §4)
    ...
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    failure_details = build_failure_details(e, current_stage)
    self.logger.error("document_processing_failed", ..., stage=failure_details["stage"],
                      retryable=failure_details["retryable"])
    await self._publish_status_update(user_id, course_id, resource_id, "failed",
                                      failure_details, job_id)
    if trace: trace.update(output={"success": False, "error": str(e)})
    return metrics
```

The success path is untouched: `final_details` keeps `"stage": "completed"`, and the existing per-step `_publish_status_update(..., "processing", {"stage": ...})` calls are unchanged. `_publish_status_update` keeps injecting `jobId` into `details` — the contract test treats published details as a superset of the builder output for exactly that key.

**(c) What does NOT change in the worker**

- `classify_error`, `TransientError`/`PermanentError`, and `run_worker`'s ACK/NACK logic (retry/backoff mechanics are a non-goal).
- `_fail_if_still_stale` (sweep keeps writing `error`/`error_stage: "processing"`/`retryable: true` directly — already contract-consistent).
- Heartbeats, leases, sequence numbers, lease-renewal side effect of `_publish_status_update`.

### 3.2 rag-api changes: none (by design)

`run_transactional_update` already implements the required persistence mapping (main doc `error`/`error_stage`/`retryable` from `error_message`/`stage`/`retryable`; `processing/summary.error` = `{code, message, stage}` with `error_code` defaulting to `"UNKNOWN"`). Because the worker previously never sent those keys, the fallbacks were operative; once the worker sends them, the same lines persist the real values. The `details.get(..., default)` fallbacks **remain in code** (harmless, and they still cover any non-worker sender), but they are no longer the operative mechanism for worker failures — that is exactly constraint K-3. The contract test pins the rag-api side so future edits to its failed branch cannot silently re-create the mismatch.

### 3.3 Resulting persisted document (failed job, after fix)

```jsonc
// users/{uid}/resources/{rid}
{
  "status": "failed",
  "error": "OpenRouter connection failed: ConnectError",   // actual message
  "error_stage": "embeddings_complete",                     // actual stage
  "retryable": true,                                        // classify_error said transient
  "status_updated_at": "<server timestamp>"
}
// users/{uid}/resources/{rid}/processing/summary
{ "error": { "code": "UNKNOWN", "message": "OpenRouter connection failed: ConnectError",
             "stage": "embeddings_complete" }, ... }
```

## 4. Stage tracking design

### 4.1 Stage map (tracker value ← pipeline segment)

| Pipeline segment (in execution order) | Tracker value set before it | Notes |
|---|---|---|
| function entry, before `try` | `"processing"` | safe/unknown; matches sweep's `error_stage` |
| `_validate_processing_request` + `"starting"` publish | `"starting"` | first tracker set inside `try` |
| Step 1 `_get_extracted_text` (incl. inline PDF extraction) | `"text_retrieved"` | |
| Step 2 content tagging | `"tagging_complete"` | |
| Step 3 summary generation + doc update + publish | `"summary_generated"` | |
| Step 4 chunking | `"chunking_complete"` | |
| Step 5 embeddings | `"embeddings_complete"` | |
| Steps 6a/6b (delete old vectors, store chunks), metadata save, completed publish, usage update, resource map | *(unchanged)* `"embeddings_complete"` | no later name exists in the closed vocabulary; last known progress stage |

Rationale for the tail segment: the vocabulary is closed by requirement (no new stage names), and reporting a fabricated `"storage"` stage would break the shared vocabulary clients already render. A vector-storage failure therefore reports `embeddings_complete` — "failed at/after embeddings, before completion" — which is accurate at the granularity the vocabulary supports.

### 4.2 Convention and drift risk

- **Convention:** set the tracker immediately before the `await` of the step. A future pipeline step added without updating the tracker reports the previous stage — degraded but never null and never misleading about *earlier* stages.
- **Mitigation:** the contract test pins the mechanism on representative stages — one early-stage failure (`text_retrieved`) and one late-stage failure (`embeddings_complete`) — enough to catch the tracker being removed or bypassed without ossifying every step.

## 5. retryable derivation design

`retryable = classify_error(e)` — the same function that already classifies every exception for the worker's ACK/NACK decisions in `run_worker`. One classification system, one meaning of "retryable".

| Exception | `classify_error` | Persisted `retryable` |
|---|---|---|
| `TransientError`, `httpx.ConnectError/ConnectTimeout/ReadTimeout/WriteTimeout/PoolTimeout`, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError` | transient | `true` |
| `httpx.HTTPStatusError` with status 429/500/502/503/504 | transient | `true` |
| `PermanentError`, `httpx.HTTPStatusError` with other 4xx | permanent | `false` |
| anything else (unclassified-unknown) | permanent (conservative default) | `false` ← **behavior change** |

- **Behavior change, deliberate:** unclassified-unknown exceptions flip from persisted `true` (today's silent consumer default) to `false`. This is the conservatism `classify_error` was written for — it prevents open-ended retry loops. Manual reprocess via `POST /process` is unaffected in both cases.
- **Semantics of the flag:** `retryable: true` marks an error condition of a kind worth re-attempting (transient by classification; automatic re-attempt where the transport provides it — redelivery/lease-stealing for lost or dead-worker cases — or manual reprocess via `POST /process` otherwise). `retryable: false` marks a condition only manual reprocess can address.
- **Sweep stays as-is:** `_fail_if_still_stale` keeps writing `retryable: true` with `error_stage: "processing"` — a worker dying mid-extraction is a transient condition by nature, and the sweep is a non-goal.

## 6. Compatibility & rollout

- **Deploy order:** worker-only deploy. rag-api already reads the contract keys, so the fix lands the moment the worker ships. No coordinated rollout, no dual-write window, no feature flag.
- **Unknown consumers of the status topic (compat hedge):** only rag-api's status subscriber is a verified consumer, but other services/tooling share the topic. Rather than audit every potential reader for a one-line fix, the worker retains the legacy `error` key alongside `error_message` (one redundant string per failure message). If a later audit confirms rag-api is the only consumer, dropping the duplicate is trivial cleanup — and will require touching the contract test, which is the drift guard doing its job.
- **Existing failed documents:** untouched (no backfill, per K-2). They keep their historical fallback values; new failures persist real values.
- **Log tooling:** the worker's structured `failed` status log (`status_update_published`) already prints `details`; the `document_processing_failed` event gains `stage` and `retryable` fields.

## 7. Contract test architecture (FR-5)

House patterns to reuse: fixture- and AST-based static contract tests in `apps/ai-server/tests/integration/test_api_contracts.py` (including its subprocess-AST-script pattern), and the Firestore transaction fakes (`FakeTx`/`FakeSnap`/`FakeRef`/`FakeDb` + identity `firestore.transactional`) proven in `apps/ai-server/rag-worker-service/tests/unit/test_processing_lease.py`.

### 7.1 Test inventory

| ID | Layer | Location | What it pins |
|---|---|---|---|
| UT-1 | worker unit | `rag-worker-service/tests/unit/test_failure_payload.py` | builder key set == `{error, error_message, stage, retryable}`; `error == error_message`; non-empty message guard (empty `str(e)` → type name) |
| UT-2 | worker unit | same | retryable mapping: transient type → `true`; `PermanentError`/4xx/unknown → `false` |
| UT-3 | worker unit | same | stage tracker: processor built via `__new__` with stubbed collaborators; step methods monkeypatched to raise at representative points; captured `_publish_status_update` details carry the expected stage (`text_retrieved` early, `embeddings_complete` late, `"processing"` pre-first-set) |
| UT-4 | worker unit | same | unknown-stage safe value: builder called with `None`/`""` → `stage == "processing"` |
| CT-1 | seam | `apps/ai-server/tests/integration/test_worker_failure_contract.py` (new) | worker-built payload, fed through rag-api's real `run_transactional_update`, persists `error`/`error_stage`/`retryable` equal to the worker's values |
| CT-2 | seam | same | representative stages: early-stage failure persists `error_stage == "text_retrieved"`; late-stage failure persists `error_stage == "embeddings_complete"` |
| CT-3 | seam | same | both derivations: transient-classified exception persists `retryable: true`; permanent-classified persists `retryable: false` |
| CT-4 | seam | same | `processing/summary.error` = `{code: "UNKNOWN", message == payload["error_message"], stage == payload["stage"]}` |
| CT-5 | drift guard | same | worker side: builder key set must equal `FAILURE_PAYLOAD_KEYS` exactly — any worker key edit fails the build |
| CT-6 | drift guard | same | rag-api side: AST scan of `run_transactional_update` (source-segment extraction, house pattern) must show the failed branch reading `details.get("error_message")`, `details.get("stage")`, `details.get("retryable")` and persisting `error`/`error_stage`/`retryable` — any rag-api failed-branch key edit fails the build |

### 7.2 Seam test mechanics (CT-1..CT-6)

- **Worker side (payload construction):** the test spawns a subprocess (`sys.executable -c script`, mirroring `_get_agent_graph_shapes`) that puts `rag-worker-service` on `sys.path`, imports the worker's `tests/conftest.py` stub environment (package `tests` is importable; it sets env defaults and stubs heavy deps), then `import main` and calls `main.build_failure_details(exc, stage)` for the scenario matrix: {transient (`httpx.ConnectError`), permanent (`ValueError`), unknown (`RuntimeError`)} × {early stage, late stage}, printing JSON. This exercises the worker's authentic code path without cross-service `sys.modules` stub collisions. *Fallback (if the subprocess proves brittle in CI):* extract `build_failure_details` (+ `classify_error`, which depends only on `httpx`) into a leaf module (e.g. `rag-worker-service/utils/failure_payload.py`) re-exported by `main.py`, and import it directly — the builder remains the worker's code path either way.
- **rag-api side (persistence):** in-process, using the existing `apps/ai-server/tests/integration/conftest.py` mocks (`import main as rag_api_main` already works there). Seed a fake resource doc with `status: "processing"` (a legal `processing → failed` transition), monkeypatch `firestore.transactional` to an identity wrapper and `SERVER_TIMESTAMP` to a sentinel (worker-test pattern), run `rag_api_main.run_transactional_update(fake_db, doc_ref, "failed", payload, logger, user_id)`, then assert on the recorded transaction writes:
  - main doc: `status == "failed"`, `error == payload["error_message"]`, `error_stage == payload["stage"]`, `retryable == payload["retryable"]`;
  - summary subdoc: `error.message == payload["error_message"]`, `error.stage == payload["stage"]`, `error.code == "UNKNOWN"`.
- **Emulator option:** where `FIRESTORE_EMULATOR_HOST` is available, the same assertions may run against a real Firestore client (both services already have emulator branches). Fakes are the default hermetic path; the emulator is optional hardening, not a requirement.
- **Negative check (mismatch regression):** one scenario feeds a legacy-shaped payload (`{"error": ...}` only) and asserts the persisted values are the fallbacks — documenting, inside the test, exactly the bug being fixed, so a future revert of the worker side fails loudly with a readable message.

### 7.3 Environment prerequisites

The seam test needs both services' import environments in one test run: rag-api deps (already required by `test_api_contracts.py`) plus the worker's dependency set for the subprocess (already required wherever worker unit tests run). No new dependencies are introduced.

## 8. Failure modes & risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Unknown consumers of the status topic read only the old `error` key | low | low | legacy `error` key retained (FR-6); dropping it later is a deliberate, test-visible change |
| Stage-tracker drift as the pipeline evolves (new step without tracker update) | medium | low | "set before the await" convention documented at the tracker; representative early/late stage tests (UT-3, CT-2); degraded result is a stale-but-non-null stage |
| `retryable: false` for genuinely transient-but-unrecognized failures reduces auto-retry affordances | medium | low | accepted per definition D-3; `classify_error` widening is out of scope; manual reprocess via `POST /process` unaffected; sweep still writes `retryable: true` for dead-worker cases |
| Contract test ossifies the payload | certain | intended | that is the drift guard; adding a key means touching the test (CT-5/CT-6), which is the point |
| Subprocess import of worker `main` brittle in CI | low | medium | documented fallback: leaf-module extraction of the builder (§7.2) |
| Empty `str(e)` producing a useless persisted error | low | low | non-empty guard in the builder (FR-7/C-4) |

## 9. Alternatives considered (rejected)

| Alternative | Why rejected |
|---|---|
| Change rag-api to read the worker's `error` key (+ migration for `stage`/`retryable`) | Contradicts the binding direction (K-1); ripples into readers, `Resource`/`ResourceResponse`, and mobile contract fixtures; requires schema work the definition forbids (K-2). |
| Rename persisted fields to match the worker (`error_message`, …) | Requires Firestore migration/backfill — forbidden (K-2); three other write paths and two models already use `error`/`error_stage`/`retryable`. |
| Derive `retryable` on the API side from heuristics | Violates K-3 (silent default remains operative) and hides the worker's own classification; the worker already has the authoritative classifier. |
| Introduce structured error codes now | `prefer_not` (K-5); `summary.error.code` stays `"UNKNOWN"`. |
| New failure-reporting topic / dual publish | Unjustified infrastructure for a payload-key fix; NFR-5. |

## 10. Observability & ops notes

- `document_processing_failed` log gains `stage` and `retryable` (FR-8); `status_update_published` already emits full `details`, so the new keys appear there automatically.
- Support runbook effect: a failed resource now shows the real message and stage in `GET /resources/{id}/status` (`error`, `error_stage`) — no Firestore console needed to disambiguate.
- No metrics, dashboards, or alerts change; no new config; no topic/subscription changes.

## 11. Deferred / open items

- **Companion D3 issue** referenced by the Objective: content unavailable in this context; anything it covers beyond this payload alignment is deferred (definition F12).
- **`plans/upload-flow.md` D4 reconciliation:** file not present in the current tree; reference exists only in Objective text — deferred.
- **Dropping the legacy `error` key:** possible follow-up cleanup if a consumer audit confirms rag-api is the only subscriber; deliberately not done now (K-4).
- **Widening `classify_error`** to recognize more transient conditions: out of scope; revisit only if `retryable: false` on unrecognized-transient failures proves operationally painful.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>