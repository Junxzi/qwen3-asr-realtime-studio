from __future__ import annotations

import argparse
import json
from pathlib import Path


def passes(row: dict[str, float]) -> bool:
    required = {
        "stable_latency_p95_seconds",
        "stable_latency_p99_seconds",
        "final_latency_p95_seconds",
        "streaming_bwer_delta_pt",
        "streaming_cer_delta_pt",
        "term_hallucination_rate",
        "wder_delta_pt",
        "audio_drop_rate",
        "oom",
    }
    return required <= row.keys() and all(row[key] is not None for key in required) and (
        row["stable_latency_p95_seconds"] <= 1.5
        and row["stable_latency_p99_seconds"] <= 2.5
        and row["final_latency_p95_seconds"] <= 1.0
        and row["streaming_bwer_delta_pt"] <= 1.0
        and row["streaming_cer_delta_pt"] <= 0.5
        and row["term_hallucination_rate"] <= 0.005
        and row["wder_delta_pt"] <= 2.0
        and row["audio_drop_rate"] <= 0.0001
        and not row["oom"]
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("inputs", nargs="+", type=Path)
    args = parser.parse_args()
    rows = [json.loads(path.read_text(encoding="utf-8")) for path in args.inputs]
    rows.sort(key=lambda row: (row["chunk_seconds"], row["concurrency"]))
    passing_32 = [row for row in rows if row["concurrency"] == 32 and passes(row)]
    decision = {
        "single_stage_accepted": bool(passing_32),
        "selected_chunk_seconds": passing_32[0]["chunk_seconds"] if passing_32 else None,
        "next_architecture": "qwen3-asr-1.7b-single" if passing_32 else "qwen3-asr-0.6b-draft-plus-1.7b-final",
        "evaluated": len(rows),
    }
    print(json.dumps(decision, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
