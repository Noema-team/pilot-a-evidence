<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="apps/ai-server/tests/integration/test_worker_failure_payload_contract.py">>>
"""
Worker → rag-api failure payload contract tests.

Scope (from the authoritative Definition, wi-define-108-a8):
  - The worker's failed status payload must carry error_message (actual exception
    message), stage (failing pipeline stage), and retryable (deliberately derived
    from classify_error) — never relying on rag-api's fallback defaults.
  - The worker must track the currently executing pipeline stage through
    process_document; stage names reuse the existing progress vocabulary
    (starting, text_retrieved, tagging_complete, summary_generated,
    chunking_complete, embeddings_complete) with "processing" as the safe
    unknown value.
  - rag-api's failed branch persists error ← error_message, error_stage ← stage,
    retryable ← retryable, and mirrors message/stage into the processing/summary
    error subdocument.
  - retryable derivation: transient-classified → True; permanent-classified
    (including unclassified-unknown) → False.
  - The legacy `error` key is retained alongside error_message (compat hedge).

Tests are derived from the requirements only, not from implementation details
beyond what the contract itself pins. Both sides are imported / AST-inspected
rather than restated in fixtures, so a key drift on either side fails the build.

The behavioral tests (classify_error mapping) exercise the worker's real
classification function. The payload/persistence seam is pinned by AST drift
guards on both the worker's failure publisher and rag-api's failed-branch
reader, following the existing AST-based pattern in
apps/ai-server/tests/integration/test_api_contracts.py.
"""

import ast
import os
import sys
import types

import pytest

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
AI_SERVER_DIR = os.path.abspath(os.path.join(TESTS_DIR, ".."))
WORKER_DIR = os.path.abspath(os.path.join(AI_SERVER_DIR, "rag-worker-service"))
RAG_API_DIR = os.path.abspath(os.path.join(AI_SERVER_DIR, "rag-api-service"))

WORKER_MAIN = os.path.join(WORKER_DIR, "main.py")
RAG_API_MAIN = os.path.join(RAG_API_DIR, "main.py")

# The contract under test.
WORKER_FAILURE_KEYS = {"error_message", "stage", "retryable"}
WORKER_LEGACY_KEY = "error"  # retained for unknown consumers of the status topic
RAG_API_CONSUMED_KEYS = {"error_message", "stage", "retryable"}
PERSISTED_FIELDS = {"error", "error_stage", "retryable"}

# Existing progress-stage vocabulary the failure stage must reuse.
KNOWN_STAGES = {
    "starting",
    "text_retrieved",
    "tagging_complete",
    "summary_generated",
    "chunking_complete",
    "embeddings_complete",
}
SAFE_UNKNOWN_STAGE = "processing"

# Number of pipeline steps that must set the stage tracker before their await.
# Six progress transitions exist in process_document; the tracker must be set
# at least that many times (update-before-await convention).
MIN_STAGE_TRACKER_ASSIGNMENTS = 6


# ---------------------------------------------------------------------------
# Module loading helpers
# ---------------------------------------------------------------------------

def _parse(path):
    with open(path) as f:
        return ast.parse(f.read())


def _find_function(tree, name):
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return node
    return None


def _dict_literal_keys(node):
    """Keys of an ast.Dict literal (string constants only)."""
    if isinstance(node, ast.Dict):
        return {k.value for k in node.keys if isinstance(k, ast.Constant) and isinstance(k.value, str)}
    return set()


