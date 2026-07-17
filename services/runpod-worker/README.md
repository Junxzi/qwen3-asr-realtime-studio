# Qwen3-ASR RunPod Worker

Railway上の制御プレーンから複数RunPodへセッションを割り当てるための、単一モデル常駐型GPU Workerです。復旧したQwen3-ASR推論コアをコンテナへ移し、Pod固有のvenvや`/root`に依存しない構成にしています。

## 不変条件

- 1 Podにつき常駐モデルは1つです。`MODEL_ID`と異なるモデルへのhot switchは行わず、`409 restart_required`を返します。
- ASRとSortformerの依存衝突を避けるため、イメージ内に`/opt/venvs/asr`と`/opt/venvs/diarizer`を別々に構築します。起動時に`activate`は使わず、絶対パスの`uvicorn`を実行します。
- Sortformerは発話ごとにNeMo公式のAOSC/FIFO状態を保持し、6 diarization frame（約480ms）単位で新着PCMだけをmicro-batchします。発話先頭からの再推論は行いません。
- モデルは`config/models.lock.json`のHF commitへ固定し、`/workspace/models`へ展開します。各directoryのrevision manifestも起動前に検証します。イメージにはモデル本体、音声、実カタログ、ログ、秘密を含めません。
- 受付済みセッションはdrain後も処理を継続します。新規セッションだけを拒否します。

## Worker API

| Method | Path | 認証 | 意味 |
| --- | --- | --- | --- |
| GET | `/health` | 不要 | プロセスliveness。drain中も200 |
| GET | `/ready?model_id=...` | 不要 | 指定モデルを新規受付できるときだけ200 |
| GET | `/healthz` | 不要 | 既存の詳細診断とWorker状態 |
| GET | `/admin/models` | Admin Bearer | resident modelとlocked model一覧 |
| POST | `/admin/models/load` | Admin Bearer | 同一モデルなら冪等200、別モデルなら409 |
| POST | `/admin/drain` | Admin Bearer | `{"draining":true}`で新規受付停止 |
| WS | `/v1/realtime` | connection ticket | 16 kHz mono PCM S16LE |

Admin APIは`Authorization: Bearer <WORKER_ADMIN_SECRET>`を要求します。比較にはtiming-safeな`hmac.compare_digest`を使います。

WebSocketの最初のframeは必ず次のJSONです。認証前のbinary PCMは処理されません。

```json
{
  "type": "session.start",
  "session_id": "01J...",
  "model_id": "infodeliverailab/qwen3-asr-ja-rlbr-context-fullft",
  "connection_ticket": "<payload>.<signature>",
  "sample_rate": 16000,
  "encoding": "pcm_s16le",
  "catalog_revision": "2026-07-15-v1"
}
```

### connection ticket

制御プレーンとWorkerだけが共有する`WORKER_TICKET_SECRET`で、短命なticketを作ります。

1. payloadはUTF-8 JSONで、`v: 1`、`wid`、`sid`、`mid`、`purpose: "realtime"`、Unix秒の`exp`、`aud: "qwen-realtime-worker"`を含めます。
2. JSON bytesをpaddingなしbase64urlにして`payload_segment`とします。
3. `HMAC-SHA256(secret, payload_segment)`をpaddingなしbase64urlにします。
4. `<payload_segment>.<signature_segment>`を送ります。

Workerは署名、期限、audience、purpose、worker/session/modelの全bindingを検証します。ticketの生成ロジックは`qwen_realtime.security.create_worker_ticket`にもあり、Python契約テストの基準実装として使えます。

## GPUイメージ

リポジトリrootから、Workerディレクトリをbuild contextにして実行します。

```bash
docker build \
  -f services/runpod-worker/Dockerfile \
  -t ghcr.io/<owner>/qwen3-asr-runpod-worker:<git-sha> \
  services/runpod-worker
```

