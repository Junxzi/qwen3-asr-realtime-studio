from __future__ import annotations

import sys
from types import ModuleType, SimpleNamespace

from qwen_realtime.diarization import NeMoSortformerDiarizer


def test_sortformer_directory_uses_pinned_archive_and_device(monkeypatch, tmp_path):
    archive = tmp_path / "pinned-model.nemo"
    archive.write_bytes(b"test")
    calls: dict[str, str] = {}

    class FakeModel:
        def __init__(self):
            self.sortformer_modules = SimpleNamespace(
                chunk_len=0,
                chunk_left_context=1,
                chunk_right_context=1,
                spkcache_len=0,
                fifo_len=0,
                spkcache_update_period=0,
                _check_streaming_parameters=lambda: calls.setdefault("checked", "yes"),
            )

        @classmethod
        def restore_from(cls, path: str):
            calls["path"] = path
            return cls()

        @classmethod
        def from_pretrained(cls, model_name: str):
            raise AssertionError(f"unexpected remote model load: {model_name}")

        def to(self, device: str):
            calls["device"] = device
            return self

        def eval(self):
            calls["eval"] = "yes"
            return self

    nemo = ModuleType("nemo")
    collections = ModuleType("nemo.collections")
    asr = ModuleType("nemo.collections.asr")
    models = ModuleType("nemo.collections.asr.models")
    models.SortformerEncLabelModel = FakeModel  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "nemo", nemo)
    monkeypatch.setitem(sys.modules, "nemo.collections", collections)
    monkeypatch.setitem(sys.modules, "nemo.collections.asr", asr)
    monkeypatch.setitem(sys.modules, "nemo.collections.asr.models", models)

    diarizer = NeMoSortformerDiarizer(str(tmp_path), device="cuda:0")
    assert diarizer._load() is diarizer._load()
    assert calls == {
        "path": str(archive),
        "device": "cuda:0",
        "eval": "yes",
        "checked": "yes",
    }
    assert diarizer._model.streaming_mode is True
    assert diarizer._model.async_streaming is True
    assert diarizer._model.sortformer_modules.chunk_len == 6
    assert diarizer._model.sortformer_modules.chunk_left_context == 0
    assert diarizer._model.sortformer_modules.chunk_right_context == 0
