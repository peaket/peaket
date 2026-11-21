# 작업 계획: W12-rtgw(S-T42 ⑯ 닫히는 중 연결 시험이 서버의 실제 100ms 유예와 경주)

- **진행**: 계획·시험 끝(2026-11-22) → 다음은 리뷰 담당.
- **무엇**: `develop` `456df0929` CI(실행 44924759035, `node / node` 잡) `@peaket/realtime-gw#test`에서 `services/realtime-gw/test/gateway.test.ts:205`의 'S-T42 ⑯ 같은 jti로 회차가 다른 연결을 답하지 않는 채 넷 만들면 … 다섯째 핸드셰이크는 … 503 …'(SEC-R02, BAT-052 RF-T15)이 `ev-2 경로: expected [ 101, '', 'websocket' ] to deeply equal [ 503, '', undefined ]`로 실패했다. 다섯째 셋 가운데 앞의 둘(회차 다름·회차 맞음)은 503이었고 셋째(ev-2 경로)만 101이다. 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane4-rtgw`(가지 `feature/lane4-W12-rtgw`, 출발점 `origin/develop` `456df0929`). 단위 시험은 `pnpm --filter @peaket/realtime-gw test`(vitest).
- **등급·차례**: C, 시험만 묶음(`Batch-Kind: test-only`): 계획 → 시험(실패 확인을 같은 커밋에) → 리뷰 → 검증 → 기록. 제품 코드(`services/realtime-gw/src/`)는 고치지 않는다.
- **정본(바꾸지 않음)**: `docs/features/seat-hold.md` §7 '핸드셰이크' ④ 뒤 문장·§12 S-T42 ⑯·§13, ADR-0297 결정 3 '곧 닫는 연결'(닫기 인사 유예 100ms [가정], 같은 jti의 닫히는 중 연결 4개 [가정]). 시험이 끊김을 보는 300ms는 BAT-052 계획 '리뷰 반영 계획' 4.1 RF-T15.

## 감독에게

1. **판정: 흔들림(시험 결함)이고 제품 결함이 아니다.** 코드는 정본대로 100ms 뒤 끊고 그때 셈을 줄인다. 시험이 그 100ms 안에 핸드셰이크 일곱을 끝내리라 기대했다(아래 1).
2. **문제 설명 바로잡기**: 실패한 것은 `:140` describe('곧 닫는 연결은 파드 상한을 차지하지 않는다', SEC-R01)가 아니라 `:188` describe('같은 토큰의 닫히는 중 연결 상한', SEC-R02)의 `:205` 단언이다. 같은 원인이 ⑯ 네 시험에 모두 있어 넷을 함께 고친다.
3. **W11-rtgw-flake와 같은 꼴이 아니다.** W11은 계산량이 vitest 벽시계 한도 5초를 넘긴 것이고, 이번은 판정 단언이 서버의 실제 타이머(100ms)와 경주한다. 둘 다 CI가 로컬보다 몇 배 느려서 드러났다는 점만 같다.
4. **같은 원인, 이 묶음 밖**: 통합 시험 `test-int/stream.int.test.ts:606-627`(RF-T15: 넷 뒤 지표 긁기 한 번과 핸드셰이크 둘이 100ms 안이어야 함)·`:575-600`(RF-T14)도 실제 프로세스의 100ms 유예와 경주한다. 실제 프로세스라 가짜 시계를 쓸 수 없고, 결정적으로 하려면 코드에 유예 타이머를 넣어 줄 자리가 필요하다(코드 묶음). 다음 묶음 후보로 올린다.
5. 계획 커밋에 꼬리말 `Batch-Kind: test-only`를 더했다(`docs/architecture.md` §8.6 '시험만 묶음').

## 계획

### 1. 원인과 근거

- 코드(정본대로): `services/realtime-gw/src/modules/stream/inbound/handshake.ts:196-207` `conn.close`가 곧 닫는 연결(4403 bad event·4429 too many)을 `#open`에서 빼고 `#closingByToken`을 1 늘린 뒤 **전역 `setTimeout(() => ws.terminate(), CLOSING_GRACE_MS)`**(`:206`, 100ms)를 건다. `:219-228` 'close'에서 셈을 1 줄이고, `:170`은 셈이 4면 503이다. 100ms가 지나 끊기면 셈이 줄어 새 핸드셰이크가 들어오는 것이 바른 동작이다.
- 시험: `test/gateway.test.ts:188-215`. 첫째 연결의 유예는 첫째 101 때 시작하므로, **첫째 101부터 100ms 안에** 넷째까지의 핸드셰이크 + `until` 10ms 폴링 + 다섯째 셋이 끝나야 한다. 늦으면 첫째가 끊겨 셈이 3이 되고 그 뒤 핸드셰이크는 101이다. CI에서 셋째만 101인 것이 이 설명과 맞는다.
- 잰 값(이 PC, 32스레드): 임시 사본(끝나고 지움)에서 첫 핸드셰이크 시작 → ev-2 경로 핸드셰이크 직전이 16~18ms(5번), 창의 2할. CI는 같은 실행의 ⑯ 첫 시험이 346ms(로컬 31~58ms)로 약 7배 느려 120ms 안팎이 된다.
- 재현(결정적): 같은 임시 사본의 ev-2 경로 핸드셰이크 앞에 진짜 120ms 기다림을 넣으면 **3/3 CI와 같은 글로 실패**, 85ms면 1/3(18 + 85 ≈ 100ms 경계). 고치지 않은 시험 10번은 10/10 통과.
- 같은 원인, 다른 꼴(CPU 부하): 바쁜 고리 64개(스레드의 2배)를 띄우고 ⑯ 네 시험을 8번 돌리면 **8번 중 5번 실패**했다(`[ false, false ]`·`[ true, false ]` 셋 = `:182`, `expected false to be true` 둘 = `:211`). 이때 SEC-R02 앞 창은 8~77ms로 오히려 짧았다. 이벤트 고리가 300ms 넘게 막히면 유예 타이머와 시험의 `sleep(300)`이 같은 타이머 단계에서 함께 돌아, 서버가 끊은 직후 클라이언트가 'close'를 받기 전에 단언이 돈다(`:181-182` 곧 닫는 연결 시험, `:210-211`). SEC-R01 두 시험(`:141-171`)은 늦어도 깨지지 않는 대신, 유예가 끝나 끊긴 뒤라 '곧 닫는 연결을 상한에 남기는' 틀린 구현을 놓친다.

