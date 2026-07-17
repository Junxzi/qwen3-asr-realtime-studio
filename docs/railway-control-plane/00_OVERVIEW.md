# Railway control plane overview

## Goals

- G-01: 利用者はRailway上の一画面から既存RunPod Podを起動し、同じ画面でリアルタイム文字起こしを開始できる。
- G-02: `RUNPOD_API_KEY`と操作パスワードをブラウザへ送らない。
- G-03: 起動の実状態を表示し、時間で進む偽の進捗を使わない。

## Non-goals

- RunPod Podの新規作成・Terminate。
- 8/16/32並列の負荷試験。
- Sortformer環境の修復。これはGPUコンテナ側の別タスクとする。

## Definition of done

- `npm run check`が成功する。
- mockモードで停止→起動→準備完了→停止の契約テストが通る。
- デスクトップ1280pxとモバイル390pxでログイン、起動、準備完了、文字起こし領域を目視確認する。
- Railwayの`/api/health`が200を返す。

## Technology

- Railway: React/Vite静的成果物とExpress制御APIを単一Nodeサービスで配信。
- RunPod: `RUNPOD_WORKERS_JSON`へ明示した複数Pod、またはTemplateから作成するdynamic worker。固定Pod IDへ依存しない。
- Audio: ブラウザからRunPodの`/v1/realtime`へ直接WSS送信し、Railwayを音声中継に使わない。
