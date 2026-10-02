<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="apps/ai-server/tests/integration/test_failure_payload_contract.py">>>
"""Worker → rag-api failure payload contract tests.

Scope (from the authoritative Definition, wi-define-108-a8):
  A failed RAG processing job must publish error_message / stage / retryable
  (plus the retained legacy `error` key) from the worker, and rag-api's failed
  branch must persist those values unchanged as error / error_stage / retryable
  on the main resource document and mirror message+stage into the
  processing/summary error subdocument.

Test strategy (per the Definition's test plan):
  - Import both sides rather than restate the contract in a fixture.
  - The worker module pulls heavy ML deps at import time, so the worker side is
    exercised by AST-extracting and *executing* its real failure-payload
    construction and classify_error() source (the house pattern used by
    test_api_contracts.py for agent-graph). The construction that runs is the
    worker's own code, not a restatement.
  - rag-api's failed branch (run_transactional_update) is imported directly and
    run against a minimal in-memory Firestore fake.
  - Key-set drift guards fail the build if either side's payload keys change.

These tests are derived from the Definition's requirements only.
"""

import ast
import json
import os
import sys
import types
from unittest.mock import MagicMock

import pytest

REPO_ROOT = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
WORKER_MAIN = os.path.join(REPO_ROOT, "rag-worker-service", "main.py")
RAG_API_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "rag-api-service"))

# Allowed stage vocabulary (Definition: existing progress-stage names plus the
# safe unknown value "processing").
ALLOWED_STAGES = {
    "starting",
    "text_retrieved",
    "tagging_complete",
    "summary_generated",
    "chunking_complete",
    "embeddings_complete",
    "processing",  # safe value when stage is genuinely unknown
}

REQUIRED_FAILURE_KEYS = {"error_message", "stage", "retryable"}
LEGACY_RETAINED_KEY = "error"

# --------------------------------------------------------------------------
# Environment / module mocking (mirrors tests/integration/conftest.py and
# test_search_pipeline.py so rag-api's main imports hermetically).
# --------------------------------------------------------------------------
os.environ.setdefault("GCP_PROJECT", "test-project")
os.environ.setdefault("GOOGLE_APPLICATION_CREDENTIALS", "/tmp/fake-creds.json")
os.environ.setdefault("SHARED_INTERNAL_TOKEN", "test-token")
os.environ.setdefault("WEAVIATE_SERVICE_URL", "http://test-weaviate:8002")
os.environ.setdefault("GCS_BUCKET_NAME", "test-bucket")
os.environ.setdefault("WEAVIATE_API_KEY", "test-key")
os.environ.setdefault("FIREBASE_PROJECT_ID", "test-project")

for _mod in [
    "firebase_admin", "firebase_admin.credentials", "firebase_admin.firestore",
    "firebase_admin.auth", "google", "google.cloud", "google.cloud.firestore",
    "google.cloud.firestore_v1", "google.cloud.pubsub_v1", "google.oauth2",
    "google.oauth2.service_account", "structlog",
]:
    if _mod not in sys.modules:
        sys.modules[_mod] = MagicMock()

if RAG_API_DIR not in sys.path:
    sys.path.insert(0, RAG_API_DIR)

import main as rag_api_main  # noqa: E402


# --------------------------------------------------------------------------
# AST helpers
# --------------------------------------------------------------------------

def _worker_tree():
    with open(WORKER_MAIN) as f:
        return ast.parse(f.read())


def _find_process_document_fn(tree):
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "process_document":
            return node
    pytest.fail("process_document not found in rag-worker main.py")


def _find_failed_publish_call(fn_node):
    """Locate the `_publish_status_update(..., "failed", <details>, ...)` call
    inside process_document's exception handler."""
    for node in ast.walk(fn_node):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not (isinstance(func, ast.Attribute) and func.attr == "_publish_status_update"):
            continue
        for arg in node.args:
            if isinstance(arg, ast.Constant) and arg.value == "failed":
                return node
    pytest.fail(
        "process_document has no failed-status _publish_status_update call — "
        "the worker failure path has drifted"
    )


def _failed_details_node(publish_call):
    """The details dict is the first non-literal positional arg after the
    "failed" status constant."""
    for arg in publish_call.args:
        if isinstance(arg, ast.Dict):
            return arg
    pytest.fail("failed-status publish call carries no details dict literal")


