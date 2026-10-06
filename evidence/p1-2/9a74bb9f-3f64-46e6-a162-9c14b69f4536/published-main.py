"""
RAG Worker Service

This service is a headless worker that consumes document processing jobs from a
Google Cloud Pub/Sub subscription and executes the RAG pipeline.
"""


import asyncio
import datetime as _dt
import logging
from typing import List, Dict, Optional, Set, Tuple, Any
from dataclasses import dataclass, asdict, field
from pathlib import Path
from enum import Enum
import time
import json
from abc import ABC, abstractmethod
import uuid
import io
import os
import httpx
import sys


# ========================================
# Custom Exception Classes for Error Classification
# ========================================

class ProcessingError(Exception):
    """Base class for processing errors."""
    pass


class TransientError(ProcessingError):
    """
    Transient errors that should be retried.
    Examples: network timeouts, temporary service unavailability, rate limits.
    """
    pass


class PermanentError(ProcessingError):
    """
    Permanent errors that should NOT be retried.
    Examples: invalid input data, missing required fields, authorization errors.
    """
    pass


def classify_error(e: Exception) -> bool:
    """
    Classify an exception as transient or permanent.

    Returns:
        True if the error is transient (should retry), False if permanent (should ack and skip).
    """
    # Check explicit exception types first
    if isinstance(e, TransientError):
        return True
    if isinstance(e, PermanentError):
        return False

    # Check for known transient exception types
    transient_types = (
        httpx.ConnectError,
        httpx.ConnectTimeout,
        httpx.ReadTimeout,
        httpx.WriteTimeout,
        httpx.PoolTimeout,
        ConnectionError,
        TimeoutError,
        asyncio.TimeoutError,
    )
    if isinstance(e, transient_types):
        return True

    # Check for HTTP status codes that indicate transient errors
    if isinstance(e, httpx.HTTPStatusError):
        status_code = e.response.status_code
        # 429 (rate limit), 500, 502, 503, 504 are typically transient
        if status_code in (429, 500, 502, 503, 504):
            return True
        # 4xx errors (except 429) are typically permanent
        return False

    # For unknown exceptions, be conservative and treat as permanent
    # to avoid infinite retry loops
    return False


def build_failure_payload(error: Exception, stage: str = "processing") -> Dict[str, Any]:
    """
    Build the failed-status payload the worker publishes for a failed job.

    This is the worker side of the worker→rag-api failure contract; rag-api's
    run_transactional_update failed branch reads exactly these keys:
      - error_message: the actual exception message (persisted as `error`)
      - stage: the pipeline stage executing at failure time (persisted as
        `error_stage`); "processing" is the safe value when the stage is
        genuinely unknown
      - retryable: deliberately derived from classify_error — transient-classified
        errors are ones Pub/Sub will redeliver (True); permanent-classified and
        unclassified-unknown errors are not (False), matching run_worker's
        ACK/NACK behavior. Never silently defaulted.

    The legacy `error` key is retained alongside error_message for continuity
    with any other consumers of the status topic.
    """
    message = str(error)
    return {
        "error_message": message,
        "stage": stage,
        "retryable": classify_error(error),
        # Legacy key kept for unknown consumers of the status topic.
        "error": message,
    }

# Document processing
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain.schema import Document

# AI/ML services
import openai
from langfuse import Langfuse

# Cloud services
import uuid
import firebase_admin
from firebase_admin import firestore, storage, credentials, auth
from google.cloud import pubsub_v1
from google.cloud import storage as gcs_storage
from google.cloud.firestore_v1.base_query import FieldFilter
from google.oauth2 import service_account
from google.auth.credentials import AnonymousCredentials

# Content analysis for tagging
import spacy
from sklearn.feature_extraction.text import TfidfVectorizer
import re

# Utilities
import tiktoken
from tenacity import retry, stop_after_attempt, wait_exponential
import hashlib
from pydantic import field_validator, Field, ConfigDict
from pydantic_settings import BaseSettings
import structlog

# Configure logging BEFORE structlog
logging.basicConfig(
    level=logging.INFO,
    format="%(message)s",
    stream=sys.stdout,
)

# Configure structured logging
structlog.configure(
    processors=[
        structlog.stdlib.filter_by_level,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.stdlib.PositionalArgumentsFormatter(),
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.JSONRenderer()
    ],
    context_class=dict,
    logger_factory=structlog.stdlib.LoggerFactory(),
    wrapper_class=structlog.stdlib.BoundLogger,
    cache_logger_on_first_use=True,
)

logger = structlog.get_logger()

class ProcessingStatus(Enum):
    """Processing status enumeration"""
    QUEUED = "queued"
    PROCESSING = "processing" 
    COMPLETED = "completed"
    FAILED = "failed"
    RETRYING = "retrying"

class DocumentType(Enum):
    """Document type classification"""
    ACADEMIC_PAPER = "academic_paper"
    TEXTBOOK = "textbook"
    LECTURE_NOTES = "lecture_notes"
    PRESENTATION = "presentation"
    ASSIGNMENT = "assignment"
    DOCUMENTATION = "documentation"  # Added for markdown
    README = "readme"
    TUTORIAL = "tutorial"
    UNKNOWN = "unknown"

@dataclass
class ProcessingMetrics:
    """Comprehensive processing metrics"""
    start_time: float
    end_time: Optional[float] = None
    text_length: int = 0
    chunks_created: int = 0
    chunks_stored: int = 0
    embeddings_generated: int = 0
    tokens_used: int = 0
    cost_estimate: float = 0.0
    document_type: DocumentType = DocumentType.UNKNOWN
    tags: List[str] = None
    confidence_scores: Dict[str, float] = None
    error_message: Optional[str] = None
    
    def __post_init__(self):
        if self.tags is None:
            self.tags = []
        if self.confidence_scores is None:
            self.confidence_scores = {}
    
    @property
    def processing_time(self) -> float:
        if self.end_time:
            return self.end_time - self.start_time
        return time.time() - self.start_time
    
    @property
    def success(self) -> bool:
        return self.error_message is None

@dataclass
class ChunkMetadata:
    user_id: str
    course_id: str                 # required now
    resource_id: str               # was doc_id
    chunk_id: str
    chunk_index: int
    title: str
    # Required. Kept required on purpose: giving these defaults to satisfy
    # dataclass ordering would let a construction site that omits `content`
    # silently produce an empty chunk — and an empty chunk embeds and stores
    # without error, so the failure surfaces as bad retrieval much later
    # instead of as a TypeError here.
    content_type: str
    token_count: int
    chunk_size: int
    content_hash: str
    tags: List[str]
    confidence_score: float
    processing_date: str
    content: str
    # Genuinely optional, so they sort after the required fields. All call
    # sites use keyword arguments, so this ordering is free to change.
    filename: str = ""
    page_number: Optional[int] = None
    section_title: Optional[str] = None
    processed_at: Optional[str] = None
    origin_book: Optional[str] = None
    origin_chapter_name: Optional[str] = None
    origin_chapter_number: Optional[int] = None
    origin_page_from: Optional[int] = None
    origin_page_to: Optional[int] = None
    # Flashcard system fields
    section_id: Optional[str] = None
    heading_level: Optional[int] = None  # 1-4 for H1-H4

class ProcessingConfig(BaseSettings):

    #
    # --- OPENROUTER ---
    #
    openrouter_api_key: str = Field(..., alias="OPENROUTER_API_KEY")
    openrouter_base_url: str = Field(..., alias="OPENROUTER_BASE_URL")
    openrouter_model: str = Field(..., alias="OPENROUTER_MODEL")

    #
    # --- FIREBASE ---
    #
    firebase_storage_bucket: str = Field(..., alias="FIREBASE_STORAGE_BUCKET")
    firebase_project_id: str = Field(..., alias="FIREBASE_PROJECT_ID")

    #
    # --- GCP / PubSub ---
    #
    gcp_project: str = Field(..., alias="GCP_PROJECT")
    google_application_credentials: str = Field(..., alias="GOOGLE_APPLICATION_CREDENTIALS")
    rag_process_sub: str = Field(..., alias="RAG_PROCESS_SUB")
    rag_status_topic: str = Field(..., alias="RAG_STATUS_TOPIC")

    #
    # --- Internal Auth ---
    #
    shared_internal_token: str = Field(..., alias="SHARED_INTERNAL_TOKEN")

    #
    # --- Weaviate ---
    #
    weaviate_service_url: str = Field(..., alias="WEAVIATE_SERVICE_URL")
    weaviate_api_key: Optional[str] = Field(None, alias="WEAVIATE_API_KEY")

    #
    # --- Langfuse (optional) ---
    #
    langfuse_public_key: Optional[str] = Field(None, alias="LANGFUSE_PUBLIC_KEY")
    langfuse_secret_key: Optional[str] = Field(None, alias="LANGFUSE_SECRET_KEY")

    #
    # --- Document processing ---
    #
    chunk_size: int = Field(800, alias="CHUNK_SIZE")
    chunk_overlap: int = Field(100, alias="CHUNK_OVERLAP")
    embedding_model: str = Field("text-embedding-3-small", alias="EMBEDDING_MODEL")
    enable_content_tagging: bool = Field(True, alias="ENABLE_CONTENT_TAGGING")
    min_tag_confidence: float = Field(0.6, alias="MIN_TAG_CONFIDENCE")
    max_tags_per_document: int = Field(10, alias="MAX_TAGS_PER_DOCUMENT")

    #
    # --- Summary Generation ---
    #
    summary_max_chars: int = Field(5000, alias="SUMMARY_MAX_CHARS")
    summary_model: str = Field("gpt-4.1-mini", alias="SUMMARY_MODEL")
    summary_prompt_version: int = Field(1, alias="SUMMARY_PROMPT_VERSION")

    #
    # --- Validators ---
    #
    @field_validator("chunk_size")
    @classmethod
    def validate_chunk_size(cls, v: int) -> int:
        if not 100 <= v <= 2000:
            raise ValueError("chunk_size must be between 100 and 2000")
        return v

    @field_validator("chunk_overlap")
    @classmethod
    def validate_chunk_overlap(cls, v: int, info):
        if v < 0 or v > info.data.get("chunk_size", 800):
            raise ValueError("chunk_overlap must be between 0 and chunk_size")
        return v

    #
    # Pydantic Settings
    #
    model_config = ConfigDict(
        env_file=".env",
        extra="forbid",    # block any unexpected env vars
    )



