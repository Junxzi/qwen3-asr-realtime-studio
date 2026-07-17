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

## transcription_assignments

| Column | Purpose |
| --- | --- |
| id | assignment ID |
| session_id | transcription session、unique、cascade delete |
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

候補rowを`FOR UPDATE SKIP LOCKED`で確保し、同じtransaction内で`active_sessions + 1`とassignmentのworker/status更新を確定する。同じ`session_id`のunique制約で再要求を冪等化する。停止開始、lease回収、Pod作成claimもDB上の条件付き更新で競合を直列化する。

## Migration

- M1 expand: 2テーブルとindexを追加。既存履歴テーブル・APIは変更しない。
- M2 application: configured workersを起動時upsertし、assignment APIを有効化。
- M3 optional contract: 単一`RUNPOD_POD_ID/SERVICE_URL`設定を、全環境の移行後に別PRで削除する。
