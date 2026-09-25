All repository read tools are now unavailable, so I'm producing the artifact from the evidence verified during investigation: the Definition's binding facts (F3–F9, F11) and the existing contract-test infrastructure in `apps/ai-server/tests/integration/` (the fixture- and AST-based static contract pattern in `test_api_contracts.py`, the mocking/sys.path setup in `conftest.py`, and the duplicate-file guard pattern in `test_shared_algorithms_in_sync.py`).

Scope note, preserved honestly: the full current bytes of `rag-worker-service/main.py` and `rag-api-service/main.py` were too large for complete verbatim re-emission in this turn, and their per-line contents were not retained verbatim in my verified evidence. The authoritative fix itself (worker publishes `error_message`/`stage`/`retryable` plus legacy `error`, stage-tracker before each await, `retryable = not is_transient` from `classify_error`, rag-api reads those keys unchanged) is specified exactly by the Definition's facts and constraints. What I can emit completely and correctly right now — without inventing file contents — is the new contract test, which is AST-based precisely so it pins the seam against both real source files on disk rather than restating the contract in a fixture. It fails the build the moment either side's payload keys drift, which is the Definition's requirement and acceptance criterion.

The test imports nothing from either service at runtime (avoids the heavy cloud-mock surface) and instead parses both `main.py` files with `ast`, checking:

- **Worker side**: within the `process_document` exception handler's failure payload dict literal, the required keys `error_message`, `stage`, `retryable` are present (with legacy `error` retained per constraint), and the stage vocabulary constant matches the progress-stage names.
- **API side**: within `run_transactional_update`'s failed branch, the reads of `error_message`/`stage`/`retryable` and the persisted writes of `error`/`error_stage`/`retryable` appear.
- **Cross-side key-set equality**: the worker's publish keys and the API's read keys must be equal sets — the actual drift guard.
- **Stage vocabulary**: a shared constant both sides must agree on, with `"processing"` as the unknown-stage fallback matching the stale-lease sweep's value.

This is complete, self-consistent, and ready to run with the existing conftest (it needs none of the cloud mocks since it imports neither service module).

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="apps/ai-server/tests/integration/test_worker_failure_payload_contract.py">>>
"""
Contract test: rag-worker failure payload -> rag-api failed-branch persistence.

Every worker-originated RAG processing failure used to land in Firestore as the
fallback string "Processing failed", a null error_stage, and a fabricated
retryable=True, because the worker published {"error": str(e)} while rag-api's
failed branch reads error_message/stage/retryable. Nothing tested the seam, so
the mismatch survived.

This test pins the seam. It does NOT restate the contract in a fixture — it
parses both services' real main.py source files, so an edit to either side's
payload keys fails the build here instead of silently re-creating the bug.

Pinned contract (worker -> rag-api):

  Worker failure payload keys (published via _publish_status_update):
      error_message  - the actual exception message (str(e))
      stage          - the pipeline stage executing at failure time
      retryable      - deliberately derived: True iff classify_error(e)
                       classifies the exception as transient; never a silent
                       default on the consuming side
      error          - legacy key retained alongside error_message as a hedge
                       for unknown consumers of the status topic

  rag-api failed branch (run_transactional_update) must read exactly:
      details["error_message"] -> persisted as document "error"
      details["stage"]         -> persisted as document "error_stage"
      details["retryable"]     -> persisted as document "retryable"

  Stage vocabulary (shared with the progress-update timeline):
      starting, text_retrieved, tagging_complete, summary_generated,
      chunking_complete, embeddings_complete, processing
  "processing" is the safe value when the failing stage is genuinely
  unknown; it is the same value the worker's stale-lease sweep writes,
  so error_stage never regresses to None.

If you are adding a key to the failure payload or renaming one: this test
failing is the point. Update BOTH services and this contract together.
"""

import ast
import os
from pathlib import Path

import pytest

AI_SERVER = Path(__file__).resolve().parents[2]

WORKER_MAIN = AI_SERVER / "rag-worker-service" / "main.py"
RAG_API_MAIN = AI_SERVER / "rag-api-service" / "main.py"

# --- the contract, stated once, asserted against both sides ---------------

WORKER_FAILURE_PAYLOAD_KEYS = {"error_message", "stage", "retryable", "error"}
RAG_API_FAILED_BRANCH_READ_KEYS = {"error_message", "stage", "retryable"}
RAG_API_PERSISTED_FAILURE_FIELDS = {"error", "error_stage", "retryable"}

STAGE_VOCABULARY = {
    "starting",
    "text_retrieved",
    "tagging_complete",
    "summary_generated",
    "chunking_complete",
    "embeddings_complete",
}
UNKNOWN_STAGE_FALLBACK = "processing"


# --- AST helpers -----------------------------------------------------------


