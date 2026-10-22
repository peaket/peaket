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
  peaket/payment/v1/payment.proto        payment-svc: 결제창 준비·승인·조회·취소, 지급대행 판매자 등록, 지급 묶음 승인
  peaket/ticket/v1/ticket.proto          ticket-svc: 발권, 예매 취소, 후기 작성 자격, 보유 티켓 확인
  peaket/identity/v1/identity.proto      identity-svc: 결제 직전 본인확인 재확인
  peaket/trust/v1/trust.proto            trust-svc: 위험 판정
  peaket/queue/v1/queue.proto            queue-svc: 대기 중 격리
  peaket/purchase/v1/refund.proto        purchase-svc: 회차 취소 일괄 환불 작업
  peaket/core/v1/core.proto              core-svc: 판매 승인 결과, 게시물 조치
```

- 2026-10-22에 protoc(grpcio-tools 1.71.0)로 여덟 파일을 모두 컴파일해 문법·import·이름이 맞음을 확인했다(서비스 8개, 호출 19개). `buf lint`와 `buf breaking`은 아직 돌리지 않았다. CI 연결은 wbs 0.2.2다.

## 2. 규칙

| 항목 | 규칙 | 근거 |
| --- | --- | --- |
| 패키지와 폴더 | 패키지는 `peaket.<받는 서비스>.v1`이고 폴더 경로가 패키지와 같다 | buf STANDARD 형식 검사 |
| 버전 | 하위 호환이 깨지는 변경은 새 패키지(`v2`)로 낸다. 필드 번호는 다시 쓰지 않고, 지운 필드는 `reserved`로 막는다. `buf breaking`이 막는다 | docs/api/guidelines.md §1, docs/architecture.md §3.2 |
| 업무 결과와 오류 | 거절·대기 중 아님·입금 대기처럼 정상적인 업무 결과는 응답의 결과 값(enum)으로 돌려준다. 요청을 처리하지 못했을 때만 gRPC 상태 코드를 쓴다(아래 표) | 추천 적용 |
| 데드라인 | 부르는 쪽은 받은 데드라인의 남은 시간을 넘긴다. 남은 시간이 모자라면 시작하지 않고 `DEADLINE_EXCEEDED`로 끝낸다. 정본 값은 좌석 홀드 전체 40ms, 결제사 승인 2초, 주문-결제-발권 3초다. 나머지 호출의 값은 아직 정하지 않았고 측정 뒤 정한다 | docs/api/guidelines.md §5 |
| 재시도 | 앱 코드는 재시도하지 않는다. gRPC 라이브러리의 투명 재시도와 메시 재시도 예산(최대 1회)만 있다. 상태를 바꾸는 호출은 멱등 키로 같은 결과를 돌려준다 | docs/api/guidelines.md §5, ADR-0082 |
| 부르는 쪽 확인 | 메시 mTLS 신원(서비스 계정)으로 부르는 쪽을 확인하고, 허용 목록 밖이면 `PERMISSION_DENIED`다 | docs/infra.md §9 |
| 개인정보 | 계좌번호는 `RegisterPayoutSeller` 안에서만 쓰고 저장하지 않는다. 사람 확인 토큰은 저장하지 않고, 기기 식별값은 가명으로 바꾼 뒤에만 저장한다. 필드 주석에 적었다 | docs/security/data-classification.md, ADR-0053 |
| 주석 | 한국어로 쓴다. 정본 문서를 가리키고, 정본에 없는 값은 지어내지 않는다 | planning/03-policies-glossary.md §5 |

**gRPC 상태 코드(추천 적용 2026-10-22)**

| 코드 | 쓰는 때 | 부르는 쪽이 할 일 |
| --- | --- | --- |
| `INVALID_ARGUMENT` | 요청 모양이 틀렸다(필수 값 없음, 금액 0 이하) | 고쳐서 다시 보내지 않는다(버그) |
| `FAILED_PRECONDITION` | 상태가 맞지 않는다(활성 결제 시도가 아님, 결제사 불일치) | 자기 상태를 다시 읽는다 |
| `ALREADY_EXISTS` | 같은 멱등 키에 다른 내용이 왔다 | 버그로 보고 알린다 |
| `NOT_FOUND` | 대상이 없다 | 업무 규칙대로 처리한다 |
| `PERMISSION_DENIED` | 허용하지 않은 서비스가 불렀다 | 설정을 고친다 |
| `RESOURCE_EXHAUSTED` | 결제사 한도나 벌크헤드(의존성별로 나눈 연결 풀)가 찼다 | 기다렸다가 업무 재시도 규칙대로 한다 |
| `DEADLINE_EXCEEDED` | 남은 시간이 모자랐거나 시간을 넘겼다 | 서킷 브레이커와 대체 응답으로 간다 |
| `UNAVAILABLE` | 서비스나 그 의존성을 쓸 수 없다 | 서킷 브레이커와 대체 응답으로 간다(본인확인은 토큰 값으로 판정, ADR-0055) |

## 3. 호출 목록

'통신 표'는 docs/architecture.md §3.2에 그 호출이 적혀 있는지다. '없음'인 호출은 흐름도에만 있어 이 초안에서 처음 계약으로 적었다. 다듬기 반영 뒤 통신 표에 더한다.

| 부르는 쪽 → 받는 쪽 | 호출 | 하는 일 | 멱등 키 | 정본 흐름 | 통신 표 |
| --- | --- | --- | --- | --- | --- |
| purchase-svc → payment-svc | `PrepareCheckout` | 결제창 준비 | — | docs/features/payment.md §2·§2.2 | 있음 |
| purchase-svc → payment-svc | `ConfirmPayment` | 승인 | `confirm-{order_id}` | docs/features/payment.md §2·§2.1 | 있음 |
| purchase-svc → payment-svc | `GetPayment`, `CancelPayment` | 조회, 취소(예매 취소·발권 실패 보상·일괄 환불) | `cancel-{cancellation_id}` | docs/features/payment.md §2.1, docs/features/transfer-refund.md §5 | 있음 |
| core-svc shop → payment-svc | `PrepareCheckout`, `ConfirmPayment`, `CancelPayment` | 굿즈·부가 상품 결제 | 같음 | docs/architecture.md §3.2 | 있음 |
| core-svc → payment-svc | `RegisterPayoutSeller` | 판매 승인 때 지급대행 판매자 등록 | — | docs/features/settlement.md | 없음 |
| ops-svc → payment-svc | `ApprovePayoutBatch` | 지급 묶음 승인 뒤 지급 요청 시작 | `batch_id` | docs/features/settlement.md | 없음 |
| purchase-svc → ticket-svc | `IssueTickets` | 발권 | `order_id` | docs/features/payment.md §2, docs/features/offline-gate.md §2 | 있음 |
| purchase-svc → ticket-svc | `CancelTickets` | 예매 취소 때 티켓 키 폐기와 상태 변경 | `cancellation_id` | docs/features/payment.md §4.1, docs/features/transfer-refund.md §3.1 | 없음 |
| core-svc review → ticket-svc | `CheckReviewEligibility` | 관람 후기 작성 자격 | — | docs/data.md(관람 후기), docs/architecture.md §3.1 | 있음(서비스 맵) |
| core-svc shop → ticket-svc | `ListHeldTickets` | 티켓 연동 부가 상품의 보유 확인 | — | docs/architecture.md §3.2 | 있음 |
| purchase-svc → identity-svc | `GetVerificationStatus` | 결제 직전 본인확인 재확인 | — | docs/features/identity.md, docs/features/payment.md §2 | 있음 |
| queue-svc·identity-svc → trust-svc | `ScoreRisk` | 위험 판정(로비 입장·사전 검증·로그인) | — | docs/features/queue-admission.md §2·§7 | 있음 |
| trust-svc → queue-svc | `IsolateWaiting` | 대기 중 격리 | `event_key` | docs/streaming.md §5.5 | 있음 |
| ops-svc → purchase-svc | `PreviewEventRefund`, `StartEventRefund`, `GetEventRefundJob`, `ResumeEventRefundJob` | 회차 취소 일괄 환불 | `cancellation_request_id` | docs/features/transfer-refund.md §5 | 없음 |
| ops-svc → core-svc | `RecordSaleReviewResult`, `ApplyModeration` | 판매 승인 결과, 게시물 조치(명령 10 포함) | — | docs/features/transfer-refund.md §2.1, docs/features/control-tower.md §5 | 없음 |

## 4. 이 초안에 넣지 않은 것

| 통신 | 이유 | 다음 |
| --- | --- | --- |
| 제어 평면 TCP 채널(ops-svc·비상 런북 Job → admission-ctrl·purchase-svc·queue-svc) | 정본이 'IDL 없이 단순 바이너리 프로토콜'로 정했다(docs/features/control-tower.md §5). 장애 복구(모든 대상의 ack, 같은 명령 ID로 다시 보냄, 비상 런북)는 정본에 있지만 메시지 모양과 버전은 없다 | 계약 저장소에서 메시지 모양과 버전을 정한다. proto로 바꿀지는 그때 새 ADR로 정한다 |
| Kafka 이벤트 스키마(Avro `.avsc`) | 정본은 asyncapi.yaml이고, Avro 원본은 `peaket-contracts`에 둔다고만 적혀 있다 | wbs 0.2.2에서 만든다 |
| 관제 지표 서버 스트리밍(ops-svc) | 통신 표에 이름만 있고 받는 쪽과 필드가 없다 | 받는 쪽을 정한 뒤 더한다 |
| 웹·파트너 앱 서버 → identity-svc 세션 생성 | 통신 표에 gRPC가 아니라 '메시 mTLS 내부 호출'로 따로 적혀 있다 | 형식을 정한 뒤 더한다 |
| 판매 승인 대기 건 등록(core-svc → ops-svc), 지급 요청 오류 알림(payment-svc → ops-svc) | 흐름도에 전달 방식이 없다. CS 처리함 건은 이벤트 `support.cases-requested`를 쓰는 길이 이미 있다 | 그 이벤트로 될지 먼저 검토한다 |
| 좌석 변경 전송(Redis 샤드 Pub/Sub)과 좌석 WebSocket | gRPC가 아니다 | asyncapi `ws.seat-delta`가 정본이다 |
