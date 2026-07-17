#!/usr/bin/env bash
set -euo pipefail

# Optional RunPod Template start command. The image ENTRYPOINT already does this.
test -d /workspace
mkdir -p /workspace/cache/huggingface /workspace/cache/vllm /workspace/models /workspace/config
exec /opt/app/scripts/entrypoint.sh
