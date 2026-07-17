# Frontend

React 19、Vite、TypeScript、TanStack Queryを維持し、React Router、Tailwind CSS v4、Radix UI、Motionを使用する。ダークテーマのみ。

## Routes

- `/`: 新規または進行中の文字起こし
- `/transcriptions/:id`: 保存済み履歴の読み取り専用表示

## Layout

1. Sidebar: 新規作成、検索、日時グループ履歴、名称変更、削除。
2. Conversation: 話者、時刻、final、partialの置換可能末尾、Context hit。
3. Audio Composer: ファイル、マイク、波形、経過時間、停止。
4. Diagnostics: GPU、WSS、TTFT、stable latency、queue、RTF、Context、保存待ち。

820px以下ではSidebarを左drawer、Diagnosticsをbottom sheetへ変更する。

## Honest states

- unauthenticated
- GPU stopped / starting / ready / error
- WebSocket connecting / connected / error
- recording / finalizing
- persisted / pending outbox
- empty history / API error / readonly history

推測進捗は表示しない。保存待ち件数はIndexedDB内の実件数を表示する。

## Visual tokens

- OKLCH dark surface
- 4px spacing rhythm
- 1px border
- sea-glass accent
- self-hosted Inter Variable / Noto Sans JP Variable
- 150〜240msの開閉・選択transition
