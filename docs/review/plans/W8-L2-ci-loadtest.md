# 묶음 계획: W8-L2-ci-loadtest(부하 시험 좌석 키 사본에 prio가 빠진 CI 실패 고침)

- **무엇**: 묶음을 시작할 때 만든 작업 목록이다(docs/architecture.md §8.6, ADR-0270 '계획'). 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane2`, 가지 `fix/lane2-w8-ci-loadtest`, 출발점 `origin/develop` `033bb26d`. 2026-11-16 작성.
- **범위**: 부하 시험 도구의 좌석 키 사본 `loadtest/poc/bench/src/seat-contract.mjs` 한 파일만 고친다. 운영 코드(`services/`)와 시험 파일(`loadtest/test/**`)은 바꾸지 않는다. 실패를 드러낸 시험이 이미 있으므로 이 묶음에는 시험 담당이 없다(시험 커밋 없음, roles-check `[구성]` 감독 예외 예정). 계획 → 구현 → 리뷰·검증 순서로 간다.
- **알린 곳**: develop CI 실행 43856980576(`033bb26d`)의 `loadtest-check / loadtest` 잡 실패. 다른 잡은 통과했다.

## 계획

### 1. 원인

실패한 시험은 하나다. `loadtest/test/poc-seat.test.mjs` 112~116행 'ST27_NFR003_seatKeys는 운영 seatKeys와 이름과 결과가 같다'.

이 시험은 측정 도구의 좌석 키 이름 표(`seatKeys`)가 운영 표와 **이름 목록도 같고, 같은 입력에 같은 키 글을 내는지** 본다. 운영 표는 자식 프로세스(`loadtest/test/fixtures/seat-store-probe.mjs`)가 운영 `redis-seat-store.ts`를 가짜 Redis로 불러 얻는다. 그 프로세스는 운영 `seatKeys`의 모든 이름을 `('E1', 'X2', 'Y3')`로 불러 결과를 돌려준다(시험 99행 `{ op: 'keys', … }`).

- **운영**: `services/purchase-svc/src/modules/inventory/adapters/redis-seat-store.ts` 189~235행 `seatKeys`에 이름이 23개다. 195행에 `prio: (e) => \`s:{event:${e}}:prio\``가 있다(우선 구매 보류의 만료 인덱스, docs/data.md §3 `s:{event:E}:prio` 행).
- **사본**: `loadtest/poc/bench/src/seat-contract.mjs` 8~31행 `seatKeys`에는 22개이고 `prio`만 없다. 나머지 22개는 이름과 글이 운영과 같다.
- **로컬 재현**: `node --test "loadtest/test/*.test.mjs"`(저장소 뿌리, Node 24.18.0)에서 468개 중 467개 통과, 이 시험 하나만 실패한다. 실패 글은 `Object.keys(...).sort()` 비교에서 기대 쪽에만 `'prio'`가 있다는 것이다.

**어떻게 들어왔나.** 2026-11-14 BAT-430(커밋 `16b60af1`, R-575, GAT-135 우선 구매)이 운영 `seatKeys`에 `prio`를 더하고 우선 구매 보류 `holdPriority`를 넣었다(`git show 16b60af1 -- …/redis-seat-store.ts`: +36줄, 그중 `seatKeys`는 `prio` 한 줄). 같은 커밋은 `loadtest/` 아래를 하나도 바꾸지 않았다. 그 뒤 develop에서 `loadtest/`를 바꾼 커밋도 없다가, 웨이브 7의 `e11b4f11`·`926a02c0`이 `loadtest/scenarios/v1-search.js`를 바꾸면서 이 잡이 처음 다시 돌아 드러났다.

**왜 그동안 안 잡혔나.** CI의 바뀐 범위 판정 `tools/ci/changes.mjs` 45~50행의 `loadtest` 규칙은 `loadtest/`와 "그 시험이 견주는 것" 몇 개(v0-monolith 파일·invariant-checker·토큰·장부 도구 등)만 고른다. 그런데 `poc-seat.test.mjs`가 견주는 `services/purchase-svc/src/modules/inventory/`(adapters·domain)와 `application/expiry-sweeper.ts`는 그 목록에 없다. 그래서 운영 좌석 저장소를 바꿔도 이 잡은 건너뛴다. 이것은 실패의 원인이 아니라 늦게 드러난 원인이고, 4절 '이번에 안 함'에 둔다.

### 2. 고칠 범위

판단 기준: 지금 `poc-seat.test.mjs`가 운영과 견주는 연산이 BAT-430 뒤에도 운영과 같은가. 견주는 것은 아래 일곱이고, `033bb26d`에서 이 시험 말고는 모두 통과한다. 즉 아래는 어긋나지 않았다.

| 견주는 것 | 운영 쪽 | BAT-430 뒤 같은가 |
|---|---|---|
| 상수(만료 묶음·틱·동시 회차·쉼·다시 잡기 대기) | `domain/expiry.ts`·`domain/hold.ts` | 같다(시험 통과) |
| `holdCall` KEYS·ARGV | `RedisSeatStore.hold`(271~296행): 키 10개 + 좌석 홀드 키, ARGV 8개 + 좌석마다 6칸 | 같다(시험 통과). BAT-430은 `hold`를 바꾸지 않았고 `prio`를 쓰지 않는다 |
| 홀드 Lua 글 | `hold-lua.ts` `HOLD_LUA` | 같다. 측정 도구는 원문을 그대로 내보내 쓴다(`loadtest/poc/seat-lua.mjs`, 사본을 커밋하지 않음) |
| `replayCommand` | `RedisSeatStore.replay`: 멱등 기록 `HMGET` 한 번 | 같다(시험 통과) |
| `expireCall` KEYS·ARGV, 만료 Lua 글 | `RedisSeatStore.expire`(793~826행): `ordered`까지, `prio`는 없음 | 같다(시험 통과). 우선 구매 보류의 만료는 따로 `duePriorityExpiries`(851행)·`expirePriority`(891행)와 `priority-expire-lua.ts`가 맡는다 |
| 만료 1단계(`dueRangeCommand`·`dueHoldCommand`) | `RedisSeatStore.dueExpiries`(759행): `expiry`를 `ZRANGE` 뒤 좌석마다 `HMGET holdId fence owner` | 같다(시험 통과) |
| `seatKeys` 이름·글 | 189~235행 | **`prio` 하나가 빠졌다(이번 실패)** |

측정 도구가 직접 보내는 판매 열기(`seat-shard.mjs` 156행 `EVAL openSale 2 bitmap epoch 좌석수 보관시한`)도 운영 `openSale`(740행)과 KEYS·ARGV가 같다. 좌석 상황 읽기(192행 `EVAL_RO snapshot 3 epoch bitmap secver`)는 운영 스냅샷 읽기(489행 KEYS `[bitmap, epoch, secver]`)와 차례가 다르다. 하지만 이것은 운영 Lua의 사본이 아니라 운영 스냅샷 API가 생기기 전에 만든 PoC 자체 Lua(`loadtest/poc/bench/lua/snapshot.lua`, 커밋된 파일, 2행 '운영 스냅샷 API는 아직 없다')를 그 Lua의 KEYS 차례대로 부른 것이다. 둘은 서로 맞다. BAT-430과 상관없고 이 시험이 보는 대상도 아니다.

**결론: 이번에 고치는 것은 사본 `seatKeys`에 `prio`를 더하는 한 줄(과 설명 주석)뿐이다.** 우선 구매 보류의 KEYS·ARGV·Lua 대조는 더하지 않는다. 지금 시험이 대조하는 연산은 하나도 `prio`를 쓰지 않으며, 측정 도구는 우선 구매 보류를 만들지 않는다.

### 3. 같은 꼴 훑기(운영을 베낀 loadtest 사본)

`loadtest/` 아래에서 `services/…` 원문을 가리키거나 "같은 규칙·사본"이라고 적은 파일을 봤다.

| 파일 | 무엇을 베꼈나 | 어긋났나 |
|---|---|---|
| `loadtest/poc/bench/src/seat-contract.mjs` | 좌석 키·KEYS·ARGV·상수 | `seatKeys.prio`만 빠짐(이번에 고침). 나머지는 시험이 운영과 견주며 통과 |
| `loadtest/poc/bench/src/sweep-rules.mjs` | `expiry-sweeper.ts`의 만료 반복 규칙 | 같은 시험 파일이 견주며 통과 |
| `loadtest/poc/seat-lua.mjs` | 좌석 Lua 셋(홀드·판매 열기·만료) | 사본을 커밋하지 않고 원문을 그대로 내보낸다. 어긋날 수 없음 |
| `loadtest/poc/run.mjs` | queue-svc 진입 Lua | 측정 전에 원문에서 쓴다(커밋 안 함). 어긋날 수 없음 |
| `loadtest/micro/lua-compare.mjs` | purchase·queue Lua | 원문 모듈을 바로 읽는다. 사본 없음 |
| `loadtest/poc/bench/lua/hold.lua`·`release.lua`·`snapshot.lua` | 사본이 아니라 PoC 자체 Lua(운영 Lua 이전) | 운영과 견주는 대상이 아니다. 운영 Lua로 재는 길은 `seat-*.lua`(위 `seat-lua.mjs`)다 |
| `loadtest/lib/seats.mjs` | v0-monolith 좌석 ID 규칙 | 다른 시험(`lib.test.mjs`)이 보고 통과. `changes.mjs` 규칙에도 원문이 들어 있다 |

같은 꼴로 어긋난 다른 사본은 없다.

### 4. 이번에 안 함

- **우선 구매 보류(`holdPriority`·`releasePriority`·`restorePriority`·`duePriorityExpiries`·`expirePriority`)의 KEYS·ARGV와 `priority-hold-lua.ts`·`priority-expire-lua.ts` 대조를 사본에 더하기.** 측정 도구(S-T27 다시 재기)는 일반 홀드·만료의 처리량과 오버셀을 잰다. 우선 구매는 취소표 한 장을 권리 하나에 주는 드문 흐름이라 측정 부하에 넣지 않는다. 시험이 통과하는 데도 필요 없다. 측정 도구가 우선 구매를 흉내 내야 하는 날이 오면 그때 `holdPriorityCall` 같은 함수와 대조 시험을 함께 더한다.
- **오버셀 검사기의 `prio` 인식.** `seat-shard.mjs` 460~463행은 비트맵의 켜진 비트와 `expiry` 멤버를 견준다. 우선 구매 보류는 비트를 켜고 `prio`에 들어가므로, 섞이면 어긋나 보일 것이다. 측정이 우선 구매 보류를 만들지 않으니 지금은 일어나지 않는다. 위와 같은 날에 함께 본다.
- **`tools/ci/changes.mjs`의 `loadtest` 범위에 `services/purchase-svc/src/modules/inventory/`(adapters·domain)와 `…/application/expiry-sweeper.ts` 더하기.** 이번처럼 운영 좌석 저장소만 바뀌어도 이 잡이 돌게 하는 고침이라 되풀이를 막는다. 다만 시험 통과에는 필요 없고, CI 범위 규칙과 그 시험(`tools/ci/changes.test.mjs` 308행 BSL060 시험)을 함께 바꾸는 다른 성격의 일이며 purchase-svc를 고치는 모든 커밋에 loadtest-check(약 수 분)를 더 붙인다. 감독이 정리 목록에 "loadtest-check 범위에 purchase-svc 좌석 저장소 경로를 더한다(W8-L2-ci-loadtest에서 드러남)"로 올리기를 권한다.
- **시험 파일의 약한 곳.** 이름·글 비교가 회차 ID 하나(`'E1'`)로만 불러 보므로, 회차 ID를 보지 않고 `'s:{event:E1}:prio'`를 그대로 돌려주는 틀린 구현도 통과한다(검증 M4 참고). 시험 파일은 이 묶음에서 바꾸지 않는다. 검증 결과에 따라 정리 목록으로 넘긴다.

### 5. 구현 담당 할 일

바꿀 파일은 `loadtest/poc/bench/src/seat-contract.mjs` 하나다.

1. 13행 `expiry: (e) => \`s:{event:${e}}:expiry\`,` 바로 뒤에 두 줄을 넣는다(운영 표와 같은 자리, 운영 195행).
   ```js
     /** 우선 구매 보류 만료 인덱스(GAT-135, docs/data.md §3 s:{event:E}:prio). 측정 도구는 우선 구매 보류를 만들지 않아 이름만 운영과 맞춘다 */
     prio: (e) => `s:{event:${e}}:prio`,
   ```
2. 다른 줄은 바꾸지 않는다. 특히 `holdCall`·`expireCall`·`replayCommand`·`dueRangeCommand`·`dueHoldCommand`·상수에는 `prio`를 넣지 않는다(운영 `hold`·`expire`·`dueExpiries`가 쓰지 않는다).
3. 확인: 저장소 뿌리(`D:/ticketpass-lane2`)에서 `node --test "loadtest/test/*.test.mjs"`가 **468개 모두 통과**해야 한다. Windows에서도 따옴표 친 글롭 꼴로 돌린다(CI `loadtest-check.yml` 24행과 같은 꼴).

바꾸면 안 되는 것:
- `loadtest/test/**`(시험 파일과 `fixtures/seat-store-probe.mjs`). 시험이 아니라 사본을 맞춘다.
- `services/**`(운영 코드). 운영이 정본이다.
- `loadtest/poc/seat-lua.mjs`의 `SEAT_LUA` 목록, `seat-shard.mjs`, `tools/ci/changes.mjs`(4절).

커밋 범위는 `seat-contract.mjs` 한 파일이다(경로를 지정해 더한다).

### 6. 리뷰 담당 볼 것

- diff가 `loadtest/poc/bench/src/seat-contract.mjs` 한 파일, 더한 줄 2줄(주석·`prio`)뿐인가. `loadtest/test/**`·`services/**`가 바뀌지 않았나.
- 더한 글이 운영 `redis-seat-store.ts` 195행과 글자까지 같은가: 해시 태그(키 이름의 `{…}` 부분, 같은 Redis 칸에 모이게 하는 표시) `{event:${e}}`, 뒷말 `:prio`. docs/data.md §3 `s:{event:E}:prio` 행과도 맞는가.
- 운영 `hold`·`expire`·`dueExpiries`·`replay`가 정말 `prio`를 쓰지 않는가(2절 표). 측정 쪽 함수에 `prio`를 넣지 않은 것이 맞는가.
- 4절 '이번에 안 함'의 까닭이 맞는가. 특히 `changes.mjs` 범위를 이번에 넓히지 않은 판단과, 정리 목록으로 넘기는 문구.
- 머리 주석(1~5행)·7행 주석이 고친 뒤에도 사실과 맞는가(바꿀 필요는 없다고 본다).

### 7. 검증 담당 틀린 구현

각 틀린 구현을 사본 `seat-contract.mjs`에만 잠깐 넣고 `node --test loadtest/test/poc-seat.test.mjs`를 돌린 뒤 `git checkout -- loadtest/poc/bench/src/seat-contract.mjs`로 되돌린다. 기준선(바꾸지 않은 고친 상태)은 전체 468개 통과다.

| 번호 | 틀린 구현 | 기대 |
|---|---|---|
| M1 | `prio`를 다시 뺀다(고치기 전으로) | 'seatKeys는 운영 seatKeys와 이름과 결과가 같다' 실패(이름 목록 차이 `'prio'`) |
| M2 | 키 글을 틀리게: `prio: (e) => \`s:event:${e}:prio\``(해시 태그 빠짐, 다른 Redis 칸으로 간다) | 같은 시험 실패(`prio` 값 비교) |
| M3 | 이름을 틀리게: `priority: (e) => \`s:{event:${e}}:prio\``(글은 맞고 이름만 다름) | 같은 시험 실패(이름 목록 차이) |
| M4(참고) | 회차를 보지 않음: `prio: () => 's:{event:E1}:prio'` | **살아남을 것으로 예상**. 시험이 `'E1'` 하나로만 부르기 때문이다(4절 마지막). 살아남으면 막는 결함이 아니라 시험의 약한 곳으로 기록하고 정리 목록에 넘긴다 |

함께 본다.
- 고친 diff가 `seat-contract.mjs`와 이 계획 파일 밖으로 나가지 않는가.
- M1~M3는 다른 시험(홀드·만료 대조 등)을 깨지 않고 이 시험 하나만 깨야 한다. 다른 시험도 깨지면 그 까닭을 적는다.

## 리뷰

아직 없음.

## 검증

아직 없음.

## 담당 표

아직 없음.
