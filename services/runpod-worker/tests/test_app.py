import json
import time
from dataclasses import replace

import numpy as np
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from qwen_realtime.app import build_runtime, create_app
from qwen_realtime.catalog import load_catalog_state
from qwen_realtime.config import Settings
from qwen_realtime.security import create_worker_ticket

MODEL_ID = "infodeliverailab/qwen3-asr-ja-rlbr-context-fullft"
WORKER_ID = "worker-test-1"
TICKET_SECRET = "test-ticket-secret-with-enough-entropy"
ADMIN_SECRET = "test-admin-secret-with-enough-entropy"


def worker_settings(tmp_path, **changes) -> Settings:
    catalog = tmp_path / "terms.json"
    catalog.write_text('{"revision":"r1","terms":[]}', encoding="utf-8")
    settings = Settings(
        catalog_path=catalog,
        chunk_seconds=0.8,
        model_id=MODEL_ID,
        worker_id=WORKER_ID,
        worker_ticket_secret=TICKET_SECRET,
        require_worker_ticket=True,
        worker_admin_secret=ADMIN_SECRET,
        models_lock_path=(
            tmp_path.parent / "does-not-exist.json"
        ),
    )
    return replace(settings, **changes)


def session_start(session_id: str = "ws1", *, revision: str = "r1", model_id: str = MODEL_ID):
    return {
        "type": "session.start",
        "session_id": session_id,
        "model_id": model_id,
        "connection_ticket": create_worker_ticket(
            secret=TICKET_SECRET,
            worker_id=WORKER_ID,
            session_id=session_id,
            model_id=model_id,
            expires_at=int(time.time()) + 60,
        ),
        "sample_rate": 16000,
        "encoding": "pcm_s16le",
        "catalog_revision": revision,
    }


def test_websocket_contract_and_health(tmp_path):
    app = create_app(worker_settings(tmp_path))
    with TestClient(app) as client:
        health = client.get("/health").json()
        assert health["status"] == "ok"
        assert health["worker_id"] == WORKER_ID
        assert health["model_id"] == MODEL_ID
        assert health["active_sessions"] == 0
        assert health["max_sessions"] == 32
        assert health["draining"] is False
        readiness = client.get("/ready", params={"model_id": MODEL_ID})
        assert readiness.status_code == 200
        assert readiness.json()["status"] == "ready"

        detailed = client.get("/healthz").json()
        assert detailed["catalog_revision"] == "r1"
        assert detailed["inference_mode"] == "development"
        assert detailed["chunk_seconds"] == 0.8
        assert detailed["service_profile"] == "production"
        assert detailed["stream_limits"] == {
            "max_pcm_frame_ms": 1_000,
            "max_stream_audio_seconds": 14_400.0,
            "max_audio_lead_seconds": 5.0,
            "max_session_seconds": 14_700.0,
            "max_session_jobs": 8,
            "max_session_events": 32,
            "scheduler_queue_size": 64,
            "scheduler_max_concurrent_batches": 2,
        }
        assert detailed["finalization"] == {
            "asr": "development_fake",
            "same_model_as_partial": True,
            "aligner_enabled": False,
            "word_timestamps": "provisional",
            "diarization_timeout_seconds": 4.0,
            "diarization_request_timeout_seconds": 4.0,
            "diarization_cleanup_timeout_seconds": 0.5,
            "diarization_fallback": "cached_activities",
        }

        with client.websocket_connect("/v1/realtime") as socket:
            socket.send_text(json.dumps(session_start()))
            ready = socket.receive_json()
            assert ready == {
                "type": "session.ready",
                "session_id": "ws1",
                "catalog_revision": "r1",
                "worker_id": WORKER_ID,
                "model_id": MODEL_ID,
                "input_end_supported": True,
            }
            voice = np.full(1600, 3000, dtype="<i2").tobytes()
            silence = np.zeros(1600, dtype="<i2").tobytes()
            for _ in range(10):
                socket.send_bytes(voice)
            for _ in range(5):
                socket.send_bytes(silence)
            messages = [socket.receive_json(), socket.receive_json()]
            assert [message["type"] for message in messages] == [
                "transcript.partial",
                "transcript.final",
            ]
            for message in messages:
                assert message["latency_ms"] >= 0
                assert message["queue_ms"] >= 0
                assert message["rtf"] >= 0


def test_input_end_flushes_tail_before_finalized_ack(tmp_path):
    app = create_app(worker_settings(tmp_path))
    with TestClient(app) as client:
        with client.websocket_connect("/v1/realtime") as socket:
            socket.send_text(json.dumps(session_start("explicit-end")))
            ready = socket.receive_json()
            assert ready["type"] == "session.ready"
            assert ready["input_end_supported"] is True

            voice = np.full(1600, 3000, dtype="<i2").tobytes()
            for _ in range(3):
                socket.send_bytes(voice)
            socket.send_text(json.dumps({"type": "input.end"}))

            tail = socket.receive_json()
            assert tail["type"] == "transcript.final"
            finalized = socket.receive_json()
            assert finalized == {
                "type": "stream.finalized",
                "session_id": "explicit-end",
            }


