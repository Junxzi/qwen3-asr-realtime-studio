#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import time

import httpx
import numpy as np


def main() -> None:
    parser = argparse.ArgumentParser(description="Smoke-test the Sortformer sidecar with silence.")
    parser.add_argument("--url", default="http://127.0.0.1:18001/diarize")
    parser.add_argument("--seconds", type=float, default=1.0)
    parser.add_argument("--concurrency", type=int, default=1)
    args = parser.parse_args()

    audio = np.zeros(round(16_000 * args.seconds), dtype="<f4")
    def send(index: int) -> dict[str, object]:
        stream_id = f"smoke-{index}-{time.time_ns()}"
        with httpx.Client(timeout=60.0, trust_env=False) as client:
            response = client.post(
                args.url,
                content=audio.tobytes(),
                headers={
                    "content-type": "application/octet-stream",
                    "x-sample-rate": "16000",
                    "x-stream-id": stream_id,
                    "x-offset-samples": "0",
                    "x-final": "true",
                },
            )
            response.raise_for_status()
            payload = response.json()
            client.delete(args.url, headers={"x-stream-id": stream_id}).raise_for_status()
            return payload

    started = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as executor:
        results = list(executor.map(send, range(args.concurrency)))
    elapsed = time.perf_counter() - started
    print(
        {
            "elapsed_seconds": round(elapsed, 3),
            "concurrency": args.concurrency,
            "activities_per_request": [len(result["activities"]) for result in results],
        }
    )


if __name__ == "__main__":
    main()
