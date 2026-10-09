<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api failure-payload contract fix

## 1. Problem statement

When a document processing job fails, the RAG worker publishes a failure status message to the
`rag-status-updates` Pub/Sub topic. The RAG API service subscribes to that topic and persists
failure information onto the resource document in Firestore (`/users/{userId}/resources/{resourceId}`).

Today the failure payload published by the worker (`apps/ai-server/rag-worker-service/main.py`) and
the failure fields persisted by the API (`apps/ai-server/rag-api-service/main.py`,
`apps/ai-server/rag-api-service/models/resource.py`) do not fully agree:

- The worker publishes only `error` (a message string) in its failure payload; the API expects
  `error`, `error_stage`, and `retryable` to describe the failure.
- The worker does not report *which pipeline stage* failed, so `error_stage` cannot be populated
  truthfully.
- The worker does not report *whether the failure is retryable*, so `retryable` cannot be populated
  truthfully.
- There is no automated contract test pinning the worker's failure-payload shape to the API's
  expected failure-field shape, so drift between the two services re-creates this bug silently.

The contract already exists on the API side and is verified:

- `Resource` dataclass (`models/resource.py`) carries `error: Optional[str]`,
  `error_stage: Optional[str]`, `retryable: bool = True`, persisted via `to_dict()` and read via
  `from_dict()` (with `retryable` defaulting to `True` when absent).
- `ResourceStatus.FAILED = "failed"` is the canonical failed lifecycle state.
- The mobile contract test (`tests/integration/test_api_contracts.py`) already requires
  `error` and `error_stage` to be present in `ResourceResponse`, confirming these fields are
  consumer-facing and must be meaningful.

## 2. Goals

1. The worker's failure status payload must carry all information the API needs to populate the
   resource's `error`, `error_stage`, and `retryable` fields truthfully.
2. `error_stage` must identify the pipeline stage that was executing when the failure occurred,
   using the worker's existing stage vocabulary.
3. `retryable` must reflect the worker's own error classification — the same classification that
   already drives the worker's ack/retry decision (`classify_error` in
   `rag-worker-service/main.py`, which returns True for transient errors and False for permanent
   errors, treating unknown exceptions as permanent/conservative).
4. A contract test must pin the failure-payload shape to the failure-field shape the API persists,
   with a drift guard so future key changes on either side fail the build.

## 3. Non-goals

- No change to the worker's retry/ack semantics. `classify_error` and the message-handler retry
  logic are untouched; only the *reporting* of retryability in the failure payload changes.
- No change to `ResourceStatus`, the resource lifecycle, or any completed/processing path.
- No new error-code taxonomy. The worker's existing `ErrorCode` enum
  (`models/processing_status.py`) and the API's failure handling are not extended.
- No change to `ResourceResponse` field names or the mobile contract fixtures
  (`tests/fixtures/api-contracts/*`). The fields already exist; this work only makes their values
  truthful.
- No change to the `ProcessingMessage` / `ProcessingMessageMetadata` Pub/Sub request models
  (`models/pubsub_messages.py`) — the process-trigger direction is unaffected.
- No change to the `ProcessingError` Pydantic model in `models/processing_status.py` (that model is
  used for Firestore-side processing metadata inside the worker and is a separate mechanism from the
  status-update payload to the API).

## 4. Functional requirements

### 4.1 Worker failure payload (rag-worker-service/main.py)

- **FR-1** When a job fails (any exception raised during pipeline execution that leads to a failed
  status update), the worker's failure payload must include:
  - `error`: the human-readable failure message (existing behavior, preserved).
  - `error_stage`: a string identifying the pipeline stage executing at failure time.
  - `retryable`: a boolean equal to the result of `classify_error(e)` for the failure exception.
