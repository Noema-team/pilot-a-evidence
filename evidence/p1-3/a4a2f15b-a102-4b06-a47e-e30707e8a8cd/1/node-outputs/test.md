All context gathered. Writing the contract test file now — it imports both sides (worker failure-payload construction via a stubbed `process_document`, rag-api's `run_transactional_update` against fakes), plus AST drift guards following the house pattern in `test_api_contracts.py`.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="apps/ai-server/tests/integration/test_worker_failure_payload_contract.py">>>
"""
Contract test: rag-worker → rag-api failure payload seam.

The worker's failure publisher and rag-api's failure consumer were written
against different contracts: the worker published `{"error": str(e)}` while
rag-api's failed branch reads `error_message` / `stage` / `retryable` and
persists them as `error` / `error_stage` / `retryable`. Every worker failure
therefore landed in Firestore as the fallback "Processing failed", a null
stage, and a fabricated `retryable: true`.

This file locks the seam from BOTH sides, deriving its expectations from the
contract (not from either implementation):

  1. Dynamic end-to-end tests: run the worker's real `process_document` with a
     failure injected at a chosen pipeline stage, capture the failure payload
     it publishes, feed that exact payload through rag-api's real
     `run_transactional_update` against a fake Firestore, and assert the
     persisted `error`, `error_stage`, and `retryable` equal the worker's
     values — and that the processing/summary error subdocument carries the
     same message and stage.
  2. Static AST drift guards (house pattern from test_api_contracts.py): if
     either side's payload keys drift, the build fails here instead of
     silently re-creating the bug in production.

Contract under test (worker → rag-api failure path):
  - worker publishes, on failure: error_message (actual exception message),
    stage (failing pipeline stage; "processing" when genuinely unknown),
    retryable (deliberately derived from classify_error: transient → True,
    permanent/unknown → False), and retains the legacy `error` key.
  - rag-api persists, on failed: error ← error_message, error_stage ← stage,
    retryable ← retryable (no silent default operative for worker failures),
    and the processing/summary error subdocument carries the same message and
    stage with error_code defaulting to "UNKNOWN".
  - stage vocabulary reuses the worker's progress-stage names: starting,
    text_retrieved, tagging_complete, summary_generated, chunking_complete,
    embeddings_complete (+ "completed"), with "processing" as safe fallback.
"""

import ast
import json
import os
import sys
import types
import asyncio
import subprocess
from unittest.mock import MagicMock

import pytest
import httpx

import main as rag_api_main  # conftest.py put rag-api-service on sys.path

WORKER_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "rag-worker-service")
)
WORKER_MAIN = os.path.join(WORKER_DIR, "main.py")

# The stage vocabulary the worker's progress updates already use; the failure
# handler must report stages from this same vocabulary (plus the safe
# fallback "processing").
STAGE_VOCABULARY = {
    "starting",
    "text_retrieved",
    "tagging_complete",
    "summary_generated",
    "chunking_complete",
    "embeddings_complete",
    "completed",
}
SAFE_STAGE = "processing"

# The exact key set the worker's failure payload must carry. `error` is the
# legacy hedge retained for unknown consumers of the status topic.
EXPECTED_FAILURE_KEYS = {"error", "error_message", "stage", "retryable"}

# The keys rag-api's failed branch must read from the payload.
REQUIRED_API_READ_KEYS = {"error_message", "stage", "retryable"}

# The persisted field names on the main resource document (established schema
# shared with the stale-lease sweep, enqueue-failure paths, and the models).
EXPECTED_PERSISTED_FIELDS = {"error", "error_stage", "retryable"}


# ========================================
# Worker module import (heavy deps mocked)
# ========================================

# Modules rag-worker-service/main.py imports at module scope that may not be
# installed (or are expensive to import) in the test environment. Anything
# already importable is used for real; the rest gets a MagicMock.
_HEAVY_IMPORTS = [
    "langchain",
    "langchain.text_splitter",
    "langchain.schema",
    "openai",
    "langfuse",
    "spacy",
    "sklearn",
    "sklearn.feature_extraction",
    "sklearn.feature_extraction.text",
    "tiktoken",
    "tenacity",
    "pydantic_settings",
    "google.cloud.storage",
    "google.auth",
    "google.auth.credentials",
    "google.cloud.firestore_v1.base_query",
]


