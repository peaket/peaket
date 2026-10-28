# 내부 gRPC 계약 초안(.proto)

- **독자와 용도**: 서비스 개발자가 서비스끼리 부르는 gRPC(서비스끼리 함수를 부르듯 빠르게 호출하는 통신 방식) 호출의 모양, 즉 요청·응답·결과 값을 확인할 때 읽는다. 계약 저장소(`peaket-contracts`)로 옮길 때의 출발점이기도 하다. 외부 API는 docs/api/openapi.yaml, 이벤트는 docs/api/asyncapi.yaml이 정본이다.
- **원본 출처**: 2026-10-22 소유자 요청으로 만든 초안이다. 소유자가 멘토의 기준("API 명세는 OpenAPI나 protobuf 같은 표준 형식 파일로 둔다")으로 문서 구성을 점검하게 했고, 점검에서 서비스 사이 gRPC 계약이 글과 표로만 있고 `.proto` 파일이 없음을 찾았다. 호출 목록과 필드는 docs/architecture.md §3.2(통신 표)와 기능 설계서의 흐름도에서 옮겼다.
- **기준 기획 버전**: v1.0. 작성 2026-10-22.
- **표시 규칙**: 이 폴더 전체가 추천 적용(2026-10-22) 초안이다. 파일마다 머리의 '정본' 줄이 근거 문서다. wbs 0.2.2(proto·Avro·Schema Registry CI)에서 `peaket-contracts`로 옮기며 확정하고, 그 뒤에는 그쪽이 정본이다.

## 1. 파일

```text
docs/api/proto/
  buf.yaml                               형식 검사(STANDARD)와 하위 호환 검사(FILE) 설정
  peaket/common/v1/common.proto          공통 값(원화 금액, 결제사)
  peaket/payment/v1/payment.proto        payment-svc: 결제창 준비·승인·결과 당기기·조회·취소, 새 결제 일시 정지 조회, 지급대행 판매자 등록, 지급 묶음 승인
  peaket/ticket/v1/ticket.proto          ticket-svc: 발권, 예매 취소, 후기 작성 자격, 보유 티켓 확인
  peaket/identity/v1/identity.proto      identity-svc: 결제 직전 본인확인 재확인, 소셜 로그인 뒤 세션 생성과 로그아웃(소비자 웹 앱 서버)
  peaket/trust/v1/trust.proto            trust-svc: 위험 판정
  peaket/queue/v1/queue.proto            queue-svc: 대기 중 격리
  peaket/purchase/v1/refund.proto        purchase-svc: 회차 취소 일괄 환불 작업
  peaket/core/v1/core.proto              core-svc: 판매 승인 결과, 게시물 조치
  peaket/control/v1/control.proto        admission-ctrl·purchase-svc·queue-svc·payment-svc가 함께 구현: 제어 상태 적용(직접 제어 채널, ADR-0102·0103. payment-svc는 명령 6 대체 결제사 전환, ADR-0143)
```

- 2026-10-22에 protoc(grpcio-tools 1.71.0)로 여덟 파일을 모두 컴파일해 문법·import·이름이 맞음을 확인했다(서비스 8개, 호출 19개). 같은 날 ADR-0085로 `PaymentService.GetNewPaymentPause`를 더해 호출이 20개가 됐다. 더한 부분은 아직 컴파일해 보지 않았다. 2026-10-28 ADR-0102로 `peaket/control/v1/control.proto`(서비스 1개, 호출 1개)를 더해 서비스 9개, 호출 21개가 됐다. 이 파일도 작업 환경에 protoc가 없어 아직 컴파일해 보지 않았다(추천 적용 2026-10-28, ADR-0102). 같은 날 기술 검토 중간-045로 `EventRefundService.PauseEventRefundJob`(호출 하나)과 멈춘 이유·결제사 몫 메시지를 `refund.proto`에 더했다. 이것도 컴파일해 보지 않았다. 위 셈 뒤에 더한 호출(`BatchGetPayments` 등)까지 2026-10-29에 파일로 다시 세면 서비스 10개, 호출 25개다(파일 9개). 2026-10-29 ADR-0143으로 `ControlKind`에 대체 결제사 전환(`CONTROL_KIND_PG_SWITCH`)을 더한 것도 컴파일해 보지 않았다. `buf lint`와 `buf breaking`은 아직 돌리지 않았다. CI 연결은 wbs 0.2.2다.

