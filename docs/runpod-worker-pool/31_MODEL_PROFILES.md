# InfoDeliver model profiles

2026-07-17に、ログイン済みHugging Face organization画面で確認した5 modelを分類する。モデル一覧へ出すことと、workerで実際に推論可能であることを分けて管理する。

| Model | Intended runtime | Worker class | Current integration status |
| --- | --- | --- | --- |
| `infodeliverailab/qwen3-asr-ja-rlbr-context-fullft` | realtime + file | `qwen_asr_realtime` | worker実装あり。GPU smoke待ち |
| `infodeliverailab/lab_asr_jp_1` | telephone file、realtime候補 | `qwen_asr_speaker_tokens` | `qwen-asr` full checkpoint。speaker token parserとGPU評価が必要 |
| `infodeliverailab/lab_asr_diarization_v1` | offline file | `ecapa_interleave_batch` | batch adapterと固定bootstrap実装済み。実GPU検証待ち |
| `infodeliverailab/lab_asr_diarization_v2` | offline file | `ecapa_interleave_batch` | v1のYT増強版。custom adapterが必要 |
| `infodeliverailab/qwen3-omni-jp-vllm` | offline file | `qwen_omni_batch` | public vLLM recipe。専用batch adapterとA100 80GB classが必要 |

## Deployment rule

- productionで検証済みとして扱うのは`integration_status=ready`かつ、同じmodel IDを`/ready`と実音声で実測したworkerがあるmodelだけとする。
- `lab_asr_diarization_v1`は明示的なPoC試行のため選択可能にするが、実GPU smokeが完了するまで`integration_status=gpu_validation_required`、`validated=false`、表示は`実GPU検証待ち`を維持する。
- 残る3モデルは一覧へ表示しつつ、adapterとGPU gateが完了するまで選択不可にする。
- `adapter_required`を単にモデル選択へ出して、終わらないprovisioning状態にしない。
- repoの`main`を起動時に追従しない。モデルprofileごとにfull commit SHAをlockし、更新は評価JSONと同じPRで行う。
- integrated speaker-tokenモデルでは、テキスト中の`<|spk_N|>`をUIへそのまま漏らさず、発話境界へ変換するadapterを通す。

## Observed model characteristics

### Context Full-FT

- 既存realtime workerが対象とする1.7B Contextモデル。
- lock済みrevision: `f03e7f67651f99e3b03e58a52567d744e32d3b92`。
- partial/final、外部Sortformer、Forced Alignerの構成で使用する。

### lab_asr_jp_1

- Qwen3-ASR系のfull checkpointで、`qwen-asr`の`Qwen3ASRModel.from_pretrained`利用例がある。
- 日本語2話者電話向けで、出力は`<|spk_0|>...<|spk_1|>...`。
- projectorと新規speaker token embeddingを学習し、LLM/audio encoderを凍結したモデル。
- realtime windowとvLLM backendでの互換性はモデルカードだけでは保証されないためGPU gateを必須にする。

### lab_asr_diarization_v1/v2

- Qwen3-ASR 1.7BにECAPA-TDNN speaker embeddingをtemporal interleaveするcustom構成。
- repoはbase modelそのものではなく、custom codeと約4.72GBのweightsを含む。
- v1 worker固定commit: `651c6d0f303557332293afa9fa15e1dd30456606`。
- v2 code最新確認commit: `b7691fb0cc4ccab0df95df8f7e08e1852d1f1e38`。
- `max_new_tokens=800`級の長尺offline推論を前提とし、現在の1秒chunk workerへ直接差し替えない。
- v1 batch workerは同時実行数1で、worker、Template、`RUNPOD_MODEL_TEMPLATES_JSON`の`max_sessions`をすべて1に揃える。
- production imageはbatch依存を共有`/opt/venvs/asr`へ固定し、private codeや重みを含めない。起動時bootstrapがNetwork Volumeの`/workspace/lab-asr-poc`へ次のsnapshotを配置する。
  - lab v1: `651c6d0f303557332293afa9fa15e1dd30456606`
  - Qwen3-ASR 1.7B base: `b188e100bd85038c06d2812d24a39776eba774ca`
  - SpeechBrain ECAPA: `0f99f2d0ebe89ac095bcc5903c4dd8f72b367286`
- bootstrap完了時に`.lab-batch-models.json`をatomicに書き、warm Volumeでmanifestと配置directoryが一致すれば再downloadしない。初回配置にはprivate repoを読める`HF_TOKEN`が必要。
- browser uploadを許可するoriginは`LAB_ALLOWED_ORIGINS`へ完全一致で列挙し、wildcardは許可しない。
- v1のadapterとCPU契約テストは実装済みだが、固定image digestを使った実GPU model load、実音声推論、VRAM/RTFの合格記録は未完了。v2は引き続き専用adapter対象外。

### qwen3-omni-jp-vllm

- organization上で最新更新されたpublic model/recipe。
- Qwen3-Omni 30B-A3B系で、Context 1.7Bと同一Podへ同時常駐させない。
- file batch専用worker classとし、realtime p95 gateの対象外にする。
