from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import struct
import subprocess
import time
from pathlib import Path
from urllib.request import ProxyHandler, build_opener

import numpy as np
import soundfile as sf
import websockets

from qwen_realtime.security import create_worker_ticket


def frame(index: int, sample_rate: int = 16_000) -> bytes:
    frequency = 360 + (index % 5) * 40
    return b"".join(
        struct.pack("<h", int(5000 * math.sin(2 * math.pi * frequency * offset / sample_rate)))
        for offset in range(320)
    )


def wav_frames(path: Path, duration: float) -> list[bytes]:
    with sf.SoundFile(str(path)) as source:
        source_rate = source.samplerate
        audio = source.read(
            frames=round(duration * source_rate), dtype="float32", always_2d=True
        ).mean(axis=1)
    if source_rate != 16_000:
        from math import gcd

        from scipy.signal import resample_poly

        divisor = gcd(source_rate, 16_000)
        audio = resample_poly(audio, 16_000 // divisor, source_rate // divisor)
    pcm = np.clip(np.rint(audio * 32_767), -32_768, 32_767).astype("<i2").tobytes()
    return [pcm[offset : offset + 640] for offset in range(0, len(pcm), 640) if len(pcm[offset : offset + 640]) == 640]


def metric_value(url: str, name: str, labels: str = "") -> float:
    metrics_url = url.replace("ws://", "http://").replace("wss://", "https://").replace(
        "/v1/realtime", "/metrics"
    )
    body = build_opener(ProxyHandler({})).open(metrics_url, timeout=10).read().decode()
    prefix = f"{name}{{{labels}}}" if labels else name
    for line in body.splitlines():
        if line.startswith(prefix + " "):
            return float(line.rsplit(" ", 1)[1])
    return 0.0


async def sample_gpu(stop: asyncio.Event, samples: list[tuple[float, float]]) -> None:
    while not stop.is_set():
        try:
            output = await asyncio.to_thread(
                subprocess.check_output,
                [
                    "nvidia-smi",
                    "--query-gpu=utilization.gpu,memory.used",
                    "--format=csv,noheader,nounits",
                ],
                text=True,
            )
            utilization, memory = (float(value.strip()) for value in output.splitlines()[0].split(","))
            samples.append((utilization, memory))
        except (FileNotFoundError, subprocess.SubprocessError, ValueError):
            return
        try:
            await asyncio.wait_for(stop.wait(), 0.5)
        except asyncio.TimeoutError:
            pass


def percentile(values: list[float], quantile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, math.ceil(quantile * len(ordered)) - 1)]


async def one_stream(
    url: str,
    revision: str,
    model_id: str,
    worker_id: str,
    ticket_secret: str | None,
    stream_id: int,
    duration: float,
    audio_frames: list[bytes] | None,
) -> dict[str, object]:
    partial_latencies: list[float] = []
    started = time.perf_counter()
    audio_end_wall = started
    async with websockets.connect(url, max_size=8 * 1024 * 1024) as socket:
        session_id = f"load-{stream_id}"
        start = {
            "type": "session.start",
            "session_id": session_id,
            "model_id": model_id,
            "sample_rate": 16000,
            "encoding": "pcm_s16le",
            "catalog_revision": revision,
        }
        if ticket_secret:
            start["connection_ticket"] = create_worker_ticket(
                secret=ticket_secret,
                worker_id=worker_id,
                session_id=session_id,
                model_id=model_id,
                expires_at=int(time.time()) + round(duration) + 120,
            )
        await socket.send(json.dumps(start))
        ready = json.loads(await socket.recv())
        if ready.get("type") == "error":
            return {"error": ready}

        async def sender() -> None:
            nonlocal audio_end_wall
            frames = audio_frames or [frame(index) for index in range(round(duration / 0.02))]
            for audio_frame in frames:
                await socket.send(audio_frame)
                audio_end_wall = time.perf_counter()
                await asyncio.sleep(0.02)
            silence = b"\x00\x00" * 320
            for _ in range(25):
                await socket.send(silence)
                audio_end_wall = time.perf_counter()
                await asyncio.sleep(0.02)

        send_task = asyncio.create_task(sender())
        final_latency = None
        first_partial = None
        while True:
            try:
                message = json.loads(await asyncio.wait_for(socket.recv(), duration + 60))
            except (asyncio.TimeoutError, websockets.ConnectionClosed) as exc:
                await send_task
                return {"stream_id": stream_id, "error": type(exc).__name__}
            received = time.perf_counter()
            if message.get("type") == "error":
                await send_task
                return {"stream_id": stream_id, "error": message}
            if message.get("type") == "transcript.partial":
                first_partial = first_partial or received - started
                expected_audio_wall = started + message["audio_end_ms"] / 1000
                if message.get("stable_text"):
                    partial_latencies.append(max(0.0, received - expected_audio_wall))
            elif message.get("type") == "transcript.final":
                final_latency = max(0.0, received - audio_end_wall)
                break
        await send_task
    return {
        "stream_id": stream_id,
        "ttft_seconds": first_partial,
        "stable_latencies_seconds": partial_latencies,
        "final_latency_seconds": final_latency,
    }


