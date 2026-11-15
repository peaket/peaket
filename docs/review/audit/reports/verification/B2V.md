# R-595 수정 검증(독립) · B2V

- 검증 대상: `D:\ticketpass-lane3`의 `c868de7e`(R-595, "B2 감사 중간 2건 — q:rst TTL·우선 입장 lst를 바로잡는다")
- 작업 위치: `D:\ticketpass-lane3` (읽기 전용 원칙. 변이 검증을 위해서만 잠시 고쳤다가 `git checkout --`로 원복)
- 금지 준수: 메인 `D:\ticketpass`·소유자 파일 접근 없음, 수정·커밋·푸시 없음, Docker 없음
- 최종 상태: HEAD `c868de7e` 그대로, 내가 만진 두 파일(`booking-restriction-lua.ts`, `memory-admission-store.ts`)은 `git diff` 0. `git status`에 남은 11줄은 **다른 작업자가 같은 worktree에서 동시에 고치는 `deploy/`·`core-svc/` 파일**로, 내가 만진 것이 아니다(파일 수정 시각 10:42, 내 세션 중). 손대지 않았다.

## 판정 요약

| 항목 | 판정 |
| --- | --- |
| `q:rst` TTL: ACTIVE+until → until+1일 | 통과(코드) |
| `q:rst` TTL: LIFTED/until 없음 → now+30일 | 통과(코드) |
| `until`이 2일 전이면 키 삭제 | 통과(코드·Redis 의미) |
| 판 번호 가드 유지 | 통과 |
| `eligibilityLists`: 계정이 든 키만·글자 차례·중복 없음 | 통과(양 어댑터) |
| `#priority`가 1~10개를 `sign`에 실음 | 통과 |
| GATED/INVALID/후보 없음 경계 | 통과 |
| 시험이 TTL 변이(until+2일)를 잡는가 | **실패(변이 생존)** → B2V-01 |
| 시험이 `eligibilityLists` 변이(남의 키 포함)를 잡는가 | 통과(변이 사망) |

**결론: 수정 자체는 의도대로 들어갔다. 다만 TTL 값(until+1일)을 확인한다고 이름 붙은 시험이 실제로는 `PTTL > 0`만 보므로, 그 값을 2일로 잘못 고쳐도 시험이 통과한다.**

## 발견

### [중간] B2V-01: "TTL이 until+1일"을 확인하는 시험이 `PTTL > 0`만 보아 TTL 값을 고정하지 못한다
- 영역/배치: `q:rst` TTL 시험(R-595, `test-int/booking-restriction.int.test.ts`)
- 위치: `services/queue-svc/test-int/booking-restriction.int.test.ts:68-83`(특히 `:71`), 대상 코드 `services/queue-svc/src/modules/admission/adapters/booking-restriction-lua.ts:14-22`
- 증거:
  - 시험 이름은 "ACTIVE+미래 until이면 TTL이 until+1일이고 …"인데, ACTIVE 건은 `expect(await pttl(a)).toBeGreaterThan(0)` 한 줄뿐이다. `until`은 `2_000_000_000_000`(2033년)이라 `until+1일`이든 `until+2일`이든 PTTL이 둘 다 0보다 크다.
  - 실측 계산: `now=1794707087562`, `until=2000000000000`일 때 `until+1일` PTTL = `205,379,312,438`ms, `until+2일` PTTL = `205,465,712,438`ms. 둘 다 `> 0`이다.
  - 변이 실행: `booking-restriction-lua.ts`의 `expireAt = untilMs + day`를 `untilMs + 2 * day`로 바꾸고 `pnpm --filter @peaket/queue-svc exec vitest run test/booking-restriction.test.ts`를 돌렸다 → **2/2 통과**(단위 시험은 Lua를 실행하지 않는다). Lua를 실행하는 유일한 시험은 test-int인데 Docker가 금지라 실행하지 못했고, 그 시험의 단언은 위와 같이 `> 0`이라 변이를 잡지 못한다. 변이는 원복했다.
  - 같은 이유로 "끝 시각이 없는 ACTIVE → 30일"(`:85-95`)도 PTTL을 아예 보지 않는다. 실제로 TTL 값을 고정하는 단언은 LIFTED의 `29일 < PTTL < 31일`(`:76-77`) 하나뿐이다.
