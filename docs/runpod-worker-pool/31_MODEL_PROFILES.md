# InfoDeliver model profiles

2026-07-17に、ログイン済みHugging Face organization画面で確認した5 modelを分類する。モデル一覧へ出すことと、workerで実際に推論可能であることを分けて管理する。

| Model | Intended runtime | Worker class | Current integration status |
| --- | --- | --- | --- |
| `infodeliverailab/qwen3-asr-ja-rlbr-context-fullft` | realtime + file | `qwen_asr_realtime` | worker実装あり。GPU smoke待ち |
| `infodeliverailab/lab_asr_jp_1` | telephone file、realtime候補 | `qwen_asr_speaker_tokens` | `qwen-asr` full checkpoint。speaker token parserとGPU評価が必要 |
| `infodeliverailab/lab_asr_diarization_v1` | offline file | `ecapa_interleave_batch` | custom ECAPA temporal-interleave adapterが必要 |
| `infodeliverailab/lab_asr_diarization_v2` | offline file | `ecapa_interleave_batch` | v1のYT増強版。custom adapterが必要 |
| `infodeliverailab/qwen3-omni-jp-vllm` | offline file | `qwen_omni_batch` | public vLLM recipe。専用batch adapterとA100 80GB classが必要 |

## Deployment rule

- `integration_status=ready`かつ、同じmodel IDを`/ready`で実測したworkerがある場合だけ新規入力を有効化する。
- 2026-07-17時点のWeb UIではContext Full-FTだけを選択可能にし、残る4モデルは一覧へ表示しつつ`gpu_validation_required`または`adapter_required`として無効化する。
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
- v1最新確認commit: `226eb0ecf3bcd709db75c3aa12ab3c9b1a5939f6`。
- v2 code最新確認commit: `b7691fb0cc4ccab0df95df8f7e08e1852d1f1e38`。
- `max_new_tokens=800`級の長尺offline推論を前提とし、現在の1秒chunk workerへ直接差し替えない。

### qwen3-omni-jp-vllm

- organization上で最新更新されたpublic model/recipe。
- Qwen3-Omni 30B-A3B系で、Context 1.7Bと同一Podへ同時常駐させない。
- file batch専用worker classとし、realtime p95 gateの対象外にする。
