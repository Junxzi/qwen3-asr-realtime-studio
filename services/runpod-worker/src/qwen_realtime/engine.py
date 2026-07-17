from __future__ import annotations

import asyncio
import logging
import math
import time
import uuid
from dataclasses import dataclass, field

import numpy as np

from .alignment import SpeakerActivity, attribute_words, provisional_words
from .asr import ASRRequest
from .audio import duration_ms, frame_bytes, pcm_s16le_to_float32
from .catalog import ContextRetriever, Term
from .config import Settings
from .diarization import Diarizer, dominant_speaker
from .metrics import ASR_LATENCY, AUDIO_SECONDS, ERRORS, QUEUE_WAIT, REWRITE_VIOLATIONS
from .protocol import ErrorPayload, FinalPayload, PartialPayload, WordPayload
from .scheduler import BatchingScheduler
from .stability import StableTranscript
from .vad import VADSession

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class UtteranceState:
    utterance_id: str
    pcm: bytearray = field(default_factory=bytearray)
    next_partial_ms: int = 1_000
    last_submitted_ms: int = 0
    partial_pending: bool = False
    context_hits: list[Term] = field(default_factory=list)
    context_updates: int = 0
    stability: StableTranscript = field(default_factory=StableTranscript)
    activities: list[SpeakerActivity] = field(default_factory=list)
    inference_prefix: str = ""
    next_diar_ms: int = 500
    diar_pending: bool = False
    diar_submitted_samples: int = 0
    diar_task: asyncio.Task[None] | None = field(default=None, repr=False)


@dataclass(frozen=True, slots=True)
class _InferenceJob:
    utterance: UtteranceState
    audio: bytes
    final: bool
    enqueued_at: float


