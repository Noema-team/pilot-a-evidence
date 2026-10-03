<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="apps/ai-server/tests/integration/test_failure_payload_contract.py">>>
"""
Contract test: rag-worker failure payload → rag-api failed-branch persistence.

Derived from the authoritative WorkItem definition (wi-define-108-a8), NOT from
implementation code. The requirements under test:

  R1. The worker's failed status payload must include error_message (the actual
      exception message), stage (the pipeline stage executing at failure time),
      and retryable (deliberately derived) — never relying on rag-api's
      fallback defaults. The legacy `error` key is retained alongside
      error_message for continuity with unknown consumers of the status topic.
  R2. The worker must track the currently executing pipeline stage through
      process_document; stage names reuse the existing progress-stage
      vocabulary (starting, text_retrieved, tagging_complete,
      summary_generated, chunking_complete, embeddings_complete), with
      "processing" as the safe value when the stage is genuinely unknown.
  R3. rag-api's failed branch persists worker-provided values unchanged:
      error ← payload error_message, error_stage ← payload stage,
      retryable ← payload retryable; the processing/summary error subdocument
      carries the same message and stage.
  R4. retryable is derived from classify_error: transient → True; permanent
      (including unclassified-unknown, per classify_error's conservative
      default) → False.
  R5. A contract test covers the worker failure → rag-api persistence path,
      exercising the worker's failure-payload construction through rag-api's
      failed-branch persistence and asserting persisted error, error_stage,
      and retryable equal the worker's values — failing if either side's
      payload keys drift.

Structure:
  - Dynamic worker-side tests: build the failure payload through
    process_document's exception handler (pipeline steps mocked to raise at
    representative early/mid/late stages) and capture the published payload.
  - Dynamic seam test: feed the captured worker payload through rag-api's
    run_transactional_update failed branch against fakes, and assert the
    persisted error / error_stage / retryable and the processing/summary
    subdocument message/stage.
  - AST-based drift guards (house pattern from test_api_contracts.py) pinning
    the payload key sets on both sides, so a future edit to either side's keys
    fails the build instead of silently re-creating the key-mismatch bug.

Known assumptions (to be confirmed during the implement/test cycle):
  - The rag-api adapter `_call_failed_branch` binds run_transactional_update
    from a set of plausible signatures; if none bind, the test FAILS LOUDLY
    with guidance rather than skipping — the seam must be exercised, not
    assumed.
  - firestore.transactional is forced to a passthrough decorator under the
    mocked-firebase test regime so the real transaction body executes.
"""

import asyncio
import ast
import importlib.util
import inspect
import os
import sys
from unittest.mock import AsyncMock, MagicMock

import pytest

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
AI_SERVER_DIR = os.path.normpath(os.path.join(TESTS_DIR, "..", ".."))
RAG_API_DIR = os.path.normpath(os.path.join(AI_SERVER_DIR, "rag-api-service"))
RAG_WORKER_DIR = os.path.normpath(os.path.join(AI_SERVER_DIR, "rag-worker-service"))
RAG_API_MAIN_PATH = os.path.join(RAG_API_DIR, "main.py")
RAG_WORKER_MAIN_PATH = os.path.join(RAG_WORKER_DIR, "main.py")

# R2: the stage vocabulary the failure stage must be drawn from.
STAGE_VOCABULARY = {
    "starting",
    "text_retrieved",
    "tagging_complete",
    "summary_generated",
    "chunking_complete",
    "embeddings_complete",
    "processing",  # safe value when the stage is genuinely unknown
}

# R1: keys every worker-originated failure payload must carry.
REQUIRED_FAILURE_KEYS = {"error_message", "stage", "retryable"}
# R1 (compatibility hedge): legacy key retained alongside error_message.
LEGACY_FAILURE_KEYS = {"error"}


# --------------------------------------------------------------------------
# Import plumbing
# --------------------------------------------------------------------------

def _ensure_mock(name):
    if name not in sys.modules:
        sys.modules[name] = MagicMock()


def _prepare_worker_import_mocks():
    """
    Mock the worker's heavy third-party imports before its module executes.
    firebase_admin / google.cloud.* / structlog are already mocked by the
    package conftest.py; add the worker-specific heavy deps here.
    """
    for name in [
        "langchain",
        "langchain.text_splitter",
        "langchain.schema",
        "langchain_community",
        "openai",
        "langfuse",
        "tiktoken",
        "google.auth",
        "google.auth.transport",
        "google.auth.exceptions",
        "google.oauth2.id_token",
        "google.cloud.aiplatform",
        "google.cloud.storage",
        "vertexai",
    ]:
        _ensure_mock(name)


