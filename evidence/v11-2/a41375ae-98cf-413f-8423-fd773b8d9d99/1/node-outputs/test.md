I have enough context. Writing the executable contract tests now — they exercise the worker's real failure-payload construction (through `process_document`'s exception handler and the real `_publish_status_update`) and feed the captured payload through rag-api's real `run_transactional_update` against fakes, plus AST drift guards on both sides.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="apps/ai-server/tests/integration/test_worker_failure_payload_contract.py">>>
"""Worker → rag-api failure-path contract tests.

Derived from the authoritative definition (wi-define-108-a8, artifact
definition:obj-108). Requirements under test:

1. The worker's failed status payload must carry `error_message` (the actual
   exception message), `stage` (the pipeline stage executing at failure time),
   and `retryable` (deliberately derived from classify_error) — never relying
   on rag-api's fallback defaults.
2. Stage names reuse the existing progress-stage vocabulary, with
   "processing" as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch persists the worker-provided values unchanged:
   main doc error ← error_message, error_stage ← stage, retryable ← retryable;
   the processing/summary error subdocument carries the same message and stage.
4. The retryable derivation is explicit and aligned with classify_error:
   transient → True, permanent/unclassified-unknown → False.
5. Drift guards: the tests fail if either side's payload keys drift.

These tests import both real sides (worker main.py, rag-api main.py) rather
than restating the contract in a fixture. They are hermetic: cloud SDKs are
stubbed, the worker pipeline is exercised with stubbed steps around the real
failure handler, and rag-api's transactional update runs against fakes.
"""

import ast
import asyncio
import concurrent.futures
import importlib
import importlib.util
import json
import logging
import sys
import types
from pathlib import Path

import pytest

TESTS_DIR = Path(__file__).resolve().parent
AI_SERVER_DIR = TESTS_DIR.parent
WORKER_MAIN_PATH = AI_SERVER_DIR / "rag-worker-service" / "main.py"
RAG_API_DIR = AI_SERVER_DIR / "rag-api-service"

# The existing progress-stage vocabulary the failure stage must draw from,
# plus the safe value for a genuinely unknown stage.
ALLOWED_STAGES = {
    "starting",
    "text_retrieved",
    "tagging_complete",
    "summary_generated",
    "chunking_complete",
    "embeddings_complete",
    "completed",
    "processing",  # safe value when stage is genuinely unknown
}


# --------------------------------------------------------------------------
# Module import plumbing (hermetic stubs for heavy worker dependencies)
# --------------------------------------------------------------------------

def _stub_if_missing(name, attrs=None, is_pkg=False):
    """Install a stub module only if the real one cannot be imported."""
    if name in sys.modules:
        return sys.modules[name]
    try:
        return importlib.import_module(name)
    except Exception:
        mod = types.ModuleType(name)
        if is_pkg:
            mod.__path__ = []
        for k, v in (attrs or {}).items():
            setattr(mod, k, v)
        sys.modules[name] = mod
        return mod


def _install_worker_dependency_stubs():
    _stub_if_missing("langchain", is_pkg=True)
    _stub_if_missing(
        "langchain.text_splitter",
        {
            "RecursiveCharacterTextSplitter": type(
                "RecursiveCharacterTextSplitter",
                (),
                {"__init__": lambda self, **kw: None},
            )
        },
    )
    _stub_if_missing(
        "langchain.schema",
        {"Document": type("Document", (), {"__init__": lambda self, **kw: None})},
    )
    _stub_if_missing(
        "openai",
        {
            "AsyncOpenAI": type(
                "AsyncOpenAI", (), {"__init__": lambda self, **kw: None}
            ),
            "APIError": type("APIError", (Exception,), {}),
        },
    )
    _stub_if_missing(
        "langfuse", {"Langfuse": type("Langfuse", (), {"__init__": lambda self, **kw: None})}
    )
    _stub_if_missing("spacy")
    _stub_if_missing(
        "tiktoken",
        {
            "get_encoding": lambda name: type(
                "Enc", (), {"encode": lambda self, t: t.split()}
            )()
        },
    )
    _stub_if_missing(
        "tenacity",
        {
            "retry": lambda *a, **kw: (lambda f: f),
            "stop_after_attempt": lambda n: None,
            "wait_exponential": lambda **kw: None,
        },
    )
    _stub_if_missing("sklearn", is_pkg=True)
    _stub_if_missing("sklearn.feature_extraction", is_pkg=True)
    _stub_if_missing(
        "sklearn.feature_extraction.text",
        {
            "TfidfVectorizer": type(
                "TfidfVectorizer", (), {"__init__": lambda self, **kw: None}
            )
        },
    )


