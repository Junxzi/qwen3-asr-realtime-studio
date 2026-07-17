# InfoDeliver ASR Studio

RunPod上のInfoDeliver文字起こしモデルへ、ブラウザから音声を直接送る文字起こしStudioです。Railwayは認証、RunPod状態確認、モデルカタログ、確定文字列の履歴、計測値だけを扱います。音声本体、部分結果、ライブイベントは保存しません。

## 主な機能

- マイクまたは音声ファイルのリアルタイム送信
- InfoDeliverの5モデルを状態付きで表示し、GPU検証済みモデルだけを選択可能にするモデルカタログ
- Context Full-FT 1.7Bのリアルタイム処理（残る4モデルはadapter/GPU gate完了まで選択不可）
- 複数RunPod workerのcapacity予約、短期接続ticket、既知Pod起動、Templateからの動的作成と`WORKER_ID`による孤児Pod回収
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
| `POST` | `/api/transcriptions/:id/assignment` | モデルに合うGPU workerを冪等に割り当て |
| `GET` | `/api/transcriptions/:id/assignment` | 現在の割当状態を副作用なしで取得 |
| `POST` | `/api/transcriptions/:id/assignment/heartbeat` | 実行中streamのassignment leaseを認証・Origin検証付きで延長 |
| `GET` | `/api/workers` | GPU poolの診断情報を取得 |

## Railway variables

| Variable | Required | Description |
| --- | --- | --- |
| `RUNPOD_PROVIDER` | yes | `live`はstart/create/stop可、`readonly`は登録済みworkerへの割当だけ |
| `RUNPOD_API_KEY` | live | RunPod REST API bearer token。ブラウザには送らない |
| `RUNPOD_WORKERS_JSON` | yes | 静的worker配列。動的Poolのみは`[]`。空文字はlegacy Podへ後方互換 |
| `RUNPOD_MODEL_TEMPLATES_JSON` | dynamic | model/runtimeごとのTemplate IDとcapacity |
| `RUNPOD_NETWORK_VOLUME_ID` | Context dynamic | locked modelと必須カタログを持つ共有Network Volume。Context workerの自動作成時は必須 |
| `RUNPOD_POOL_MAX_WORKERS` | no | enabled worker上限。既定4 |
| `RUNPOD_GPU_TYPES` | no | RunPod APIへ渡すGPU候補。既定A100 80GB 2種 |
| `RUNPOD_POD_ID` / `RUNPOD_SERVICE_URL` | local legacy | development/testの後方互換用。本番は単一Podも`RUNPOD_WORKERS_JSON`の1要素として明示 |
| `RUNPOD_WORKER_ADMIN_SECRET` | live | Worker管理APIと共有する独立32文字以上のsecret |
| `WORKER_TICKET_SECRET` | production | ブラウザ直送用の短期ticketを署名する独立32文字以上のsecret |
| `WORKER_TICKET_TTL_SECONDS` | no | 既定120秒 |
| `WORKER_LEASE_SECONDS` | no | capacity回収lease。既定900秒、実行中は60秒heartbeatと確定発話で延長 |
| `WORKER_PROVISION_TIMEOUT_SECONDS` | no | Pod作成placeholderの期限。既定300秒 |
| `CONTROL_PASSWORD` | yes | UI共通パスワード |
| `SESSION_SECRET` | yes | 32文字以上のランダム値 |
| `SESSION_TTL_SECONDS` | no | 既定43200秒 |
| `ALLOWED_ORIGIN` | yes | Railway公開URL。末尾`/`なし |
| `DATABASE_URL` | Railway | `${{Postgres.DATABASE_URL}}`を参照 |
| `TRANSCRIPT_STORAGE` | Railway | `postgres` |
| `TRANSCRIPT_RETENTION_DAYS` | no | 既定30日 |
| `TRANSCRIPT_STALE_MINUTES` | no | 未完了セッションを中断扱いにする時間。既定10分 |

`RUNPOD_API_KEY`、`RUNPOD_WORKER_ADMIN_SECRET`、`WORKER_TICKET_SECRET`、`CONTROL_PASSWORD`、`SESSION_SECRET`をGitへコミットせず、Railway/RunPod Secretsへ登録してください。署名・cookie・Worker管理のsecretは相互に別の値を使います。

| Railway variable | RunPod Worker variable | Rule |
| --- | --- | --- |
| `WORKER_TICKET_SECRET` | `WORKER_TICKET_SECRET` | 全workerと完全に同じ値 |
| `RUNPOD_WORKER_ADMIN_SECRET` | `WORKER_ADMIN_SECRET` | 全workerと完全に同じ値 |

名前が異なる管理secretを取り違えないでください。どちらもブラウザやGitへは渡しません。

静的workerは次のschemaを1行JSONにしてRailwayの`RUNPOD_WORKERS_JSON`へ設定します。動的作成だけを使う場合は`[]`です。本番では未設定・空文字をfail-loudで拒否します。

```json
[{"id":"context-a","pod_id":"pod-id","name":"Context A100","service_url":"https://pod-id-8000.proxy.runpod.net","model_id":"infodeliverailab/qwen3-asr-ja-rlbr-context-fullft","runtime":"realtime","max_sessions":32,"enabled":true}]
```

単一のContext Templateだけなら`RUNPOD_TEMPLATE_ID`、複数model/runtimeなら`RUNPOD_MODEL_TEMPLATES_JSON`を使います。Context workerを動的作成する構成は、`/workspace/config/terms.json`を準備したNetwork Volumeなしでは起動を拒否します。

## Railway deployment

1. Railway ProjectにPostgreSQL serviceを追加する。
2. Web serviceへ`DATABASE_URL=${{Postgres.DATABASE_URL}}`と`TRANSCRIPT_STORAGE=postgres`を設定する。
3. `deploy/runpod/template.example.json`を検証済みWorker image digestとRunPod Secret参照でTemplate化する。
4. `RUNPOD_WORKERS_JSON`、必要なら`RUNPOD_MODEL_TEMPLATES_JSON`を含む上記variablesを設定してデプロイする。
5. `railway.json`のpre-deployでmigrationが完了してから新しいコンテナが公開される。
6. `/api/health`、`/api/workers`、履歴再読み込み、CPU fake配管を確認し、その後GPU smoke gateを行う。

ロールバック時も追加テーブルは残るため、旧版アプリへの復帰を妨げません。

## 運用上の注意

- `readonly`と静的worker登録を使えばGPU起動は従来どおり手動運用にできます。`live`とTemplate設定時だけ自動作成します。
- 受付済み音声はブラウザからRunPodへ直送され、Railwayを経由しません。
- モデルIDはサーバー側の許可リストからだけ選択でき、話者分離・Alignerなどの補助モデルはASR選択肢に含めません。
- Qwen3-Omniを含む未統合4モデルは表示だけ行い、専用adapterとGPU評価が完了するまで選択できません。1 Podは常に1 resident modelです。
- private InfoDeliverモデルのライセンス表示は`other`のため、本番移行前に社内利用条件と再配布可否を文書化してください。
- 30日削除は起動時と24時間ごとに実行します。
- `npm audit --omit=dev`は本番依存だけを確認します。Drizzle Kitの既知警告は開発用CLI依存で、本番イメージには残りません。
