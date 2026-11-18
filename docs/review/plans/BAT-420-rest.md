# 작업 계획: BAT-420-rest(GAT-090·GAT-110의 남은 서버 몫)

- **무엇**: BAT-420(갈래 3, 등급 A, 단계 GAT-090·GAT-110)의 단계 줄 '남은 것' 가운데 이 갈래가 할 서버 몫의 작업 목록이다. 앞 웨이브의 계획·기록은 docs/review/plans/BAT-420.md(400KB가 넘어 새 파일로 나눴다)다. 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane3-b420`, 가지 `feature/lane3-BAT-420`, 출발점 `a8076fad`(합치기를 기다리는 BAT-408 머리. BAT-408이 develop에 들어간 뒤 감독이 다시 올린다). 2026-11-19 계획 담당 `l3-b420-plan`(claude-opus-5-5)이 썼고 시험·제품 코드는 쓰지 않았다. 지시서는 `node tools/ci/brief.mjs --batch BAT-420`(만든 때 `a8076fad`)다.
- **묶음 ID와 차례**: 묶음 ID는 이 파일 이름 `BAT-420-rest`다(장부 범위는 BUILD_ORDER BAT-420 줄). 정방향 묶음이다(이 계획 커밋에 `Batch-Order: impl-first`). 차례는 계획 → 구현 → 시험(구현을 맡지 않은 시험 담당, 구현 전 트리와 이 계획 커밋에서 실패 확인) → 리뷰 → 리뷰 반영 → 검증 → 기록이다. A 등급이라 짧은 고리를 쓰지 않는다(docs/architecture.md §8.6 '역할 나누기', ADR-0283 결정 2).
- **정본**: 이 커밋에서 먼저 고쳤다(아래 §6). docs/features/payment.md §6 '가상계좌 환불 계좌 전달의 첫 구현'(새 문단)·§11 P-T71·P-T72(새 줄), docs/features/transfer-refund.md §5 'core 회차 상태 반영'(새 두 줄)·§11 R-T40·R-T41(새 줄), docs/security/asvs/transfer-refund.md 'BAT-420-rest 계획 메모', docs/BUILD_ORDER.md BAT-420 줄 '장부 범위'에 `P-T71, P-T72, R-T40, R-T41`. 계약 파일(docs/api의 openapi·proto)은 생성물과 함께 바꿔야 해서 구현 담당이 §4대로 고친다.

## 계획

### 1. 크기와 나누기

**남은 몫 어림(WBS 일, 모두 [가정])**

| 몫 | 단계 | 무엇 | 어림 | 할 곳 |
| --- | --- | --- | --- | --- |
| V | GAT-090 | 가상계좌 환불 계좌 전달(payment-svc 계약·결제사 어댑터·시뮬레이터, purchase-svc 견적·취소·재시도·일괄 환불의 계좌 규칙과 계좌 대기 CS 건) | 0.8 | 이 묶음 |
| K | GAT-110 | core 회차 상태 반영과 검색 동기화(SR-T8 ③): core-svc 내부 HTTP, ops-svc 호출·다시 하기 | 0.4 | 이 묶음 |
| S1 | GAT-090 | 취소 화면 SCR-038 잇기(견적·`refundAccountRequired`·재인증 `purpose` 둘·취소·결과 상태, 403·503·422 문구, docs/frontend.md §4.3 503 `reauth-unavailable` 줄) | 0.4 | 화면 묶음 |
| S2 | GAT-110 | SCR-044 파트너 회차 취소·연기 요청과 상태, SCR-047 관제 판정·미리보기·확정·진행률 잇기 | 0.5 | 화면 묶음 |
| W | GAT-090 | 탈퇴 참여자의 가상계좌 몫(docs/planning/03 §1.5 ⑤의 나머지: 지금 환급할 표는 탈퇴 본문의 계좌를 넘기고, 지금 못 하면 탈퇴를 미룸) | 0.25 | 나눈 묶음 |
| — | — | 합계 | 2.35 | — |

- 단계 줄 WBS(GAT-090 1.75 + GAT-110 1.65 = 3.4)에서 이미 한 몫(R-547·R-552·R-673·BAT-415-reauth)을 빼고 남은 일을 어림했다. 5일 [가정]은 넘지 않는다. 그래도 한 묶음으로는 무겁다. 서비스 다섯(payment·purchase·ops·core·identity)과 앱 셋(apps/web·apps/partner·apps/console-host)에 걸치고, 화면은 갈래 2 영역(ADR-0286)이며, W는 다른 갈래 단계(PRF-174)가 먼저다.
- **나누기 결정(2026-11-19 전체 감독 승인, docs/lanes/coord.md, develop `dcd69477`)**: BAT-421은 갈래 2로 BUILD_ORDER '기능 묶음' 표에 BAT-420 바로 뒤에 더했고(wbs.csv에는 더하지 않음, 기존 몫을 나눔), W는 안 (가)대로 PRF-174로 옮겼다(GAT-090·GAT-110·PRF-174 단계 줄에 한 구절씩). 아래는 처음 낸 안이다.
- **나누기 안(처음 낸 것)**:
  - **BAT-420-rest(이 파일, 갈래 3, A)**: V·K. 1.2일 [가정]. 선행 없음(BAT-415-reauth·BAT-010은 develop에 있다. BAT-408은 합치기 대기이고 이 몫은 그 코드에 닿지 않는다).
  - **BAT-421(새 묶음, A, 화면)**: S1·S2와 브라우저 확인(대본 `docs/review/browser-check/` 아래 `GAT-090-GAT-110.md`, d5 §5.20·§6.12·§7.8과 R-T36·R-T37·R-T39·P-T72로 만든다). 0.9일 [가정]. 선행 BAT-420-rest(견적·취소 응답의 `refundAccountRequired`, 422 `refund-account-required`가 계약에 들어가야 화면을 잇는다)와 BAT-408(ADR-0293 `purpose`). 안: 갈래 2가 한다(ADR-0286 화면 영역. 갈래 3이 하면 web 잡 아홉과 첫 JS 예산을 이 갈래가 처음 재야 하고, 갈래 2의 화면 묶음과 같은 앱 파일이 겹친다).
  - **BAT-422(새 묶음, A, 서버)** 또는 **PRF-174에 합치기**: W. 0.25일 [가정]. 선행 PRF-174(BAT-013, 갈래 1, 탈퇴 참여자의 미사용 티켓 취소)와 BAT-420-rest. 지금은 탈퇴가 표를 취소하지 않아 계좌를 넘길 호출이 없다(docs/features/identity.md §8 '탈퇴 참여자와 탈퇴 미룸의 첫 구현'의 남는 한계). 안 (가) 추천: PRF-174에 합친다(같은 참여자 호출·같은 파일, identity → purchase 참여자 계약 `account.proto`에 계좌 칸을 한 번만 더한다. 0.25일을 GAT-090에서 PRF-174로 옮긴다). 안 (나): 갈래 3 BAT-422로 BAT-013 뒤에 한다.
- **감독이 갈래 2에 전달할 문안(한 단락)**: "BAT-420(갈래 3)의 화면 몫을 새 묶음 BAT-421(등급 A)로 나눠 갈래 2에 넘기려 합니다. 할 일은 SCR-038 예매 취소 화면(견적의 새 칸 `refundAccountRequired`가 참일 때만 계좌 입력 ⑦을 보이고, 재인증 시작 때 계좌가 없으면 `purpose` `ticket-cancel`, 있으면 `ticket-cancel-refund-account`, 재인증을 한 번만 하도록 계좌 입력을 재인증 앞에 두며, 403 `reauth-required`·503 `reauth-unavailable`·422 `refund-account-required` 문구와 202 `REFUND_PENDING`의 `refundAccountRequired` 참일 때 SCR-060 안내, docs/frontend.md §4.3 오류 표에 503 `reauth-unavailable` 줄), SCR-044 파트너 회차 취소·연기 요청과 상태, SCR-047 관제 판정·미리보기·2인 확정·진행률을 이미 있는 서버 계약(ops-svc, R-T36·R-T37)에 잇는 일입니다. 선행은 BAT-420-rest(갈래 3, 가상계좌 계좌 규칙과 계약 칸, 이 묶음 합치기 뒤)와 BAT-408(ADR-0293)이고 어림 0.9일 [가정]입니다. 정본은 d5 §5.20·§6.12·§7.8, docs/frontend.md §4.1·§4.3, docs/features/transfer-refund.md §3.1·§5, docs/features/payment.md §6 '가상계좌 환불 계좌 전달의 첫 구현'입니다. 브라우저 확인 대본 자리는 `docs/review/browser-check/` 아래 `GAT-090-GAT-110.md`입니다."

### 2. 범위

| 구분 | 내용 |
| --- | --- |
| 장부 범위(BAT-420) | `R-T23 ⑤⑥, R-T24, R-T36, R-T37, R-T38, P-T19 ①③, SR-T8 ③, P-T71, P-T72, R-T40, R-T41`(이 커밋에서 뒤 넷을 더함). `node tools/ci/ledger.mjs --batch BAT-420`: 항목 48개(자동 시험 26, 다른 단계 1 = SR-T8 ③, 빈칸 21 = 새 넷의 세부), 등급 A 47·B 1 |
| 이 몫이 판정할 항목 | P-T71 ①~⑥, P-T72 ①~⑥, R-T40 ①~④(몫 V), R-T41 ①~⑤와 SR-T8 ③(몫 K). SR-T8 ③은 ledger-notes·search.md의 '다른 단계(LCH-090·GAT-110)'이고 이 몫이 GAT-110 쪽을 시험으로 채운다. 판매 중지(LCH-090) 쪽이 남아 있어 상태는 다른 단계로 남을 수 있다(검증 담당이 장부로 본다) |
| 회귀(고치지 않고 돌린다) | R-T23 ⑤⑥·R-T24·R-T36·R-T37·R-T38·P-T19 ①③(앞 웨이브), R-T39(BAT-415-reauth), P-T21(결제 후 일반 취소의 기대 잔액), P-T55(탈퇴 참여자의 입금 전 취소) |
| 범위 밖 | 화면 S1·S2(→ BAT-421 안), 탈퇴 W(→ PRF-174 또는 BAT-422 안), 지연 환급 계좌 다시 받기 `POST /v1/cancellations/{cancellationId}/account`와 그 멱등키·알림(→ GAT-130, BAT-425), core `entry_closed_at`(→ GAT-180), 입금 대기·발권 대기 주문 정리(→ PRF-173), 판매 중지·재개의 검색 동기화(→ LCH-090), 계좌 대기 건의 CS 처리(→ GAT-280) |

### 3. 바른 동작

**몫 V(정본 docs/features/payment.md §6 '가상계좌 환불 계좌 전달의 첫 구현')**

| # | 동작 | 정본 근거 |
| --- | --- | --- |
| V1 | payment-svc는 그 결제에 수출 사건 `AWAITING_DEPOSIT`이 있으면 가상계좌 결제로 본다. `GetPayment`에 `virtual_account_paid` | §6 '가상계좌였는지' |
| V2 | `CancelPaymentRequest.refund_account`(선택)·결과 `CANCEL_RESULT_REFUND_ACCOUNT_REQUIRED`. 계좌는 어디에도 저장·기록하지 않는다 | §6 '계약', ADR-0050 결정 3 |
| V3 | 결제 후 일반 취소 + 가상계좌 + 계좌 있음 → 결제사 본문에 계좌. 토스 모양·포트원 각각 | §6 '결제 후 일반 취소의 가상계좌 갈래', §2.1 |
| V4 | 계좌 없음 + `payment_cancel` 행 없음 → 결제사 0·행 0·`REFUND_ACCOUNT_REQUIRED` | 같은 곳 |
| V5 | 계좌 없음 + 행 있음(앞서 계좌를 실어 보냄) → 결제사 취소 호출 0, 조회 1. 반영이면 `CANCELLED`(행 끝냄), 아니면 행 그대로 `REFUND_ACCOUNT_REQUIRED` | 같은 곳, §4.1 '취소 건 기록과 기대 잔액' |
| V6 | 결제사 계좌 거절 → 행 `FAILED`, `REFUND_ACCOUNT_REQUIRED`. 카드 결제에 온 계좌 → 버림·지표 | 같은 곳 |
| V7 | 견적 `refundAccountRequired` = 가상계좌 ∧ 입장 시작 전. `GetPayment` 실패 → 503 `dependency-unavailable` | §6 'purchase-svc 견적' |
| V8 | 예매 취소: 재인증 뒤 Saga 앞에서 다시 읽고, 필요한데 없으면 422 `refund-account-required`(Saga 0), 읽기 실패 503(Saga 0), 미루는 취소·카드 결제의 계좌는 버리고 접수 | §6 'purchase-svc 예매 취소', openapi `createTicketCancellation` 설명 |
| V9 | `REFUND_ACCOUNT_REQUIRED` 답 → 취소 행 `REFUND_PENDING`·`next_refund_at` 빔·`refund_account_required_at`, 재시도·자동 정지 셈 밖, 응답 `refundAccountRequired` 참 | §6 '계좌 대기' |
| V10 | CS '환불 대기'(`REFUND_ACCOUNT_PENDING`) 건은 틱 끝 다시 열기의 다섯째 종류(환급 실패 다음), 2xx 뒤에만 `refund_account_case_opened_at` | §6 '계좌 대기', transfer-refund §3.1 ⑥ |
| V11 | 회차 취소 일괄 환불의 가상계좌 항목 → `ACCOUNT_PENDING`, 다시 보내지 않음, COMPLETED 셈에서 끝난 항목, 진행 합계에 따로 | §6 '계좌 대기', transfer-refund §11 R-T40 |

**몫 K(정본 docs/features/transfer-refund.md §5 'core 회차 상태 반영')**

| # | 동작 | 정본 근거 |
| --- | --- | --- |
| K1 | 확정이 Start까지 끝낸 뒤 ops-svc가 core-svc `POST /internal/v1/events/{eventId}/cancellation-status`(요청 ID·종류·연기 시작)를 부른다 | §5 'core 회차 상태 반영', ADR-0280 결정 6 |
| K2 | core-svc 한 트랜잭션: CANCELLED(연기면 POSTPONED와 바뀐 시작) + `withSearchSync`. 공연이 빠지면 커밋 뒤 `/v1/search*` 무효화 1번·`search_removed`(이유 `EVENT_CANCELLED`) | 같은 곳, search §2.3 '구현 자리', SR-T8 ③ |
| K3 | 멱등: 같은 상태면 204·바뀐 것 0·무효화 0. 404 `not-found`, 409 `event-status-conflict`, 400 `invalid-body`, 401(공유 토큰) | 같은 곳 |
| K4 | 실패해도 확정은 그대로. `core_applied_at` 빔 → 1분 다시 하기(20건), 성공 때 칸 씀. 실패 경고·지표, 10분 넘으면 SEV2 한 번(`core_apply_overdue_at`) | §5 둘째 줄 |
| K5 | 연기는 판매를 멈추지 않는다(지금 그대로). core 반영만 한다 | ADR-0280 결정 1 |

### 4. 손댈 파일과 공개 인터페이스(구현 담당)

| 파일 | 할 일 | 공개 인터페이스 |
| --- | --- | --- |
| `docs/api/proto/peaket/payment/v1/payment.proto` | V1·V2 | `GetPaymentResponse.virtual_account_paid = 9`(bool). `message RefundAccount { string bank_code = 1; string account_number = 2; string holder_name = 3; }`, `CancelPaymentRequest.refund_account = 6`, `CancelResult.CANCEL_RESULT_REFUND_ACCOUNT_REQUIRED = 5`. 주석에 '저장·기록하지 않는다' |
| `docs/api/openapi.yaml` | V7·V8·V9 | `CancellationQuote.refundAccountRequired`(bool), `Cancellation.refundAccountRequired`(bool, 선택), `createTicketCancellation` 422(`refund-account-required`)·503(`dependency-unavailable`) 설명, `getCancellationQuote` 503. 이미 있는 `refund-account-required` 유형을 쓴다 |
| 생성물 `packages/contracts`·`packages/api-client` | proto·openapi를 바꿨으므로 다시 만든다 | 생성물만 |
| `services/payment-svc/src/modules/payment/domain/payment-gateway.ts` | 결제사 포트 `cancel` 입력에 계좌 | `cancel(c: { …; refundAccount?: { bankCode: string; accountNumber: string; holderName: string } })`. `CancelResult`에 계좌 거절을 나타낼 값(예 `{ kind: 'REJECTED', reason: 'REFUND_ACCOUNT_INVALID' }`, 모양은 구현이 정함) |
| `…/adapters/pg/toss-gateway.ts`·`toss-shaped.ts`·`portone-gateway.ts`·`simulator-gateway.ts` | V3·V6. 계좌 칸 이름과 거절 코드는 공식 문서와 대조해 머리 주석에 날짜와 함께 적는다 | — |
| `services/pg-simulator/src/server.ts` | 가상계좌 결제의 취소에 계좌가 없으면 업무 거절, 형식이 틀린 계좌(시험용 규칙, 예 계좌번호 `000`으로 시작)는 계좌 거절 | 시뮬레이터 동작만 |
| `…/application/cancel-confirmed-payment.ts`·`cancel-payment.ts`, `…/adapters/db/drizzle-confirm-jobs.ts`(또는 `payment_cancel` 저장소) | V1·V4·V5·V6. 가상계좌 판정은 결제 행 잠금 안에서 `payment_event` 한 번 읽기 | 저장소에 `hasDepositEvent(tx, paymentId): Promise<boolean>`(이름은 구현이 정함) |
| `…/application/get-payment-detail.ts`, `…/inbound/payment.grpc.ts` | V1·V2 응답·요청 칸 | — |
| `services/purchase-svc/src/modules/refund/domain/ports.ts`, `…/adapters/grpc-payment-cancellations.ts` | V2. `PaymentCancelOutcome`에 `REFUND_ACCOUNT_REQUIRED`, 계좌를 proto로 싣기. 결제 수단 읽기 포트 | `export interface PaymentMethodLookup { virtualAccountPaid(q: { orderId: string; deadlineMs: number }): Promise<boolean> }`(실패는 던진다) |
| `…/application/quote-cancellation.ts`, 견적 컨트롤러 | V7 | `CancellationQuoteView.refundAccountRequired: boolean`. 실패 → 503 `dependency-unavailable` |
| `…/inbound/ticket-cancellation.controller.ts`, `…/application/cancel-ticket.ts` | V8·V9. 차례: 인증 → 멱등 키 → 구매 서명 → 본문 → 재인증 → 결제 수단 읽기·계좌 규칙 → Saga | `CancelTicketResult`에 `refundAccountRequired` |
| `…/application/refund-retry-loop.ts`·`refund-after-entry.ts` | V9. 계좌 대기 행을 집지 않는다(`refund_account_required_at IS NULL`) | — |
| `…/application/cs-case-reopen.ts`, 새 `…/adapters/http-refund-account-notice.ts` | V10. ops-svc CS 내부 HTTP(kind `REFUND_ACCOUNT_PENDING`, 지금 `HttpRefundFailureNotice`와 같은 꼴), 지표 kind `REFUND_ACCOUNT_PENDING` | — |
| `…/application/event-refund-service.ts`·`event-refund-loop.ts`, `…/adapters/db/drizzle-event-refund-store.ts` | V11. 항목 상태 `ACCOUNT_PENDING`, 진행 합계 `accountPending` | `GetEventRefundJob` 답에 계좌 대기 수(refund.proto 칸 하나, 구현이 이름을 정함) |
| `services/purchase-svc/migrations/0029_refund_account_pending.sql`(번호 감독 확정 2026-11-19. Drizzle journal `meta/_journal.json`의 `when`은 develop의 마지막 항목보다 커야 한다) | `order_cancellation.refund_account_required_at`·`refund_account_case_opened_at`(CHECK: 연 시각은 표시 없이 쓰지 않음), `event_refund_item_status_check`에 `ACCOUNT_PENDING`, 다시 열기 부분 인덱스 | — |
| `services/core-svc/src/modules/catalog/inbound/internal-sale-config.controller.ts`(같은 `internal/v1/events` 컨트롤러) 또는 새 컨트롤러 | K1·K3. 같은 공유 토큰 가드 | `POST /internal/v1/events/:eventId/cancellation-status` 본문 `{ requestId: uuid, kind: 'CANCEL' \| 'POSTPONE', postponedTo?: ISO 시각 }`(모르는 칸 400) → 204 |
| 새 `services/core-svc/src/modules/catalog/application/apply-event-cancellation-status.ts`, 저장소(drizzle·memory) | K2·K3. `withSearchSync({ reason: 'EVENT_CANCELLED', … })` 안에서 회차 행 잠금·상태 확인·쓰기, 바뀐 공연 ID 돌려줌 | `export class ApplyEventCancellationStatus { execute(i: { eventId: string; requestId: string; kind: 'CANCEL' \| 'POSTPONE'; postponedTo?: Date }): Promise<'APPLIED' \| 'UNCHANGED'> }`, 오류 `EventNotFound`·`EventStatusConflict` |
| 새 `services/ops-svc/src/adapters/http-core-event-status.ts`, `…/event-cancellations/domain/ports.ts` | K1. `http-core-event-owners.ts`와 같은 꼴(`createExternalHttpClient`, 3초) | `export interface CoreEventStatus { apply(q: { eventId: string; requestId: string; kind: 'CANCEL' \| 'POSTPONE'; postponedTo?: Date }): Promise<void> }`(실패는 던진다) |
| `services/ops-svc/src/modules/event-cancellations/application/event-cancellations.ts` | K1·K4. approve가 Start 뒤에 부르고, 실패는 삼켜 경고·지표만. 다시 하기 쓰임새 `retryCoreApply(now)` | — |
| `services/ops-svc/src/event-cancellation-wiring.ts`(또는 시작 조립) | K4 고리(1분, `FOR UPDATE SKIP LOCKED` 잡기 뒤 미루기, 파드 여럿 안전). 주소 `PEAKET_CORE_HTTP_URL`이 없으면 local·ci만 대역, 그 밖은 시작 실패(판매 설정 읽기와 같은 규칙) | — |
| `services/ops-svc/migrations/0016_event_cancellation_core_applied.sql`(번호 감독 확정 2026-11-19. journal `when`은 develop의 마지막 항목보다 커야 한다) | `event_cancellation_request.core_applied_at`·`core_apply_overdue_at`, 다시 하기 부분 인덱스 | — |
| 메시 허용 원천 `deploy/platform/mesh/port-allow.yaml`(BAT-061이 만든 원천 하나)과 생성물 `deploy/platform/mesh/policies.yaml`·`meshless-networkpolicies.yaml` | ops-svc → core-svc 줄에 `/internal/v1/events/{eventId}/cancellation-status`를 더하고, **같은 커밋에서** `node tools/ci/mesh-policies.mjs --write`로 생성물을 다시 만든다(`--check`가 CI에서 견준다). ADR-0285 결정 9 표 줄도 사실대로 더한다. 주의: 갈래 1이 같은 원천·생성물을 고칠 수 있다. 합칠 때 겹치면 원천을 합친 뒤 생성물은 손으로 합치지 말고 다시 만든다(ops→core 내부 HTTP는 2026-11-19 감독 승인) | — |
| docs/api/guidelines.md §8.1 | core-svc 회차 상태 반영 행(실패 모양·무게) | — |

### 5. 판정 항목마다 쓸 시험(시험 담당, 구현 뒤에 쓰고 구현 전 트리에서 실패를 본다)

- 단언 값은 정본에서 가져온다: 결과 이름·문제 유형·상태는 payment §6·openapi, 다시 하기 간격 1분·20건·10분·3초와 이유 `EVENT_CANCELLED`는 transfer-refund §5, 무효화 경로 `/v1/search*`는 search §2.3. 시험의 시계 값은 코드 상수와 다르게 고른다(예 다시 하기 경계는 확정 + 9분 59초·10분, 자주 놓친 결함).
- 계좌 글 누설 검사는 시험 계좌번호를 다른 값과 겹치지 않는 글(예 `110-987-654321`)로 두고 DB 전체 행·로그 수집기·Outbox 본문에서 그 글을 찾는다.

| 시험(이름은 ID로 시작) | 종류·파일 | 단언 | 판정 기준의 정본 |
| --- | --- | --- | --- |
| `P-T71 ①~⑥ …` | 통합, 새 `services/payment-svc/test-int/payment-cancel-refund-account.int.test.ts`(실제 PostgreSQL, 결제사 기록 대역) + 단위 `test/cancel-confirmed-payment-refund-account.test.ts` | ① 토스 모양·포트원 본문의 계좌 칸 값과 DB·Outbox에 계좌 글 0 ② 결제사 호출 0·`payment_cancel` 0행·결과 ③ 결제사 취소 0·조회 1, 조회 답 둘(반영·아님)에 각각 결과와 행 상태 ④ 행 `FAILED` ⑤ 본문에 계좌 칸 없음·지표 +1 ⑥ 입금 확정·부분 취소 뒤 참, 카드·만료 거짓 | payment §11 P-T71, §6 |
| `P-T72 ①~⑥ …` | 단위 HTTP, 새 `services/purchase-svc/test/cancel-refund-account-http.test.ts`(BAT-415-reauth의 `fan-reauth-fixtures.ts` 재인증 대역) + 통합 `test-int/cancellation.int.test.ts`에 계좌 대기·다시 열기 | ① 견적 세 경우·503 ② 422·503과 ticket·payment `cancel` 0·`writes.create` 0 ③ 대역이 받은 계좌, 입장 시작 뒤 취소와 재시도 실행기 호출에 계좌 없음 ④ 202 본문·행 칸·`refund_attempts` 그대로·다음 틱 집기 0 ⑤ ops 대역 2xx·5xx 차례, 연 시각, 환급 실패 건 뒤 차례 ⑥ 로그·Outbox·행에 계좌 글 0 | payment §11 P-T72, §6 |
| `R-T40 ①~④ …` | 통합, `services/purchase-svc/test-int/event-refund.int.test.ts`에 더함(실제 payment-svc는 대역 gRPC 서버로 `REFUND_ACCOUNT_REQUIRED`를 돌려줌. 실제 payment-svc까지 잇는 것은 선택) + 단위 `test/event-refund-account-pending.test.ts` | ① 항목·행 상태 ② CS 건 수(틱 두 번에도 1), ops 내려감 뒤 다시 열기 ③ 자동 정지 셈 입력에 계좌 대기 0, 다음 틱 결제사 호출 0 ④ COMPLETED와 `accountPending` 2 | transfer-refund §11 R-T40 |
| `R-T41 ①~⑤ …`, `SR-T8 ③ 회차 전부 취소가 같은 트랜잭션에서 검색을 고치고 커밋 뒤 무효화와 search_removed를 남긴다` | core 통합, `services/core-svc/test-int/search-read-model.int.test.ts`에 더함(실제 PostgreSQL, CDN 대역·로그 수집) + ops 단위 `services/ops-svc/test/event-cancellation-core-apply.test.ts`(가짜 시계, core 대역) | ① 회차 하나 취소 뒤 공연이 검색에 있음·무효화 0, 둘째 뒤 빠짐·무효화 1·줄 1(이유) ② 같은 요청 다시: 0·0·0 ③ core 대역 실패 → 확정 202·칸 빔, 살아남 → 다시 하기 1번·칸 씀, 9분 59초 SEV2 0·10분 1·그 뒤 0 ④ POSTPONED·바뀐 시작, 판매 멈춤 호출 0 ⑤ 404·409·401과 core 쓰기 0. SR-T8 ③: 트랜잭션을 되돌리면(작업 안에서 던짐) 검색이 그대로이고 무효화 0 | transfer-refund §11 R-T41, search §12 SR-T8 ③ |
| `R-T41 ③ 시작 조립 …` | 단위, ops 시작 조립 | `PEAKET_CORE_HTTP_URL` 없음에 `PEAKET_ENV` prod·staging·demo·없음 → 시작 실패, local·ci → 대역과 경고 1 | §5 'core 회차 상태 반영', 자주 놓친 결함 '시작 파일 조립' |

- 회귀: `services/purchase-svc/test/cancel-reauth-http.test.ts`(R-T39), `test/cancel-ticket.test.ts`(R-T3·R-T4, 카드 결제는 계좌 규칙이 바꾸지 않는다), `test/event-refund*.test.ts`, `test-int/event-cancel-r-t24.int.test.ts`, payment-svc `test-int/*cancel*`(P-T21), `test-int/withdrawal*`(P-T55), ops `test/event-cancellation-*.test.ts`·`test-int/event-cancellations.int.test.ts`. 결제 수단 읽기 포트가 생겨 기존 단위 시험의 조립이 깨지면, 대역 기본값(카드)을 구현 쪽 조립 도우미에 둔다(시험 파일은 구현 담당이 고치지 않는다).
- 구현 전 트리에서 실패를 볼 수 없는 단언(카드 결제의 회귀, K3의 404)은 검증의 틀린 구현(아래 M)으로 실패를 한 번 본다.

### 6. 정본 빈칸과 정한 것(이 커밋에서 정본에 씀, 모두 '추천 적용, 2026-11-19')

| 빈칸 | 정한 것 | 쓴 곳 |
| --- | --- | --- |
| 결제 원장에 '가상계좌였다'는 칸이 없다(BAT-420.md §1 V의 까닭 ②) | 수출 사건 `AWAITING_DEPOSIT`이 있으면 가상계좌. 새 칸·마이그레이션 없음 | payment §6 |
| 계좌가 든 첫 본문과 계좌 없는 재시도(같은 멱등키 = 같은 본문) | 계좌 없는 재시도는 결제사에 보내지 않고 조회로만 끝을 본다. 다른 계좌로 다시 보내는 멱등키는 GAT-130 | payment §6 |
| 화면이 계좌 입력을 보일지 알 길(견적에 결제 수단이 없다) | 견적 `refundAccountRequired`, 서버가 정한다 | payment §6(openapi는 구현이 고친다) |
| 지금 환급인데 계좌가 없을 때 | Saga 앞 422 `refund-account-required`(이미 있는 유형) | payment §6 |
| 계좌 대기 상태와 CS '환불 대기' 건 여는 곳 | 취소 행 표시 두 칸, 틱 끝 다시 열기의 다섯째 종류, 일괄 환불 항목 `ACCOUNT_PENDING` | payment §6, transfer-refund §11 R-T40 |
| core 회차 상태를 쓰는 길(ADR-0280 결정 6은 '뒤에 붙인다'만) | ops-svc → core-svc 내부 HTTP, Start 뒤, 실패는 확정을 되돌리지 않고 다시 하기 | transfer-refund §5 |
| 판정 항목 | P-T71·P-T72·R-T40·R-T41을 만들고 BAT-420 장부 범위에 더함 | payment §11, transfer-refund §11, BUILD_ORDER BAT-420 '장부 범위' |
| ASVS 대조 | 14.2.4·16.2.5·15.4.2·2.2.1·2.3.1·8.3.1·4.4.1 메모 | asvs/transfer-refund.md |

- 방향을 바꾸는 결정이 없어 ADR은 쓰지 않았다(0294는 쓰지 않았다). 가상계좌 규칙은 POL-014·ADR-0050 결정 3을, core 반영은 ADR-0280 결정 6을 구현 자리까지 내린 것이다. core-svc에 gRPC 서버를 새로 두지 않고 내부 HTTP를 쓴 것은 docs/architecture.md §3.2 REST 행이 이미 적은 '내부 HTTP' 갈래(판매 설정 읽기·정산 원천)를 따른 것이다. 감독이 gRPC가 맞다고 보면 이 줄만 바꾸면 된다(호출 모양만 다르고 규칙은 같다).
- [가정]: `GetPayment` 300ms, 내부 HTTP 3초, 다시 하기 1분·20건·10분, 시뮬레이터의 계좌 거절 규칙.
- 남는 한계: 재인증 토큰은 422·503에서도 이미 썼다(BAT-415-reauth의 '남는 한계'와 같은 꼴). 화면은 견적의 `refundAccountRequired`로 계좌를 먼저 받아 이 경우를 피한다(BAT-421). 계좌 대기 건의 계좌 다시 받기가 GAT-130 전까지 없어 그 건은 CS가 사람 손으로 처리한다.

### 7. 마이그레이션과 다른 갈래 영향

| 서비스 | 필요 | 번호 |
| --- | --- | --- |
| payment-svc | 없음(V1을 사건으로 판정) | 갈래 3 몫 0023~0024는 쓰지 않는다 |
| purchase-svc | 있음(취소 행 두 칸·CHECK, 일괄 환불 항목 상태 값, 부분 인덱스) | **0029**(감독 확정 2026-11-19, journal `when`은 develop 것보다 크게) |
| ops-svc | 있음(`core_applied_at`·`core_apply_overdue_at`, 부분 인덱스) | **0016**(감독 확정 2026-11-19, journal `when`은 develop 것보다 크게) |
| core-svc | 없음(회차 `status`·`starts_at`이 있다) | — |

- 다른 갈래 영향: docs/api의 payment.proto·openapi와 생성물 두 패키지(깨지지 않는 칸·값 더하기. 새 enum 값은 옛 purchase-svc가 모르는 값이라 배포 차례는 purchase-svc와 payment-svc를 함께, 운영 전이라 지금은 함께 나간다). core-svc 카탈로그 컨트롤러(갈래 2가 검색 표를 만든 곳, BAT-165)·`withSearchSync` 부르는 곳 하나 더함. 메시 허용 정책 원천(ADR-0285, 갈래 1이 만든 도구일 수 있다). 화면 앱은 건드리지 않는다.
- BAT-408(합치기 대기)과 겹치는 파일: 없다(이 몫은 identity-svc·`packages/platform`을 고치지 않는다).

### 8. 차례(구현 담당 안에서)

1. proto·openapi 칸 → 생성물 두 패키지 → 2. payment-svc(포트·어댑터·시뮬레이터·일반 취소 갈래·`GetPayment`) → 3. purchase-svc 마이그레이션 0029 → 4. purchase-svc 포트·견적·취소·재시도·다시 열기·일괄 환불 → 5. core-svc 쓰임새·컨트롤러 → 6. ops-svc 마이그레이션 0016·어댑터·approve·다시 하기·시작 조립 → 7. 메시 원천과 생성물 다시 만들기(같은 커밋)·guidelines §8.1 → 8. 아래 §11 게이트. V와 K는 서로 닿지 않아 순서를 바꿔도 된다.

### 9. 자주 놓친 결함 가운데 해당하는 것

| 결함(docs/architecture.md §8.6) | 이 몫에서 |
| --- | --- |
| 저장소 응답은 정확한 값까지 | 결제사 본문의 계좌 세 칸 값, `payment_cancel` 행 수 0, 진행 합계 `accountPending` 2, 무효화 경로 글 |
| 지우거나 옮기는 연산은 건드린 키·집합 모두 | 계좌 대기 표시가 `next_refund_at`을 비우고 `refund_attempts`를 바꾸지 않는지, 항목 상태와 취소 행 둘 다 |
| 경계값 양쪽 | 다시 하기 SEV2 10분 직전·경계, 다시 하기 20건 상한(21건째는 다음 바퀴), 입장 시작 직전·직후의 견적 |
| 세 상태(있음·없음·확인 못 함)의 가운데 | 가상계좌 여부 읽기: 참·거짓·실패(503). 조회 대조: 반영·아님·조회 실패(→ `UNKNOWN`, 계좌 대기로 보지 않는다) |
| 판정 함수만이 아니라 부르는 쪽이 결과를 쓰는지 | 422에서 ticket·payment·`writes` 0, 계좌 대기 행을 재시도 실행기가 집지 않음, 일괄 환불 다음 틱 호출 0 |
| 겹친 가드는 하나씩 빼 본다 | 계좌 규칙이 purchase(Saga 앞)와 payment(계좌 없으면 안 보냄) 두 곳이다. purchase 가드만 뺀 틀린 구현은 payment가 가려 돈은 안 나가지만 표가 취소된다(P-T72 ②의 ticket `cancel` 0이 잡는다). payment 가드만 뺀 것은 P-T71 ②가 잡는다 |
| 시험 값을 상수와 다르게 | 다시 하기 간격·경계는 정본 값으로 적고 코드 상수를 가져오지 않는다 |
| 시작 파일 조립은 따로 | ops `PEAKET_CORE_HTTP_URL` 규칙, purchase 결제 수단 읽기 포트가 `start.ts`에서 실제 gRPC 어댑터로 꽂히는지(글 읽기 시험) |
| 장애 주입이 실제로 끼어들었는지 | core 대역·ops CS 대역이 실제로 실패를 돌려준 횟수 ≥ 1을 함께 단언 |
| 개인정보 누설 | 계좌 글을 DB 전체·로그·Outbox에서 찾는 단언(P-T71 ①, P-T72 ⑥) |

### 10. A등급 틀린 구현 표본(검증 담당이 넣을 것, 16개)

| # | 틀린 구현 | 잡는 시험 |
| --- | --- | --- |
| M1 | payment-svc가 가상계좌 판정을 `virtual_account_no IS NOT NULL`로 한다(입금 확정 뒤 거짓) | P-T71 ⑥, ② |
| M2 | 계좌 없는 가상계좌 취소에도 `payment_cancel` 행을 만든다 | P-T71 ② |
| M3 | 계좌 없는 재시도에 결제사 취소를 다시 부른다(같은 멱등키 다른 본문) | P-T71 ③ |
| M4 | 조회가 반영이 아니어도 `CANCELLED`로 답한다 | P-T71 ③ |
| M5 | 계좌를 `payment_cancel`·사건 본문·로그에 남긴다 | P-T71 ①, P-T72 ⑥ |
| M6 | 카드 결제에 온 계좌를 결제사 본문에 싣는다 | P-T71 ⑤ |
| M7 | 견적이 입장 시작 뒤에도 `refundAccountRequired` 참 | P-T72 ① |
| M8 | `GetPayment` 실패를 '계좌 필요 없음'으로 본다 | P-T72 ①②(503) |
| M9 | 422 검사를 Saga 뒤(표 취소 뒤)에 한다 | P-T72 ②의 ticket `cancel` 0 |
| M10 | 입장 시작 뒤 취소의 계좌를 재시도까지 들고 간다 | P-T72 ③ |
| M11 | 계좌 대기를 재시도 횟수에 넣거나 `next_refund_at`을 남긴다 | P-T72 ④ |
| M12 | CS '환불 대기' 연 시각을 2xx 전에 쓴다 | P-T72 ⑤ |
| M13 | 계좌 대기 항목을 자동 정지 실패로 센다 | R-T40 ③ |
| M14 | 계좌 대기 항목이 남으면 COMPLETED로 가지 않는다(또는 반대로 셈에서 빠뜨려 `accountPending`이 0) | R-T40 ④ |
| M15 | core가 검색 동기화를 트랜잭션 밖(커밋 뒤)에서 부른다 | SR-T8 ③(되돌림 때 검색이 바뀜), R-T41 ① |
| M16 | ops가 core 실패 때 `core_applied_at`을 써 버리거나, 성공 뒤에도 비워 두어 다시 부른다 | R-T41 ③ |

- 덧붙일 만한 것(검증 담당 판단): core 멱등을 빼 두 번째 부름에도 무효화(R-T41 ②), 연기에 판매 멈춤을 부름(R-T41 ④), 공유 토큰 가드 빠짐(R-T41 ⑤).

### 11. 닿는 CI 잡과 게이트 명령

| 영역 | 잡 | 비고 |
| --- | --- | --- |
| docs/api(proto·openapi) | contract-check / contracts, docs-check / docs, node / node | node가 전체를 돈다(WIDEN_JS). 생성물 차이·깨짐 검사·서비스 OpenAPI 차이(D-T38) |
| packages/contracts·api-client 생성물 | contract-check / contracts, node / node | — |
| services/payment-svc | node / node, contract-check / contracts | 통합 `pnpm --filter @peaket/payment-svc test:integration`(P-T71) |
| services/purchase-svc | node / node, contract-check / contracts | 통합 `pnpm --filter @peaket/purchase-svc test:integration`(P-T72 ⑤, R-T40) |
| services/core-svc | node / node, contract-check / contracts | 통합 `pnpm --filter @peaket/core-svc test:integration`(R-T41 ①②⑤, SR-T8 ③) |
| services/ops-svc | node / node, contract-check / contracts, docs-check / docs | — |
| services/pg-simulator | node / node, image / build | 이미지 스모크 |
| 메시 원천·생성물(`deploy/platform/mesh/`) | `.github/workflows/tools-check.yml`(`node tools/ci/mesh-policies.mjs --check`), kind / kind | 생성물은 `node tools/ci/mesh-policies.mjs --write`로만 만든다 |
| docs | docs-check / docs | — |

```
cd /d/ticketpass-lane3-b420 && pnpm --filter @peaket/contracts gen && pnpm --filter @peaket/api-client gen && pnpm --filter @peaket/contracts gen:check && pnpm --filter @peaket/contracts test && pnpm --filter @peaket/api-client test
cd /d/ticketpass-lane3-b420/services/payment-svc && npx vitest run && npx tsc -p tsconfig.json --noEmit
cd /d/ticketpass-lane3-b420/services/purchase-svc && npx vitest run && npx tsc -p tsconfig.json --noEmit
cd /d/ticketpass-lane3-b420/services/core-svc && npx vitest run && npx tsc -p tsconfig.json --noEmit
cd /d/ticketpass-lane3-b420/services/ops-svc && npx vitest run && npx tsc -p tsconfig.json --noEmit
cd /d/ticketpass-lane3-b420/services/pg-simulator && npx vitest run
cd /d/ticketpass-lane3-b420 && pnpm lint
cd /d/ticketpass-lane3-b420 && python -I -X utf8 tools/doc-check/check_all.py
cd /d/ticketpass-lane3-b420 && node tools/ci/ledger.mjs --batch BAT-420
```

- 통합 시험(Docker)은 감독이 잠금을 잡은 때만 돌린다. 네 서비스의 통합을 한 잠금 안에서 겹치지 않게 차례로 돌린다(무거운 통합 시험 겹치지 않기). 이 폴더에는 node_modules가 없어 구현 담당이 설치 뒤 돌린다. `pnpm`이 응용 프로그램 제어에 막히면 생성은 `node packages/contracts/scripts/generate.mjs`·`node packages/api-client/scripts/generate.mjs`, lint는 `npx eslint <서비스 폴더>`로 대신한다.
- 문서 점검: 이 계획 커밋은 오류 0이다. 남은 경고 넷(openapi 응답 설명 셋, mermaid 문법 검사 건너뜀)은 이 커밋이 닿지 않은 것이다.

## 실패 확인

## 시험 결과

## 리뷰

## 검증

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | l3-b420-plan | claude-opus-5-5 | 2026-11-19T03:43+09:00 | 2026-11-19T04:04+09:00 |
| impl | l3-b420-impl | claude-opus-5-5 | 2026-11-19T04:05+09:00 | 2026-11-19T04:56+09:00 |

- 다른 담당은 자기 커밋에서 이 표에 자기 행을 더한다. 리뷰 반영 커밋은 `Fix-By`의 역할(시험·구현) 행으로 센다.