def _fake_firestore_module():
    """Functional stand-in for firebase_admin.firestore.

    The integration conftest installs a MagicMock firestore, which makes
    rag-api's @firestore.transactional decorator a no-op mock (the update
    body never runs). These tests need the real failed-branch logic to
    execute, so a functional fake is installed instead.
    """
    mod = types.ModuleType("firebase_admin.firestore")
    mod.SERVER_TIMESTAMP = "SERVER_TIMESTAMP"
    mod.Increment = lambda v: v
    mod.transactional = lambda fn: fn  # run the update body directly
    return mod


_worker_main = None


def get_worker_main():
    """Import the worker's main.py once, with heavy deps stubbed."""
    global _worker_main
    if _worker_main is None:
        _install_worker_dependency_stubs()
        fake_fs = _fake_firestore_module()
        fb = sys.modules.get("firebase_admin")
        if fb is not None:
            fb.firestore = fake_fs
        sys.modules["firebase_admin.firestore"] = fake_fs
        spec = importlib.util.spec_from_file_location(
            "rag_worker_main_contract", WORKER_MAIN_PATH
        )
        mod = importlib.util.module_from_spec(spec)
        sys.modules["rag_worker_main_contract"] = mod
        spec.loader.exec_module(mod)
        _worker_main = mod
    return _worker_main


_api_main = None


def get_rag_api_main():
    """Import rag-api's main.py once, with a functional firestore fake."""
    global _api_main
    if _api_main is None:
        fake_fs = _fake_firestore_module()
        fb = sys.modules.get("firebase_admin")
        if fb is not None:
            fb.firestore = fake_fs
        sys.modules["firebase_admin.firestore"] = fake_fs
        if str(RAG_API_DIR) not in sys.path:
            sys.path.insert(0, str(RAG_API_DIR))
        # Re-import cleanly: another test file may have imported `main`
        # already while firestore was still a MagicMock.
        sys.modules.pop("main", None)
        _api_main = importlib.import_module("main")
    return _api_main


# --------------------------------------------------------------------------
# Fakes: worker side (Pub/Sub publisher + Firestore)
# --------------------------------------------------------------------------

class FakePublisher:
    """Captures published status messages the way Pub/Sub would deliver them."""

    def __init__(self):
        self.messages = []

    def topic_path(self, project, topic):
        return f"projects/{project}/topics/{topic}"

    def publish(self, topic_path, data):
        self.messages.append(json.loads(data.decode("utf-8")))
        fut = concurrent.futures.Future()
        fut.set_result("msg-id")
        return fut


class FakeWorkerDoc:
    def __init__(self, db, path):
        self.db = db
        self.path = path

    def get(self, transaction=None):
        # exists=False keeps the lease-heartbeat write in _publish_status_update
        # a no-op, exactly like a resource doc that is not the lease source.
        return types.SimpleNamespace(exists=False)

    def update(self, data):
        self.db.updates.append((self.path, dict(data)))

    def set(self, data, merge=False):
        self.db.sets.append((self.path, dict(data)))

    def collection(self, name):
        return FakeWorkerCollection(self.db, f"{self.path}/{name}")


class FakeWorkerCollection:
    def __init__(self, db, path):
        self.db = db
        self.path = path

    def document(self, doc_id):
        return FakeWorkerDoc(self.db, f"{self.path}/{doc_id}")


class FakeWorkerDb:
    def __init__(self):
        self.updates = []
        self.sets = []

    def document(self, path):
        return FakeWorkerDoc(self, path)