def _extract_classify_error_module():
    """Exec the worker's real classify_error (plus its exception classes) in an
    isolated namespace. httpx is a real dependency in the test env."""
    tree = _worker_tree()
    keep = []
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name in ("ProcessingError", "TransientError", "PermanentError"):
            keep.append(node)
        elif isinstance(node, ast.FunctionDef) and node.name == "classify_error":
            keep.append(node)
    if not keep:
        pytest.fail("classify_error / exception classes not found in rag-worker main.py")
    ns = {"httpx": __import__("httpx"), "asyncio": __import__("asyncio")}
    exec(compile(ast.Module(body=keep, type_ignores=[]), "<classify_error>", "exec"), ns)
    return ns


# --------------------------------------------------------------------------
# Worker-side payload contract (AST on the real source)
# --------------------------------------------------------------------------

class TestWorkerFailurePayloadContract:
    def test_failure_payload_contains_required_keys(self):
        tree = _worker_tree()
        fn = _find_process_document_fn(tree)
        details = _failed_details_node(_find_failed_publish_call(fn))
        keys = {k.value for k in details.keys if isinstance(k, ast.Constant)}
        missing = REQUIRED_FAILURE_KEYS - keys
        assert not missing, (
            f"worker failure payload missing required keys {missing}; "
            f"contract requires error_message/stage/retryable"
        )

    def test_failure_payload_retains_legacy_error_key(self):
        tree = _worker_tree()
        fn = _find_process_document_fn(tree)
        details = _failed_details_node(_find_failed_publish_call(fn))
        keys = {k.value for k in details.keys if isinstance(k, ast.Constant)}
        assert LEGACY_RETAINED_KEY in keys, (
            "worker failure payload must retain the legacy 'error' key for "
            "unknown consumers of the status topic"
        )

    def test_retryable_is_derived_from_classify_error_not_defaulted(self):
        tree = _worker_tree()
        fn = _find_process_document_fn(tree)
        details = _failed_details_node(_find_failed_publish_call(fn))
        # The retryable value expression must involve classify_error — a
        # constant True/False here would be a silent default, which the
        # Definition forbids.
        for k, v in zip(details.keys, details.values):
            if isinstance(k, ast.Constant) and k.value == "retryable":
                calls = [n for n in ast.walk(v) if isinstance(n, ast.Call)]
                assert calls, "retryable must be deliberately derived (via classify_error), not a constant"
                assert any(
                    isinstance(c.func, ast.Name) and c.func.id == "classify_error"
                    for c in calls
                ), "retryable must be derived from classify_error(e)"
                break
        else:
            pytest.fail("failure payload has no retryable key")

    def test_stage_value_comes_from_tracked_stage_variable(self):
        tree = _worker_tree()
        fn = _find_process_document_fn(tree)
        details = _failed_details_node(_find_failed_publish_call(fn))
        for k, v in zip(details.keys, details.values):
            if isinstance(k, ast.Constant) and k.value == "stage":
                assert isinstance(v, ast.Name), (
                    "stage in the failure payload must come from the stage "
                    "tracker local, not a literal"
                )
                break
        else:
            pytest.fail("failure payload has no stage key")

    def test_stage_tracker_is_updated_through_the_pipeline(self):
        fn = _find_process_document_fn(_worker_tree())
        # The stage tracker local referenced by the failure payload must be
        # assigned with each allowed stage value in process_document.
        assigned = set()
        for node in ast.walk(fn):
            if isinstance(node, ast.Assign):
                for t in node.targets:
                    if isinstance(t, ast.Name):
                        for elt in getattr(node.value, "elts", []) if isinstance(node.value, (ast.Set, ast.List, ast.Tuple)) else []:
                            pass
                if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                    for t in node.targets:
                        if isinstance(t, ast.Name):
                            assigned.add(node.value.value)
        # Direct string assignments to any local count as tracker writes;
        # require the representative stages the Definition pins.
        for stage in ("starting", "text_retrieved", "embeddings_complete"):
            assert stage in assigned, (
                f"stage tracker never set to '{stage}' in process_document — "
                f"update-before-await convention broken"
            )

    def test_stage_vocabulary_is_respected(self):
        fn = _find_process_document_fn(_worker_tree())
        literals = {
            n.value for n in ast.walk(fn)
            if isinstance(n, ast.Constant) and isinstance(n.value, str)
        }
        stage_literals = {s for s in literals if s in ALLOWED_STAGES}
        assert stage_literals, "no stage names found in process_document"
        # Any literal that looks like a stage (published via stage keys) must
        # be from the allowed vocabulary.
        for node in ast.walk(fn):
            if isinstance(node, ast.Dict):
                for k, v in zip(node.keys, node.values):
                    if (
                        isinstance(k, ast.Constant) and k.value == "stage"
                        and isinstance(v, ast.Constant) and isinstance(v.value, str)
                    ):
                        assert v.value in ALLOWED_STAGES, (
                            f"stage '{v.value}' is outside the agreed vocabulary {sorted(ALLOWED_STAGES)}"
                        )


