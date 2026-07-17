from __future__ import annotations

import subprocess
import threading
import time
from typing import Any

_CACHE_SECONDS = 5.0
_cache: dict[str, Any] = {}
_cached_at = 0.0
_lock = threading.Lock()


def _number(value: str) -> float | None:
    try:
        return float(value.strip())
    except ValueError:
        return None


def parse_nvidia_smi(line: str) -> dict[str, Any]:
    fields = [field.strip() for field in line.split(",")]
    if len(fields) != 6:
        return {}
    utilization, memory_used, memory_total, temperature, power, name = fields
    values = {
        "gpu_utilization_percent": _number(utilization),
        "gpu_memory_used_mb": _number(memory_used),
        "gpu_memory_total_mb": _number(memory_total),
        "gpu_temperature_c": _number(temperature),
        "gpu_power_w": _number(power),
        "accelerator": name or None,
    }
    return {key: value for key, value in values.items() if value is not None}


def gpu_telemetry() -> dict[str, Any]:
    global _cache, _cached_at
    now = time.monotonic()
    with _lock:
        if now - _cached_at < _CACHE_SECONDS:
            return dict(_cache)
        try:
            result = subprocess.run(
                [
                    "nvidia-smi",
                    "--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,name",
                    "--format=csv,noheader,nounits",
                ],
                check=True,
                capture_output=True,
                text=True,
                timeout=2,
            )
            first_gpu = result.stdout.splitlines()[0] if result.stdout.splitlines() else ""
            _cache = parse_nvidia_smi(first_gpu)
        except (FileNotFoundError, IndexError, subprocess.SubprocessError):
            _cache = {}
        _cached_at = now
        return dict(_cache)
