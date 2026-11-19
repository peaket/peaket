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
| core-svc | 처음 계획은 없음. 구현이 `0029_event_status_ops_grant`(운영 역할에 `event.status` 고치기 권한)를 더했다 | **0029**(감독이 갈래 3에 줌, develop `0daf6434`. 리뷰 RV-09 닫힘) |

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

- **누가·어디서**: 시험 담당 `l3-b420-test`(claude-opus-5-5, 2026-11-19). 구현 전 트리는 계획 커밋 `6bfe405a`를 따로 꺼낸 worktree(`D:/ticketpass-lane3-b420-base`)에 pnpm install·패키지 다섯(search-normalize·shuffle·validation·contracts·platform) 빌드 뒤 시험 파일만 복사해 돌렸다. 통합 시험은 Docker 잠금(`lane3-BAT-420`, 2026-11-19T05:54:34+09:00 ~ 06:02:32+09:00) 안에서 파일 하나씩 차례로 돌렸고 남은 컨테이너는 0이다.
- **결과(새 시험 103개)**: 실패 66, 실행조차 안 됨 25(새 모듈이 없어 파일을 읽지 못함 19 = core `test/event-cancellation-status.test.ts` 5·ops `test/event-cancellation-core-apply.test.ts` 14, 0016 칸이 없어 묶음 준비가 실패해 건너뜀 6 = ops `test-int/event-cancellations.int.test.ts` R-T41 ③), 통과 12.

| 파일 | 시험 ID | 개수 | 구현 전 트리 |
| --- | --- | --- | --- |
| `services/pg-simulator/test/refund-account.test.ts`(새) | P-T71 | 9 | 실패 6, 통과 3 |
| `services/payment-svc/test/cancel-confirmed-payment-refund-account.test.ts`(새) | P-T71 | 18 | 실패 16, 통과 2 |
| `services/payment-svc/test-int/payment-cancel-refund-account.int.test.ts`(새) | P-T71 ①~⑥ | 8 | 실패 7, 통과 1 |
| `services/payment-svc/test-int/payment-deposit.int.test.ts`(더함) | P-T71 ⑥ | 1 | 실패 1 |
| `services/purchase-svc/test/cancel-refund-account-http.test.ts`(새) | P-T72 ①~④·⑥ | 13 | 실패 9, 통과 4 |
| `services/purchase-svc/test/event-refund-account-pending.test.ts`(새) | R-T40 ①③④ 6, P-T72 ④⑤ 7 | 13 | 실패 12, 통과 1 |
| `services/purchase-svc/test-int/cancellation.int.test.ts`(더함) | P-T72 ②~⑥ | 5 | 실패 4, 통과 1 |
| `services/purchase-svc/test-int/event-cancel-r-t24.int.test.ts`(더함) | R-T40 ①~④ | 4 | 실패 4 |
| `services/core-svc/test/event-cancellation-status.test.ts`(새) | R-T41 | 5 | 실행 안 됨(모듈 없음) |
| `services/core-svc/test-int/search-read-model.int.test.ts`(더함) | R-T41 ①②④⑤ 4, SR-T8 ③ 1 | 5 | 실패 5(경로 404) |
| `services/ops-svc/test/event-cancellation-core-apply.test.ts`(새) | R-T41 ③④ | 14 | 실행 안 됨(모듈 없음) |
| `services/ops-svc/test/event-cancellation-core-apply-main.test.ts`(새) | R-T41 ③ 시작 조립 | 2 | 실패 2 |
| `services/ops-svc/test-int/event-cancellations.int.test.ts`(더함) | R-T41 ③ | 6 | 실행 안 됨(묶음 준비 42703) |

- **구현 전 트리에서 통과한 12개(새 동작이 아닌 대조·회귀)**: 시뮬레이터 토스 모양 ①(옛 시뮬레이터가 모르는 칸을 버리고 취소해 통과한다. 계좌가 결제사 본문에 실리는지는 payment 통합 ①이 잡는다)·카드 ⑤·포트원 ①, payment 단위의 대조 둘(계좌를 다시 실은 재시도, 계좌 없는 포트원 본문), payment 통합 ⑤(카드 결제의 본문), purchase HTTP 대조 넷(카드 결제, 가상계좌에 계좌를 실은 취소, 입장 시작 뒤 취소, 결과 모름), 환급 실행기의 업무 거절 대조, purchase 통합 ⑥(계좌 글 누설 0 — 옛 트리도 저장하지 않는다). 계획 §5 끝 줄대로 이 단언들의 실패는 검증의 틀린 구현(M6·M10 등)으로 본다.
- **구현 전 트리의 실패가 보여 준 것**: R-T40 ①에서 옛 일괄 환불은 가상계좌 주문의 두 표도 계좌 없이 결제사 취소를 불러 done 4였다(돈이 계좌 없이 나가는 길). P-T72 ②는 422 대신 Saga가 돌아 ACCEPTED였다.

### 리뷰 반영 재현

- **누가·어디서**: 시험 담당 `l3-b420-test`(claude-opus-5-5, 2026-11-19T07:00~07:40+09:00). 고치기 전 트리는 지금 트리(`85394ba0`, 제품 코드는 `94da0926`과 같다)이고 이 폴더에서 바로 돌렸다. 통합은 Docker 잠금(`lane3-BAT-420`, 07:30:16~07:36:34+09:00) 안에서 새·바꾼 파일만 차례로 돌렸고 남은 컨테이너는 0이다.
- **명령**: 서비스마다 `npx vitest run`(payment·core·ops·purchase 단위 전체, `packages/validation`), 통합은 `PEAKET_TEST_CONTAINER_PREFIX=lane3-b420- npx vitest run --config vitest.integration.config.mjs <파일>`(payment `payment-cancel-refund-account`, purchase `event-refund`·`cancellation`·`event-cancel-r-t24`, core `search-read-model`, ops `event-cancellations`). `tsc --noEmit`: payment·purchase·core·ops 오류 0, `packages/validation`은 새 모듈이 없어 오류 1(`../src/refund-account/index`, 구현 I4가 만든다).
- **결과(새 시험 37개)**: 재현(실패) 24, 처음부터 통과 11(검증이 틀린 구현으로 실패를 본다), 실행 안 됨 2(`packages/validation/test/refund-account.test.ts`, 모듈 없음).

| T | 시험(파일) | 고치기 전 트리 |
| --- | --- | --- |
| T1 | `P-T75 ①~③`: purchase `test/cs-case-adapters-contract.test.ts`(새, 공용 표 `test/fixtures/cs-case-bodies.json`)·ops `test/cases-contract.test.ts`(새, 같은 표)·ops `test/cases.test.ts`(더함 1) | 재현 5(ops 다섯 종류 중 환불 대기 `accepted: false`, 어댑터가 2xx `accepted: false`·`{}`·JSON 아님을 연 것으로 봄, 틱 끝 다시 열기가 연 시각을 씀). 처음부터 통과 1(어댑터 다섯의 본문이 표와 같다) |
| T2 | `P-T73 ①②⑤`: payment 단위 더함 4·통합 더함 2, purchase `test/cancel-refund-account-http.test.ts` 더함 1 | 재현 6(결제사 취소를 다시 보냄, 시뮬레이터 `IDEMPOTENCY_KEY_REUSED`를 REJECTED·행 FAILED로 읽음, 다시 누름에 계좌를 넘김). 처음부터 통과 1(쓰임새가 결제사 UNKNOWN에 행을 끝내지 않는다) |
| T3 | `P-T73 ③④`: payment 통합 더함 2, purchase `test-int/cancellation.int.test.ts` 더함 1 | 재현 3(`fail_reason` 칸 없음 42703, 다시 누름이 payment를 불러 REJECTED·`refund_failed_at`) |
| T4 | `P-T74 ①~③`: `packages/validation/test/refund-account.test.ts`(새)·공용 표 `packages/validation/test/fixtures/refund-account-cases.json`(새), payment `test/refund-account-shape.test.ts`(새)·단위 더함 1·통합 더함 1, purchase HTTP 더함 2 | 재현 5(`088`이 202, 31자 계좌가 payment에서 계좌로 읽힘, 포트원 대응표 밖 코드가 `payment_cancel` FAILED 행), 실행 안 됨 2, 처음부터 통과 1(경계 대조가 지난다) |
| T5 | `R-T40 ⑤`: ops `test/grpc-event-refunds.test.ts`(새), `test/event-cancellations-http.test.ts` 더함 1 | 재현 2. 처음부터 통과 1(칸 없는 옛 답은 0) |
| T6 | `R-T41 ⑥`: ops `test/event-cancellation-core-apply.test.ts` 더함 4·`test-int/event-cancellations.int.test.ts` 더함 1, core `test/event-cancellation-status.test.ts` 더함 1 | 재현 5(P1을 다시 부름, 4xx 다음 볼 시각 1분, 21건 머리 막힘, 대체 표시 칸 없음 42703, core가 지난 같은 연기를 409). 처음부터 통과 1(둘 다 비면 P1 → P2) |
| T7 | `R-T41 ③ 확정은 Start를 끝낸 뒤에만 core를 부른다`(ops 단위 더함) | 처음부터 통과(O13로 본다) |
| T8 | `R-T41 ③ 어댑터는 연결 실패·시간 초과를 실패로 던진다`(ops `test/http-core-event-status.test.ts` 새), ops 통합 '실제 어댑터를 닫힌 포트에' 더함 | 처음부터 통과 2(O09로 본다) |
| T9 | `SR-T8 ③ 검색 쪽 쓰기가 실패하면 회차 상태도 되돌려진다`(core 통합 더함, `search_document`에 커밋 때 터지는 지연 제약 트리거) | 처음부터 통과(I06로 본다) |
| T10 | `P-T73 ⑤ 공연 시작 뒤 다시 누름의 계좌는 payment로 가지 않는다`(purchase HTTP 더함) | 처음부터 통과(A05로 본다) |
| T11 | `P-T72 ③ 재시도 실행기는 실제로 집은 행으로도 계좌를 싣지 않는다`(purchase 통합 더함) | 처음부터 통과(A05·M10로 본다) |

- **정본 변경 반영(시험 이의 아님)**: payment 단위 'P-T71 ③ 대조'를 정본 ⑥대로 결제사 취소 0·조회 1로 뒤집음(재현), payment 통합 'P-T71 ④'의 다시 부름 답을 REJECTED에서 `REFUND_ACCOUNT_REQUIRED`·결제사 0으로(재현), ops `test/cases.test.ts`의 '받는 종류 셋'을 넷(환불 대기 더함, `DISPUTE` 등은 여전히 `accepted: false`)으로, purchase `test/cancel-reauth-http.test.ts`의 계좌 표본 `bankCode '088'`을 `'88'`로. 받는 쪽 대역의 2xx 본문을 `{"accepted":true}`로 바꿈: purchase `test-int/ops-cs-double.ts`(`state.accepted`, 기본 참), `test/event-refund-wave-review.test.ts` 대역 둘, `test/event-refund-account-pending.test.ts`의 202 답(구현 I1 뒤에도 기존 시험이 지나게).
- **구현이 맞출 이름·모양**(계획 §3): `packages/validation/src/refund-account/index.ts`의 `refundAccountShape(v): { ok: true; value: { bankCode; accountNumber(하이픈 뺀 숫자); holderName } } | { ok: false }`(하위 경로 `@peaket/validation/refund-account`). payment `payment_cancel.fail_reason`(계좌 거절 `REFUND_ACCOUNT_INVALID`, 그 밖 null). ops 진행 `EventRefundJobProgress.accountPending`·관제 상세 `progress.accountPending`(결제사별 몫에는 없음). ops 0016 `event_cancellation_request.core_apply_superseded_at`, 메모리 저장소의 `core.get(id).nextAtMs`·`appliedAtMs`는 지금 이름 그대로 쓴다(4xx 401 제외 + 600,000ms, 5xx·무응답·401 + 60,000ms). purchase 본문 모양 오류는 400 `invalid-body`(문제 유형 접두어 + `invalid-body`). CS 받는 층 답은 2xx 본문 `accepted: true`일 때만 연 것.
- **알림**: ops `test/event-cancellation-core-apply-main.test.ts`(main.ts를 띄우는 두 시험)가 다섯 서비스 단위를 한꺼번에 돌린 때 시간 초과로 실패했고 혼자 돌리면 통과한다(부하에 따른 흔들림, 이 반영과 무관). 검증 담당이 다시 볼 때 따로 돌리기를 권한다.
- **시험 이의(구현 담당 `l3-b420-impl`, 리뷰 반영 구현, 2026-11-19)**: payment `test/payment-schema.test.ts`의 다섯 시험(PRF180·PRF181·PRF182_PRF183·GAT-080 P8 둘)은 마이그레이션 기록을 0000~0021로, `payment_cancel` 칸을 아홉으로 못 박아 정본 ④가 정한 새 칸 `fail_reason`(마이그레이션 0023, 감독 지시 번호)과 어긋나 실패한다. 구현 잘못이 아니라 시험이 정본 변경(payment §6 '구현에서 정한 것' ④, docs/data.md payment_cancel)을 따라가지 않은 것이라, 시험 담당이 기록 목록에 `[23, '0023_payment_cancel_fail_reason']`·SQL 파일 목록에 `0023_payment_cancel_fail_reason.sql`·칸 목록에 `fail_reason text`(빈 값 허용)·check `payment_cancel_fail_reason_check`를 더하고, 0022가 비는 것(갈래 5 몫)을 기록 차례 검사가 받게 고쳐 주기를 바란다. 그 밖 재현 시험은 모두 지난다.
  - **처리(시험 담당 `l3-b420-test`, 2026-11-19, 정본 변경 반영)**: `payment-schema.test.ts`를 정본 ④대로 고쳤다. 기록 목록에 `[23, '0023_payment_cancel_fail_reason']`, SQL·스냅샷 목록에 0023, 마지막 스냅샷을 `0023_snapshot.json`으로, `payment_cancel` 칸에 `fail_reason text`(빈 값 허용)와 `payment_cancel_fail_reason_check`(빈 값이거나 FAILED·`REFUND_ACCOUNT_INVALID`)를 더했고, 0023 SQL은 그 칸과 검사 두 문뿐이라는 시험을 새로 두었다. 0022(갈래 5 몫)는 기록·파일이 나중에 들어와도 그 번호만 앞머리로 보고 나머지를 차례로 견준다(idx 오름차순·중복 없음은 전체로 본다). payment 단위 50파일 3,039 통과, `tsc --noEmit` 오류 0.

## 시험 결과

