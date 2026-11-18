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

### 리뷰 반영 재현

- 담당: 시험 `l3-b415r-test`(구현을 맡지 않음), 2026-11-18. '리뷰 반영 계획' §2의 T1~T11을 썼다. 트리는 고치기 전 머리 `44f0d12a`(리뷰 반영 계획 커밋. `src`는 `f0aab468`과 같다)에 시험 파일 넷만 바꾼 그대로다. 따로 꺼낸 폴더는 쓰지 않았다. 단언 값(5분 30초 = 330,000ms, 읽기 상한 1,000ms, 까닭 이름표, `Retry-After` `5`)은 transfer-refund §3.1 '공개키 묶음 읽기'·'한 번 쓰기'·'답'·'거절 기록'·'시작 조립'과 data.md §3 `reauth:jti:{jti}`에서 가져왔다.
- 명령: `cd /d/ticketpass-lane3/services/purchase-svc && npx vitest run test/cancel-reauth-http.test.ts test/jwks-fan-reauth-gate.test.ts test/fan-reauth-wiring.test.ts` → 39개 가운데 **실패 13·통과 26**. 전체 `npx vitest run`은 132 파일·4,173개 가운데 실패 13(같은 13)·통과 4,160. `npx tsc -p tsconfig.json --noEmit`은 오류 2(아래 '새 이름'). `python -I -X utf8 tools/doc-check/check_all.py` 오류 0·경고 4(출발점과 같음).
- 시험 도구(`test/fan-reauth-fixtures.ts`)에 더한 것: 가짜 `fetch`의 `hang` 모드(받은 `AbortSignal`이 끊을 때까지 답하지 않음), `unsignedReauth`(alg none), `hs256Reauth`(공개키 좌표를 비밀로 쓴 HS256).

| # | 시험(파일) | 지금 트리 | 까닭 |
| --- | --- | --- | --- |
| T1 | `R-T39 ② 남은 수명이 5분 30초를 넘는 토큰은 거절하고 jti를 잡지 않는다`(어댑터. 앞 '정확한 수명' 시험의 600초 줄을 옮겨 뒤집음) | 실패(재현) | 남은 330,000ms의 `PX`가 `'300000'`(공용 상한 5분)이라 첫 단언에서 멈춤 |
| T1 | `R-T39 ② 남은 수명이 5분 30초를 넘는 토큰(600초)은 403이고 jti를 잡지 않는다`(HTTP) | 실패(재현) | 202를 받음 |
| T2 | `R-T39 ⑤ 공개키 묶음 안의 키가 깨지면 503 reauth-unavailable이다`(HTTP) | 실패(재현) | 500을 받음 |
| T2 | `R-T39 ⑤ 공개키 묶음 안의 키가 깨지면(같은 kid 키 둘, ERR_JWKS_MULTIPLE_MATCHING_KEYS) 어댑터는 ReauthUnavailable을 던진다`(어댑터) | 실패(재현) | jose `JWKSMultipleMatchingKeys`를 그대로 던짐 |
| T3 | `R-T39 ② 모르는 crit 머리의 토큰은 403이다`(HTTP) | 실패(재현) | 500을 받음(jose `ERR_JOSE_NOT_SUPPORTED`를 그대로 던짐) |
| T4 | `R-T39 ⑦ 확인기가 뜻밖의 오류를 내면 500이고 Retry-After가 없으며 아무것도 부르지 않는다`(HTTP 확인기 대역) | 처음부터 통과(검증이 틀린 구현으로 실패를 본다: V7 '모든 오류를 503') | 컨트롤러가 `ReauthUnavailable`만 503으로 바꾼다 |
| T5 | `R-T39 ② 거절마다 까닭 이름표 하나를 로그에 남기고 토큰·계정 ID는 싣지 않는다`(HTTP, 21가지 + 다시 씀 `replay`) | 실패(새 이름) | `onResult`가 없어 기록 0줄(첫 줄 '머리 없음'에서 멈춤) |
| T5 | `R-T39 ⑤ 확인하지 못함은 까닭 store 하나를 남긴다(jti 저장소 오류)`(HTTP) | 실패(새 이름) | 기록 0줄 |
| T5 | `R-T39 ⑤ 팬 공개키 묶음을 받지 못하면 503 …, 살아나면 새 토큰으로 202다`(HTTP, 앞 시험에 까닭 `keys` 단언 한 줄을 더함) | 실패(새 이름) | 503·호출 0은 통과, 까닭 `keys` 기록 0줄 |
| T6 | `R-T39 ⑥ 주소는 있고 PEAKET_IDENTITY_ISSUER가 없으면 운영에서 시작하지 않는다`(조립) | 실패(재현) | prod에서 던지지 않음 |
| T6 | `R-T39 ⑥ local·ci에서 PEAKET_IDENTITY_ISSUER가 없으면 발급자 https://identity.peaket.example만 받고, 있으면 그 값만 받는다`(조립, 앞 발급자 기본값 시험을 prod → local·ci, 없음·빈 값으로 바꿈) | 처음부터 통과(대조 쪽. 검증이 I5 '운영에서 기본값'으로 위 줄의 실패를 본다) | 지금도 local·ci는 기본값 |
| T6 | `R-T39 ② fanReauthGateFromEnv는 거절 기록을 받는 곳(onResult)을 확인기에 넘긴다`(조립) | 실패(새 이름) | 기록 0줄 |
| T6 | `R-T39 ② start.ts는 확인기 조립에 거절 기록을 받는 곳(onResult)을 넘긴다`(start.ts 글) | 실패(새 이름) | 예매 취소 조립의 `fanReauthGateFromEnv(` 인자에 `onResult`가 없음 |
| T7 | `R-T39 ⑤ 처음 공개키 읽기가 답하지 않으면 1,000ms 안팎에 ReauthUnavailable이다`(어댑터) | 실패(재현) | 5,014ms(상한 5,000ms) |
| T7 | `R-T39 ⑤ 처음 공개키 읽기가 답하지 않으면 1,000ms 안팎에 503이다`(HTTP) | 실패(재현) | 5,085ms |
| T8 | `R-T39 ③ 같은 토큰으로 다른 표 둘을 동시에 보내면 하나만 지난다`(HTTP, `Promise.all`) | 처음부터 통과(검증이 `jti` 잡기 빼기로 실패를 본다) | `SET NX` 두 번, 하나가 `null` |
| T9 | `R-T39 ② alg none·HS256 토큰은 403이다`(HTTP), `R-T39 ② 어댑터는 alg none·HS256 토큰을 거절하고 jti를 잡지 않으며, none은 공개키 묶음도 읽지 않는다`(어댑터) | 처음부터 통과(검증이 플랫폼 `alg` 검사 빼기로 실패를 본다) | 플랫폼 확인기가 머리에서 `alg` 거절 |
| T10 | 어댑터 이름: '정확한 수명' → `R-T39 ③ …(한 번 쓰기)`, 'act·sid·sub' → `R-T39 ② …`, '빈 값' → `R-T39 ② …`. 공개키 못 받음·저장소 세 상태는 ⑤ 그대로 | 이름만(통과) | — |
| T11 | `R-T39 ② 어댑터는 토큰이 없거나 빈 값이면 false이고 공개키도 jti도 건드리지 않는다`에 `jwks.urls` 0번 | 처음부터 통과(검증 F3 류로 실패를 본다) | 지금도 먼저 거절 |
| T12 | `R-T39 ⑤ 좌표가 곡선 밖인 키를 담은 공개키 묶음이면 503 reauth-unavailable이다`(HTTP, 대조 `crv` 없음 → 403·까닭 `kid`), `R-T39 ⑤ 좌표가 곡선 밖인 키를 담은 공개키 묶음이면 어댑터는 ReauthUnavailable을 던진다`(어댑터, 같은 대조 → false). 트리 `3e97790e`, `npx vitest run test/cancel-reauth-http.test.ts test/jwks-fan-reauth-gate.test.ts -t "곡선 밖"` → 2개 모두 실패 | 실패(재현) 2 | HTTP는 500, 어댑터는 `DOMException`(DataError)을 그대로 던짐. 단언 실패라 대조 줄까지는 가지 않았다. 전체는 4,175개 가운데 실패 15(앞 13 + 이 2)·통과 4,160, `tsc` 오류 2 그대로 |
| RN-03·L7 | `R-T39 ② fanReauthResultLogger는 403을 info 한 줄, 503을 warn 한 줄로 남기고 까닭 이름표 말고는 싣지 않는다`(조립, 이름표 13 + 2마다 가짜 로거. 결과에 토큰·jti·계정·세션 ID를 얹어 넘겨도 줄에 없고, 칸은 `reason`과 사건 이름 `event`뿐), `R-T39 ② 실제 확인기의 거절과 확인 못 함이 fanReauthResultLogger를 거쳐 info·warn 한 줄씩 남는다`(조립, 다른 계정 → `info` `sub`, 저장소 오류 → `warn` `store`). 트리 `99461bf1`(고친 곳 검증 뒤, 고치기 전) | 실패(새 이름) 2 | `TypeError: fanReauthResultLogger is not a function`(`refund-wiring.ts`에 그 내보내기가 없어 돌지 못함. `tsc`도 TS2305 1). 감독이 정한 모양 `fanReauthResultLogger(log: { info(o: object): void; warn(o: object): void }): (r: FanReauthResult) => void`대로 부른다 |
| RN-03·L7 | `R-T39 ② start.ts는 확인기 조립의 onResult로 fanReauthResultLogger를 넘긴다`(start.ts 글. 앞 'onResult를 넘긴다' 시험을 좁힘) | 실패(재현) 1 | 인자에 `onResult: fanReauthResultLogger(`가 없고 몸체를 start.ts에 직접 둠 |
| E7 | `R-T39 ⑦ 어댑터는 뜻밖의 오류(시계가 TypeError)를 ReauthUnavailable로 덮지 않고 그대로 던진다`(어댑터: 같은 오류 객체, `onResult` 0번, `command` 0번), `R-T39 ⑦ 실제 확인기가 뜻밖의 오류를 내면 500이고 Retry-After가 없으며 아무것도 부르지 않는다`(HTTP, 실제 어댑터에 깨진 시계) | 처음부터 통과 2(검증이 E7 '뜻밖 오류를 503으로 덮기'로 실패를 본다) | 지금 어댑터는 목록 밖 오류를 그대로 던진다 |
| R4 | `R-T39 ⑤ 남은 수명이 상한보다 길면 PX를 정본 값 330000으로 자르고, 짧으면 남은 수명 그대로다`(새 `packages/platform/test/reauth-jti.test.ts`: 400초·330,001ms·330,000ms → `'330000'`, 329,999ms → `'329999'`, 100초 → `'100000'`), `R-T39 ⑤ 이미 있으면(NX가 null) false다` | 처음부터 통과 2(검증이 R4 '공용 상한 6분'·R3 '5분'으로 실패를 본다) | 지금 공용 상한이 정본대로 5분 30초 |
| 위 묶음 실행 | purchase-svc `npx vitest run` 4,179개 가운데 실패 3(위 RN-03 셋)·통과 4,176, `tsc --noEmit` 오류 1(TS2305 `fanReauthResultLogger`). `packages/platform` `npx vitest run` 49 파일·581개 통과, `tsc --noEmit` 오류 0 | — | — |

