# Architecture

```text
Browser
  ├─ HTTPS → Railway React UI / Express API
  │            └─ PostgreSQL
  │                 ├─ transcription_sessions
  │                 └─ transcript_utterances (final only)
  └─ WSS PCM → RunPod /v1/realtime
                 └─ Qwen3-ASR Context Full-FT 1.7B on A100
```

## Decisions

- ADR-01: Railwayは認証、履歴、集計メトリクスを扱う制御面とする。
- ADR-02: 音声をRailway経由でプロキシしない。ブラウザからRunPodへ直接送る。
- ADR-03: DB session IDを`session.start.session_id`にも使い、保存履歴とWSSを一意に結びつける。
- ADR-04: 音声、partial、ライブイベントは永続化せず、finalと単語情報だけを保存する。
- ADR-05: providerは`mock|readonly|live`とし、CIとローカル検証では課金APIを呼ばない。
- ADR-06: 保存失敗はブラウザのIndexedDB outboxへ退避し、finalの冪等PUTで再送する。
- ADR-07: 30日retentionは起動時と24時間ごとのmaintenanceで適用する。

## Data lifecycle

1. `POST /api/transcriptions`でUUIDを発行する。
2. 同じUUIDをRunPodの`session.start`へ送る。
3. partialは画面だけを更新する。
4. finalを`PUT .../utterances/:utteranceId`で保存する。
5. 停止時に`POST .../complete`で状態と集計メトリクスを保存する。
6. 期限到達または利用者の削除操作でsessionとutteranceを一括削除する。
