# BAT-430 GAT-135 잔여 측정 기록(웨이브 4, 갈래 2, R-587)

- **기준**: `origin/develop` `b178600e`(R-586) 위로 rebase, 가지 `wave/lane2-BAT-430-gat135-remainder`.
- **범위**: purchase-svc 우선 구매 보류 회수·만료·결제 실패 복귀, `seat_sale` 활성 행 대조, 동시 발급 정리, core 일정 사본의 입장 시작, gRPC `PriorityPurchaseService` Grant·Withdraw 정본, ops-svc gRPC 클라이언트·소명 인정 자동 호출, S-T37 ⑤~⑦ 시험.
- **마이그레이션**: purchase 0020(`purchase_order.priority_grant_id`, `priority_grant_offered_seat_key` 부분 유일 인덱스, `priority_grant_expiry_idx`).

## cheap gate

| 검사 | 결과 |
| --- | --- |
| purchase 단위 | 3856 통과(110 파일) |
| queue 단위 | 685 통과(38 파일) |
| ops 단위 | 86 통과(20 파일) |
| platform 단위 | 535 통과(43 파일) |
| contracts 단위 | 41 통과(11 파일) |
| api-client 단위 | 113 통과(8 파일) |
| typecheck | purchase·queue·ops·platform·contracts·api-client 통과 |
| lint | 통과 |
| doc-check | 통과 |
| ledger `--batch BAT-430` | S-T37 ⑤~⑦ 자동 시험으로 이동 |
| trace-check S-T37/Q-T62 | 통과 |
| records `--check` | 통과 |
| contracts `gen:check` | 생성물이 계약과 같다 |
| api-client `gen:check` | 생성물이 계약과 같다 |

## 구현 메모

- 회수는 `PRIORITY_RELEASE_LUA`로 보류를 먼저 풀고 좌석을 바로 돌려준 뒤 권리를 WITHDRAWN으로 바꾼다. 좌석은 방금 놓은 좌석 대기에 넣지 않는다.
- 발급은 `seat_sale` PENDING·SOLD 좌석을 건너뛰고, 사용 때 그 좌석이 팔렸으면 보류를 풀고 409 `priority-grant-invalid`다.
- 같은 취소 표의 동시 발급은 한 권리만 남기고 진 쪽이 잡은 여분 보류를 푼다. 같은 좌석의 다른 OFFERED 권리는 0020 부분 유일 인덱스가 막는다.
- 만료 반복이 `s:{event:E}:prio`를 1초 주기로 돌려 `PRIORITY_EXPIRE_LUA`로 좌석을 풀고 권리를 EXPIRED로 바꾼다(보상 건 없음).
- 입장 시작 시각은 core-svc 내부 판매 설정 사본의 `entryOpensAtMs`에서 읽는다.
- 결제 실패는 `RESTORE_PRIORITY_LUA`가 pin·ordered만 지워 PRIORITY 보류로 되돌리고, 결제 완료는 주문 전이 트랜잭션에서 USED를 적는다.
- prio 토큰이 권리의 좌석이 아닌 좌석을 주문하면 409 `priority-seat-only`다.
- gRPC 정본은 `GrantPriorityPurchase`·`WithdrawPriorityPurchase`이고, ops-svc는 `PEAKET_PURCHASE_GRPC_ADDR`가 있으면 gRPC, 없으면 기존 내부 HTTP를 쓴다.

## heavy gate

| 검사 | 결과 |
| --- | --- |
| purchase test-int | **372 통과**(6 파일, `--maxWorkers=2`): `priority-hold`(release·prio 만료), `purchase-migration`(0020, 21개), `event-refund`(21개), `order-expiry`, `saga-e2e`, `order-store` |
| ops test-int | **40 통과**(9 파일): 실제 gRPC 서버와 `GrpcPurchasePriorityGrants`, 소명 인정·기각 내부 경로, gRPC NOT_FOUND→404 |
| purchase gRPC 단위 | `priority-grant-grpc.test.ts` 3 통과(Grant·Withdraw·NOT_FOUND) |
| 변이 | **22/22 잡힘, 놓침 0**: withdraw release·USED 검사, grant 동시성·판매 대조·입장 시작·같은 좌석/등급, memory release/expire, sweeper priority pass·count, create-order seat-only/holdId/status, gRPC result/state 매핑, ops gRPC NOT_FOUND, 소명 기각, queue 사본 상태 |
| 4관점 리뷰 | 높음 1 고침(gRPC 오류 매핑이 Promise를 끝내지 못해 30초 타임아웃·unhandled), 중간 2 문서화·후속(회수 DB 실패 시 일시적 OFFERED 무홀드, 만료 회수 DB 반영 실패 재시도 없음) |
| 브라우저 확인 | 화면 변경이 없어 생략 |

## 남은 막힘

- PRIORITY→일반 홀드 `kind` 재작성 변환은 하지 않았다(pin·ordered로 같은 뜻).
- queue-svc `q:prio` 만료 회수가 purchase 권리 상태를 대조하는 몫.
- ops-svc 실제 사건 저장소·작업 워커 연결.
- `ledger --batch BAT-430 --require`의 ASVS 빈칸 92·ID만 113(대부분 offline-gate·queue-admission ASVS).