### 2. 바른 동작과 고칠 방향(시험 담당 몫, `test/gateway.test.ts` 하나)

- ⑯ 두 describe(시험 넷)는 서버의 유예 타이머를 vitest 가짜 타이머로 잡는다: `startGateway` 전에 `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })`. `setImmediate`·`nextTick`·`Date`·`performance`는 가짜로 하지 않는다(ws 받는 쪽이 `setImmediate`를 쓰고 `node_modules/ws/lib/receiver.js`, 토큰 `iat`·확인은 `Date`). 같은 꾸러미 앞선 예 `test/redis-subscriber.test.ts:147`. 가능성 확인(임시 사본, 끝나고 지움): SEC-R02 시험만 이 방식으로 바꾸고 다섯째 앞에 진짜 150ms를 넣어도 5/5 통과, 넣지 않아도 5/5 통과했다(파일 시험 5개 모두).
- 시험 쪽 기다림은 가짜 타이머에 묶이지 않게 한다: 닫힘 프레임·'close' 이벤트를 약속으로 기다리거나, 파일 머리에서 잡아 둔 진짜 `setTimeout`으로 폴링한다(상한 1,000ms 그대로). 고정 `sleep(300)`은 없앤다. `afterEach` 첫 줄에 `vi.useRealTimers()`(`shutdown`의 20ms 폴링과 `sleep(3_000)`이 진짜 타이머로 돈다).
- 시간 차례(SEC-R02): 넷 → 4403 넷 확인 → 가짜 시계 `closingGraceMs − 1`(99ms)까지 → 다섯째 셋 503·503 셈 3 → 다른 토큰 101 → 가짜 시계 `waitAfterGraceMs`(300ms)까지 → 넷 모두 'close' → 맞는 회차 101. **99ms까지 꼭 돌린다**: 시계를 돌리지 않으면 유예가 짧은 틀린 구현(M1)을 놓친다.
- 곧 닫는 연결 시험(`:173-185`): 99ms에 bad·tooMany가 아직 열려 있고(닫힘 프레임은 받음), 300ms까지 돌리면 둘이 'close', open1·2는 닫힘 프레임 없이 열려 있다.
- SEC-R01 두 시험(`:141-171`): 가짜 타이머를 켜면 곧 닫는 연결이 유예 동안(가짜 시간 0) 상한에 들지 않음을 결정적으로 본다. `Date.now() - started < 1_000`(정본 '곧바로(1초 안)')은 그대로 둔다.
- 바꾸지 않는 것: `SPEC` 값(100·4·300), 기존 시험 이름, 단언 값(101·503·4403·4429·503 셈 3), 파드 상한(3·100), `S-T42 ②` 시험, `src/`·`test/hub-fixtures.ts`·vitest 설정. 다시 시도·한도 늘리기는 쓰지 않는다.
- 막히면(가짜 타이머가 ws·http와 어울리지 않음) '시험 이의'에 적고 감독에게 올린다. 그때는 코드 묶음(유예 타이머 주입 자리)으로 바꿔야 한다.

