# Runtime state machine

```text
stopped --POST start--> starting --/healthz 2xx--> ready
ready --POST stop--> stopping --Pod EXITED--> stopped
any --provider/probe error--> error --retry status--> derived state
```

- UI polls status every2秒。進捗率や残り時間は表示しない。
- `ready`でのみWebSocket接続・マイク・ファイル入力を有効にする。
- WebSocketは`session.start`後、`session.ready`を受信して入力可能になる。
- 発話末尾では650msの無音を100msフレームで送ってEoUを促す。

