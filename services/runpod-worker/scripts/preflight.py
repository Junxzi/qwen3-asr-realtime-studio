from __future__ import annotations

import json
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

from qwen_realtime.catalog import load_catalog_state
from qwen_realtime.config import Settings
from qwen_realtime.models import context_catalog_required, read_models_lock

LOCKED_GPU_PACKAGES = {
    "qwen-asr": "0.0.6",
    "vllm": "0.14.0",
    "silero-vad": "6.2.1",
}
MODEL_MANIFEST = ".qwen-realtime-model.json"
ALIGNER_MODEL_ID = "Qwen/Qwen3-ForcedAligner-0.6B"
DIARIZER_MODEL_ID = "nvidia/diar_streaming_sortformer_4spk-v2.1"


def _secret_error(name: str, value: str | None) -> str | None:
    if value is None:
        return f"{name} is required"
    if len(value.encode("utf-8")) < 32:
        return f"{name} must contain at least 32 bytes"
    return None


def _validate_locked_model(
    *,
    label: str,
    configured_path: Path,
    entry: dict[str, str] | None,
    allow_child: bool = False,
) -> list[str]:
    if entry is None:
        return [f"{label} is not present in the immutable models lock"]
    expected_dir = Path(entry["local_dir"])
    configured = configured_path.resolve(strict=False)
    expected = expected_dir.resolve(strict=False)
    path_matches = configured == expected or (allow_child and expected in configured.parents)
    errors: list[str] = []
    if not path_matches:
        errors.append(f"{label} does not match the immutable models lock local_dir")
    if not configured_path.exists():
        errors.append(f"{label} does not exist")
    manifest_path = expected_dir / MODEL_MANIFEST
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        errors.append(f"{label} immutable revision manifest is missing or invalid")
    else:
        if manifest.get("model_id") != entry["model_id"]:
            errors.append(f"{label} manifest model_id does not match the models lock")
        if manifest.get("revision") != entry["revision"]:
            errors.append(f"{label} manifest revision does not match the models lock")
    return errors


def main() -> None:
    settings = Settings.from_env()
    errors: list[str] = []
    warnings: list[str] = []

    error = _secret_error("WORKER_ADMIN_SECRET", settings.worker_admin_secret)
    if error is not None:
        errors.append(error)
    if settings.require_worker_ticket:
        error = _secret_error("WORKER_TICKET_SECRET", settings.worker_ticket_secret)
        if error is not None:
            errors.append(error)
    if not settings.require_worker_ticket and settings.asr_backend != "fake":
        errors.append("REQUIRE_WORKER_TICKET=false is allowed only with ASR_BACKEND=fake")
    if not settings.worker_id:
        errors.append("WORKER_ID or RUNPOD_POD_ID is required")

    try:
        models = read_models_lock(settings.models_lock_path)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        models = []
        errors.append(f"MODELS_LOCK_PATH is invalid: {type(exc).__name__}")
    locked_by_id = {item["model_id"]: item for item in models}
    locked_ids = set(locked_by_id)
    if settings.model_id not in locked_ids:
        errors.append("MODEL_ID is not present in the immutable models lock")

    selected_model = locked_by_id.get(settings.model_id)
    catalog_state = load_catalog_state(
        settings.catalog_path,
        required=context_catalog_required(
            selected_model,
            asr_backend=settings.asr_backend,
        ),
    )
    errors.extend(catalog_state.errors)
    warnings.extend(catalog_state.warnings)

    gpu_details: dict[str, object] | None = None
    if settings.asr_backend != "fake":
        errors.extend(
            _validate_locked_model(
                label="ASR_MODEL",
                configured_path=Path(settings.asr_model),
                entry=locked_by_id.get(settings.model_id),
            )
        )
        if settings.enable_aligner:
            errors.extend(
                _validate_locked_model(
                    label="ALIGNER_MODEL",
                    configured_path=Path(settings.aligner_model),
                    entry=locked_by_id.get(ALIGNER_MODEL_ID),
                )
            )
        if settings.diarizer_backend == "sortformer_remote":
            errors.extend(
                _validate_locked_model(
                    label="DIARIZER_MODEL",
                    configured_path=Path(settings.diarizer_model),
                    entry=locked_by_id.get(DIARIZER_MODEL_ID),
                    allow_child=True,
                )
            )
        actual: dict[str, str] = {}
        for package, expected in LOCKED_GPU_PACKAGES.items():
            try:
                actual[package] = version(package)
            except PackageNotFoundError:
                errors.append(f"required GPU package is missing: {package}")
                continue
            if actual[package] != expected:
                errors.append(
                    f"GPU package lock mismatch for {package}: expected {expected}, got {actual[package]}"
                )
        try:
            import torch

            if not torch.cuda.is_available():
                errors.append("CUDA GPU is not available")
            elif not torch.cuda.is_bf16_supported():
                errors.append("the configured BF16 runtime requires a BF16-capable GPU")
            else:
                gpu_details = {
                    "name": torch.cuda.get_device_name(0),
                    "torch": torch.__version__,
                    "cuda": torch.version.cuda,
                    "packages": actual,
                }
        except ImportError:
            errors.append("torch is not importable in the ASR environment")

    result = {
        "status": "error" if errors else "ok",
        "worker_id": settings.worker_id,
        "model_id": settings.model_id,
        "backend": settings.asr_backend,
        "gpu": gpu_details,
        "warnings": warnings,
        "errors": errors,
    }
    print(json.dumps(result, ensure_ascii=False))
    if errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
