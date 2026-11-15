# R-621 queue 회귀 시험 독립 검증 · B2TA

- 검증 대상: `6f203fd3` (R-621, "test(queue): B2 회귀 시험 — q:rst TTL·우선 입장 lst를 정본 계약으로 고정한다")
- 기준: `b2da7828` (R-621이 develop에 병합된 커밋), 작업 위치 `D:\ticketpass-audit-ro2` (`git checkout --detach b2da7828`)
- 원칙: production 코드는 변이 검증을 위해서만 잠시 고쳤고, 매번 `git checkout HEAD -- <파일>`로 원복했다. 커밋·푸시·합치기 없음.
- 시작 시 `git status --short`: 출력 없음(깨끗함). 종료 시에도 출력 없음. HEAD는 `b2da7828` 그대로.

## 판정: **통과**

| 확인 항목 | 결과 |
| --- | --- |
| 새 시험이 수정 전 결함을 잡는가 | 통과 — `c868de7e^`에서 단위 5/5·test-int 4/8 실패, `78d5decf^`에서 test-int 2/8 실패 |
| 변이 1: `until+1일` → `until+2일` | 새 시험은 통과, **기존 시험**(R-615, 같은 파일 `:74`)이 실패. 회귀 그물 전체로는 잡힘 |
| 변이 2: 끝 없는 ACTIVE 30일 → 0일 | 통과 — 새 시험 `:94`가 `expected -2`로 실패 |
| 변이 2: 끝 없는 ACTIVE 30일 → 60일 | 통과 — 새 시험 `:94`가 `expected 5183999994 to be < 2678400000`으로 실패 |
| 변이 3: `eligibilityLists` 인수 순서 뒤집기 | 통과 — 새 어댑터 시험이 `args` 불일치로 실패 |
| 변이 4: 명단 읽기 실패를 조용히 `[]`로 삼키기 | 통과 — 새 503 시험이 `expected 200 to be 503`으로 실패 |
| 시험 품질(정본 계약·결합도·기존 시험 약화) | 대체로 통과. 아래 3.4 공백 참조 |
| queue 단위 시험 전체 | 통과 — 41파일 693건 |
| test-int `booking-restriction.int.test.ts` | 통과 — 8건, Valkey 컨테이너 정리됨 |
| typecheck(queue-svc / 루트) | 통과 — queue `tsc --noEmit` exit 0, 루트 turbo 42/42 |
| 루트 lint | 통과 — exit 0 |

새 시험 6건(단위 5 + test-int 1)은 HEAD에서 모두 초록이고, 요구 변이를 5회 실행해 새 시험이 4회를 죽였다. 남은 1회(`until+2일`)는 R-615가 이미 넣은 기존 시험이 죽인다. 새 시험의 적용 범위(끝 시각 없는 ACTIVE)를 생각하면 정상이다.

## 1. 수정 전 결함 재현

### 1.1 R-595 이전(`c868de7e^`)으로 대상 소스 되돌리기

되돌린 파일 7개:

```
services/queue-svc/src/modules/admission/adapters/admission-lua.ts
services/queue-svc/src/modules/admission/adapters/booking-restriction-lua.ts
services/queue-svc/src/modules/admission/adapters/memory-admission-store.ts
services/queue-svc/src/modules/admission/adapters/redis-admission-store.ts
services/queue-svc/src/modules/admission/adapters/redis-booking-restrictions.ts
services/queue-svc/src/modules/admission/application/confirm-admission.ts
services/queue-svc/src/modules/admission/domain/ports.ts
```

`pnpm vitest run test/priority-admission-lists.test.ts test/eligibility-lists-adapter.test.ts`:

```
Test Files  2 failed (2)
     Tests  5 failed (5)
```

시험별 증거:

| 시험 | 실패 지점 | 메시지 |
| --- | --- | --- |
| `priority-admission-lists` > 후보 상한 10개까지… | `:92` `expect(claims.lst).toEqual(LISTS)` | `AssertionError: expected undefined to deeply equal [ 'list-01', …, 'list-10' ]` — `lst` 클레임 자체가 없다 |
| `priority-admission-lists` > 명단 사본 읽기가 실패하면… | `:108` `expect(res.statusCode).toBe(503)` | `AssertionError: expected 200 to be 503` — 실패를 삼키고 입장을 열어 버린다 |
| `eligibility-lists-adapter` 3건 | 각 `eligibilityLists(...)` 호출 | `TypeError: … eligibilityLists is not a function` — R-595 이전에는 포트·구현이 없다 |

