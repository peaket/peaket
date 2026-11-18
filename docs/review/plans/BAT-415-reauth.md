# 작업 계획: BAT-415-reauth(팬 예매 취소의 재인증 계약)

- **무엇**: BAT-415(등급 A, 단계 GAT-070·GAT-080)의 GAT-080 단계 줄 '남은 것' 첫째, 팬 예매 취소의 재인증 계약을 여는 일의 작업 목록이다. 지금 `TicketCancellationController`는 `ReauthGate` 기본값(`unavailableReauth`, 늘 false)이라 취소가 늘 403 `reauth-required`다. 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane3`, 가지 `feature/lane3-BAT-415`, 출발점 `07a3eae8`. 2026-11-18 계획 담당 `l3-b415r-plan`(claude-opus-5-5)이 썼고 시험·제품 코드는 쓰지 않았다. 지시서는 `node tools/ci/brief.mjs --batch BAT-415`(만든 때 `08120a67`)다.
- **묶음 ID와 차례**: 묶음 ID는 이 파일 이름 `BAT-415-reauth`다(장부 범위는 BAT-415 줄). 정방향 묶음이다(이 계획 커밋에 `Batch-Order: impl-first`). 차례는 계획 → 구현 → 시험(구현을 맡지 않은 시험 담당, 구현 전 트리 `07a3eae8`과 이 계획 커밋에서 실패 확인) → 리뷰 → 리뷰 반영 → 검증 → 기록이다. A 등급이라 짧은 고리를 쓰지 않는다(docs/architecture.md §8.6 '역할 나누기', ADR-0283 결정 2).
- **정본**: 이 커밋에서 먼저 고쳤다(아래 §6). docs/features/transfer-refund.md §3.1 '팬 취소의 재인증 확인'(새 문단)·§11 R-T39(새 줄), docs/security/authz-matrix.md §6 '작업 묶음 `act`의 값', docs/data.md §3 `reauth:jti:{jti}`(새 줄), docs/api/openapi.yaml `createTicketCancellation` 403 설명·503 응답(새 줄), docs/security/asvs/transfer-refund.md 'BAT-415-reauth 계획 메모', docs/BUILD_ORDER.md BAT-415 줄 '장부 범위'에 R-T39.

## 계획

### 1. 범위

| 구분 | 내용 |
| --- | --- |
| 장부 범위(BAT-415) | `R-T3, R-T4, P-T21, R-T39`(이 커밋에서 R-T39를 더함). `node tools/ci/ledger.mjs --batch BAT-415`: 항목 9개(R-T3·R-T4·P-T21 자동 시험 3, R-T39 ①~⑥ 빈칸 6), 등급 A 9 |
| 이 몫이 닿는 판정 항목 | R-T39 ①~⑥(새로 판정). R-T3·R-T4는 이미 '자동 시험'이고 그 시험은 재인증 대역(`reauth.verify → true`)을 꽂아 돈다. 인터페이스를 불(boolean) 반환 그대로 두므로 그 시험은 바뀌지 않아야 한다(회귀로만 돌린다). P-T21은 payment-svc라 닿지 않는다 |
| 범위 밖 | 부르는 쪽 ops-svc 실행(→ LCH-270), 가상계좌 몫(→ GAT-090. 다만 계좌를 담은 취소의 작업 묶음 규칙은 이 몫이 정한다), 팬 화면의 실제 재인증 흐름(`apps/web` 취소 화면은 미리보기뿐), 다른 재인증 받는 서비스(core·ops·payment)의 고침(§4 재쓰기 후보와 정리 목록 후보) |

### 2. 바른 동작(정본 docs/features/transfer-refund.md §3.1 '팬 취소의 재인증 확인')

| # | 동작 | 정본 근거 |
| --- | --- | --- |
| B1 | `X-Reauth-Token`을 팬 키 셋(`aud` fan)의 공용 확인기 `TokenVerifier.verifyReauth`로 본다: ES256 서명·`typ` reauth+jwt·`iss`·`aud` fan·`exp`, `sid` = `Principal.sessionId`, `act` = B2 | identity.md §3 '발급자와 검증 규칙'·'재인증 토큰의 묶음', §7.1 ④, authz-matrix §6 |
| B2 | 본문 `refundAccount`가 없으면 `FAN_SENSITIVE`만, 있으면 `FAN_HIGH_RISK`만 | authz-matrix §6 '작업 묶음 `act`의 값'(이 커밋) |
| B3 | 토큰의 `sub` = `Principal.accountId`(확인기는 `sub`를 대조하지 않으므로 받는 쪽이 본다) | identity.md §8 '탈퇴의 첫 구현'('`sub`가 그 계정'), core `attendee-exports.ts`와 같은 꼴 |
| B4 | B1~B3을 모두 통과한 뒤에만 `jti`를 좌석 Redis `reauth:jti:{jti}`에 `SET NX PX`(값 `1`, 수명 = min(5분, `exp` − 지금), 최소 1ms)로 잡는다. 이미 있으면 거절 | data.md §3 `reauth:jti:{jti}`(이 커밋), platform `RedisReauthJtiStore` |
| B5 | 차례: 인증 가드 → 멱등 키 → `@PurchaseSigned` → 본문 검사 → 재인증 → `CancelTicket.execute`. 재인증 거절·확인 못 함이면 ticket-svc·payment-svc 호출 0, `order_cancellation` 쓰기 0 | transfer-refund §3.1 '차례' |
| B6 | 거절(토큰 없음·빈 값, B1~B4 어긋남, 이미 씀) → 403 `reauth-required`. 확인 못 함(공개키 묶음을 한 번도 받지 못함 `TokenKeysUnavailable`, `jti` 저장소가 던짐) → 503 `reauth-unavailable`, `Retry-After: 5` [가정] | transfer-refund §3.1 '답', openapi 503 줄(이 커밋), identity.md §3 '공개키 배포' |
| B7 | 시작: `PEAKET_IDENTITY_FAN_JWKS_URL`이 있으면 확인기를 꽂는다(`PEAKET_IDENTITY_ISSUER`, 없으면 `https://identity.peaket.example`). 없으면 local·ci는 닫힌 대역 + 경고 한 번, 그 밖(`PEAKET_ENV` 없음 포함)은 시작 실패. 빈 문자열은 없는 것으로 본다 | transfer-refund §3.1 '시작 조립', `refund-wiring.ts`의 `STUB_ENVS` 규칙 |
| B8 | 견적 `GET …/cancellation-quote`는 지금처럼 재인증 없이 200 | transfer-refund §3.1 '답' |

