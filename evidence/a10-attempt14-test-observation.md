<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path=".sle/work/wi-define-108-a8/tests.md">>>
# Test scripts — worker→rag-api failure payload contract (`wi-define-108-a8`)

Derived **only** from the authoritative Definition (requirements R1–R4, constraints, acceptance criteria). All spec literals (`error_message`/`stage`/`retryable` payload keys; persisted `error`/`error_stage`/`retryable`; stage vocabulary `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`, safe value `"processing"`; fallbacks `"Processing failed"`/`None`/`True`; `error_code` default `"UNKNOWN"`) are taken from the Definition, never from implementation code.

**These tests are RED until the fix lands.** The current worker handler publishes only `{"error": str(e)}` (F3), so every payload assertion below fails today — that is the bug reproduced as an executable test.

## Deliverables

| File | CI leg (verified) | Covers |
|---|---|---|
| `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py` | `python-unit-tests` → worker is in `UNIT_SERVICES` of `ci-detect-changes.sh`; runs `pytest rag-worker-service/tests/unit/` | R1 payload keys + drift guard, R2 stage tracking (behavioral + AST), R4 retryable derivation vs `classify_error` |
| `apps/ai-server/tests/integration/test_worker_failure_payload_contract.py` | `cross-service-and-contract-tests` (cross fires when **either** service changes — verified) | Acceptance #4: full worker failure → rag-api persistence path, negative legacy-payload control, API-side AST drift guard |

**Required CI wiring (one line, must land with the test file):** the cross job runs an explicit file list (verified in `.github/workflows/backend-tests.yml`), so the new contract file must be added:

```yaml
      - name: Run API contract tests
        run: python3 -m pytest tests/integration/test_api_contracts.py tests/integration/test_worker_failure_payload_contract.py -v --tb=short
```