def _ensure_importable(name):
    if name in sys.modules:
        return sys.modules[name]
    try:
        __import__(name)
        return sys.modules[name]
    except Exception:
        mod = MagicMock()
        sys.modules[name] = mod
        return mod


def _import_worker_main():
    os.environ.setdefault("GCP_PROJECT", "test-project")
    os.environ.setdefault("GOOGLE_APPLICATION_CREDENTIALS", "/tmp/fake-creds.json")
    for name in _HEAVY_IMPORTS:
        _ensure_importable(name)
    if WORKER_DIR not in sys.path:
        sys.path.insert(0, WORKER_DIR)
    import main as worker_main  # rag-worker-service/main.py

    return worker_main


# ========================================
# Fake Firestore for rag-api's failed branch
# ========================================

class FakeSnapshot:
    exists = True

    def __init__(self, data):
        self._data = data

    def to_dict(self):
        return dict(self._data)


class FakeSummaryRef:
    def __init__(self, store):
        self.store = store

    def set(self, data, merge=False):
        self.store["summary"] = data


class FakeDocRef:
    def __init__(self, store):
        self.store = store
        self.id = "res-1"

    def get(self, transaction=None):
        return FakeSnapshot(self.store["main"])

    def collection(self, name):
        return types.SimpleNamespace(document=lambda doc_id: FakeSummaryRef(self.store))


class FakeTransaction:
    def __init__(self, store):
        self.store = store

    def update(self, doc_ref, data):
        self.store["main"].update(data)


class FakeDB:
    def __init__(self, store):
        self.store = store

    def transaction(self):
        return FakeTransaction(self.store)

    def document(self, path):
        return FakeDocRef(self.store)


@pytest.fixture
def firestore_mocks():
    """Configure the mocked firebase_admin.firestore for run_transactional_update."""
    fw = sys.modules["firebase_admin.firestore"]
    original_transactional = getattr(fw, "transactional", None)
    original_server_ts = getattr(fw, "SERVER_TIMESTAMP", None)
    # Identity decorator: run the transaction body immediately against fakes.
    fw.transactional = lambda f: f
    fw.SERVER_TIMESTAMP = "SERVER_TIMESTAMP"
    yield fw
    if original_transactional is not None:
        fw.transactional = original_transactional
    if original_server_ts is not None:
        fw.SERVER_TIMESTAMP = original_server_ts


def _run_failed_branch(details, firestore_mocks):
    """Feed a worker failure payload through rag-api's failed branch."""
    store = {
        "main": {"status": "processing", "userId": "user-1"},
        "summary": {},
    }
    db = FakeDB(store)
    doc_ref = FakeDocRef(store)
    logger = MagicMock()
    rag_api_main.run_transactional_update(db, doc_ref, "failed", details, logger, "user-1")
    return store


# ========================================
# Stubbed worker processor
# ========================================

