from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("readings", type=Path, help="JSON object: written form -> reading list")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    source = json.loads(args.readings.read_text(encoding="utf-8"))
    if not isinstance(source, dict) or not source:
        raise SystemExit("readings must be a non-empty JSON object")
    canonical = json.dumps(source, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    revision = "securities-terms-" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:12]
    terms = []
    for written, readings in sorted(source.items()):
        if not isinstance(readings, list) or not readings:
            raise SystemExit(f"{written!r} has no readings")
        terms.append(
            {
                "id": written,
                "read": str(readings[0]),
                "write": written,
                "aliases": [str(value) for value in readings[1:]],
                "priority": 1.0,
            }
        )
    payload = {"revision": revision, "terms": terms}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"revision": revision, "terms": len(terms)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
