# 작업 계획: W8-L1-ci-fix2(develop CI 고침: web 서버 묶음 밖 패키지와 부하 시험 점검의 의존성 설치)

- **무엇**: develop CI(실행 43865738562, 커밋 `3256c93f`)에서 실패한 세 잡 `web / budgets`, `loadtest-check / loadtest`, `node / node`를 고치는 일의 작업 목록이다. 셋째(`node / node`)는 감독 결정(2026-11-16)으로 처음 계획 커밋 뒤에 이 묶음에 넣었다(docs/architecture.md §8.6, ADR-0281). 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane1`, 가지 `wave/lane1-w8-cifix2`, 출발점 `origin/develop` `3256c93f`. 2026-11-16 작성. 이 폴더에는 `node_modules`가 있다(뿌리 `yaml` 포함).
- **묶음 ID와 차례**: 묶음 표에 없는 일이라 이 파일 이름 `W8-L1-ci-fix2`를 쓴다. 코드 묶음이고 **정방향 묶음**이다(이 계획 커밋에 `Batch-Order: impl-first`, §8.6 4 세부 '정방향 묶음' 줄). 차례는 계획 → 구현 → 독립 시험 담당의 시험(구현 전 트리 `3256c93f`에서 실패 확인) → 시험 통과 → 리뷰 → 검증 → 기록이다.
- **등급**: B(배포·운영 도구, CI 설정). 틀린 구현 표본은 아래 '틀린 구현 목록'이다.
- **정본**: docs/frontend.md §5.18 '앱 서버 실행'(Next.js 앱 서버 실행 줄. 이 계획 커밋이 `@peaket/platform`과 '키 하나' 문장을 더했다), docs/devops.md §3 워크플로 표 `loadtest-check.yml` 행(이 계획 커밋이 '잠금 파일대로 설치한 뒤 돈다' 문장을 더했다), 같은 표 `tools-check.yml` 행('잠금 파일대로 의존성을 설치한 뒤 돈다', 2026-11-03), ADR-0281 결정 1~3·5.

## 계획

### 1. 원인(감독이 확인한 사실과 이 계획 담당이 다시 본 것)

1. **`web / budgets`**: 시험 'HOT-390 첫 JS 예산: redis는 서버 묶음 밖에 두고 standalone node_modules에서 불러온다'(`apps/web/test-int/standalone-scm.build.test.mjs`)가 '@redis/client가 서버 묶음에 들어 있다'로 실패했다.
   - `apps/web/next.config.ts`의 설정 객체에 `serverExternalPackages` 키가 둘 있다. 38줄은 redis 여섯(갈래 2 HOT-390, `7658d6e1`), 41줄은 `['@peaket/platform']`(BAT-055 HOT-400, `e5b724d3`)이다. 자바스크립트 객체에서 같은 키를 두 번 쓰면 뒤의 값이 앞을 덮으므로 실제 설정은 `['@peaket/platform']`뿐이고, redis가 다시 서버 묶음에 들어갔다. 가지를 다시 올릴(rebase) 때 서로 다른 줄이라 충돌 표시 없이 양쪽이 남았다.
   - 이 꼴을 막을 시험이 있었지만 놓쳤다. `apps/web/server/server-external.test.mjs`의 'HOT-390 V170-R11 …'은 소스에서 정규식으로 **첫** `serverExternalPackages`만 읽어 여섯과 견주므로, 둘째 키가 첫째를 덮어도 통과한다.
   - 린트도 놓쳤다. `next.config.ts`는 `tsconfig.json`의 `include` 밖이라 타입 검사(같은 이름 속성 오류)를 받지 않고, 뿌리 ESLint 설정은 `no-dupe-keys`(객체의 같은 키를 막는 규칙)를 켜지 않았다. 이 계획 담당이 `node node_modules/eslint/bin/eslint.js --rule '{"no-dupe-keys":"error"}'`로 뿌리 lint 범위 전체(apps·packages·services·tools)를 돌려 보니 걸린 곳은 이 41줄 하나뿐이었다.
2. **`loadtest-check / loadtest`**: `loadtest/test/v1.test.mjs`의 PRF215 시험 셋('PRF215_notes는…'(319줄 근처), 'PRF215_코드리뷰M4_…'(337줄 근처), 'PRF215_serving 전진 기록·…')이 `Cannot find package 'yaml' imported from tools/local/gateway-objects.mjs`로 실패했다.
   - 길: 시험이 `../run.mjs`를 늦게 가져옴 → `loadtest/run.mjs` 30줄이 `tools/local/cluster.mjs`를 가져옴 → `cluster.mjs` 29줄이 `tools/local/gateway-objects.mjs`를 가져옴 → 그 7줄이 `yaml`(뿌리 `package.json`의 개발 의존성 `^2.9.1`)을 가져온다. BAT-060(HOT-410)이 이 가져오기를 넣었다.
   - `.github/workflows/loadtest-check.yml`은 의존성을 설치하지 않고 `node --test "loadtest/test/*.test.mjs"`만 돈다. 그래서 `yaml`이 없다.
   - 재현(이 계획 담당, 2026-11-16): `git archive 3256c93f`를 `node_modules`가 없는 빈 폴더에 풀고 `DOCKER_HOST=tcp://127.0.0.1:9`(Docker를 못 찾게 해서 k6 형식 검사를 건너뜀)로 `node --test "loadtest/test/*.test.mjs"` → 시험 443개, 실패 3(위 셋, 모두 `yaml`을 찾지 못함), 통과 440. CI와 같다.
   - 덧붙인 발견: 바뀐 범위 고르기 `tools/ci/changes.mjs`의 `loadtest` 규칙(50줄)은 `tools/local/(cluster|tools|v0-token|v1-stage|v1-objects).mjs`만 보고 `gateway-objects.mjs`를 빼먹었다. `cluster.mjs`가 그 파일을 가져오는데도, 그 파일만 바뀐 가지에서는 `loadtest-check`가 돌지 않는다. BAT-060 가지에서 이 실패가 일찍 드러나지 않은 까닭 가운데 하나로 본다.
