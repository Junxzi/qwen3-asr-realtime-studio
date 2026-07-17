from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any, Protocol

import numpy as np

from .alignment import WordTiming
from .metrics import BACKEND_STAGE_LATENCY


@dataclass(frozen=True, slots=True)
class ASRRequest:
    request_id: str
    audio: np.ndarray
    context: str = ""
    language: str = "Japanese"
    final: bool = False
    prefix_text: str = ""


@dataclass(frozen=True, slots=True)
class ASRResult:
    text: str
    language: str = "Japanese"
    words: list[WordTiming] = field(default_factory=list)
    token_prefixes: tuple[str, ...] = ()


class ASRBackend(Protocol):
    async def transcribe_batch(self, requests: list[ASRRequest]) -> list[ASRResult]: ...


class FakeASRBackend:
    """Deterministic backend for protocol, batching, and load-harness tests."""

    def __init__(self, script: list[str] | None = None, delay_seconds: float = 0.0) -> None:
        self.script = script or ["野村證券の株価について確認します"]
        self.delay_seconds = delay_seconds
        self.calls: list[list[ASRRequest]] = []
        self._index = 0

    async def transcribe_batch(self, requests: list[ASRRequest]) -> list[ASRResult]:
        if self.delay_seconds:
            await asyncio.sleep(self.delay_seconds)
        self.calls.append(requests)
        results: list[ASRResult] = []
        for request in requests:
            text = self.script[min(self._index, len(self.script) - 1)]
            self._index += 1
            duration_ms = round(request.audio.size * 1000 / 16_000)
            words: list[WordTiming] = []
            if request.final and text:
                units = list(text)
                width = max(1, duration_ms // len(units))
                words = [
                    WordTiming(unit, index * width, min(duration_ms, (index + 1) * width), 0.99)
                    for index, unit in enumerate(units)
                ]
            results.append(
                ASRResult(
                    text=text,
                    words=words,
                    token_prefixes=tuple(text[:index] for index in range(1, len(text) + 1)),
                )
            )
        return results


def _value(item: Any, *names: str, default: Any = None) -> Any:
    for name in names:
        if isinstance(item, dict) and name in item:
            return item[name]
        if hasattr(item, name):
            return getattr(item, name)
    return default


def _extract_words(raw: Any) -> list[WordTiming]:
    words: list[WordTiming] = []
    # qwen-asr 0.0.6 returns ForcedAlignResult(items=[...]).  It is currently
    # iterable too, but using the documented ``items`` field keeps this adapter
    # resilient to dataclass/proxy implementations that expose only the field.
    items = _value(raw, "items", default=raw) if raw is not None else []
    for item in items or []:
        text = str(_value(item, "text", "word", default=""))
        start = _value(item, "start_time", "start", "start_sec", default=0.0)
        end = _value(item, "end_time", "end", "end_sec", default=start)
        # Official Qwen ForcedAlignItem values are seconds.
        start_float, end_float = float(start), float(end)
        words.append(
            WordTiming(
                text=text,
                start_ms=round(start_float * 1000),
                end_ms=round(end_float * 1000),
                confidence=float(_value(item, "confidence", "score", default=1.0)),
            )
        )
    return words


def _token_prefixes(tokenizer: Any, text: str) -> tuple[str, ...]:
    token_ids = tokenizer.encode(text, add_special_tokens=False)
    return tuple(
        tokenizer.decode(token_ids[:index], skip_special_tokens=True)
        for index in range(1, len(token_ids) + 1)
    )


class QwenVLLMBackend:
    """Batched official qwen-asr vLLM wrapper, loaded only on the GPU host."""

    def __init__(
        self,
        model_path: str,
        aligner_path: str | None,
        dtype: str = "bfloat16",
        gpu_memory_utilization: float = 0.72,
        max_batch_size: int = 32,
        partial_max_new_tokens: int = 32,
        final_max_new_tokens: int = 512,
    ) -> None:
        self.model_path = model_path
        self.aligner_path = aligner_path
        self.dtype = dtype
        self.gpu_memory_utilization = gpu_memory_utilization
        self.max_batch_size = max_batch_size
        self.partial_max_new_tokens = partial_max_new_tokens
        self.final_max_new_tokens = final_max_new_tokens
        self._model: Any = None
        self._lock = asyncio.Lock()

    def _load(self) -> Any:
        if self._model is not None:
            return self._model
        try:
            import torch
            from qwen_asr import Qwen3ASRModel
        except ImportError as exc:  # pragma: no cover - RunPod only
            raise RuntimeError("install the gpu extra to use Qwen3-ASR") from exc
        aligner_kwargs = None
        if self.aligner_path:
            aligner_kwargs = {
                "dtype": torch.bfloat16,
                "device_map": "cuda:0",
            }
        self._model = Qwen3ASRModel.LLM(
            model=self.model_path,
            dtype=self.dtype,
            gpu_memory_utilization=self.gpu_memory_utilization,
            max_inference_batch_size=self.max_batch_size,
            max_new_tokens=self.final_max_new_tokens,
            forced_aligner=self.aligner_path,
            forced_aligner_kwargs=aligner_kwargs,
        )
        return self._model

    async def transcribe_batch(self, requests: list[ASRRequest]) -> list[ASRResult]:
        # vLLM owns a non-thread-safe engine. One lock preserves a single active
        # generate call while the scheduler forms continuous micro-batches.
        async with self._lock:
            return await asyncio.to_thread(self._transcribe_sync, requests)

    def _transcribe_sync(self, requests: list[ASRRequest]) -> list[ASRResult]:
        model = self._load()
        is_final = bool(requests) and all(request.final for request in requests)
        needs_timestamps = is_final and bool(self.aligner_path)
        # qwen-asr stores public vLLM SamplingParams on the wrapper. Final and
        # partial batches are separated by BatchingScheduler and this method is
        # lock-protected, so changing the per-call cap is race-free.
        from vllm import SamplingParams

        model.sampling_params = SamplingParams(
            temperature=0.0,
            max_tokens=self.final_max_new_tokens if is_final else self.partial_max_new_tokens,
        )
        raw_results = model.transcribe(
            audio=[request.audio for request in requests],
            language=[request.language for request in requests],
            context=[request.context for request in requests],
            return_time_stamps=needs_timestamps,
        )
        parsed: list[ASRResult] = []
        tokenizer = model.processor.tokenizer
        for result in raw_results:
            text = str(_value(result, "text", default=""))
            parsed.append(
                ASRResult(
                    text=text,
                    language=str(_value(result, "language", default="Japanese")),
                    words=_extract_words(_value(result, "time_stamps", "timestamps", default=[])),
                    token_prefixes=_token_prefixes(tokenizer, text),
                )
            )
        return parsed


class QwenAsyncVLLMBackend:
    """vLLM AsyncLLM backend with native continuous batching across calls."""

    def __init__(
        self,
        model_path: str,
        aligner_path: str | None,
        dtype: str = "bfloat16",
        gpu_memory_utilization: float = 0.72,
        max_batch_size: int = 32,
        partial_max_new_tokens: int = 32,
        final_max_new_tokens: int = 512,
        compile_aligner: bool = True,
        warmup_aligner: bool = True,
    ) -> None:
        self.model_path = model_path
        self.aligner_path = aligner_path
        self.dtype = dtype
        self.gpu_memory_utilization = gpu_memory_utilization
        self.max_batch_size = max_batch_size
        self.partial_max_new_tokens = partial_max_new_tokens
        self.final_max_new_tokens = final_max_new_tokens
        self.compile_aligner = compile_aligner
        self.warmup_aligner = warmup_aligner
        self._engine: Any = None
        self._processor: Any = None
        self._aligner: Any = None
        self._aligner_lock = asyncio.Lock()
        self._parse_output: Any = None
        self._load_lock = asyncio.Lock()

    async def _ensure_loaded(self) -> None:
        if self._engine is not None:
            return
        async with self._load_lock:
            if self._engine is not None:
                return
            import torch
            from qwen_asr import (  # noqa: F401 - registers vLLM model
                Qwen3ASRModel,
                Qwen3ForcedAligner,
            )
            from qwen_asr.core.transformers_backend import Qwen3ASRProcessor
            from qwen_asr.inference.utils import parse_asr_output
            from vllm import AsyncEngineArgs, AsyncLLMEngine

            args = AsyncEngineArgs(
                model=self.model_path,
                dtype=self.dtype,
                gpu_memory_utilization=self.gpu_memory_utilization,
                max_num_seqs=self.max_batch_size,
                enable_log_requests=False,
            )
            self._engine = AsyncLLMEngine.from_engine_args(args)
            self._processor = Qwen3ASRProcessor.from_pretrained(
                self.model_path, fix_mistral_regex=True
            )
            self._parse_output = parse_asr_output
            if self.aligner_path:
                torch.set_float32_matmul_precision("high")
                self._aligner = Qwen3ForcedAligner.from_pretrained(
                    self.aligner_path,
                    dtype=torch.bfloat16,
                    device_map="cuda:0",
                )
                if self.compile_aligner and hasattr(self._aligner.model, "thinker"):
                    self._aligner.model.thinker = torch.compile(
                        self._aligner.model.thinker,
                        mode="reduce-overhead",
                        fullgraph=False,
                    )
                if self.compile_aligner and self.warmup_aligner:
                    await asyncio.to_thread(self._warm_aligner)

    def _warm_aligner(self) -> None:
        """Compile both static and automatic-dynamic graphs before readiness."""
        if self._aligner is None:
            return
        for batch_size, seconds, text in (
            (1, 1.0, "起動確認"),
            (2, 1.2, "起動確認を行います"),
        ):
            samples = round(16_000 * seconds)
            axis = np.arange(samples, dtype=np.float32) / 16_000
            audio = (0.01 * np.sin(2 * np.pi * 220 * axis)).astype(np.float32)
            self._aligner.align(
                [(audio, 16_000)] * batch_size,
                [text] * batch_size,
                ["Japanese"] * batch_size,
            )

    def _prompt(self, context: str, language: str, prefix_text: str) -> str:
        messages = [
            {"role": "system", "content": context or ""},
            {"role": "user", "content": [{"type": "audio", "audio": ""}]},
        ]
        base = self._processor.apply_chat_template(
            messages,
            add_generation_prompt=True,
            tokenize=False,
        )
        return base + f"language {language}<asr_text>" + prefix_text

    async def _generate_one(self, request: ASRRequest) -> ASRResult:
        from vllm import SamplingParams

        params = SamplingParams(
            temperature=0.0,
            max_tokens=self.final_max_new_tokens if request.final else self.partial_max_new_tokens,
        )
        inputs = {
            "prompt": self._prompt(request.context, request.language, request.prefix_text),
            "multi_modal_data": {"audio": [request.audio]},
        }
        final_output = None
        started = time.perf_counter()
        try:
            async for output in self._engine.generate(inputs, params, request.request_id):
                final_output = output
        finally:
            BACKEND_STAGE_LATENCY.labels(stage="generate").observe(time.perf_counter() - started)
        if final_output is None:
            raise RuntimeError("vLLM returned no output")
        raw_text = request.prefix_text + final_output.outputs[0].text
        language, text = self._parse_output(raw_text, user_language=request.language)
        return ASRResult(
            text=text,
            language=language,
            token_prefixes=_token_prefixes(self._processor.tokenizer, text),
        )

    async def transcribe_batch(self, requests: list[ASRRequest]) -> list[ASRResult]:
        await self._ensure_loaded()
        if requests and any(request.final != requests[0].final for request in requests):
            raise ValueError("partial and final requests must not share an ASR batch")
        results = list(await asyncio.gather(*(self._generate_one(request) for request in requests)))
        if requests and requests[0].final and self._aligner is not None:
            # torch.compile and the Transformers model are not re-entrant. ASR
            # generation remains continuously batched, while final alignment
            # batches use one GPU critical section.
            async with self._aligner_lock:
                started = time.perf_counter()
                try:
                    alignable = [
                        index for index, result in enumerate(results) if result.text.strip()
                    ]
                    aligned = (
                        await asyncio.to_thread(
                            self._aligner.align,
                            [(requests[index].audio, 16_000) for index in alignable],
                            [results[index].text for index in alignable],
                            [results[index].language for index in alignable],
                        )
                        if alignable
                        else []
                    )
                finally:
                    BACKEND_STAGE_LATENCY.labels(stage="aligner").observe(time.perf_counter() - started)
            if len(aligned) != len(alignable):
                raise RuntimeError("forced aligner returned a mismatched batch length")
            words_by_index = {
                index: _extract_words(alignment)
                for index, alignment in zip(alignable, aligned, strict=True)
            }
            results = [
                ASRResult(
                    text=result.text,
                    language=result.language,
                    words=words_by_index.get(index, []),
                    token_prefixes=result.token_prefixes,
                )
                for index, result in enumerate(results)
            ]
        return results

    async def close(self) -> None:
        if self._engine is None:
            return
        shutdown = getattr(self._engine, "shutdown", None)
        if shutdown is not None:
            result = shutdown()
            if asyncio.iscoroutine(result):
                await result
