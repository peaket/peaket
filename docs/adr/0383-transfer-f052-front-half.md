# ADR-0383: 양도 앞 몫의 서버·화면 결정 — 티켓 상세·받은 요청 목록·조회 한도·돌려주기 멱등(2026-11-23)

- **상태**: 채택(2026-11-23). 기능 F-05-2(현장 입장, A등급, BUILD_ORDER GAT-050·GAT-055 앞 몫)의 구현 결정 묶음이다. 정본은 [docs/features/transfer-refund.md](../features/transfer-refund.md) §3.1·§4·§4.1·§5·§7.4·§11, [docs/features/offline-gate.md](../features/offline-gate.md) §2·§4, [docs/api/openapi.yaml](../api/openapi.yaml), [docs/api/guidelines.md](../api/guidelines.md) §3·§4다. 값은 정본에 두고 여기서는 자리만 가리킨다.
- **관련**: [docs/architecture.md](../architecture.md) §8.6, 계획 `docs/review/plans/F-05-2.md`, 마이그레이션 `services/ticket-svc/migrations/0018_transfer_lookup_and_return.sql`
- **관련 ID**: GAT-050, GAT-055, R-T1, R-T2, R-T17, R-T21, R-T25, ASVS v5.0.0-2.3.3·2.3.4·2.4.1·8.2.2·9.1.1·11.1.1·14.3.2·14.3.3

## 맥락

- 양도 서버 몫(BAT-410)은 요청·수락·거절·철회·만료·돌려주기·부정 예매 잠금을 이미 갖췄다. 그런데 팬 화면이 읽을 길이 셋 없었다: 티켓 상세(`GET /v1/tickets/{ticketId}`), 받은 요청 목록(`GET /v1/transfers`), 보낸 사람이 진행 중 요청 ID를 아는 길(계약의 `pendingTransfer`).
- 계획 중 돈·좌석 불변식 결함 둘을 찾았다. **D1**: 회차 취소·운영자 취소가 `transfer_offer`를 거두지 않아 `OFFERED`가 남는다. **D2**: 수락이 티켓 상태를 보지 않아, 환급된 표를 받는 사람이 수락하면 `ACTIVE` 표가 되살아난다(결제자는 이미 환급받음).
- 받는 사람 조회에 한도·기록이 없어 회원 코드를 계정 단위로 반복 조회할 수 있었다(ASVS 2.4.1). 돌려주기는 같은 `Idempotency-Key`를 다시 보내면 보유자가 이미 바뀌어 404/409가 났다(BAT-410 RV-08).

## 결정

### 1. 티켓 상세와 목록의 칸

- `GET /v1/tickets/{ticketId}`를 ticket-svc에 새로 둔다. 지금 보유자만 200이고, 남의 표·없는 표·UUID 아닌 값은 같은 404 `not-found`다. `Cache-Control: private, no-store`(오류 포함).
- 상세는 `transferable`(상품 양도 가능 && 결제자 보유 && 양도 마감 전 && 입장 시작 전 && 진행 중 요청 없음 && 잠금 없음), `transferDeadline`(공연 시작 − 2시간, POL-017), `transferLocked`·`transferLockExpiresAt`(잠겼고 보유자가 결제자일 때만), `receivedFromNickname`(받은 표면 가린 값, 뒤 몫 F-05-11이 실제 닉네임), `pendingTransfer`(보유자 = 결제자이고 `OFFERED` 요청이 있을 때만 `{offerId, expiresAt}`)를 싣는다.
- 좌석 이름·예매번호·입장 시각·주문 상세·판매자 정보는 이 기능의 범위 밖이라 싣지 않는다(월렛 뒤 몫).
- 월렛 목록 항목(`GET /v1/tickets`)에는 `pendingTransfer`만 더한다. `transferable`·`transferDeadline`·받은 표의 `receivedFromNickname`·`transferLockExpiresAt`은 offline-gate §2 '무엇을 싣나'가 목록에서 빼라고 정했으므로 상세에만 싣는다(정본이 계획의 '같은 칸을 목록에도'보다 이긴다).
- `transferable`의 상품 양도 가능 원천은 아직 ticket-svc에 없다. 원천이 생길 때까지 참으로 보고, 서버가 409로 거절할 때만 화면이 '양도 불가 상품'을 보인다(남는 한계).

### 2. 받은 요청 목록

- `GET /v1/transfers`는 세션 계정이 받는 사람인 요청만 최근 순(만든 시각 내림차순, 같으면 요청 ID 내림차순)으로 준다. `status` 쉼표 거르기·불투명 커서·`limit`(기본 20 [가정], 최대 100)을 받고, 모르는 `status`·풀리지 않는 커서는 400 `invalid-query`다.
- 항목은 `role`이 늘 `RECIPIENT`이고 결제 금액·결제자 연락처·예매번호를 싣지 않는다(authz-matrix §4.1). `Cache-Control: private, no-store`.

