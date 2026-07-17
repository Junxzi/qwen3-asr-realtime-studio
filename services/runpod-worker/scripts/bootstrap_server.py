from __future__ import annotations

import json
import os
import signal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


def _state() -> dict[str, object]:
    return {
        "phase": "initializing",
        "worker_id": os.getenv("WORKER_ID") or os.getenv("RUNPOD_POD_ID") or "",
        "model_id": os.getenv("MODEL_ID", ""),
        "model_loaded": False,
        "accepting_sessions": False,
        "active_sessions": 0,
        "max_sessions": int(os.getenv("MAX_SESSIONS", "32")),
        "draining": False,
    }


class BootstrapHandler(BaseHTTPRequestHandler):
    server_version = "qwen-realtime-bootstrap/1"

    def do_GET(self) -> None:  # noqa: N802 - stdlib callback name
        path = urlsplit(self.path).path
        if path in {"/health", "/healthz"}:
            self._json(200, {"status": "ok", **_state()})
            return
        if path == "/ready":
            self._json(503, {"status": "not_ready", **_state()})
            return
        self._json(404, {"status": "not_found"})

    def log_message(self, format: str, *args: object) -> None:
        return

    def _json(self, status: int, payload: dict[str, object]) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", int(os.getenv("PORT", "8000"))), BootstrapHandler)

    def stop(*_: object) -> None:
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