### 3. 손댈 파일과 공개 인터페이스(구현 담당)

| 파일 | 할 일 | 공개 인터페이스 |
| --- | --- | --- |
| `services/purchase-svc/src/modules/refund/domain/ports.ts` | `ReauthGate.verify`의 질의에 `act`를 더하고 확인 못 함 오류를 둔다. 반환은 불 그대로(기존 시험 대역 `async () => true`가 그대로 돈다) | `export type FanReauthAct = 'FAN_SENSITIVE' \| 'FAN_HIGH_RISK'`. `verify(token: string \| undefined, q: { readonly accountId: string; readonly sessionId: string; readonly act: FanReauthAct }): Promise<boolean>`(true = 통과이고 이번 호출이 `jti`를 잡았다, false = 403). `export class ReauthUnavailable extends Error`(503) |
| 새 `services/purchase-svc/src/modules/refund/adapters/jwks-fan-reauth-gate.ts` | B1~B4·B6. core `JwksBookersReauth`·ops `JwksApprovalVerifier`와 같은 꼴(`createExternalHttpClient` provider `identity-jwks`, `timeoutCapMs` 5,000)이되 키 셋 fan, 패스키 검사 없음, `jti` 저장소는 **필수** | `export class JwksFanReauthGate implements ReauthGate { constructor(o: { jwksUrl: string; issuer: string; jti: ReauthJtiStore; clock?: Clock; fetch?: typeof fetch }) }`. 토큰 없음·빈 값 → false. `TokenRejected` → false. `TokenKeysUnavailable` → `ReauthUnavailable`. `sub` 불일치 → false(jti를 잡지 않음). `claim`이 던지면 `ReauthUnavailable`, false면 false. 그 밖의 오류는 그대로 던진다 |
| `services/purchase-svc/src/modules/refund/inbound/ticket-cancellation.controller.ts` | B2·B5·B6. 머리 주석의 known gap 줄을 바꾼다. `unavailableReauth`는 남긴다(대역 없는 조립의 닫힌 기본값) | `act = body.refundAccount !== undefined ? 'FAN_HIGH_RISK' : 'FAN_SENSITIVE'`. `ReauthUnavailable` → `ProblemError({ type: 'reauth-unavailable', status: 503, title: '재인증 검증기를 쓸 수 없습니다', retryAfterSeconds: 5 })`(제목은 openapi 목록과 같다). 재인증은 `cancel.execute`보다 앞, 지금 자리 그대로 |
| `services/purchase-svc/src/modules/refund/index.ts` | 내보내기 | `JwksFanReauthGate`, `ReauthUnavailable`, `type FanReauthAct` |
| `services/purchase-svc/src/refund-wiring.ts` | B7 조립 함수(시험이 시작 규칙을 따로 띄워 본다) | `export function fanReauthGateFromEnv(o: { readonly env: Readonly<Record<string, string \| undefined>>; readonly jti: ReauthJtiStore; readonly warn?: (msg: string) => void; readonly clock?: Clock; readonly fetch?: typeof fetch }): ReauthGate \| undefined`. 던짐 글에 `PEAKET_IDENTITY_FAN_JWKS_URL`을 넣는다 |
| `services/purchase-svc/src/start.ts` | 예매 취소 조립 블록(`if (database && ticketGrpcAddr && paymentGrpcAddr)`) 안에서 `fanReauthGateFromEnv({ env, jti: new RedisReauthJtiStore(redis), clock: systemClock, warn })`를 부르고 결과가 있으면 `refund.reauth`에 넣는다(`redis`는 좌석 Redis). 315줄 known gap 주석을 바꾼다. 경고는 이 파일의 기존 시작 경고 방식을 쓴다 | — |
| 생성물 `packages/contracts`·`packages/api-client` | openapi 503 줄을 더했으므로 둘 다 다시 만든다(`pnpm --filter @peaket/contracts gen`, `pnpm --filter @peaket/api-client gen`, 갈래 3 메모 'openapi 고치면 contracts·api-client 둘 다 gen') | 생성물만 |

