# API contract

すべて既存cookie認証が必要。mutationはOrigin検証を行う。エラーは`{error:{code,message,requestId,details?}}`。

## POST /api/transcriptions/:id/assignment

Request:

```json
{"purpose":"realtime"}
```

未readyは202、readyは200。同じsessionへの再要求は同じassignmentを返す。

```json
{
  "data": {
    "id": "uuid",
    "session_id": "uuid",
    "model_id": "infodeliverailab/qwen3-asr-ja-rlbr-context-fullft",
    "purpose": "realtime",
    "status": "ready",
    "worker": {"id":"context-a","pod_id":"pod-id","name":"context-a","loaded_model_id":"..."},
    "connection": {
      "websocket_url": "wss://pod-id-8000.proxy.runpod.net/v1/realtime",
      "ticket": "short-lived-signed-value",
      "expires_at": "2026-07-17T00:02:00.000Z"
    },
    "message": null,
    "retry_after_ms": 1000
  }
}
```

現行WorkerはリアルタイムWebSocketだけを実装しているため、存在しないbatch URLは返さない。将来batch adapterを有効化するときは、Worker endpointと契約テストを同時に追加する。

## GET /api/transcriptions/:id/assignment

現在の状態だけを返すread-only endpoint。Pod起動・作成などの副作用は行わない。未作成は404 `assignment_not_found`。準備を進めるpollはOrigin検証付きの`POST`を同じsessionへ冪等に再送する。

## POST /api/transcriptions/:id/assignment/heartbeat

認証CookieとOrigin検証を必須とし、録音中sessionに結び付いた`ready`/`active` assignmentだけを`active`へ更新してleaseを延長する。ブラウザはWorker WebSocketまたは長時間file処理の開始直後と60秒ごとに送信し、terminal completionを開始する前にintervalを停止して進行中requestをabortする。terminal sessionは409 `transcription_not_active`、未割当は404 `assignment_not_found`、非active assignmentは409 `assignment_not_active`を返す。

## GET /api/workers

診断向けworker一覧とpool集計を返す。secret、ticket、内部Authorization headerは返さない。

## Worker contract

- `GET /health`: process liveness。モデル未readyでも200可。
- `GET /ready?model_id=<id>`: 指定モデルを今すぐ受付可能な場合だけ200。それ以外は503。
- `GET /admin/models`: 管理secret必須。
- `POST /admin/models/load`: 同じresident modelは冪等200。別モデルは409 `restart_required`。
- `POST /admin/drain`: 新規session受付を停止。
- `WS /v1/realtime`: 最初のtext frameは`session.start`。

```json
{
  "type":"session.start",
  "session_id":"uuid",
  "sample_rate":16000,
  "encoding":"pcm_s16le",
  "catalog_revision":"revision",
  "model_id":"infodeliverailab/qwen3-asr-ja-rlbr-context-fullft",
  "connection_ticket":"short-lived-signed-value"
}
```

`session.ready`の`input_end_supported:true`を確認したクライアントは、最終binary PCMの後に
`{"type":"input.end"}`を送る。WorkerはVADをflushし、queue済みのpartial/finalをすべて送信してから
`{"type":"stream.finalized","session_id":"uuid"}`を返す。クライアントはこのackとfinalの保存完了を
待ってからセッションを`completed`にする。

## Ticket claims

```json
{"v":1,"aud":"qwen-realtime-worker","wid":"worker-id","sid":"session-id","mid":"model-id","purpose":"realtime","exp":1784220000}
```

payloadのbase64urlとHMAC-SHA256署名を`.`で連結する。署名比較はconstant-time。workerは`wid/sid/mid/purpose/exp/aud`をすべて検証する。