async def generate_app_check_token() -> str:
    """
    Generates a custom Firebase Auth token for service-to-service authentication.
    NOTE: The Python Firebase Admin SDK does not natively support creating App Check tokens.
    This function creates a custom auth token as a workaround.
    """
    try:
        def _create_token_sync():
            # The UID for the custom token can be any string.
            # Using a descriptive UID for the service is a good practice.
            uid = f"{os.environ.get('SERVICE_NAME', 'rag-service')}-{uuid.uuid4()}"
            custom_token = firebase_admin.auth.create_custom_token(uid)
            return custom_token.decode('utf-8')

        token = await asyncio.to_thread(_create_token_sync)
        return token
    except Exception as e:
        logger.error("custom_token_generation_failed", error=str(e))
        raise RuntimeError("Failed to generate custom auth token for service account.") from e

class ContentTagger:
    """Advanced content-based tagging system for markdown content"""
    
    def __init__(self, config: ProcessingConfig):
        self.config = config
        self.logger = structlog.get_logger(component="content_tagger")
        
        # Extended subject patterns for both academic and general content
        self.subject_patterns = {
            # Academic subjects
            "mathematics": [r"theorem", r"proof", r"equation", r"formula", r"calculus", r"algebra"],
            "computer_science": [r"algorithm", r"programming", r"software", r"database", r"network"],
            "physics": [r"quantum", r"mechanics", r"thermodynamics", r"electromagnetic", r"relativity"],
            "chemistry": [r"molecular", r"organic", r"inorganic", r"reaction", r"compound"],
            "biology": [r"cell", r"organism", r"evolution", r"genetics", r"ecosystem"],
            "psychology": [r"cognitive", r"behavioral", r"therapy", r"personality", r"development"],
            "economics": [r"market", r"supply", r"demand", r"inflation", r"monetary"],
            "literature": [r"narrative", r"poetry", r"author", r"literary", r"criticism"],
            "history": [r"historical", r"century", r"ancient", r"medieval", r"revolution"],
            "philosophy": [r"ethics", r"metaphysics", r"logic", r"epistemology", r"existential"],
            
            # TODO: Expand content analysis for non-academic markdown files
            # General content patterns that should be added later:
            "documentation": [r"api", r"endpoint", r"configuration", r"setup", r"install"],
            "tutorial": [r"step", r"guide", r"how to", r"example", r"walkthrough"],
            "notes": [r"todo", r"meeting", r"action item", r"summary", r"minutes"],
            "reference": [r"glossary", r"index", r"appendix", r"bibliography", r"citation"]
        }
    
    async def generate_tags(self, text: str, metadata: Dict[str, Any]) -> Tuple[List[str], Dict[str, float]]:
        """Generate content-based tags with confidence scores"""
        
        if not self.config.enable_content_tagging:
            return [], {}
        
        try:
            tags = set()
            confidence_scores = {}
            
            # 1. Subject detection based on patterns
            subject_tags, subject_scores = self._detect_academic_subjects(text)
            tags.update(subject_tags)
            confidence_scores.update(subject_scores)
            
            # 2. Document type tags
            doc_type_tags = self._generate_document_type_tags(metadata)
            tags.update(doc_type_tags)
            
            # 3. Content complexity tags
            complexity_tags = self._analyze_content_complexity(text)
            tags.update(complexity_tags)
            
            # 4. Structural tags
            structure_tags = self._analyze_document_structure_tags(text, metadata)
            tags.update(structure_tags)
            
            # 5. Key concept extraction using TF-IDF
            concept_tags, concept_scores = await self._extract_key_concepts(text)
            tags.update(concept_tags)
            confidence_scores.update(concept_scores)
            
            # Filter by confidence and limit
            filtered_tags = self._filter_and_rank_tags(list(tags), confidence_scores)
            
            self.logger.info("tags_generated", 
                           tag_count=len(filtered_tags),
                           tags=filtered_tags[:5])
            
            return filtered_tags, confidence_scores
            
        except Exception as e:
            self.logger.error("tagging_failed", error=str(e))
            return [], {}
    
    def _detect_academic_subjects(self, text: str) -> Tuple[List[str], Dict[str, float]]:
        """Detect academic subjects using pattern matching"""
        text_lower = text.lower()
        subject_scores = {}
        
        for subject, patterns in self.subject_patterns.items():
            matches = 0
            total_patterns = len(patterns)
            
            for pattern in patterns:
                pattern_matches = len(re.findall(pattern, text_lower))
                matches += min(pattern_matches, 3)
            
            if matches > 0:
                confidence = min(matches / (total_patterns * 2), 1.0)
                if confidence >= self.config.min_tag_confidence:
                    subject_scores[subject] = confidence
        
        return list(subject_scores.keys()), subject_scores
    
    def _generate_document_type_tags(self, metadata: Dict[str, Any]) -> List[str]:
        """Generate tags based on document type and structure"""
        tags = []
        
        doc_type = metadata.get("document_type", DocumentType.UNKNOWN)
        if doc_type != DocumentType.UNKNOWN:
            tags.append(doc_type.value)
        
        # Add origin-based tags
        if metadata.get("origin_book"):
            tags.append("textbook")
        if metadata.get("origin_chapter_name"):
            tags.append("chapter")
        
        return tags
    
    def _analyze_content_complexity(self, text: str) -> List[str]:
        """Analyze content complexity and reading level"""
        tags = []
        
        avg_sentence_length = self._calculate_avg_sentence_length(text)
        vocab_complexity = self._analyze_vocabulary_complexity(text)
        
        if avg_sentence_length > 25:
            tags.append("complex_sentences")
        if vocab_complexity > 0.7:
            tags.append("advanced_vocabulary")
        if len(text) > 50000:
            tags.append("comprehensive")
        elif len(text) < 5000:
            tags.append("concise")
        
        return tags
    
    def _analyze_document_structure_tags(self, text: str, metadata: Dict[str, Any]) -> List[str]:
        """Generate tags based on document structure"""
        tags = []
        
        # Markdown structure analysis
        if text.count('#') > 5:
            tags.append("well_structured")
        if text.count('```') > 0:
            tags.append("code_examples")
        if text.count('|') > 10:  # Likely contains tables
            tags.append("tabular_data")
        if '[' in text and '](' in text:  # Contains links
            tags.append("linked_content")
        
        return tags
    
    async def _extract_key_concepts(self, text: str) -> Tuple[List[str], Dict[str, float]]:
        """Extract key concepts using TF-IDF with sampling from entire document"""
        try:
            vectorizer = TfidfVectorizer(
                max_features=100,
                stop_words='english',
                ngram_range=(1, 2),
                min_df=2,
                max_df=0.8
            )

            # Split into sentences and sample from throughout the document
            # to avoid missing important content in longer documents
            all_sentences = [s.strip() for s in text.split('.') if s.strip()]
            MAX_SENTENCES = 500  # Increased from 100 to cover more content

            if len(all_sentences) <= MAX_SENTENCES:
                sentences = all_sentences
            else:
                # Sample evenly from throughout the document
                step = len(all_sentences) / MAX_SENTENCES
                sentences = [all_sentences[int(i * step)] for i in range(MAX_SENTENCES)]

            if len(sentences) < 5:
                return [], {}
            
            tfidf_matrix = vectorizer.fit_transform(sentences)
            feature_scores = tfidf_matrix.sum(axis=0).A1
            feature_names = vectorizer.get_feature_names_out()
            
            term_scores = list(zip(feature_names, feature_scores))
            term_scores.sort(key=lambda x: x[1], reverse=True)
            
            concept_tags = []
            concept_scores = {}
            
            for term, score in term_scores[:20]:
                clean_term = re.sub(r'[^Ȁ-ɿ -~]', '', term.lower()).strip()
                if (len(clean_term) > 3 and 
                    clean_term.isalpha() and 
                    score > 0.1):
                    concept_tags.append(clean_term)
                    concept_scores[clean_term] = float(score)
                
                if len(concept_tags) >= 10:
                    break
            
            return concept_tags, concept_scores
            
        except Exception as e:
            self.logger.warning("concept_extraction_failed", error=str(e))
            return [], {}
    
    def _filter_and_rank_tags(self, tags: List[str], confidence_scores: Dict[str, float]) -> List[str]:
        """Filter tags by confidence and limit total number"""
        
        def tag_score(tag):
            return confidence_scores.get(tag, 0.5)
        
        sorted_tags = sorted(tags, key=tag_score, reverse=True)
        
        filtered_tags = [
            tag for tag in sorted_tags 
            if confidence_scores.get(tag, 0.5) >= self.config.min_tag_confidence
        ]
        
        return filtered_tags[:self.config.max_tags_per_document]
    
    def _calculate_avg_sentence_length(self, text: str) -> float:
        """Calculate average sentence length"""
        sentences = re.split(r'[.!?]+', text)
        valid_sentences = [s for s in sentences if len(s.strip()) > 5]
        
        if not valid_sentences:
            return 0
        
        total_words = sum(len(s.split()) for s in valid_sentences)
        return total_words / len(valid_sentences)
    
    def _analyze_vocabulary_complexity(self, text: str) -> float:
        """Analyze vocabulary complexity"""
        words = re.findall(r'\b\w+\b', text.lower())
        if not words:
            return 0
        
        long_words = [w for w in words if len(w) >= 6]
        return len(long_words) / len(words)

