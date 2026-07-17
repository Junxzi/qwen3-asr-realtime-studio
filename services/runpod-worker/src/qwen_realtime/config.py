from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_CATALOG_PATH = "/workspace/config/terms.json"
DEFAULT_ASR_MODEL = "/workspace/models/qwen3-asr-ja-rlbr-context-fullft"
DEFAULT_ALIGNER_MODEL = "/workspace/models/Qwen3-ForcedAligner-0.6B"
DEFAULT_DIARIZER_MODEL = (
    "/workspace/models/diar_streaming_sortformer_4spk-v2.1-verified/"
    "diar_streaming_sortformer_4spk-v2.1.nemo"
)
DEFAULT_MODEL_ID = "infodeliverailab/qwen3-asr-ja-rlbr-context-fullft"
DEFAULT_MODELS_LOCK_PATH = "/opt/app/config/models.lock.json"


def _bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _optional_positive_float(name: str) -> float | None:
    value = os.getenv(name)
    if value is None or not value.strip():
        return None
    parsed = float(value)
    if parsed <= 0:
        raise ValueError(f"{name} must be greater than zero when set")
    return parsed


def _positive_float(name: str, default: float) -> float:
    value = os.getenv(name)
    parsed = default if value is None or not value.strip() else float(value)
    if parsed <= 0:
        raise ValueError(f"{name} must be greater than zero")
    return parsed


def _integer_at_least(name: str, default: int, minimum: int) -> int:
    value = os.getenv(name)
    parsed = default if value is None or not value.strip() else int(value)
    if parsed < minimum:
        raise ValueError(f"{name} must be at least {minimum}")
    return parsed


def _optional_string(name: str) -> str | None:
    value = os.getenv(name)
    if value is None or not value.strip():
        return None
    return value.strip()


