Plan reviewed internally; emitting the required artifact below.

````
<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Implementation Plan — Worker Failure Payload Contract Alignment

Run: 19c8b352-ba7d-4ef2-add9-ed38ac332914 | Iteration 1 | Authoritative Definition: wi-define-108-a8

## Goal

Align the rag-worker's failed-status payload with rag-api's failed-branch contract
(`error_message`, `stage`, `retryable`) so failed jobs persist the real error message,
failing pipeline stage, and a deliberately derived retryable flag — verified end-to-end
by a contract test over the worker → rag-api failure path.

Non-negotiable framing from the Definition:
- Fix the **worker** to match rag-api's existing reads/persisted schema (`error`,
  `error_stage`, `retryable` stay untouched). No migration, rename, or backfill.
- Every worker-originated failure payload carries all three keys explicitly;
  rag-api's `details.get(...)` fallbacks become inert for worker failures.
- Legacy `error` key retained in the payload (hedge for unknown topic consumers).
- No error-code taxonomy introduced (`error_code` may keep defaulting to `"UNKNOWN"`).

---

## Design Decisions (pre-resolved by the Definition)

| Decision | Choice |
|---|---|
| Which side moves? | Worker emits `error_message`/`stage`/`retryable`; rag-api reads unchanged |
| Persisted field names | Unchanged: `error`, `error_stage`, `retryable` (main doc), `message`/`stage` (processing/summary subdoc) |
| retryable derivation | `classify_error(e)`: transient → `True`, permanent/unclassified-unknown → `False` (per F8) |
| Stage vocabulary | Existing progress-stage names: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embedding_complete*`; safe fallback `"processing"` (same constant as `_fail_if_still_stale` uses for `error_stage`) |

*Note on naming:* verify whether the last pre-completion progress update emitted by the
current code is spelled `embeddings_complete` or `embedding_complete` (Definition F9 lists
`embeddings_complete`) and use whichever spelling appears in the live
`_publish_status_update` call sites verbatim, so a mid-late-stage failure reads correctly
against the progress timeline. If both spellings exist in the repo history, normalize to
what the current code emits — do NOT invent new stage strings.

Known behavior change accepted by the Definition (record it in PR notes):
Unclassified-unknown exceptions previously persisted `retryable: true` via the silent
default; under this change they persist `retryable: false` because `classify_error`
defaults conservatively to permanent. Manual reprocess via `POST /process` is unaffected.
The stale-lease sweep's own `retryable=True` write is intentionally untouched (dead worker
is transient).

---

## File-by-file Changes

All edits target the worker service unless stated otherwise:

```
apps/ai-server/rag-worker-service/
├── main.py                      # core change: stage tracker, failure payload builder
└── exceptions.py                # NO functional change needed (see Task 1 verification)
tests/
└── integration/test_api_contracts.py   # extend with worker↔api failure-path contract test
apps/ai-server/rag-api-service/
└── main.py                      # READ ONLY — no production changes permitted
```

### Task 1 — Verify assumptions about existing helpers (investigation-in-plan)

Before writing the diff, confirm within `rag-worker-service/main.py`:

1. Locate the `except Exception` handler inside `process_document` that constructs
   `details={"error": str(e)}` and hands off to `_publish_status_update(status="failed", ...)`.
2. Confirm `classify_error(e)` returns a plain boolean (`bool`), callable once and reused
   for both the payload and left intact for `run_worker`'s ACK/NACK logic.
   Unit coverage already proves the mapping: `TransientError`/`ConnectionError`/timeouts/
   connect-read timeouts/HTTP 429+503 → `True`; `PermanentError`/ValueError/generic/
   HTTP 400+404 → `False` (existing `TestErrorClassification::test_*` cases pin this).
3. Note how `str(e)` renders `PDFProcessingError` instances — since those override state
   with `super().__init__(self.message)`, standard stringification yields `message`, so the
   payload needs no special-casing for custom exception types.
4. Record the exact sequence/order of `_publish_status_update(..., stage=...)` calls (if
   such an arg already exists) vs. inline literals like `status=f"text_{i}"` etc., to pick
   the lowest-churn insertion point for stage tracking.

If item (4) reveals an existing stage parameter threaded through helper functions, adopt it
as the single source of truth rather than introducing a parallel variable.

### Task 2 — Track the executing pipeline stage through `process_document`

Add a local mutable holder inside `process_document` (function-local closure variable, e.g.
`current_stage = "processing"`, mutated immediately *before* each phase begins):

```
current_stage = "processing"