## 2. 규칙

| 항목 | 규칙 | 근거 |
| --- | --- | --- |
| 패키지와 폴더 | 패키지는 `peaket.<받는 서비스>.v1`이고 폴더 경로가 패키지와 같다. 받는 서비스 여럿이 같은 계약을 구현하는 제어 상태 적용만 `peaket.control.v1` 하나로 둔다(추천 적용 2026-10-28, ADR-0102) | buf STANDARD 형식 검사 |
| 버전 | 하위 호환이 깨지는 변경은 새 패키지(`v2`)로 낸다. 필드 번호는 다시 쓰지 않고, 지운 필드는 `reserved`로 막는다. `buf breaking`이 막는다 | docs/api/guidelines.md §1, docs/architecture.md §3.2 |
| 업무 결과와 오류 | 거절·대기 중 아님·입금 대기처럼 정상적인 업무 결과는 응답의 결과 값(enum)으로 돌려준다. 요청을 처리하지 못했을 때만 gRPC 상태 코드를 쓴다(아래 표) | 추천 적용 |
| 데드라인 | 부르는 쪽은 받은 데드라인의 남은 시간을 넘긴다. 남은 시간이 모자라면 시작하지 않고 `DEADLINE_EXCEEDED`로 끝낸다. 정본 값은 좌석 홀드 전체 40ms, 승인 명령 접수(`ConfirmPayment`) 200ms [가정], 주문-결제-발권 3초이고, 제어 상태 적용(`ApplyControl`)은 1초 [가정]이다(추천 적용 2026-10-28, ADR-0102). 결과 당기기(`BatchGetPayments`)는 500ms [가정]이고 purchase-svc 파드마다 동시 요청 4개 [가정]까지다(추천 적용 2026-10-29, ADR-0140, docs/architecture.md §5 시간 초과 기본값). 결제사 승인 HTTP 호출은 데드라인으로 끊지 않고 읽기 시간 초과 60초 [가정]까지 기다린다(2초는 경보·측정 기준, docs/architecture.md §5 시간 초과 기본값, 2026-10-28 기술 검토 높음-16). 나머지 호출의 값은 아직 정하지 않았고 측정 뒤 정한다 | docs/api/guidelines.md §5 |
| 재시도 | 앱 코드는 네트워크 재시도를 하지 않는다. 남는 전송 재시도는 gRPC 라이브러리의 투명 재시도와 메시 재시도 예산(최대 1회)이다. 결제 승인 확인 같은 업무 재시도는 같은 멱등 키로 승인 기한 안에서만 한다(docs/architecture.md §5). 상태를 바꾸는 호출은 멱등 키로 같은 결과를 돌려준다 | docs/api/guidelines.md §5, ADR-0082 |
| 부르는 쪽 확인 | 메시 mTLS 신원(서비스 계정)으로 부르는 쪽을 확인하고, 허용 목록 밖이면 `PERMISSION_DENIED`다. 제어 포트는 ops-svc와 비상 런북 Job 신원만 받는다(추천 적용 2026-10-28, ADR-0102). identity-svc의 `SessionService`는 소비자 웹 앱 서버 신원만, `IdentityService`는 purchase-svc 신원만 받는다(추천 적용 2026-10-28, 기술 검토 중간-083) | docs/infra.md §9 |
| 개인정보 | 계좌번호는 `RegisterPayoutSeller` 안에서만 쓰고 저장하지 않는다. 사람 확인 토큰은 저장하지 않고, 기기 식별값은 가명으로 바꾼 뒤에만 저장한다. 필드 주석에 적었다 | docs/security/data-classification.md, ADR-0053 |
| 주석 | 한국어로 쓴다. 정본 문서를 가리키고, 정본에 없는 값은 지어내지 않는다 | planning/03-policies-glossary.md §5 |

