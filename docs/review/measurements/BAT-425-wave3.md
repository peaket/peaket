# BAT-425 GAT-130 잔여 측정·검증 기록(2026-11-15, R-583)

- 가지: `wave/lane2-BAT-425-gat130` (기준 `origin/develop` `5b73c33b`, R-581)
- 작업 폴더: `D:/ticketpass-lane2`
- 범위: `docs/features/transfer-refund.md` §5, R-T9·R-T22, `docs/features/settlement.md` §6, `docs/security/asvs/transfer-refund.md`

## 1. 넣은 것

| 몫 | 내용 | 시험 |
| --- | --- | --- |
| gRPC 정본 | `refund.proto` `EventRefundService`에 `ApplyEventRefund`·`CloseEventRefundWindow`를 더하고 `StartEventRefund`에 `kind`·`postponed_to`·`refund_window_closes_at`·`fan_notice_reason`, `GetEventRefundJob`에 `kind`·`refund_window_closes_at`·`not_applied_orders`·`applied_orders`를 더했다. purchase-svc gRPC 서버, ops-svc gRPC 클라이언트, 내부 HTTP 호환 경로 유지 | `test-int/event-refund-grpc.int.test.ts`, `services/ops-svc/test/refund-commands.test.ts` |
| 자동 정지 | 1분 창 실패율 5%(호출 20건 이상)·실패 금액 500만 원·연속 실패 20건·서킷 열림은 결제사 몫, 1분 창 거절률 5%는 작업 전체를 `PAUSED`로 두고 ops-svc `ops_alert`에 SEV2를 남긴다. `EVENT_REFUND_PAUSE`·`EVENT_REFUND_RESUME` 명령으로 수동 멈춤·재개 | `services/purchase-svc/test/event-refund-gat130.test.ts` R-T9·R-T22, `services/ops-svc/test/refund-commands.test.ts` |
| 백그라운드 실행기 | 릴레이 리더의 `event-refund-runner`(10초 [가정] 틱)가 `event_refund_item`의 `PENDING`/`UNKNOWN`을 `next_attempt_at`(1분→5분→15분→1시간→6시간, 5회 [가정])에 따라 처리한다. `cancel-{cancellationId}` 멱등, 5회 초과·업무 거절은 `FAILED`+CS `REFUND_FAILED` | `test/event-refund-gat130.test.ts`, `test-int/event-refund.int.test.ts` |
| 연기·신청 창 | `POSTPONE`은 `REFUND_WINDOW`로 시작하고 `ApplyEventRefund`(멱등 키 `application_id`)로 신청한 티켓만 환급한다. 창이 닫히면 미신청은 `NOT_APPLIED`로 끝나고, 신청 건의 환급이 끝나면 `COMPLETED` | `test/event-refund-gat130.test.ts`, `test-int/event-refund-grpc.int.test.ts` |
| 팬 알림 | `trade.orders` Outbox에 `EVENT_CANCELLATION_CONFIRMED`·`EVENT_POSTPONED`(바뀐 일시·신청 창 닫힘)·`REFUNDED`(`refundAmount`)·`REFUND_FAILED`를 남긴다. 실제 발송기는 core-svc notify 후속 | `test/event-refund-gat130.test.ts` |
| 경보 | ops-svc `ops_alert`(마이그레이션 0003)·내부 HTTP `/internal/v1/ops-alerts`, `(event_key, kind)` 멱등(같은 사유라도 1분 버킷이 지나면 새 경보) | `services/ops-svc/test/alerts.test.ts`, `test/migration-0003.test.ts` |
| 저장 | purchase 0018: `event_cancellation_request.postponed_to`·`refund_window_closes_at`, `event_refund_item.applied_at`·`next_attempt_at`, `event_refund_attempt` | `test/purchase-schema.test.ts`, `test-int/event-refund.int.test.ts` |

## 2. cheap gate

| 게이트 | 결과 |
| --- | --- |
| purchase-svc 단위 | 3838 통과 |
| ops-svc 단위 | 58 통과 |
| bundle 단위 | 79 통과 |
| payment-svc 단위 | 2929 통과 |
| core-svc 단위 | 329 통과 |
| partner 단위 | 181 통과 |
| platform 단위 | 532 통과 |
| contracts 단위 | 41 통과 |
| api-client 단위 | 113 통과 |
| typecheck | 42/42 통과 |
| lint | 오류 0 |
| doc-check | 오류 0(경고 4, 기존 openapi 응답 설명) |
| ledger `--batch BAT-425` | 실행(BAT-425 범위: 자동 시험 11, ID만 108, 빈칸 130, 해당 없음 20) |
| trace-check R-T9·R-T22·GAT-120·GAT-130 | 통과(ID 4개, 시험 26개) |
| records `--check` | 통과 |
| contracts `gen:check` | 통과 |
| api-client `gen` | 다시 만듦 |

