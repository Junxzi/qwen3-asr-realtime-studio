import json

from qwen_realtime.catalog import load_catalog_state
from qwen_realtime.models import context_catalog_required


def model_entry(*, required: bool) -> dict[str, object]:
    return {
        "model_id": "org/model",
        "revision": "abc",
        "local_dir": "/workspace/models/model",
        "requires_context_catalog": required,
    }


def test_real_context_model_requires_a_nonempty_catalog(tmp_path):
    missing = tmp_path / "missing.json"
    required = context_catalog_required(
        model_entry(required=True),
        asr_backend="qwen_async_vllm",
    )

    state = load_catalog_state(missing, required=required)

    assert state.errors == ["CATALOG_PATH is required for the selected Context model"]
    assert state.warnings == []
    assert state.ready is False

    empty = tmp_path / "empty.json"
    empty.write_text('{"revision":"r1","terms":[]}', encoding="utf-8")
    state = load_catalog_state(empty, required=required)
    assert state.errors == [
        "CATALOG_PATH must contain at least one term for the selected Context model"
    ]
    assert state.warnings == []
    assert state.ready is False

    populated = tmp_path / "populated.json"
    populated.write_text(
        json.dumps(
            {
                "revision": "r1",
                "terms": [
                    {"id": "nomura", "read": "ノムラ", "write": "野村證券"}
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    state = load_catalog_state(populated, required=required)
    assert state.errors == []
    assert state.warnings == []
    assert state.ready is True


def test_fake_and_explicit_non_context_models_keep_optional_catalog(tmp_path):
    missing = tmp_path / "missing.json"
    fake_required = context_catalog_required(
        model_entry(required=True),
        asr_backend="fake",
    )
    non_context_required = context_catalog_required(
        model_entry(required=False),
        asr_backend="qwen_async_vllm",
    )

    assert fake_required is False
    assert non_context_required is False
    state = load_catalog_state(missing, required=fake_required)
    assert state.errors == []
    assert state.warnings == [
        "catalog file is absent; worker will use the empty catalog revision"
    ]
    assert state.ready is True