- 셈: 단언 실패 13 = **재현 8**(T1 둘, T2 둘, T3, T6 운영, T7 둘) + **새 이름이 없어 생긴 실패 5**(T5 셋, T6 `onResult` 둘. 돌기는 하고 기록이 0줄이라 단언에서 실패한다. RV-06의 결함 그 자체이기도 하다). 실행조차 안 되는 실패는 0이다(vitest는 타입을 보지 않는다). 대신 `tsc --noEmit`이 오류 2다: `cancel-reauth-http.test.ts`·`fan-reauth-wiring.test.ts`의 `onResult`가 아직 없는 속성(TS2353). 구현 뒤 사라져야 한다. 처음부터 통과 6(T4, T6 local·ci 대조, T8, T9 둘, T11).
- 구현 담당이 맞출 모양(시험이 이 모양을 단언한다):
  - `JwksFanReauthGate` 생성자 선택 인자 `onResult`, `fanReauthGateFromEnv`의 선택 인자 `onResult`(받아서 그대로 넘긴다), start.ts는 예매 취소 조립의 `fanReauthGateFromEnv({ … })` 인자에 `onResult`를 넣는다(`onResult:` 또는 줄인 `onResult,`).
  - 기록은 403·503마다 **정확히 한 번**, 값은 `{ outcome: 'rejected', reason }` 또는 `{ outcome: 'unavailable', reason: 'keys' | 'store' }`이고 다른 칸이 없다(`toEqual`). 통과(202)의 기록은 보지 않는다.
  - 까닭: 없음·빈 값 `missing`, 형식 깨짐 `format`, 만료 `expired`, 다른 세션·act 반대·목록 밖 act·act 없음·jti 없음 `claims`, 다른 계정 `sub`, 팬 묶음에 없는 kid `kid`, 같은 kid의 다른 키 `signature`, `typ` at+jwt `typ`, `aud` partner `aud`, `iss` 다름 `iss`, alg none·HS256 `alg`, 모르는 `crit` **`claims`**, 남은 수명 600초 `lifetime`, 다시 씀 `replay`. 확인 못 함: `jti` 저장소 오류 `store`, 공개키 못 받음·같은 kid 키 둘 `keys`.
  - 남은 수명: `expiresAt − 지금 > 330_000`이면 거절(jti 안 잡음), 330,000이면 통과이고 `PX` `'330000'`(I2 공용 상한도 함께 바꿔야 통과한다).
  - 발급자: 주소가 있고 `PEAKET_IDENTITY_ISSUER`가 없거나 빈 값이면 prod·production·staging·demo·`PEAKET_ENV` 없음에서 던지고 글에 `PEAKET_IDENTITY_ISSUER`를 넣는다. 주소와 발급자가 둘 다 없으면 기존 시험대로 글에 `PEAKET_IDENTITY_FAN_JWKS_URL`이 있어야 한다(주소 검사가 먼저이거나 두 이름을 다 넣는다).
  - 읽기 상한: 답하지 않는 첫 읽기가 실제 시간 900ms 이상·2,500ms 미만에 `ReauthUnavailable`(HTTP 503)이고 `fetch` 1번.
- 계획과 정본이 어긋나는 곳(정본을 따랐다): 계획 §3 I3은 `ERR_JOSE_NOT_SUPPORTED`의 까닭을 `format`이라 했으나, 정본 §3.1 '거절 기록'은 `claims`에 넣는다(`claims`(`sid`·`act` 어긋남과 `ERR_JOSE_NOT_SUPPORTED` 포함)). 시험은 `claims`를 단언한다.
- 계획 담당에게 넘길 정본 빈칸(시험은 쓰지 않음): 계획 T2가 예로 든 깨진 키 둘은 jose 6.2.14에서 정본의 503 코드 목록에 들지 않는다. 곡선 밖 좌표·`y` 없음·숫자 `x`는 `ERR_JWK_INVALID`가 아니라 `DOMException`(이름 DataError, 'Invalid keyData', `code` 0)이고, `crv` 없음은 `ERR_JWKS_NO_MATCHING_KEY`(지금 403 `kid`)다. 확인 때 실제로 닿는 목록의 코드는 `ERR_JWKS_MULTIPLE_MATCHING_KEYS`(같은 kid 키 둘)뿐이라 T2를 그것으로 썼다. `ERR_JWKS_INVALID`(묶음에 비밀 키 `d`가 든 경우 등)는 `createLocalJWKSet`이 읽기 단계에서 내므로 처음이면 이미 `TokenKeysUnavailable`(503)이다. 곡선 밖 좌표의 키는 I3대로 고치면 500으로 남아 R-T39 ⑤ '공개키 묶음 안의 키가 깨졌을 때 503'과 어긋난다. 정본 '답'의 목록에 그 DOMException을 더할지 정해야 한다.

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

### 다시 보기

- 담당: 리뷰 `l3-b415r-review`(claude-opus-5-5), 2026-11-18. 본 것: `git diff a9b0abbb..b90b9527`(반영 계획 `44f0d12a`·`3e97790e`, 재현 시험 `ee9ed4f3`·`16f2bc7b`, 구현 `b90b9527`)와 '리뷰 반영 계획' 절. 고친 곳만 봤다. 구현 커밋은 시험 파일을, 시험 커밋 둘은 `src`를 건드리지 않았다. 구현 커밋의 `deploy/gateways/*.routes.yaml` 다섯은 계약 해시 머리줄만 바뀌었고 `node tools/ci/gateway-routes.mjs --check`가 '같다'다(첫 바퀴 openapi 고침의 생성물을 맞춘 것). 바뀐 트리에서 새 시험 세 파일 41/41 통과를 다시 돌려 봤다.
- jose 오류 경계 확인(일회용 스크립트, 같은 jose 6.2.14): 맞는 `kid`에 서명을 자르거나 비우거나 두 배로 늘린 토큰은 `ERR_JWS_SIGNATURE_VERIFICATION_FAILED`, 서명 글자가 깨진 토큰은 `ERR_JWS_INVALID`였다. 토큰 쪽 값으로는 `DataError`나 키 묶음 오류 코드가 나지 않아, 공격자가 503(`keys`)과 경고 줄을 만들어 내는 길은 찾지 못했다. `ERR_JWKS_MULTIPLE_MATCHING_KEYS`는 `kid`가 겹친 묶음(identity 설정)에서만 난다.

| 지적 | 판정 | 근거 |
| --- | --- | --- |
| RV-01 | 남음(문구) | 이 묶음에서 막지 않는 것은 계획대로다. 정본 transfer-refund §3.1 '남는 한계'(128줄)와 data.md §3에 서비스 안에서만이라는 것을 적었다. 다만 그 문구가 '소유자 결정을 기다린다(OPEN 문안은 계획 …)'인 채다. OPEN[50]이 (나)로 정해졌으므로 RN-01로 고친다 |
| RV-02 | 닫힘 | 어댑터가 `sub` 대조 뒤·`jti` 잡기 전에 `expiresAt − 지금 > 330,000ms`이면 403(까닭 `lifetime`)이고 `jti`를 잡지 않는다. 공용 상한도 330,000ms라, 받은 토큰의 기록 수명은 늘 토큰의 남은 시간 그대로다. 경계 330,000 통과·330,001 거절과 `PX '330000'`을 시험이 본다. 두 상수가 따로인 점은 RN-02 |
| RV-03 | 남음(정리 목록 이관) | 반영 계획 §1대로 `docs/lanes/lane3-cleanup.md`에 기록 커밋에서 넣는다. 코드는 그대로다(`jwks-fan-reauth-gate.ts` `path: u.pathname`) |
| RV-04 | 일부 닫힘 | 읽기 상한이 1,000ms가 됐다(정본 §3.1 '공개키 묶음 읽기'). 미리 읽기·오래된 캐시로 답하기는 정리 목록 이관이다 |
| RV-05 | 닫힘 | 키 묶음 오류 코드 셋과 `DataError`는 503(`keys`), `ERR_JOSE_NOT_SUPPORTED`는 403(`claims`), 그 밖은 500이고 `Retry-After`가 없다(R-T39 ⑦). 위 확인대로 토큰 쪽 값이 503으로 새는 길은 없다. 참고로 `crv`가 빠진 키는 정본대로 403(`kid`)이라, identity 키 설정이 틀린 것이 `warn`이 아니라 `info`의 `kid`로만 보인다(정본 결정이라 지적하지 않는다) |
| RV-06 | 닫힘(시험 한 군데 남음) | 넘기는 기록은 정해진 이름표 `reason` 하나와 `outcome`뿐이고, 형에 토큰·`jti`·계정 ID·세션 ID가 없다. start.ts가 403은 `info`, 503은 `warn`으로 `{ event, reason }`만 싣는다. 발급자가 없으면 local·ci 밖에서 시작하지 않는다(`PEAKET_ENV` 없음 포함). start.ts의 로그 잇기를 글 대조로만 보는 것은 RN-03 |
| RV-07 | 닫힘 | 정본 '남는 한계'에 '503 뒤에도 새 재인증'을 적었다 |
| RV-08 | 닫힘(다음 단계 몫) | GAT-090 단계 줄에 'BAT-415-reauth가 넘긴 것'으로 넷(`X-Reauth-Token`, 계좌면 `high-risk`, 두 재인증 시트의 흐름, frontend.md 오류 표 503)을 적었다 |
| RV-09 | 닫힘 | (가) 멈추는 읽기가 900ms 이상 2,500ms 미만에 503 (나) 동시 두 요청이 202 하나·403 하나이고 ticket 호출 1 (다) `alg` none·HS256과 모르는 `crit`가 403 |

