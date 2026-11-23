# 기능 계획: FIX-wallet-tickets(발권 → 월렛 이음매 — 월렛 목록 HTTP 조회와 월렛 실제 데이터, 데모 S1)

- **진행**: 계획 끝(2026-11-23). 시험 씀·실패 확인(2026-11-23, 10절). 시험 리뷰 끝(2026-11-23, 15절 TR-01~08). 다음은 지적 반영(시험 담당).
- **무엇**: 감독 결정 2026-11-23(7일 완성 ADR-0373 결정 1 ①, 시험 먼저 ADR-0372)으로 갈래 4가 맡은 새 일 FIX-wallet-tickets의 작업 목록이다. BUILD_ORDER '기능 단위 계획' 표에 이 ID의 행은 없다(2절 1의 문안을 감독이 coord에 적는다). 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **쉬운 말**: 결제가 끝나면 티켓이 발권되지만, 팬이 '마이 티켓'(월렛)을 열어도 그 티켓을 볼 수 없었다. 월렛이 부르는 목록 주소(`GET /v1/tickets`)는 계약과 게이트웨이에는 있는데, 받아 줄 서버 처리기가 없었기 때문이다. 이 일은 ticket-svc에 그 처리기를 더하고, 월렛 화면이 가짜 그림 대신 그 목록으로 티켓과 회전 QR(15초마다 바뀌는 입장 QR)을 그리게 하고, 시연 시나리오 S1이 DB를 직접 읽는 대신 그 주소와 실제 QR로 '발권 → 월렛'을 확인하게 바꾼다.
- **바탕**: `D:/ticketpass-lane4-wallet`, 가지 `feature/lane4-FIX-wallet-tickets`, 기준 `origin/develop` `1f3fa58d2`. 계획 담당은 제품·시험 코드를 쓰지 않았고 시험·Docker를 돌리지 않았다. 읽은 조사: 감독이 준 `fan-flow-survey.md` 2절 ①.
- **차례**: A 절차(ADR-0372): 계획 → 시험 → 시험 리뷰 → (지적 반영) → 시험 고정 → 구현 → 게이트 → 기록·합치기. 구현 뒤 리뷰·검증은 없다. 구현 담당은 시험 파일을 고치지 못한다(틀려 보이면 '시험 이의').
- **크기 어림**: 약 1.75일 [가정](목표 1.5~2일 안). 2절 2.
- **한 줄 결론**: 서버는 이미 있는 목록 쓰임새(`TicketService.list`)를 부르는 HTTP 처리기 하나와 칸 고르기·커서 400만 더하면 된다. 큰 몫은 월렛 화면(실제 목록 받기·저장·상태 다섯)과 데모 S1이다. 정본 빈칸(누가 어떤 칸을 채우나, 상태별 카드, 화면 상태 둘, 판정 시험)은 이 커밋이 정본에 썼다(1절). ADR은 쓰지 않았다.

## 1. 정본 자리

이 커밋이 정본에 쓴 것은 ★.

| 자리 | 무엇 |
| --- | --- |
| ★ `docs/features/offline-gate.md` §2 '월렛 목록 서버' | 처리 위치(ticket-svc HTTP, 게이트웨이 그대로), 누구의 표·어떤 표·차례·나누기·싣는 칸·뺄 칸·캐시·기록, 운영 확인 표 |
| ★ `docs/features/offline-gate.md` §11 O-T47(①~⑧)·O-T48(①~⑩) | 서버·화면 판정 시험(장부 18항목이 새로 생겼다) |
| ★ `docs/frontend.md` §4.2.4 '월렛 목록 세부', §3 표 '티켓 `Ticket`' 줄 | 받기·표시 값(회차 공개 요약)·저장 맞추기·화면 상태·상태별 카드·펼침·미리보기·남는 한계 |
| ★ `docs/design/d5-screen-blueprint.md` §5.13 상태 표 '불러오지 못함'·'찾을 수 없음' | 화면 상태 둘(정본에 없던 것) |
| ★ `docs/api/proto/README.md` §3 `ListTickets` 줄 | '팬 웹 앱 서버 →'를 '(부르는 쪽 없음) →'로. 정본끼리 어긋남을 감독 결정 (가)대로 풀었다 |
| ★ `docs/security/asvs/offline-gate.md` 머리 'FIX-wallet-tickets 계획 메모' | 8.2.2·15.3.1·14.2.2·14.3.2·16.2.5가 이 경로에 걸리는 방식 |
| openapi `listTickets`(4721행), `Ticket`(697행), `getEvent`·`EventPublicSummary`(4962·1324행), 문제 종류 `invalid-query`(164행) | 계약. 고치지 않는다 |
| `docs/api/guidelines.md` §3(커서·`limit` 최대 100·넘으면 400·끝은 `nextCursor` null), 270행(같은 쿼리 두 번은 400) | 나누기 규칙 |
| `docs/security/authz-matrix.md` §3 '티켓' 행(보기는 보유자 `ticket.account_id`) | 소유자 확인 |
| `docs/frontend.md` §3.7(QR v1·회전), §4.1('401'·'api-client 밖의 호출' 시간 한도), §4.2.4 '입장용 휴대폰 등록 세부', §5.4 | QR 값의 출처와 회전, 등록 |
| `docs/features/offline-gate.md` §2 '서버 등록 잇기'·'같은 키 다시 등록', §3 | QR은 기기 키로 기기 안에서 만든다. 서버는 QR 재료를 주지 않는다 |
| `docs/design/d5-screen-blueprint.md` §5.13, §10.6 S1('013(입장용 휴대폰 등록 → 회전 QR)') | 화면 상태·데모 시나리오 정본 |
| `docs/planning/03-policies-glossary.md` §2.5 티켓 상태 T4~T26, POL-017·POL-032 | 상태별 카드의 근거(양도 마감 < 입장 시작, 취소 기한 = 공연 시작) |

## 2. 감독에게

1. **coord에 적을 행 문안**(BUILD_ORDER에는 더하지 않았다. `ledger.mjs --batch`를 쓰려면 이 행이 BUILD_ORDER 표에 있어야 한다):

   `| FIX-wallet-tickets | 현장 입장(팬 흐름) | A | - | 1.75 | O-T47, O-T48, offline-gate:v5.0.0-14.2.2, offline-gate:v5.0.0-14.3.2, offline-gate:v5.0.0-15.3.1, offline-gate:v5.0.0-16.2.5, V-T7 | 월렛 목록 GET /v1/tickets를 ticket-svc HTTP가 답하고, 월렛이 실제 목록·회전 QR을 그리며, 데모 S1이 HTTP 목록과 실제 QR로 발권 → 월렛을 확인한다 판정: O-T47, O-T48, V-T7 | F-02-1 | 진행 | 감독 결정 2026-11-23(ADR-0373 결정 1 ①의 발권 → 월렛 이음매, 조사 fan-flow-survey 2절 ①). 계획 docs/review/plans/FIX-wallet-tickets.md. 좌석 이름·예매번호·입장 시각·상세 경로(getTicket)는 범위 늘어남 후보(계획 3.2) |`

2. **크기**: 약 1.75일 [가정]. 서버 0.6(처리기·칸 고르기·커서 400·메시 0.05 포함, 시험 쓰기 0.3 포함), 화면 1.0(목록 받기·저장·카드·상태·쪽 둘, 시험 쓰기 0.4 포함), 데모 S1 0.35(고침 0.25 + 정적 시험 0.1). 데모 실제 재생은 Docker 잠금·이미지 빌드로 대기가 0.5일쯤 [가정] 더 든다(대부분 기다림).
3. **ADR 없음**: 감독 결정 (가)를 정본 문장(1절 ★)으로 적었다. 0366·0367은 비워 둔 그대로다. ADR-0285 결정 맥락(12행)의 'ListTickets는 팬 웹 앱 서버가'는 그때의 예시라 고치지 않는다.
4. **메시 허용 한 줄을 이 일에서 고친다(추천 (가))**: proto README를 '(부르는 쪽 없음)'으로 고쳤으므로 `deploy/platform/mesh/port-allow.yaml` 261행 `ListTickets: [web]`을 `[]`로 바꾸고 생성기로 `policies.yaml`을 다시 쓴다(아무도 부르지 못함, 최소 권한). 기존 MS-09 시험(`deploy/platform/mesh/test/mesh-policies.test.mjs` 182·756·767행)은 시험 담당이 고친다. (나) 남겨 두기는 웹 앱 서버가 쓰지 않는 발권 목록 읽기 권한이 남는다. 게이트웨이 라우트 원천(`deploy/gateways/routes/`)은 고치지 않는다.
5. **범위 늘어남 후보(하지 않음, coord '범위 늘어남'에 한 줄씩)**: ① 좌석 이름(`seatLabel`): ticket 데이터에 없다(스캐너 목록도 같은 한계, offline-gate §6 GAT-180 메모). 발권 gRPC에 좌석 이름을 싣고 ticket 표에 칸을 더해야 한다(purchase-svc·계약·마이그레이션, 약 0.75일). ② 예매번호(`bookingNumber`): 주문 쪽 칸이 data.md에 아직 없다. ③ 입장 시각(`enteredAt`): ticket-svc 스캔 기록으로 채울 수 있으나 이 일 밖. ④ 상세 경로 `GET /v1/tickets/{ticketId}`(판매자 정보 `seller`): 게이트웨이는 보내지만 처리기가 없다. 월렛 펼침은 목록 저장소로 그린다. ⑤ 받은 표의 보낸 분 닉네임, 잠긴 표의 잠금 기한. ⑥ 주문 상세 `GET /v1/orders/{orderId}`(조사 2절 ②).
6. **동결·다른 갈래와 겹침**: 데스크톱 '휴대폰에서 등록하세요' 안내(O-T32, GAT-020 다른 단계)·돌려주기·양도·취소 화면은 하지 않는다. `apps/web`의 월렛 파일을 바꾸는 다른 갈래 일은 coord에서 보지 못했다. 데모 `tools/local/demo/runner.mjs`는 S1 블록만 고친다(다른 시나리오의 SQL 읽기는 그대로).
7. **Docker 차례**: ticket-svc 통합 시험(PostgreSQL)과 데모 S1 재생(kind)이 Docker를 쓴다. 데모 재생은 무겁고 측정(F-08-x)과 겹치면 안 되니 감독이 차례를 정한다. 시험 담당의 실패 확인은 단위·node 시험만으로 할 수 있고, 통합 시험 실패 확인은 잠금을 잡고 한다.

