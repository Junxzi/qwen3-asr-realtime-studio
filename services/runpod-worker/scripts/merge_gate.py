from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="Merge load and quality metrics into one gate record.")
    parser.add_argument("--load", type=Path, required=True)
    parser.add_argument("--quality", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    load = json.loads(args.load.read_text(encoding="utf-8"))
    quality = json.loads(args.quality.read_text(encoding="utf-8"))
    merged = {**load, **quality}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in merged.items() if key != "streams"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