### 3. 시험 목록

- 시험 담당은 먼저 `peaket-test-antipatterns` 스킬을 읽는다. ★는 지금 방식(진짜 타이머)에서 결정적으로 실패해야 한다.

| 시험 | 단언 | 지금 실패 까닭 |
| --- | --- | --- |
| W12R-01 ① ★(새 시험, SEC-R02 describe) | 같은 jti 회차 다른 넷 뒤 가짜 시계 99ms, 이어 **진짜 시간 `closingGraceMs + 50`(150ms)**을 흘려(느린 러너 흉내, 진짜 타이머로 기다림) 다섯째 셋(회차 다름·맞음·ev-2 경로) 모두 503·빈 본문·업그레이드 없음 | 진짜 타이머면 150ms 안에 넷이 끊겨 셋 모두 101 |
| SEC-R02 시험 고침(이름 그대로) | 위 2의 시간 차례. 99ms에 503 셋, 300ms 뒤 넷 'close'·맞는 회차 101 | 지금 시험은 통과하지만 CI에서 흔들림 |
| 곧 닫는 연결 시험 고침(이름 그대로) | 99ms에 열림, 300ms까지 돌려 'close', 열린 둘은 그대로 | 부하에서 흔들림(위 1) |
| SEC-R01 두 시험 고침(이름 그대로) | 가짜 타이머 아래 지금 단언 그대로 | 늦은 러너에서 M2를 놓침 |

- 실패 확인 방법: ① 지금 트리의 시험 파일(`456df0929`)을 임시 사본으로 두고 ev-2 경로 핸드셰이크 앞에 진짜 120ms 기다림을 넣어 5번 → 5번 모두 `ev-2 경로: expected [ 101, … ]`로 실패해야 한다. ② 고친 파일의 W12R-01 ①에서 `vi.useFakeTimers` 줄만 임시로 빼면 실패해야 한다(시계 돌리기는 그때 건너뛰도록 임시로 막는다). 둘 다 끝나면 되돌리고 `git diff`로 확인한다.

### 4. 틀린 구현 표본(검증 담당용)

- 임시 사본(`git worktree add --detach`, 끝나고 지움)의 `src/modules/stream/inbound/handshake.ts`에 하나씩 넣고 `pnpm --filter @peaket/realtime-gw test test/gateway.test.ts`를 돌린다.

| # | 넣을 결함 | 잡을 시험 |
| --- | --- | --- |
| M1 | `CLOSING_GRACE_MS` 50(유예가 짧다) | SEC-R02 고침(99ms에 101)·W12R-01 ①·곧 닫는 연결 시험(99ms에 끊김) |
| M2 | 곧 닫는 연결을 `conn.close`에서 `#open`에서 빼지 않는다('close' 때만 뺌) | SEC-R01 두 시험(파드 상한 3에서 다른 토큰 503) |
| M3 | 회차가 다른 연결(4403 bad event)은 닫히는 중으로 세지 않는다(4429만 셈) | SEC-R02 고침·W12R-01 ①(다섯째 101) |
| M4 | 유예를 1초로(BAT-052 M51) | SEC-R02 고침(300ms에 끊기지 않음)·곧 닫는 연결 시험 |

### 5. 게이트

- 로컬: 먼저 `pnpm exec turbo run build --filter=@peaket/realtime-gw^...`. `pnpm --filter @peaket/realtime-gw test test/gateway.test.ts -t "S-T42 ⑯"`과 `-t "W12R-01"`을 각 20번(실패 0), 바쁜 고리를 스레드 수의 2배 띄운 채 `test/gateway.test.ts` 5번(실패 0, 끝나고 바쁜 고리를 모두 끈다), `pnpm --filter @peaket/realtime-gw test`(꾸러미 전체), `pnpm exec turbo run typecheck --filter=@peaket/realtime-gw`, 바꾼 파일 `pnpm exec eslint`, `python tools/doc-check/check_all.py`(오류 0), `node tools/ci/roles-check.mjs`.
- 초안 PR CI `node / node`의 `@peaket/realtime-gw#test` 성공. 같은 잡의 core-svc 실패(갈래 2)는 이 묶음 몫이 아님을 적는다.