`pnpm vitest run --config vitest.integration.config.mjs test-int/booking-restriction.int.test.ts`:

```
Test Files  1 failed (1)
     Tests  4 failed | 4 passed (8)
```

새 시험의 실패 지점:

```
FAIL  … > 끝 시각이 없는 ACTIVE는 30일 TTL이고, 같은 판 재전송이 그 30일을 다시 세운다
AssertionError: expected -1 to be greater than 2505600000
 ❯ test-int/booking-restriction.int.test.ts:94:19
     94|     expect(first).toBeGreaterThan(29 * DAY);
```

`PTTL = -1`은 키가 만료 없이 남아 있다는 뜻이다. R-595 이전에는 `PEXPIREAT` 자체가 없어 30일 TTL이 걸리지 않는다. 같은 실행에서 기존 TTL 시험·같은 판 TTL 시험·`ELIGIBILITY_LISTS` 시험도 함께 실패했다(총 4건).

원복: `git checkout HEAD -- <7개 파일>` → `git status --short` 출력 없음.

### 1.2 R-615 이전(`78d5decf^`)으로 `booking-restriction-lua.ts` 되돌리기

`pnpm vitest run --config vitest.integration.config.mjs test-int/booking-restriction.int.test.ts`:

```
Test Files  1 failed (1)
     Tests  2 failed | 6 passed (8)
```

새 시험의 실패 지점:

```
FAIL  … > 끝 시각이 없는 ACTIVE는 30일 TTL이고, 같은 판 재전송이 그 30일을 다시 세운다
AssertionError: expected 991 to be greater than 2505600000
 ❯ test-int/booking-restriction.int.test.ts:104:21
    104|     expect(rearmed).toBeGreaterThan(29 * DAY);
```

첫 쓰기의 30일 TTL은 통과하고(`:94`), `PEXPIRE 1000` 뒤 같은 판 재전송이 TTL을 다시 세우지 않아 991ms가 남은 채 실패한다. R-615가 고친 결함(같은 판 재전송이 `PEXPIREAT`에 닿지 않음)을 새 시험이 정확히 잡는다. 기존의 "같은 판 재전송은 … TTL만 다시 세우며" 시험도 같은 이유로 실패했다.

원복: `git checkout HEAD -- services/queue-svc/src/modules/admission/adapters/booking-restriction-lua.ts` → `git status --short` 출력 없음.

## 2. 변이 검증

모든 변이는 해당 파일만 고친 뒤 시험을 돌리고 `git checkout HEAD -- <파일>`로 원복했다. 변이 사이의 `git status --short`는 매번 깨끗했다.

| # | 변이 | 위치 | 실행 시험 | 결과 | 잡은 시험 / 증거 |
| --- | --- | --- | --- | --- | --- |
| 1 | `untilMs + day` → `untilMs + 2 * day` | `booking-restriction-lua.ts:11` | test-int 8건 | 1 failed / 8 | **기존 시험** `:74` — `expected 176399069 to be less than or equal to 90005000`. 새 시험은 통과(끝 시각 없는 가지만 봄) |
| 2a | `nowMs + 30 * day` → `nowMs + 0 * day` | `booking-restriction-lua.ts:12` | test-int 8건 | 5 failed / 8 | **새 시험** `:94` — `expected -2 to be greater than 2505600000`(즉시 삭제). 기존 LIFTED·until 없음 시험도 실패 |
| 2b | `nowMs + 30 * day` → `nowMs + 60 * day` | `booking-restriction-lua.ts:12` | test-int 8건 | 2 failed / 8 | **새 시험** `:94` — `expected 5183999994 to be less than 2678400000`. 기존 LIFTED 시험도 실패 |
| 3 | `[i.accountId, ...listKeys]` → `[...listKeys, i.accountId]` | `redis-admission-store.ts:146` | 어댑터 3건 | 1 failed / 3 | **새 어댑터 시험** — `args`가 `[ACCOUNT, 'vip', 'member']`와 불일치 |
| 4 | `eligibilityLists(...).catch(() => [])` | `confirm-admission.ts:203` | priority 2건 | 1 failed / 2 | **새 503 시험** — `expected 200 to be 503` |
| 5 (보조) | `candidateEligibilityLists`와 메모리 store의 `.sort()` 제거 | `queue.ts:131`, `memory-admission-store.ts:211` | priority 2건 | **2 passed / 2** | **생존** — 아래 공백 1 |