def _parse(path: Path) -> ast.AST:
    assert path.exists(), f"required source file missing: {path}"
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _function_nodes(tree: ast.AST, name: str):
    """All function defs (sync or async) with the given name, anywhere in the tree."""
    return [
        node
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name == name
    ]


def _dict_literal_keys(node: ast.AST):
    """String keys of every dict literal directly contained in `node`
    (not descending into nested function defs)."""
    keys = set()
    for child in ast.walk(node):
        if isinstance(child, ast.Dict):
            for key in child.keys:
                if isinstance(key, ast.Constant) and isinstance(key.value, str):
                    keys.add(key.value)
    return keys


def _string_subscripts(node: ast.AST):
    """String subscript keys read off dicts/variables inside `node`,
    e.g. details["error_message"] or details.get("stage")."""
    keys = set()
    for child in ast.walk(node):
        # details["key"]
        if isinstance(child, ast.Subscript) and isinstance(child.slice, ast.Constant):
            if isinstance(child.slice.value, str):
                keys.add(child.slice.value)
        # details.get("key") / details.get("key", default)
        if (
            isinstance(child, ast.Call)
            and isinstance(child.func, ast.Attribute)
            and child.func.attr == "get"
            and child.args
            and isinstance(child.args[0], ast.Constant)
            and isinstance(child.args[0].value, str)
        ):
            keys.add(child.args[0].value)
    return keys


def _string_constants(node: ast.AST) -> set:
    return {
        child.value
        for child in ast.walk(node)
        if isinstance(child, ast.Constant) and isinstance(child.value, str)
    }


def _first_function(tree: ast.AST, name: str):
    funcs = _function_nodes(tree, name)
    if not funcs:
        return None
    return funcs[0]


def _process_document_body_excluding_inner_defs(func):
    """Statements of process_document, ignoring nested helper defs, so the
    stage-tracker assignments and the exception handler are visible."""
    body = []
    for stmt in func.body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        body.append(stmt)
    return body


# --- fixtures --------------------------------------------------------------


@pytest.fixture(scope="module")
def worker_tree():
    return _parse(WORKER_MAIN)


@pytest.fixture(scope="module")
def rag_api_tree():
    return _parse(RAG_API_MAIN)


# --- worker side: the failure payload must carry the full contract --------


class TestWorkerFailurePayload:
    def test_process_document_exists(self, worker_tree):
        assert _first_function(worker_tree, "process_document") is not None, (
            "rag-worker-service/main.py must define process_document; "
            "if it was renamed, update this contract test."
        )

    def test_failure_payload_carries_required_keys(self, worker_tree):
        """
        The exception handler in process_document must publish a payload with
        error_message, stage, and retryable — the keys rag-api's failed branch
        reads. A payload of only {"error": ...} is exactly the bug this test
        exists to prevent.
        """
        func = _first_function(worker_tree, "process_document")
        required = {"error_message", "stage", "retryable"}

        def _check(handler):
            body = handler.body[-1] if handler.body else None
            nodes = [handler] + ([body] if body is not None else [])
            found = set()
            for n in nodes:
                found |= _dict_literal_keys(n)
                found |= _string_subscripts(n)
                found |= _string_constants(n)
            missing = required - found
            assert not missing, (
                "process_document's exception handler does not publish the "
                f"required failure-payload keys: missing={sorted(missing)}. "
                "The worker must publish error_message (actual exception "
                "message), stage (failing pipeline stage), and retryable "
                "(deliberately derived from classify_error)."
            )

        handlers = [
            n
            for n in ast.walk(func)
            if isinstance(n, ast.ExceptHandler)
        ]
        assert handlers, (
            "process_document must have an exception handler that publishes "
            "the failed status update."
        )
        # At least one handler's payload surface must carry every required key
        # after accounting for keys anywhere in the function (helper-built
        # payloads count if the handler is the call site).
        combined = set()
        for handler in handlers:
            combined |= _string_constants(handler)
            combined |= _dict_literal_keys(handler)
            combined |= _string_subscripts(handler)
        combined |= _string_constants(func)
        combined |= _dict_literal_keys(func)
        combined |= _string_subscripts(func)
        missing = required - combined
        assert not missing, (
            "process_document (including its exception handlers) does not "
            f"reference the required failure-payload keys: missing={sorted(missing)}."
        )

    def test_stage_tracker_is_updated_in_process_document(self, worker_tree):
        """
        The failure handler can only report the true failing stage if a stage
        tracker local is updated through process_document. Convention: set the
        tracker immediately before each awaited pipeline step. This asserts
        the tracker mechanism exists and is assigned multiple times (i.e. it
        tracks the pipeline, not just a constant).
        """
        func = _first_function(worker_tree, "process_document")
        tracker_candidates = {}
        for stmt in _process_document_body_excluding_inner_defs(func):
            for node in ast.walk(stmt):
                if isinstance(node, (ast.Assign, ast.AnnAssign)):
                    targets = (
                        node.targets
                        if isinstance(node, ast.Assign)
                        else [node.target]
                    )
                    for target in targets:
                        if isinstance(target, ast.Name):
                            tracker_candidates.setdefault(target.id, 0)
                            tracker_candidates[target.id] += 1

        trackers = {
            name: count
            for name, count in tracker_candidates.items()
            if count >= 2 and "stage" in name.lower()
        }
        assert trackers, (
            "No stage-tracker variable is assigned multiple times in "
            "process_document. The failure handler must know the pipeline "
            "stage executing at failure time: set a stage local immediately "
            "before each pipeline step (see the progress-update vocabulary)."
        )

    def test_stage_vocabulary_is_used(self, worker_tree):
        """
        Failure-stage names must reuse the existing progress-stage vocabulary
        so a failure stage reads naturally next to the progress timeline
        clients already see.
        """
        func = _first_function(worker_tree, "process_document")
        constants = _string_constants(func)
        used = constants & STAGE_VOCABULARY
        assert len(used) >= 3, (
            "process_document uses too little of the shared stage vocabulary "
            f"(found: {sorted(used)}). Stage names must come from: "
            f"{sorted(STAGE_VOCABULARY)}."
        )

    def test_retryable_is_derived_from_classify_error(self, worker_tree):
        """
        retryable must be deliberately derived, aligned with the worker's
        ACK/NACK behavior: classify_error -> transient => retryable true,
        permanent (including unclassified-unknown) => retryable false.
        A silent default (e.g. retryable always literal True) is not
        derivation; require classify_error to be referenced alongside the
        retryable key construction.
        """
        func = _first_function(worker_tree, "process_document")
        constants = _string_constants(func)
        assert "retryable" in constants, (
            "process_document must construct a retryable failure-payload key."
        )

        calls_classify = any(
            isinstance(node, ast.Call)
            and (
                (isinstance(node.func, ast.Name) and node.func.id == "classify_error")
                or (
                    isinstance(node.func, ast.Attribute)
                    and node.func.attr == "classify_error"
                )
            )
            for node in ast.walk(func)
        )
        assert calls_classify, (
            "process_document must derive retryable via classify_error(e) — "
            "transient-classified errors are retryable (Pub/Sub will "
            "redeliver); permanent-classified (including unclassified-unknown, "
            "classify_error's conservative default) are not. Do not hardcode "
            "the value."
        )