# --------------------------------------------------------------------------
# Fakes: rag-api side (Firestore transaction)
# --------------------------------------------------------------------------

class _ApiSnapshot:
    def __init__(self, data):
        self._data = data
        self.exists = data is not None

    def to_dict(self):
        return dict(self._data or {})


class _ApiTransaction:
    def __init__(self):
        self.updates = []
        self.sets = []

    def update(self, ref, data):
        self.updates.append((ref, dict(data)))

    def set(self, ref, data, merge=False):
        self.sets.append((ref, dict(data), merge))


class _ApiDocRef:
    def __init__(self, path, data):
        self.path = path
        self.id = path.split("/")[-1]
        self._data = data

    def get(self, transaction=None):
        return _ApiSnapshot(self._data)

    def collection(self, name):
        return _ApiCollectionRef(f"{self.path}/{name}")


class _ApiCollectionRef:
    def __init__(self, path):
        self.path = path

    def document(self, doc_id):
        return _ApiDocRef(f"{self.path}/{doc_id}", None)


class _ApiDb:
    def __init__(self):
        self.last_transaction = None

    def transaction(self):
        tx = _ApiTransaction()
        self.last_transaction = tx
        return tx


# --------------------------------------------------------------------------
# Scenario driver: run the worker pipeline to a failure, capture the payload
# --------------------------------------------------------------------------

def _build_processor(wm, exc, fail_at):
    """Build an EnhancedDocumentProcessor without __init__, with every
    pipeline step stubbed to succeed except the one that fails. The real
    process_document body (including its exception handler and the real
    _publish_status_update) is what runs."""
    proc = object.__new__(wm.EnhancedDocumentProcessor)
    proc.config = types.SimpleNamespace(
        gcp_project="test-gcp",
        rag_status_topic="test-topic",
        summary_max_chars=5000,
        summary_prompt_version=1,
        summary_model="test-model",
    )
    proc.logger = logging.getLogger("worker-contract-test")
    proc.langfuse = None
    proc.db = FakeWorkerDb()
    proc.pubsub_publisher = FakePublisher()

    async def ok_text(*a, **k):
        return "document body", {"title": "T", "filename": "f.md"}

    async def ok_tags(text, metadata):
        return [], {}

    async def ok_summary(text, title):
        return {"overview": "o", "bulletPoints": []}

    async def ok_chunks(*a, **k):
        return []

    async def ok_embeddings(chunks):
        return []

    async def ok_void(*a, **k):
        return None

    async def ok_store(chunks, vectors):
        return {"successful_inserts": 0}

    proc._validate_processing_request = ok_void
    proc._get_extracted_text = ok_text
    proc.content_tagger = types.SimpleNamespace(generate_tags=ok_tags)
    proc.generate_document_summary = ok_summary
    proc._get_document_path = lambda *a, **k: "users/u1/resources/r1"
    proc._create_enhanced_chunks = ok_chunks
    proc._generate_embeddings_with_openrouter = ok_embeddings
    proc.delete_old_vectors_via_service = ok_void
    proc.store_chunks_via_service = ok_store
    proc._save_processing_metadata_to_subcollection = ok_void
    proc._update_user_usage = ok_void
    proc._generate_resource_map = ok_void

    async def boom(*a, **k):
        raise exc

    if fail_at == "validate":
        proc._validate_processing_request = boom
    elif fail_at == "text_retrieval":
        proc._get_extracted_text = boom
    elif fail_at == "embeddings":
        proc._generate_embeddings_with_openrouter = boom
    else:
        raise ValueError(f"unknown fail_at: {fail_at}")
    return proc


def run_failure_scenario(wm, exc, fail_at):
    """Run process_document to failure; return the published 'failed' message."""
    proc = _build_processor(wm, exc, fail_at)
    asyncio.run(proc.process_document("u1", "__ungrouped__", "r1", "job-1"))
    failed = [m for m in proc.pubsub_publisher.messages if m["status"] == "failed"]
    assert len(failed) == 1, f"expected exactly one failed status message, got {failed}"
    return failed[0]