def _make_processor(worker_mod, fail_at):
    """
    Build a stub `self` for EnhancedDocumentProcessor.process_document whose
    pipeline succeeds up to `fail_at` and raises there.

    fail_at: "starting" | "tagging" | "embeddings"
    """
    proc = types.SimpleNamespace()
    proc.config = types.SimpleNamespace(
        summary_max_chars=5000,
        summary_prompt_version=1,
        summary_model="test-model",
        embedding_model="text-embedding-3-small",
    )
    proc.langfuse = None
    proc.logger = worker_mod.logger
    proc.db = FakeDB({"main": {}, "summary": {}})

    captured = []

    async def fake_publish(user_id, course_id, resource_id, status, details, job_id=None):
        captured.append((status, dict(details)))

    proc._publish_status_update = fake_publish

    async def validate(user_id, course_id, resource_id):
        if fail_at == "starting":
            raise ValueError("validation exploded")

    proc._validate_processing_request = validate

    async def get_text(user_id, course_id, resource_id):
        return "some text", {"title": "t", "filename": "f"}

    proc._get_extracted_text = get_text

    async def generate_tags(text, metadata):
        if fail_at == "tagging":
            raise ValueError("tagging exploded")
        return [], {}

    proc.content_tagger = types.SimpleNamespace(generate_tags=generate_tags)

    async def summary(text, title):
        return {"overview": "o", "bulletPoints": []}

    proc.generate_document_summary = summary
    proc._get_document_path = lambda user_id, course_id, resource_id: (
        f"users/{user_id}/resources/{resource_id}"
    )

    async def chunks(*a, **k):
        return []

    proc._create_enhanced_chunks = chunks

    async def embeddings(chs):
        if fail_at == "embeddings":
            raise httpx.ConnectError("connection to embedding provider failed")
        return []

    proc._generate_embeddings_with_openrouter = embeddings

    return proc, captured


def _run_failing_process(worker_mod, fail_at):
    proc, captured = _make_processor(worker_mod, fail_at)
    asyncio.run(
        worker_mod.EnhancedDocumentProcessor.process_document(
            proc, "user-1", "course-1", "res-1", "job-1"
        )
    )
    failed = [(s, d) for (s, d) in captured if s == "failed"]
    assert len(failed) == 1, (
        f"expected exactly one failed status publish, got {[(s, d) for s, d in captured]}"
    )
    return failed[0][1]


# ========================================
# Dynamic contract tests: worker payload → rag-api persistence
# ========================================

class TestWorkerFailureToApiPersistence:
    def _assert_persistence_matches(self, details, store):
        main_doc = store["main"]
        # rag-api must persist the worker's values unchanged — no fallbacks.
        assert main_doc["error"] == details["error_message"], (
            "persisted error must equal the worker's error_message "
            f"(got {main_doc['error']!r} vs {details['error_message']!r})"
        )
        assert main_doc["error_stage"] == details["stage"], (
            "persisted error_stage must equal the worker's stage "
            f"(got {main_doc['error_stage']!r} vs {details['stage']!r})"
        )
        assert main_doc["retryable"] is details["retryable"], (
            "persisted retryable must equal the worker's derived retryable "
            f"(got {main_doc['retryable']!r} vs {details['retryable']!r})"
        )
        assert main_doc["status"] == "failed"
        # processing/summary error subdocument carries the same message/stage.
        summary_error = store["summary"]["error"]
        assert summary_error["message"] == details["error_message"]
        assert summary_error["stage"] == details["stage"]
        assert summary_error["code"] == "UNKNOWN"

    def test_early_stage_failure_persists_worker_values(self, worker_mod, firestore_mocks):
        details = _run_failing_process(worker_mod, "tagging")
        assert set(details.keys()) == EXPECTED_FAILURE_KEYS
        assert details["error_message"] == "tagging exploded"
        assert details["stage"] in STAGE_VOCABULARY
        assert details["retryable"] is worker_mod.classify_error(ValueError("tagging exploded"))
        store = _run_failed_branch(details, firestore_mocks)
        self._assert_persistence_matches(details, store)

    def test_late_stage_transient_failure_persists_worker_values(self, worker_mod, firestore_mocks):
        details = _run_failing_process(worker_mod, "embeddings")
        assert set(details.keys()) == EXPECTED_FAILURE_KEYS
        exc = httpx.ConnectError("connection to embedding provider failed")
        assert details["retryable"] is worker_mod.classify_error(exc)
        assert details["retryable"] is True, "transient-classified errors must be retryable"
        assert details["stage"] in STAGE_VOCABULARY
        assert details["stage"] in {
            "text_retrieved", "tagging_complete", "summary_generated",
            "chunking_complete", "embeddings_complete",
        }, "a late-stage failure must report a post-extraction stage"
        store = _run_failed_branch(details, firestore_mocks)
        self._assert_persistence_matches(details, store)

    def test_unknown_stage_failure_uses_safe_processing_stage(self, worker_mod, firestore_mocks):
        details = _run_failing_process(worker_mod, "starting")
        assert details["stage"] == SAFE_STAGE, (
            "a failure before the first stage transition must report the "
            "safe 'processing' stage, not None"
        )
        assert details["error_message"] == "validation exploded"
        store = _run_failed_branch(details, firestore_mocks)
        self._assert_persistence_matches(details, store)

    def test_retryable_is_deliberately_derived_not_defaulted(self, worker_mod, firestore_mocks):
        # Permanent (unclassified-unknown) → False, even though rag-api's
        # silent default was True. The derivation must be the operative
        # mechanism, not the API-side fallback.
        details = _run_failing_process(worker_mod, "tagging")
        assert details["retryable"] is False
        store = _run_failed_branch(details, firestore_mocks)
        assert store["main"]["retryable"] is False

    def test_legacy_error_key_retained_alongside_error_message(self, worker_mod):
        details = _run_failing_process(worker_mod, "tagging")
        assert details["error"] == details["error_message"], (
            "the legacy 'error' key must be retained for unknown consumers "
            "of the status topic and carry the same message"
        )


