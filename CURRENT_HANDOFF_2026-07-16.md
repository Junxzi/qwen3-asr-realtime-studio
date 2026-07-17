# Qwen3-ASR RunPod 復旧作業 引き継ぎ

更新日時: 2026-07-16 JST

## 次セッションへの依頼

RunPod 上の既存 Qwen3-ASR リアルタイムサービスを復旧し、公開 UI で音声文字起こしができるところまで進める。

新しい Pod の作成や現 Pod の Terminate は、既存 `/workspace` の退避方法を確定するまで行わない。

## RunPod

- Pod 名: `qwen3asr_fintuning-migration-migration`
- Pod ID: `nhf73n5jvajgyj`
- GPU: A100 SXM 80GB x1
- 現在: GPU ありで起動済み
- SSH 接続情報:

```bash
ssh root@154.54.102.25 -p 15329 -i ~/.ssh/id_ed25519
```

- 公開 UI: `https://nhf73n5jvajgyj-8000.proxy.runpod.net/`
- 公開 health: `https://nhf73n5jvajgyj-8000.proxy.runpod.net/health`
- JupyterLab: `https://nhf73n5jvajgyj-8888.proxy.runpod.net/`
- Web Terminal は利用者が有効化し、Chrome で開いている。

## 現在の障害

Pod と JupyterLab は起動しているが、8000 番は `502 Bad Gateway`。

ASR 起動コマンドは実行済み:

```bash
nohup env \
  PYTHONPATH=/workspace/qwen-realtime-releases/qwen-realtime-20260715T132242Z/src \
  LOG_DIR=/workspace/qwen-realtime/outputs \
  bash /workspace/qwen-realtime-releases/qwen-realtime-20260715T132242Z/scripts/run_all.sh \
  > /workspace/qwen-realtime/outputs/service-supervisor.log 2>&1 &
```

ログで判明した直接原因:

```text
nohup: ignoring input
/workspace/qwen-realtime-releases/qwen-realtime-20260715T132242Z/scripts/run_all.sh: line 19: /opt/qwen-realtime/venvs/qwen-diarizer/bin/activate: No such file or directory
```

GPU 不足やモデル不良ではなく、話者分離用 Python venv が非永続領域 `/opt` に置かれていたため、Pod 再起動後に消えたことが原因。

## 永続領域に残っている Python 環境

実行済み:

```bash
find /workspace -path '*/bin/activate' -type f | sort
```

結果:

```text
/workspace/cache/uv/builds-v0/.tmpVDuIZS/bin/activate
/workspace/cache/uv/builds-v0/.tmprOTCWq/bin/activate
/workspace/qwen-realtime/uv-cache/builds-v0/.tmpHtTUMy/bin/activate
/workspace/qwen-realtime/uv-cache/builds-v0/.tmpf6yRgR/bin/activate
/workspace/qwen-realtime/uv-cache/builds-v0/.tmpmK2blh/bin/activate
/workspace/qwen-realtime/uv-cache/builds-v0/.tmptvJO1G/bin/activate
/workspace/qwen-runtime/venvs/qwen-realtime/bin/activate
/workspace/venvs/qwen-realtime/bin/activate
```

`qwen-diarizer` venv は `/workspace` に存在しない。ASR 用 `qwen-realtime` venv は残っている。

## 次に実行する調査

Chrome または Computer Use で、開いている RunPod Web Terminal を操作できるなら次を実行する。

```bash
grep -RniE 'qwen-diarizer|venv|diar' \
  /workspace/qwen-realtime-releases/qwen-realtime-20260715T132242Z/scripts \
  /workspace/qwen-realtime/configs/service.env
```

必要に応じて以下も確認する。

```bash
sed -n '1,220p' \
  /workspace/qwen-realtime-releases/qwen-realtime-20260715T132242Z/scripts/run_all.sh

find /workspace/qwen-realtime-releases/qwen-realtime-20260715T132242Z/scripts \
  -maxdepth 2 -type f -print | sort
```

`service.env` 全体にはトークン等が含まれる可能性があるため、画面やチャットへ全文を出さない。

## 復旧方針

1. リリース内のセットアップスクリプトや lock ファイルから、diarizer venv の正しい依存関係を特定する。
2. venv を `/opt` ではなく、永続領域の次のような場所へ再構築する。

```text
/workspace/venvs/qwen-diarizer
```

3. `run_all.sh` または設定値の参照先を、永続 venv へ変更する。
4. 今後の再起動でも壊れないよう、ASR と diarizer の venv、キャッシュ、ログをすべて `/workspace` 配下へ統一する。
5. サービスを再起動する。
6. Pod 内で確認:

```bash
curl -fsS http://127.0.0.1:8000/health
```

7. 外部から確認:

```powershell
Invoke-WebRequest -UseBasicParsing `
  https://nhf73n5jvajgyj-8000.proxy.runpod.net/health
```

8. 公開 UI を開き、`demo-securities-call.wav` またはマイクで partial/final を確認する。

## 配置済みモデル

| 用途 | モデル | RunPod パス |
|---|---|---|
| 最終 ASR | `infodeliverailab/qwen3-asr-ja-rlbr-context-fullft` | `/workspace/models/qwen3-asr-ja-rlbr-context-fullft` |
| Forced Aligner | `Qwen/Qwen3-ForcedAligner-0.6B` | `/workspace/models/Qwen3-ForcedAligner-0.6B` |
| Streaming diarization | `nvidia/diar_streaming_sortformer_4spk-v2.1` | `/workspace/models/diar_streaming_sortformer_4spk-v2.1-verified` |

## 配置済みサービス

- リリース:
  `/workspace/qwen-realtime-releases/qwen-realtime-20260715T132242Z`
- 実行設定:
  `/workspace/qwen-realtime/configs/service.env`
- ログ:
  `/workspace/qwen-realtime/outputs`
- モデル lock:
  `/workspace/qwen-realtime/outputs/models-lock.json`
- 監督ログ:
  `/workspace/qwen-realtime/outputs/service-supervisor.log`
- WebSocket:
  `/v1/realtime`

## ローカル側

- リポジトリ:
  `C:\Users\junju\Documents\Codex\2026-07-15\qwen3-asr-summary-runpod-a100-80gb`
- 既存の詳細引き継ぎ:
  `RUNPOD_REALTIME_HANDOFF.md`
- ローカル音声サンプル:
  `demo-securities-call.wav`

## SSH の状態

接続先 `154.54.102.25:15329` は提示済み。

RunPod コンソールが提示した秘密鍵パスは `~/.ssh/id_ed25519` だが、この PC にはその鍵が存在しなかった。

以下の既存鍵では認証に失敗した。

- `C:\Users\junju\.ssh\imma_key`
- `C:\Users\junju\.ssh\juno_tailscale`

エラー:

```text
Permission denied (publickey,password).
```

新規 `id_ed25519` 作成を試みたが完了確認前に作業が中断されたため、存在確認から再開すること。

```powershell
Get-Item "$HOME\.ssh\id_ed25519","$HOME\.ssh\id_ed25519.pub" `
  -ErrorAction SilentlyContinue
```

鍵がなければ新規作成し、公開鍵のみを RunPod の `/root/.ssh/authorized_keys` または RunPod SSH Public Keys に登録すれば、以後は Web Terminal を介さず操作できる。

秘密鍵、HF トークン、RunPod API キー、Jupyter トークンはチャットや Git に貼らない。

## Chrome / Computer Use

利用者は Chrome で Web Terminal を開いている。

前セッションでは Chrome / Computer Use プラグイン自体は認識されたが、画面操作を実行する機能がタスクに公開されず、クリックや入力を実行できなかった。

新セッションでは最初に次を試す。

- `Computer Use` と `Chrome` プラグインを明示的に指定する。
- Chrome の既存 Web Terminal タブを取得する。
- 操作機能が使える場合は、上記の調査コマンドから続行する。
- 操作機能がなければ、SSH 鍵登録を一度だけ利用者に依頼し、その後は SSH で作業する。

## 新 Pod を作る場合

現時点では推奨しない。A100 SXM 80GB は今回の構成に十分で、障害原因は GPU ではなく消失した venv。

新 Pod を作る場合も現 Podを先に Terminateしない。現在の `/workspace` が通常の Volume Disk の場合は物理マシンに紐づき、新 Pod へ直接付け替えられない可能性がある。Cloud Sync、SSH/rsync、または Network Volume へデータを退避してから移行する。

GPU候補:

1. A100 SXM 80GB: 現行・推奨
2. A100 PCIe 80GB: わずかに安価
3. H100 80GB: 32同時通話の性能ゲートで必要になった場合
4. L40S 48GB: 安価だが3モデルと32同時処理ではVRAM余裕が小さい

## 完了条件

- `/health` が内外とも HTTP 200
- ASR、Forced Aligner、Sortformer が `production` / `real` モードでロード済み
- 公開 UI が表示される
- サンプル音声で partial と final が返る
- 話者情報または `speaker_hint` が返る
- ログに致命的エラーがない
- 再起動後も `/workspace` 内の venv を使って起動できる