- 새 지적(높음 0, 중간 0, 낮음 3):

| # | 심각도 | 자리 | 지적 | 근거(정본) | 고칠 방향 |
| --- | --- | --- | --- | --- | --- |
| RN-01 | 낮음 | `docs/features/transfer-refund.md:128`('남는 한계' 끝 문장) | RV-01 문구가 '방향을 바꾸는 결정이므로 소유자 결정을 기다린다(OPEN 문안은 계획 …)'인 채다. OPEN[50]이 (나)(identity가 받는 쪽 작업을 토큰에 싣고 받는 서비스는 자기 작업의 토큰만 받음)로 정해졌으므로, 정본이 낡은 상태를 말한다 | 소유자 결정 OPEN[50], 반영 계획 §4 | 기록 커밋에서 'OPEN[50]에서 (나)로 정했다(2026-11-18). GAT-045가 막고, 그때까지 이 한계를 받아들인다'로 바꾼다. GAT-045 단계 줄이 생기면 그 줄에 이 몫(purchase 팬 취소가 자기 작업의 토큰만 받음, R-T39에 줄 하나)을 적는다 |
| RN-02 | 낮음 | `jwks-fan-reauth-gate.ts:13`, `packages/platform/src/reauth-jti.ts:9` | 받는 수명 상한(`MAX_REMAINING_LIFETIME_MS`)과 공용 기록 상한(`REAUTH_JTI_TTL_MS`)이 같은 330,000을 따로 적는다. 지금은 시험(330,000ms → `PX '330000'`)이 둘이 어긋나는 것을 잡는다. 하지만 RV-02의 틈은 '받는 상한 > 기록 상한'일 때 다시 생기므로 한 값에서 나오는 편이 낫다. 또 core·ops·payment의 받는 쪽은 수명 거절이 없어, 330,000ms보다 긴 토큰이 오면 RV-02와 같은 틈이 그대로다 | transfer-refund §3.1 '한 번 쓰기', data.md §3 | 어댑터가 `@peaket/platform`의 `REAUTH_JTI_TTL_MS`를 가져다 쓴다(또는 받는 상한을 플랫폼 확인기 쪽으로 옮긴다). 세 서비스의 수명 거절은 계획 §4 재쓰기 후보와 함께 정리 목록에 넣는다 |
| RN-03 | 낮음 | `services/purchase-svc/src/start.ts:335–338`, `test/fan-reauth-wiring.test.ts:157–165` | R-T39 ②의 판정은 '로그에 까닭 이름표 하나가 남고 토큰·계정 ID가 없다'이다. 시험은 `onResult`로 넘긴 값을 모아 볼 뿐이고, start.ts가 그것을 로그로 잇는지는 글 대조(`onResult` 글자가 있는지)로만 본다. `onResult: () => {}`나 403·503의 로그 단계를 바꾼 틀린 구현도 통과한다(지시서 §7 '부르는 쪽이 결과를 실제로 쓰는지') | transfer-refund §3.1 '거절 기록', §11 R-T39 ② | 로그로 잇는 함수를 `refund-wiring.ts`에 이름 붙여 꺼내고(예 `fanReauthResultLog(logger)`), 가짜 로거로 403 → `info` `{ event: 'fan_reauth_rejected', reason }`, 503 → `warn` `{ event: 'fan_reauth_unavailable', reason }`, 다른 필드 없음을 단언한다. start.ts 글 시험은 그 함수를 넘기는지만 본다 |

## 검증

- 담당: 검증 `l3-b415r-verify`(claude-opus-5-5), 2026-11-18. 계획·시험·구현·리뷰에 관여하지 않았다(ADR-0270 '검증'). 리뷰 `a9b0abbb`와 같은 때 따로 했고 리뷰 지적은 보고 나서 겹침만 적었다.
- 방법: 틀린 구현(일부러 넣은 결함)은 따로 꺼낸 폴더 `D:/ticketpass-lane3-verify`(`a01638e3`, 메인 폴더에서 `worktree add --detach`)에만 넣었다. 하나 넣고 → purchase-svc 단위 시험 일곱 파일(`cancel-reauth-http`·`jwks-fan-reauth-gate`·`fan-reauth-wiring`·`refund-http`·`refund-wiring`·`start-fraud-grpc`·`cancel-ticket`, 시험 76개)을 돌리고 → `git checkout -- .`으로 되돌렸다. 살아남은 것은 purchase-svc 단위 시험 전체(132 파일·4,157개)로 한 번 더 돌렸다. 변이 없이 돌린 기준 실행은 일곱 파일 76/76, 전체 4,157/4,157 통과다. '잡힘'은 기준에 없던 단언 실패가 하나라도 생긴 것이다. Docker를 쓰는 `test-int/cancel-reauth.int.test.ts`(③)는 돌리지 않았다(CI 몫). 공용 패키지(`packages/platform`)는 vitest가 원본으로 이어 그쪽 겹친 가드도 같은 방법으로 넣었다.
- **셈: 넣은 33, 잡힌 30, 살아남은 3**(그 가운데 1은 동치, 즉 행동이 바뀌지 않는 변이). 상한 30을 3 넘겼다. 30개를 다 돈 뒤에도 '실패 확인'의 못 본 시험 20개 가운데 셋(⑥ local·ci 경고, ⑥ 주소가 있으면 환경과 무관, ⑤ 어댑터 빈 토큰)이 한 번도 실패하지 않아 그 셋을 보려고 F1~F3을 더했다.

### 1. 넣은 결함

자리: G = `adapters/jwks-fan-reauth-gate.ts`, C = `inbound/ticket-cancellation.controller.ts`, W = `refund-wiring.ts`, S = `start.ts`, P = platform `token-verify.ts`, J = platform `reauth-jti.ts`. 잡은 시험은 이름 앞머리만 적는다(HTTP = `cancel-reauth-http`, 어댑터 = `jwks-fan-reauth-gate`, 조립 = `fan-reauth-wiring`).

