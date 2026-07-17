from __future__ import annotations

import asyncio
import contextlib
import math
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass

import numpy as np
from fastapi import FastAPI, Header, HTTPException, Request

from .config import DEFAULT_DIARIZER_MODEL
from .diarization import DiarizationUpdate, NeMoSortformerDiarizer

SAMPLE_RATE = 16_000
FLOAT32_BYTES_PER_SAMPLE = 4


def _bounded_int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    value = int(os.getenv(name, str(default)))
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def _bounded_float_env(name: str, default: float, minimum: float, maximum: float) -> float:
    value = float(os.getenv(name, str(default)))
    if not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


# Periodic diarization normally sends about 500 ms. Two seconds leaves room for
# scheduler jitter while placing a strict upper bound on every retained PCM body.
MAX_PCM_CHUNK_SECONDS = _bounded_float_env(
    "DIARIZER_MAX_PCM_CHUNK_SECONDS", 2.0, 0.08, 20.0
)
MAX_PCM_CHUNK_SAMPLES = math.ceil(SAMPLE_RATE * MAX_PCM_CHUNK_SECONDS)
MAX_DIARIZATION_BODY_BYTES = MAX_PCM_CHUNK_SAMPLES * FLOAT32_BYTES_PER_SAMPLE

# Expire work before RemoteDiarizer's default 4 second HTTP timeout. This makes
# a timed-out caller's queue item ineligible for later GPU inference.
REMOTE_REQUEST_TIMEOUT_SECONDS = _bounded_float_env(
    "DIARIZER_REQUEST_TIMEOUT_SECONDS", 4.0, 0.1, 60.0
)
SIDECAR_REQUEST_TIMEOUT_SECONDS = _bounded_float_env(
    "DIARIZER_SIDECAR_REQUEST_TIMEOUT_SECONDS",
    max(0.05, REMOTE_REQUEST_TIMEOUT_SECONDS - 0.5),
    0.05,
    REMOTE_REQUEST_TIMEOUT_SECONDS,
)
if SIDECAR_REQUEST_TIMEOUT_SECONDS >= REMOTE_REQUEST_TIMEOUT_SECONDS:
    raise ValueError(
        "DIARIZER_SIDECAR_REQUEST_TIMEOUT_SECONDS must be less than "
        "DIARIZER_REQUEST_TIMEOUT_SECONDS"
    )
DISCONNECT_POLL_SECONDS = 0.1

model = NeMoSortformerDiarizer(
    model_name=os.getenv("DIARIZER_MODEL", DEFAULT_DIARIZER_MODEL),
    device=os.getenv("DIARIZER_DEVICE", "cuda"),
    chunk_frames=int(os.getenv("DIARIZER_CHUNK_FRAMES", "6")),
    speaker_cache_frames=int(os.getenv("DIARIZER_SPEAKER_CACHE_FRAMES", "188")),
    fifo_frames=int(os.getenv("DIARIZER_FIFO_FRAMES", "188")),
    speaker_cache_update_frames=int(
        os.getenv("DIARIZER_SPEAKER_CACHE_UPDATE_FRAMES", "144")
    ),
)


@dataclass(slots=True)
class _Pending:
    update: DiarizationUpdate
    future: asyncio.Future[list]
    deadline: float


class SortformerQueueFull(RuntimeError):
    """The bounded sidecar queue cannot accept more PCM."""


class SortformerRequestExpired(TimeoutError):
    """The sidecar could not finish before the caller's HTTP timeout."""


class SortformerBatcherClosed(RuntimeError):
    """The sidecar is shutting down and no longer accepts work."""


class _ClientDisconnected(RuntimeError):
    pass


