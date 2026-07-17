from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import struct
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import websockets

from qwen_realtime.security import create_worker_ticket


def tone_frame(frame_ms: int = 20, sample_rate: int = 16_000, frequency: float = 440.0) -> bytes:
    samples = sample_rate * frame_ms // 1000
    return b"".join(
        struct.pack("<h", int(6000 * math.sin(2 * math.pi * frequency * index / sample_rate)))
        for index in range(samples)
    )


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="ws://127.0.0.1:8000/v1/realtime")
    parser.add_argument("--catalog-revision", required=True)
    parser.add_argument(
        "--model-id",
        default=os.getenv(
            "MODEL_ID", "infodeliverailab/qwen3-asr-ja-rlbr-context-fullft"
        ),
    )
    parser.add_argument("--realtime", action="store_true")
    parser.add_argument("--wav", type=Path)
    parser.add_argument("--start-seconds", type=float, default=0.0)
    parser.add_argument("--duration-seconds", type=float, default=6.0)
    parser.add_argument("--timeout", type=float, default=120.0)
    args = parser.parse_args()

    if args.wav:
        with sf.SoundFile(str(args.wav)) as wav:
            source_rate = wav.samplerate
            wav.seek(min(len(wav), round(args.start_seconds * source_rate)))
            audio = wav.read(
                frames=round(args.duration_seconds * source_rate),
                dtype="float32",
                always_2d=True,
            ).mean(axis=1)
        if source_rate != 16_000:
            from math import gcd

            from scipy.signal import resample_poly

            divisor = gcd(source_rate, 16_000)
            audio = resample_poly(audio, 16_000 // divisor, source_rate // divisor)
        pcm = np.clip(np.rint(audio * 32_767), -32_768, 32_767).astype("<i2").tobytes()
        frames = [pcm[offset : offset + 640] for offset in range(0, len(pcm) - 639, 640)]
    else:
        frames = [tone_frame() for _ in range(round(args.duration_seconds * 50))]

    started = time.perf_counter()
    async with websockets.connect(args.url, max_size=8 * 1024 * 1024) as socket:
        ticket_secret = os.getenv("WORKER_TICKET_SECRET")
        start = {
            "type": "session.start",
            "session_id": "smoke",
            "model_id": args.model_id,
            "sample_rate": 16000,
            "encoding": "pcm_s16le",
            "catalog_revision": args.catalog_revision,
        }
        if ticket_secret:
            start["connection_ticket"] = create_worker_ticket(
                secret=ticket_secret,
                worker_id=os.getenv("WORKER_ID") or os.getenv("RUNPOD_POD_ID", "local-worker"),
                session_id="smoke",
                model_id=args.model_id,
                expires_at=int(time.time()) + 120,
            )
        await socket.send(
            json.dumps(
                start
            )
        )
        print(await socket.recv(), flush=True)
        for frame in frames:
            await socket.send(frame)
            if args.realtime:
                await asyncio.sleep(0.02)
        silence = b"\x00\x00" * 320
        for _ in range(25):
            await socket.send(silence)
            if args.realtime:
                await asyncio.sleep(0.02)
        while True:
            message = json.loads(await asyncio.wait_for(socket.recv(), args.timeout))
            print(
                json.dumps(
                    {"wall_seconds": round(time.perf_counter() - started, 3), **message},
                    ensure_ascii=False,
                ),
                flush=True,
            )
            if message.get("type") == "transcript.final":
                return


if __name__ == "__main__":
    asyncio.run(main())