@dataclass(frozen=True, slots=True)
class Settings:
    model_id: str = DEFAULT_MODEL_ID
    worker_id: str = "local-worker"
    worker_ticket_secret: str | None = None
    require_worker_ticket: bool = True
    worker_admin_secret: str | None = None
    draining: bool = False
    models_lock_path: Path = Path(DEFAULT_MODELS_LOCK_PATH)
    service_profile: str = "production"
    sample_rate: int = 16_000
    encoding: str = "pcm_s16le"
    max_sessions: int = 32
    session_start_timeout_seconds: float = 10.0
    max_pcm_frame_ms: int = 1_000
    max_stream_audio_seconds: float = 14_400.0
    max_audio_lead_seconds: float = 5.0
    max_session_seconds: float = 14_700.0
    max_session_jobs: int = 8
    max_session_events: int = 32
    chunk_seconds: float = 1.0
    min_chunk_seconds: float = 0.8
    max_utterance_seconds: float = 20.0
    vad_end_silence_ms: int = 480
    vad_threshold: float = 0.5
    pre_roll_ms: int = 240
    rollback_tokens: int = 5
    partial_max_new_tokens: int = 32
    final_max_new_tokens: int = 512
    batch_window_ms: int = 15
    batch_size: int = 32
    scheduler_queue_size: int = 64
    scheduler_max_concurrent_batches: int = 2
    label_delay_ms: int = 320
    diarizer_interval_ms: int = 500
    final_diarization_timeout_seconds: float | None = 4.0
    diarizer_request_timeout_seconds: float = 4.0
    diarizer_cleanup_timeout_seconds: float = 0.5
    context_top_k: int = 20
    context_max_updates: int = 2
    catalog_path: Path = Path(DEFAULT_CATALOG_PATH)
    asr_backend: str = "fake"
    asr_model: str = DEFAULT_ASR_MODEL
    asr_dtype: str = "bfloat16"
    aligner_model: str = DEFAULT_ALIGNER_MODEL
    diarizer_backend: str = "energy"
    diarizer_model: str = DEFAULT_DIARIZER_MODEL
    diarizer_url: str = "http://127.0.0.1:18001/diarize"
    gpu_memory_utilization: float = 0.72
    enable_aligner: bool = True
    compile_aligner: bool = True
    warmup_aligner: bool = True
    reject_catalog_revision_mismatch: bool = True

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            model_id=os.getenv("MODEL_ID", DEFAULT_MODEL_ID).strip(),
            worker_id=(
                os.getenv("WORKER_ID")
                or os.getenv("RUNPOD_POD_ID")
                or ""
            ).strip(),
            worker_ticket_secret=_optional_string("WORKER_TICKET_SECRET"),
            require_worker_ticket=_bool("REQUIRE_WORKER_TICKET", True),
            worker_admin_secret=_optional_string("WORKER_ADMIN_SECRET"),
            draining=_bool("DRAINING", False),
            models_lock_path=Path(
                os.getenv("MODELS_LOCK_PATH", DEFAULT_MODELS_LOCK_PATH)
            ),
            service_profile=os.getenv("SERVICE_PROFILE", "production"),
            sample_rate=int(os.getenv("SAMPLE_RATE", "16000")),
            max_sessions=int(os.getenv("MAX_SESSIONS", "32")),
            session_start_timeout_seconds=(
                _optional_positive_float("SESSION_START_TIMEOUT_SECONDS") or 10.0
            ),
            max_pcm_frame_ms=_integer_at_least("MAX_PCM_FRAME_MS", 1_000, 20),
            max_stream_audio_seconds=_positive_float(
                "MAX_STREAM_AUDIO_SECONDS", 14_400.0
            ),
            max_audio_lead_seconds=_positive_float("MAX_AUDIO_LEAD_SECONDS", 5.0),
            max_session_seconds=_positive_float("MAX_SESSION_SECONDS", 14_700.0),
            max_session_jobs=_integer_at_least("MAX_SESSION_JOBS", 8, 1),
            max_session_events=_integer_at_least("MAX_SESSION_EVENTS", 32, 1),
            chunk_seconds=float(os.getenv("CHUNK_SECONDS", "1.0")),
            max_utterance_seconds=float(os.getenv("MAX_UTTERANCE_SECONDS", "20.0")),
            vad_end_silence_ms=int(os.getenv("VAD_END_SILENCE_MS", "480")),
            vad_threshold=float(os.getenv("VAD_THRESHOLD", "0.5")),
            rollback_tokens=int(os.getenv("ROLLBACK_TOKENS", "5")),
            partial_max_new_tokens=int(os.getenv("PARTIAL_MAX_NEW_TOKENS", "32")),
            final_max_new_tokens=int(os.getenv("FINAL_MAX_NEW_TOKENS", "512")),
            batch_window_ms=int(os.getenv("BATCH_WINDOW_MS", "15")),
            batch_size=int(os.getenv("BATCH_SIZE", "32")),
            scheduler_queue_size=_integer_at_least("SCHEDULER_QUEUE_SIZE", 64, 1),
            scheduler_max_concurrent_batches=_integer_at_least(
                "SCHEDULER_MAX_CONCURRENT_BATCHES", 2, 1
            ),
            label_delay_ms=int(os.getenv("LABEL_DELAY_MS", "320")),
            diarizer_interval_ms=int(os.getenv("DIARIZER_INTERVAL_MS", "500")),
            final_diarization_timeout_seconds=(
                _optional_positive_float("FINAL_DIARIZATION_TIMEOUT_SECONDS") or 4.0
            ),
            diarizer_request_timeout_seconds=_positive_float(
                "DIARIZER_REQUEST_TIMEOUT_SECONDS", 4.0
            ),
            diarizer_cleanup_timeout_seconds=_positive_float(
                "DIARIZER_CLEANUP_TIMEOUT_SECONDS", 0.5
            ),
            context_top_k=int(os.getenv("CONTEXT_TOP_K", "20")),
            context_max_updates=int(os.getenv("CONTEXT_MAX_UPDATES", "2")),
            catalog_path=Path(os.getenv("CATALOG_PATH", DEFAULT_CATALOG_PATH)),
            asr_backend=os.getenv("ASR_BACKEND", "fake"),
            asr_model=os.getenv("ASR_MODEL", DEFAULT_ASR_MODEL),
            asr_dtype=os.getenv("ASR_DTYPE", "bfloat16"),
            aligner_model=os.getenv("ALIGNER_MODEL", DEFAULT_ALIGNER_MODEL),
            diarizer_backend=os.getenv("DIARIZER_BACKEND", "energy"),
            diarizer_model=os.getenv("DIARIZER_MODEL", DEFAULT_DIARIZER_MODEL),
            diarizer_url=os.getenv("DIARIZER_URL", "http://127.0.0.1:18001/diarize"),
            gpu_memory_utilization=float(os.getenv("GPU_MEMORY_UTILIZATION", "0.72")),
            enable_aligner=_bool("ENABLE_ALIGNER", True),
            compile_aligner=_bool("COMPILE_ALIGNER", True),
            warmup_aligner=_bool("WARMUP_ALIGNER", True),
            reject_catalog_revision_mismatch=_bool("REJECT_CATALOG_REVISION_MISMATCH", True),
        )
