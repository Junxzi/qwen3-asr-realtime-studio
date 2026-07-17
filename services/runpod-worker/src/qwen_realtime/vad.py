from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Protocol

import numpy as np

from .audio import pcm_s16le_to_float32


@dataclass(frozen=True, slots=True)
class VADDecision:
    probability: float
    speech_started: bool
    speech_ended: bool
    is_speech: bool


class VADSession(Protocol):
    def feed(self, pcm: bytes) -> VADDecision: ...

    def flush(self) -> VADDecision: ...


class EnergyVADSession:
    """Deterministic local/test VAD with the same state contract as Silero."""

    def __init__(
        self,
        sample_rate: int = 16_000,
        threshold: float = 0.012,
        end_silence_ms: int = 480,
    ) -> None:
        self.sample_rate = sample_rate
        self.threshold = threshold
        self.end_silence_ms = end_silence_ms
        self.active = False
        self.trailing_silence_ms = 0.0

    def feed(self, pcm: bytes) -> VADDecision:
        samples = pcm_s16le_to_float32(pcm)
        rms = float(np.sqrt(np.mean(np.square(samples)))) if samples.size else 0.0
        probability = min(1.0, rms / max(self.threshold * 2.0, 1e-6))
        speech = rms >= self.threshold
        duration = samples.size * 1000 / self.sample_rate
        started = speech and not self.active
        ended = False
        if speech:
            self.active = True
            self.trailing_silence_ms = 0.0
        elif self.active:
            self.trailing_silence_ms += duration
            if self.trailing_silence_ms >= self.end_silence_ms:
                self.active = False
                self.trailing_silence_ms = 0.0
                ended = True
        return VADDecision(probability, started, ended, self.active)

    def flush(self) -> VADDecision:
        ended = self.active
        self.active = False
        self.trailing_silence_ms = 0.0
        return VADDecision(0.0, False, ended, False)


class SileroVADFactory:
    """Creates one stateful Silero model per call session.

    Silero's JIT wrapper stores recurrent state on the model object itself.  A
    shared model therefore leaks history whenever frames from two WebSockets
    are interleaved.  Keep the first eagerly loaded model for the first call,
    then load a small independent JIT instance for every additional call.
    """

    def __init__(
        self,
        threshold: float = 0.5,
        end_silence_ms: int = 480,
        model_loader: Callable[..., object] | None = None,
    ) -> None:
        if model_loader is None:
            try:
                from silero_vad import load_silero_vad
            except ImportError as exc:  # pragma: no cover - GPU image only
                raise RuntimeError("install the gpu extra to use Silero VAD") from exc
            model_loader = load_silero_vad
        self._model_loader = model_loader
        # Eager loading preserves startup/readiness validation while still
        # assigning an exclusive model instance to the first accepted call.
        self._first_model: object | None = self._load_model()
        self.threshold = threshold
        self.end_silence_ms = end_silence_ms

    def _load_model(self) -> object:
        return self._model_loader(onnx=False)

    def create(self) -> "SileroVADSession":
        model = self._first_model
        if model is None:
            model = self._load_model()
        else:
            self._first_model = None
        return SileroVADSession(model, self.threshold, self.end_silence_ms)


class SileroVADSession:
    def __init__(self, model: object, threshold: float, end_silence_ms: int) -> None:
        self.model = model
        self.threshold = threshold
        self.end_silence_ms = end_silence_ms
        self.active = False
        self.trailing_silence_ms = 0.0
        self.pending = np.empty(0, dtype=np.float32)
        self._reset_model()

    def _reset_model(self) -> None:
        reset_states = getattr(self.model, "reset_states", None)
        if callable(reset_states):
            reset_states()

    def feed(self, pcm: bytes) -> VADDecision:
        import torch

        samples = pcm_s16le_to_float32(pcm)
        self.pending = np.concatenate((self.pending, samples))
        probabilities: list[float] = []
        while self.pending.size >= 512:
            frame, self.pending = self.pending[:512], self.pending[512:]
            probability = float(self.model(torch.from_numpy(frame), 16_000).item())
            probabilities.append(probability)
        probability = max(probabilities, default=0.0)
        speech = probability >= self.threshold
        duration = samples.size * 1000 / 16_000
        started = speech and not self.active
        ended = False
        if speech:
            self.active = True
            self.trailing_silence_ms = 0.0
        elif self.active:
            self.trailing_silence_ms += duration
            if self.trailing_silence_ms >= self.end_silence_ms:
                self.active = False
                self.trailing_silence_ms = 0.0
                ended = True
        return VADDecision(probability, started, ended, self.active)

    def flush(self) -> VADDecision:
        ended = self.active
        self.active = False
        self.trailing_silence_ms = 0.0
        self.pending = np.empty(0, dtype=np.float32)
        self._reset_model()
        return VADDecision(0.0, False, ended, False)
