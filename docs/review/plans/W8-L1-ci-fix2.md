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

시험 담당(w8l1-cifix2-test-6b66f6f0, 2026-11-16). 구현 전 트리는 감독이 꺼내 둔 `D:/ticketpass-lane1-pre`(분리 HEAD `8b26b842`, 계획 커밋. 제품 파일은 출발점 `3256c93f`과 같다. `node_modules` 없음)다. 네 시험 파일을 그 폴더 같은 자리에 복사해 돌리고 `git -C D:/ticketpass-lane1-pre checkout -- .`로 되돌렸다(되돌린 뒤 `status` 빈 것 확인).

- **CF2-01·CF2-02**: `node --test apps/web/server/server-external.test.mjs`(node 내장만 씀) → 시험 2, 실패 2. CF2-01은 '키가 2번 나온다', CF2-02는 첫 배열이 redis 여섯뿐이라 일곱과 다르다.
- **CF2-03·CF2-04**: `node --test --test-name-pattern="CF2-0[34]|tools-check는" tools/ci/check-workflows.test.mjs tools/ci/changes.test.mjs`(node 내장과 git만 씀. CF2-03은 글자로 읽어 `yaml`이 없어도 건너뛰지 않는다) → 시험 3, 실패 2, 통과 1(기존 tools-check 시험). CF2-03은 'packageManager 판으로 pnpm을 받는 단계가 없다', CF2-04는 `tools/local/gateway-objects.mjs`가 `loadtest`를 고르지 않는다.
- **CF2-05~07**: 이 시험은 `jose`·`yaml`을 가져오므로 `node_modules`가 없는 `-pre`에서는 읽기부터 실패한다(`Cannot find package 'jose'`). 그래서 `-pre`에서는 돌리지 않았다. 대신 `git diff --stat 3256c93f c3811a03 -- apps/web/scripts deploy apps/web/package.json package.json pnpm-lock.yaml`가 빈 것(이 시험이 읽는 제품 쪽·정의 파일·의존성이 구현 전과 같다)을 보고 `D:/ticketpass-lane1`에서 견줬다.
  - ⓐ 고치기 전 시험(`git show 8b26b842:apps/web/scripts/local-fan-gateway-parity.test.mjs`를 같은 폴더의 임시 이름으로 두고 `cd apps/web && node --test …`, 돌린 뒤 지움) → 시험 4, 실패 3, 통과 1. 실패 셋 모두 'gw-fan api에 POST /v1/events/e2e-id-10/holds 라우트가 없다'(계획 1의 3과 같다).
  - ⓑ 고친 시험(두 파일을 읽음) → 시험 4, 통과 4.
- **R-1(커밋하지 않는 재현)**: `node_modules`가 없는 이 PC 임시 폴더(그 위의 폴더들에도 `node_modules`가 없음을 확인)에 `git archive 8b26b842 | tar -x`로 풀고 `DOCKER_HOST=tcp://127.0.0.1:9 node --test "loadtest/test/*.test.mjs"` → 시험 443, 실패 3, 통과 440. 실패 셋은 PRF215 셋이고 모두 `Cannot find package 'yaml' imported from …/tools/local/gateway-objects.mjs`(계획 1의 2와 같다).

## 시험 결과

구현 위(`D:/ticketpass-lane1`, 구현 커밋 `c3811a03` + 이 시험 커밋의 시험 파일). 구현 차이는 보지 않았다(ADR-0281 결정 2).