# ========================================
# Static drift guards (AST, house pattern)
# ========================================

_WORKER_AST_SCRIPT = """\
import ast, json, sys

with open(sys.argv[1]) as f:
    tree = ast.parse(f.read())

process_doc = None
for node in tree.body:
    for child in ast.walk(node):
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)) and child.name == 'process_document':
            process_doc = child
if process_doc is None:
    print(json.dumps({'error': 'process_document not found'})); sys.exit(0)

failure_calls = []
for node in ast.walk(process_doc):
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
            and node.func.attr == '_publish_status_update':
        for arg in node.args:
            if isinstance(arg, ast.Dict) and any(
                isinstance(k, ast.Constant) and k.value == 'error_message' for k in arg.keys
            ):
                keys = {k.value for k in arg.keys if isinstance(k, ast.Constant)}
                stage_expr = None
                for k, v in zip(arg.keys, arg.values):
                    if isinstance(k, ast.Constant) and k.value == 'stage':
                        stage_expr = ast.dump(v)
                failure_calls.append({'keys': sorted(keys), 'stage_expr': stage_expr})

tracker_assigns = 0
tracker_name = None
if failure_calls and failure_calls[0]['stage_expr']:
    # The stage value in the failure payload must be a variable (the stage
    # tracker), not a constant — find its name from the dump.
    import re
    m = re.search(r"Name\\(id='([A-Za-z_][A-Za-z0-9_]*)'\\)", failure_calls[0]['stage_expr'])
    if m:
        tracker_name = m.group(1)
        for node in ast.walk(process_doc):
            if isinstance(node, ast.Assign):
                for t in node.targets:
                    if isinstance(t, ast.Name) and t.id == tracker_name:
                        tracker_assigns += 1

print(json.dumps({
    'failure_payloads': failure_calls,
    'tracker_name': tracker_name,
    'tracker_assign_count': tracker_assigns,
}))
"""

