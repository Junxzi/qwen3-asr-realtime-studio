# RunPod worker pool overview

## Goals

- G-01: 利用者は同じWeb UIからモデルを選び、複数のRunPod Podのいずれかへセッション単位で安全に割り当てられる。
- G-02: 既知Podを手動起動するreadonly運用と、RunPod APIでstart/createする自動運用を同じ契約で扱う。
- G-03: 新しいPodは固定digestのworker imageと固定モデルrevisionから再現でき、特定Podのcontainer diskに依存しない。
- G-04: RunPod API key、worker管理secret、HF tokenをブラウザへ送らない。
- G-05: 割当、Pod起動、モデルロードの実状態を表示し、時間駆動の偽進捗を使わない。

## Guardrails

- 1 Podには1つのASRモデルだけを常駐させる。active session中はモデルを切り替えない。
- ライブ音声の途中で別Podへ黙ってfailoverしない。worker喪失時は中断として確定する。
- 音声本体、partial、worker ticketはRailwayへ永続化しない。
- ブラウザへ返す接続先はサーバー登録済みworkerから生成し、利用者入力のURLを信用しない。
- ticketはworker、session、model、purpose、期限へ束縛する。

## Non-goals

- 1セッションを複数GPUへ分散すること。
- active sessionを保持したままモデルをhot swapすること。
- 未検証のモデルを「利用可能」と表示すること。
- RunPodを本番基盤とみなすこと。本番は同じworker imageを証券会社管理VPCへ移す。

## Definition of done

- `npm run check`が成功し、worker poolのunit/contract testsが緑になる。
- Python workerのCPU fake-mode testsが緑になる。
- 2つのmock workerを使い、同一モデル優先、capacity制約、冪等割当、ticket改ざん拒否を自動試験できる。
- Railwayは`POST/GET /api/transcriptions/:id/assignment`で202からreadyへ遷移し、readyになるまで接続情報を返さない。
- workerは`/health`と`/ready`を分離し、認証済み`session.start`より前のPCMを受理しない。
- GPU smokeでは、別々の2セッションが登録済み2 Podへ割り当てられ、少なくともContext Full-FT 1.7Bでfinalが返る。

## Terms

- control plane: Railway上のExpress API、Postgres、React UI。
- worker: 1つのモデルを常駐させるRunPod Pod上のPythonサービス。
- assignment: transcription sessionとworkerの期限付き対応関係。
- configured worker: `RUNPOD_WORKERS_JSON`またはDBへ登録済みの既知worker。
- provisioner: 停止Podのstartまたはtemplateからのcreateを行う処理。
