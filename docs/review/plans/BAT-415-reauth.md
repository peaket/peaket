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

- 담당: 시험 `l3-b415r-test`(구현을 맡지 않음), 2026-11-18. 구현 전 트리는 계획 커밋 `f9aed291`(구현 `6dfb671b` 앞)이다.
- 명령: `git -C D:/ticketpass worktree add --detach D:/ticketpass-lane3-base f9aed291` → 그 안에서 `pnpm install --frozen-lockfile --prefer-offline` → `packages/shuffle`에서 `npx tsc -p tsconfig.build.json`(dist) → 시험 파일 넷(`test/fan-reauth-fixtures.ts`·`test/cancel-reauth-http.test.ts`·`test/jwks-fan-reauth-gate.test.ts`·`test/fan-reauth-wiring.test.ts`)만 복사 → `services/purchase-svc`에서 `npx vitest run test/cancel-reauth-http.test.ts test/jwks-fan-reauth-gate.test.ts test/fan-reauth-wiring.test.ts` → 끝난 뒤 `git -C D:/ticketpass worktree remove --force D:/ticketpass-lane3-base`.
- 결과: 시험 23개 가운데 실패 12·건너뜀 11·통과 0.
  - **단언 실패 3(실패로 센다)**: `R-T39 ④ 컨트롤러는 … FAN_HIGH_RISK, 없으면 FAN_SENSITIVE를 … 묻는다`(확인기가 받은 질의에 `act`가 없다), `R-T39 ⑤ 확인기가 확인하지 못하면(ReauthUnavailable) 503 …`(500을 받았다. 구현 전 컨트롤러는 확인기가 던진 오류를 503으로 바꾸지 않는다), `R-T39 ⑥ start.ts는 좌석 Redis의 jti 저장소로 확인기를 만들어 …`(예매 취소 조립 블록에 `fanReauthGateFromEnv(`가 없다).
  - **새 이름이 없어 돌지 못함 9(세지 않는다)**: `jwks-fan-reauth-gate.test.ts`의 ⑤ 다섯은 `TypeError: JwksFanReauthGate is not a constructor`, `fan-reauth-wiring.test.ts`의 ⑥ 조립 함수 넷은 `TypeError: fanReauthGateFromEnv is not a function`(구현 전 `refund/index.ts`·`refund-wiring.ts`에 그 내보내기가 없다).
  - **건너뜀 11(세지 않는다)**: `cancel-reauth-http.test.ts`의 실제 확인기 조립 둘(①·②×2·③×4·④·⑤×2, 그리고 공개키 묶음 못 받음 ⑤)은 `beforeAll`에서 `JwksFanReauthGate is not a constructor`로 조립이 깨져 돌지 않았다.
- 구현 전 트리에서 단언 실패를 보지 못한 시험 20개(어댑터·조립 함수·실제 확인기 HTTP)는 계획 §5 끝 줄대로 검증 담당의 틀린 구현(§9 M1~M14)으로 실패를 한 번 본다.

## 시험 결과

- 시험 파일(이름은 모두 `R-T39 <세부>`로 시작):
  - `services/purchase-svc/test/cancel-reauth-http.test.ts` 13개: ① 1, ② 2(목록 17가지 거절 + `exp` = 지금 + 1초 경계 대조), ③ 4(다른 표에 다시 씀, 401 뒤 같은 토큰, 400 뒤 같은 토큰, 같은 멱등 키를 새 토큰으로 다시 보냄), ④ 2(실제 확인기, 컨트롤러가 묻는 `act`), ⑤ 4(jti 저장소 오류 503, 가운데 상태 '이미 있음' 403, 공개키 묶음 못 받음 503 뒤 살아나면 202, 확인기의 `ReauthUnavailable` → 503).
  - `services/purchase-svc/test/jwks-fan-reauth-gate.test.ts` 5개: 모두 ⑤(수명 180초 → `PX 180000`·600초 → `300000`·`exp` 직전 1ms → `1`·`exp` → 거절, act·sid·sub 거절과 jti 안 잡음, 빈 토큰, 공개키 못 받음(던짐·500) → `ReauthUnavailable`, jti 세 상태).
  - `services/purchase-svc/test/fan-reauth-wiring.test.ts` 5개: 모두 ⑥(주소 없음·빈 값 × prod·production·staging·demo·없음 → 던짐, local·ci → undefined와 경고 1번, 주소가 있으면 환경마다 확인기이고 그 주소에서 읽음, 발급자 기본값, start.ts 글).
  - 도구 `services/purchase-svc/test/fan-reauth-fixtures.ts`(ES256 서명, 가짜 공개키 묶음 fetch, 명령을 적는 가짜 좌석 Redis). 발급자는 `https://identity.test`, 토큰 수명은 180초(5분 상수와 다름).
  - 통합(선택) `services/purchase-svc/test-int/cancel-reauth.int.test.ts` 1개(③): 실제 Valkey로 같은 토큰 두 번째 취소 → 403, 키 값 `1`·남은 시간 170~180초. 이 PC에서 Docker로 돌리지 않았고 `tsc --noEmit`으로 컴파일만 확인했다(감독이 초안 PR CI로 돌린다). 계획은 `cancellation.int.test.ts`에 더한다고 했으나, Valkey만 띄우는 가벼운 새 파일로 나눴다.