3. **`node / node`**: `apps/web/scripts/local-fan-gateway-parity.test.mjs`의 'W7-WIR-06 로컬 gw-fan 대역의 …' 셋(사전 요청 허용 머리·Max-Age, 노출 머리, 구매 경로 `ticket:buy`)이 'gw-fan api에 POST /v1/events/e2e-id-10/holds 라우트가 없다'로 실패했다(시험 970개 가운데 3). 이 폴더에서 `cd apps/web && node --test scripts/local-fan-gateway-parity.test.mjs`로 같은 실패(실패 3, 통과 1)를 다시 봤다.
   - 까닭: 이 시험은 `deploy/gateways/gw-fan.yaml` 하나만 읽어 api 호스트 라우트를 찾는다(17줄 `docs`). BAT-060(`965b8442`, HOT-410)이 api 호스트의 HTTPRoute를 손으로 쓰지 않고 생성기가 만든 `deploy/gateways/gw-fan.routes.yaml`로 옮겼다(정본 docs/infra.md §4.1 '경로별 메서드 생성기'). 지금 `gw-fan.yaml`에는 HTTPRoute 21개와 SecurityPolicy 8개가, `gw-fan.routes.yaml`에는 HTTPRoute 9개가 있고 `/holds` 매치는 생성 파일에만 있다. 라우트를 겨누는 SecurityPolicy(CORS·인가)는 그대로 `gw-fan.yaml`에 있다.
   - 고칠 쪽 확인(이 계획 담당, 2026-11-16): 이 시험 파일의 임시 사본만 '두 파일을 함께 읽게' 바꿔 같은 폴더에서 돌리니 4개 모두 통과했다(사본은 지웠다). 그래서 로컬 대역 `local-fan-gateway.mjs`, 교차 출처 값 `gateway-cors.mjs`, 가짜 API `mock-api.mjs`(제품 쪽 개발 도구)는 정의와 같고, 틀린 것은 시험이 정의를 읽는 범위다.

### 2. 고칠 길과 고른 것