**gRPC 상태 코드(추천 적용 2026-10-22)**

| 코드 | 쓰는 때 | 부르는 쪽이 할 일 |
| --- | --- | --- |
| `INVALID_ARGUMENT` | 요청 모양이 틀렸다(필수 값 없음, 금액 0 이하) | 고쳐서 다시 보내지 않는다(버그) |
| `FAILED_PRECONDITION` | 상태가 맞지 않는다(활성 결제 시도가 아님, 결제사 불일치) | 자기 상태를 다시 읽는다 |
| `ALREADY_EXISTS` | 같은 멱등 키에 다른 내용이 왔다(REST의 422 `idempotency-key-reused`와 같은 경우, docs/api/guidelines.md §4) | 버그로 보고 알린다 |
| `NOT_FOUND` | 대상이 없다 | 업무 규칙대로 처리한다 |
| `PERMISSION_DENIED` | 허용하지 않은 서비스가 불렀다 | 설정을 고친다. 대체 응답으로 가지 않는다(본인확인 재확인도 거부하고 SEV2, 기술 검토 낮음-153) |
| `RESOURCE_EXHAUSTED` | 결제사 한도나 벌크헤드(의존성별로 나눈 연결 풀)가 찼다 | 기다렸다가 업무 재시도 규칙대로 한다. 본인확인 재확인은 남은 데드라인 안에서 한 번 다시 묻고, 그래도 이 코드면 토큰 값으로 판정한다(ADR-0055, 기술 검토 낮음-153) |
| `INTERNAL`·`UNKNOWN` | 받는 쪽의 예상하지 못한 오류 | 서킷 브레이커가 실패로 센다. 본인확인 재확인은 `RESOURCE_EXHAUSTED`와 같이 한 번 다시 묻고 토큰 값으로 판정한다(추천 적용 2026-10-28, 기술 검토 낮음-153) |
| `DEADLINE_EXCEEDED` | 남은 시간이 모자랐거나 시간을 넘겼다 | 서킷 브레이커와 대체 응답으로 간다 |
| `UNAVAILABLE` | 서비스나 그 의존성을 쓸 수 없다 | 서킷 브레이커와 대체 응답으로 간다(본인확인은 토큰 값으로 판정, ADR-0055) |

## 3. 호출 목록

'통신 표'는 docs/architecture.md §3.2에 그 호출이 적혀 있는지다. 흐름도에만 있던 호출은 이 초안에서 처음 계약으로 적었고, 2026-10-22에 통신 표에 더했다(ADR-0084).

2026-10-28에 결제창 값과 시각의 형을 맞췄다(추천 적용 2026-10-28, 기술 검토 낮음-028). `PrepareCheckoutResponse.checkout`은 `map<string, string>`에서 결제사별 메시지의 `oneof`(`TossCheckout toss`, `PortoneCheckout portone`, 시뮬레이터는 토스와 같은 `TossCheckout simulator`)로 바꿔, 키 이름 실수를 컴파일과 `buf`가 잡게 했다. 같은 파일의 `ConfirmPaymentRequest`가 이미 결제사별 `oneof`다. 문자열이던 시각 둘(`ApplyModerationRequest.ends_at`, `ApplyControlResponse.applied_at`)은 다른 계약처럼 `google.protobuf.Timestamp`로 바꿨다. 셋 다 계약 저장소로 옮기기 전 초안이라 번호를 다시 썼고, 이 변경도 protoc로 컴파일해 보지 않았다. openapi `PaymentAttempt.checkout`도 같은 칸의 `TossCheckout`·`PortoneCheckout` 스키마로 맞췄다.