## 3. heavy gate

| 게이트 | 결과 |
| --- | --- |
| purchase-svc test-int 전체 | 1839 통과·2 건너뜀(`--maxWorkers=2`, 0018 적용·재적용·마이그레이션 수 19 포함) |
| purchase-svc test-int 첫 실행 | 1835 통과·4 실패. 1건은 `event_refund_attempt.consecutiveFailures`의 같은 밀리초 실패 누락(고침), 3건은 `hold-lifecycle`·`seat-store`의 Redis 100ms 마감 flaky(단독·`--maxWorkers=2` 재실행 통과) |
| ops-svc test-int 전체 | 31 통과(`event-refund-grpc.int.test.ts` 실제 gRPC 칸 매핑, `command-execution-refund.int.test.ts` PAUSE/RESUME 명령, 0003 `ops_alert`·명령 유형) |
| 변이 | 31/31 잡힘(자동 정지 임계·재시도·신청 창·NOT_APPLIED·DB 창 쿼리·gRPC enum·취소 ID·배상 올림·연기 사유) |
| 브라우저 | 화면 변경이 없어 생략(사유: 서버·계약·배치만 바뀌었다) |

## 4. 4관점 리뷰

- **높음 0**.
- **보안 중간 1(문서화·후속)**: `refund.proto` gRPC 포트는 앱 수준 호출자 확인이 없고 메시 L7 허용 목록(ops-svc 신원만)에 의존한다. `StartEventRefund`의 `ruled_by`·`confirmed_by`는 서로 다름만 확인하고 역할은 확인하지 않는다. 배포 때 gRPC 포트를 클러스터 안에만 열고 ops-svc 신원만 허용해야 한다.
- **정합 중간 1(고침)**: 연기 신청과 신청 창 닫기가 겹치면 늦게 쓴 쪽이 먼저 신청을 덮을 수 있었다. `markApplied`·`markNotApplied` 조건부 UPDATE(`applied_at is null`)로 먼저 온 쪽만 남기게 고쳤다. `ops_alert`는 event_key에 1분 버킷을 넣어 재개 뒤 다시 멈춘 경우 새 경보를 남긴다.
- **시험 중간 1(문서화)**: 전체 test-int를 기본 병렬로 돌리면 `hold-lifecycle`·`seat-store`의 Redis 100ms 마감 시험이 flaky하다(이번 변경과 무관, 단독·`--maxWorkers=2` 통과). heavy gate는 `--maxWorkers=2`로 돌린다.
- **운영 중간 3(후속)**: `event_refund_attempt`는 시도마다 한 행이라 보존·파티션 정책이 없다. `event-refund-runner`는 로그만 있고 지표(처리 수·실패 수·틱 지연)가 없다. `PEAKET_GRPC_PORT`·`PEAKET_PURCHASE_GRPC_ADDR`를 배포 환경에 넣기 전까지는 내부 HTTP 호환 경로로 돈다.
- 합계: **높음 0, 중간 6(정합 1 고침, 보안·시험·운영 5 문서화·후속)**.

## 5. 막힌 몫

- **배상 송금·정산 지급**: `CompensationTransferPort`와 payment-svc 송금 계약, 지급대행, 정산 계좌, KYC가 없다. `compensationTargets`·`compensationTotal`은 미리보기·요청에 남기지만 실제 송금·`COMPENSATION_ADVANCE` 미수금·상계는 만들지 않는다. 정본 `docs/features/settlement.md` §6·§7.
- **팬 알림 발송기**: core-svc notify의 `core-notify-sender`가 없다. `trade.orders` Outbox와 asyncapi 계약까지다.
- **회차 취소 요청 REST·판정**: ops-svc의 파트너 취소·연기 요청 접수·판정·2인 확정 화면은 아직 없다. 현재는 ops 명령 `EVENT_CANCEL`로 시작한다.
- **결제사 서킷 상태**: purchase-svc가 payment-svc의 결제사별 서킷 상태를 읽는 계약이 없어 `AUTO_CIRCUIT_OPEN`은 포트 기본 false다. 실패율·실패 금액·연속 실패·거절률은 동작한다.

## 6. 모델

- 작업 모델: OpenCode DeepSeek V4.1 Flash (max 추론)
- Co-Authored-By: OpenCode DeepSeek V4.1 Flash <noreply@opencode.ai>
