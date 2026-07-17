from qwen_realtime.gpu import parse_nvidia_smi


def test_parse_nvidia_smi_telemetry():
    assert parse_nvidia_smi("62, 31744, 81920, 48, 286.5, NVIDIA A100 80GB PCIe") == {
        "gpu_utilization_percent": 62.0,
        "gpu_memory_used_mb": 31744.0,
        "gpu_memory_total_mb": 81920.0,
        "gpu_temperature_c": 48.0,
        "gpu_power_w": 286.5,
        "accelerator": "NVIDIA A100 80GB PCIe",
    }


def test_parse_nvidia_smi_rejects_partial_rows():
    assert parse_nvidia_smi("62, 31744") == {}