변이 1은 새 시험이 아니라 기존 시험이 잡는다. 새 시험은 "끝 시각 없는 ACTIVE"의 30일 TTL과 재전송에 초점이 있고, `until+1일` 값은 R-615가 이미 넣은 `:73-74` 창 단언이 지킨다. 회귀 그물 전체로는 변이가 죽으므로 게이트에는 문제가 없다.

## 3. 시험 품질

### 3.1 기존 시험 약화·삭제 없음

`git show --numstat 6f203fd3`:

```
1   0   docs/PROGRESS.md
20  0   services/queue-svc/test-int/booking-restriction.int.test.ts
54  0   services/queue-svc/test/eligibility-lists-adapter.test.ts
115 0   services/queue-svc/test/priority-admission-lists.test.ts
```

추가만 있고 삭제는 0줄이다. 기존 `booking-restriction.int.test.ts`의 7건은 그대로 두고 새 1건만 더했다. `priority-grant.test.ts`의 기존 `lst` 시험도 건드리지 않았다.

### 3.2 정본 계약을 보는가

- **상태·에러**: `ADMITTED` 200, 503 + `retry-after: 1` + `type`이 `dependency-unavailable`로 끝남, 503 응답에 `admissionToken`이 없음. `admission.controller.ts:65`의 정본 매핑과 일치한다.
- **TTL**: test-int가 `PTTL`을 29~31일 창으로 단언하고, `PEXPIRE 1000`으로 수명을 줄인 뒤 같은 판 재전송이 30일을 다시 세우는지 본다. `docs/data.md:2473`의 "ACTIVE면 끝 시각 + 1일(끝이 없으면 30일), LIFTED면 30일" 및 "10분마다 다시 보내 다시 선다"와 맞는다.
- **`lst`**: 후보 10개 전부를 `claims.lst`로 정확히 비교하고, `claims.prio`도 함께 확인한다. `docs/features/queue-admission.md:261`의 "글자 차례·중복 없음, 1~10개" 및 GAT-135의 `prio` 계약을 본다.
- **저장 칸**: test-int가 `HMGET st,until,rid,ver`와 `store.read`로 "같은 판 재전송은 칸을 바꾸지 않는다"를 확인한다. `changed:false`도 함께 본다.

### 3.3 구현 세부 결합

- HTTP 시험은 실제 `AppModule` 조립, 실제 ES256 서명·`readAdmissionToken`으로 토큰을 읽는다. 사설 필드(`#priority`)나 내부 함수명을 단언하지 않는다.
- `store.db.elig(...)`는 명단 사본을 심는 픽스처다. 기존 `priority-grant.test.ts:112-125`, `eligibility-cases.ts:234-261`과 같은 패턴이고, 단언은 HTTP 응답·토큰 클레임에만 있다.
- `eligibility-lists-adapter.test.ts`는 의도적으로 white-box다. `evalScript`의 `keys`·`args`, `ARGV[1]`=계정 ID, 한 해시 슬롯을 단언하는데, 이것이 이 어댑터↔Lua 계약 자체다. 다만 `admissionKeys.elig`를 그대로 써서 키 문자열 자체를 고정하지는 않는다(해시 태그 1개인지만 별도 확인). 적절한 수준이다.
- 503 시험의 `Proxy`는 공개 포트 메서드 `eligibilityLists`만 실패시킨다. 도메인 포트를 통한 장애 주입이라 구현 교체에도 견딘다.

### 3.4 공백

