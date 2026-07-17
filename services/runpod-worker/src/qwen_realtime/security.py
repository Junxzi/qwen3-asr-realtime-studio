from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import time
from typing import Any, Mapping

WORKER_TICKET_AUDIENCE = "qwen-realtime-worker"
WORKER_TICKET_PURPOSE = "realtime"


class WorkerTicketError(ValueError):
    """Raised when a short-lived control-plane ticket cannot be trusted."""


def _base64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _base64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    try:
        return base64.b64decode(
            value + padding,
            altchars=b"-_",
            validate=True,
        )
    except (binascii.Error, ValueError) as exc:
        raise WorkerTicketError("ticket encoding is invalid") from exc


def create_worker_ticket(
    *,
    secret: str,
    worker_id: str,
    session_id: str,
    model_id: str,
    expires_at: int,
    audience: str = WORKER_TICKET_AUDIENCE,
) -> str:
    """Create the documented payload.signature ticket used by the control plane."""

    claims = {
        "v": 1,
        "aud": audience,
        "exp": expires_at,
        "mid": model_id,
        "purpose": WORKER_TICKET_PURPOSE,
        "sid": session_id,
        "wid": worker_id,
    }
    payload = json.dumps(
        claims,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    payload_segment = _base64url_encode(payload)
    signature = hmac.new(
        secret.encode("utf-8"),
        payload_segment.encode("ascii"),
        hashlib.sha256,
    ).digest()
    return f"{payload_segment}.{_base64url_encode(signature)}"


def verify_worker_ticket(
    ticket: str,
    *,
    secret: str,
    worker_id: str,
    session_id: str,
    model_id: str,
    now: int | None = None,
    audience: str = WORKER_TICKET_AUDIENCE,
) -> Mapping[str, Any]:
    parts = ticket.split(".")
    if len(parts) != 2:
        raise WorkerTicketError("ticket format is invalid")
    payload_segment, signature_segment = parts
    presented_signature = _base64url_decode(signature_segment)
    expected_signature = hmac.new(
        secret.encode("utf-8"),
        payload_segment.encode("ascii"),
        hashlib.sha256,
    ).digest()
    if not hmac.compare_digest(presented_signature, expected_signature):
        raise WorkerTicketError("ticket signature is invalid")
    try:
        claims = json.loads(_base64url_decode(payload_segment))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise WorkerTicketError("ticket payload is invalid") from exc
    if not isinstance(claims, dict):
        raise WorkerTicketError("ticket payload is invalid")
    expected = {
        "v": 1,
        "aud": audience,
        "mid": model_id,
        "purpose": WORKER_TICKET_PURPOSE,
        "sid": session_id,
        "wid": worker_id,
    }
    if any(claims.get(key) != value for key, value in expected.items()):
        raise WorkerTicketError("ticket claims do not match this connection")
    expires_at = claims.get("exp")
    if isinstance(expires_at, bool) or not isinstance(expires_at, int):
        raise WorkerTicketError("ticket expiry is invalid")
    if expires_at <= (int(time.time()) if now is None else now):
        raise WorkerTicketError("ticket has expired")
    return claims


def secrets_match(presented: str, expected: str) -> bool:
    """Compare secrets without an early-exit string comparison."""

    return hmac.compare_digest(
        presented.encode("utf-8"),
        expected.encode("utf-8"),
    )


def bearer_secret(authorization: str | None) -> str | None:
    if authorization is None:
        return None
    scheme, separator, token = authorization.partition(" ")
    if not separator or scheme.lower() != "bearer" or not token:
        return None
    return token
