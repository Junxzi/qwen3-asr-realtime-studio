# API contract

| Method | Path | Auth | Result |
| --- | --- | --- | --- |
| GET | `/api/health` | no | appとDBのhealth |
| POST | `/api/session/login` | no | HttpOnly署名cookie |
| GET | `/api/session` | yes | `authenticated=true` |
| POST | `/api/session/logout` | yes | cookie clear |
| GET | `/api/control/status` | yes | Pod/ASR stageとrealtime endpoint |
| POST | `/api/control/start` | yes | 202 operation |
| POST | `/api/control/stop` | yes | 202 operation |
| GET | `/api/transcriptions?cursor=&limit=&q=` | yes | cursor付き履歴一覧 |
| POST | `/api/transcriptions` | yes | session作成 |
| GET | `/api/transcriptions/:id` | yes | session、final発話、metrics |
| PATCH | `/api/transcriptions/:id` | yes | 利用者タイトル更新 |
| PUT | `/api/transcriptions/:id/utterances/:utteranceId` | yes | final発話の冪等upsert |
| POST | `/api/transcriptions/:id/complete` | yes | completed/interrupted/failed |
| DELETE | `/api/transcriptions/:id` | yes | cascade削除 |

Errors use `{ "error": { "code": "snake_case", "message": "...", "requestId": "..." } }` and every response has `x-request-id`.

`ControlStage` is `stopped | starting | ready | stopping | error`. RunPodが`RUNNING`でもASR readiness前は`starting`とする。

最初のfinal発話から24文字以内のタイトルを自動生成する。`PATCH`後は自動タイトルで上書きしない。
