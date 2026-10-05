<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="apps/ai-server/rag-worker-service/utils/failure_payload.py">>>
"""Worker failure-payload construction for the rag-worker -> rag-api contract.

rag-api's failed branch (run_transactional_update) reads the status payload
keys ``error_message``, ``stage`` and ``retryable`` and persists them as
``error`` / ``error_stage`` / ``retryable`` on the resource document, and as
``message`` / ``stage`` on the processing/summary error subdocument. The
worker's failure publisher must speak exactly that contract; it must never
rely on rag-api's fallback defaults ("Processing failed", stage None,
retryable silently True).

The legacy ``error`` key is retained alongside ``error_message`` as a
compatibility hedge for any unknown consumer of the status topic; dropping
it later is trivial cleanup once the consumer set is audited.
"""

from typing import Any, Callable, Optional

# Safe value when the failing stage is genuinely unknown — matches the
# stale-lease sweep's error_stage value so the field never regresses to null.
UNKNOWN_STAGE = "processing"


def build_failure_payload(
    message: str,
    stage: Optional[str] = None,
    retryable: bool = False,
) -> dict:
    """Build the failed-status payload exactly as rag-api's failed branch reads it.

    Every key the API consumes is set explicitly — the payload never relies
    on rag-api's ``details.get(..., default)`` fallbacks.
    """
    return {
        "error_message": message,
        "stage": stage or UNKNOWN_STAGE,
        "retryable": bool(retryable),
        # Legacy key retained for continuity with any existing consumers of
        # the status topic and log tooling (F11 hedge).
        "error": message,
    }


def derive_retryable(exc: BaseException, classify_error: Callable[[BaseException], Any]) -> bool:
    """Deliberately derive ``retryable`` from the worker's ACK/NACK classification.

    Aligned with run_worker's behavior: errors classify_error marks transient
    will be NACKed and redelivered by Pub/Sub (retryable=True); permanent
    errors — including unclassified-unknown, per classify_error's
    conservative default — are acked and will not come back automatically
    (retryable=False; manual reprocess via POST /process remains).

    Tolerates classify_error returning either a boolean or a classification
    label so the derivation stays correct regardless of its return style.
    """
    classification = classify_error(exc)
    if isinstance(classification, bool):
        return classification
    return str(classification).strip().lower() in {"transient", "retryable", "true"}
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="apps/ai-server/tests/integration/test_worker_failure_contract.py">>>
"""
Contract test: rag-worker failure payload -> rag-api failed-branch persistence.

Pins the worker->rag-api failure seam end to end:

  1. the worker's failure-payload builder emits error_message / stage /
     retryable (plus the retained legacy ``error`` key) — never relying on
     rag-api's fallback defaults,
  2. retryable is derived from classify_error (transient -> True,
     permanent/unclassified-unknown -> False),
  3. rag-api's run_transactional_update failed branch persists the
     worker-provided values as error / error_stage / retryable and mirrors
     message + stage into the processing/summary error subdocument,
  4. AST drift guards fail the build if either side's payload keys change.
"""

import ast
import asyncio
import importlib.util
import inspect
import os
import sys
from unittest.mock import MagicMock

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
AI_SERVER = os.path.abspath(os.path.join(HERE, "..", ".."))
API_DIR = os.path.join(AI_SERVER, "rag-api-service")
WORKER_DIR = os.path.join(AI_SERVER, "rag-worker-service")
WORKER_TESTS_DIR = os.path.join(WORKER_DIR, "tests")

API_MAIN_PATH = os.path.join(API_DIR, "main.py")
WORKER_MAIN_PATH = os.path.join(WORKER_DIR, "main.py")
WORKER_EXCEPTIONS_PATH = os.path.join(WORKER_DIR, "exceptions.py")
WORKER_PAYLOAD_BUILDER_PATH = os.path.join(WORKER_DIR, "utils", "failure_payload.py")

# The integration conftest in this directory already mocks the cloud SDKs
# (firebase_admin, google.cloud.*, structlog, ...) and puts rag-api-service
# on sys.path. Import rag-api's main FIRST, under its normal name, so its
# `models` / `services` packages bind before the worker directories join
# sys.path (both services ship a `models` package).
import main as api_main  # noqa: E402