- 마이그레이션: 없다. `jti` 한 번 쓰기는 기존 좌석 Redis로 푼다(purchase DB 표를 새로 두지 않는다). 그래서 purchase·payment·ticket 마이그레이션 번호를 정할 일이 없다.
- 다른 갈래 영향: openapi 한 줄(`createTicketCancellation` responses)과 생성물 두 패키지. 같은 줄을 다른 갈래가 고치면 합칠 때 겹친다. 깨지는 변경은 아니다(응답 하나 더함).

### 4. 재쓰기 후보(이미 재인증을 확인하는 곳)

| 자리 | 쓸 것 | 그대로 베끼지 않을 것 |
| --- | --- | --- |
| `packages/platform/src/token-verify.ts` `TokenVerifier.verifyReauth` | 서명·typ·iss·aud·exp·sid·act 확인, 공개키 묶음 캐시·다시 읽기, `TokenKeysUnavailable`·`TokenRejected` | `sub`는 대조하지 않는다(B3은 받는 쪽 몫) |
| `packages/platform/src/reauth-jti.ts` `RedisReauthJtiStore` | `SET reauth:jti:{jti} 1 NX PX min(5분, exp − now)` | `reauthJtiStoreFromEnv`는 쓰지 않는다(purchase는 좌석 Redis가 늘 있다. 닫힌 저장소 `UnavailableReauthJtiStore`가 끼면 403만 남는다) |
| core `services/core-svc/src/modules/export/adapters/sources.ts` `JwksBookersReauth`, ops `services/ops-svc/src/modules/payouts/adapters/jwks-approval-verifier.ts`, payment `JwksReauthVerifier` | JWKS를 `createExternalHttpClient`로 읽는 조립 | `jti?`가 선택이라 저장소를 안 넘기면 한 번 쓰기를 건너뛴다(`if (this.#jti)`). `TokenKeysUnavailable`을 잡지 않아 500이 된다. purchase는 둘 다 하지 않는다. 세 곳의 같은 꼴은 구간 끝 정리 목록 후보(이 몫에서 고치지 않음) |
| identity `services/identity-svc/src/modules/session/adapters/jose-reauth-verifier.ts` | 팬 키 셋(`keySet: 'fan'`, `aud` fan)을 쓰는 유일한 받는 쪽 예 | 자기 공개키를 바로 쓰므로 JWKS 읽기가 없다 |