async def process_document(resource_id: str, blob_uri_or_payload..., ):
    ...
    except Exception as exc:
        ...
```

Mutation points (set BEFORE attempting the phase, i.e. mutate then execute, so an exception
inside the phase reports the phase being attempted):

| Phase (in execution order observed today) | Value assigned to `current_stage` |
|---|---|
| Entry / initial fetch-and-parse | `"starting"` |
| Text retrieval/extraction completes → publish progress | `"text_retrieved"` |
| Tagging phase begins | `"tagging_complete"` |
| Summary phase begins | `"summary_generated"` |
| Chunking phase begins | `"chunking_complete"` |
| Embedding phase begins | `"embeddings_complete"` (match exact spelling used in progress emissions) |
| Final completion publication | leave whatever precedes; success path overrides anyway |

Two subtleties handled deliberately:

- Mutate-then-execute ordering means a failure *during* a phase attributes itself to that
  phase even though the corresponding *_complete* progress event hasn't fired yet. This is
  intentional and matches user expectation ("it died while doing X"). Document the choice
  in a short comment near the holder declaration.
- Initialization to `"processing"` guarantees the field is never empty/None even if an
  unexpected early exit occurs (matching `_fail_if_still_stale`'s convention of using
  `"processing"` when the true stage is unknowable).

Since Python closures capture by reference and we're mutating a local variable inside the
same function body (no nested async helpers need rebinding), no `nonlocal` keyword is
required — unless refactor discovers phases implemented as sibling coroutines, in which case
promote the holder to a small mutable object passed down (avoid `global` entirely).

Alternative considered and rejected: threading stage explicitly through every helper's
signature. Churn-heavy relative to benefit given the flat structure of `process_document`;
revisit only if the file grows further decomposition later.

### Task 3 — Build the compliant failure payload

Replace the current failure-detail dict with a constructed payload satisfying rag-api's
reads exactly. Target shape:

```python
failure_details = {
    "error_message": str(exc),
    "stage": current_stage,
    "retryable": classify_error(exc),
    # legacy alias preserved for hedged compatibility (constraint F11 / prefer-type constraint)
    "error": str(exc),
}
_publish_status_update(
    resource_id=resource_id,
    status="failed",
    details=failure_details,
    ...)
