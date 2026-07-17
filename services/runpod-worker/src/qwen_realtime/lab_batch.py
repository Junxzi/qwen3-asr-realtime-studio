from __future__ import annotations

import asyncio
import importlib
import inspect
import logging
import os
import re
import sys
import tempfile
import time
import wave
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from fastapi import FastAPI, File, Form, Header, Query, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .gpu import gpu_telemetry
from .metrics import (
    LAB_BATCH_ACTIVE,
    LAB_BATCH_INFERENCE_LATENCY,
    LAB_BATCH_REQUESTS,
    LAB_BATCH_UPLOAD_BYTES,
)
from .security import (
    WorkerTicketError,
    bearer_secret,
    secrets_match,
    verify_worker_ticket,
    verify_worker_ticket_envelope,
)

DEFAULT_LAB_MODEL_ID = "infodeliverailab/lab_asr_diarization_v1"
DEFAULT_LAB_REPO_REVISION = "651c6d0f303557332293afa9fa15e1dd30456606"
_SPEAKER_MARKER = re.compile(r"(?:<\|spk_(\d+)\|>|\[spk_(\d+)\])", re.IGNORECASE)
_SPECIAL_TOKEN = re.compile(r"<\|[^|<>]{1,128}\|>")
_ASR_TEXT_START = re.compile(r"<asr_text>", re.IGNORECASE)
_ASR_TEXT_END = re.compile(r"</asr_text>", re.IGNORECASE)
_WHITESPACE = re.compile(r"\s+")
_MODEL_PROLOGUE = re.compile(r"^(?:(?:system|user|assistant)\s*)+", re.IGNORECASE)
logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class LabBatchSettings:
    worker_id: str = "lab-batch-worker"
    model_id: str = DEFAULT_LAB_MODEL_ID
    repo_path: Path = Path("/workspace/lab-asr-poc/lab_asr_diarization_v1")
    module_name: str = "infer_single"
    backend_factory: str | None = None
    worker_ticket_secret: str | None = None
    require_worker_ticket: bool = True
    worker_admin_secret: str | None = None
    max_upload_bytes: int = 256 * 1024 * 1024
    max_audio_seconds: float = 120.0
    default_max_new_tokens: int = 800
    hard_max_new_tokens: int = 1024
    max_request_overhead_bytes: int = 1024 * 1024
    temp_dir: Path = Path("/tmp/infodeliver-lab-batch")
    temp_max_age_seconds: float = 3600.0
    allowed_origins: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.max_upload_bytes < 1 or self.max_request_overhead_bytes < 0:
            raise ValueError("batch request byte limits must be non-negative")
        if self.max_audio_seconds <= 0 or self.temp_max_age_seconds <= 0:
            raise ValueError("batch duration limits must be greater than zero")
        if not 1 <= self.default_max_new_tokens <= self.hard_max_new_tokens <= 1024:
            raise ValueError("batch token limits must satisfy 1 <= default <= hard <= 1024")
        if "*" in self.allowed_origins:
            raise ValueError("LAB_ALLOWED_ORIGINS must list exact origins; wildcard is forbidden")

    @classmethod
    def from_env(cls) -> LabBatchSettings:
        factory = os.getenv("LAB_BACKEND_FACTORY", "").strip() or None
        allowed_origins = tuple(
            origin.strip()
            for origin in os.getenv("LAB_ALLOWED_ORIGINS", "").split(",")
            if origin.strip()
        )
        if "*" in allowed_origins:
            raise ValueError("LAB_ALLOWED_ORIGINS must list exact origins; wildcard is forbidden")
        return cls(
            worker_id=(
                os.getenv("WORKER_ID")
                or os.getenv("RUNPOD_POD_ID")
                or ""
            ).strip(),
            model_id=os.getenv("MODEL_ID", DEFAULT_LAB_MODEL_ID).strip(),
            repo_path=Path(
                os.getenv(
                    "LAB_REPO_PATH",
                    "/workspace/lab-asr-poc/lab_asr_diarization_v1",
                )
            ),
            module_name=os.getenv("LAB_INFERENCE_MODULE", "infer_single").strip(),
            backend_factory=factory,
            worker_ticket_secret=os.getenv("WORKER_TICKET_SECRET", "").strip() or None,
            require_worker_ticket=os.getenv("REQUIRE_WORKER_TICKET", "true").lower()
            not in {"0", "false", "no"},
            worker_admin_secret=os.getenv("WORKER_ADMIN_SECRET", "").strip() or None,
            max_upload_bytes=int(os.getenv("LAB_MAX_UPLOAD_BYTES", str(256 * 1024 * 1024))),
            max_audio_seconds=float(os.getenv("LAB_MAX_AUDIO_SECONDS", "120")),
            default_max_new_tokens=int(os.getenv("LAB_DEFAULT_MAX_NEW_TOKENS", "800")),
            hard_max_new_tokens=min(
                1024,
                int(os.getenv("LAB_HARD_MAX_NEW_TOKENS", "1024")),
            ),
            max_request_overhead_bytes=int(
                os.getenv("LAB_MAX_REQUEST_OVERHEAD_BYTES", str(1024 * 1024))
            ),
            temp_dir=Path(
                os.getenv("LAB_TEMP_DIR", "/tmp/infodeliver-lab-batch")
            ),
            temp_max_age_seconds=float(
                os.getenv("LAB_TEMP_MAX_AGE_SECONDS", "3600")
            ),
            allowed_origins=allowed_origins,
        )


