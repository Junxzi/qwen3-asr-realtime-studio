# Migration と rollback

## 展開

1. expand migration を適用する。旧 `transcription_assignments` と `UNIQUE(session_id)` は残し、実体の `transcription_assignment_records` と新コード用view `transcription_assignment_purposes` を追加する。legacy tableをlockした状態でAFTER trigger設置とbackfillを完了し、新コードのINSTEAD OF triggerもlegacy→records順で書く。
2. multi-assignment 対応 control plane を展開する。
3. batch adapter を A40 Pod で起動し health/ready/synthetic smoke を確認する。
4. processing profile の batch を有効化する。
5. hybrid を一通話だけ有効化する。

## Feature gate

- lab adapter の実モデル smoke が完了するまでは `validated=false` / `gpu_validation_required` と表示する。PoC の明示的な試行は妨げないため selectable は維持する。
- worker または template がない mode は `setup_required`、worker がなく template だけある mode は `provisionable` と表示し、ready と誤認させない。

## Rollback

- UI gate を閉じ、realtime だけを選択可能に戻す。
- 新しい列と purpose records/view、互換 trigger、旧 table を残し、破壊的 migration は行わない。旧 binary は引き続き `ON CONFLICT(session_id)` を実行できる。
- hybrid session が存在する状態で旧 scheduler へ戻さない。先に active hybrid を完了または中断し、二 assignment を解放する。
- Pod の停止は利用者の明示操作に限定する。

## Contract migration

旧 binary へ戻さないことが確認でき、rollback window が閉じた後にだけ、別 release でview trigger、legacy trigger、旧 `transcription_assignments` を削除する。expand と contract を同じ deploy で実行しない。
