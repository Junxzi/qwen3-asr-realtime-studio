# Requirements

## Functional

- R-POOL-01: control planeは複数workerのPod ID、service URL、モデル、runtime、capacity、状態、heartbeatを管理する。
- R-POOL-02: 新規sessionの割当は、同じモデルがreadyで空きのあるworkerを最優先し、負荷が低い順で決定する。
- R-POOL-03: 同じsessionからの再要求は同じassignmentを返し、active countを増やさない。
- R-POOL-04: ready workerがなければ、既知の停止Podをstartし、設定時だけtemplateから新規Podをcreateする。
- R-POOL-05: start/create/model preloadは非同期状態として表し、未readyのHTTP応答は202にする。
- R-POOL-06: readonly運用では`RUNPOD_WORKERS_JSON`の複数workerをprobe・割当できるが、start/createは行わない。
- R-POOL-07: session完了・中断・失敗・削除・lease満了でassignmentを冪等に解放する。
- R-POOL-08: worker一覧は診断用に公開するが、API key、管理secret、ticket署名secretを含めない。
- R-POOL-09: WebSocketはassignment固有URLを使い、`session.start`に短期ticketを含める。
- R-POOL-10: batch uploadはassignment固有URLへBearer ticket付きで送る。

## Worker

- R-WORKER-01: imageはPython依存とASR/diarizerの分離venvを`/opt/venvs`へ格納し、`source activate`へ依存しない。
- R-WORKER-02: モデル重みはimageへ含めず、HFのfull commitまたはNetwork Volumeから取得する。
- R-WORKER-03: `/health`はprocess liveness、`/ready`は指定モデルの推論可能性を返す。
- R-WORKER-04: 1 Podは1モデルresidentとし、別モデルのload要求はactive=0でもrestart-requiredを正直に返してよい。
- R-WORKER-05: ticket検証に失敗した`session.start`を1008で閉じ、capacityを消費しない。

## Non-functional

- R-NFR-01: 32並列割当でもworkerの`max_sessions`を超えない。
- R-NFR-02: Railway再起動後もworkerとassignmentをPostgresから復元できる。
- R-NFR-03: ticket既定TTLは120秒、assignment lease既定は15分とし環境変数で変更可能にする。
- R-NFR-04: readiness probeが失敗したworkerは直ちに新規割当対象から外し、次周期以降の成功で復帰させる。
- R-NFR-05: service URL、model ID、Pod IDは最大長と許可形式を境界で検証する。
