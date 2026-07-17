#!/usr/bin/env bash
set -euo pipefail

readonly APP_ROOT="${APP_ROOT:-/opt/app}"
readonly ASR_PYTHON="${ASR_PYTHON:-/opt/venvs/asr/bin/python}"
readonly ASR_UVICORN="${ASR_UVICORN:-/opt/venvs/asr/bin/uvicorn}"

"$ASR_PYTHON" "$APP_ROOT/scripts/preflight.py"
exec "$ASR_UVICORN" qwen_realtime.app:app \
  --host 0.0.0.0 --port "${PORT:-8000}" --workers 1