- **구현 트리(`2930f8b3` + 이 커밋의 시험)**: 새·바꾼 시험 파일 모두 통과. 단위 전체 — pg-simulator 6파일 109, payment-svc 49파일 3,033, core-svc 80파일 516, ops-svc 41파일 278, purchase-svc 136파일 4,249(모두 통과). 통합(이 PC Docker, 새·바꾼 파일만) — payment `payment-cancel-refund-account` 8·`payment-deposit` 47, purchase `cancellation` 43·`event-cancel-r-t24` 31, core `search-read-model` 32, ops `event-cancellations` 23(모두 통과). 통합 전체는 감독의 초안 PR CI 몫이다.
- `npx tsc -p tsconfig.json --noEmit`(test·test-int 포함) payment·purchase·core·ops·pg-simulator 오류 0. `python -I -X utf8 tools/doc-check/check_all.py` 오류 0·경고 4(이 커밋이 닿지 않은 openapi 응답 설명 셋, mermaid 건너뜀). 시험 파일은 eslint 설정 밖이다(경고 'File ignored').
- **시험을 고치며 정한 것**: CancelPayment 답의 `remaining_cancellable`(시뮬레이터 토스 모양은 비어 있음)은 견주지 않는다. 결제 후 전액이 되는 카드 일괄 환불의 결제사 금액은 'ALL'이고 금액은 payment_cancel 행(33,333)으로 본다. 잡기·늦음 표시의 돌려주는 줄 차례는 견주지 않는다(UPDATE … RETURNING은 차례를 정하지 않는다, 고르는 차례는 limit으로 본다). 검색 어긋난 줄(drift)은 같은 DB를 나눠 쓰는 앞 묶음 때문에 0이 아니어서 이 묶음에서는 그 공연의 이름 줄 0으로 대신했다.
- **구현 결함 의심(시험으로 확인하지 않음, 리뷰·검증 판단)**: ① 팬 취소가 계좌 거절로 계좌 대기(REFUND_PENDING·refund_account_required_at)가 된 뒤 팬이 같은 표를 새 키로 다시 누르면, ticket-svc가 첫 취소 ID를 알려 `CancelTicket.#replay`가 같은 취소 ID로 payment를 다시 부르고, payment-svc는 FAILED 행이라 REJECTED를 돌려 그 행에 환급 실패 표시(refund_failed_at)까지 남는 것으로 읽힌다(CS 건이 '환불 대기'와 '환급 실패' 둘). ② core-svc에 계획 §7이 '없음'으로 둔 마이그레이션 `0029_event_status_ops_grant.sql`이 생겼다(구현 주석 '번호 감독 확인 대기'). ③ 시뮬레이터는 모르는 칸을 거절하지 않고 버린다(옛 동작, 결함 아님).

## 리뷰

- **누가·무엇을**: 리뷰 담당 `l3-b420-review`(claude-opus-5-5, 2026-11-19). `git diff a8076fad..5654fd91`(계획 `b251d831`·`6bfe405a`, 구현 `2930f8b3`, 시험 `5654fd91`)과 이 계획·지시서를 읽고, 정본은 payment §4.1·§6·§11, transfer-refund §3.1 ⑥·§5·§11, data.md, guidelines §8.1, ADR-0285 결정 9를 필요한 줄만 봤다. 시험·빌드·Docker는 돌리지 않았다(읽기만). 관점 넷(정확성, 동시 실행·장애, 보안, 화면과 서버 잇기)을 한 번에 봤다.
- **수**: 높음 2, 중간 4, 낮음 5(모두 11).
- **커밋 나누기**: 구현 커밋 `2930f8b3`은 시험 파일(`test/`·`test-int/`)을 건드리지 않았고, 시험 커밋 `5654fd91`은 `src`를 건드리지 않았다(계획 파일만 더함). 지킴.
- **권한 넓힘(core-svc `0029_event_status_ops_grant`) 판정 — 문제 없음**: `GRANT UPDATE ("status") ON "event" TO core_ops`는 칸 하나·표 하나만 연다. 연기 때 함께 고치는 칸(`starts_at`·`ends_at`·`entry_opens_at`·`version`)은 0012가 이미 같은 역할에 줬고(0012 26행), 새 저장소(`drizzle-event-status-store.ts` `write`)가 쓰는 칸도 이 다섯뿐이다. 모자란 칸·더 넓게 열린 칸은 없다. 행 보안 `event_ops`(0012, 조건 없이 연다)는 그대로이고, 0008의 `event_partner_approved_guard` 트리거는 파트너 역할만 막아 운영 역할 쓰기를 막지 않는다. 역할은 `NOSUPERUSER NOBYPASSRLS`이고 시작 때 `assertDatabaseRole(opsDatabase, 'core_ops')`가 본다. 시험(`search-read-model.int.test.ts` R-T41 ④)이 실제 `core_ops` 로그인 역할로 연기 쓰기를 해 권한이 모자라지 않음을 보인다. 남는 것은 번호·계획 어긋남뿐이다(RV-09).
- **같은 취소의 재시도 판정 — 실제 결함(RV-03)**: 아래 RV-03에 근거를 적었다.

| # | 심각도 | 파일:줄 | 무엇이 틀렸나(근거) | 고칠 방향 |
| --- | --- | --- | --- | --- |
| RV-01 | 높음(환불 누락) | `services/ops-svc/src/modules/cases/application/receive-case-requested.ts:7`, `services/purchase-svc/src/modules/refund/adapters/cs-case-response.ts:15-17`, `…/adapters/http-refund-account-notice.ts:22-37` | CS '환불 대기'(`REFUND_ACCOUNT_PENDING`) 건이 ops-svc에 실제로 생기지 않는다. ops-svc의 받는 종류는 `REFUND_FAILED`·`FLAGGED`·`JUDGEMENT_PENDING` 셋뿐이라 이 종류는 202 `{ accepted: false }`로 답하고 저장하지 않는다(ops 시험 `test/cases.test.ts:64`가 '셋 밖은 만들지 않는다'를 단언한다). 그런데 purchase-svc `requireAccepted`는 상태 코드 2xx만 보므로 `refund_account_case_opened_at`을 써 버린다. 결과: 계좌 대기 행은 '연 것'으로 표시되고 다시 열지 않으며, CS 처리함에는 건이 없어 아무도 모르는 환불 대기가 남는다(payment §6 '계좌 대기', transfer-refund §3.1 ⑥ 다섯째 건, R-T40 ②·P-T72 ⑤가 바란 것과 반대). 시험은 ops를 대역(늘 2xx)으로 둬서 놓쳤다 | ① ops-svc `ACCEPTED`에 `REFUND_ACCOUNT_PENDING`을 더하고 ops 시험(cases.test.ts '받는 종류')을 정본대로 고친다. ② purchase `requireAccepted`가 본문 `accepted === true`까지 보게 하고(아니면 `CsCaseRejected`, 다시 열기가 잇는다) 다른 CS 어댑터에도 같게 쓴다. ③ purchase 어댑터 본문을 실제 ops 받는 층(`CasesController`·`ReceiveCaseRequested`)에 넣어 보는 계약 시험 하나(종류 다섯 모두 accepted 참) |
| RV-02 | 높음(같은 멱등키 다른 본문, 원장 어긋남) | `services/payment-svc/src/modules/payment/application/cancel-confirmed-payment.ts:98·107·128-133`, `services/purchase-svc/src/modules/refund/application/cancel-ticket.ts:233-250`, `services/payment-svc/src/modules/payment/adapters/pg/toss-shaped.ts:264` | 계좌를 실어 보낸 취소가 결과 모름(UNKNOWN)으로 진행 중 행(REQUESTED)인데 팬이 새 멱등 키로 **다른 계좌**(또는 예금주 띄어쓰기만 다른 계좌)를 실어 다시 누르면, `#replay`가 그 계좌를 그대로 넘기고 payment-svc는 `replay`이고 계좌가 있으므로 조회 없이 같은 멱등키 `cancel-{취소 ID}`로 다른 본문을 보낸다. 정본은 '같은 멱등키 = 같은 본문'(payment §4.1 '취소 건 기록과 기대 잔액')이고 '메모리의 계좌는 같은 요청 안의 즉시 재시도에만 쓴다'(payment §6 첫 문단)이며, 다른 계좌로 다시 보내는 멱등키는 GAT-130이다(이 계획 §6). 시뮬레이터는 이 경우 422 `IDEMPOTENCY_KEY_REUSED`를 주는데 토스 모양 어댑터는 이를 업무 거절(REJECTED)로 읽어 행을 `FAILED`로 끝낸다. 첫 본문이 결제사에서 이미 반영됐다면 돈은 나갔는데 원장 누적 취소액은 그대로이고 purchase는 '환급 실패' CS 건을 연다 → CS가 다시 돌려주면 이중 환불이다 | ① payment-svc: 가상계좌 결제에서 그 취소 ID의 행이 이미 있으면(replay) 들어온 계좌와 관계없이 결제사 취소를 다시 보내지 않고 V5(조회로만 끝을 봄)로 간다. 시험 'P-T71 ③ 대조: 계좌를 다시 실은 재시도는 조회 없이 결제사 취소를 한 번 부른다'를 반대로 고치고 payment §6에 한 줄 더한다. ② purchase `#replay`는 계좌를 넘기지 않는다(겹친 가드). ③ 결제사의 멱등키 재사용 답(시뮬레이터 `IDEMPOTENCY_KEY_REUSED`, 토스·포트원의 같은 뜻 코드)은 REJECTED가 아니라 결과 모름으로 읽는다 |
| RV-03 | 중간 | `services/payment-svc/src/modules/payment/adapters/db/drizzle-confirm-jobs.ts:650`, `services/purchase-svc/src/modules/refund/application/cancel-ticket.ts:233-256`(`#replay`→`#recordUnrefunded`) | 지시서가 물은 경우는 실제 결함이다. 결제사가 계좌를 거절하면 payment 행은 `FAILED`이고 첫 답은 `REFUND_ACCOUNT_REQUIRED`라 purchase 행은 계좌 대기(`refund_account_required_at`)다. 팬이 새 멱등 키로 다시 누르면(계좌를 실어야 422를 지난다) ticket-svc가 첫 취소 ID를 알려 `#replay`가 같은 취소 ID로 payment를 부르고, payment는 `FAILED` 행을 거절 까닭 없이 `REJECTED`로 답한다(시험 P-T71 ④도 '같은 취소 ID를 맞는 계좌로 다시 불러도 REJECTED'를 단언). purchase는 이를 업무 거절로 보고 `markRefundFailed`로 `refund_failed_at`까지 쓴다. 그래서 한 취소에 CS 건이 '환불 대기'와 '환급 실패' 둘로 열리고(transfer-refund §3.1 ⑥은 두 건을 따로 정의하고 결제사 업무 거절만 환급 실패다), 팬 답은 202 `REFUND_PENDING`·`refundAccountRequired` 없음이라 화면이 SCR-060 안내를 못 보이며, 팬이 새로 넣은 계좌는 아무 데도 쓰이지 않는다. 같은 취소 ID에 첫 답(`REFUND_ACCOUNT_REQUIRED`)과 다른 답(`REJECTED`)을 주는 것도 같은 취소 ID = 같은 결과(payment §4.1)와 어긋난다. 돈은 나가지 않는다 | payment-svc가 계좌 거절로 끝낸 `FAILED` 행을 개인정보 없는 까닭 값(예 `fail_reason = 'REFUND_ACCOUNT_INVALID'`, 마이그레이션 0023 몫)으로 기억해 replay에 `REFUND_ACCOUNT_REQUIRED`를 다시 준다. purchase `#replay`는 계좌 대기 행(`refund_account_required_at` 있음)이면 실패 표시를 쓰지 않고 202 `refundAccountRequired` 참으로 답한다(계좌 다시 받기는 GAT-130). 회귀 시험: 계좌 거절 뒤 새 키 재요청에서 `refund_failed_at` 빔·CS 건 하나·답의 `refundAccountRequired` 참 |
| RV-04 | 중간(화면과 서버 잇기) | `services/purchase-svc/src/modules/refund/inbound/ticket-cancellation.controller.ts:34`, `…/application/cancel-ticket.ts:93`, `services/payment-svc/src/modules/payment/domain/payment-gateway.ts`(`refundAccountOf`), `docs/api/openapi.yaml:641`(`RefundAccount`), `…/adapters/pg/portone-gateway.ts:377` | purchase는 계좌가 '있는지'만 보고 모양은 보지 않는다(은행 코드 1~20자 아무 글, 계좌번호 1~40자). payment는 은행 코드 두 자리 숫자·계좌번호 숫자 1~20자·예금주 1~60자가 아니면 계좌가 없는 것과 같게 다룬다(payment §6 '구현에서 정한 것' ②). 그래서 화면이 금융결제원 세 자리 코드(예 `088`)나 글자 섞인 번호를 보내면 422 없이 Saga가 돌아 표가 취소되고 그 취소는 계좌 대기로 빠진다(계좌 다시 받기 GAT-130 전이라 CS 손일). openapi `RefundAccount`에 모양이 없어 BAT-421이 알 길도 없다. 포트원 대응표에 없는 은행 코드는 행을 만든 뒤 `FAILED`로 끝내 그 취소 ID를 다시 못 쓴다(RV-03과 겹침) | purchase가 Saga 앞에서 payment와 같은 모양 검사(공용 함수나 같은 규칙)를 하고 틀리면 422 `refund-account-required`(또는 400 `invalid-body`, 정본에 한 줄)로 막는다. openapi `RefundAccount`에 `pattern`·`maxLength`를 적어 BAT-421에 넘긴다. 포트원 대응표 검사는 `beginConfirmedCancel` 앞(행을 만들기 전)으로 옮기는 것을 정본 ②와 함께 다시 본다 |
| RV-05 | 중간(화면과 서버 잇기) | `services/ops-svc/src/adapters/grpc-event-refunds.ts:184-196`, `docs/api/openapi.yaml` ops `refundProgress`(3497행 근처) | purchase-svc는 `GetEventRefundJobResponse.account_pending_orders`(refund.proto 10)를 내지만 ops-svc 어댑터가 읽지 않고, 관제 진행률 응답에도 칸이 없다. 계좌 대기만 남은 요청은 COMPLETED인데 관제 화면에는 `total > done + failed`로만 보여 '계좌 대기 2가 따로 있다'(R-T40 ④, payment §6 '진행 합계에 따로 센다')를 SCR-047(BAT-421)이 그릴 수 없다. 결제사별 몫(`per_pg`)에도 계좌 대기 수가 없다 | ops 어댑터·관제 진행률 계약(openapi)에 `accountPending`(요청 합계, 가능하면 결제사별)을 더하고 생성물을 다시 만든다. 이 묶음에서 못 하면 BAT-421 넘김 문안에 '선행: ops 진행률 칸'을 적는다 |
| RV-06 | 중간(동시 실행·장애) | `services/ops-svc/src/modules/event-cancellations/adapters/db/drizzle-store.ts:138`, `…/application/event-cancellations.ts`(`retryCoreApply`), `services/core-svc/src/modules/catalog/domain/event-cancellation-status.ts:59-60` | core 반영 다시 하기가 요청 사이의 차례를 모른다. ① 같은 회차의 연기 P1이 반영 못 한 채 남고 뒤 연기 P2가 확정 때 바로 반영되면, 다음 바퀴가 P1을 반영해 시작 시각을 옛 값으로 되돌린다(core는 요청 ID를 기록만 하고 비교하지 않는다). ② P1이 CANCEL 반영 뒤에 다시 불리면 409가 영원히 나고 1분마다 오류 로그가 쌓인다. ③ 영원히 실패하는 요청이 20건 [가정]을 넘으면 확정 시각 순 잡기라 새 요청이 다시 하기 차례를 못 받는다. ④ 이미 같은 시각으로 연기된 회차라도 그 시각이 지나면 '지금보다 이름' 검사가 먼저라 멱등 204가 아니라 409다 | ops: 같은 회차에 뒤 요청이 반영(`core_applied_at`)되면 앞 요청은 반영된 것으로 덮거나(또는 '대체됨' 표시) 다시 하기에서 뺀다. 또는 core가 확정 시각·판을 받아 더 오래된 반영을 거절한다. 잡기 차례를 `core_apply_next_at` 우선으로 바꿔 머리 막힘을 피한다. core `decideEventStatus`는 '이미 같은 상태' 검사를 '지금보다 이름' 앞에 둔다 |
| RV-07 | 낮음(보안) | `services/core-svc/src/modules/catalog/inbound/internal-event-status.controller.ts:3`, `deploy/platform/mesh/port-allow.yaml`(core-svc `rest.callers`), `docs/security/asvs/transfer-refund.md` BAT-420-rest 메모 | 회차를 취소·연기하는 쓰기 경로인데 막는 것은 서비스 공용 내부 토큰과 포트 단위 메시뿐이다. core-svc REST 포트는 ops·payment·purchase·ticket 넷이 부를 수 있어(ADR-0285는 경로로 거르지 않는다) 주석 '부르는 쪽은 ops-svc 하나'와 ASVS 메모 '메시 부르는 쪽 목록을 쓴다'(8.3.1·4.4.1)는 사실과 다르다. 지금 바로 쓸 수 있는 공격 길은 아니다(토큰이 필요하다) | 주석과 ASVS 메모를 '포트 단위라 같은 포트의 다른 부르는 쪽도 닿는다(ADR-0285 남는 위험)'로 고친다. 상태를 바꾸는 내부 HTTP가 늘면 ADR-0285 '되돌릴 조건'(경로 단위 거르기)에 이 경로를 적는다 |
| RV-08 | 낮음(장애) | `services/payment-svc/src/modules/payment/application/cancel-confirmed-payment.ts:107-113`, transfer-refund §3.1 ⑥ 다섯째 건 | V5에서 조회가 '반영 아님'이면 진행 중 행(REQUESTED)을 그대로 두고 계좌 대기로 넘긴다(정본대로). 그런데 그 행은 앞서 계좌를 실어 보낸 것이라 결제사가 늦게 반영할 수 있고, 다시 부르는 쪽이 없어(재시도 실행기는 계좌 대기 행을 집지 않는다) 3시간 잔액 대조도 돌지 않는다. CS가 '환불 대기' 건을 손으로 돌려주면 이중 환불이 될 수 있는데 건 본문에 '계좌를 한 번 보낸 진행 중 건'이라는 표시가 없다 | CS 건 본문에 개인정보 없는 표시(예 `followUp: true` 또는 category 값)로 '보낸 뒤 결과 모름'을 구분하거나, GAT-130·GAT-280 정본에 'CS 처리 전 결제사 조회 필수'를 적는다 |
| RV-09 | 낮음(절차) | `services/core-svc/migrations/0029_event_status_ops_grant.sql:4`, `…/meta/_journal.json`, 계획 §7 core 행 | 계획 §7은 core-svc 마이그레이션을 '없음'으로 뒀는데 구현이 하나 더했고 번호는 '감독 확인 대기'다. 내용은 맞지만(위 판정) 다른 갈래 번호 몫과 겹치는지 아직 아무도 보지 않았다. 계획 §7 표와 시험 결과 절의 '구현 결함 의심 ②'도 그대로다 | 감독에게 core-svc 번호 확인을 받고 계획 §7 core 행을 사실대로 고친다(리뷰 반영 커밋) |
| RV-10 | 낮음(정본 빈칸) | transfer-refund §5 'core 반영의 구현에서 정한 것' ①, docs/BUILD_ORDER.md | 연기는 core `event`만 고치고 판매 설정 사본(`event_sale_config`)과 purchase·queue 사본은 그대로다. purchase 견적·취소는 옛 시작 시각으로 공제·'공연 시작'을 판정하므로 옛 날짜가 지나면 연기된 공연의 팬 취소가 409 `entry-started`가 된다(연기 신청 환급 창이 따로 있어 돈 길은 막히지 않는다). 정본은 'LCH-090과 함께 본다'만 적어 맡는 단계 줄이 없다 | BUILD_ORDER에 맡을 단계 줄(LCH-090 또는 새 줄)과 정본 §12 미결정 한 줄을 둔다 |
| RV-11 | 낮음(관측) | `services/ops-svc/src/modules/event-cancellations/application/event-cancellations.ts`(approve의 `#applyCore`) | 확정 직후 반영은 `core_apply_next_at`을 쓰지 않아, 그 사이 다른 파드의 다시 하기 바퀴가 같은 요청을 함께 부를 수 있다. core가 멱등이라 결과는 같지만 실패 지표·경고가 두 번 셀 수 있다 | 확정 직후 반영 전에 `core_apply_next_at = now + 1분`을 쓰거나, 지금처럼 두고 지표 설명에 '겹쳐 셀 수 있음'을 적는다 |