push後はtagではなくregistry digestをRunPod Templateへ設定します。初回だけlocked modelをNetwork Volumeへprewarmすると、以後のPodはイメージ起動とモデルloadだけでreadyになります。モデルdownloadは共有volume上のfile lockで直列化し、vLLM/Torch compile cacheはPod ID別に分離します。新規Volumeのdownload中もport 8000のbootstrap livenessは応答し、`/ready`だけを503に保ちます。

GitHub Actionsでは標準runnerの限られた空き容量に合わせ、Pythonゲート後に未使用の公式runner SDK/toolcacheだけを明示削除します。PRは軽量な`smoke` targetをloadしてentrypoint/healthを実行した後、`production` targetを`cacheonly`でbuildし、巨大なCUDA imageをDocker daemonへ二重保存しません。main/tagでは同じ`production` targetを直接GHCRへpushし、digestだけを成果物にします。実運用のRunPod Templateには必ず`production` targetのdigestを指定し、`smoke` targetは使用しません。

Context Full-FTは`/workspace/config/terms.json`も必須です。承認済みの「表記→読み候補」JSONから`python /opt/app/scripts/build_catalog.py <readings.json> /workspace/config/terms.json`で生成します。欠落、空語彙、不正JSON、予約revision `empty`ではpreflightと`/ready`がfail-closedになり、実セッションを受け付けません。fake backendだけは配管試験のため自動的にこの要件を免除します。

必要な秘密はRunPod Secretsで注入します。

- `HF_TOKEN`: private modelのread token
- `WORKER_TICKET_SECRET`: Railwayとの共有HMAC secret、32 bytes以上
- `WORKER_ADMIN_SECRET`: Admin API secret、32 bytes以上

Railway側では同じ値をそれぞれ`WORKER_TICKET_SECRET`、`RUNPOD_WORKER_ADMIN_SECRET`として設定します。後者だけ変数名が異なるため注意してください。

その他の変数は`config/service.env.example`と`deploy/runpod/README.md`を参照してください。

## CPU fake mode

CUDAなしでもAPI、認証、ticket、drain、WebSocket状態遷移を検証できます。実音声認識は行いません。

```bash
uv sync --extra dev
export ASR_BACKEND=fake
export DIARIZER_BACKEND=energy
export BOOTSTRAP_MODELS=false
export MODEL_ID=infodeliverailab/qwen3-asr-ja-rlbr-context-fullft
export WORKER_ID=cpu-fake-1
export WORKER_ADMIN_SECRET=local-admin-secret-at-least-32-bytes
export REQUIRE_WORKER_TICKET=false
export MODELS_LOCK_PATH="$PWD/config/models.lock.json"
uv run uvicorn qwen_realtime.app:app --host 127.0.0.1 --port 8000
```

別terminalで次を実行します。

```bash
uv run python scripts/smoke_client.py --catalog-revision empty
```

## 品質ゲート

```bash
uv sync --extra dev
uv run ruff check src tests scripts
uv run pytest
uv run python -m compileall -q src scripts
```

GPUでのみ確認できる項目は、CUDA/BF16、vLLM model load、Sortformer AOSC/FIFOの実state更新、実音声WebSocket smoke、VRAM/latencyです。`scripts/preflight.py`はpackage lock、モデル配置、GPU、認証設定を起動前にfail-loudで検証します。

## 現時点の未検証リスク

このPCにはDockerとNVIDIA GPUがないため、GPU imageの実buildは未検証です。依存解決とhash lockの生成は成功していますが、`nvidia/cuda:12.8.1-cudnn-devel-ubuntu24.04`上のPython 3.12で、`vllm==0.14.0`/`qwen-asr==0.0.6`のLinux wheel、`nemo_toolkit==2.7.3`のnative依存、private modelのload、CUDA Graph、BF16を実行する確認が残っています。CUDA base image、apt package、GitHub Actionsのmajor tagも最初の成功build後にdigest/commit SHAへ固定する必要があります。最初のA100起動時にimage build、`preflight.py`、`/ready`、実音声smokeの順で検証し、合格したimageとCUDA baseをdigest固定してください。root実行とdevel baseの縮小はGPU smoke後のhardening項目です。
