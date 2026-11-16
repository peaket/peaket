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

**판정: 합쳐도 됨.** 막는 지적은 없다. 지적 넷은 모두 낮음이고 이 묶음 밖(정리 목록)으로 넘긴다. 리뷰 담당 l2w8ci-review, 2026-11-16, 구현 커밋 `db6dc130` 기준.

### 확인한 것

- **바뀐 범위.** `git diff --stat 033bb26d..db6dc130`은 이 계획 파일과 `loadtest/poc/bench/src/seat-contract.mjs`(+2, -0)뿐이다. `loadtest/test/**`·`services/**`는 바뀌지 않았다.
- **(1) 사본 `seatKeys`가 운영과 이름·결과가 같은가.** 운영 `services/purchase-svc/src/modules/inventory/adapters/redis-seat-store.ts` 189~235행과 사본 8~32행을 이름 하나씩 맞대 봤다. 둘 다 23개(bitmap·hold·expiry·prio·quota·stream·idem·epoch·ctl·rel·secver·ordered·paused·fence·autoCur·section·ctlEvents·rebuild·failed·sweep·sessions·saleSweep·sessionSweep)이고, 키 글도 23개 모두 글자까지 같다. 더한 줄 `prio: (e) => \`s:{event:${e}}:prio\``는 운영 195행과 같고, docs/data.md 2520행 `s:{event:E}:prio`(Sorted Set, 우선 구매 보류 만료 인덱스)와도 맞다. BAT-430(`16b60af1`)이 운영 `seatKeys`에 더한 것은 `prio` 한 줄뿐이고(`git show 16b60af1 -- …/redis-seat-store.ts`), 그 뒤 운영 파일을 바꾼 `7a076b5c`(R-587)·`f79a5855`(R-604)는 `seatKeys` 표에 이름을 더하지 않고 `seatKeys.prio`를 쓰는 연산만 더했다. 빠진 키는 없다.
- **운영 `hold`·`expire`·`dueExpiries`·`replay`가 `prio`를 쓰지 않는가.** 운영 파일에서 `seatKeys.prio`가 나오는 곳은 `holdPriority`(334행)·`releasePriority`(364행)·`pin`(525행, R-604 B1-01)·`restorePriority`(602행)·`duePriorityExpiries`(854행)·`expirePriority`(894행)뿐이다. 측정 도구가 운영과 견주는 `hold`(271행)·`replay`(474행)·`dueExpiries`(759행)·`expire`(792행)에는 없다. 그래서 사본 `holdCall`·`expireCall`·`replayCommand`·`dueRangeCommand`·`dueHoldCommand`에 `prio`를 넣지 않은 것이 맞다.
- **(2) `prio`를 더한 것이 측정 도구의 다른 동작에 주는 영향.** `grep -rn seatKeys loadtest`로 쓰는 곳을 모두 봤다. `seatKeys`를 돌며(`Object.keys`·`Object.entries`) 키를 만드는 곳은 대조 시험(`loadtest/test/poc-seat.test.mjs` 114~115행)과 운영 쪽을 부르는 `loadtest/test/fixtures/seat-store-probe.mjs` 103행뿐이다. 측정 본체 `loadtest/poc/bench/src/seat-shard.mjs`는 `bitmap`·`expiry`·`stream`·`epoch`·`secver`·`ctl`·`ctlEvents`·`section`을 이름으로 골라 쓸 뿐(94·132·155~158·192·199·460~465행) 표를 돌지 않는다. 사본 안 함수도 이름으로만 부른다. 오버셀 검사기(460~463행, 비트 수 = `expiry` 멤버 수)는 `prio`를 읽지 않으며 측정이 우선 구매 보류를 만들지 않으므로 결과가 달라지지 않는다. 뜻하지 않은 영향은 없다.
- **(3) '이번에 안 함' 판단.** 타당하다. 측정 도구는 일반 홀드·만료만 만들고, 시험 통과에 우선 구매 연산 대조가 필요 없다. `tools/ci/changes.mjs` 48행의 `loadtest` 규칙 정규식에 `services/purchase-svc/`가 없는 것도 확인했다(그래서 BAT-430 때 이 잡이 건너뛰어졌다). 대조 시험의 probe는 `redis-seat-store.ts`를 불러 그 안에서 `inventory/adapters/`·`inventory/domain/`을 줄줄이 가져오고(바깥 `@nestjs/common`·`@peaket/platform`은 가짜로 바꾼다, probe 4·34행), `sweep-rules.mjs`는 `application/expiry-sweeper.ts`와 견주므로, 계획이 권한 경로(adapters·domain·expiry-sweeper)가 이 시험이 기대는 운영 파일을 다 덮는다. 범위 규칙과 그 시험(`tools/ci/changes.test.mjs` BSL060)을 함께 바꾸는 다른 성격의 일이라 따로 하는 것도 맞다.
- **(4) 같은 꼴로 어긋난 사본.** 계획 3절 표 밖에서 `services/`를 가리키는 loadtest 파일도 봤다. `loadtest/lib/users.mjs`(토큰 쿠키 이름, `changes.mjs` 규칙에 원문 `token.ts`가 있다), `loadtest/e2e/v0-rehearsal.e2e.mjs`(검사기 빌드를 읽는다, 사본 아님), `loadtest/poc/bench/lua/entry-number-batch.lua`(`loadtest/poc/run.mjs` 38행이 측정 전에 쓰는 생성물이고 `.gitignore` 36행으로 커밋되지 않는다, `git ls-files`로도 확인), `loadtest/run.mjs`·`loadtest/scenarios/v1-search.js`(설명 주석에서 가리킬 뿐). 커밋된 PoC Lua는 `hold.lua`·`release.lua`·`snapshot.lua` 셋뿐이고 운영 사본이 아니다. 같은 꼴로 어긋난 사본은 더 없다.
- **머리 주석.** 사본 1~5행·7행 주석은 고친 뒤에도 사실과 맞다.
- **시험.** `cd D:/ticketpass-lane2 && node --test "loadtest/test/*.test.mjs"`(Node 24.18.0): tests 468, pass 468, fail 0.