- `node --test apps/web/server/server-external.test.mjs apps/web/scripts/local-fan-gateway-parity.test.mjs`(`apps/web`에서) → 시험 6, 통과 6(CF2-01·02·05·06·07과 기존 '가짜 API는 사전 요청의 요청 머리를 …').
- `node --test --test-name-pattern="CF2-0[34]|tools-check는" tools/ci/check-workflows.test.mjs tools/ci/changes.test.mjs` → 시험 3, 통과 3.
- 두 파일 전체 `node --test tools/ci/check-workflows.test.mjs tools/ci/changes.test.mjs` → 시험 86, 통과 85, 건너뜀 1(CI에서만 도는 'CI에서는_yaml패키지가있어_…'), 실패 0.
- web 서버 단위 시험 전체 `cd apps/web && node --test "server/**/*.test.mjs"` → 시험 66, 통과 66.
- R-1 구현 뒤: `git archive c3811a03`를 같은 꼴로 푼 폴더에 `D:/ticketpass-lane1/node_modules`를 가리키는 연결(junction)을 두고(설치한 상태 대신) 같은 명령 → 시험 443, 통과 443, 실패 0. 돌린 뒤 연결만 먼저 지우고(진짜 `node_modules`는 그대로) 폴더를 지웠다.
- R-2(운영 빌드가 필요한 'HOT-390 첫 JS 예산: redis는 서버 묶음 밖에 …')는 이 PC에서 돌리지 않았다(운영 빌드가 무겁고 계획 4가 CI `web / budgets` 몫으로 둔다). 최종 근거는 CI 잡이다.
- 고친 시험 네 파일은 뿌리 ESLint(`node node_modules/eslint/bin/eslint.js <파일>`)에 걸리는 것이 없다.
- 구현이 틀렸다고 볼 것은 찾지 못했다(시험이 보는 공개 인터페이스 범위 안에서).
- 시험을 쓰며 고른 것: CF2-01·02는 블록 주석과 줄 주석(`https://`의 `//`는 남김)을 지운 소스에서 센다(주석 줄 안의 `serverExternalPackages:`를 세지 않는다). CF2-03은 `yaml` 없이 steps 목록을 글자로 읽어 ⓐ `packageManager`를 읽어 pnpm을 받는 `run`(또는 `pnpm/action-setup` 액션) ⓑ 값이 정확히 `pnpm install --frozen-lockfile`인 `run`(그 단계에 `working-directory` 없음, 파일에 `defaults:` 없음) ⓒ 값이 정확히 `node --test "loadtest/test/*.test.mjs"`인 `run`을 찾아 ⓐ < ⓑ < ⓒ를 본다. CF2-05~07은 두 정의 파일을 이름으로 적고, 하나라도 없으면 '정의 파일이 없다'로 그 시험이 실패한다(파일 읽기를 시험 안으로 늦춰 가짜 API 시험은 따로 돈다).

## 리뷰

리뷰 담당(w8l1-cifix2-review-7a7b511f, 2026-11-16, 한 바퀴 짧은 대조). 받은 것: `git diff origin/develop...HEAD`, `git log origin/develop..HEAD`(HEAD `720830f6`), 이 계획 파일, 정본 줄(docs/frontend.md §5.18 '앱 서버 실행', docs/devops.md §3 `loadtest-check.yml` 행). 리뷰를 쓰는 사이 검증 커밋 `dab0671e`가 올라와 그 '검증' 절도 읽었다(발견이 겹치는 곳은 아래에 적었다).

- **세 실패가 고쳐졌나**
  - `web / budgets`: `apps/web/next.config.ts` 41줄에 `serverExternalPackages` 키가 하나이고 일곱(redis 여섯 → `@peaket/platform`)이 한 배열이다. 정본 §5.18('키 하나, 소비자 웹은 한 배열, 파트너는 platform 하나')과 맞고 `apps/partner/next.config.ts` 19줄은 그대로 하나다. 운영 빌드 시험(R-2)은 이 PC에서 돌리지 않았다(최종 근거는 CI).
  - `loadtest-check / loadtest`: 추가한 두 단계가 `tools-check.yml` 23~28줄과 글자까지 같은 꼴(packageManager 판 확인 → `npm install --global` → 뿌리 `pnpm install --frozen-lockfile`)이고 `node --test` 앞이다. 정본 devops §3 행('tools-check처럼 잠금 파일대로 설치한 뒤 시험')과 맞는다. 설치 단계가 다른 잡과 어긋나는 곳은 없다(`--ignore-scripts`는 `security-scan`만 쓰고 `tools-check`·`ci.yml` lint·`contract-check`도 쓰지 않는다). `node tools/ci/check-workflows.mjs` → '통과: 워크플로 19개'.
  - `node / node`: parity 시험이 `gw-fan.yaml`·`gw-fan.routes.yaml` 둘을 이름으로 읽는다. 두 파일의 HTTPRoute 이름이 겹치지 않음(3개 / 7개, 겹침 0)과 생성 파일이 api 호스트 HTTPRoute만 담음을 `yaml`로 확인했다. 생성 파일이 없을 때 조용히 통과하는 길은 없다: 세 시험 모두 단언 전에 `routeNameFor`→`defs()`를 부르고 `defs()`가 `existsSync` 단언으로 실패한다(실패하면 `loaded`가 비어 다음 시험도 다시 실패). 파일이 비어 있으면 '라우트가 없다'로 실패한다. 검증 M-25·M-26과 같은 결론이다.
