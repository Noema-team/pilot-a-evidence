<<<SLE-OUTPUT>>>
<<<SLE-PATCH path="apps/ai-server/rag-worker-service/main.py" base="7d7718bcbeb2e219dab14e285a66e62ea5883c209981a0be91cc29b490569988">>>
--- a/apps/ai-server/rag-worker-service/main.py
+++ b/apps/ai-server/rag-worker-service/main.py
@@ -974,6 +974,9 @@
     async def process_document(self, user_id: str, course_id: str, resource_id: str, job_id: Optional[str] = None) -> ProcessingMetrics:
         """Enhanced main processing pipeline for subcollection structure"""
         metrics = ProcessingMetrics(start_time=time.time())
+        # Track the pipeline stage currently executing so the failure handler
+        # below can report the true failing stage in the failed status payload.
+        current_stage = "processing"
         trace = self.langfuse.trace(name="doc_processing_course_resources",
                                 input={"user_id": user_id, "course_id": course_id, "resource_id": resource_id, "job_id": job_id}) if self.langfuse else None
         
@@ -984,6 +987,7 @@
             # Step 1: Get pre-extracted text (replaces file download and extraction)
+            current_stage = "text_retrieved"
             text_content, doc_metadata = await self._get_extracted_text(user_id, course_id, resource_id)
             metrics.text_length = len(text_content)
             await self._publish_status_update(user_id, course_id, resource_id, "processing", {"stage": "text_retrieved", "progress": 20}, job_id)
@@ -989,6 +993,7 @@
             # Step 2: Content Tagging and Analysis
+            current_stage = "tagging_complete"
             tags, confidence_scores = await self.content_tagger.generate_tags(text_content, doc_metadata)
             metrics.tags, metrics.confidence_scores = tags, confidence_scores
             await self._publish_status_update(user_id, course_id, resource_id, "processing", {"stage": "tagging_complete", "progress": 40}, job_id)
@@ -994,6 +999,7 @@
             # Step 3: Generate Summary
+            current_stage = "summary_generated"
             summary_data = await self.generate_document_summary(text_content, doc_metadata.get('title', 'Untitled Document'))
 
             update_data = {}
@@ -1004,6 +1010,7 @@
             # Step 4: Chunking
+            current_stage = "chunking_complete"
             chunks = await self._create_enhanced_chunks(text_content, doc_metadata, tags, user_id, course_id, resource_id)
             metrics.chunks_created = len(chunks)
             metrics.tokens_used = sum(c.token_count for c in chunks)
@@ -1010,6 +1017,7 @@
             # Step 5: Generate Embeddings
+            current_stage = "embeddings_complete"
             vectors = await self._generate_embeddings_with_openrouter(chunks)
             metrics.embeddings_generated = len(vectors)
             await self._publish_status_update(user_id, course_id, resource_id, "processing", {"stage": "embeddings_complete", "progress": 80}, job_id)
@@ -1103,8 +1111,17 @@
         except Exception as e:
             metrics.error_message, metrics.end_time = str(e), time.time()
+            # Derive retryable from the same classification that drives the
+            # ACK/NACK decision in run_worker: transient → Pub/Sub will
+            # redeliver (retryable true); permanent (including
+            # unclassified-unknown, per classify_error's conservative
+            # default) → acked, manual reprocess via POST /process.
+            retryable = classify_error(e)
             self.logger.error("document_processing_failed", user_id=user_id, course_id=course_id, resource_id=resource_id, error=str(e))
-            await self._publish_status_update(user_id, course_id, resource_id, "failed", {"error": str(e)}, job_id)
+            failure_details = {
+                "error": str(e),
+                "error_message": str(e),
+                "stage": current_stage,
+                "retryable": retryable,
+            }
+            await self._publish_status_update(user_id, course_id, resource_id, "failed", failure_details, job_id)
             if trace: trace.update(output={"success": False, "error": str(e)})
             return metrics