- **확인했고 문제없는 것**: 계좌 없는 재시도는 결제사 취소 0·조회만(V5), 조회 실패·가를 수 없음은 UNKNOWN(계좌 대기로 보지 않음). 카드 결제에 온 계좌는 버리고 지표만. 422·503(결제 수단 읽기)은 ticket·좌석·취소 행·결제사 호출 앞이라 쓰는 것이 없다(재인증 토큰 소비는 정본의 남는 한계). 견적은 입장 시작 뒤면 결제 수단을 읽지 않는다. 마감 뒤 환급의 REQUESTED 행은 `claimDue`가 먼저 REFUND_PENDING으로 바꾸므로 `markRefundAccountRequired` 조건과 맞는다. 재시도 실행기·일괄 환불은 계좌를 싣지 않고, 계좌 대기 행·항목을 다시 집지 않으며 자동 정지 셈 밖이다. 일괄 환불 COMPLETED 셈에 `ACCOUNT_PENDING`이 끝난 항목으로 들어간다. 계좌는 proto·gRPC 받는 층·결제사 본문에만 있고 `payment_cancel`·사건·Outbox·CS 건 본문·로그·지표 이름표에 없다. core 반영은 한 트랜잭션 안의 `withSearchSync`라 되돌리면 검색도 그대로다. ops 다시 하기 잡기는 `FOR UPDATE SKIP LOCKED` + 미루기 한 문장이고 늦음 표시는 요청마다 한 번이다. `PEAKET_CORE_HTTP_URL`은 local·ci 밖에서 없으면 시작 실패다. core 경로는 공용 내부 토큰 가드(운영은 토큰 없으면 시작 안 함, 401)다. proto는 칸·열거값 더하기만이라 옛 purchase는 새 결과를 UNKNOWN으로 읽고, openapi는 선택 칸·응답 더하기이며 생성물·게이트웨이 계약 해시가 함께 바뀌었다.

### 다시 보기(리뷰 반영 뒤, 2026-11-19)

- **본 것**: 가지 `feature/lane3-BAT-420r` 머리 `fa909a81`. `git diff f21f8034..fa909a81 -- . ':!docs/review/plans'`(반영 계획 `85394ba0`, 재현 시험 `fbed418c`, 구현 `7817c75e`, 스키마 시험 `6fa6086d`, 은행 코드 정본 `97614273`, 생성물 `fa909a81`)와 이 파일 '리뷰 반영 계획' 절. 고친 곳 중심으로 읽었고 시험·빌드는 돌리지 않았다.
- **결과**: 높음 둘·보안 하나를 포함해 맡긴 일곱(RV-01~07) 모두 닫힘. RV-08·RV-10·RV-11은 반영 계획대로 정리 목록으로 넘어갔고(남음, 낮음), RV-09는 감독 번호 확인으로 닫혔다. 새 지적 셋(모두 낮음). 고침이 새 이중 환불·환불 누락·개인정보 누설 길을 만들지는 않았다.

| # | 판정 | 근거 |
| --- | --- | --- |
| RV-01 | 닫힘 | ops-svc `receive-case-requested.ts`의 받는 종류에 `REFUND_ACCOUNT_PENDING`이 들어갔다. purchase `requireAccepted`는 2xx이고 본문이 JSON 객체이며 `accepted === true`일 때만 연 것으로 본다(`accepted: false`·칸 없음·JSON 아님은 `CsCaseRejected`, 다시 열기가 잇는다). 다른 CS 어댑터 넷이 보내는 종류(`REFUND_FAILED`·`FLAGGED`)도 ops가 받는 종류라, 더 엄해진 판정이 기존 건을 막지 않는다. 다섯 본문을 실제 ops 받는 층에 넣어 보는 계약 시험(`cs-case-adapters-contract.test.ts`·`cases-contract.test.ts`, 공용 본문 표 `cs-case-bodies.json`)이 생겼다 |
| RV-02 | 닫힘 | payment-svc는 가상계좌 결제에서 그 취소 ID의 행이 이미 있으면(replay) 계좌가 있어도 다시 보내지 않고 조회 대조(V5)로만 끝을 본다(`virtualAccount && (replay || refundAccount === undefined)`). purchase `#replay`는 계좌를 넘기지 않는다(겹친 가드). 토스 모양 어댑터는 `IDEMPOTENCY_KEY_REUSED`를 결과 모름으로 읽고, 포트원은 그 코드가 거절 목록에 없어 이미 결과 모름이다. 같은 멱등키로 나가는 본문은 첫 본문 하나뿐이다. 카드 결제의 재시도는 그대로다 |
| RV-03 | 닫힘 | payment-svc 0023 `payment_cancel.fail_reason`(계좌 거절만 `REFUND_ACCOUNT_INVALID`, CHECK로 FAILED 행에만)을 남기고 그 행의 다시 부름은 결제사 0·`REFUND_ACCOUNT_REQUIRED`다(같은 취소 ID = 같은 답). purchase는 계좌 대기 행(`refund_account_required_at` 있음)의 다시 누름에서 payment를 부르지 않고 실패 표시 없이 202 `refundAccountRequired` 참을 준다. 그래서 '환급 실패' 건이 함께 열리지 않는다. `VOIDED` 검사가 먼저라 CS가 끝낸 행은 되살리지 않는다. 칸에는 개인정보가 없다 |
| RV-04 | 닫힘 | purchase는 재인증 앞에서 공용 규칙(`@peaket/validation/refund-account` `refundAccountShape`)으로 모양을 보고 틀리면 400 `invalid-body`다(토큰·결제 수단 읽기·Saga 0, 오류 글에 값 없음). 은행 코드는 토스 숫자 두 자리만이고 세 자리(`004`·`088`)는 400이다(payment §6 ②·openapi `RefundAccount` `pattern`). payment는 같은 규칙의 사본을 두고 같은 표(`refund-account-cases.json`)를 두 쪽 시험이 돈다. 포트원 대응표 밖 코드는 행을 만들기 전에 계좌 없음과 같게 다뤄 그 취소 ID를 태우지 않는다. 남는 빈틈은 RN-01 |
| RV-05 | 닫힘 | ops 어댑터가 `account_pending_orders`를 `accountPending`으로 읽어 관제 진행률(`views.ts`·openapi `progress.accountPending`, 생성물)에 싣는다. 결제사별 몫에는 없다고 계약에 적었다(SCR-047은 합계로 그린다) |
| RV-06 | 닫힘 | ① ops 0016에 `core_apply_superseded_at`을 더하고 `markCoreApplied`가 같은 트랜잭션에서 같은 회차의 앞 요청(확정 시각이 더 이르고 반영 전)에 대체 표시를 써, 앞 요청이 뒤 상태를 덮지 않는다. 대체된 요청은 다시 하기·늦음 표시 대상 밖이다. 한 바퀴 안에서는 확정 시각 차례로 부른다. ② 4xx(401 제외)는 다음 볼 시각을 10분 [가정] 미뤄 1분마다 쌓이던 오류 로그를 줄인다. ③ 잡기 차례가 '다음 볼 시각(빈 값 먼저) → 확정 시각'이고 부분 색인도 그 차례라 머리 막힘이 없다. ④ core `decideEventStatus`는 '이미 같은 시각으로 연기됨'을 '지금보다 이름' 앞에서 봐 지난 시각의 같은 반영도 204다 |
| RV-07 | 닫힘 | 컨트롤러 머리 주석, ASVS 메모, ADR-0285 '되돌릴 조건'에 '포트 단위라 core-svc REST 포트를 부르는 다른 서비스도 공유 토큰만 있으면 닿는다'를 사실대로 적었다. 경로 단위 거르기는 ADR-0285 대안 2를 다시 볼 때의 몫으로 남는다(이 묶음에서 고칠 것 아님) |
| RV-08 | 남음(낮음) | 정리 목록으로 넘어갔다. RV-02 고침으로 이 경우가 늘었다(RN-03) |
| RV-09 | 닫힘 | 감독이 core-svc 0029를 갈래 3에 줬다(develop `0daf6434`). 계획 §7 core 행을 고쳤다 |
| RV-10 | 남음(낮음) | 정리 목록으로 넘어갔다 |
| RV-11 | 남음(낮음) | 정리 목록으로 넘어갔다. 확정 직후 반영과 다시 하기의 겹친 부름은 그대로이고 core가 멱등이라 결과는 같다 |