def _import_rag_api_main():
    """Import rag-api's main.py under the conftest mock regime."""
    if RAG_API_DIR not in sys.path:
        sys.path.insert(0, RAG_API_DIR)
    # Force @firestore.transactional to a passthrough so the real transaction
    # body executes under the mocked firebase regime (the conftest MagicMock
    # would otherwise swallow the decorated function's body entirely).
    fcm = sys.modules.get("google.cloud.firestore")
    if fcm is not None:
        try:
            fcm.transactional = lambda fn: fn
        except Exception:
            pass
    import main as rag_api_main
    return rag_api_main


def _import_worker_main():
    """Import the worker's main.py under a distinct module name (both services
    ship a main.py; the conftest sys.path entry points at rag-api's)."""
    _prepare_worker_import_mocks()
    mod_name = "rag_worker_main_under_contract_test"
    if mod_name in sys.modules:
        return sys.modules[mod_name]
    spec = importlib.util.spec_from_file_location(mod_name, RAG_WORKER_MAIN_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = module
    spec.loader.exec_module(module)
    return module


# --------------------------------------------------------------------------
# Worker-side helpers: drive process_document's exception handler
# --------------------------------------------------------------------------

def _make_processor(worker):
    """
    Build an EnhancedDocumentProcessor without running __init__ (which loads
    the marker model stack and opens real clients). Only the attributes the
    pipeline and the failure handler touch are provided.
    """
    proc = worker.EnhancedDocumentProcessor.__new__(worker.EnhancedDocumentProcessor)
    proc.config = MagicMock()
    proc.config.gcp_project = "test-project"
    proc.config.rag_status_topic = "rag-status"
    proc.logger = MagicMock()
    proc.langfuse = None
    proc.db = MagicMock()
    return proc


def _stub_pipeline(proc, fail_at=None, exc=None):
    """
    Stub every pipeline step process_document awaits up to the late stage we
    exercise. If fail_at names a step, that step raises `exc` instead.

    Steps verified in the repository: _validate_processing_request,
    _get_extracted_text, content_tagger.generate_tags,
    generate_document_summary, _create_enhanced_chunks,
    _generate_embeddings_with_openrouter, delete_old_vectors_via_service.
    Steps between embeddings and the completed publish are not exercised here
    (failures are injected at or before the embeddings step).
    """
    async def _maybe_fail(name, retval):
        if fail_at == name:
            raise exc
        return retval

    async def _validate(user_id, course_id, resource_id):
        return await _maybe_fail("validate", None)

    async def _get_text(user_id, course_id, resource_id):
        return await _maybe_fail("text", ("extracted text", {"total_pages": 3, "filename": "f.pdf"}))

    async def _tags(text, metadata):
        return await _maybe_fail("tags", (["tag1"], {"tag1": 0.9}))

    async def _summary(text, title):
        return await _maybe_fail("summary", None)

    async def _chunks(text, metadata, tags, user_id, course_id, resource_id):
        return await _maybe_fail("chunks", [])

    async def _embeddings(chunks):
        return await _maybe_fail("embeddings", [])

    async def _delete_old(user_id, course_id, resource_id):
        return await _maybe_fail("delete_old", None)

    proc._validate_processing_request = _validate
    proc._get_extracted_text = _get_text
    proc.content_tagger = MagicMock()
    proc.content_tagger.generate_tags = _tags
    proc.generate_document_summary = _summary
    proc._create_enhanced_chunks = _chunks
    proc._generate_embeddings_with_openrouter = _embeddings
    proc.delete_old_vectors_via_service = _delete_old
    proc._update_user_usage = AsyncMock()
    proc._generate_resource_map = AsyncMock()


def _capture_status_publishes(proc):
    """Replace _publish_status_update with a recording async stub."""
    published = []

    async def recorder(user_id, course_id, resource_id, status, details, job_id=None):
        published.append({
            "user_id": user_id,
            "course_id": course_id,
            "resource_id": resource_id,
            "status": status,
            "details": details,
            "job_id": job_id,
        })

    proc._publish_status_update = recorder
    return published


def _run_process(proc, worker):
    return asyncio.run(
        proc.process_document("user1", "course1", "res-1", job_id="job-1")
    )


def _failed_payloads(published):
    return [p for p in published if p["status"] == "failed"]


# --------------------------------------------------------------------------
# Dynamic worker-side tests (R1, R2, R4)
# --------------------------------------------------------------------------

class TestWorkerFailurePayloadContract:
    """The worker's failed status payload must speak rag-api's contract."""

    def _failure(self, fail_at, exc):
        worker = _import_worker_main()
        proc = _make_processor(worker)
        _stub_pipeline(proc, fail_at=fail_at, exc=exc)
        published = _capture_status_publishes(proc)
        _run_process(proc, worker)
        failures = _failed_payloads(published)
        assert len(failures) == 1, (
            f"expected exactly one failed status publish for failure at "
            f"{fail_at!r}, got {len(failures)}: {published}"
        )
        return failures[0]["details"], worker

    def test_failure_payload_carries_contract_keys_early_failure(self):
        details, _ = self._failure("text", RuntimeError("extraction exploded"))
        missing = REQUIRED_FAILURE_KEYS - set(details)
        assert not missing, (
            f"worker failure payload missing contract keys {missing}; "
            f"rag-api's failed branch reads error_message/stage/retryable and "
            f"would silently fall back to 'Processing failed'/None/True. "
            f"Payload keys: {sorted(details)}"
        )

    def test_failure_payload_carries_contract_keys_late_failure(self):
        details, _ = self._failure("embeddings", RuntimeError("embedding call failed"))
        missing = REQUIRED_FAILURE_KEYS - set(details)
        assert not missing, f"missing contract keys {missing} in {sorted(details)}"

    def test_error_message_is_actual_exception_message(self):
        details, _ = self._failure("text", RuntimeError("extraction exploded"))
        assert details["error_message"] == "extraction exploded", (
            "error_message must carry the worker's actual exception message, "
            "not a fallback string"
        )

    def test_legacy_error_key_retained_alongside_error_message(self):
        details, _ = self._failure("tags", RuntimeError("tagger blew up"))
        missing = LEGACY_FAILURE_KEYS - set(details)
        assert not missing, (
            f"legacy failure keys {missing} dropped from the payload; the "
            f"compatibility hedge requires `error` alongside `error_message` "
            f"for unknown consumers of the status topic"
        )
        assert details["error"] == "tagger blew up"

    def test_stage_is_present_and_within_vocabulary_early_failure(self):
        details, _ = self._failure("text", RuntimeError("extraction exploded"))
        stage = details.get("stage")
        assert isinstance(stage, str) and stage, (
            f"stage must be a non-empty string naming the failing pipeline "
            f"stage; got {stage!r}"
        )
        assert stage in STAGE_VOCABULARY, (
            f"stage {stage!r} must reuse the existing progress-stage vocabulary "
            f"(or the safe value 'processing'), got an out-of-vocabulary name"
        )

    def test_stage_tracks_pipeline_progress_late_failure(self):
        """R2: the stage tracker must advance — a late-stage failure must not
        report the same stage as an early-stage failure."""
        early, _ = self._failure("text", RuntimeError("early boom"))
        late, _ = self._failure("embeddings", RuntimeError("late boom"))
        assert late["stage"] != early["stage"], (
            f"stage tracker did not advance: early failure reported "
            f"{early['stage']!r} and late failure reported {late['stage']!r}"
        )
        assert late["stage"] in STAGE_VOCABULARY

    def test_stage_is_never_missing_or_null(self):
        for fail_at in ("validate", "text", "tags", "summary", "chunks", "embeddings"):
            details, _ = self._failure(fail_at, RuntimeError(f"boom at {fail_at}"))
            assert details.get("stage"), (
                f"failure at {fail_at!r} produced stage {details.get('stage')!r}; "
                f"error_stage must never regress to null (the safe value is 'processing')"
            )

    # R4: retryable is derived from classify_error, never silently defaulted.

    def test_retryable_transient_error_is_true(self):
        import httpx
        details, _ = self._failure("text", httpx.ConnectError("connection refused"))
        assert details.get("retryable") is True, (
            "classify_error classifies connection errors as transient; the "
            "payload must derive retryable=True from that classification"
        )

    def test_retryable_permanent_error_is_false(self):
        worker = _import_worker_main()
        details, _ = self._failure("text", worker.PermanentError("bad input"))
        assert details.get("retryable") is False, (
            "PermanentError classifies as permanent (acked, not redelivered); "
            "retryable must be False"
        )

    def test_retryable_unclassified_unknown_error_is_false(self):
        """The deliberate behavior change: unclassified-unknown exceptions
        classify permanent per classify_error's conservative default, so the
        persisted retryable must be False — not the API's silent True default."""
        details, _ = self._failure("text", RuntimeError("totally unexpected"))
        assert details.get("retryable") is False, (
            "unclassified-unknown exceptions classify as permanent via "
            "classify_error; retryable must be deliberately False, not the "
            "API-side silent default True"
        )

    def test_retryable_matches_classify_error_for_all_injected_failures(self):
        worker = _import_worker_main()
        import httpx
        cases = [
            ("validate", RuntimeError("boom")),
            ("text", httpx.ConnectTimeout("timeout")),
            ("tags", ValueError("bad value")),
            ("summary", worker.TransientError("transient")),
            ("chunks", worker.PermanentError("permanent")),
            ("embeddings", httpx.HTTPStatusError(
                "500", request=MagicMock(),
                response=MagicMock(status_code=500),
            )),
        ]
        for fail_at, exc in cases:
            details, _ = self._failure(fail_at, exc)
            expected = worker.classify_error(exc)
            assert details.get("retryable") is expected, (
                f"failure at {fail_at!r} ({type(exc).__name__}): payload "
                f"retryable={details.get('retryable')!r} but classify_error "
                f"says {expected!r} — retryable must be derived from the same "
                f"classification that drives ACK/NACK"
            )

    def test_retryable_key_always_present_and_boolean(self):
        for fail_at in ("validate", "text", "tags", "summary", "chunks", "embeddings"):
            details, _ = self._failure(fail_at, RuntimeError(f"boom {fail_at}"))
            assert "retryable" in details, (
                f"failure at {fail_at!r} omitted retryable — the payload must "
                f"never rely on rag-api's details.get('retryable', True) fallback"
            )
            assert isinstance(details["retryable"], bool)


# --------------------------------------------------------------------------
# rag-api failed-branch adapter and seam test (R3, R5)
# --------------------------------------------------------------------------

def _get_run_transactional_update():
    api = _import_rag_api_main()
    fn = getattr(api, "run_transactional_update", None)
    if fn is None:
        pytest.fail(
            "rag-api main.py does not expose run_transactional_update; the "
            "contract seam must exercise the real failed-branch persistence "
            "function. Update the adapter if the function was renamed."
        )
    return fn


def _call_failed_branch(payload):
    """
    Feed a worker failure payload through rag-api's failed-branch persistence
    against fakes. Returns (db, tx, doc_ref) mocks so tests can assert on the
    persisted writes.

    The adapter binds run_transactional_update from plausible signatures; if
    none bind it FAILS (never skips) so the seam cannot silently go untested.
    """
    fn = _get_run_transactional_update()
    sig = inspect.signature(fn)

    db = MagicMock()
    tx = MagicMock(name="transaction")
    db.transaction.return_value = tx
    doc_ref = MagicMock(name="doc_ref")
    doc_ref.path = "users/user1/resources/res-1"
    snap = MagicMock(name="snapshot")
    snap.exists = True
    snap.to_dict = lambda: {"status": "processing", "userId": "user1"}
    doc_ref.get.return_value = snap
    tx.get.return_value = snap

    candidates = [
        {"db": db, "doc_ref": doc_ref, "status": "failed", "details": payload},
        {"db": db, "transaction": tx, "doc_ref": doc_ref, "status": "failed", "details": payload},
        {"db": db, "doc_ref": doc_ref, "new_status": "failed", "details": payload},
        {"db": db, "doc_ref": doc_ref, "status": "failed", "details": payload, "job_id": "job-1"},
        {"db": db, "doc_ref": doc_ref, "status": "failed", "details": payload,
         "user_id": "user1", "course_id": "course1", "resource_id": "res-1"},
    ]

    bound = None
    for cand in candidates:
        try:
            bound = sig.bind(**cand)
            break
        except TypeError:
            continue
    if bound is None:
        pytest.fail(
            f"could not bind run_transactional_update{sig} to a failed-branch "
            f"call with kwargs from: {[sorted(c) for c in candidates]}. "
            f"Update _call_failed_branch to the real signature — the seam test "
            f"must exercise the real persistence function, not a re-statement "
            f"of the contract."
        )

    if inspect.iscoroutinefunction(fn):
        asyncio.run(fn(**bound.arguments))
    else:
        fn(**bound.arguments)
    return db, tx, doc_ref


def _collect_written_dicts(*mocks):
    """Every dict passed to any call on the given mocks (recursively through
    one level of list/tuple args)."""
    out = []

    def _scan(mock):
        for call in mock.mock_calls:
            for arg in call.args:
                if isinstance(arg, dict):
                    out.append(arg)
                elif isinstance(arg, (list, tuple)):
                    for sub in arg:
                        if isinstance(sub, dict):
                            out.append(sub)

    for m in mocks:
        _scan(m)
    return out


class TestWorkerToApiFailurePersistenceSeam:
    """R5: the worker's payload, fed through rag-api's failed branch, must
    persist the worker's values — not the fallback defaults."""

    def _persisted(self, payload):
        db, tx, doc_ref = _call_failed_branch(payload)
        return _collect_written_dicts(db, tx, doc_ref)

    def test_worker_payload_persists_intact_end_to_end(self):
        worker = _import_worker_main()
        proc = _make_processor(worker)
        _stub_pipeline(proc, fail_at="chunks", exc=RuntimeError("chunker exploded"))
        published = _capture_status_publishes(proc)
        _run_process(proc, worker)
        payload = _failed_payloads(published)[0]["details"]

        written = self._persisted(payload)

        main_doc = [
            d for d in written
            if d.get("error") == "chunker exploded"
            and d.get("error_stage") == payload["stage"]
            and d.get("retryable") == payload["retryable"]
        ]
        assert main_doc, (
            f"no persisted write carries the worker's values unchanged: "
            f"expected error={payload['error_message']!r}, "
            f"error_stage={payload['stage']!r}, retryable={payload['retryable']!r} "
            f"in writes: {written}"
        )

    def test_persisted_error_is_not_the_fallback_string(self):
        worker = _import_worker_main()
        proc = _make_processor(worker)
        _stub_pipeline(proc, fail_at="text", exc=RuntimeError("the real reason"))
        published = _capture_status_publishes(proc)
        _run_process(proc, worker)
        payload = _failed_payloads(published)[0]["details"]

        written = self._persisted(payload)
        errs = [d.get("error") for d in written if "error" in d]
        assert "the real reason" in errs, (
            f"persisted error values {errs} do not include the worker's actual "
            f"message — the 'Processing failed' fallback regime is still operative"
        )
        assert "Processing failed" not in errs, (
            "the fallback string 'Processing failed' was persisted; the "
            "worker-provided error_message must be used instead"
        )

    def test_persisted_error_stage_is_not_none(self):
        worker = _import_worker_main()
        proc = _make_processor(worker)
        _stub_pipeline(proc, fail_at="embeddings", exc=RuntimeError("embeddings down"))
        published = _capture_status_publishes(proc)
        _run_process(proc, worker)
        payload = _failed_payloads(published)[0]["details"]

        written = self._persisted(payload)
        stages = [d.get("error_stage") for d in written if "error_stage" in d]
        assert stages and all(s is not None for s in stages), (
            f"error_stage persisted as None {stages}; the worker-provided stage "
            f"must be persisted"
        )
        assert payload["stage"] in stages

    def test_persisted_retryable_is_worker_derived_not_defaulted(self):
        worker = _import_worker_main()
        # Permanent-classified failure → worker derives retryable=False; the
        # API's silent default True must NOT be what lands in Firestore.
        proc = _make_processor(worker)
        _stub_pipeline(proc, fail_at="tags", exc=RuntimeError("unclassified"))
        published = _capture_status_publishes(proc)
        _run_process(proc, worker)
        payload = _failed_payloads(published)[0]["details"]
        assert payload["retryable"] is False  # worker derived (R4)

        written = self._persisted(payload)
        retryables = [d.get("retryable") for d in written if "retryable" in d]
        assert False in retryables, (
            f"persisted retryable values {retryables}; a permanent-classified "
            f"worker failure must persist retryable=False, proving the "
            f"worker-derived value (not the API's True default) is operative"
        )

    def test_processing_summary_subdocument_carries_message_and_stage(self):
        worker = _import_worker_main()
        proc = _make_processor(worker)
        _stub_pipeline(proc, fail_at="summary", exc=RuntimeError("summary failed"))
        published = _capture_status_publishes(proc)
        _run_process(proc, worker)
        payload = _failed_payloads(published)[0]["details"]

        written = self._persisted(payload)
        subdoc = [
            d for d in written
            if d.get("message") == "summary failed" and d.get("stage") == payload["stage"]
        ]
        assert subdoc, (
            f"no processing/summary subdocument write carries message="
            f"{payload['error_message']!r} and stage={payload['stage']!r}; "
            f"writes seen: {written}"
        )


# --------------------------------------------------------------------------
# AST drift guards (R5: fail the build if either side's keys drift)
# --------------------------------------------------------------------------

def _parse(path):
    with open(path) as f:
        return ast.parse(f.read())


def _dict_literals_containing(tree, key):
    """Dict AST nodes whose literal keys include `key`."""
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            keys = {
                k.value for k in node.keys
                if isinstance(k, ast.Constant) and isinstance(k.value, str)
            }
            if key in keys:
                found.append((node, keys))
    return found


def _subscript_string_keys(tree):
    """String constants used as subscript keys, e.g. details['error_message']."""
    keys = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Constant) \
                and isinstance(node.slice.value, str):
            keys.add(node.slice.value)
    return keys


