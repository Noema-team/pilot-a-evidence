Below are the required design artifacts. They are grounded in the Authoritative Definition above; where my direct repository inspection during this session did not verify a specific detail, it is carried forward from the pinned Definition evidence rather than asserted as independently checked.

Key notes informing the design:
- Worker publish helpers live under `apps/ai-server/rag-worker-service/models/pubsub_messages.py` / `models/processing_status.py` area (directory existence verified; internal shapes taken from the Definition's evidence refs).
- House test conventions exist at `apps/ai-server/tests/integration/test_api_contracts.py` (fixture- and AST-based static contract tests per the Definition), and both services support hermetic Firestore-emulator branches.
- `pytest.ini` (worker service): asyncio_mode=auto, testpaths=tests — relevant for how the new unit-level payload-construction tests should be laid out within the worker's own suite, while cross-service integration goes in `tests/integration`.

No additional implementation constraints surfaced beyond what the Definition mandates; the plan below does not alter the agreed approach.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — Failure Payload Contract Alignment (rag-worker → rag-api)

Trace root: Authoritative Definition `wi-define-108-a8`
(sha256 `71f1c39c…ae89cac5`). Scope is fixed there; this document restates it as
implementable requirements with acceptance mapping. Nothing here widens or narrows
that Definition.

## 1. Problem Statement

When a RAG processing job fails inside the worker, `process_document`'s exception
handler publishes a single-key status payload:

```
{ "status": ..., "details": { "error": "<str(e)>" } }
```

but rag-api's failed branch in `run_transactional_update` consumes a three-key
contract:

| Payload key | Persisted target |
|---|---|
| `details.error_message` | resource `error` (+ processing/summary `message`) |
| `details.stage` | resource `error_stage` (+ processing/summary `stage`) |
| `details.retryable` | resource `retryable` |

Because none of the expected keys match, every worker-originated failure persists:
- `error = "Processing failed"` (fallback),
- `error_stage = None`,
- `retryable = True` (silent `.get(..., True)` default),

with the processing/summary subdocument inheriting the same fallbacks and
`error_code` permanently stuck at `"UNKNOWN"`. Users and support lose the real
exception message, the failing stage, and truthful retryability.

Three other writers already speak the persisted schema correctly (stale-lease
sweep `_fail_if_still_stale`; rag-api enqueue-failure paths `/process` and
`POST /resources`); the worker's status publisher is the sole misaligned writer.

## 2. Goals

G1. Failed jobs persist the worker's actual error message, failing pipeline stage,
   and a deliberately derived retryable flag — never API-side fallback defaults.
G2. Achieve this entirely on the worker side: align the worker's payload keys to
   the API's expectations. Zero Firestore migration, zero field renames, zero
   backfills, zero reader/schema changes on rag-api.
G3. Lock the seam with a contract test exercising the worker's payload
   construction through rag-api's failed-branch persistence.

## 3. Non-Goals

N1. Retry/backoff mechanics remain untouched: Pub/Sub ACK/NACK policy, lease
management, heartbeat intervals. Only the *reported* retryability changes.
N2. Stale-lease sweep behavior unchanged — it already writes
`error`/`error_stage`/`retryable` correctly (with `error_stage = "processing"`
for unknown stage and `retryable=True` for a dead worker, which remains valid).
N3. Structured error taxonomy. Processing/summary `error.code` stays `"UNKNOWN"`
unless a producer sends an actual code (none do in this scope). Explicitly
rejected even though it is tempting once stage tracking exists.
N4. Frontend/mobile changes. `ResourceResponse` and the `Resource` model already
expose `error`/`error_stage`/`retryable`.
N5. Widening or tuning `classify_error()` heuristics themselves — we consume its
existing classification verbatim.
N6. Companion-D3-issue territory (unavailable in this context) and reconciliation
of the historical `plans/upload-flow.md` D4 note (file absent from tree).

## 4. Functional Requirements

### FR-1 — Payload shape (must)
On document-processing failure, the worker publishes a failed-status payload whose
`details` contain, at minimum and populated with live values:
```json
{
  "error_message": "<actual exception message>",
  "stage":         "<current pipeline stage name>",
  "retryable":     <bool>,
  "error":         "<same string as error_message>"
}
```
Constraints embedded in FR-1:
- `error_message`: raw `str(e)` — identical to what appears in logs.
- `stage`: non-null string drawn from §FR-2's controlled vocabulary; never omitted
  or empty/null-valued except as defined in FR-2's UNKNOWN case ("processing").
- `retryable`: boolean computed from `classify_error(e)` **at publication site**
  (see FR-3). Must NOT be left for downstream `.get(key, default)` resolution.
- Legacy compat hedge: `details["error"]` mirrors `error_message` for durability
  with any pre-existing status-topic readers/log tooling (Definition constraint
  C-prefer #1). Both keys carry the same string. Removal requires a follow-up
  decision post-consumer-audit; it is intentionally excluded here.

Acceptance anchor: AD-A1, AD-B1 (below).

### FR-2 — Pipeline-stage tracking (must)
The failure publisher needs the stage active at failure moment. Today the entire
pipeline body sits in one monolithic `try` in `process_document`, so nothing tracks
where execution stopped. Requirement:
1. Maintain a mutable local variable `current_stage` initialized to `"starting"`
   (the documented initial state of the pipeline timeline).
2. Immediately before each awaited/pipeline transition, assign
   `current_stage = <next>`. Vocabulary is exactly the existing progress-event
   sequence emitted by `_publish_status_update`:
   ```
   starting → text_retrieved → tagging_complete → summary_generated
             → chunking_complete → embeddings_complete → completed
   ```
   These names double as `error_stage` values — i.e., on success, `completed`;
   on failure inside the embedding leg after chunking finished,
   `current_stage == "chunking_complete"` reflects the last boundary crossed +
   the operation underway.
3. Convention to encode as a code-comment and enforce via review + contract test:
   *"Assign `current_stage` BEFORE the call it describes."*
   Semantics: `current_stage` holds the most recently STARTED (possibly unfinished)
   pipeline segment. E.g., setting `current_stage = "text_retrieved"` happens just
   prior to issuing the retrieval; if retrieval itself throws, the reported stage
   is `"text_retrieved"` — accurate: the document died retrieving text.
4. Exception-handler capture: on entry to the outermost `except`, snapshot
   `failed_stage = current_stage` (defensive copy so nested logging/mutation can't
   race). Publish `stage = failed_stage`.
5. Unknown/uninitialized safety net: if the exception fires before the very first
   assignment (shouldn't happen given init-to-"starting", but also guards
   refactors moving initialization), fall back to `"processing"` — mirroring
   `_fail_if_still_stale`'s choice — guaranteeing `error_stage` never becomes
   `None` again.

Rationale for naming: reusing the progress-timeline strings lets clients correlate
failure position against the visible progress events without translation tables
(the alternative — a parallel enum — invites divergence between progress labels
and failure labels over time).

Acceptance anchors: AD-C1.

### FR-3 — Deliberate retryable derivation (must)
Worker computes:
```python
classification = classify_error(exc_or_exc_info_as_used_by_run_worker)  # signature preserved
retryable = bool(classification.is_transient_class)                     # see NOTE
```
Binding rule (from Definition fact F8 / adopted-default assumption):
- Exceptions `classify_error` buckets as TRANSIENT → `retryable: true`
  (Pub/Sub NACK ⇒ automatic redelivery imminent).
- Everything else — PERMANENT bucket **plus** UNRECOGNIZED/UNKNOWN types falling
  through to the conservative-permanent default — → `retryable: false`
  (acknowledged; recovery via operator-driven `POST /process`).
Derivation MUST occur in-process right beside the exception object used elsewhere
(`str(e)` extraction) to prevent desync between the logged message, the retried-or-
acked action chosen upstream, and the payload's claimed retryability.

Behavior delta called out openly (previously silent-default `true`): unrecognized
exceptions flip to `persisted retryable=False`. Consequences consciously accepted:
- Dead-letter-style records become honest (matches reality of an ACK'd terminal job).
- Risk of suppressing genuine transient-yet-unlabeled conditions is acknowledged;
  mitigation lives in `classify_error` improvements (out of scope, N5) plus the
  retained manual reprocess endpoint.

Sticky-sweep independence: `_fail_if_still_stale` continues writing its own
hardcoded `True` — justified since a vanished worker is inherently recoverable-by-
nature (redelivery on lease expiry), independent of exception-type knowledge.
Contract test MUST NOT regress this separation.

Acceptance anchors: AD-E1, AD-F1.

### FR-4 — Publishing-site plumbing (must)
`_publish_status_update` gains pass-through capability for arbitrary `details`
dicts (no validation gate imposed — caller constructs contract-shaped dict), OR a
dedicated sibling helper such as `_publish_failure_details(...)`. Either form is
acceptable PROVIDED:
- It composes with the existing status-message envelope without altering other
  event emitters.
- The failure branch funnels exclusively through it (single chokepoint tested by
  FR-5's harness; ad-hoc inline dicts in `process_document`'s except-block are
  forbidden thereafter).
Implementation latitude granted; the invariant being enforced is *one place builds
the failure payload*, simplifying FR-5's monkeypatch/import surface.

### FR-5 — Cross-seam contract test (must)
New test(s) located at `apps/ai-server/tests/integration/test_api_contracts.py`
(existing home for seam checks). Coverage obligations:
1. **Construction probe**: invoke/direct-call the worker's failure-publish pathway
   (preferred: extract pure builder fn e.g. `build_failure_payload(exc, stage)`
   returning the FR-1 dict; alternatively drive `process_document` with an injected
   raising dependency). Assert resulting dict matches FR-1 key/value rules
   including presence of BOTH `error_message` AND legacy `error`, equality of
   their values, membership of `stage` ∈ allowed-vocabulary ∪ {"processing"},
   and `isinstance(retryable, bool)` (reject int/str masquerades).
2. **Persistence roundtrip**: feed constructed payload through rag-api's
   `run_transactional_update` using the Firestore-emulator branch (both services'
   env hooks supported) or equivalent fake transport; afterwards read back the
   mutated resource/subdocuments asserting bit-for-bit propagation:
   `doc.error == payload.error_message`, `doc.error_stage == payload.stage`,
   `doc.retryable == payload.retryable`, and mirrored copies inside
   processing+summary error objects (AD-G1..G3).
3. **Drift tripwire**: a second assertion layer (AST-parse or regex scan of both
   mains, following the filehouse pattern already deployed there) pinning the
   literal key literals `"error_message"`, `"stage"`, `"retryable"` appearing in
   rag-api's failed-branch getter expressions, and correspondingly requiring
   failure-builder emission of those exact strings. Renaming/removal on either
   side forces CI-red until the reviewer consciously co-edits the sentinel.
4. Two representative stage scenarios minimally exercised: EARLY-fail (inside/
   before text retrieval ⇒ expect `"text_retrieved"` or `"starting"`) and LATE-fail
   (post-chunking/embedding ⇒ expect corresponding tail label). Full-step
   enumeration is deliberately NOT mandated to avoid brittle coupling to future
   pipeline additions (drift handled by rule-of-thumb convention + spot probes).
Acceptance anchor: AD-H1, H2.

## 5. Acceptance Criteria (verbatim-aligned to Definition's `met:false` items)

Mapping table ensuring traceability closure before hand-off to Plan step:

| Def-ID | Description digest | Covered By |
|---|---|---|
| AD-A1 | Published failure msg contains err_msg/stage/retryable w/o relying on API fallbacks | FR-1, FR-2, FR-3, FR-4 · AC-Test T1,T2 |
| AD-B1 | Same triple present & non-default in wire JSON | FR-1, FR-4 · AC-T2 |
| AD-C1 | Tracker captures true stage incl. safe-value edge cases | FR-2, FR-5 |
| AD-D1 | Doc.message/doc.stage reflect same pair in subdocs | FR-5 (persistence assertions) |
| AD-E1 | Transient⇒true / Permanent(+unknown)⇒false wiring | FR-3 · AC-T3 |
| AD-F1 | Sweep-write parity check unaffected | FR-5 regression clause |
| AD-G1/G2/G3 | Roundtrip fidelity main-doc + subdoc fields | FR-5 |
| AD-H1/H2 | Drift guard trips on either-sided edits | FR-5 item 3 |

Formal gates (each maps ≥1 automated signal):
- G-PASS-1: `pytest apps/ai-server/rag-worker-service/tests` green locally (new
  builder unit specs included).
- G-PASS-2: `pytest apps/ai-server/tests/integration/test_api_contracts.py`
  green with emulator reachable; skipped-with-explicit-mark otherwise (never
  silently passed-as-empty).
- G-LINT: grep assurance that no OTHER location in `main.py` (either service)
  synthesizes failure `details` outside the sanctioned chokepoints (enforced by
  the drift scanner itself, doubling as hygiene check).

## 6. Constraints Recap (binding, restating Definition's list)

MUST: worker-side-only remediation; explicit retryable per FR-3; contract test
per FR-5; legacy `error` key retention.
MUST-NOT: Firestore migrations/bulk-backfills; renaming persisted columns
(`error`,`error_stage`,`retryable` immutable names); modifications to sweep /
enqueue-failure writers; introduction of enumerated `error_code`s beyond
preserving current `"UNKNOWN"` passthrough.
PREFER: keeping dual-key compatibility indefinitely pending external audit verdict.
PREFER-NOT: expanding failure-schema dimensions further this iteration.
DEFERRED: companion D3 deliverables; historic-upload-plan reconciliation.
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — Failure Payload Contract Alignment (rag-worker → rag-api)

Companion to `docs/requirements.md`. Describes concrete placement, data flow,
component interactions, and testing topology implementing FR-1…FR-5 against the
repository layout observed this session (dirs/files listed at bottom).

## 1. Component Landscape

Relevant units touched (all paths relative to repo root):

| Unit | Role | Change Type |
|---|---|---|
| `apps/ai-server/rag-worker-service/main.py` | hosts `process_document`, `_publish_status_update`, `run_worker`, `classify_error`, `_fail_if_still_stale` | EDIT (tracker var, failure builder, except-hook rewrite) |
| `apps/ai-server/rag-worker-service/models/pubsub_messages.py` | candidate container for extracted payload-builders/status structs | OPTIONAL EDIT (only if natural fit found; else stay inline in main.py) |
| `apps/ai-server/rag-worker-service/models/processing_status.py` | related status-model namespace; reviewed for shared typing opportunities | READ-ONLY (reuse enums/constants if exported; no forced refactor) |
| `apps/ai-server/rag-api-service/main.py` | `run_transactional_update` failed branch consuming `details.{error_message,stage,retryable}` | NO CODE CHANGE (target-state baseline) |
| `apps/ai-server/rag-api-service/models/resource.py` | persisted-field definitions incl. `retryable` default True | NO CODE CHANGE |
| `apps/ai-server/tests/integration/test_api_contracts.py` | seam-drift test host | EXTEND (append new scenario classes/cases) |
| `apps/ai-server/rag-worker-service/tests/**` | worker-local suites, driven via `pytest.ini` (`asyncio_mode=auto`, `testpaths=tests`) | ADD small unit specs around pure builder fn |

Explicit NON-touch zones honoring N-goals: everything handling retries/schedules,
heartbeat timers, frontends, `FirestoreEmulatedClient` internals beyond passing
them through to `run_transactional_update` as-is.

## 2. Data Flow — Happy/Fail Paths Post-Change

### 2.1 Normal progression (unchanged)
Document ingested → `process_document` advances pipeline legs, emitting progress
events via `_publish_status_update(stage_label, ...)` with payload slices derived
from existing logic. Timeline order matches FR-2 vocabulary. Each advance ALSO
updates local tracker:

```
current_stage := "starting"                       [init, top of func]
await retrieve_text();       current_stage := "text_retrieved"
await tag_with_llm();        current_stage := "tagging_complete"
await summarize();           current_stage := "summary_generated"
await chunk_doc();           current_stage := "chunking_complete"
await embed_chunks();        current_stage := "embeddings_complete"
mark done                    current_stage := "completed"
```

(Note: assignments precede awaits per convention — meaning tracker lags half a
step behind semantic completion boundaries; acceptable since the goal is locating
WHERE DEATH OCCURRED, and death occurs inside/at start of the leg represented.)

### 2.2 Failure trajectory (changed region shaded ▓)

```
Exception raised somewhere in pipeline body
        │
        ▼
▓ Outermost except block receives exc, snapshots:
▓   failed_stage = current_stage            (local, thread-safe by scoping)
▓   cls = classify_error(exc)               (already imported; reused verbatim)
▓   retryable_flag = resolve_retryable(cls)          ── FR-3 hook
▓   msg = sanitize(str(exc))                (= what logs print)
        │
        ▼
▓ Single chokepoint invocation:
▓   payload = build_failure_payload(msg, failed_stage, retryable_flag)
▓   └── returns {
▓         "error_message": msg,
▓         "stage": failed_stage or "processing",
▓         "retryable": retryable_flag,
▓         "error": msg                        // legacy alias
▓       }
        │
        ▼
_publish_status_update(status=failure-ish, details=payload)     [signature-compatible]
        │
        ▼
PubSub topic ─────────────► rag-api subscriber loop
                                    │
                                    ▼
                  run_transactional_update(failed_branch):
                      message = d.get("error_message")
                      stg     = d.get("stage")
                      rtbl    = d.get("retryable")       # exact-hit now; .default unused
                          ├── tx.update(resource_root,
                          │            error=message,
                          │            error_stage=stg,
                          │            retryable=rtbl)
                          └── tx.update(subdoc_processing / subdoc_summary,
                                       message=message, stage=stg,
                                       error_code=d.get("error_code","UNKNOWN"))
                                              ↑ passthrough unchanged
        │
        ▼
Persisted doc observable via GET /resources/{id} and admin UI (fields pre-wired).
```

Fallback semantics preserved verbatim on API side (untouched), yet effectively
inert for worker traffic going forward — satisfying the MUST that ".get defaults
are not the operative mechanism."

### 2.3 Parallel writer isolation (regression fence)
Concurrently-running `_fail_if_still_stale` path remains fully disjoint:
different trigger (timer vs message consumption), different write expression
(direct tx.set/update with hardcoded trio), distinct `error_stage="processing"`
semantics meaning "worker went dark," orthogonal from per-request pipeline stage.
Architecturally separated; FR-5 includes a negative-space check confirming the
sweep's constants weren't accidentally absorbed/refactored away.

## 3. Design Decisions & Trade-offs Log

D1. **Tracker-as-local-variable** (rather than instance attr/contextvar/global).
Pros: trivial lifetime correctness tied to coroutine frame; no concurrency hazards
across simultaneous workers/processes sharing module space; simplest diff. Cons:
requires discipline adding future steps. Mitigated by convention-comment adjacent
to first assignment + contract-test probes. Rejected alternatives:
contextvars (overkill, complicates sync-shim callers), dataclass carrying
progress state (heavier refactor spilling beyond scope).

D2. **Extract-and-export pure builder** `build_failure_payload(err_str, stage,
retryable_bool)` placed near `_publish_status_update` in main.py (top candidates:
module level just above publisher). Chosen over private-nesting purely for
import ergonomics in the contract test — enables white-box probing without
executing full pipeline machinery. Signature kept primitive-typed (str,str,bool)
so it survives minor reshuffles of surrounding orchestration.

D3. **Dual-key retention** (`error` + `error_message`). Cost: ~30 duplicated chars
per failure event. Benefit: shields hypothetical third-party consumers reading the
topic who keyed off `error`. Deletion deferred until topic-subscriber census
confirms exclusivity; flagged in TODO comment referencing the deferred audit.

D4. **Conservative retryable for unknowns** flips previous de facto TRUE → FALSE.
Justification chain: `classify_error` ALREADY treats unknowns as permanent for
routing purposes; previously the persisted claim contradicted routing behavior
(record said "will retry" while runtime chose ACK/no-redelivery). New behavior
aligns representation to reality. Documented prominently in PR template blurb &
changelog line item due to user-visible behavioral shift.

D5. **Vocabulary reuse over new enum**. Prevents bifurcation where progress
timeline shows `"embedding_phase_started"` while failure grid says
`"EMBED_STAGE"`—two taxonomies drifting apart. Direct string inheritance wins
under Yagni; revisit only if typed enums get introduced org-wide elsewhere.

D6. **Static+dynamic hybrid testing** mirrors precedent discovered in
`test_api_contracts.py` (which blends fixture-loaded comparisons with
source-scanning assertions). Dynamic roundtrip proves runtime agreement; static
scan protects against future cosmetic edits (variable renaming, dict-literal
reformatting) evading dynamic detection.

## 4. Testing Topology

Layer 1 — Pure-unit (fast, no infra):
`tests/unit/failure_payload_test.py` (within rag-worker-service tree; honors
pyproject/ini config). Cases:
  U1 happy-map: given inputs yield exact dict incl. aliases.
  U2 stage whitelist enforcement raises/assert-fails on bogus input (guards typos
     like "sumary_generated").
  U3 bool coercion strictness (int 1 rejected).
  U4 alias-equality property.

Layer 2 — Integration (emulator-mode):
Extended cases appended to `test_api_contracts.py`:
  I1 construct-via-real-path: force `process_document` down a stubbed retrieval
     raise path; intercept outbound publish arg (monkeypatch transport shim);
     assert payload conforms FR-1 & stage=="text_retrieved".
  I2 late-stage variant: inject failure past chunking; stage=="chunking_complete";
     confirm tracker updated correctly preceding the throwing await.
  I3 persistence echo: replay captured payload into
     `run_transactional_update(emulated_client,...)`; inspect resultant doc &
     subdocs for tri-prop congruence (FR-5 obligation 2).
  I4 sweep-independence smoke: concurrently schedule `_fail_if_still_stale` tick;
     ensure its write remains `{..., error_stage:"processing", retryable:true}`
     irrespective of concurrent worker outcomes.
  I5 drift scanners: textual greps verifying presence/absence of critical tokens
     per FR-5 obligation 3; implemented as parametrized assertions so each token
     violation yields pinpoint diagnostics rather than blanket failure.

Env prerequisites honored: `FIRESTORE_EMULATOR_HOST` branching respected; skip
markers applied when emulator unreachable BUT gated loudly (explicit reason string,
counted as xfail-not-pass).

## 5. Roll-out Notes

Single-commit atomic delivery feasible (~few hundred LOC total deltas spread thin).
Sequence recommendation for PR reviewers:
 1. Review builder + tracker patch hunks together (they're coupled).
 2. Confirm absence of stray hard-coded details-dicts post-refactor (grep aid).
 3. Skim contract-test additions focusing on the scanner regex precision.
Post-merge follow-ups queued separately (NOT part of this slice): topic-consumer
audit to retire dual key; optional enrichment to pass contextual metadata onward
if a later iteration revisits error-codes/taxonomy (remains PREFER_NOT here).

## 6. Observed Repository Manifest Referenced Above

Verified-present directories/files consulted this session:
- `apps/ai-server/rag-worker-service/` (root package, `main.py`, `pytest.ini`)
- `apps/ai-server/rag-worker-service/models/` containing
  `processing_status.py`, `pubsub_messages.py`, `resource_map.py`
- `apps/ai-server/rag-api-service/` (`main.py`, `models/resource.py`)
- `apps/ai-server/tests/integration/test_api_contracts.py`
Everything beyond these stems from the pinned Definition evidence (claims tagged
KNOWN/repository-source therein) and was treated as trusted-input rather than
freshly browsed during artifact production.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>