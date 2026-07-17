import asyncio

import numpy as np

from qwen_realtime.asr import ASRRequest, FakeASRBackend
from qwen_realtime.scheduler import BatchingScheduler


async def test_concurrent_partial_requests_are_batched():
    backend = FakeASRBackend()
    scheduler = BatchingScheduler(backend, batch_size=8, window_ms=30)
    await scheduler.start()
    requests = [
        ASRRequest(str(index), np.zeros(16_000, dtype=np.float32)) for index in range(6)
    ]
    await asyncio.gather(*(scheduler.submit(request) for request in requests))
    await scheduler.close()
    assert len(backend.calls) == 1
    assert len(backend.calls[0]) == 6


async def test_final_and_partial_requests_do_not_share_batch():
    backend = FakeASRBackend()
    scheduler = BatchingScheduler(backend, batch_size=8, window_ms=30)
    await scheduler.start()
    await asyncio.gather(
        scheduler.submit(ASRRequest("partial", np.zeros(1, dtype=np.float32))),
        scheduler.submit(ASRRequest("final", np.zeros(1, dtype=np.float32), final=True)),
    )
    await scheduler.close()
    assert len(backend.calls) == 2
    assert backend.calls[0][0].final is not backend.calls[1][0].final


async def test_global_queue_and_concurrent_dispatches_are_bounded():
    backend = FakeASRBackend(delay_seconds=0.1)
    scheduler = BatchingScheduler(
        backend,
        batch_size=1,
        window_ms=1,
        max_queue_size=1,
        max_concurrent_batches=1,
    )
    requests = [
        ASRRequest(str(index), np.zeros(1, dtype=np.float32)) for index in range(4)
    ]
    tasks = [asyncio.create_task(scheduler.submit(item)) for item in requests]

    await asyncio.sleep(0.03)
    assert scheduler.queue.maxsize == 1
    assert scheduler.queue.qsize() == 1
    assert len(scheduler.dispatches) == 1
    assert sum(task.done() for task in tasks) == 0

    await asyncio.gather(*tasks)
    await scheduler.close()
    assert len(backend.calls) == 4
