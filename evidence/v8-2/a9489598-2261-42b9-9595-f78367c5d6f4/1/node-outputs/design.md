<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — Worker Failure Payload Contract Alignment (rag-worker → rag-api)

Work Item: `wi-define-108-a8`
Definition SHA256 (authoritative): `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`

## 1. Problem Statement

When a RAG processing job fails, the worker's exception handler publishes a single-key status
payload (`{"error": str(e)}`). Rag-api's failed branch in `run_transactional_update` reads three
keys (`error_message`, `stage`, `retryable`) and persists them onto the resource document. Due to
the key mismatch, every worker-originated failure currently persists:

- `error` = fallback string `"Processing failed"` (worker's actual message lost),
- `error_stage` = `None`,
- `retryable` = silently-defaulted `True`.

Users and support cannot disambiguate failures; the persisted retryability contradicts the
worker's actual ACK/NACK decision.

## 2. Scope Boundary

In scope: the worker's failure-status payload construction, stage tracking within
`process_document`, retryable derivation, rag-api's passthrough persistence confirmation, and a
contract test pinning the seam.

Out of scope (from the Definition's non-goals):

- Stale-lease sweep behavior — `_fail_if_still_stale` already writes `error`/`error_stage`/
  `retryable=True` correctly.
- Retry/backoff mechanics: Pub/Sub ACK/NACK policy, leases, heartbeats — only the *reporting*
  of retryability changes.
- Frontend/mobile changes — `ResourceResponse` already exposes `error`/`error_stage`.
- Structured error-code taxonomy — `error.code` in the processing/summary subdoc stays `"UNKNOWN"`
  unless a code is actually sent.
- Anything covered by the companion D3 issue beyond this alignment (content unavailable; deferred),
  including reconciliation with the historical D4 deviation note (`plans/upload-flow.md` absent
  from the tree).

## 3. Functional Requirements

FR-1 — Failure payload completeness. When document processing raises, the worker's failed status
payload MUST contain:
- `error_message`: the actual exception message,
- `stage`: the pipeline stage executing at failure time,
- `retryable`: a deliberately derived boolean.
The payload MUST NOT rely on rag-api's fallback defaults for any of these keys.

FR-2 — Legacy compatibility key. The payload SHOULD also retain the legacy `error` key carrying
the same message, for continuity with any unknown consumers of the status topic (per assumption
F11). Dropping it later is permitted once consumption is audited.

FR-3 — Stage tracking. The worker MUST track the currently executing pipeline stage throughout
`process_document` such that the exception handler reports the true failing stage. Constraints:
- Stage names MUST reuse the existing progress vocabulary: `starting`, `text_retrieved`,
  `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`.
- Convention: the tracker variable is updated immediately BEFORE each awaited pipeline step.
- When the stage is genuinely unknowable (failure before the first tracked transition), the value
  MUST be `"processing"` — the same safe value used elsewhere for `error_stage` — never `null`.

FR-4 — Retryable derivation. The worker MUST derive `retryable` explicitly from
`classify_error(e)` using the adopted rule (assumption F8):
- Exception classified TRANSIENT → `retryable = true` (Pub/Sub will redeliver);
- Exception classified PERMANENT — including unclassified-unknown, since `classify_error`
  conservatively defaults those to permanent → `retryable = false` (job acked; manual reprocess
  via `POST /process` remains available).
Rationale: the persisted record must agree with the worker's ACK/NACK behavior. Note this is a
deliberate behavior change: previously-silent `retryable=true` becomes `false` for
unclassified-unknown errors.

FR-5 — API passthrough fidelity. Rag-api's failed branch MUST continue to persist the
worker-supplied values unchanged:
- main document: `error` ← payload `error_message`, `error_stage` ← payload `stage`,
  `retryable` ← payload `retryable`;
- processing/summary error subdocument: `message` and `stage` carry the same values; `error_code`
  defaults to `"UNKNOWN"` as today.
No reader changes, no schema/migration/name changes on the API side.

## 4. Non-functional Requirements

NFR-1 — No migration constraint. The fix MUST NOT require a Firestore migration, field rename, or
backfill. Persisted field names (`error`, `error_stage`, `retryable`) and their semantics remain
exactly as-is.

NFR-2 — Consistency invariant. For any worker-originated failure, the following MUST hold after
persistence:
```
resource.error == worker_payload["error_message"]
resource.error_stage == worker_payload["stage"]        # never null for worker failures
resource.retryable == worker_payload["retryable"]
subdoc.message == resource.error && subdoc.stage == resource.error_stage
```

NFR-3 — Existing behaviors preserved. Transient/permanent classification logic, ACK/NACK routing
in `run_worker`, lease handling, and the stale-lease sweep's independent failure write are all
unchanged.

## 5. Testing Requirements

TR-1 — Seam contract test. A test MUST exist under the established integration-contract location
(`apps/ai-server/tests/integration/`, extending the pattern of `test_api_contracts.py`) that:
- builds the failure payload through the worker's real code path (imported, not restated);
- feeds it through rag-api's `run_transactional_update` failed branch against the Firestore
  emulator (both services have `FIRESTORE_EMULATOR_HOST` hermetic modes) or faithful fakes;
- asserts NFR-2 holds end-to-end;
- includes a key-set drift guard asserting the exact expected payload keys on the worker side and
  the exact expected detail-keys on the api side, so adding/removing/renaming keys on either side
  breaks the build.

TR-2 — Representative stage coverage. The contract test MUST verify stage reporting for at least
one early-stage failure and one late-stage failure, sufficient to detect removal/bypass of the
tracker without ossifying every pipeline step.

TR-3 — Retryable mapping coverage. Tests MUST cover at minimum: a transient-classified error
persisting `retryable=true` and a permanent/unclassified error persisting `retryable=false`.

## 6. Acceptance Criteria

From the authoritative Definition (all initially `met: false`):

AC-1 — A failed job's published status message contains `error_message` (actual exception
message), `stage` (failing pipeline stage), and `retryable` (deliberately derived); none relies on
rag-api's fallback defaults.

AC-2 — After a failed job, the persisted resource document shows `error` = the worker's actual
message (never `"Processing failed"`), `error_stage` = the failing stage (never `None`),
`retryable` = the worker-derived value.

AC-3 — The processing/summary error subdocument carries the same message and stage as the main
document.

AC-4 — The contract test described in TR-1/TR-2/TR-3 exists and passes.

## 7. Known Unknowns (to resolve during implementation)

- Exact call-site signatures and surrounding control flow in `main.py` files (evidence refs from
  the Definition confirmed the handlers exist; precise line placement is an implementation detail).
- Whether any third-party/log tooling parses the legacy `error` key (hedge retained regardless).
- Full inventory of subscribers to the status topic (out-of-band hedged by FR-2).

## 8. Risk Register

| Risk | Mitigation |
|---|---|
| Unknown consumers break if legacy `error` dropped | Keep `error` beside `error_message` (FR-2) |
| Future pipeline steps skip stage tracking | Update-before-await convention + TR-2 representative tests |
| Unclassified-transient-looking errors become non-auto-retried | Accepted consequence of conservative `classify_error`; manual reprocess intact |
| Contract test ossification | Intentional drift-guard property (per Definition) |
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — Worker Failure Payload Contract Alignment

Work Item: `wi-define-108-a8`

## 1. Context and Topology

Two services participate in the failure-reporting seam:

```
┌───────────────┐   publish(failed status payload)   ┌──────────────┐
│ rag-worker    │ ─────────────────────────────────► │ rag-api      │
│ rag-worker-   │         (status topic)             │ run_transac- │
│ service       │                                    │ tional_update│
│ main.py       │                                    │ → Firestore  │
└───────────────┘                                    └──────────────┘
```

Other writers to the same persisted failure schema (NOT modified by this change):

- Worker stale-lease sweep `_fail_if_still_stale` — writes `error`/`error_stage`/"processing"/
  `retryable=True` directly.
- Rag-api enqueue-failure paths (`/process`, `POST /resources`) — write the same triple directly.
- Readers: `ResourceResponse` and the `Resource` model expose `error`/`error_stage`/`retryable`
  (retryable defaults `true` at the model level).

The worker's status publisher is the sole misaligned writer; this design fixes exactly that node
without touching readers or sibling writers.

## 2. Design Decisions

D-1 — Worker aligns to API, not vice versa. Rag-api's persisted field names
(`error`, `error_stage`, `retryable`) are already shared by three write paths and two response
models. Renaming the API side would ripple; renaming the worker's outgoing payload keys costs one
locality. Chosen direction mirrors the Objective preference (fact F2).

D-2 — Stage tracker as a pre-await local. Within `process_document` (currently one large try
block whose handler lacks positional awareness), add a mutable local, e.g. `current_stage`,
initialized to `"processing"` and reassigned to the appropriate vocabulary term immediately
BEFORE each awaited pipeline step:

```
stages observed in progress updates (existing vocabulary):
starting → text_retrieved → tagging_complete → summary_generated
        → chunking_complete → embeddings_complete → completed
```

The exception handler then publishes `current_stage`. Initialization to `"processing"` guarantees
early failures (before the first assignment) report the safe sentinel rather than `None`,
matching the sweep's convention. Reusing the progress-vocabulary terms lets a failure stage sit
naturally adjacent to the progress timeline clients already render.

Drift-control convention (recorded norm, not enforced by lint): assign the tracker just above
every new awaited step; the contract test anchors two representative positions.

D-3 — Retryable derives from the existing classifier. `classify_error(e)` is already invoked per
exception and governs ACK/NACK in `run_worker` (Transients get NACK/redelivery; permanents get
acked). The failure handler computes `retryable = isinstance/classification == TRANSIENT` via the
same function in the same handler, guaranteeing a single evaluation point consistent with the
delivery outcome:

| Classification (incl. heuristic sources) | Published retryable | Delivery behavior |
|---|---|---|
| TransientError / transient heuristics | `true` | NACK → Pub/Sub redelivers |
| PermanentError / permanent heuristics | `false` | Acked; manual reprocess via POST `/process` |
| Unrecognized exception (conservative default) | `false` | Acked; manual reprocess |

Behavior-change note: unrecognized exceptions flip from effectively-`true` (silent API default)
to `false`. This matches the classifier's anti-infinite-loop intent; the sweep continues writing
`true` legitimately because a crashed worker is inherently transient.

D-4 — Dual-key publication hedge. The failed payload sends BOTH `error_message` AND legacy
`error` (identical strings), plus `stage` and `retryable`:

```json
{
  "error": "<str(e)>",
  "error_message": "<str(e)>",
  "stage": "<current_stage>",
  "retryable": <bool>
}
```

Cost: ~tens of duplicated bytes per rare event. Benefit: immunity to unaudited topic subscribers
(only rag-api's subscriber is verified today, fact F11). Removal is a documented follow-up pending
consumer audit.

## 3. Component Changes

### 3.1 `apps/ai-server/rag-worker-service/main.py`
- `process_document`: declare `current_stage`; insert assignments ahead of each awaited pipeline
  segment corresponding to the six tracked transitions; initialize to `"processing"`.
- `process_document` exception handler: replace `details={"error": str(e)}` with the four-key
  dict from §2/D-4, deriving `retryable` via `classify_error(e)`.
- No changes to: `_publish_status_update` signature/mechanics, `run_worker` ACK/NACK logic,
  lease/heartbeat timers, `_fail_if_still_stale`.

### 3.2 `apps/ai-server/rag-api-service/main.py`
- Zero behavioral change required. `run_transactional_update` failed branch already reads
  `error_message`/`stage`/`retryable` via `details.get(...)` and persists them verbatim along with
  the subdoc copy (`error_code` untouched ⇒ `"UNKNOWN"`). It simply starts receiving well-formed
  input.

### 3.3 Persistence surface (`rag-api-service/models/resource.py`)
- Untouched. Field names/types/default stay identical (no migration, no backfill, satisfying the
  hard constraint).

### 3.4 New: contract test
Location follows the established home: extend
`apps/ai-server/tests/integration/test_api_contracts.py` (fixture-/AST-style precedent) or a
peer module thereunder.

Structure:
1. **Worker side (real code exercised)** — drive the failure-payload construction, ideally by
   invoking/faking the exception path of `process_document` (emulator-compatible), OR minimally by
   calling the extracted builder if extraction proves necessary; capture the emitted details dict.
2. **Key-drift guards (static assertions)**
   - Assert worker payload key set ⊇ {`error`, `error_message`, `stage`, `retryable`} and equals
     it modulo tolerated extras (explicit allow-list).
   - Assert rag-api failed-branch reads exactly {`error_message`, `stage`, `retryable`} (source /
     AST scan of `run_transactional_update`, mirroring existing AST-based checks).
3. **API side (hermetic execution)** — invoke `run_transactional_update` against the Firestore
   emulator via `FIRESTORE_EMULATOR_HOST` branching already supported by both services, falling
   back to faithful fakes/emulation stubs if runtime constraints demand.
4. **Persistence assertions** — post-write snapshot yields
   `error == error_message`, `error_stage == stage`, `retryable == derived_bool`, subdoc
   `{message, stage}` mirror match, `error_code == "UNKNOWN"`.
5. **Scenario matrix** — ≥1 early-stage failure (verifies `"processing"` init or earliest assigned
   stage propagates) and ≥1 late-stage failure; ≥1 transient-mapped case (`retryable=true`) and
   ≥1 permanent/unclassified case (`retryable=false`).

Fallback note: if live invocation of the async pub/sub hand-off is brittle in the harness, tests
may import-and-call the payload-builder unit while keeping the raw-source key-scan assertion
(item 2) as the binding contract check between physical files — preserving drift detection even
when emulation simplifications apply.

## 4. Data Flow (after change)

Failure path sequence:

```
await pipeline_step_n          ┐
   ▲ current_stage := name_n   ├─ raise E
                               ┘ except:
   cls = classify_error(E)                    → determines ACK/NACK (UNCHANGED)
   payload = {
     error: str(E),
     error_message: str(E),
     stage: current_stage,
     retryable: cls.is_transient
   }
_publish_status_update(status="failed", details=payload)
                                          │
                            Pub/Sub status topic
                                          ▼
              rag-api subscriber → run_transactional_update(failed branch)
                ├── details["error_message"] ──→ doc["error"]
                ├── details["stage"]         ──→ doc["error_stage"]
                ├── details["retryable"]     ──→ doc["retryable"]
                └── subdoc(message=str(E), stage=current_stage,
                           code="UNKNOWN")
```

Success path and progress-message formats remain byte-for-byte unchanged.

## 5. Invariants Summary

I-1  Persisted triplet ⇄ worker payload equality (see NFR-2 in requirements).
I-2  `error_stage != nil` for ANY worker-originated failure (sentinel `"processing"` floor).
I-3  Exactly-one derivation site for retryable-per-event: `classify_error` output copied
     straight into the payload; never recomputed downstream.
I-4  Sweep/enqueue/API-direct-writer outputs remain bit-compatible with new-format inputs (they
     already populate equivalent shapes; overlap validated implicitly by AC-2 regression suite).
I-5  No new topics, schemas, indexes, migrations, or client-visible endpoint/response deltas.

## 6. Deployment & Rollback Considerations

- Services deploy independently; intermediate states degrade gracefully backward-compatibly:
  - Old-worker ↔ new-API: API sees missing `error_message` etc., behaves identically to today
    (fallbacks active) — strictly not worse than baseline.
  - New-worker ↔ old-API: extra/aliased keys ignored harmlessly by `.get(...)`.
- Thus rollout order is unconstrained; rollback is symmetric (reverting the worker restores prior
  observable state minus the fixed columns; reverting rag-api is unnecessary though harmless).
- Post-deploy validation query suggestion (operational, optional): sample recent failed resources
  confirming `error_stage IS NOT NULL` and `error != "Processing failed"` among worker-caused ones.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>