1. **① 한 배열로 합친다(추천 적용 2026-11-16)**: `apps/web/next.config.ts`에 `serverExternalPackages` 키를 **하나만** 두고, 값은 아래 일곱을 한 배열에 그대로 적는다(따로 둔 상수나 펼침으로 만들지 않는다. 시험이 소스를 읽는다).
   - `'redis'`, `'@redis/client'`, `'@redis/bloom'`, `'@redis/json'`, `'@redis/search'`, `'@redis/time-series'`: 정본 docs/frontend.md §5.18 '앱 서버 실행'의 여섯(공유 캐시 처리기, 첫 JS 예산).
   - `'@peaket/platform'`: 같은 줄에 이 계획 커밋이 더한 문장(앱 서버 텔레메트리, HOT-400. OTel SDK가 모듈 읽기를 가로채므로 묶지 않는다). 지금 `apps/partner/next.config.ts`(그것 하나)와 같은 까닭이다.
   - 차례는 redis 여섯 → platform(지금 두 줄의 차례). 주석은 두 까닭(첫 JS 예산, 텔레메트리)을 한 주석으로 모은다. `apps/partner/next.config.ts`는 바꾸지 않는다.
2. **② 고칠 길 셋 가운데 '잡에 설치를 넣기'를 고른다(추천 적용 2026-11-16)**:

   | 길 | 무엇 | 판단 |
   | --- | --- | --- |
   | 가. 잡에 설치를 넣기 | `loadtest-check.yml`에 `tools-check.yml`과 같은 두 단계(`packageManager` 판으로 pnpm 받기, `pnpm install --frozen-lockfile`)를 `node --test` 앞에 넣는다 | **고름** |
   | 나. 늦게 가져오기 | `gateway-objects.mjs`가 `yaml`을 쓰는 함수 안에서만 `await import('yaml')` | 고르지 않음 |
   | 다. yaml 없이 읽기 | Envoy Gateway 설치 파일(여러 문서 YAML)을 직접 짠 읽기로 다룬다 | 고르지 않음 |

   - **CI 시간**: 같은 실행의 `tools-check / tools`에서 pnpm 받기 3초, `pnpm install --frozen-lockfile` 9초였다(실행 43865738562 단계 시각). `loadtest-check`의 시험 단계는 1분이고 잡 상한은 10분이라, 12초쯤 더해도 상한 안이다.
   - **다른 잡과의 일관성**: 2026-11-03 `tools-check`가 설치 없이 돌아 `yaml`을 못 읽은 같은 꼴을 '설치를 넣기'로 고쳤고(docs/devops.md §3 `tools-check.yml` 행), 그 차례를 `tools/ci/check-workflows.test.mjs`의 'tools-check는_잠금파일대로_의존성을설치한뒤에_시험을돈다'가 지킨다. `ci.yml` lint 잡·`spec-check`·`perf-nightly`도 같은 두 단계를 쓴다.
   - **정본이 정한 도구**: `yaml`은 뿌리 개발 의존성으로 잠금 파일에 고정된 도구이고 `tools/ci/gateway-routes.mjs` 등도 쓴다. 설치는 잠금 파일대로만 한다(docs/devops.md §4.4). 길 나는 `gatewayInstall`·`readGatewayObjects`를 비동기로 바꿔 `cluster.mjs`까지 흔들고, 다음에 누가 `yaml`이나 다른 패키지를 맨 위에서 가져오면 같은 실패가 되풀이된다. 길 다는 정본이 고른 도구를 버리고 YAML 읽기를 새로 짠다.
   - 설치 단계는 뿌리에서 `--dir`·`--filter` 없이 돈다(뿌리 개발 의존성 `yaml`이 필요하다. `--dir loadtest`는 `loadtest/`에 `package.json`이 없어 아무것도 설치하지 않는다). 주석은 `tools-check.yml`의 설치 주석과 같은 꼴로 '왜'를 적는다.
   - 정본: 이 계획 커밋이 docs/devops.md §3 `loadtest-check.yml` 행에 '잠금 파일대로 의존성을 설치한 뒤 시험을 돈다'를 더했다.
