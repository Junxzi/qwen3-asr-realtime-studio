from __future__ import annotations

import json
from pathlib import Path
from typing import TypedDict


class ModelLockEntry(TypedDict):
    model_id: str
    revision: str
    local_dir: str
    requires_context_catalog: bool


def context_catalog_required(
    entry: ModelLockEntry | None,
    *,
    asr_backend: str,
) -> bool:
    return (
        asr_backend != "fake"
        and (entry is None or entry["requires_context_catalog"])
    )


def read_models_lock(path: Path) -> list[ModelLockEntry]:
    """Return the immutable model catalog without requiring model files locally."""

    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("models lock must be a JSON object")
    models: list[ModelLockEntry] = []
    for model_id, item in payload.items():
        if not isinstance(model_id, str) or not isinstance(item, dict):
            raise ValueError("models lock entries must be objects")
        revision = item.get("revision")
        local_dir = item.get("local_dir")
        if not isinstance(revision, str) or not isinstance(local_dir, str):
            raise ValueError("models lock entries require revision and local_dir")
        requires_context_catalog = item.get("requires_context_catalog", True)
        if not isinstance(requires_context_catalog, bool):
            raise ValueError("models lock requires_context_catalog must be a boolean")
        models.append(
            {
                "model_id": model_id,
                "revision": revision,
                "local_dir": local_dir,
                "requires_context_catalog": requires_context_catalog,
            }
        )
    return models