| # | 심각도 | 파일:줄 | 무엇이 틀렸나(근거) | 고칠 방향 |
| --- | --- | --- | --- | --- |
| RN-01 | 낮음 | `packages/validation/src/refund-account/index.ts`(`BANK_CODE`), `services/payment-svc/src/modules/payment/domain/payment-gateway.ts`(`PORTONE_BANK_OF`) | 공용 규칙은 은행 코드를 '숫자 두 자리'로만 본다. 토스 은행 코드 표에 없는 두 자리(예 `99`)는 400을 지나 Saga가 돌고, 토스는 `INVALID_BANK`로 계좌 거절(행 FAILED·`fail_reason`), 포트원은 대응표 밖이라 계좌 없음이 되어 둘 다 표가 취소된 채 계좌 대기로 빠진다. RV-03 고침으로 계좌 대기 행의 다시 누름은 payment를 부르지 않으므로, 팬이 맞는 코드로 다시 눌러도 GAT-130 전에는 고칠 길이 없다. 포트원 대응표의 26개가 토스 은행 코드 표와 같은 목록이라 같은 표로 막을 수 있다 | 공용 규칙이 토스 은행 코드 표(지금 포트원 대응표와 같은 26개)에 있는 코드만 받게 하고, 표를 한 곳(공용 패키지나 공용 시험 표)에 둔다. 틀리면 지금처럼 400 `invalid-body` |
| RN-02 | 낮음(문서) | `docs/security/asvs/transfer-refund.md:14`(BAT-420-rest 메모 끝) | 메모는 '환불 계좌 모양은 purchase·payment가 같은 공용 함수로 본다'고 적었지만, payment-svc는 v0 이미지 때문에 같은 규칙의 사본(`refundAccountOf`)을 두고 같은 표로 시험한다. 사본은 gRPC로 온 공백을 먼저 빼 purchase보다 조금 너그럽다(겹친 가드라 문제는 아니다) | 메모를 '같은 규칙(purchase는 공용 함수, payment는 같은 표로 시험하는 사본)'으로 고친다 |
| RN-03 | 낮음(장애, 넘김) | `services/payment-svc/src/modules/payment/application/cancel-confirmed-payment.ts`(V5 조건), GAT-130 지시서 | RV-02 고침의 정해진 대가다. 계좌를 실은 첫 전송이 결제사에 닿지 않은 채 결과 모름이 되면, 전에는 같은 계좌로 다시 누르면 다시 보낼 수 있었지만 이제는 조회 '반영 아님'으로 계좌 대기가 되고 GAT-130 전까지 CS 손일이다(payment §6 ⑥이 받아들인 것). 이 진행 중 행(REQUESTED)은 결제사가 늦게 반영할 수 있어(RV-08), GAT-130이 새 멱등키로 다른 계좌를 보낼 때 앞 행을 닫지 않으면 이중 환불이 된다 | GAT-130(BAT-425) 지시서와 정리 목록 RV-08 줄에 '새 멱등키 전송 전에 그 취소 ID의 진행 중 행을 조회로 끝내고(반영이면 환급 끝, 아니면 행을 닫은 뒤) 보낸다'를 적는다 |

## 검증

- **누가·어디서**: 검증 담당 `l3-b420-verify`(claude-opus-5-5, 2026-11-19). 계획·구현·시험·리뷰에 관여하지 않았다. 시험 커밋 `5654fd91`을 따로 된 작업 폴더(`D:/ticketpass-lane3-b420-verify`, `--detach`)로 꺼내 `pnpm install --frozen-lockfile --prefer-offline`을 하고 패키지 여섯(search-normalize·shuffle·validation·contracts·platform·pg-simulator)을 빌드했다. 리뷰 커밋 `f21f8034`은 이 파일만 고쳐 제품 코드는 같다.
  - 틀린 구현은 제품 코드(시뮬레이터 포함)에 한 번에 하나씩 넣었다. 그 서비스의 시험을 돌린 뒤 `git checkout -- <파일>`로 되돌렸다. 시험 파일은 고치지 않았다.
  - 단위 시험: 결함마다 그 서비스의 단위 시험 전체를 돌렸다. payment-svc 49파일 3,033개, purchase-svc 136파일 4,249개, ops-svc 41파일 278개, pg-simulator 6파일 109개다. 고치지 않은 트리에서는 모두 통과했다.
  - 통합 시험: 이 PC Docker에서 결함마다 관련 파일만 돌렸다(payment `payment-cancel-refund-account`·`payment-deposit`, purchase `cancellation`·`event-cancel-r-t24`, core `search-read-model`). Docker 잠금 `lane3-BAT-420`은 2026-11-19T06:27:09+09:00부터 06:45:28+09:00까지 잡았다. 시험이 띄운 컨테이너는 끝날 때 0개였고 오늘 생긴 남은 볼륨도 0개다. `bench-*` 컨테이너는 없었다.
  - 결함마다 넣은 코드는 검증 담당의 임시 스크립트에 있고 커밋하지 않았다.
- **결과: 넣은 것 40, 잡힌 것 36, 살아남은 것 4.**
  - 살아남은 넷: A05, I06, O09, O13.
  - 돈이 바로 나가는 결함은 없다. O13은 돈 길에 간접으로 닿는다. I06·O09·O13 셋은 통과 기준(SR-T8 ③, R-T41 ③)에 걸린다(아래).

| # | 자리 | 틀린 구현(계획 번호) | 잡은 시험 |
| --- | --- | --- | --- |
| V01 | payment `cancel-confirmed-payment.ts` V5 갈래 | 계좌 없는 가상계좌 재시도(행 있음)의 조회 갈래를 빼서 결제사 취소를 다시 부른다(M3) | P-T71 ③ 단위 셋 |
| V02 | 같음 | 조회 대조가 '반영 아님(RESEND)'이어도 CANCELLED로 답한다(M4) | P-T71 ③ 단위(RESEND) |
| V03 | 같음 | 장애 주입: 조회 실패(UNKNOWN)를 계좌 대기로 답한다(세 상태의 가운데) | P-T71 ③ 단위(세 상태) |
| V04 | 같음 | 카드 결제에 온 계좌를 결제사 본문에 싣는다(M6) | P-T71 ⑤ 단위, P-T71 ⑤ 통합(같은 결함을 통합으로 다시 돌림) |
| V05 | 같음 | 카드에 온 계좌를 버릴 때 지표를 올리지 않는다 | P-T71 ⑤ 단위 |
| V06 | 같음 | 결제사 계좌 거절(`REFUND_ACCOUNT_INVALID`)을 REJECTED로 답한다 | P-T71 ④ 단위 |
| V07 | 같음 | 계좌 거절 행을 FAILED 대신 CANCEL_PENDING으로 남긴다 | P-T71 ④ 단위 |
| V09 | payment `confirm-command.ts` `virtualAccountPaidOf` | 원장 상태를 보지 않는다(기한 만료 FAILED·입금 대기도 참) | P-T71 ⑥ 단위 |
| V11 | payment `toss-shaped.ts` | 계좌 칸 이름을 `refundReceiveAccount` 대신 `refundAccount`로 쓴다 | P-T71 ① 단위(토스 모양) |
| V14 | payment `cancel-confirmed-payment.ts` → 저장소 | 계좌번호를 `payment_cancel` 사유에 덧붙인다(M5) | 단위는 통과. P-T71 ① 통합 둘(DB 행 글 찾기)과 ③④ 통합 |
| N07 | 같음 | 계좌를 다시 실은 재시도도 조회 갈래로 보낸다(V5 조건을 '재시도면'으로) | P-T71 ③ 대조(계좌를 다시 실은 재시도) |
| N08 | payment `portone-gateway.ts` | 계좌가 없을 때도 본문에 `refundAccount: null`을 싣는다 | P-T71 ① 포트원 계좌 없음, 기존 P-T16 넷 |
| I01 | payment `drizzle-confirm-jobs.ts` `hasDepositEvent`·`drizzle-payment-store.ts` | 가상계좌 판정을 `virtual_account_no IS NOT NULL`로 한다(M1) | P-T71 ①②③④⑥ 통합 8 |
| I02 | payment `drizzle-confirm-jobs.ts` `beginConfirmedCancel` | 겹친 가드의 payment 쪽: 계좌 없는 가상계좌의 ACCOUNT_REQUIRED를 빼서 행을 만든다(M2) | P-T71 ② 통합(`payment_cancel` 0행) |
| N09 | pg-simulator `engine.ts` | 계좌 없는 취소의 거절을 카드 결제에도 건다 | 시뮬레이터 P-T71 ⑤와 기존 취소 시험 아홉 |
| N10 | pg-simulator `server.ts` | 토스·포트원 경로가 계좌 칸을 엔진에 넘기지 않는다 | 시뮬레이터 P-T71 ① 토스·포트원, ③, ④ |
| A01 | purchase `quote-cancellation.ts` | 입장 시작 뒤에도 결제 수단을 읽어 `refundAccountRequired`가 참이다(M7) | P-T72 ① 경계 |
| A02 | 같음 | 장애 주입: GetPayment 실패를 '계좌 필요 없음'으로 본다(M8) | P-T72 ① 503 |
| A03 | purchase `cancel-ticket.ts` | 장애 주입: 취소의 결제 수단 읽기 실패를 카드로 보고 Saga를 돈다(M8) | P-T72 ② 503 |
| A04 | 같음 | 겹친 가드의 purchase 쪽: 422 가드를 뺀다. payment가 돈은 막지만 표가 취소된다(M9) | P-T72 ②(ticket·payment·`writes` 0) |
| A05 | 같음 | 입장 시작 뒤 취소의 계좌를 버리지 않는다(M10) | **살아남음** |
| A07 | 같음 | REFUND_ACCOUNT_REQUIRED 답을 계좌 대기 대신 재시도 예약으로 처리한다(M11) | P-T72 ④ 단위 |
| A10 | purchase `refund-after-entry.ts` | 재시도 실행기가 REFUND_ACCOUNT_REQUIRED를 재시도 횟수에 넣는다(M11) | P-T72 ④ 실행기 단위 |
| A11 | 같음 | 장애 주입: ops '환불 대기' 열기 실패를 삼켜서 연 시각을 2xx 전에 쓴다(M12) | P-T72 ⑤ 단위 |
| A12 | 같음 | '환불 대기'를 환급 실패보다 먼저 연다 | P-T72 ⑤ 단위(차례) |
| A14 | purchase `start.ts` | 결제 수단 읽기 포트를 시작 조립에서 뺀다 | P-T72 시작 조립(글 읽기) |
| N01 | purchase `cancel-ticket.ts` | 가상계좌면 계좌를 버리고 카드면 넘긴다(조건 뒤집기) | P-T72 ③ 가상계좌 계좌·카드 계좌 |
| N02 | 같음 | '지금 환급' 판정에서 입장 시작을 뺀다 | P-T72 ③ 입장 시작 뒤 |
| N03 | 같음 | 결과 모름(UNKNOWN)도 계좌 대기로 처리한다 | P-T72 ④ 대조 UNKNOWN, 기존 GAT-080 시험 하나 |
| N04 | 같음 | 카드 결제도 계좌가 없으면 422다 | P-T72 ② 대조 카드 |
| N05 | purchase `refund-after-entry.ts` | 재시도 실행기가 업무 거절(REJECTED)도 계좌 대기로 처리한다 | P-T72 ④ 대조 REJECTED, 기존 GAT-090·GAT-110 시험 다섯 |
| N06 | purchase `cancel-ticket.ts` `writes.create` | 계좌번호를 취소 행 `actor` 칸에 싣는다(M5) | P-T72 ③ 단위(`created`의 계좌 글). 통합으로 다시 돌려 P-T72 ③④⑥ 통합 |
| I03 | purchase `drizzle-cancellation.ts` `dueRefunds` | 겹친 가드: 계좌 대기 행 빼기(`refund_account_required_at IS NULL`)를 뺀다 | P-T72 ④ 통합(하루 뒤 `dueRefunds`), ⑤ 통합 |
| B01 | purchase `event-refund-service.ts` | 계좌 대기 항목을 자동 정지 기록에 실패로 넣는다(M13) | R-T40 ③ 단위 |
| B02 | 같음 | COMPLETED 셈에서 계좌 대기를 뺀다(M14) | R-T40 ④ 단위 |
| I06 | core `apply-event-cancellation-status.ts` | 검색 동기화를 회차 쓰기 트랜잭션 밖(커밋 뒤의 다른 트랜잭션)에서 부른다(M15) | **살아남음** |
| O01 | ops `event-cancellations.ts` `#applyCore` | 장애 주입: core가 실패해도 `core_applied_at`을 쓴다(M16) | R-T41 ③ 단위 넷 |
| O02 | 같음 | 성공한 뒤에 `core_applied_at`을 쓰지 않는다(M16) | R-T41 ③ 단위 셋 |
| O09 | ops `http-core-event-status.ts` | 장애 주입: 연결 실패·시간 초과(`request`가 던짐)를 204로 읽는다 | **살아남음** |
| O13 | ops `approve` | core 반영을 Start(일괄 환불 시작) 앞으로 옮긴다 | **살아남음** |

- I06은 첫 실행 때 관계없는 시험 하나(HOT-280의 읽은 줄 수)가 실패했다. 다른 갈래 시험과 함께 돌아 부하가 컸던 때다. 고치지 않은 트리와 같은 결함 트리를 다시 돌리니 32개가 모두 통과해 '살아남음'으로 적었다.
- **구현 전에도 통과한 12개**(위 '실패 확인'): 모두 이번 틀린 구현으로 실패를 봤다.

| 구현 전에 통과한 시험 | 실패시킨 결함 |
| --- | --- |
| 시뮬레이터 토스 모양 ① | N10 |
| 시뮬레이터 카드 ⑤ | N09 |
| 시뮬레이터 포트원 ① | N10 |
| payment 단위 대조: 계좌를 다시 실은 재시도 | N07 |
| payment 단위 대조: 계좌 없는 포트원 본문 | N08 |
| payment 통합 ⑤ 카드 결제의 본문 | V04(통합으로 다시 돌림) |
| purchase HTTP 대조: 카드 결제(② 대조) | N04 |
| purchase HTTP 대조: 가상계좌에 계좌를 실은 취소(③) | N01, N06 |
| purchase HTTP 대조: 입장 시작 뒤 취소(③) | N02 |
| purchase HTTP 대조: 결과 모름(④ 대조) | N03 |
| 환급 실행기의 업무 거절 대조(④) | N05 |
| purchase 통합 ⑥ 계좌 글 누설 0 | N06(통합으로 다시 돌림) |

- **겹친 가드를 하나씩 뺀 결과**:
  - 계좌 규칙(purchase 422와 payment ACCOUNT_REQUIRED): 두 쪽을 따로 뺀 A04와 I02가 각각 P-T72 ②·P-T71 ②에서 잡혔다.
  - 재시도 실행기의 계좌 대기 행 빼기(I03)는 P-T72 ④ 통합이 잡았다. `next_refund_at`을 비우는 것은 가드가 되지 못한다. `dueRefunds`는 `next_refund_at`이 빈 REFUND_PENDING 행도 집기 때문이다. 그래서 `refund_account_required_at IS NULL` 하나만이 그 행을 막는다.
  - 표시 칸 CHECK(`order_cancellation_refund_account_case_check`)는 넣지 않았다. P-T72 ④ 통합이 제약 이름과 23514를 직접 단언하는 것을 읽어서 확인했다.
  - 카드 결제의 계좌 버리기(purchase·payment 두 곳): payment 쪽(V04)은 잡혔다. purchase 쪽은 N01이 뒤집은 조건으로 함께 잡혔다.