@dataclass(frozen=True, slots=True)
class LabInferenceResult:
    text: str
    duration_seconds: float | None = None


class LabBackend(Protocol):
    def load(self) -> None: ...

    def transcribe(self, audio_path: Path, max_new_tokens: int) -> LabInferenceResult: ...


class KnownLabDiarizationBackend:
    """Persistent implementation of the private v1 repository's CLI pipeline."""

    _SPECIAL = [
        "<|sc|>",
        "<|semantic_start|>",
        "<|speaker_start|>",
        *(f"<|spk_{index}|>" for index in range(8)),
    ]

    def __init__(self, repo_path: Path) -> None:
        self.repo_path = repo_path
        self._torch: object | None = None
        self._librosa: object | None = None
        self._processor: object | None = None
        self._model: object | None = None
        self._encoder: object | None = None
        self._device = os.getenv("LAB_DEVICE", "cuda:0")
        self._dtype: object | None = None

    def load(self) -> None:
        if self._model is not None:
            return
        if not self.repo_path.is_dir():
            raise RuntimeError(f"LAB_REPO_PATH does not exist: {self.repo_path}")
        repo = str(self.repo_path.resolve())
        code_dir = str((self.repo_path / "code").resolve())
        for import_path in (repo, code_dir):
            if import_path not in sys.path:
                sys.path.insert(0, import_path)
        try:
            import librosa
            import torch
            from ecapa_qwen_temporal_interleave import (
                ECAPAQwenTemporalInterleave,
                ECAPASlidingWindowEncoder,
            )
            from qwen_asr import Qwen3ASRModel
            from speechbrain.inference.speaker import EncoderClassifier
        except ImportError as exc:
            raise RuntimeError(
                "the lab repository environment is incomplete; run its setup.sh first"
            ) from exc

        if not torch.cuda.is_available() and self._device.startswith("cuda"):
            raise RuntimeError("lab_asr_diarization_v1 requires a CUDA worker")
        dtype_name = os.getenv("LAB_DTYPE", "bfloat16").lower()
        dtype = torch.float16 if dtype_name == "float16" else torch.bfloat16
        base_model = Path(
            os.getenv("BASE_MODEL_DIR", str(self.repo_path.parent / "base_model"))
        )
        checkpoint_path = Path(
            os.getenv("LAB_CHECKPOINT_PATH", str(self.repo_path / "weights" / "interleave.pt"))
        )
        ecapa_dir = Path(
            os.getenv(
                "LAB_ECAPA_DIR",
                str(self.repo_path.parent / "pretrained_ecapa"),
            )
        )
        if not base_model.exists():
            raise RuntimeError(f"BASE_MODEL_DIR does not exist: {base_model}")
        if not checkpoint_path.is_file():
            raise RuntimeError(f"LAB_CHECKPOINT_PATH does not exist: {checkpoint_path}")
        if not ecapa_dir.is_dir():
            raise RuntimeError(f"LAB_ECAPA_DIR does not exist: {ecapa_dir}")

        wrapped = Qwen3ASRModel.from_pretrained(
            str(base_model),
            dtype=dtype,
            device_map=self._device,
        )
        qwen = wrapped.model
        processor = wrapped.processor
        added = processor.tokenizer.add_special_tokens(
            {"additional_special_tokens": self._SPECIAL}
        )
        if added:
            qwen.thinker.resize_token_embeddings(
                len(processor.tokenizer),
                mean_resizing=True,
            )
        classifier = EncoderClassifier.from_hparams(
            source=str(ecapa_dir),
            savedir=str(ecapa_dir / ".speechbrain-runtime"),
            run_opts={"device": self._device},
        )
        encoder = ECAPASlidingWindowEncoder(
            classifier,
            sample_rate=16_000,
            window_seconds=1.5,
            stride_seconds=0.08,
            infer_batch_size=int(os.getenv("LAB_ECAPA_BATCH", "256")),
        )
        with torch.no_grad():
            ecapa_dim = int(encoder(torch.zeros(16_000, device=self._device)).shape[-1])
        speaker_tokens_per_block = int(os.getenv("LAB_SPEAKER_TOKENS_PER_BLOCK", "4"))
        model = ECAPAQwenTemporalInterleave(
            qwen_model=qwen,
            ecapa_encoder=encoder,
            tokenizer=processor.tokenizer,
            ecapa_dim=ecapa_dim,
            block_seconds=float(os.getenv("LAB_BLOCK_SECONDS", "1.2")),
            speaker_tokens_per_block=speaker_tokens_per_block,
        ).to(self._device)
        checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
        speaker_adapter = checkpoint.get("speaker_adapter")
        if speaker_adapter and speaker_tokens_per_block > 0:
            model.speaker_adapter.load_state_dict(speaker_adapter, strict=False)
        qwen_trainable = checkpoint.get("qwen_trainable")
        if qwen_trainable:
            model.qwen.load_state_dict(qwen_trainable, strict=False)
        model.eval()

        self._torch = torch
        self._librosa = librosa
        self._processor = processor
        self._model = model
        self._encoder = encoder
        self._dtype = dtype

    def _build_prefix(self) -> str:
        processor = self._processor
        messages = [
            {"role": "system", "content": ""},
            {
                "role": "user",
                "content": [{"type": "audio", "audio": None}],
            },
        ]
        return processor.apply_chat_template(  # type: ignore[union-attr]
            [messages],
            add_generation_prompt=True,
            tokenize=False,
        )[0]

    def transcribe(self, audio_path: Path, max_new_tokens: int) -> LabInferenceResult:
        if any(
            value is None
            for value in (
                self._torch,
                self._librosa,
                self._processor,
                self._model,
                self._encoder,
                self._dtype,
            )
        ):
            raise RuntimeError("lab backend is not loaded")
        torch = self._torch
        librosa = self._librosa
        processor = self._processor
        model = self._model
        encoder = self._encoder
        dtype = self._dtype
        waveform_numpy, _ = librosa.load(str(audio_path), sr=16_000, mono=True)  # type: ignore[union-attr]
        inputs = processor(  # type: ignore[operator]
            text=[self._build_prefix()],
            audio=[waveform_numpy],
            return_tensors="pt",
            padding=True,
            truncation=False,
        )
        input_ids = inputs["input_ids"].to(self._device)
        attention_mask = inputs["attention_mask"].to(self._device)
        input_features = inputs["input_features"].to(self._device, dtype=dtype)
        feature_attention_mask = inputs["feature_attention_mask"].to(self._device)
        waveform = torch.from_numpy(waveform_numpy).to(self._device)  # type: ignore[union-attr]
        with torch.no_grad():  # type: ignore[union-attr]
            semantic = model._semantic_features(input_features, feature_attention_mask)
            ecapa = encoder(waveform)
            speaker = model.speaker_adapter(
                ecapa.to(next(model.speaker_adapter.parameters()).device)
            )
            speaker = speaker.to(device=semantic.device, dtype=semantic.dtype)
            duration = waveform.shape[-1] / 16_000.0
            embeds, mask, _, _ = model._build_interleaved_inputs(
                input_ids=input_ids,
                attention_mask=attention_mask,
                semantic=semantic,
                speaker=speaker,
                duration_seconds=duration,
                labels=None,
            )
            generated = model.thinker.generate(
                inputs_embeds=embeds,
                attention_mask=mask,
                max_new_tokens=max_new_tokens,
                do_sample=False,
                num_beams=1,
                pad_token_id=processor.tokenizer.pad_token_id,
                eos_token_id=processor.tokenizer.eos_token_id,
            )
        raw = processor.tokenizer.decode(generated[0], skip_special_tokens=False)
        return LabInferenceResult(text=raw, duration_seconds=duration)

    def duration_seconds(self, audio_path: Path) -> float:
        if self._librosa is None:
            raise RuntimeError("lab backend is not loaded")
        return float(self._librosa.get_duration(path=str(audio_path)))  # type: ignore[union-attr]