### 3. 철회 까닭의 공개 값

- `TransferOffer.withdrawReason`을 더한다. `WITHDRAWN`일 때만 싣고 공개 값은 `SENDER`·`EVENT_CANCELLED`·`EVENT_POSTPONED`·`OTHER`다. 저장 값 `FRAUD_LOCK`·`ACCOUNT_DELETED`·`DEPOSIT_ERROR`와 모르는 값은 `OTHER`로 낸다(받는 사람에게 부정 예매·탈퇴 사유를 드러내지 않는다).
- 계약 열거에 값을 더하면 깨짐이므로 화면은 모르는 값을 `OTHER`와 같게 그린다.

### 4. 받는 사람 조회 한도와 기록(0018)

- 계정당 **미끄러지는 60분 창에 10회** [가정]다. 11번째부터 429 `too-many-requests`와 `Retry-After`(가장 오래된 셈한 조회가 창에서 빠질 때까지의 초, 올림, 1 이상)를 준다.
- 시도마다 `transfer_recipient_lookup` 한 행을 남긴다(`account_id`, `looked_up_at`, `result`: `FOUND`·`NOT_FOUND`·`LIMITED`·`UNAVAILABLE`). 회원 코드·휴대폰 번호 원문·찾은 계정 ID는 남기지 않는다. `LIMITED`는 한도 셈에서 뺀다.
- 기록을 **조회보다 먼저** 쓴다. 트랜잭션에서 계정 단위 `pg_advisory_xact_lock`을 잡고 세고, `UNAVAILABLE` 자리 행을 넣은 뒤 커밋한다. 기록을 쓰지 못하면 identity를 부르지 않고 503 `dependency-unavailable`(닫힌 쪽)이다. identity가 실패하면 그 행을 `UNAVAILABLE`로 남기고 503, 찾지 못하면 `NOT_FOUND`, 찾으면 `FOUND`로 고친다.
- 휴대폰 번호 조회는 아직 받지 않지만(뒤 몫 F-05-11) 시도는 한도에 세고 404 `recipient-not-found`다.
- 보존은 90일 [가정]이다. 이 기능은 읽기에서 창 밖 행을 세지 않는 것만 하고, 실제 지우기는 데이터 보존 정비(구간 5)로 넘긴다.

### 5. 돌려주기 다시 보냄

- 같은 계정·같은 `Idempotency-Key`·같은 표면 처음 200 본문을 그대로 재생한다. 같은 키로 다른 표면 422 `idempotency-key-reused`(guidelines §4 '다른 본문')이고 아무것도 바꾸지 않는다.
- 차례는 **신원 → 키 형식 → 재인증 → 기록 보기(재생) → 판정·쓰기·기록 쓰기(한 트랜잭션)** 다. 재인증 앞에서 재생하지 않는다(재인증 없이 '돌려줬다'를 읽는 길을 만들지 않는다).
- `ticket_return`(`account_id`, `idempotency_key`)에 표·시각을 남긴다. 기록 쓰기가 실패하면 트랜잭션째 되돌아가 보유자·키·`transfer_pending`·`version`이 그대로이고, 고친 뒤 같은 키로 다시 보내면 처리된다.

### 6. D1·D2 불변식

- **D1**: 회차 취소(`eventCancel`)는 `WITHDRAWN`·`EVENT_CANCELLED`, 운영자 취소(`#operatorCancelOne`)는 `WITHDRAWN`·`FRAUD_LOCK`으로 표를 끝내는 **같은 트랜잭션**에서 진행 중 요청을 거두고 `decided_at`을 쓴다. 운영자 취소 기록의 `withdrawn_transfer_offer_id`에 거둔 요청 ID를 적고 결과에도 싣는다.
- **D2**: 수락은 티켓 행 잠금 안에서 표 상태를 다시 본다. 끝난 상태(환급·무효·취소 접수·부정 표시, 돌려주기의 `ENDED_STATUSES`와 같은 넷)면 409 `ticket-ended`이고 보유자·키·요청을 바꾸지 않는다. 이미 수락한 요청의 재생은 표 상태와 상관없이 200이다.

### 7. 돌려준 뒤 결제자의 기기 키 다시 등록

- 정본 offline-gate §4 '돌려주기'는 결제자가 돌아온 표에 `reason=TRANSFER`로 다시 등록한다고 정한다. 기기 키 저장소의 '결제자 그대로면 TRANSFER 거절' 규칙은 이 경우를 예외로 둔다: `ticket_return`에 그 표·결제자의 기록이 있으면 `TRANSFER`를 받는다. 기록이 없는 결제자 표는 지금처럼 403 `transfer-not-allowed`다.
- 기기 키 저장소는 갈래 3 F-05-4와 같은 파일이다. 이 기능은 한 조건과 한 조회만 더했고, 뒤에 합치는 쪽이 `ticket_return` 조회를 함께 살린다.

