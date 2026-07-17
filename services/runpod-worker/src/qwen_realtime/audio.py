from __future__ import annotations

import numpy as np


def pcm_s16le_to_float32(pcm: bytes) -> np.ndarray:
    if len(pcm) % 2:
        raise ValueError("PCM S16LE payload length must be even")
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0


def duration_ms(pcm: bytes, sample_rate: int = 16_000) -> int:
    return round((len(pcm) / 2) * 1000 / sample_rate)


def frame_bytes(milliseconds: int, sample_rate: int = 16_000) -> int:
    return int(sample_rate * milliseconds / 1000) * 2
