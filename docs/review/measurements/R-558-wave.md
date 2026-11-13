# R-558 BAT-425 회차 취소 일괄 환불 첫 몫 웨이브 보고서

- 날짜: 2026-11-14
- 가지: `wave/lane3-BAT-425`
- 기준: `origin/develop` `5a68392e`, heavy gate에서 `12a832bc` 위로 rebase
- 범위: GAT-120·GAT-130 첫 몫. ops-svc `EVENT_CANCEL` 2인 승인·purchase-svc 내부 HTTP 전달, purchase-svc `event_cancellation_request`·`event_refund_item`(0016), 기존 `CancelTicket`/`CancelPayment` 재사용, 진행률·부분 실패·수동 일시정지·재개, CS `REFUND_FAILED` 내부 HTTP.

## Docker test-int

- purchase-svc 실제 PostgreSQL 18: **85건 통과**(event-refund 6, purchase-migration 79). 0016 적용·재적용, `event_cancellation_request`·`event_refund_item`, 대상 조회, 미리보기·시작·진행률·일시정지·재개, 결정적 취소 ID, 같은 요청·티켓 멱등, 부분 실패 CS 통지, `order_cancellation` 상태를 진행률이 따라가는지 확인.
- ops-svc 실제 PostgreSQL 18: **15건 통과**(event-cancel-dispatch 2, 기존 13). `EVENT_CANCEL` 2인 승인·요청자≠승인자, 승인 뒤 내부 HTTP 전달, `DISPATCHED`/`FAILED` 사건·감사.
- test-int가 잡은 결함: `ops_command_type_check`에 `EVENT_CANCEL`이 없어 실제 DB 접수가 500이었다. `0001_event_cancel_command_type.sql`로 제약을 넓혔다.

## 변이

- 29개 표본: 명령 상태 전이·2인 승인·승인 기한·dispatch 성공/실패·감사, 미리보기·시작·일시정지·재개·진행률·결정적 ID·멱등·부분 실패·CS 통지, 입장 뒤 회차 취소 즉시 환급, DB 진행률 동기화.
- 결과: **29/29 잡음**. 처음에는 같은 요청 재시작·DB 요청 충돌·dispatch 감사/상태 변이가 놓쳤고, 시험을 보강해 모두 잡았다.

## 4관점 리뷰

- **높음 1(고침)**: 입장이 시작된 회차 취소가 기존 팬 취소 규칙을 따라 환급을 입장 기록 마감 뒤로 미루던 문제. `EVENT_CANCELLED`·`EVENT_POSTPONED`는 바로 환급하도록 고쳤다.
- **중간 5(3 고침, 2 문서화·후속)**:
  1. 내부 HTTP가 공개 역할만 있고 서비스 사이 인증이 없었다 → `PEAKET_INTERNAL_TOKEN` 공유 토큰 가드를 양 서비스에 넣었다.
  2. 환급 재시도 실행기가 `order_cancellation`을 REFUNDED로 바꿔도 `event_refund_item` 진행률이 낡았다 → 조회에서 `order_cancellation` 상태를 따라가게 고쳤다.
  3. 같은 요청 ID로 회차·판정을 바꿔도 처음 요청을 돌려주던 문제 → 409로 막았다.
  4. 1만 건을 요청 안에서 동기 실행하는 백그라운드 실행기 부재 — 문서화·후속.
  5. 정본 `event_refund_pg_part` 대신 `event_refund_item`·progress JSONB를 쓰는 차이 — 문서화·후속.

## CI 로컬 등가

- root typecheck 42/42, lint 통과.
- ops-svc 단위 27건, purchase-svc 단위 3804건, platform 528건, contracts 41건, api-client 113건 통과.
- doc-check 오류 0(기존 경고 4), ledger `--check`·`records --check`·contracts `gen:check` 통과.
- platform 문제 유형 2건, api-client 113건 통과.
- trace-check GAT-120 6건·GAT-130 9건 통과. R-T9(자동 정지)·R-T22(수동 일시정지·재개·업무 거절)는 자동 정지·측정 몫이라 아직 시험이 없다.
- `ledger --batch BAT-425`는 부분 적용으로 빈칸·ID만이 남는다.

## 브라우저 확인

- 화면 변경이 없어 생략했다. 사유는 `docs/review/browser-check/R-558.md`에 남겼다.

## 남은 문제

- `refund.proto` gRPC `EventRefundService` 연결(첫 몫은 내부 HTTP).
- 자동 정지(1분 실패율·연속 실패·서킷·거절률), 연기(POSTPONE)·환급 신청 기간, 백그라운드 실행기, 팬 알림.
- 배상 지급·계좌 입력·송금·정산 상계, Kafka 소비자·SSE·화면.
- 정본 `event_refund_pg_part`·`promoter_id`·`partner_reason`·`judged_by`·`dry_run`·`done_count`/`failed_count`와의 차이.
- 재인증 토큰·멱등 키·행위자 가명화는 기존 골격과 같은 후속이다.