<<<END-SLE-PATCH>>>
<<<SLE-ARTIFACT path="apps/ai-server/tests/integration/test_worker_failure_payload_contract.py">>>
"""
Contract test: rag-worker failure payload → rag-api failed-branch persistence.

The worker publishes failed status with details carrying error_message, stage,
and retryable (plus the legacy `error` key); rag-api's run_transactional_update
failed branch reads exactly those keys and persists error / error_stage /
retryable on the main resource document and message/stage on the
processing/summary error subdocument.

These tests pin both sides of the seam:
  - AST drift guards on the worker's failure-payload construction (keys, the
    classify_error-derived retryable, stage-tracker coverage) and on rag-api's
    failed-branch reads, so a key rename on either side fails the build.
  - A functional test that feeds a worker-shaped failure payload through
    run_transactional_update against fakes and asserts the persisted values.
"""

import ast
import os

import main as rag_api_main

WORKER_MAIN_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "rag-worker-service", "main.py")
)
RAG_API_MAIN_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "rag-api-service", "main.py")
)

WORKER_FAILURE_KEYS = {"error", "error_message", "stage", "retryable"}
API_FAILURE_READ_KEYS = {"error_message", "stage", "retryable"}

# Stage vocabulary shared with the worker's progress status updates, plus the
# safe fallback "processing" used when the stage is genuinely unknown.
STAGE_VOCABULARY = {
    "starting",
    "text_retrieved",
    "tagging_complete",
    "summary_generated",
    "chunking_complete",
    "embeddings_complete",
    "completed",
    "processing",
}


def _worker_source():
    with open(WORKER_MAIN_PATH) as f:
        return f.read()


def _worker_tree():
    return ast.parse(_worker_source())


def _worker_failure_details_node(tree):
    """Locate the failure-payload dict literal in the worker's source."""
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            keys = {
                k.value
                for k in node.keys
                if isinstance(k, ast.Constant) and isinstance(k.value, str)
            }
            if "error_message" in keys:
                return node, keys
    raise AssertionError(
        "Worker failure payload dict (with error_message key) not found — "
        "the failure-payload contract has drifted on the worker side."
    )


def _process_document_function(tree):
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.name == "process_document":
                return node
    raise AssertionError("process_document not found in worker main.py")


def _rag_api_source():
    with open(RAG_API_MAIN_PATH) as f:
        return f.read()


# ---------------------------------------------------------------------------
# Worker-side drift guards
# ---------------------------------------------------------------------------


class TestWorkerFailurePayloadContract:
    def test_failure_payload_carries_required_keys(self):
        tree = _worker_tree()
        _, keys = _worker_failure_details_node(tree)
        missing = WORKER_FAILURE_KEYS - keys
        assert not missing, (
            f"Worker failure payload is missing keys: {missing}. "
            "rag-api's failed branch reads error_message/stage/retryable."
        )

    def test_failure_payload_retryable_is_derived_from_classify_error(self):
        tree = _worker_tree()
        node, _ = _worker_failure_details_node(tree)
        retryable_value = None
        for key, value in zip(node.keys, node.values):
            if isinstance(key, ast.Constant) and key.value == "retryable":
                retryable_value = value
        assert retryable_value is not None, "retryable key missing from failure payload"
        assert isinstance(retryable_value, ast.Name) and retryable_value.id == "retryable", (
            "retryable must be a variable assigned from classify_error(e), not a "
            "literal default — the payload must carry a deliberately derived value."
        )
        src = _worker_source()
        assert "classify_error(e)" in src, (
            "Worker must derive retryable via classify_error(e) so the persisted "
            "record matches the ACK/NACK behavior."
        )

    def test_stage_tracker_covers_representative_stages(self):
        tree = _worker_tree()
        func = _process_document_function(tree)
        assigned_stages = set()
        for node in ast.walk(func):
            if isinstance(node, ast.Assign):
                targets = [t.id for t in node.targets if isinstance(t, ast.Name)]
                if "current_stage" in targets and isinstance(node.value, ast.Constant):
                    assigned_stages.add(node.value.value)
        assert "text_retrieved" in assigned_stages, (
            "Stage tracker must be set before the text-retrieval step (early-stage failures)"
        )
        assert "embeddings_complete" in assigned_stages, (
            "Stage tracker must be set before the embeddings step (late-stage failures)"
        )
        unknown = assigned_stages - STAGE_VOCABULARY
        assert not unknown, f"Stage tracker uses names outside the shared vocabulary: {unknown}"

    def test_failure_payload_reports_tracked_stage(self):
        tree = _worker_tree()
        node, _ = _worker_failure_details_node(tree)
        stage_value = None
        for key, value in zip(node.keys, node.values):
            if isinstance(key, ast.Constant) and key.value == "stage":
                stage_value = value
        assert stage_value is not None, "stage key missing from failure payload"
        assert isinstance(stage_value, ast.Name) and stage_value.id == "current_stage", (
            "Failure payload stage must come from the stage tracker (current_stage), "
            "not a hardcoded value."
        )