def persist_failure(am, details):
    """Feed a worker failure payload through rag-api's real failed branch.

    Returns (main_update, summary_update) as written by the transaction.
    """
    db = _ApiDb()
    doc_ref = _ApiDocRef(
        "users/u1/resources/r1", {"status": "processing", "userId": "u1"}
    )
    am.run_transactional_update(
        db, doc_ref, "failed", details, logging.getLogger("api-contract-test"), "u1"
    )
    tx = db.last_transaction
    assert tx is not None, "run_transactional_update never opened a transaction"
    assert len(tx.updates) == 1, f"expected one main-doc update, got {tx.updates}"
    assert tx.sets, f"expected a processing/summary write, got {tx.sets}"
    return tx.updates[0][1], tx.sets[0][1]


# --------------------------------------------------------------------------
# Worker-side payload tests
# --------------------------------------------------------------------------

class TestWorkerFailurePayload:
    def test_transient_failure_payload_carries_contract_keys(self):
        wm = get_worker_main()
        msg = run_failure_scenario(
            wm, wm.TransientError("storage backend unavailable"), "text_retrieval"
        )
        details = msg["details"]
        # The actual exception message, not a fallback string.
        assert details["error_message"] == "storage backend unavailable"
        # Deliberately derived, never silently defaulted.
        assert details["retryable"] is True
        # Stage is tracked and drawn from the existing vocabulary.
        assert details["stage"] in ALLOWED_STAGES
        assert details["stage"], "stage must never be None or empty"

    def test_legacy_error_key_retained_alongside_error_message(self):
        wm = get_worker_main()
        msg = run_failure_scenario(
            wm, wm.TransientError("storage backend unavailable"), "text_retrieval"
        )
        details = msg["details"]
        assert details.get("error") == "storage backend unavailable", (
            "the legacy `error` key must be retained for unknown consumers "
            "of the status topic"
        )

    def test_retryable_matches_worker_classification_transient(self):
        wm = get_worker_main()
        exc = wm.TransientError("upstream 503")
        details = run_failure_scenario(wm, exc, "text_retrieval")["details"]
        assert details["retryable"] == wm.classify_error(exc)
        assert details["retryable"] is True

    def test_unclassified_unknown_error_derives_retryable_false(self):
        wm = get_worker_main()
        exc = ValueError("unsupported document layout")
        details = run_failure_scenario(wm, exc, "text_retrieval")["details"]
        # classify_error's conservative default: unknown → permanent → false.
        assert details["retryable"] == wm.classify_error(exc)
        assert details["retryable"] is False

    def test_stage_reports_true_failing_stage_for_late_failure(self):
        wm = get_worker_main()
        details = run_failure_scenario(
            wm, wm.TransientError("embedding provider down"), "embeddings"
        )["details"]
        assert details["stage"] == "embeddings_complete", (
            "a failure during the embeddings step must report the embeddings "
            "stage, not a stale or default stage"
        )

    def test_stage_differs_between_early_and_late_failures(self):
        wm = get_worker_main()
        early = run_failure_scenario(
            wm, wm.TransientError("boom-early"), "text_retrieval"
        )["details"]["stage"]
        late = run_failure_scenario(
            wm, wm.TransientError("boom-late"), "embeddings"
        )["details"]["stage"]
        assert early != late, (
            "the stage tracker must advance through the pipeline: an early "
            "and a late failure must not report the same stage"
        )

    def test_stage_falls_back_to_processing_when_genuinely_unknown(self):
        wm = get_worker_main()
        details = run_failure_scenario(
            wm, wm.TransientError("doc vanished before pipeline start"), "validate"
        )["details"]
        assert details["stage"] == "processing", (
            "when no stage has been entered, the safe value is 'processing' — "
            "the stage must never regress to None"
        )

    def test_payload_does_not_rely_on_api_fallback_message(self):
        wm = get_worker_main()
        details = run_failure_scenario(
            wm, wm.TransientError("the real reason"), "text_retrieval"
        )["details"]
        assert details["error_message"] != "Processing failed"
        assert details["error_message"] == "the real reason"


# --------------------------------------------------------------------------
# End-to-end persistence: worker payload → rag-api failed branch
# --------------------------------------------------------------------------