- **복구 경로 장애 주입**:
  - 결제사 조회 실패(V03): 잡혔다.
  - 결제 수단 읽기 실패(A02·A03): 잡혔다.
  - ops CS 5xx(A11): 잡혔다.
  - core 실패를 성공으로 적기(O01): 잡혔다.
  - core 연결 실패·시간 초과를 어댑터가 성공으로 읽는 것(O09): 살아남았다.
  - 계좌 대기 표시 쓰기 실패는 실행하지 않고 코드를 읽어 판단했다. 판단 결과는 이렇다.
    - 팬 취소에서 `markRefundAccountRequired`가 던지면 응답은 5xx다. 행은 REFUND_PENDING·`next_refund_at` 빔으로 남는다.
    - 그러면 다음 틱에 재시도 실행기가 그 행을 계좌 없이 다시 부른다. 계좌 없음·모양 틀림 갈래는 다시 계좌 대기가 되어 스스로 낫는다.
    - 결제사가 계좌를 거절한 행(payment FAILED)은 다르다. payment가 REJECTED로 답해 '환급 실패' 건이 열리고, '환불 대기'는 열리지 않는다. 돈은 나가지 않는다.
    - 이 실패를 넣는 시험은 없다. 시험 결과 절의 의심 ①, 리뷰 RV-03과 같은 끝으로 간다.
- **살아남은 것과 잡을 시험 제안**:
  - A05(입장 시작 뒤 취소의 계좌를 버리지 않음): 걸림 없음. 돈·권한에 걸리지 않고, 통과 기준(P-T72 ③)에는 좁은 길에서만 약하게 닿는다.
    - 대부분은 결과가 같은 결함이다. 입장 시작 뒤 취소는 ticket-svc가 REFUND_AFTER_CLOSE로 답해 payment를 부르지 않고, 취소 행에는 계좌 칸이 없다.
    - 보이는 길은 하나뿐이다. 공연 시작 뒤 다시 누름(`replayOnly`)에 ticket-svc가 첫 팬 취소 K1을 REFUND_NOW로 알려 오는 경우다. 이때 본문 계좌가 payment로 간다(계좌는 결제사에만 간다).
    - 제안: 그 길(견적 EVENT_STARTED + ticket 대역 `ALREADY_CANCELLED`·`firstResult: REFUND_NOW`, 본문에 계좌)에서 payment 대역이 계좌를 받지 않는지 단언한다. 아니면 이 길의 정책을 정본에 정한다.
  - I06(검색 동기화를 트랜잭션 밖에서): 통과 기준 SR-T8 ③('같은 트랜잭션에서')에 걸린다. 돈·권한에는 걸리지 않는다.
    - 지금 SR-T8 ③ 시험은 회차 행의 커밋 자리에 실패를 넣는다. 그래서 동기화가 같은 트랜잭션이든 커밋 뒤 따로든 둘 다 되돌려진 것처럼 보인다.
    - 이 결함 트리에서는 동기화가 실패하면 core 회차는 CANCELLED인데 공연이 검색에 남는다.
    - 제안: 실패를 검색 쪽 쓰기에 넣는다(예: 그 공연의 `search_document` 갱신에 지연 제약 트리거). 그리고 회차 행이 SCHEDULED·판 그대로인지 단언한다.
  - O09(어댑터가 연결 실패·시간 초과를 성공으로 읽음): 통과 기준 R-T41 ③('core가 실패하면 `core_applied_at`이 빈다')에 걸린다. 돈·권한에는 걸리지 않는다.
    - 이 결함이면 반영 실패에도 칸이 써진다. 다시 하기도 10분 SEV2도 돌지 않고, core 회차는 SCHEDULED로 남는다(검색·판매 상태가 어긋난다).
    - `HttpCoreEventStatus` 단위 시험은 상태 코드만 바꾸고 `request`가 던지는 경우가 없다. ops 단위·통합은 core 대역(던짐)을 꽂아 어댑터를 지나지 않는다.
    - 제안: 단위에 `request`가 시간 초과·ECONNREFUSED로 던지면 `apply`도 던지는지 단언한다. 또는 ops 통합에 실제 어댑터를 닫힌 포트로 꽂아 `core_applied_at` 빔을 본다.
  - O13(Start 앞에서 core 반영): 통과 기준 R-T41 ③과 transfer-refund §5('Start까지 끝낸 뒤')에 걸린다. 돈 길에는 간접으로 닿는다.
    - Start가 실패하면 요청은 PENDING_APPROVAL로 돌아간다. 그런데 core 회차는 이미 CANCELLED이고 검색에서 빠진다. 그 뒤 반려되면 환급 없이 회차만 취소로 보인다.
    - ops 단위 첫 시험은 이름과 주석에 '차례: Start가 core 반영보다 먼저다'를 적었다. 그러나 단언은 `f.log.indexOf('start:…') >= 0`(Start가 있었는지)뿐이라 차례를 보지 않는다.
    - 제안: Start 대역과 core 대역이 같은 기록에 쓰게 해 차례를 견준다. 그리고 Start가 실패하는 확정에서 core 호출 0을 단언한다.
- **넣지 않은 표본**(상한 40이라 뺐다): 아래는 각각 단언이 정확히 그 값을 보는지 읽어서 확인했다. 실행으로 본 것이 아니다.
  - 계획 M14의 다른 쪽(`accountPending` 0): R-T40 ④ `accountPending: 2`.
  - 취소기 둘의 ACCOUNT_PENDING 옮기기: R-T40 ① 취소기 둘.
  - 덧붙일 만한 것 셋:
    - core 멱등: core 단위 R-T41 ①의 `undefined`, 통합 ②의 판·무효화·줄 그대로.
    - 연기의 판매 멈춤: ops 단위 ④ `stopCalls` [].
    - 공유 토큰 가드 빠짐: 통합 ⑤ 401 둘.
  - 연기 시작 경계: core 단위 ⑤ 지금·+1ms.
  - 0029 CHECK 빼기: 통합 ④ 23514.
  - 일괄 환불 항목의 계좌 대기 표시 쓰기: 통합 R-T40 ① `refund_account_required_at`.
  - 늦음 표시 한 번만: ops 통합 '다시 0건'.
  - 다시 하기 간격·늦음 경계 상수: 단위 59,999·60,000ms, 9분 59초·10분.
- **판정 기준 대조**(정본 payment §11 P-T71·P-T72, transfer-refund §11 R-T40·R-T41, search §12 SR-T8 ③과 그 ID를 단 시험의 단언):
  - 단언이 비었거나 ID만 단 시험은 없었다.
  - 기준의 한 구절을 단언이 보지 않는 곳이 넷이다. R-T40 ②·P-T72 ⑤의 'CS 건이 열린다', R-T41 ③의 차례, SR-T8 ③의 '같은 트랜잭션', P-T72 ③의 재시도 실행기 몫이다.

| 항목 | 정본 판정(요지) | 시험의 단언 | 대조 |
| --- | --- | --- | --- |
| P-T71 ① | 토스 모양·포트원 본문에 계좌가 정확히, `payment_cancel`·`payment_event`·Outbox에 계좌 글 0 | 통합: 결제사 기록 대역의 본문 전체 `toEqual`(토스 `refundReceiveAccount`, 포트원 `refundAccount`·SHINHAN), 결제 DB의 모든 공개 표·모든 행과 로그에서 계좌번호(하이픈 있음·없음)·예금주 글 찾기 0 | 맞음 |
| P-T71 ② | 결제사 0, REFUND_ACCOUNT_REQUIRED, `payment_cancel` 0행 | 통합: `sent` [], 결과, 행 [], 사건·원장·시뮬레이터 잔액 그대로. 21자리 계좌도 같음 | 맞음 |
| P-T71 ③ | 결제사 취소 0·조회 1, 반영 → CANCELLED, 아님 → REFUND_ACCOUNT_REQUIRED·행 진행 중 | 통합 둘(결제사 커밋 뒤 끊김·반영 전 끊김)과 단위의 세 상태 | 맞음 |
| P-T71 ④ | 행 FAILED, REFUND_ACCOUNT_REQUIRED | 통합: 000 계좌번호로 행 FAILED·결과·돈 0, 같은 취소 ID 다시 부르면 REJECTED | 맞음 |
| P-T71 ⑤ | 카드: 본문에 계좌 없음, 지표 +1 | 통합: 본문 `toEqual`(계좌 칸 없음), 지표 `{pg="SIMULATOR"}` 1, 계좌 없는 카드는 그대로 | 맞음 |
| P-T71 ⑥ | 입금 확정 뒤·부분 취소 뒤 참, 카드·기한 만료 거짓 | 통합 둘(`payment-cancel-refund-account` ⑥, `payment-deposit` 실제 입금 흐름) | 맞음 |
| P-T72 ① | 가상계좌·입장 시작 전만 참, 뒤·카드 거짓, GetPayment 실패 503 | 단위 HTTP: 세 경우, 경계 +1ms·정각·뒤, 503 유형·칸 없음, 읽기 데드라인 300 | 맞음 |
| P-T72 ② | 422, ticket·payment·`order_cancellation` 쓰기 0, 실패 503도 0 | 단위 HTTP `nothingRan`(ticket·payment·created·좌석), 통합: 실제 ticket 행·`order_cancellation`·`payment_cancel`·결제사 호출 그대로 | 맞음 |
| P-T72 ③ | payment 대역이 받은 계좌 = 본문, 입장 시작 뒤 계좌는 payment 대역이 받지 않음(재시도 실행기의 호출에도) | 단위 HTTP·통합 ③ | 약함(작다): 재시도 실행기 몫은 손으로 만든 `DueRefund`(계좌 칸이 없는 꼴)로 부르므로 늘 참이다. 실제 근거는 취소 행에 계좌가 없다는 단언(③·⑥)이다. 좁은 길은 A05 |
| P-T72 ④ | 202 REFUND_PENDING·`refundAccountRequired`, `next_refund_at` 빔·`refund_account_required_at`·재시도 횟수 그대로, 재시도 실행기가 다시 집지 않음 | 통합: 행 칸 정확한 값, 하루 뒤 실제 `dueRefunds`에 없음 | 맞음 |
| P-T72 ⑤ | '환불 대기' 건을 한 번 열고, 2xx 뒤에만 연 시각, 실패하면 다음 틱, 환급 실패 다음 차례 | 단위 차례·지표, 통합 500 → 202 → 다시 0 | 약함: '건을 연다'를 purchase가 보낸 요청과 연 시각으로만 본다. 실제 ops-svc 받는 쪽은 이 종류를 202 `accepted: false`로 받고 저장하지 않는다(리뷰 RV-01과 같은 자리, `receive-case-requested.ts` ACCEPTED 셋). ops 쪽 결과를 보는 단언이 없다 |
| P-T72 ⑥ | 로그·Outbox·`order_cancellation`에 계좌 글 0 | 단위 로그, 통합 purchase·ticket·payment DB 모든 행 | 맞음 |
| R-T40 ① | 카드 환급, 가상계좌 두 표 결제사 0·ACCOUNT_PENDING, 행 REFUND_PENDING·빔·표시 | 통합(실제 ticket·payment gRPC) | 맞음 |
| R-T40 ② | 취소마다 '환불 대기' 한 번(틱 다시 돌려도 한 건), ops가 내려가면 다음 틱에 | 통합: ops HTTP 대역 500 → 202, 다시 돌려도 더 부르지 않음 | 약함: P-T72 ⑤와 같다. 'CS 처리함에 건이 열린다'를 ops 대역의 받은 요청으로만 본다. 실제 ops-svc는 이 종류를 만들지 않는다(RV-01). '내려감'은 500이고 연결 끊김은 아니다(같은 던짐 길이라 작다) |
| R-T40 ③ | 자동 정지 실패율·연속 실패·실패 금액에 들지 않음, 다음 틱 결제사 0 | 단위·통합: 시도 기록은 카드 둘 SUCCESS뿐, 연속 실패 0·실패 금액 0, 다음 틱 두 번 호출 그대로 | 맞음 |
| R-T40 ④ | COMPLETED, 진행 합계에 계좌 대기 2 | 단위·통합, gRPC `account_pending_orders` 2 | 맞음(ops·관제 화면 몫은 리뷰 RV-05) |
| R-T41 ① | 첫 확정: CANCELLED·검색에 남음·무효화 0·줄 0, 둘째: 빠짐·무효화 1·줄 1(EVENT_CANCELLED) | 통합: 판 +1, `['/v1/search*']`, 줄 이유·판, 이름 줄 0 | 맞음 |
| R-T41 ② | 같은 요청 다시: 바뀐 것·무효화·줄 0 | 통합: 회차 행 `toEqual`, 검색 판·무효화·줄 수 그대로 | 맞음 |
| R-T41 ③ | core 실패 → 확정 202·칸 빔, 살아나면 다시 하기 1번·칸, 10분 SEV2 요청마다 1번 | 단위(9분 59초·10분·그 뒤 0, 20건·21건째, 1분 경계)·통합(실제 DB 잡기·SKIP LOCKED·늦음 경계, 서비스 HTTP) | 약함: '확정이 Start까지 끝낸 뒤'의 차례를 단언이 보지 않는다(O13). 실패 주입이 모두 core 대역이라 실제 어댑터의 연결 실패·시간 초과 길이 없다(O09) |
| R-T41 ④ | POSTPONED·바뀐 시작, 판매 멈춤 없음 | core 통합(시작·끝·입장 시작 옮김, 오픈 시각 그대로), ops 단위 `stopCalls` [] | 맞음 |
| R-T41 ⑤ | 404, 409 `event-status-conflict`, 401, 셋 다 쓰기 0 | 통합: 유형까지, 401 둘, 400 넷, 전후 스냅숏 같음 | 맞음 |
| SR-T8 ③ | 회차 전부 취소가 같은 트랜잭션에서 동기화, 커밋 뒤 무효화·`search_removed` | 통합: 커밋 자리 실패 주입 → 회차·검색·판·무효화·줄 그대로, 트리거를 치운 뒤 정상 | 약함: 실패를 회차 행 커밋에 넣어서 '같은 트랜잭션'을 증명하지 못한다(I06) |

- **장부**: `node tools/ci/ledger.mjs --batch BAT-420`(이 폴더)은 항목 48개다. 상태는 자동 시험 47, 다른 단계 1이다.
  - 다른 단계 1은 SR-T8 ③이다. `docs/review/ledger/search.md`가 'LCH-090·GAT-110'으로 둔 대로다.
  - GAT-110 쪽은 이 묶음 시험이 생겼다. 판매 중지(LCH-090) 쪽이 남아 있으므로 '다른 단계'가 맞다.
  - `--require`는 그 1건으로 실패한다(지시서 §1과 같다).