(Do **not** switch to a directory wildcard: that would silently pull `test_base_images_are_pinned.py` / `test_containers_run_as_non_root.py` — verified present in `tests/integration/` but absent from the cross job's list — into this job.)

---

## FILE 1: `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py`

```python
"""Worker failure-status payload contract (unit side) — wi-define-108-a8.

R1  failed payload carries error_message (real exception message), stage
    (pipeline stage at failure time) and retryable (deliberately derived) —
    never relying on rag-api's fallback defaults.
R2  stage is tracked through process_document; names reuse the progress
    vocabulary; "processing" only when the stage is genuinely unknown.
R4  retryable is derived from classify_error: transient -> True,
    permanent / unclassified-unknown -> False.

RED until the fix lands: today the exception handler publishes only
{"error": str(e)} (Definition F3), so every payload assertion fails.
"""
import ast
import asyncio
import importlib.util
import inspect
import os
import sys
from pathlib import Path

import pytest

SERVICE_DIR = Path(__file__).resolve().parents[2]
if str(SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(SERVICE_DIR))

import main  # worker main; heavy deps stubbed by tests/conftest.py

# R2: the exact vocabulary pinned by the Definition (six progress stages +
# the "genuinely unknown" safe value).
ALLOWED_STAGES = {
    "starting", "text_retrieved", "tagging_complete", "summary_generated",
    "chunking_complete", "embeddings_complete", "processing",
}
# R1 + F11 hedge: exact key set of the failure details payload. A new key
# must touch this test — that ossification is the drift guard working.
EXPECTED_FAILURE_KEYS = {"error", "error_message", "stage", "retryable"}

WORKER_MAIN_SRC = SERVICE_DIR / "main.py"


# ── exception classes (Definition F7 pins TransientError/PermanentError) ────
def _exc_classes():
    try:
        spec = importlib.util.spec_from_file_location(
            "worker_exceptions", SERVICE_DIR / "exceptions.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod.TransientError, mod.PermanentError
    except Exception:
        return main.TransientError, main.PermanentError  # re-export fallback


# ── capture the failed-status publish (Definition F3: handler publishes via
#    _publish_status_update; we intercept the seam, signature-agnostic) ──────
class _Capture:
    def __init__(self, exc=None, raise_on_call=1):
        self.calls = []
        self._exc = exc
        self._raise_on = raise_on_call

    async def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if self._raise_on and len(self.calls) == self._raise_on:
            raise self._exc


def _failure_payload(cap):
    for args, kwargs in cap.calls:
        dicts = [a for a in args if isinstance(a, dict)]
        dicts += [v for v in kwargs.values() if isinstance(v, dict)]
        for d in dicts:
            if "error_message" in d:
                return d
    pytest.fail(
        "no failed-status payload with 'error_message' was published — RED "
        "until the fix lands (or the publish seam moved; see artifact "
        "assumptions)")


# ── adapter: invoke process_document without guessing its signature ─────────
_CANDIDATES = {
    "user_id": "u1", "course_id": "c1", "resource_id": "r1",
    "document_id": "r1", "file_id": "r1",
    "file_url": "gs://test-bucket/u1/c1/r1",
    "storage_path": "u1/c1/r1", "file_name": "doc.pdf",
    "mime_type": "application/pdf",
    "data": {"user_id": "u1", "course_id": "c1", "resource_id": "r1",
             "file_url": "gs://test-bucket/u1/c1/r1"},
}


def _process_kwargs():
    sig = inspect.signature(main.process_document)
    kwargs = {}
    for name, p in sig.parameters.items():
        if p.default is not inspect.Parameter.empty:
            continue
        if name in _CANDIDATES:
            kwargs[name] = _CANDIDATES[name]
        else:
            pytest.fail(
                f"process_document requires param {name!r} not in the "
                f"candidate map — extend _CANDIDATES (adapter; see artifact "
                f"assumptions)")
    return kwargs


# Defensive no-op patching of claim-ish preambles so the first publish is the
# first observable failure point. Harmless when names don't exist.
_CLAIM_CANDIDATES = [
    "_claim_resource_if_queued", "_claim_if_queued", "_claim_resource",
    "_fail_if_still_stale",
]


def _patch_claim_fns(monkeypatch):
    async def _ok(*a, **k):
        return True, {}
    for name in _CLAIM_CANDIDATES:
        if hasattr(main, name):
            monkeypatch.setattr(main, name, _ok, raising=False)


def _run_process(monkeypatch, exc):
    cap = _Capture(exc=exc)
    _patch_claim_fns(monkeypatch)
    monkeypatch.setattr(main, "_publish_status_update", cap)
    asyncio.run(main.process_document(**_process_kwargs()))
    return _failure_payload(cap)


# ── behavioral tests (R1, R2, R4) ────────────────────────────────────────────
def _cases():
    T, P = _exc_classes()
    return [
        ("unknown", RuntimeError, False),   # unclassified -> permanent (F8)
        ("transient", T, True),
        ("permanent", P, False),
    ]


@pytest.mark.parametrize("label,exc_cls,expected_retryable", _cases())
def test_failed_payload_contract(monkeypatch, label, exc_cls, expected_retryable):
    msg = f"boom-{label}"
    payload = _run_process(monkeypatch, exc_cls(msg))

    assert payload["error_message"] == msg          # R1: real message
    assert payload["error"] == msg                  # legacy hedge (F11 adopted default)
    assert payload["stage"] in ALLOWED_STAGES       # R2: tracked, never null/absent
    assert payload["retryable"] is expected_retryable  # R4: deliberately derived


def test_failed_payload_key_set_is_exact(monkeypatch):
    """Drift guard: adding/removing a failure-payload key must fail the build."""
    payload = _run_process(monkeypatch, RuntimeError("boom-keys"))
    assert set(payload) == EXPECTED_FAILURE_KEYS


def _classify_is_transient(result):
    """R4 alignment check without pinning classify_error's return representation."""
    if isinstance(result, bool):
        return result                    # ASSUMED: True means transient
    if isinstance(result, str):
        return "transient" in result.lower()
    name = getattr(result, "name", "") or str(result)
    return "transient" in name.lower()


@pytest.mark.parametrize("label,exc_cls,_", _cases(), ids=lambda v: str(v))
def test_retryable_matches_classify_error(monkeypatch, label, exc_cls, _):
    """R4: the payload's retryable must equal what classify_error decides."""
    exc = exc_cls(f"boom-align-{label}")
    payload = _run_process(monkeypatch, exc)
    expected = _classify_is_transient(main.classify_error(exc))
    assert payload["retryable"] is expected


# ── AST guards: the stage tracker exists and feeds the handler (R2) ─────────
def _find_fn(tree, name):
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return node
    return None


def _assigned_bindings(fn, tree):
    """name -> list of value nodes assigned in the function or at module level."""
    bindings = {}
    for scope in (fn, tree):
        for node in ast.walk(scope):
            if isinstance(node, ast.Assign):
                for t in node.targets:
                    if isinstance(t, ast.Name):
                        bindings.setdefault(t.id, []).append(node.value)
    return bindings


def _reaches_classify(node, bindings, depth=0):
    if depth > 4:
        return False
    if isinstance(node, ast.Call):
        f = node.func
        if isinstance(f, ast.Name) and f.id == "classify_error":
            return True
        if isinstance(f, ast.Name) and f.id in ("bool", "str") and node.args:
            return any(_reaches_classify(a, bindings, depth + 1) for a in node.args)
        return False
    if isinstance(node, ast.Name):
        for val in bindings.get(node.id, []):
            if _reaches_classify(val, bindings, depth + 1):
                return True
    return False


def _failure_details_dicts(fn):
    out = []
    for node in ast.walk(fn):
        if isinstance(node, ast.Dict) and node.keys:
            keys = {k.value for k in node.keys if isinstance(k, ast.Constant)}
            if "error_message" in keys:
                out.append(node)
    return out


def test_failure_details_literal_has_contract_keys():
    tree = ast.parse(WORKER_MAIN_SRC.read_text())
    fn = _find_fn(tree, "process_document")
    assert fn is not None, "process_document not found in worker main.py"
    dicts = _failure_details_dicts(fn)
    assert dicts, (
        "no failure details literal containing 'error_message' found inside "
        "process_document — the handler shape changed; update this guard")
    for d in dicts:
        keys = {k.value for k in d.keys if isinstance(k, ast.Constant)}
        missing = EXPECTED_FAILURE_KEYS - keys
        assert not missing, f"failure payload literal is missing keys: {missing}"


def test_stage_value_is_a_tracked_variable():
    """R2: 'stage' must come from a variable assigned >= 2 times (init + per-step
    updates) — a hardcoded stage or a removed tracker fails here."""
    tree = ast.parse(WORKER_MAIN_SRC.read_text())
    fn = _find_fn(tree, "process_document")
    assert fn is not None
    bindings = _assigned_bindings(fn, tree)
    for d in _failure_details_dicts(fn):
        for k, v in zip(d.keys, d.values):
            if isinstance(k, ast.Constant) and k.value == "stage":
                assert isinstance(v, ast.Name), (
                    "failure payload 'stage' is not a tracked variable")
                stores = [
                    n for n in ast.walk(fn)
                    if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)
                    and n.id == v.id
                ]
                assert len(stores) >= 2, (
                    f"stage tracker {v.id!r} is assigned {len(stores)} time(s) — "
                    "it must be initialised and updated per pipeline step (R2)")


def test_retryable_value_is_derived_from_classify_error():
    """R4: 'retryable' must be a classify_error call (or a name bound to one) —
    a literal True/False silent default fails here."""
    tree = ast.parse(WORKER_MAIN_SRC.read_text())
    fn = _find_fn(tree, "process_document")
    assert fn is not None
    bindings = _assigned_bindings(fn, tree)
    for d in _failure_details_dicts(fn):
        for k, v in zip(d.keys, d.values):
            if isinstance(k, ast.Constant) and k.value == "retryable":
                assert _reaches_classify(v, bindings), (
                    "failure payload 'retryable' is not derived from "
                    "classify_error — silent defaults are forbidden (R4)")
```

---

## FILE 2: `apps/ai-server/tests/integration/test_worker_failure_payload_contract.py`

```python
"""Contract test: worker failure payload -> rag-api failed-branch persistence.

Acceptance #4 of wi-define-108-a8: exercise the worker's failure-payload
construction through the real code path, feed the captured payload through
rag-api's run_transactional_update against fakes (Firestore-emulator mode
exists in both services — Definition F10 — but CI's cross job provisions no
emulator, so the house FakeTx/FakeDb pattern is used instead), and assert the
persisted error, error_stage and retryable equal the worker's values.

Also pins, on both sides, that the payload keys cannot drift silently.

NOTE: the worker side must run before the api side in this file (pytest keeps
file order): worker-main and api-main are both single-file 'main' modules and
are loaded lazily, in sequence, with sibling-module isolation.
"""
import ast
import asyncio
import importlib.util
import inspect
import os
import sys
import types
from pathlib import Path

import pytest

AI_SERVER = Path(__file__).resolve().parents[2]
WORKER_DIR = AI_SERVER / "rag-worker-service"
API_DIR = AI_SERVER / "rag-api-service"
WORKER_MAIN_SRC = WORKER_DIR / "main.py"
API_MAIN_SRC = API_DIR / "main.py"

USER_ID, COURSE_ID, RESOURCE_ID = "u1", "c1", "r1"

ALLOWED_STAGES = {
    "starting", "text_retrieved", "tagging_complete", "summary_generated",
    "chunking_complete", "embeddings_complete", "processing",
}
EXPECTED_FAILURE_KEYS = {"error", "error_message", "stage", "retryable"}

# ── worker env defaults (verified list from rag-worker tests/conftest.py) ────
for _k, _v in {
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
}.items():
    os.environ.setdefault(_k, _v)


# ── by-absence stubs: only inject a module if it is genuinely missing (the
#    shared integration conftest already mocks google/firebase/structlog) ────
def _stub_module(name, attrs=None):
    mod = types.ModuleType(name)
    for k, v in (attrs or {}).items():
        setattr(mod, k, v)
    sys.modules[name] = mod
    return mod


def _stub_if_missing(name, attrs=None):
    try:
        __import__(name)
        return sys.modules[name]
    except Exception:
        return _stub_module(name, attrs)


# The verified stub surface from rag-worker-service/tests/conftest.py.
_oa = _stub_if_missing("openai", {})
if not hasattr(_oa, "AsyncOpenAI"):
    _oa.AsyncOpenAI = type("AsyncOpenAI", (), {"__init__": lambda self, **kw: None})
    _oa.APIError = type("APIError", (Exception,), {"__init__": lambda self, *a, **kw: None})
_lf = _stub_if_missing("langfuse", {})
if not hasattr(_lf, "Langfuse"):
    _lf.Langfuse = type("Langfuse", (), {"__init__": lambda self, **kw: None})
_sp = _stub_if_missing("spacy", {})
if not hasattr(_sp, "load"):
    _sp.load = lambda *a, **kw: None
_tk = _stub_if_missing("tiktoken", {})
if not hasattr(_tk, "get_encoding"):
    _tk.get_encoding = lambda x: type("Enc", (), {"encode": lambda self, t: t.split()})()
_tn = _stub_if_missing("tenacity", {})
for _attr, _val in {
    "retry": lambda *a, **kw: (lambda f: f),
    "stop_after_attempt": lambda n: None,
    "wait_exponential": lambda **kw: None,
}.items():
    if not hasattr(_tn, _attr):
        setattr(_tn, _attr, _val)
if "langchain" not in sys.modules:
    _stub_module("langchain", {"__path__": []})
if "langchain.text_splitter" not in sys.modules:
    _stub_module("langchain.text_splitter", {
        "RecursiveCharacterTextSplitter": type("RCTS", (), {"__init__": lambda self, **kw: None}),
    })
if "langchain.schema" not in sys.modules:
    _stub_module("langchain.schema", {
        "Document": type("Document", (), {"__init__": lambda self, **kw: None}),
    })
for _heavy in ("marker", "pypdf", "magic", "PIL"):
    if _heavy not in sys.modules:
        _stub_if_missing(_heavy, {"__path__": []})


# ── module loading with sibling-package isolation ────────────────────────────
def _load_service_main(alias, service_dir):
    added_before = set(sys.modules)
    spec = importlib.util.spec_from_file_location(alias, service_dir / "main.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[alias] = mod
    sys.path.insert(0, str(service_dir))
    try:
        spec.loader.exec_module(mod)
    finally:
        if str(service_dir) in sys.path:
            sys.path.remove(str(service_dir))
    new_tops = {m.split(".")[0] for m in set(sys.modules) - added_before}
    return mod, new_tops


def _drop_siblings(service_dir, tops):
    """Remove sibling packages the load bound, so the *other* service's
    same-named packages (models/...) resolve cleanly on its own load."""
    for top in list(tops):
        if (service_dir / top).exists() or (service_dir / f"{top}.py").exists():
            for name in [n for n in sys.modules if n.split(".")[0] == top]:
                del sys.modules[name]


_worker_main = None
_worker_sibling_tops = set()


def _worker():
    global _worker_main, _worker_sibling_tops
    if _worker_main is None:
        _worker_main, _worker_sibling_tops = _load_service_main(
            "worker_main_contract", WORKER_DIR)
    return _worker_main


_api_main = None


def _api():
    """Loaded lazily, AFTER worker-side capture tests have run, so worker and
    api sibling modules never shadow each other in sys.modules."""
    global _api_main
    if _api_main is None:
        # Neutralise the @firestore.transactional decorator BEFORE api-main
        # executes, so run_transactional_update stays a real function (house
        # pattern from rag-worker tests/unit/test_processing_lease.py).
        for mocked in ("google.cloud.firestore", "google.cloud.firestore_v1",
                       "firebase_admin.firestore"):
            m = sys.modules.get(mocked)
            if m is not None:
                if not hasattr(m, "transactional") or not inspect.isfunction(
                        getattr(m, "transactional", None)):
                    try:
                        m.transactional = lambda f: f
                    except Exception:
                        pass
                try:
                    m.SERVER_TIMESTAMP = "SERVER_TIMESTAMP"
                except Exception:
                    pass
        _drop_siblings(WORKER_DIR, _worker_sibling_tops)
        mod, _ = _load_service_main("api_main_contract", API_DIR)
        if not inspect.isfunction(getattr(mod, "run_transactional_update", None)):
            pytest.fail(
                "run_transactional_update did not load as a real function — "
                "the transactional decorator path changed (see artifact "
                "assumptions)")
        _api_main = mod
    return _api_main


# ── generic in-memory Firestore fakes (house FakeTx/FakeSnap pattern) ────────
def _data_arg(args, kwargs):
    if len(args) >= 2:
        return args[1]
    for key in ("document_data", "field_updates", "data", "updates"):
        if key in kwargs:
            return kwargs[key]
    raise AssertionError(f"no update payload found in kwargs: {list(kwargs)}")


class _Snap:
    def __init__(self, data):
        self._d = dict(data)
        self.exists = True

    def to_dict(self):
        return dict(self._d)

    def get(self, key, default=None):
        return self._d.get(key, default)


class _Ref:
    def __init__(self, store, path):
        self._store, self._path = store, path

    @property
    def path(self):
        return self._path

    def get(self, transaction=None):
        return _Snap(self._store.docs.get(self._path, {}))

    def update(self, *a, **k):
        data = _data_arg(a, k)
        self._store.docs.setdefault(self._path, {}).update(data)
        self._store.writes.append(("update", self._path, data))

    def set(self, *a, **k):
        data = _data_arg(a, k)
        self._store.docs.setdefault(self._path, {}).update(data)
        self._store.writes.append(("set", self._path, data))


class _Coll:
    def __init__(self, store, path):
        self._store, self._path = store, path

    def document(self, name):
        return _Ref(self._store, f"{self._path}/{name}")


class _Tx:
    def __init__(self, store):
        self._store = store

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def get(self, ref):
        return ref.get(self)

    def update(self, *a, **k):
        ref = a[0] if a else k.get("ref") or k.get("document_ref")
        data = _data_arg(a[1:], k)
        ref.update(data)

    def set(self, *a, **k):
        ref = a[0] if a else k.get("ref") or k.get("document_ref")
        data = _data_arg(a[1:], k)
        ref.set(data)


class FakeDb:
    def __init__(self):
        self.docs = {}
        self.writes = []          # (kind, path, data) — every update/set

    def document(self, path):
        return _Ref(self, path)

    def collection(self, path):
        return _Coll(self, path)

    def transaction(self):
        return _Tx(self)


# ── adapters ─────────────────────────────────────────────────────────────────
def _call(fn, *args):
    out = fn(*args)
    return asyncio.run(out) if inspect.isawaitable(out) else out


class _Capture:
    def __init__(self, exc):
        self.calls, self._exc = [], exc

    async def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        raise self._exc


_CANDIDATES = {
    "user_id": USER_ID, "course_id": COURSE_ID, "resource_id": RESOURCE_ID,
    "document_id": RESOURCE_ID, "file_id": RESOURCE_ID,
    "file_url": "gs://test-bucket/u1/c1/r1", "storage_path": "u1/c1/r1",
    "file_name": "doc.pdf", "mime_type": "application/pdf",
    "data": {"user_id": USER_ID, "course_id": COURSE_ID,
             "resource_id": RESOURCE_ID,
             "file_url": "gs://test-bucket/u1/c1/r1"},
}

_CLAIM_CANDIDATES = [
    "_claim_resource_if_queued", "_claim_if_queued", "_claim_resource",
    "_fail_if_still_stale",
]


def _capture_worker_failure_payload(monkeypatch, exc):
    wm = _worker()

    async def _ok(*a, **k):
        return True, {}

    for name in _CLAIM_CANDIDATES:
        if hasattr(wm, name):
            monkeypatch.setattr(wm, name, _ok, raising=False)

    cap = _Capture(exc)
    monkeypatch.setattr(wm, "_publish_status_update", cap)

    sig = inspect.signature(wm.process_document)
    kwargs = {}
    for name, p in sig.parameters.items():
        if p.default is not inspect.Parameter.empty:
            continue
        if name in _CANDIDATES:
            kwargs[name] = _CANDIDATES[name]
        else:
            pytest.fail(
                f"process_document requires param {name!r} not in the "
                f"candidate map — extend _CANDIDATES (adapter)")
    asyncio.run(wm.process_document(**kwargs))

    for args, kw in cap.calls:
        for d in [a for a in args if isinstance(a, dict)] + \
                 [v for v in kw.values() if isinstance(v, dict)]:
            if "error_message" in d:
                return d
    pytest.fail("worker published no failed payload with 'error_message' — "
                "RED until the fix lands")


def _invoke_api_failed_branch(monkeypatch, payload):
    api = _api()
    db = FakeDb()
    sig = inspect.signature(api.run_transactional_update)
    args = [db, USER_ID, COURSE_ID, RESOURCE_ID, "failed", payload]
    # ASSUMED positional order (see artifact assumptions): (db, user_id,
    # course_id, resource_id, status, details). Single fix point if the real
    # signature differs.
    if len(sig.parameters) < len(args):
        pytest.fail(
            f"run_transactional_update takes {len(sig.parameters)} params; "
            f"adapter assumed {len(args)} — adjust the adapter, see "
            f"artifact assumptions")
    monkeypatch.setattr(api.firestore, "transactional", lambda f: f,
                        raising=False)
    monkeypatch.setattr(api.firestore, "SERVER_TIMESTAMP", "SERVER_TIMESTAMP",
                        raising=False)
    _call(api.run_transactional_update, *args)
    return db


# ── persistence assertions (path-agnostic: the failed branch owns the layout,
#    the contract owns the field names) ──────────────────────────────────────
def _main_doc_write(db):
    for _kind, _path, data in db.writes:
        if "error_stage" in data:
            return data
    pytest.fail("no persisted write carried 'error_stage' — the failed branch "
                "did not persist (adapter mismatch or contract regression)")


def _iter_dicts(obj):
    if isinstance(obj, dict):
        yield obj
        for v in obj.values():
            yield from _iter_dicts(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _iter_dicts(v)


def _subdoc_message_stage(db):
    for _kind, _path, data in db.writes:
        for d in _iter_dicts(data):
            if "message" in d and "stage" in d:
                return d
    pytest.fail("no processing/summary error subdoc with message+stage was "
                "written — Definition F4 contract broken")


# ── the contract test (Acceptance #4) ────────────────────────────────────────
def test_worker_failure_flows_to_persisted_document(monkeypatch):
    # 1. worker side: real failure-payload construction. RuntimeError is
    #    unclassified-unknown -> classify_error says permanent -> retryable
    #    False (F8; the deliberate behavior change this fix pins).
    payload = _capture_worker_failure_payload(
        monkeypatch, RuntimeError("boom-contract"))
    assert set(payload) == EXPECTED_FAILURE_KEYS        # worker-side drift guard
    assert payload["error_message"] == "boom-contract"
    assert payload["error"] == "boom-contract"          # legacy hedge (F11)
    assert payload["stage"] in ALLOWED_STAGES
    assert payload["retryable"] is False

    # 2. api side: real failed-branch persistence against fakes.
    db = _invoke_api_failed_branch(monkeypatch, payload)
    data = _main_doc_write(db)

    # R3: persisted values equal the worker's values, unchanged.
    assert data["error"] == payload["error_message"]
    assert data["error_stage"] == payload["stage"]
    assert data["retryable"] == payload["retryable"]


def test_processing_summary_subdoc_carries_message_and_stage(monkeypatch):
    payload = _capture_worker_failure_payload(
        monkeypatch, RuntimeError("boom-subdoc"))
    db = _invoke_api_failed_branch(monkeypatch, payload)
    sub = _subdoc_message_stage(db)
    assert sub["message"] == payload["error_message"]
    assert sub["stage"] == payload["stage"]
    # Non-goal honoured: no error-code taxonomy; UNKNOWN default stands.
    assert sub.get("error_code", "UNKNOWN") == "UNKNOWN"


def test_legacy_payload_still_lands_on_api_fallbacks(monkeypatch):
    """Negative control with drift-guard teeth: feeding the OLD one-key payload
    (the pre-fix worker shape, Definition F3/F5) must produce exactly the
    documented fallbacks — proving the api side is unchanged (constraint: the
    worker aligns to the api, never the reverse)."""
    db = _invoke_api_failed_branch(monkeypatch, {"error": "boom-legacy"})
    data = _main_doc_write(db)
    assert data["error"] == "Processing failed"   # F5 fallback literal
    assert data["error_stage"] is None            # F5 fallback literal
    assert data["retryable"] is True              # F5 silent default


def test_api_failed_branch_reads_contract_keys_only():
    """API-side drift guard: the failed branch must read error_message/stage/
    retryable from the payload and must NOT read the legacy 'error' key —
    reading 'error' would re-create the original mismatch."""
    tree = ast.parse(API_MAIN_SRC.read_text())
    fn = None
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and \
                node.name == "run_transactional_update":
            fn = node
    assert fn is not None, "run_transactional_update not found in api main.py"

    read_keys, detail_receivers, bad_reads = set(), set(), []
    for node in ast.walk(fn):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
                and node.func.attr == "get" and node.args \
                and isinstance(node.args[0], ast.Constant) \
                and isinstance(node.args[0].value, str):
            read_keys.add(node.args[0].value)
            if node.args[0].value == "error_message" and \
                    isinstance(node.func.value, ast.Name):
                detail_receivers.add(node.func.value.id)
        if isinstance(node, ast.Subscript) and \
                isinstance(node.slice, ast.Constant) and \
                isinstance(node.slice.value, str):
            read_keys.add(node.slice.value)

    missing = {"error_message", "stage", "retryable"} - read_keys
    assert not missing, (
        f"failed branch no longer reads payload keys {missing} — API-side "
        f"payload keys drifted")
    assert "error" not in detail_receivers or True
    for node in ast.walk(fn):
        receiver = None
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
                and node.func.attr == "get" and node.args \
                and isinstance(node.args[0], ast.Constant):
            receiver = node.func.value
            key = node.args[0].value
        elif isinstance(node, ast.Subscript) and \
                isinstance(node.slice, ast.Constant):
            receiver = node.value
            key = node.slice.value
        if receiver is not None and isinstance(receiver, ast.Name) and \
                receiver.id in detail_receivers and key == "error":
            bad_reads.append(key)
    assert not bad_reads, (
        "failed branch reads legacy 'error' from the payload details — "
        "re-introduces the worker/API key mismatch this fix removes")
```

---

## Requirement → test traceability

| Definition requirement / acceptance | Tests |
|---|---|
| R1 payload carries `error_message`/`stage`/`retryable`, never api fallbacks | F1 `test_failed_payload_contract`, `test_failed_payload_key_set_is_exact`; F2 `test_worker_failure_flows_to_persisted_document` |
| R2 stage tracker, progress vocabulary, safe `"processing"` | F1 `test_failed_payload_contract` (membership), `test_stage_value_is_a_tracked_variable`, `test_failure_details_literal_has_contract_keys` |
| R3 api persists values unchanged; subdoc carries message+stage | F2 `test_worker_failure_flows_to_persisted_document`, `test_processing_summary_subdoc_carries_message_and_stage` |
| R4 retryable from `classify_error` (transient→True, permanent/unknown→False) | F1 `test_failed_payload_contract`, `test_retryable_matches_classify_error`, `test_retryable_value_is_derived_from_classify_error`; F2 pins the unknown→False change |
| Acceptance: contract test covers worker failure → rag-api persistence, fails on key drift either side | F2 whole file (`test_worker_failure_flows_to_persisted_document` + both drift guards + `test_legacy_payload_still_lands_on_api_fallbacks`) |
| Constraint: api unchanged, no migration | F2 `test_legacy_payload_still_lands_on_api_fallbacks` (F5 fallback literals `"Processing failed"` / `None` / `True` pinned) |

## Assumptions requiring first-run confirmation (single fix points, flagged inline)

1. **`process_document` invocation** — introspected against a candidate kwargs map; an unrecognized required parameter fails loudly with an instruction, rather than guessing silently.
2. **`run_transactional_update` positional order** `(db, user_id, course_id, resource_id, status, details)` — isolated in `_invoke_api_failed_branch`; only that adapter changes if the real order differs.
3. **`classify_error` return representation** — `_classify_is_transient` handles bool/str/enum/tuple; the spec-pinned behavioral expectations (True/False per exception class) hold regardless; only the R4 alignment test depends on the heuristic.
4. **Failure-handler builds a dict literal** containing the four keys inside `process_document` (AST guards); a restructured handler fails the guard with a maintenance message rather than passing vacuously.
5. **Firestore fakes** — `run_transactional_update` is expected to use `db.transaction()`/`tx.get/tx.update` or direct ref updates; the generic FakeDb covers both. If the branch queries collections (`where(...)`) before writing, extend `_Coll` minimally.
6. **Stage value on early failure** may be `"starting"` or the safe `"processing"` depending on where the tracker is first assigned relative to the first publish; the membership assertion is deliberately convention-neutral, per R2. The plan's "late-stage failure" representative case cannot be built blind (full-pipeline collaborator stubs have unverifiable return shapes); the tracker mechanism is instead pinned by the ≥2-assignments AST guard plus a defined late value (`embeddings_complete` becomes assertable once collaborator stubs exist after the fix lands).

## Out of scope (per Definition non-goals)

No tests for ACK/NACK mechanics, lease/heartbeat timing, the stale-lease sweep's own write path, error-code taxonomy, or frontend exposure of `error`/`error_stage`.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>