## 3. 범위

### 3.1 하는 것

- **ticket-svc**: `GET /v1/tickets` HTTP 처리기(팬 쿠키, 세션 계정의 표만, `TicketService.list` 호출), 응답 칸 고르기(offline-gate §2 '무엇을 싣나'), 풀리지 않는 커서 400 `invalid-query`, `Cache-Control: private, no-store`, 조립(`ticket.module.ts`·`start.ts`).
- **메시**: `ListTickets` 허용 주체를 비운다(2절 4).
- **apps/web**: 월렛 목록 받기(`nextCursor` null까지)·회차 공개 요약으로 표시 값 채우기·`peaket-wallet` 저장 맞추기, 실제 화면 부품(목록·펼침), 상태 다섯(불러오는 중·빈 화면·불러오지 못함·표 있음·로그인으로), 상태별 카드와 QR 자리, 펼침 '찾을 수 없음', 개발 서버 `?state=` 미리보기 유지.
- **데모 S1**: 발권 확인을 ticket DB SQL 대신 `GET /v1/tickets`로, SCR-013을 목업 id 대신 실제 `ticketId`로 열고 '이 휴대폰을 입장용으로 등록'을 눌러 실제 등록(`POST /v1/tickets/{ticketId}/device-keys` 201)과 회전 QR을 본다. 확인 이름 `wallet-list`를 더한다.

### 3.2 빼는 것과 까닭

| 뺀 것 | 갈 곳 |
| --- | --- |
| 좌석 이름·예매번호·입장 시각·보낸 분 닉네임·잠금 기한·양도 가능 여부·양도 마감 칸 | 범위 늘어남 후보(2절 5). ticket 데이터에 없어 칸을 뺀다(거짓 값 금지) |
| 상세 `GET /v1/tickets/{ticketId}`(판매자 정보) | 범위 늘어남 후보(2절 5 ④) |
| 데스크톱 안내·돌려주기·양도·취소·부스 재발급 화면을 실제 데이터로 | GAT-020 등 그 화면의 기능(O-T32 다른 단계). 이 일은 목록·펼침·QR 자리까지 |
| 게이트웨이 라우트 | 고치지 않는다(이미 ticket-svc:8080으로 보낸다) |
| openapi 계약 | 고치지 않는다(칸이 모두 선택이라 빼도 계약 안이다. 400·401 응답 줄은 2절이 아니라 14절 1) |
| 다른 데모 시나리오(S4·S5 등)의 `/my/tickets` 방문 | 그대로(이제 실제 목록이 보인다) |
| 기기 키 정리(목록에서 사라진 표의 키 지우기) | 양도·재발급 흐름(GAT-020) |

## 4. 현재 상태(기준 `1f3fa58d2`)

| 정본 요구 | 지금 | 자리 |
| --- | --- | --- |
| `GET /v1/tickets`를 ticket-svc가 받음 | HTTP 처리기 없음(기기 키·양도만) | `services/ticket-svc/src/modules/ticket/ticket.module.ts:19` |
| 게이트웨이 | `GET /v1/tickets`·`/v1/tickets/{ticketId}`를 ticket-svc:8080으로 보냄 | `deploy/gateways/routes/gw-fan.yaml:399-439` |
| 목록 쓰임새 | 있음. 최신 발권순(`created_at` desc, `id` desc), 기본 20·최대 100으로 잘라 받음 | `application/ticket-service.ts:113`, `adapters/db/drizzle-ticket-store.ts:469`, `adapters/memory-ticket-store.ts:248`, `domain/ticket.ts:458-463` |
| 풀리지 않는 커서는 400 | 조용히 첫 쪽으로 봄 | `domain/ticket.ts:447-463`(`parseWalletCursor`·`normalizeListInput`), `drizzle-ticket-store.ts` `decodeCursor` |
| 싣는 칸 | 목록 기록(`WalletTicket`)에 `gateZone`·회차 시작·양도 잠금·결제자 여부가 없음. 주문·좌석 ID·QR 포인터가 있음(gRPC용) | `domain/ticket.ts:345-353`, `walletTicketOf` 500행 |
| gRPC `ListTickets` | 있음, 부르는 쪽 없음 | `inbound/ticket.grpc.ts:256` |
| 메시 | `ListTickets: [web]` | `deploy/platform/mesh/port-allow.yaml:261`, 생성물 `policies.yaml:1326`, 시험 `mesh-policies.test.mjs:182·767` |
| 월렛 화면 | 목업만(상태 19가지 그림). 펼침은 목업 id가 아니면 404 | `apps/web/src/widgets/ticket-wallet/model/wallet.ts`, `ui/Wallet.tsx`, `_pages/my-tickets`, `_pages/ticket-detail/ui/TicketDetailPage.tsx:16`, `entities/ticket/model.ts` |
| 기기 키 등록·회전 QR | 실제 등록·QR v1은 이미 있음(목업 UUID로 그림) | `features/wallet-device-key/ui/DeviceQr.tsx`, `register.ts`, `enrollment.ts`, `store.ts`(`WalletTicketSnapshot`) |
| 회차 공개 요약 읽기 | 있음. `title`·`startsAt`·`sellerName`만 읽음 | `entities/event-summary/model.ts` |
| 데모 S1 | 발권은 ticket DB SQL, SCR-013은 목업 id `tkt-lumen-r1-0312?state=QR 15초 지남` | `tools/local/demo/runner.mjs:957-975`, `scenarios.mjs:29·41`, `demo.mjs:361`, 시험 `demo.test.mjs:943-961` |

## 5. 장부 범위

`node tools/ci/ledger.mjs --batch FIX-wallet-tickets`(감독 승인으로 BUILD_ORDER 표에 행을 더한 뒤, 2026-11-23): **항목 23개, 자동 시험 1(V-T7)·ID만 4·빈칸 18**, 등급 B 23(기능 등급 A). `node tools/ci/ledger.mjs --check`는 이 커밋에서 통과한다(정본에 O-T47·O-T48을 더해 장부를 다시 썼다: 항목 4127개, 빈칸 743).

### 5.1 남긴 항목

| 항목 | 지금 | 채우는 것 |
| --- | --- | --- |
| O-T47 ①~⑧(새) | 빈칸 8 | 서버 목록 판정(B1~B9) |
| O-T48 ①~⑩(새) | 빈칸 10 | 화면 판정(B10~B17) |
| offline-gate:v5.0.0-14.2.2·14.3.2 | ID만 | 목록 200·400 응답 `Cache-Control: private, no-store`(O-T47 ⑧) |
| offline-gate:v5.0.0-15.3.1 | ID만 | 계약 칸만·QR 재료 없음(O-T47 ⑤) |
| offline-gate:v5.0.0-16.2.5 | ID만 | 기록 줄에 티켓 키·QR 포인터 없음(O-T47 ⑧) |
| V-T7 | 자동 시험 | S1이 SQL·목업 id 없이 HTTP 목록과 실제 QR로 본다(정적 시험 + 실제 재생) |

- O-T47 ⑥ 고침(갈래 결정 2026-11-23): 처음 쓴 '팬이 아닌 신원은 403'이 authz-matrix §5.1('다른 대상의 토큰은 역할과 상관없이 401')·플랫폼 가드와 어긋나 오래된 정본을 따라 401로 고쳤다.
- 등급: 장부 항목은 모두 B다. 감독 결정으로 A 절차(시험 리뷰 있음)로 한다.
- offline-gate:v5.0.0-8.2.2는 이미 자동 시험이다. O-T47 ①⑦ 시험에 이 ID도 단다(돈 되는 회귀 지킴).

### 5.2 뺀 항목의 정할 곳 후보