class EnhancedDocumentProcessor:
    """Enhanced document processor for subcollection structure with pre-extracted text"""

    # marker-pdf converter, shared per process. Building it loads the model
    # stack (expensive even with a warm weight cache); documents then reuse it.
    _marker_converter = None

    def __init__(self, config: ProcessingConfig):
        self.config = config
        self.logger = structlog.get_logger(component="document_processor")
        
        # Initialize services
        self._init_services()
        
        # Initialize components
        self.content_tagger = ContentTagger(config)
        self.httpx_client = httpx.AsyncClient(base_url=self.config.weaviate_service_url)
        self.pubsub_publisher = pubsub_v1.PublisherClient()
        
        # Initialize text splitter optimized for markdown
        self.text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=config.chunk_size,
        chunk_overlap=config.chunk_overlap,
        separators=[
            "\n# ",      # Markdown H1 headers
            "\n## ",     # Markdown H2 headers
            "\n### ",    # Markdown H3 headers
            "\n#### ",   # Markdown H4 headers
            "\n",        # Paragraph boundaries
            ". ",        # Sentence boundaries
            "! ",
            "? ",
            " ",         # Word boundaries
            ""           # Character boundaries
        ],
        keep_separator=True,
        length_function=len
    )

        
        # Token counter
        self.tokenizer = tiktoken.get_encoding("cl100k_base")
        
        # Cost tracking
        self.embedding_cost_per_token = self._get_embedding_cost()

    def _get_embedding_cost(self) -> float:
        """Get cost per token based on model"""
        model = self.config.embedding_model
        
        cost_map = {
            "text-embedding-3-small": 0.00002,
            "text-embedding-3-large": 0.00013,
            "text-embedding-ada-002": 0.0001,
        }
        
        return cost_map.get(model, 0.00002)

    def _truncate_text_for_summary(self, text: str) -> str:
        """Limits text length to avoid token explosion for summary generation."""
        max_chars = self.config.summary_max_chars
        if len(text) > max_chars:
            self.logger.warning("text_truncated_for_summary", original_length=len(text), truncated_length=max_chars)
            return text[:max_chars]
        return text

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=2, min=4, max=30))
    async def generate_document_summary(self, text: str, title: str) -> Optional[Dict[str, Any]]:
        """
        Generates a summary (overview and bullet points) of the document text using an LLM.
        Returns None if summary generation fails.
        """
        if not self.openai_client:
            self.logger.error("openai_client_not_initialized_for_summary")
            return None

        truncated_text = self._truncate_text_for_summary(text)
        prompt = f"""
        You are an expert academic assistant. Summarize the following document content.

        Document Title: {title}
        Document Content:
        ---
        {truncated_text}
        ---

        Provide a concise overview and 3-5 key bullet points.
        Format your response as a JSON object with two keys: "overview" (string) and "bulletPoints" (list of strings).
        Example:
        {{
            "overview": "This document discusses...",
            "bulletPoints": [
                "Key point one",
                "Key point two",
                "Key point three"
            ]
        }}
        """

        try:
            chat_completion = await self.openai_client.chat.completions.create(
                messages=[
                    {
                        "role": "system",
                        "content": "You are a helpful assistant that summarizes academic documents into a concise overview and key bullet points in JSON format."
                    },
                    {
                        "role": "user",
                        "content": prompt,
                    }
                ],
                model=self.config.summary_model,
                response_format={"type": "json_object"},
                temperature=0.3,
            )
            summary_content = chat_completion.choices[0].message.content
            summary_json = json.loads(summary_content)
            
            if not isinstance(summary_json.get("overview"), str) or \
               not isinstance(summary_json.get("bulletPoints"), list):
                raise ValueError("Invalid summary format received from LLM.")

            self.logger.info("document_summary_generated", 
                             model=self.config.summary_model, 
                             prompt_version=self.config.summary_prompt_version,
                             resource_title=title)
            return summary_json

        except openai.APIError as e:
            self.logger.error("openrouter_summary_api_error", error=str(e))
            return None
        except json.JSONDecodeError as e:
            self.logger.error("summary_json_decode_error", error=str(e), raw_content=summary_content)
            return None
        except ValueError as e:
            self.logger.error("summary_format_validation_error", error=str(e), raw_content=summary_content)
            return None
        except Exception as e:
            self.logger.error("document_summary_generation_failed", error=str(e))
            return None
    
    def _init_services(self):
        """Initialize external services"""
        # Default to None so a failed init degrades gracefully (summary,
        # embeddings, and skeleton refinement all no-op on a missing
        # client) instead of raising AttributeError at call time.
        self.openai_client = None
        try:
            # Configure OpenRouter client
            self.openai_client = openai.AsyncOpenAI(
                api_key=self.config.openrouter_api_key,
                base_url=self.config.openrouter_base_url,
                timeout=60.0
            )
            self.logger.info("openai_client_initialized_for_openrouter")

            # LangFuse
            if self.config.langfuse_public_key and self.config.langfuse_secret_key:
                self.langfuse = Langfuse(
                    public_key=self.config.langfuse_public_key,
                    secret_key=self.config.langfuse_secret_key
                )
                self.logger.info("langfuse_client_initialized")
            else:
                self.langfuse = None
                self.logger.warning("langfuse_keys_not_provided")

            # Firebase initialization using GOOGLE_APPLICATION_CREDENTIALS
            if not firebase_admin._apps:
                google_application_credentials_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
                if google_application_credentials_path:
                    cred = credentials.Certificate(google_application_credentials_path)
                    firebase_admin.initialize_app(cred, {
                        'storageBucket': self.config.firebase_storage_bucket
                    })
                elif os.getenv("FIRESTORE_EMULATOR_HOST"):
                    # Emulator: see the equivalent branch in rag-api-service.
                    self.logger.info(
                        "firebase_emulator_mode",
                        firestore_emulator=os.getenv("FIRESTORE_EMULATOR_HOST"),
                    )
                    firebase_admin.initialize_app(options={
                        'projectId': os.getenv("GCP_PROJECT", "demo-project"),
                        'storageBucket': self.config.firebase_storage_bucket,
                    })
                else:
                    raise RuntimeError(
                        "GOOGLE_APPLICATION_CREDENTIALS environment variable is not set "
                        "and no emulator host is configured."
                    )

            self.db = firestore.client()
            self.storage_client = self._build_storage_client()
            self.logger.info("firebase_initialized")

            self.logger.info("services_initialization_complete")

        except Exception as e:
            self.logger.error("service_initialization_failed", error=str(e))
            raise

    def _build_storage_client(self):
        """
        Build the Cloud Storage client for PDF downloads.

        firebase_admin.storage's default client authenticates with the
        service-account certificate and mints real OAuth tokens — unusable
        against the hermetic stack's fake-gcs-server. When
        STORAGE_EMULATOR_HOST is set, build an anonymous client instead
        (mirrors utils/cloud_storage.py).
        """
        emulator = os.getenv("STORAGE_EMULATOR_HOST")
        if emulator:
            self.logger.info("storage_client_emulator_mode", emulator_host=emulator)
            return gcs_storage.Client(
                project=os.getenv("GCP_PROJECT", "demo-project"),
                credentials=AnonymousCredentials(),
            )
        return gcs_storage.Client(project=os.getenv("GCP_PROJECT"))
    
    def _get_document_path(self, user_id: str, course_id: str, resource_id: str) -> str:
        """
        Resolve the Firestore path of a resource document.

        V2's create_resource always writes the canonical path
        (users/{userId}/resources/{resourceId}) — course membership is a
        course_ids array on the document, not a separate location — so the
        canonical path is preferred even when a course_id is supplied. The
        legacy course-centric path (users/{userId}/courses/{courseId}/
        courseResources/{resourceId}) is the fallback.
        """
        if not user_id or not resource_id:
            raise ValueError("user_id and resource_id are required")

        canonical = f"users/{user_id}/resources/{resource_id}"
        if course_id in (None, "__ungrouped__"):
            return canonical
        if self.db.document(canonical).get().exists:
            return canonical

        return f"users/{user_id}/courses/{course_id}/courseResources/{resource_id}"

    async def _extract_pdf_from_storage(self, storage_url: str, storage_bucket: str, resource_id: str) -> tuple[str, int]:
        """Download and extract text from PDF in Cloud Storage using marker-pdf for high-quality extraction"""
        import io
        import re

        self.logger.info("downloading_pdf_from_storage", storage_url=storage_url, resource_id=resource_id)

        try:
            # Parse storage URL to get bucket and path
            if storage_url.startswith('gs://'):
                parts = storage_url[5:].split('/', 1)
                bucket_name = parts[0]
                file_path = parts[1] if len(parts) > 1 else ''
            else:
                # Parse Firebase Storage URL format
                # Use the full bucket name as provided (e.g. 'project-id.firebasestorage.app')
                bucket_name = storage_bucket 
                match = re.search(r'/o/([^?]+)', storage_url)
                if match:
                    import urllib.parse
                    file_path = urllib.parse.unquote(match.group(1))
                else:
                    raise ValueError(f"Could not parse storage URL: {storage_url}")

            # Download PDF from Storage
            bucket = self.storage_client.bucket(bucket_name)
            blob = bucket.blob(file_path)
            pdf_bytes = await asyncio.to_thread(blob.download_as_bytes)

            self.logger.info("pdf_downloaded", resource_id=resource_id, size_bytes=len(pdf_bytes))

            # Extract using marker-pdf for high-quality markdown output
            extracted_text, total_pages = await self._extract_pdf_with_marker(pdf_bytes, resource_id)

            if not extracted_text.strip():
                raise ValueError("PDF extraction resulted in empty text")

            return extracted_text, total_pages

        except Exception as e:
            self.logger.error("pdf_extraction_error", resource_id=resource_id, error=str(e))
            raise

    async def _extract_pdf_with_marker(self, pdf_bytes: bytes, resource_id: str) -> tuple[str, int]:
        """
        Extract text from PDF using marker-pdf for high-quality markdown output.
        This provides much better structure, formatting, and table extraction than basic pypdf.

        Written against the marker-pdf 1.x API (PdfConverter + create_model_dict).
        The pre-1.0 entry points (marker.convert.convert_single_pdf,
        marker.models.load_all_models) were removed upstream in 1.0 — against
        marker-pdf 1.6.1 the old code died at import and every document
        silently fell back to pypdf, which is how production extraction was
        degraded without any visible failure.
        """
        # Explicit backend selection. Without this the only way to avoid
        # marker-pdf is to make it fail, and its fallback is exception-driven
        # and silent — which means a degraded extraction is indistinguishable
        # from a good one. The hermetic test stack's `fast` profile sets this
        # to "pypdf" so it stays offline (marker pulls ~2GB from HuggingFace).
        backend = os.getenv("PDF_EXTRACTION_BACKEND", "marker").strip().lower()
        if backend == "pypdf":
            self.logger.info(
                "pdf_extraction_backend_forced",
                resource_id=resource_id,
                backend="pypdf",
            )
            return await self._extract_pdf_with_pypdf(pdf_bytes, resource_id)

        try:
            import tempfile
            from pypdf import PdfReader
            from marker.converters.pdf import PdfConverter
            from marker.models import create_model_dict

            self.logger.info("extracting_pdf_with_marker", resource_id=resource_id, pdf_size=len(pdf_bytes))

            # Get basic metadata first
            pdf_io = io.BytesIO(pdf_bytes)
            reader = PdfReader(pdf_io)
            total_pages = len(reader.pages)

            self.logger.info("pdf_metadata_extracted", resource_id=resource_id, total_pages=total_pages)

            # The converter owns the model stack; building it is expensive even
            # with a warm weight cache, so it is created once per process and
            # shared across documents.
            if self.__class__._marker_converter is None:
                self.logger.info("loading_marker_models", resource_id=resource_id)
                def build_converter():
                    return PdfConverter(artifact_dict=create_model_dict())
                self.__class__._marker_converter = await asyncio.to_thread(build_converter)
            converter = self.__class__._marker_converter

            # marker's converter takes a file path, not a stream.
            self.logger.info("converting_pdf_to_markdown", resource_id=resource_id, pages=total_pages)
            with tempfile.NamedTemporaryFile(suffix=".pdf") as tmp:
                tmp.write(pdf_bytes)
                tmp.flush()
                rendered = await asyncio.to_thread(converter, tmp.name)

            markdown_text = rendered.markdown

            self.logger.info("pdf_extraction_complete",
                           resource_id=resource_id,
                           text_length=len(markdown_text),
                           total_pages=total_pages,
                           images_found=len(rendered.images) if rendered.images else 0)

            return markdown_text, total_pages

        except ImportError as e:
            self.logger.warning("marker_pdf_not_available_falling_back_to_pypdf",
                              resource_id=resource_id,
                              error=str(e))
            # Fallback to simple pypdf extraction
            text, pages = await self._extract_pdf_with_pypdf(pdf_bytes, resource_id)
            return text, pages

        except Exception as e:
            self.logger.error("marker_extraction_failed_falling_back",
                            resource_id=resource_id,
                            error=str(e))
            # Fallback to simple pypdf extraction
            text, pages = await self._extract_pdf_with_pypdf(pdf_bytes, resource_id)
            return text, pages

    async def _extract_pdf_with_pypdf(self, pdf_bytes: bytes, resource_id: str) -> tuple[str, int]:
        """
        Fallback: Extract text using pypdf (basic extraction).
        Used when marker-pdf is unavailable or fails.
        Returns tuple of (extracted_text, total_pages).
        """
        from pypdf import PdfReader
        import io

        self.logger.info("extracting_pdf_with_pypdf_fallback", resource_id=resource_id)

        pdf_file = io.BytesIO(pdf_bytes)
        text_pages = []

        def extract_text_sync():
            reader = PdfReader(pdf_file)
            total_pages = len(reader.pages)
            for page_num, page in enumerate(reader.pages, 1):
                page_text = page.extract_text() or ''
                if page_text.strip():
                    text_pages.append(f"\n## Page {page_num}\n\n{page_text}")
            return '\n\n'.join(text_pages), total_pages

        extracted_text, total_pages = await asyncio.to_thread(extract_text_sync)

        self.logger.info("pypdf_extraction_complete",
                       resource_id=resource_id,
                       total_pages=total_pages,
                       text_length=len(extracted_text))

        return extracted_text, total_pages
    
    async def process_document(self, user_id: str, course_id: str, resource_id: str, job_id: Optional[str] = None) -> ProcessingMetrics:
        """Enhanced main processing pipeline for subcollection structure"""
        metrics = ProcessingMetrics(start_time=time.time())
        trace = self.langfuse.trace(name="doc_processing_course_resources",
                                input={"user_id": user_id, "course_id": course_id, "resource_id": resource_id, "job_id": job_id}) if self.langfuse else None
        
        # Stage tracker: set immediately before each pipeline step so the
        # failure handler reports the true failing stage. Names reuse the
        # progress-update vocabulary; "processing" is the safe value when the
        # stage is genuinely unknown (e.g. failure before the first step).
        current_stage = "processing"
        try:
            await self._validate_processing_request(user_id, course_id, resource_id)
            current_stage = "starting"
            await self._publish_status_update(user_id, course_id, resource_id, "processing", {"stage": "starting"}, job_id)
            
            # Step 1: Get pre-extracted text (replaces file download and extraction)
            current_stage = "text_retrieved"
            text_content, doc_metadata = await self._get_extracted_text(user_id, course_id, resource_id)
            metrics.text_length = len(text_content)
            await self._publish_status_update(user_id, course_id, resource_id, "processing", {"stage": "text_retrieved", "progress": 20}, job_id)

            # Step 2: Content Tagging and Analysis
            current_stage = "tagging_complete"
            tags, confidence_scores = await self.content_tagger.generate_tags(text_content, doc_metadata)
            metrics.tags, metrics.confidence_scores = tags, confidence_scores
            await self._publish_status_update(user_id, course_id, resource_id, "processing", {"stage": "tagging_complete", "progress": 40}, job_id)

            # Step 3: Generate Summary
            current_stage = "summary_generated"
            summary_data = await self.generate_document_summary(text_content, doc_metadata.get('title', 'Untitled Document'))
            
            update_data = {}
            if summary_data:
                update_data["ragDescription"] = summary_data
                update_data["ragDescriptionUpdatedAt"] = firestore.SERVER_TIMESTAMP
                update_data["ragDescriptionMeta"] = {
                    "promptVersion": self.config.summary_prompt_version,
                    "maxChars": self.config.summary_max_chars,
                    "model": self.config.summary_model
                }
            else:
                update_data["ragDescription"] = None # If summary generation failed, store null

            doc_path = self._get_document_path(user_id, course_id, resource_id)
            self.db.document(doc_path).update(update_data)

            await self._publish_status_update(user_id, course_id, resource_id, "processing", {"stage": "summary_generated", "progress": 50}, job_id)

            # Step 4: Chunking
            current_stage = "chunking_complete"
            chunks = await self._create_enhanced_chunks(text_content, doc_metadata, tags, user_id, course_id, resource_id)
            metrics.chunks_created = len(chunks)
            metrics.tokens_used = sum(c.token_count for c in chunks)
            metrics.cost_estimate = metrics.tokens_used * self.embedding_cost_per_token
            await self._publish_status_update(user_id, course_id, resource_id, "processing", {"stage": "chunking_complete", "progress": 60}, job_id)

            # Step 5: Generate Embeddings
            current_stage = "embeddings_complete"
            vectors = await self._generate_embeddings_with_openrouter(chunks)
            metrics.embeddings_generated = len(vectors)
            await self._publish_status_update(user_id, course_id, resource_id, "processing", {"stage": "embeddings_complete", "progress": 80}, job_id)
            chunks = await self._create_enhanced_chunks(text_content, doc_metadata, tags, user_id, course_id, resource_id)
            metrics.chunks_created = len(chunks)
            metrics.tokens_used = sum(c.token_count for c in chunks)
            metrics.cost_estimate = metrics.tokens_used * self.embedding_cost_per_token
            await self._publish_status_update(user_id, course_id, resource_id, "processing", {"stage": "chunking_complete", "progress": 60}, job_id)

            # Step 5: Generate Embeddings
            vectors = await self._generate_embeddings_with_openrouter(chunks)
            metrics.embeddings_generated = len(vectors)
            await self._publish_status_update(user_id, course_id, resource_id, "processing", {"stage": "embeddings_complete", "progress": 80}, job_id)

            # Step 6a: Delete old vectors AFTER successful processing but BEFORE storing new ones
            # This ensures we don't lose data if processing fails
            await self.delete_old_vectors_via_service(user_id, course_id, resource_id)

            # Step 6b: Store in Weaviate via Weaviate Service
            storage_result = await self.store_chunks_via_service(chunks, vectors)
            # What the index actually accepted — store_chunks_via_service
            # raises on partial writes, so this equals len(chunks) here, but
            # reporting it from the storage result (not from
            # embeddings_generated) keeps the claim honest if that ever
            # changes.
            metrics.chunks_stored = storage_result.get("successful_inserts", 0)

            # Save processing metadata to subcollection (new architecture)
            await self._save_processing_metadata_to_subcollection(
                user_id=user_id,
                course_id=course_id,
                resource_id=resource_id,
                metrics=metrics,
                tags=tags
            )

            final_details = {
                "stage": "completed",
                "progress": 100,
                "jobId": job_id,
                "weaviate_storage": storage_result,
                "ragProcessingMetrics": {
                    "chunks_created": metrics.chunks_created,
                    "chunks_stored": metrics.chunks_stored,
                    "tokens_used": metrics.tokens_used,
                    "cost_estimate": metrics.cost_estimate,
                    "processing_time": metrics.processing_time,
                    "embeddings_generated": metrics.embeddings_generated
                },
                "ragContentTags": tags,
                "ragContentAnalysis": {
                    "confidence_scores": metrics.confidence_scores,
                    "document_type": metrics.document_type.value if isinstance(metrics.document_type, DocumentType) else str(metrics.document_type),
                    "text_length": metrics.text_length
                },
                "ragSearchable": True,
                "ragVectorStorage": {
                    "provider": "weaviate-service",
                    "chunks_stored": metrics.chunks_stored
                }
            }
            await self._publish_status_update(user_id, course_id, resource_id, "completed", final_details, job_id)

            # Update user usage counter
            await self._update_user_usage(user_id)

            # Generate resource map for flashcard system (directly, not via Pub/Sub)
            await self._generate_resource_map(
                user_id=user_id,
                course_id=course_id,
                resource_id=resource_id,
                markdown_text=text_content,
                total_pages=doc_metadata.get('total_pages', 0),
                filename=doc_metadata.get('filename', 'Unknown'),
                chunks_metadata=[asdict(c) for c in chunks],
            )

            metrics.end_time = time.time()
            if trace: trace.update(output={"success": True, "metrics": asdict(metrics)})
            self.logger.info("document_processing_completed", user_id=user_id, course_id=course_id, resource_id=resource_id, processing_time=metrics.processing_time)
            return metrics
            
        except Exception as e:
            metrics.error_message, metrics.end_time = str(e), time.time()
            # Contract with rag-api's failed branch: publish the actual error
            # message, the failing stage, and a deliberately derived retryable
            # flag — never rely on rag-api's fallback defaults.
            failure_details = build_failure_payload(e, current_stage)
            self.logger.error(
                "document_processing_failed",
                user_id=user_id,
                course_id=course_id,
                resource_id=resource_id,
                error=str(e),
                stage=current_stage,
                retryable=failure_details["retryable"],
            )
            await self._publish_status_update(user_id, course_id, resource_id, "failed", failure_details, job_id)
            if trace: trace.update(output={"success": False, "error": str(e), "stage": current_stage})
            return metrics
    
    async def _validate_processing_request(self, user_id: str, course_id: str, resource_id: str):
        """Validate processing request using subcollection paths"""
        
        doc_path = self._get_document_path(user_id, course_id, resource_id)
        doc_ref = self.db.document(doc_path)
        doc_data = doc_ref.get().to_dict()
        
        if not doc_data:
            raise ValueError(f"Document {resource_id} not found at path {doc_path}")
        
        # Verify user ownership (implicit in path structure, but double-check)
        if doc_data.get('userId') != user_id:
            raise PermissionError(f"User {user_id} does not own document {resource_id}")
        
        # Check if already processed is handled by _claim_resource_if_queued
        # if doc_data.get('ragProcessingStatus') == 'processing':
        #     raise ValueError(f"Document {resource_id} is already being processed")
        
        # Ensure we have either extracted text OR a source file to extract from
        has_text = bool(doc_data.get('extractedText'))
        has_source = bool(doc_data.get('storage_url') or doc_data.get('pdfUrl'))
        
        if not has_text and not has_source:
            raise ValueError(f"Document {resource_id} has neither extracted text nor a valid source URL")
    
    async def _save_content_to_subcollection(self, user_id: str, course_id: str, resource_id: str,
                                             text_content: str, total_pages: int):
        """Save extracted text to content subcollection (new architecture)"""
        try:
            doc_path = self._get_document_path(user_id, course_id, resource_id)
            # content/data + extracted_text is the contract the readers use
            # (flashcard-service generate, rag-worker regenerate-map). An
            # earlier revision wrote content/extracted with a `text` field,
            # which no reader ever looked at — flashcard generation found
            # "no markdown content" for every freshly ingested resource.
            content_ref = self.db.document(f"{doc_path}/content/data")

            await asyncio.to_thread(
                content_ref.set,
                {
                    "extracted_text": text_content,
                    "text_length": len(text_content),
                    "extraction_method": "marker-pdf",
                    "extracted_at": firestore.SERVER_TIMESTAMP,
                    "total_pages": total_pages
                }
            )
            self.logger.info("content_saved_to_subcollection",
                           resource_id=resource_id,
                           text_length=len(text_content))
        except Exception as e:
            self.logger.error("save_content_subcollection_failed",
                            resource_id=resource_id,
                            error=str(e))
            # Don't fail main processing if subcollection write fails

    async def _save_processing_metadata_to_subcollection(self, user_id: str, course_id: str,
                                                         resource_id: str, metrics, tags: List[str]):
        """Save processing metadata to processing subcollection (new architecture)"""
        try:
            doc_path = self._get_document_path(user_id, course_id, resource_id)
            processing_ref = self.db.document(f"{doc_path}/processing/summary")

            await asyncio.to_thread(
                processing_ref.set,
                {
                    "metrics": {
                        "chunks_created": metrics.chunks_created,
                        "tokens_used": metrics.tokens_used,
                        "cost_estimate": metrics.cost_estimate,
                        "processing_time": metrics.processing_time,
                        "embeddings_generated": metrics.embeddings_generated
                    },
                    "tags": tags,
                    "analysis": {
                        "confidence_scores": metrics.confidence_scores,
                        "document_type": metrics.document_type.value if isinstance(metrics.document_type, DocumentType) else str(metrics.document_type),
                        "text_length": metrics.text_length
                    },
                    "vector_storage": {
                        "provider": "weaviate-service",
                        "chunks_stored": metrics.chunks_stored
                    },
                    "processed_at": firestore.SERVER_TIMESTAMP
                }
            )
            self.logger.info("processing_metadata_saved_to_subcollection",
                           resource_id=resource_id)
        except Exception as e:
            self.logger.error("save_processing_metadata_subcollection_failed",
                            resource_id=resource_id,
                            error=str(e))
            # Don't fail main processing if subcollection write fails

    async def _get_extracted_text(self, user_id: str, course_id: str, resource_id: str) -> Tuple[str, Dict[str, Any]]:
        """Get pre-extracted text and metadata from Firestore - supports both old and new paths"""

        # Try course-centric path first (old system)
        doc_path = self._get_document_path(user_id, course_id, resource_id)
        doc_ref = self.db.document(doc_path)
        doc_data = doc_ref.get().to_dict()

        # If not found and course_id is placeholder, try new resource path
        if not doc_data and course_id == "__ungrouped__":
            doc_path = f"users/{user_id}/resources/{resource_id}"
            doc_ref = self.db.document(doc_path)
            doc_data = doc_ref.get().to_dict()
            self.logger.info("using_new_resource_path", path=doc_path)

        if not doc_data:
            raise ValueError(f"Document not found at {doc_path}")

        # Prioritize extracting from PDF if URL is available, regardless of existing extractedText
        storage_url = doc_data.get('storage_url') or doc_data.get('pdfUrl')
        storage_bucket = doc_data.get('storage_bucket')
        text_content = ''

        if storage_url and storage_bucket:
            self.logger.info("extracting_pdf_text_forced",
                           resource_id=resource_id,
                           storage_url=storage_url)

            try:
                # Extract PDF text inline
                text_content, total_pages = await self._extract_pdf_from_storage(
                    storage_url,
                    storage_bucket,
                    resource_id
                )

                # Save summary to main document (lightweight)
                doc_ref.update({
                    'total_pages': total_pages,
                    'extractionMethod': 'marker-pdf',
                    'extractedAt': firestore.SERVER_TIMESTAMP
                })

                # Save full extracted text to content subcollection (new architecture)
                await self._save_content_to_subcollection(
                    user_id=user_id,
                    course_id=course_id,
                    resource_id=resource_id,
                    text_content=text_content,
                    total_pages=total_pages
                )

                doc_data['total_pages'] = total_pages

                self.logger.info("pdf_text_extracted_and_saved",
                               resource_id=resource_id,
                               text_length=len(text_content),
                               total_pages=total_pages)

            except Exception as e:
                self.logger.error("pdf_extraction_failed",
                                resource_id=resource_id,
                                error=str(e))
                # Fallback to existing text if extraction fails
                if doc_data.get('extractedText'):
                    self.logger.warning("fallback_to_existing_text", resource_id=resource_id)
                    text_content = doc_data.get('extractedText')
                else:
                    raise ValueError(f"Failed to extract PDF text and no existing text found: {str(e)}")
        
        # Fallback to existing extractedText if no PDF URL
        elif doc_data.get('extractedText'):
             text_content = doc_data.get('extractedText')
        else:
            raise ValueError(f"No extracted text and no storage URL for document {resource_id}")

        # Build metadata from Firestore document
        processed_at_val = doc_data.get('processed_at')

        # Build metadata from Firestore document
        doc_metadata = {
            "user_id": doc_data.get('userId'),
            "course_id": doc_data.get('courseId') or doc_data.get('course_ids', [None])[0] if isinstance(doc_data.get('course_ids'), list) and doc_data.get('course_ids') else None,
            "title": doc_data.get('title', ''),
            "filename": doc_data.get('filename', ''),
            "pdf_url": doc_data.get('pdfUrl') or doc_data.get('storage_url', ''),
            "thumbnail_url": doc_data.get('thumbnailUrl'),
            "tags": doc_data.get('tags', []),
            "processed_at": str(processed_at_val) if processed_at_val else '',
            "origin_book": doc_data.get('originBook'),
            "origin_chapter_name": doc_data.get('originChapterName'),
            "origin_chapter_number": doc_data.get('originChapterNumber'),
            "origin_page_from": doc_data.get('originPageFrom'),
            "origin_page_to": doc_data.get('originPageTo'),
            "extracted_images": doc_data.get('extractedImages', []),
            "document_type": DocumentType.UNKNOWN,  # Will be analyzed by content tagger
            "text_length": len(text_content)
        }
        
        return text_content, doc_metadata
    
    async def _create_enhanced_chunks(self, text: str, metadata: Dict[str, Any], 
                                    tags: List[str], user_id: str, course_id: str, 
                                    resource_id: str) -> List[ChunkMetadata]:
        """Create chunks with enhanced metadata for subcollection structure"""
        
        raw_chunks = self.text_splitter.split_text(text)
        
        enhanced_chunks = []
        current_section = None
        current_heading_level = None
        section_counter = 0

        # Helper to clean up metadata values
        def get_meta(key, default=None):
            val = metadata.get(key)
            return val if val not in [None, ""] else default

        for i, chunk_content in enumerate(raw_chunks):
            # Extract section title and heading level from markdown headers
            section_title, heading_level = self._extract_markdown_header_with_level(chunk_content)
            if section_title:
                current_section = section_title
                current_heading_level = heading_level
                section_counter += 1

            # Generate section_id if we have a current section
            section_id = None
            if current_section:
                section_id = f"{resource_id}_s{section_counter:03d}"

            # Determine content type
            content_type = self._classify_chunk_content(chunk_content)

            # Calculate token count
            token_count = len(self.tokenizer.encode(chunk_content))

            # Create enhanced metadata
            chunk_metadata = ChunkMetadata(
                user_id=user_id,
                course_id=course_id,
                resource_id=resource_id,
                chunk_id=f"{resource_id}_chunk_{i:04d}",
                chunk_index=i,
                title=get_meta('title'),
                filename=metadata.get('filename', ''),
                page_number=self._estimate_page_number(i, len(raw_chunks), metadata),
                section_title=current_section,
                content_type=content_type,
                token_count=token_count,
                chunk_size=len(chunk_content),
                content_hash=hashlib.md5(chunk_content.encode()).hexdigest()[:8],
                tags=tags.copy(),
                confidence_score=1.0,
                processed_at=get_meta('processed_at'),
                processing_date=time.strftime('%Y-%m-%d %H:%M:%S'),
                content=chunk_content,
                # Origin metadata
                origin_book=get_meta('origin_book'),
                origin_chapter_name=get_meta('origin_chapter_name'),
                origin_chapter_number=get_meta('origin_chapter_number'),
                origin_page_from=get_meta('origin_page_from'),
                origin_page_to=get_meta('origin_page_to'),
                # Flashcard system fields
                section_id=section_id,
                heading_level=current_heading_level
            )

            enhanced_chunks.append(chunk_metadata)
        
        return enhanced_chunks
    
    def _extract_markdown_section_title(self, content: str) -> Optional[str]:
        """Extract section title from markdown headers"""
        lines = content.split('\n')

        for line in lines[:5]:  # Check first few lines
            line = line.strip()
            if line.startswith('#'):
                # Extract header text without the # symbols
                header_text = line.lstrip('#').strip()
                if header_text and len(header_text) < 100:
                    return header_text

        return None

    def _extract_markdown_header_with_level(self, content: str) -> tuple[Optional[str], Optional[int]]:
        """Extract section title and heading level from markdown headers"""
        lines = content.split('\n')

        for line in lines[:5]:  # Check first few lines
            line_stripped = line.strip()
            if line_stripped.startswith('#'):
                # Count heading level
                level = 0
                for char in line_stripped:
                    if char == '#':
                        level += 1
                    else:
                        break

                # Extract header text without the # symbols
                header_text = line_stripped.lstrip('#').strip()
                if header_text and len(header_text) < 100 and 1 <= level <= 4:
                    return header_text, level

        return None, None
    
    def _classify_chunk_content(self, content: str) -> str:
        """Classify chunk content type for markdown content"""
        content_lower = content.lower()
        content_stripped = content.strip()
        
        # Markdown-specific classifications
        if content_stripped.startswith('#'):
            return 'markdown_header'
        elif '```' in content:
            return 'code_block'
        elif content.count('|') >= 2 and '\n' in content:
            return 'markdown_table'
        elif content_stripped.startswith('[') and '](' in content:
            return 'link_reference'
        elif content_stripped.startswith('- ') or content_stripped.startswith('* '):
            return 'list'
        elif content_stripped.startswith('>'):
            return 'blockquote'
        elif content.count('\n') < 2 and len(content) < 200:
            return 'heading'
        else:
            return 'paragraph'
    
    def _estimate_page_number(self, chunk_index: int, total_chunks: int, metadata: Dict[str, Any]) -> Optional[int]:
        """Estimate page number based on chunk position and origin metadata"""
        origin_page_from = metadata.get('origin_page_from')
        origin_page_to = metadata.get('origin_page_to')
        
        if origin_page_from and origin_page_to:
            # Distribute chunks across the page range
            page_range = origin_page_to - origin_page_from + 1
            progress = chunk_index / total_chunks
            estimated_page = origin_page_from + int(progress * page_range)
            return min(estimated_page, origin_page_to)
        
        return None
    
    
    
    
    
    async def _update_user_usage(self, user_id: str):
        """Update user's documentsProcessed counter"""
        try:
            # Use the same collection name as everywhere else: "users"
            user_ref = self.db.document(f"users/{user_id}")

            user_ref.set({
                'documentsProcessed': firestore.Increment(1),
                'lastActiveDate': firestore.SERVER_TIMESTAMP,
                'updatedAt': firestore.SERVER_TIMESTAMP
            }, merge=True)
            self.logger.info("user_usage_updated", user_id=user_id)
        except Exception as e:
            self.logger.warning("user_usage_update_failed", user_id=user_id, error=str(e))

    async def _generate_resource_map(
        self,
        user_id: str,
        course_id: str,
        resource_id: str,
        markdown_text: str,
        total_pages: int = 0,
        filename: str = "",
        chunks_metadata: list | None = None,
    ):
        """
        Generate resource map for flashcard system directly (no Pub/Sub).
        Uses ResourceMapGenerator to parse markdown structure and create section-based map.
        """
        try:
            self.logger.info(
                "resource_map_generation_started",
                user_id=user_id,
                resource_id=resource_id,
                text_length=len(markdown_text)
            )

            # Import here to avoid circular dependencies
            from workers.resource_map_generator import ResourceMapGenerator

            # Generate and store resource map. The OpenRouter chat client
            # enables tier-2 skeleton refinement for thin heading scans.
            generator = ResourceMapGenerator(
                self.db,
                llm_client=self.openai_client,
                llm_model=self.config.summary_model,
            )
            resource_map = await generator.generate_and_store_map(
                user_id=user_id,
                course_id=course_id,
                resource_id=resource_id,
                markdown_text=markdown_text,
                total_pages=total_pages,
                filename=filename,
                chunks_metadata=chunks_metadata,
            )

            self.logger.info(
                "resource_map_generation_completed",
                user_id=user_id,
                resource_id=resource_id,
                total_sections=resource_map.get('total_sections', 0),
                extraction_confidence=resource_map.get('extraction_confidence', 'unknown')
            )

        except Exception as e:
            # Don't fail the main processing if map generation fails
            self.logger.warning(
                "resource_map_generation_failed",
                user_id=user_id,
                resource_id=resource_id,
                error=str(e)
            )

    # Track sequence numbers per resource for ordered status updates
    _status_sequence: Dict[str, int] = {}

    def _get_next_sequence(self, resource_id: str) -> int:
        """Get the next sequence number for a resource's status updates."""
        if resource_id not in self._status_sequence:
            self._status_sequence[resource_id] = 0
        self._status_sequence[resource_id] += 1
        return self._status_sequence[resource_id]

    def _reset_sequence(self, resource_id: str):
        """Reset sequence counter for a resource (call when processing completes/fails)."""
        if resource_id in self._status_sequence:
            del self._status_sequence[resource_id]

    async def _publish_status_update(self, user_id: str, course_id: str, resource_id: str,
                                      status: str, details: Dict[str, Any], job_id: Optional[str] = None):
        """
        Publish processing status to Pub/Sub topic.

        Includes sequence numbers to allow clients to handle out-of-order delivery.
        """
        try:
            topic_path = self.pubsub_publisher.topic_path(self.config.gcp_project, self.config.rag_status_topic)

            if job_id and 'jobId' not in details:
                details['jobId'] = job_id

            # Get sequence number for ordering
            sequence = self._get_next_sequence(resource_id)

            message_data = {
                "user_id": user_id,
                "course_id": course_id,
                "resource_id": resource_id,
                "status": status,
                "details": details,
                "timestamp": time.time(),
                "sequence": sequence  # Allows clients to handle out-of-order delivery
            }

            # Reset sequence on terminal states
            if status in ("completed", "failed"):
                self._reset_sequence(resource_id)

            # Every status update renews the processing lease (the claim's
            # status_updated_at is what lease-stealing checks). Stage
            # transitions heartbeat; the long silent ones (marker-pdf) are
            # covered by _heartbeat_loop.
            try:
                lease_paths = [f"users/{user_id}/resources/{resource_id}"]
                if course_id and course_id != INDEPENDENT_RESOURCE_MARKER:
                    lease_paths.append(
                        f"users/{user_id}/courses/{course_id}/courseResources/{resource_id}"
                    )
                for lease_path in lease_paths:
                    lease_ref = self.db.document(lease_path)
                    if lease_ref.get().exists:
                        lease_ref.set({"status_updated_at": firestore.SERVER_TIMESTAMP}, merge=True)
                        break
            except Exception as e:
                self.logger.debug("lease_heartbeat_write_skipped", resource_id=resource_id, error=str(e))

            future = self.pubsub_publisher.publish(topic_path, json.dumps(message_data).encode('utf-8'))
            await asyncio.wrap_future(future)  # Ensure message is published
            self.logger.info("status_update_published",
                           user_id=user_id,
                           course_id=course_id,
                           resource_id=resource_id,
                           status=status,
                           sequence=sequence,
                           details=details)
        except Exception as e:
            self.logger.error("status_publish_failed",
                            user_id=user_id,
                            course_id=course_id,
                            resource_id=resource_id,
                            status=status,
                            error=str(e))

    async def close(self):
        """Clean up resources"""
        await self.httpx_client.aclose()
        self.pubsub_publisher.api.transport.close()

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=2, min=4, max=30))
    async def _generate_embeddings_with_openrouter(self, chunks: List[ChunkMetadata]) -> List[List[float]]:
        """Generate embeddings for chunks using OpenRouter"""
        if not self.openai_client:
            raise Exception("OpenRouter client is not initialized.")
            
        self.logger.info("generating_embeddings_via_openrouter", count=len(chunks))
        
        content_to_embed = [chunk.content for chunk in chunks]

        try:
            response = await self.openai_client.embeddings.create(
                model=self.config.embedding_model,
                input=content_to_embed
            )
            
            return [data.embedding for data in response.data]
        except openai.APIConnectionError as e:
            self.logger.error(
                "openrouter_connection_failed",
                error=str(e),
                base_url=self.config.openrouter_base_url,
                detail="Could not connect to OpenRouter. This is likely a network issue or an invalid API key. "
                       "Please check the following: "
                       "1. The 'OPENROUTER_API_KEY' in your .env file is correct. "
                       "2. The rag-worker-service container has internet access. "
                       "3. DNS resolution for openrouter.ai is working from within the container."
            )
            raise  # Re-raise to allow tenacity to retry

    async def delete_old_vectors_via_service(self, user_id: str, course_id: str, resource_id: str) -> int:
        """
        Delete old vectors for a resource from Weaviate via the Weaviate Service.

        This is called AFTER successful processing (text extraction, chunking, embedding generation)
        but BEFORE storing new vectors. This ensures we don't lose data if processing fails.

        Returns:
            Number of deleted chunks (0 if none found or on error)
        """
        self.logger.info("deleting_old_vectors_before_storage", user_id=user_id, resource_id=resource_id)

        try:
            headers = {
                "x-internal-token": self.config.shared_internal_token
            }
            delete_url = f"/resources/{user_id}/{resource_id}/vectors?course_id={course_id}"

            response = await self.httpx_client.delete(
                delete_url,
                headers=headers,
                timeout=60.0
            )

            if response.status_code == 200:
                result = response.json()
                deleted_count = result.get("deleted_chunks", 0)
                self.logger.info("old_vectors_deleted_successfully",
                               resource_id=resource_id,
                               deleted_count=deleted_count)
                return deleted_count
            else:
                # Not found (404) is expected for new documents
                self.logger.info("no_old_vectors_to_delete",
                               resource_id=resource_id,
                               status_code=response.status_code)
                return 0

        except Exception as e:
            # Log but don't fail - missing old vectors is not critical
            self.logger.warning("delete_old_vectors_failed",
                              resource_id=resource_id,
                              error=str(e))
            return 0

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=2, min=4, max=30))
    async def store_chunks_via_service(self, chunks: List[ChunkMetadata], vectors: List[List[float]]) -> Dict[str, Any]:
        """Store document chunks in Weaviate via the Weaviate Service"""
        self.logger.info("storing_chunks_via_weaviate_service", count=len(chunks))

        try:
            payload = {
                "chunks": [asdict(chunk) for chunk in chunks],
                "vectors": vectors
            }

            # Log the full payload for debugging the 422 error
            try:
                payload_json_for_logging = json.dumps(payload, indent=2)
                self.logger.info("weaviate_payload_to_send", payload_size=len(payload_json_for_logging))
                # To avoid excessively large logs, only log the full payload if it's of a reasonable size
                if len(payload_json_for_logging) < 10000: # 10KB limit
                    self.logger.debug("weaviate_payload_content", payload_content=payload_json_for_logging)
                else:
                    self.logger.info("weaviate_payload_is_large", sample_chunk=json.dumps(payload['chunks'][0], indent=2))
            except TypeError as e:
                self.logger.error("payload_serialization_for_logging_failed", error=str(e))


            headers = {
                "x-internal-token": self.config.shared_internal_token
            }
            response = await self.httpx_client.post(
                "/vectors",
                json=payload,
                timeout=300.0,
                headers=headers
            )
            response.raise_for_status()

            result = response.json()
            self.logger.info("weaviate_service_storage_complete", **result)

            # Weaviate's batch insert can partially fail while the endpoint
            # still returns 200: failed_inserts > 0 means some chunks never
            # reached the search index. Accepting that would mark the
            # resource searchable while retrieval silently misses the
            # unstored chunks — so require every chunk to have landed.
            # Raising here fails the job (status "failed"), which is the
            # honest outcome for a partially-indexed document; it is
            # reprocessable, unlike a silent hole in the index.
            expected = len(chunks)
            successful = result.get("successful_inserts", 0)
            failed = result.get("failed_inserts", 0)
            if failed > 0 or successful != expected:
                raise RuntimeError(
                    f"partial vector write: {successful}/{expected} chunks "
                    f"stored, {failed} failed — refusing to mark the "
                    "resource searchable on a partial index"
                )

            return result
        except TypeError as e:
            self.logger.error(
                "weaviate_storage_type_error",
                error=str(e),
                detail="A TypeError occurred while sending data to the weaviate-service. "
                       "This often indicates that part of the payload is not JSON-serializable. "
                       "Check the 'weaviate_payload_sample' log for clues."
            )
            raise
        except Exception as e:
            # Catch other potential errors like httpx.RequestError
            self.logger.error("weaviate_storage_failed", error=str(e))
            raise