# --------------------------------------------------------------------------
# rag-api failed-branch contract (AST on the real source)
# --------------------------------------------------------------------------

class TestRagApiFailedBranchContract:
    def _failed_branch_reads(self):
        with open(os.path.join(RAG_API_DIR, "main.py")) as f:
            tree = ast.parse(f.read())
        fn = None
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "run_transactional_update":
                fn = node
                break
        assert fn is not None, "run_transactional_update not found in rag-api main.py"
        read_keys = set()
        for node in ast.walk(fn):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "get"
                and node.args
                and isinstance(node.args[0], ast.Constant)
                and isinstance(node.args[0].value, str)
            ):
                read_keys.add(node.args[0].value)
        return read_keys

    def test_failed_branch_reads_worker_payload_keys(self):
        reads = self._failed_branch_reads()
        for key in ("error_message", "stage", "retryable"):
            assert key in reads, (
                f"rag-api failed branch does not read details['{key}'] — "
                f"worker/api payload contract drift"
            )

    def test_persisted_schema_fields_unchanged(self):
        # The Definition forbids renaming/migrating the persisted fields.
        with open(os.path.join(RAG_API_DIR, "main.py")) as f:
            source = f.read()
        for field in ("error_stage", "retryable"):
            assert f'"{field}"' in source or f"'{field}'" in source, (
                f"rag-api no longer references persisted field '{field}'"
            )


# --------------------------------------------------------------------------
# retryable derivation semantics (exec the worker's real classify_error)
# --------------------------------------------------------------------------

class TestRetryableDerivationMatchesAckNack:
    @pytest.fixture(scope="class")
    def classify(self):
        ns = _extract_classify_error_module()
        return ns["classify_error"], ns

    def test_transient_error_is_retryable(self, classify):
        classify_error, ns = classify
        assert classify_error(ns["TransientError"]("boom")) is True

    def test_permanent_error_is_not_retryable(self, classify):
        classify_error, ns = classify
        assert classify_error(ns["PermanentError"]("bad input")) is False

    def test_connection_errors_are_retryable(self, classify):
        classify_error, _ = classify
        assert classify_error(ConnectionError("refused")) is True
        assert classify_error(TimeoutError("timed out")) is True

    def test_http_5xx_and_429_are_retryable(self, classify):
        classify_error, _ = classify
        httpx = __import__("httpx")
        req = httpx.Request("GET", "http://x")
        for code in (429, 500, 502, 503, 504):
            resp = httpx.Response(code, request=req)
            assert classify_error(httpx.HTTPStatusError(str(code), request=req, response=resp)) is True, code

    def test_http_4xx_is_not_retryable(self, classify):
        classify_error, _ = classify
        httpx = __import__("httpx")
        req = httpx.Request("GET", "http://x")
        resp = httpx.Response(400, request=req)
        assert classify_error(httpx.HTTPStatusError("400", request=req, response=resp)) is False

    def test_unknown_exceptions_classify_permanent(self, classify):
        # Definition F8: unclassified-unknown → permanent → retryable false.
        classify_error, _ = classify
        assert classify_error(ValueError("mystery")) is False


# --------------------------------------------------------------------------
# End-to-end: worker payload construction → rag-api failed-branch persistence
# --------------------------------------------------------------------------

class _FakeSnapshot:
    def __init__(self, data):
        self._data = data

    @property
    def exists(self):
        return self._data is not None

    def to_dict(self):
        return dict(self._data or {})


