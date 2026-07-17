from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPT_PATH = Path(__file__).parents[1] / "scripts" / "bootstrap_lab_batch.py"
SPEC = importlib.util.spec_from_file_location("bootstrap_lab_batch_under_test", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
bootstrap = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = bootstrap
SPEC.loader.exec_module(bootstrap)


@pytest.fixture(autouse=True)
def _flock_compatibility(monkeypatch):
    if bootstrap.fcntl is None:
        monkeypatch.setattr(
            bootstrap,
            "fcntl",
            SimpleNamespace(LOCK_EX=2, flock=lambda _handle, _operation: None),
        )


def test_downloads_exact_snapshots_once_and_writes_atomic_manifest(tmp_path):
    root = tmp_path / "lab-asr-poc"
    manifest = root / ".lab-batch-models.json"
    lock = root / ".lab-batch-download.lock"
    calls: list[dict[str, object]] = []

    def fake_download(**kwargs):
        calls.append(kwargs)
        local_dir = Path(kwargs["local_dir"])
        local_dir.mkdir(parents=True)
        spec = next(item for item in bootstrap.SNAPSHOTS if item.repo_id == kwargs["repo_id"])
        for relative in spec.required_files:
            required = local_dir / relative
            required.parent.mkdir(parents=True, exist_ok=True)
            required.write_text("ready", encoding="utf-8")
        return str(local_dir)

    assert bootstrap.ensure_snapshots(
        root=root,
        manifest_path=manifest,
        lock_path=lock,
        token="private-token-value",
        download=fake_download,
    ) is True

    assert [
        (call["repo_id"], call["revision"], Path(call["local_dir"]).name)
        for call in calls
    ] == [
        (
            "infodeliverailab/lab_asr_diarization_v1",
            "651c6d0f303557332293afa9fa15e1dd30456606",
            "lab_asr_diarization_v1",
        ),
        (
            "Qwen/Qwen3-ASR-1.7B",
            "b188e100bd85038c06d2812d24a39776eba774ca",
            "base_model",
        ),
        (
            "speechbrain/spkrec-ecapa-voxceleb",
            "0f99f2d0ebe89ac095bcc5903c4dd8f72b367286",
            "pretrained_ecapa",
        ),
    ]
    assert all(call["token"] == "private-token-value" for call in calls)
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    assert payload == bootstrap.expected_manifest(root)
    assert "private-token-value" not in manifest.read_text(encoding="utf-8")
    assert not list(root.glob("*.tmp"))

    def unexpected_download(**_kwargs):
        raise AssertionError("a matching warm volume must not redownload")

    assert bootstrap.ensure_snapshots(
        root=root,
        manifest_path=manifest,
        lock_path=lock,
        token=None,
        download=unexpected_download,
    ) is False


def test_fresh_placement_requires_hf_token(tmp_path):
    root = tmp_path / "lab-asr-poc"
    with pytest.raises(RuntimeError, match="HF_TOKEN"):
        bootstrap.ensure_snapshots(
            root=root,
            manifest_path=root / ".lab-batch-models.json",
            lock_path=root / ".lab-batch-download.lock",
            token=None,
        )


def test_check_only_rejects_revision_mismatch(tmp_path):
    root = tmp_path / "lab-asr-poc"
    for item in bootstrap.SNAPSHOTS:
        (root / item.directory).mkdir(parents=True)
    manifest = root / ".lab-batch-models.json"
    payload = bootstrap.expected_manifest(root)
    payload["snapshots"][0]["revision"] = "wrong-revision"
    manifest.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(RuntimeError, match="revision-mismatched"):
        bootstrap.ensure_snapshots(
            root=root,
            manifest_path=manifest,
            lock_path=root / ".lab-batch-download.lock",
            token=None,
            check_only=True,
        )


def test_check_only_rejects_missing_required_snapshot_file(tmp_path):
    root = tmp_path / "lab-asr-poc"
    for item in bootstrap.SNAPSHOTS:
        for relative in item.required_files:
            required = root / item.directory / relative
            required.parent.mkdir(parents=True, exist_ok=True)
            required.write_text("ready", encoding="utf-8")
    manifest = root / ".lab-batch-models.json"
    manifest.write_text(json.dumps(bootstrap.expected_manifest(root)), encoding="utf-8")
    (root / bootstrap.SNAPSHOTS[0].directory / bootstrap.SNAPSHOTS[0].required_files[0]).unlink()

    with pytest.raises(RuntimeError, match="revision-mismatched"):
        bootstrap.ensure_snapshots(
            root=root,
            manifest_path=manifest,
            lock_path=root / ".lab-batch-download.lock",
            token=None,
            check_only=True,
        )


def test_failed_download_does_not_publish_ready_manifest(tmp_path):
    root = tmp_path / "lab-asr-poc"

    def failed_download(**_kwargs):
        raise OSError("simulated download failure")

    with pytest.raises(OSError, match="simulated"):
        bootstrap.ensure_snapshots(
            root=root,
            manifest_path=root / ".lab-batch-models.json",
            lock_path=root / ".lab-batch-download.lock",
            token="private-token-value",
            download=failed_download,
        )
    assert not (root / ".lab-batch-models.json").exists()
