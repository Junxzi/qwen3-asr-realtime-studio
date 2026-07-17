from types import SimpleNamespace

import numpy as np
import pytest

from qwen_realtime.asr import ASRRequest, ASRResult, QwenAsyncVLLMBackend


def test_async_prompt_matches_qwen_asr_006_forced_language_format():
    class Processor:
        def apply_chat_template(self, messages, **kwargs):
            assert messages == [
                {"role": "system", "content": "catalog"},
                {"role": "user", "content": [{"type": "audio", "audio": ""}]},
            ]
            assert kwargs == {"add_generation_prompt": True, "tokenize": False}
            return "CHAT_TEMPLATE"

    backend = QwenAsyncVLLMBackend("model", None)
    backend._processor = Processor()

    assert (
        backend._prompt("catalog", "Japanese", "prefix")
        == "CHAT_TEMPLATElanguage Japanese<asr_text>prefix"
    )


async def test_async_final_alignment_skips_empty_transcriptions():
    class Aligner:
        def __init__(self) -> None:
            self.calls = []

        def align(self, audio, text, language):
            self.calls.append((audio, text, language))
            return [
                SimpleNamespace(
                    items=[SimpleNamespace(text="野村", start_time=0.1, end_time=0.4)]
                )
            ]

    backend = QwenAsyncVLLMBackend("model", "aligner")
    backend._engine = object()  # bypass GPU-only lazy loading
    backend._aligner = Aligner()

    async def generate(request: ASRRequest) -> ASRResult:
        return ASRResult(text="" if request.request_id == "silent" else "野村")

    backend._generate_one = generate  # type: ignore[method-assign]
    audio = np.zeros(16_000, dtype=np.float32)
    results = await backend.transcribe_batch(
        [
            ASRRequest("silent", audio, final=True),
            ASRRequest("speech", audio, final=True),
        ]
    )

    assert backend._aligner.calls[0][1] == ["野村"]
    assert results[0].words == []
    assert results[1].words[0].text == "野村"
    assert results[1].words[0].start_ms == 100
    assert results[1].words[0].end_ms == 400


async def test_async_backend_rejects_mixed_partial_final_batch():
    backend = QwenAsyncVLLMBackend("model", None)
    backend._engine = object()  # bypass GPU-only lazy loading
    audio = np.zeros(1, dtype=np.float32)

    with pytest.raises(ValueError, match="partial and final"):
        await backend.transcribe_batch(
            [ASRRequest("partial", audio), ASRRequest("final", audio, final=True)]
        )