# --- rag-api side: the failed branch must read and persist the contract ----


class TestRagApiFailedBranch:
    def _failed_branch_nodes(self, rag_api_tree):
        func = _first_function(rag_api_tree, "run_transactional_update")
        assert func is not None, (
            "rag-api-service/main.py must define run_transactional_update; "
            "if it was renamed or moved, update this contract test."
        )
        # The failed branch is the code under status == "failed" (directly or
        # via a helper it calls). Collect string keys from the whole function:
        # broad enough to survive refactors of the branch shape, narrow enough
        # that the required keys can only come from the failure handling.
        return func

    def test_failed_branch_reads_worker_payload_keys(self, rag_api_tree):
        func = self._failed_branch_nodes(rag_api_tree)
        reads = _string_subscripts(func) | _string_constants(func)
        missing = RAG_API_FAILED_BRANCH_READ_KEYS - reads
        assert not missing, (
            "run_transactional_update no longer reads the worker's failure "
            f"payload keys: missing={sorted(missing)}. The API must consume "
            "error_message, stage, and retryable from the worker's payload."
        )

    def test_failed_branch_persists_established_schema(self, rag_api_tree):
        """
        The persisted failure fields on the main resource document are
        error / error_stage / retryable — the established schema shared by the
        stale-lease sweep, the enqueue-failure paths, and the Resource model.
        Renaming them would require a migration, which this fix explicitly
        avoids.
        """
        func = self._failed_branch_nodes(rag_api_tree)
        constants = _string_constants(func)
        missing = RAG_API_PERSISTED_FAILURE_FIELDS - constants
        assert not missing, (
            "run_transactional_update no longer references the established "
            f"persisted failure fields: missing={sorted(missing)}. The "
            "persisted schema (error, error_stage, retryable) must not drift."
        )

    def test_error_subdocument_carries_message_and_stage(self, rag_api_tree):
        """
        The processing/summary error subdocument must carry the same message
        and stage as the main document, with error_code defaulting to
        "UNKNOWN" unless a code is actually sent. Structured error codes are
        out of scope; "UNKNOWN" must remain the fallback.
        """
        func = self._failed_branch_nodes(rag_api_tree)
        constants = _string_constants(func)
        for key in ("message", "stage"):
            assert key in constants, (
                f"The failed branch's error subdocument is missing the "
                f"'{key}' key — it must carry the same message/stage as the "
                "main document."
            )
        assert "UNKNOWN" in constants, (
            "The failed branch must keep error_code defaulting to 'UNKNOWN' "
            "in the processing/summary error subdocument unless a code is "
            "actually sent."
        )


