# Architecture

## Request flow

```text
Browser
  | POST transcription
  | POST assignment
  v
Railway control plane ---- PostgreSQL(worker/assignment/lease)
  |        |
  |        +---- RunPod REST(start/create; live mode only)
  |        +---- Worker admin /ready
  v
assignment ready {trusted WSS URL, short-lived ticket}
  |
  +================ Browser sends PCM directly ================> RunPod worker
                                                                 | ASR + VAD
                                                                 | diarizer sidecar
                                                                 | aligner
Railway <--------------------- final text/metrics via Browser ----+
```

## Components

- `WorkerRegistry`: worker heartbeat/capacityとassignment leaseを永続化し、reserveを原子的に行う。
- `WorkerScheduler`: ready同モデル→既知停止Pod→template createの順で状態を進める。
- `RunPodFleetClient`: Pod list/get/start/stop/createだけを扱う。listは環境変数`WORKER_ID`完全一致による孤児Podの再照合に使い、Bearer keyを応答へ含めない。
- `WorkerAdminClient`: `/health`、`/ready`、`/admin/*`を管理secret付きで呼ぶ。
- `WorkerTicketIssuer`: HMAC-SHA256 ticketを発行する。
- `ModelTemplateRegistry`: model/runtimeごとに検証済みRunPod Templateを対応付け、汎用Templateへの誤投入を防ぐ。
- `Reconciler`: provisioning assignmentとstale leaseを定期処理する。
- `Sortformer sidecar`: utterance IDごとにNeMoの`StreamingSortformerState`（AOSC/FIFO）を保持し、offset付きの増分PCMを32 streamまでmicro-batchする。final後は明示削除し、切断時の残存stateはTTL reaperが回収する。

## State machines

```text
assignment: requested -> provisioning -> ready -> active -> released
                                \-> failed

worker: stopped -> starting -> loading -> ready -> draining -> stopped
         starting/ready -> unhealthy
         starting/stopped -> terminated
```

## ADR-01: Browserからworkerへ直送

採用。RailwayでPCMを中継すると帯域、遅延、データ取扱範囲が増えるため。control planeは短期ticketだけを発行する。

## ADR-02: Single resident model per Pod

採用。vLLM/CUDA graphのVRAM断片化とactive session中のモデル破棄を避ける。モデル変更は新Podまたはdrain後の再起動で行う。

## ADR-03: Static pool first, autoscaling optional

採用。RunPod API keyを作れない環境でも複数Podを利用できる。`RUNPOD_WORKERS_JSON`の既知workerを最初のpoolとし、live modeでだけstart/createを許可する。

## ADR-04: No mid-stream failover

採用。VAD、stable/unstable、speaker cacheがworker内状態であり、別workerへ移すと文字列整合性を保証できないため。

## ADR-05: WORKER_IDによるcreate reconciliation

採用。dynamic worker IDはassignment IDから決定し、RunPodへ`WORKER_ID`環境変数として渡す。control planeはcreate前、曖昧なcreate失敗後、定期reconcile、provisioning reaperで`GET /pods`の完全一致を検索し、1つだけなら同じworker recordへadoptする。assignmentのないadopt済みworkerはidle worker処理で停止する。複数一致は課金・処理状態を推測せずfail loudする。
