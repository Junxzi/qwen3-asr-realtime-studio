import importlib
import os
import time
import wave
from dataclasses import replace
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient

from qwen_realtime.lab_batch import (
    DEFAULT_LAB_MODEL_ID,
    LabBatchSettings,
    LabInferenceResult,
    RepositoryLabBackend,
    cleanup_stale_temp_files,
    create_lab_batch_app,
    parse_speaker_transcript,
)
from qwen_realtime.security import create_worker_ticket

WORKER_ID = "lab-worker-1"
SECRET = "batch-ticket-secret-with-enough-entropy"
ADMIN_SECRET = "batch-admin-secret-with-enough-entropy"


class FakeLabBackend:
    def __init__(self, text: str = "<|spk_0|>ありがとうございます。[spk_1]ご注文ですか。"):
        self.text = text
        self.load_count = 0
        self.calls: list[tuple[Path, int, bool]] = []

    def load(self) -> None:
        self.load_count += 1

    def transcribe(self, audio_path: Path, max_new_tokens: int) -> LabInferenceResult:
        self.calls.append((audio_path, max_new_tokens, audio_path.exists()))
        return LabInferenceResult(self.text, 1.0)


def settings(tmp_path, **changes) -> LabBatchSettings:
    configured = LabBatchSettings(
        worker_id=WORKER_ID,
        worker_ticket_secret=SECRET,
        worker_admin_secret=ADMIN_SECRET,
        temp_dir=tmp_path,
        repo_path=tmp_path / "repo",
    )
    return replace(configured, **changes)


def ticket(session_id: str, *, purpose: str = "batch") -> str:
    return create_worker_ticket(
        secret=SECRET,
        worker_id=WORKER_ID,
        session_id=session_id,
        model_id=DEFAULT_LAB_MODEL_ID,
        purpose=purpose,  # type: ignore[arg-type]
        expires_at=int(time.time()) + 60,
    )


def wav_bytes(milliseconds: int = 100) -> bytes:
    from io import BytesIO

    output = BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16_000)
        audio.writeframes(np.zeros(milliseconds * 16, dtype="<i2").tobytes())
    return output.getvalue()


def post(client: TestClient, session_id: str = "batch-session", **data):
    return client.post(
        "/v1/audio/transcriptions",
        headers={"Authorization": f"Bearer {ticket(session_id)}"},
        files={"audio": ("sample.wav", wav_bytes(), "audio/wav")},
        data={
            "session_id": session_id,
            "model_id": DEFAULT_LAB_MODEL_ID,
            "utterance_id": "source-utterance-1",
            "max_new_tokens": "800",
            **data,
        },
    )


def test_batch_worker_loads_once_normalizes_speakers_and_deletes_upload(tmp_path):
    backend = FakeLabBackend()
    app = create_lab_batch_app(settings(tmp_path), backend)
    with TestClient(app) as client:
        assert client.get("/ready", params={"model_id": DEFAULT_LAB_MODEL_ID}).status_code == 200
        response = post(client)
        assert response.status_code == 200
        payload = response.json()
        assert "<|" not in payload["text"]
        assert "[spk_" not in payload["text"]
        assert [item["speaker"] for item in payload["utterances"]] == [
            "speaker_0",
            "speaker_1",
        ]
        assert payload["utterances"][0]["timing_source"] == "proportional_estimate"
        assert payload["utterance_id"] == "source-utterance-1"
        assert payload["turns"][1]["speaker"] == "speaker_1"
        assert payload["duration"] == 1.0
        assert payload["rtf"] >= 0
    assert backend.load_count == 1
    assert backend.calls[0][1:] == (800, True)
    assert backend.calls[0][0].exists() is False
    assert list(tmp_path.glob("lab-*")) == []


def test_missing_private_repo_keeps_readiness_failed(tmp_path):
    app = create_lab_batch_app(settings(tmp_path, repo_path=tmp_path / "missing"))
    with TestClient(app) as client:
        health = client.get("/health").json()
        assert health["status"] == "ok"
        assert health["model_loaded"] is False
        assert health["load_failed"] is True
        assert client.get("/ready", params={"model_id": DEFAULT_LAB_MODEL_ID}).status_code == 503