class _FakeTransaction:
    def __init__(self, store):
        self._store = store
        self._ops = []

    def get(self, ref):
        return _FakeSnapshot(self._store.get(ref.path))

    def update(self, ref, data):
        self._ops.append(("update", ref.path, dict(data)))

    def set(self, ref, data, merge=False):
        self._ops.append(("set", ref.path, dict(data), merge))


class _FakeDocRef:
    def __init__(self, store, path):
        self._store = store
        self.path = path

    def get(self, transaction=None):
        return _FakeSnapshot(self._store.get(self.path))

    @property
    def id(self):
        return self.path.rsplit("/", 1)[-1]


class _FakeFirestore:
    """Minimal Firestore fake: dict-backed store keyed by document path."""

    SERVER_TIMESTAMP = "SERVER_TIMESTAMP"

    def __init__(self):
        self.store = {}

    def document(self, path):
        return _FakeDocRef(self.store, path)

    def transaction(self):
        return _FakeTransaction(self.store)

    @staticmethod
    def transactional(fn):
        def wrapper(tx, *args, **kwargs):
            return fn(tx, *args, **kwargs)
        return wrapper


def _build_worker_failure_payload(exception, stage):
    """Execute the worker's *actual* failure-details dict construction,
    extracted from process_document's failed publish call via AST.

    The dict expression references the exception local (e) and the stage
    tracker local; we bind sample values for both and eval the real code.
    """
    tree = _worker_tree()
    fn = _find_process_document_fn(tree)
    details_node = _failed_details_node(_find_failed_publish_call(fn))

    # Names referenced by the details expression.
    needed = {n.id for n in ast.walk(details_node) if isinstance(n, ast.Name)}
    classify_error = _extract_classify_error_module()["classify_error"]

    # Bind the exception handler's locals: the exception under whatever local
    # name the handler uses, the stage tracker under its name, and anything
    # else the expression needs from the enclosing scope.
    except_names = [n.id for n in ast.walk(fn) if isinstance(n, ast.ExceptHandler) and n.name]
    ns = {"classify_error": classify_error, "str": str}
    for name in needed:
        if name in except_names:
            ns[name] = exception
        elif name not in ns:
            # Stage tracker local (or a helper) — bind the caller-supplied stage.
            ns[name] = stage
    # If the handler names its exception explicitly (e.g. `except Exception as e`),
    # make sure every free Name that isn't the stage tracker gets the exception.
    for name in needed:
        if name not in ns:
            ns[name] = exception
        elif ns[name] is stage and name not in except_names and name not in {"classify_error"}:
            pass  # stage tracker local — keep the stage value
    code = compile(ast.Expression(body=details_node), "<failure_details>", "eval")
    return eval(code, ns)