- **검증 폴더**: `git worktree remove`가 'Filename too long'으로 폴더 지우기에 실패했다. worktree 등록은 풀렸고 `D:/ticketpass-lane3-b420-verify` 폴더(apps·node_modules 등)는 남겨 두었다.

### 고친 곳 검증

- **누가·어디서**: 검증 담당 `l3-b420-verify`(claude-opus-5-5, 2026-11-19). 계획·시험·구현·리뷰에 관여하지 않았다.
  - 리뷰 반영 머리 `fa909a81`을 따로 된 작업 폴더 `D:/ticketpass-lane3-b420-v2`(`--detach`)로 꺼냈다. `pnpm install --frozen-lockfile --prefer-offline`을 하고 패키지 여섯을 빌드했다(search-normalize·shuffle·validation·contracts·platform·pg-simulator).
  - 리뷰 다시 보기 커밋 `c91defdc`는 이 파일만 고쳐 제품 코드는 같다.
  - 틀린 구현은 제품 코드에 하나씩 넣었다. 서비스 시험을 돌린 뒤 `git checkout -- <파일>`로 되돌렸다. `packages/validation`을 고친 결함은 넣은 뒤와 되돌린 뒤 모두 그 패키지를 다시 빌드했다. 시험 파일은 고치지 않았다.
  - 단위 시험은 결함마다 서비스 전체를 돌렸다(payment 3,039, purchase 4,256, ops 288, core 517, validation 29). 고치지 않은 트리에서 모두 통과했다.
    - 하나는 뺐다. ops `test/event-cancellation-core-apply-main.test.ts`(main.ts를 띄우는 둘)는 고치지 않은 트리에서도 30초 시간 초과로 실패했다. 그래서 ops 실행에서는 이 파일을 뺐다(`--exclude`). 시험 담당이 알린 부하 흔들림과 같다.
  - 통합 시험은 관련 파일만 돌렸다: payment `payment-cancel-refund-account`, purchase `cancellation`, core `search-read-model`, ops `event-cancellations`.
  - Docker 잠금 `lane3-BAT-420`은 세 번 잡았다. 08:56:19~09:01:23, 09:04:09~09:04:34, 09:04:45~09:05:02(+09:00)이다.
    - 처음 08:44~08:56에는 `lane1-BAT-057`이 잡고 있어 기다렸다.
    - `bench-*` 컨테이너는 없었다. 끝날 때 새 컨테이너 0개, 오늘 남은 볼륨 0개다.
- **결과: 넣은 것 30, 잡힌 것 28, 살아남은 것 2(P04, Q22).**
  - 돈·권한·통과 기준에 걸리는 생존은 없다.
  - 지난 검증에서 살아남은 넷은 이렇게 됐다. O13(P01)·O09(P02)·I06(P03)은 잡혔다. A05(P04)는 혼자는 여전히 살아남지만, 다시 누름의 계좌 넘기기(P05)와 겹치면 T10이 잡는다(아래).

| # | 자리 | 틀린 구현 | 잡은 시험 |
| --- | --- | --- | --- |
| P01 | ops `approve` | core 반영을 Start 앞으로(지난 O13) | T7 R-T41 ③ 차례 |
| P02 | ops `http-core-event-status.ts` | 연결 실패·시간 초과를 204로(지난 O09) | T8 단위(ECONNREFUSED·TimeoutError), T8 통합(실제 어댑터를 닫힌 포트에) |
| P03 | core `apply-event-cancellation-status.ts` | 검색 동기화를 커밋 뒤 다른 트랜잭션에서(지난 I06) | T9 SR-T8 ③ 통합(`search_document` 커밋 실패 → 회차 그대로) |
| P04 | purchase `cancel-ticket.ts` | 입장 시작 뒤 취소의 계좌를 버리지 않는다(지난 A05) | **살아남음**(단위·통합 T11) |
| P05 | 같음 `#replay` | 다시 누름이 본문 계좌를 payment에 넘긴다(R7) | P-T73 ⑤ 단위(새 멱등 키 다시 누름) |
| P06 | purchase `http-refund-account-notice.ts` | CS 본문 category를 `REFUND_ACCOUNT`로 | T1 P-T75 ① 어댑터 본문 = 공용 표, P-T72 ⑤ |
| P07 | payment `cancel-confirmed-payment.ts` | 결제사 UNKNOWN에 행을 FAILED로 끝낸다 | T2 P-T73 ② 쓰임새(mark 0) 외 둘 |
| P08 | ops `grpc-event-refunds.ts` | `account_pending_orders` 대신 `total_orders`를 읽는다 | T5 R-T40 ⑤ 2와 옛 답 0 |
| P09 | ops 메모리 저장소 잡기 | 한 바퀴 안 부르는 차례를 확정 시각 거꾸로 | T6 R-T41 ⑥ P1 → P2, 대체, 20건 |
| Q01 | ops `receive-case-requested.ts` | 받는 종류에서 `REFUND_ACCOUNT_PENDING`을 뺀다(R1) | P-T75 ① ops 둘, `cases.test` |
| Q02 | purchase `cs-case-response.ts` | `accepted` 판정을 뺀다(2xx만, R2) | P-T75 ②③ |
| Q03 | 같음 | `accepted !== true` → `=== false`(칸 없음·JSON 아님이 지나감) | P-T75 ③ |
| Q04 | payment V5 갈래 | 행이 있어도 계좌가 있으면 다시 보낸다(R3) | P-T73 ①, P-T71 ③ 대조(뒤집은 것) |
| Q05 | payment `toss-shaped.ts` | `IDEMPOTENCY_KEY_REUSED`를 REJECTED로(R4) | P-T73 ② 어댑터 |
| Q06 | payment 쓰임새 | 계좌 거절 행에 `fail_reason`을 쓰지 않는다(R5) | 단위는 통과. P-T73 ③ 통합 둘 |
| Q07 | payment `drizzle-confirm-jobs.ts` | `fail_reason`을 읽지 않고 FAILED는 늘 REJECTED(R5) | P-T73 ③ 통합 둘 |
| Q08 | purchase `#replay` | 계좌 대기 행에도 payment를 부른다(R6) | 단위는 통과. P-T73 ④ 통합 |
| Q09 | purchase `drizzle-cancellation.ts` `findCancellation` | 계좌 대기 표시를 읽지 않는다(R6) | P-T73 ④ 통합 |
| Q10 | `packages/validation` 은행 코드 | 두 자리 → 두·세 자리(`088` 지나감) | P-T74 ① 공용 함수·purchase HTTP |
| Q11 | payment `payment-gateway.ts` 은행 코드 | 같은 결함을 payment 사본에 | P-T74 ② 같은 표 |
| Q12 | validation 계좌번호 | 숫자 1~20 → 1~21 | P-T74 ① 둘 |
| Q13 | 같음 | 숫자 1~20 → 1~19 | P-T74 ① 경계 대조(20자) 둘 |
| Q14 | validation 예금주 | 60자 → 61자 | P-T74 ① 둘 |
| Q16 | purchase 컨트롤러 | 본문 모양 검사를 뺀다(payment가 가린다, R8) | P-T74 ①(400·재인증 0·Saga 0) |
| Q17 | payment 쓰임새 | 포트원 대응표 검사를 뺀다(어댑터가 행을 만든 뒤 거절, R9) | P-T74 ③ 단위·통합 |
| Q18 | ops `grpc-event-refunds.ts` | `accountPending`을 싣지 않는다(R10) | R-T40 ⑤ 어댑터 |
| Q20 | ops 메모리 저장소 `markCoreApplied` | 앞 요청 대체 표시를 뺀다(R11) | R-T41 ⑥ P1 다시 부르지 않음 |
| Q22 | 같음 `claimCoreApplies` | 잡기 차례에서 '다음 볼 시각 빈 값 먼저'를 빼고 확정 시각만(R12) | **살아남음** |
| Q23 | ops `CORE_APPLY_REJECTED_RETRY_MS` | 4xx 미룸 600,000 → 60,000 | R-T41 ⑥ 21건·다음 볼 시각 |
| Q25 | core `decideEventStatus` | '이미 같은 상태'를 '지금보다 이름' 뒤로(옛 동작, R13) | R-T41 ⑥ core 단위 |

- 아래 셋은 셈(30)에 넣지 않은 다시 실행이다.
  - P04+P05: 넣은 두 결함을 함께 넣었다. 겹친 가드 확인이다.
  - Q06·Q08: 단위가 통과해 같은 결함을 통합으로 다시 돌렸다.
  - P02: 단위로 잡힌 뒤 통합으로도 돌렸다.
- **'처음부터 통과' 11개**: 10개는 틀린 구현으로 실패를 봤다.

| 시험 | 실패시킨 결함 |
| --- | --- |
| T1 어댑터 다섯 본문이 표와 같다 | P06 |
| T2 쓰임새가 결제사 UNKNOWN에 행을 끝내지 않는다 | P07 |
| T4 경계 대조가 지난다 | Q13 |
| T5 칸 없는 옛 답은 0 | P08 |
| T6 둘 다 비면 P1 → P2 | P09 |
| T7 Start 뒤에만 core | P01 |
| T8 어댑터 연결 실패·시간 초과(단위) | P02 |
| T8 실제 어댑터를 닫힌 포트에(통합) | P02(통합으로 다시 돌림) |
| T9 검색 쪽 쓰기 실패면 회차도 되돌림 | P03 |
| T10 공연 시작 뒤 다시 누름의 계좌 | P04+P05(둘 중 하나만으로는 실패하지 않음) |
| T11 재시도 실행기는 실제로 집은 행으로도 계좌를 싣지 않는다 | **실패를 보지 못함**: P04를 넣어도 통과한다. 계좌를 저장하는 곳이 없어 실행기가 계좌를 가질 길이 없다. 이 시험은 '취소 행에 계좌가 없다'는 구조를 지키는 회귀 시험이다(지난 검증의 P-T72 ③ '약함'과 같은 성질) |

- **살아남은 둘**:
  - P04(A05, 입장 시작 뒤 계좌를 버리지 않음): 돈·권한·통과 기준에 걸리지 않는다. 이제는 결과가 같은 결함이다.
    - 지난 검증 때 보이던 길은 공연 시작 뒤 다시 누름이었다. 그 길은 I2(`#replay`가 계좌를 넘기지 않음)로 닫혔다.
    - P05와 함께 넣으면 T10이 잡는다. 두 가드가 겹쳐 있고, 바깥 가드(P05 쪽)는 단독으로 잡힌다.
    - 더 둘 시험은 없다(제안 없음).
  - Q22(잡기 차례의 '빈 값 먼저'를 뺌): 돈·권한에 걸리지 않는다. 통과 기준 R-T41 ⑥은 '늘 4xx 21건'만 말하므로 걸리지 않는다.
    - 지금 21건 시험은 4xx 행을 10분 미루는 것(Q23이 잡음)만으로 지나간다. 그래서 차례 규칙이 겹친 가드로 숨는다.
    - 차례 규칙이 혼자 막는 것은 늘 5xx·무응답인 요청 21건이다. 이들은 1분 뒤 다시 잡힌다. 새 요청이 확정 시각이 늦어 그 뒤로 밀린다.
    - 제안: 메모리·DB 저장소 각각에 '늘 503인 요청 21건 + 새 요청 1건 → 다음 바퀴(1분 뒤)에 새 요청이 반영'을 둔다. DB 쪽 `order by core_apply_next_at nulls first`도 같은 시험으로 본다(이번에는 넣지 않음).
- **넣지 않은 표본**(상한 30): 아래는 시험을 읽어서만 확인했고 실행으로 본 것이 아니다.
  - DB 저장소의 대체 표시 빼기: ops 통합 R-T41 ⑥이 `core_apply_superseded_at` not null·P1 `core_applied_at` null·다음 바퀴 호출 [].
  - 401도 10분 미룸: 단위 R-T41 ⑥ 다음 볼 시각(401 + 60,000).
  - payment 사본의 계좌번호·예금주 경계: P-T74 ② 같은 표.
  - openapi `RefundAccount` 조임과 생성물: 계약 잡 몫이라 넣지 않았다.
- **새로 본 것(고치지 않은 트리)**: ops 통합 `test-int/event-cancellations.int.test.ts`의 'R-T41 ③ 0016은 core_applied_at·core_apply_next_at·core_apply_overdue_at(빈 값 허용)…'이 `fa909a81`에서 결함 없이도 실패한다.
  - 기대는 `core_%` 칸 셋인데 받은 것은 넷이다. I6이 `core_apply_superseded_at`을 더했다.
  - 리뷰 반영이 기존 시험을 따라 고치지 않은 것이다(payment `payment-schema.test.ts`와 같은 종류). CI ops 통합이 이 1건으로 빨갛게 될 것이다.
  - 시험 담당 몫: 기대 칸에 `core_apply_superseded_at`을 더한다. 색인 정의 단언에 `core_apply_superseded_at IS NULL`·`core_apply_next_at NULLS FIRST`도 더하기를 권한다.
- **판정 기준 대조**(정본 payment §11 P-T73~P-T75, transfer-refund §11 R-T40 ⑤·R-T41 ⑥과 그 ID를 단 시험):
  - 단언이 비었거나 ID만 단 시험은 없다.
  - 약한 곳은 둘이다. P-T74 ① 경계 대조 시험 이름, R-T41 ⑥의 '회차 시작은 P2의 값'이다.