| # | 자리 | 내용 | R-T39 | 잡은 시험 |
| --- | --- | --- | --- | --- |
| M1 | G | 확인기에 요청의 `act` 대신 토큰의 `act`를 넘긴다 | ②④ | HTTP ②(계좌 없는 본문에 FAN_HIGH_RISK)·④, 어댑터 act·sid·sub |
| M2 | C | 계좌가 있어도 `FAN_SENSITIVE`를 묻는다 | ④ | HTTP ④ 둘(실제 확인기, 컨트롤러가 묻는 질의) |
| M3 | G | `sub` = 요청 계정 대조를 뺀다 | ② | HTTP ② 다른 계정, 어댑터 sub 다름 |
| M4 | G | `sessionId`로 요청 세션 대신 토큰의 `sid`를 넘긴다 | ② | HTTP ② 다른 세션, 어댑터 sid 다름 |
| M5 | G | `jti` 잡기를 뺀다(늘 통과) | ①③ | HTTP ①·② 경계·③ 셋·④·⑤ 둘, 어댑터 수명·세 상태 |
| M6 | C | 재인증을 Saga 뒤로 옮긴다 | ②③ | HTTP ③ 다른 표(ticket `cancel` 2번), ② 머리 없음·④·⑤ 넷(호출 1번) |
| M7a | G | `jti`를 `sub` 대조 앞에서 잡는다 | ② | HTTP ② 다른 계정 `SET` 0, 어댑터 sub 다름 |
| M7b | G | `jti`를 서명·클레임 확인 앞에서(풀어 읽은 값으로) 잡는다 | ②⑤ | HTTP ② 만료·④·⑤ 둘, 어댑터 넷 |
| M8 | G | `jti` 수명을 늘 5분으로 둔다(토큰 만료 무시) | ① | HTTP ①(`PX 180000`)·② 경계(`1000`)·③·④, 어댑터 수명 |
| M9 | G | `TokenKeysUnavailable`을 거절(403)로 바꾼다 | ⑤ | HTTP ⑤ 공개키 못 받음, 어댑터 공개키 못 받음 |
| M10 | G | `jti` 저장소 오류를 통과로 본다 | ⑤ | HTTP ⑤ 저장소 오류, 어댑터 세 상태 |
| M11 | G | `jti` 저장소 오류를 거절(403)로 둔다 | ⑤ | HTTP ⑤ 저장소 오류, 어댑터 세 상태 |
| M12 | 모듈 미들웨어 + C | 재인증을 구매 요청 서명(인증 가드) 앞, Nest 미들웨어로 옮긴다 | ③ | HTTP ③ 401 뒤·400 뒤(`SET` 0이 아님), ④·⑤ |
| M13 | W | 운영에서 주소가 없어도 던지지 않고 닫힌 대역으로 뜬다 | ⑥ | 조립 '운영에서 시작하지 않는다'(prod부터) |
| M14a | S | `MemoryReauthJtiStore`를 넘긴다 | ⑥ | 조립 start.ts 글 |
| M14b | S | `reauthJtiStoreFromEnv(env)`(Redis 없이)를 넘긴다 | ⑥ | 조립 start.ts 글 |
| V1 | C | 계좌가 없어도 `FAN_HIGH_RISK`를 묻는다 | ①④ | HTTP ①·② 경계·③ 넷·⑤ 등 11개 |
| V2 | G | 확인기에 늘 `FAN_SENSITIVE`를 넘긴다(질의의 `act` 무시) | ④ | HTTP ④, 어댑터 act 반대 |
| V3 | G | 토큰 없음·빈 값의 먼저 거절을 뺀다(플랫폼 확인기와 겹친 가드) | ② | **살아남음(동치)**, 전체 4,157 통과 |
| V4 | P | 만료 판정에 1초 여유를 준다(만료 경계) | ② | HTTP ② 만료(exp = 지금), 어댑터 `exp` 경계 |
| V5 | C | 503에 `Retry-After`를 싣지 않는다 | ⑤ | HTTP ⑤ 셋 |
| V6 | C | `ReauthUnavailable`을 403 `reauth-required`로 바꾼다 | ⑤ | HTTP ⑤ 셋 |
| V7 | C | 확인기의 모든 오류(그 밖의 오류 포함)를 503으로 바꾼다 | ⑤ | **살아남음**, 전체 4,157 통과 |
| V8 | G | 공개키 묶음 읽기 시간 상한 5,000ms를 120,000ms로 늘린다(장애 주입: 시간 초과) | ⑤ | **살아남음**. 전체에서 gRPC 시간 시험 10개가 실패했으나 변이 없는 트리에서도 같은 파일(`payment-confirm`)이 흔들려 이 변이와 무관하다(일곱 파일 + 그 파일들 다시 돌림) |
| V9 | W | demo도 닫힌 대역으로 띄운다 | ⑥ | 조립 '운영에서 시작하지 않는다'(demo) |
| V10 | W | 발급자 기본값을 다른 값으로 둔다 | ⑥ | 조립 발급자 기본값 |
| V11 | S | 만든 확인기를 `refund.reauth`에 넣지 않는다 | ⑥ | 조립 start.ts 글 |
| V12 | J | `jti` 수명의 5분 상한을 뺀다 | ③ | 어댑터 수명(600초 → `300000`) |
| V13 | P | 공용 확인기의 `sid` 대조를 뺀다(M4와 겹친 가드의 다른 쪽) | ② | HTTP ② 다른 세션, 어댑터 sid 다름 |
| V14 | P | 공용 확인기의 `act` 대조를 뺀다(M1과 겹친 가드의 다른 쪽) | ②④ | HTTP ②·④, 어댑터 act 반대 |
| F1 | W | local·ci에서 주소가 없을 때 경고를 남기지 않는다 | ⑥ | 조립 local·ci 경고 1번 |
| F2 | W | local·ci면 주소가 있어도 닫힌 대역을 준다(환경을 먼저 본다) | ⑥ | 조립 local·ci 경고, 조립 '주소가 있으면 환경과 무관' |
| F3 | G | 토큰 없음·빈 값을 확인 못 함(503)으로 던진다 | ② | HTTP ② 머리 없음, 어댑터 빈 토큰 |

- 겹친 가드: `sid`·`act`는 플랫폼 확인기만, `sub`는 어댑터만 지킨다. 받는 쪽에서 값을 바꿔 넘기는 결함(M1·M4)과 확인기 쪽에서 빼는 결함(V13·V14)을 따로 넣어 모두 잡혔다. `jti` 5분 상한은 저장소(J), 수명 계산은 어댑터(G)가 맡아 각각(V12·M8) 잡혔다. 빈 토큰은 어댑터와 확인기가 겹쳐 지켜 한쪽만 빼면 행동이 같다(V3 동치). 구매 서명 → 재인증 차례(M12)도 잡혔다.
- '실패 확인'의 못 본 시험 20개: 위 결함으로 20개 모두 단언 실패를 한 번 이상 봤다(새 시험 23개 전부). 가장 적게 잡힌 것은 HTTP ③ '같은 멱등 키를 새 토큰으로 다시 보냄'(V1만)과 조립 발급자 기본값(V10만)이다.

### 2. 복구 경로 장애 주입

| 끊는 자리 | 결과 |
| --- | --- |
| `jti` 저장소 오류(가짜 좌석 Redis가 던짐) | 시험이 있다(HTTP ⑤·어댑터 세 상태). M10·M11·V6이 잡혔다 |
| 공개키 묶음 읽기 실패(던짐·HTTP 500), 처음 못 받은 뒤 살아남 | 시험이 있다(HTTP ⑤·어댑터). M9·V5·V6이 잡혔다 |
| 공개키 묶음 읽기 시간 초과(응답 없음) | 시험이 없다. 일회용 시험(커밋하지 않음)으로 `AbortSignal`을 따르는 멈추는 가짜 `fetch`를 실제 구현에 꽂았더니 5,012ms 뒤 `ReauthUnavailable`(원인 `TimeoutError`)이고 `fetch` 1번·`SET` 0번이었다. 복구 경로는 맞다. 다만 상한을 잘못 둔 결함(V8)은 잡지 못한다 |

### 3. 살아남은 것(시험 담당에게 넘김)

| # | 권한·개인정보·통과 기준 | 잡을 시험 제안 |
| --- | --- | --- |
| V3 | 걸리지 않음(동치: 확인기가 머리 해석에서 같은 거절을 하고 공개키도 읽지 않는다) | 필요 없다 |
| V7 | 걸리지 않음. 닫힌 쪽이라 Saga는 0번이다. 정본은 '확인하지 못하면 503'만 정하고 그 밖 오류는 정하지 않아 R-T39 판정 밖이다(계획 B6·§3 '그 밖의 오류는 그대로 던진다'). 리뷰 RV-05(jose 키 오류는 503으로)를 반영하면 그 종류는 503이 맞으므로, 시험은 예상 못 한 오류 한 가지만 본다 | `cancel-reauth-http`의 확인기 대역 묶음에 '`verify`가 `TypeError`를 던지면 500이고 `Retry-After`가 없으며 Saga 0번' 한 줄 |
| V8 | 걸리지 않음(닫힌 쪽, 가용성). 정본에 상한 값이 없어 통과 기준 밖이다. HTTP 요청에서는 요청 마감이 상한을 다시 줄여 겉으로 가려질 수 있다. 리뷰 RV-09 (가)와 같은 지적 | 정본(identity §3 '공개키 배포' 또는 guidelines §8.1)에 읽기 상한을 먼저 적고, 어댑터 시험에 멈추는 가짜 `fetch`(`AbortSignal`을 따름)로 '상한 안에 `ReauthUnavailable`, `SET` 0번'을 단언한다. `AbortSignal.timeout`은 가짜 시계를 따르지 않으므로 실제 시간으로 재거나(위 실험처럼 상한 −100ms 이상·상한 +2초 미만) 상한을 주입할 수 있게 한다 |

### 4. 판정 기준 대조(R-T39 ①~⑥, 정본 transfer-refund §11)

| 항목 | 정본 판정 | 시험 단언 | 결과 |
| --- | --- | --- | --- |
| ① | 202이고 Saga가 한 번 돈다 | HTTP ①: 202, 본문, ticket·payment `cancel`·`writes.create` 각 1번, `SET` 정확히 한 번 | 맞음 |
| ② | 모두 403 `reauth-required`, ticket·payment 호출과 `order_cancellation` 쓰기 0 | HTTP ②: 17가지마다 403·`type`·ticket·payment·`writes.create` 0·`SET` 0 | 맞음. '관리 키로 서명'은 팬 묶음에 없는 `kid`의 새 키로 대신했다(관리 키 묶음 자체는 두지 않음). 어댑터가 팬 주소만 읽는 것은 조립·어댑터 시험의 `jwks.urls`가 보므로 판정은 덮인다 |
| ③ | 앞은 403·호출 0, 뒤(401 뒤 바른 요청)는 202 | HTTP ③ 넷 | 맞음 |
| ④ | `FAN_SENSITIVE`는 403, `FAN_HIGH_RISK`는 202 | HTTP ④ 둘 | 맞음 |
| ⑤ | 둘 다 503 `reauth-unavailable`과 `Retry-After`, 호출 0 | HTTP ⑤ 셋(저장소 오류, 공개키 못 받음, 확인기 대역): 503·`type`·`Retry-After` `5`·호출 0 | 맞음 |
| ⑥ | 시작하지 않는다 | 조립 함수가 던짐(5개 환경 × 없음·빈 값) + start.ts 글 읽기 | 맞음(간접). `start()`를 실제로 띄워 보지는 않는다. start.ts가 던짐을 삼키는 결함은 넣어 보지 않았다(상한) |

- 이름만 달린 시험(어긋남):
  - 어댑터 시험 다섯이 모두 `R-T39 ⑤`를 달았으나, 셋('정확한 수명으로 jti를 잡는다', 'act·sid·sub가 틀린 토큰을 거절', '빈 값이면 false')은 정본 ⑤(확인 못 함 → 503)가 아니라 ②(거절)와 §3.1 '한 번 쓰기'를 본다. 장부는 ID로 세므로 ⑤가 실제보다 두텁게 보인다. ⑤의 정본 판정은 HTTP 시험 셋이 따로 단언하므로 빠진 판정은 없다. 시험 담당이 ②·③으로 바꾸거나 '연결:'로 적는 것을 권한다.
  - 어댑터 '토큰이 없거나 빈 값이면 false이고 공개키도 jti도 건드리지 않는다'는 `jti`(`SET` 0)만 단언하고 공개키(`jwks.urls`)는 단언하지 않는다. `expect(jwks.urls).toHaveLength(0)` 한 줄이면 이름과 맞는다.