3. **②의 보탬: 범위 고르기에 `gateway-objects.mjs`를 더한다(추천 적용 2026-11-16)**: `tools/ci/changes.mjs` 50줄 `loadtest` 규칙의 `tools\/local\/(cluster|tools|v0-token|v1-stage|v1-objects)\.mjs$`에 `gateway-objects`를 더한다. 그 밖의 범위 규칙은 바꾸지 않는다(`tools/local/` 전체로 넓히지 않는다).
4. **③ 시험 파일이 생성 라우트 파일까지 읽게 한다(추천 적용 2026-11-16, 감독 결정으로 범위 안)**: 고칠 쪽은 **시험 파일**이다(시험 담당 몫, 위 1의 3 확인). `local-fan-gateway-parity.test.mjs`가 정의 객체를 `deploy/gateways/gw-fan.yaml`과 `deploy/gateways/gw-fan.routes.yaml` 둘에서 모아 읽는다. 제품 쪽(`local-fan-gateway.mjs`·`gateway-cors.mjs`·`mock-api.mjs`)과 생성 파일은 바꾸지 않는다.
   - 두 파일을 이름으로 적고, 둘 다 있어야 한다(없으면 '정의 파일이 없다'로 실패. `gw-fan*.yaml` 글롭으로 넓히지 않는다. 다른 파일이 생기면 그때 이 시험이 '라우트가 없다'로 알린다).
   - 시험 이름의 'deploy/gateways/gw-fan.yaml의 그 라우트 정책 값' 글은 두 파일을 가리키게 고치고, 앞에 이 묶음 번호(아래 5의 CF2-05~07)를 단다. `W7-WIR-06`은 남긴다. 머리 주석의 '그 YAML을 읽어 견준다'도 두 파일로 고친다.
   - 정방향 묶음이라도 이 고침에는 구현 커밋이 없다. 시험 커밋(`Role: test`)이 시험 파일과 이 계획 파일만 바꾼다(§8.6 '정방향 묶음' 줄: 시험 커밋은 시험 파일과 문서만). `gateway-cors.mjs` 머리 주석의 '기준은 gw-fan.yaml·gw-partner.yaml의 SecurityPolicy cors'는 SecurityPolicy가 그대로 `gw-fan.yaml`에 있으므로 맞아 고치지 않는다.
   - 정본: 바꿀 것이 없다(docs/infra.md §4.1이 이미 api 호스트 HTTPRoute를 생성 파일 `deploy/gateways/<게이트웨이>.routes.yaml`에 둔다고 정한다).

### 3. 공개 인터페이스

- `apps/web/next.config.ts`: 설정 객체의 `serverExternalPackages`가 위 2의 1 일곱을 담은 배열 글자 하나(키 하나). 다른 키는 그대로.
- `.github/workflows/loadtest-check.yml`: 잡 `loadtest`의 단계가 checkout → setup-node → pnpm 받기(`packageManager` 판) → `pnpm install --frozen-lockfile` → `node --test "loadtest/test/*.test.mjs"`(이 명령 글자는 그대로). 잡 이름·상한·권한은 그대로.
- `tools/ci/changes.mjs`: `scopes()`가 `tools/local/gateway-objects.mjs` 변경에 `loadtest`를 고른다. 내놓는 함수는 바뀌지 않는다.

### 4. 손댈 파일

| 파일 | 담당 | 무엇 |
| --- | --- | --- |
| `docs/frontend.md` §5.18 '앱 서버 실행' 줄 | 계획(이 커밋) | `@peaket/platform`, 키 하나·한 배열 문장 |
| `docs/devops.md` §3 표 `loadtest-check.yml` 행 | 계획(이 커밋) | 설치한 뒤 시험 |
| `apps/web/next.config.ts` | 구현(먼저) | 위 2의 1 |
| `.github/workflows/loadtest-check.yml` | 구현 | 위 2의 2 |
| `tools/ci/changes.mjs` | 구현 | 위 2의 3 |
| `apps/web/server/server-external.test.mjs` | 시험(구현 뒤) | 아래 5의 CF2-01·CF2-02(기존 'HOT-390 V170-R11 …'을 고쳐 CF2-02로) |
| `tools/ci/check-workflows.test.mjs` | 시험 | CF2-03 |
| `tools/ci/changes.test.mjs` | 시험 | CF2-04 |
| `apps/web/scripts/local-fan-gateway-parity.test.mjs` | 시험 | CF2-05~07(위 2의 4. 구현 커밋 없음) |

