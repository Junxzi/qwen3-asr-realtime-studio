# Qwen3-ASR リアルタイム PoC 引き継ぎ

更新日: 2026-07-15 (JST)

## 現在の状態

- RunPod Pod: `qwen3asr_fintuning-migration-migration`
- Pod ID: `nhf73n5jvajgyj`
- 状態: **停止済み**（RunPod 画面で `Not running` と `Start for ...` を確認）
- `/workspace` のモデル、コード、設定、評価結果は永続ボリュームに保存済み
- 稼働中だけ利用できる UI: `https://nhf73n5jvajgyj-8000.proxy.runpod.net/`

## 配置済みモデル

| 用途 | モデル | 固定 commit | RunPod パス |
|---|---|---|---|
| ASR / 最終品質 | `infodeliverailab/qwen3-asr-ja-rlbr-context-fullft` | `f03e7f67651f99e3b03e58a52567d744e32d3b92` | `/workspace/models/qwen3-asr-ja-rlbr-context-fullft` |
| 単語タイムスタンプ | `Qwen/Qwen3-ForcedAligner-0.6B` | `c7cbfc2048c462b0d63a45797104fc9db3ad62b7` | `/workspace/models/Qwen3-ForcedAligner-0.6B` |
| リアルタイム話者分離 | `nvidia/diar_streaming_sortformer_4spk-v2.1` | `fafaab5faa1617a0ca52d38dd3dc4bd636800d3d` | `/workspace/models/diar_streaming_sortformer_4spk-v2.1-verified` |

モデルファイルは SHA-256 と NeMo の実 restore で検証済み。最初の Xet 経由 Sortformer は破損を検出したため使用せず、通常ダウンロードで取得した `-verified` 側だけを本番設定に指定している。

## 配置済みサービス

- リリース: `/workspace/qwen-realtime-releases/qwen-realtime-20260715T132242Z`
- 実行設定: `/workspace/qwen-realtime/configs/service.env`
- モデル lock: `/workspace/qwen-realtime/outputs/models-lock.json`
- 変更前バックアップ: `/workspace/qwen-realtime-deployments/prechange-20260715T125555Z`
- WebSocket: `/v1/realtime`
- UI: `/`

UI にはローカル音声ファイル入力と同梱サンプル通話があり、どちらも同じ `File -> decodeAudioData -> 16 kHz mono PCM -> 20 ms以上のフレームを実時間ペース送信` 経路を使う。

## 検証結果

- 自動テスト: `25 passed`
- `/health`: production、real inference、Context Full-FT、Forced Aligner、Sortformer、capacity 32 を確認
- warm WebSocket smoke: エラー 0、partial 3件、final 1件
- warm partial latency: `77 / 92 / 93 ms`
- final latency: `165 ms`
- queue: `0 ms`
- RTF: `0.047`
- 認識結果: `お世話になります。あかつき証券でございます。`
- ブラウザ UI: サンプル音声から partial、final、単語タイムスタンプ、`speaker_0` の表示まで確認
- ブラウザ Console error/warning: 0件

ローカル確認用音声: `demo-securities-call.wav`

## 再開方法

1. RunPod で Pod ID `nhf73n5jvajgyj` を Start する。
2. Web Terminal で次を実行する。

```bash
nohup env \
  PYTHONPATH=/workspace/qwen-realtime-releases/qwen-realtime-20260715T132242Z/src \
  LOG_DIR=/workspace/qwen-realtime/outputs \
  bash /workspace/qwen-realtime-releases/qwen-realtime-20260715T132242Z/scripts/run_all.sh \
  > /workspace/qwen-realtime/outputs/service-supervisor.log 2>&1 &
```

3. 次で readiness を確認する。

```bash
curl -fsS http://127.0.0.1:8000/health
```

4. UI を開き、音声ファイルを選択して `音声ファイルを開始`、または `サンプル通話` を実行する。
5. 作業後は Pod を Stop する。Terminate はしない。

## 未実施・注意点

- 8/16/32同時通話の正式な負荷ゲートは未実施。
- 最初の cold request はコンパイル等により final まで約 7.46 秒だった。warm-up 後は上記の値。
- Chrome 拡張によるネイティブファイル選択ダイアログの自動操作はハングしたため、実ファイル選択クリックだけは自動 E2E 未完。ファイル入力実装の存在と、同じファイル処理経路を使う同梱サンプルの E2E は確認済み。
- Pod 停止中も永続ボリューム料金は RunPod 表示で約 `$0.022/hr`。