- 리뷰와 겹침: V8 = RV-09 (가). V7은 RV-05와 방향이 반대인 결함이라 둘을 함께 고칠 때 경계(어느 오류가 503인가)를 시험으로 고정해야 한다. RV-02(600초 토큰을 받는 것)는 V12가 '5분 상한 빼기'만 잡는다는 것과 맞물린다. RV-02대로 고치면 어댑터 수명 시험의 600초 줄 기대가 바뀐다.

### 고친 곳 검증

- 담당: 검증 `l3-b415r-verify`(claude-opus-5-5), 2026-11-18. 머리 `b90b9527`(반영 계획 `44f0d12a`·`3e97790e`, 재현 시험 `ee9ed4f3`·`16f2bc7b`, 구현 `b90b9527`)를 따로 꺼낸 폴더 `D:/ticketpass-lane3-verify`에서 봤다. 리뷰 다시 보기 `48e30fb3`과는 따로 했다.
- 방법은 앞과 같다. 하나 넣고 일곱 파일(시험 94개)을 돌린 뒤 되돌렸다. 살아남은 것은 purchase-svc 단위 시험 전체(132 파일·4,175개)로 다시 돌렸다. 변이 없는 기준은 94/94 통과다. 플랫폼 `reauth-jti.ts`를 직접 보는 플랫폼 단위 시험은 없어서(`packages/platform/test`에 `REAUTH_JTI_TTL_MS`·`RedisReauthJtiStore` 단언 없음) J 변이도 purchase 시험으로만 봤다.
- **셈: 넣은 26, 잡힌 21, 살아남은 5**(그 가운데 2는 닿는 입력이 없어 사실상 동치). 상한 25를 1 넘겼다. 25개를 돈 뒤 '처음부터 통과' 시험 가운데 HTTP `R-T39 ② alg none·HS256 토큰은 403이다`만 한 번도 실패하지 않아, 그것을 보려고 A2를 더했다.

#### 넣은 결함

자리 약자는 위 §1과 같다.

| # | 자리 | 내용 | 잡은 시험 |
| --- | --- | --- | --- |
| R1 | G | 남은 수명 비교 `>`를 `>=`로(경계 330,000ms를 거절) | 어댑터 ② 남은 수명(330,000ms가 거절됨) |
| R2 | G | 수명 상한 상수를 1초 늘린다(5분 31초) | 어댑터 ② 남은 수명(330,001ms가 통과) |
| R3 | J | 공용 `REAUTH_JTI_TTL_MS`를 5분으로 되돌린다 | 어댑터 ② 남은 수명(`PX` `300000`) |
| R4 | J | 공용 `REAUTH_JTI_TTL_MS`를 6분으로 늘린다 | **살아남음**(어댑터 상한 5분 30초가 먼저 걸러 가린다, 겹친 가드) |
| E1 | G | `ERR_JWKS_MULTIPLE_MATCHING_KEYS`를 503 목록에서 뺀다 | HTTP ⑤ 키 깨짐, 어댑터 ⑤ 같은 kid 키 둘 |
| E2 | G | `ERR_JWK_INVALID`를 503 목록에서 뺀다 | **살아남음**(닿는 입력 없음, 아래) |
| E3 | G | `ERR_JWKS_INVALID`를 503 목록에서 뺀다 | **살아남음**(닿는 입력 없음, 아래) |
| E4 | G | `DOMException` DataError를 503 목록에서 뺀다 | HTTP ⑤ 곡선 밖, 어댑터 ⑤ 곡선 밖 |
| E5 | G | `ERR_JOSE_NOT_SUPPORTED`를 503으로 던진다 | HTTP ② crit, HTTP ② 거절 기록 |
| E6 | G | `ERR_JOSE_NOT_SUPPORTED`의 까닭을 `format`으로 | HTTP ② 거절 기록(crit 줄) |
| E7 | G | 어댑터가 뜻밖 오류를 503(`keys`)으로 덮는다 | **살아남음** |
| E8 | C | 컨트롤러가 확인기의 모든 오류를 503으로(앞 V7) | HTTP ⑦ |
| L1 | G | 403의 `onResult`를 부르지 않는다 | HTTP ② 거절 기록, HTTP ⑤ 곡선 밖 대조, 조립 ② onResult |
| L2 | G | 403의 `onResult`를 두 번 부른다 | 같은 셋 |
| L3 | G | 다른 계정의 까닭을 `claims`로 바꾼다 | HTTP ② 거절 기록, 조립 ② onResult |
| L4 | G | 503의 `onResult`를 부르지 않는다 | HTTP ⑤ 넷(`store`·`keys`) |
| L5 | G | 다시 쓴 토큰의 기록에 `jti`를 싣는다 | HTTP ② 거절 기록(`toEqual`) |
| L6 | W | `onResult`를 확인기에 넘기지 않는다 | 조립 ② onResult |
| L7 | S | `onResult`는 넘기되 로그를 남기지 않는다(`info`·`warn` 둘 다 뺌) | **살아남음** |
| I1 | W | 발급자 없음을 demo에서도 기본값으로 받는다 | 조립 ⑥ 발급자 없음(demo) |
| I2 | W | 빈 값 발급자를 있는 것으로 본다 | 조립 ⑥ local·ci 발급자 기본값, 조립 ⑥ 발급자 없음(빈 값) |
| T1 | G | 공개키 묶음 읽기 상한 1,000ms를 5,000ms로 되돌린다 | HTTP ⑤·어댑터 ⑤ 답하지 않는 읽기(5,036ms·5,018ms) |
| C1 | G | `jti` 잡기 결과를 무시한다(이미 있어도 통과) | HTTP ③ 동시 둘(`[202, 202]`)·③ 다른 표·⑤ 가운데 상태·② 거절 기록, 어댑터 세 상태 |
| A1 | P | 머리의 `alg` ES256 검사를 뺀다(`jwtVerify`의 `algorithms`와 겹친 가드) | 어댑터 ② alg none(공개키 읽기 0번이 아님). 403은 그대로라 HTTP는 통과 |
| A2 | P | `alg` none 토큰을 서명 확인 없이 받는다 | HTTP ② alg none·HS256, HTTP ② 거절 기록, 어댑터 ② alg |
| W1 | G | 빈 토큰도 먼저 공개키 묶음을 읽어 둔 뒤 거절한다 | 어댑터 ② 빈 값(`jwks.urls` 0번) |

- '처음부터 통과' 시험이 실패하는 것을 한 번씩 봤다: T4 ⑦은 E8, T6 local·ci 발급자 기본값은 I2, T8 동시 두 요청은 C1, T9는 어댑터 쪽을 A1·A2, HTTP 쪽을 A2, T11 빈 토큰 공개키 0번은 W1로 봤다.
- 겹친 가드: 수명은 어댑터 상한(R1·R2)과 공용 저장소 상한(R3·R4)이 겹친다. 공용 상한을 낮추는 쪽(R3)만 잡히고, 높이는 쪽(R4)은 어댑터가 가린다. `alg`는 머리 검사와 `jwtVerify`의 `algorithms`가 겹쳐, 머리 검사만 빼면(A1) 거절은 그대로이고 공개키 읽기 0번만 깨진다.
- 닿는 입력 확인(E2·E3, 일회용 스크립트): jose 6.2.14에서 x 없음·숫자 x·base64 깨짐·`d` 있음은 모두 `DataError`, kty RSA·crv P-384·`use` enc·`key_ops` encrypt는 `ERR_JWKS_NO_MATCHING_KEY`(403 `kid`)였다. 확인 단계에서 `ERR_JWK_INVALID`를 내는 키는 찾지 못했다. `ERR_JWKS_INVALID`는 묶음을 들여오는 읽기 단계에서 나므로, 처음이면 `TokenKeysUnavailable`이 되고 받은 키가 있으면 그 키를 계속 쓴다. 시험 담당이 '리뷰 반영 재현'에 적은 것과 같다.

#### 살아남은 것(시험 담당에게 넘김)

| # | 권한·통과 기준 | 잡을 시험 제안 |
| --- | --- | --- |
| L7 | **통과 기준에 걸림**: R-T39 ② '거절마다 로그에 까닭 이름표 하나가 남고'. 시험은 `onResult` 대역의 값까지만 보고, start.ts가 그 값을 서비스 로그로 남기는지는 인자에 `onResult`가 있는지만 본다. 권한에는 걸리지 않는다(관측). | start.ts의 `onResult` 몸체를 `refund-wiring.ts`의 작은 함수(예: 로거를 받아 `info`·`warn`을 부르는 함수)로 빼고, 가짜 로거로 '403은 `info` 한 줄에 `{ event: 'fan_reauth_rejected', reason }`만, 503은 `warn` 한 줄에 `{ event: 'fan_reauth_unavailable', reason }`만'을 단언한다. start.ts 글 시험은 그 함수를 넘기는지 본다. 또는 `createService`의 `logDestination`으로 모은 로그 줄을 본다(계획 T5가 처음 적은 방법) |
| E7 | 권한에는 걸리지 않는다(닫힌 쪽, Saga 0). R-T39 ⑦은 컨트롤러 앞의 확인기 대역으로만 덮인다. 실제 어댑터가 뜻밖 오류를 그대로 던지는지(정본 §3.1 '답' '그 밖의 뜻밖 오류는 … 500')는 시험이 없다. ⑦ 판정을 실제 확인기로 읽으면 걸린다 | 어댑터 시험에 가짜 시계의 `now()`가 처음 확인 뒤 `TypeError`를 던지게 하고 `verify`가 `TypeError`로 실패한다(`ReauthUnavailable`이 아님), `onResult` 0번, `command` 0번을 단언 |
| R4 | 걸리지 않는다(purchase에서는 동치). 다른 받는 서비스(core·ops·payment)는 어댑터 상한이 없어 `PX`가 6분까지 늘지만 닫히는 쪽이다 | 플랫폼 단위 시험에 `RedisReauthJtiStore.claim`의 `PX`를 남은 수명 400초일 때 `'330000'`, 100초일 때 `'100000'`으로 단언한다(지금 플랫폼에 이 저장소의 시험이 없다) |
| E2·E3 | 걸리지 않는다(닿는 입력 없음) | 시험보다 목록을 정본·주석에서 '방어용, jose 6.2.14에서는 닿지 않음'으로 적거나 빼는 것을 계획 담당이 정한다 |

