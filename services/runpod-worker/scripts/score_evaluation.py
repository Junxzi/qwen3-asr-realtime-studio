from __future__ import annotations

import argparse
import json
from pathlib import Path

from qwen_realtime.evaluation import score_records


def load_jsonl(path: Path) -> list[dict[str, object]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("predictions", type=Path)
    parser.add_argument("--offline-baseline", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    scores = score_records(load_jsonl(args.predictions))
    if args.offline_baseline:
        baseline = score_records(load_jsonl(args.offline_baseline))
        scores["streaming_cer_delta_pt"] = 100 * ((scores["cer"] or 0) - (baseline["cer"] or 0))
        scores["streaming_bwer_delta_pt"] = 100 * ((scores["bwer"] or 0) - (baseline["bwer"] or 0))
        scores["wder_delta_pt"] = 100 * ((scores["wder"] or 0) - (baseline["wder"] or 0))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(scores, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(scores, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
