# Migration plan

| Task | Scope | Acceptance | Status |
| --- | --- | --- | --- |
| WP-101 | Podソース回収・secret scan | Python source/tests/lockだけがstagingにあり音声・model・secretがない | completed |
| WP-102 | Worker image | CPU fake tests、shell syntax、image構成が再現可能 | in progress |
| WP-201 | Registry/data model | migration、memory/Postgres store、atomic capacity tests | in progress |
| WP-202 | Scheduler/ticket/API | 202→ready、冪等、ticket tests、secret非露出 | in progress |
| WP-203 | Web assignment UX | global URLを使わずassignment URL/ticketだけで接続 | in progress |
| WP-301 | Static multi-Pod deploy | 2 workerを`RUNPOD_WORKERS_JSON`へ登録しpool診断でready | pending |
| WP-302 | Template/autoprovision | template IDからcreate、model env、Network Volumeを検証 | pending |
| WP-303 | GPU smoke/load gate | Context 1.7B final、2 Pod、8/16/32計測 | pending |
| WP-401 | lab_asr_jp_1 adapter | speaker tokenを発話へ変換しfile GPU smoke | pending |
| WP-402 | ECAPA v1/v2 adapter | custom codeを隔離workerでbatch API化 | pending |
| WP-403 | Qwen3-Omni adapter | A100 80GB batch workerでfile smoke | pending |

## Rollout

1. mock worker 2台でRailwayの配管を検証する。
2. 既存GPU Podをstatic workerとして1台登録し、Context 1.7Bをsmokeする。
3. 2台目を登録し、異なるsessionが別workerへ割り当てられることを確認する。
4. custom imageをdigest固定したRunPod Templateを作成する。
5. API keyが利用可能な環境だけauto-start/createを有効化する。

## Rollback

`RUNPOD_WORKERS_JSON`から行を外すだけでは、DBに残る`origin=dynamic` workerは無効化されない。次の順番で縮退する。

1. 新規assignmentを止め、`RUNPOD_PROVIDER=readonly`かつTemplate設定なしへ切り替える。
2. `/api/workers`で`active_sessions=0`と`provisioning_assignments=0`を確認する。処理中なら完了またはlease回収を待つ。
3. Web serviceをmaintenance停止し、RunPod console/APIで対象dynamic Podを停止する。
4. DB transaction内で`UPDATE inference_workers SET enabled=false, status='stopped' WHERE origin='dynamic' AND active_sessions=0;`を実行する。
5. 残す1 workerだけを`RUNPOD_WORKERS_JSON`へ登録して再デプロイし、`/api/workers`のcapacityを確認する。

既存assignmentと履歴はDBへ残し、migrationはdownしない。worker imageを前digestへ戻す場合は、モデルrevisionとimage digestを同時に記録する。