def _resolve_attribute(module: object, dotted_name: str) -> object:
    value = module
    for part in dotted_name.split("."):
        value = getattr(value, part)
    return value


class RepositoryLabBackend:
    """Persistent adapter for the private repository's importable inference API.

    The repository is imported exactly once during FastAPI lifespan.  For repos
    whose CLI does not expose a reusable API, LAB_BACKEND_FACTORY may name a
    zero-argument factory (``module:function``) returning an object with
    ``transcribe_file``/``transcribe``/``infer_file``/``infer``.
    """

    _TRANSCRIBE_NAMES = (
        "transcribe_file",
        "transcribe",
        "infer_single",
        "infer_file",
        "infer",
        "run_inference",
    )

    def __init__(
        self,
        repo_path: Path,
        module_name: str = "infer_single",
        factory: str | None = None,
    ) -> None:
        self.repo_path = repo_path
        self.module_name = module_name
        self.factory = factory
        self._runner: object | None = None
        self._transcribe: object | None = None

    def load(self) -> None:
        if self._transcribe is not None:
            return
        if not self.repo_path.is_dir():
            raise RuntimeError(f"LAB_REPO_PATH does not exist: {self.repo_path}")
        repo = str(self.repo_path.resolve())
        if repo not in sys.path:
            sys.path.insert(0, repo)

        module_name = self.module_name
        factory_name: str | None = None
        if self.factory:
            module_name, separator, factory_name = self.factory.partition(":")
            if not separator or not module_name or not factory_name:
                raise RuntimeError("LAB_BACKEND_FACTORY must use module:function syntax")
        module = importlib.import_module(module_name)
        runner: object = module
        if factory_name:
            factory = _resolve_attribute(module, factory_name)
            if not callable(factory):
                raise RuntimeError("LAB_BACKEND_FACTORY does not resolve to a callable")
            runner = factory()
        else:
            for name in ("create_backend", "build_backend", "load_backend"):
                candidate = getattr(module, name, None)
                if callable(candidate):
                    runner = candidate()
                    break

        transcribe = None
        for owner in (runner, module):
            for name in self._TRANSCRIBE_NAMES:
                candidate = getattr(owner, name, None)
                if callable(candidate):
                    transcribe = candidate
                    break
            if transcribe is not None:
                break
        if transcribe is None and callable(runner) and runner is not module:
            transcribe = runner
        if transcribe is None:
            raise RuntimeError(
                "the lab repository exposes no persistent inference callable; "
                "set LAB_BACKEND_FACTORY=module:function to an adapter factory"
            )
        self._runner = runner
        self._transcribe = transcribe

    def transcribe(self, audio_path: Path, max_new_tokens: int) -> LabInferenceResult:
        if self._transcribe is None:
            raise RuntimeError("lab backend is not loaded")
        function = self._transcribe
        signature = inspect.signature(function)
        parameters = signature.parameters
        kwargs: dict[str, object] = {}
        path_parameter = next(
            (
                name
                for name in ("audio_path", "file_path", "path", "audio", "filename")
                if name in parameters
            ),
            None,
        )
        if path_parameter is not None:
            kwargs[path_parameter] = str(audio_path)
            args: tuple[object, ...] = ()
        else:
            args = (str(audio_path),)
        if "max_new_tokens" in parameters:
            kwargs["max_new_tokens"] = max_new_tokens
        raw = function(*args, **kwargs)
        if inspect.isawaitable(raw):
            raw = asyncio.run(raw)
        return _coerce_inference_result(raw)


