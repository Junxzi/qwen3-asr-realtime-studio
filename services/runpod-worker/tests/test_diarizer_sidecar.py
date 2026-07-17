from __future__ import annotations

import asyncio
import contextlib

import numpy as np
import pytest
from fastapi.testclient import TestClient

from qwen_realtime import diarizer_sidecar
from qwen_realtime.alignment import SpeakerActivity
from qwen_realtime.diarization import DiarizationUpdate


def test_sidecar_requires_stream_metadata_and_supports_explicit_cleanup(monkeypatch):
    received = []
    closed = []

    async def update_batch(updates):
        received.extend(updates)
        return [[SpeakerActivity(0, 500, "speaker_0", 0.9)] for _ in updates]

    async def close_stream(stream_id):
        closed.append(stream_id)

    monkeypatch.setattr(diarizer_sidecar.model, "_load", lambda: object())
    monkeypatch.setattr(diarizer_sidecar.model, "update_batch", update_batch)
    monkeypatch.setattr(diarizer_sidecar.model, "close_stream", close_stream)

    audio = np.zeros(8_000, dtype="<f4")
    headers = {
        "content-type": "application/octet-stream",
        "x-sample-rate": "16000",
        "x-stream-id": "session-utterance-1",
        "x-offset-samples": "4000",
        "x-final": "true",
    }
    with TestClient(diarizer_sidecar.app) as client:
        missing = client.post("/diarize", content=audio.tobytes())
        assert missing.status_code == 422

        response = client.post("/diarize", content=audio.tobytes(), headers=headers)
        assert response.status_code == 200
        assert response.json() == {
            "stream_id": "session-utterance-1",
            "next_offset_samples": 12_000,
            "finalized": True,
            "activities": [
                {
                    "start_ms": 0,
                    "end_ms": 500,
                    "speaker": "speaker_0",
                    "confidence": 0.9,
                }
            ],
        }

        deleted = client.delete(
            "/diarize",
            headers={"x-stream-id": "session-utterance-1"},
        )
        assert deleted.status_code == 204

    assert len(received) == 1
    assert received[0].stream_id == "session-utterance-1"
    assert received[0].offset_samples == 4_000
    assert received[0].audio.size == 8_000
    assert received[0].final is True
    assert closed == ["session-utterance-1"]


@pytest.mark.asyncio
async def test_batcher_rejects_when_bounded_queue_is_full():
    batcher = diarizer_sidecar.SortformerBatcher(
        batch_size=1,
        window_ms=0,
        max_queue_size=1,
        request_timeout_seconds=1,
    )
    update = DiarizationUpdate("stream-1", np.zeros(1, dtype="<f4"), 16_000, 0)
    first = asyncio.create_task(batcher.submit(update))
    await asyncio.sleep(0)

    with pytest.raises(diarizer_sidecar.SortformerQueueFull):
        await batcher.submit(
            DiarizationUpdate("stream-2", np.zeros(1, dtype="<f4"), 16_000, 0)
        )

    first.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await first
    await batcher.close()


def test_sidecar_returns_retryable_overload_response(monkeypatch):
    async def overloaded(_update):
        raise diarizer_sidecar.SortformerQueueFull("full")

    monkeypatch.setattr(diarizer_sidecar.model, "_load", lambda: object())
    monkeypatch.setattr(diarizer_sidecar.batcher, "submit", overloaded)
    with TestClient(diarizer_sidecar.app) as client:
        response = client.post(
            "/diarize",
            content=np.zeros(8, dtype="<f4").tobytes(),
            headers={"x-stream-id": "overloaded-stream"},
        )

    assert response.status_code == 503
    assert response.headers["retry-after"] == "1"
    assert response.json() == {"detail": "Sortformer queue is full"}


def test_sidecar_rejects_oversize_body_before_enqueue(monkeypatch):
    called = False

    async def submit(_update):
        nonlocal called
        called = True
        return []

    monkeypatch.setattr(diarizer_sidecar.model, "_load", lambda: object())
    monkeypatch.setattr(diarizer_sidecar.batcher, "submit", submit)
    monkeypatch.setattr(diarizer_sidecar, "MAX_DIARIZATION_BODY_BYTES", 16)
    with TestClient(diarizer_sidecar.app) as client:
        response = client.post(
            "/diarize",
            content=b"\0" * 20,
            headers={"x-stream-id": "oversize-stream"},
        )

    assert response.status_code == 413
    assert response.json() == {"detail": "float32 PCM chunk is too large"}
    assert called is False


@pytest.mark.asyncio
async def test_batcher_discards_canceled_and_stale_queued_work(monkeypatch):
    received = []

    async def update_batch(updates):
        received.extend(updates)
        return [[] for _ in updates]

    monkeypatch.setattr(diarizer_sidecar.model, "update_batch", update_batch)
    batcher = diarizer_sidecar.SortformerBatcher(
        batch_size=2,
        window_ms=0,
        max_queue_size=4,
        request_timeout_seconds=0.01,
    )
    canceled = asyncio.create_task(
        batcher.submit(DiarizationUpdate("canceled", np.zeros(1, dtype="<f4"), 16_000, 0))
    )
    await asyncio.sleep(0)
    canceled.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await canceled

    with pytest.raises(diarizer_sidecar.SortformerRequestExpired):
        await batcher.submit(
            DiarizationUpdate("stale", np.zeros(1, dtype="<f4"), 16_000, 0)
        )

    await batcher.start()
    for _ in range(10):
        if batcher.queue.empty():
            break
        await asyncio.sleep(0)
    await batcher.close()

    assert received == []