- 계획과 달라진 것: ③(다)는 가짜 `writes`·`orders`가 취소 기록을 돌려주게 해 뺄 필요가 없었다(202, 같은 취소 ID, 결제사 취소 1번). 계획에 없던 것으로 ③ '본문 검사(400) 뒤 같은 토큰'(정본 '차례'의 본문 검사 → 재인증), ② `OPS_COMMAND`·`jti 없음`, ④ 목록 밖 `PAYOUT_ACCOUNT`, 확인기 대역으로 컨트롤러가 묻는 질의와 503 변환을 따로 본 둘을 더했다.
- 구현 트리(`6dfb671b`): 새 시험 23/23 통과. `services/purchase-svc`에서 `npx vitest run` 전체 132 파일·4,157개 통과(구현 커밋의 129 파일·4,134개에 새 3 파일·23개). 회귀(refund-http·cancel-ticket·cancel-ticket-event-cancelled·refund-wiring·start-fraud-grpc)도 그 안에서 통과.
- 구현 결함 의심: 없다(실패한 시험이 없다).
- 게이트: `npx tsc -p tsconfig.json --noEmit`(purchase-svc, test·test-int 포함) 통과. `npx eslint`(바꾼 파일 다섯) 오류 0(저장소 설정이 서비스 시험 파일을 대상으로 두지 않아 '설정 없음' 경고만), `npx eslint services/purchase-svc` 오류 0. `python -I -X utf8 tools/doc-check/check_all.py` 오류 0·경고 4(출발점과 같음).

## 리뷰

- 담당: 리뷰 `l3-b415r-review`(claude-opus-5-5), 2026-11-18. 본 것: `git diff 07a3eae8..a01638e3`, 지시서 §7 '자주 놓친 결함', 정본(transfer-refund §3.1 '팬 취소의 재인증 확인', authz-matrix §6, identity.md §3 '공개키 배포'·'발급자와 검증 규칙'·'재인증 토큰의 묶음', data.md §3 `reauth:jti:{jti}`, openapi `createTicketCancellation`), 주변 코드(`packages/platform` `token-verify.ts`·`reauth-jti.ts`·`http-client.ts`, `start.ts` 예매 취소 조립, `apps/web` 취소·재인증 흐름). 관점 넷(정확성, 동시 실행·장애, 보안, 화면과 서버 잇기)을 한 번에 봤다.
- 대조 결과: 계획 §3의 일곱 항목(ports·어댑터·컨트롤러·index·refund-wiring·start.ts·생성물)이 모두 구현됐고 공개 인터페이스가 계획과 같다. 구현 커밋 `6dfb671b`는 시험 파일을 건드리지 않았다(바뀐 파일 8개 모두 `src`·생성물·계획 파일). 시험 커밋 `a01638e3`는 `src`를 건드리지 않았다. 토큰 검증은 서명(ES256만)·`typ`·`iss`·`aud`·`exp`·`sid`·`act`(플랫폼 확인기)와 `sub`(어댑터 51줄)를 모두 보고, 거절·`sub` 불일치는 `jti`를 잡기 전에 끝나며, `jti`는 `SET NX`(원자적)라 같은 토큰 두 요청이 동시에 와도 하나만 지난다. 확인 못 함(공개키 처음 못 받음, 저장소 오류)이 통과로 새는 길은 없다(둘 다 `ReauthUnavailable` → 503). 운영에서 닫힌 대역으로 조용히 뜨는 길도 없다(`PEAKET_ENV` 없음·demo 포함 시작 실패).
- 높음 0, 중간 1, 낮음 8.