#### 판정 기준 대조(R-T39 ⑦과 넓힌 ②③⑤⑥)

| 항목 | 정본 판정(넓힌 부분) | 시험 단언 | 결과 |
| --- | --- | --- | --- |
| ② | 남은 수명 5분 30초 초과·`alg` none·HS256·모르는 `crit`도 403, 호출·쓰기 0. 거절마다 로그에 까닭 이름표 하나, 토큰·계정 ID 없음 | HTTP: 600초·crit·alg 둘을 `expectRejected`(403·`type`·호출 0·`writes.create` 0·`SET` 0). 거절 기록 시험은 21가지와 `replay`마다 `onResult` 값 한 개를 `toEqual`로, 토큰·계정·세션 ID가 그 값에 없음을 본다. 어댑터는 330,000·330,001ms 경계 | 403 쪽은 맞음. **'로그에 남는다'는 대역 값까지만 보고 실제 로그 줄은 보지 않는다**(L7이 살아남음) |
| ③ | 새 토큰 하나로 다른 표 둘을 동시에 → 202 하나·403 하나, ticket-svc 호출 1 | HTTP ③ 동시: `Promise.all` → `[202, 403]`, 403의 `type`, ticket·payment·`writes.create` 각 1번, `SET` 두 번 | 맞음 |
| ⑤ | 키 깨짐·처음 읽기 답 없음도 503·`Retry-After`·호출 0. 답 없는 읽기는 1,000ms [가정] 안팎 | HTTP: 같은 kid 키 둘·곡선 밖·답 없음을 `expectUnavailable`, 까닭 `keys`. 답 없음은 실제 시간 900ms 이상 2,500ms 미만 | 맞음. 다만 위쪽 허용폭이 2.5배라 상한을 2,000ms로 잘못 둬도 통과할 것이다(넣지 않음). 정본 '안팎'이 폭을 정하지 않아 어긋남은 아니다 |
| ⑥ | 주소는 있고 `PEAKET_IDENTITY_ISSUER` 없이 운영에서도 시작하지 않는다 | 조립: 없음·빈 값 × prod·production·staging·demo·없음에서 던짐(글에 `PEAKET_IDENTITY_ISSUER`). local·ci는 기본값만 받음 | 맞음(간접. `start()`는 띄우지 않는다. 앞과 같다) |
| ⑦ | 확인기가 뜻밖의 오류(`TypeError`) → 500, `Retry-After` 없음, 호출 0 | HTTP ⑦: 확인기 대역이 `TypeError`를 던짐 → 500·`Retry-After` 없음·ticket·payment·`writes.create` 0. 대조로 `ReauthUnavailable` → 503 | 컨트롤러 경계는 맞음. **실제 어댑터의 뜻밖 오류 경로는 보지 않는다**(E7이 살아남음) |

- 이름만 달린 시험: 앞 대조의 어긋남 둘(어댑터 ID, 빈 토큰의 공개키 단언)은 T10·T11로 닫혔다. 새로 '이름만'인 것은 거절 기록 시험 이름의 '로그에 남기고'다(단언은 `onResult` 값. L7).
- 리뷰 다시 보기와 겹침은 보지 않았다(따로 했다).

### 마지막 고침 검증

- 담당: 검증 `l3-b415r-verify`(claude-opus-5-5), 2026-11-18. 머리 `99638b47`(재현 시험 `2c59c278`, 구현 `99638b47`)를 따로 꺼낸 폴더 `D:/ticketpass-lane3-verify`에서 봤다. purchase-svc 일곱 파일(기준 98/98 통과)과 플랫폼 `test/reauth-jti.test.ts`(기준 2/2 통과)를 돌렸다. 살아남은 것은 purchase-svc 단위 시험 전체(4,179개)로 다시 돌렸다.
- **셈: 넣은 11, 잡힌 9, 살아남은 2.**

| # | 자리 | 내용 | 잡은 시험 |
| --- | --- | --- | --- |
| G1 | W `fanReauthResultLogger` | 403을 `warn`으로 남긴다 | 조립 ② 로그 잇기(가짜 로거), 조립 ② 실제 확인기 → 로그 |
| G2 | W 같은 함수 | 503을 `info`로 남긴다 | 같은 둘 |
| G3 | W 같은 함수 | 403을 한 번 더 남긴다 | 같은 둘 |
| G4 | W 같은 함수 | 넘어온 값을 통째로 싣는다(`outcome`과 섞여 온 토큰·`jti`·계정 ID가 따라온다) | 같은 둘(칸 `outcome`) |
| G5 | W 같은 함수 | 까닭 이름표를 바꾼다(`sub` → `claims`) | 같은 둘 |
| G6 | W 같은 함수 | 사건 이름 `event`를 바꾼다 | **살아남음** |
| S1 | S start | `onResult`에 빈 함수를 넘긴다 | 조립 ② start.ts가 `fanReauthResultLogger`를 넘김 |
| S2 | S start | 감싼 로거의 `info`를 `log.warn`으로 잇는다(403이 `warn`이 된다) | **살아남음** |
| E7 | G | 어댑터가 뜻밖 오류를 503(`keys`)으로 덮는다(앞 검증의 살아남은 것) | HTTP ⑦ 실제 확인기, 어댑터 ⑦ 시계 `TypeError` |
| R3 | J | 공용 `REAUTH_JTI_TTL_MS`를 5분으로 | 플랫폼 ⑤ PX 상한(남은 400초) |
| R4 | J | 공용 `REAUTH_JTI_TTL_MS`를 6분으로(앞 검증의 살아남은 것) | 플랫폼 ⑤ PX 상한(남은 400초) |

- 처음부터 통과한 시험이 실패하는 것을 봤다: R-T39 ⑦ 어댑터·HTTP 둘은 E7, 플랫폼 `reauth-jti.test.ts`의 상한 시험은 R3·R4로 봤다. 플랫폼 파일의 '이미 있으면 false'는 이번에 넣은 결함으로 실패하지 않았다(지시 범위 밖).
- 살아남은 것:
  - G6: 권한·통과 기준에 걸리지 않는다. 정본 §3.1 '거절 기록'은 까닭 이름표만 정하고 사건 이름은 정하지 않는다. 시험도 `event`가 글자인지만 본다. 대시보드·경보가 사건 이름으로 거른다면 정본에 이름을 적고 시험이 그 값을 단언해야 한다.
  - S2: 권한에는 걸리지 않는다(관측). R-T39 ② 판정 칸은 단계를 말하지 않으므로 통과 기준 밖이다. 다만 §3.1 '거절 기록'의 '403은 `info`, 503은 `warn`'과 어긋난 채 통과한다. start.ts 글 시험은 `onResult: fanReauthResultLogger(`까지만 보고 감싼 로거의 안쪽은 보지 않는다. 제안: 글 시험에 `info: (o) => log?.info(`·`warn: (o) => log?.warn(`을 더하거나, 서비스 로거(`info(obj, msg)`)를 감싸지 않고 바로 받게 함수 모양을 바꾼다.
- R-T39 ② '로그' 판정 대조: 판정은 '거절마다 로그에 까닭 이름표 하나가 남고 토큰·계정 ID는 없다'이다. 이제 세 겹으로 덮인다. (가) HTTP 거절 기록 시험은 21가지와 `replay`에서 `onResult` 값이 하나이고 그 값에 토큰·계정·세션 ID가 없음을 본다. (나) 조립 시험은 `fanReauthResultLogger`가 이름표 13개마다 `info` 한 줄, `keys`·`store`마다 `warn` 한 줄을 남기고, 칸이 `reason`·`event`뿐이며, 섞여 온 토큰·`jti`·계정·세션 ID를 옮기지 않음을 본다. 실제 확인기 → 이 함수 → 가짜 로거도 본다. (다) start.ts 글 시험은 이 함수를 `onResult`로 넘기는지 본다. 앞 검증의 어긋남(L7, 이름만 '로그')은 닫혔다. 남은 틈은 S2(감싼 부분의 단계)뿐이고, 판정 칸의 글('로그에 하나, 토큰·계정 ID 없음')에는 맞는다.

## 리뷰 반영 계획

- **담당·바탕**: 계획 담당 `l3-b415r-plan`(claude-opus-5-5, 같은 세션), 2026-11-18, 머리 `f0aab468`. '리뷰' 절 RV-01~09와 '검증' 절 살아남은 V3·V7·V8, 판정 기준 대조의 어긋남 둘에 답한다. 처리는 감독이 정한 대로다. A 등급이라 반영 계획 커밋을 따로 두고(이 커밋), 지적마다 시험 담당이 재현 시험을 먼저 써서 지금 트리(`f0aab468`)에서 실패를 본 뒤 구현 담당이 고친다(커밋 꼬리말 `Fix-By`·`Finding`은 그 담당들이 단다). 고친 뒤에는 리뷰 담당이 고친 곳만 다시 보고, 검증 담당이 마지막 검증을 한다.
- **정본**: 이 커밋에서 먼저 고쳤다(모두 '추천 적용, 2026-11-18, BAT-415-reauth 리뷰'). docs/features/transfer-refund.md §3.1 '팬 취소의 재인증 확인'(새 줄 '공개키 묶음 읽기'·'거절 기록', '한 번 쓰기'·'답'·'시작 조립'·'남는 한계' 고침)과 §11 R-T39(②③⑤⑥ 넓힘, ⑦ 새로), docs/data.md §3 `reauth:jti:{jti}`(수명 상한 5분 30초, 서비스 안에서만), docs/BUILD_ORDER.md GAT-090 단계 줄('BAT-415-reauth가 넘긴 것'). openapi `createTicketCancellation` 503 설명은 원인 예 둘만 적은 채 두었다(설명을 바꾸면 생성물이 다시 바뀐다. 원인 목록의 정본은 transfer-refund §3.1이다).
- **ADR**: 쓰지 않았다. RV-01을 막는 결정은 방향을 바꾸므로 아래 §4 OPEN으로 소유자에게 보낸다(감독이 번호를 받는다).
- **장부**: `node tools/ci/ledger.mjs --batch BAT-415` → 항목 10개(R-T39 ⑦이 새로 생겨 'ID만' 1), 자동 시험 9.