- 왜 문제인가: R-595의 커밋 메시지와 정합 점검 표는 "ACTIVE until+1일 PTTL"을 확인했다고 적지만, 시험은 그 값을 검증하지 않는다. 개인정보 파기 기한을 정하는 상수를 잘못 고쳐도(예: +2일) CI가 초록으로 남아, B2-1에서 지적한 보존 기한 위반이 조용히 되살아날 수 있다. TTL이 짧아지는 쪽(예: until 그대로)도 잡지 못해, 제한이 끝나기 전에 사본이 사라져 입장이 열릴 수도 있다.
- 재현/확인: 위 변이 + 단위 시험 통과, PTTL 두 값 계산. test-int는 Docker 필요로 미실행.
- 제안 수정: ACTIVE 건을 `expect(await pttl(a)).toBeGreaterThan(UNTIL + DAY - Date.now() - 60_000)`·`toBeLessThan(UNTIL + DAY - Date.now() + 60_000)`처럼 창으로 고정한다(또는 `PEXPIRETIME`으로 절대 시각을 읽어 `UNTIL + DAY`와 ±수 초 비교). "until 없음" 건도 29~31일 창을 더한다. 시험 이름이 주장하는 값을 실제로 단언하게 만드는 최소 수정이다.
- 확신도: 높음

### [낮음] B2V-02: 새 Redis 어댑터 `eligibilityLists`(Lua)를 실행하는 시험이 없다
- 영역/배치: 우선 구매 입장 `lst`(GAT-135) — 운영 어댑터
- 위치: `services/queue-svc/src/modules/admission/adapters/admission-lua.ts:277-286`(`ELIGIBILITY_LISTS_LUA`), `services/queue-svc/src/modules/admission/adapters/redis-admission-store.ts:142-149`
- 증거: `eligibilityLists`를 부르는 시험은 `test/priority-grant.test.ts` 하나이고, 그 시험은 `MemoryAdmissionStore`를 쓴다. `test-int/**`에서 `eligibilityLists`를 부르는 곳이 없다(검색 결과 0). 즉 운영 경로인 Redis Lua는 단위·통합 어느 쪽에서도 실행되지 않는다. 나는 코드 대조로 `KEYS[i]` ↔ `ARGV[i+1]`, `ARGV[1]`=계정 ID, 후보 키가 모두 `{event:E}` 해시 태그라 한 슬롯인 점, `table.sort`의 글자 차례를 확인했고 틀린 곳은 찾지 못했다.
- 왜 문제인가: 지금은 맞지만, 이 5줄짜리 Lua의 인수 순서나 `SISMEMBER` 대상이 퇴행해도 시험이 잡지 못한다. 그 경우 우선 구매 입장 토큰의 `lst`가 비거나 틀려, 선예매 회차에서 우선 구매가 `sale-policy-denied`로 막힌다(B2-2가 되살아난다).
- 재현/확인: 시험 파일 검색. test-int는 Docker 필요로 미실행.
- 제안 수정: `test-int/booking-restriction.int.test.ts` 옆에 `RedisAdmissionStore.eligibilityLists` 시험을 하나 더한다(계정이 든 키 2개·남의 키 1개·없는 키 1개 → 글자 차례 2개만, 중복 후보는 한 번만). Docker 없이도 돌게 하려면 메모리 어댑터와 같은 표를 `test/`에 두되, Lua 자체는 test-int에 둔다.
- 확신도: 높음(공백은 확실, 코드 정확성은 대조로 확인)