class TestFailurePayloadKeyDriftGuards:

    def test_worker_failure_details_dict_has_contract_keys(self):
        tree = _parse(RAG_WORKER_MAIN_PATH)
        hits = _dict_literals_containing(tree, "error_message")
        assert hits, (
            "no dict literal in rag-worker-service/main.py contains the key "
            "'error_message' — the worker's failure payload no longer speaks "
            "rag-api's contract (error_message/stage/retryable)"
        )
        for _, keys in hits:
            missing = (REQUIRED_FAILURE_KEYS | LEGACY_FAILURE_KEYS) - keys
            # Only assert completeness for dicts that look like the failure
            # payload (they carry at least error_message + one more contract key).
            if "stage" in keys or "retryable" in keys:
                assert not missing, (
                    f"worker failure payload dict is missing keys {missing}; "
                    f"contract requires {sorted(REQUIRED_FAILURE_KEYS | LEGACY_FAILURE_KEYS)}"
                )
                break
        else:
            pytest.fail(
                "found 'error_message' dict literals but none carrying stage/"
                "retryable — the failure payload construction has drifted"
            )

    def test_rag_api_failed_branch_reads_contract_keys(self):
        tree = _parse(RAG_API_MAIN_PATH)
        sub_keys = _subscript_string_keys(tree)
        all_consts = {
            n.value for n in ast.walk(tree)
            if isinstance(n, ast.Constant) and isinstance(n.value, str)
        }
        readable = sub_keys | all_consts
        for key in ("error_message", "stage", "retryable"):
            assert key in readable, (
                f"rag-api main.py no longer references {key!r} — the failed "
                f"branch's read side of the worker→rag-api contract has drifted"
            )
        for persisted in ("error_stage", "retryable"):
            assert persisted in readable, (
                f"rag-api main.py no longer references persisted field "
                f"{persisted!r} — the failed-branch persistence schema drifted"
            )

    def test_worker_payload_keys_cover_rag_api_read_keys(self):
        """The seam invariant: every key rag-api's failed branch reads from the
        payload must be present in the worker's failure payload key set."""
        worker_tree = _parse(RAG_WORKER_MAIN_PATH)
        worker_keys = set()
        for node, keys in _dict_literals_containing(worker_tree, "error_message"):
            worker_keys |= keys
        api_tree = _parse(RAG_API_MAIN_PATH)
        api_read = {"error_message", "stage", "retryable"} & (
            _subscript_string_keys(api_tree)
        )
        missing = api_read - worker_keys
        assert not missing, (
            f"rag-api's failed branch reads payload keys {sorted(api_read)} but "
            f"the worker's failure payload dict literals only provide "
            f"{sorted(worker_keys)} — missing {missing}; the contract seam is broken"
        )
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>