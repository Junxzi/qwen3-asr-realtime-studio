# Runtime state machine

```text
stopped --assignment/live start--> starting --strict worker probes--> ready
ready --POST stop--> stopping --Pod EXITED--> stopped
any --provider/probe error--> error --retry status--> derived state
```

`strict worker probes`は`/health`のliveness、`/ready?model_id=...`の完全なworker/model一致・受付状態・Context catalog revision、およびproductionで`/healthz`の`inference_mode=real`をすべて確認する。単一の2xxだけではreadyにしない。

- UI polls status every2秒。進捗率や残り時間は表示しない。
- `ready`でのみWebSocket接続・マイク・ファイル入力を有効にする。
- WebSocketは`session.start`後、`session.ready`を受信して入力可能になる。
- 対応Workerでは`input.end`を送り、全finalより後の`stream.finalized`を最大10秒待ってから保存・完了する。
- capabilityを返さない旧Workerだけは700msの無音後、末尾finalまたは1秒quiet windowを最大5秒待つ。これはbest-effortとして診断イベントに明記する。
- 予期しないWebSocket切断は同一セッションのterminalization latchを通して一度だけ`failed`完了し、assignmentを解放する。
