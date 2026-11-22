# 작업 계획: W12-datefix(날짜 고정 판매 열기 시험을 실행 시각 기준으로)

- **무엇**: 2026-11-29·12-02/03 같은 절대 날짜를 쓰는 판매 열기 시험이 그날이 지나면 실패할 수 있다. 세 시험 파일의 회차 오픈·시작 시각을 실행 시각 기준 상대값으로 바꾼다. 시험 이름·단언·제품 코드는 그대로다.
- **바탕**: 갈래 5 작업 폴더 `D:/ticketpass-lane5`, 가지 `feature/lane5-W12-datefix`(출발 `e7f15543d`). 2026-11-22 감독 지시와 `docs/lanes/coord.md` 갈래 5 메모(맨 앞 차례, 기한 2026-11-29), 갈래 1 W12-pt36 계획 6절 10·11(고정 날짜와 실제 시계를 함께 쓰는 시험 목록).
- **등급·차례**: B, 시험만 묶음(`Batch-Kind: test-only`, `docs/architecture.md` §8.6 4 '시험만 묶음'): 계획 → 시험 → 리뷰 → 검증. 구현 커밋이 없다. 제품 코드(`services/*/src/`)는 고치지 않는다.
- **지시서·장부**: `node tools/ci/ledger.mjs --batch W12-datefix`는 BUILD_ORDER에 줄이 없어 코드 2다(묶음 표에 없는 시험 고침). 지시서 대신 이 계획과 정본 자리를 읽는다.

## 계획

### 1. 문제

- purchase-svc `test-int/sale-open.int.test.ts`는 오픈을 `2026-11-29T11:00Z`, 시작을 `2026-12-02T10:30Z`로 고정한다. 회차 판정 시계는 `openAt−1ms`이고 `OpenSale`은 `now ≥ saleEndsAtMs`(시작 24시간 전)면 409다. 그날이 지나면 시험의 `now < openAt`(오픈 전) 전제와 판매 종료 계산이 실행 시각과 어긋난다(갈래 1 W12-pt36 조사·coord 2026-11-22 메모, 확인 필요).
- core-svc `test-int/sale-open.int.test.ts`는 `2026-12-02/03`을 고정한다. 이 파일은 `q:cfg`·`q:epoch`의 만료를 실제 Valkey의 `PEXPIREAT`(판매 종료+24시간)로 걸어, 그날이 지나면 키가 사라져 `cfgOf`·`epochOf`가 빈 해시를 돌려주고 rev·node 단언이 깨진다.
- core-svc `test/partner-production.http.test.ts`의 `2026-12-02/03`도 같은 꼴이다. 서비스 시계가 `NOW_MS`(2026-11-05)로 고정이라 즉시 깨지지는 않지만, 회차 날짜가 그 시계 뒤로 지나면 '지금 < 오픈 < 시작−24시간' 일정 규칙이 깨진다.
- 세 파일 모두 실패 날짜가 다가오면 CI가 빨개지고, 그때 고치면 원인을 날짜로 오인하기 쉽다.

### 2. 바꾼 곳과 방식

- purchase: 모듈 상수 `BASE = Date.now() + 7일`. ⑦은 `openAt = BASE`, ⑦b는 `BASE+1일`, ⑨는 `BASE+4일`이고 시작은 `openAt + 3일`이다. 판매 종료 지난 회차는 `saleEndsAtMs = openAt − 30분`으로 두어 `openAt−1ms` 시계에서 409가 나게 한다. 좌석맵 없는 회차도 같은 방식이다.
- core test-int: `startsAtMs(days) = BASE_MS + days일`, `BASE_MS = Date.now() + 7일`. `makeSubmitted`가 ISO 문자열 대신 epoch ms를 받는다. ⑥의 시작 차례는 `[1, 0]`, ⑥b는 `[8, 9]`, ⑨ 실패는 `[2, 3]`·no-layout은 `[4]`다. `startsAtMs`·`saleEndsAtMs`·`PEXPIRETIME` 단언을 같은 값에서 계산한다.
- core HTTP: `openAtIn(n)`·`startsAtIn(n)`이 실행 시각 + n일의 UTC 11:00/10:00을 만든다. 상대 오픈이 수요일 정비 창(03:00~06:30 KST)에 들지 않게 11:00 UTC(20:00 KST)를 쓰고, 시작은 오픈 25일 뒤로 두어 판매 종료(시작 24시간 전)가 오픈 뒤가 된다.
- core test-int의 주입 시계 `NOW = 2026-11-13`은 그대로 둔다. 승인·사본 계산은 그 고정 시계로 판정하고, Valkey 만료만 실제 시계를 쓰기 때문이다.