def _stub_worker_dependencies():
    """
    Stub the worker's heavy third-party imports so worker main.py can be
    imported hermetically (mirrors rag-worker-service/tests/conftest.py).
    """
    def stub(name, attrs=None):
        if name in sys.modules:
            return
        mod = types.ModuleType(name)
        if attrs:
            for k, v in attrs.items():
                setattr(mod, k, v)
        sys.modules[name] = mod

    class _FakeCreds:
        @classmethod
        def from_service_account_file(cls, *a, **kw):
            return object()

    stub("openai", {
        "AsyncOpenAI": type("AsyncOpenAI", (), {"__init__": lambda self, **kw: None}),
        "APIError": type("APIError", (Exception,), {}),
    })
    stub("langfuse", {"Langfuse": type("Langfuse", (), {"__init__": lambda self, **kw: None})})
    stub("firebase_admin", {"_apps": {}, "initialize_app": lambda *a, **kw: None})
    stub("firebase_admin.firestore", {})
    stub("firebase_admin.storage", {})
    stub("firebase_admin.credentials", {})
    stub("firebase_admin.auth", {"create_custom_token": lambda uid: b"token"})
    stub("google", {"__path__": []})
    stub("google.cloud", {"__path__": []})
    stub("google.cloud.pubsub_v1", {
        "PublisherClient": type("PublisherClient", (), {"__init__": lambda self, **kw: None}),
        "SubscriberClient": type("SubscriberClient", (), {
            "__init__": lambda self, **kw: None,
            "subscription_path": lambda self, *a: "projects/test/subscriptions/test-sub",
        }),
    })
    stub("google.oauth2", {"__path__": []})
    stub("google.oauth2.service_account", {"Credentials": _FakeCreds})
    stub("google.auth", {})
    stub("google.auth.credentials", {
        "AnonymousCredentials": type("AnonymousCredentials", (), {"__init__": lambda self: None}),
    })
    stub("spacy", {})
    stub("tiktoken", {
        "get_encoding": lambda x: type("Enc", (), {"encode": lambda self, t: t.split()})(),
    })
    stub("tenacity", {
        "retry": lambda *a, **kw: (lambda f: f),
        "stop_after_attempt": lambda n: None,
        "wait_exponential": lambda **kw: None,
    })
    stub("google.cloud.firestore", {
        "Increment": lambda v: v,
        "SERVER_TIMESTAMP": "SERVER_TIMESTAMP",
        "client": lambda: None,
        "Client": type("Client", (), {"__init__": lambda self, *a, **kw: None}),
    })
    stub("google.cloud.firestore_v1", {"__path__": []})
    stub("google.cloud.firestore_v1.base_query", {
        "FieldFilter": type("FieldFilter", (), {"__init__": lambda self, *a, **kw: None}),
    })
    stub("google.cloud.storage", {"bucket": lambda *a, **kw: None})

    # langchain text splitter / schema
    try:
        from langchain_text_splitters import RecursiveCharacterTextSplitter as _RCTS  # noqa
        splitter = _RCTS
    except ImportError:
        splitter = type("RecursiveCharacterTextSplitter", (), {})
    stub("langchain", {"__path__": []})
    stub("langchain.text_splitter", {"RecursiveCharacterTextSplitter": splitter})
    try:
        from langchain_core.documents import Document as _Doc  # noqa
        doc = _Doc
    except ImportError:
        doc = type("Document", (), {"__init__": lambda self, **kw: None})
    stub("langchain.schema", {"Document": doc})


_worker_main = None


def _load_worker_main():
    """Import the worker's main module (with stubs) once, for behavioral tests."""
    global _worker_main
    if _worker_main is not None:
        return _worker_main
    _stub_worker_dependencies()
    env_defaults = {
        "GOOGLE_APPLICATION_CREDENTIALS": "/dev/null",
        "GCP_PROJECT": "test-gcp",
        "RAG_PROCESS_SUB": "test-sub",
        "RAG_STATUS_TOPIC": "test-topic",
        "OPENROUTER_API_KEY": "test-key",
        "OPENROUTER_BASE_URL": "http://localhost",
        "OPENROUTER_MODEL": "test-model",
        "FIREBASE_STORAGE_BUCKET": "test-bucket",
        "FIREBASE_PROJECT_ID": "test-project",
        "SHARED_INTERNAL_TOKEN": "test-token",
        "WEAVIATE_SERVICE_URL": "http://localhost:8080",
    }
    for k, v in env_defaults.items():
        os.environ.setdefault(k, v)
    if WORKER_DIR not in sys.path:
        sys.path.insert(0, WORKER_DIR)
    import main as worker_main  # rag-worker-service/main.py
    _worker_main = worker_main
    return worker_main


# ---------------------------------------------------------------------------
# Shared AST fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def worker_tree():
    assert os.path.exists(WORKER_MAIN), f"worker main.py not found at {WORKER_MAIN}"
    return _parse(WORKER_MAIN)


@pytest.fixture(scope="module")
def rag_api_tree():
    assert os.path.exists(RAG_API_MAIN), f"rag-api main.py not found at {RAG_API_MAIN}"
    return _parse(RAG_API_MAIN)


@pytest.fixture(scope="module")
def worker_process_document(worker_tree):
    fn = _find_function(worker_tree, "process_document")
    assert fn is not None, "process_document not found in rag-worker main.py"
    return fn


def _failure_publish_call(process_document_fn):
    """Find the _publish_status_update call with status 'failed' inside the
    exception handler of process_document."""
    for node in ast.walk(process_document_fn):
        if isinstance(node, ast.ExceptHandler):
            for sub in ast.walk(node):
                if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Attribute) \
                        and sub.func.attr == "_publish_status_update":
                    if len(sub.args) >= 4 and isinstance(sub.args[3], ast.Constant) \
                            and sub.args[3].value == "failed":
                        return sub
    return None