- **FR-2** `error_stage` must use the worker's existing stage vocabulary. The worker's
  `ProcessingStage` enum (`models/processing_status.py`) defines: `pdf_download`,
  `text_extraction`, `markdown_conversion`, `chunking`, `embedding_generation`,
  `weaviate_storage`, `resource_map`, `completed`. The failure stage reported must be one of
  these values (or a value the worker's pipeline code already uses for its stage transitions),
  never null and never an invented stage name.
- **FR-3** If the failure occurs before any stage transition has been recorded (e.g. during
  message parsing or resource lookup), `error_stage` must fall back to the earliest meaningful
  stage value (`pdf_download`) rather than null, so the API's `error_stage` field never regresses
  to null for a failed resource.
- **FR-4** `retryable` must be derived by calling the worker's existing `classify_error(e)`
  function on the failure exception. It must not be hardcoded, defaulted, or derived from any
  other heuristic. Consequences that follow from `classify_error`'s verified behavior:
  - Transient exceptions (`TransientError`, `httpx.ConnectError`, `httpx.ConnectTimeout`,
    `httpx.ReadTimeout`, `ConnectionError`, `TimeoutError`) → `retryable: true`.
  - `httpx.HTTPStatusError` with status 429/500/502/503/504 → `retryable: true`; other 4xx →
    `retryable: false`.
  - `PermanentError` and any unclassified exception → `retryable: false`.
- **FR-5** The failure payload's `error` message must remain the exception's message (or the
  existing message format the worker already publishes), so existing log/UX consumers of the
  `error` string see no change.

### 4.2 API failure persistence (rag-api-service/main.py)

- **FR-6** When the API's status-update handler processes a `failed` status message, it must
  persist onto the resource document:
  - `error` ← payload `error`
  - `error_stage` ← payload `error_stage`
  - `retryable` ← payload `retryable`
  - `status` ← `ResourceStatus.FAILED` (existing behavior, preserved)
- **FR-7** The API must tolerate a legacy payload that omits `error_stage` or `retryable` (e.g.
  from an old worker build still in flight): absent `error_stage` persists as null; absent
  `retryable` persists as `True` (matching `Resource.from_dict`'s existing default). This keeps
  the API backward-compatible during rolling deploys.
- **FR-8** The API must not reject or crash on unexpected extra keys in the failure payload; it
  must persist only the keys it knows (`error`, `error_stage`, `retryable`) and ignore the rest.

### 4.3 Contract test (tests/integration/test_api_contracts.py or a sibling contract test file)

- **FR-9** A contract test must import both services' code (per the existing pattern in
  `tests/integration/test_api_contracts.py`, which imports `main as rag_api_main` with the
  cloud-SDK mocks installed by `tests/integration/conftest.py`) and assert that:
  - The worker's failure-payload construction produces exactly the key set the API's failure
    handler reads: `error`, `error_stage`, `retryable` (plus any keys the API already reads for
    other status fields, if the test covers the full status payload).
  - The API's failure handler reads exactly the key set the worker's failure construction
    produces.
- **FR-10** The contract test must include a **key-set drift guard**: a future edit that adds,
  removes, or renames a failure-payload key on either side must fail the test with a message
  naming the mismatched key(s).
- **FR-11** The contract test must verify the value-flow contract end to end at the unit level:
  for a representative transient exception (e.g. `httpx.ConnectTimeout`) the worker's
  failure-payload construction must yield `retryable: true`, and for a representative permanent
  exception (e.g. `PermanentError`) it must yield `retryable: false`, with `error_stage` set to a
  valid `ProcessingStage` value in both cases.
- **FR-12** The contract test must verify the API's persistence mapping: given a failure payload
  with `error`, `error_stage`, `retryable`, the API's failure handler must write those values to
  the resource's `error`, `error_stage`, `retryable` fields (asserted against the `Resource`
  dataclass's field names as persisted by `to_dict()`).
- **FR-13** The contract test must verify the API's backward-compatibility behavior (FR-7):
  a payload omitting `error_stage`/`retryable` persists null/`True` respectively and does not
  raise.

## 5. Data requirements

- **DR-1** Failure-payload key names (the contract under test):

  | Key           | Type   | Produced by        | Consumed by        | Persisted as (Resource field) |
  |---------------|--------|--------------------|--------------------|-------------------------------|
  | `error`       | string | worker (existing)  | API (existing)     | `error`                       |
  | `error_stage` | string | worker (new)       | API (new)          | `error_stage`                 |
  | `retryable`   | bool   | worker (new)       | API (new)          | `retryable`                   |

- **DR-2** `error_stage` values must be members of the worker's `ProcessingStage` enum value set:
  `pdf_download`, `text_extraction`, `markdown_conversion`, `chunking`, `embedding_generation`,
  `weaviate_storage`, `resource_map`, `completed`. The fallback value per FR-3 is `pdf_download`.
- **DR-3** `retryable` values must be booleans. The API must not coerce, string-match, or
  reinterpret the value.

## 6. Behavioral consequences (accepted, verified)

- **BC-1** Unclassified exceptions currently cause the worker to ack-and-skip (per
  `classify_error`'s conservative `return False`) but would previously have persisted
  `retryable: true` (the API's `Resource.from_dict` default) if the field was absent. After this
  change they will persist `retryable: false`. This makes the persisted field agree with the
  worker's actual ack/retry decision — the intended fix.
- **BC-2** `error_stage` will now be populated for failed resources where it was previously null
  (the worker never sent it). This is a UX-visible improvement consistent with the mobile contract
  test's requirement that `error_stage` be present in `ResourceResponse`.

## 7. Constraints

- **C-1** All changes are confined to `apps/ai-server/rag-worker-service/main.py` (failure-payload
  construction), `apps/ai-server/rag-api-service/main.py` (failure-field persistence), and
  `apps/ai-server/tests/integration/` (contract test). No other service, model, or fixture file is
  modified.
- **C-2** The contract test must run in the existing hermetic test environment: the cloud-SDK
  mocks installed by `tests/integration/conftest.py` (`firebase_admin`, `google.cloud.*`,
  `google.oauth2.*`, `structlog`) suffice; no real GCP credentials, Pub/Sub emulator, or network
  access is required.
- **C-3** The worker's `ProcessingConfig` (env-driven, `extra="forbid"`) gains no new required
  settings; the failure-payload keys are derived from existing runtime state (the exception and the
  stage tracker), not from configuration.
- **C-4** The API's `Resource` dataclass and `to_dict()`/`from_dict()` are unchanged; the fields
  `error`, `error_stage`, `retryable` already exist and are already persisted.

## 8. Acceptance criteria

- **AC-1** For a failed job, the resource document in Firestore has `status: "failed"`,
  `error` equal to the failure message, `error_stage` equal to the stage executing at failure
  time (a valid `ProcessingStage` value, never null per FR-3), and `retryable` equal to
  `classify_error`'s verdict for the failure exception.
- **AC-2** For a transient failure (e.g. a connection timeout to an external service), the
  persisted `retryable` is `true`.
- **AC-3** For a permanent failure (e.g. `PermanentError` or an unclassified exception), the
  persisted `retryable` is `false`.
- **AC-4** The contract test (FR-9–FR-13) passes in the hermetic environment (C-2) and fails when:
  - a failure-payload key is added, removed, or renamed on either side (FR-10);
  - the worker's `error_stage` value falls outside the `ProcessingStage` value set (FR-11);
  - the API's persistence mapping drops or renames a failure field (FR-12);
  - the API's backward-compat tolerance regresses (FR-13).
- **AC-5** No existing test regresses: the mobile contract tests in
  `tests/integration/test_api_contracts.py` (which pin `ResourceResponse`'s `error` and
  `error_stage` fields and the `Resource` fixture's field set) continue to pass unchanged.
- **AC-6** The worker's existing unit tests and the API's existing integration tests
  (`rag-api-service/tests/integration/test_endpoints.py`, `test_timeline_endpoints.py`) continue
  to pass unchanged.

## 9. Open questions / unknowns

- **UQ-1** The worker's status-update payload may carry additional keys beyond `error` (e.g.
  status, resource identifiers, timestamps) that the API's handler also reads. The verified
  evidence covers the failure fields under discussion; the full status-payload key set was not
  exhaustively read. The contract test should cover the full status payload if feasible, but the
  mandatory scope is the failure-key set (`error`, `error_stage`, `retryable`).
- **UQ-2** Whether the API's failure handler currently reads any failure fields beyond `error`
  (e.g. does it already read `error_stage`/`retryable` and silently persist defaults, or does it
  not read them at all) was not exhaustively verified. The requirement (FR-6) states the target
  behavior; the implementation must reconcile with whatever the handler currently does.
- **UQ-3** Whether the worker's status-update publishing path is shared by the `RETRYING` status
  (and whether `RETRYING` messages should also carry `error_stage`/`retryable`) was not verified.
  This work scopes to the `FAILED` status only; `RETRYING` payload shape is out of scope unless
  investigation shows it shares the same construction site trivially.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>