async def run() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="ws://127.0.0.1:8000/v1/realtime")
    parser.add_argument("--catalog-revision", required=True)
    parser.add_argument(
        "--model-id",
        default=os.getenv(
            "MODEL_ID", "infodeliverailab/qwen3-asr-ja-rlbr-context-fullft"
        ),
    )
    parser.add_argument(
        "--worker-id",
        default=os.getenv("WORKER_ID") or os.getenv("RUNPOD_POD_ID", "local-worker"),
    )
    parser.add_argument("--concurrency", type=int, choices=(8, 16, 32), required=True)
    parser.add_argument("--duration", type=float, default=60.0)
    parser.add_argument("--chunk-seconds", type=float, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--wav", type=Path, help="Real call audio; μ-law/8 kHz WAV is normalized to PCM16/16 kHz")
    args = parser.parse_args()
    audio_frames = wav_frames(args.wav, args.duration) if args.wav else None
    actual_duration = len(audio_frames) * 0.02 if audio_frames else args.duration
    audio_before = metric_value(args.url, "qwen_realtime_audio_seconds_total")
    queue_count_before = metric_value(
        args.url, "qwen_realtime_queue_wait_seconds_count", 'kind="partial"'
    ) + metric_value(args.url, "qwen_realtime_queue_wait_seconds_count", 'kind="final"')
    queue_sum_before = metric_value(
        args.url, "qwen_realtime_queue_wait_seconds_sum", 'kind="partial"'
    ) + metric_value(args.url, "qwen_realtime_queue_wait_seconds_sum", 'kind="final"')
    gpu_samples: list[tuple[float, float]] = []
    gpu_stop = asyncio.Event()
    gpu_task = asyncio.create_task(sample_gpu(gpu_stop, gpu_samples))
    rows = await asyncio.gather(
        *(
            one_stream(
                args.url,
                args.catalog_revision,
                args.model_id,
                args.worker_id,
                os.getenv("WORKER_TICKET_SECRET"),
                index,
                actual_duration,
                audio_frames,
            )
            for index in range(args.concurrency)
        )
    )
    gpu_stop.set()
    await gpu_task
    audio_after = metric_value(args.url, "qwen_realtime_audio_seconds_total")
    queue_count_after = metric_value(
        args.url, "qwen_realtime_queue_wait_seconds_count", 'kind="partial"'
    ) + metric_value(args.url, "qwen_realtime_queue_wait_seconds_count", 'kind="final"')
    queue_sum_after = metric_value(
        args.url, "qwen_realtime_queue_wait_seconds_sum", 'kind="partial"'
    ) + metric_value(args.url, "qwen_realtime_queue_wait_seconds_sum", 'kind="final"')
    stable = [value for row in rows for value in row.get("stable_latencies_seconds", [])]
    ttft = [row["ttft_seconds"] for row in rows if row.get("ttft_seconds") is not None]
    final = [row["final_latency_seconds"] for row in rows if row.get("final_latency_seconds") is not None]
    payload = {
        "concurrency": args.concurrency,
        "chunk_seconds": args.chunk_seconds,
        "duration_seconds": actual_duration,
        "stable_latency_p95_seconds": percentile(stable, 0.95),
        "stable_latency_p99_seconds": percentile(stable, 0.99),
        "ttft_p95_seconds": percentile(ttft, 0.95),
        "final_latency_p95_seconds": percentile(final, 0.95),
        "gpu_utilization_p95_percent": percentile([sample[0] for sample in gpu_samples], 0.95),
        "gpu_peak_memory_mib": max((sample[1] for sample in gpu_samples), default=None),
        "queue_wait_mean_seconds": (queue_sum_after - queue_sum_before)
        / max(1, queue_count_after - queue_count_before),
        "audio_drop_rate": max(
            0.0,
            1.0
            - (audio_after - audio_before)
            / max(0.001, args.concurrency * (actual_duration + 0.5)),
        ),
        "oom": any("error" in row for row in rows),
        "streams": rows,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in payload.items() if key != "streams"}, indent=2))


if __name__ == "__main__":
    asyncio.run(run())
