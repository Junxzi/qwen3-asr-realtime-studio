from __future__ import annotations

from prometheus_client import Counter, Gauge, Histogram

ACTIVE_SESSIONS = Gauge("qwen_realtime_active_sessions", "Current accepted WebSocket sessions")
AUDIO_SECONDS = Counter("qwen_realtime_audio_seconds_total", "PCM audio accepted by the service")
ASR_LATENCY = Histogram(
    "qwen_realtime_asr_seconds",
    "ASR inference wall time",
    ["kind"],
    buckets=(0.05, 0.1, 0.25, 0.5, 0.8, 1.0, 1.5, 2.5, 5.0, 10.0),
)
BACKEND_STAGE_LATENCY = Histogram(
    "qwen_realtime_backend_stage_seconds",
    "Backend inference wall time by stage",
    ["stage"],
    buckets=(0.025, 0.05, 0.1, 0.25, 0.5, 0.8, 1.0, 1.5, 2.5, 5.0, 10.0, 30.0, 60.0),
)
QUEUE_WAIT = Histogram(
    "qwen_realtime_queue_wait_seconds",
    "Time between job enqueue and inference start",
    ["kind"],
    buckets=(0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5),
)
REWRITE_VIOLATIONS = Counter(
    "qwen_realtime_rewrite_violations_total", "Hypotheses that diverged before the committed prefix"
)
CAPACITY_REJECTIONS = Counter("qwen_realtime_capacity_rejections_total", "Rejected new sessions")
ERRORS = Counter("qwen_realtime_errors_total", "Pipeline errors", ["stage"])
LAB_BATCH_ACTIVE = Gauge(
    "qwen_lab_batch_active_requests",
    "Current lab batch inference requests",
)
LAB_BATCH_REQUESTS = Counter(
    "qwen_lab_batch_requests_total",
    "Lab batch requests by terminal result",
    ["result"],
)
LAB_BATCH_UPLOAD_BYTES = Counter(
    "qwen_lab_batch_upload_bytes_total",
    "Audio bytes accepted by the lab batch worker",
)
LAB_BATCH_INFERENCE_LATENCY = Histogram(
    "qwen_lab_batch_inference_seconds",
    "Lab model inference wall time",
    buckets=(0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0),
)
