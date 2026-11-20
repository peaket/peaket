# ADR-0328: 예매 취소 POST의 구매 세션 서명을 재인증·Origin 검사로 바꾼다 (2026-11-20)

- **상태**: 채택(2026-11-20, BAT-421 구현, 전체 감독 결정 1). 추천 적용이며, 취소 처리기 하나에서만 `@PurchaseSigned()`와 구매 서명 머리 요구를 뗀다. 나머지 다섯 구매 세션 서명 작업(홀드·홀드 해제·연장·주문·결제 시도·결제 접수)은 그대로 둔다.
- **관련**: [docs/features/transfer-refund.md](../features/transfer-refund.md) §3.1, [docs/frontend.md](../frontend.md) §4.1·§4.2.4·§4.3, [docs/design/d5-screen-blueprint.md](../design/d5-screen-blueprint.md) §5.20, [docs/api/openapi.yaml](../api/openapi.yaml) `createTicketCancellation`, [docs/BUILD_ORDER.md](../BUILD_ORDER.md) BAT-421, [ADR-0050](0050-crypto-corrections-and-key-management.md) 결정 8, [ADR-0221](0221-booking-flow-split-and-purchase-signer-core.md) 결정 5, [ADR-0293](0293-fan-reauth-token-bound-to-receiving-operation.md)
- **관련 ID**: transfer-refund:v5.0.0-3.5.3, R-T39, BAT-421, GAT-090

## 맥락

- `POST /v1/tickets/{ticketId}/cancellation`은 `@PurchaseSigned()`로 살아 있는 구매 세션의 `X-Purchase-Seq`·`X-Purchase-Mac`을 요구했다. 그 훅은 입장 토큰으로 시작한 구매 세션이 남아 있을 때만 통과하고, 세션이 없거나 끝났으면 401 `purchase-session-ended`다(packages/platform/src/purchase-auth.ts, ADR-0050 결정 8).
- 그런데 예매 취소 화면(SCR-038)은 마이 티켓에서 며칠 뒤에 열린다. 팬의 구매 세션은 좌석 구매 여정에서만 살고 결제가 끝나면 남지 않는다. 그래서 화면이 서버로 취소를 보내면 늘 401이었다.
- 취소는 이미 `X-Reauth-Token`으로 지킨다. 재인증 토큰은 5분·한 번·같은 로그인 세션(`sid`)·같은 계정(`sub`)·작업 묶음(`act`: `FAN_SENSITIVE` 또는 `FAN_HIGH_RISK`)·받는 쪽 작업(`op`: `TICKET_CANCEL` 또는 `TICKET_CANCEL_REFUND_ACCOUNT`)에 묶여 있고, `jti` 한 번 쓰기를 좌석 Redis에서 잡는다(docs/features/transfer-refund.md §3.1, ADR-0293). 팬 쿠키는 gw-fan이 같은 출처 검사(`Origin`/`Sec-Fetch-Site`) 뒤에 넘긴다.
- openapi는 이 작업에 구매 서명 머리를 선언하지 않았다. 계약과 생성 클라이언트는 처음부터 `fanCookie`·`Idempotency-Key`·`X-Reauth-Token`만 알고 있었고, 컨트롤러 쪽 머리 스키마만 서명을 더 요구해 정본과 어긋나 있었다.

## 결정