class TestWorkerFailureToRagApiPersistence:
    """The contract test required by the Definition: exercise the worker's
    failure-payload construction through rag-api's failed-branch persistence
    and assert the persisted error / error_stage / retryable equal the
    worker's values."""

    USER = "user1"
    RESOURCE = "res-1"
    RESOURCE_PATH = f"users/user1/resources/res-1"
    SUMMARY_PATH = f"users/user1/resources/res-1/processing/summary"

    def _run_failed_branch(self, payload):
        db = _FakeFirestore()
        db.store[self.RESOURCE_PATH] = {
            "status": "processing",
            "filename": "test.pdf",
            "userId": self.USER,
        }
        db.store[self.SUMMARY_PATH] = {"stage": "claimed_by_worker", "progress": 0}

        fn = getattr(rag_api_main, "run_transactional_update", None)
        assert fn is not None, (
            "rag-api main.py must expose run_transactional_update for the "
            "worker→rag-api failure contract test"
        )

        # Bind arguments by name where possible; fall back to positional.
        import inspect
        sig = inspect.signature(fn)
        candidates = {
            "db": db,
            "firestore_db": db,
            "user_id": self.USER,
            "resource_id": self.RESOURCE,
            "course_id": "__ungrouped__",
            "status": "failed",
            "details": payload,
            "job_id": None,
            "new_status": "failed",
        }
        kwargs = {}
        positional = []
        for name, param in sig.parameters.items():
            if name in candidates and param.kind in (param.POSITIONAL_OR_KEYWORD, param.KEYWORD_ONLY):
                kwargs[name] = candidates[name]
            elif param.kind == param.VAR_KEYWORD:
                continue
            elif name in candidates:
                positional.append(candidates[name])
        # Fill any required positional params we couldn't name-match.
        for name, param in sig.parameters.items():
            if (
                param.kind == param.POSITIONAL_ONLY
                and name not in kwargs
                and not any(p is candidates.get(name) for p in positional)
                and name in candidates
            ):
                positional.append(candidates[name])
        try:
            fn(*positional, **kwargs)
        except TypeError as e:
            pytest.fail(
                f"could not invoke run_transactional_update against the fake "
                f"Firestore with the worker failure payload: {e}"
            )
        return db

    def test_persisted_document_carries_worker_values(self):
        exc = ValueError("embedding service returned garbage for chunk 12")
        payload = _build_worker_failure_payload(exc, "embeddings_complete")

        # Worker-side: the payload must carry the real message, the failing
        # stage, and a derived retryable — none relying on rag-api fallbacks.
        assert payload["error_message"] == "embedding service returned garbage for chunk 12"
        assert payload["stage"] == "embeddings_complete"
        assert isinstance(payload["retryable"], bool)
        assert payload["error"] == payload["error_message"], "legacy error key must mirror error_message"

        db = self._run_failed_branch(payload)
        doc = db.store[self.RESOURCE_PATH]

        assert doc["status"] == "failed"
        assert doc["error"] == payload["error_message"], (
            "persisted error must be the worker's actual message, not the "
            "'Processing failed' fallback"
        )
        assert doc["error_stage"] == payload["stage"], (
            "persisted error_stage must be the worker's failing stage, not None"
        )
        assert doc["retryable"] == payload["retryable"], (
            "persisted retryable must be the worker's derived value, not the "
            "silent default True"
        )

    def test_summary_subdocument_mirrors_message_and_stage(self):
        exc = TransientLike = ConnectionError("weaviate connection reset")
        payload = _build_worker_failure_payload(exc, "chunking_complete")
        db = self._run_failed_branch(payload)
        summary = db.store[self.SUMMARY_PATH]
        error = summary.get("error")
        assert isinstance(error, dict), (
            "processing/summary error subdocument missing — rag-api failed "
            "branch must write message/stage there"
        )
        assert error.get("message") == payload["error_message"]
        assert error.get("stage") == payload["stage"]

    def test_retryable_transient_true_permanent_false(self):
        # Transient-classified error → retryable true end-to-end.
        payload_t = _build_worker_failure_payload(ConnectionError("reset"), "text_retrieved")
        assert payload_t["retryable"] is True
        db_t = self._run_failed_branch(payload_t)
        assert db_t.store[self.RESOURCE_PATH]["retryable"] is True

        # Permanent/unknown-classified error → retryable false end-to-end
        # (deliberate behavior change vs. the old silent default).
        payload_p = _build_worker_failure_payload(ValueError("bad pdf"), "starting")
        assert payload_p["retryable"] is False
        db_p = self._run_failed_branch(payload_p)
        assert db_p.store[self.RESOURCE_PATH]["retryable"] is False

    def test_unknown_stage_falls_back_to_processing_never_none(self):
        payload = _build_worker_failure_payload(RuntimeError("boom"), "processing")
        assert payload["stage"] == "processing"
        db = self._run_failed_branch(payload)
        assert db.store[self.RESOURCE_PATH]["error_stage"] == "processing"


class TestPayloadKeyDriftGuard:
    """Fail the build if either side's payload keys drift."""

    def test_worker_payload_key_set_is_pinned(self):
        payload = _build_worker_failure_payload(ValueError("x"), "starting")
        keys = set(payload.keys())
        expected = REQUIRED_FAILURE_KEYS | {LEGACY_RETAINED_KEY}
        assert keys == expected, (
            f"worker failure payload key set drifted: expected {sorted(expected)}, "
            f"got {sorted(keys)}. Update both sides and this guard together."
        )

    def test_payload_values_are_json_serializable(self):
        # The payload travels over Pub/Sub as JSON.
        payload = _build_worker_failure_payload(ValueError("x"), "starting")
        json.dumps(payload)
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>