# ========================================
# PUB/SUB WORKER
# ========================================


# Pub/Sub initialization using mounted service account (same as Firebase)
GCP_PROJECT = os.environ["GCP_PROJECT"]
RAG_PROCESS_SUB = os.getenv("RAG_PROCESS_SUB", "vector-process-sub")

# Load the same service account JSON used by Firebase
GOOGLE_KEY_PATH = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
if not GOOGLE_KEY_PATH:
    raise RuntimeError("GOOGLE_APPLICATION_CREDENTIALS is not set")

PUBSUB_CREDS = service_account.Credentials.from_service_account_file(GOOGLE_KEY_PATH)
SUBSCRIBER = pubsub_v1.SubscriberClient(credentials=PUBSUB_CREDS)
SUB_PATH = SUBSCRIBER.subscription_path(GCP_PROJECT, RAG_PROCESS_SUB)

logger.info(
    "starting_pubsub_subscriber",
    project_id=GCP_PROJECT,
    subscription_name=RAG_PROCESS_SUB,
    subscription_path=SUB_PATH,
    emulator_host=os.getenv("PUBSUB_EMULATOR_HOST"),
)

def _priority_of(received_message):
    try:
        attrs = received_message.message.attributes or {}
        return int(attrs.get("priority", "5"))
    except Exception:
        return 5