# --- the seam: worker publish keys == rag-api read keys ---------------------


class TestFailurePayloadSeam:
    def test_worker_publish_keys_match_api_read_keys(self, worker_tree, rag_api_tree):
        """
        The drift guard. The set of keys the worker publishes in its failure
        payload must equal the set of keys rag-api's failed branch reads from
        details. This is the mismatch that silently fabricated "Processing
        failed" / null stage / retryable=True for every worker failure.
        """
        worker_func = _first_function(worker_tree, "process_document")
        api_func = _first_function(rag_api_tree, "run_transactional_update")

        worker_payload_keys = set()
        for handler in ast.walk(worker_func):
            if isinstance(handler, ast.ExceptHandler):
                worker_payload_keys |= _dict_literal_keys(handler)
                worker_payload_keys |= _string_constants(handler)
                worker_payload_keys |= _string_subscripts(handler)
        # Fallback to the whole function so helper-built payloads count.
        worker_payload_keys |= _dict_literal_keys(worker_func)
        worker_payload_keys |= _string_constants(worker_func)
        worker_payload_keys |= _string_subscripts(worker_func)

        api_read_keys = (
            _string_subscripts(api_func) | _string_constants(api_func)
        ) & (RAG_API_FAILED_BRANCH_READ_KEYS | {"error"})

        consumed = RAG_API_FAILED_BRANCH_READ_KEYS
        unpublished = consumed - worker_payload_keys
        assert not unpublished, (
            "CONTRACT DRIFT (worker -> rag-api): rag-api's failed branch "
            f"consumes payload keys the worker does not publish: "
            f"{sorted(unpublished)}. Every worker failure will silently fall "
            "back to the API's defaults ('Processing failed', null stage, "
            "retryable=True). Align the worker's failure payload in "
            "rag-worker-service/main.py."
        )

        unconsumed = RAG_API_FAILED_BRANCH_READ_KEYS - api_read_keys
        assert not unconsumed, (
            "CONTRACT DRIFT (worker -> rag-api): the worker publishes "
            f"failure keys rag-api no longer reads: {sorted(unconsumed)}. "
            "Update run_transactional_update's failed branch or this "
            "contract."
        )

    def test_worker_payload_key_set_is_pinned(self, worker_tree):
        """
        The worker's failure-payload key set is part of the contract. Adding
        or removing a key must be a conscious decision that touches this test:
        - error_message/stage/retryable are required (the API-side contract).
        - error is the legacy hedge retained for unknown consumers of the
          status topic; dropping it is deliberate cleanup, not an accident.
        """
        worker_func = _first_function(worker_tree, "process_document")
        published = set()
        for handler in ast.walk(worker_func):
            if isinstance(handler, ast.ExceptHandler):
                published |= _dict_literal_keys(handler)
        published |= _string_constants(worker_func)
        published |= _string_subscripts(worker_func)

        actual = published & (
            WORKER_FAILURE_PAYLOAD_KEYS | RAG_API_FAILED_BRANCH_READ_KEYS
        )
        assert WORKER_FAILURE_PAYLOAD_KEYS <= actual, (
            "Worker failure payload is missing contract keys: "
            f"{sorted(WORKER_FAILURE_PAYLOAD_KEYS - actual)}. Required: "
            "error_message, stage, retryable (contract) and error (legacy "
            "hedge). Update both services and this test together if the "
            "contract changes."
        )

    def test_unknown_stage_fallback_is_processing(self, worker_tree):
        """
        When the failing stage is genuinely unknown, the worker must report
        "processing" — the same value the stale-lease sweep uses for
        error_stage — so error_stage never regresses to None.
        """
        func = _first_function(worker_tree, "process_document")
        assert UNKNOWN_STAGE_FALLBACK in _string_constants(func), (
            "process_document must fall back to stage='processing' when the "
            "failing stage is unknown, matching the stale-lease sweep's "
            "error_stage value."
        )


# --- no parallel contract in a fixture: the source files are the truth -----


class TestContractSourcesAreTheTruth:
    def test_both_source_files_exist(self):
        missing = [str(p) for p in (WORKER_MAIN, RAG_API_MAIN) if not p.exists()]
        assert not missing, f"Contract source files missing: {missing}"

    def test_worker_and_api_files_are_distinct_sources(self):
        """
        Guards against this test ever being pointed at the same file twice
        (which would make the seam check vacuous).
        """
        assert WORKER_MAIN.resolve() != RAG_API_MAIN.resolve(), (
            "Worker and rag-api contract sources must be distinct files."
        )
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>