- **커밋 경계**: 구현 커밋 `c3811a03`은 `next.config.ts`·`loadtest-check.yml`·`changes.mjs`·이 계획 파일(담당 표 한 줄)만 바꿨고 시험 파일을 건드리지 않았다. 시험 커밋 `720830f6`은 시험 파일 넷과 이 계획 파일만 바꿨다. 독립 시험이 구현을 옮겨 적지 않았다: CF2-02의 일곱은 정본 §5.18·계획 2의 1에서 오고, CF2-03은 구현의 셸 줄을 베끼지 않고 'packageManager를 읽어 pnpm을 받는 run(또는 corepack·`pnpm/action-setup`)'처럼 계획 3의 공개 인터페이스 글자만 단언한다.
- **실행(이 리뷰 담당)**: `node --test tools/ci/check-workflows.test.mjs tools/ci/changes.test.mjs` → 86, 통과 85, 건너뜀 1(CI 전용), 실패 0. `node --test apps/web/server/server-external.test.mjs` → 2, 통과 2. `cd apps/web && node --test scripts/local-fan-gateway-parity.test.mjs` → 4, 통과 4. `node tools/ci/roles-check.mjs --base origin/develop --head HEAD`(HEAD `720830f6`) → 실패 셋, 모두 '아직 오지 않은 차례'(review·verify 커밋 없음, '리뷰'·'검증' 절 빔). 구성·꼬리말·경계 실패는 없다. 검증·이 리뷰 커밋 뒤에 다시 돌려야 한다.

| 번호 | 심각도 | 파일:줄 | 발견 | 고칠 쪽 |
| --- | --- | --- | --- | --- |
| RV-1 | 중간(통과 기준) | `apps/web/server/server-external.test.mjs:14` | `configSource()`가 블록 주석을 먼저 정규식 `/\/\*[\s\S]*?\*\//g`로 지운다. 그런데 `next.config.ts` 67줄의 **줄 주석** 안에 이미 `/_q/*` 글자가 있어, 그 뒤 어디든 `*/` 글자(예: 주석이나 문자열의 `'src/**/*.tsx'`의 `**/`)가 생기면 67줄부터 그 글자까지의 진짜 코드가 지워진다. 그 사이에 둘째 `serverExternalPackages:`가 들어가면 CF2-01이 '1번'으로 **조용히 통과**한다. 이 리뷰 담당이 임시 문자열로 재현했다(67줄 뒤에 `serverExternalPackages: ['@peaket/platform'],`와 `// 예: 'src/**/*.tsx'` 두 줄을 넣은 소스: 실제 키 2, `configSource()` 뒤 센 수 1). CF2-02도 첫 배열만 보므로 함께 빠져나간다. 계획 5 CF2-01 단언('주석 줄 제외하고 정확히 한 번')을 지키지 못하는 길이라 통과 기준 지적으로 본다. 지금 파일에는 67줄 뒤 `*/`가 없어 오늘 결과는 맞다 | **이 묶음에서 고침**(시험, `Fix-By: test`). 블록 주석 지우기를 빼고(지금 `next.config.ts`에 블록 주석이 없다) 줄 단위로 센다: 앞머리가 `//`인 줄을 버린 뒤 `^\s*['"]?serverExternalPackages['"]?\s*:`를 줄마다 센다. 따옴표 꼴까지 세면 검증 M-33도 함께 잡는다. 블록 주석을 남겨 둘 거면 왼쪽부터 한 번 훑으며 `//`·`/*`·문자열을 가리는 작은 훑기로 바꾼다. 고친 뒤 위 재현 두 줄과 M-33으로 실패를 본다 |
| RV-2 | 낮음 | `.github/workflows/loadtest-check.yml:24~29`, `tools/ci/check-workflows.test.mjs:707` 근처(CF2-03) | 검증 M-30·M-31(설치 단계 `if: false`·`continue-on-error: true`)과 같은 구멍을 리뷰로도 봤다. CF2-03이 ⓐ·ⓑ 단계에 `if`·`continue-on-error` 키가 없음을 보지 않는다. 일부러 써야 생기는 꼴이라 낮음 | 시험(검증 절 제안대로 `steps[i].keys.has('if')`·`'continue-on-error'` 단언). 이 묶음에서 RV-1과 함께 고치면 싸다. 감독이 정한다 |
| RV-3 | 낮음 | `tools/ci/changes.mjs:50` | `loadtest` 범위는 이제 설치에 기대는데 `package.json`(packageManager 판)·`pnpm-lock.yaml`(`yaml` 판)·`.nvmrc`를 보지 않는다. 그것만 바뀐 가지에서 `loadtest-check`가 돌지 않는다. 다만 같은 변경은 `ci-node`·`tools-check` 등 `--frozen-lockfile` 잡이 먼저 돌아 설치 자체의 고장은 거기서 드러나므로 낮음. 범위 정규식은 그 밖에는 너무 넓거나 좁지 않다: 뿌리 고정 `^(...)`에 대안마다 `$`가 있고, `loadtest/run.mjs`→`tools/local/`의 가져오기 닫힘(cluster·gateway-objects·tools·v0-token·v1-stage·v1-objects)을 이번에 모두 덮는다(이 리뷰 담당이 `import` 줄로 확인) | 구간 끝 정리 후보(계획 6의 2 '가져오기 그래프로 보는 시험'에 묶는다). 이 묶음에서 하지 않는다 |