def _coerce_inference_result(raw: object) -> LabInferenceResult:
    if isinstance(raw, LabInferenceResult):
        return raw
    if isinstance(raw, str):
        return LabInferenceResult(raw)
    if isinstance(raw, dict):
        text = next(
            (raw.get(key) for key in ("text", "transcript", "output") if raw.get(key)),
            None,
        )
        if not isinstance(text, str):
            raise RuntimeError("lab inference result contains no text")
        duration = raw.get("duration_seconds", raw.get("duration"))
        return LabInferenceResult(
            text=text,
            duration_seconds=float(duration) if isinstance(duration, (int, float)) else None,
        )
    if isinstance(raw, (tuple, list)) and raw and isinstance(raw[0], str):
        duration = raw[1] if len(raw) > 1 else None
        return LabInferenceResult(
            raw[0],
            float(duration) if isinstance(duration, (int, float)) else None,
        )
    raise RuntimeError("lab inference returned an unsupported result type")


def _clean_text(value: str) -> str:
    without_wrappers = _ASR_TEXT_END.sub(" ", value)
    return _WHITESPACE.sub(" ", _SPECIAL_TOKEN.sub(" ", without_wrappers)).strip()


def _clean_model_prefix(value: str) -> str:
    return _MODEL_PROLOGUE.sub("", _clean_text(value)).strip()


