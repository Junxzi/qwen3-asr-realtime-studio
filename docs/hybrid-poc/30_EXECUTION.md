# 実行計画

## WP1: control plane

- processing profile catalog を一元定義する。
- session schema と migration を追加する。
- assignment store/scheduler/routes を purpose 単位へ変更する。
- batch URL と purpose-bound ticket を返す。

## WP2: worker

- realtime worker に構造化 pipeline event を追加する。
- ticket 検証を realtime/batch で分離する。
- lab model を常駐させる batch adapter と parser を追加する。
- CPU fake-mode tests と A40 smoke を用意する。

## WP3: frontend

- model picker を processing mode picker へ変更する。
- pipeline reducer と mode 別 flow graph を追加する。
- final と partial を utterance 単位で扱う。
- 保存中、outbox、失敗を実 Promise から flow へ反映する。

## 統合順序

1. schema と API の後方互換テスト。
2. worker protocol と adapter の fake-mode test。
3. frontend reducer と component test。
4. 全 lint、typecheck、unit、contract、build。
5. desktop/mobile screenshot 比較。
6. A40 batch smoke。
7. Context worker と A40 を用いた一通話 hybrid smoke。
