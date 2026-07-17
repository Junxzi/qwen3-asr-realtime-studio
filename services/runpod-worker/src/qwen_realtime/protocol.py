from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SessionStart(StrictModel):
    type: Literal["session.start"]
    session_id: Annotated[str, Field(min_length=1, max_length=128)]
    model_id: Annotated[str, Field(min_length=1, max_length=256)]
    connection_ticket: Annotated[str, Field(min_length=1, max_length=4096)] | None = None
    sample_rate: Literal[16000]
    encoding: Literal["pcm_s16le"]
    catalog_revision: Annotated[str, Field(min_length=1, max_length=128)]

    @field_validator("session_id", "model_id", "catalog_revision")
    @classmethod
    def no_control_characters(cls, value: str) -> str:
        if any(ord(char) < 32 for char in value):
            raise ValueError("control characters are not allowed")
        return value


class WordPayload(StrictModel):
    text: str
    start_ms: int
    end_ms: int
    speaker: str
    confidence: float = Field(ge=0.0, le=1.0)
    overlap: bool


class PartialPayload(StrictModel):
    type: Literal["transcript.partial"] = "transcript.partial"
    utterance_id: str
    revision: int
    stable_text: str
    unstable_text: str
    speaker_hint: str | None
    audio_end_ms: int
    latency_ms: int | None = None
    queue_ms: int | None = None
    rtf: float | None = None


class FinalPayload(StrictModel):
    type: Literal["transcript.final"] = "transcript.final"
    utterance_id: str
    text: str
    words: list[WordPayload]
    context_hits: list[str]
    audio_start_ms: int = Field(default=0, ge=0)
    audio_end_ms: int | None = Field(default=None, ge=0)
    authoritative: bool = True
    latency_ms: int | None = None
    queue_ms: int | None = None
    rtf: float | None = None


class ErrorPayload(StrictModel):
    type: Literal["error"] = "error"
    code: str
    message: str


class SessionCapabilities(StrictModel):
    pipeline_events: bool = True
    input_end: bool = True
    partial_transcripts: bool = True
    speaker_hints: bool = True
    final_word_timestamps: bool = False


class SessionReady(StrictModel):
    type: Literal["session.ready"] = "session.ready"
    session_id: str
    catalog_revision: str
    worker_id: str
    model_id: str
    input_end_supported: bool = True
    pipeline_id: str = "context_realtime_v1"
    capabilities: SessionCapabilities = Field(default_factory=SessionCapabilities)


class PipelineStagePayload(StrictModel):
    type: Literal["pipeline.stage"] = "pipeline.stage"
    seq: int = Field(ge=1)
    pipeline_id: Annotated[str, Field(min_length=1, max_length=128)]
    utterance_id: Annotated[str, Field(min_length=1, max_length=256)]
    stage: Literal[
        "audio_ingest",
        "vad",
        "context_asr",
        "streaming_sortformer",
        "endpoint",
        "lab_finalizer",
        "replace_result",
        "persist",
    ]
    status: Literal[
        "queued",
        "running",
        "completed",
        "fallback",
        "failed",
        "skipped",
    ]
    audio_end_ms: int | None = Field(default=None, ge=0)
    elapsed_ms: int | None = Field(default=None, ge=0)
    detail_code: Annotated[str, Field(min_length=1, max_length=64)] | None = None


class InputEnd(StrictModel):
    type: Literal["input.end"]


class StreamFinalized(StrictModel):
    type: Literal["stream.finalized"] = "stream.finalized"
    session_id: str


class ModelLoadRequest(StrictModel):
    model_id: Annotated[str, Field(min_length=1, max_length=256)]


class DrainRequest(StrictModel):
    draining: bool = True