| # | 심각도 | 관점 | 자리 | 지적 | 근거(정본) | 고칠 방향 |
| --- | --- | --- | --- | --- | --- | --- |
| RV-01 | 중간 | 보안 | `docs/data.md:2645`(`reauth:jti:{jti}` 줄), `jwks-fan-reauth-gate.ts:54` | `jti` 한 번 쓰기가 받는 서비스마다 따로라(purchase는 좌석 Redis, identity 탈퇴·기기 세션 끝내기·제공자 잇기는 PostgreSQL `reauth_token_use`) 같은 세션의 `FAN_SENSITIVE` 토큰 하나를 identity에서 한 번, 팬 취소에서 한 번 더 쓸 수 있다. 예: 기기 세션을 끝내려고 받은 토큰으로 5분 안에 공제가 붙는 예매 취소를 한다. 이 묶음이 정본에 '받는 서비스마다 자기 Redis에 둔다'를 쓰면서 그 결과는 적지 않았다 | identity.md §3 '재인증 토큰의 묶음'('5분 한 번', 묶음은 다른 작업에 쓰지 못하게 하려는 것), authz-matrix §6 | 이번에는 transfer-refund §3.1 '남는 한계'와 data.md 줄에 '한 번 쓰기는 받는 서비스 안에서만이고, 같은 `FAN_SENSITIVE` 토큰을 identity 작업과 팬 취소에 한 번씩 쓸 수 있다'를 적고, 받아들일지 소유자에게 묻는다(OPEN). 막으려면 다음 단계에서 고른다: (가) 팬 취소만의 묶음(`act`)을 둔다, (나) identity가 토큰에 받는 쪽 작업을 싣고 웹이 `purpose`로 고른다, (다) 한 번 쓰기를 identity 한 곳에서 한다(gRPC로 소비). 어느 것이든 ADR이 필요하다 |
| RV-02 | 낮음 | 보안 | `jwks-fan-reauth-gate.ts:54`, `packages/platform/src/reauth-jti.ts`(`Math.min(REAUTH_JTI_TTL_MS, …)`), 시험 `jwks-fan-reauth-gate.test.ts:39–42` | 남은 수명이 5분보다 긴 토큰도 받고 `jti` 기록만 5분에서 자르므로, 기록이 사라진 뒤 토큰이 아직 살아 있으면 다시 쓸 수 있다. identity와 purchase의 시계가 s초 어긋나면 토큰 끝 s초가 다시 쓸 수 있는 틈이다. 시험 ⑤가 600초 토큰을 받고 `PX 300000`을 단언해 이 틈을 '바른 동작'으로 고정한다 | identity.md §3 '재인증 토큰의 묶음'(5분 한 번), data.md §3('수명은 토큰의 남은 시간이고 5분을 넘지 않는다') | 어댑터에서 `expiresAt − 지금`이 5분 + 작은 허용치(정본에 [가정]으로 정함)를 넘는 토큰을 거절(false, `jti` 안 잡음)한다. 시험 ⑤의 600초 줄은 '거절이고 `command` 0번'으로 바꾼다(정본 문장도 '넘으면 거절'로 고친다) |
| RV-03 | 낮음 | 정확성 | `jwks-fan-reauth-gate.ts:20·32` | 공개키 묶음 주소의 쿼리(`u.search`)를 버리고 `pathname`만 부른다. 또 `PEAKET_IDENTITY_FAN_JWKS_URL`이 주소 꼴이 아니면 `new URL`이 'Invalid URL'만 던져 어느 설정이 틀렸는지 시작 로그로 알 수 없다 | transfer-refund §3.1 '시작 조립' | `path: u.pathname + u.search`. `fanReauthGateFromEnv`에서 `new URL`을 감싸 던짐 글에 설정 이름을 넣는다 |
| RV-04 | 낮음 | 동시 실행·장애 | `ticket-cancellation.controller.ts:76·93`, `jwks-fan-reauth-gate.ts:10`, platform `token-verify.ts` `#keysFor` | 재인증 확인이 `@Bulkhead(WRITE_BULKHEAD)` 안에서 돈다. 이 칸막이는 주문 만들기(`orders.controller.ts`)와 함께 쓴다. 공개키 캐시가 5분을 넘으면 그 요청이 다시 읽기를 기다리고(identity가 느리면 최대 5,000ms, 장애 중에는 30초마다), 그동안 같이 온 취소들이 쓰기 칸을 잡고 있다. 첫 읽기도 첫 취소 요청이 한다 | identity.md §3 '공개키 배포'(장애에도 무상태 검증), docs/architecture.md 칸막이 규칙 | 이 몫에서 고치지 않아도 된다. 정리 목록 후보: 시작할 때 한 번 미리 읽기, 캐시가 오래되면 옛 키로 답하고 뒤에서 다시 읽기(플랫폼), 공개키 읽기 상한을 요청 마감보다 짧게(예 1,000ms [가정]) |
| RV-05 | 낮음 | 정확성 | `jwks-fan-reauth-gate.ts:48` | 확인기가 `TokenRejected`·`TokenKeysUnavailable` 말고 던지는 것(공개키 묶음 안 키를 들여오지 못한 jose `JWKInvalid`·`JOSENotSupported` 등, 받은 JSON이 키 묶음 꼴이지만 키가 깨진 경우)은 그대로 던져 500이 된다. 닫힌 쪽이라 보안 결함은 아니지만 정본의 '확인하지 못하면 503'과 다르다 | transfer-refund §3.1 '답' | jose 키 오류 종류를 `ReauthUnavailable`로 바꾸고, 그 밖의 예상 못 한 오류만 그대로 던진다. 시험에 '키 묶음 안 키가 깨짐 → 503' 한 줄 |
| RV-06 | 낮음 | 보안(관측) | `jwks-fan-reauth-gate.ts:46`, `refund-wiring.ts:57` | 거절 이유(`TokenRejected.reason`)를 버리고 지표·로그가 없다. `PEAKET_IDENTITY_ISSUER`가 빠지면 운영에서도 기본값 발급자로 조용히 떠서, 발급자가 다르면 모든 팬 취소가 403이 되는데 아무 신호가 없다(팬은 재인증만 되풀이한다) | transfer-refund §3.1 '시작 조립', docs/observability.md 필드 규칙(이름표 가짓수) | local·ci 밖에서 발급자 기본값을 쓰면 시작 경고 한 줄. 거절 이유를 정해진 이름표(`format`·`kid`·`signature`·`typ`·`iss`·`aud`·`expired`·`claims`·`sub`·`replay`)로 세는 지표나 요청 기록 속성을 둔다(토큰 내용은 싣지 않는다) |
| RV-07 | 낮음 | 동시 실행·장애 | transfer-refund §3.1 '남는 한계'(126줄), `jwks-fan-reauth-gate.ts:53–57` | 저장소 오류로 503을 줄 때 `SET`이 실제로 들어갔을 수 있다(응답 시간 초과). 그러면 `Retry-After: 5` 뒤 같은 토큰으로 다시 보내면 403이다. '남는 한계'는 Saga 실패·응답 잃음만 적었다. 닫힌 쪽이라 돈 위험은 없다 | transfer-refund §3.1 '답'·'남는 한계', docs/frontend.md 660줄('한 번 쓰면 버린다') | '남는 한계'에 '503 `reauth-unavailable` 뒤 다시 보낼 때도 새 재인증이 필요하다'를 더한다(선택: `jti` 값에 멱등 키를 넣어 같은 키로 다시 보낸 요청은 지나게 하면 응답 잃음 재시도도 풀리나, data.md 값 `1`을 바꾸는 결정이라 ADR이 필요하다) |
| RV-08 | 낮음 | 화면과 서버 잇기(다음 단계 몫) | `apps/web/src/_pages/ticket-cancel/ui/CancelFlow.tsx:5`, `apps/web/src/_pages/refund-account/ui/ReauthSheet.tsx`, `apps/web/src/features/social-login/server/handlers.ts:242`, docs/frontend.md 758·1344줄 | 웹 취소 화면은 미리보기뿐이라 `X-Reauth-Token`을 보내지 않는다(계획 §1 범위 밖, 맞음). 잇는 단계가 지킬 것: 본문에 환급 계좌를 실으면 재인증 `purpose`를 `high-risk`로(웹 `handlers.ts:242` → 같은 폴더 `identity-client.ts:173` `REAUTH_PURPOSE_HIGH_RISK` → `services/identity-svc/src/modules/session/domain/session.ts:25` `FAN_HIGH_RISK`), 없으면 빈 값(`sensitive`)으로 받는다. 환급 계좌 화면에 따로 재인증 시트가 있어, 계좌 입력과 취소가 재인증을 두 번 받거나 `sensitive` 토큰으로 계좌 취소를 보내 403이 되풀이되지 않게 흐름을 정한다. frontend.md 오류 표에 503 `reauth-unavailable` 줄(문구 키, 새 재인증 뒤 다시 보냄)이 없다 | authz-matrix §6, transfer-refund §3.1 '작업 묶음'·'남는 한계', frontend.md §4.1·§4.3 | 취소 화면을 잇는 단계 줄(BUILD_ORDER)에 위 셋을 적고, frontend.md 오류 표에 503 `reauth-unavailable`을 더한다 |
| RV-09 | 낮음 | 시험 | `test/cancel-reauth-http.test.ts:187–218`, `test/jwks-fan-reauth-gate.test.ts`, `test/fan-reauth-fixtures.ts:71–72` | (가) 공개키 읽기가 끝나지 않는 경우(멈춤)가 없다. 가짜 `fetch`는 던짐·500만 있어 읽기 상한(5,000ms)을 크게 잘못 둔 결함을 못 잡는다(지시서 §7 '시간 한도 상수는 경계 직전과 경계'). (나) 같은 토큰으로 다른 표 두 요청을 동시에(`Promise.all`) 보내는 경우가 없다(지금은 차례대로뿐). (다) ②에 `alg` HS256·none 토큰이 없다(플랫폼 시험이 덮지만 이 묶음 HTTP 경계에서는 안 본다) | 지시서 §7, identity.md §3 '발급자와 검증 규칙'(ES256만) | (가) `AbortSignal`을 따르는 멈추는 가짜 `fetch`와 가짜 시계로 상한 − 1ms·상한을 본다(단언 값은 정본에 상한을 적은 뒤 그 값으로) (나) 동시 두 요청 → 202 하나·403 하나, ticket `cancel` 1번 (다) ② 목록에 두 줄 |