def test_first_frame_must_be_authenticated_json_not_pcm(tmp_path):
    app = create_app(worker_settings(tmp_path))
    with TestClient(app) as client:
        with client.websocket_connect("/v1/realtime") as socket:
            socket.send_bytes(bytes(640))
            assert socket.receive_json()["code"] == "invalid_session_start"


def test_session_start_must_arrive_before_handshake_deadline(tmp_path):
    app = create_app(
        worker_settings(tmp_path, session_start_timeout_seconds=0.01)
    )
    with TestClient(app) as client:
        with client.websocket_connect("/v1/realtime") as socket:
            assert socket.receive_json() == {
                "type": "error",
                "code": "session_start_timeout",
                "message": (
                    "session.start was not received before the handshake deadline"
                ),
            }
        assert client.get("/health").json()["active_sessions"] == 0


def test_oversized_pcm_frame_is_rejected_with_1009(tmp_path):
    app = create_app(worker_settings(tmp_path, max_pcm_frame_ms=100))
    with TestClient(app) as client:
        with client.websocket_connect("/v1/realtime") as socket:
            socket.send_text(json.dumps(session_start("large-frame")))
            assert socket.receive_json()["type"] == "session.ready"
            socket.send_bytes(bytes(3_202))
            assert socket.receive_json() == {
                "type": "error",
                "code": "audio_frame_too_large",
                "message": "binary PCM frames may contain at most 100 ms of audio",
            }
            with pytest.raises(WebSocketDisconnect) as closed:
                socket.receive_json()
            assert closed.value.code == 1009


def test_cumulative_audio_limit_is_checked_before_buffering(tmp_path):
    app = create_app(
        worker_settings(
            tmp_path,
            max_stream_audio_seconds=0.15,
            max_audio_lead_seconds=1.0,
        )
    )
    with TestClient(app) as client:
        with client.websocket_connect("/v1/realtime") as socket:
            socket.send_text(json.dumps(session_start("audio-limit")))
            assert socket.receive_json()["type"] == "session.ready"
            voice = np.full(1_600, 3_000, dtype="<i2").tobytes()
            socket.send_bytes(voice)
            socket.send_bytes(voice)
            assert socket.receive_json()["code"] == "stream_audio_limit_exceeded"
            with pytest.raises(WebSocketDisconnect) as closed:
                socket.receive_json()
            assert closed.value.code == 1008


def test_audio_cannot_be_blasted_faster_than_realtime_allowance(tmp_path):
    app = create_app(worker_settings(tmp_path, max_audio_lead_seconds=0.05))
    with TestClient(app) as client:
        with client.websocket_connect("/v1/realtime") as socket:
            socket.send_text(json.dumps(session_start("pacing")))
            assert socket.receive_json()["type"] == "session.ready"
            socket.send_bytes(np.zeros(16_000, dtype="<i2").tobytes())
            assert socket.receive_json()["code"] == "audio_pacing_exceeded"
            with pytest.raises(WebSocketDisconnect) as closed:
                socket.receive_json()
            assert closed.value.code == 1008


def test_idle_websocket_is_closed_at_session_duration_limit(tmp_path):
    app = create_app(worker_settings(tmp_path, max_session_seconds=0.01))
    with TestClient(app) as client:
        with client.websocket_connect("/v1/realtime") as socket:
            socket.send_text(json.dumps(session_start("wall-limit")))
            assert socket.receive_json()["type"] == "session.ready"
            assert socket.receive_json()["code"] == "session_duration_exceeded"
            with pytest.raises(WebSocketDisconnect) as closed:
                socket.receive_json()
            assert closed.value.code == 1008
        assert client.get("/health").json()["active_sessions"] == 0


def test_ticket_is_bound_to_worker_session_and_model(tmp_path):
    app = create_app(worker_settings(tmp_path))
    start = session_start("different-session")
    start["session_id"] = "ws1"
    with TestClient(app) as client:
        with client.websocket_connect("/v1/realtime") as socket:
            socket.send_text(json.dumps(start))
            assert socket.receive_json() == {
                "type": "error",
                "code": "invalid_connection_ticket",
                "message": "connection ticket is invalid or expired",
            }
        assert client.get("/health").json()["active_sessions"] == 0


def test_same_session_ticket_cannot_consume_capacity_twice(tmp_path):
    app = create_app(worker_settings(tmp_path))
    with TestClient(app) as client:
        with client.websocket_connect("/v1/realtime") as first:
            first.send_text(json.dumps(session_start("same-session")))
            assert first.receive_json()["type"] == "session.ready"
            with client.websocket_connect("/v1/realtime") as duplicate:
                duplicate.send_text(json.dumps(session_start("same-session")))
                assert duplicate.receive_json()["code"] == "session_already_connected"
            assert client.get("/health").json()["active_sessions"] == 1
        assert client.get("/health").json()["active_sessions"] == 0