- **구현 담당이 알아 둘 것**: 구현 커밋 뒤에는 기존 'HOT-390 V170-R11 next.config.ts serverExternalPackages는 정본의 redis 여섯 패키지와 같다'가 **실패하는 것이 맞다**(정본이 일곱으로 바뀌었고, 첫 키가 일곱이 된다). 구현 담당은 시험 파일을 고치지 않는다. 시험 담당이 이 시험을 CF2-02로 고친다. 구현 담당은 그 밖의 web 단위 시험(`cd apps/web && node --test "server/**/*.test.mjs"`)과 `node --test tools/ci/changes.test.mjs`·`node --test tools/ci/check-workflows.test.mjs`(기존 시험)가 통과하는지 보고 커밋한다. 운영 빌드·`test:build`는 돌리지 않아도 된다(CI `web / budgets` 잡 몫, 아래 5의 '되돌림').

### 5. 시험 목록

- 이름 꼴: `CF2-<두 자리> <정본 ID> <설명>`(§8.6의 7). 정본 ID는 ①이 HOT-390·HOT-400, ②가 BSL-060이다.
- **시험 담당은 구현을 보지 않고 쓴다(ADR-0281 결정 2)**: 단언 값(일곱 패키지 이름, 키 수, 단계 명령 글자, 범위 이름)은 이 계획 2·3과 정본(docs/frontend.md §5.18 '앱 서버 실행', docs/devops.md §3 표 두 행)에서 가져온다. 구현의 차이(diff)는 공개 인터페이스(위 3)만 본다.
- **구현 전 트리에서 실패 확인(ADR-0281 결정 3)**: 새 시험을 출발점 `3256c93f`의 제품 파일 위에서 돌린다. 예: `git -C D:/ticketpass-lane1 show 3256c93f:apps/web/next.config.ts`·`…:.github/workflows/loadtest-check.yml`·`…:tools/ci/changes.mjs`를 꺼내 임시 사본(작업 폴더 밖, `git archive 3256c93f`를 푼 폴더 등)에 두고 새 시험 파일을 그 사본의 같은 자리에 복사해 돈다. 작업 트리의 제품 파일은 바꾸지 않는다. '실패 확인' 절에 돌린 명령·실패한 시험 수·까닭을 적는다. CF2-01~04는 구현 전 트리에서 실패가 예상된다. CF2-05~07은 시험 결함의 고침이라 통과가 예상된다(아래 '처음부터 통과').