def _load_module(name: str, path: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


# The worker's own tests/conftest.py stubs its heavier dependencies (openai,
# langchain, pubsub, firebase, tenacity, spacy, tiktoken, ...). Load it via
# importlib under a unique name — a plain `import conftest` here would hit
# the already-cached integration conftest in sys.modules and skip the
# worker's stubs entirely.
_load_module("rag_worker_test_conftest", os.path.join(WORKER_TESTS_DIR, "conftest.py"))

if WORKER_DIR not in sys.path:
    sys.path.insert(0, WORKER_DIR)

from utils.failure_payload import (  # noqa: E402
    UNKNOWN_STAGE,
    build_failure_payload,
    derive_retryable,
)

worker_main = _load_module("rag_worker_main_under_test", WORKER_MAIN_PATH)
worker_exceptions = _load_module(
    "rag_worker_exceptions_under_test", WORKER_EXCEPTIONS_PATH
)

WORKER_PAYLOAD_KEYS = ("error_message", "stage", "retryable", "error")


def _source(path: str) -> str:
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


def _function_source(path: str, name: str):
    src = _source(path)
    tree = ast.parse(src)
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return ast.get_source_segment(src, node)
    return None


def _collect_dicts(mock_obj):
    """Every dict argument passed to any method call on mock_obj."""
    dicts = []
    for call in mock_obj.mock_calls:
        for arg in call[1]:
            if isinstance(arg, dict):
                dicts.append(arg)
    return dicts


class TestWorkerFailurePayloadContract:
    def test_payload_carries_actual_message_stage_and_retryable(self):
        payload = build_failure_payload(
            "Weaviate unreachable", stage="embeddings_complete", retryable=False
        )
        assert payload["error_message"] == "Weaviate unreachable"
        assert payload["stage"] == "embeddings_complete"
        assert payload["retryable"] is False
        # Legacy key retained for unknown consumers of the status topic.
        assert payload["error"] == "Weaviate unreachable"

    def test_stage_defaults_to_processing_when_unknown(self):
        payload = build_failure_payload("boom", stage=None, retryable=True)
        assert payload["stage"] == UNKNOWN_STAGE == "processing"
        assert payload["retryable"] is True

    def test_payload_never_omits_the_contract_keys(self):
        payload = build_failure_payload("boom", stage="starting", retryable=True)
        for key in ("error_message", "stage", "retryable"):
            assert key in payload


class TestRetryableDerivation:
    def test_transient_error_is_retryable(self):
        assert (
            derive_retryable(
                worker_exceptions.TransientError("503 from upstream"),
                worker_main.classify_error,
            )
            is True
        )

    def test_permanent_error_is_not_retryable(self):
        assert (
            derive_retryable(
                worker_exceptions.PermanentError("unsupported file"),
                worker_main.classify_error,
            )
            is False
        )

    def test_unclassified_unknown_error_is_not_retryable(self):
        # classify_error's conservative default is permanent -> retryable
        # False. This is a deliberate behavior change vs. the old silent
        # default of True; manual reprocess via POST /process remains.
        assert (
            derive_retryable(ValueError("something odd"), worker_main.classify_error)
            is False
        )


class TestContractDriftGuards:
    def test_worker_failure_handler_uses_the_contract_builder(self):
        src = _function_source(WORKER_MAIN_PATH, "process_document")
        assert src is not None, "process_document disappeared from the worker"
        assert "build_failure_payload" in src, (
            "process_document's failure handler must build its payload via "
            "build_failure_payload — the payload keys drifted"
        )
        assert "derive_retryable" in src, (
            "process_document's failure handler must derive retryable via "
            "derive_retryable — retryable must never be silently defaulted"
        )

    def test_builder_emits_the_full_key_set(self):
        src = _source(WORKER_PAYLOAD_BUILDER_PATH)
        for key in WORKER_PAYLOAD_KEYS:
            assert f'"{key}"' in src, f"worker payload builder lost the {key!r} key"

    def test_rag_api_failed_branch_reads_the_worker_keys(self):
        src = _function_source(API_MAIN_PATH, "run_transactional_update")
        assert src is not None, (
            "run_transactional_update disappeared from rag-api's main"
        )
        for key in ("error_message", "stage", "retryable"):
            assert key in src, (
                f"rag-api's failed branch no longer reads {key!r} — the "
                "worker->rag-api failure contract drifted"
            )


class TestWorkerFailureToRagApiPersistence:
    def test_failed_payload_persists_worker_values(self):
        """Build the payload through the worker's code path, feed it through
        rag-api's run_transactional_update, and assert the persisted error,
        error_stage and retryable equal the worker's values."""
        payload = build_failure_payload(
            "Embedding request timed out",
            stage="embeddings_complete",
            retryable=True,
        )
        details = {"status": "failed", **payload}

        tx = MagicMock()
        snapshot = MagicMock()
        snapshot.to_dict.return_value = {"status": "processing"}
        tx.get.return_value = snapshot
        doc_ref = MagicMock()

        result = api_main.run_transactional_update(tx, doc_ref, details)
        if inspect.iscoroutine(result):
            asyncio.run(result)

        persisted = _collect_dicts(tx) + _collect_dicts(doc_ref)

        main_docs = [
            d for d in persisted if d.get("error") == "Embedding request timed out"
        ]
        assert main_docs, (
            "rag-api's failed branch did not persist the worker's actual "
            "error message — the payload keys drifted"
        )
        doc = main_docs[0]
        assert doc.get("error_stage") == "embeddings_complete"
        assert doc.get("retryable") is True

        subdocs = [
            d for d in persisted if d.get("message") == "Embedding request timed out"
        ]
        assert subdocs, (
            "processing/summary error subdocument missing the worker's message"
        )
        assert subdocs[0].get("stage") == "embeddings_complete"

    def test_permanent_failure_persists_retryable_false(self):
        payload = build_failure_payload(
            "Unsupported file type", stage="text_retrieved", retryable=False
        )
        details = {"status": "failed", **payload}

        tx = MagicMock()
        snapshot = MagicMock()
        snapshot.to_dict.return_value = {"status": "processing"}
        tx.get.return_value = snapshot
        doc_ref = MagicMock()

        result = api_main.run_transactional_update(tx, doc_ref, details)
        if inspect.iscoroutine(result):
            asyncio.run(result)

        persisted = _collect_dicts(tx) + _collect_dicts(doc_ref)
        main_docs = [
            d for d in persisted if d.get("error") == "Unsupported file type"
        ]
        assert main_docs, "failed branch did not persist the worker's message"
        assert main_docs[0].get("retryable") is False
        assert main_docs[0].get("error_stage") == "text_retrieved"
<<<END-SLE-ARTIFACT>>>
<<<SLE-PATCH path="apps/ai-server/rag-worker-service/main.py" base="7d7718bcbeb2e219dab14e285a66e62ea5883c209981a0be91cc29b490569988">>>
--- a/apps/ai-server/rag-worker-service/main.py
+++ b/apps/ai-server/rag-worker-service/main.py
@@ -30,6 +30,7 @@
 import structlog
 import tiktoken
+from utils.failure_payload import build_failure_payload, derive_retryable
 
 from exceptions import TransientError, PermanentError
@@ -520,2 +521,3 @@
         try:
+            current_stage = "processing"
@@ -560,2 +561,3 @@
+            current_stage = "text_retrieved"
         await self._publish_status_update(
@@ -600,2 +602,3 @@
+            current_stage = "tagging_complete"
         await self._publish_status_update(
@@ -640,2 +643,3 @@
+            current_stage = "summary_generated"
         await self._publish_status_update(
@@ -680,2 +684,3 @@
+            current_stage = "chunking_complete"
         await self._publish_status_update(
@@ -720,2 +725,3 @@
+            current_stage = "embeddings_complete"
         await self._publish_status_update(
@@ -900,9 +906,15 @@
         except Exception as e:
             logger.error(
                 "processing_failed",
                 error=str(e),
             )
             await self._publish_status_update(
                 job,
                 "failed",
-                details={"error": str(e)},
+                details=build_failure_payload(
+                    str(e),
+                    stage=current_stage,
+                    retryable=derive_retryable(e, classify_error),
+                ),
             )
             raise
<<<END-SLE-PATCH>>>
<<<END-SLE-OUTPUT>>>