from __future__ import annotations

import argparse
import json
import os
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import ProxyHandler, build_opener


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ready", action="store_true")
    args = parser.parse_args()
    port = int(os.getenv("PORT", "8000"))
    path = "/health"
    if args.ready:
        path = "/ready?" + urlencode({"model_id": os.environ["MODEL_ID"]})
    try:
        opener = build_opener(ProxyHandler({}))
        with opener.open(f"http://127.0.0.1:{port}{path}", timeout=3) as response:
            payload = json.load(response)
            if response.status != 200 or payload.get("status") not in {"ok", "ready"}:
                raise RuntimeError("worker health response is not healthy")
    except (HTTPError, URLError, TimeoutError, RuntimeError, json.JSONDecodeError) as exc:
        print(f"worker healthcheck failed: {type(exc).__name__}", file=sys.stderr)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