### [낮음] B2V-03: 같은 판 재전송으로는 TTL이 다시 서지 않아, "끝 없는 ACTIVE"가 30일 뒤 조용히 만료된다
- 영역/배치: `q:rst` TTL과 판 번호 가드의 상호작용
- 위치: `services/queue-svc/src/modules/admission/adapters/booking-restriction-lua.ts:5`(가드), `:14-22`(TTL), 문서 `docs/data.md:2470`
- 증거: 가드가 `if current and tonumber(current) >= tonumber(ARGV[4]) then return 0 end`로 먼저 끝나므로, 같은 판 번호의 재전송은 `PEXPIREAT`에 닿지 않는다. 문서는 "줄어든 수명은 ops-svc 작업 워커가 10분 [가정]마다 ACTIVE인 제한을 같은 판 번호로 다시 보내 다시 세운다"라고 적는다. `until`이 있는 ACTIVE는 TTL이 `until+1일`(절대 시각)이라 재전송이 필요 없지만, **`until`이 없는 ACTIVE**는 최초 쓰기 때 `now+30일`로 굳고 재전송으로 늘지 않아 30일 뒤 키가 사라진다. 그 뒤 queue-svc는 그 계정의 입장을 403으로 막지 않는다. purchase-svc `s:rst`에는 TTL이 없어 주문 생성의 확인은 계속 막으므로, 문서가 이미 적은 "홀드는 잡을 수 있다"는 남는 한계로 떨어진다(좌석을 홀드 시간만큼 묶는 정도).
- 왜 문제인가: 무기한 예매 제한(끝 시각 없음)이 30일째에 대기열 층에서 해제된다. 돈·좌석이 직접 뚫리지는 않지만, 운영자가 '제한 중'이라고 믿는 계정이 대기열을 통과해 좌석을 잡을 수 있고, 문서가 약속한 복구 절차가 실제로는 동작하지 않는다. 덧붙여 TTL 계산의 `now`는 주입된 `CLOCK`이 아니라 `Date.now()`라, 파드 시계가 크게 틀리면 LIFTED/끝 없는 ACTIVE의 수명이 어긋난다.
- 재현/확인: 코드 대조. ops-svc에는 `SetBookingRestriction`를 부르는 작업 워커가 아직 이 저장소에 없다(검색 0건) — 그래서 지금은 재전송 자체가 없고, 워커가 붙는 순간 이 어긋남이 드러난다.
- 제안 수정: (a) 같은 판이어도 `until`이 없는 ACTIVE면 `PEXPIREAT now+30일`만 갱신하고 `changed`는 false로 둔다(값은 바꾸지 않는다). 또는 (b) 문서에서 "다시 세운다"를 빼고, 무기한 제한은 30일마다 판 번호를 올려 다시 보내도록 ops 쪽 계약을 정한다. (a)가 최소 수정이다.
- 확신도: 중간(문서 문장의 해석 여지 + ops 워커 미구현)

## 실행한 시험

원복 후 기준선(모두 통과):

```
& pnpm.cmd --filter @peaket/queue-svc exec vitest run test/booking-restriction.test.ts test/priority-grant.test.ts test/eligibility-schedule.test.ts
→ Test Files 3 passed (3), Tests 15 passed (15)
```

변이 1 — `memory-admission-store.ts`의 `eligibilityLists`가 계정 구성원을 보지 않고 후보 키를 모두 돌려주게 바꿈:

```
& pnpm.cmd --filter @peaket/queue-svc exec vitest run test/priority-grant.test.ts
→ FAIL: expected [ 'member', 'staff', 'vip' ] to deeply equal [ 'member', 'staff' ]
→ Tests 1 failed | 9 passed (10)
```

→ 변이 사망(시험이 잡음). `git checkout --`로 원복, `git diff` 0 확인.

변이 2 — `booking-restriction-lua.ts`의 `untilMs + day`를 `untilMs + 2 * day`로 바꿈:

```
& pnpm.cmd --filter @peaket/queue-svc exec vitest run test/booking-restriction.test.ts
→ Test Files 1 passed (1), Tests 2 passed (2)
```

→ 변이 생존(단위 시험은 Lua를 실행하지 않음). Lua를 실행하는 test-int는 `startValkey()`가 `docker run`을 부르므로(`test-int/valkey.ts:18`) Docker 금지 지침에 따라 실행하지 않았다. 원복 후 `git diff` 0 확인.

## 확인했으나 문제 없음으로 본 것