- 높음은 없다. 통과 기준 지적은 RV-1 하나이고 이 묶음에서 고친다.
- **같은 모델 새 맥락 사실**: 이 리뷰는 계획·구현·시험·검증 담당과 같은 모델(claude-opus-5-5)이 그들의 대화 맥락 없이 새 세션에서 했다(ADR-0270 결정 6, 다른 모델을 쓸 수 없음). 받은 것은 감독이 준 공통 규칙, 위 diff·log, 이 계획 파일, 정본 두 줄뿐이고 다른 담당의 보고는 받지 않았다(검증 절은 리뷰 도중 git에 올라온 것을 읽었다). 코드는 고치지 않았다.

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

검증 담당(w8l1-cifix2-verify-6e13c0cb)이 2026-11-16에 적었다. B 등급 틀린 구현 표본(§8.6의 3)과 판정 기준 대조 표본이다.

- **방법**: ①②(CF2-01~04)는 감독이 꺼낸 분리 HEAD `720830f6`(`D:/ticketpass-lane1-pre`, 이 가지의 구현·시험과 같은 트리, `node_modules` 없음)의 제품 파일(`apps/web/next.config.ts`, `.github/workflows/loadtest-check.yml`, `tools/ci/changes.mjs`, M-16은 `tools/local/gateway-objects.mjs`도)에 틀린 구현을 하나씩 문자열 바꾸기로 넣고 `node --test apps/web/server/server-external.test.mjs`나 `node --test --test-name-pattern="CF2-0[34]|tools-check는" tools/ci/check-workflows.test.mjs tools/ci/changes.test.mjs`를 돌렸다. ③(CF2-05~07)은 `jose`·`yaml`이 필요해 `D:/ticketpass-lane1`(HEAD `720830f6`)에서 제품 쪽·정의 파일을 잠깐 바꾸고 `cd apps/web && node --test scripts/local-fan-gateway-parity.test.mjs`를 돌렸다. 하나 끝날 때마다 `git -C <폴더> checkout -- .` 뒤 `git status --short`가 빈 것을 봤다(실행마다 빔. 넣기 전에도 빈 것을 확인. 도구 실수로 M-10을 처음에 바뀜 없이 한 번 돌린 것은 버리고 고쳐 다시 돌렸다). 시험 파일은 고치지 않았다.
- **기준(넣기 전)**: CF2-01·02 통과 2, CF2-03·04와 기존 tools-check 시험 통과 3(`-pre`), parity 시험 통과 4(`D:/ticketpass-lane1`).
- **고른 표본**: 틀린 구현 목록 M-01~M-26 전부와 목록 밖 보탬 여덟(M-10b, M-27~M-33). 보탬은 시험의 단언이 약해 보인 곳(따옴표 붙은 키, 빈칸 든 키, 설치 단계의 `working-directory`·`if`·`continue-on-error`, 정의 쪽 인가 값)을 찔러 보려고 더했다. 과잉 검사 확인 하나(X-01, 통과가 맞음)는 수에 넣지 않았다.