# Processing lease: how long a claim is trusted without a heartbeat.
# The claim write itself counts as the first heartbeat, so a worker that
# dies mid-extraction (OOM, crash) has its claim stolen — and the message
# redelivered — after this long. Generous: marker-pdf on a 70-page PDF
# runs minutes, and heartbeats fire on every stage transition plus this
# interval, so only a genuinely dead worker misses by this much.
PROCESSING_LEASE_SECONDS = int(os.getenv("PROCESSING_LEASE_SECONDS", "600"))
HEARTBEAT_INTERVAL_SECONDS = int(os.getenv("HEARTBEAT_INTERVAL_SECONDS", "60"))


def _lease_expired(data: dict, now_ms: int) -> bool:
    """True if a 'processing' claim is stale enough to steal."""
    updated = data.get("status_updated_at")
    if updated is None:
        return False  # legacy doc without the field — don't steal blindly
    updated_ms = _timestamp_to_ms(updated)
    if updated_ms is None:
        return False
    return (now_ms - updated_ms) / 1000.0 > PROCESSING_LEASE_SECONDS


def _timestamp_to_ms(value) -> Optional[int]:
    """Convert a Firestore timestamp (Snapshot or datetime) to epoch ms."""
    import datetime as _dt
    if hasattr(value, "seconds"):  # google.cloud.firestore.Timestamp
        return int(value.seconds) * 1000 + int(getattr(value, "nanos", 0)) // 1_000_000
    if isinstance(value, _dt.datetime):
        return int(value.timestamp() * 1000)
    return None

