from __future__ import annotations

import math

import numpy as np
import pytest

from qwen_realtime.diarization import (
    DiarizationUpdate,
    EnergyDiarizer,
    NeMoSortformerDiarizer,
    _NeMoStreamState,
)


async def test_energy_diarizer_updates_are_gap_checked_and_idempotent():
    diarizer = EnergyDiarizer()
    first = await diarizer.update("stream", np.zeros(800, dtype=np.float32), 16_000, 0)
    duplicate = await diarizer.update("stream", np.zeros(800, dtype=np.float32), 16_000, 0)
    second = await diarizer.update("stream", np.zeros(800, dtype=np.float32), 16_000, 800)

    assert first[0].end_ms == 50
    assert duplicate[0].end_ms == 50
    assert second[0].end_ms == 100
    with pytest.raises(ValueError, match="audio gap"):
        await diarizer.update("stream", np.zeros(1, dtype=np.float32), 16_000, 2_000)
    await diarizer.close_stream("stream")


async def test_sortformer_keeps_aosc_state_and_only_forwards_new_fixed_chunks(monkeypatch):
    diarizer = NeMoSortformerDiarizer(chunk_frames=6, max_speakers=2)
    next_state = 0
    forwarded_batches: list[list[int]] = []

    def new_stream_state():
        nonlocal next_state
        next_state += 1
        return _NeMoStreamState(nemo_state=f"state-{next_state}")

    def stream_step(states, audios):
        forwarded_batches.append([audio.size for audio in audios])
        predictions = [
            np.full((math.ceil(audio.size / 1280), 4), 0.9, dtype=np.float32)
            for audio in audios
        ]
        return [f"next-{state.nemo_state}" for state in states], predictions

    monkeypatch.setattr(diarizer, "_new_stream_state", new_stream_state)
    monkeypatch.setattr(diarizer, "_stream_step_sync", stream_step)

    audio = np.zeros(8000, dtype=np.float32)
    first = await diarizer.update_batch(
        [
            DiarizationUpdate("a", audio, 16_000, 0),
            DiarizationUpdate("b", audio, 16_000, 0),
        ]
    )
    await diarizer.update("a", audio, 16_000, 8000)
    final = await diarizer.update("a", np.empty(0, dtype=np.float32), 16_000, 16_000, final=True)
    duplicate = await diarizer.update("a", audio, 16_000, 0, final=True)

    assert forwarded_batches == [[7680, 7680], [7680], [640]]
    assert first[0] and first[1]
    assert final == duplicate
    assert diarizer._streams["a"].next_sample == 16_000
    assert diarizer._streams["a"].pending.size == 0
    assert diarizer._streams["a"].finalized is True

    await diarizer.close_stream("a")
    assert "a" not in diarizer._streams
