import asyncio
import time

import numpy as np

from qwen_realtime.alignment import SpeakerActivity
from qwen_realtime.asr import FakeASRBackend
from qwen_realtime.catalog import Catalog, ContextRetriever, Term
from qwen_realtime.config import Settings
from qwen_realtime.diarization import EnergyDiarizer
from qwen_realtime.engine import StreamingSession
from qwen_realtime.protocol import ErrorPayload, PartialPayload
from qwen_realtime.scheduler import BatchingScheduler
from qwen_realtime.vad import EnergyVADSession


def pcm(amplitude: int, milliseconds: int = 100) -> bytes:
    return np.full(16 * milliseconds, amplitude, dtype="<i2").tobytes()


async def test_session_queues_are_bounded_and_partial_work_is_coalesced():
    settings = Settings(
        max_session_jobs=1,
        max_session_events=1,
        catalog_path=None,  # type: ignore[arg-type]
    )
    scheduler = BatchingScheduler(FakeASRBackend(), batch_size=1, window_ms=1)
    session = StreamingSession(
        "bounded",
        settings,
        EnergyVADSession(),
        scheduler,
        ContextRetriever(Catalog.empty()),
        EnergyDiarizer(),
    )

    # The worker task has not had an event-loop turn yet, so this sentinel keeps
    # the one-slot job queue full while the partial enqueue is attempted.
    session.jobs.put_nowait(None)
    utterance = session._new_utterance()
    utterance.pcm.extend(pcm(3_000, milliseconds=1_000))
    session._enqueue_partial(utterance)
    assert session.jobs.maxsize == 1
    assert session.jobs.qsize() == 1
    assert utterance.partial_pending is False
    assert session.jobs.get_nowait() is None
    session.jobs.task_done()

    session.events.put_nowait(ErrorPayload(code="occupied", message="occupied"))
    emitted = await session._emit_event(
        PartialPayload(
            utterance_id="partial",
            revision=1,
            stable_text="",
            unstable_text="partial",
            speaker_hint=None,
            audio_end_ms=1_000,
        ),
        drop_if_full=True,
    )
    assert emitted is False
    assert session.events.maxsize == 1
    session.events.get_nowait()

    session.events.put_nowait(ErrorPayload(code="occupied", message="occupied"))
    blocked_emit = asyncio.create_task(
        session._emit_event(ErrorPayload(code="tail", message="tail"))
    )
    await asyncio.sleep(0)
    assert blocked_emit.done() is False
    session.discard_output()
    await blocked_emit

    await asyncio.wait_for(session.finish(), timeout=0.5)
    assert await session.events.get() is None
    await scheduler.close()


async def test_session_emits_partial_then_contextual_final():
    settings = Settings(
        chunk_seconds=1.0,
        vad_end_silence_ms=480,
        catalog_path=None,  # type: ignore[arg-type]
    )
    backend = FakeASRBackend(
        script=["のむらしょうけんを確認", "野村證券を確認", "野村證券を確認"]
    )
    scheduler = BatchingScheduler(backend, batch_size=8, window_ms=1)
    retriever = ContextRetriever(
        Catalog("r1", (Term("nomura", "のむらしょうけん", "野村證券"),)), top_k=20
    )
    session = StreamingSession(
        "s1",
        settings,
        EnergyVADSession(end_silence_ms=480),
        scheduler,
        retriever,
        EnergyDiarizer(),
    )
    for _ in range(12):
        await session.feed(pcm(3000))
    for _ in range(5):
        await session.feed(pcm(0))
    await session.finish()
    await scheduler.close()
    events = []
    while True:
        event = await session.events.get()
        if event is None:
            break
        events.append(event)
    assert [event.type for event in events] == ["transcript.partial", "transcript.final"]
    assert events[0].speaker_hint == "speaker_0"
    assert events[-1].context_hits == ["nomura"]
    assert events[-1].words[0].speaker == "speaker_0"
    assert backend.calls[0][0].context == ""
    assert "<write>野村證券</write>" in backend.calls[-1][0].context


async def test_audio_received_during_slow_inference_is_coalesced():
    settings = Settings(chunk_seconds=0.8, catalog_path=None)  # type: ignore[arg-type]
    backend = FakeASRBackend(delay_seconds=0.05)
    scheduler = BatchingScheduler(backend, batch_size=8, window_ms=1)
    session = StreamingSession(
        "s2",
        settings,
        EnergyVADSession(),
        scheduler,
        ContextRetriever(Catalog.empty()),
        EnergyDiarizer(),
    )
    for _ in range(20):
        await session.feed(pcm(3000))
    for _ in range(5):
        await session.feed(pcm(0))
    await session.finish()
    await scheduler.close()
    # A coalesced 1.8+ second request is present; there is no per-frame inference fan-out.
    sizes = [request.audio.size for call in backend.calls for request in call]
    assert max(sizes) >= 28_000
    assert len(sizes) <= 3


