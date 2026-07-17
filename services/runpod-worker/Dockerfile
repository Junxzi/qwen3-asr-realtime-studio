# syntax=docker/dockerfile:1.7
ARG CUDA_IMAGE=nvidia/cuda:12.8.1-cudnn-devel-ubuntu24.04
ARG UV_VERSION=0.11.16

# The CI smoke target deliberately excludes the CUDA/vLLM/NeMo dependency
# stacks.  It exercises the exact packaged application, entrypoint, preflight,
# and health endpoints without loading the multi-gigabyte production image into
# the GitHub-hosted runner's Docker daemon.
FROM python:3.12-slim-bookworm AS smoke

ARG UV_VERSION
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/workspace/cache/huggingface \
    HUGGINGFACE_HUB_CACHE=/workspace/cache/huggingface/hub \
    VLLM_CACHE_ROOT=/workspace/cache/vllm \
    PORT=8000

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/app
COPY . /opt/app

RUN python3.12 -m pip install --no-cache-dir "uv==${UV_VERSION}" \
    && python3.12 -m venv /opt/venvs/asr \
    && UV_PROJECT_ENVIRONMENT=/opt/venvs/asr uv sync \
        --frozen --no-dev --no-install-project \
    && uv pip install \
        --python /opt/venvs/asr/bin/python --no-cache --no-deps /opt/app \
    && chmod 0755 /opt/app/scripts/entrypoint.sh /opt/app/scripts/run_all.sh \
        /opt/app/scripts/run_lab_batch.sh /opt/app/scripts/bootstrap_lab_batch.py

EXPOSE 8000
HEALTHCHECK --interval=5s --timeout=3s --start-period=15s --retries=4 \
    CMD ["/opt/venvs/asr/bin/python", "/opt/app/scripts/healthcheck.py"]
ENTRYPOINT ["/opt/app/scripts/entrypoint.sh"]

FROM ${CUDA_IMAGE} AS production

ARG UV_VERSION
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/workspace/cache/huggingface \
    HUGGINGFACE_HUB_CACHE=/workspace/cache/huggingface/hub \
    VLLM_CACHE_ROOT=/workspace/cache/vllm \
    PORT=8000

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential ca-certificates curl ffmpeg git libsndfile1 libgomp1 \
        libsox-fmt-all python3.12 python3.12-dev python3.12-venv sox \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/app
COPY . /opt/app

RUN python3.12 -m venv /opt/venvs/asr \
    && /opt/venvs/asr/bin/pip install --no-cache-dir "uv==${UV_VERSION}" \
    && /opt/venvs/asr/bin/uv pip install \
        --python /opt/venvs/asr/bin/python --no-cache \
        --require-hashes -r /opt/app/requirements.asr.lock \
    && /opt/venvs/asr/bin/uv pip install \
        --python /opt/venvs/asr/bin/python --no-cache --no-deps /opt/app \
    && python3.12 -m venv /opt/venvs/diarizer \
    && /opt/venvs/asr/bin/uv pip install \
        --python /opt/venvs/diarizer/bin/python --no-cache \
        --require-hashes -r /opt/app/requirements.diarizer.lock \
    && /opt/venvs/asr/bin/uv pip install \
        --python /opt/venvs/diarizer/bin/python --no-cache --no-deps /opt/app \
    && /opt/venvs/asr/bin/uv pip check --python /opt/venvs/asr/bin/python \
    && /opt/venvs/asr/bin/uv pip check --python /opt/venvs/diarizer/bin/python \
    && chmod 0755 /opt/app/scripts/entrypoint.sh /opt/app/scripts/run_all.sh \
        /opt/app/scripts/run_lab_batch.sh /opt/app/scripts/bootstrap_lab_batch.py

EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=300s --retries=4 \
    CMD ["/opt/venvs/asr/bin/python", "/opt/app/scripts/healthcheck.py"]
ENTRYPOINT ["/opt/app/scripts/entrypoint.sh"]
