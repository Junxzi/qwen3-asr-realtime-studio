# Testing and quality gates

## TypeScript

- unit: scheduler優先順位、capacity、同一session冪等、CAS競合、lease reaper。
- unit: ticket正常、期限切れ、改ざん、worker/session/model/purpose差し替え。
- unit: RunPod list/start/createのpath、template/env body、`WORKER_ID`完全一致、重複fail-loud、429/5xx、secret非露出。
- unit: create前adoption、in-flight placeholderの再照合、create応答喪失後のadoption、定期reconcile/reaperによるclient非依存の回収を検証する。
- contract: auth、Origin、入力検証、202 polling、ready接続情報、release、capacity_exceeded。
- integration: GitHub ActionsのPostgres 17へmigrationを適用し、実storeで32並列reserveして上限を超えない。
- existing: 履歴、認証、audio変換、batch整形を退行させない。

## Python worker

- CPU fake mode: `/health`、`/ready`、admin認証、drain、same-model load。
- realtime auth: 正常ticket、期限切れ、改ざん、別worker/session/model、未認証PCM。
- protocol: `model_id`とticketを含むWebの`session.start`がstrict validationを通る。
- diarization: offsetの連続性、再送の冪等性、発話ごとのAOSC/FIFO状態、固定長増分chunk、final flushとTTL cleanup。
- preflight: productionでsecret/model revision不足をfail-loudにする。

## Commands

```text
npm run lint
npm run typecheck
npm run test:unit
npm run test:contract
npm run build
DATABASE_URL=postgresql://... npm run test:postgres
cd services/runpod-worker
uv sync --frozen --extra dev
uv run --no-sync ruff check src tests scripts
uv run --no-sync pytest -q
uv run --no-sync python -m compileall -q src scripts
```

Worker workflowはASR/diarizer両方のlock再生成差分、shell、preflight、bootstrapを検査する。PRは軽量`smoke` targetをfake modeで起動し、production targetはdaemonへloadせずbuildする。main/tagはproduction targetをGHCRへpushしてimmutable digestを出力する。公開したproduction digestのRunPod上での`/ready`確認は下記GPU gateであり、CI済みとは扱わない。

GPUが必要なgateはRunPod上の別工程とし、未実施を成功扱いにしない。

- worker image起動、CUDA/BF16、vLLM import。
- Context Full-FT 1.7B loadとWSS final。
- Sortformer sidecarとForced Aligner。
- 2 Pod割当smoke、8/16/32並列latency gate。