| 시험 | 파일 | 단언 | 구현 전 트리(`3256c93f`)에서 |
| --- | --- | --- | --- |
| CF2-01 HOT-390·HOT-400 next.config.ts의 설정 객체에 serverExternalPackages 키는 하나다 | `apps/web/server/server-external.test.mjs` | 소스에서 `serverExternalPackages` 키(`serverExternalPackages:` 꼴, 주석 줄 제외)가 정확히 한 번 나온다 | 실패(두 번) |
| CF2-02 HOT-390 V170-R11·HOT-400 serverExternalPackages는 정본의 redis 여섯과 @peaket/platform이다 | 같은 파일(기존 V170-R11을 고친다) | 그 배열의 값(정렬)이 `@peaket/platform`·`@redis/bloom`·`@redis/client`·`@redis/json`·`@redis/search`·`@redis/time-series`·`redis` 일곱과 같다(겹침·빠짐 없음) | 실패(첫 키가 여섯) |
| CF2-03 BSL-060 loadtest-check는 잠금 파일대로 의존성을 설치한 뒤에 시험을 돈다 | `tools/ci/check-workflows.test.mjs`(기존 'tools-check는_잠금파일대로_…' 옆) | `loadtest-check.yml`에 ⓐ `packageManager`를 읽어 pnpm을 받는 단계, ⓑ 뿌리에서 도는 `pnpm install --frozen-lockfile` 단계(`--dir`·`--filter` 없음), ⓒ `node --test "loadtest/test/*.test.mjs"` 단계가 있고 ⓐ < ⓑ < ⓒ 차례다. 글자 찾기든 YAML 읽기든 시험 담당이 고르되, YAML로 읽으면 `yaml`이 없을 때 건너뛰지 말고 글자로 본다(이 시험이 지키려는 것이 '설치 없음'이므로) | 실패(설치 단계 없음) |
| CF2-04 BSL-060 로컬 클러스터 도구 gateway-objects.mjs를 바꾸면 loadtest를 고른다 | `tools/ci/changes.test.mjs`(기존 'BSL060_부하시험·…_loadtest를고른다' 목록에 더하거나 새 시험) | `scopes({ 'tools/local/gateway-objects.mjs': … })`가 `loadtest`를 담는다 | 실패 |
| CF2-05 W7-WIR-06 로컬 gw-fan 대역의 사전 요청 허용 머리·Max-Age가 gw-fan.yaml·gw-fan.routes.yaml 정의의 그 라우트 정책 값과 같다 | `apps/web/scripts/local-fan-gateway-parity.test.mjs` | 지금 시험과 같은 단언(경로 넷의 라우트 → 그 라우트를 겨눈 SecurityPolicy의 `cors.allowHeaders`·`maxAge`와 대역의 사전 요청 응답). 라우트는 두 파일에서 찾는다 | 통과 예상(제품 쪽이 바뀌지 않음, 아래 '처음부터 통과') |
| CF2-06 W7-WIR-06 로컬 gw-fan 대역의 노출 머리가 gw-fan.yaml·gw-fan.routes.yaml 정의의 그 라우트 정책 값과 같다 | 같은 파일 | 지금 시험과 같은 단언(`cors.exposeHeaders`) | 통과 예상 |
| CF2-07 W7-WIR-06 로컬 gw-fan 대역도 구매 경로에서 ticket:buy가 없으면 403이고 purchase로 넘기지 않는다(gw-fan-buy 인가와 같다) | 같은 파일 | 지금 시험과 같은 단언(정의의 `authorization`에 `ticket:buy`, 대역 403·안 넘김, 있으면 200) | 통과 예상 |

- **재현(커밋하지 않는 시험, 시험 담당이 '실패 확인'·'시험 결과'에 적는다)**:
  - R-1 ②의 재현: `node_modules`가 없는 빈 폴더(그 폴더의 위 폴더에도 `node_modules`가 없는 곳. 예 이 PC의 임시 폴더)에 `git -C D:/ticketpass-lane1 archive <커밋> | tar -x -C <폴더>`로 풀고, 그 폴더에서 `DOCKER_HOST=tcp://127.0.0.1:9 node --test "loadtest/test/*.test.mjs"`. `3256c93f`에서는 443개 가운데 실패 3(`yaml`)이 나와야 한다(이 계획 담당이 2026-11-16에 본 값). Docker는 쓰지 않는다(`DOCKER_HOST`로 k6 형식 검사를 건너뛰게 한다). 구현 뒤의 '설치한 상태'는 이 PC에서 pnpm이 막힐 수 있으므로, 같은 폴더에 `D:/ticketpass-lane1/node_modules`를 가리키는 연결(junction, `cmd //c mklink /J`)을 만들어 대신해도 된다. 그때 실패 0이어야 한다. 최종 근거는 CI `loadtest-check / loadtest` 잡이다.
  - R-2 ①의 되돌림(기존 시험): CI `web / budgets` 잡의 'HOT-390 첫 JS 예산: redis는 서버 묶음 밖에 두고 …'(운영 빌드가 필요). `3256c93f`에서 이미 실패했다(CI 사실). 구현 뒤 CI에서 통과해야 한다. 이 PC에서 운영 빌드를 돌릴 수 있으면 `tools/web-checks`의 `node seed-css/build.mjs web` 뒤 `cd apps/web && node --test test-int/standalone-scm.build.test.mjs`로 봐도 된다(Docker 없음). 못 돌리면 그렇게 적는다.
