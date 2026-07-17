# RunPod worker pool operations runbook

## Provisioning deadline

- `WORKER_PROVISION_TIMEOUT_SECONDS`（既定300秒）を超えてもPod IDが確定しないdynamic worker placeholderは、reaperが`enabled=false`、`status=terminated`へ移す。
- 期限切れとRunPodのcreate応答が競合した場合、control planeはworker登録を条件付きで確定する。placeholderがすでに期限切れなら、返されたPodを直ちに停止する。
- placeholderを無効化するとpool capacityは解放され、同じassignmentの次回処理で再取得できる。

## 課金孤児Podの自動復旧と確認

dynamic workerは`provision-<assignment UUID>`を永続的な`WORKER_ID`として持つ。RunPod Podにも同じ値を環境変数で渡し、Pod名を`qwen-<WORKER_ID>`へ固定する。Pod名は診断用であり、自動照合はRunPod `GET /pods`が返す環境変数の`WORKER_ID`完全一致だけを信頼する。

control planeはcreate前、既存のin-flight placeholderを処理するとき、create応答が失われたときにPod一覧を検索する。定期reconcileとprovisioning reaperも、Pod IDのないdynamic placeholderを一覧検索してから状態を進める。完全一致する非TERMINATED Podが1つならDBへadoptし、新しいPodは作らない。assignmentが存在しない孤児Podはadopt後に通常のidle worker処理で停止する。このため、RunPodがPodを作成した直後にcontrol planeのプロセスまたはホストが失われ、ブラウザから再要求がなくても自動復旧または停止できる。

同じ`WORKER_ID`を持つ非TERMINATED Podが複数ある場合は、どれかを暗黙に採用・停止せず`runpod_duplicate_worker_pods`でfail loudする。RunPod一覧API自体が到達不能な場合もcreateを続けない。運用者はデプロイ障害やprovisioning timeout後に次を確認する。

1. `runpod_worker_adopted`ログがあれば、`workerId`と`podId`が`GET /api/workers`へ反映されたことを確認する。
2. `runpod_duplicate_worker_pods`があれば、RunPod Console/APIで該当`WORKER_ID`のPodを一覧化し、処理中でない重複Podを明示的に停止する。
3. `provisioning_billing_guard_failed`ログがあれば、ログ中の`podId`を最優先で確認する。
4. RunPod API障害が長引いた場合は、`qwen-provision-`から始まるPodと`GET /api/workers`の`pod_id`を照合し、DBに存在せず処理中でもないPodを停止する。

RunPod create APIはidempotency keyを提供しないため、`WORKER_ID`を変更・再利用した手動createは行わない。

## Pod ID重複のmigration gate

`0002_unique_worker_pod.sql`は、空文字を除く`inference_workers.pod_id`へunique indexを追加する。既存DBに重複がある場合はmigrationを失敗させ、どちらかを暗黙に削除しない。デプロイ前に次のSQLで重複を確認し、RunPodの実体とassignmentを照合して不要なworker recordを明示的に整理する。

```sql
SELECT pod_id, array_agg(id ORDER BY id) AS worker_ids
FROM inference_workers
WHERE pod_id <> ''
GROUP BY pod_id
HAVING count(*) > 1;
```
