# Data model

## inference_workers

| Column | Purpose |
| --- | --- |
| id | control plane内の安定ID |
| pod_id | RunPod Pod ID。空のprovisioning placeholderを除きunique |
| name / service_url | provisionと接続に必要な信頼済み設定 |
| model_id | `/ready`で照合するresident model |
| runtime | realtimeまたはbatch |
| origin | staticまたはdynamic |
| status | stopped/starting/loading/ready/draining/unhealthy/terminated |
| max_sessions / active_sessions | capacity |
| enabled | 新規割当可否。draining時はfalse |
| gpu / health | RunPodとWorkerから取得した診断JSON |
| last_heartbeat_at | 最終probe時刻 |
| created_at / updated_at | 監査時刻 |

## transcription_assignment_records / transcription_assignment_purposes view

| Column | Purpose |
| --- | --- |
| id | assignment ID |
| session_id | transcription session、purposeとの複合unique、cascade delete |
| worker_id | reserve前はnull、reserve後はworker FK |
| model_id / purpose | ticketと割当条件 |
| status | requested/provisioning/ready/active/released/failed |
| lease_expires_at | worker喪失時の回収期限 |
| message | 正直な待機・失敗理由 |
| created_at / updated_at / activated_at / released_at | 状態時刻 |

短期ticketとその期限はレスポンス生成時だけ作り、DBへ保存しない。

## Atomic reserve invariant

Postgres transaction内で次を同時に満たすworkerだけを更新する。

```text
enabled = true
status = ready
model_id = requested model
runtime = requested purpose
active_sessions < max_sessions
```

候補rowを`FOR UPDATE SKIP LOCKED`で確保し、同じtransaction内で`active_sessions + 1`とassignmentのworker/status更新を確定する。同じ`(session_id, purpose)`のunique制約で再要求を冪等化する。worker loss時はそのworkerのready/active assignmentをrow lockし、requestedへの戻しと`active_sessions`減算を同じtransactionで行う。停止開始、lease回収、Pod作成claimもDB上の条件付き更新で競合を直列化する。

一度に複数workerの`active_sessions`を減算するrelease/reaperは、assignment UUID順をworker更新順として使わない。対象`worker_id`をdistinct化し、DB上の`worker_id ASC`で全worker rowを`FOR UPDATE`してから、worker単位に集計したカウンターを同じ順序で更新する。

## Migration

- M1 expand: 2テーブルとindexを追加。既存履歴テーブル・APIは変更しない。
- M2 application: configured workersを起動時upsertし、assignment APIを有効化。
- M3 expand: purpose実体tableと新コード用viewを追加する。旧`transcription_assignments`の`UNIQUE(session_id)`を保持し、旧AFTER triggerとviewのINSTEAD OF triggerをどちらもlegacy→records順にする。旧`ON CONFLICT(session_id)`は壊さない。
- M4 application: purpose-aware codeを展開する。
- M5 optional contract: rollback window終了後の別PRで互換triggerと旧table、単一`RUNPOD_POD_ID/SERVICE_URL`設定を削除する。