1. **취소 처리기에서 구매 세션 서명 요구를 뗀다.** `ticket-cancellation.controller.ts`의 `@PurchaseSigned()`와 계약 머리 스키마의 `X-Purchase-Seq`·`X-Purchase-Mac`을 지운다. openapi와 생성물은 바꾸지 않는다(이미 서명을 선언하지 않았다).
2. **취소는 재인증·Origin·팬 쿠키로 지킨다.** 차례는 인증 가드 → 멱등 키 → 본문 검사(계좌 모양) → `X-Reauth-Token` 확인(세션·계정·`act`·`op`·한 번 쓰기) → 취소 Saga다. 확인에 실패하면 403 `reauth-required`, 확인기를 못 쓰면 503 `reauth-unavailable`(Retry-After 5초 [가정])이고 Saga는 돌지 않는다(기존 그대로).
3. **다른 다섯 서명 작업은 그대로 둔다.** 좌석 홀드·해제·연장, 주문 만들기, 결제 시도, 결제 접수는 구매 여정 안에서만 일어나므로 살아 있는 구매 세션 서명이 맞다. 이 결정은 `POST /v1/tickets/{ticketId}/cancellation` 하나에만 적용한다.
4. **화면은 견적의 `refundAccountRequired`로 재인증 `purpose`를 먼저 정한다.** 참이면 `ticket-cancel-refund-account`, 거짓이면 `ticket-cancel`이고 재인증은 한 번이다. 계좌는 재인증 왕복 뒤에 받아 요청 본문에만 싣고 저장하지 않는다(d5 §5.20 ⑤ 뒤 ⑦, docs/frontend.md §4.1).
5. **계약 주석과 정본을 맞춘다.** transfer-refund §3.1 '차례'에서 '구매 요청 서명'을 빼고, 이 처리기가 팬 쿠키·gw-fan Origin 검사·재인증 토큰으로 지켜진다는 한 줄을 둔다. 취소 POST에 구매 서명 머리가 없어도 401이 나지 않는다는 사실은 회귀 시험이 지킨다.

## 결과

- SCR-038 화면이 며칠 뒤에 열려도 취소를 보낼 수 있다. 화면은 403 `reauth-required`면 새 재인증 뒤 같은 본문·같은 멱등 키로 한 번 다시 보내고, 503 `reauth-unavailable`이면 새 재인증을 받는다.
- 취소에서 구매 세션 서명 확인·일련번호 소비가 사라진다. 대신 재인증 토큰의 다섯 묶음(세션·계정·`act`·`op`·한 번)과 Origin 검사가 그 자리를 지킨다.
- 남는 한계: 재인증 토큰을 잡은 뒤 Saga가 실패하거나 응답을 잃으면 같은 멱등 키로 다시 보낼 때 새 재인증이 필요하다(기존 한계 그대로). 취소 POST는 더 이상 살아 있는 구매 세션에 묶이지 않으므로, 팬이 브라우저를 바꿔도 재인증만 하면 취소할 수 있다.
- 되돌릴 조건:
  - 취소에 구매 세션 결속이 꼭 필요하다는 사고·감사 결과가 나오면, 앱 서버가 취소용 입장 토큰을 발급하는 새 계약을 먼저 만든 뒤 이 결정을 되돌린다.
  - gw-fan이 팬 쿠키 쓰기 경로에서 Origin·`Sec-Fetch-Site` 검사를 끄거나 느슨하게 바꾸면, 이 결정의 전제가 사라지므로 취소 경로의 출처 검사를 따로 확인한다.
  - 취소 이외의 구매 쓰기 작업에서도 같은 401 문제가 드러나면, 그 작업마다 구매 세션을 새로 여는 길과 이 결정의 범위를 다시 정한다.

## 다른 선택지

| 길 | 고르지 않은 까닭 |
| --- | --- |
| 구매 세션 서명을 그대로 둔다 | SCR-038은 며칠 뒤에 열려 살아 있는 구매 세션이 없으므로 취소가 늘 401이다. 화면을 열 수 없다 |
| 앱 서버가 취소용 입장 토큰을 발급한다 | 새 계약·새 저장소·새 만료 규칙이 필요해 0.9일 밖이고, 재인증 토큰과 역할이 겹친다 |
| 취소 전용 새 엔드포인트를 만든다 | 같은 취소를 두 경로로 나누면 멱등 기록·감사·재인증 확인이 갈라진다. 기존 경로의 계약을 고치는 편이 작다 |
| 구매 세션 대신 CSRF 토큰만 둔다 | 재인증 토큰이 이미 세션·계정·작업에 묶여 있고, 팬 쿠키는 SameSite·Origins로 지켜진다. 새 토큰은 중복이다 |