### 3. 지키는 것

- `openAt−1ms` 경계: `world()`가 `openAt−1`에서 시작해 그 틱이 상태를 바꾸지 않고, `advance(1)` 뒤 다음 틱이 ON_SALE로 바꾼다.
- 판매 종료: 기본 시작은 오픈+3일이라 판매 종료(시작−24시간)가 오픈 뒤다. 지난 회차만 `openAt−30분`에 끝난 것으로 잡는다.
- 시험 이름·단언 구조, 제품 코드, Docker 잠금 규칙(갈래 5가 `lock.sh`로 잡고 놓는다).

### 4. 게이트

- `pnpm --filter @peaket/purchase-svc test:integration test-int/sale-open.int.test.ts`
- `pnpm --filter @peaket/core-svc test:integration test-int/sale-open.int.test.ts`
- `pnpm --filter @peaket/core-svc test test/partner-production.http.test.ts`
- 두 서비스 전체 단위 시험과 typecheck, `python tools/doc-check/check_all.py`, `node tools/ci/roles-check.mjs --base origin/develop --head HEAD`.

## 실패 확인

- 고치기 전 자리: purchase `services/purchase-svc/test-int/sale-open.int.test.ts`가 오픈 `2026-11-29T11:00Z`·시작 `2026-12-02T10:30Z`를, core `services/core-svc/test-int/sale-open.int.test.ts`가 `2026-12-02T10:00Z`·`2026-12-03T10:00Z`를, `services/core-svc/test/partner-production.http.test.ts`가 `2026-12-02T11:00Z`·`2026-12-03T11:00Z`를 고정했다.
- core test-int는 그날이 지나면 확실히 깨진다. `q:cfg`·`q:epoch`의 만료가 실제 시계의 `PEXPIREAT`(판매 종료+24시간)이라 2026-12-04 무렵 키가 사라지고, `cfgOf`·`epochOf`가 빈 해시를 돌려주어 rev '4'·node 'standalone' 단언이 실패한다.
- purchase는 판정 시계를 `openAt−1ms`로 주입하지만, 오픈·시작이 실행 시각보다 과거가 되면 `now < openAt`(오픈 전) 전제와 판매 종료 규칙을 쓰는 자리에서 실행 시각과 어긋난다. 갈래 1 W12-pt36 조사와 coord 2026-11-22 메모가 11-29을 기한으로 적었다(당시 '확인 필요'였고, 이 묶음이 그 위험을 없앤다).
- core HTTP는 주입 시계가 2026-11-05 고정이라 즉시 깨지지는 않는다. 그래도 회차 날짜가 그 시계 뒤로 지나면 같은 일정 규칙(지금 < 오픈 < 시작−24시간)이 깨지는 같은 꼴이라 함께 상대화했다.
- 고치기 전 트리의 빨간 실행은 실패 날짜(11-29·12-02)가 아직 오지 않아 만들지 않았다. 대신 규칙과 날짜의 산술로 실패 조건을 확인했고, 고친 뒤 세 시험을 실행해 통과를 봤다.

## 리뷰