### 1. 지적마다 처리

| 지적 | 처리 | 담당(차례) | 정본 |
| --- | --- | --- | --- |
| RV-01 중간 보안 | 이 묶음에서 막지 않는다. 정본 '남는 한계'에 적고 아래 §4 OPEN 문안을 감독에게 넘긴다 | 계획(이 커밋)만 | transfer-refund §3.1 '남는 한계', data.md §3 |
| RV-02 낮음 보안 | 고친다. 남은 수명이 5분 30초(5분 + 시계 차이 30초 [가정])를 넘는 토큰은 `jti`를 잡지 않고 거절한다(까닭 `lifetime`). 공용 저장소 상한 `REAUTH_JTI_TTL_MS`를 5분에서 5분 30초로 올려 기록이 토큰보다 먼저 사라지지 않게 한다 | 시험 → 구현 | transfer-refund §3.1 '한 번 쓰기'·'답', data.md §3 |
| RV-03 낮음 | 정리 목록으로(`docs/lanes/lane3-cleanup.md`, 기록 커밋에서 감독이 넣는다) | — | — |
| RV-04 낮음 | 정리 목록으로(시작할 때 미리 읽기, 오래된 캐시로 답하고 뒤에서 다시 읽기). 읽기 상한을 1,000ms로 줄이는 것은 RV-09와 함께 이 묶음에서 한다 | — | transfer-refund §3.1 '공개키 묶음 읽기' |
| RV-05 낮음·검증 V7 | 고친다. 경계: 키 묶음 안 키를 쓸 수 없는 jose 오류(`ERR_JWK_INVALID`·`ERR_JWKS_INVALID`·`ERR_JWKS_MULTIPLE_MATCHING_KEYS`)는 503 `reauth-unavailable`, `ERR_JOSE_NOT_SUPPORTED`는 토큰 거절 403, 그 밖의 뜻밖 오류(`TypeError` 등)는 500이고 `Retry-After`가 없다. 모두 Saga 0 | 시험 → 구현 | transfer-refund §3.1 '답', R-T39 ⑤⑦ |
| RV-06 낮음 보안(관측) | 고친다. (가) 403마다 `info` 한 줄에 까닭 이름표 하나(`missing`·확인기 까닭 아홉·`sub`·`lifetime`·`replay`), 503은 `warn`에 `keys`·`store`. 토큰·`jti`·계정 ID·세션 ID는 싣지 않는다 (나) `PEAKET_IDENTITY_ISSUER`가 없거나 빈 값이면 local·ci만 기본값을 쓰고 그 밖은 시작 실패 | 시험 → 구현 | transfer-refund §3.1 '거절 기록'·'시작 조립', R-T39 ②⑥ |
| RV-07 낮음 | 정본 '남는 한계'에 적기만 한다(503 뒤 같은 토큰은 403일 수 있다) | 계획(이 커밋)만 | transfer-refund §3.1 '남는 한계' |
| RV-08 낮음(다음 단계) | GAT-090 단계 줄에 'BAT-415-reauth가 넘긴 것'으로 적었다(취소 화면의 `X-Reauth-Token`, 계좌면 `purpose` high-risk, 두 재인증 시트의 흐름, frontend.md §4.3 오류 표의 503 `reauth-unavailable`) | 계획(이 커밋)만 | BUILD_ORDER GAT-090 |
| RV-09 낮음·검증 V8 | 고친다. 공개키 묶음 읽기 한 번의 상한을 1,000ms [가정]로 정본에 적었다(지금 코드는 5,000ms). 시험을 더한다: (가) 답하지 않는 읽기 (나) 같은 토큰 동시 두 요청 (다) `alg` none·HS256 | 시험 → 구현((가)만 코드가 바뀐다. (나)(다)는 지금도 맞을 것이라 시험만) | transfer-refund §3.1 '공개키 묶음 읽기', R-T39 ②③⑤ |
| 검증 V3 | 정리 목록으로(동치, 시험 필요 없음) | — | — |
| 검증 대조 어긋남 둘 | 시험 이름과 단언을 고친다 | 시험만 | R-T39 ②·③·⑤ |

### 2. 시험 담당 몫(재현 먼저, `f0aab468`에서 본 실패를 '실패 확인' 절에 적는다)

| # | 시험(이름은 ID로 시작) | 파일 | 단언 | 지금 트리에서 |
| --- | --- | --- | --- | --- |
| T1(RV-02) | `R-T39 ② 남은 수명이 5분 30초를 넘는 토큰은 거절하고 jti를 잡지 않는다` | `test/jwks-fan-reauth-gate.test.ts`(기존 '정확한 수명' 시험의 600초 줄을 이것으로 바꾼다. 정본이 바뀌어 뒤집는 것이라 시험 이의가 아니다), HTTP 한 줄은 `test/cancel-reauth-http.test.ts` | 가짜 시계로 남은 수명 330,000ms → true이고 `PX` `'330000'`. 330,001ms·600,000ms → false이고 `command` 0번. 180초 → `'180000'`은 그대로. HTTP: 600초 토큰 → 403·호출 0·`SET` 0 | 330,001ms·600초가 true라 실패, 330초의 `PX`가 `'300000'`이라 실패 |
| T2(RV-05) | `R-T39 ⑤ 공개키 묶음 안의 키가 깨지면 503 reauth-unavailable이다` | `test/cancel-reauth-http.test.ts`, 어댑터 한 줄 | 같은 `kid`인데 키가 깨진(`x` 좌표가 곡선 밖이거나 `crv`가 빠진) 묶음 → 503·`type` reauth-unavailable·`Retry-After` `5`·호출 0·`SET` 0. 어댑터는 `ReauthUnavailable`을 던진다 | 500이라 실패 |
| T3(RV-05) | `R-T39 ② 모르는 crit 머리의 토큰은 403이다` | `test/cancel-reauth-http.test.ts`(② 목록에 한 줄) | 403 reauth-required·호출 0·`SET` 0 | 시험 담당이 결과를 적는다(jose가 내는 오류에 따라 지금 500일 수 있다) |
| T4(V7) | `R-T39 ⑦ 확인기가 뜻밖의 오류를 내면 500이고 Retry-After가 없으며 아무것도 부르지 않는다` | 같은 파일(확인기 대역 묶음, `verify`가 `TypeError`를 던짐) | 500, `Retry-After` 머리 없음, ticket·payment·`writes.create` 0. 대조: 같은 대역이 `ReauthUnavailable`을 던지면 503 | 처음부터 통과할 수 있다(그러면 그렇게 적고 검증이 V7을 다시 넣어 실패를 본다) |
| T5(RV-06 가) | `R-T39 ② 거절마다 까닭 이름표 하나를 로그에 남기고 토큰·계정 ID는 싣지 않는다` | 같은 파일(서비스 로그를 `logDestination`으로 모은다) | ② 경우마다 정확히 한 줄이고 까닭이 정본 이름표다(없음 `missing`, 만료 `expired`, 다른 세션·다른 act `claims`, 다른 계정 `sub`, 다른 키 `kid` 또는 `signature`, `typ`, `aud`, `iss`, 수명 `lifetime`, 다시 씀 `replay`). 로그 글 전체에 토큰 문자열·`jti`·계정 ID·세션 ID가 없다. ⑤는 `warn` 한 줄에 `keys`·`store` | 로그가 없어 실패 |
| T6(RV-06 나) | `R-T39 ⑥ 주소는 있고 PEAKET_IDENTITY_ISSUER가 없으면 운영에서 시작하지 않는다` | `test/fan-reauth-wiring.test.ts`(기존 발급자 기본값 시험은 `PEAKET_ENV` prod를 local·ci로 바꾼다) | 발급자 없음·빈 값 × prod·staging·demo·없음 → 던짐(글에 `PEAKET_IDENTITY_ISSUER`). local·ci → 기본값 발급자 토큰만 받는다. start.ts 글 시험: 확인기 조립에 거절 기록을 받는 곳(로거)을 넘긴다 | prod에서 던지지 않아 실패 |
| T7(RV-09 가·V8) | `R-T39 ⑤ 처음 공개키 읽기가 답하지 않으면 1,000ms 안팎에 503이다` | `test/jwks-fan-reauth-gate.test.ts`, HTTP 한 줄 | `AbortSignal`을 따르는 멈추는 가짜 `fetch`와 실제 시간으로: `ReauthUnavailable`(HTTP는 503)까지 900ms 이상 2,500ms 미만, `fetch` 1번, `SET` 0번. 단언 값 1,000은 정본에서 가져온다(코드 상수를 가져오지 않는다) | 5,000ms라 2,500ms 안에 끝나지 않아 실패 |
| T8(RV-09 나) | `R-T39 ③ 같은 토큰으로 다른 표 둘을 동시에 보내면 하나만 지난다` | `test/cancel-reauth-http.test.ts` | `Promise.all` 두 요청 → 202 하나·403 하나, ticket `cancel` 1번, `SET` 2번(하나는 `null`을 받음) | 처음부터 통과할 것(그렇게 적고 검증이 `jti` 잡기를 빼 실패를 본다) |
| T9(RV-09 다) | `R-T39 ② alg none·HS256 토큰은 403이다` | 같은 파일(② 목록에 두 줄) | 403·호출 0·`SET` 0. none은 공개키 읽기 0번 | 처음부터 통과할 것(그렇게 적는다) |
| T10(대조 ①) | 어댑터 시험 이름 | `test/jwks-fan-reauth-gate.test.ts` | '정확한 수명으로 jti를 잡는다' → `R-T39 ③ …`(한 번 쓰기), 'act·sid·sub가 틀린 토큰을 거절' → `R-T39 ② …`, '빈 값이면 false' → `R-T39 ② …`. 공개키 못 받음·저장소 세 상태는 ⑤ 그대로 | 이름만 |
| T11(대조 ②) | 빈 토큰 시험 | 같은 파일 | `expect(jwks.urls).toHaveLength(0)` 한 줄을 더한다 | 처음부터 통과할 것 |
| T12(RV-05 보완, 2026-11-18 감독 결정) | `R-T39 ⑤ 좌표가 곡선 밖인 키를 담은 공개키 묶음이면 503 reauth-unavailable이다` | `test/cancel-reauth-http.test.ts`, 어댑터 한 줄은 `test/jwks-fan-reauth-gate.test.ts` | 같은 `kid`이고 `x`·`y`가 곡선 밖인 키(jose가 `DOMException` `DataError`를 냄) → HTTP 503·`type` reauth-unavailable·`Retry-After` `5`·호출 0·`SET` 0. 어댑터는 `ReauthUnavailable`을 던지고 `command` 0번. 대조: `crv`가 없는 키는 403(까닭 `kid`) | 500이라 실패할 것(시험 담당이 '실패 확인'에 적는다) |

