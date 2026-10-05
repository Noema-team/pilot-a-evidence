All verified evidence is in hand. The worker's `process_document` except handler publishes `{"error": str(e)}` (confirmed), `classify_error` is module-level in the worker (confirmed), and the contract-test infrastructure is AST/fixture-based (confirmed). rag-api's failed branch is unchanged per the Definition (worker aligns to API), so no rag-api patch is emitted. I'm adding a dependency-free payload builder the failure handler and the contract test both use, stage tracking through the pipeline, and the contract test.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="apps/ai-server/rag-worker-service/utils/failure_payload.py">>>
"""
Failure payload construction for the rag-worker's failed status messages.

Contract (consumed by rag-api's run_transactional_update failed branch):
  error_message: the actual exception message (persisted as `error`)
  stage:         the pipeline stage executing at failure time (persisted as
                 `error_stage`)
  retryable:     deliberately derived from classify_error — transient -> True,
                 permanent/unknown -> False (persisted as `retryable`)
  error:         legacy key retained alongside error_message for continuity
                 with any unknown consumers of the status topic.

This module is intentionally dependency-free so contract tests can import it
in isolation without pulling in the worker's heavy service imports.
"""

from typing import Dict

# The exact key set of a worker failure payload. The contract test pins this.
FAILURE_PAYLOAD_KEYS = frozenset({"error_message", "stage", "retryable", "error"})

# Safe stage value when the failing stage is genuinely unknown. Matches the
# stale-lease sweep's error_stage fallback so the field never regresses to null.
UNKNOWN_STAGE = "processing"


def build_failure_payload(message: str, stage: str, retryable: bool) -> Dict[str, object]:
    """
    Build the failed status details payload for a failed processing job.

    The payload must never rely on rag-api's fallback defaults: every
    worker-originated failure carries error_message, stage, and retryable
    explicitly. The legacy `error` key is retained as a compatibility hedge
    for any unknown consumer of the status topic.
    """
    if not message:
        message = "Processing failed"
    if not stage:
        stage = UNKNOWN_STAGE
    return {
        "error_message": message,
        "stage": stage,
        "retryable": bool(retryable),
        # Legacy key retained for unknown consumers of the status topic.
        "error": message,
    }
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="apps/ai-server/tests/integration/test_worker_failure_contract.py">>>
"""
Contract test: rag-worker failure payload -> rag-api failed-branch persistence.

Pins the seam between the worker's failed status payload and rag-api's
failed-branch persistence:

  worker publishes: error_message / stage / retryable (+ legacy `error`)
  rag-api reads:    error_message / stage / retryable
  rag-api persists: error / error_stage / retryable

A drift in either side's keys fails this test instead of silently re-creating
the "Processing failed"/null-stage/silent-retryable bug.

The worker side is exercised functionally (the dependency-free
failure_payload module is imported directly); the rag-api side is pinned with
AST checks against its source, following the existing static contract-test
pattern in this directory.
"""
import ast
import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))
AI_SERVER_DIR = os.path.abspath(os.path.join(HERE, ".."))
WORKER_DIR = os.path.join(AI_SERVER_DIR, "rag-worker-service")
WORKER_MAIN = os.path.join(WORKER_DIR, "main.py")
FAILURE_PAYLOAD_MODULE = os.path.join(WORKER_DIR, "utils", "failure_payload.py")
RAG_API_MAIN = os.path.join(AI_SERVER_DIR, "rag-api-service", "main.py")

# Keys rag-api's failed branch reads from the worker's failure payload.
API_READ_KEYS = {"error_message", "stage", "retryable"}
# Legacy key the worker retains for unknown consumers of the status topic.
LEGACY_WORKER_KEYS = {"error"}
# Fields rag-api persists on the resource document.
API_PERSISTED_FIELDS = {"error", "error_stage", "retryable"}


def _load_failure_payload_module():
    spec = importlib.util.spec_from_file_location(
        "worker_failure_payload", FAILURE_PAYLOAD_MODULE
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _read(path):
    with open(path) as f:
        return f.read()


def _collect_get_keys(source):
    """First-argument string constants of any `<expr>.get(...)` call."""
    keys = set()
    for node in ast.walk(ast.parse(source)):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "get"
            and node.args
            and isinstance(node.args[0], ast.Constant)
            and isinstance(node.args[0].value, str)
        ):
            keys.add(node.args[0].value)
    return keys


def _collect_dict_keys(source):
    keys = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Dict):
            for k in node.keys:
                if isinstance(k, ast.Constant) and isinstance(k.value, str):
                    keys.add(k.value)
    return keys


def test_worker_failure_payload_contract_keys():
    mod = _load_failure_payload_module()
    payload = mod.build_failure_payload("boom", "chunking_complete", True)
    assert set(payload.keys()) == API_READ_KEYS | LEGACY_WORKER_KEYS
    assert payload["error_message"] == "boom"
    assert payload["stage"] == "chunking_complete"
    assert payload["retryable"] is True
    assert payload["error"] == "boom"  # legacy continuity key
    assert set(mod.FAILURE_PAYLOAD_KEYS) == API_READ_KEYS | LEGACY_WORKER_KEYS


def test_worker_failure_payload_fallbacks():
    mod = _load_failure_payload_module()
    payload = mod.build_failure_payload("", "", False)
    assert payload["error_message"] == "Processing failed"
    assert payload["stage"] == "processing"
    assert payload["retryable"] is False
    assert payload["error"] == "Processing failed"


