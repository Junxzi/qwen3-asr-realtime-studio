# Pre-implementation baseline audit (2026-07-17)

この表はPod内からソースを回収する前の証跡であり、現在のbranchの実装状態ではない。O-01/B-01/W-01/W-02/W-03/S-01/O-02は本設計で解消済み。Q-01だけは安全のため未統合4モデルを選択不可のまま表示し、各adapterとGPU smokeを`60_MIGRATION_PLAN.md`のWP-401〜403で追跡する。

| ID | Area | Observed fact | Impact | Severity |
| --- | --- | --- | --- | --- |
| O-01 | orchestration | `RUNPOD_POD_ID`と`RUNPOD_SERVICE_URL`が単一値 | Pod障害時にWeb全体が利用不能 | high |
| B-01 | backend | `PodProvider`と`createApp`内operationが1 Pod前提 | 同時割当、capacity、leaseを表現できない | high |
| W-01 | worker | Python推論サービスがGitHubに存在せずPod内だけにある | Pod作り直しで再現不能 | critical |
| W-02 | protocol | Webは`model_id`を送るがworkerのstrict `SessionStart`は受け付けない | realtime接続が`invalid_session_start`になる | critical |
| W-03 | runtime | `run_all.sh`が非永続`/opt/qwen-realtime/venvs/qwen-diarizer`をsourceする | Pod再起動後に起動失敗 | critical |
| S-01 | security | worker WSSと管理面にsession単位認証がない | Pod URLを知る第三者がcapacityを消費可能 | high |
| Q-01 | model | Context Full-FT 1.7B以外は同じworker契約でGPU smokeされていない | モデル一覧と実利用可能性が一致しない | high |
| O-02 | readiness | `/health`の任意2xxをモデルreadyとして扱う | 起動済みだが未ロードのworkerへ接続し得る | high |

## Evidence

- 固定Pod設定: `server/config.ts`、`server/runpod.ts`、`server/app.ts`。
- ブラウザ直結: `src/useRealtime.ts`。
- worker回収元: `/workspace/qwen-realtime-releases/qwen-realtime-20260715T132242Z`。
- 起動障害: `run_all.sh` line 19の`/opt/qwen-realtime/venvs/qwen-diarizer/bin/activate`。
- protocol不一致: `src/audio.ts`の`model_id`と回収worker `protocol.py`の`extra="forbid"`。
