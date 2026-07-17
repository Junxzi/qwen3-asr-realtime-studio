# RunPod worker pool operations runbook

## lab batch workerのcold/warm起動

`lab_asr_diarization_v1`はContext realtimeと同じproduction imageを使い、Templateの
`WORKER_RUNTIME=batch`でbatch経路を選ぶ。batchの依存はimage内の共有
`/opt/venvs/asr`から実行し、private code、model weight、HF tokenをimage layerへ
含めない。TemplateとRailwayのmodel template mapは`max_sessions=1`に揃える。

起動前に次を確認する。

1. PodへNetwork Volumeを`/workspace`としてmountする。
2. `MODEL_ID=infodeliverailab/lab_asr_diarization_v1`、`WORKER_RUNTIME=batch`、
   `LAB_PYTHON=/opt/venvs/asr/bin/python`を設定する。
3. `HF_TOKEN`はprivate lab repoを読めるRunPod Secret、`WORKER_TICKET_SECRET`と
   `WORKER_ADMIN_SECRET`は制御プレーンと対応する独立secretから注入する。
4. `LAB_ALLOWED_ORIGINS`へStudioの公開originをscheme、host、portまで完全一致で
   設定する。複数はcomma区切りとし、wildcard `*`は使わない。
5. Templateは検証対象のproduction image digestへ固定し、tagやrepoの`main`を追従しない。

`run_all.sh`はbootstrap health serviceを起動した後、`bootstrap_lab_batch.py`で次の
snapshotだけを`/workspace/lab-asr-poc`へ配置する。

| Snapshot | revision |
| --- | --- |
| `infodeliverailab/lab_asr_diarization_v1` | `651c6d0f303557332293afa9fa15e1dd30456606` |
| `Qwen/Qwen3-ASR-1.7B` | `b188e100bd85038c06d2812d24a39776eba774ca` |
| `speechbrain/spkrec-ecapa-voxceleb` | `0f99f2d0ebe89ac095bcc5903c4dd8f72b367286` |

downloadは`.lab-batch-download.lock`の`flock`で直列化する。全配置の完了後に
`.lab-batch-models.json`をatomicに置換するため、途中終了したdownloadをwarm配置と
誤認しない。次回起動でmanifestが期待値と完全一致し、3 directoryが存在するときは
downloadを行わない。manifest欠落、revision変更、directory欠落時は固定snapshotを
再配置する。Volumeをprewarmするときは同時に複数Podを起動せず、まず1 Podのbootstrap
完了を待つ。

cold download中は`/health`が200、`/ready?model_id=infodeliverailab%2Flab_asr_diarization_v1`
が503であることを確認する。model load完了後は`/ready`が200、`worker_id`と`model_id`が
登録値に一致し、`max_sessions`が1であることを確認する。二回目のwarm起動ではbootstrap
出力の`downloaded=false`を確認し、HF downloadが再発していないことをログで確認する。

代表的な失敗確認順は次のとおり。

1. `HF_TOKEN is required`または401/403: RunPod Secretの参照名とorganization/repo read権限。
2. `snapshot placement is incomplete or revision-mismatched`: manifestと3 directoryの有無。手動でrevisionを書き換えず、固定bootstrapを再実行する。
3. import error: `LAB_PYTHON`が`/opt/venvs/asr/bin/python`で、image digestがbatch依存を含む版か。
4. CORS拒否: browserの`Origin`と`LAB_ALLOWED_ORIGINS`の完全一致。末尾slashを追加しない。
5. `/ready` 503: `load_failed`、`security_configured`、`worker_id`、GPU telemetryを`/healthz`で確認する。

adapter、自動bootstrap、CPUテストが成功していても実GPU検証の代わりにはならない。
固定image digest、上記3 revision、実音声fixture、応答JSON、VRAM、RTFを記録するまでは
Studioの`validated=false` / `実GPU検証待ち`を解除しない。

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
