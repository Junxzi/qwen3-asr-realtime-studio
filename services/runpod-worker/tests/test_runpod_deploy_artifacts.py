from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).parents[3]
DEPLOY_ROOT = REPO_ROOT / "deploy" / "runpod"


def load_json(name: str):
    return json.loads((DEPLOY_ROOT / name).read_text(encoding="utf-8"))


def test_model_template_map_includes_single_session_lab_batch_runtime():
    profiles = load_json("model-templates.example.json")
    assert profiles == [
        {
            "model_id": "infodeliverailab/qwen3-asr-ja-rlbr-context-fullft",
            "runtime": "realtime",
            "template_id": "replace-with-context-worker-template-id",
            "max_sessions": 32,
        },
        {
            "model_id": "infodeliverailab/lab_asr_diarization_v1",
            "runtime": "batch",
            "template_id": "replace-with-lab-batch-worker-template-id",
            "max_sessions": 1,
        },
    ]


def test_lab_batch_template_is_immutable_private_and_volume_backed():
    template = load_json("lab-batch-template.example.json")
    env = template["env"]
    assert template["imageName"].endswith("@sha256:<verified-digest>")
    assert template["dockerEntrypoint"] == []
    assert template["dockerStartCmd"] == []
    assert template["ports"] == ["8000/http"]
    assert template["volumeMountPath"] == "/workspace"
    assert template["isPublic"] is False
    assert env["WORKER_RUNTIME"] == "batch"
    assert env["MODEL_ID"] == "infodeliverailab/lab_asr_diarization_v1"
    assert env["MAX_SESSIONS"] == "1"
    assert env["LAB_REPO_REVISION"] == (
        "651c6d0f303557332293afa9fa15e1dd30456606"
    )
    assert env["LAB_PYTHON"] == "/opt/venvs/asr/bin/python"
    assert env["LAB_ALLOWED_ORIGINS"] != "*"
    assert env["HF_TOKEN"] == "{{ RUNPOD_SECRET_hf_token }}"
    assert env["WORKER_TICKET_SECRET"] == (
        "{{ RUNPOD_SECRET_worker_ticket_secret }}"
    )
    assert '"HF_TOKEN": "hf_' not in json.dumps(template)