def test_worker_payload_needs_no_api_fallbacks():
    """Round-trip through rag-api's documented read path: no fallback fires."""
    mod = _load_failure_payload_module()
    payload = mod.build_failure_payload("boom: bad chunk", "tagging_complete", False)
    # rag-api's failed branch reads (documented contract, F4):
    error = payload.get("error_message")
    stage = payload.get("stage")
    retryable = payload.get("retryable", True)  # API-side fallback must not be operative
    assert error == "boom: bad chunk" and error != "Processing failed"
    assert stage == "tagging_complete" and stage is not None
    assert "retryable" in payload and retryable is False


def test_worker_failure_handler_uses_contract_builder():
    src = _read(WORKER_MAIN)
    # The failure handler must build the payload via the shared builder and
    # derive retryable from classify_error — never a silent default.
    assert "from utils.failure_payload import build_failure_payload" in src
    assert "build_failure_payload(str(e), current_stage, retryable)" in src
    assert "retryable = classify_error(e)" in src
    # Stage tracker must exist and be initialised to the safe unknown value.
    assert 'current_stage = "processing"' in src


def test_rag_api_failed_branch_reads_worker_keys():
    src = _read(RAG_API_MAIN)
    get_keys = _collect_get_keys(src)
    missing = API_READ_KEYS - get_keys
    assert not missing, f"rag-api no longer reads worker failure keys: {sorted(missing)}"


def test_rag_api_persists_error_stage_retryable():
    src = _read(RAG_API_MAIN)
    dict_keys = _collect_dict_keys(src)
    missing = API_PERSISTED_FIELDS - dict_keys
    assert not missing, f"rag-api no longer persists failure fields: {sorted(missing)}"
<<<END-SLE-ARTIFACT>>>
<<<SLE-PATCH path="apps/ai-server/rag-worker-service/main.py" base="7d7718bcbeb2e219dab14e285a66e62ea5883c209981a0be91cc29b490569988">>>
--- a/apps/ai-server/rag-worker-service/main.py
+++ b/apps/ai-server/rag-worker-service/main.py
@@ -12,6 +12,7 @@
 import uuid
 import io
 import os
 import httpx
 import sys
+from utils.failure_payload import build_failure_payload
 
 
 # ========================================
@@ -975,12 +976,19 @@
     async def process_document(self, user_id: str, course_id: str, resource_id: str, job_id: Optional[str] = None) -> ProcessingMetrics:
         """Enhanced main processing pipeline for subcollection structure"""
         metrics = ProcessingMetrics(start_time=time.time())
+        # Tracks the pipeline stage executing at failure time so the failed
+        # status payload can report the true failing stage. Convention: set
+        # this immediately before the await of each pipeline step, reusing
+        # the progress-stage vocabulary. "processing" is the safe value when
+        # the stage is genuinely unknown (mirrors the stale-lease sweep).
+        current_stage = "processing"
         trace = self.langfuse.trace(name="doc_processing_course_resources",
                                 input={"user_id": user_id, "course_id": course_id, "resource_id": resource_id, "job_id": job_id}) if self.langfuse else None
         
         try:
             await self._validate_processing_request(user_id, course_id, resource_id)
+            current_stage = "starting"
             await self._publish_status_update(user_id, course_id, resource_id, "processing", {"stage": "starting"}, job_id)
             
             # Step 1: Get pre-extracted text (replaces file download and extraction)
+            current_stage = "text_retrieved"
             text_content, doc_metadata = await self._get_extracted_text(user_id, course_id, resource_id)
@@ -989,6 +997,7 @@
             
             # Step 2: Content Tagging and Analysis
+            current_stage = "tagging_complete"
             tags, confidence_scores = await self.content_tagger.generate_tags(text_content, doc_metadata)
             metrics.tags, metrics.confidence_scores = tags, confidence_scores
             await self._publish_status_update(user_id, course_id, resource_id, "processing", {"stage": "tagging_complete", "progress": 40}, job_id)
@@ -995,6 +1004,7 @@
             # Step 3: Generate Summary
+            current_stage = "summary_generated"
             summary_data = await self.generate_document_summary(text_content, doc_metadata.get('title', 'Untitled Document'))
             
             update_data = {}
@@ -1015,6 +1025,7 @@
             # Step 4: Chunking
+            current_stage = "chunking_complete"
             chunks = await self._create_enhanced_chunks(text_content, doc_metadata, tags, user_id, course_id, resource_id)
             metrics.chunks_created = len(chunks)
@@ -1022,6 +1033,7 @@
             # Step 5: Generate Embeddings
+            current_stage = "embeddings_complete"
             vectors = await self._generate_embeddings_with_openrouter(chunks)
             metrics.embeddings_generated = len(vectors)
@@ -1095,8 +1107,13 @@
         except Exception as e:
             metrics.error_message, metrics.end_time = str(e), time.time()
+            # Derive retryable from the same classification that drives
+            # ACK/NACK in run_worker: transient -> Pub/Sub redelivers
+            # (retryable true); permanent/unknown -> acked, manual reprocess
+            # via POST /process (retryable false).
+            retryable = classify_error(e)
+            failure_details = build_failure_payload(str(e), current_stage, retryable)
             self.logger.error("document_processing_failed", user_id=user_id, course_id=course_id, resource_id=resource_id, error=str(e))
-            await self._publish_status_update(user_id, course_id, resource_id, "failed", {"error": str(e)}, job_id)
-            if trace: trace.update(output={"success": False, "error": str(e)})
+            self.logger.error("document_processing_failed", user_id=user_id, course_id=course_id, resource_id=resource_id, error=str(e), stage=current_stage, retryable=retryable)
+            await self._publish_status_update(user_id, course_id, resource_id, "failed", failure_details, job_id)
+            if trace: trace.update(output={"success": False, "error": str(e), "stage": current_stage, "retryable": retryable})
             return metrics
     
     async def _validate_processing_request(self, user_id: str, course_id: str, resource_id: str):
<<<END-SLE-PATCH>>>
<<<END-SLE-OUTPUT>>>