### 지적

- **RVL-1(낮음) 계획 4절의 우선 구매 연산 목록에 `pin`이 빠졌다.** 무엇: 4절은 `prio`를 쓰는 운영 연산을 `holdPriority`·`releasePriority`·`restorePriority`·`duePriorityExpiries`·`expirePriority`로 적었지만, R-604(`f79a5855`, B1-01)부터 일반 묶기 `pin`도 KEYS에 `prio`를 넣는다. 근거: `services/purchase-svc/src/modules/inventory/adapters/redis-seat-store.ts` 512~526행(KEYS 마지막이 `seatKeys.prio(e)`). 지금은 측정 도구가 `pin`을 부르지도 대조하지도 않아(`loadtest/poc/bench/src/seat-contract.mjs`에 묶기 호출 함수가 없다) 이번 고침에는 영향이 없다. 권하는 처리: 고치지 않는다. 뒤에 측정 도구에 묶기 대조를 더할 때 `prio`가 KEYS에 들어간다는 점을 정리 목록 문구에 함께 적는다.
- **RVL-2(낮음) 대조 시험이 입력 한 벌로만 불러 본다.** 무엇: 계획 4절 마지막·7절 M4와 같은 내용이다. `seatKeys` 23개를 모두 `('E1', 'X2', 'Y3')` 한 번으로만 견주므로, 인자를 보지 않고 고정 글을 돌려주는 틀린 사본도 통과한다(`prio`만이 아니라 23개 모두). 근거: `loadtest/test/poc-seat.test.mjs` 95·115행. 권하는 처리: 이 묶음에서는 고치지 않는다. 정리 목록에 "seatKeys 대조를 회차·계정·색인이 다른 입력 두 벌로 부른다"로 올린다.
- **RVL-3(낮음) `changes.mjs` 정리 목록 문구를 조금 넓힌다.** 무엇: 계획이 권한 문구("purchase-svc 좌석 저장소 경로")는 맞지만, 이 시험은 운영 Lua 원문(`hold-lua.ts`·`expire-lua.ts`)과 상수(`domain/expiry.ts`·`domain/hold.ts`)도 견준다. 근거: `tools/ci/changes.mjs` 48행 정규식에 `services/purchase-svc/`가 없다. `loadtest/poc/seat-lua.mjs`가 `inventory/adapters/`의 Lua를, `loadtest/poc/bench/src/sweep-rules.mjs`가 `application/expiry-sweeper.ts`를 원문으로 삼는다. 권하는 처리: 정리 목록 문구를 "loadtest-check 범위에 `services/purchase-svc/src/modules/inventory/`(adapters·domain)와 `…/application/expiry-sweeper.ts`를 더하고 BSL060 시험에 그 경로를 넣는다(W8-L2-ci-loadtest에서 드러남)"로 적는다.
- **RVL-4(낮음, 이 묶음 밖) docs/data.md의 `s:{event:E}:prio` 행이 뒤처졌다.** 무엇: 그 행은 "만료 작업이 이 집합의 지난 것을 푸는 연결은 후속"이라고 적었지만, R-587(`7a076b5c`)이 `duePriorityExpiries`·`expirePriority`를 넣었고 만료 반복이 이를 부르며 시작 코드가 잇는다. 근거: `docs/data.md` 2520행, `services/purchase-svc/src/modules/inventory/adapters/redis-seat-store.ts` 851·891행, `services/purchase-svc/src/modules/inventory/application/expiry-sweeper.ts` 401~403행, `services/purchase-svc/src/start.ts` 483행. 계획 4절은 이 문장을 판단 근거로 쓰지 않아 이번 판단에는 영향이 없다. 권하는 처리: 이 묶음에서는 정본을 고치지 않고, 감독이 정리 목록에 "data.md §3 prio 행의 '연결은 후속'을 R-587 반영으로 고친다"로 올린다.