### 8. 화면

- SCR-014(`/my/tickets/{ticketId}/transfer`)·SCR-041(`/my/transfers/{offerId}`)은 UUID 요청만 실제 실행부를 `ssr: false` 동적 가져오기로 싣는다. 목업 ID·`?state=`는 지금처럼 서버 그리기 미리보기다(R-T21 ③).
- SCR-014: 상세 → 회원 코드 확인 → 재인증 `purpose` `transfer-request`(카카오 먼저, I-T54 ④) → 돌아와 `/reauth/token`으로 토큰을 메모리에 받음 → 법정 고지 확인 → 요청. 진행 중 요청 카드와 [요청 철회].
- SCR-041: 요청 읽기·수락은 화면 스크립트의 같은 사이트 요청이다. 고지 세 문장이 [받기]보다 먼저다. [거절]은 뒤 몫 F-05-11이라 그리지 않는다.
- SCR-013: 받은 표의 [결제자에게 돌려주기]는 확인 대화상자 → 재인증 `purpose` `ticket-return` → 돌아와 `POST /returns` → 그 표의 기기 키·월렛 항목을 지우고 동기화. 받은 `OFFERED` 요청 카드는 SCR-041로 잇고, 결제자 표의 '양도 요청 중' 카드는 SCR-014 ⑥로 잇는다.
- 재인증 토큰은 `X-Reauth-Token` 머리에만 두고 주소·본문·쿠키·`localStorage`·`sessionStorage`·IndexedDB에 두지 않는다. 재인증 왕복 동안 이어 갈 값(티켓 ID·멱등 키·받는 사람 참조)만 `sessionStorage`에 둔다.
- 월렛 저장 스냅샷에는 진행 중 요청의 **ID만** 둔다(기한·상대 값 없음, ASVS 14.3.3).

### 9. 값과 한계

- 한도 10회·창 60분·보존 90일은 코드 상수 [가정]이다. 새 환경 값을 만들지 않는다(`start.ts`·`config.ts`를 고치지 않는다).
- 받는 사람에게 보이는 보낸 분 닉네임은 identity 닉네임 읽기가 없어 지금은 가린 값(`회*`)이다(뒤 몫 F-05-11).
- SCR-041의 공연명·시작 시각은 공개 회차 요약(`GET /v1/events/{eventId}`)으로 채우고 좌석은 보이지 않는다(월렛과 같은 한계).
- 브라우저 확인은 로컬 무대가 없으면 하지 못한다. 계획 §8의 대본과 남는 한계를 결과 파일에 적는다.

## 결과

- 좋아지는 점: 팬이 SCR-014·SCR-041·SCR-013에서 양도·수락·돌려주기를 실제 서버로 끝낼 수 있다. D1·D2로 환급된 표가 되살아나는 길과, 회차 취소 뒤 받을 수 없는 요청이 48시간 남는 길이 닫힌다. 조회 남용이 계정 단위로 제한되고 기록이 남는다. 돌려주기 응답을 잃어도 같은 키로 이어 갈 수 있다.
- 잃는 점: 조회마다 DB 쓰기가 한 번 더 든다(기록을 먼저 쓰는 닫힌 쪽). 상세·목록이 `transfer_offer`를 함께 읽어 쿼리가 늘어난다. `transferable`의 상품 원천이 없어 참으로 보고, 서버 409로만 막는다.
- 버린 안: 조회 뒤에 기록 쓰기(기록 실패를 성공으로 읽는 길), 고정 창(정각) 한도, 재생을 재인증 앞에서(재인증 없이 결과를 읽는 길), 목록에 상세 칸을 모두 싣기(offline-gate §2와 어긋남), `Ticket.pendingTransfer`를 목록에서 빼기(화면이 보낸 요청을 찾을 길이 없음).

## 고른 안과 버린 안

- (고름) 상세·목록·조회 한도·돌려주기 멱등을 ticket-svc와 팬 웹에만 더하고, purchase-svc·identity-svc는 고치지 않는다.
- (고름) 조회 기록을 먼저 쓰고 identity를 부른다(닫힌 쪽).
- (고름) 돌려준 뒤 결제자의 기기 키 등록은 `TRANSFER`를 받는다(정본 offline-gate §4).
- (버림) 조회 기록을 나중에 쓰기: 기록 쓰기가 실패해도 조회가 성공해 한도를 우회할 수 있다.
- (버림) `withdrawReason`에 `FRAUD_LOCK`을 그대로 노출: 받는 사람에게 부정 예매 사유가 드러난다.
- (버림) SCR-041 [거절]을 이 기능에 넣기: 뒤 몫 F-05-11(동결)의 몫이다.