def test_model_and_catalog_mismatch_are_rejected(tmp_path):
    app = create_app(worker_settings(tmp_path))
    wrong_model = "infodeliverailab/another-model"
    with TestClient(app) as client:
        with client.websocket_connect("/v1/realtime") as socket:
            socket.send_text(json.dumps(session_start(model_id=wrong_model)))
            assert socket.receive_json()["code"] == "model_unavailable"
        with client.websocket_connect("/v1/realtime") as socket:
            socket.send_text(json.dumps(session_start(revision="old-r")))
            assert socket.receive_json()["code"] == "catalog_revision_mismatch"


def test_admin_auth_model_load_and_drain_contract(tmp_path):
    lock = tmp_path / "models.lock.json"
    lock.write_text(
        json.dumps(
            {
                MODEL_ID: {
                    "revision": "a" * 40,
                    "local_dir": "/workspace/models/context-fullft",
                }
            }
        ),
        encoding="utf-8",
    )
    app = create_app(worker_settings(tmp_path, models_lock_path=lock))
    headers = {"Authorization": f"Bearer {ADMIN_SECRET}"}
    with TestClient(app) as client:
        assert client.get("/admin/models").status_code == 401
        assert client.get(
            "/admin/models", headers={"Authorization": "Bearer wrong"}
        ).status_code == 403
        models = client.get("/admin/models", headers=headers)
        assert models.status_code == 200
        assert models.json()["models"][0]["model_id"] == MODEL_ID

        same = client.post(
            "/admin/models/load", headers=headers, json={"model_id": MODEL_ID}
        )
        assert same.status_code == 200
        assert same.json()["status"] == "loaded"
        assert same.json()["restart_required"] is False

        other = client.post(
            "/admin/models/load",
            headers=headers,
            json={"model_id": "infodeliverailab/other"},
        )
        assert other.status_code == 409
        assert other.json()["error"]["code"] == "restart_required"
        assert other.json()["error"]["details"]["active_sessions"] == 0

        drained = client.post("/admin/drain", headers=headers, json={"draining": True})
        assert drained.status_code == 200
        assert drained.json()["draining"] is True
        assert client.get("/ready", params={"model_id": MODEL_ID}).status_code == 503
        with client.websocket_connect("/v1/realtime") as socket:
            socket.send_text(json.dumps(session_start()))
            assert socket.receive_json()["code"] == "worker_draining"

        accepting = client.post(
            "/admin/drain", headers=headers, json={"draining": False}
        )
        assert accepting.json()["status"] == "accepting"
        assert client.get("/ready", params={"model_id": MODEL_ID}).status_code == 200


def test_readiness_rejects_wrong_model_and_missing_security(tmp_path):
    secured = create_app(worker_settings(tmp_path))
    with TestClient(secured) as client:
        response = client.get("/ready", params={"model_id": "wrong/model"})
        assert response.status_code == 503
        assert response.json()["model_match"] is False

    insecure = create_app(
        worker_settings(
            tmp_path,
            worker_admin_secret=None,
            worker_ticket_secret=None,
            require_worker_ticket=True,
        )
    )
    with TestClient(insecure) as client:
        assert client.get("/health").status_code == 200
        assert client.get("/ready", params={"model_id": MODEL_ID}).status_code == 503


def test_required_empty_catalog_blocks_readiness_and_websocket(tmp_path):
    settings = worker_settings(tmp_path)
    runtime = build_runtime(settings)
    runtime.catalog_state = load_catalog_state(settings.catalog_path, required=True)
    app = create_app(runtime=runtime)

    with TestClient(app) as client:
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json()["catalog_required"] is True
        assert health.json()["catalog_ready"] is False
        assert health.json()["catalog_status"] == "empty"
        assert client.get("/ready", params={"model_id": MODEL_ID}).status_code == 503

        with client.websocket_connect("/v1/realtime") as socket:
            socket.send_text(json.dumps(session_start()))
            assert socket.receive_json() == {
                "type": "error",
                "code": "catalog_unavailable",
                "message": "the required Context catalog is not available",
            }


def test_health_discloses_demo_finalization_tradeoffs(tmp_path):
    settings = worker_settings(
        tmp_path,
        service_profile="demo_fast",
        enable_aligner=False,
        final_diarization_timeout_seconds=0.35,
    )
    runtime = build_runtime(settings)
    runtime.settings = replace(settings, asr_backend="qwen_async_vllm")
    app = create_app(runtime=runtime)
    with TestClient(app) as client:
        health = client.get("/healthz").json()
    assert health["service_profile"] == "demo_fast"
    assert health["finalization"] == {
        "asr": "contextual_final",
        "same_model_as_partial": True,
        "aligner_enabled": False,
        "word_timestamps": "provisional",
        "diarization_timeout_seconds": 0.35,
        "diarization_request_timeout_seconds": 4.0,
        "diarization_cleanup_timeout_seconds": 0.5,
        "diarization_fallback": "cached_activities",
    }