- 처음부터 통과가 예상되는 시험: CF2-05~07. 이 셋은 시험 결함의 고침이라 제품 쪽(구현 전 트리와 같다)에서 통과하는 것이 맞다. 고치기 전 시험이 `3256c93f`에서 실패한 것(CI 실행 43865738562, 이 계획 담당의 재실행)이 결함의 재현이고, 시험 담당은 '실패 확인' 절에 ⓐ 고치기 전 시험이 `3256c93f`에서 실패 3, ⓑ 고친 시험이 같은 트리에서 통과 4를 적는다. 새 시험이 실패를 보는 것은 검증 담당의 틀린 구현(아래 M-21~M-26)으로 한다(ADR-0281 결정 3).
- 시간: 다섯 시험 파일 모두 1분 안. `cd apps/web && node --test scripts/local-fan-gateway-parity.test.mjs`(Docker 없음, 안에서 대역·가짜 서버를 띄운다). `node --test apps/web/server/server-external.test.mjs`, `node --test --test-name-pattern="CF2-0[34]|tools-check는" tools/ci/check-workflows.test.mjs tools/ci/changes.test.mjs`.

### 6. 앞으로 막을 것(후보)

- **이 묶음에서 넣는 것**: CF2-01(같은 키 두 번을 소스로 막음), CF2-03(설치 단계 차례), CF2-04(범위 고르기), CF2-05~07(생성 라우트 파일까지 읽음. 두 파일 가운데 하나가 없으면 실패).
- **구간 끝 정리 목록 후보(이 묶음에서 하지 않는다, 감독이 PROGRESS '구간 끝 정리 목록(갈래 1)'에 올릴지 정한다)**:
  1. 뿌리 ESLint에 `no-dupe-keys`를 켠다. 지금 저장소에서 걸리는 곳은 이 41줄 하나뿐이라(위 1의 1) 켜는 값이 싸고, rebase로 생기는 '같은 키 두 번'을 next.config 밖에서도 막는다.
  2. `loadtest` 범위 규칙이 `loadtest/`의 실행 코드가 가져오는 `tools/local/` 모듈을 모두 덮는지 가져오기 그래프로 보는 시험(파일 이름을 손으로 더하는 지금 방식은 이번처럼 빠뜨린다).
  3. 설치 없이 도는 다른 잡(지금 `docs-check` 등)에 같은 꼴의 위험이 있는지 훑기.
  4. `deploy/gateways/*.yaml`을 읽는 다른 시험·도구가 생성 파일 `*.routes.yaml`을 함께 읽는지 훑기(이번 계획 담당은 `gw-fan.yaml`을 이름으로 읽는 `.mjs`를 `apps`·`tools`·`deploy`에서 찾아 `gateway-cors.mjs`(주석만)·이 시험·`changes.test.mjs`(범위 고르기 사례)만 봤다).

### 7. 셋째 실패를 범위에 넣은 기록

- 처음 계획 커밋(`f35d8d2f`)은 `node / node` 실패를 범위 밖으로 두었다. 감독 결정(2026-11-16)으로 이 묶음에 넣었고, 원인은 위 1의 3, 고칠 쪽은 2의 4, 시험은 5의 CF2-05~07, 틀린 구현은 M-21~M-26이다.

## 시험 이의

## 실패 확인

## 시험 결과

## 리뷰

## 틀린 구현 목록

검증 담당이 하나씩 넣고 위 5의 시험(과 R-1)이 실패하는지 본다(B등급 표본). 번호는 이 묶음의 것이다. 묶음이 작아 표본이 26개다. M-25·M-26은 생성 파일을 검증 사본에서만 바꾼다(커밋하지 않는다).