# Shared constant for independent resources (used across services)
INDEPENDENT_RESOURCE_MARKER = "__ungrouped__"


async def regenerate_map_only(db, user_id: str, resource_id: str) -> dict:
    """
    Regenerate resource map from stored markdown content.

    This is a lightweight operation that:
    1. Reads existing markdown from content/data subcollection
    2. Regenerates the resource map using ResourceMapGenerator
    3. Saves updated map to resourceMap/data subcollection

    Used when map generation failed or needs to be refreshed without
    re-processing the entire PDF.

    Args:
        db: Firestore client
        user_id: User ID
        resource_id: Resource ID

    Returns:
        dict with status and resource_map

    Raises:
        Exception if content not found or generation fails
    """
    from workers.resource_map_generator import ResourceMapGenerator

    logger.info("regenerate_map_started", user_id=user_id, resource_id=resource_id)

    # 1. Get resource document for metadata
    resource_path = f"users/{user_id}/resources/{resource_id}"
    resource_ref = db.document(resource_path)
    resource_doc = await asyncio.to_thread(resource_ref.get)

    if not resource_doc.exists:
        raise ValueError(f"Resource not found: {resource_id}")

    resource_data = resource_doc.to_dict()
    filename = resource_data.get("filename", "Unknown")
    total_pages = resource_data.get("total_pages", 0)

    # 2. Read markdown from content/data subcollection
    content_ref = db.document(f"{resource_path}/content/data")
    content_doc = await asyncio.to_thread(content_ref.get)

    if not content_doc.exists:
        raise ValueError(f"Content not found for resource: {resource_id}. PDF may not have been processed yet.")

    content_data = content_doc.to_dict()
    markdown_text = content_data.get("extracted_text", "")

    if not markdown_text:
        raise ValueError(f"No extracted text found for resource: {resource_id}")

    logger.info("regenerate_map_content_loaded",
                resource_id=resource_id,
                text_length=len(markdown_text),
                total_pages=total_pages)

    # 3. Generate new resource map. Same tier-2 refinement wiring as the
    # subscriber path: chat client from OpenRouter env when configured.
    import os as _os
    from openai import AsyncOpenAI as _AsyncOpenAI

    _api_key = _os.getenv("OPENROUTER_API_KEY")
    _llm_client = None
    if _api_key:
        _llm_client = _AsyncOpenAI(
            api_key=_api_key,
            base_url=_os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
            timeout=60.0,
        )

    generator = ResourceMapGenerator(db, llm_client=_llm_client)
    resource_map = await generator.generate_and_store_map(
        user_id=user_id,
        course_id=INDEPENDENT_RESOURCE_MARKER,  # Use new architecture
        resource_id=resource_id,
        markdown_text=markdown_text,
        total_pages=total_pages,
        filename=filename
    )

    # 4. Update resource status
    await asyncio.to_thread(
        resource_ref.update,
        {
            "resourceMapStatus": "completed",
            "resourceMapUpdatedAt": firestore.SERVER_TIMESTAMP
        }
    )

    logger.info("regenerate_map_completed",
                resource_id=resource_id,
                sections_count=resource_map.total_sections if hasattr(resource_map, 'total_sections') else len(resource_map.get('sections', [])))

    return {
        "status": "success",
        "resource_id": resource_id,
        "message": "Resource map regenerated successfully"
    }