| 뺀 항목 | 후보 |
| --- | --- |
| AZ-T6(팬 A로 팬 B의 주문·티켓·양도·문의·본인확인·세션) | 그 자원들의 기능. 이 일의 티켓 목록 몫은 O-T47 ①⑦로 판정한다. AZ-T6 이름을 달면 다른 자원이 남았는데 '자동 시험'으로 세지므로 달지 않는다 |
| O-T32(데스크톱 안내) | GAT-020(다른 단계 그대로) |
| O-T13·FE-T14(오프라인 QR 회전·워커 범위) | 이미 있는 시험. 이 일은 QR 자리를 실제 ticketId로 잇기만 한다 |
| O-T44·O-T45(기기 키 등록) | 이미 자동 시험. 데모 S1이 실제 서버로 한 번 더 지난다 |

## 6. 바른 동작 표

| # | 상황 | 바른 동작 | 정본 |
| --- | --- | --- | --- |
| B1 | 세션 계정 A가 목록을 부름 | A가 지금 보유한 표만, 발권 시각 내림차순·같으면 티켓 ID 내림차순. B의 표 0장 | offline-gate §2 '누구의 표', proto README §3 |
| B2 | 쪽 나누기 | `limit` 2로 5장 → 2·2·1, 겹침·빠짐 없음, 마지막 쪽만 `nextCursor` null | guidelines §3 |
| B3 | `limit`·커서 오류 | 생략 20 [가정], 0·101 → 400, 풀리지 않는 커서 → 400 `invalid-query`(처음 쪽으로 보지 않음), B의 표 자리 커서 → A의 표만 | guidelines §3, offline-gate §2 '차례와 나누기' |
| B4 | 끝난 표 | `REFUNDED`·`VOIDED`·`CANCEL_REQUESTED`·`FLAGGED`·`TRANSFER_PENDING`도 그 상태로 목록에 남음 | offline-gate §2 '어떤 표' |
| B5 | 싣는 칸 | `ticketId`·`eventId`·`status`·`transferLocked` 늘. `gateZone`은 비지 않을 때. `eventStartsAt`=`cancelDeadline`=발권 때 회차 시작(있을 때). 결제자 보유 표 `receivedFromNickname` null, 받은 표는 칸 없음. 그 밖의 표시 칸 없음 | offline-gate §2 '무엇을 싣나', POL-032 |
| B6 | 싣지 않는 값 | 주문·좌석·계정·결제자 ID, `PEAKET1:` 포인터, 티켓 키·해시, 판 번호, 사건 ID | 같은 곳, ASVS 15.3.1 |
| B7 | 인증 | 세션 없음 401, 팬이 아닌 신원도 401(다른 대상의 신원은 역할과 상관없이 401, authz-matrix §5.1), 쿼리 `accountId`는 무시(계약 밖 칸) | authz-matrix §3 '티켓'·§5.1, offline-gate §2 |
| B8 | 양도된 표 | 수락 뒤 B 목록에만 | offline-gate §2 '누구의 표' |
| B9 | 캐시·기록 | 200·400 모두 `Cache-Control: private, no-store`. 기록 줄에 본문·티켓 키·포인터 없음 | offline-gate §2 '캐시와 기록', ASVS 14.3.2·16.2.5 |
| B10 | 화면 받기 | `limit=100`, 앞 응답 커서 그대로, null까지. 같은 커서 반복이면 멈추고 실패 | frontend §4.2.4 '월렛 목록 세부' 받기 |
| B11 | 401 | 토큰 한 번 갱신 뒤 다시. 그래도 401이면 저장된 표를 그리지 않고 로그인(SCR-004) | 같은 곳, §4.1 '401' |
| B12 | 표시 값 | 회차마다 한 번 공개 요약. 실패 회차도 표는 보이고 "공연 정보를 불러오지 못했습니다" | 같은 곳 '표시 값' |
| B13 | 저장 맞추기 | 목록에 없는 표의 표시 값 지움, 기기 키는 남김, 끝에 `lastSyncAt` | 같은 곳 '저장' |
| B14 | 화면 상태 | 저장 있음 → 바로 그림. 저장 없음+받는 중 → 불러오는 중, 0장 → 빈 화면, 실패 → 불러오지 못함+[다시 시도]. 저장 있음+실패 → 저장 값+오프라인 배너 | 같은 곳 '화면 상태', d5 §5.13 |
| B15 | 상태별 카드 | `ISSUED`·`ACTIVE`만 QR 자리. 나머지는 배지·문장만(문장은 frontend §4.2.4 그대로). 받은 표 <받은 티켓>, 공연 종료 지남 <지난 공연>·QR 없음 | 같은 곳 '상태별 카드', 03 §2.5 |
| B16 | QR 값 | QR v1의 티켓 ID = 목록의 `ticketId`, keyId = 이 기기에 '등록됨'인 키. 대체 글에 그 `ticketId` | frontend §3.7, offline-gate §2·§3 |
| B17 | 펼침 | 저장소에 없으면 "티켓을 찾을 수 없습니다", 서버 셸은 티켓 ID로 읽지 않음 | frontend §4.2.4 '펼침', d5 §5.13 |
| B18 | 데모 S1 | 구매 전 목록에 없던 E-1 표 2장이 결제 뒤 `GET /v1/tickets`에 `ISSUED`로 나타남(`wallet-list`), 그 표의 펼침에서 등록 201·회전 QR(`ticket-qr`). S1 블록에 SQL·목업 id 없음 | d5 §10.6 S1 |

## 7. 손댈 파일(구현 담당 몫, 시험 파일 제외)

- **ticket-svc**: 새 `src/modules/ticket/inbound/wallet-tickets.controller.ts`, `ticket.module.ts`(`TicketWiring.tickets` 선택 칸, 있으면 처리기 실음), `src/start.ts`(`tickets: ticket` 넘기기), `domain/ticket.ts`(`WalletTicket`에 칸 더하기, 응답 꼴 함수, 커서 오류를 `TicketInputError`로), `adapters/db/drizzle-ticket-store.ts`·`adapters/memory-ticket-store.ts`(목록 기록에 칸 채우기), `inbound/ticket.grpc.ts`(바뀐 `WalletTicket`에 맞춤만, proto 칸은 그대로). 마이그레이션 없음.
- **메시**: `deploy/platform/mesh/port-allow.yaml`(`ListTickets: []`), `node tools/ci/mesh-policies.mjs --write`로 `policies.yaml`(손으로 고치지 않는다).
- **apps/web**: 새 `src/features/wallet-sync/`(`index.ts`, `sync.ts`, `model.ts`), `src/features/wallet-device-key/store.ts`(스냅샷 칸 더하기·목록 읽기·맞추기 함수), `src/entities/event-summary/model.ts`(선택 칸 `placeName`·`entryOpensAt`·`endsAt` 읽기, 기존 세 칸 규칙 그대로), 새 `src/widgets/ticket-wallet/ui/WalletLive.tsx`, `src/widgets/ticket-wallet/index.ts`, `src/_pages/my-tickets/ui/*`·`src/_pages/ticket-detail/ui/TicketDetailPage.tsx`(기본은 실제 화면, 개발 서버 `?state=`면 목업, ADR-0224 결정 2 꼴).
- **데모**: `tools/local/demo/runner.mjs`(S1 블록, 필요하면 등록 누르기·응답 기다리기 도우미), `tools/local/demo/scenarios.mjs`(S1 `checks`에 `wallet-list`, 단계 글), `tools/local/demo.mjs`(361행 안내 글).
- 고치지 않는다: openapi·proto·계약 생성물, `deploy/gateways/`, purchase-svc, `packages/platform`(고쳐야 하면 구현 메모에 까닭).

## 8. 공개 인터페이스

시험은 이 모양 그대로 쓴다. 다르게 만들려면 구현 담당이 '시험 이의'로 알린다.

### 8.1 HTTP(ticket-svc)

- `GET /v1/tickets?cursor=<불투명>&limit=<1~100>`. 응답 200 `application/json` `{ items: Ticket[], nextCursor: string | null }`(openapi `ListTicketsResponse` 그대로, `@peaket/contracts/openapi/tickets`의 `ListTicketsResponse`로 검사된다).
- 신원: 게이트웨이 머리 `x-user-id`(계정 UUID)·`x-session-id`·`x-user-aud: fan`(지금 `test/device-keys-http.test.ts`가 쓰는 꼴). 없으면 401, `x-user-aud`가 `fan`이 아니어도 401(authz-matrix §5.1). 계정은 머리에서만 읽는다.
- 항목 칸(B5·B6): `ticketId`, `eventId`, `status`, `transferLocked`(boolean)는 늘. `gateZone`(빈 값이면 칸 없음), `eventStartsAt`·`cancelDeadline`(ISO 8601, 같은 값, 발권 `event_starts_at`이 없으면 둘 다 칸 없음), `receivedFromNickname`(보유자 = 결제자면 `null`, 아니면 칸 없음). 이 밖의 칸은 없다.
- 오류: `limit` 0·101·정수 아님·같은 쿼리 두 번 → 400(플랫폼 계약 검사, 문제 종류는 단언하지 않는다). 풀리지 않는 커서 → 400 문제 상세 `type` 끝이 `invalid-query`, `title` "목록 조건이 올바르지 않습니다". 커서 꼴은 지금 그대로(`[발권 ms, 티켓 UUID]` JSON의 base64url)이고 시험은 앞 응답의 `nextCursor`만 다시 쓴다. 'B의 표 자리 커서'는 B로 부른 목록의 `nextCursor`를 A 세션에 넣어 만든다.
- 머리: 200·400 모두 `cache-control: private, no-store`.
- 쓰임새: 처리기는 `TicketService.list({ accountId, cursor, limit })`를 부른다. 풀리지 않는 커서는 `TicketService.list`가 `TicketInputError`로 던진다(gRPC `ListTickets`도 `INVALID_ARGUMENT`가 된다).