- 리뷰 담당 `lane5-w12datefix-review`, 2026-11-22 10:45~10:58 KST. 본 것: `git diff e7f15543d..HEAD`(계획 `fa50400b`·시험 `5c90ef1d`), 바뀐 세 시험 파일, `services/purchase-svc/src/modules/inventory/application/open-sale.ts`(판매 종료 409)·`domain/sale-state.ts`(UPCOMING→ON_SALE 경계)·`adapters/db/drizzle-event-sale.ts`(Outbox), `services/core-svc/src/modules/catalog/adapters/queue-sale-config-store.ts`(`PEXPIREAT`)·`domain/production.ts`(판매 종료 = 시작−24시간)·`application/create-production.ts`(일정 검사). 시험은 돌리지 않았다(시험 담당·검증 담당 몫).
- 바뀐 파일은 `docs/review/plans/W12-datefix.md`와 시험 세 파일뿐이고 제품 코드(`services/*/src/`) 변경은 없다(갈림점 기준 `git diff --name-only`).
- (1) `openAt−1ms` 경계: purchase `world()`가 `clock = fakeClock({ now: openAt − 1 })`로 서고, ⑦ 첫 시험이 그 틱에서 상태·판이 바뀌지 않음을, `advance(1)` 뒤 틱이 ON_SALE(version 2)로 바꿈을 그대로 단언한다. 상대화는 `openAt` 값만 바꿨고 경계 계산(`openAt − 1`, `advance(1)`)은 손대지 않았다.
- (2) 판매 종료(시작 24시간 전): purchase 기본 `startsAt = openAt + 3일`이라 `saleEndsAtMs = startsAt − 24시간 = openAt + 2일`이고, `openAt−1ms` 시계에서 `now < saleEndsAtMs`다. 지난 회차는 `saleEndsAtMs = openAt − 30분`이라 `now ≥ saleEndsAtMs`로 409 `sale-not-publishable`이 그대로 성립한다. core HTTP는 `startsAtIn(n)`이 오픈 25일 뒤라 `지금 < 오픈 < 시작−24시간 < 시작 < 종료`가 유지된다.
- (3) `PEXPIREAT` 단언: core test-int가 `startsAtMs(2)`로 회차 시작을 잡고, `saleEndsAtMs`는 `startsAtMs(2) − DAY_MS`, TTL은 `startsAtMs(2) − DAY_MS + KEEP_AFTER_SALE_END_MS`로 같은 값에서 계산한다. 값이 서로 다른 출처(문자열·상수)로 갈라지지 않아 만료 단언이 회차 시작과 함께 움직인다.
- (4) core의 주입 시계 `NOW = 2026-11-13`을 남긴 까닭: 이 파일은 승인·사본 쓰기를 고정 시계로 판정해 rev·phase·`#ended` 필터를 결정적으로 만들고, Valkey 만료(`PEXPIREAT`)만 실제 시계를 쓴다. 회차 시작을 `Date.now() + 7일` 뒤로 두면 `NOW`(2026-11-13)는 늘 그보다 앞서 `#ended`가 거짓으로 남고, 실제 시계 쪽 키 만료도 미래다. 그래서 `NOW`는 그대로 두는 것이 맞다.
- (5) core HTTP의 상대 오픈은 UTC 11:00(20:00 KST) 고정이라 수요일 정비 창(03:00~06:30 KST)에 들지 않고, 시각을 11:00/10:00으로 고정해 실행 날짜가 바뀌어도 같은 요일·시각 규칙을 탄다. `production()`에 선택 인자 `startsAt`을 더한 것은 이 두 시험만 상대 시작을 쓰게 하려는 것이고 다른 호출부의 기본값은 그대로다.
- 막는 지적 없음. 낮음 하나: '실패 확인'의 purchase 위험은 갈래 1 조사가 '확인 필요'로 남긴 것이라 단정하지 않고 위험 서술로 두었는데, 상대화로 그 위험 자체가 사라지므로 고칠 것은 아니다.


## 검증

- (검증 담당이 채운다) 앞서 잰 게이트 결과와 새 HEAD에서 다시 확인한 결과.

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | lane5-w12datefix-plan | deepseek-v4.1-flash | 2026-11-22T10:20+09:00 | 2026-11-22T10:31+09:00 |
| test | lane5-w12datefix-test | deepseek-v4.1-flash | 2026-11-22T09:40+09:00 | 2026-11-22T10:40+09:00 |
| review | lane5-w12datefix-review | deepseek-v4.1-flash | 2026-11-22T10:45+09:00 | 2026-11-22T10:58+09:00 |
| verify | lane5-w12datefix-verify | deepseek-v4.1-flash | 2026-11-22T11:02+09:00 | 2026-11-22T11:20+09:00 |