### 6. 범위 밖

- `src/` 고침, 통합 시험(감독에게 4), `degraded.test.ts`·`hub.test.ts`(W11에서 다룸), vitest 전체 한도·CI 러너 크기.

## 시험 이의

(시험 담당이 채운다)

## 실패 확인

- 까닭: 버그(흔들림) 재현이라 고치기 전 방식에서 실패를 본다. 이 PC(32스레드), 임시 사본은 `test/` 아래 따로 두고 돌린 뒤 지웠다(`git status`에 `gateway.test.ts`만 남음).
- ① 고치기 전(`456df0929` 시험 파일 사본, ev-2 경로 핸드셰이크 앞에 진짜 `sleep(120)`): `pnpm test test/w12r-repro.test.ts -t "SEC-R02"` 5번 → 5번 모두 1 failed | 4 skipped (5), `AssertionError: ev-2 경로: expected [ 101, '', 'websocket' ] to deeply equal [ 503, '', undefined ]`(CI와 같은 글).
- ② 고친 파일 사본에서 SEC-R02 describe의 `beforeEach(fakeGraceTimers)`를 빼고 W12R-01 ①의 시계 돌리기를 건너뜀(진짜 타이머): `pnpm test test/w12r-neg.test.ts -t "W12R-01"` 5번 → 5번 모두 1 failed | 5 skipped (6), `AssertionError: 회차 다름: expected [ 101, '', 'websocket' ] to deeply equal [ 503, '', undefined ]`(150ms 안에 넷이 끊겨 다섯째가 101).

## 시험 결과

- 바꾼 것(`test/gateway.test.ts`만): ⑯ 두 describe의 `beforeEach`에서 `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })`, `afterEach` 첫 줄 `vi.useRealTimers()`, 시험 쪽 `sleep`은 파일 머리에서 잡은 진짜 `setTimeout`, 고정 `sleep(300)` 둘은 가짜 시계 99ms·300ms 돌리기와 `until`(닫힘을 1,000ms까지 폴링)로. 곧 닫는 연결 시험은 99ms에 서버와 한 번 주고받은 뒤(404) 아직 열림을 본다. 새 `W12R-01 ①`(진짜 150ms를 흘리는 줄에 `fixed-wait` 표기). `SPEC` 값·기존 시험 이름·단언 값·`src/`는 그대로.
- `pnpm --filter @peaket/realtime-gw test test/gateway.test.ts` 5번: 6/6 ×5, 실패 0. ev-2 경로 앞에 진짜 120ms를 넣은 고친 사본 5번: 6/6 ×5, 실패 0.
- `-t "S-T42 ⑯"` 20번: 5 passed | 1 skipped ×20(W12R-01 ①이 SEC-R02 describe 안이라 함께 걸림), 실패 0. `-t "W12R-01"` 20번: 1 passed | 5 skipped ×20, 실패 0.
- 바쁜 고리 64개(`node -e "for(;;){}"`, 스레드의 2배) 아래 `test/gateway.test.ts` 5번: 6/6 ×5(파일당 51~67초), 실패 0. 끝나고 바쁜 고리 0개 확인.
- `pnpm --filter @peaket/realtime-gw test`(꾸러미 전체): 7 파일·87 시험 통과, 실패 0.
- `pnpm exec turbo run typecheck --filter=@peaket/realtime-gw`: 7 successful. `pnpm exec eslint services/realtime-gw/test/gateway.test.ts`: 오류 0(시험 파일은 뿌리 설정의 `**/*.test.*` 무시라 '무시' 경고 1).
- `python tools/doc-check/check_all.py`: 오류 0, 경고 4(이 묶음과 무관한 api 3·mermaid 건너뜀 1). `node tools/ci/roles-check.mjs`: 시험 커밋 전 '시험만 묶음에 test·review·verify 커밋이 없다' 1건(차례상 아직 없음, 검증 뒤 다시 본다).

## 리뷰

(리뷰 담당이 채운다)

## 검증

(검증 담당이 채운다)

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | w12rtgw-plan-4b8e | claude-opus-5-5 | 2026-11-22T01:57+09:00 | 2026-11-22T02:25+09:00 |
| test | w12rtgw-test-6d1c | claude-opus-5-5 | 2026-11-22T02:26+09:00 | 2026-11-22T02:45+09:00 |

## 기록
