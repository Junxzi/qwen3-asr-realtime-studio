# テストと品質ゲート

## Control plane

- legacy create の realtime default。
- batch + microphone の拒否。
- hybrid の二 assignment と purpose ごとの冪等性。
- batch URL、ticket purpose isolation。
- heartbeat、complete、delete、reaper の全割当解放。
- 一 worker 喪失時に sibling assignment を保持。

## Worker

- raw/bracket speaker tag parser。
- upload、token、auth、CORS、capacity 上限。
- pipeline event の seq、順序、PII 非混入。
- 480ms endpoint で一度だけ finalizer が起動。
- finalizer 中も後続 partial が止まらない。
- `stream.finalized` は全 final 完了後に送る。

## Frontend

- reducer の重複、逆順、複数発話、failed/fallback。
- 古い final が別発話 partial を消さない。
- batch speaker tag 正規化と 800 token default。
- 保存成功、outbox、IndexedDB 失敗の状態。
- 1536×1024 と 390×844 の screenshot。
- keyboard、aria label、reduced motion。

## 必須コマンド

```text
npm run lint
npm run typecheck
npm test
npm run build
pytest services/runpod-worker/tests
```

生成キャッシュは lint 対象から除外するが、source や test のエラーは除外しない。GPU smoke は commit、model revision、worker image digest、音声 fixture、応答 JSON を記録する。
