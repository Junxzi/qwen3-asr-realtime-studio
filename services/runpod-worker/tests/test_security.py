import time

import pytest

from qwen_realtime.security import (
    WorkerTicketError,
    create_worker_ticket,
    secrets_match,
    verify_worker_ticket,
)


def test_ticket_round_trip_and_expiry():
    now = int(time.time())
    ticket = create_worker_ticket(
        secret="secret",
        worker_id="worker-1",
        session_id="session-1",
        model_id="org/model",
        expires_at=now + 30,
    )
    claims = verify_worker_ticket(
        ticket,
        secret="secret",
        worker_id="worker-1",
        session_id="session-1",
        model_id="org/model",
        now=now,
    )
    assert claims["purpose"] == "realtime"

    with pytest.raises(WorkerTicketError, match="expired"):
        verify_worker_ticket(
            ticket,
            secret="secret",
            worker_id="worker-1",
            session_id="session-1",
            model_id="org/model",
            now=now + 30,
        )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("secret", "different"),
        ("worker_id", "worker-2"),
        ("session_id", "session-2"),
        ("model_id", "org/other"),
    ],
)
def test_ticket_rejects_tampering_and_binding_mismatch(field, value):
    arguments = {
        "secret": "secret",
        "worker_id": "worker-1",
        "session_id": "session-1",
        "model_id": "org/model",
    }
    ticket = create_worker_ticket(**arguments, expires_at=2_000_000_000)
    arguments[field] = value
    with pytest.raises(WorkerTicketError):
        verify_worker_ticket(ticket, **arguments, now=1_900_000_000)


def test_secret_comparison():
    assert secrets_match("same", "same") is True
    assert secrets_match("same", "different") is False


def test_verifies_control_plane_golden_ticket():
    node_golden = (
        "eyJ2IjoxLCJhdWQiOiJxd2VuLXJlYWx0aW1lLXdvcmtlciIsIndpZCI6Indvcmtlci0xIiw"
        "ic2lkIjoic2Vzc2lvbi0xIiwibWlkIjoib3JnL21vZGVsIiwicHVycG9zZSI6InJlYWx0aW1lI"
        "iwiZXhwIjoyMDAwMDAwMDAwfQ.-ABaxxvBo5bD6eJhCkg83npiH10P-enWF3rVb36450U"
    )
    claims = verify_worker_ticket(
        node_golden,
        secret="worker-ticket-secret-at-least-32-characters",
        worker_id="worker-1",
        session_id="session-1",
        model_id="org/model",
        now=1_999_999_999,
    )
    assert claims["v"] == 1
    assert claims["exp"] == 2_000_000_000
