from __future__ import annotations

import asyncio
from dataclasses import dataclass

from .asr import ASRBackend, ASRRequest, ASRResult


@dataclass(slots=True)
class _Pending:
    request: ASRRequest
    future: asyncio.Future[ASRResult]


class BatchingScheduler:
    """Bounded micro-batcher; final and partial jobs never share a generate call."""

    def __init__(
        self,
        backend: ASRBackend,
        batch_size: int = 32,
        window_ms: int = 15,
        *,
        max_queue_size: int = 64,
        max_concurrent_batches: int = 2,
    ) -> None:
        if max_queue_size < 1:
            raise ValueError("max_queue_size must be at least one")
        if max_concurrent_batches < 1:
            raise ValueError("max_concurrent_batches must be at least one")
        self.backend = backend
        self.batch_size = batch_size
        self.window_ms = window_ms
        self.queue: asyncio.Queue[_Pending | None] = asyncio.Queue(maxsize=max_queue_size)
        self.dispatch_slots = asyncio.Semaphore(max_concurrent_batches)
        self.task: asyncio.Task[None] | None = None
        self.dispatches: set[asyncio.Task[None]] = set()

    async def start(self) -> None:
        if self.task is None:
            self.task = asyncio.create_task(self._run(), name="asr-microbatcher")

    async def close(self) -> None:
        if self.task is not None:
            await self.queue.put(None)
            await self.task
            if self.dispatches:
                await asyncio.gather(*self.dispatches)
            close = getattr(self.backend, "close", None)
            if close is not None:
                result = close()
                if asyncio.iscoroutine(result):
                    await result
            self.task = None

    async def submit(self, request: ASRRequest) -> ASRResult:
        if self.task is None:
            await self.start()
        future = asyncio.get_running_loop().create_future()
        await self.queue.put(_Pending(request, future))
        return await future

    async def _run(self) -> None:
        carry: _Pending | None = None
        while True:
            item = carry or await self.queue.get()
            carry = None
            if item is None:
                return
            batch = [item]
            final = item.request.final
            deadline = asyncio.get_running_loop().time() + self.window_ms / 1000
            while len(batch) < self.batch_size:
                timeout = deadline - asyncio.get_running_loop().time()
                if timeout <= 0:
                    break
                try:
                    candidate = await asyncio.wait_for(self.queue.get(), timeout)
                except asyncio.TimeoutError:
                    break
                if candidate is None:
                    await self.queue.put(None)
                    break
                if candidate.request.final != final:
                    carry = candidate
                    break
                batch.append(candidate)
            await self.dispatch_slots.acquire()
            dispatch = asyncio.create_task(self._dispatch(batch), name="asr-dispatch")
            self.dispatches.add(dispatch)
            dispatch.add_done_callback(self.dispatches.discard)

    async def _dispatch(self, batch: list[_Pending]) -> None:
        try:
            results = await self.backend.transcribe_batch([pending.request for pending in batch])
            if len(results) != len(batch):
                raise RuntimeError("ASR backend returned a mismatched batch length")
            for pending, result in zip(batch, results, strict=True):
                if not pending.future.cancelled():
                    pending.future.set_result(result)
        except Exception as exc:
            for pending in batch:
                if not pending.future.cancelled():
                    pending.future.set_exception(exc)
        finally:
            self.dispatch_slots.release()