def parse_speaker_transcript(text: str) -> list[tuple[str, str]]:
    """Normalize both private-model speaker syntaxes without leaking special tokens."""

    start = _ASR_TEXT_START.search(text)
    if start:
        text = text[start.end() :]
    matches = list(_SPEAKER_MARKER.finditer(text))
    if not matches:
        cleaned = _clean_model_prefix(text)
        return [("speaker_0", cleaned)] if cleaned else []
    segments: list[tuple[str, str]] = []
    prefix = _clean_model_prefix(text[: matches[0].start()])
    if prefix:
        segments.append(("speaker_0", prefix))
    arrival_order: dict[int, int] = {}
    for index, match in enumerate(matches):
        raw_speaker = int(match.group(1) or match.group(2))
        if raw_speaker not in arrival_order:
            arrival_order[raw_speaker] = min(len(arrival_order), 1)
        speaker = f"speaker_{arrival_order[raw_speaker]}"
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        cleaned = _clean_text(text[match.end() : end])
        if not cleaned:
            continue
        if segments and segments[-1][0] == speaker:
            segments[-1] = (speaker, f"{segments[-1][1]} {cleaned}")
        else:
            segments.append((speaker, cleaned))
    return segments


def _wav_duration(path: Path) -> float | None:
    try:
        with wave.open(str(path), "rb") as audio:
            rate = audio.getframerate()
            return audio.getnframes() / rate if rate > 0 else None
    except (wave.Error, EOFError, OSError):
        return None


def cleanup_stale_temp_files(
    temp_dir: Path,
    max_age_seconds: float,
    *,
    now: float | None = None,
) -> int:
    """Remove only this worker's abandoned regular files from non-persistent temp."""

    cutoff = (time.time() if now is None else now) - max_age_seconds
    removed = 0
    for candidate in temp_dir.glob("lab-*"):
        try:
            if candidate.is_symlink() or not candidate.is_file():
                continue
            if candidate.stat().st_mtime > cutoff:
                continue
            candidate.unlink()
            removed += 1
        except FileNotFoundError:
            continue
        except OSError:
            logger.warning("failed to remove stale batch temp file", exc_info=True)
    return removed


def _utterance_payloads(
    segments: list[tuple[str, str]],
    duration_seconds: float | None,
) -> list[dict[str, object]]:
    weights = [max(1, len(text)) for _, text in segments]
    total_weight = sum(weights)
    duration_ms = round(duration_seconds * 1000) if duration_seconds is not None else 0
    cursor = 0
    payloads: list[dict[str, object]] = []
    for index, ((speaker, text), weight) in enumerate(zip(segments, weights, strict=True)):
        end = (
            duration_ms
            if index == len(segments) - 1
            else round(duration_ms * (cursor + weight) / total_weight)
        )
        payloads.append(
            {
                "utterance_id": f"batch-{index + 1}",
                "text": text,
                "speaker": speaker,
                "start_ms": round(duration_ms * cursor / total_weight),
                "end_ms": end,
                "timing_source": "proportional_estimate",
            }
        )
        cursor += weight
    return payloads


class _SingleCapacity:
    def __init__(self) -> None:
        self._token: asyncio.Queue[None] = asyncio.Queue(maxsize=1)
        self._token.put_nowait(None)

    @property
    def active(self) -> int:
        return 0 if self._token.qsize() else 1

    def acquire_nowait(self) -> bool:
        try:
            self._token.get_nowait()
        except asyncio.QueueEmpty:
            return False
        return True

    def release(self) -> None:
        if self._token.empty():
            self._token.put_nowait(None)


@dataclass(slots=True)
class _LabRuntime:
    settings: LabBatchSettings
    backend: LabBackend
    capacity: _SingleCapacity
    loaded: bool = False
    load_error: str | None = None
    draining: bool = False
    real_backend: bool = True


def _error(status: int, code: str, message: str, **headers: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"error": message, "code": code},
        headers=headers,
    )


def _strong_secret(value: str | None) -> bool:
    return value is not None and len(value.encode("utf-8")) >= 32


class _BodyLimitExceeded(Exception):
    pass