def _failed_branch_source(rag_api_fn):
    """Extract the source segment of rag-api's failed branch: the block guarded
    by status == 'failed' (an If whose test mentions the 'failed' constant)."""
    for node in ast.walk(rag_api_fn):
        if isinstance(node, ast.If):
            consts = [n.value for n in ast.walk(node.test)
                      if isinstance(n, ast.Constant) and isinstance(n.value, str)]
            if "failed" in consts:
                return ast.unparse(node)
    return None


# ---------------------------------------------------------------------------
# Worker side: failure payload construction
# ---------------------------------------------------------------------------

class TestWorkerFailurePayloadContract:
    def test_failure_payload_contains_required_keys(self, worker_process_document):
        """Requirement: failed payload must include error_message, stage,
        retryable — the payload must never rely on rag-api's fallbacks."""
        call = _failure_publish_call(worker_process_document)
        assert call is not None, (
            "process_document's exception handler must publish a 'failed' "
            "status via _publish_status_update"
        )
        assert len(call.args) >= 5, (
            "_publish_status_update('failed', ...) must receive a details dict"
        )
        details = call.args[4]
        keys = _dict_literal_keys(details)
        missing = WORKER_FAILURE_KEYS - keys
        assert not missing, (
            f"Worker failure payload missing required keys {missing}; "
            f"found {sorted(keys)}. rag-api reads error_message/stage/retryable."
        )

    def test_failure_payload_retains_legacy_error_key(self, worker_process_document):
        """Prefer-constraint: legacy `error` key retained alongside
        error_message for unknown consumers of the status topic."""
        call = _failure_publish_call(worker_process_document)
        assert call is not None
        keys = _dict_literal_keys(call.args[4])
        assert WORKER_LEGACY_KEY in keys, (
            "Worker failure payload must retain the legacy 'error' key "
            "alongside error_message for topic-consumer continuity"
        )

    def test_error_message_value_is_the_actual_exception(self, worker_process_document):
        """error_message must carry the actual exception message (str(e)),
        not a static fallback string."""
        call = _failure_publish_call(worker_process_document)
        assert call is not None
        details = call.args[4]
        for key, value in zip(details.keys, details.values):
            if isinstance(key, ast.Constant) and key.value == "error_message":
                assert isinstance(value, ast.Call), (
                    "error_message must be derived from the caught exception "
                    "(e.g. str(e)), not a literal"
                )
                src = ast.unparse(value)
                assert "str(" in src, (
                    f"error_message must wrap the exception (str(e)); got {src}"
                )
                return
        pytest.fail("error_message key not found in failure payload")

    def test_stage_value_comes_from_tracked_variable(self, worker_process_document):
        """The failure handler must report the stage tracker variable, not a
        literal — the tracker is what makes the stage the *true* failing stage."""
        call = _failure_publish_call(worker_process_document)
        assert call is not None
        details = call.args[4]
        for key, value in zip(details.keys, details.values):
            if isinstance(key, ast.Constant) and key.value == "stage":
                assert isinstance(value, ast.Name), (
                    "stage in the failure payload must be read from the stage "
                    "tracker variable, not a hardcoded literal"
                )
                return
        pytest.fail("stage key not found in failure payload")

    def test_stage_tracker_is_maintained_across_pipeline_steps(self, worker_process_document):
        """Stage-tracker drift guard: the tracker variable reported at failure
        time must be assigned before each pipeline step (update-before-await
        convention). With six progress transitions in the pipeline, the tracker
        must be assigned at least that many times inside process_document."""
        # The variable the failure payload reports:
        call = _failure_publish_call(worker_process_document)
        assert call is not None
        tracker_name = None
        for key, value in zip(call.args[4].keys, call.args[4].values):
            if isinstance(key, ast.Constant) and key.value == "stage" and isinstance(value, ast.Name):
                tracker_name = value.id
        assert tracker_name is not None, "failure payload must reference a stage tracker variable"

        assignments = [
            node for node in ast.walk(worker_process_document)
            if isinstance(node, ast.Assign)
            and any(isinstance(t, ast.Name) and t.id == tracker_name for t in node.targets)
        ]
        assert len(assignments) >= MIN_STAGE_TRACKER_ASSIGNMENTS, (
            f"Stage tracker '{tracker_name}' assigned only {len(assignments)} times "
            f"in process_document; expected >= {MIN_STAGE_TRACKER_ASSIGNMENTS} "
            "(one per pipeline step, set immediately before the await). "
            "A step added without updating the tracker reports a stale stage."
        )
        # Each assignment must set the tracker to a value from the known
        # vocabulary or the safe unknown value.
        for node in assignments:
            consts = [n.value for n in ast.walk(node.value)
                      if isinstance(n, ast.Constant) and isinstance(n.value, str)]
            for c in consts:
                assert c in KNOWN_STAGES or c == SAFE_UNKNOWN_STAGE, (
                    f"Stage tracker set to unknown stage '{c}'; must reuse the "
                    f"progress vocabulary {sorted(KNOWN_STAGES)} or "
                    f"'{SAFE_UNKNOWN_STAGE}'"
                )

    def test_stage_tracker_initialized_to_safe_unknown_value(self, worker_process_document):
        """When the stage is genuinely unknown (failure before the first
        transition), the tracker must default to 'processing' — the same value
        the stale-lease sweep uses — so error_stage never regresses to null."""
        call = _failure_publish_call(worker_process_document)
        assert call is not None
        tracker_name = None
        for key, value in zip(call.args[4].keys, call.args[4].values):
            if isinstance(key, ast.Constant) and key.value == "stage" and isinstance(value, ast.Name):
                tracker_name = value.id
        assert tracker_name is not None

        # Find the earliest assignment to the tracker in source order; it must
        # be an initializer to the safe value.
        assignments = sorted(
            (node for node in ast.walk(worker_process_document)
             if isinstance(node, ast.Assign)
             and any(isinstance(t, ast.Name) and t.id == tracker_name for t in node.targets)),
            key=lambda n: n.lineno,
        )
        assert assignments, "stage tracker must be initialized"
        first = assignments[0]
        consts = [n.value for n in ast.walk(first.value)
                  if isinstance(n, ast.Constant) and isinstance(n.value, str)]
        assert SAFE_UNKNOWN_STAGE in consts, (
            f"Stage tracker must initialize to '{SAFE_UNKNOWN_STAGE}' so an "
            "early failure never persists error_stage=None"
        )


