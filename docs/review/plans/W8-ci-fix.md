# 묶음 계획: W8-ci-fix(develop CI 날짜 지남 실패 고침)

- **무엇**: 묶음을 시작할 때 만든 작업 목록이다(docs/architecture.md §8.6, ADR-0270 '계획'). 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane3-ci`, 가지 `fix/lane3-w8-ci-date`, 출발점 `origin/develop` `92448f1d`. 2026-11-16 작성.
- **범위**: 시험 파일만 고친다. 제품 코드는 바꾸지 않는다. 그래서 이 묶음에는 구현 담당이 없고, 계획 → 시험 → 검증 순서로 간다.
- **알린 곳**: develop CI 실행 43799265031의 node 잡 실패(2026-11-16 04:00Z 기록).

## 계획

### 1. 원인

`services/purchase-svc/test-int/priority-hold.int.test.ts`는 기준 시각을 고정 날짜로 박아 둔다.

```ts
const NOW = Date.parse('2026-11-14T08:00:00.000Z');
```

이 값으로 보류 만료 시각(`expiresAtMs: NOW + DAY`, 곧 2026-11-15 08:00Z)과 보관 시한(`keepUntilMs: NOW + 2 * DAY`, 곧 2026-11-16 08:00Z)을 만든다. 그런데 우선 구매 보류 Lua(Redis 안에서 한 번에 도는 작은 프로그램)는 시험이 넣은 가짜 시계(시험이 시각을 정해 넣는 시계)를 보지 않는다. Redis 서버가 아는 실제 지금 시각(`redis.call('TIME')`)을 읽어 견준다.

- 시각을 읽는 곳: `services/purchase-svc/src/modules/inventory/adapters/priority-hold-lua.ts` 45~48행(`TIME`), 57행(`keep <= now or exp <= now`이면 `EXPIRED`).
- `RedisSeatStore`에 넘긴 가짜 시계는 경고 문의 시각과 `retireEvent`에만 쓴다(`redis-seat-store.ts` 260행 주석). Lua 안의 시각은 늘 Redis 시각이다.

그래서 실제 시각이 2026-11-15 08:00Z를 넘자 보류가 처음부터 '이미 지난 것'으로 판정되어 `EXPIRED`가 나왔다. CI에서 실패한 시험은 넷이다.

| 시험 | 실패 모양 |
|---|---|
| S-T37 ①_같은_좌석을_PRIORITY로_잡고_prio_인덱스에만_넣는다 | `{ kind: 'EXPIRED' }`가 `{ kind: 'OK', … }`와 다르다(41행) |
| S-T37 ④_우선_주문의_홀드_확인은_같은_권리_ID의_PRIORITY_홀드만_OK다 | 같은 꼴(61행) |
| S-T37 ⑦_회수_해제는_좌석을_바로_돌려주고_RELEASED를_남긴다 | 같은 꼴(77행) |
| S-T37 ⑦_다른_계정이나_다른_권리_ID로는_PRIORITY_보류를_풀지_못한다 | 같은 꼴(91행) |

날짜가 지나서 터진 것이고 제품 결함이 아니다. 한 가지 더 있다. 같은 파일의 'S-T37 ⑦_prio_만료_회수는_지난_보류만_풀고_EXPIRED를_남긴다'는 만료 시각은 `Date.now()`로 잡지만 보관 시한은 `NOW + 2 * DAY`(2026-11-16 08:00Z)를 쓴다. 그래서 **오늘 17:00(한국 시각) 뒤에는 다섯째로 실패한다.**

### 2. 같은 꼴 훑기 결과

`services/*/test-int/`와 `packages/*/test-int/`에서 `Date.parse('20…`, `new Date('20…`, `Date.UTC(20…`를 쓰는 파일 94개와, 숫자로 박은 시각(`1_793_…` 꼴) 파일 5개를 봤다. 판정 기준은 "고정 날짜에서 만든 값이 서버의 실제 시각(Redis `TIME`, Redis 절대 만료 `PEXPIREAT`, DB `now()`, 시험이 앱에 넣은 시스템 시계)과 견주어지고, 그 경계가 아직 오지 않았는가"이다.

먼저 서버 실제 시각을 읽는 제품 코드를 찾았다.

- **Redis `TIME`**: purchase-svc 좌석 Lua 전부(`inventory/adapters/*-lua.ts`), `refund/adapters/redis-seat-returns.ts`, queue-svc·admission-ctrl의 Lua.
- **Redis 절대 만료 `PEXPIREAT`(이 시각에 키를 지우라는 명령)**: 위 Lua들, core-svc `queue-sale-eligibility-copy.ts`·`queue-sale-config-store.ts`, identity-svc 세션 Redis 어댑터 셋. 지난 시각을 주면 키가 바로 지워진다.
- **DB `now()`로 견주기**: purchase-svc `drizzle-seat-rebuild.ts`(`expires_at > now()`, `lease_until < now()`), core-svc 검색 보기(`migrations/0009_search.sql`·`0018_search_sale_status.sql`).
- **JWT 검증**: `packages/platform/src/token-verify.ts`·`scanner-auth.ts` 모두 `currentDate`에 주입 시계를 넘긴다. 실제 시각과 견주지 않는다.
- **outbox id**: `packages/platform/src/outbox.ts` 39행이 주입 시계로 UUIDv7을 만든다. 칸(파티션)도 같은 시계로 만들어서 어긋나지 않는다.

지난 고정 날짜(예: 2026-11-05)에 짧은 간격만 더한 값은 이미 경계를 지났다. 오늘 통과하면 앞으로도 같은 결과라 안전하다. 위험한 것은 "고정 날짜 + 며칠"이 아직 미래이면서 서버 시각과 견주어지는 경우다.

#### (가) 오늘·며칠 안에 터짐: 이번에 고친다

| 파일 | 터지는 때 | 까닭 |
|---|---|---|
| `services/purchase-svc/test-int/priority-hold.int.test.ts` | 이미 터짐(2026-11-15 08:00Z), 다섯째는 2026-11-16 08:00Z | 1절 |
| `services/purchase-svc/test-int/cancellation.int.test.ts` | 2026-11-20 01:00Z(한국 시각 10:00) | `NOW = '2026-11-13T10:00:00+09:00'`, `world()`가 `openSale` 보관 시한을 `saleEndsAtMs + DAY` = `NOW + 7 * DAY`로 준다(248행). 반납 알림도 같은 시한(`drizzle-cancellation.ts` 254행). 이 시각이 지나면 Lua의 `PEXPIREAT`가 비트맵·세대 키를 바로 지우고, 반납은 `NOT_READY`로 아무것도 쓰지 않는다. 그러면 좌석 비트가 1로 남아 352행 `GETBIT … toBe(0)` 같은 반납 단언이 깨진다 |

#### (나) 언젠가 터짐: 정리 목록(이번에 고치지 않는다)

| 파일 | 터지는 때 | 까닭 |
|---|---|---|
| `services/core-svc/test-int/catalog.int.test.ts` | 2026-12-01 ~ 12-24 무렵 | 앱이 시스템 시계(`systemClock`)를 쓰고 회차는 고정 날짜(오픈 12-01, 공연 12-24)다. `GET /v1/events/{id}` 응답의 시각 의존 칸(선예매 여부 등, `get-event-summary.ts` 73~76행)이 바뀔 수 있다. 72행 주석처럼 한 곳은 이미 날짜와 상관없게 짜 두었다 |
| `services/core-svc/test-int/queue-sale-eligibility-copy.int.test.ts` | 2027-01-01 | 명단 사본 만료 `2027-01-01`을 `PEXPIREAT`로 건다. 그 뒤에는 키가 바로 지워져 `PTTL` 단언(45~47행)이 깨진다 |
| `services/core-svc/test-int/shop-notify.int.test.ts` | 2027-01 ~ 03 | 앱이 `clock: systemClock`(48행)이다. '판매 전 상품'을 `saleStartsAt: 2027-03-01`로 만들고 `NOT_STARTED`를 기대한다(156~161행). 연결 회차도 2027-01 고정이다 |
| `services/purchase-svc/test-int/seat-hold-ledger.int.test.ts` | 2031-03 무렵(먼 일) | '먼 회차'를 `2031-03-15`의 UUIDv7로 만들어 칸이 없다는 것을 본다(260행). 가까운 회차는 시스템 시계로 만든다. 그 날짜에 다가가면 칸이 생겨 기대가 바뀐다 |

정리할 때도 같은 방법을 쓴다. 고정 날짜를 "실제 지금 + 간격"으로 바꾸거나, 앱에 가짜 시계를 넣는다.

#### (다) 안전: 서버 시각과 견주지 않거나, 경계를 이미 지나 결과가 고정됨

- **identity-svc 19개**(admin-*·device-sessions·fan-account·fraud-hold·inv-ref-rotation·investigation·login-methods·main-reverification·pid-rotation·reverification-check·staff-invitations·withdrawal): 기준이 지난 날짜(11-04 ~ 11-14)이고 앱에 가짜 시계를 넣는다. JWT 검증도 주입 시계를 쓴다. Redis 절대 만료는 이미 지난 시각이라 결과가 바뀌지 않는다.
- **payment-svc 18개**(support.ts 포함): 가짜 시계만 쓰고, payment-svc에는 DB `now()` 비교와 Redis가 없다. payment-deposit의 11-20도 가짜 시계 안의 값이다.
- **ops-svc 11개, ticket-svc 8개, trust-svc 3개, invariant-checker 1개, packages/platform 2개**: 가짜 시계, 서버 시각 비교 없음. ticket-svc·trust-svc의 Redis 사용에는 `TIME`·`PEXPIREAT`가 없다.
- **core-svc 나머지 20개**: 앱에 가짜 시계를 넣거나(`clock` 주입) 표에 행을 직접 넣고 시각을 견주지 않는다(rls·export-audit·webhook-lease·review-*). 시스템 시계를 쓰는 둘도 단언이 날짜와 상관없다. seatmap-templates 194행은 승인 공연이지만 403(승인 이력 실무자)을 잠금 판정보다 먼저 낸다(`seatmap-layouts.ts` 3행 순서). seatmap-import는 초안 공연이라 오픈 뒤 잠금이 걸리지 않는다(`geometryLocked`는 승인 시각이 없으면 false).
- **purchase-svc 나머지**: event-refund·event-refund-grpc·sale-control·order-fixtures 사용 파일은 DB만 쓰고 `now()` 비교 경로를 타지 않는다. sale-state·seat-sales·measure-auto-s19-s20·sale-policy는 기준을 `Date.now()`에서 잡는다(이미 바른 꼴).
- **숫자 시각 5개**(booking-restrictions·seat-store·invariants·immutable-anchor·verdict-evidence): 지난 시각이거나 가짜 응답 안의 값이다.

### 3. 고치는 방법(시험 쪽만)

원칙: 기준 시각(`NOW`)을 **서버 실제 시각에서** 잡고, 나머지 값은 지금처럼 `NOW`에서 더하고 뺀다. 그러면 단언이 보는 관계(`NOW + DAY`, `NOW - 1` 등)는 그대로이고 `expect(` 줄은 하나도 바뀌지 않는다. 서버 시각은 Valkey(Redis 호환 서버)의 `TIME`으로 읽는다. 이미 쓰는 꼴이 있다(`services/purchase-svc/test-int/accept-e2e.int.test.ts` 136행, `consumers.int.test.ts` 98행).

```ts
const t = (await redis.command(['TIME'], {})) as unknown[];
const serverMs = Number(t[0]) * 1000 + Math.floor(Number(t[1]) / 1000);
```

`Date.now()`보다 이 값이 낫다. Lua가 견주는 시계가 바로 이것이고, 개인 PC의 Docker Desktop은 컨테이너 시계가 PC 시계와 어긋날 때가 있다.

**① `priority-hold.int.test.ts`**
1. `const NOW = Date.parse('2026-11-14T08:00:00.000Z');`를 `let NOW: number;`로 바꾼다.
2. `beforeAll`에서 `createHotRedis` 뒤, `new RedisSeatStore(…, fakeClock({ now: NOW }))` 앞에 위 두 줄로 `NOW = serverMs`를 넣는다.
3. 맨 위 주석에 "Lua가 Redis TIME과 견주므로 기준은 서버 시각에서 잡는다"를 한 줄 더한다.
4. 다른 줄은 손대지 않는다. B1-01과 ⑦ 만료 회수의 `Date.now()`는 그대로 둔다. GAT135의 `NOW - 1`은 서버 시각보다 앞이라 여전히 `EXPIRED`다.

**② `cancellation.int.test.ts`**
1. 이 파일은 기준을 한국 시각 10:00에 맞춰 두었다(`+09:00`). 날짜 경계를 보는 규칙이 있을 수 있으니 시각은 유지한다. 서버의 한국 날짜에서 **3일 전 10:00(한국 시각)**으로 잡는다. 오늘 CI가 통과한 상태(기준이 실제보다 약 75시간 앞)와 같은 범위(62~86시간 앞)가 된다. 그래서 `NOW + DAY`류는 늘 지난 값이고 `NOW + 7 * DAY`는 늘 3일 넘게 남는다.
   ```ts
   const KST = 9 * HOUR;
   const dayStart = Math.floor((serverMs + KST) / DAY) * DAY - KST; // 서버 기준 한국 날짜 0시(UTC 밀리초)
   NOW = dayStart - 3 * DAY + 10 * HOUR;
   ```
2. `const NOW`를 `let NOW: number;`로 바꾼다. `beforeAll`에서 `startValkey`·`createHotRedis`를 `ensureOutboxPartitions(admin, fakeClock({ now: NOW }))`(100행)보다 먼저 두고, 서버 시각을 읽어 `NOW`를 정한 뒤 outbox 칸과 107행 가짜 시계를 만든다.
3. 모듈 맨 위에서 `NOW`로 미리 계산한 상수가 있으면 함께 `beforeAll` 뒤(함수 안)로 옮긴다. `world()` 등 함수 안에서 쓰는 곳은 그대로 둔다.
4. `expect(` 줄은 바꾸지 않는다.

**제품 코드는 바꾸지 않는다.** Lua가 Redis 시각을 보는 것은 설계대로다(docs/features/seat-hold.md 117행: Lua 안의 시각은 Redis `TIME`).

### 4. 시험 담당: 실패 확인

시험 담당은 고치기 전에, 시험이 정말 날짜 때문에 실패하는지 지금 코드에서 재현한다(Docker 필요).

1. **priority-hold, 지금 그대로**: 고치기 전 파일을 돌리면 1절 표의 넷이 `EXPIRED`로 실패해야 한다. 2026-11-16 08:00Z 뒤라면 '⑦ prio 만료 회수'까지 다섯이다. CI 43799265031과 같은 줄(41·61·77·91행)인지 맞춘다.
2. **cancellation, 미래를 당겨 재현**: 오늘은 통과하므로 고정 날짜를 잠깐 `'2026-11-05T10:00:00+09:00'`로 바꿔 돌린다. 그러면 `NOW + 7 * DAY` = 11-12로 이미 지난 값이 된다. 좌석 반납을 보는 시험(352행 `GETBIT … toBe(0)` 등)이 실패해야 한다. 실패한 시험 이름을 기록하고 날짜를 되돌린다.
   - 이 재현에서 아무것도 실패하지 않으면 cancellation은 고치지 않는다. (나)로 옮기고 검증 기록에 남긴다.
3. **고친 뒤**: 두 파일을 돌려 모두 통과해야 한다. priority-hold는 7개, cancellation은 지금 통과하는 수와 같아야 한다.
4. **날짜 민감도 확인**: 고친 priority-hold에서 `NOW = serverMs - 2 * DAY`로 잠깐 바꾸면 같은 넷(과 ⑦ 만료 회수)이 다시 실패해야 한다. 시험이 서버 시각과의 관계를 실제로 본다는 증거다. 확인 뒤 되돌린다.

### 5. 검증 담당: 넣어 볼 틀린 구현

각 틀린 구현을 넣어 실패를 확인한 뒤 되돌린다. 하나라도 통과하면 시험이 약한 것이다.

| 번호 | 틀린 구현 | 기대 |
|---|---|---|
| M1 | priority-hold의 기준을 다시 `Date.parse('2026-11-14T08:00:00.000Z')`로 되돌린다 | 1절 표의 넷(오늘 17:00 뒤라면 다섯) 실패 |
| M2 | priority-hold의 기준을 `serverMs - 2 * DAY`로 둔다(서버 시각을 읽긴 하나 지난 쪽으로 어긋남) | 같은 넷 실패 |
| M3 | cancellation의 기준을 지난 고정 날짜 `'2026-11-05T10:00:00+09:00'`로 되돌린다(원래 값 11-13은 11-20 01:00Z 전까지 통과하므로 더 이른 날짜를 쓴다) | 4절 2에서 기록한 반납 시험 실패 |

함께 본다.
- 고친 diff에 `expect(` 줄이 없어야 한다. 단언 값이 바뀌지 않았다는 확인이다.
- diff가 두 시험 파일과 이 계획·검토 기록 밖으로 나가지 않아야 한다. 제품 코드(`src/`)는 바뀌지 않아야 한다.

## 실패 확인

시험 담당(`l3w8-ci-test`)이 2026-11-16 13:25~13:40(한국 시각, 04:25~04:40Z) 개인 PC Docker Desktop에서 돌렸다. 모든 명령은 `services/purchase-svc` 폴더에서 `npx vitest run --config vitest.integration.config.mjs <파일>`이다. 공용 패키지는 설정의 별칭(alias)이 `src`를 바로 읽어 dist가 필요 없었다.

### 고치기 전(출발점 `92448f1d`의 시험 그대로)

| 파일 | 결과 | 실패한 시험과 줄 |
|---|---|---|
| `test-int/priority-hold.int.test.ts` | **7개 중 4개 실패**, 3개 통과 | S-T37 ①(41행)·④(61행)·⑦ 회수 해제(77행)·⑦ 다른 계정·권리 ID(91행). 넷 다 `expected { kind: 'EXPIRED' } to match object { kind: 'OK', … }`. CI 43799265031과 같은 시험·같은 줄이다 |
| `test-int/cancellation.int.test.ts`(원래 날짜 11-13) | 13개 모두 통과 | 없음. 11-20 01:00Z 전이라 아직 안 터진다 |
| 같은 파일, 날짜만 잠깐 `'2026-11-05T10:00:00+09:00'`로 당김 | **13개 중 1개 실패** | GAT080_취소는_티켓키폐기·좌석RETURNED·Redis비트해제·결제사부분취소를_한번에_한다, 352행 `GETBIT … toBe(0)`에서 `expected 1 to be +0` |

- **까닭(priority-hold)**: 1절 그대로다. 우선 구매 보류 Lua가 `redis.call('TIME')`으로 실제 지금을 읽는데, 시험의 만료 시각 `NOW + DAY`(11-15 08:00Z)가 이미 지나 처음부터 `EXPIRED`가 났다. 돌린 때가 08:00Z 전이라 '⑦ prio 만료 회수'는 아직 통과했다(다섯째는 아님).
- **까닭(cancellation)**: 2절 (가) 그대로다. 보관 시한 `NOW + 7 * DAY`가 지난 값이 되자 판매 열기 Lua의 `PEXPIREAT`가 세대 키를 바로 지웠고, 반납이 `NOT_READY`로 아무것도 쓰지 않아 좌석 비트가 1로 남았다. 날짜를 당겨 실패가 재현되었으므로 **cancellation은 (나)로 옮기지 않고 이번에 고친다.** 날짜는 재현 뒤 `git checkout`으로 되돌렸다.

### 고친 뒤

3절 방법대로 두 파일의 기준 시각만 Valkey `TIME`에서 잡았다. priority-hold는 `NOW = serverMs`, cancellation은 서버 기준 한국 날짜의 3일 전 10:00(한국 시각)이다(오늘 돌리면 원래 값 11-13 10:00과 같다). cancellation은 Valkey를 먼저 띄우고 그 뒤에 outbox 칸을 만든다. 고친 diff에 `expect(` 줄은 없다.

| 파일 | 결과 |
|---|---|
| `test-int/priority-hold.int.test.ts` | **7개 모두 통과** |
| `test-int/cancellation.int.test.ts` | **13개 모두 통과**(고치기 전과 같은 수) |

- `npx tsc --noEmit -p services/purchase-svc/tsconfig.json`도 통과했다(`@peaket/shuffle` dist를 먼저 빌드). eslint 설정은 `test-int`를 보지 않는다.
- 주의: 두 파일을 한 번의 vitest로 함께 돌렸을 때 cancellation의 시험 둘이 `RedisDeadlineError: Redis 호출이 마감 100ms를 넘겼다`(world()의 `openSale`)로 한 번 실패했다. 개인 PC에서 컨테이너 셋(PostgreSQL·Valkey 둘)이 겹친 부하 탓이고, 따로 돌리면 둘 다 통과했다. 날짜와는 상관없다.

### 날짜 민감도(손으로 한 번 보고 되돌림)

| 바꾼 기준 | 결과 |
|---|---|
| priority-hold `NOW = Date.parse('2026-11-14T08:00:00.000Z')`(M1 꼴) | 7개 중 4개 실패(고치기 전과 같은 넷) |
| priority-hold `NOW = serverMs - 2 * DAY`(M2 꼴) | 7개 중 **5개** 실패. 같은 넷과 '⑦ prio 만료 회수'(131행). 보관 시한 `NOW + 2 * DAY`가 서버 지금과 같아져 `keep <= now`이기 때문이다. 5절 M2의 기대 '같은 넷'은 '넷 이상'으로 읽는다 |
| cancellation `NOW = Date.parse('2026-11-05T10:00:00+09:00')`(M3 꼴, 고친 파일에서) | 13개 중 1개 실패. 위와 같은 반납 시험(고친 파일 기준 359행) |

셋 다 확인 뒤 고친 값으로 되돌렸다. 시험이 서버 시각과의 관계를 실제로 본다는 뜻이다.

## 검증

검증 담당(`l3w8-ci-verify`)이 2026-11-16 13:32~13:34(한국 시각, 04:32~04:34Z) 개인 PC Docker Desktop에서 돌렸다. 바탕은 가지 `fix/lane3-w8-ci-date`의 `4df40392`(시험 담당이 고친 뒤)다. 모든 명령은 `services/purchase-svc` 폴더에서 `npx vitest run --config vitest.integration.config.mjs <파일>`이고, 두 파일은 한 번에 하나씩 따로 돌렸다(함께 돌리면 부하로 100ms 마감을 넘긴 기록이 있다). 틀린 구현은 시험 파일의 기준 시각 한 줄만 잠깐 바꿨고, 돌린 뒤마다 `git checkout -- <파일>`로 되돌렸다.

### 기준선(바꾸지 않은 상태)

| 파일 | 결과 |
|---|---|
| `test-int/priority-hold.int.test.ts` | 7개 모두 통과 |
| `test-int/cancellation.int.test.ts` | 13개 모두 통과 |

### 틀린 구현

| 번호 | 바꾼 것 | 돌린 시험 | 결과 |
|---|---|---|---|
| M1 | priority-hold `NOW = serverMs` → `NOW = Date.parse('2026-11-14T08:00:00.000Z')`(고정 날짜로 되돌림) | `test-int/priority-hold.int.test.ts` | **잡힘**. 7개 중 4개 실패: S-T37 ①·④·⑦ 회수 해제·⑦ 다른 계정·권리 ID, 넷 다 `expected { kind: 'EXPIRED' } to match object { kind: 'OK', … }`. 돌린 때가 08:00Z 전이라 다섯째('⑦ prio 만료 회수')는 아직 통과했다(계획 5절 기대와 같다) |
| M2 | priority-hold `NOW = serverMs` → `NOW = serverMs - 2 * DAY`(서버 시각을 읽되 지난 쪽으로 어긋남) | `test-int/priority-hold.int.test.ts` | **잡힘**. 7개 중 5개 실패: M1의 넷과 '⑦ prio 만료 회수'. 보관 시한 `NOW + 2 * DAY`가 서버 지금과 같아져 `keep <= now`이기 때문이다(실패 확인 절과 같다) |
| M3 | cancellation `NOW = dayStart - 3 * DAY + 10 * HOUR` → `NOW = Date.parse('2026-11-05T10:00:00+09:00')`(지난 고정 날짜) | `test-int/cancellation.int.test.ts` | **잡힘**. 13개 중 1개 실패: GAT080_취소는_티켓키폐기·좌석RETURNED·Redis비트해제·결제사부분취소를_한번에_한다, 359행 `GETBIT … toBe(0)`에서 `expected 1 to be +0`(4절 2에서 기록한 반납 시험과 같다) |

**합계: 넣은 틀린 구현 3개, 잡힘 3개, 살아남음 0개.**

### 함께 본 것

- **diff 범위**: `git diff 92448f1d 4df40392`는 두 시험 파일과 이 계획 파일만 바꾼다. `services/purchase-svc/src`는 바뀌지 않았다. 시험 파일 diff에 `expect(` 줄은 없다(0줄).
- **남은 고정 날짜**: 두 시험 파일에서 `Date.parse`·`Date.UTC`·`new Date('…')`·`20xx-xx` 꼴 날짜·숫자로 박은 시각을 찾았다. 기준 시각을 쓰지 않는 고정 날짜는 남아 있지 않다. 두 파일이 불러오는 도우미(`test-int/valkey.ts`·`postgres.ts`)에도 없다.
- **참고(날짜가 아닌 시계 어긋남)**: priority-hold의 'B1-01_결제_중_pin이_있으면_만료_회수가_좌석을_풀지_않는다'(108행)와 '⑦ prio 만료 회수'(130·133행)는 기준을 서버 시각이 아니라 PC 시계 `Date.now()`에서 잡는다. 계획 3절 ①-4대로 그대로 둔 것이고 날짜가 지나도 깨지지 않는다. 다만 Lua는 Redis `TIME`과 견주므로, 컨테이너 시계가 PC 시계와 크게 어긋나면(⑦은 200ms, B1-01은 60초 넘게) 흔들릴 수 있다. 이번 실행에서는 통과했다. 고칠 일은 아니고 흔들림이 보이면 볼 자리로 남긴다.
- **정리**: 실행 전후 `docker ps -a` 목록이 같다(이 실행이 남긴 컨테이너 없음). 되돌린 뒤 `git status`는 이 계획 파일 밖에 깨끗하다.

## 리뷰

리뷰 담당(`l3w8-ci-review`)이 2026-11-16에 `git diff 92448f1d..4df40392`와 위 계획·실패 확인·검증 절만 보고 대조했다. 시험은 돌리지 않았다. 줄 번호는 `4df40392` 기준이다.

**판정: 합쳐도 된다.** 막는 지적은 없다. 지적 넷은 모두 낮음이고, 이번 묶음에서 고치지 않고 정리 목록으로 넘겨도 된다.

### 확인한 것(문제 없음)

- **서버 시각 읽기**: `Number(t[0]) * 1000 + Math.floor(Number(t[1]) / 1000)`는 Valkey `TIME`의 초·마이크로초를 밀리초로 바꾸는 식이고, Lua가 견주는 식(`priority-hold-lua.ts` 46~48행 `nowSec * 1000 + math.floor(t[2] / 1000)`)과 똑같다. 이미 쓰는 꼴(`accept-e2e.int.test.ts` 136행·`consumers.int.test.ts` 98행)과도 같다. 여기서는 기준을 한 번 정해 두고 움직이지 않으므로, 그쪽처럼 PC 시계와의 차이를 다섯 번 재어 가운데 값을 쓸 필요는 없다.
- **한국 시각 10:00 맞추기**: `Math.floor((serverMs + KST) / DAY) * DAY - KST`는 서버 기준 한국 날짜 0시이고, 공용 패키지의 같은 계산(`packages/platform/src/outbox.ts` 63행 `kstDayStart`)과 같은 식이다. 한국은 서머타임(여름에 시계를 한 시간 당기는 제도)이 없어 늘 맞다. 그래서 `NOW`는 늘 한국 시각 10:00이고 서버 지금보다 62시간(한국 0시에 돌 때)~86시간(23:59에 돌 때) 앞이다.
- **하루 경계**: 자정 직전·직후 어느 쪽에 돌아도 위 범위 안이다. 시험 도중 자정을 넘어도 `NOW`는 `beforeAll`에서 한 번만 정하므로 차이가 몇 분 늘 뿐이다. 이 파일에서 서버 시각과 견주는 값은 기본 회차의 보관 시한 `NOW + 7 * DAY`(늘 82~106시간 남음)와 입장 시작 뒤 두 시험의 `NOW + 2 * HOUR`(늘 지남, W1)뿐이고, 둘 다 범위 안 어디서나 같은 쪽에 선다.
- **날마다 바뀌는 요일**: 고치기 전 `NOW`는 늘 금요일(11-13)이었는데 이제 요일이 날마다 바뀐다. 요일을 보는 곳은 영업일 달력(`refund-policy.ts` 167행 `within24h`)뿐이다. 예매 시각이 `NOW - 12 * DAY`라 그 사이 영업시간은 요일과 상관없이 24시간을 넘어 늘 거짓이다. 남은 일수(329행 `daysBefore: 7`, 441행 `9000`)는 한국 달력일로 세므로 10:00 맞춤 덕에 늘 같다(밤 23시 무렵을 기준으로 잡았다면 `NOW + 2 * HOUR`가 다음 날이 되어 공제율이 바뀌었을 것이다). 단언 값이 요일·시각에 따라 바뀌지 않는다.
- **outbox 칸**: `ensureOutboxPartitions`는 `NOW`의 한국 날짜부터 7일 뒤까지 칸을 만든다(`outbox.ts` 117~124행). 서버 날짜는 그 안(넷째 날)이라 가짜 시계로 쓰든 실제 시계로 쓰든 칸이 있다. `beforeAll`은 Valkey를 먼저 띄우도록 순서만 바뀌었다.
- **DB `now()`**: 취소 경로(`src/modules/refund`)에는 DB `now()` 비교가 없다. 환급 실행기는 시험이 넣은 `nowMs`만 쓴다.
- **단언의 뜻**: diff에 `expect(` 줄이 없다. priority-hold는 `NOW = serverMs`라 작성 때의 관계(만료 `NOW + DAY`는 미래, GAT135의 `NOW - 1`은 과거)를 되살렸고, 서버 시각에 맞추면서 약해진 단언은 없다. GAT135의 `NOW - 1`은 여유가 1ms처럼 보이지만 앞 시험들(⑦의 250ms 기다림 포함)이 먼저 돌아 실제 여유는 수백 ms를 넘는다.
- **같은 파일에 남은 고정 날짜**: 두 파일 모두 없다(검증 절과 같다).
- **제품 코드**: diff는 두 시험 파일과 이 계획 파일뿐이다. `src/`는 그대로다.
- **훑기에서 빠진 곳**: queue-svc·admission-ctrl의 `test-int`에는 고정 날짜가 없다. purchase-svc `sale-policy.int.test.ts` 210행의 `'2026-12-23'`은 core 사본이 덮어쓰고 `layout-seat-map.ts`가 이 값을 시각과 견주지 않으므로 (다) 판정이 맞다.

### 지적

- **W1 (낮음)** `services/purchase-svc/test-int/cancellation.int.test.ts` 50~51·108행(관련 421·433행)
  - 근거: 주석이 '3일 전 10:00'이라고만 하고 왜 3일 전인지 적지 않았다. 까닭은 계획 3절 ②-1(오늘 CI가 통과한 상태와 같은 62~86시간 범위)에만 있다. 이 범위 때문에 입장 시작 뒤 두 시험(421·433행, `eventStartsAtMs: NOW + 2 * HOUR`)은 판매 보관 시한 `NOW + 2 * HOUR`가 늘 지난 값이다. 그래서 `openSale`의 `PEXPIREAT`가 키를 바로 지우고, 좌석 반납은 늘 `NOT_READY` 길로 간다. 두 시험은 Redis를 단언하지 않아 결과가 같고, 고치기 전에도(11-13 12:00 한국 시각 뒤로) 같은 길이었으므로 이번에 약해진 것은 아니다. 다만 이제는 언제 돌려도 그렇다. 주석이 없으면 나중에 누가 기준을 그냥 `serverMs`로 줄이다가 이 길을 바꾸고도 모를 수 있다.
  - 고칠 쪽: 시험 담당. 주석에 "서버보다 62~86시간 앞이라 `NOW + 2 * HOUR`는 늘 지났고 `NOW + 7 * DAY`는 늘 남는다. 입장 시작 뒤 두 시험의 Redis 반납은 `NOT_READY`다"를 한 줄 더한다. 이번 묶음에서 해도 되고 정리 목록으로 넘겨도 된다.
- **W2 (낮음)** `services/purchase-svc/test-int/priority-hold.int.test.ts` 108~111·130~135행
  - 근거: 검증 절 '참고'와 같은 자리이고 한 가지를 더한다. '⑦ prio 만료 회수'는 잡을 때 여유 200ms(컨테이너 시계가 PC보다 앞서면 `priority-hold-lua.ts` 57행에서 `EXPIRED`)만이 아니라, 풀 때도 여유가 약 50ms뿐이다. 250ms 기다린 뒤 `priority-expire-lua.ts` 69행이 '만료 시각 <= Redis 지금'을 보므로, 컨테이너 시계가 PC보다 50ms 넘게 뒤처지면 `released: 0`이 된다. 계획 3절이 `Date.now()` 대신 서버 시각을 고른 까닭(Docker Desktop 시계 어긋남)과 같은 위험이 같은 파일에 남는다. 날짜 지남과는 다른 문제이고 고치기 전부터 있던 것이라 이번 범위 밖이 맞다.
  - 고칠 쪽: 감독(정리 목록). (나) 목록이나 정리 목록에 "B1-01·⑦ 만료 회수의 기준도 서버 시각(`TIME`)에서 잡기"를 한 줄 더한다. '흔들리면 볼 자리'로만 두지 않는다.
- **W3 (낮음)** 이 계획 2절 (나) 표의 `services/core-svc/test-int/catalog.int.test.ts` 줄
  - 근거: 까닭으로 든 시각 의존 칸(선예매 배지 등, `get-event-summary.ts` 76행)을 이 시험은 단언하지 않는다. `GET /v1/events/{id}` 단언(193~194행)은 `toMatchObject`로 eventId·productionId·title·startsAt·sellerName만 보고, 회차 단언(72~73행)은 날짜와 상관없게 짜 두었다. 그래서 '12-01~12-24에 깨진다'는 근거가 약하다. 한편 45행 `saleApprovedAt: 2026-11-20`(오늘 기준 미래)은 표에 없다. 승인 시각을 지금과 견주는 곳은 `geometryLocked`(`seatmap-layout.ts` 326행)뿐이라 이 파일에는 영향이 없어 보이나, 정리 때 함께 본다.
  - 고칠 쪽: 정리 담당. 정리 때 깨지는 단언을 짚어 적거나, 없으면 (다)로 옮긴다. 이번 묶음을 막지 않는다.
- **W4 (낮음, 절차)** 이 계획 2절 (나) 전체
  - 근거: (나) 네 줄은 이 검토 기록(규범 아님) 안에만 있다. 가장 이른 확실한 경계는 `queue-sale-eligibility-copy.int.test.ts`의 2027-01-01(약 6주 뒤)이라 이번에 넘기기에는 맞다. 다만 이 파일에만 두면 이번처럼 그날이 와서야 CI가 알려 줄 수 있다.
  - 고칠 쪽: 감독(기록 담당). 묶음을 합칠 때 (나) 네 줄과 W2를 정리 목록에 터지는 날짜와 함께 옮긴다.

## 담당 표

- 시험만 고치는 묶음이라 구현 담당이 없다(감독 예외 2026-11-16, roles-check `[구성] impl 없음`). 리뷰와 검증은 같은 시각에 따로 띄웠다(검증은 도커 잠금 안에서 먼저 끝남). 감독(기록 커밋 `Role: record`)은 `l3w8-supervisor`. 모두 구현과 같은 모델의 새 맥락이다(OPEN[40] 결정 전). Agent 도구 ID: plan `a1fd309f9cd39f0d6`, test `af92776b4de9692d0`, review `ab89f9f7e16ab165c`, verify `ab752405810d9942f`.

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | l3w8-ci-plan | claude-opus-5-5 | 2026-11-16T13:08+09:00 | 2026-11-16T13:22+09:00 |
| test | l3w8-ci-test | claude-opus-5-5 | 2026-11-16T13:23+09:00 | 2026-11-16T13:31+09:00 |
| review | l3w8-ci-review | claude-opus-5-5 | 2026-11-16T13:32+09:00 | 2026-11-16T13:39+09:00 |
| verify | l3w8-ci-verify | claude-opus-5-5 | 2026-11-16T13:32+09:00 | 2026-11-16T13:35+09:00 |