2026-10-28에 판매 승인 단위(공연, ADR-0093)를 초안에 맞췄다. `RecordSaleReviewResultRequest`의 1번 필드를 `event_id`에서 `production_id`로 바꾸고, 승인 본문의 회차별 규모(`EventScale`·`ScaleLevel`)·공연장·아티스트·다른 이름을 5~8번으로 더했다. 아직 계약 저장소로 옮기기 전이라 번호 1을 다시 썼다. 옮긴 뒤라면 §2 '버전' 규칙대로 새 번호와 `reserved`로 한다. 같은 때 proto·Avro의 다른 회차 칸을 훑었다. 결제사 지정·전환과 새 결제 일시 정지는 회차 칸이라(ADR-0093 결정 2) `PrepareCheckoutRequest.event_id`와 `GetNewPaymentPause`는 그대로다. 정산(`trade.settlements`)도 회차 단위라 그대로다. 이 변경도 작업 환경에 protoc가 없어 아직 컴파일해 보지 않았다(추천 적용 2026-10-28, 기술 검토 중간-086).

| 부르는 쪽 → 받는 쪽 | 호출 | 하는 일 | 멱등 키 | 정본 흐름 | 통신 표 |
| --- | --- | --- | --- | --- | --- |
| purchase-svc → payment-svc | `PrepareCheckout` | 결제창 준비 | — | docs/features/payment.md §2·§2.2 | 있음 |
| purchase-svc → payment-svc | `ConfirmPayment` | 승인 명령(접수만 기다리고 결과는 `trade.payments`) | `confirm-{order_id}` | docs/features/payment.md §2·§2.1 | 있음 |
| purchase-svc → payment-svc | `BatchGetPayments` | 결과 당기기: 결과 사건이 5초 [가정] 안에 오지 않은 주문을 최대 100건 [가정]씩 묻는다(점검은 1초 [가정]마다, 같은 주문은 5초 [가정]에 한 번. 쓰기 인스턴스 읽기, 결제사 호출 없음, ADR-0140) | 읽기라 없음 | docs/features/payment.md §2 | 있음 |
| purchase-svc → payment-svc | `GetPayment`, `CancelPayment` | 조회, 취소(예매 취소·발권 실패 보상·일괄 환불) | `cancel-{cancellation_id}` | docs/features/payment.md §2.1, docs/features/transfer-refund.md §5 | 있음 |
| purchase-svc → payment-svc | `GetNewPaymentPause` | 새 결제 일시 정지 조회(홀드 만료 작업이 1초마다) | — | docs/features/payment.md §9, docs/features/seat-hold.md §5, ADR-0085 | 있음 |
| core-svc shop → payment-svc | `PrepareCheckout`, `ConfirmPayment`, `CancelPayment` | 굿즈·부가 상품 결제 | 같음 | docs/architecture.md §3.2 | 있음 |
| core-svc → payment-svc | `RegisterPayoutSeller` | 판매 승인 때 지급대행 판매자 등록 | — | docs/features/settlement.md | 있음 |
| ops-svc → payment-svc | `ApprovePayoutBatch` | 지급 묶음 승인 뒤 지급 요청 시작 | `batch_id` | docs/features/settlement.md | 있음 |
| purchase-svc → ticket-svc | `IssueTickets` | 발권(승인 뒤 실패하면 같은 주문 ID로 다시 보낸다, ADR-0106) | `order_id` | docs/features/payment.md §2·§3, docs/features/offline-gate.md §2 | 있음 |
| purchase-svc → ticket-svc | `CancelTickets` | 예매 취소 때 티켓 키 폐기와 상태 변경 | `cancellation_id` | docs/features/payment.md §4.1, docs/features/transfer-refund.md §3.1 | 있음 |
| core-svc review → ticket-svc | `CheckReviewEligibility` | 관람 후기 작성 자격 | — | docs/data.md(관람 후기), docs/architecture.md §3.1 | 있음(서비스 맵) |
| core-svc shop → ticket-svc | `ListHeldTickets` | 티켓 연동 부가 상품의 보유 확인 | — | docs/architecture.md §3.2 | 있음 |
| purchase-svc → identity-svc | `GetVerificationStatus` | 결제 직전 본인확인 재확인 | — | docs/features/identity.md, docs/features/payment.md §2 | 있음 |
| 소비자 웹 앱 서버(OIDC 클라이언트) → identity-svc | `CreateSession`, `EndSession` | 소셜 로그인 뒤 세션 생성(제공자 토큰은 보내지 않는다), 로그아웃. 받는 쪽 웨이포인트의 L7 허용 목록이 웹 앱 서버 서비스 계정만 `SessionService`로 들인다(추천 적용 2026-10-28, 기술 검토 중간-083) | `idempotency_key`(로그인 시도마다, 로그인 진행 쿠키 state의 HMAC. 다시 오면 같은 세션에 토큰만 다시 발급) | docs/features/identity.md §2 | 있음(gRPC 행에 합침, 2026-10-28) |
| queue-svc·identity-svc → trust-svc | `ScoreRisk` | 위험 판정(로비 입장·사전 검증·로그인) | — | docs/features/queue-admission.md §2·§7 | 있음 |
| trust-svc → queue-svc | `IsolateWaiting` | 대기 중 격리 | `event_key` | docs/streaming.md §5.5 | 있음 |
| ops-svc → purchase-svc | `PreviewEventRefund`, `StartEventRefund`, `GetEventRefundJob`, `PauseEventRefundJob`, `ResumeEventRefundJob` | 회차 취소 일괄 환불(결제사 몫마다 스스로 멈춤·수동 일시정지·재개, 기술 검토 중간-045) | `cancellation_request_id` | docs/features/transfer-refund.md §5 | 있음 |
| ops-svc → core-svc | `RecordSaleReviewResult`, `ApplyModeration` | 판매 승인 결과(공연 단위: 대상은 `production_id`이고, 승인이면 회차별 규모·공연장·아티스트·다른 이름을 openapi 승인 본문과 같게 싣는다, ADR-0093. 판매 중지·재개 `SUSPENDED`·`RESUMED`는 승인 업무를 실행할 때 부른다, ADR-0123), 게시물 조치(명령 10 포함) | — | docs/features/transfer-refund.md §2.1, docs/features/control-tower.md §5 | 있음 |
| ops-svc·비상 런북 Job → admission-ctrl 리더·purchase-svc 파드마다·queue-svc 파드마다·payment-svc 파드마다 | `ApplyControl` | 제어 상태 적용(명령 1·2·3·7·11과 명령 6의 대기열 진입, 명령 6의 대체 결제사 전환 `CONTROL_KIND_PG_SWITCH`(payment-svc는 payment DB `pg_switch`에, admission-ctrl 리더는 `q:{event:E}:ctl`에 판 번호와 함께 쓴다, 추천 적용 2026-10-29, ADR-0143 결정 1), 판매 승인의 판매 중지 `CONTROL_KIND_SALE_SUSPENSION`(ADR-0123)). 판 번호가 지금 것보다 클 때만 자기 저장소에 쓰고, 적용한 판 번호를 돌려준다 | `command_id`·`version`(판 번호) | docs/features/control-tower.md §3·§5, ADR-0102·0103·0143 | 있음(제어 gRPC 행) |