1. **HTTP 수준의 정렬·중복 제거가 독립적으로 자극되지 않는다.** `LISTS`가 이미 글자 차례(`list-01`…`list-10`)이고 중복도 없다. `candidateEligibilityLists`와 메모리 store의 `.sort()`를 모두 없앤 보조 변이 5가 **2/2 통과**했다. 정본의 "글자 차례"를 이 시험만으로는 반증할 수 없다. Redis Lua의 정렬·중복 제거는 test-int `:135`가 `['gamma-list','alpha-list','alpha-list']`를 넣어 `['alpha-list','gamma-list']`를 기대하므로 실제 운영 경로는 덮인다. 메모리 store의 정렬은 시험 대역이라 영향이 낮다.
2. **새 시험은 `until+2일` 변이를 잡지 않는다.** 기존 R-615 시험이 잡으므로 전체 그물은 닫혀 있지만, 새 시험 이름/주석이 "TTL"을 넓게 말하지 않도록 범위를 오해할 여지는 있다.
3. (낮음, 문서-코드 어긋남) `docs/features/queue-admission.md:261`은 `lst`를 "입장 Lua 안에서 읽어"라고 적지만, 우선 구매 입장은 `confirm-admission.ts:203`에서 별도 `eligibilityLists` 호출로 읽는다. 관측되는 계약(내용·503)은 같고 새 시험이 그 동작을 고정한다. 원자성 요구가 아니라면 문서 문장만 다듬으면 된다.

## 4. 실행한 시험·게이트

원복 후 기준선:

```
cd services/queue-svc
pnpm test
→ Test Files 41 passed (41), Tests 693 passed (693)

pnpm vitest run --config vitest.integration.config.mjs test-int/booking-restriction.int.test.ts
→ Test Files 1 passed (1), Tests 8 passed (8)
→ 그 실행 직후 docker ps 비어 있음(내 컨테이너 정리 확인)

pnpm typecheck
→ tsc --noEmit, 오류 없음(exit 0)

cd ../..
pnpm typecheck
→ Tasks: 42 successful, 42 total (39 cached), Time 5.009s

pnpm lint
→ eslint …, 오류 없음(exit 0)
```

참고: 처음 `pnpm test:integration -- booking-restriction`는 인수 필터가 먹지 않아 test-int 19개 파일을 모두 돌렸고, 다른 세션이 띄운 `postgres:18-alpine` 컨테이너와 자원이 겹쳐 무관한 13건이 100ms Redis 마감 초과로 실패했다. 대상 파일만 따로 돌린 결과는 위와 같이 8/8이고, 내 실행이 남긴 컨테이너는 없다. 이 실패는 대상 시험의 문제가 아니라 환경 경합이다.

## 5. 남은 공백

1. HTTP 우선 입장 시험이 정렬·중복 제거를 독립적으로 자극하지 못한다(보조 변이 생존). 필요하면 `LISTS`를 일부러 뒤섞고 중복 후보를 넣어 `lst`를 비교하면 된다.
2. `until+1일` 값은 새 시험이 아니라 기존 R-615 시험이 지킨다. 새 시험의 범위를 좁게 읽어야 한다.
3. 메모리 store의 `.sort()`는 어떤 시험도 직접 고정하지 않는다(운영 경로는 Redis).
4. 문서의 "입장 Lua 안에서" 표현과 우선 구매 입장의 별도 읽기 호출이 어긋난다(동작 영향 없음).
5. R-621 커밋 메시지가 남긴 B2-3(계정 ID 모양 오류 500)은 이번 시험 범위 밖이며, 새 시험도 다루지 않는다.

## 6. 작업 뒤 상태

```
$ git rev-parse HEAD
b2da78289ce58ddc4e133ac60492b8d5c13f6581

$ git status --short
(출력 없음)

$ git diff --stat HEAD
(출력 없음)

$ docker ps --format "{{.ID}} {{.Image}} {{.Names}}"
(내 실행 직후: 출력 없음. 최종 확인: 다른 세션이 띄운 postgres:18-alpine 1개)
```

production 변경 없음, 커밋·푸시·합치기 없음. 변이용 수정은 모두 원복되었다. 최종 `git status --short`와 `git diff --stat HEAD`는 둘 다 출력이 없다. 검증 중 다른 세션이 띄운 valkey/postgres/moto 컨테이너가 간헐적으로 보였으나 내가 만든 것이 아니어서 손대지 않았다. 내 test-int 실행은 매번 afterAll에서 컨테이너를 지웠고, 각 실행 직후 `docker ps`가 빈 것으로 확인했다.
