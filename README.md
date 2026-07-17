# InfoDeliver ASR Studio

RunPod上のInfoDeliver文字起こしモデルへ、ブラウザから音声を直接送る文字起こしStudioです。Railwayは認証、RunPod状態確認、モデルカタログ、確定文字列の履歴、計測値だけを扱います。音声本体、部分結果、ライブイベントは保存しません。

## 主な機能

- マイクまたは音声ファイルのリアルタイム送信
- 新規セッションごとのASRモデル選択
- Context Full-FT 1.7Bのリアルタイム処理とQwen3-Omni 30B-A3Bのファイル一括処理
- 話者別のpartial/final表示と保存済み履歴
- 履歴検索、名称変更、即時削除
- Railway保存失敗時のIndexedDB outbox再送
- GPU、WebSocket、TTFT、stable latency、Context hitの診断表示
- 30日経過履歴の自動削除

## ローカル起動

```powershell
Copy-Item .env.example .env
npm ci
npm run build
npm start
```

初期設定は`RUNPOD_PROVIDER=mock`、履歴はメモリ保存です。`http://localhost:3000`を開き、`.env`の`CONTROL_PASSWORD`でログインします。

## コマンド

| Command | Purpose |
| --- | --- |
| `npm run dev` | Express APIをwatch起動 |
| `npm run dev:client` | Vite UIを起動 |
| `npm run check` | lint、型検査、テスト、production build |
| `npm run db:migrate` | `dist`を使ってDrizzle migrationを実行 |
| `npm start` | production成果物を`PORT`で起動 |

## 履歴API

すべて共通パスワード認証が必要です。

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/models` | 選択可能なASRモデルと入力方式を取得 |
| `GET` | `/api/transcriptions?cursor=&limit=&q=` | 履歴一覧・検索 |
| `POST` | `/api/transcriptions` | セッション開始 |
| `GET` | `/api/transcriptions/:id` | 発話と計測値を取得 |
| `PATCH` | `/api/transcriptions/:id` | 名称変更 |
| `PUT` | `/api/transcriptions/:id/utterances/:utteranceId` | 確定発話を冪等保存 |
| `POST` | `/api/transcriptions/:id/complete` | 完了・中断・失敗を保存 |
| `DELETE` | `/api/transcriptions/:id` | 関連発話を含めて削除 |

## Railway variables

| Variable | Required | Description |
| --- | --- | --- |
| `RUNPOD_PROVIDER` | yes | 本番は`live`。GPU起動をUIから行わない場合は`readonly` |
| `RUNPOD_API_KEY` | live | RunPod REST API bearer token。ブラウザには送らない |
| `RUNPOD_POD_ID` | yes | 対象Pod ID |
| `RUNPOD_SERVICE_URL` | yes | RunPod公開サービスURL |
| `RUNPOD_READY_PATH` | yes | ASR readiness path |
| `CONTROL_PASSWORD` | yes | UI共通パスワード |
| `SESSION_SECRET` | yes | 32文字以上のランダム値 |
| `SESSION_TTL_SECONDS` | no | 既定43200秒 |
| `ALLOWED_ORIGIN` | yes | Railway公開URL。末尾`/`なし |
| `DATABASE_URL` | Railway | `${{Postgres.DATABASE_URL}}`を参照 |
| `TRANSCRIPT_STORAGE` | Railway | `postgres` |
| `TRANSCRIPT_RETENTION_DAYS` | no | 既定30日 |
| `TRANSCRIPT_STALE_MINUTES` | no | 未完了セッションを中断扱いにする時間。既定10分 |

`RUNPOD_API_KEY`、`CONTROL_PASSWORD`、`SESSION_SECRET`をGitへコミットせず、Railway Variablesへ登録してください。

## Railway deployment

1. Railway ProjectにPostgreSQL serviceを追加する。
2. Web serviceへ`DATABASE_URL=${{Postgres.DATABASE_URL}}`と`TRANSCRIPT_STORAGE=postgres`を設定する。
3. 上記variablesを設定してデプロイする。
4. `railway.json`のpre-deployでmigrationが完了してから新しいコンテナが公開される。
5. `/api/health`の`storage`と画面の履歴作成・再読み込みを確認する。

ロールバック時も追加テーブルは残るため、旧版アプリへの復帰を妨げません。

## 運用上の注意

- GPU起動は従来どおり手動運用にできます。
- 受付済み音声はブラウザからRunPodへ直送され、Railwayを経由しません。
- モデルIDはサーバー側の許可リストからだけ選択でき、話者分離・Alignerなどの補助モデルはASR選択肢に含めません。
- Qwen3-Omniは約70GB以上のVRAMを使用するため、RunPodでは複数モデルを常駐させず、選択時に単一モデルを切り替えます。
- 30日削除は起動時と24時間ごとに実行します。
- `npm audit --omit=dev`は本番依存だけを確認します。Drizzle Kitの既知警告は開発用CLI依存で、本番イメージには残りません。