## 4. 이 초안에 넣지 않은 것

- 관제 스캐너 기기 관리(ops-svc → ticket-svc: 기기 등록 승인·폐기·등록 코드 새로 만들기). 기기 원장의 주인은 ticket-svc이고 ops-svc가 gRPC로 부른다(docs/architecture.md §3.2, 추천 적용 2026-10-29). 호출 모양은 구현 때 ticket.proto에 더한다.
- 온세일 일정 읽기(`freeze-calendar`·배경 작업 일정기)는 gRPC가 아니다. ops-svc가 S3에 쓰는 일정 파일 `ops-calendar/upcoming-onsales.json`을 읽는다(docs/devops.md §8.2, ADR-0145 상태 줄. ops-svc를 업무 gRPC 받는 쪽으로 만들지 않는다).

| 통신 | 이유 | 다음 |
| --- | --- | --- |
| Kafka 이벤트 스키마(Avro `.avsc`) | 정본은 asyncapi.yaml이고, Avro 원본은 `peaket-contracts`에 둔다고만 적혀 있다 | 초안은 docs/api/avro/에 있다(2026-10-22). 등록과 CI 연결은 wbs 0.2.2다 |
| 관제 지표 서버 스트리밍(ops-svc) | 2026-10-28 ADR-0100이 지웠다. 콘솔의 실시간 값은 SSE 흐름(asyncapi `sse.ops-live`·`sse.ops-event-live`)으로 받는다 | 더하지 않는다 |
| 주최 측 귀책 배상금 송금(purchase-svc → payment-svc) | 송금 포트는 정본에 있지만(ADR-0046) 결제사 송금 계약 전이다 | 결제사 계약 뒤 더한다 |
| 정산 계좌 변경 뒤 지급대행 등록 갱신 | 정본(docs/features/settlement.md)에 절차가 있지만 호출이 없다 | `RegisterPayoutSeller`를 다시 쓸지 정한 뒤 더한다 |
| 판매 승인 대기 건 등록(core-svc → ops-svc), 지급 요청 오류 알림(payment-svc → ops-svc) | 흐름도에 전달 방식이 없다. CS 처리함 건은 이벤트 `support.cases-requested`를 쓰는 길이 이미 있다 | 그 이벤트로 될지 먼저 검토한다 |
| 좌석 변경 전송(Redis 샤드 Pub/Sub)과 좌석 WebSocket | gRPC가 아니다 | asyncapi `ws.seat-delta`가 정본이다 |
| ops-svc 관리 API 뒤의 내부 호출: core-svc(support 모듈의 CS 건 상세 읽기·답변·진행 경과·문의 닫기, catalog 모듈의 홈 구성·아티스트·공연장·다른 이름 반영)와 ticket-svc(스캐너 기기 등록·폐기·등록 코드 새로 만들기. 기기 원장의 주인은 ticket-svc다) | 정본(docs/architecture.md §3.2 gRPC 행, 추천 적용 2026-10-29)과 openapi `/v1/ops/cases*`·`/v1/ops/home-layout`·`/v1/ops/artists*`·`/v1/ops/places*`·`/v1/ops/scanner-devices*` 설명에 흐름은 있지만 호출 모양이 없다 | 구현 때 core.proto·ticket.proto에 더한다 |
| core-svc 작업 워커 → image-worker 이미지 처리 맡기기(원본 키·종류 → 상태·파생본 키·폭·높이·거절 사유) | 정본(docs/architecture.md §3.2, 기술 검토 중간-068)에 호출이 있지만 초안을 미뤘다 | 구현 때 core.proto 옆에 더한다 |
| 계정 병합 확정 전 흡수 계정의 티켓·후기 수 확인(identity-svc → ticket-svc·core-svc review) | 정본(docs/data.md §4의 9번, POL-034)이 '0이 아니면 막는다'만 정했고 호출 모양이 없다. 통신 표에도 아직 없다 | 구현 때 ticket.proto·core.proto에 더한다 |
| Alertmanager → ops-svc 경보 웹훅, ops-svc → Alertmanager 경보 목록 API(억제 상태 30초 [가정]마다) | gRPC가 아니라 클러스터 안 HTTP이고 외부 계약(openapi)도 아니다(추천 적용 2026-10-29, ADR-0145 결정 9) | 정본은 docs/features/control-tower.md §13과 docs/data.md(ops 경보 기록 표)다. 받은 값은 asyncapi `OpsAlert`로 바꿔 콘솔에 보낸다 |