class SortformerBatcher:
    """Small localhost micro-batcher for concurrent call streams."""

    def __init__(
        self,
        batch_size: int = 32,
        window_ms: int = 12,
        max_queue_size: int = 64,
        request_timeout_seconds: float = 3.5,
    ) -> None:
        if batch_size < 1:
            raise ValueError("batch_size must be at least one")
        if window_ms < 0:
            raise ValueError("window_ms must not be negative")
        if max_queue_size < 1:
            raise ValueError("max_queue_size must be at least one")
        if request_timeout_seconds <= 0:
            raise ValueError("request_timeout_seconds must be positive")
        self.batch_size = batch_size
        self.window_ms = window_ms
        self.max_queue_size = max_queue_size
        self.request_timeout_seconds = request_timeout_seconds
        self.queue: asyncio.Queue[_Pending] = asyncio.Queue(maxsize=max_queue_size)
        self.task: asyncio.Task[None] | None = None
        self.closed = False

    async def start(self) -> None:
        if self.task is not None and not self.task.done():
            return
        if self.closed:
            # FastAPI has one lifespan in production. Recreating an empty queue
            # also keeps repeated TestClient lifespans from reusing a loop-bound
            # asyncio.Queue.
            self.queue = asyncio.Queue(maxsize=self.max_queue_size)
        self.closed = False
        self.task = asyncio.create_task(self._run(), name="sortformer-microbatcher")

    async def close(self) -> None:
        self.closed = True
        task = self.task
        self.task = None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._cancel_queued()

    async def submit(self, update: DiarizationUpdate) -> list:
        if self.closed:
            raise SortformerBatcherClosed("Sortformer sidecar is shutting down")
        loop = asyncio.get_running_loop()
        future = asyncio.get_running_loop().create_future()
        pending = _Pending(
            update=update,
            future=future,
            deadline=loop.time() + self.request_timeout_seconds,
        )
        try:
            self.queue.put_nowait(pending)
        except asyncio.QueueFull as exc:
            future.cancel()
            raise SortformerQueueFull("Sortformer queue is full") from exc
        try:
            return await asyncio.wait_for(future, timeout=self.request_timeout_seconds)
        except TimeoutError as exc:
            future.cancel()
            raise SortformerRequestExpired("Sortformer request deadline exceeded") from exc
        except asyncio.CancelledError:
            future.cancel()
            raise

    @staticmethod
    def _active(pending: _Pending, now: float) -> bool:
        if pending.future.done():
            return False
        if pending.deadline <= now:
            pending.future.cancel()
            return False
        return True

    def _cancel_queued(self) -> None:
        while True:
            try:
                pending = self.queue.get_nowait()
            except asyncio.QueueEmpty:
                return
            pending.future.cancel()

    async def _run(self) -> None:
        batch: list[_Pending] = []
        try:
            while True:
                item = await self.queue.get()
                loop = asyncio.get_running_loop()
                if not self._active(item, loop.time()):
                    continue
                batch = [item]
                batch_window_deadline = loop.time() + self.window_ms / 1000
                while len(batch) < self.batch_size:
                    timeout = batch_window_deadline - loop.time()
                    if timeout <= 0:
                        break
                    try:
                        candidate = await asyncio.wait_for(self.queue.get(), timeout)
                    except asyncio.TimeoutError:
                        break
                    if self._active(candidate, loop.time()):
                        batch.append(candidate)
                batch = [pending for pending in batch if self._active(pending, loop.time())]
                if not batch:
                    continue
                try:
                    results = await model.update_batch([pending.update for pending in batch])
                    for pending, result in zip(batch, results, strict=True):
                        if not pending.future.done():
                            pending.future.set_result(result)
                except asyncio.CancelledError:
                    for pending in batch:
                        pending.future.cancel()
                    raise
                except Exception as exc:
                    for pending in batch:
                        if not pending.future.done():
                            pending.future.set_exception(exc)
                finally:
                    batch = []
        finally:
            for pending in batch:
                pending.future.cancel()
            self._cancel_queued()