## 검증

**판정: 통과.** 틀린 구현 여섯 가운데 다섯(M1·M2·M3·M5·M6)을 대조 시험이 잡았다. 계획이 미리 살아남는다고 본 M4 하나만 살아남았고, 이것은 고친 코드의 결함이 아니라 시험이 입력 한 벌로만 불러 보는 약한 곳(리뷰 RVL-2와 같은 것)이다. 검증 담당 l2w8ci-verify, 2026-11-16, 구현 커밋 `db6dc130` 기준, Node 24.18.0.

### 기준선

- 고친 상태: `cd D:/ticketpass-lane2 && node --test "loadtest/test/*.test.mjs"` → tests 468, pass 468, fail 0.
- 고치기 전 상태: `git show 81d9f4e3:loadtest/poc/bench/src/seat-contract.mjs`를 잠깐 그 자리에 쓰고 `node --test loadtest/test/poc-seat.test.mjs` → tests 39, pass 38, fail 1. 실패한 것은 'ST27_NFR003_seatKeys는 운영 seatKeys와 이름과 결과가 같다' 하나이고, 이름 목록 비교(114행)에서 운영에만 있는 `'prio'`가 차이로 나왔다. CI가 낸 실패와 같다. 바로 되돌렸다.

### 틀린 구현

각 틀린 구현은 사본 `loadtest/poc/bench/src/seat-contract.mjs`에만 잠깐 넣고 `node --test loadtest/test/poc-seat.test.mjs`(39개)를 돌린 뒤 `git checkout -- loadtest/poc/bench/src/seat-contract.mjs`로 되돌렸다. 되돌릴 때마다 `git status --short`가 비어 있는 것을 확인했다. M5·M6은 검증 담당이 더한 것이다.

