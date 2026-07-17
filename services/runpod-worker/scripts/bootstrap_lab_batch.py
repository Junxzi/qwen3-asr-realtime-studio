from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from huggingface_hub import snapshot_download

try:
    import fcntl
except ImportError:  # pragma: no cover - production workers are Linux-based
    fcntl = None  # type: ignore[assignment]

DEFAULT_ROOT = Path("/workspace/lab-asr-poc")
DEFAULT_MANIFEST_NAME = ".lab-batch-models.json"
DEFAULT_LOCK_NAME = ".lab-batch-download.lock"


@dataclass(frozen=True, slots=True)
class SnapshotSpec:
    repo_id: str
    revision: str
    directory: str
    required_files: tuple[str, ...]


SNAPSHOTS = (
    SnapshotSpec(
        repo_id="infodeliverailab/lab_asr_diarization_v1",
        revision="651c6d0f303557332293afa9fa15e1dd30456606",
        directory="lab_asr_diarization_v1",
        required_files=("setup.sh", "infer_single.py", "weights/interleave.pt"),
    ),
    SnapshotSpec(
        repo_id="Qwen/Qwen3-ASR-1.7B",
        revision="b188e100bd85038c06d2812d24a39776eba774ca",
        directory="base_model",
        required_files=("config.json", "model.safetensors.index.json"),
    ),
    SnapshotSpec(
        repo_id="speechbrain/spkrec-ecapa-voxceleb",
        revision="0f99f2d0ebe89ac095bcc5903c4dd8f72b367286",
        directory="pretrained_ecapa",
        required_files=("hyperparams.yaml", "embedding_model.ckpt"),
    ),
)

Download = Callable[..., str]


def expected_manifest(root: Path) -> dict[str, object]:
    return {
        "schema_version": 1,
        "root": str(root),
        "snapshots": [
            {
                "repo_id": item.repo_id,
                "revision": item.revision,
                "local_dir": str(root / item.directory),
                "required_files": list(item.required_files),
            }
            for item in SNAPSHOTS
        ],
    }


def placement_matches(root: Path, manifest_path: Path) -> bool:
    try:
        current = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return False
    if current != expected_manifest(root):
        return False
    return all(
        (root / item.directory).is_dir()
        and all((root / item.directory / relative).is_file() for relative in item.required_files)
        for item in SNAPSHOTS
    )


def write_manifest_atomic(manifest_path: Path, payload: dict[str, object]) -> None:
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = manifest_path.with_name(f".{manifest_path.name}.{os.getpid()}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(manifest_path)
    finally:
        temporary.unlink(missing_ok=True)


def ensure_snapshots(
    *,
    root: Path,
    manifest_path: Path,
    lock_path: Path,
    token: str | None,
    check_only: bool = False,
    download: Download | None = None,
) -> bool:
    root.mkdir(parents=True, exist_ok=True)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+", encoding="utf-8") as lock_handle:
        if fcntl is None:
            raise RuntimeError("lab batch bootstrap requires Linux flock support")
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
        if placement_matches(root, manifest_path):
            return False
        if check_only:
            raise RuntimeError("lab batch snapshot placement is incomplete or revision-mismatched")
        if not token:
            raise RuntimeError("HF_TOKEN is required to download the private lab batch snapshot")

        downloader = download or snapshot_download
        for item in SNAPSHOTS:
            downloader(
                repo_id=item.repo_id,
                revision=item.revision,
                local_dir=root / item.directory,
                token=token,
            )
        write_manifest_atomic(manifest_path, expected_manifest(root))
        return True


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Provision pinned lab batch snapshots")
    parser.add_argument("--check-only", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    root = Path(os.getenv("LAB_BOOTSTRAP_ROOT", str(DEFAULT_ROOT)))
    manifest_path = Path(
        os.getenv("LAB_BOOTSTRAP_MANIFEST", str(root / DEFAULT_MANIFEST_NAME))
    )
    lock_path = Path(os.getenv("LAB_MODEL_DOWNLOAD_LOCK", str(root / DEFAULT_LOCK_NAME)))
    try:
        downloaded = ensure_snapshots(
            root=root,
            manifest_path=manifest_path,
            lock_path=lock_path,
            token=os.getenv("HF_TOKEN", "").strip() or None,
            check_only=args.check_only,
        )
    except RuntimeError as error:
        raise SystemExit(str(error)) from error
    print(
        json.dumps(
            {
                "status": "ready",
                "downloaded": downloaded,
                "snapshots": [
                    {"repo_id": item.repo_id, "revision": item.revision}
                    for item in SNAPSHOTS
                ],
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