### 8.2 ticket-svc 조립(시험이 쓰는 이음매)

- `AppModule.register({ ticket: { deviceKeys, tickets?, transfers? }, … })`: `tickets`는 `TicketService`. 있으면 `WalletTicketsController`(`inbound/wallet-tickets.controller.ts`, `@Controller('v1/tickets')`, `@Get()`)를 싣는다. 단위 시험은 `new TicketService({ store: new MemoryTicketStore(), clock: fakeClock(…) })`로 `issue`·`cancel`·`blockIssue`를 불러 표를 만든다. 통합 시험은 `DrizzleTicketStore`(실제 PostgreSQL)와 `start()` 또는 같은 `AppModule`.
- 기록 줄 확인: `createService`에 넘기는 기록 출력 흐름(지금 시험의 `quiet()` 자리)을 시험이 잡아 문자열로 본다.

### 8.3 웹 함수(`apps/web/src/features/wallet-sync`, node --test가 상대 경로로 읽는다)

- `syncWallet(): Promise<WalletSyncResult>` — 부를 때마다 `ORIGINS.api`를 읽는다. 비면 `{ kind: 'unavailable' }`(부르지 않음). `globalThis.fetch`로 `${ORIGINS.api}/v1/tickets?limit=100`(다음부터 `&cursor=<앞 nextCursor>`), `credentials: 'include'`. 401이면 `refreshOnce`(Web Locks `peaket.refresh`, register.ts와 같은 길)로 한 번 갱신 뒤 다시. 결과:
  - `{ kind: 'ok'; count: number }` — 저장 맞추기·`lastSyncAt` 쓰기까지 끝남.
  - `{ kind: 'needs-login' }` — 갱신 뒤에도 401.
  - `{ kind: 'failed'; reason: 'network' | 'server' | 'bad-response' | 'cursor-loop' }` — 끊김·시간 초과(`network`), 5xx·정의 밖 상태(`server`), 모양이 틀린 200(`bad-response`, `ListTicketsResponse`로 검사), 앞 쪽과 같은 커서(`cursor-loop`). 실패면 저장소를 바꾸지 않는다.
  - 회차 공개 요약: 받은 표의 서로 다른 `eventId`마다 `GET ${ORIGINS.api}/v1/events/{eventId}`를 한 번(entities/event-summary 읽기 도구). 실패는 그 회차 표시 값만 비운다.
- `loadWalletCards(nowMs: number): Promise<WalletCard[]>` — 저장소의 표를 카드로. 차례는 서버 목록 차례.
- `walletCardOf(snapshot, nowMs): WalletCard`(순수). `WalletCard = { ticketId; eventId; title: string | null; placeName: string | null; startsAt: string | null; badge: WalletBadge; note: string | null; showQr: boolean; qrLabel: string }`. `WalletBadge = '사용 가능' | '받은 티켓' | '양도 요청 중' | '취소 접수됨' | '환급됨' | '확인 중' | '무효' | '지난 공연'`. `title`이 null이면 화면은 "공연 정보를 불러오지 못했습니다". `note`는 frontend §4.2.4 '상태별 카드'의 문장 그대로(없으면 null). `qrLabel`은 `입장 QR, 티켓 <ticketId>, 15초마다 바뀝니다`로 시작한다(데모가 `aria-label^="입장 QR"`로 찾는다).
- `walletScreenOf({ stored: number; sync: 'pending' | WalletSyncResult }): { screen: 'loading' | 'empty' | 'error' | 'list' | 'login'; offline: boolean }`(순수). B14 표 그대로. `unavailable`은 저장된 표로 그린다(로컬 화면 개발).
- 저장소(`features/wallet-device-key/store.ts`에 더함): `listTicketSnapshots(): Promise<WalletTicketSnapshot[]>`, `replaceTicketSnapshots(snapshots): Promise<void>`(목록에 없는 표 지움, `keys`는 건드리지 않음). 이미 있는 `loadTicketSnapshot`·`loadDeviceKey`·`loadLastSyncedAt`는 그대로 쓴다. 스냅샷에는 개인정보(이름·연락처)를 두지 않는다(frontend §3.7).

### 8.4 화면(`WalletLive`)

- 경로 `/my/tickets`(목록), `/my/tickets/{ticketId}`(펼침). 운영 빌드는 늘 실제 화면, 개발 서버에서 `?state=`가 있으면 지금 목업.
- 보이는 글(시험이 찾는 것): 불러오는 중 "티켓을 불러오는 중입니다", 빈 화면 "아직 티켓이 없습니다"와 ( 공연 둘러보기 › ), 불러오지 못함 "티켓을 불러오지 못했습니다"와 버튼 "다시 시도", 펼침 없음 "티켓을 찾을 수 없습니다"와 ( 마이 티켓 › ), 표시 값 실패 "공연 정보를 불러오지 못했습니다", 배지는 `WalletBadge` 글 그대로.
- QR 자리: `showQr`인 카드만 `DeviceQr`(지금 부품, `ticketId`=그 표, `label`=`qrLabel`). 키가 없으면 그 부품이 '이 휴대폰을 입장용으로 등록' 버튼을 그린다(버튼 `aria-label`은 `<qrLabel>, 이 휴대폰을 입장용으로 등록`).
- 오프라인 배너: 지금 `OfflineBanner` 부품, 마지막 동기화 시각.

### 8.5 데모 S1

- 단계(scenarios.mjs `steps` 글도 맞춘다): … `pay` 앞에 `wallet-before`(api, 구매 전 `GET /v1/tickets` 목록의 ticketId 모음) → `pay` → `wallet`(api, `GET /v1/tickets`를 1초 간격 60초까지 다시 불러 구매 전에 없던 이 회차(E-1) `ISSUED` 표 2장을 찾음) → `result`(SCR-012) → `ticket`(SCR-013 `/my/tickets/{ticketId}`, `?state=` 없음, '이 휴대폰을 입장용으로 등록'을 눌러 `POST /v1/tickets/{ticketId}/device-keys` 201을 기다리고 회전 QR을 본다).
- 확인 이름: `seat-hold-2`, `payment-approved`, `wallet-list`(새, 새 표 2장의 ticketId를 상세에 적음), `ticket-qr`(QR `aria-label`에 그 ticketId가 있고 칸 수 > 0, 등록 응답 201).
- S1 블록에 `sqlRead(`·`tkt-lumen`·`?state=`가 없다. `demo.mjs` 안내 글의 'S1 SCR-013은 목업 티켓만' 줄을 지금 동작으로 바꾼다.

## 9. 판정 항목별 시험

이름에 ID와 세부 번호를 단다. 단언 값은 정본에서 가져오고 코드 상수를 옮기지 않는다. 장부 밖 세부는 `FWAL-` 번호.