| 번호 | 무엇 | 결과 | 실패한 시험 |
|---|---|---|---|
| M1 | `prio` 줄(설명 주석 포함)을 다시 뺀다(고치기 전으로) | 잡힘(38/39) | 'ST27_NFR003_seatKeys는 운영 seatKeys와 이름과 결과가 같다'(114행 이름 목록, 차이 `'prio'`) |
| M2 | 키 글을 틀리게: `prio: (e) => \`s:event:${e}:prio\``(해시 태그 `{}` 빠짐, 다른 Redis 칸으로 간다) | 잡힘(38/39) | 같은 시험(115행 값 비교, `'s:event:E1:prio'` 대 `'s:{event:E1}:prio'`) |
| M3 | 이름만 틀리게: `priority: (e) => \`s:{event:${e}}:prio\`` | 잡힘(38/39) | 같은 시험(114행 이름 목록, `'priority'` 대 `'prio'`) |
| M4 | 회차를 보지 않음: `prio: () => 's:{event:E1}:prio'` | **살아남음**(39/39) | 없음 |
| M5 | 옆 줄을 베끼다 꼬리를 안 고침: `prio: (e) => \`s:{event:${e}}:expiry\`` | 잡힘(38/39) | 같은 시험(115행 값 비교, `…:expiry` 대 `…:prio`) |
| M6 | `expiry`와 `prio`의 키 글을 서로 바꿔 적음(이름은 둘 다 있음) | 잡힘(33/39) | 같은 시험과 함께 `expiry`를 쓰는 대조 다섯: holdCall 운영 대조, expireCall 계약 차례, expireCall 운영 대조, 만료 1단계 운영 대조, 만료 1단계·릴레이 흉내 명령 모양 |

- M1·M2·M3·M5는 계획 7절 기대대로 seatKeys 대조 시험 하나만 깼고 홀드·만료 대조 등 다른 시험은 깨지 않았다. M6이 다른 시험 다섯도 깬 것은 `expiry` 키를 홀드·만료 호출이 실제로 쓰기 때문이며(`holdCall`·`expireCall`·만료 1단계 명령), 측정 도구가 쓰는 키가 틀리면 여러 겹으로 잡힌다는 뜻이다.
- **M4(살아남음)는 시험의 약한 곳이다.** 대조 시험이 `seatKeys` 23개를 모두 `fn('E1', 'X2', 'Y3')` 한 번으로만 견주므로(`loadtest/test/poc-seat.test.mjs` 115행), 인자를 보지 않고 `E1` 글을 그대로 돌려주는 틀린 사본도 통과한다. 리뷰 RVL-2와 같은 것이다. 이 묶음의 고친 줄(`prio: (e) => \`s:{event:${e}}:prio\``)은 인자를 쓰므로 막는 결함은 아니다. 정리 목록 후보: "seatKeys 대조를 회차·계정·색인이 다른 입력 두 벌로 부른다(W8-L2-ci-loadtest 검증 M4, 리뷰 RVL-2)".

### 함께 본 것

- **운영과 사본 직접 견줌.** 운영 `services/purchase-svc/src/modules/inventory/adapters/redis-seat-store.ts` 189행 `seatKeys`와 사본 `seatKeys`에서 '이름 => 키 글'을 뽑아 정렬해 `diff`로 견줬다. 둘 다 23개이고 글자까지 차이가 없다.
- **코드가 구현 커밋 그대로인가.** 틀린 구현을 모두 되돌린 뒤 `git status --short`가 비어 있고 `git diff --stat db6dc130 -- loadtest services`도 비어 있다.
- **마지막 전체 시험.** `node --test "loadtest/test/*.test.mjs"` → tests 468, pass 468, fail 0.

## 담당 표

아직 없음.
