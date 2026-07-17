from __future__ import annotations

import asyncio
import math
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

import numpy as np

from .alignment import SpeakerActivity


class Diarizer(Protocol):
    async def update(
        self,
        stream_id: str,
        audio: np.ndarray,
        sample_rate: int,
        offset_samples: int,
        *,
        final: bool = False,
    ) -> list[SpeakerActivity]: ...

    async def close_stream(self, stream_id: str) -> None: ...


class EnergyDiarizer:
    """Single-speaker development fallback; never use for acceptance WDER."""

    def __init__(self) -> None:
        self._stream_lengths: dict[str, int] = {}

    async def update(
        self,
        stream_id: str,
        audio: np.ndarray,
        sample_rate: int,
        offset_samples: int,
        *,
        final: bool = False,
    ) -> list[SpeakerActivity]:
        del final
        current = self._stream_lengths.get(stream_id, 0)
        if offset_samples > current:
            raise ValueError("diarization update contains an audio gap")
        current = max(current, offset_samples + audio.size)
        self._stream_lengths[stream_id] = current
        duration_ms = round(current * 1000 / sample_rate)
        if not current:
            return []
        return [SpeakerActivity(0, duration_ms, "speaker_0", 0.5)]

    async def close_stream(self, stream_id: str) -> None:
        self._stream_lengths.pop(stream_id, None)


@dataclass(frozen=True, slots=True)
class DiarizationUpdate:
    stream_id: str
    audio: np.ndarray
    sample_rate: int
    offset_samples: int
    final: bool = False


@dataclass(slots=True)
class _NeMoStreamState:
    nemo_state: object
    next_sample: int = 0
    pending: np.ndarray = field(default_factory=lambda: np.empty(0, dtype=np.float32))
    probability_chunks: list[np.ndarray] = field(default_factory=list)
    finalized: bool = False
    updated_at: float = field(default_factory=time.monotonic)


