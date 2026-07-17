# RunPod Worker Template

このディレクトリは、同じASR Workerを複数Podへ再現するためのTemplate入力例です。秘密値やmodel/audio dataは含みません。

## 推奨構成

1. `services/runpod-worker/Dockerfile`をGitHub Actions等でbuildし、GHCRへpushする。
2. 検証済みimageをdigestで固定する。
3. Secure CloudのNetwork Volumeを`/workspace`へmountする。volumeはdatacenter単位で用意する。
4. `template.example.json`は`POST /v1/templates`へ渡せるREST API bodyです。placeholderを置換し、TCPではなくport `8000/http`を公開する。
5. `HF_TOKEN`、`WORKER_TICKET_SECRET`、`WORKER_ADMIN_SECRET`はRunPod Secretsから`{{ RUNPOD_SECRET_<name> }}`形式で注入する。
6. Railway側はPod IDから`https://<POD_ID>-8000.proxy.runpod.net`を組み立て、`/ready?model_id=...`が200になってから割り当てる。

GHCR packageがprivateの場合は、先にRunPodへregistry credentialを登録し、`containerRegistryAuthId`を置換します。packageをpublicにする場合は同fieldを削除できます。Network VolumeのIDはTemplateではなくPod作成時の`networkVolumeId`で指定します。

Railwayの`RUNPOD_MODEL_TEMPLATES_JSON`には`model-templates.example.json`と同じ配列を1行JSONで設定します。Templateはmodel/runtimeごとに分け、adapter未実装のmodelを汎用Templateへ渡しません。動的作成時の`WORKER_ID`、`MODEL_ID`、`WORKER_RUNTIME`は制御プレーンが上書きし、秘密値はTemplate側のRunPod Secretsだけから注入します。

既存Podへ依存しない構成ではRailwayの`RUNPOD_WORKERS_JSON`を明示的に`[]`へ設定します。未設定または空文字は後方互換のlegacy Podを登録します。

`/health`はliveness、`/ready`は新規受付可否です。新規Volumeのmodel取得中もbootstrap health serviceがport 8000をlistenし、`/health`は200、`/ready`は503を返します。drain中にlivenessまで落とすとPodが再起動されるため、RunPod/Dockerのhealthcheckには`/health`を使います。

## Network Volumeの扱い

- `config/models.lock.json`のcommitへ固定したmodelだけを置きます。
- Context Full-FTの実Workerは`/workspace/config/terms.json`を必須とし、欠落・空語彙・予約revision `empty`ではreadyになりません。248語の元データはrepoへ含めず、承認済みの読みJSONから`/opt/app/scripts/build_catalog.py`でNetwork Volumeへ生成します。
- 初回prewarmでは1 Podだけを起動するのが最短です。同時起動してもWorker側の`flock`でdownloadを直列化します。
- 推論時はmodel directoryを読み取り用途として扱います。HF downloadはfile lockで直列化し、vLLM/Torch compile cacheはPod ID別ディレクトリへ分離します。
- Hugging Faceをsource of truthとし、datacenter間でvolumeが共有される前提にはしません。

## 起動と切り替え

Templateの起動commandは空欄で構いません。imageのENTRYPOINTが`/opt/app/scripts/entrypoint.sh`を実行します。明示する場合も同じ絶対パスを指定してください。

既存Podを`RUNPOD_WORKERS_JSON`へ静的登録する場合、workerの`id`はPod内の`WORKER_ID`と完全一致させます。`WORKER_ID`を省略した新WorkerはRunPodが注入する`RUNPOD_POD_ID`を使うため、registry側の`id`にも生のPod IDを設定します。

別modelへ変更するときは、Railwayから`POST /admin/drain`を送り、`active_sessions=0`を確認してPodを停止し、新しい`MODEL_ID`/imageで再作成します。実行中のhot switchは行いません。

## CPU配管テスト

GPUを付けずにTemplate配管だけを確認する場合は`cpu-fake.env.example`を使います。APIとWebSocket fake結果は確認できますが、Qwen3-ASR/Forced Aligner/Sortformerはloadされません。