- **TTL 계산**: ACTIVE+`until`이면 `until + 86,400,000`, 그 밖(LIFTED·`until` 없음)이면 `ARGV[5] + 30일`. `until`이 2일 전이면 `PEXPIREAT` 인자가 1일 전이라 Redis가 키를 즉시 지운다. `read`는 모든 칸이 nil이면 `undefined`를 돌려주므로 지워진 키는 '제한 없음'이 아니라 '사본 없음'으로 읽힌다.
- **판 번호 가드**: `current >= ver`면 `HSET`·`PEXPIREAT` 전에 0을 돌려준다. 옛 판이 TTL을 늘리거나 지운 키를 되살리지 못한다(지워진 키에 옛 판이 오면 다시 쓰지만 `until`이 과거라 다시 즉시 지워진다).
- **원자성**: `HSET`·`HDEL`·`PEXPIREAT`가 Lua 한 번이라 중간 상태가 없다.
- **`eligibilityLists` 내용**: 후보를 `Set`으로 중복 제거하고, `SISMEMBER`/`has`로 계정이 든 키만 남기며, Lua `table.sort`·JS `sort()` 모두 글자 차례다. 후보 키 문자 집합이 `[a-z0-9-]`라 두 정렬이 같은 순서를 낸다. 후보가 없으면 Redis를 부르지 않고 `[]`다.
- **`#priority` 경계**: 일정이 없으면 후보 `undefined` → `lst` 없음, `NONE`이면 후보 `[]` → `lst` 없음, `INVALID`면 `candidateEligibilityLists`가 `undefined` → `lst` 없음(일반 입장과 같은 규칙), GATED인데 계정이 어느 명단에도 없으면 `[]` → `lst` 없음. `1 <= lists.length <= 10`일 때만 `sign`에 싣는다. `parseEligibility`가 `eligLists`와 모든 창 `lists`의 합집합을 10개로 제한하므로 10개 초과는 설정 단계에서 `INVALID`가 되어 도달하지 않는다(방어 가드가 한 겹 더 있는 셈).
- **서비스 간 계약**: queue-svc `ELIG_LIST_KEY`와 purchase-svc `LIST_KEY`가 둘 다 `^[a-z0-9-]{3,32}$`라, queue-svc가 실은 `lst` 원소를 purchase-svc가 모양 위반(401)으로 거절하지 않는다.
- **장애 처리**: 새로 추가된 `eligibilityLists` 읽기가 `QueueStoreUnavailable`을 던지면 `admission.controller.ts:65`가 503 `dependency-unavailable`(Retry-After 1초)로 바꾼다. 500이 아니다.
- **`AdmissionStore` 구현**: `implements AdmissionStore`는 메모리·Redis 둘뿐이고 둘 다 새 메서드를 갖는다(타입 구멍 없음).
- **시험 실행 결과**: 원복 후 `booking-restriction`·`priority-grant`·`eligibility-schedule` 15건 통과. 변이 1은 잡았고 변이 2는 잡지 못했다.

## 남은 위험

1. **B2V-01**대로 ACTIVE TTL 값이 시험으로 고정되지 않았다. 지금 코드는 `until+1일`로 맞지만, 회귀를 막는 그물은 없다.
2. **B2V-02**대로 운영 Redis Lua `eligibilityLists`는 실행 시험이 없다. 지금은 대조상 맞다.
3. **B2V-03**대로 무기한 ACTIVE 제한은 30일 뒤 대기열 층에서 풀린다(주문 층은 purchase-svc가 계속 막음). ops 재전송 워커가 붙을 때 계약을 다시 맞춰야 한다.
4. test-int(Valkey)를 Docker 금지로 실행하지 못했다. TTL·삭제 동작은 코드와 Redis 의미로 판정했고, 실제 Valkey 8.1에서의 `PEXPIREAT` 과거 시각 삭제는 표준 동작이지만 실행 증거는 아니다.
5. 같은 worktree에서 다른 작업자가 `deploy/`·`core-svc/`를 동시에 고치고 있었다. 내 변이는 `services/queue-svc` 두 파일에만 닿았고 원복했지만, 이후 그 작업이 커밋되면 HEAD가 움직일 수 있다.
