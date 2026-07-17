#!/usr/bin/env bash
set -euo pipefail

readonly APP_ROOT="${APP_ROOT:-/opt/app}"
readonly ASR_PYTHON="${ASR_PYTHON:-/opt/venvs/asr/bin/python}"
readonly ASR_UVICORN="${ASR_UVICORN:-/opt/venvs/asr/bin/uvicorn}"
readonly DIARIZER_UVICORN="${DIARIZER_UVICORN:-/opt/venvs/diarizer/bin/uvicorn}"

export HF_HOME="${HF_HOME:-/workspace/cache/huggingface}"
export HUGGINGFACE_HUB_CACHE="${HUGGINGFACE_HUB_CACHE:-${HF_HOME}/hub}"
readonly CACHE_ID_RAW="${RUNPOD_POD_ID:-${WORKER_ID:-local-worker}}"
readonly CACHE_ID="${CACHE_ID_RAW//[^a-zA-Z0-9_.-]/_}"
readonly VLLM_CACHE_BASE="${VLLM_CACHE_ROOT:-/workspace/cache/vllm}"
export VLLM_CACHE_ROOT="${VLLM_CACHE_BASE%/}/${CACHE_ID}"
export TORCHINDUCTOR_CACHE_DIR="${TORCHINDUCTOR_CACHE_DIR:-${VLLM_CACHE_ROOT}/torchinductor}"
export PYTHONUNBUFFERED=1
export PYTHONDONTWRITEBYTECODE=1
export NO_PROXY="${NO_PROXY:-127.0.0.1,localhost}"
export no_proxy="${no_proxy:-127.0.0.1,localhost}"

mkdir -p \
  /workspace/cache/huggingface \
  "$VLLM_CACHE_ROOT" \
  "$TORCHINDUCTOR_CACHE_DIR" \
  /workspace/models \
  /workspace/config

BOOTSTRAP_PID=""
DIARIZER_PID=""
MAIN_PID=""

shutdown() {
  for pid in "$MAIN_PID" "$DIARIZER_PID" "$BOOTSTRAP_PID"; do
    if [[ -n "$pid" ]]; then
      kill "$pid" 2>/dev/null || true
    fi
  done
}
trap shutdown EXIT INT TERM

# Keep liveness available while a fresh volume downloads and validates models.
# /ready remains 503 until the real service has loaded the resident model.
"$ASR_PYTHON" "$APP_ROOT/scripts/bootstrap_server.py" &
BOOTSTRAP_PID=$!
for _ in $(seq 1 50); do
  if curl --fail --silent "http://127.0.0.1:${PORT:-8000}/health" >/dev/null; then
    break
  fi
  if ! kill -0 "$BOOTSTRAP_PID" 2>/dev/null; then
    echo "Bootstrap health service exited during startup" >&2
    wait "$BOOTSTRAP_PID"
    exit 1
  fi
  sleep 0.1
done

if [[ "${ASR_BACKEND:-qwen_async_vllm}" != "fake" && "${BOOTSTRAP_MODELS:-true}" == "true" ]]; then
  "$ASR_PYTHON" "$APP_ROOT/scripts/bootstrap_models.py"
fi

"$ASR_PYTHON" "$APP_ROOT/scripts/preflight.py"

if [[ "${DIARIZER_BACKEND:-sortformer_remote}" == "sortformer_remote" ]]; then
  "$DIARIZER_UVICORN" qwen_realtime.diarizer_sidecar:app \
    --host 127.0.0.1 --port 18001 --workers 1 &
  DIARIZER_PID=$!

  for _ in $(seq 1 "${DIARIZER_STARTUP_TIMEOUT_SECONDS:-180}"); do
    if curl --fail --silent http://127.0.0.1:18001/healthz >/dev/null; then
      break
    fi
    if ! kill -0 "$DIARIZER_PID" 2>/dev/null; then
      echo "Sortformer sidecar exited during startup" >&2
      wait "$DIARIZER_PID"
      exit 1
    fi
    sleep 1
  done
  if ! curl --fail --silent http://127.0.0.1:18001/healthz >/dev/null; then
    echo "Sortformer sidecar did not become ready before the timeout" >&2
    exit 1
  fi
fi

kill "$BOOTSTRAP_PID" 2>/dev/null || true
wait "$BOOTSTRAP_PID" 2>/dev/null || true
BOOTSTRAP_PID=""

if [[ -z "$DIARIZER_PID" ]]; then
  trap - EXIT INT TERM
  exec "$ASR_UVICORN" qwen_realtime.app:app \
    --host 0.0.0.0 --port "${PORT:-8000}" --workers 1
fi

"$ASR_UVICORN" qwen_realtime.app:app \
  --host 0.0.0.0 --port "${PORT:-8000}" --workers 1 &
MAIN_PID=$!

set +e
wait -n "$MAIN_PID" "$DIARIZER_PID"
STATUS=$?
set -e
shutdown
wait "$MAIN_PID" 2>/dev/null || true
wait "$DIARIZER_PID" 2>/dev/null || true
exit "$STATUS"
