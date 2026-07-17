# 要件

## 機能要件

- R-01: session は `processing_mode` を持ち、未指定時は `realtime` とする。
- R-02: hybrid session は `realtime` と `batch` の二つの assignment を持てる。
- R-03: assignment は `(session_id, purpose)` で冪等にする。
- R-04: realtime 接続情報は `websocket_url`、batch 接続情報は `batch_url` と短期 ticket を返す。
- R-05: batch adapter はモデルを起動時に一度だけロードし、一並列で推論する。
- R-06: batch adapter は `<|spk_N|>` と `[spk_N]` を正規化し、special token を UI へ返さない。
- R-07: worker は PII を含まない `pipeline.stage` を送る。
- R-08: UI は受信した実イベントと保存 Promise の結果だけで工程状態を更新する。
- R-09: finalizer 失敗時は Context 結果を保持し、フォールバックであることを明示する。
- R-10: 音声本体を保存しない。

## 非機能要件

- NFR-01: ticket は worker、session、model、purpose、有効期限へ束縛する。
- NFR-02: browser から任意の finalizer URL を worker へ渡さない。
- NFR-03: batch upload のサイズ、長さ、token 数を上限で拒否する。
- NFR-04: telemetry は欠落しても文字起こしを妨げず、final は欠落させない。
- NFR-05: 色だけに依存せず、工程状態を文言とアイコンでも示す。
- NFR-06: 390px 幅で横スクロールなしに主要操作とフローを確認できる。

## 対象外

- 8〜32 通話の負荷最適化。
- 長時間 batch の非同期 job API。
- Pod の自動停止、料金制御、音声再生、エクスポート。
- lab モデル内部の層単位ストリーミング可視化。
