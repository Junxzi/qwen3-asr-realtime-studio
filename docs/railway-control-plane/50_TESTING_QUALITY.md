# Testing and quality

- Unit: config、cookie、PCM、URL、cursor、auto-title、retention。
- Contract: auth、入力検証、検索、paging、final冪等保存、rename、complete、delete、expiry。
- Static: ESLint + client/server TypeScript。
- Build: Vite production + server TypeScript + Drizzle migration artifact。
- Browser: login、履歴復元、診断drawer、mobile sidebar、console error 0。
- Visual: 1536×1024と390×844を承認済み画像と比較する。
- Security: `npm audit --omit=dev`でproduction依存に既知脆弱性0。
- Deploy smoke: public `/api/health`、ログイン、DB storage、履歴再読み込み。
- Realtime smoke: RunPod GPUがreadyなときにマイクまたはサンプル音声でpartial/finalを確認する。

完了条件は`npm run check`成功、ブラウザconsole error 0、重大な視覚差分なし。外部GPUが停止中の場合、Realtime smokeだけは未実施として明記する。
