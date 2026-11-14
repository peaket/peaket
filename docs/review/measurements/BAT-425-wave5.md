# BAT-425 GAT-130 잔여 측정 기록(웨이브 5, 갈래 2, R-592)

- **기준**: `origin/develop` `105a8ab8`(R-590), 가지 `wave/lane2-BAT-425-gat130-remainder`.
- **범위**: ops-svc 회차 취소 요청·판정·2인 확정, payment-svc 배상 송금 gRPC 계약·포트·가짜 어댑터, core-svc `core-notify-sender` 첫 몫, 결제사 서킷 상태 노출.

## cheap gate

| 검사 | 결과 |
| --- | --- |
| purchase 단위 | **3858 통과** |
| queue 단위 | **687 통과** |
| ops 단위 | **97 통과** (event-cancellations 4 포함) |
| core 단위 | **350 통과** (notification-sender 3·internal-notify 1 포함) |
| payment 단위 | **2941 통과** (compensation-transfer 3·gRPC 1·circuits 1 포함) |
| platform 단위 | **542 통과** |
| contracts 단위 | **41 통과** |
| api-client 단위 | **113 통과** |
| typecheck | purchase·queue·ops·core·payment·platform·contracts·api-client 통과 |
| lint | 통과 |
| doc-check | 오류 0, 경고 4(기존 API 설명·mermaid 환경) |
| ledger `--batch BAT-425` | 자동 시험 14·ID만 113·빈칸 122(기존과 같음) |
| trace-check R-T9/R-T22/GAT-120/GAT-130 | 통과(R-T9 3·R-T22 4·GAT-120 4·GAT-130 35) |
| records `--check` | 통과 |
| contracts `gen:check` | 생성물이 계약과 같다 |
| api-client `gen:check` | 생성물이 계약과 같다 |

## 구현 메모

- ops-svc `event_cancellation_request`(0011): 요청(commander) → 판정(commander) → 판정자가 아닌 operator·commander 확정. 확정 때 purchase-svc `EventRefundService.StartEventRefund`를 요청 ID 멱등 키로 부른다. 정지·재개는 `PauseEventRefundJob`·`ResumeEventRefundJob`에 잇는다. 판매 중지 확인·재인증 토큰은 아직 강제하지 않는다.
- payment-svc `CompensationTransferService`(payment.proto): `compensation_id` 멱등, `CompensationTransferPort`·가짜 어댑터. `PEAKET_COMPENSATION_TRANSFER_MODE=fake`가 아니면 UNAVAILABLE, 계좌 원문은 저장하지 않는다(POL-014).
- core-svc `core-notify-sender` 첫 몫: `NotificationSender`·`FakeNotificationTransport`·내부 `POST /internal/v1/notify/trade-events`. `PEAKET_NOTIFY_SENDER_MODE=fake`가 아니면 UNAVAILABLE(503). `notification_job`·`notification_delivery` 표와 Kafka 소비자는 마이그레이션 허용 밖이라 후속이다.
- payment-svc `GET /internal/v1/circuits` → ops-svc `GET /v1/ops/pg-circuits`. `closed`·`half_open`·`open`만 싣고 계정·구독 주소는 싣지 않는다.

## heavy gate

| 검사 | 결과 |
| --- | --- |
| ops test-int | **45 통과**(11 파일): `event-cancellations`(0011 적용·재적용, 요청→판정→확정, 정지·재개), `event-cancel-dispatch`, `event-refund-grpc` 회귀 |
| payment test-int | **476 통과·2 건너뜀**(21 파일) |
| payment 단위 | **2941 통과**: CompensationTransfer gRPC·fake/503, `/internal/v1/circuits` |
| core test-int | **239 통과·1 건너뜀**(19 파일) |
| core 단위 | **350 통과**: `/internal/v1/notify/trade-events` fake/503 |
| purchase test-int | **13 통과**(`event-refund`·`event-refund-grpc`) |
| 변이 | **21/21 잡힘, 놓침 0**: event-cancellations 판정/확정/반려/정지, compensation fake·멱등·검증·gRPC 상태, circuit 기본/목록, notify fake·멱등·검증·HTTP 503·문안 |
| 4관점 리뷰 | 높음 1 고침(내부 알림·서킷 경로에 `InternalTokenGuard` 누락), 중간 2 고침(ops 활성 요청 부분 유일 인덱스 누락, 알림 메모리 기록 무한 증가), 중간 2 문서화·후속(판매 중지 확인·재인증 미강제, ops 배상 송금 클라이언트/경로 없음) |
| 브라우저 확인 | 화면 변경이 없어 생략 |

## 남은 막힘

- 실제 지급대행·정산 계좌·KYC 연결(외부 계정·업체 없음).
- `core-notify-sender` 발송 원장 표·Kafka `trade.orders` 소비자·실제 웹 푸시/이메일 대행.
- 회차 취소 요청의 판매 중지 확인·재인증 토큰·ops 화면(SCR-047).
- `ledger --batch BAT-425 --require`의 ASVS 빈칸 122·ID만 113.

## heavy gate에서 돌릴 것

- ops test-int: `event-cancellations` HTTP/DB(0011 적용·재적용), 실제 purchase-svc gRPC 확정, 기존 `event-cancel-dispatch` 회귀.
- purchase test-int: `event-refund`·`event-refund-grpc`(기존).
- payment/core 단위·test-int: 배상 송금 gRPC 핸들러, 알림 sender 내부 경로, 서킷 상태 엔드포인트.
- 변이: event-cancellations 판정/확정, compensation fake/503, notify fake/503, circuit 상태 매핑.
- 브라우저: 화면 변경이 없어 생략.