batcher = SortformerBatcher(
    batch_size=_bounded_int_env("DIARIZER_BATCH_SIZE", 32, 1, 128),
    window_ms=_bounded_int_env("DIARIZER_BATCH_WINDOW_MS", 12, 0, 1_000),
    max_queue_size=_bounded_int_env("DIARIZER_SIDECAR_QUEUE_SIZE", 64, 1, 1_024),
    request_timeout_seconds=SIDECAR_REQUEST_TIMEOUT_SECONDS,
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    model._load()
    await batcher.start()
    cleanup_interval = float(os.getenv("DIARIZER_STREAM_CLEANUP_INTERVAL_SECONDS", "60"))
    stream_ttl = float(os.getenv("DIARIZER_STREAM_TTL_SECONDS", "120"))

    async def cleanup_stale_streams() -> None:
        while True:
            await asyncio.sleep(cleanup_interval)
            await model.cleanup_stale_streams(stream_ttl)

    cleanup_task = asyncio.create_task(cleanup_stale_streams(), name="sortformer-stream-reaper")
    try:
        yield
    finally:
        cleanup_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await cleanup_task
        await batcher.close()


app = FastAPI(title="Sortformer Sidecar", lifespan=lifespan)


async def _read_limited_body(request: Request) -> bytes:
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            declared_length = int(content_length)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid content-length") from exc
        if declared_length < 0:
            raise HTTPException(status_code=400, detail="invalid content-length")
        if declared_length > MAX_DIARIZATION_BODY_BYTES:
            raise HTTPException(status_code=413, detail="float32 PCM chunk is too large")

    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_DIARIZATION_BODY_BYTES:
            raise HTTPException(status_code=413, detail="float32 PCM chunk is too large")
        body.extend(chunk)
    return bytes(body)


async def _submit_until_disconnect(
    request: Request, update: DiarizationUpdate
) -> list:
    if await request.is_disconnected():
        raise _ClientDisconnected
    task = asyncio.create_task(batcher.submit(update), name=f"diarize-{update.stream_id}")
    try:
        while True:
            done, _ = await asyncio.wait({task}, timeout=DISCONNECT_POLL_SECONDS)
            if task in done:
                return task.result()
            if await request.is_disconnected():
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
                raise _ClientDisconnected
    finally:
        if not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok", "model": model.model_name}


@app.post("/diarize")
async def diarize(
    request: Request,
    x_sample_rate: int = Header(default=16_000),
    x_stream_id: str = Header(),
    x_offset_samples: int = Header(default=0),
    x_final: bool = Header(default=False),
) -> dict[str, object]:
    if x_sample_rate != 16_000:
        raise HTTPException(status_code=400, detail="16 kHz input required")
    if not x_stream_id or len(x_stream_id) > 128 or any(ord(char) < 32 for char in x_stream_id):
        raise HTTPException(status_code=400, detail="valid x-stream-id required")
    if x_offset_samples < 0:
        raise HTTPException(status_code=400, detail="x-offset-samples must not be negative")
    body = await _read_limited_body(request)
    if len(body) % 4:
        raise HTTPException(status_code=400, detail="float32 payload length must be divisible by four")
    audio = np.frombuffer(body, dtype="<f4").copy()
    try:
        activities = await _submit_until_disconnect(
            request,
            DiarizationUpdate(
                stream_id=x_stream_id,
                audio=audio,
                sample_rate=x_sample_rate,
                offset_samples=x_offset_samples,
                final=x_final,
            ),
        )
    except SortformerQueueFull as exc:
        raise HTTPException(
            status_code=503,
            detail="Sortformer queue is full",
            headers={"Retry-After": "1"},
        ) from exc
    except SortformerRequestExpired as exc:
        raise HTTPException(status_code=504, detail="Sortformer request deadline exceeded") from exc
    except SortformerBatcherClosed as exc:
        raise HTTPException(status_code=503, detail="Sortformer sidecar is shutting down") from exc
    except _ClientDisconnected as exc:
        raise HTTPException(status_code=499, detail="client disconnected") from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {
        "stream_id": x_stream_id,
        "next_offset_samples": x_offset_samples + audio.size,
        "finalized": x_final,
        "activities": [
            {
                "start_ms": item.start_ms,
                "end_ms": item.end_ms,
                "speaker": item.speaker,
                "confidence": item.confidence,
            }
            for item in activities
        ]
    }


@app.delete("/diarize", status_code=204)
async def close_diarization_stream(x_stream_id: str = Header()) -> None:
    if not x_stream_id or len(x_stream_id) > 128:
        raise HTTPException(status_code=400, detail="valid x-stream-id required")
    await model.close_stream(x_stream_id)


def main() -> None:
    import uvicorn

    uvicorn.run("qwen_realtime.diarizer_sidecar:app", host="127.0.0.1", port=18001, workers=1)


if __name__ == "__main__":
    main()