```

Implementation notes:

- Compute `retryable = classify_error(exc)` ONCE locally; pass the stored result forward.
  Even though `run_worker` independently consults classification for ACK/NACK, storing the
  computed value in a local var lets us add a debug-level log line pairing the decision
  with the outcome, aiding ops triage of "why is this flagged unrecoverable".
- Keep `str(exc)` identical between the two aliases (`error_message` and `error`) —
  divergence there invites confusion in logs/dashboards reading different keys.
- DO NOT touch the `success`/progress payloads anywhere in `process_document` — the
  contract under repair affects only the `"failed"` branch emission.
- Preserve whatever logging/timing surrounds the exception handler today (stack traces,
  metrics counters, lease-release calls) — reorder nothing unrelated.

Edge-case audit checklist (verify manually post-edit, list results in PR description):

- [ ] Empty-string exception messages (`raise ValueError("")` upstream) — payload still
      well-formed, api stores empty string rather than falling back. Acceptable per spec
      (fallback is defined on absence-of-key, not emptiness).
- [ ] Exceptions raised *outside* `process_document` entirely (message-consumer setup,
      subscription init) don't route through this handler — confirm they retain existing
      handling and aren't accidentally routed through the new path.
- [ ] Concurrent mutation safety: `current_stage` writes happen sequentially within one
      coroutine invocation; no cross-task sharing concerns arise.
- [ ] JSON serializability: `str()` guarantees a string; booleans serialize natively in
      the pub/sub envelope encoding already used elsewhere.

### Task 4 — Extend the contract test suite

File: `apps/ai-server/tests/integration/test_api_contracts.py`

Existing patterns prove feasibility (fixture-driven fake/emulated storage + static
AST assertions). Compose TWO complementary layers per the spirit of the Definition's
acceptance criteria ("must fail if either side's payload keys drift").

#### Layer A — Behavioral round-trip test (primary proof)

Construct a realistic scenario exercising BOTH ends:

1. Instantiate or invoke the worker's failure-payload construction path with a controlled
   exception input (subclass `Exception`, force `classify_error` to yield a deterministic
   answer — easiest: raise something whose classification is stable, e.g. a synthetic
   `RuntimeError` subclass registered permanently OR monkeypatch-free approach choosing
   `ValueError` which maps to permanent=False deterministically per unit-tested table).
2. Capture the resulting payload dict returned/built by the modified worker code.
3. Feed that captured payload into rag-api's `run_transactional_update` configured against
   the Firestore emulator (preferred; fall back to the existing in-repo fakes if emulator
   startup proves flaky in CI timing — check what the neighboring tests already settle on
   and mirror THAT mechanism, don't pioneer a third one).
4. Read back the persisted resource document after commit.
5. Assert equality of ALL THREE mapped fields:

```
persisted.error               == payload["error_message"]
persisted.error_stage         == payload["stage"]
persisted.retryable           == payload["retryable"]       # NOT defaulted-True anymore
subdoc_processing_summary.message == payload["error_message"]
subdoc_processing_summary.stage   == payload["stage"]
```

Also assert the negative-space invariant: repeat the loop with a second variant that
intentionally OMITS `retryable` from the payload, and confirm the persisted value equals
whatever rag-api's documented fallback produces — proving our primary assertion above isn't
accidentally green due to coincidental defaults masking a dropped key.

Repeat matrix — parametrize over representative classifications so both boolean outcomes
of the derivation rule get exercised end-to-end:

| Parametrization | Input exception | Expected persisted retryable |
|---|---|---|
| transient | synthesized `TransientError("-")` or equivalent | `True` |
| permanent-typed | `PermanentError("-")` | `False` |
| permanent-heuristic | `ValueError("boom")` | `False` |
| unknown-default | bare `Exception("mystery")` | `False` (conservative default!) |

For each row also vary the injected `current_stage` value across at least 2 distinct
entries from the allowed vocabulary (one late-stage like `"embeddings_complete"`, one
early/safe like `"processing"`) to catch bugs where stage propagation works only at some
phases.

#### Layer B — Static drift-guard test

Because behavioral tests can pass despite cosmetic renames surviving unnoticed until
runtime, add a lightweight static scan asserting the contract survives refactors:

Option chosen: regex/text-scan approach mirroring the pattern presumably used elsewhere in
this test module (inspect neighbors first; if they lean on `ast.parse` node walking for
call-site detection, follow suit for consistency).

Assertions to encode statically:

- In `rag-worker-service/main.py` (source text of `process_document` region or whole file):
  - The failure-details construction includes occurrences of `"error_message"` AND
    `"stage"` AND `"retryable"` AND `"error"` together in proximity (within N chars /
    within the same enclosing expression), guarding accidental deletion of any key.
  - Exactly one occurrence of `"processing"` serving as the initializer for the stage
    holder (tolerates comments nearby but flags multiple divergent sentinel assignments).
- In `rag-api-service/main.py` (READ of the failed branch, purely observational — this
  guards against someone ELSE silently editing the reader later):
  - Occurrences of `"error_message"`, `"stage"`, `"retryable"` appear within the failed-
    branch lookup expressions.
  - Presence of the `.get(... , True)` fallback for retryable is expected TODAY and simply
    noted as tolerated (our worker always supplies the key so the fallback never fires);
    if a future refactor removes the fallback entirely, this scanner shouldn't break —
    therefore assert only on presence of the KEY LITERALS, not the fallback syntax.

Keep the static layer fast (<100ms) and dependency-light (pure stdlib parsing of source
strings/filesystem reads) so it runs identically regardless of emulator availability.

### Task 5 — Update adjacent documentation touched indirectly

Minimal-touch hygiene items only (scope discipline — none expand the fix):

- Inline docstring/comment atop `process_document` noting the failure-handler contract and
  pointing readers toward the contract test filename for enforcement location.
- If `plans/*.md` contains a running deviations/issues ledger referencing this defect ID
  (search for the phrase used in the objective header, "contract mismatch"), append a
  resolution pointer. SKIP creation of new planning artifacts — the Definition forbids
  widening scope and mentions `plans/upload-flow.md` is absent from the tree anyway, so
  reconciliation of historical D4 notes is explicitly deferred (goal F12).

No README/API-doc changes required: client-facing response shapes are governed by
`ResourceResponse` which already surfaces `error`/`error_stage`; zero public-API delta.

---

## Sequencing & Dependencies

```
Task 1 ──► Tasks 2 + 3 (single cohesive worker patch; land together so intermediate
              commits never ship half-migrated payloads)
Task 4A depends on Tasks 2+3 complete (imports worker symbols).
Task 4B can technically start anytime after Task 3 locks key literals; schedule last
          so it reflects FINAL literal choices including the embeddings-spelling decision.
Task 5 trivially follows everything else.
```

Commit granularity suggestion: ONE feature commit spanning worker changes + contract
test additions (they form an inseparable pair per acceptance criterion #3), followed by a
separate optional chore commit for the Task 5 doc-comment tweak if desired.

---

## Verification Checklist (maps to Definition acceptance bullets)

Mapping of acceptance clauses → concrete checks performed during QA:

1. *"Failed status message contains error_message/stage/retryable..."*
   → Inspect a live emulated-topic capture OR unit-call the publisher with mocked transport
     and dump the serialized envelope; grep for all four keys incl. legacy alias.
2. *"Stage tracks the phase executing at failure time."*
   → Force faults at ≥3 distinct injection points (mock raising inside embedding call,
     mock raising inside summarizer, throw immediately upon entry) and observe differing
     `payload["stage"]` outputs matching the injection site.
3. *"Persisted error != 'Processing failed'; error_stage not None; retryable explicit."*
   → Round-trip assertions in Layer A enforce this literally against the emulator/fake store.
4. *"Contract test exists and passes; detects drift on either side."*
   → Layer A catches semantic drift; Layer B catches textual/literal drift; both wired into
     the same pytest discovery root as siblings so CI gates uniformly.
5. *"Worker retains legacy error key."*
   → Explicit assertion included in Layer A comparing `payload["error"] ==
     payload["error_message"]`.

Additional regression smoke (manual or scripted):
- Successful happy-path ingestion still completes end-to-end (ensure adding stage mutations
  didn't alter control flow).
- Stale-lease sweep still writes `error/error_stage/"processing"/retryable=True` unmolested.
- Enqueue-time validation failures (API `/process` bad-request path) behave identically.
- Progress events along the way remain byte-for-byte compatible for dashboard rendering.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Emulator startup flakes in CI | Medium | Blocks Tier-A test | Fall back to in-repo fakes already proven by sibling tests; mark emulator-dependent variants with skip-if-unreachable decorator |
| Hidden third-party subscriber relies solely on removed-behavior `retryable=True` default meaning "always true" | Low-Medium | Silent downstream misinterpretation | Definition mandates keeping legacy `error` key; additionally log WARN on first few deployments when `retryable=False` fires, giving operators visibility into the newly-conservative signal before dashboards adapt |
| `classify_error` heuristic evolves independently breaking the equivalence assumption | Low | Payload disagrees w/ ACK/NACK reality | Both consume the SAME function call in-process; equivalence holds structurally, not merely incidentally |
| Refactor temptation while touching `process_document` widens blast radius | Medium | Scope creep / regressions | Hard rule: surgical edits only; defer restructuring ideas to a tracked follow-up ticket, NOT this cycle |
| Static-drift scanner brittle to formatting churn (black/pre-commit reformats) | Medium | False-positive CI breaks | Anchor scans on stable substrings unlikely to be rewritten (quoted literals survive most formatters); avoid whitespace-sensitive regex anchors |

Deferred-by-design reminders (do NOT fold into this iteration):
- Companion D3 issue contents (unavailable here) — strictly excluded.
- Historical D4 note reconciliation in `plans/upload-flow.md` — file absent; deferred.
- Structured error-code taxonomy introduction — prohibited preference.
- Any change to retry/backoff machinery, leases, heartbeats, frontend/mobile layers.

<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>
````