def test_batch_worker_rejects_wrong_ticket_tokens_and_capacity(tmp_path):
    app = create_lab_batch_app(settings(tmp_path), FakeLabBackend())
    with TestClient(app) as client:
        realtime_ticket = ticket("wrong-purpose", purpose="realtime")
        denied = client.post(
            "/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {realtime_ticket}"},
            files={"audio": ("sample.wav", wav_bytes(), "audio/wav")},
            data={
                "session_id": "wrong-purpose",
                "model_id": DEFAULT_LAB_MODEL_ID,
                "max_new_tokens": "800",
            },
        )
        assert denied.status_code == 403
        assert post(client, max_new_tokens="1025").status_code == 422

        assert app.state.runtime.capacity.acquire_nowait() is True
        busy = post(client, session_id="busy")
        assert busy.status_code == 429
        assert busy.headers["retry-after"] == "1"
        app.state.runtime.capacity.release()


def test_batch_guard_authenticates_before_multipart_validation(tmp_path):
    app = create_lab_batch_app(settings(tmp_path), FakeLabBackend())
    with TestClient(app) as client:
        missing = client.post("/v1/audio/transcriptions", content=b"")
        assert missing.status_code == 401
        assert missing.json()["code"] == "connection_ticket_required"
        invalid = client.post(
            "/v1/audio/transcriptions",
            headers={"Authorization": "Bearer invalid"},
            content=b"",
        )
        assert invalid.status_code == 403
        assert invalid.json()["code"] == "invalid_connection_ticket"


def test_real_batch_backend_cannot_disable_authentication(tmp_path):
    configured = settings(
        tmp_path,
        repo_path=tmp_path / "missing",
        require_worker_ticket=False,
    )
    app = create_lab_batch_app(configured)
    with TestClient(app) as client:
        response = client.post("/v1/audio/transcriptions", content=b"")
        assert response.status_code == 401
        assert response.json()["code"] == "connection_ticket_required"


def test_real_batch_backend_requires_a_32_byte_ticket_secret(tmp_path):
    configured = settings(
        tmp_path,
        repo_path=tmp_path / "missing",
        worker_ticket_secret="too-short",
    )
    app = create_lab_batch_app(configured)
    with TestClient(app) as client:
        response = client.post(
            "/v1/audio/transcriptions",
            headers={"Authorization": "Bearer signed-ticket"},
            content=b"",
        )
        assert response.status_code == 503
        assert response.json()["code"] == "worker_auth_misconfigured"


def test_explicit_fake_backend_may_run_unauthenticated(tmp_path):
    configured = settings(
        tmp_path,
        require_worker_ticket=False,
        worker_ticket_secret=None,
    )
    app = create_lab_batch_app(configured, FakeLabBackend())
    with TestClient(app) as client:
        response = client.post(
            "/v1/audio/transcriptions",
            files={"audio": ("sample.wav", wav_bytes(), "audio/wav")},
            data={
                "session_id": "fake-no-auth",
                "model_id": DEFAULT_LAB_MODEL_ID,
                "max_new_tokens": "800",
            },
        )
        assert response.status_code == 200


def test_batch_guard_limits_body_before_form_parser(tmp_path):
    configured = settings(
        tmp_path,
        require_worker_ticket=False,
        worker_ticket_secret=None,
        max_upload_bytes=64,
        max_request_overhead_bytes=0,
    )
    app = create_lab_batch_app(configured, FakeLabBackend())
    with TestClient(app) as client:
        response = client.post(
            "/v1/audio/transcriptions",
            content=b"x" * 65,
            headers={"Content-Type": "application/octet-stream"},
        )
        assert response.status_code == 413
        assert response.json()["code"] == "request_too_large"


def test_upload_limit_is_enforced_and_temporary_file_is_deleted(tmp_path):
    app = create_lab_batch_app(settings(tmp_path, max_upload_bytes=64), FakeLabBackend())
    with TestClient(app) as client:
        response = post(client)
        assert response.status_code == 413
    assert list(tmp_path.glob("lab-*")) == []


def test_audio_duration_limit_is_checked_before_wav_inference(tmp_path):
    backend = FakeLabBackend()
    app = create_lab_batch_app(settings(tmp_path, max_audio_seconds=0.05), backend)
    with TestClient(app) as client:
        response = post(client)
        assert response.status_code == 413
        assert response.json()["code"] == "audio_duration_exceeded"
    assert backend.calls == []


def test_non_wav_duration_returned_by_backend_is_also_enforced(tmp_path):
    backend = FakeLabBackend()
    app = create_lab_batch_app(settings(tmp_path, max_audio_seconds=0.5), backend)
    with TestClient(app) as client:
        response = client.post(
            "/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {ticket('non-wav')}"},
            files={"audio": ("sample.webm", b"not-a-wav", "audio/webm")},
            data={
                "session_id": "non-wav",
                "model_id": DEFAULT_LAB_MODEL_ID,
                "max_new_tokens": "800",
            },
        )
        assert response.status_code == 413
        assert response.json()["code"] == "audio_duration_exceeded"
    assert len(backend.calls) == 1
    assert backend.calls[0][0].exists() is False