_API_AST_SCRIPT = """\
import ast, json, sys

with open(sys.argv[1]) as f:
    tree = ast.parse(f.read())

fn = None
for node in tree.body:
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == 'run_transactional_update':
        fn = node
if fn is None:
    print(json.dumps({'error': 'run_transactional_update not found'})); sys.exit(0)

read_keys = set()
main_update_keys = set()
summary_error_keys = set()

def details_reads(nodes):
    keys = set()
    for n in nodes:
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) \
                and n.func.attr == 'get' and isinstance(n.func.value, ast.Name) \
                and n.func.value.id == 'details' and n.args \
                and isinstance(n.args[0], ast.Constant):
            keys.add(n.args[0].value)
        if isinstance(n, ast.Subscript) and isinstance(n.value, ast.Name) \
                and n.value.id == 'details' and isinstance(n.slice, ast.Constant):
            keys.add(n.slice.value)
    return keys

for node in ast.walk(fn):
    if isinstance(node, ast.If):
        test = node.test
        is_failed = (
            isinstance(test, ast.Compare) and isinstance(test.left, ast.Name)
            and test.left.id == 'new_status'
            and any(isinstance(c, ast.Constant) and c.value == 'failed' for c in test.comparators)
        )
        if not is_failed:
            continue
        body = list(node.body)
        for stmt in body:
            if isinstance(stmt, ast.Assign):
                for t in stmt.targets:
                    if isinstance(t, ast.Subscript) and isinstance(t.value, ast.Name) \
                            and t.value.id == 'main_update' and isinstance(t.slice, ast.Constant):
                        main_update_keys.add(t.slice.value)
            if isinstance(stmt, ast.Assign) and getattr(stmt, 'value', None) is not None:
                v = stmt.value
                if isinstance(v, ast.Dict):
                    for k in v.keys:
                        if isinstance(k, ast.Constant) and k.value == 'error':
                            summary_error_keys |= details_reads(
                                [e for e in ast.walk(v) if isinstance(e, (ast.Call, ast.Subscript))]
                            )
        read_keys |= details_reads(
            [n for n in ast.walk(ast.Module(body=body, type_ignores=[]))
             if isinstance(n, (ast.Call, ast.Subscript))]
        )

print(json.dumps({
    'read_keys': sorted(read_keys),
    'main_update_keys': sorted(main_update_keys),
}))
"""


def _run_ast_script(script, path):
    result = subprocess.run(
        [sys.executable, "-c", script, path],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(f"AST subprocess failed: {result.stderr}")
    return json.loads(result.stdout.strip())


class TestFailurePayloadDriftGuards:
    def test_worker_failure_payload_has_contract_keys(self):
        shapes = _run_ast_script(_WORKER_AST_SCRIPT, WORKER_MAIN)
        assert "error" in shapes or shapes.get("failure_payloads"), shapes
        payloads = shapes["failure_payloads"]
        assert payloads, "worker must publish a failure payload containing error_message"
        keys = set(payloads[0]["keys"])
        missing = REQUIRED_API_READ_KEYS - keys
        assert not missing, f"worker failure payload missing contract keys: {missing}"

    def test_worker_failure_payload_stage_is_tracked_variable(self):
        shapes = _run_ast_script(_WORKER_AST_SCRIPT, WORKER_MAIN)
        assert shapes.get("tracker_name"), (
            "the failure payload's stage must come from a stage-tracker "
            "variable, not a constant"
        )
        assert shapes["tracker_assign_count"] >= 5, (
            "the stage tracker must be updated across the pipeline stages "
            "(set immediately before each pipeline step)"
        )

    def test_rag_api_failed_branch_reads_worker_keys(self):
        shapes = _run_ast_script(_API_AST_SCRIPT, os.path.join(
            os.path.dirname(WORKER_DIR), "rag-api-service", "main.py"
        ))
        read_keys = set(shapes["read_keys"])
        missing = REQUIRED_API_READ_KEYS - read_keys
        assert not missing, (
            f"rag-api failed branch must read payload keys {REQUIRED_API_READ_KEYS}; "
            f"missing: {missing}"
        )

    def test_rag_api_failed_branch_persists_established_schema_fields(self):
        shapes = _run_ast_script(_API_AST_SCRIPT, os.path.join(
            os.path.dirname(WORKER_DIR), "rag-api-service", "main.py"
        ))
        main_update_keys = set(shapes["main_update_keys"])
        missing = EXPECTED_PERSISTED_FIELDS - main_update_keys
        assert not missing, (
            f"rag-api failed branch must persist {EXPECTED_PERSISTED_FIELDS} "
            f"on the main document; missing: {missing}"
        )


# Module-scope worker import fixture (heavy deps mocked once).
@pytest.fixture(scope="module")
def worker_mod():
    return _import_worker_main()
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>