| 항목 | 시험 이름 예 | 층·파일(새) |
| --- | --- | --- |
| O-T47 ①⑦ | `O-T47 ① A 세션은 A가 보유한 표만 최신 발권순으로 받고 B의 표는 없다(ASVS v5.0.0-8.2.2)`, `O-T47 ⑦ 양도 수락 뒤 그 표는 B의 목록에만 있다` | ticket-svc 통합(PostgreSQL) `test-int/wallet-tickets.int.test.ts`. ①은 단위에도 |
| O-T47 ②③ | `O-T47 ② limit 2로 5장을 2·2·1로 겹침 없이 받고 마지막만 nextCursor가 null이다`, `O-T47 ③ limit 0·101은 400, 풀리지 않는 커서는 400 invalid-query, B의 커서는 A의 표만` | 단위 `test/wallet-tickets-http.test.ts`(메모리 저장소) + 통합(같은 발권 시각 두 장으로 ID 내림차순 경계) |
| O-T47 ④ | `O-T47 ④ 환급·무효 표가 그 상태로 목록에 남는다` | 통합(실제 `cancel`·`blockIssue`) |
| O-T47 ⑤ | `O-T47 ⑤ 항목은 계약 칸만이고 주문·좌석·계정 ID·PEAKET1 포인터·티켓 키가 없다(ASVS v5.0.0-15.3.1)` | 단위: 항목 키 집합을 정확히 단언(허용 목록), `gateZone` 빈 값·있음 둘, 회차 시작 있음·없음 둘 |
| O-T47 ⑥ | `O-T47 ⑥ 세션 없으면 401, 팬이 아닌 신원도 401, 쿼리 accountId는 무시한다` | 단위 |
| O-T47 ⑧ | `O-T47 ⑧ 200·400 모두 private, no-store이고 기록 줄에 티켓 키·PEAKET1 값이 없다(ASVS v5.0.0-14.2.2, v5.0.0-14.3.2, v5.0.0-16.2.5)` | 단위(기록 흐름을 잡는다) |
| O-T48 ①⑩ | `O-T48 ① 커서를 그대로 실어 세 쪽을 받고 모두 저장한다`, `O-T48 ⑩ 같은 커서가 다시 오면 멈추고 cursor-loop 실패다` | web node `src/features/wallet-sync/sync.test.mjs`(fake-indexeddb + `globalThis.fetch`) |
| O-T48 ②③④⑤ | `O-T48 ② 0장이면 empty`, `③ 저장 없음+실패면 error`, `④ 저장 있음+실패면 list+offline`, `⑤ 갱신 뒤 401이면 login이고 저장된 표를 그리지 않는다` | 같은 파일(`walletScreenOf`와 `syncWallet` 결과) + 화면 Playwright(아래) |
| O-T48 ⑥ | `O-T48 ⑥ ISSUED·ACTIVE만 showQr이고 나머지 다섯은 배지·문장만`(상태 일곱 모두, 받은 표·지난 공연 포함) | web node `src/features/wallet-sync/model.test.mjs` |
| O-T48 ⑦ | `O-T48 ⑦ 회차 요약은 회차마다 한 번이고 404·410·실패 회차의 표도 남는다` | sync.test.mjs(요청 수 단언) |
| O-T48 ⑧ | `O-T48 ⑧ 목록에서 빠진 표의 표시 값은 지우고 기기 키는 남긴다` | sync.test.mjs(`loadTicketSnapshot`·`loadDeviceKey`) |
| O-T48 ⑨ | `O-T48 ⑨ 펼침 주소의 표가 없으면 찾을 수 없음` | 화면 Playwright |
| 화면 | `O-T48 ②③⑥⑨ 화면` — 가짜 API(경로 가로채기)로 빈 화면·불러오지 못함·상태 섞인 목록(QR 자리 수)·펼침 없음 | `tools/web-checks` 운영 빌드 위 새 spec(예 `reflow/wallet-live.spec.mjs`). 로컬에 Playwright가 없으면 초안 PR CI web 잡으로 |
| V-T7 | `V-T7 ④ S1은 발권을 GET /v1/tickets로 확인하고 SQL·목업 티켓 id 없이 실제 ticketId 화면의 QR을 본다(FWAL-DEMO ①)`, `V-T7 ① plan --check가 S1 checks에 wallet-list를 낸다(FWAL-DEMO ②)` | `tools/local/demo.test.mjs`(정적 시험, 지금 ④·① 시험 옆) |
| 실제 서버 | `node tools/local/demo.mjs play --scenarios S1`(또는 `all --scenarios S1`)이 `wallet-list`·`ticket-qr` 통과 | 데모 무대(kind, Docker 잠금). 12절 |
| 메시 | `MS-09 … TicketService/ListTickets는 아무도 없음 …`(지금 시험의 단언·이름 고침) | `deploy/platform/mesh/test/mesh-policies.test.mjs` |
| 덧붙임 | `FWAL-GRPC ① 풀리지 않는 커서는 gRPC ListTickets에서도 INVALID_ARGUMENT`, `FWAL-ORDER ① 같은 발권 시각이면 티켓 ID 내림차순` | 단위·통합 |

- 기존 시험 가운데 바뀐 동작에 걸리는 것(시험 담당이 시험 커밋에서 정본대로 고친다): `mesh-policies.test.mjs` MS-09(182·767행), `demo.test.mjs` V-T7 ④(S1 블록 단언), `widgets/ticket-wallet/ui/wallet-first-screen.test.mjs`(BAT-177 T6, 첫 HTML의 QR 뼈대: 14절 3), 펼침 404를 기대하는 것이 있으면 그것.

## 10. 실패 확인

- 시험 담당이 기준 커밋 `1f3fa58d2` + 이 계획 커밋 트리(구현 전)에서 새 동작의 시험이 실패하는 것을 본다(ADR-0372 결정 1). 명령·시험 수·실패 수·까닭 한 줄만 적는다.
- 기대: ticket-svc 단위 HTTP 시험은 404(처리기 없음)로, web 시험은 모듈 없음으로, 데모 정적 시험은 S1 블록의 `sqlRead(`로, MS-09는 `web` 주체로 실패한다.

시험 담당 fwal-test-2e9a, 2026-11-23, 트리 `cec434dd3`(구현 전) + 시험 파일. 모두 실패를 봤다(기대한 까닭으로만).

| 시험 | 명령(저장소 뿌리 기준) | 시험 수 | 실패 | 까닭 |
| --- | --- | --- | --- | --- |
| ticket-svc 단위 `test/wallet-tickets-http.test.ts` | `cd services/ticket-svc && npx vitest run test/wallet-tickets-http.test.ts` | 18 | 18 | HTTP 17은 404 Not Found(처리기 없음). FWAL-GRPC ①은 풀리지 않는 커서가 `{ tickets: [] }`로 풀림(거절 안 함). 표 만들기(취소 REFUND_NOW·발권 막기·양도 CREATED·수락 OK·잠금 LOCKED)는 실패 전까지 지났다 |
| ticket-svc 통합 `test-int/wallet-tickets.int.test.ts` | Docker 잠금 `lane4-wallet-test` 뒤 `cd services/ticket-svc && npx vitest run --config vitest.integration.config.mjs test-int/wallet-tickets.int.test.ts` | 8 | 미룸 | 통합은 Docker 엔진 꺼짐으로 미룸(2026-11-23 감독 알림, 잠금을 잡았다가 엔진이 없어 놓음). 엔진이 켜지고 감독이 잠금 멈춤을 풀면 시험 담당이 다시 돌려 이 칸을 채운다. 기대 까닭은 단위와 같은 404(start.ts에 처리기 없음)와 FWAL-GRPC ①의 OK(INVALID_ARGUMENT 아님) |
| web `src/features/wallet-sync/sync.test.mjs`·`model.test.mjs` | `cd apps/web && node --test src/features/wallet-sync/sync.test.mjs src/features/wallet-sync/model.test.mjs` | 13 + 4 | 파일 2 실패 | `ERR_MODULE_NOT_FOUND` `./model.ts`·`./sync.ts`(모듈 없음). 이 작업 폴더는 `packages/contracts/dist`가 없어 먼저 `npx tsc -p tsconfig.build.json`(contracts)로 빌드했다 |
| web `widgets/ticket-wallet/ui/wallet-first-screen.test.mjs` | `cd apps/web && node --test src/widgets/ticket-wallet/ui/wallet-first-screen.test.mjs` | 6 | 1(T6 ⑦) | `WalletLive.tsx` 없음. T6 ①~⑤는 그대로 통과(목업 화면은 `?state=` 미리보기로 남는다) |
| 메시 `deploy/platform/mesh/test/mesh-policies.test.mjs` | `node --test deploy/platform/mesh/test/mesh-policies.test.mjs` | 24 | 3(MS-02·MS-09·MS-10) | 셋 다 생성물 `policies.yaml`에 남은 `web` 주체(`ticket-svc:50052의 부르는 쪽 +web`, `ListTickets [cluster.local/ns/web/sa/web]`). `port-allow.yaml`을 `[]`로 고치고 `--write`하면 풀린다 |
| 데모 `tools/local/demo.test.mjs` 새 둘 | `node --test --test-name-pattern="FWAL-DEMO" tools/local/demo.test.mjs` | 2 | 2 | FWAL-DEMO ①은 S1 블록의 `sqlRead(`, ②는 S1 checks에 `wallet-list` 없음 |
| 화면 `tools/web-checks/reflow/wallet-live.spec.mjs` | ci-web reflow 잡(`pnpm run reflow`, ' 기본 폭: ' 프로젝트) | 7 | 로컬 못 돌림 | 이 PC의 `tools/web-checks`에 설치(node_modules)·운영 빌드가 없다. 기준 트리에서는 첫 HTML에 '티켓을 불러오는 중입니다'가 없고(목업), 없는 표 펼침이 404라 실패할 자리다. 첫 실행은 구현 뒤 CI |

- 시험이 스스로 깨지지 않았는지: 작업 폴더에 버릴 대역 구현(서버 처리기·커서 400·칸 고르기, 웹 sync·model·저장소 함수 둘)을 잠깐 넣어 단위 18/18, web 17/17이 통과하는 것을 보고 지웠다(커밋에 없음, `git status`로 확인). 구현 지시가 아니다.

### 시험이 기댄 모양(계획 8절에 없거나 정본끼리 어긋난 것)