### 5. 판정 항목마다 쓸 시험(시험 담당, 구현 뒤에 쓰고 구현 전 트리에서 실패를 본다)

- 공통 틀: `services/purchase-svc/test/refund-http.test.ts`처럼 `AppModule.register({ memory: true, sessions, refund: {…} })`에 실제 `JwksFanReauthGate`를 꽂는다. 시험 안에서 ES256 키 쌍을 만들고 가짜 `fetch`가 그 공개키 묶음(JWKS)을 준다. 발급자는 기본값과 다른 `https://identity.test`로 둔다(기본값을 잘못 쓰는 결함이 숨지 않게). `jti` 저장소는 `RedisReauthJtiStore`에 받은 명령을 적는 가짜 `command`를 넘긴다. 토큰 수명은 5분 상수와 다른 값(예 180초)으로 고른다(자주 놓친 결함 '시험 값은 상수와 다르게').
- 단언 값은 정본에서 가져온다: 상태·`type`(`${PROBLEM_TYPE_BASE}reauth-required`·`reauth-unavailable`)·`Retry-After` `5`는 transfer-refund §3.1·openapi, 작업 묶음 이름은 authz-matrix §6, 키 이름과 명령 모양은 data.md §3.

| 시험(이름은 ID로 시작) | 종류·파일 | 단언 | 판정 기준의 정본 |
| --- | --- | --- | --- |
| `R-T39 ① 같은 세션·계정의 FAN_SENSITIVE 토큰이면 취소가 202이고 Saga가 한 번 돈다` | 단위 HTTP, 새 `test/cancel-reauth-http.test.ts` | 202, 본문 `cancellationId` = 멱등 키·`status` REFUNDED·`refundAmount` 30,000(견적 시험과 같은 표 33,333원, 공제 10%), ticket `cancel` 1번·payment `cancel` 1번·`writes.create` 1번, 가짜 Redis에 `['SET', 'reauth:jti:<jti>', '1', 'NX', 'PX', '180000']` 정확히 한 번 | transfer-refund §11 R-T39 ①, §3.1 |
| `R-T39 ② 토큰이 없거나 맞지 않으면 403 reauth-required이고 아무것도 부르지 않는다` | 같은 파일 | 경우마다 따로(새 멱등 키·새 구매 일련번호): 머리 없음, 빈 값, 형식 깨짐, 만료(`exp` = 지금), 다른 `sid`, 다른 `sub`, 계좌 없는 본문에 `FAN_HIGH_RISK`, `BOOKER_EXPORT`, `act` 없음, JWKS에 없는 키로 서명(관리 키 자리), 같은 `kid`의 다른 키로 서명, `typ` at+jwt, `aud` partner, `iss` 다름. 모두 403·`type` reauth-required, ticket·payment·`writes.create` 0번, 가짜 Redis `SET` 0번. 경계 대조: `exp` = 지금 + 1초면 202 | R-T39 ②, identity §3 '발급자와 검증 규칙' |
| `R-T39 ③ 쓴 토큰은 다시 못 쓰고 구매 서명에서 막힌 요청은 토큰을 쓰지 않는다` | 같은 파일 | (가) 토큰 A로 표 1 → 202, 같은 A로 표 2(새 멱등 키) → 403 reauth-required이고 ticket `cancel`이 1번 그대로 (나) 토큰 B로 `X-Purchase-Mac`이 틀린 요청 → 401이고 Redis `SET` 0번, 이어 B로 바른 요청 → 202 (다) (가)의 첫 멱등 키와 새 토큰 C로 다시 → 202이고 `cancellationId`가 처음과 같으며 payment `cancel` 합이 1번(가짜 `writes`·`orders`가 같은 취소 ID의 앞 행을 돌려줄 수 있을 때. 대역으로 못 만들면 '실패 확인'에 까닭을 적고 뺀다) | R-T39 ③, §3.1 '한 번 쓰기'·'차례'·'남는 한계' |
| `R-T39 ④ 환급 계좌를 담은 취소는 FAN_HIGH_RISK 토큰만 받는다` | 같은 파일 | 본문 `{ refundAccount: { bankCode, accountNumber, holderName } }`: `FAN_SENSITIVE` → 403, 호출 0, `SET` 0번. `FAN_HIGH_RISK` → 202, Saga가 받은 `refundAccount`가 본문과 같다 | R-T39 ④, authz-matrix §6 |
| `R-T39 ⑤ 확인하지 못하면 503 reauth-unavailable이고 아무것도 부르지 않는다` | 같은 파일 | (가) 가짜 `fetch`가 첫 공개키 읽기에 던짐(또는 500) → 503, `type` reauth-unavailable, `Retry-After` `5`, 호출 0. 이어 `fetch`가 살아나면 새 토큰으로 202(실패를 영구로 들고 있지 않다) (나) 가짜 `command`가 던짐 → 503·`Retry-After` `5`·호출 0 (다) 세 상태의 가운데 대조: `command`가 `null`(이미 있음) → 403이지 503이 아니다 | R-T39 ⑤, identity §3 '공개키 배포' |
| `R-T39 ⑤ 어댑터는 확인을 마친 뒤에만 정확한 수명으로 jti를 잡는다` | 단위, 새 `test/jwks-fan-reauth-gate.test.ts`(가짜 시계) | `exp` − 지금 = 180초 → `PX` `'180000'`. 600초짜리(정본 5분보다 긴, 시험 키로 만든 토큰) → `'300000'`. 경계: 지금 = `exp`×1000 − 1 → true이고 `PX` `'1'`, 지금 = `exp`×1000 → false이고 `command` 0번. `act`·`sid`·`sub`가 틀린 토큰 → false, `command` 0번. `TokenKeysUnavailable` → `ReauthUnavailable`을 던짐(false가 아님) | data.md §3 `reauth:jti:{jti}`, §3.1 '한 번 쓰기' |
| `R-T39 ⑥ 팬 공개키 묶음 주소 없이는 운영에서 시작하지 않는다` | 단위, 새 `test/fan-reauth-wiring.test.ts` | `fanReauthGateFromEnv`: 주소 없음·빈 문자열에 `PEAKET_ENV` prod·staging·demo·없음 각각 → 던짐(글에 `PEAKET_IDENTITY_FAN_JWKS_URL`). local·ci → undefined이고 `warn` 1번. 주소 있음(환경마다) → `JwksFanReauthGate`. 주소만 있고 `PEAKET_IDENTITY_ISSUER`가 없으면 `iss` `https://identity.peaket.example` 토큰은 받고 `https://identity.test`는 거절 | R-T39 ⑥, §3.1 '시작 조립' |
| `R-T39 ⑥ start.ts는 좌석 Redis의 jti 저장소로 확인기를 만들어 예매 취소 조립에 넣는다` | 단위(시작 파일 글 읽기, `test/start-fraud-grpc.test.ts`와 같은 방식), 같은 새 파일 | 주석을 뺀 `start.ts`에서 `fanReauthGateFromEnv(`가 예매 취소 조립 블록 안에 있고, 인자에 `new RedisReauthJtiStore(redis)`가 있으며(`Memory…`·`reauthJtiStoreFromEnv`가 아님), 결과가 `refund` 객체의 `reauth`로 들어간다 | §3.1 '시작 조립', 자주 놓친 결함 '시작 파일 조립은 따로' |