class NeMoSortformerDiarizer:
    """Streaming-Sortformer adapter with arrival-order labels capped at two speakers.

    Each logical call stream keeps the official NeMo StreamingSortformerState
    (AOSC + FIFO), so arrival-order speaker labels survive VAD utterance resets.
    Only newly arrived audio is preprocessed and forwarded, so inference cost is
    linear in stream duration rather than repeatedly reprocessing the full prefix.
    """

    def __init__(
        self,
        model_name: str = "nvidia/diar_streaming_sortformer_4spk-v2.1",
        threshold: float = 0.5,
        frame_ms: int = 80,
        max_speakers: int = 2,
        device: str = "cuda",
        chunk_frames: int = 6,
        speaker_cache_frames: int = 188,
        fifo_frames: int = 188,
        speaker_cache_update_frames: int = 144,
    ) -> None:
        self.model_name = model_name
        self.threshold = threshold
        self.frame_ms = frame_ms
        self.max_speakers = max_speakers
        self.device = device
        self.chunk_frames = chunk_frames
        self.speaker_cache_frames = speaker_cache_frames
        self.fifo_frames = fifo_frames
        self.speaker_cache_update_frames = speaker_cache_update_frames
        self._model: object | None = None
        self._lock = asyncio.Lock()
        self._streams: dict[str, _NeMoStreamState] = {}

    def _load(self) -> object:
        if self._model is None:
            try:
                from nemo.collections.asr.models import SortformerEncLabelModel
            except ImportError as exc:  # pragma: no cover - RunPod only
                raise RuntimeError("install the diarization extra to use Sortformer") from exc
            model_path = Path(self.model_name)
            if model_path.is_dir():
                archives = sorted(model_path.glob("*.nemo"))
                if len(archives) != 1:
                    raise RuntimeError(
                        f"DIARIZER_MODEL directory must contain exactly one .nemo archive: {model_path}"
                    )
                loaded = SortformerEncLabelModel.restore_from(str(archives[0]))
            elif model_path.is_file():
                loaded = SortformerEncLabelModel.restore_from(str(model_path))
            else:
                loaded = SortformerEncLabelModel.from_pretrained(self.model_name)
            loaded = loaded.to(self.device).eval()
            loaded.streaming_mode = True
            loaded.async_streaming = True
            modules = loaded.sortformer_modules
            modules.chunk_len = self.chunk_frames
            modules.chunk_left_context = 0
            modules.chunk_right_context = 0
            modules.spkcache_len = self.speaker_cache_frames
            modules.fifo_len = self.fifo_frames
            modules.spkcache_update_period = self.speaker_cache_update_frames
            modules._check_streaming_parameters()
            self._model = loaded
        return self._model

    async def analyze(self, audio: np.ndarray, sample_rate: int) -> list[SpeakerActivity]:
        """Compatibility one-shot path used by the standalone smoke script."""

        stream_id = f"oneshot-{uuid.uuid4().hex}"
        try:
            return await self.update(stream_id, audio, sample_rate, 0, final=True)
        finally:
            await self.close_stream(stream_id)

    async def update(
        self,
        stream_id: str,
        audio: np.ndarray,
        sample_rate: int,
        offset_samples: int,
        *,
        final: bool = False,
    ) -> list[SpeakerActivity]:
        results = await self.update_batch(
            [DiarizationUpdate(stream_id, audio, sample_rate, offset_samples, final)]
        )
        return results[0]

    async def update_batch(
        self, updates: list[DiarizationUpdate]
    ) -> list[list[SpeakerActivity]]:
        if not updates:
            return []
        if any(update.sample_rate != 16_000 for update in updates):
            raise ValueError("Sortformer requires 16 kHz audio")
        if len({update.stream_id for update in updates}) != len(updates):
            raise ValueError("only one update per diarization stream may be batched")
        async with self._lock:
            return await asyncio.to_thread(self._update_batch_sync, updates)

    async def close_stream(self, stream_id: str) -> None:
        async with self._lock:
            self._streams.pop(stream_id, None)

    async def cleanup_stale_streams(self, max_idle_seconds: float) -> int:
        cutoff = time.monotonic() - max_idle_seconds
        async with self._lock:
            stale = [
                stream_id
                for stream_id, state in self._streams.items()
                if state.updated_at < cutoff
            ]
            for stream_id in stale:
                self._streams.pop(stream_id, None)
            return len(stale)

    def _new_stream_state(self) -> _NeMoStreamState:
        model = self._load()
        nemo_state = model.sortformer_modules.init_streaming_state(
            batch_size=1,
            async_streaming=True,
            device=model.device,
        )
        return _NeMoStreamState(nemo_state=nemo_state)

    def _update_batch_sync(
        self, updates: list[DiarizationUpdate]
    ) -> list[list[SpeakerActivity]]:
        states: list[_NeMoStreamState] = []
        for update in updates:
            if update.offset_samples < 0:
                raise ValueError("diarization offset must not be negative")
            state = self._streams.get(update.stream_id)
            if state is None:
                if update.offset_samples != 0:
                    raise ValueError("a new diarization stream must start at offset zero")
                state = self._new_stream_state()
                self._streams[update.stream_id] = state
            if update.offset_samples > state.next_sample:
                raise ValueError("diarization update contains an audio gap")
            overlap = state.next_sample - update.offset_samples
            if overlap < update.audio.size:
                if state.finalized:
                    raise ValueError("diarization stream is already finalized")
                new_audio = update.audio[overlap:].astype(np.float32, copy=False)
                state.pending = np.concatenate((state.pending, new_audio))
                state.next_sample += new_audio.size
            state.updated_at = time.monotonic()
            states.append(state)

        chunk_samples = round(self.chunk_frames * self.frame_ms * 16_000 / 1000)
        while True:
            ready_states: list[_NeMoStreamState] = []
            ready_audio: list[np.ndarray] = []
            ready_sizes: list[int] = []
            for update, state in zip(updates, states, strict=True):
                if state.pending.size >= chunk_samples:
                    take = chunk_samples
                elif update.final and state.pending.size:
                    take = state.pending.size
                else:
                    continue
                ready_states.append(state)
                ready_audio.append(state.pending[:take])
                ready_sizes.append(take)
            if not ready_states:
                break
            next_states, predictions = self._stream_step_sync(ready_states, ready_audio)
            for state, next_state, prediction, consumed in zip(
                ready_states,
                next_states,
                predictions,
                ready_sizes,
                strict=True,
            ):
                state.nemo_state = next_state
                state.pending = state.pending[consumed:]
                if prediction.size:
                    state.probability_chunks.append(prediction)

        results: list[list[SpeakerActivity]] = []
        for update, state in zip(updates, states, strict=True):
            if update.final and not state.pending.size:
                state.finalized = True
            probabilities = (
                np.concatenate(state.probability_chunks, axis=0)
                if state.probability_chunks
                else np.empty((0, self.max_speakers), dtype=np.float32)
            )
            duration_ms = round(state.next_sample * 1000 / update.sample_rate)
            results.append(self._activities_from_probabilities(probabilities, duration_ms))
        return results

    def _stream_step_sync(
        self,
        states: list[_NeMoStreamState],
        audios: list[np.ndarray],
    ) -> tuple[list[object], list[np.ndarray]]:
        import torch

        model = self._load()
        lengths_np = np.asarray([audio.size for audio in audios], dtype=np.int64)
        padded = np.zeros((len(audios), int(lengths_np.max(initial=0))), dtype=np.float32)
        for index, audio in enumerate(audios):
            padded[index, : audio.size] = audio
        signal = torch.from_numpy(padded).to(self.device)
        lengths = torch.from_numpy(lengths_np).to(self.device)
        with torch.inference_mode():
            processed, processed_lengths = model.preprocessor(
                input_signal=signal,
                length=lengths,
            )
            max_processed_length = int(processed_lengths.max().item())
            processed = processed[:, :, :max_processed_length].transpose(1, 2)
            combined_state = self._combine_nemo_states(
                [state.nemo_state for state in states]
            )
            empty_predictions = torch.zeros(
                (len(states), 0, model.sortformer_modules.n_spk),
                device=model.device,
            )
            combined_state, chunk_predictions = model.forward_streaming_step(
                processed_signal=processed,
                processed_signal_length=processed_lengths,
                streaming_state=combined_state,
                total_preds=empty_predictions,
            )
            # streaming_update_async zero-pads invalid output frames. Valid
            # sigmoid probabilities are positive, including silence frames.
            valid_frames = (chunk_predictions.abs().sum(dim=2) > 0).sum(dim=1)
        split_states = self._split_nemo_state(combined_state, len(states))
        cpu_predictions = chunk_predictions.detach().float().cpu().numpy()
        valid_frame_counts = valid_frames.detach().cpu().tolist()
        predictions = [
            cpu_predictions[
                index,
                : min(int(valid_frame_counts[index]), cpu_predictions.shape[1]),
                :,
            ]
            for index in range(len(states))
        ]
        return split_states, predictions

    @staticmethod
    def _combine_nemo_states(states: list[object]) -> object:
        import torch

        combined = type(states[0])()
        for name in (
            "spkcache",
            "spkcache_lengths",
            "spkcache_preds",
            "fifo",
            "fifo_lengths",
            "fifo_preds",
            "spk_perm",
            "mean_sil_emb",
            "n_sil_frames",
        ):
            values = [getattr(state, name) for state in states]
            if all(value is None for value in values):
                setattr(combined, name, None)
            elif name == "fifo_preds" and any(value is None for value in values):
                template = next(value for value in values if value is not None)
                setattr(
                    combined,
                    name,
                    torch.cat(
                        [torch.zeros_like(template) if value is None else value for value in values],
                        dim=0,
                    ),
                )
            elif name == "spk_perm" and any(value is None for value in values):
                # Async inference does not consume spk_perm; it is optional
                # bookkeeping emitted only by the synchronous update path.
                setattr(combined, name, None)
            elif any(value is None for value in values):
                raise RuntimeError(f"inconsistent Sortformer state field: {name}")
            else:
                setattr(combined, name, torch.cat(values, dim=0))
        return combined

    @staticmethod
    def _split_nemo_state(state: object, count: int) -> list[object]:
        results = [type(state)() for _ in range(count)]
        for name in (
            "spkcache",
            "spkcache_lengths",
            "spkcache_preds",
            "fifo",
            "fifo_lengths",
            "fifo_preds",
            "spk_perm",
            "mean_sil_emb",
            "n_sil_frames",
        ):
            value = getattr(state, name)
            for index, result in enumerate(results):
                setattr(result, name, None if value is None else value[index : index + 1].clone())
        return results

    def _analyze_batch_sync(self, audios: list[np.ndarray]) -> list[list[SpeakerActivity]]:
        import torch

        model = self._load()
        lengths = np.asarray([audio.size for audio in audios], dtype=np.int64)
        padded = np.zeros((len(audios), int(lengths.max(initial=0))), dtype=np.float32)
        for index, audio in enumerate(audios):
            padded[index, : audio.size] = audio.astype(np.float32, copy=False)
        signal = torch.from_numpy(padded).to(self.device)
        length = torch.from_numpy(lengths).to(self.device)
        with torch.inference_mode():
            probabilities = model(audio_signal=signal, audio_signal_length=length).detach().cpu().numpy()
        return [
            self._activities_from_probabilities(
                probabilities[index], round(int(lengths[index]) * 1000 / 16_000)
            )
            for index in range(len(audios))
        ]

    def _activities_from_probabilities(
        self, probabilities: np.ndarray, duration_ms: int
    ) -> list[SpeakerActivity]:
        probabilities = probabilities[: math.ceil(duration_ms / self.frame_ms)]
        first_active: list[tuple[int, int]] = []
        for channel in range(probabilities.shape[1]):
            frames = np.flatnonzero(probabilities[:, channel] >= self.threshold)
            if frames.size:
                first_active.append((int(frames[0]), channel))
        channel_map = {
            channel: f"speaker_{arrival_index}"
            for arrival_index, (_, channel) in enumerate(sorted(first_active)[: self.max_speakers])
        }
        activities: list[SpeakerActivity] = []
        for channel, speaker in channel_map.items():
            active = probabilities[:, channel] >= self.threshold
            start: int | None = None
            for index, enabled in enumerate(np.append(active, False)):
                if enabled and start is None:
                    start = index
                elif not enabled and start is not None:
                    confidence = float(probabilities[start:index, channel].mean())
                    activities.append(
                        SpeakerActivity(
                            start * self.frame_ms,
                            min(duration_ms, index * self.frame_ms),
                            speaker,
                            confidence,
                        )
                    )
                    start = None
        return sorted(activities, key=lambda item: (item.start_ms, item.speaker))


