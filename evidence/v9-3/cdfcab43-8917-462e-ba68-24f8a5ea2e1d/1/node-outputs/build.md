<<<SLE-OUTPUT>>>
<<<SLE-PATCH path="apps/ai-server/rag-worker-service/main.py" base="7d7718bcbeb2e219dab14e285a66e62ea5883c209981a0be91cc29b490569988">>>
--- a/apps/ai-server/rag-worker-service/main.py
+++ b/apps/ai-server/rag-worker-service/main.py
@@ -87,6 +87,9 @@
     # For unknown exceptions, be conservative and treat as permanent
     # to avoid infinite retry loops
     return False
 
+from failure_payload import build_failure_details
+
 # Document processing
 from langchain.text_splitter import RecursiveCharacterTextSplitter
 from langchain.schema import Document
@@ -1015,6 +1018,7 @@
             chunks = await self._create_enhanced_chunks(text_content, doc_metadata, tags, user_id, course_id, resource_id)
             metrics.chunks_created = len(chunks)
             metrics.tokens_used = sum(c.token_count for c in chunks)
             metrics.cost_estimate = metrics.tokens_used * self.embedding_cost_per_token
+            self._current_stage = "chunking_complete"
             await self._publish_status_update(user_id, course_id, resource_id, "processing", {"stage": "chunking_complete", "progress": 60}, job_id)
 
             # Step 5: Generate Embeddings
@@ -1020,6 +1024,7 @@
             vectors = await self._generate_embeddings_with_openrouter(chunks)
             metrics.embeddings_generated = len(vectors)
+            self._current_stage = "embeddings_complete"
             await self._publish_status_update(user_id, course_id, resource_id, "processing", {"stage": "embeddings_complete", "progress": 80}, job_id)
 
             # Step 6a: Delete old vectors AFTER successful processing but BEFORE storing new ones
@@ -1093,8 +1098,14 @@
         except Exception as e:
             metrics.error_message, metrics.end_time = str(e), time.time()
-            self.logger.error("document_processing_failed", user_id=user_id, course_id=course_id, resource_id=resource_id, error=str(e))
-            await self._publish_status_update(user_id, course_id, resource_id, "failed", {"error": str(e)}, job_id)
+            failure_stage = getattr(self, "_current_stage", None) or "processing"
+            retryable = classify_error(e)
+            self.logger.error("document_processing_failed", user_id=user_id, course_id=course_id, resource_id=resource_id, error=str(e), stage=failure_stage, retryable=retryable)
+            await self._publish_status_update(
+                user_id, course_id, resource_id, "failed",
+                build_failure_details(str(e), failure_stage, retryable),
+                job_id,
+            )
             if trace: trace.update(output={"success": False, "error": str(e)})
             return metrics
<<<END-SLE-PATCH>>>
<<<SLE-ARTIFACT path="apps/ai-server/rag-worker-service/failure_payload.py">>>
"""Failure payload contract shared by rag-worker (publisher) and rag-api (consumer).

rag-api's failed branch in run_transactional_update reads the status payload
keys ``error_message``, ``stage`` and ``retryable`` and persists them as
``error``, ``error_stage`` and ``retryable`` on the resource document, plus
``message``/``stage`` in the ``processing/summary`` error subdocument.

The worker must publish exactly these keys — never relying on rag-api's
fallback defaults ("Processing failed", stage None, retryable True). The
legacy ``error`` key is retained alongside ``error_message`` as a hedge for
any unknown consumer of the status topic.
"""

# Safe value used when the failing pipeline stage is genuinely unknown.
# Matches the stale-lease sweep's error_stage value so the field never
# regresses to null.
STAGE_UNKNOWN = "processing"


def build_failure_details(error_message, stage, retryable):
    """Build the worker's failed-status details payload.

    error_message: the actual exception message (str(e)).
    stage: the pipeline stage executing at failure time, or None if unknown
        (in which case STAGE_UNKNOWN is used).
    retryable: deliberately derived by the caller (transient-classified
        errors -> True, permanent-classified -> False). Never silently
        defaulted here or downstream.
    """
    resolved_stage = stage or STAGE_UNKNOWN
    return {
        "error_message": error_message,
        "stage": resolved_stage,
        "retryable": bool(retryable),
        # Legacy key retained for continuity with any existing consumers of
        # the status topic and log tooling.
        "error": error_message,
    }
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="apps/ai-server/tests/integration/test_worker_failure_contract.py">>>
"""Contract test: rag-worker failure payload -> rag-api failed-branch persistence.

Pins the seam between the worker's failed-status publisher and rag-api's
run_transactional_update failed branch:
  - the worker publishes error_message / stage / retryable (plus the legacy
    `error` key) and never relies on rag-api's fallback defaults;
  - rag-api persists error <- error_message, error_stage <- stage,
    retryable <- retryable on the main document, and carries the same
    message and stage into the processing/summary error subdocument.

Key-set drift on either side fails these tests instead of silently
re-creating the "Processing failed"/null-stage/silent-retryable bug.
"""

import ast
import inspect
import logging
import os
import sys

import pytest

RAG_API_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "rag-api-service")
)
RAG_WORKER_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "rag-worker-service")
)
# Append (not insert at 0): conftest already put rag-api-service first so
# `import main` resolves to rag-api's main, not the worker's.
for _p in (RAG_API_DIR, RAG_WORKER_DIR):
    if _p not in sys.path:
        sys.path.append(_p)