| 번호 | 대상 | 넣은 틀린 구현(바꾼 곳) | 돌린 시험 | 결과 | 처음 실패한 단언 |
| --- | --- | --- | --- | --- | --- |
| M-01 | ① | 일곱 한 줄을 develop 꼴 두 키(redis 여섯 / `['@peaket/platform']`)로 | CF2-01·02 | 잡음(둘 다) | '키가 2번 나온다', 첫 배열이 일곱과 다름 |
| M-02 | ① | 한 키에서 `@peaket/platform`을 뺌 | CF2-02 | 잡음 | 일곱과 다름 |
| M-03 | ① | 한 키에서 `@redis/client`를 뺌 | CF2-02 | 잡음 | 일곱과 다름 |
| M-04 | ① | 값을 `['@peaket/platform']`만 | CF2-02 | 잡음 | 일곱과 다름 |
| M-05 | ① | 값을 redis 여섯만(M-02와 결과 파일이 같다. 키가 하나라 '여섯 키를 남긴다'와 '빼고 합친다'가 같은 글이 된다) | CF2-02 | 잡음 | 일곱과 다름 |
| M-06 | ① | `@peaket/platform`을 `transpilePackages`로 옮김 | CF2-02 | 잡음 | 일곱과 다름 |
| M-07 | ① | `'redis'`를 두 번 | CF2-02 | 잡음 | 일곱과 다름(정렬 비교가 겹침을 셈) |
| M-08 | ① | 여섯 키 + 둘째 키 `serverExternalPackage`(끝 s 빠짐)에 platform | CF2-02 | 잡음 | 일곱과 다름 |
| M-09 | ① | 일곱 뒤에 `serverExternalPackages: []` | CF2-01 | 잡음 | '키가 2번 나온다' |
| M-10 | ② | pnpm 받기·설치를 `node --test` 뒤로 | CF2-03 | 잡음 | '설치가 시험보다 뒤에 있다' |
| M-10b | ② | (보탬) pnpm 받기는 앞, 설치만 시험 뒤 | CF2-03 | 잡음 | '설치가 시험보다 뒤에 있다' |
| M-11 | ② | `pnpm install`(`--frozen-lockfile` 없음) | CF2-03 | 잡음 | '`pnpm install --frozen-lockfile` 단계가 없다' |
| M-12 | ② | 두 단계를 `npm install yaml` 하나로 | CF2-03 | 잡음 | 'pnpm을 받는 단계가 없다' |
| M-13 | ② | `--dir loadtest`를 붙임 | CF2-03 | 잡음 | '`pnpm install --frozen-lockfile` 단계가 없다' |
| M-14 | ② | `--filter ./tools/local`을 붙임 | CF2-03 | 잡음 | 같음 |
| M-15 | ② | pnpm 받기 단계를 뺌 | CF2-03 | 잡음 | 'pnpm을 받는 단계가 없다' |
| M-16 | ② | 두 단계를 빼고 `gateway-objects.mjs`의 `yaml`을 `await import`로(길 나) | CF2-03 | 잡음 | 'pnpm을 받는 단계가 없다' |
| M-17 | ② | 두 단계를 뺌(`run.mjs` 상수 옮기기는 넣지 않았다. CF2-03은 워크플로 글만 읽어 결과가 같다) | CF2-03 | 잡음 | 'pnpm을 받는 단계가 없다' |
| M-18 | ② | 시험 명령을 `node --test "loadtest/test/v1.test.mjs"`로 | CF2-03 | 잡음 | '`node --test "loadtest/test/*.test.mjs"` 단계가 없다' |
| M-29 | ② | (보탬) 설치 단계에 `working-directory: loadtest` | CF2-03 | 잡음 | '설치 단계가 뿌리가 아닌 폴더에서 돈다' |
| M-30 | ② | (보탬) 설치 단계에 `if: false`(단계가 늘 건너뛰어진다) | CF2-03 | **놓침** | 통과 |
| M-31 | ② | (보탬) 설치 단계에 `continue-on-error: true`(설치가 실패해도 시험으로 간다) | CF2-03 | **놓침** | 통과 |
| M-19 | ②의 보탬 | `changes.mjs`에서 `gateway-objects`를 뺌 | CF2-04 | 잡음 | `tools/local/gateway-objects.mjs`가 loadtest를 안 고름 |
| M-20 | ②의 보탬 | `gateway-object`(오타)로 | CF2-04 | 잡음 | 같음 |
| M-21 | ③ | `GW_FAN_API_CORS.allowHeaders`에 `X-Evil` | CF2-05(+ 기존 '가짜 API는 사전 요청의 요청 머리를 …') | 잡음 | 'POST /v1/events/e2e-id-10/holds: 허용 머리' |
| M-22 | ③ | `maxAgeSeconds` 7200 → 3600 | CF2-05 | 잡음 | '…holds: Max-Age' |
| M-23 | ③ | `exposeHeaders`에서 `X-Trace-Id`를 뺌 | CF2-06 | 잡음 | '…holds: 노출 머리' |
| M-24 | ③ | `local-fan-gateway.mjs` 구매 경로 `ticket:buy` 검사를 끔(`if (false && …)`) | CF2-07 | 잡음 | '…holds: ticket:buy 없음' |
| M-25 | ③ | `gw-fan.routes.yaml`에서 `/v1/events/[^/]+/holds` 매치 셋(TRACE 막기 하나, gw-fan-buy의 POST·OPTIONS)을 지움 | CF2-05~07 | 잡음(셋 다) | 'gw-fan api에 POST /v1/events/e2e-id-10/holds 라우트가 없다' |
| M-26 | ③ | `gw-fan.routes.yaml`을 지움 | CF2-05~07 | 잡음(셋 다) | '정의 파일이 없다: …gw-fan.routes.yaml' |
| M-27 | ① | (보탬) 여섯 키 + 둘째 키를 따옴표 붙은 `'serverExternalPackages': ['@peaket/platform']` | CF2-01·02 | 잡음(CF2-02만) | 첫 배열이 일곱과 다름. CF2-01은 따옴표 키를 세지 않아 통과 |
| M-28 | ① | (보탬) 일곱 뒤에 `serverExternalPackages : [...]`(키와 콜론 사이 빈칸) | CF2-01 | 잡음 | '키가 2번 나온다' |
| M-32 | ③ | (보탬) 정의 `gw-fan.yaml` gw-fan-buy 인가의 `ticket:buy`를 `ticket:read`로 | CF2-07 | 잡음 | 정의의 `authorization`에 `ticket:buy`가 없음 |
| M-33 | ① | (보탬) 일곱 뒤에 따옴표 붙은 빈 키 `'serverExternalPackages': []`(실제 값은 빈 배열) | CF2-01·02 | **놓침** | 둘 다 통과 |
| X-01 | ① | (과잉 검사 확인) 일곱 앞에 주석 줄 `// 예전 꼴 serverExternalPackages: [...]` | CF2-01·02 | 통과(맞음) | 주석 줄을 세지 않는다 |

