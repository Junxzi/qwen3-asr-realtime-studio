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
- lab batch: `purpose=batch` ticket、別purpose拒否、exact-origin CORS、upload/audio/token上限、同時実行数1、話者tag正規化、model load一回、temporary file cleanupをCPU契約テストで確認する。
- lab bootstrap: lab `651c6d0f303557332293afa9fa15e1dd30456606`、base `b188e100bd85038c06d2812d24a39776eba774ca`、ECAPA `0f99f2d0ebe89ac095bcc5903c4dd8f72b367286`だけを`/workspace/lab-asr-poc`へ配置し、atomic manifest、`flock`、warm Volumeのno-redownload、不一致時のfail-loudを確認する。
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

Worker workflowはASR/diarizer両方のlock再生成差分、`entrypoint.sh`、`run_all.sh`、`run_lab_batch.sh`のshell syntax、preflight、realtime/bootstrapとlab bootstrapの契約を検査する。batch依存はproduction imageの共有`/opt/venvs/asr`へ固定し、private codeと重みをimageへ含めない。PRは軽量`smoke` targetをfake modeで起動し、production targetはdaemonへloadせずbuildする。main/tagはproduction targetをGHCRへpushしてimmutable digestを出力する。公開したproduction digestのRunPod上での`/ready`確認は下記GPU gateであり、CI済みとは扱わない。

GPUが必要なgateはRunPod上の別工程とし、未実施を成功扱いにしない。

- worker image起動、CUDA/BF16、vLLM import。
- Context Full-FT 1.7B loadとWSS final。
- Sortformer sidecarとForced Aligner。
- `lab_asr_diarization_v1`の3つの固定snapshot、共有`/opt/venvs/asr`、capacity 1、exact-origin CORSを使った`/ready`と実音声file推論。cold Volumeとwarm Volumeを各1回起動し、warm起動でsnapshotを再downloadしないことも確認する。
- 2 Pod割当smoke、8/16/32並列latency gate。

lab v1はadapterと自動テストが緑でも、実GPU上のmodel load、実音声応答、VRAM、RTFをimage digest・snapshot revision・fixture・応答JSONとともに記録するまでは`validated=false` / `実GPU検証待ち`とする。
