# Realtime stream safety

The worker validates safety limits before PCM reaches the streaming engine.

| Variable | Default | Enforcement |
| --- | ---: | --- |
| `MAX_PCM_FRAME_MS` | 1000 ms | Oversized binary frame: error + WebSocket close 1009 |
| `MAX_STREAM_AUDIO_SECONDS` | 14400 s | Cumulative accepted PCM: error + close 1008 |
| `MAX_AUDIO_LEAD_SECONDS` | 5 s | Audio sent ahead of wall clock: error + close 1008 |
| `MAX_SESSION_SECONDS` | 14700 s | Wall-clock session, including idle time: error + close 1008 |
| `MAX_SESSION_JOBS` | 8 | Per-session inference backlog; partial work is coalesced, final work backpressures |
| `MAX_SESSION_EVENTS` | 32 | Per-session outbound event backlog; partial events may be dropped, finals backpressure |
| `SCHEDULER_QUEUE_SIZE` | 64 | Global queued ASR requests |
| `SCHEDULER_MAX_CONCURRENT_BATCHES` | 2 | Global in-flight ASR batches |

The existing 20 ms minimum PCM frame and independent 20-second utterance/VAD reset are unchanged.

Final Sortformer work is bounded by `FINAL_DIARIZATION_TIMEOUT_SECONDS=4`, the remote sidecar request by `DIARIZER_REQUEST_TIMEOUT_SECONDS=4`, and state cleanup separately by `DIARIZER_CLEANUP_TIMEOUT_SECONDS=0.5`. These limits leave headroom under the browser's 10-second `stream.finalized` acknowledgement deadline.