def _claim_resource_if_queued(db, user_id: str, course_id: str, resource_id: str) -> bool:
    """
    Atomically check if resource is available for processing and claim it using a transaction.

    This prevents race conditions where two workers could both see 'queued' status
    and start processing the same document simultaneously.

    Supports both new independent resource path and legacy course-centric path:
    - New: users/{userId}/resources/{resourceId}
    - Legacy: users/{userId}/courses/{courseId}/courseResources/{resourceId}
    """
    try:
        # Resolve the resource document before claiming. V2's create_resource
        # always writes the canonical path (users/{uid}/resources/{rid}) —
        # course membership is a course_ids array on the doc, not a separate
        # location — so the canonical path is tried first even when a course
        # is attached. The legacy course-centric path is the fallback.
        candidate_paths = [f"users/{user_id}/resources/{resource_id}"]
        if course_id != INDEPENDENT_RESOURCE_MARKER:
            candidate_paths.append(
                f"users/{user_id}/courses/{course_id}/courseResources/{resource_id}"
            )

        doc_ref = None
        for path in candidate_paths:
            ref = db.document(path)
            if ref.get().exists:
                doc_ref = ref
                break

        if doc_ref is None:
            logger.warning(
                "pubsub_claim_failed_not_found",
                resource_id=resource_id,
                course_id=course_id,
                paths=candidate_paths,
            )
            return False
        logger.info(
            "claiming_resource",
            resource_id=resource_id,
            course_id=course_id,
            path=doc_ref.path,
        )

        @firestore.transactional
        def claim_in_transaction(transaction):
            """Atomic claim operation - read and update in single transaction."""
            doc = doc_ref.get(transaction=transaction)

            if not doc.exists:
                logger.warning("pubsub_claim_failed_not_found", resource_id=resource_id, course_id=course_id)
                return False

            data = doc.to_dict() or {}
            status = data.get("status", data.get("ragProcessingStatus", "uploaded"))

            terminal_states = ("completed", "failed", "deleted")
            if status in terminal_states:
                logger.info("pubsub_skipping_claimed_resource", resource_id=resource_id, status=status)
                return False

            if status == "processing":
                # An in-flight claim is trusted only while its lease is live.
                # A crashed worker (OOM mid-extraction, restart) stops
                # heartbeating, the lease expires, and the redelivered
                # message steals the claim instead of being dropped.
                now_ms = int(_dt.datetime.now().timestamp() * 1000)
                if not _lease_expired(data, now_ms):
                    logger.info("pubsub_resource_already_processing", resource_id=resource_id)
                    return False
                logger.warning(
                    "pubsub_stealing_expired_lease",
                    resource_id=resource_id,
                    lease_seconds=PROCESSING_LEASE_SECONDS,
                )

            transaction.update(doc_ref, {
                "status": "processing",
                "status_updated_at": firestore.SERVER_TIMESTAMP,
                "updated_at": firestore.SERVER_TIMESTAMP,
                "schema_version": 2,
            })

            summary_ref = doc_ref.collection("processing").document("summary")
            transaction.set(summary_ref, {
                "stage": "claimed_by_worker",
                "progress": 0,
                "updated_at": firestore.SERVER_TIMESTAMP,
                "started_at": firestore.SERVER_TIMESTAMP,
            }, merge=True)

            logger.info("pubsub_resource_claimed_successfully", resource_id=resource_id, previous_status=status)
            return True

        # Execute the transactional claim
        transaction = db.transaction()
        return claim_in_transaction(transaction)

    except Exception as e:
        logger.error("pubsub_claim_resource_failed", resource_id=resource_id, error=str(e))
        return False

