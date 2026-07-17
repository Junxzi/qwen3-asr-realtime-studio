# Requirements

| ID | Requirement | Acceptance |
| --- | --- | --- |
| R-CTL-01 | 認証済み利用者だけがGPUを起動・停止できる | 未認証のmutationが401になる契約テスト |
| R-CTL-02 | 起動操作は冪等 | RUNNING時の再起動要求がproviderのstartを重複実行しない |
| R-CTL-03 | Pod状態とASR readinessを分けて表示 | `starting`と`ready`が別状態としてテストされる |
| R-SEC-01 | RunPod APIキーをクライアントへ返さない | `rg "RUNPOD_API_KEY" src`が0件 |
| R-ASR-01 | 16kHz mono PCM S16LEをWSS送信 | session.start契約とPCM変換のunit test |
| R-UX-01 | loading/error/empty/successを表示 | 各状態のコンポーネント分岐が存在しブラウザで確認 |
| R-DEP-01 | RailwayのPORTへbindしhealthcheckを提供 | production build起動後`/api/health`が200 |