- 회귀(고치지 않고 돌린다): `test/refund-http.test.ts`(대역 없는 조립의 403 `GAT080_취소는_구매서명을_지나지만_재인증_계약이_없어_403_reauth-required다`, R-T3, 견적 200은 B8), `test/cancel-ticket.test.ts`(R-T3·R-T4), `test/cancel-ticket-event-cancelled.test.ts`, `test/refund-wiring.test.ts`, `test/start-fraud-grpc.test.ts`. 앞 시험의 대역은 질의의 `act`를 보지 않으므로 그대로 통과해야 한다. 실패하면 '시험 이의'가 아니라 구현 결함으로 본다(인터페이스를 불 반환으로 둔 까닭).
- 구현 전 트리에서 실패를 볼 수 없는 시험: ③(나)의 401 쪽, ⑤(다)는 구현 전 트리에서도 거절이라 실패 이유가 '어댑터·함수가 없다'뿐이다. 이것은 실패로 세지 않으므로(§8.6 '모든 시험은 한 번은 실패를 본다') 검증의 틀린 구현(아래 M12·M11)으로 실패를 한 번 본다.
- 통합(선택, Docker, 감독이 잠금을 잡은 때만): `test-int/cancellation.int.test.ts`에 실제 좌석 Redis로 같은 토큰 두 번 → 두 번째 403. 단위의 가짜 `command`가 명령 모양을 정확히 보므로 이 묶음의 필수는 아니다.