1. **정본 어긋남(감독·계획 담당이 정한다)**: O-T47 ⑥ 판정 칸은 '팬이 아닌 신원 → 403'인데, `docs/security/authz-matrix.md` 200행('다른 대상의 토큰은 역할과 상관없이 401')과 플랫폼 공용 가드(대상이 다르면 신원을 인정하지 않음, purchase-svc 시험들도 401로 본다)는 401이다. 시험은 401(partner·ops·scanner, 표 없음)로 썼다. 403으로 바꾸려면 플랫폼을 고쳐야 한다. O-T47 ⑥ 문장을 '401·401'로 고치는 것을 추천한다.
2. ticket-svc 단위: 쓰임새가 없는 상태(`CANCEL_REQUESTED`·`FLAGGED`)와 비지 않은 `gateZone`은 `MemoryTicketStore.tickets` 기록을 시험 씨앗으로 고친다(통합은 `update ticket set gate_zone`). 양도 요청 중·받은 표·잠긴 표는 `MemoryTransferStore`(`createOffer`·`accept`·`setTransferLock`)로 만든다. `transferLocked`는 잠금 직후(기한 14일 남음) true로 본다.
3. 400 목록: `limit` 0·101·-1·2.5·abc·두 번, 풀리지 않는 커서 여섯 꼴(base64url 아님·JSON 아님·배열 아님·칸 수 다름·UUID 아님·시각이 수 아님). 문제 종류는 커서만 `invalid-query`와 제목 '목록 조건이 올바르지 않습니다'를 단언한다.
4. 저장소 목록 읽기 장애는 500(플랫폼 about:blank)이고 내부 글을 싣지 않는다. 캐시 머리는 단언하지 않는다(정본 판정은 200·400).
5. 기록 줄: `PEAKET_LOG_SAMPLE_ONE_IN=1`로 정상 줄도 남기고, JSON 줄의 `route` `/v1/tickets`·`status` 200·400이 있는지 본 뒤 티켓 키·키 해시·`PEAKET1:`·응답의 티켓 ID·커서 값이 없는지 본다.
6. 통합은 `start()`를 `PEAKET_ENV=ci`·DB 주소만으로 띄운다(Redis·Kafka·identity 없이 뜨는 지금 동작). `FWAL-GRPC ①`은 `start()`의 gRPC 포트를 `ticketPackage().TicketService` 클라이언트(내부 토큰 없음)로 부른다.
7. web 파일 나눔: `syncWallet`·`loadWalletCards`는 `features/wallet-sync/sync.ts`, `walletCardOf`·`walletScreenOf`는 `model.ts`(시험이 `.ts` 상대 경로로 읽는다). 저장소 함수 둘은 `wallet-device-key/store.ts`. Dexie 표 이름 `tickets`·`deviceKeys`·`meta`는 그대로다(시험이 매번 비운다).
8. `syncWallet`: 성공 때 `lastSyncAt`은 `Date.now()` 값(시험은 Date만 가짜 시계)이고 실패 때 바꾸지 않는다. 목록 404 같은 정의 밖 상태는 `server`다. `bad-response`는 items가 배열 아님·nextCursor가 글·null 아님·목록 밖 상태 값·JSON 아닌 200이다(items 칸이 아예 없는 200은 계약 Zod가 받으므로 시험하지 않았다. 구현 리뷰 볼 점: 그때 저장소를 비우면 오프라인 QR이 사라진다). 회차 요약 요청은 쿠키를 싣지 않고(`credentials`가 `include`가 아님) 쪽이 달라도 회차마다 한 번이다. 계약 밖 칸(`qrPayload`·주문·좌석 ID)이 응답에 섞여도 저장하지 않고, 받는 동안 `console`에 아무것도 내지 않는다.
9. `WalletCard`: 따옴표 문장이 정본에 없는 상태(ISSUED·ACTIVE·TRANSFER_PENDING·REFUNDED·받은 표)의 `note`는 null. 받은 ACTIVE 표는 <받은 티켓>이고 QR 자리가 있다. <지난 공연>은 회차 요약 `endsAt` < `nowMs`(종료 1ms 전은 <사용 가능>). 요약 200 회차의 `startsAt`은 요약 값. `loadWalletCards` 차례는 서버 목록 차례이고 `walletCardOf(스냅샷)`과 같다.
10. `walletScreenOf`: `needs-login`은 저장 수와 무관하게 `login`, 저장 있음+`unavailable`은 `list`(offline false), `offline`은 저장 있음+`failed`일 때만 true.
11. 화면 spec: 등록 버튼 이름 `^입장 QR, 티켓 <id>, 15초마다 바뀝니다 … 이 휴대폰을 입장용으로 등록$`, 오프라인 배너는 `role=status`의 '오프라인입니다'·'마지막 동기화', 없는 표 펼침은 HTTP 200, 첫 HTML(`/my/tickets`)에 '티켓을 불러오는 중입니다'·`wallet-qr-skeleton`·`data:image/png;base64,`가 있고 `tkt-lumen-`가 없다, 갱신 뒤 401이면 주소가 `/login`.
12. T6 ⑦: 실제 화면 파일은 `widgets/ticket-wallet/ui/WalletLive.tsx`이고 `DeviceQr`·`OfflineBanner`·`wallet-sync/sync`를 값으로 정적 import하지 않으며 `<DeviceQr>`·`<OfflineBanner>`를 직접 그리지 않는다(늦게 받는 `DeviceQrLazy`·`OfflineBannerLazy`).
13. 데모 정적 시험: S1 블록(또는 S1이 부르는 최상위 도우미)이 `'/v1/tickets'`(하위 경로 아님)를 결제 접수 앞·뒤로 부른다, `addCheck('wallet-list', <식>)`, `screen: 'SCR-013', path: '/my/tickets/{ticketId}'` 줄, runner 안에 '이 휴대폰을 입장용으로 등록'과 `waitForResponse(`…`device-keys`(400자 안), S1 checks는 정확히 `seat-hold-2, payment-approved, wallet-list, ticket-qr`, steps는 `checkout → wallet-before → pay → wallet → result → ticket`, `demo.mjs`에 '목업 티켓만'이 없다.

## 11. 시험이 잡아야 할 틀린 구현(시험 리뷰가 대조한다)

| # | 틀린 구현 | 잡아야 할 시험 |
| --- | --- | --- |
| M1 | 쿼리나 커서 안의 계정으로 거른다(머리의 계정을 안 씀) | O-T47 ①③⑥ |
| M2 | 결제자(`payer_account_id`)로 거른다 | O-T47 ⑦ |
| M3 | 끝난 표를 거른다(`ISSUED`·`ACTIVE`만) | O-T47 ④ |
| M4 | 기록을 통째로 내보낸다(`orderId`·`seatId`·`qrPayload`가 섞임) | O-T47 ⑤ |
| M5 | 없는 칸에 빈 글·지금 시각·seatId를 채운다 | O-T47 ⑤ |
| M6 | 풀리지 않는 커서를 첫 쪽으로 본다 | O-T47 ③ |
| M7 | `limit` 101을 100으로 잘라 받는다 | O-T47 ③ |
| M8 | 마지막 쪽에 빈 글 `nextCursor`, 또는 `limit`과 같은 수가 남을 때 null을 놓침(정확히 4장·`limit` 2) | O-T47 ② |
| M9 | `no-store`를 200에만 단다 | O-T47 ⑧ |
| M10 | 화면이 첫 쪽만 받는다 | O-T48 ① |
| M11 | 같은 커서에 무한히 부른다 | O-T48 ⑩ |
| M12 | 실패하면 저장소를 비운다(오프라인에서 QR이 사라짐) | O-T48 ④ |
| M13 | 401에서도 저장된 표를 그린다 | O-T48 ⑤ |
| M14 | 환급·무효 표에도 QR 자리 | O-T48 ⑥ |
| M15 | 요약 실패 회차의 표를 빼 버린다 / 회차마다 표 수만큼 묻는다 | O-T48 ⑦ |
| M16 | 빠진 표의 기기 키까지 지운다 / 표시 값을 남긴다 | O-T48 ⑧ |
| M17 | 데모가 여전히 SQL·목업 id로 본다 | V-T7 ④ |

## 12. 게이트

| 잡 | 로컬에서 |
| --- | --- |
| node(ticket-svc) | `pnpm exec turbo run build --filter=@peaket/ticket-svc^...` 뒤 `pnpm exec turbo run typecheck test --filter=@peaket/ticket-svc`(막히면 패키지 폴더에서 `npx tsc --noEmit`·`npx vitest run`) |
| node 통합(Docker) | `bash D:/ticketpass-locks/lock.sh take docker lane4-FIX-wallet` → `pnpm --filter @peaket/ticket-svc test:integration` 전부 → `docker rm -f -v` → `drop`. 합치기 직전 develop 위로 다시 쌓은 트리에서 한 번 더(무거우면 초안 PR CI) |
| web | `pnpm --filter @peaket/web typecheck`, `pnpm --filter @peaket/web test`, 첫 JS 예산(`tools/web-checks/budgets/js.spec.mjs` 월렛 행)과 새 화면 spec은 web-checks 폴더(설치 따로) 또는 초안 PR CI |
| 도구 | `node --test "tools/local/*.test.mjs"`(tools-check 잡), `node tools/local/demo.mjs plan --check` |
| 실제 서버 | Docker 잠금을 잡고 `node tools/local/demo.mjs all --scenarios S1`(이미지 다시 빌드 포함, [추정] 35~45분). `wallet-list`·`ticket-qr` 통과와 걸린 시간을 계획 파일 '시험 결과'에 |
| 메시 | `node tools/ci/mesh-policies.mjs --check`, `node --test deploy/platform/mesh/test/mesh-policies.test.mjs` |
| 게이트웨이(안 바뀜 확인) | `node tools/ci/gateway-routes.mjs --check` |
| 계약(안 바뀜 확인) | `pnpm --filter @peaket/contracts gen:check` |
| 린트·문서 | `pnpm lint`, `python -I -X utf8 tools/doc-check/check_all.py`(오류 0) |
| 대조·장부·역할 | `node tools/ci/trace-check.mjs --ids "O-T47,O-T48,V-T7,ASVS v5.0.0-14.2.2,ASVS v5.0.0-14.3.2,ASVS v5.0.0-15.3.1,ASVS v5.0.0-16.2.5" --report <작업 폴더 밖 보고서>`, `node tools/ci/ledger.mjs --check`(행이 BUILD_ORDER에 생기면 `--batch FIX-wallet-tickets --require`), `node tools/ci/roles-check.mjs --base origin/develop --head HEAD`, 기록 커밋에서 `node tools/ci/ledger.mjs` |

