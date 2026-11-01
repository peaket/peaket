# 브라우저 확인: add-local-cluster-and-relay-deployment

- 날짜: 2026-11-01
- 결과: 해당 없음

화면이 없는 변경이다. 로컬·CI kind 클러스터 스크립트, 공용 Helm 차트, 서비스별 Outbox 릴레이 프로세스, CI 잡과 점검 스크립트만 더했다(docs/architecture.md §8.6 6번). 확인은 시험(플랫폼 단위·통합, `tools/local`·`tools/ci`·문서 점검 시험)과 실제 kind 클러스터 시험 둘(`tools/local/e2e/aws-emulator.e2e.mjs`, `tools/local/e2e/relay-takeover.e2e.mjs`)로 했다.