- **합계**: 넣은 34개, 잡은 31개, 놓친 3개(M-30·M-31·M-33, 셋 다 목록 밖 보탬). 계획의 목록 M-01~M-26은 26개 모두 잡았다(CF2-05~07이 실패하게 될 M-25·M-26 포함). 검사 항목 ①·②·②의 보탬·③마다 하나 이상 넣었고 모두 하나 이상 잡혔다.
- **R-1을 함께 보지 않은 것**: 목록이 M-13에 R-1도 적었지만, 이 PC에서는 pnpm 설치를 돌리지 않아(공통 규칙, `--dir loadtest` 설치의 결과를 연결로 흉내 낼 수 없음) CF2-03만 봤다. CF2-03이 잡았으므로 표본 판정은 바뀌지 않는다.
- **처음부터 통과 시험의 실패를 본 번호**(ADR-0281 결정 3, 이것으로 완료 근거로 센다):
  - CF2-05: M-21, M-22, M-25, M-26.
  - CF2-06: M-23, M-25, M-26.
  - CF2-07: M-24, M-25, M-26, M-32.
  - CF2-01~04는 '실패 확인' 절에서 구현 전 트리로 실패를 봤고, 여기서도 M-01·M-09·M-28(CF2-01), M-02~M-08·M-27(CF2-02), M-10~M-18·M-29(CF2-03), M-19·M-20(CF2-04)로 다시 봤다.