### 3. 구현 담당 몫(시험 커밋 뒤, 시험 파일은 고치지 않는다)

| # | 파일 | 고칠 것 |
| --- | --- | --- |
| I1(RV-02) | `services/purchase-svc/src/modules/refund/adapters/jwks-fan-reauth-gate.ts` | 확인과 `sub` 대조 뒤, `jti` 잡기 전에 `verified.expiresAt − 지금 > 330_000`이면 false(까닭 `lifetime`). 상수 이름과 주석은 정본 문구대로(5분 + 시계 차이 30초) |
| I2(RV-02) | `packages/platform/src/reauth-jti.ts` | `REAUTH_JTI_TTL_MS`를 `5 * 60_000 + 30_000`으로, 주석을 '5분 + 시계 차이 30초'로 고친다. **다른 서비스 영향**: core·ops·payment의 `jti` 기록도 최대 30초 길어진다(닫히는 쪽이고 행동은 그대로). `packages/platform`을 바꾸므로 node 잡이 전체를 돌고 kind·image도 돈다 |
| I3(RV-05·V7) | 같은 어댑터 | 확인기 오류 가운데 `code`가 `ERR_JWK_INVALID`·`ERR_JWKS_INVALID`·`ERR_JWKS_MULTIPLE_MATCHING_KEYS`면 `ReauthUnavailable`(까닭 `keys`), `ERR_JOSE_NOT_SUPPORTED`면 false(까닭 `claims`, 정본 §3.1 '거절 기록'대로. 처음 계획의 `format`은 틀렸다), 그 밖은 그대로 던진다. 보완(2026-11-18, 감독 결정): jose 6.2.14에서 좌표가 곡선 밖이거나 `y`가 없는 키는 `code` 없이 `DOMException`(name `DataError`)을 내므로, `e instanceof Error && e.name === 'DataError'`(DOMException 포함)도 `ReauthUnavailable`(까닭 `keys`)로 바꾼다. `crv`가 없는 키의 `ERR_JWKS_NO_MATCHING_KEY`는 확인기가 `TokenRejected('kid')`로 바꾸므로 그대로 403(까닭 `kid`)이다. jose를 새 의존성으로 들이지 않고 `code`·`name` 글로 가른다. 컨트롤러는 그대로 둔다(500은 플랫폼 기본) |
| I4(RV-06 가) | 같은 어댑터, `src/refund-wiring.ts`, `src/start.ts` | 생성자 선택 인자 `onResult?: (r: { outcome: 'rejected'; reason: ReauthRejectReason } \| { outcome: 'unavailable'; reason: 'keys' \| 'store' }) => void`, 이름표 형 `export type ReauthRejectReason = 'missing' \| TokenRejectReason \| 'sub' \| 'lifetime' \| 'replay'`. `fanReauthGateFromEnv`가 받아 넘기고, start.ts가 서비스 로거로 403은 `info`, 503은 `warn` 한 줄(필드는 `reason`만)로 잇는다(늦게 묶는 로거 방식) |
| I5(RV-06 나) | `src/refund-wiring.ts` | 주소가 있고 `PEAKET_IDENTITY_ISSUER`가 없거나 빈 값이면 local·ci만 기본값, 그 밖은 던짐(글에 `PEAKET_IDENTITY_ISSUER`) |
| I6(RV-09) | 같은 어댑터 | `JWKS_TIMEOUT_CAP_MS`를 1,000으로, 주석에 정본 자리를 적는다 |

- 구현 담당이 돌릴 것: 계획 §10의 첫 두 줄과 `pnpm lint`, 그리고 I2 때문에 `cd /d/ticketpass-lane3/packages/platform && npx vitest run && npx tsc -p tsconfig.json --noEmit`. 생성물은 바뀌지 않는다(openapi를 고치지 않았다).

### 4. RV-01 OPEN 문안(감독이 전체 감독에게 보내 번호를 받는다)

> **팬 재인증 토큰의 한 번 쓰기가 받는 서비스마다 따로다**(BAT-415-reauth 리뷰 RV-01, 중간 보안). 재인증 토큰(5분, 작업 묶음 `act`)의 한 번 쓰기를 받는 서비스가 각자 기록한다(identity는 PostgreSQL `reauth_token_use`, purchase-svc 팬 취소는 좌석 Redis). 그래서 같은 세션의 `FAN_SENSITIVE` 토큰 하나를 5분 안에 identity 작업(탈퇴, 다른 기기 로그아웃, 로그인 수단 추가·해제)에 한 번, 예매 취소에 한 번 쓸 수 있다. `FAN_HIGH_RISK`도 양도(ticket-svc)와 환급 계좌 입력(purchase-svc)이 함께 받게 되면 같다. 토큰은 화면 메모리에만 있고 같은 세션·5분 안이라 실제 악용은 그 토큰 값을 가로챈 경우로 좁지만, identity.md §3이 묶음을 둔 까닭('다른 작업에 쓰지 못하게')과 어긋난다. 선택지는 셋이다. (가) 팬 취소만의 작업 묶음(예 `FAN_CANCEL`)을 더한다. 바꿀 곳은 적지만 같은 문제가 다른 받는 서비스마다 다시 생긴다. (나) identity가 토큰에 받는 쪽 작업(새 클레임, 예 `op` = `TICKET_CANCEL`·`TRANSFER_REQUEST`·`CANCELLATION_ACCOUNT`)을 싣고, 웹이 재인증 `purpose`로 그 작업을 고르며, 받는 서비스는 자기 작업의 토큰만 받는다. 토큰 하나가 한 받는 곳에서만 쓰이므로 서비스마다 따로인 기록으로도 충분하다. identity·웹 앱 서버·받는 서비스가 모두 바뀌고 ADR이 필요하다. (다) 한 번 쓰기를 identity 한 곳에서 한다(받는 서비스가 identity gRPC로 `jti`를 소비한다). 가장 확실하지만 취소·양도가 identity 동기 호출에 기대게 되어 identity 장애가 그 작업을 막는다(identity.md §10의 무상태 검증과 어긋난다). **추천은 (나)**다. 새 동기 의존이 없고, 지금 받는 쪽 검사(`act`·`sid`·`sub`)에 한 줄을 더하는 꼴이며 (가)를 포함한다. 그때까지는 transfer-refund §3.1 '남는 한계'로 받아들인다. 정할 시점은 취소 화면을 잇는 GAT-090이나 양도 요청을 여는 단계 앞이다.

### 5. 다시 볼 것

- 리뷰 담당: RV-02·RV-05·RV-06·RV-09의 고친 곳만 다시 본다(높음 지적은 없었다).
- 검증 담당: 고친 곳에 틀린 구현을 넣는다. I1 상한 빼기·경계 `>`를 `>=`로, I2 상수 되돌리기, I3 `ERR_JWK_INVALID`를 500으로·`ERR_JOSE_NOT_SUPPORTED`를 503으로·`TypeError`를 503으로, I4 까닭 이름표 바꾸기·계정 ID 싣기, I5 운영에서 기본값 쓰기, I6 상한 5,000으로 되돌리기.

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | l3-b415r-plan | claude-opus-5-5 | 2026-11-18T20:50+09:00 | 2026-11-18T21:08+09:00 |
| impl | l3-b415r-impl | claude-opus-5-5 | 2026-11-18T21:07+09:00 | 2026-11-18T21:17+09:00 |
| test | l3-b415r-test | claude-opus-5-5 | 2026-11-18T21:19+09:00 | 2026-11-18T21:36+09:00 |
| review | l3-b415r-review | claude-opus-5-5 | 2026-11-18T21:37+09:00 | 2026-11-18T22:52+09:00 |
| verify | l3-b415r-verify | claude-opus-5-5 | 2026-11-18T21:38+09:00 | 2026-11-18T23:34+09:00 |
| plan | l3-b415r-plan | claude-opus-5-5 | 2026-11-18T22:06+09:00 | 2026-11-18T22:40+09:00 |
| test | l3-b415r-test | claude-opus-5-5 | 2026-11-18T22:16+09:00 | 2026-11-18T23:20+09:00 |
| impl | l3-b415r-impl | claude-opus-5-5 | 2026-11-18T22:41+09:00 | 2026-11-18T23:24+09:00 |
| record | l3-supervisor | claude-opus-5-5 | 2026-11-18T23:36+09:00 | 2026-11-18T23:55+09:00 |

- 다른 담당은 자기 커밋에서 이 표에 자기 행을 더한다. 리뷰 반영 커밋은 `Fix-By`의 역할(시험·구현) 행으로 센다.
