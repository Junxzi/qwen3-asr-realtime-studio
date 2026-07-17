import json

import pytest

from qwen_realtime.models import read_models_lock


def test_models_lock_is_read_without_touching_model_files(tmp_path):
    path = tmp_path / "models.lock.json"
    path.write_text(
        json.dumps(
            {"org/model": {"revision": "abc", "local_dir": "/workspace/models/model"}}
        ),
        encoding="utf-8",
    )
    assert read_models_lock(path) == [
        {
            "model_id": "org/model",
            "revision": "abc",
            "local_dir": "/workspace/models/model",
            "requires_context_catalog": True,
        }
    ]


def test_models_lock_preserves_context_catalog_requirement(tmp_path):
    path = tmp_path / "models.lock.json"
    path.write_text(
        json.dumps(
            {
                "org/context-model": {
                    "revision": "abc",
                    "local_dir": "/workspace/models/context-model",
                    "requires_context_catalog": True,
                }
            }
        ),
        encoding="utf-8",
    )
    assert read_models_lock(path)[0]["requires_context_catalog"] is True


def test_invalid_models_lock_fails_loudly(tmp_path):
    path = tmp_path / "models.lock.json"
    path.write_text('{"org/model": {"revision": "abc"}}', encoding="utf-8")
    with pytest.raises(ValueError, match="revision and local_dir"):
        read_models_lock(path)

    path.write_text(
        json.dumps(
            {
                "org/model": {
                    "revision": "abc",
                    "local_dir": "/workspace/models/model",
                    "requires_context_catalog": "yes",
                }
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="requires_context_catalog"):
        read_models_lock(path)