class _BatchRequestGuard:
    """Reject oversized or unauthenticated uploads before multipart parsing."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        runtime: _LabRuntime,
    ) -> None:
        self.app = app
        self.runtime = runtime
        self.settings = runtime.settings
        self.real_backend = runtime.real_backend
        self.maximum_body_bytes = (
            self.settings.max_upload_bytes
            + self.settings.max_request_overhead_bytes
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or scope.get("method") != "POST"
            or scope.get("path") != "/v1/audio/transcriptions"
        ):
            await self.app(scope, receive, send)
            return
        headers = {
            key.decode("latin-1").lower(): value.decode("latin-1")
            for key, value in scope.get("headers", [])
        }
        content_length = headers.get("content-length")
        if content_length is not None:
            try:
                declared_bytes = int(content_length)
            except ValueError:
                response = _error(400, "invalid_content_length", "Content-Length is invalid")
                await response(scope, receive, send)
                return
            if declared_bytes < 0 or declared_bytes > self.maximum_body_bytes:
                response = _error(
                    413,
                    "request_too_large",
                    "the multipart request exceeds the configured limit",
                )
                await response(scope, receive, send)
                return

        ticket = bearer_secret(headers.get("authorization"))
        ticket_required = self.settings.require_worker_ticket or self.real_backend
        if self.real_backend and not _strong_secret(self.settings.worker_admin_secret):
            response = _error(
                503,
                "worker_auth_misconfigured",
                "worker administration authentication is not securely configured",
            )
            await response(scope, receive, send)
            return
        claims = None
        if ticket_required or ticket is not None:
            if not _strong_secret(self.settings.worker_ticket_secret):
                response = _error(
                    503,
                    "worker_auth_misconfigured",
                    "ticket verification is not securely configured",
                )
                await response(scope, receive, send)
                return
            if ticket is None:
                response = _error(401, "connection_ticket_required", "a batch ticket is required")
                await response(scope, receive, send)
                return
            try:
                claims = verify_worker_ticket_envelope(
                    ticket,
                    secret=self.settings.worker_ticket_secret,
                    worker_id=self.settings.worker_id,
                    purpose="batch",
                )
            except WorkerTicketError:
                response = _error(
                    403,
                    "invalid_connection_ticket",
                    "batch ticket is invalid or expired",
                )
                await response(scope, receive, send)
                return

        if not self.runtime.loaded or self.runtime.load_error is not None:
            response = _error(503, "worker_not_ready", "the resident model is not ready")
            await response(scope, receive, send)
            return
        if self.runtime.draining:
            response = _error(503, "worker_draining", "this worker is draining")
            await response(scope, receive, send)
            return
        if claims is not None and claims.get("mid") != self.settings.model_id:
            response = _error(409, "model_unavailable", "the requested model is not resident")
            await response(scope, receive, send)
            return
        if not self.runtime.capacity.acquire_nowait():
            response = _error(
                429,
                "capacity_exceeded",
                "the batch worker is busy",
                **{"Retry-After": "1"},
            )
            await response(scope, receive, send)
            return
        scope.setdefault("state", {})["batch_capacity_acquired"] = True
        LAB_BATCH_ACTIVE.inc()

        consumed = 0

        async def limited_receive() -> Message:
            nonlocal consumed
            message = await receive()
            if message["type"] == "http.request":
                consumed += len(message.get("body", b""))
                if consumed > self.maximum_body_bytes:
                    raise _BodyLimitExceeded
            return message

        try:
            try:
                await self.app(scope, limited_receive, send)
            except _BodyLimitExceeded:
                response = _error(
                    413,
                    "request_too_large",
                    "the multipart request exceeds the configured limit",
                )
                await response(scope, receive, send)
        finally:
            LAB_BATCH_ACTIVE.dec()
            self.runtime.capacity.release()


def create_lab_batch_app(
    settings: LabBatchSettings | None = None,
    backend: LabBackend | None = None,
) -> FastAPI:
    configured = settings or LabBatchSettings.from_env()
    if "*" in configured.allowed_origins:
        raise ValueError("LAB_ALLOWED_ORIGINS must list exact origins; wildcard is forbidden")
    selected_backend: LabBackend
    if backend is not None:
        selected_backend = backend
    elif configured.backend_factory:
        selected_backend = RepositoryLabBackend(
            configured.repo_path,
            configured.module_name,
            configured.backend_factory,
        )
    elif configured.model_id == DEFAULT_LAB_MODEL_ID:
        selected_backend = KnownLabDiarizationBackend(configured.repo_path)
    else:
        selected_backend = RepositoryLabBackend(
            configured.repo_path,
            configured.module_name,
        )
    runtime = _LabRuntime(
        settings=configured,
        backend=selected_backend,
        capacity=_SingleCapacity(),
        real_backend=backend is None,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        try:
            configured.temp_dir.mkdir(parents=True, exist_ok=True)
            await asyncio.to_thread(
                cleanup_stale_temp_files,
                configured.temp_dir,
                configured.temp_max_age_seconds,
            )
            await asyncio.to_thread(runtime.backend.load)
            runtime.loaded = True
        except Exception as exc:
            runtime.load_error = str(exc)
            logger.exception("lab batch model preload failed")
        yield

    app = FastAPI(title="InfoDeliver Lab ASR Batch Worker", version="0.2.0", lifespan=lifespan)
    app.state.runtime = runtime
    app.add_middleware(
        _BatchRequestGuard,
        runtime=runtime,
    )
    if configured.allowed_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(configured.allowed_origins),
            allow_credentials=False,
            allow_methods=["GET", "POST", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type"],
        )

    def state(requested_model: str | None = None) -> dict[str, object]:
        ticket_required = configured.require_worker_ticket or runtime.real_backend
        security_configured = (
            not runtime.real_backend
            or _strong_secret(configured.worker_admin_secret)
        ) and (
            not ticket_required
            or _strong_secret(configured.worker_ticket_secret)
        )
        model_match = requested_model is None or requested_model == configured.model_id
        accepting = (
            runtime.loaded
            and runtime.load_error is None
            and model_match
            and not runtime.draining
            and runtime.capacity.active < 1
            and security_configured
            and bool(configured.worker_id)
        )
        return {
            "worker_id": configured.worker_id,
            "model_id": configured.model_id,
            "model_loaded": runtime.loaded,
            "model_match": model_match,
            "load_failed": runtime.load_error is not None,
            "active_sessions": runtime.capacity.active,
            "max_sessions": 1,
            "draining": runtime.draining,
            "security_configured": security_configured,
            "catalog_required": False,
            "catalog_ready": True,
            "accepting_sessions": accepting,
        }

    @app.get("/")
    async def root() -> dict[str, object]:
        return {"service": "infodeliver-lab-asr-batch-worker", **state()}

    @app.get("/health")
    async def health() -> dict[str, object]:
        return {"status": "ok", "service": "infodeliver-lab-asr-batch-worker", **state()}

    @app.get("/healthz")
    async def healthz() -> dict[str, object]:
        telemetry = await asyncio.to_thread(gpu_telemetry)
        return {
            "status": "ok",
            "runtime": "batch",
            "inference_mode": "real" if runtime.real_backend else "development",
            "backend": "lab_repository",
            "accelerator": telemetry.get("accelerator", "local CPU"),
            "repo_path_name": configured.repo_path.name,
            "max_new_tokens": {
                "default": configured.default_max_new_tokens,
                "hard_limit": configured.hard_max_new_tokens,
            },
            "max_audio_seconds": configured.max_audio_seconds,
            **telemetry,
            **state(),
        }

    @app.get("/metrics")
    async def metrics() -> Response:
        return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)

    @app.get("/ready")
    async def ready(
        model_id: str | None = Query(default=None, min_length=1, max_length=256),
    ) -> JSONResponse:
        payload = state(model_id)
        is_ready = bool(payload["accepting_sessions"])
        return JSONResponse(
            status_code=200 if is_ready else 503,
            content={"status": "ready" if is_ready else "not_ready", **payload},
        )

    @app.post("/admin/drain")
    async def drain(
        request: Request,
        authorization: str | None = Header(default=None),
    ) -> JSONResponse:
        presented = bearer_secret(authorization)
        if not _strong_secret(configured.worker_admin_secret):
            return _error(503, "admin_auth_not_configured", "admin authentication is not configured")
        if presented is None:
            return _error(401, "admin_auth_required", "Bearer authentication is required")
        if not secrets_match(presented, configured.worker_admin_secret):
            return _error(403, "admin_auth_invalid", "admin authentication failed")
        payload = await request.json()
        runtime.draining = bool(payload.get("draining", True))
        return JSONResponse({"status": "draining" if runtime.draining else "accepting", **state()})

    @app.post("/v1/audio/transcriptions")
    async def transcriptions(
        request: Request,
        audio: UploadFile = File(...),
        session_id: str = Form(..., min_length=1, max_length=128),
        model_id: str = Form(..., min_length=1, max_length=256),
        utterance_id: str | None = Form(default=None, min_length=1, max_length=256),
        max_new_tokens: int = Form(default=configured.default_max_new_tokens, ge=1),
        authorization: str | None = Header(default=None),
    ) -> JSONResponse:
        if model_id != configured.model_id:
            return _error(409, "model_unavailable", "the requested model is not resident")
        if max_new_tokens > configured.hard_max_new_tokens:
            return _error(
                422,
                "max_new_tokens_exceeded",
                f"max_new_tokens may not exceed {configured.hard_max_new_tokens}",
            )
        ticket = bearer_secret(authorization)
        ticket_required = configured.require_worker_ticket or runtime.real_backend
        if ticket_required or ticket is not None:
            if not _strong_secret(configured.worker_ticket_secret):
                return _error(
                    503,
                    "worker_auth_misconfigured",
                    "ticket verification is not securely configured",
                )
            if ticket is None:
                return _error(401, "connection_ticket_required", "a batch ticket is required")
            try:
                verify_worker_ticket(
                    ticket,
                    secret=configured.worker_ticket_secret,
                    worker_id=configured.worker_id,
                    session_id=session_id,
                    model_id=model_id,
                    purpose="batch",
                )
            except WorkerTicketError:
                return _error(403, "invalid_connection_ticket", "batch ticket is invalid or expired")
        if not runtime.loaded or runtime.load_error is not None:
            return _error(503, "worker_not_ready", "the resident model is not ready")
        if runtime.draining:
            return _error(503, "worker_draining", "this worker is draining")
        temp_path: Path | None = None
        started = time.perf_counter()
        outcome = "rejected"
        try:
            content_length = request.headers.get("content-length")
            if (
                content_length
                and int(content_length)
                > configured.max_upload_bytes + configured.max_request_overhead_bytes
            ):
                return _error(413, "audio_too_large", "the audio upload exceeds the configured limit")
            suffix = Path(audio.filename or "audio.wav").suffix.lower()
            if not re.fullmatch(r"\.[a-z0-9]{1,8}", suffix):
                suffix = ".audio"
            descriptor, raw_path = tempfile.mkstemp(
                prefix="lab-",
                suffix=suffix,
                dir=configured.temp_dir,
            )
            os.close(descriptor)
            temp_path = Path(raw_path)
            uploaded = 0
            with temp_path.open("wb") as destination:
                while chunk := await audio.read(1024 * 1024):
                    uploaded += len(chunk)
                    if uploaded > configured.max_upload_bytes:
                        return _error(413, "audio_too_large", "the audio upload exceeds the configured limit")
                    destination.write(chunk)
            if uploaded == 0:
                return _error(422, "audio_empty", "the audio upload is empty")
            LAB_BATCH_UPLOAD_BYTES.inc(uploaded)

            duration = await asyncio.to_thread(_wav_duration, temp_path)
            if duration is None:
                duration_probe = getattr(runtime.backend, "duration_seconds", None)
                if callable(duration_probe):
                    duration = await asyncio.to_thread(duration_probe, temp_path)
            if duration is not None and duration > configured.max_audio_seconds:
                return _error(
                    413,
                    "audio_duration_exceeded",
                    f"audio may not exceed {configured.max_audio_seconds:g} seconds",
                )

            inference_started = time.perf_counter()
            outcome = "inference_failed"
            try:
                result = await asyncio.to_thread(
                    runtime.backend.transcribe,
                    temp_path,
                    max_new_tokens,
                )
            finally:
                LAB_BATCH_INFERENCE_LATENCY.observe(
                    time.perf_counter() - inference_started
                )
            duration = result.duration_seconds if result.duration_seconds is not None else duration
            if duration is not None and duration > configured.max_audio_seconds:
                return _error(
                    413,
                    "audio_duration_exceeded",
                    f"audio may not exceed {configured.max_audio_seconds:g} seconds",
                )
            segments = parse_speaker_transcript(result.text)
            if not segments:
                return _error(502, "empty_transcript", "the model returned no transcript")
            wall = time.perf_counter() - started
            utterances = _utterance_payloads(segments, duration)
            outcome = "success"
            return JSONResponse(
                {
                    "utterance_id": utterance_id,
                    "text": " ".join(text for _, text in segments),
                    "duration": duration,
                    "wall": wall,
                    "rtf": wall / duration if duration and duration > 0 else None,
                    "turns": [
                        {
                            "speaker": item["speaker"],
                            "text": item["text"],
                            "start_ms": item["start_ms"],
                            "end_ms": item["end_ms"],
                            "timing_source": item["timing_source"],
                        }
                        for item in utterances
                    ],
                    "utterances": utterances,
                }
            )
        except ValueError:
            return _error(400, "invalid_content_length", "Content-Length is invalid")
        except Exception:
            logger.exception("lab batch inference request failed")
            return _error(500, "inference_failed", "batch inference failed")
        finally:
            await audio.close()
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)
            LAB_BATCH_REQUESTS.labels(result=outcome).inc()

    return app


app = create_lab_batch_app()


def main() -> None:
    import uvicorn

    uvicorn.run(
        "qwen_realtime.lab_batch:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8000")),
        workers=1,
    )