# ---------------------------------------------------------------------------
# Worker side: retryable derivation (behavioral, real classify_error)
# ---------------------------------------------------------------------------

class TestRetryableDerivation:
    @pytest.fixture(scope="class")
    def worker(self):
        return _load_worker_main()

    def _payload_retryable(self, worker, exc):
        """The contract: retryable == classify_error(exc). transient → True,
        permanent (incl. unclassified-unknown) → False."""
        return bool(worker.classify_error(exc))

    def test_transient_error_maps_to_retryable_true(self, worker):
        assert self._payload_retryable(worker, worker.TransientError("boom")) is True

    def test_permanent_error_maps_to_retryable_false(self, worker):
        assert self._payload_retryable(worker, worker.PermanentError("bad input")) is False

    def test_unclassified_unknown_maps_to_retryable_false(self, worker):
        """classify_error's conservative default: unknown exceptions are
        permanent → retryable False (deliberate change from the old silent
        True default)."""
        class WeirdError(Exception):
            pass
        assert self._payload_retryable(worker, WeirdError("???")) is False

    def test_connection_error_is_transient(self, worker):
        import httpx
        assert self._payload_retryable(worker, httpx.ConnectError("refused")) is True

    def test_http_429_is_transient(self, worker):
        import httpx
        req = httpx.Request("GET", "http://x")
        resp = httpx.Response(429, request=req)
        assert self._payload_retryable(worker, httpx.HTTPStatusError("rate", request=req, response=resp)) is True

    def test_http_400_is_permanent(self, worker):
        import httpx
        req = httpx.Request("GET", "http://x")
        resp = httpx.Response(400, request=req)
        assert self._payload_retryable(worker, httpx.HTTPStatusError("bad", request=req, response=resp)) is False

    def test_failure_payload_retryable_is_derived_not_literal(self, worker_process_document):
        """The retryable value in the failure payload must come from
        classify_error (a Call), never a hardcoded literal default."""
        call = _failure_publish_call(worker_process_document)
        assert call is not None
        details = call.args[4]
        for key, value in zip(details.keys, details.values):
            if isinstance(key, ast.Constant) and key.value == "retryable":
                assert isinstance(value, ast.Call), (
                    "retryable must be deliberately derived (classify_error(e)), "
                    "never a hardcoded literal — the silent default is exactly "
                    "the bug being fixed"
                )
                src = ast.unparse(value)
                assert "classify_error" in src, (
                    f"retryable must be derived via classify_error; got {src}"
                )
                return
        pytest.fail("retryable key not found in failure payload")


# ---------------------------------------------------------------------------
# rag-api side: failed-branch consumption and persistence
# ---------------------------------------------------------------------------