### 6. 정본 빈칸과 정한 것(이 커밋에서 정본에 씀, 모두 '추천 적용, 2026-11-18')

| 빈칸 | 정한 것 | 쓴 곳 |
| --- | --- | --- |
| purchase-svc가 팬 재인증 토큰을 어떻게 확인하는지(known gap) | B1·B3·B5·B6·B8 | transfer-refund §3.1 '팬 취소의 재인증 확인' |
| 환급 계좌를 담은 취소의 작업 묶음 | 계좌가 있으면 `FAN_HIGH_RISK`만, 없으면 `FAN_SENSITIVE`만(반대도 거절) | authz-matrix §6, transfer-refund §3.1, openapi 403 설명 |
| `jti` 한 번 쓰기를 어디에 두나 | 좌석 Redis `reauth:jti:{jti}`(마이그레이션 없음). 다른 받는 서비스의 자리도 함께 적음(키가 정본에 없었다) | data.md §3 |
| 확인 못 함의 답 | 503 `reauth-unavailable`(openapi 목록에 이미 있는 이름), `Retry-After: 5` [가정]. `jti` 저장소 오류도 403이 아니라 503(세 상태의 가운데) | transfer-refund §3.1, openapi `createTicketCancellation` 503 |
| 시작 조립의 설정 이름과 규칙 | `PEAKET_IDENTITY_FAN_JWKS_URL`·`PEAKET_IDENTITY_ISSUER`, local·ci만 닫힌 대역 | transfer-refund §3.1 '시작 조립' |
| 판정 항목 | R-T39 ①~⑥을 만들고 BAT-415 장부 범위에 더함 | transfer-refund §11, BUILD_ORDER BAT-415 '장부 범위' |
| ASVS 대조 | 9.1.1·9.2.1~9.2.3·8.2.1·2.3.1 메모 | asvs/transfer-refund.md |

