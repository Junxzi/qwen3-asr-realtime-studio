import pytest

from qwen_realtime.config import Settings


def test_demo_finalization_settings_from_env(monkeypatch):
    monkeypatch.setenv("SERVICE_PROFILE", "demo_fast")
    monkeypatch.setenv("ENABLE_ALIGNER", "false")
    monkeypatch.setenv("FINAL_DIARIZATION_TIMEOUT_SECONDS", "0.35")
    settings = Settings.from_env()
    assert settings.service_profile == "demo_fast"
    assert settings.enable_aligner is False
    assert settings.final_diarization_timeout_seconds == 0.35


def test_worker_identity_and_security_settings_from_env(monkeypatch):
    monkeypatch.setenv("RUNPOD_POD_ID", "pod-123")
    monkeypatch.setenv("MODEL_ID", "org/model")
    monkeypatch.setenv("WORKER_TICKET_SECRET", "ticket-secret")
    monkeypatch.setenv("WORKER_ADMIN_SECRET", "admin-secret")
    monkeypatch.setenv("REQUIRE_WORKER_TICKET", "true")
    monkeypatch.setenv("DRAINING", "true")
    monkeypatch.setenv("SESSION_START_TIMEOUT_SECONDS", "7.5")
    monkeypatch.setenv("MAX_PCM_FRAME_MS", "500")
    monkeypatch.setenv("MAX_STREAM_AUDIO_SECONDS", "7200")
    monkeypatch.setenv("MAX_AUDIO_LEAD_SECONDS", "2.5")
    monkeypatch.setenv("MAX_SESSION_SECONDS", "7500")
    monkeypatch.setenv("MAX_SESSION_JOBS", "4")
    monkeypatch.setenv("MAX_SESSION_EVENTS", "16")
    monkeypatch.setenv("SCHEDULER_QUEUE_SIZE", "32")
    monkeypatch.setenv("SCHEDULER_MAX_CONCURRENT_BATCHES", "3")
    monkeypatch.setenv("DIARIZER_REQUEST_TIMEOUT_SECONDS", "3")
    monkeypatch.setenv("DIARIZER_CLEANUP_TIMEOUT_SECONDS", "0.25")
    settings = Settings.from_env()
    assert settings.worker_id == "pod-123"
    assert settings.model_id == "org/model"
    assert settings.worker_ticket_secret == "ticket-secret"
    assert settings.worker_admin_secret == "admin-secret"
    assert settings.require_worker_ticket is True
    assert settings.draining is True
    assert settings.session_start_timeout_seconds == 7.5
    assert settings.max_pcm_frame_ms == 500
    assert settings.max_stream_audio_seconds == 7200
    assert settings.max_audio_lead_seconds == 2.5
    assert settings.max_session_seconds == 7500
    assert settings.max_session_jobs == 4
    assert settings.max_session_events == 16
    assert settings.scheduler_queue_size == 32
    assert settings.scheduler_max_concurrent_batches == 3
    assert settings.diarizer_request_timeout_seconds == 3
    assert settings.diarizer_cleanup_timeout_seconds == 0.25


def test_final_diarization_timeout_must_be_positive(monkeypatch):
    monkeypatch.setenv("FINAL_DIARIZATION_TIMEOUT_SECONDS", "0")
    with pytest.raises(ValueError, match="must be greater than zero"):
        Settings.from_env()


def test_session_start_timeout_must_be_positive(monkeypatch):
    monkeypatch.setenv("SESSION_START_TIMEOUT_SECONDS", "0")
    with pytest.raises(ValueError, match="must be greater than zero"):
        Settings.from_env()


def test_stream_safety_limits_are_validated(monkeypatch):
    monkeypatch.setenv("MAX_PCM_FRAME_MS", "19")
    with pytest.raises(ValueError, match="must be at least 20"):
        Settings.from_env()

    monkeypatch.setenv("MAX_PCM_FRAME_MS", "20")
    monkeypatch.setenv("MAX_AUDIO_LEAD_SECONDS", "0")
    with pytest.raises(ValueError, match="must be greater than zero"):
        Settings.from_env()


def test_diarizer_chunks_must_stay_below_sidecar_limit(monkeypatch):
    monkeypatch.setenv("DIARIZER_MAX_CHUNK_SECONDS", "2")
    with pytest.raises(ValueError, match="less than 2 seconds"):
        Settings.from_env()


def test_worker_identity_has_no_shared_fallback(monkeypatch):
    monkeypatch.delenv("WORKER_ID", raising=False)
    monkeypatch.delenv("RUNPOD_POD_ID", raising=False)
    assert Settings.from_env().worker_id == ""