- 화면이 바뀌므로 브라우저 확인 대상이다. ADR-0373 결정 3대로 마지막 날 한 번에 한다(감독 몫).

## 13. 자주 놓친 결함(시험·구현 지시문에 넣는다)

- **남의 표 노출**: 계정은 게이트웨이 머리에서만. 쿼리·커서·본문의 계정 값은 읽지 않는다. 결제자 칸이 아니라 보유자 칸(`account_id`)으로 거른다. 커서를 바꿔 끼워도 내 표만(커서는 자리일 뿐).
- **취소·환불·무효 표 표시**: 서버는 감추지 않고, 화면은 QR 자리를 없애고 상태 배지·문장을 보인다. `TRANSFER_PENDING`도 QR 없음. 시험은 상태 일곱을 모두 넣는다(허용 목록 밖 값마다).
- **QR 값 노출**: 서버 응답에 `PEAKET1:` 포인터·티켓 키·해시가 없어야 한다. 화면은 QR v1 글자·서명을 `console`·텔레메트리·주소창에 내지 않는다(지금 `DeviceQr`가 지키는 규칙을 실제 화면도 지킨다). 요청 기록 줄에 응답 본문이 없다.
- **칸 단언은 정확히**: 항목 키 집합을 허용 목록과 같게(`toEqual`로 정렬해 비교), '없는 칸'은 `undefined`가 아니라 키가 없음으로. null과 칸 없음을 가른다(`receivedFromNickname`).
- **경계는 양쪽**: `limit` 1·100(된다)과 0·101(400), 4장·`limit` 2(마지막 쪽 nextCursor null), 같은 발권 시각 두 장(ID 내림차순). 시험 값은 코드 기본값 20과 다르게도 한 번.
- **캐시 머리**: 200과 400 둘 다. 웹 워커가 `/v1/*`를 캐시하지 않는 규칙(sw-rules)은 그대로.
- **화면 쪽**: 실패 때 저장소를 지우지 않는다(현장 오프라인에서 QR이 사라진다). 401만 저장된 표를 숨긴다. 회차 요약은 회차마다 한 번(요청 수 단언). 첫 JS 예산(월렛 15KB [가정]): 동기화·api 조각은 늦게 가져온다(BAT-177 T6 규칙: QR·오프라인 조각은 load 뒤).
- **캐시 화면에 개인 값 금지**: `/my/tickets/[ticketId]` 서버 셸은 티켓 ID로 아무것도 읽지 않는다(지금의 목업 404 판정도 실제 화면에서는 뺀다).
- **데모**: 구매 전 목록과 견줘 '새로 생긴 이 회차 표'를 찾는다(앞 시나리오가 남긴 표와 섞이지 않게). 등록 응답을 기다린 뒤 QR을 본다(고정 대기 없음). 쿠키·QR 값은 로그에 싣지 않는다(지금 `api()` 규칙).
- **시작 파일 조립**: `start.ts`가 `tickets`를 넘기는지 따로 본다(시험 조립만 통과하고 실제 서버에서 404가 되는 일). 데모 S1 재생이 마지막 확인이다.
- 정본 시험 표에 세부 번호를 더하면 '연결 요구사항' 칸 앞에 둔다.

## 14. 정할 것

| # | 정할 것 | 추천·정할 곳 |
| --- | --- | --- |
| 1 | openapi `listTickets`에 400·401 응답 줄이 없다 | 그대로 둔다(계약 생성물 바꿈이 커진다. 400·401은 플랫폼 공통). 적어야 하면 범위 늘어남 후보 |
| 2 | 화면 Playwright spec 자리와 가짜 API | `tools/web-checks`의 운영 빌드 + 경로 가로채기(지금 `reflow/wallet-sw.spec.mjs`·`purchase/server.mjs` 꼴). 시험 담당이 고른다 |
| 3 | BAT-177 T6(첫 HTML에 QR 뼈대 data URI)의 실제 화면 대응 | 실제 화면의 첫 HTML(불러오는 중)에도 같은 QR 뼈대를 둔다. 시험 담당이 T6을 실제 화면 파일에 맞춰 고친다 |
| 4 | 데모 브라우저가 데스크톱 폭이다 | 데스크톱 안내(O-T32)는 이 일 밖이라 실제 화면은 바로 등록 버튼을 그린다. 데모는 그 버튼을 누른다 |
| 5 | 동기화 때 `meta.lastSyncAt` 말고 계정 표시를 둘지(공유 기기) | 두지 않는다(브라우저가 계정 ID를 모른다). frontend §4.2.4 '남는 한계'에 적었다 |
| 6 | `WalletTicketSnapshot`에 칸을 더할 때 Dexie 판 | 색인을 바꾸지 않으면 판을 올리지 않는다. 색인이 필요하면 판 2와 옮기기를 구현 메모에 |

## 시험 결과

(시험 담당·구현 담당이 채운다)

## 15. 리뷰(시험 리뷰)

- 시험도 구현도 맡지 않은 리뷰 담당이 시험의 바뀐 부분·이 계획·정본·장부만 보고 적는다(ADR-0372 결정 2). 볼 것: 판정 기준과 단언 대조(이름만 단 시험 없음), 11절 틀린 구현 열일곱을 시험이 잡는지, 13절, 시험 안티패턴(초록인데 검증 없음, 고정 대기, 내부 업무 로직 모킹, 짝 없는 가짜).
- 지적은 시험 담당이 고친다(`Role: review-fix`, `Fix-By: test`). 리뷰 담당이 반영을 확인해 이 절에 적으면 시험이 고정된다.

리뷰 담당 fwal-trev-7c4e(claude-opus-5-5), 2026-11-23, 시험 커밋 `8d06644e6`·계획 고침 `e3a505e76` 기준. 본 것: `git diff cec434dd3..HEAD -- services apps tools deploy`, 이 계획 1~14절, offline-gate §2 '월렛 목록 서버'·§11 O-T47·O-T48, frontend §4.2.4 '월렛 목록 세부'·§4.1 '시간 초과'·'api-client 밖의 호출', openapi `listTickets`·`Ticket`, authz-matrix §5.1, `docs/security/asvs/offline-gate.md` 해당 행, `ledger --batch FIX-wallet-tickets`(자동 시험 19, ID만 4, 빈칸 0). 시험을 돌리지는 않았다(읽기 리뷰).

**전체 판단**: O-T47 ①~⑧·O-T48 ①~⑩의 판정 문장마다 정본 값으로 정확히 단언하는 시험이 있고, 11절 틀린 구현 M1~M17은 모두 잡힌다. 가짜는 경계(저장소 포트의 `memory-*` 짝 가짜, `globalThis.fetch`, fake-indexeddb, 시계)뿐이고 업무 로직 모킹·고정 대기·타입 탈출은 없다. 실제 서버 연결은 통합 시험(`start()`)과 데모 S1이 맡는다. 다만 A 등급 실패 상황 둘(아래 TR-01·TR-04: 현장 오프라인 QR이 사라지는 길)이 열려 있고, 장부 ID만 넷이 게이트 `--require`에서 막힌다(TR-02). 구현 뒤 리뷰가 없으므로 10절 8의 '구현 리뷰 볼 점'은 지금 시험으로 못 박아야 한다.