| 항목 | 정본 판정(요지) | 시험의 단언 | 대조 |
| --- | --- | --- | --- |
| P-T73 ① | 결과 모름 진행 중 행에 다른 계좌(띄어쓰기만 다른 예금주 포함): 결제사 취소 0·조회 1, 결제사 기록 본문 하나 | payment 통합: 결제사 `drop` 주입으로 진행 중, 예금주 둘마다 `POST` [], `GET` 1, `payment_cancel` REQUESTED 그대로, 첫 본문 `refundReceiveAccount` 그대로, 잔액 그대로. 단위: 호출 `['begin', 'query', 'settle']`·취소 0 | 맞음 |
| P-T73 ② | 멱등키 재사용 답 → UNKNOWN, 행 진행 중(FAILED 아님) | 통합: 시뮬레이터 `IDEMPOTENCY_KEY_REUSED`로 UNKNOWN·행 REQUESTED. 단위: 토스·시뮬레이터 어댑터, 쓰임새 mark 0 | 맞음 |
| P-T73 ③ | 계좌 거절 행을 맞는 계좌로 다시: 결제사 0·REFUND_ACCOUNT_REQUIRED. 다른 업무 거절은 REJECTED | 통합 둘: `fail_reason` `REFUND_ACCOUNT_INVALID`·결제사 0·결과, 대조 `NOT_CANCELABLE_PAYMENT` → REJECTED·`fail_reason` 빔 | 맞음 |
| P-T73 ④ | 새 멱등 키 다시 누름: 202 REFUND_PENDING·`refundAccountRequired`, payment 0, `refund_failed_at` 빔, CS 건은 '환불 대기' 하나 | purchase 통합: 결과, `paymentCalls`·`gatewayCalls` [], 행 칸, 다시 열기 뒤 ops 대역이 받은 건 `[['REFUND_ACCOUNT_PENDING', 첫 취소 ID]]` | 맞음 |
| P-T73 ⑤ | 다시 누름(공연 시작 뒤 포함)의 계좌를 payment 대역이 받지 않음 | purchase HTTP 둘(새 멱등 키·공연 시작 뒤) | 맞음(공연 시작 뒤는 겹친 가드라 P04+P05로 실패를 봤다) |
| P-T74 ① | 틀린 모양 여덟은 400 `invalid-body`·재인증 확인·결제 수단 읽기·Saga 0. 경계 대조(20자·하이픈 30자·60자)는 지남 | purchase HTTP: 공용 표의 틀린 8개마다 400·유형·`verifies` 0·`lookups` []·`nothingRan`. 맞는 것은 202·payment 호출 1. validation 단위 | 약함(작다): 경계 대조 시험 이름은 'payment 대역이 받은 계좌는 본문 그대로'인데, 단언은 호출 수(1)뿐이고 받은 계좌 값은 견주지 않는다 |
| P-T74 ② | 같은 경우마다 payment 판정이 purchase와 같다 | payment `refund-account-shape.test.ts`가 같은 JSON 표로 `refundAccountOf` | 맞음(Q11이 잡음) |
| P-T74 ③ | 포트원 대응표 밖 코드: `payment_cancel` 0행·결제사 0·REFUND_ACCOUNT_REQUIRED, 같은 취소 ID를 대응표 안 코드로 → 결제사로 | payment 통합·단위 | 맞음 |
| P-T75 ① | 종류 다섯마다 ops-svc가 `accepted: true`, 건 한 번(같은 eventKey 다시 보내도 한 건) | purchase: 어댑터 다섯의 본문 = 공용 표 `cs-case-bodies.json`. ops: 같은 표를 실제 `CasesController`·쓰임새·메모리 저장소에 넣어 `accepted: true`·`caseId`·한 건 | 맞음. 두 서비스를 한 실행에서 잇지 않고 공용 표로 잇는다. 표를 바꾸면 두 쪽이 함께 따라가는 꼴이다(P06·Q01이 각 쪽을 잡음) |
| P-T75 ② | 2xx `accepted: false` → 연 시각 빔, 지표 +1, 다음 틱 다시 | purchase 단위: 틱 끝 다시 열기·지표 `{kind="REFUND_ACCOUNT_PENDING"}` | 맞음 |
| P-T75 ③ | 어댑터 모두 같은 판정 | purchase 단위: 다섯 어댑터 × (`accepted: false`·칸 없음·JSON 아님) → `CsCaseRejected` | 맞음 |
| R-T40 ⑤ | 관제 상세 `progress.accountPending` 2(ops가 purchase 진행 답에서) | ops HTTP(진행 대역 → 상세 응답 2, 결제사별 몫에는 없음, 없으면 칸 없음)와 gRPC 어댑터(`account_pending_orders` 2 → 2, 옛 답 0) | 맞음. HTTP 시험은 진행 대역을 쓰고 어댑터 시험이 따로 잇는다 |
| R-T41 ⑥ | P1 미반영·P2 반영 → 다음 바퀴 P1 0·`core_apply_superseded_at`·회차 시작은 P2 값, 늘 4xx 21건이어도 새 요청 반영, 같은 시각 지난 연기 204 | ops 단위(호출·대체·21건·다음 볼 시각), ops 통합(실제 DB 대체 칸), core 단위(`UNCHANGED`, 다른 시각은 409) | 약함(작다): '회차 시작은 P2의 값 그대로'를 core 상태로 보지 않고 P1 호출 0으로 갈음한다. core 대역이라 회차 시각을 읽지 않는다. 21건 단언은 4xx 미룸만으로 지나가 차례 규칙을 따로 보지 않는다(Q22) |

## 리뷰 반영 계획

- **누가·무엇을**: 계획 담당 `l3-b420-plan`(claude-opus-5-5, 2026-11-19). 바탕은 위 '리뷰'(`f21f8034`, RV-01~11)와 '검증'(`94da0926`, 살아남은 A05·I06·O09·O13, 판정 대조 약함 넷)이다. 처리는 감독이 정했다. 정본 빈칸은 이 커밋에서 먼저 썼다(모두 '추천 적용, 2026-11-19, BAT-420-rest 리뷰 반영'): payment §6 '구현에서 정한 것' ②(포트원 대응표)·④(같은 취소 ID = 같은 답)·⑥(같은 멱등키에는 첫 본문만)·⑦(계좌 모양 한 규칙)과 '계좌 대기' 끝(관제 `progress.accountPending`, 계좌 대기 행의 다시 누름), payment §11 P-T73·P-T74·P-T75(새 줄), transfer-refund §3.1 ⑥ '실패 기록'(`accepted: true`), §5 'core 반영의 구현에서 정한 것' ⑥(요청 사이의 차례), §11 R-T40 ⑤·R-T41 ⑥(새 세부), asvs/transfer-refund.md 'BAT-420-rest 계획 메모', ADR-0285 '되돌릴 조건', BUILD_ORDER BAT-420 '장부 범위'에 `P-T73, P-T74, P-T75`(61항목).
- **차례**: 시험 담당이 먼저 재현 시험을 쓰고 지금 트리 `94da0926`에서 실패를 '실패 확인' 절에 적는다(구현 전 트리) → 구현 담당이 고친다(시험 파일은 고치지 않는다) → 리뷰 다시 보기 → 검증(살아남은 넷과 아래 새 틀린 구현) → 기록. 커밋 꼬리말에 `Fix-By`(시험·구현)를 단다.

### 1. 지적마다 처리

| 지적 | 처리 | 시험 담당 | 구현 담당 | 정본 위치 |
| --- | --- | --- | --- | --- |
| RV-01 높음 | 이 묶음에서 고침 | T1 | I1 | transfer-refund §3.1 ⑥ '실패 기록', payment §11 P-T75 |
| RV-02 높음 | 이 묶음에서 고침. 같은 키에는 첫 본문만, 다른 계좌는 GAT-130 경계 | T2 | I2 | payment §6 '구현에서 정한 것' ⑥, '계좌 대기' 끝, §11 P-T73 ①②⑤ |
| RV-03 중간 | 이 묶음에서 고침 | T3 | I3 | payment §6 ④, '계좌 대기' 끝, §11 P-T73 ③④ |
| RV-04 중간 | 이 묶음에서 고침 | T4 | I4 | payment §6 ②⑦, §11 P-T74 |
| RV-05 중간 | 이 묶음에서 고침(BAT-421 화면이 쓸 칸) | T5 | I5 | payment §6 '계좌 대기' 끝, transfer-refund §11 R-T40 ⑤ |
| RV-06 중간 | 이 묶음에서 고침 | T6 | I6 | transfer-refund §5 '구현에서 정한 것' ⑥, §11 R-T41 ⑥ |
| RV-07 낮음 보안 | 이 묶음에서 고침(사실대로 적기) | — | I7 | asvs/transfer-refund.md 메모, ADR-0285 '되돌릴 조건'(이 커밋) |
| RV-08 낮음 | 정리 목록으로 | — | — | — |
| RV-09 낮음 | 닫힘: 감독이 core-svc 0029를 갈래 3에 줌(develop `0daf6434`). 계획 §7 core 행을 고쳤다 | — | — | 계획 §7 |
| RV-10 낮음 | 정리 목록으로(연기 회차의 판매 설정 사본. 맡을 단계가 없으면 문안만) | — | — | — |
| RV-11 낮음 | 정리 목록으로 | — | — | — |
| 검증 O13 | 시험 보강(Start 뒤 core 반영의 차례) | T7 | — | transfer-refund §5 'core 회차 상태 반영' 첫 줄, §11 R-T41 ③ |
| 검증 O09 | 시험 보강(어댑터 연결 실패·시간 초과) | T8 | — | §11 R-T41 ③ |
| 검증 I06 | 시험 보강(검색 동기화가 같은 트랜잭션) | T9 | — | search §12 SR-T8 ③ |
| 검증 A05 | 시험 보강 + I2의 '다시 누름은 계좌를 넘기지 않음'이 길을 닫는다 | T10 | (I2) | payment §6 '계좌 대기' 끝, §11 P-T73 ⑤ |
| 판정 대조 P-T72 ③ | 시험 보강(재시도 실행기 몫을 실제 집은 행으로) | T11 | — | payment §11 P-T72 ③ |
| 판정 대조 R-T40 ②·P-T72 ⑤ | RV-01과 같은 자리라 T1이 메운다 | (T1) | (I1) | P-T75 |
| 판정 대조 R-T41 ③·SR-T8 ③ | T7·T8·T9가 메운다 | (T7~T9) | — | — |

### 2. 시험 담당 몫(재현 먼저, `94da0926`에서 실패를 본다)

| # | 시험(이름은 ID로 시작) | 파일 | 단언 | 구현 전 트리에서 |
| --- | --- | --- | --- | --- |
| T1 | `P-T75 ①~③ …` | purchase `test/cs-case-adapters-contract.test.ts`(새): CS 건 어댑터 다섯 종류가 보내는 본문을 `test/fixtures/cs-case-bodies.json`(새)과 정확히 견준다. ops `test/cases-contract.test.ts`(새): 같은 JSON을 실제 `CasesController`·`ReceiveCaseRequested`·메모리 저장소에 넣는다. purchase `test/cs-case-response.test.ts`(있으면 더함): 2xx `{ accepted: false }` | ① 다섯 모두 202 `accepted: true`이고 건 한 개씩, 같은 본문 다시 보내도 한 건 ② `accepted: false`면 `CsCaseRejected`, 연 시각 빔, 지표 `purchase_cs_case_open_failures_total{kind="REFUND_ACCOUNT_PENDING"}` +1, 다음 틱 다시 부름 ③ 어댑터 넷(`http-entry-flag-notice`·`http-refund-failure-notice`·`http-deduction-gap-notice`·`http-refund-account-notice`, 일괄 환불 실패 포함) 모두 같은 판정. ops 기존 `test/cases.test.ts:64`의 '셋 밖은 만들지 않는다'는 정본대로 넷(환불 대기 더함)으로 고치고, 넷 밖 종류(예 `DISPUTE`)는 여전히 `accepted: false`를 둔다 | ① 환불 대기 `accepted: false`로 실패 ② 연 시각을 써서 실패 |
| T2 | `P-T73 ①② …`, `P-T73 ⑤ …` | payment `test/cancel-confirmed-payment-refund-account.test.ts`(더함)·`test-int/payment-cancel-refund-account.int.test.ts`(더함), `test/toss-shaped*.test.ts`(멱등키 재사용 코드), purchase `test/cancel-refund-account-http.test.ts`(더함) | ① 결과 모름 진행 중 행에 다른 계좌(예금주 `김결제`·`김 결제`)로 다시 부름: 결제사 취소 0·조회 1, 결제사 기록 본문 하나 ② 시뮬레이터 `IDEMPOTENCY_KEY_REUSED`(토스 모양 어댑터) → `UNKNOWN`, 행 `REQUESTED` ⑤ purchase 다시 누름(새 멱등 키, ticket 대역이 첫 취소 ID를 알림)에 본문 계좌 → payment 대역 `refundAccount` 없음. 기존 'P-T71 ③ 대조: 계좌를 다시 실은 재시도는 조회 없이 결제사 취소를 한 번 부른다'는 정본 ⑥대로 반대(취소 0·조회 1)로 고친다 | ①②⑤ 실패 |
| T3 | `P-T73 ③④ …` | payment `test-int/payment-cancel-refund-account.int.test.ts`(더함), purchase `test-int/cancellation.int.test.ts`(더함) | ③ `000` 계좌로 거절된 행을 같은 취소 ID·맞는 계좌로 다시: 결제사 0·`REFUND_ACCOUNT_REQUIRED`·`fail_reason` `REFUND_ACCOUNT_INVALID`. 업무 거절(시뮬레이터의 다른 거절)로 끝난 행은 `REJECTED`·`fail_reason` 빔 ④ 팬이 계좌 거절 뒤 새 키로 같은 표 다시 누름: 202 `REFUND_PENDING`·`refundAccountRequired` 참, payment 호출 0, `refund_failed_at` 빔, 다시 열기 한 틱 뒤 ops 대역이 받은 건은 `REFUND_ACCOUNT_PENDING` 하나뿐. 기존 P-T71 ④의 '같은 취소 ID 다시 부르면 REJECTED'는 ③대로 고친다 | ③④ 실패 |
| T4 | `P-T74 ①~③ …` | 공용 함수 `packages/validation/test/refund-account.test.ts`(새), purchase `test/cancel-refund-account-http.test.ts`(더함), payment `test/refund-account-shape.test.ts`(새, 같은 표를 읽는다) | ① 틀린 모양 각각 400 `invalid-body`, 재인증 대역 `verify` 0번·결제 수단 읽기 0·Saga 0. 경계 대조 셋은 지남 ② 같은 표를 payment 판정에 넣어 같은 결과 ③ 포트원 대응표 밖 두 자리 코드 → `payment_cancel` 0행·결제사 0·`REFUND_ACCOUNT_REQUIRED`, 같은 취소 ID를 대응표 안 코드로 → 결제사로 감. 기존 시험의 계좌 표본(`bankCode: '088'` 등, R-T39·P-T72)은 정본 ②의 두 자리 코드로 고친다(이름·단언은 그대로) | ①③ 실패(①은 202, ③은 `FAILED` 행) |
| T5 | `R-T40 ⑤ …` | ops `test/grpc-event-refunds.test.ts`(있으면 더함, 없으면 새), `test/event-cancellations-http.test.ts`(더함) | 어댑터가 `account_pending_orders` 2를 `accountPending` 2로 읽고, 관제 상세 응답 `progress.accountPending` 2. 칸이 없는 옛 답(0)은 0 | 실패 |
| T6 | `R-T41 ⑥ …` | ops `test/event-cancellation-core-apply.test.ts`(더함, 가짜 시계·core 대역)·`test-int/event-cancellations.int.test.ts`(더함), core `test/event-cancellation-status.test.ts`(더함) | 같은 회차 P1(확정 t1, core 실패)·P2(t2, 반영): 다음 바퀴 core 호출 0, P1 `core_apply_superseded_at` 있음·`core_applied_at` 빔, 회차 시작 P2 값. 같은 바퀴에 둘 다 빔이면 P1 → P2 차례로 부르고 P1 반영 뒤 P2. 늘 4xx 21건 + 새 요청 1: 첫 바퀴에 새 요청 반영, 4xx 행의 다음 볼 시각 = 지금 + 10분(5xx는 + 1분). core: 같은 시각으로 이미 연기된 회차를 그 시각 + 1ms에 다시 받으면 `UNCHANGED`(204) | 실패 |
| T7 | `R-T41 ③ 확정은 Start를 끝낸 뒤에만 core를 부른다` | ops `test/event-cancellation-core-apply.test.ts`(더함) | Start 대역과 core 대역이 한 기록 배열에 쓰고 `start` 다음 `core` 차례를 `toEqual`로 본다. Start가 실패하는 확정(503)에서 core 호출 0 | 지금 구현은 맞아 통과할 수 있다. 검증 O13 틀린 구현으로 실패를 본다 |
| T8 | `R-T41 ③ 어댑터는 연결 실패·시간 초과를 실패로 던진다` | ops `test/http-core-event-status.test.ts`(더함) | `request`가 시간 초과 오류·`ECONNREFUSED`로 던지면 `apply`도 던진다(두 경우). 선택: ops 통합에 실제 어댑터를 닫힌 포트로 꽂아 확정 뒤 `core_applied_at` 빔 | O09로 실패를 본다 |
| T9 | `SR-T8 ③ 검색 쪽 쓰기가 실패하면 회차 상태도 되돌려진다` | core `test-int/search-read-model.int.test.ts`(더함) | 그 공연의 `search_document` 갱신에 지연 제약 트리거(커밋 때 실패)를 걸고 취소 반영: 500(또는 5xx), 회차 `status` SCHEDULED·`version` 그대로, 무효화 0, `search_removed` 0. 트리거를 치운 뒤 정상 | I06으로 실패를 본다 |
| T10 | `P-T73 ⑤ 공연 시작 뒤 다시 누름의 계좌는 payment로 가지 않는다` | purchase `test/cancel-refund-account-http.test.ts`(더함) | 견적 EVENT_STARTED, ticket 대역 `ALREADY_CANCELLED`·`firstResult: REFUND_NOW`, 본문 계좌 → payment 대역이 받은 호출에 `refundAccount` 없음 | 지금 실패할 수 있다(검증 판단). 아니면 A05로 본다 |
| T11 | `P-T72 ③ 재시도 실행기는 실제로 집은 행으로도 계좌를 싣지 않는다` | purchase `test-int/cancellation.int.test.ts`(더함) | 입장 시작 뒤 취소(본문에 계좌)를 실제 DB에 쓰고 마감 뒤 실제 `dueRefunds`·실제 실행기로 돌린다. payment 대역 호출에 `refundAccount` 없음 | 지금 구현은 맞아 통과할 수 있다. A05·M10 틀린 구현으로 본다 |