- 방향을 바꾸는 결정이 없어 ADR은 쓰지 않았다(identity §3·§7.1과 authz-matrix §6의 규칙을 팬 취소에 적용한 것). 0293은 쓰지 않았다.
- `Retry-After: 5`는 [가정]이다. 공개키 묶음을 한 번도 받지 못한 동안에는 확인기가 요청마다 다시 읽으므로 1초보다 길게 두었다.
- 남는 한계(정본에 적음): 토큰을 쓴 뒤 응답을 잃은 재시도는 새 재인증이 필요하다. 좌석 Redis가 데이터를 잃으면 5분 안의 `jti` 기록이 사라진다.

### 7. 차례(구현 담당 안에서)

1. ports.ts 인터페이스·오류 → 2. 어댑터 → 3. 컨트롤러 → 4. index 내보내기 → 5. refund-wiring 조립 함수 → 6. start.ts 조립 → 7. contracts·api-client 생성물 → 8. 아래 §10 게이트 명령. 시험 파일은 고치지 않는다(기존 시험이 깨지면 위 '회귀' 줄대로 구현을 고친다).

### 8. 자주 놓친 결함 가운데 해당하는 것

| 결함(docs/architecture.md §8.6) | 이 몫에서 |
| --- | --- |
| 저장소 응답은 정확한 값까지 | `SET` 명령의 키·값·`NX`·`PX` 수까지(§5 ①·⑤ 어댑터) |
| 경계값은 양쪽 | `exp` 직전(−1ms)과 `exp`, 수명 5분 상한의 안·밖(180초·600초) |
| 소유자·세션·토큰의 계정 대조를 뺀 요청이 거절되는지 | `sub`·`sid` 각각(② 다른 계정·다른 세션, M3·M4) |
| 허용·거부 목록은 목록 밖 값마다 | `act` 목록 밖(`BOOKER_EXPORT`·없음)과 반대 묶음, `typ`·`aud`·`iss` 각각 |
| 세 상태(있음·없음·확인 못 함)의 가운데 | `jti` 저장소: 잡음 true·이미 있음 false(403)·오류(503). 공개키: 받음·못 받음(503) |
| 판정 함수만이 아니라 부르는 쪽이 결과를 쓰는지 | HTTP에서 호출 0·`writes.create` 0까지 본다(어댑터 단위만으로 끝내지 않음) |
| 겹친 가드는 하나씩 빼 본다 | 확인기의 `sid`·`act` 대조와 받는 쪽 `sub` 대조, 구매 서명과 재인증의 차례(M3·M4·M12) |
| 시험 값을 상수와 다르게 | 토큰 수명 180초·600초, 발급자 `https://identity.test` |
| 시작 파일 조립은 따로 | `fanReauthGateFromEnv` 단위 + start.ts 글 읽기(⑥ 둘) |
| 장애 주입이 실제로 끼어들었는지 | ⑤에서 가짜 `fetch`·`command`가 실제로 불렸는지(부른 수 ≥ 1)를 함께 단언 |

### 9. A등급 틀린 구현 표본(검증 담당이 넣을 것, 14개)

| # | 틀린 구현 | 잡는 시험 |
| --- | --- | --- |
| M1 | 요청 `act`가 아니라 토큰의 `act`를 확인기에 넘긴다(묶음 대조 무력) | ② `BOOKER_EXPORT`·`FAN_HIGH_RISK` 줄, ④ |
| M2 | 계좌가 있어도 `FAN_SENSITIVE`를 넘긴다 | ④ |
| M3 | `sub` 대조를 뺀다 | ② 다른 계정 |
| M4 | `sessionId`로 요청 세션이 아니라 토큰의 `sid`를 넘긴다 | ② 다른 세션 |
| M5 | `jti` 잡기를 뺀다 | ③(가), ① `SET` 1번 |
| M6 | `jti`를 Saga 뒤에 잡는다 | ③(가)의 ticket `cancel` 1번 그대로 |
| M7 | `jti`를 서명·클레임 확인 앞에서 잡는다 | ⑤ 어댑터(틀린 토큰의 `command` 0번), ② `SET` 0번 |
| M8 | 수명을 늘 5분으로 둔다(`expiresAt` 무시) | ⑤ 어댑터 `PX` `'180000'` |
| M9 | `TokenKeysUnavailable`을 false(403)로 바꾼다 | ⑤(가), ⑤ 어댑터 |
| M10 | `jti` 저장소 오류를 통과(true)로 본다 | ⑤(나) |
| M11 | `jti` 저장소 오류를 403으로 둔다 | ⑤(나)의 503, ⑤(다) |
| M12 | 재인증을 `@PurchaseSigned` 앞(가드)으로 옮긴다 | ③(나)의 401 뒤 `SET` 0번과 이어진 202 |
| M13 | `fanReauthGateFromEnv`가 운영에서 주소가 없으면 undefined(닫힌 대역)로 뜬다 | ⑥ 조립 함수 |
| M14 | start.ts가 `MemoryReauthJtiStore`나 `reauthJtiStoreFromEnv(env)`(Redis 없이)를 넘긴다 | ⑥ start.ts 글 |