| ID | 심각도 | 분류 | 자리 | 정본 근거 | 고칠 것 |
| --- | --- | --- | --- | --- | --- |
| TR-01 | 높음 | 장애 주입·빈칸(A 등급) | `apps/web/src/features/wallet-sync/sync.test.mjs:188-191`(bad-response 목록), 10절 8 | frontend §4.2.4 '저장'(목록을 **다 받으면** 맞춘다)·'화면 상태'(모양이 틀린 응답은 받지 못함), openapi `listTickets` 200의 `items`는 필수 칸이 아니다 | `items` 칸이 없는 200(`{ nextCursor: null }`, `{}`)은 계약 Zod를 지나므로, 구현이 `items ?? []`로 읽으면 저장소를 비워 오프라인 QR이 사라진다. 저장된 표가 있는 상태에서 이 두 응답을 주고 `{ kind: 'failed', reason: 'bad-response' }`, 저장소·`lastSyncAt` 그대로, 화면 `list`+`offline`을 단언하는 시험을 더한다. 8.3 `bad-response` 정의에 'items 칸 없음'을 적는다(정본 문장 보강이 필요하면 감독 판단) |
| TR-02 | 높음 | 장부·태그 | `services/ticket-svc/test/wallet-tickets-http.test.ts:175·292·357·459`, `test-int/wallet-tickets.int.test.ts:126·195·233` | `tools/ci/asvs-report.mjs` 15행(정본 꼴 `[ASVS v5.0.0-x.y.z]`), ledger `codeArea`(구현 위치가 가리키는 영역 안 시험만 센다) | ① 이름 `(ASVS v5.0.0-14.2.2, v5.0.0-14.3.2, v5.0.0-16.2.5)`는 첫 ID만 태그로 읽히고(꼴 다름 경고) 14.3.2·16.2.5는 태그가 아니다. ID마다 `[ASVS v5.0.0-14.2.2] [ASVS v5.0.0-14.3.2] [ASVS v5.0.0-16.2.5]`, `[ASVS v5.0.0-15.3.1]`, `[ASVS v5.0.0-8.2.2]` 꼴로 고친다(시험 담당). ② 네 행의 코드 영역이 `apps/scanner`(기본값)라 ticket-svc 시험이 세지지 않아 `ledger --batch FIX-wallet-tickets`가 'ID만 4'다. `docs/security/asvs/offline-gate.md` 14.2.2·14.3.2·15.3.1·16.2.5 행 구현 위치 칸에 `ticket-svc`(월렛 목록 `GET /v1/tickets`)를 적어야 자동 시험이 된다(정본이라 감독·계획 담당 몫, 게이트 `--require` 전) |
| TR-03 | 높음 | 장애 주입·되돌림(A 등급) | `sync.test.mjs:215-230`(O-T48 ④), `:313-331`(⑩) | plan 8.3 '실패면 저장소를 바꾸지 않는다', frontend §4.2.4 '저장'(다 받은 뒤 맞춤), O-T48 ④ | 지금 실패는 모두 **첫 쪽**에서 난다(⑩만 둘째 쪽). 저장된 표 2장이 있는 상태에서 첫 쪽 200(새 표 1장, 커서 있음) → 둘째 쪽 끊김·503·401(갱신 뒤도)인 경우를 더해 `failed`(401은 `needs-login`), 저장소가 앞 동기화 값 그대로(새 표 없음, 옛 표 그대로), `lastSyncAt` 그대로를 단언한다. 받은 만큼만 맞추는 구현(옛 표 지움 → 오프라인 QR 사라짐)을 잡는다. ④는 `got.kind`만 보지 말고 `reason`(`network`·`server`)까지 단언한다 |
| TR-04 | 중간 | 판정 단언 약함(TA-C10·C04) | `apps/web/src/features/wallet-sync/model.test.mjs:170-208`, `tools/web-checks/reflow/wallet-live.spec.mjs:140-162` | O-T48 ⑥ '등록된 키가 있으면 회전 QR이고 그 대체 글에 그 티켓 ID', frontend §3.7 | model 시험의 회전 QR은 시험이 직접 `createQrFrame(signer, card.ticketId, …)`을 불러 `decoded.ticketId === id`를 보므로, 실제 화면(`WalletLive`)이 `DeviceQr`에 다른 ID를 넘겨도 통과한다. spec ⑥에 '등록 버튼 누름 → `POST /v1/tickets/<id>/device-keys`를 경로 가로채기로 201(받은 JWK의 keyId, model 시험의 `keyIdOfJwk` 꼴) → `getByRole('img', { name: /^입장 QR, 티켓 <id>, 15초마다 바뀝니다/ })` 보임, 요청 경로의 ID = 목록 `ticketId`'를 더한다. model 시험의 15초 경계는 코드 함수(`msUntilNextQrFrame`)로 경계를 구하지 말고 정본 값(15초, 예 `03:00:14.999Z`·`03:00:15.000Z`)으로 둔다(TA-C02) |
| TR-05 | 중간 | 칸 단언(M5) | `services/ticket-svc/test/wallet-tickets-http.test.ts:407-426` | offline-gate §2 '무엇을 싣나'(받은 표의 `receivedFromNickname`, **잠긴 표의 `transferLockExpiresAt`**은 칸을 뺀다) | 받은 표·잠긴 표는 `'receivedFromNickname' in`과 `transferLocked`만 본다. 잠금 기한은 양도 저장소에 있어 구현이 `transferLockExpiresAt`을 채우기 쉽다. 두 항목 모두 키 집합을 정확히 단언한다(받은 표 `cancelDeadline, eventId, eventStartsAt, status, ticketId, transferLocked`, 잠긴 표는 여기에 `receivedFromNickname`). B 목록 원문에 결제자 A의 계정 ID가 없는지도 본다 |
| TR-06 | 중간 | 데모 정적 시험 빈틈(TA-C01) | `tools/local/demo.test.mjs:987`(새), `:960`(기존 같은 꼴) | 계획 8.5 확인 이름, 정본 d5 §10.6 S1 | `/addCheck\('wallet-list',\s*[a-zA-Z]/`는 `addCheck('wallet-list', true)`를 받는다(직접 확인). `true`·`false` 글자를 부정 앞보기로 막는 꼴(식 자리가 이름이나 호출이어야 한다)로 고치고, 같은 꼴인 960행 ticket-qr 단언도 함께 고친다. `ticket-qr` 식이 `wallet-list`로 찾은 ticketId와 QR 대체 글을 견주는지(`ticketQrOf` 결과와 그 ID를 함께 쓰는지)도 S1 블록에서 본다. '이 휴대폰을 입장용으로 등록'·`waitForResponse … device-keys` 단언은 `source` 전체가 아니라 S1 블록과 S1이 부르는 도우미로 좁힌다(다른 시나리오가 더하면 저절로 통과) |
| TR-07 | 낮음 | 경계·장애(시간 한도) | `sync.test.mjs:73-96`(가짜 API가 `init.signal`을 기록하지 않음), `:182` | frontend §4.2.4 '받기'(읽기 시간 한도는 §4.1 'api-client 밖의 호출'의 읽기 값 10초) | 시간 초과는 가짜가 `TimeoutError`를 던질 뿐이라 시간 한도가 없는 구현(답 없는 망에서 '불러오는 중'에 영원히 머묾)도 통과한다. 목록·요약 요청마다 `init.signal`이 `AbortSignal`인지 단언하거나, 신호를 따르는 멈춘 응답으로 10초 뒤 `network` 실패를 본다 |
| TR-08 | 낮음 | 캐시 머리 | `wallet-tickets-http.test.ts:459-470` | offline-gate §2 '캐시와 기록'(`private, no-store`, **오류 응답도**) | 판정 ⑧은 200·400이지만 정본 문장은 오류 응답 전부다. 401(세션 없음)·500(저장소 장애, 495행 시험)에도 `cache-control: private, no-store`를 단언한다. 플랫폼 가드가 401에 달지 못하면 시험 이의로 알린다 |

- 확인했고 지적하지 않은 것: 남의 표(①③⑦, 커서 바꿔 끼우기·쿼리 `accountId`·결제자/보유자), 다른 대상 신원 401(⑥, partner·ops·scanner = 다른 테넌트 몫), 금지 칸·값(⑤, 원문 문자열까지), 기록 줄(⑧, 빈 기록 통과 막음), 페이지 경계(4장·`limit` 2, 0장, 1·100, 같은 발권 시각), 풀리지 않는 커서 여섯 꼴, gRPC `INVALID_ARGUMENT`, 시작 파일 조립(통합이 `start()`), 통합 시험 CI 잡(`ci-node.yml` 154행), MS-09 `ListTickets: []`, 화면 상태 다섯·배지·문장(정본 글 그대로), 회차 요약 요청 수·쿠키 없음, 빠진 표의 기기 키 남김, QR 글자가 저장소·`console`에 없음, spec 0개 실행(제목 ' 기본 폭: ' 일곱 모두).
- **시험 고정**: TR-01~TR-06을 반영하면(TR-02 ②는 정본 고침이라 감독·계획 담당이 게이트 전에) 고정해도 된다. TR-07·TR-08은 반영을 권하지만 고정을 막지 않는다. 반영 확인은 이 리뷰 담당이 이 절에 적는다.

## 16. 검증

- 없음(ADR-0372 결정 3: 구현 뒤 리뷰·검증을 하지 않는다).

## 17. 담당 표

| 역할 | 세션 | 모델 | 커밋 |
| --- | --- | --- | --- |
| 계획 | fwal-plan-4b1c | claude-opus-5-5 | 이 커밋 |
| 시험 | fwal-test-2e9a | claude-opus-5-5 | 이 시험 커밋 |
| 시험 리뷰 | fwal-trev-7c4e | claude-opus-5-5 | 이 리뷰 커밋(지적 TR-01~08) |
| 구현 | | | |
| 기록 | | | |