| 번호 | 대상 | 넣을 틀린 구현 | 잡아야 할 시험 |
| --- | --- | --- | --- |
| M-01 | ① | 두 키를 그대로 둔다(지금 develop) | CF2-01 |
| M-02 | ① | 한 키로 합치되 `@peaket/platform`을 뺀다 | CF2-02 |
| M-03 | ① | 한 키로 합치되 `@redis/client`를 뺀다 | CF2-02 |
| M-04 | ① | redis 여섯 키를 지우고 platform 키만 남긴다 | CF2-02 |
| M-05 | ① | platform 키를 지우고 redis 여섯 키만 남긴다 | CF2-02 |
| M-06 | ① | `@peaket/platform`을 `serverExternalPackages` 대신 `transpilePackages`에 넣는다 | CF2-02 |
| M-07 | ① | 일곱 가운데 하나(`redis`)를 두 번 적는다 | CF2-02 |
| M-08 | ① | 둘째 키를 `serverExternalPackage`(끝 s 빠짐)로 바꿔 둔다(Next.js가 모르는 키) | CF2-02 |
| M-09 | ① | 합친 배열 뒤에 빈 `serverExternalPackages: []`를 하나 더 둔다 | CF2-01 |
| M-10 | ② | 설치 단계를 `node --test` 뒤에 둔다 | CF2-03 |
| M-11 | ② | `pnpm install`을 `--frozen-lockfile` 없이 돈다 | CF2-03 |
| M-12 | ② | pnpm 대신 `npm install yaml`로 그 패키지만 받는다 | CF2-03 |
| M-13 | ② | `pnpm install --frozen-lockfile --dir loadtest`로 돈다 | CF2-03, R-1 |
| M-14 | ② | `pnpm install --frozen-lockfile --filter ./tools/local`로 돈다 | CF2-03 |
| M-15 | ② | pnpm 받기 단계를 빼고(러너에 pnpm이 있다고 보고) 설치만 둔다 | CF2-03 |
| M-16 | ② | 설치를 넣지 않고 `gateway-objects.mjs`의 `yaml`을 늦게 가져오기로 바꾼다(길 나) | CF2-03 |
| M-17 | ② | 설치를 넣지 않고 `loadtest/run.mjs`가 `cluster.mjs` 대신 필요한 상수를 옮겨 적게 한다 | CF2-03 |
| M-18 | ② | 설치를 넣고 시험 명령을 `node --test "loadtest/test/v1.test.mjs"`로 좁힌다 | CF2-03 |
| M-19 | ②의 보탬 | `changes.mjs`에 `gateway-objects`를 더하지 않는다 | CF2-04 |
| M-20 | ②의 보탬 | `gateway-objects` 대신 오타 `gateway-object`를 더한다 | CF2-04 |
| M-21 | ③ | `apps/web/scripts/gateway-cors.mjs` `GW_FAN_API_CORS.allowHeaders`에 정의에 없는 머리(`X-Evil`)를 더한다 | CF2-05 |
| M-22 | ③ | 같은 곳 `maxAgeSeconds`를 7200에서 3600으로 | CF2-05 |
| M-23 | ③ | 같은 곳 `exposeHeaders`에서 `X-Trace-Id`를 뺀다 | CF2-06 |
| M-24 | ③ | `apps/web/scripts/local-fan-gateway.mjs`가 구매 경로에서 `ticket:buy`를 보지 않고 넘긴다 | CF2-07 |
| M-25 | ③ | 생성 파일 `deploy/gateways/gw-fan.routes.yaml`에서 `/v1/events/[^/]+/holds` 매치를 지운다(검증 사본에서만, 시험이 생성 파일을 읽는지 보는 것) | CF2-05~07 가운데 하나 이상(그 경로를 받는 라우트가 생성 파일에만 있으므로) |
| M-26 | ③ | 같은 생성 파일을 지운다(시험이 두 파일 모두를 요구하는지 보는 것) | CF2-05~07(둘 다 있어야 한다, 위 2의 4) |

- 표본 밖에서 검증 담당이 더 넣어도 된다(예: 주석 줄 안의 `serverExternalPackages:` 글자를 CF2-01이 세는지).

## 검증

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | w8l1-cifix2-plan-d3f0cd33 | claude-opus-5-5 | 2026-11-16T21:15+09:00 | 2026-11-16T21:44+09:00 |