- 단언 값은 정본에서 가져온다(10분·1분·`REFUND_ACCOUNT_INVALID`·`accepted`·모양 규칙). 시험의 시계 값은 코드 상수와 다르게 고른다.

### 3. 구현 담당 몫(시험 커밋 뒤, 시험 파일은 고치지 않는다)

| # | 할 일 | 파일 |
| --- | --- | --- |
| I1 | ops `ACCEPTED`에 `REFUND_ACCOUNT_PENDING`을 더하고 머리 주석을 넷으로. purchase `requireAccepted`가 2xx와 본문 `accepted === true`를 함께 보고, 아니면 `CsCaseRejected`(다시 열기가 잇는다). CS 건 어댑터 모두 이 함수를 쓴다 | `services/ops-svc/src/modules/cases/application/receive-case-requested.ts`, `services/purchase-svc/src/modules/refund/adapters/cs-case-response.ts`와 어댑터들 |
| I2 | payment: 가상계좌 결제에서 그 취소 ID 행이 있으면 계좌와 관계없이 조회 대조로만(⑥). 결제사 멱등키 재사용 답 → `UNKNOWN`(시뮬레이터 `IDEMPOTENCY_KEY_REUSED`, 토스·포트원 코드는 공식 문서 대조 뒤 머리 주석에 날짜). purchase `#replay`는 계좌를 넘기지 않는다 | `cancel-confirmed-payment.ts`, `toss-shaped.ts`·`portone-gateway.ts`·`simulator-gateway.ts`, `services/purchase-svc/src/modules/refund/application/cancel-ticket.ts` |
| I3 | payment 마이그레이션(아래 §4)으로 `payment_cancel.fail_reason`. 계좌 거절 때 `REFUND_ACCOUNT_INVALID`를 쓰고, 그 행의 다시 부름은 결제사 0·`REFUND_ACCOUNT_REQUIRED`. purchase `#replay`: 행에 `refund_account_required_at`이 있으면 payment를 부르지 않고 실패 표시 없이 202 `REFUND_PENDING`·`refundAccountRequired` 참 | payment `drizzle-confirm-jobs.ts`·`cancel-confirmed-payment.ts`·schema, purchase `cancel-ticket.ts` |
| I4 | 공용 함수(예 `refundAccountShape(v): { ok: true; value } \| { ok: false }`)를 `packages/validation`에 두고 purchase 본문 검사(zod)와 payment `refundAccountOf`가 쓴다. openapi `RefundAccount`에 `pattern`·`maxLength`·`minLength`와 설명. 포트원 대응표 검사를 `beginConfirmedCancel` 앞으로. 생성물 두 패키지 다시 만들기 | `packages/validation/src/`, purchase `ticket-cancellation.controller.ts`, payment `payment-gateway.ts`·`portone-gateway.ts`·`cancel-confirmed-payment.ts`, `docs/api/openapi.yaml`, `packages/contracts`·`packages/api-client` |
| I5 | ops 어댑터가 `account_pending_orders`를 읽고 관제 상세 `progress.accountPending`(정수, 필수 아님)에 싣는다. openapi `EventCancellationRequest.progress`에 칸, 생성물 다시 만들기 | `services/ops-svc/src/adapters/grpc-event-refunds.ts`, `…/event-cancellations/inbound/views.ts`, `docs/api/openapi.yaml` |
| I6 | ops 0016에 `core_apply_superseded_at`(부분 인덱스 조건에도 넣음). 잡기 차례 `core_apply_next_at NULLS FIRST`, 같은 회차는 `approved_at` 차례, 반영 성공과 같은 트랜잭션에서 앞 요청에 대체 표시, 4xx(401 제외) 다음 볼 시각 + 10분. core `decideEventStatus`는 '이미 같은 상태'를 먼저 | `services/ops-svc/migrations/0016_…sql`·journal, `…/adapters/db/drizzle-store.ts`, `…/application/event-cancellations.ts`, `services/core-svc/src/modules/catalog/domain/event-cancellation-status.ts` |
| I7 | core 컨트롤러 머리 주석을 '부르는 쪽은 ops-svc 하나'에서 '메시는 포트 단위라 core-svc REST 포트를 부르는 다른 서비스도 공유 토큰이 있으면 닿는다(ADR-0285)'로 | `services/core-svc/src/modules/catalog/inbound/internal-event-status.controller.ts` |

- 게이트: 계획 §11 명령에 `packages/validation` 시험·빌드를 더한다(`node / node`가 전체를 돈다, WIDEN_JS). 통합은 감독 잠금 때 payment·purchase·core·ops를 차례로.

### 4. 마이그레이션과 다른 갈래 영향

| 서비스 | 반영 | 번호 |
| --- | --- | --- |
| payment-svc | 새로 하나: `payment_cancel.fail_reason text`(CHECK: 빈 값이거나 `status = 'FAILED'`이고 값이 `REFUND_ACCOUNT_INVALID`) | **감독 확인 필요**(감독이 준 목록에 payment가 없다. 첫 지시의 갈래 3 몫 0023~0024 안이면 0023. 이 폴더의 마지막은 0021) |
| purchase-svc | 0029 그대로(새 칸 없음) | 0029 |
| ops-svc | 0016에 칸 하나(`core_apply_superseded_at`)와 인덱스 조건을 더한다(아직 develop에 없음) | 0016 |
| core-svc | 0029 그대로 | 0029 |

- 다른 갈래 영향:
  - `packages/validation`에 공용 함수를 더한다(더하기만). node 잡이 전체를 돈다.
  - openapi 공용 `RefundAccount`를 조인다. 이 스키마는 굿즈 주문 취소(core-svc shop)와 탈퇴(`DELETE /v1/identity/account`, identity-svc, PRF-174 갈래 1)도 쓴다. 돈이 같은 결제사 취소로 가므로 셋 다 같은 규칙이 맞다. 다만 그 두 서버의 본문 검사는 이 묶음에서 고치지 않는다(그 단계 몫. PRF-174 넘김 구절에 '계좌 모양은 `packages/validation` 공용 함수'를 감독이 더해 주기를 바란다). 계약 깨짐 검사가 요청 조임을 깨짐으로 보면 감독 확인이 필요하다(운영 전이라 `breaking-approved` 절차).
  - BAT-421(갈래 2) 화면은 `RefundAccount` 모양과 `progress.accountPending`을 쓴다. 넘김 문안의 선행에 'BAT-420-rest 리뷰 반영(계좌 모양·`accountPending`)'을 더해 주기를 바란다.
  - 메시 원천·생성물은 이번 반영에서 고치지 않는다(RV-07은 글만).

### 5. 새 틀린 구현(검증 담당이 넣을 것, 살아남은 넷 A05·I06·O09·O13에 더해)

| # | 틀린 구현 | 잡는 시험 |
| --- | --- | --- |
| R1 | ops 받는 종류에서 `REFUND_ACCOUNT_PENDING`을 뺀다 | T1 ① |
| R2 | purchase가 `accepted`를 보지 않고 2xx만 본다 | T1 ② |
| R3 | payment가 행이 있어도 계좌가 있으면 다시 보낸다(옛 동작) | T2 ① |
| R4 | 멱등키 재사용 답을 `REJECTED`로 읽는다 | T2 ② |
| R5 | 계좌 거절 행에 `fail_reason`을 쓰지 않는다(또는 다시 부름에 `REJECTED`) | T3 ③ |
| R6 | purchase `#replay`가 계좌 대기 행에도 payment를 부르거나 `markRefundFailed`를 쓴다 | T3 ④ |
| R7 | purchase `#replay`가 본문 계좌를 넘긴다 | T2 ⑤, T10 |
| R8 | purchase 본문 검사에서 모양 검사를 뺀다(payment가 가린다) | T4 ①(재인증 0·Saga 0) |
| R9 | 포트원 대응표 검사를 행 만든 뒤로 되돌린다 | T4 ③ |
| R10 | ops 어댑터가 `account_pending_orders`를 읽지 않는다 | T5 |
| R11 | 대체 표시를 빼서 앞 연기를 다시 반영한다 | T6 |
| R12 | 잡기 차례를 `approved_at`만으로 둔다(머리 막힘) | T6(21건) |
| R13 | core가 '지금보다 이름'을 먼저 본다(옛 동작) | T6 core |

### 6. 은행 코드의 꼴(2026-11-19 감독 지적 반영)

- **정한 꼴**: 공용 `RefundAccount.bankCode`는 토스 은행 코드 표의 숫자 코드 두 자리만 받는다(예 신한 `88`, KB국민 `06`). 금융결제원 세 자리(예 `004`·`088`)는 400 `invalid-body`이고 바꾸지 않는다. 결제사별 바꾸기는 토스 어댑터가 그대로 싣고, 포트원은 `services/payment-svc/src/modules/payment/domain/payment-gateway.ts` 대응표가 열거값으로 바꾼다. 정본은 payment §6 '구현에서 정한 것' ②의 '은행 코드의 꼴'과 openapi `RefundAccount.bankCode` 설명(이 커밋)이다.
- **근거**: 토스페이먼츠 개발자 문서 '은행 코드 및 증권사 코드'(2026-11-19 확인)는 두 자리 숫자·금융결제원 세 자리·영문 코드를 따로 두고 요청에는 두 자리를 가장 권한다. 토스 취소 API `refundReceiveAccount.bank`는 형식을 따로 적지 않고 그 표를 가리킨다. 두 꼴은 앞 0 떼기로 바뀌지 않는다(KB국민 `06`과 `004`, IBK기업 `03`과 `003`). 포트원 열거값 이름은 [가정]이다.
- **바꿀 수 있는 안(쓰지 않음, 감독 결정 대기)**: 세 자리도 받으려면 공용 함수 `refundAccountShape`가 두 꼴(두 자리 토스 코드, 세 자리 금융결제원 코드)을 받고, 세 자리는 금융결제원 → 토스 대응표(공용 `packages/validation`에 한 곳)로 두 자리로 바꾼 값을 돌려준다. 대응표에 없는 세 자리는 400이다. 서비스는 바꾼 두 자리만 다룬다(purchase·payment가 같은 함수, 결제사 어댑터는 지금 그대로). 탈퇴(identity, PRF-174)·굿즈 취소(core shop)도 같은 함수를 쓰게 된다.
- 시험 영향(지금 꼴 그대로면 없음): P-T74 ①의 '세 자리(`088`) 400'은 지금 정본과 맞다. 위 안을 고르면 그 줄과 `packages/validation` 시험 표를 바꾸는 시험 담당 몫이 생긴다.

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | l3-b420-plan | claude-opus-5-5 | 2026-11-19T03:43+09:00 | 2026-11-19T04:04+09:00 |
| impl | l3-b420-impl | claude-opus-5-5 | 2026-11-19T04:05+09:00 | 2026-11-19T04:56+09:00 |
| test | l3-b420-test | claude-opus-5-5 | 2026-11-19T04:58+09:00 | 2026-11-19T06:10+09:00 |
| review | l3-b420-review | claude-opus-5-5 | 2026-11-19T06:05+09:00 | 2026-11-19T08:31+09:00(다시 보기 08:27~08:31) |
| verify | l3-b420-verify | claude-opus-5-5 | 2026-11-19T06:06+09:00 | 2026-11-19T06:50+09:00 |
| plan | l3-b420-plan | claude-opus-5-5 | 2026-11-19T06:52+09:00 | 2026-11-19T07:00+09:00 |
| plan | l3-b420-plan | claude-opus-5-5 | 2026-11-19T08:18+09:00 | 2026-11-19T08:30+09:00 |
| test | l3-b420-test | claude-opus-5-5 | 2026-11-19T07:00+09:00 | 2026-11-19T07:42+09:00 |
| impl | l3-b420-impl | claude-opus-5-5 | 2026-11-19T07:45+09:00 | 2026-11-19T08:17+09:00 |
| test | l3-b420-test | claude-opus-5-5 | 2026-11-19T08:18+09:00 | 2026-11-19T08:22+09:00 |
| verify | l3-b420-verify | claude-opus-5-5 | 2026-11-19T08:27+09:00 | 2026-11-19T09:08+09:00 |

- 다른 담당은 자기 커밋에서 이 표에 자기 행을 더한다. 리뷰 반영 커밋은 `Fix-By`의 역할(시험·구현) 행으로 센다.