# ---------------------------------------------------------------------------
# rag-api-side drift guards
# ---------------------------------------------------------------------------


class TestRagApiFailedBranchContract:
    def test_failed_branch_reads_worker_payload_keys(self):
        tree = ast.parse(_rag_api_source())
        found = set()
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "get"
                and node.args
                and isinstance(node.args[0], ast.Constant)
                and isinstance(node.args[0].value, str)
            ):
                found.add(node.args[0].value)
        missing = API_FAILURE_READ_KEYS - found
        assert not missing, (
            f"rag-api failed branch no longer reads details keys: {missing}. "
            "The worker→rag-api failure contract has drifted."
        )


# ---------------------------------------------------------------------------
# Functional persistence test (worker-shaped payload → rag-api failed branch)
# ---------------------------------------------------------------------------


class _FakeSnapshot:
    exists = True

    def __init__(self, data):
        self._data = data

    def to_dict(self):
        return self._data


class _FakeSummaryRef:
    def __init__(self):
        self.set_calls = []

    def set(self, data, merge=False):
        self.set_calls.append(data)


class _FakeSummaryCollection:
    def __init__(self, doc_ref):
        self._doc_ref = doc_ref

    def document(self, name):
        assert name == "summary"
        return self._doc_ref.summary


class _FakeDocRef:
    def __init__(self, data):
        self._data = data
        self.updates = []
        self.summary = _FakeSummaryRef()
        self.id = "res-contract-123"

    def get(self, transaction=None):
        return _FakeSnapshot(self._data)

    def update(self, data):
        self.updates.append(data)

    def collection(self, name):
        assert name == "processing"
        return _FakeSummaryCollection(self)


class _FakeDB:
    def transaction(self):
        return object()


class TestWorkerFailurePersistencePath:
    def test_worker_failure_payload_persists_through_rag_api(self, monkeypatch):
        monkeypatch.setattr(rag_api_main.firestore, "transactional", lambda f: f)
        doc_ref = _FakeDocRef({"status": "processing"})
        # Exactly the payload the worker's failure handler now publishes.
        details = {
            "error": "Embedding request failed after retries",
            "error_message": "Embedding request failed after retries",
            "stage": "embeddings_complete",
            "retryable": False,
        }
        rag_api_main.run_transactional_update(
            _FakeDB(), doc_ref, "failed", details, rag_api_main.logger, "user-1"
        )
        assert doc_ref.updates, "rag-api failed branch must update the main document"
        main_update = doc_ref.updates[-1]
        assert main_update["status"] == "failed"
        assert main_update["error"] == "Embedding request failed after retries", (
            "Persisted error must be the worker's actual message, not the "
            "'Processing failed' fallback"
        )
        assert main_update["error_stage"] == "embeddings_complete", (
            "Persisted error_stage must be the worker's failing stage, not None"
        )
        assert main_update["retryable"] is False, (
            "Persisted retryable must be the worker's derived value, not the "
            "silent default True"
        )
        assert doc_ref.summary.set_calls, "rag-api failed branch must write the summary subdocument"
        summary = doc_ref.summary.set_calls[-1]
        assert summary["error"]["message"] == details["error_message"]
        assert summary["error"]["stage"] == "embeddings_complete"
        assert summary["stage"] == "embeddings_complete"

    def test_transient_failure_payload_persists_retryable_true(self, monkeypatch):
        monkeypatch.setattr(rag_api_main.firestore, "transactional", lambda f: f)
        doc_ref = _FakeDocRef({"status": "processing"})
        details = {
            "error": "upstream timeout",
            "error_message": "upstream timeout",
            "stage": "text_retrieved",
            "retryable": True,
        }
        rag_api_main.run_transactional_update(
            _FakeDB(), doc_ref, "failed", details, rag_api_main.logger, "user-1"
        )
        main_update = doc_ref.updates[-1]
        assert main_update["error"] == "upstream timeout"
        assert main_update["error_stage"] == "text_retrieved"
        assert main_update["retryable"] is True
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>