async def test_final_diarization_timeout_uses_cached_activities():
    class BlockingDiarizer:
        async def update(
            self,
            stream_id,
            audio,
            sample_rate,
            offset_samples,
            *,
            final=False,
        ):
            del stream_id, audio, sample_rate, offset_samples, final
            await asyncio.Event().wait()
            return []

        async def close_stream(self, stream_id):
            del stream_id

    settings = Settings(
        chunk_seconds=10.0,
        diarizer_interval_ms=500,
        final_diarization_timeout_seconds=0.01,
        catalog_path=None,  # type: ignore[arg-type]
    )
    backend = FakeASRBackend(script=["野村"])
    scheduler = BatchingScheduler(backend, batch_size=8, window_ms=1)
    session = StreamingSession(
        "timeout",
        settings,
        EnergyVADSession(end_silence_ms=480),
        scheduler,
        ContextRetriever(Catalog.empty()),
        BlockingDiarizer(),
    )
    await session.feed(pcm(3000, milliseconds=600))
    assert session.current is not None
    session.current.activities = [
        SpeakerActivity(0, 2_000, "speaker_1", 0.9),
    ]
    started = time.perf_counter()
    for _ in range(5):
        await session.feed(pcm(0))
    await session.finish()
    elapsed = time.perf_counter() - started
    await scheduler.close()

    events = []
    while True:
        event = await session.events.get()
        if event is None:
            break
        events.append(event)
    assert elapsed < 0.5
    assert [event.type for event in events] == ["transcript.final"]
    assert events[0].text == "野村"
    assert all(word.speaker == "speaker_1" for word in events[0].words)


async def test_diarization_cleanup_has_its_own_short_timeout():
    class BlockingCleanupDiarizer:
        async def update(
            self,
            stream_id,
            audio,
            sample_rate,
            offset_samples,
            *,
            final=False,
        ):
            del stream_id, audio, sample_rate, offset_samples, final
            return []

        async def close_stream(self, stream_id):
            del stream_id
            await asyncio.Event().wait()

    settings = Settings(
        chunk_seconds=10.0,
        final_diarization_timeout_seconds=0.1,
        diarizer_cleanup_timeout_seconds=0.01,
        catalog_path=None,  # type: ignore[arg-type]
    )
    scheduler = BatchingScheduler(FakeASRBackend(script=["cleanup"]), batch_size=8, window_ms=1)
    session = StreamingSession(
        "cleanup-timeout",
        settings,
        EnergyVADSession(end_silence_ms=480),
        scheduler,
        ContextRetriever(Catalog.empty()),
        BlockingCleanupDiarizer(),
    )
    await session.feed(pcm(3000, milliseconds=100))
    started = time.perf_counter()
    await session.finish()
    elapsed = time.perf_counter() - started
    await scheduler.close()

    assert elapsed < 0.5
    assert (await session.events.get()).type == "transcript.final"


async def test_diarization_submits_each_audio_sample_once_and_flushes_state():
    class RecordingDiarizer:
        def __init__(self):
            self.calls = []
            self.closed = []

        async def update(
            self,
            stream_id,
            audio,
            sample_rate,
            offset_samples,
            *,
            final=False,
        ):
            self.calls.append((stream_id, offset_samples, audio.size, final))
            duration_ms = round((offset_samples + audio.size) * 1000 / sample_rate)
            return [SpeakerActivity(0, duration_ms, "speaker_0", 0.9)]

        async def close_stream(self, stream_id):
            self.closed.append(stream_id)

    diarizer = RecordingDiarizer()
    settings = Settings(
        chunk_seconds=10.0,
        diarizer_interval_ms=500,
        catalog_path=None,  # type: ignore[arg-type]
    )
    scheduler = BatchingScheduler(FakeASRBackend(script=["野村"]), batch_size=8, window_ms=1)
    session = StreamingSession(
        "incremental",
        settings,
        EnergyVADSession(end_silence_ms=480),
        scheduler,
        ContextRetriever(Catalog.empty()),
        diarizer,
    )
    for _ in range(12):
        await session.feed(pcm(3000))
    for _ in range(5):
        await session.feed(pcm(0))
    await session.finish()
    await scheduler.close()

    assert len(diarizer.calls) == 2
    first, final = diarizer.calls
    assert first[1] == 0
    assert final[1] == first[1] + first[2]
    assert final[3] is True
    assert sum(call[2] for call in diarizer.calls) == final[1] + final[2]
    assert diarizer.closed == [first[0]]
