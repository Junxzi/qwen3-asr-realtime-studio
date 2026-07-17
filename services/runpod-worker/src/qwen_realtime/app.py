from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import (
    Depends,
    FastAPI,
    Header,
    Query,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import JSONResponse
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from pydantic import ValidationError

from .asr import FakeASRBackend, QwenAsyncVLLMBackend, QwenVLLMBackend
from .audio import frame_bytes
from .catalog import Catalog, CatalogState, ContextRetriever, load_catalog_state
from .config import Settings
from .diarization import EnergyDiarizer, NeMoSortformerDiarizer, RemoteDiarizer
from .engine import StreamingSession
from .gpu import gpu_telemetry
from .metrics import ACTIVE_SESSIONS, CAPACITY_REJECTIONS, ERRORS
from .models import context_catalog_required, read_models_lock
from .protocol import (
    DrainRequest,
    ErrorPayload,
    InputEnd,
    ModelLoadRequest,
    SessionReady,
    SessionStart,
    StreamFinalized,
)
from .scheduler import BatchingScheduler
from .security import WorkerTicketError, bearer_secret, secrets_match, verify_worker_ticket
from .vad import EnergyVADSession, SileroVADFactory

logger = logging.getLogger(__name__)


class Capacity:
    def __init__(self, limit: int, *, draining: bool = False) -> None:
        self.limit = limit
        self._sessions: set[str] = set()
        self.draining = draining
        self.lock = asyncio.Lock()

    @property
    def active(self) -> int:
        return len(self._sessions)

    async def acquire(self, session_id: str) -> str | None:
        async with self.lock:
            if self.draining:
                return "worker_draining"
            if session_id in self._sessions:
                return "session_already_connected"
            if self.active >= self.limit:
                return "capacity_exceeded"
            self._sessions.add(session_id)
            ACTIVE_SESSIONS.inc()
            return None

    async def release(self, session_id: str) -> None:
        async with self.lock:
            if session_id in self._sessions:
                self._sessions.remove(session_id)
                ACTIVE_SESSIONS.dec()

    async def set_draining(self, draining: bool) -> None:
        async with self.lock:
            self.draining = draining


@dataclass(slots=True)
class Runtime:
    settings: Settings
    catalog: Catalog
    catalog_state: CatalogState
    scheduler: BatchingScheduler
    retriever: ContextRetriever
    diarizer: object
    vad_factory: object
    capacity: Capacity
    model_loaded: bool = False
    model_load_error: str | None = None
    preload_task: asyncio.Task[None] | None = None

    def create_vad(self):
        if isinstance(self.vad_factory, SileroVADFactory):
            return self.vad_factory.create()
        return EnergyVADSession(
            sample_rate=self.settings.sample_rate,
            end_silence_ms=self.settings.vad_end_silence_ms,
        )


class WorkerAPIError(Exception):
    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details


def build_runtime(settings: Settings) -> Runtime:
    selected_model = None
    if settings.asr_backend != "fake":
        selected_model = next(
            (
                entry
                for entry in read_models_lock(settings.models_lock_path)
                if entry["model_id"] == settings.model_id
            ),
            None,
        )
    catalog_state = load_catalog_state(
        settings.catalog_path,
        required=context_catalog_required(
            selected_model,
            asr_backend=settings.asr_backend,
        ),
    )
    catalog = catalog_state.catalog
    if settings.asr_backend == "qwen_async_vllm":
        backend = QwenAsyncVLLMBackend(
            model_path=settings.asr_model,
            aligner_path=settings.aligner_model if settings.enable_aligner else None,
            dtype=settings.asr_dtype,
            gpu_memory_utilization=settings.gpu_memory_utilization,
            max_batch_size=settings.batch_size,
            partial_max_new_tokens=settings.partial_max_new_tokens,
            final_max_new_tokens=settings.final_max_new_tokens,
            compile_aligner=settings.compile_aligner,
            warmup_aligner=settings.warmup_aligner,
        )
    elif settings.asr_backend == "qwen_vllm":
        backend = QwenVLLMBackend(
            model_path=settings.asr_model,
            aligner_path=settings.aligner_model if settings.enable_aligner else None,
            dtype=settings.asr_dtype,
            gpu_memory_utilization=settings.gpu_memory_utilization,
            max_batch_size=settings.batch_size,
            partial_max_new_tokens=settings.partial_max_new_tokens,
            final_max_new_tokens=settings.final_max_new_tokens,
        )
    elif settings.asr_backend == "fake":
        backend = FakeASRBackend()
    else:
        raise ValueError(f"unknown ASR_BACKEND: {settings.asr_backend}")
    if settings.diarizer_backend == "sortformer":
        diarizer = NeMoSortformerDiarizer(settings.diarizer_model)
    elif settings.diarizer_backend == "sortformer_remote":
        diarizer = RemoteDiarizer(
            settings.diarizer_url,
            timeout_seconds=settings.diarizer_request_timeout_seconds,
        )
    elif settings.diarizer_backend == "energy":
        diarizer = EnergyDiarizer()
    else:
        raise ValueError(f"unknown DIARIZER_BACKEND: {settings.diarizer_backend}")
    vad_factory = (
        SileroVADFactory(settings.vad_threshold, settings.vad_end_silence_ms)
        if settings.asr_backend in {"qwen_vllm", "qwen_async_vllm"}
        else object()
    )
    scheduler = BatchingScheduler(
        backend,
        settings.batch_size,
        settings.batch_window_ms,
        max_queue_size=settings.scheduler_queue_size,
        max_concurrent_batches=settings.scheduler_max_concurrent_batches,
    )
    return Runtime(
        settings=settings,
        catalog=catalog,
        catalog_state=catalog_state,
        scheduler=scheduler,
        retriever=ContextRetriever(catalog, settings.context_top_k),
        diarizer=diarizer,
        vad_factory=vad_factory,
        capacity=Capacity(settings.max_sessions, draining=settings.draining),
    )


async def _preload_model(runtime: Runtime) -> None:
    preload_async = getattr(runtime.scheduler.backend, "_ensure_loaded", None)
    preload_sync = getattr(runtime.scheduler.backend, "_load", None)
    try:
        if preload_async is not None:
            await preload_async()
        elif preload_sync is not None:
            await asyncio.to_thread(preload_sync)
        runtime.model_loaded = True
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # pragma: no cover - exercised on GPU deployment
        runtime.model_load_error = f"{type(exc).__name__}: {exc}"
        logger.exception("worker model preload failed")


def _security_configured(settings: Settings) -> bool:
    return bool(settings.worker_admin_secret) and (
        not settings.require_worker_ticket or bool(settings.worker_ticket_secret)
    )


def _state(runtime: Runtime, requested_model_id: str | None = None) -> dict[str, object]:
    requested = requested_model_id or runtime.settings.model_id
    model_match = requested == runtime.settings.model_id
    accepting = (
        runtime.model_loaded
        and runtime.model_load_error is None
        and model_match
        and runtime.catalog_state.ready
        and not runtime.capacity.draining
        and runtime.capacity.active < runtime.capacity.limit
        and _security_configured(runtime.settings)
    )
    return {
        "worker_id": runtime.settings.worker_id,
        "model_id": runtime.settings.model_id,
        "requested_model_id": requested,
        "model_loaded": runtime.model_loaded,
        "model_match": model_match,
        "catalog_required": runtime.catalog_state.required,
        "catalog_ready": runtime.catalog_state.ready,
        "catalog_status": runtime.catalog_state.status,
        "active_sessions": runtime.capacity.active,
        "max_sessions": runtime.capacity.limit,
        "draining": runtime.capacity.draining,
        "accepting_sessions": accepting,
    }


def create_app(settings: Settings | None = None, runtime: Runtime | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    runtime = runtime or build_runtime(settings)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await runtime.scheduler.start()
        preload_async = getattr(runtime.scheduler.backend, "_ensure_loaded", None)
        preload_sync = getattr(runtime.scheduler.backend, "_load", None)
        if preload_async is None and preload_sync is None:
            runtime.model_loaded = True
        else:
            runtime.preload_task = asyncio.create_task(
                _preload_model(runtime), name="worker-model-preload"
            )
        yield
        if runtime.preload_task is not None and not runtime.preload_task.done():
            runtime.preload_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await runtime.preload_task
        await runtime.scheduler.close()

    app = FastAPI(title="Qwen3-ASR RunPod Worker", version="0.2.0", lifespan=lifespan)
    app.state.runtime = runtime

    @app.exception_handler(WorkerAPIError)
    async def worker_api_error(_: Request, exc: WorkerAPIError) -> JSONResponse:
        error: dict[str, object] = {"code": exc.code, "message": exc.message}
        if exc.details is not None:
            error["details"] = exc.details
        return JSONResponse(status_code=exc.status_code, content={"error": error})

    async def require_admin(
        authorization: str | None = Header(default=None),
    ) -> None:
        if not runtime.settings.worker_admin_secret:
            raise WorkerAPIError(
                503,
                "admin_auth_not_configured",
                "worker admin authentication is not configured",
            )
        presented = bearer_secret(authorization)
        if presented is None:
            raise WorkerAPIError(401, "admin_auth_required", "Bearer authentication is required")
        if not secrets_match(presented, runtime.settings.worker_admin_secret):
            raise WorkerAPIError(403, "admin_auth_invalid", "admin authentication failed")

    @app.get("/", include_in_schema=False)
    async def root() -> dict[str, object]:
        return {
            "service": "qwen3-asr-runpod-worker",
            "worker_id": runtime.settings.worker_id,
            "model_id": runtime.settings.model_id,
        }

    @app.get("/health")
    async def health() -> dict[str, object]:
        return {
            "status": "ok",
            "service": "qwen3-asr-runpod-worker",
            **_state(runtime),
        }

    @app.get("/ready")
    async def ready(
        model_id: str | None = Query(default=None, min_length=1, max_length=256),
    ) -> JSONResponse:
        state = _state(runtime, model_id)
        is_ready = bool(state["accepting_sessions"])
        return JSONResponse(
            status_code=200 if is_ready else 503,
            content={"status": "ready" if is_ready else "not_ready", **state},
        )

    @app.get("/healthz")
    async def healthz() -> dict[str, object]:
        is_real_model = runtime.settings.asr_backend in {"qwen_vllm", "qwen_async_vllm"}
        aligner_active = is_real_model and runtime.settings.enable_aligner
        telemetry = await asyncio.to_thread(gpu_telemetry)
        return {
            "status": "ok",
            **_state(runtime),
            "catalog_revision": runtime.catalog.revision,
            "catalog_terms": len(runtime.catalog.terms),
            "backend": runtime.settings.asr_backend,
            "inference_mode": "real" if is_real_model else "development",
            "model_path_name": Path(runtime.settings.asr_model).name,
            "diarizer": runtime.settings.diarizer_backend,
            "accelerator": telemetry.get(
                "accelerator", os.getenv("ACCELERATOR_LABEL", "local CPU")
            ),
            **telemetry,
            "chunk_seconds": runtime.settings.chunk_seconds,
            "service_profile": runtime.settings.service_profile,
            "stream_limits": {
                "max_pcm_frame_ms": runtime.settings.max_pcm_frame_ms,
                "max_stream_audio_seconds": runtime.settings.max_stream_audio_seconds,
                "max_audio_lead_seconds": runtime.settings.max_audio_lead_seconds,
                "max_session_seconds": runtime.settings.max_session_seconds,
                "max_session_jobs": runtime.settings.max_session_jobs,
                "max_session_events": runtime.settings.max_session_events,
                "scheduler_queue_size": runtime.settings.scheduler_queue_size,
                "scheduler_max_concurrent_batches": (
                    runtime.settings.scheduler_max_concurrent_batches
                ),
            },
            "finalization": {
                "asr": "contextual_final" if is_real_model else "development_fake",
                "same_model_as_partial": True,
                "aligner_enabled": aligner_active,
                "word_timestamps": "forced_aligner" if aligner_active else "provisional",
                "diarization_timeout_seconds": runtime.settings.final_diarization_timeout_seconds,
                "diarization_request_timeout_seconds": runtime.settings.diarizer_request_timeout_seconds,
                "diarization_cleanup_timeout_seconds": runtime.settings.diarizer_cleanup_timeout_seconds,
                "diarization_fallback": "cached_activities",
            },
        }

    @app.get("/metrics")
    async def metrics() -> Response:
        return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)

    @app.get("/admin/models", dependencies=[Depends(require_admin)])
    async def admin_models() -> dict[str, object]:
        return {
            "worker_id": runtime.settings.worker_id,
            "resident": {
                "model_id": runtime.settings.model_id,
                "loaded": runtime.model_loaded,
                "load_failed": runtime.model_load_error is not None,
            },
            "models": read_models_lock(runtime.settings.models_lock_path),
            "active_sessions": runtime.capacity.active,
            "draining": runtime.capacity.draining,
        }

    @app.post("/admin/models/load", dependencies=[Depends(require_admin)])
    async def admin_load_model(payload: ModelLoadRequest) -> dict[str, object]:
        if payload.model_id != runtime.settings.model_id:
            raise WorkerAPIError(
                409,
                "restart_required",
                "this worker has one immutable resident model; drain and restart it with MODEL_ID",
                {
                    "current_model_id": runtime.settings.model_id,
                    "requested_model_id": payload.model_id,
                    "active_sessions": runtime.capacity.active,
                    "draining": runtime.capacity.draining,
                },
            )
        return {
            "status": (
                "loaded"
                if runtime.model_loaded
                else "load_failed"
                if runtime.model_load_error is not None
                else "loading"
            ),
            "worker_id": runtime.settings.worker_id,
            "model_id": runtime.settings.model_id,
            "restart_required": False,
        }

    @app.post("/admin/drain", dependencies=[Depends(require_admin)])
    async def admin_drain(payload: DrainRequest) -> dict[str, object]:
        await runtime.capacity.set_draining(payload.draining)
        return {
            "status": "draining" if payload.draining else "accepting",
            **_state(runtime),
        }

    @app.websocket("/v1/realtime")
    async def realtime(websocket: WebSocket) -> None:
        await websocket.accept()
        acquired = False
        session: StreamingSession | None = None
        try:
            try:
                raw_start = await asyncio.wait_for(
                    websocket.receive_text(),
                    timeout=runtime.settings.session_start_timeout_seconds,
                )
                start = SessionStart.model_validate_json(raw_start)
            except TimeoutError:
                await websocket.send_json(
                    ErrorPayload(
                        code="session_start_timeout",
                        message="session.start was not received before the handshake deadline",
                    ).model_dump()
                )
                await websocket.close(code=1008)
                return
            except (ValidationError, json.JSONDecodeError, RuntimeError, KeyError, TypeError) as exc:
                await websocket.send_json(
                    ErrorPayload(code="invalid_session_start", message=str(exc)).model_dump()
                )
                await websocket.close(code=1008)
                return

            ticket_required = runtime.settings.require_worker_ticket
            ticket_present = start.connection_ticket is not None
            if ticket_required or ticket_present:
                if not runtime.settings.worker_ticket_secret:
                    await websocket.send_json(
                        ErrorPayload(
                            code="worker_auth_misconfigured",
                            message="worker ticket verification is not configured",
                        ).model_dump()
                    )
                    await websocket.close(code=1011)
                    return
                if start.connection_ticket is None:
                    await websocket.send_json(
                        ErrorPayload(
                            code="connection_ticket_required",
                            message="a short-lived connection ticket is required",
                        ).model_dump()
                    )
                    await websocket.close(code=1008)
                    return
                try:
                    verify_worker_ticket(
                        start.connection_ticket,
                        secret=runtime.settings.worker_ticket_secret,
                        worker_id=runtime.settings.worker_id,
                        session_id=start.session_id,
                        model_id=start.model_id,
                    )
                except WorkerTicketError:
                    await websocket.send_json(
                        ErrorPayload(
                            code="invalid_connection_ticket",
                            message="connection ticket is invalid or expired",
                        ).model_dump()
                    )
                    await websocket.close(code=1008)
                    return

            if start.model_id != runtime.settings.model_id:
                await websocket.send_json(
                    ErrorPayload(
                        code="model_unavailable",
                        message="the requested model is not resident on this worker",
                    ).model_dump()
                )
                await websocket.close(code=1008)
                return
            if not runtime.model_loaded or runtime.model_load_error is not None:
                await websocket.send_json(
                    ErrorPayload(
                        code="worker_not_ready",
                        message="the resident model is not ready",
                    ).model_dump()
                )
                await websocket.close(code=1013)
                return
            if not runtime.catalog_state.ready:
                await websocket.send_json(
                    ErrorPayload(
                        code="catalog_unavailable",
                        message="the required Context catalog is not available",
                    ).model_dump()
                )
                await websocket.close(code=1013)
                return
            if (
                runtime.settings.reject_catalog_revision_mismatch
                and start.catalog_revision != runtime.catalog.revision
            ):
                await websocket.send_json(
                    ErrorPayload(
                        code="catalog_revision_mismatch",
                        message=f"server catalog revision is {runtime.catalog.revision}",
                    ).model_dump()
                )
                await websocket.close(code=1008)
                return
            rejection = await runtime.capacity.acquire(start.session_id)
            if rejection is not None:
                CAPACITY_REJECTIONS.inc()
                code = rejection
                message = {
                    "worker_draining": "this worker is draining and is not accepting new sessions",
                    "session_already_connected": "this session already has an active connection",
                    "capacity_exceeded": "no new sessions are being accepted",
                }[rejection]
                await websocket.send_json(ErrorPayload(code=code, message=message).model_dump())
                await websocket.close(code=1013)
                return
            acquired = True
            session = StreamingSession(
                session_id=start.session_id,
                settings=runtime.settings,
                vad=runtime.create_vad(),
                scheduler=runtime.scheduler,
                retriever=runtime.retriever,
                diarizer=runtime.diarizer,
            )
            await websocket.send_json(
                SessionReady(
                    session_id=start.session_id,
                    catalog_revision=runtime.catalog.revision,
                    worker_id=runtime.settings.worker_id,
                    model_id=runtime.settings.model_id,
                ).model_dump()
            )

            stream_started_at = time.monotonic()
            received_audio_bytes = 0
            bytes_per_second = runtime.settings.sample_rate * 2
            max_frame_bytes = frame_bytes(
                runtime.settings.max_pcm_frame_ms,
                runtime.settings.sample_rate,
            )

            async def reject_stream(code: str, message: str, close_code: int) -> bool:
                ERRORS.labels(stage=code).inc()
                await websocket.send_json(
                    ErrorPayload(code=code, message=message).model_dump()
                )
                await websocket.close(code=close_code)
                return False

            async def receive_audio() -> bool:
                nonlocal received_audio_bytes
                while True:
                    elapsed = time.monotonic() - stream_started_at
                    remaining = runtime.settings.max_session_seconds - elapsed
                    if remaining <= 0:
                        return await reject_stream(
                            "session_duration_exceeded",
                            "the realtime session reached its wall-clock duration limit",
                            1008,
                        )
                    try:
                        message = await asyncio.wait_for(
                            websocket.receive(),
                            timeout=remaining,
                        )
                    except TimeoutError:
                        return await reject_stream(
                            "session_duration_exceeded",
                            "the realtime session reached its wall-clock duration limit",
                            1008,
                        )
                    if message["type"] == "websocket.disconnect":
                        return False
                    text = message.get("text")
                    if text is not None:
                        try:
                            InputEnd.model_validate_json(text)
                        except (ValidationError, json.JSONDecodeError, TypeError) as exc:
                            await websocket.send_json(
                                ErrorPayload(
                                    code="invalid_client_event",
                                    message=str(exc),
                                ).model_dump()
                            )
                            continue
                        return True
                    pcm = message.get("bytes")
                    if pcm is None:
                        await websocket.send_json(
                            ErrorPayload(
                                code="binary_audio_required",
                                message="send PCM as binary frames",
                            ).model_dump()
                        )
                        continue
                    if len(pcm) > max_frame_bytes:
                        return await reject_stream(
                            "audio_frame_too_large",
                            (
                                "binary PCM frames may contain at most "
                                f"{runtime.settings.max_pcm_frame_ms} ms of audio"
                            ),
                            1009,
                        )
                    next_audio_bytes = received_audio_bytes + len(pcm)
                    next_audio_seconds = next_audio_bytes / bytes_per_second
                    if next_audio_seconds > runtime.settings.max_stream_audio_seconds:
                        return await reject_stream(
                            "stream_audio_limit_exceeded",
                            "the realtime stream reached its cumulative audio limit",
                            1008,
                        )
                    elapsed = time.monotonic() - stream_started_at
                    if next_audio_seconds > elapsed + runtime.settings.max_audio_lead_seconds:
                        return await reject_stream(
                            "audio_pacing_exceeded",
                            "binary PCM was sent faster than the permitted realtime lead",
                            1008,
                        )
                    try:
                        await session.feed(pcm)
                    except ValueError as exc:
                        await websocket.send_json(
                            ErrorPayload(code="invalid_audio", message=str(exc)).model_dump()
                        )
                    else:
                        received_audio_bytes = next_audio_bytes

            async def send_events() -> None:
                try:
                    while True:
                        event = await session.events.get()
                        if event is None:
                            return
                        await websocket.send_json(event.model_dump())
                except Exception:
                    session.discard_output()
                    raise

            sender = asyncio.create_task(send_events(), name=f"sender-{start.session_id}")
            input_ended = False
            try:
                input_ended = await receive_audio()
            finally:
                if not input_ended:
                    session.discard_output()
                await session.finish()
                if input_ended:
                    await sender
                else:
                    with contextlib.suppress(WebSocketDisconnect, RuntimeError):
                        await sender
            if input_ended:
                await websocket.send_json(
                    StreamFinalized(session_id=start.session_id).model_dump()
                )
        except WebSocketDisconnect:
            if session is not None:
                await session.finish()
        except Exception:
            ERRORS.labels(stage="websocket").inc()
            raise
        finally:
            if acquired:
                await runtime.capacity.release(start.session_id)
            with contextlib.suppress(RuntimeError):
                await websocket.close()

    return app


app = create_app()


def main() -> None:
    import uvicorn

    uvicorn.run(
        "qwen_realtime.app:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8000")),
        workers=1,
    )
