from __future__ import annotations

import fcntl
import json
import os
from pathlib import Path

from huggingface_hub import snapshot_download

DEFAULT_LOCK = Path("/opt/app/config/models.lock.json")
MODEL_MANIFEST = ".qwen-realtime-model.json"
SUPPORT_MODEL_IDS = (
    "Qwen/Qwen3-ForcedAligner-0.6B",
    "nvidia/diar_streaming_sortformer_4spk-v2.1",
)


def main() -> None:
    lock_path = Path(os.getenv("MODELS_LOCK_PATH", str(DEFAULT_LOCK)))
    payload = json.loads(lock_path.read_text(encoding="utf-8"))
    model_id = os.getenv(
        "MODEL_ID", "infodeliverailab/qwen3-asr-ja-rlbr-context-fullft"
    )
    selected_ids = (model_id, *SUPPORT_MODEL_IDS)
    missing = [item for item in selected_ids if item not in payload]
    if missing:
        raise SystemExit(f"models lock does not contain required ids: {missing}")

    lock_file = Path(os.getenv("MODEL_DOWNLOAD_LOCK", "/workspace/.locks/model-download.lock"))
    lock_file.parent.mkdir(parents=True, exist_ok=True)
    downloaded: list[dict[str, str]] = []
    with lock_file.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        for selected_id in selected_ids:
            item = payload[selected_id]
            revision = str(item["revision"])
            local_dir = Path(str(item["local_dir"]))
            local_dir.parent.mkdir(parents=True, exist_ok=True)
            snapshot_download(
                repo_id=selected_id,
                revision=revision,
                local_dir=local_dir,
                token=os.getenv("HF_TOKEN"),
            )
            manifest = local_dir / MODEL_MANIFEST
            temporary = local_dir / f"{MODEL_MANIFEST}.tmp"
            temporary.write_text(
                json.dumps(
                    {"model_id": selected_id, "revision": revision},
                    ensure_ascii=False,
                    sort_keys=True,
                )
                + "\n",
                encoding="utf-8",
            )
            temporary.replace(manifest)
            downloaded.append({"model_id": selected_id, "revision": revision})
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    print(json.dumps({"status": "ready", "models": downloaded}, ensure_ascii=False))


if __name__ == "__main__":
    main()