async def run_worker(processor, process_fn):
    logger.info("pubsub_worker_loop_starting")

    # Heartbeat + sweep tasks keep processing leases honest. The heartbeat
    # covers stages that don't naturally publish status (marker-pdf on a
    # 70-page PDF is silent for minutes); the sweep is the last line of
    # defense — anything whose lease expired without a worker picking it
    # back up is marked failed so the client isn't left on a spinner.
    heartbeat_task = asyncio.create_task(_heartbeat_loop(processor))
    sweep_task = asyncio.create_task(_stale_lease_sweep_loop(processor))

    while True:
        try:
            logger.info("pulling_messages_from_pubsub")
            response = await asyncio.to_thread(
                SUBSCRIBER.pull,
                request={"subscription": SUB_PATH, "max_messages": 5},
                timeout=30.0
            )
            logger.info("pull_call_finished", received_message_count=len(response.received_messages))
            
            msgs = response.received_messages
            if not msgs:
                logger.info("no_messages_received_sleeping")
                await asyncio.sleep(5)
                continue

            logger.info("pubsub_messages_received", count=len(msgs))
            msgs = sorted(msgs, key=_priority_of, reverse=True)

            ack_ids = []
            for rm in msgs:
                msg = rm.message
                try:
                    logger.info(
                        "received_pubsub_message",
                        message_id=msg.message_id,
                        attributes={k: v for k, v in msg.attributes.items()},
                    )
                    payload = json.loads(msg.data.decode("utf-8"))
                    user_id = payload["user_id"]
                    resource_id = payload["resource_id"]
                    action = payload.get("action", "process")  # Default to full processing

                    # Handle map-only regeneration (lightweight operation)
                    if action == "regenerate-map":
                        logger.info("pubsub_regenerate_map_request", resource_id=resource_id, user_id=user_id)
                        await regenerate_map_only(processor.db, user_id, resource_id)
                        ack_ids.append(rm.ack_id)
                        logger.info("message_acknowledged_after_map_regeneration", message_id=msg.message_id)
                        continue

                    # Full PDF processing flow
                    course_id = payload.get("course_id", INDEPENDENT_RESOURCE_MARKER)
                    job_id = payload.get("job_id")

                    logger.info("pubsub_processing_message", resource_id=resource_id, user_id=user_id, course_id=course_id, job_id=job_id)

                    if not _claim_resource_if_queued(processor.db, user_id, course_id, resource_id):
                        ack_ids.append(rm.ack_id)
                        logger.info("message_acknowledged_due_to_claim_failure", message_id=msg.message_id)
                        continue

                    _ACTIVE_PROCESSING.add((user_id, course_id, resource_id))
                    try:
                        await process_fn(user_id, course_id, resource_id, job_id)
                    finally:
                        _ACTIVE_PROCESSING.discard((user_id, course_id, resource_id))
                    ack_ids.append(rm.ack_id)
                    logger.info("message_acknowledged_after_processing", message_id=msg.message_id)

                except Exception as e:
                    logger.error("pubsub_message_processing_failed", error=str(e), error_type=type(e).__name__, payload=msg.data.decode("utf-8"))

                    # Smart ACK/NACK logic using exception type classification
                    is_transient = classify_error(e)

                    if is_transient:
                        # TRANSIENT ERROR: Do NOT acknowledge.
                        # Let Pub/Sub retry this message later (after ack deadline).
                        logger.info("transient_error_detected_nacking_message",
                                   message_id=msg.message_id,
                                   error_type=type(e).__name__,
                                   reason=str(e))
                        # Omitting from ack_ids allows Pub/Sub to redeliver after ack deadline
                    else:
                        # PERMANENT ERROR: Acknowledge to avoid poison pill loops.
                        ack_ids.append(rm.ack_id)
                        logger.info("permanent_error_acknowledged",
                                   message_id=msg.message_id,
                                   error_type=type(e).__name__)


            if ack_ids:
                await asyncio.to_thread(
                    SUBSCRIBER.acknowledge,
                    request={"subscription": SUB_PATH, "ack_ids": ack_ids}
                )
                logger.info("pubsub_messages_acked_in_batch", count=len(ack_ids))
        except Exception as e:
            logger.error("pubsub_worker_loop_error", error=str(e))
            await asyncio.sleep(15)

async def _heartbeat_loop(processor):
    """Renew leases for resources this worker is actively processing.

    Tracks in-flight (user_id, course_id, resource_id) tuples as process_fn
    starts/finishes them (see run_worker's wrapper below) and refreshes
    status_updated_at every HEARTBEAT_INTERVAL_SECONDS while they run.
    """
    while True:
        try:
            active = set(_ACTIVE_PROCESSING)

            def _beat_sync():
                for user_id, course_id, resource_id in active:
                    try:
                        lease_paths = [f"users/{user_id}/resources/{resource_id}"]
                        if course_id != INDEPENDENT_RESOURCE_MARKER:
                            lease_paths.append(
                                f"users/{user_id}/courses/{course_id}/courseResources/{resource_id}"
                            )
                        for lease_path in lease_paths:
                            ref = processor.db.document(lease_path)
                            if ref.get().exists:
                                ref.set({"status_updated_at": firestore.SERVER_TIMESTAMP}, merge=True)
                                break
                    except Exception as e:
                        logger.debug("heartbeat_refresh_failed", resource_id=resource_id, error=str(e))

            if active:
                await asyncio.to_thread(_beat_sync)
        except Exception as e:
            logger.error("heartbeat_loop_error", error=str(e))
        await asyncio.sleep(HEARTBEAT_INTERVAL_SECONDS)

# (user_id, course_id, resource_id) tuples currently being processed by
# this worker — populated by run_worker, read by _heartbeat_loop.
_ACTIVE_PROCESSING: Set[Tuple[str, str, str]] = set()


def _fail_if_still_stale(db, doc_ref, now_ms: int) -> bool:
    """Mark a resource failed only if its lease is *still* expired.

    Re-evaluates staleness on the current document inside the same
    transaction that writes the failure — between the sweep query and this
    write, a redelivered message may legitimately have stolen and renewed
    the lease. Without the re-check the sweeper would kill exactly the
    recovery the claim-stealing layer performed.
    """
    @firestore.transactional
    def fail_in_transaction(transaction):
        snap = doc_ref.get(transaction=transaction)
        if not snap.exists:
            return False
        data = snap.to_dict() or {}
        if data.get("status") != "processing":
            return False
        if not _lease_expired(data, now_ms):
            return False
        transaction.update(doc_ref, {
            "status": "failed",
            "error": "processing lease expired without heartbeat — worker died or stalled",
            "error_stage": "processing",
            "retryable": True,
            "status_updated_at": firestore.SERVER_TIMESTAMP,
            "updated_at": firestore.SERVER_TIMESTAMP,
        })
        return True

    try:
        return fail_in_transaction(db.transaction())
    except Exception as e:
        logger.error("stale_lease_fail_write_error", resource_path=doc_ref.path, error=str(e))
        return False


async def _stale_lease_sweep_loop(processor):
    """Fail resources whose processing lease expired and nobody reclaimed.

    Covers the case Pub/Sub redelivery can't: the message was acked or
    lost entirely (e.g. worker OOM-killed after the pull), so no new claim
    attempt will ever arrive. The sweep marks such resources failed with a
    retryable error so the client shows the failure and can retry.
    """
    while True:
        try:
            cutoff = _dt.datetime.now(tz=_dt.timezone.utc) - _dt.timedelta(seconds=PROCESSING_LEASE_SECONDS)
            now_ms = int(_dt.datetime.now(tz=_dt.timezone.utc).timestamp() * 1000)

            def _sweep_sync():
                stale = []
                query = (
                    processor.db.collection_group("resources")
                    .where(filter=FieldFilter("status", "==", "processing"))
                    .where(filter=FieldFilter("status_updated_at", "<", cutoff))
                    .limit(50)
                )
                # The query snapshot is only a candidate list — the lease is
                # re-checked transactionally at write time by
                # _fail_if_still_stale, closing the reclaim-vs-sweep race.
                for doc in query.stream():
                    if _fail_if_still_stale(processor.db, doc.reference, now_ms):
                        stale.append(doc.reference.path)
                return stale

            for path in await asyncio.to_thread(_sweep_sync):
                logger.warning("stale_processing_lease_failed", resource_path=path)
        except Exception as e:
            logger.error("stale_lease_sweep_error", error=str(e))
        await asyncio.sleep(HEARTBEAT_INTERVAL_SECONDS * 2)


async def main():
    """Initializes the processor and starts the worker loop."""
    processor = None
    try:
        config = ProcessingConfig()
        processor = EnhancedDocumentProcessor(config)
        logger.info("processor_initialized_for_worker")

        await run_worker(processor, process_fn=processor.process_document)
    
    except Exception as e:
        logger.critical("worker_startup_failed", error=str(e))
    
    finally:
        if processor:
            await processor.close()
            logger.info("processor_shutdown_complete")

if __name__ == "__main__":
    asyncio.run(main())