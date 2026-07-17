# フロントエンド

## Processing mode picker

- 高速リアルタイム: microphone / file。
- 高精度ファイル: file のみ。
- ライブ＋高精度確定: microphone / file。

利用不能な profile は理由付きで disabled にする。モデル ID は詳細として控えめに表示し、方式名と混同させない。

## Pipeline flow

- Diagnostics drawer の先頭に置く。
- desktop は縦方向、Context ASR と Sortformer を小さな並列分岐で示す。
- mobile は同じ意味順で縦積みにする。
- DOM と CSS で描画し、図専用ライブラリは追加しない。

各 node は `待機 / キュー / 実行中 / 完了 / フォールバック / 失敗 / 状態未提供` を文言、アイコン、色で示す。active node のモーションは reduced-motion で停止する。

## Reducer 規則

- `seq` が現在値以下の event を無視する。
- node 状態を event なしに先へ進めない。
- 発話を `utterance_id` ごとに保持する。
- finalizer 完了だけで置換完了にせず、authoritative final 受信を待つ。
- PUT 成功だけで保存完了にする。outbox 格納時は保存待ちにする。
- 履歴画面では静的構成図と「実行イベントは保存されていません」を表示する。