class TestRagApiFailedBranchContract:
    def test_failed_branch_reads_worker_payload_keys(self, rag_api_tree):
        """Requirement: rag-api's failed branch reads error_message, stage,
        retryable from the details payload. If the worker's keys drift, this
        test plus the worker-side guards fail the build."""
        fn = _find_function(rag_api_tree, "run_transactional_update")
        assert fn is not None, "run_transactional_update not found in rag-api main.py"
        branch = _failed_branch_source(fn)
        assert branch is not None, "failed branch not found in run_transactional_update"

        read_keys = set()
        for node in ast.walk(ast.parse(branch)):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
                    and node.func.attr == "get":
                if node.args and isinstance(node.args[0], ast.Constant) \
                        and isinstance(node.args[0].value, str):
                    read_keys.add(node.args[0].value)
        missing = RAG_API_CONSUMED_KEYS - read_keys
        assert not missing, (
            f"rag-api failed branch no longer reads {missing} from the worker "
            f"payload; consumed keys found: {sorted(read_keys)}"
        )

    def test_failed_branch_persists_established_fields(self, rag_api_tree):
        """The failed branch must persist error, error_stage, retryable on the
        main resource document (established schema — no rename, no migration)."""
        fn = _find_function(rag_api_tree, "run_transactional_update")
        assert fn is not None
        branch = _failed_branch_source(fn)
        assert branch is not None

        written = set()
        for node in ast.walk(ast.parse(branch)):
            if isinstance(node, ast.Dict):
                written |= _dict_literal_keys(node)
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                written.add(node.value)
        missing = PERSISTED_FIELDS - written
        assert not missing, (
            f"rag-api failed branch no longer persists {missing}; "
            f"established schema is {sorted(PERSISTED_FIELDS)}"
        )

    def test_failed_branch_writes_processing_summary_error_subdocument(self, rag_api_tree):
        """The processing/summary error subdocument must carry the same message
        and stage, with error_code defaulting to 'UNKNOWN' when no code is sent."""
        fn = _find_function(rag_api_tree, "run_transactional_update")
        assert fn is not None
        branch = _failed_branch_source(fn)
        assert branch is not None
        assert "processing" in branch and "summary" in branch, (
            "failed branch must write to the processing/summary subdocument"
        )
        assert "UNKNOWN" in branch, (
            "processing/summary error subdocument must default error_code to "
            "'UNKNOWN' unless a code is actually sent"
        )

    def test_persisted_error_comes_from_payload_error_message(self, rag_api_tree):
        """Persistence mapping: error ← details error_message (not a static
        fallback like 'Processing failed')."""
        fn = _find_function(rag_api_tree, "run_transactional_update")
        assert fn is not None
        branch = _failed_branch_source(fn)
        assert branch is not None
        # The failed branch must reference the error_message key when building
        # the persisted error value.
        uses_error_message = False
        for node in ast.walk(ast.parse(branch)):
            if isinstance(node, ast.Constant) and node.value == "error_message":
                uses_error_message = True
                break
        assert uses_error_message, (
            "failed branch must map persisted error from payload error_message"
        )


# ---------------------------------------------------------------------------
# Cross-service seam: the two key sets must interlock
# ---------------------------------------------------------------------------

class TestSeamInterlock:
    def test_worker_payload_keys_are_exactly_what_rag_api_reads(
        self, worker_process_document, rag_api_tree
    ):
        """The drift guard doing its job: the worker's failure payload keys and
        rag-api's consumed keys must interlock — every key the worker sends
        that rag-api depends on must be read, and vice versa."""
        call = _failure_publish_call(worker_process_document)
        assert call is not None
        worker_keys = _dict_literal_keys(call.args[4])

        fn = _find_function(rag_api_tree, "run_transactional_update")
        assert fn is not None
        branch = _failed_branch_source(fn)
        assert branch is not None

        api_keys = set()
        for node in ast.walk(ast.parse(branch)):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
                    and node.func.attr == "get":
                if node.args and isinstance(node.args[0], ast.Constant) \
                        and isinstance(node.args[0].value, str):
                    api_keys.add(node.args[0].value)

        for key in RAG_API_CONSUMED_KEYS:
            assert key in worker_keys, (
                f"rag-api reads '{key}' but the worker's failure payload does "
                "not send it — the fallback-default bug resurfaces"
            )
            assert key in api_keys, (
                f"worker sends '{key}' but rag-api's failed branch no longer "
                "reads it — the value would be silently dropped"
            )
        # Legacy key retained on the wire even though rag-api doesn't read it.
        assert WORKER_LEGACY_KEY in worker_keys
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>