### 판정 기준 대조(표본)

계획 5의 단언마다 시험 코드(`apps/web/server/server-external.test.mjs` 11~28줄, `tools/ci/check-workflows.test.mjs` 689~707줄, `apps/web/scripts/local-fan-gateway-parity.test.mjs` 머리~40줄)를 읽어 맞췄다.

| 계획 단언 | 시험 | 단언이 규칙을 보나 |
| --- | --- | --- |
| CF2-01 키가 정확히 한 번(주석 줄 제외) | CF2-01 | 맨 키(`serverExternalPackages\s*:`)는 본다(M-01·M-09·M-28 잡음, X-01 과잉 없음). 따옴표 붙은 키는 세지 않는다(M-33 놓침) |
| CF2-02 일곱과 같음(정렬, 겹침·빠짐 없음) | CF2-02 | 본다. 다만 **첫** 배열만 읽으므로 키가 둘이면 CF2-01에 기댄다(M-33은 둘 다 빠져 나감) |
| CF2-03 ⓐ < ⓑ < ⓒ, 뿌리에서, `--dir`·`--filter` 없음, `yaml` 없이 글로 | CF2-03 | 본다(M-10~M-18·M-29 잡음). 단계가 실제로 돌거나 실패를 멈추는지(`if`·`continue-on-error`)는 계획이 적지 않았고 시험도 보지 않는다(M-30·M-31 놓침) |
| CF2-04 `gateway-objects.mjs` → `loadtest` | CF2-04 | 본다(M-19·M-20 잡음) |
| CF2-05~07 두 파일을 이름으로, 둘 다 있어야 함, 값은 정의에서 | CF2-05~07 | 본다(M-25·M-26 잡음, M-32로 정의 쪽 값을 읽는 것도 확인) |

### 놓친 것의 처리(시험 담당에게 넘긴다, 검증 담당은 시험을 쓰지 않는다)

- 셋 다 목록 밖 보탬이고, 계획의 정본 줄(설치한 뒤 시험, 키 하나)을 어기려면 일부러 써야 하는 모양이라 높음·보안·통과 기준 지적은 아니다(낮음). 이 묶음에서 시험을 더할지, 구간 끝 정리 목록에 둘지는 감독이 정한다.
- **M-33(따옴표 붙은 같은 키)**: CF2-01이 키를 `['"]?serverExternalPackages['"]?\s*:`로 세면 잡는다. 계획 6의 후보 1(뿌리 ESLint `no-dupe-keys`)을 켜도 잡는다(따옴표와 관계없이 같은 키로 본다).
- **M-30·M-31(설치 단계를 꺼 두거나 실패를 넘김)**: CF2-03이 ⓐ·ⓑ 단계에 `if`·`continue-on-error` 키가 없음을 더 보면 잡는다(지금 `steps[install].keys.has('working-directory')`와 같은 꼴).

- **같은 모델 새 맥락 사실**: 이 검증은 계획·구현·시험·리뷰 담당과 같은 모델(claude-opus-5-5)이 그들의 대화 맥락 없이 새 세션에서 했다(ADR-0270 결정 6, 다른 모델을 쓸 수 없음). 받은 것은 감독이 준 공통 규칙, 이 계획 파일, `git diff origin/develop...HEAD --stat`뿐이고 다른 담당의 보고는 받지 않았다. '리뷰' 절은 이 검증을 적을 때 비어 있었다.

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | w8l1-cifix2-plan-d3f0cd33 | claude-opus-5-5 | 2026-11-16T21:15+09:00 | 2026-11-16T21:44+09:00 |
| impl | w8l1-cifix2-impl-a624bfe3 | claude-opus-5-5 | 2026-11-16T21:44+09:00 | 2026-11-16T21:53+09:00 |
| test | w8l1-cifix2-test-6b66f6f0 | claude-opus-5-5 | 2026-11-16T21:54+09:00 | 2026-11-16T22:07+09:00 |
| verify | w8l1-cifix2-verify-6e13c0cb | claude-opus-5-5 | 2026-11-16T22:06+09:00 | 2026-11-16T22:13+09:00 |
| review | w8l1-cifix2-review-7a7b511f | claude-opus-5-5 | 2026-11-16T22:07+09:00 | 2026-11-16T22:24+09:00 |