- 지시서 '자주 놓친 결함' 대조: 저장소 응답 정확한 값(`SET` 인자 전부)·경계 양쪽(`exp` −1ms·`exp`)·계정 대조 뺀 요청(`sub`·`sid`)·목록 밖 값(`BOOKER_EXPORT`·`OPS_COMMAND`·`PAYOUT_ACCOUNT`·없음)·세 상태 가운데('이미 있음' 403)·부르는 쪽이 결과를 씀(호출 0·`writes.create` 0)·시험 값 ≠ 상수(180초, `https://identity.test`)·시작 파일 따로(start.ts 글 읽기)·장애 주입이 실제로 끼어듦(`jwks.urls.length ≥ 1`)은 모두 걸린다. 빠진 것은 RV-09(시간 한도, 경쟁)다.

## 검증

(검증 담당이 채운다)

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | l3-b415r-plan | claude-opus-5-5 | 2026-11-18T20:50+09:00 | 2026-11-18T21:08+09:00 |
| impl | l3-b415r-impl | claude-opus-5-5 | 2026-11-18T21:07+09:00 | 2026-11-18T21:17+09:00 |
| test | l3-b415r-test | claude-opus-5-5 | 2026-11-18T21:19+09:00 | 2026-11-18T21:36+09:00 |
| review | l3-b415r-review | claude-opus-5-5 | 2026-11-18T21:37+09:00 | 2026-11-18T21:49+09:00 |

- 다른 담당은 자기 커밋에서 이 표에 자기 행을 더한다. 리뷰 반영 커밋은 `Fix-By`의 역할(시험·구현) 행으로 센다.