class RemoteDiarizer:
    """Process-isolated Sortformer client (required by vLLM/NeMo protobuf pins)."""

    def __init__(self, url: str, timeout_seconds: float = 4.0) -> None:
        self.url = url
        self.timeout_seconds = timeout_seconds

    async def update(
        self,
        stream_id: str,
        audio: np.ndarray,
        sample_rate: int,
        offset_samples: int,
        *,
        final: bool = False,
    ) -> list[SpeakerActivity]:
        import httpx

        # The RunPod base image injects an outbound proxy and does not always
        # exempt loopback. The sidecar is local-only, so proxy inheritance is
        # both unnecessary and capable of routing 127.0.0.1 to nginx.
        async with httpx.AsyncClient(timeout=self.timeout_seconds, trust_env=False) as client:
            response = await client.post(
                self.url,
                content=audio.astype("<f4", copy=False).tobytes(),
                headers={
                    "content-type": "application/octet-stream",
                    "x-sample-rate": str(sample_rate),
                    "x-stream-id": stream_id,
                    "x-offset-samples": str(offset_samples),
                    "x-final": "true" if final else "false",
                },
            )
            response.raise_for_status()
            payload = response.json()
        if int(payload["next_offset_samples"]) < offset_samples + audio.size:
            raise RuntimeError("Sortformer sidecar did not acknowledge the complete audio update")
        return [SpeakerActivity(**item) for item in payload["activities"]]

    async def close_stream(self, stream_id: str) -> None:
        import httpx

        async with httpx.AsyncClient(timeout=self.timeout_seconds, trust_env=False) as client:
            response = await client.delete(self.url, headers={"x-stream-id": stream_id})
            response.raise_for_status()


def dominant_speaker(activities: list[SpeakerActivity], audio_end_ms: int, window_ms: int = 500) -> str | None:
    start = max(0, audio_end_ms - window_ms)
    totals: dict[str, int] = {}
    for activity in activities:
        overlap = max(0, min(audio_end_ms, activity.end_ms) - max(start, activity.start_ms))
        totals[activity.speaker] = totals.get(activity.speaker, 0) + overlap
    if not totals:
        return None
    return max(totals, key=lambda speaker: (totals[speaker], speaker))
