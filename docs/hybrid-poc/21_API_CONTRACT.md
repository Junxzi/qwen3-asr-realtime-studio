# API とイベント契約

## Session 作成

`POST /api/transcriptions`

```json
{
  "source": "microphone",
  "processing_mode": "hybrid",
  "model_id": "infodeliverailab/qwen3-asr-ja-rlbr-context-fullft"
}
```

未指定の `processing_mode` は `realtime`。`batch` と microphone の組み合わせは 400 とする。

## Assignment

```text
POST /api/transcriptions/:id/assignment {"purpose":"realtime"}
POST /api/transcriptions/:id/assignment {"purpose":"batch"}
GET  /api/transcriptions/:id/assignment?purpose=realtime
GET  /api/transcriptions/:id/assignment?purpose=batch
```

realtime の `connection` は `websocket_url`、batch は `batch_url` を返す。ticket は別 purpose へ流用できない。

heartbeat は `{"purpose":"realtime"}` のように一つだけ更新できる。body を省略した旧 client は、その session の全 assignment を更新する互換動作を維持する。catalog revision は realtime assignment の応答からだけ session へ反映する。

## Batch adapter

`POST /v1/audio/transcriptions`

- `Authorization: Bearer <batch-ticket>`
- multipart: `audio`, `session_id`, `model_id`, optional `utterance_id`, optional `max_new_tokens`
- `max_new_tokens`: 既定 800、上限 1024

結果は正規化済み `text`、`turns`、推論時間、RTF、timing source を返す。推定時刻は `proportional_estimate` と明示する。

## Pipeline event

```json
{
  "type": "pipeline.stage",
  "seq": 18,
  "pipeline_id": "hybrid_context_lab_v1",
  "utterance_id": "session-abc-utt-1",
  "stage": "lab_finalizer",
  "status": "running",
  "audio_end_ms": 3280,
  "elapsed_ms": 0,
  "detail_code": null
}
```

`status` は `queued | running | completed | fallback | failed | skipped`。イベントへ音声、文字列、カタログ用語、secret を含めない。`seq` は session 内単調増加とし、UI は古いイベントを無視する。

## 互換性

- 既存 session は DB default により realtime として読める。
- 既存 model catalog を残し、processing profile を追加フィールドとして返す。
- final 保存 API は同じ `utterance_id` の高い revision だけを採用する。
- processing profile は `availability.selectable/configured/provisionable/validated/status` を返す。実GPU未検証でも試行可能だが `validated=false` を明示する。
