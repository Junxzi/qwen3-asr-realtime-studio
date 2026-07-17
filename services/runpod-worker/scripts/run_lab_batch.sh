#!/usr/bin/env bash
set -euo pipefail

readonly APP_ROOT="${APP_ROOT:-/opt/app}"
readonly LAB_BOOTSTRAP_ROOT="${LAB_BOOTSTRAP_ROOT:-/workspace/lab-asr-poc}"
readonly LAB_BOOTSTRAP_MANIFEST="${LAB_BOOTSTRAP_MANIFEST:-${LAB_BOOTSTRAP_ROOT}/.lab-batch-models.json}"
readonly LAB_REPO_PATH="${LAB_REPO_PATH:-${LAB_BOOTSTRAP_ROOT}/lab_asr_diarization_v1}"
readonly LAB_REPO_REVISION="${LAB_REPO_REVISION:-651c6d0f303557332293afa9fa15e1dd30456606}"
LAB_PYTHON="${LAB_PYTHON:-/opt/lab-asr-venv/bin/python}"
if [[ ! -x "$LAB_PYTHON" && -x /opt/venvs/asr/bin/python ]]; then
  LAB_PYTHON=/opt/venvs/asr/bin/python
fi
if [[ ! -x "$LAB_PYTHON" && -x "${LAB_REPO_PATH}/venv/bin/python" ]]; then
  LAB_PYTHON="${LAB_REPO_PATH}/venv/bin/python"
fi

if [[ ! -d "$LAB_REPO_PATH" ]]; then
  echo "LAB_REPO_PATH does not exist: $LAB_REPO_PATH" >&2
  exit 1
fi
if [[ ! -x "$LAB_PYTHON" ]]; then
  echo "LAB_PYTHON is not executable: $LAB_PYTHON" >&2
  exit 1
fi
if [[ -n "$LAB_REPO_REVISION" ]]; then
  actual_revision="$(git -C "$LAB_REPO_PATH" rev-parse HEAD 2>/dev/null || true)"
  if [[ -z "$actual_revision" && -f "$LAB_BOOTSTRAP_MANIFEST" ]]; then
    "$LAB_PYTHON" "$APP_ROOT/scripts/bootstrap_lab_batch.py" --check-only >/dev/null
    actual_revision="$LAB_REPO_REVISION"
  fi
  if [[ -z "$actual_revision" ]]; then
    readonly HF_METADATA_ROOT="${LAB_REPO_PATH}/.cache/huggingface/download"
    readonly HF_TREE_MARKER="${LAB_REPO_PATH}/.cache/huggingface/trees/${LAB_REPO_REVISION}.json"
    readonly HF_REVISION_MARKERS=(
      "${HF_METADATA_ROOT}/setup.sh.metadata"
      "${HF_METADATA_ROOT}/infer_single.py.metadata"
      "${HF_METADATA_ROOT}/weights/interleave.pt.metadata"
    )
    hf_snapshot_valid=true
    [[ -f "$HF_TREE_MARKER" ]] || hf_snapshot_valid=false
    for marker in "${HF_REVISION_MARKERS[@]}"; do
      [[ -f "$marker" ]] || { hf_snapshot_valid=false; break; }
      IFS= read -r marker_revision < "$marker"
      [[ "$marker_revision" == "$LAB_REPO_REVISION" ]] || { hf_snapshot_valid=false; break; }
    done
    if [[ "$hf_snapshot_valid" == true ]]; then
      actual_revision="$LAB_REPO_REVISION"
    fi
  fi
  if [[ "$actual_revision" != "$LAB_REPO_REVISION" ]]; then
    echo "LAB_REPO_PATH revision mismatch: expected $LAB_REPO_REVISION, got ${actual_revision:-unknown}" >&2
    exit 1
  fi
fi
if ! "$LAB_PYTHON" -c 'import fastapi, multipart, uvicorn' >/dev/null 2>&1; then
  echo "LAB_PYTHON must provide fastapi, python-multipart, and uvicorn" >&2
  exit 1
fi
export PYTHONPATH="${APP_ROOT}/src:${LAB_REPO_PATH}${PYTHONPATH:+:${PYTHONPATH}}"
export BASE_MODEL_DIR="${BASE_MODEL_DIR:-${LAB_BOOTSTRAP_ROOT}/base_model}"
export LAB_ECAPA_DIR="${LAB_ECAPA_DIR:-${LAB_BOOTSTRAP_ROOT}/pretrained_ecapa}"
export LAB_CHECKPOINT_PATH="${LAB_CHECKPOINT_PATH:-${LAB_REPO_PATH}/weights/interleave.pt}"
export PYTHONDONTWRITEBYTECODE=1
export PYTHONUNBUFFERED=1

exec "$LAB_PYTHON" -m uvicorn qwen_realtime.lab_batch:app \
  --host 0.0.0.0 --port "${PORT:-8000}" --workers 1