import main as rag_api_main  # noqa: E402  (cloud deps mocked in conftest)
from failure_payload import build_failure_details  # noqa: E402

WORKER_MAIN_PATH = os.path.join(RAG_WORKER_DIR, "main.py")
RAG_API_MAIN_PATH = os.path.join(RAG_API_DIR, "main.py")


# ---------------------------------------------------------------------------
# Minimal Firestore fakes: just enough for run_transactional_update's
# failed branch to execute synchronously.
# ---------------------------------------------------------------------------

class FakeSnapshot:
    exists = True

    def __init__(self, data):
        self._data = data

    def to_dict(self):
        return self._data


class FakeSummaryRef:
    def __init__(self):
        self.id = "summary"


class FakeDocRef:
    def __init__(self, data):
        self.id = "resource-1"
        self._snapshot = FakeSnapshot(data)
        self._summary_ref = FakeSummaryRef()

    def get(self, transaction=None):
        return self._snapshot

    def collection(self, name):
        assert name == "processing"
        return self

    def document(self, doc_id):
        assert doc_id == "summary"
        return self._summary_ref


class FakeTransaction:
    def __init__(self):
        self.updates = []
        self.sets = []

    def update(self, ref, data):
        self.updates.append((ref, data))

    def set(self, ref, data, merge=False):
        self.sets.append((ref, data, merge))


class FakeDB:
    def transaction(self):
        return FakeTransaction()


@pytest.fixture
def run_failed_update():
    """Run rag-api's failed branch against fakes; return (main_update, summary_update)."""
    original_transactional = rag_api_main.firestore.transactional
    rag_api_main.firestore.transactional = lambda fn: fn
    try:
        doc_ref = FakeDocRef({"status": "processing"})
        db = FakeDB()
        def _run(details):
            rag_api_main.run_transactional_update(
                db, doc_ref, "failed", details,
                logging.getLogger("test_worker_failure_contract"), "user-1",
            )
            tx = db.transaction()
            main_updates = [data for ref, data in tx.updates if ref is doc_ref]
            assert len(main_updates) == 1, "expected exactly one main-document update"
            summary_sets = [data for ref, data, merge in tx.sets if ref is doc_ref._summary_ref and merge]
            assert len(summary_sets) == 1, "expected exactly one summary merge-set"
            return main_updates[0], summary_sets[0]
        yield _run
    finally:
        rag_api_main.firestore.transactional = original_transactional


# ---------------------------------------------------------------------------
# The contract itself
# ---------------------------------------------------------------------------

class TestWorkerFailurePayloadThroughRagApi:
    def test_permanent_failure_persists_worker_values(self, run_failed_update):
        message = "Embedding request failed after 3 attempts"
        details = build_failure_details(message, "embeddings_complete", False)
        main_update, summary_update = run_failed_update(details)

        assert main_update["status"] == "failed"
        assert main_update["error"] == message, "must persist the worker's actual error message, not 'Processing failed'"
        assert main_update["error_stage"] == "embeddings_complete", "must persist the failing stage, not None"
        assert main_update["retryable"] is False, "must persist the worker-derived retryable, not a silent default"

        error_subdoc = summary_update["error"]
        assert error_subdoc["message"] == message
        assert error_subdoc["stage"] == "embeddings_complete"
        assert error_subdoc["code"] == "UNKNOWN", "no error-code taxonomy in this fix"

    def test_transient_failure_persists_retryable_true(self, run_failed_update):
        message = "rate limited by upstream provider"
        details = build_failure_details(message, "text_retrieved", True)
        main_update, summary_update = run_failed_update(details)

        assert main_update["error"] == message
        assert main_update["error_stage"] == "text_retrieved"
        assert main_update["retryable"] is True
        assert summary_update["error"]["message"] == message
        assert summary_update["error"]["stage"] == "text_retrieved"

    def test_unknown_stage_falls_back_to_processing(self):
        payload = build_failure_details("boom", None, True)
        assert payload["stage"] == "processing"


class TestPayloadKeyDriftGuards:
    def test_worker_payload_key_set_is_pinned(self):
        source = inspect.getsource(build_failure_details)
        tree = ast.parse(source)
        returned_keys = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Return) and isinstance(node.value, ast.Dict):
                returned_keys = {
                    k.value for k in node.value.keys if isinstance(k, ast.Constant)
                }
        assert returned_keys == {"error_message", "stage", "retryable", "error"}, (
            "Worker failure payload keys drifted; update this contract test "
            "and rag-api's failed branch together."
        )
        assert "error_message" in returned_keys
        assert "stage" in returned_keys

    def test_rag_api_failed_branch_reads_worker_keys(self):
        with open(RAG_API_MAIN_PATH) as f:
            source = f.read()
        for key in ("error_message", "stage", "retryable"):
            assert f'details.get("{key}"' in source, (
                f"rag-api's failed branch no longer reads details key '{key}'; "
                "worker/api payload contract drifted."
            )

    def test_worker_failure_publisher_uses_contract_builder(self):
        with open(WORKER_MAIN_PATH) as f:
            source = f.read()
        assert "build_failure_details(str(e), failure_stage, retryable)" in source, (
            "Worker's failed-status publish no longer goes through "
            "build_failure_details; payload contract may have drifted."
        )
        assert '"failed", {"error": str(e)}' not in source, (
            "Worker regressed to the bare {'error': str(e)} payload that "
            "rag-api's fallback defaults silently paper over."
        )
        assert "classify_error(e)" in source, (
            "retryable must be deliberately derived from classify_error, "
            "not defaulted."
        )
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>