### 10. 닿는 CI 잡과 게이트 명령

| 영역 | 잡 | 비고 |
| --- | --- | --- |
| services/purchase-svc | node / node, contract-check / contracts | 통합 시험 `pnpm --filter @peaket/purchase-svc test:integration`(이 몫은 단위만 필수) |
| docs/api(openapi) | contract-check / contracts, docs-check / docs, node / node | node가 전체를 돈다(WIDEN_JS, docs/api). 생성물 차이·깨짐 검사·서비스 OpenAPI 차이(D-T38) |
| packages/contracts·api-client 생성물 | contract-check / contracts, node / node | — |
| docs | docs-check / docs | — |

```
cd /d/ticketpass-lane3/services/purchase-svc && npx vitest run test/cancel-reauth-http.test.ts test/jwks-fan-reauth-gate.test.ts test/fan-reauth-wiring.test.ts test/refund-http.test.ts test/cancel-ticket.test.ts test/cancel-ticket-event-cancelled.test.ts test/refund-wiring.test.ts test/start-fraud-grpc.test.ts && npx tsc -p tsconfig.json --noEmit
cd /d/ticketpass-lane3/services/purchase-svc && npx vitest run
cd /d/ticketpass-lane3 && pnpm --filter @peaket/contracts gen:check && pnpm --filter @peaket/contracts test && pnpm --filter @peaket/api-client test
cd /d/ticketpass-lane3 && pnpm lint
cd /d/ticketpass-lane3 && python -I -X utf8 tools/doc-check/check_all.py
cd /d/ticketpass-lane3 && node tools/ci/ledger.mjs --batch BAT-415
```

- 이 PC에서 `pnpm`이 응용 프로그램 제어에 막히면(갈래 메모) 생성은 `node packages/contracts/scripts/generate.mjs`·`node packages/api-client/scripts/generate.mjs`, 검사는 같은 폴더의 `check-generated.mjs`로 돌리고 lint는 `npx eslint services/purchase-svc`로 대신한다. 깨짐 검사(`tools/ci/contract-breaking.mjs`)는 Docker 이미지를 쓰므로 감독 잠금 때만 돌리고, 못 돌리면 '검증'에 적어 CI에 맡긴다.
- 문서 점검: 이 계획 커밋은 새 오류 0이다(이 파일이 생기기 전에는 transfer-refund §3.1의 계획 경로가 '없는 경로'였다. 남은 경고 넷은 출발점에도 있는 것).

## 실패 확인

(시험 담당이 채운다)

## 시험 결과

(시험 담당이 채운다)

## 리뷰

(리뷰 담당이 채운다)

## 검증

(검증 담당이 채운다)

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | l3-b415r-plan | claude-opus-5-5 | 2026-11-18T20:50+09:00 | 2026-11-18T21:08+09:00 |

- 다른 담당은 자기 커밋에서 이 표에 자기 행을 더한다. 리뷰 반영 커밋은 `Fix-By`의 역할(시험·구현) 행으로 센다.