def test_cors_is_exact_origin_only(tmp_path):
    app = create_lab_batch_app(
        settings(tmp_path, allowed_origins=("https://studio.example",)),
        FakeLabBackend(),
    )
    with TestClient(app) as client:
        allowed = client.options(
            "/v1/audio/transcriptions",
            headers={
                "Origin": "https://studio.example",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization,content-type",
            },
        )
        assert allowed.status_code == 200
        assert allowed.headers["access-control-allow-origin"] == "https://studio.example"
        denied = client.options(
            "/v1/audio/transcriptions",
            headers={
                "Origin": "https://evil.example",
                "Access-Control-Request-Method": "POST",
            },
        )
        assert "access-control-allow-origin" not in denied.headers


def test_batch_health_exposes_gpu_and_prometheus_metrics(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "qwen_realtime.lab_batch.gpu_telemetry",
        lambda: {
            "accelerator": "NVIDIA A40",
            "gpu_utilization_percent": 42.0,
            "gpu_memory_used_mb": 1234.0,
        },
    )
    app = create_lab_batch_app(settings(tmp_path), FakeLabBackend())
    with TestClient(app) as client:
        health = client.get("/healthz").json()
        assert health["accelerator"] == "NVIDIA A40"
        assert health["gpu_utilization_percent"] == 42.0
        assert post(client).status_code == 200
        metrics = client.get("/metrics")
        assert metrics.status_code == 200
        assert "qwen_lab_batch_active_requests" in metrics.text
        assert "qwen_lab_batch_inference_seconds" in metrics.text


def test_batch_settings_use_runpod_identity_and_ephemeral_temp(monkeypatch):
    monkeypatch.delenv("WORKER_ID", raising=False)
    monkeypatch.setenv("RUNPOD_POD_ID", "a40-pod")
    monkeypatch.delenv("LAB_TEMP_DIR", raising=False)
    configured = LabBatchSettings.from_env()
    assert configured.worker_id == "a40-pod"
    assert configured.temp_dir == Path("/tmp/infodeliver-lab-batch")


def test_parser_accepts_both_markers_clamps_to_two_speakers_and_merges_turns():
    assert parse_speaker_transcript(
        "prefix <|spk_0|> one [spk_0] two <|spk_9|> three <|eos|>"
    ) == [
        ("speaker_0", "prefix one two"),
        ("speaker_1", "three"),
    ]


def test_parser_removes_qwen_role_prologue_and_uses_arrival_order_speakers():
    assert parse_speaker_transcript(
        "language Japanese<asr_text><|spk_4|>ありがとうございます。"
        "<|spk_6|>ご注文ですか。<|spk_4|>はい。"
    ) == [
        ("speaker_0", "ありがとうございます。"),
        ("speaker_1", "ご注文ですか。"),
        ("speaker_0", "はい。"),
    ]


def test_stale_temp_cleanup_only_removes_old_worker_files(tmp_path):
    old = tmp_path / "lab-old.wav"
    fresh = tmp_path / "lab-fresh.wav"
    unrelated = tmp_path / "other.wav"
    for path in (old, fresh, unrelated):
        path.write_bytes(b"audio")
    os.utime(old, (100, 100))
    os.utime(fresh, (950, 950))
    assert cleanup_stale_temp_files(tmp_path, 100, now=1000) == 1
    assert old.exists() is False
    assert fresh.exists() is True
    assert unrelated.exists() is True


def test_repository_backend_imports_and_builds_runner_only_once(tmp_path):
    module_name = "lab_adapter_fixture"
    (tmp_path / f"{module_name}.py").write_text(
        """
loads = 0

class Runner:
    def transcribe_file(self, audio_path, max_new_tokens=800):
        return {"text": f"[spk_0] {max_new_tokens}:{audio_path}"}

def create_backend():
    global loads
    loads += 1
    return Runner()
""",
        encoding="utf-8",
    )
    audio = tmp_path / "audio.wav"
    audio.write_bytes(wav_bytes())
    backend = RepositoryLabBackend(tmp_path, module_name)
    backend.load()
    backend.load()
    result = backend.transcribe(audio, 777)
    loaded_module = importlib.import_module(module_name)
    assert loaded_module.loads == 1
    assert result.text.startswith("[spk_0] 777:")