class StreamingSession:
    """One-call state machine with coalescing and at most one inference in flight."""

    def __init__(
        self,
        session_id: str,
        settings: Settings,
        vad: VADSession,
        scheduler: BatchingScheduler,
        retriever: ContextRetriever,
        diarizer: Diarizer,
    ) -> None:
        if settings.max_session_jobs < 1 or settings.max_session_events < 1:
            raise ValueError("session queue sizes must be at least one")
        self.session_id = session_id
        self.settings = settings
        self.vad = vad
        self.scheduler = scheduler
        self.retriever = retriever
        self.diarizer = diarizer
        self.current: UtteranceState | None = None
        self.pre_roll = bytearray()
        self.events: asyncio.Queue[
            PartialPayload | FinalPayload | ErrorPayload | None
        ] = asyncio.Queue(maxsize=settings.max_session_events)
        self.jobs: asyncio.Queue[_InferenceJob | None] = asyncio.Queue(
            maxsize=settings.max_session_jobs
        )
        self._worker = asyncio.create_task(self._run_jobs(), name=f"stream-{session_id}")
        self._diar_tasks: set[asyncio.Task[None]] = set()
        self._closed = False
        self._discard_output = False

    def _new_utterance(self) -> UtteranceState:
        return UtteranceState(
            utterance_id=f"{self.session_id}-{uuid.uuid4().hex[:12]}",
            next_partial_ms=round(self.settings.chunk_seconds * 1000),
            stability=StableTranscript(rollback_tokens=self.settings.rollback_tokens),
            next_diar_ms=self.settings.diarizer_interval_ms,
        )

    async def feed(self, pcm: bytes) -> None:
        if self._closed:
            raise RuntimeError("session is closed")
        if len(pcm) < frame_bytes(20, self.settings.sample_rate):
            raise ValueError("binary audio frames must contain at least 20 ms")
        if len(pcm) % 2:
            raise ValueError("PCM S16LE payload length must be even")
        AUDIO_SECONDS.inc(len(pcm) / 2 / self.settings.sample_rate)
        decision = self.vad.feed(pcm)
        if self.current is None:
            self.pre_roll.extend(pcm)
            max_pre_roll = frame_bytes(self.settings.pre_roll_ms, self.settings.sample_rate)
            if len(self.pre_roll) > max_pre_roll:
                del self.pre_roll[: len(self.pre_roll) - max_pre_roll]
            if decision.speech_started or decision.is_speech:
                self.current = self._new_utterance()
                self.current.pcm.extend(self.pre_roll)
                self.pre_roll.clear()
        else:
            self.current.pcm.extend(pcm)

        utterance = self.current
        if utterance is None:
            return
        audio_ms = duration_ms(utterance.pcm, self.settings.sample_rate)
        max_ms = round(self.settings.max_utterance_seconds * 1000)
        if audio_ms >= max_ms:
            await self._enqueue_final(utterance)
            self.current = None
            self.pre_roll.clear()
            return
        if audio_ms >= utterance.next_partial_ms and not utterance.partial_pending:
            self._enqueue_partial(utterance)
        if audio_ms >= utterance.next_diar_ms and not utterance.diar_pending:
            self._schedule_diarization(utterance)
        if decision.speech_ended:
            await self._enqueue_final(utterance)
            self.current = None
            self.pre_roll.clear()

    def _enqueue_partial(self, utterance: UtteranceState) -> None:
        if self.jobs.full():
            ERRORS.labels(stage="partial_job_queue_full").inc()
            return
        audio = bytes(utterance.pcm)
        utterance.partial_pending = True
        utterance.last_submitted_ms = duration_ms(audio, self.settings.sample_rate)
        utterance.next_partial_ms = utterance.last_submitted_ms + round(self.settings.chunk_seconds * 1000)
        try:
            self.jobs.put_nowait(
                _InferenceJob(utterance, audio, False, time.perf_counter())
            )
        except asyncio.QueueFull:
            utterance.partial_pending = False
            ERRORS.labels(stage="partial_job_queue_full").inc()

    async def _enqueue_final(self, utterance: UtteranceState) -> None:
        audio = bytes(utterance.pcm)
        if not audio:
            return
        await self.jobs.put(_InferenceJob(utterance, audio, True, time.perf_counter()))

    async def finish(self) -> None:
        if self._closed:
            return
        decision = self.vad.flush()
        if self.current is not None and (decision.speech_ended or self.current.pcm):
            await self._enqueue_final(self.current)
            self.current = None
        await self.jobs.join()
        if self._diar_tasks:
            await asyncio.gather(*self._diar_tasks, return_exceptions=True)
        await self.jobs.put(None)
        await self._worker
        self._closed = True
        if self._discard_output:
            self._drain_events()
        await self.events.put(None)

    def discard_output(self) -> None:
        """Stop retaining transcript events after the peer has disconnected."""

        self._discard_output = True
        self._drain_events()

    def _drain_events(self) -> None:
        while True:
            try:
                self.events.get_nowait()
            except asyncio.QueueEmpty:
                return

    async def _emit_event(
        self,
        event: PartialPayload | FinalPayload | ErrorPayload,
        *,
        drop_if_full: bool = False,
    ) -> bool:
        if self._discard_output:
            return False
        if drop_if_full:
            try:
                self.events.put_nowait(event)
            except asyncio.QueueFull:
                ERRORS.labels(stage="partial_event_queue_full").inc()
                return False
            return True
        await self.events.put(event)
        return True

    def _schedule_diarization(self, utterance: UtteranceState) -> None:
        offset_samples = utterance.diar_submitted_samples
        end_samples = len(utterance.pcm) // 2
        if end_samples <= offset_samples:
            return
        audio = pcm_s16le_to_float32(bytes(utterance.pcm[offset_samples * 2 :]))
        audio_ms = round(end_samples * 1000 / self.settings.sample_rate)
        utterance.diar_pending = True
        utterance.next_diar_ms = audio_ms + self.settings.diarizer_interval_ms
        task = asyncio.create_task(
            self._run_diarization(utterance, audio, offset_samples, end_samples),
            name=f"diar-{utterance.utterance_id}",
        )
        utterance.diar_task = task
        self._diar_tasks.add(task)
        task.add_done_callback(self._diar_tasks.discard)

    async def _run_diarization(
        self,
        utterance: UtteranceState,
        audio: np.ndarray,
        offset_samples: int,
        end_samples: int,
    ) -> None:
        try:
            utterance.activities = await self.diarizer.update(
                utterance.utterance_id,
                audio,
                self.settings.sample_rate,
                offset_samples,
            )
            utterance.diar_submitted_samples = max(
                utterance.diar_submitted_samples,
                end_samples,
            )
        except Exception:
            ERRORS.labels(stage="diarization").inc()
        finally:
            utterance.diar_pending = False
            if self.current is utterance:
                current_ms = duration_ms(utterance.pcm, self.settings.sample_rate)
                if current_ms >= utterance.next_diar_ms:
                    self._schedule_diarization(utterance)

    async def _final_diarization(
        self,
        utterance: UtteranceState,
        audio: np.ndarray,
    ) -> list[SpeakerActivity]:
        """Flush the stateful diarization stream without suppressing final ASR.

        Periodic calls submit only new PCM. The final call waits for any active
        update, then submits the remaining suffix and asks the sidecar to flush
        its AOSC/FIFO state. A bounded demo profile can retain cached activities.
        """

        cached = list(utterance.activities)

        async def flush() -> list[SpeakerActivity]:
            nonlocal cached
            if utterance.diar_task is not None:
                await asyncio.gather(utterance.diar_task, return_exceptions=True)
                cached = list(utterance.activities)
            offset_samples = utterance.diar_submitted_samples
            remaining = audio[offset_samples:]
            activities = await self.diarizer.update(
                utterance.utterance_id,
                remaining,
                self.settings.sample_rate,
                offset_samples,
                final=True,
            )
            utterance.diar_submitted_samples = audio.size
            return activities

        try:
            timeout = self.settings.final_diarization_timeout_seconds
            if timeout is None:
                return await flush()
            return await asyncio.wait_for(flush(), timeout=timeout)
        except asyncio.TimeoutError:
            ERRORS.labels(stage="final_diarization_timeout").inc()
            logger.warning(
                "final diarization timed out after %.3fs for session %s; using %d cached activities",
                self.settings.final_diarization_timeout_seconds,
                self.session_id,
                len(cached),
            )
            return cached
        except Exception:
            ERRORS.labels(stage="final_diarization").inc()
            logger.exception(
                "final diarization failed for session %s; using %d cached activities",
                self.session_id,
                len(cached),
            )
            return cached
        finally:
            try:
                await asyncio.wait_for(
                    self.diarizer.close_stream(utterance.utterance_id),
                    timeout=self.settings.diarizer_cleanup_timeout_seconds,
                )
            except asyncio.TimeoutError:
                ERRORS.labels(stage="diarization_cleanup_timeout").inc()
                logger.warning(
                    "diarization cleanup timed out after %.3fs for session %s",
                    self.settings.diarizer_cleanup_timeout_seconds,
                    self.session_id,
                )
            except Exception:
                ERRORS.labels(stage="diarization_cleanup").inc()
                logger.exception("diarization cleanup failed for session %s", self.session_id)

    async def _run_jobs(self) -> None:
        while True:
            job = await self.jobs.get()
            if job is None:
                self.jobs.task_done()
                return
            kind = "final" if job.final else "partial"
            inference_started = time.perf_counter()
            queue_seconds = inference_started - job.enqueued_at
            QUEUE_WAIT.labels(kind=kind).observe(queue_seconds)
            try:
                await self._infer(job, queue_seconds, inference_started)
                ASR_LATENCY.labels(kind=kind).observe(time.perf_counter() - inference_started)
            except Exception:
                ERRORS.labels(stage=kind).inc()
                logger.exception("%s inference failed for session %s", kind, self.session_id)
                await self._emit_event(
                    ErrorPayload(code="inference_failed", message="inference failed")
                )
            finally:
                if not job.final:
                    job.utterance.partial_pending = False
                    # Coalesce all audio received during inference into one latest request.
                    if self.current is job.utterance:
                        current_ms = duration_ms(job.utterance.pcm, self.settings.sample_rate)
                        if current_ms >= job.utterance.next_partial_ms:
                            self._enqueue_partial(job.utterance)
                self.jobs.task_done()

    async def _infer(
        self,
        job: _InferenceJob,
        queue_seconds: float,
        inference_started: float,
    ) -> None:
        utterance = job.utterance
        audio = pcm_s16le_to_float32(job.audio)
        if job.final and not utterance.context_hits and self.retriever.catalog.terms:
            # Short utterances can end before the first 1 s partial. Preserve the
            # unbiased-first rule with one text-only draft, then run the aligned
            # contextual final pass.
            draft = await self.scheduler.submit(
                ASRRequest(
                    request_id=f"{utterance.utterance_id}:retrieval-draft",
                    audio=audio,
                    context="",
                    final=False,
                )
            )
            utterance.context_hits = self.retriever.retrieve(draft.text)
            utterance.context_updates += 1
        context = self.retriever.prompt(utterance.context_hits)
        request = ASRRequest(
            request_id=f"{utterance.utterance_id}:{'final' if job.final else utterance.stability.revision + 1}",
            audio=audio,
            context=context,
            final=job.final,
            prefix_text="" if job.final else utterance.inference_prefix,
        )
        if job.final:
            asr_result, activities = await asyncio.gather(
                self.scheduler.submit(request),
                self._final_diarization(utterance, audio),
            )
            utterance.activities = activities
        else:
            asr_result = await self.scheduler.submit(request)
            activities = utterance.activities
        audio_end_ms = round(audio.size * 1000 / self.settings.sample_rate)
        processing_seconds = time.perf_counter() - inference_started
        latency_ms = round((time.perf_counter() - job.enqueued_at) * 1000)
        queue_ms = round(queue_seconds * 1000)
        rtf = round(processing_seconds / max(audio.size / self.settings.sample_rate, 0.001), 3)
        if job.final:
            utterance.stability.update(asr_result.text, final=True)
            words = asr_result.words or provisional_words(asr_result.text, audio_end_ms)
            attributed = attribute_words(words, activities)
            await self._emit_event(
                FinalPayload(
                    utterance_id=utterance.utterance_id,
                    text=asr_result.text,
                    words=[
                        WordPayload(
                            text=word.text,
                            start_ms=word.start_ms,
                            end_ms=word.end_ms,
                            speaker=word.speaker,
                            confidence=word.confidence,
                            overlap=word.overlap,
                        )
                        for word in attributed
                    ],
                    context_hits=[term.term_id for term in utterance.context_hits],
                    latency_ms=latency_ms,
                    queue_ms=queue_ms,
                    rtf=rtf,
                )
            )
            return

        if utterance.context_updates < self.settings.context_max_updates:
            hits = self.retriever.retrieve(asr_result.text)
            old_ids = [term.term_id for term in utterance.context_hits]
            new_ids = [term.term_id for term in hits]
            if new_ids != old_ids:
                utterance.context_hits = hits
            utterance.context_updates += 1

        token_count = len(asr_result.token_prefixes) or len(asr_result.text)
        label_delay_tokens = math.ceil(token_count * self.settings.label_delay_ms / max(1, audio_end_ms))
        holdback_tokens = max(self.settings.rollback_tokens, label_delay_tokens)
        kept_tokens = max(0, token_count - holdback_tokens)
        candidate_stable = (
            asr_result.token_prefixes[kept_tokens - 1]
            if asr_result.token_prefixes and kept_tokens > 0
            else ""
        )
        before = utterance.stability.rewrite_violations
        stable, unstable = utterance.stability.update(
            asr_result.text,
            holdback_tokens=holdback_tokens,
            candidate_stable=candidate_stable if asr_result.token_prefixes else None,
        )
        # Match the official streaming recipe: the first two chunks are
        # unbiased; from chunk three onward, feed the previous hypothesis minus
        # the last five real tokenizer tokens as decoder prefix.
        if utterance.stability.revision >= 2 and asr_result.token_prefixes:
            rollback_index = len(asr_result.token_prefixes) - self.settings.rollback_tokens
            utterance.inference_prefix = (
                asr_result.token_prefixes[rollback_index - 1] if rollback_index > 0 else ""
            )
        else:
            utterance.inference_prefix = ""
        if utterance.stability.rewrite_violations > before:
            REWRITE_VIOLATIONS.inc()
        await self._emit_event(
            PartialPayload(
                utterance_id=utterance.utterance_id,
                revision=utterance.stability.revision,
                stable_text=stable,
                unstable_text=unstable,
                speaker_hint=dominant_speaker(activities, audio_end_ms),
                audio_end_ms=audio_end_ms,
                latency_ms=latency_ms,
                queue_ms=queue_ms,
                rtf=rtf,
            ),
            drop_if_full=True,
        )