class TestWorkerFailureToApiPersistence:
    def test_transient_failure_persists_worker_values_unchanged(self):
        wm = get_worker_main()
        am = get_rag_api_main()
        msg = run_failure_scenario(wm, wm.TransientError("upstream 503"), "text_retrieval")
        details = msg["details"]
        main_update, summary_update = persist_failure(am, details)

        assert main_update["error"] == "upstream 503"
        assert main_update["error_stage"] == details["stage"]
        assert main_update["retryable"] is True

        err = summary_update["error"]
        assert err["message"] == "upstream 503"
        assert err["stage"] == details["stage"]
        assert err["code"] == "UNKNOWN"

    def test_permanent_failure_persists_retryable_false(self):
        wm = get_worker_main()
        am = get_rag_api_main()
        msg = run_failure_scenario(
            wm, ValueError("malformed document structure"), "text_retrieval"
        )
        details = msg["details"]
        main_update, summary_update = persist_failure(am, details)

        assert main_update["error"] == "malformed document structure"
        assert main_update["error_stage"] == details["stage"]
        assert main_update["retryable"] is False
        assert summary_update["error"]["message"] == "malformed document structure"
        assert summary_update["error"]["stage"] == details["stage"]

    def test_worker_payload_always_supplies_keys_api_reads(self):
        """The API-side .get(...) fallbacks must be dead code on the worker
        failure path: every worker failure payload supplies all three keys."""
        wm = get_worker_main()
        for exc, fail_at in (
            (wm.TransientError("t"), "text_retrieval"),
            (ValueError("p"), "embeddings"),
            (ValueError("u"), "validate"),
        ):
            details = run_failure_scenario(wm, exc, fail_at)["details"]
            missing = {"error_message", "stage", "retryable"} - set(details)
            assert not missing, (
                f"worker failure payload (fail_at={fail_at}) missing keys {missing}; "
                "rag-api would silently apply fallback defaults"
            )

    def test_persisted_error_is_never_the_fallback_string(self):
        wm = get_worker_main()
        am = get_rag_api_main()
        msg = run_failure_scenario(
            wm, wm.TransientError("distinctive failure signature"), "text_retrieval"
        )
        main_update, _ = persist_failure(am, msg["details"])
        assert main_update["error"] == "distinctive failure signature"
        assert main_update["error"] != "Processing failed"
        assert main_update["error_stage"] is not None


# --------------------------------------------------------------------------
# Static drift guards: either side changing its keys must fail the build
# --------------------------------------------------------------------------

def _find_function(tree, name):
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return node
    raise AssertionError(f"function {name!r} not found in module")


class TestFailurePayloadKeyDriftGuard:
    def test_worker_failure_handler_declares_contract_keys(self):
        tree = ast.parse(WORKER_MAIN_PATH.read_text())
        fn = _find_function(tree, "process_document")
        dict_keys = set()
        for node in ast.walk(fn):
            if isinstance(node, ast.ExceptHandler):
                for sub in ast.walk(node):
                    if isinstance(sub, ast.Dict):
                        for k in sub.keys:
                            if isinstance(k, ast.Constant) and isinstance(k.value, str):
                                dict_keys.add(k.value)
        missing = {"error_message", "stage", "retryable"} - dict_keys
        assert not missing, (
            f"worker's process_document failure handler no longer publishes "
            f"keys {missing} — the worker→rag-api failure contract drifted"
        )

    def test_api_failed_branch_reads_contract_keys(self):
        api_main_path = RAG_API_DIR / "main.py"
        tree = ast.parse(api_main_path.read_text())
        fn = _find_function(tree, "run_transactional_update")
        reads = set()
        for node in ast.walk(fn):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "get"
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "details"
                and node.args
                and isinstance(node.args[0], ast.Constant)
                and isinstance(node.args[0].value, str)
            ):
                reads.add(node.args[0].value)
        missing = {"error_message", "stage", "retryable"} - reads
        assert not missing, (
            f"rag-api's run_transactional_update failed branch no longer reads "
            f"keys {missing} from the payload — the worker→rag-api failure "
            "contract drifted"
        )
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>