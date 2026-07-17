# 一通話・三方式 ASR PoC 概要

## 目的

InfoDeliver ASR Studio で、次の三つの処理方式を一通話単位で選択し、実際に進行した工程だけをフロー図上で可視化する。

1. `realtime`: Context Full-FT 1.7B と Streaming Sortformer によるライブ文字起こし。
2. `batch`: `infodeliverailab/lab_asr_diarization_v1` による話者付きファイル一括処理。
3. `hybrid`: Context Full-FT の部分表示を、480ms の無音検出後に `lab_asr_diarization_v1` の高精度結果で置換する。

## PoC の境界

- 同時処理は一通話に限定する。
- 音声、partial、フローイベントは Railway へ永続化しない。
- 最終発話と集計値だけを既存履歴へ保存する。
- RunPod Pod は自動停止しない。
- 進捗率や経過タイマーから工程を推測せず、assignment、worker、HTTP 保存の実イベントだけで表示を更新する。

## 完了条件

- 三方式を Studio で選べる。
- batch はファイル入力だけを許可する。
- hybrid は realtime worker と batch worker を同一 session に割り当てられる。
- フロー図が待機、実行中、完了、保存待ち、フォールバック、失敗を区別する。
- 遅い旧発話の final が次発話の partial を消さない。
- 同じ `utterance_id` の大きい revision が暫定結果を置換する。
- control plane、frontend、Python worker の自動テストと一通話 smoke を通す。
