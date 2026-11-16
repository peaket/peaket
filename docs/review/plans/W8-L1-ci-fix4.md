# 작업 계획: W8-L1-ci-fix4(develop CI 고침: web 첫 JS 예산, 앱 서버 텔레메트리 SDK를 서버 묶음 밖으로)

- **무엇**: develop CI(실행 43877632398, 커밋 `108f029a`)의 `web / budgets` 잡에서 실패한 첫 JS 예산 둘(`web /` 176.1kB > 한도 175.7kB, `web /my/tickets` 161.9kB > 한도 161.6kB, `tools/web-checks/budgets/js.spec.mjs:39`)을 고치는 일의 작업 목록이다(docs/architecture.md §8.6, ADR-0281). 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane1-cf4`, 가지 `wave/lane1-w8-cifix4`, 출발점 `origin/develop` `108f029a`. 견준 기준 폴더 `D:/ticketpass-lane1-cf4base`(분리 HEAD `033bb26d`, 커밋하지 않음). 2026-11-17 작성. 두 폴더 모두 `pnpm install --offline --frozen-lockfile --filter "@peaket/web..." --filter "@peaket/config"`로 설치했다(pnpm·Next.js 빌드 모두 막히지 않았다). Docker는 쓰지 않았다.
- **묶음 ID와 차례**: 묶음 표에 없는 일이라 이 파일 이름 `W8-L1-ci-fix4`를 쓴다. 코드 묶음이고 **정방향 묶음**이다(이 계획 커밋에 `Batch-Order: impl-first`, §8.6 4 세부 '정방향 묶음' 줄). 차례는 계획 → 구현 → 독립 시험 담당의 시험(구현 전 트리 `108f029a`에서 실패 확인) → 시험 통과 → 리뷰 → 검증 → 기록이다.
- **등급**: B(배포·운영 도구와 빌드 설정, 의존성 목록). 틀린 구현 표본은 아래 '틀린 구현 목록'이다.
- **정본**: docs/frontend.md §5.18 '앱 서버 실행'(Next.js 앱 서버 실행 줄. 이 계획 커밋이 '작업 공간 패키지는 밖에 두어지지 않는다'와 'OTel SDK 여섯을 직접 의존성으로 두고 같은 배열에 넣는다' 문장을 더했다), docs/frontend.md §5.8 '첫 JS 열'(기준선 + 1kB 규칙, 바꾸지 않는다), docs/devops.md §4.4(잠금 파일대로 설치), ADR-0281 결정 1~3·5.

## 계획

### 1. 원인

1. **두 빌드를 견준 첫 JS(이 계획 담당, 2026-11-17)**: 두 폴더에서 CI `web / budgets` 잡과 같은 운영 빌드(`tools/web-checks`에서 `PEAKET_BUILDS=prod node seed-css/build.mjs web`)를 하고, `js.spec.mjs`와 같은 방법(`seed-css/apps.mjs`의 `scriptSrcs`로 첫 화면 HTML의 `<script src>`·modulepreload·script preload를 모아 파일마다 gzip, 서버는 `apps/web/server/start.mjs` + 가짜 API, `PEAKET_ENV=ci`)으로 쟀다. 측정 스크립트는 scratchpad에만 두었다(커밋하지 않음).

   | 경로 | 한도(kB) | `033bb26d` | `108f029a` | 차이 | CI `108f029a` |
   | --- | --- | --- | --- | --- | --- |
   | `web /` | 175.7(기준선 174.7 + 1) | 175.6 | 176.1 | +0.5 | 176.1 |
   | `web /my/tickets` | 161.6(기준선 160.6 + 1) | 161.5 | 161.9 | +0.4 | 161.9 |
   | `web /events/0b8f…4e01` | 203.3 | 193.0 | 193.5 | +0.5 | 통과 |
   | `web /search` | 예산 안 | 167.2 | 167.6 | +0.4 | 통과 |
   | `web /login` | 예산 안 | 159.4 | 159.8 | +0.4 | 통과 |

   - 로컬 `108f029a` 값이 CI 값과 같다(176.1·161.9). 그래서 이 PC의 측정으로 원인을 볼 수 있다.
   - **새로 들어온 파일은 없다.** 두 빌드 모두 `/`는 파일 12개, `/my/tickets`는 11개이고 차례도 같다. Turbopack 실행부(`turbopack-…js`)와 `seed-color-mode.js` 둘만 글자가 같고, 나머지 덩어리는 **모두** 조금씩 커졌다(예: 가장 큰 차이 `0ijsxa1y218vp.js` → `0p5f20mere194.js` gzip 44,391 → 44,532바이트, +141). 경로 하나에 실리는 코드가 늘어난 것이 아니라 모든 덩어리가 고르게 늘었다.
2. **까닭은 모듈 번호 길이다(덩어리 글자로 확인)**: 같은 덩어리를 견주면 코드는 한 글자도 다르지 않고 Turbopack 모듈 번호만 다섯 자리에서 여섯 자리가 됐다. 예: 926바이트 덩어리의 `10322,e=>{e.i(60851);var i=e.i(77146);…` 가 `310322,e=>{e.i(260851);var i=e.i(877146);…` 가 됐다(앞에 한 자리가 붙고 끝 다섯 자리는 같다). 번호는 덩어리 안에서 모듈마다 정의·참조로 여러 번 나오므로 경로마다 약 0.4~0.5kB(gzip)가 는다.
   - 빌드의 모든 덩어리(`.next/server`·`.next/static`, standalone 뺌)에서 모듈 정의를 세면 `033bb26d` 3,005개(번호 4·5자리), `108f029a` 3,172개(번호 4·5·6자리, 6자리가 2,844개)다. Turbopack이 모듈 수에 따라 번호 자리 수를 정하고, 그 문턱을 넘은 것으로 본다(문턱 값 자체는 확인하지 못했다, 추정).
   - 이것은 docs/frontend.md §5.18이 redis 때(BAT-170) 적은 설명('서버 모듈 수가 늘어 번호가 한 자리 길어지고, 그 번호가 브라우저 묶음에도 실린다', 그때는 추정)과 같은 꼴이다. 이번에 덩어리 글자로 확인해 그 줄의 '추정'을 이 계획 커밋에서 고쳤다.
3. **늘어난 서버 모듈은 앱 서버 텔레메트리의 OTel SDK다**: `108f029a`에만 있는 모듈 정의(끝 다섯 자리로 짝지음) 184개 가운데 120개가 서버 덩어리 `[root-of-the-server]__1_1qtb_4dz47o._.js`(606,251바이트) 하나에 있다. 이 덩어리는 `instrumentation.ts`가 늦게 가져오는 `@peaket/platform/telemetry/app-server`(`startAppServerTelemetry`·`exitAfterStartupFailure`)와 그것이 끌어오는 `@opentelemetry/sdk-node`·`sdk-trace`·`sdk-logs`·`sdk-metrics`·OTLP 내보내기·`@grpc/grpc-js`를 묶은 것이다. 나머지는 같은 SDK의 작은 덩어리(`@opentelemetry/api` diag, machine-id 감지 등)와 짝짓기 소음이다.
   - **들어온 커밋**: `e5b724d3`(BAT-055, HOT-400, 게이트웨이 다섯의 정의와 앱 서버 추적 입구)가 `apps/web/instrumentation.ts`에 `await import('@peaket/platform/telemetry/app-server')`를 넣었고, `0c8faee7`이 그 자리를 다듬었다. `3256c93f`에서는 next.config 같은 키 두 번으로 다른 시험이 먼저 깨져(ci-fix2) 이 단계까지 오지 않았고, ci-fix2(`c3811a03`)가 그것을 고친 뒤 처음 드러났다.
   - **`serverExternalPackages`의 `@peaket/platform`이 듣지 않는다**: ci-fix2가 정본대로 이 이름을 같은 배열에 넣었지만, 서버 덩어리 어디에도 `require("@peaket/platform…")` 같은 밖 모듈 부르기가 없고 standalone `node_modules`에도 `@peaket/platform`·`@opentelemetry`가 없다. 작업 공간 패키지(`workspace:*`, `apps/web/node_modules/@peaket/platform`은 `packages/platform`을 가리키는 연결)라 실제 경로가 `node_modules` 밖이어서 Turbopack이 밖에 두지 않고 묶은 것으로 본다(빌드 출력에 경고는 없었다).
   - 그 사이 들어온 나머지(`social-login` `identity-client.ts`의 `node:net`·`clientIpOf`, `packages/config/next/server-actions-key.mjs`의 `isProductionNodeServer`, `next.config.ts` 한 키 합치기, `trace-boundary.ts`)는 첫 JS에 몫이 없다. 아래 4의 실험 ①에서 텔레메트리 가져오기 하나만 묶음에서 가리자 다섯 경로 모두 `033bb26d`와 같은 값(175.6·161.5·193.0·167.2·159.4)으로 돌아왔다.
4. **실험(이 계획 담당, 작업 폴더에서 잠깐 바꾸고 `git checkout --`로 되돌림. 되돌린 뒤 `108f029a` 그대로 다시 빌드해 모듈 정의 3,172개를 다시 봤다)**:

   | 실험 | 바꾼 것 | 모듈 정의 수(번호 자리) | `web /` | `web /my/tickets` | 그 밖 |
   | --- | --- | --- | --- | --- | --- |
   | ① 묶음에서 가리기(진단용) | `instrumentation.ts`의 두 `import()`에 `/* turbopackIgnore: true */` | 3,005(4·5자리) | 175.6 | 161.5 | standalone에 `@peaket/platform`이 실리지 않아 운영 서버에서 텔레메트리를 못 띄운다(아래 2의 길 나) |
   | ② SDK 여섯을 직접 의존성 + 밖 패키지 | `apps/web/package.json` `dependencies`에 아래 2의 1 여섯(판 적기는 platform과 같다), `next.config.ts` 배열에 같은 여섯, `pnpm install --offline`(잠금 파일은 web 가져오기 항목 여섯만 늘고 새 패키지 없음) | 2,869(4·5자리) | 175.6 | 161.5 | 텔레메트리 덩어리가 18,203바이트로 줄고 SDK 여섯을 Turbopack 밖 모듈(`.next/node_modules/@opentelemetry/<이름>-<해시>`)로 부른다. standalone `apps/web/.next/node_modules/@opentelemetry`에 여섯이, `node_modules/.pnpm`에 `@opentelemetry+sdk-node`·`@grpc+grpc-js` 등이 실린다. `tools/web-checks`의 `node --test --test-name-pattern="web 운영" boot/production-start.test.mjs` 통과 2(BAS-220 RV-08·V-T31 ②), `apps/web`의 `node --test "test-int/*.build.test.mjs"` 통과 3. `server/server-external.test.mjs`는 CF2-02가 실패(일곱이 아니라서, 맞는 실패. 아래 4) |

   - 실험 ②의 첫 JS는 `033bb26d`와 바이트까지 같다(다섯 경로 같은 값). 한도와의 거리는 `033bb26d`와 같이 `/` 0.1kB, `/my/tickets` 0.1kB이다(아래 6의 1).

### 2. 고칠 길과 고른 것

| 길 | 무엇 | 판단 |
| --- | --- | --- |
| 가. SDK 여섯을 web 직접 의존성으로 두고 `serverExternalPackages`에 넣기 | 아래 1 | **고름**(추천 적용 2026-11-17) |
| 나. 늦게 가져오기를 묶음에서 가리기 | `import(/* turbopackIgnore: true */ …)` | 고르지 않음. Next.js 추적이 그 가져오기를 따라가지 않아 standalone에 platform·SDK가 실리지 않는다(실험 ①). `outputFileTracingIncludes`로 pnpm 저장소 폴더를 글롭으로 싣는 것은 판·해시가 바뀔 때마다 깨지기 쉽다 |
| 다. 텔레메트리 시작을 `server/start.mjs`로 옮기기 | Next.js 밖의 시작 파일에서 SDK를 띄운다 | 고르지 않음. 정본(HOT-400, docs/observability.md §6)이 정한 `instrumentation.ts` 입구와 standalone `server.js`를 바로 띄우는 시작 확인(V-T31 ②)을 바꾸는 더 큰 일이고, 파트너(`next start`)와 갈라진다 |
| 라. platform을 pnpm `injected` 의존성으로 | 연결 대신 복사본을 `node_modules`에 둬 Turbopack이 밖에 두게 한다 | 고르지 않음. 설치 뒤에 만드는 `dist`가 복사본에 따라가지 않는다(설치 → 패키지 빌드 차례의 CI·로컬 모두) |
| 마. 기준선(js-baseline.json)을 올리기 | `web /`·`web /my/tickets`에 +0.5·+0.4 | 고르지 않음. 원인은 첫 화면 코드가 아니라 서버 쪽 SDK가 번호 길이로 브라우저에 끼친 몫이고, 첫 화면에 꼭 필요한 것이 아니다(§5.8 '첫 JS 열'·§5.18 '첫 JS 예산은 올리지 않고 줄인다'). 길 가로 바이트까지 돌아온다 |

1. **고친 모양(구현 담당)**:
   - `apps/web/package.json` `dependencies`에 여섯을 더한다. 판 적기는 `packages/platform/package.json`의 것과 글자까지 같게 한다: `"@opentelemetry/api": "^1.10.0"`, `"@opentelemetry/core": "3.0.0"`, `"@opentelemetry/exporter-trace-otlp-proto": "0.300.0"`, `"@opentelemetry/resources": "3.0.0"`, `"@opentelemetry/sdk-node": "0.300.0"`, `"@opentelemetry/sdk-trace": "3.0.0"`. 이름 차례(알파벳)로 둔다.
   - `pnpm-lock.yaml`은 `pnpm install --offline`(또는 `pnpm install`)로 다시 만든다. 손으로 고치지 않는다. 늘어나는 것은 `importers` `apps/web`의 여섯 항목뿐이어야 하고 `packages:`·`snapshots:`에 새 패키지가 생기면 멈추고 보고한다(같은 판이 이미 잠금 파일에 있다).
   - `apps/web/next.config.ts`의 `serverExternalPackages` 한 배열 끝에(`'@peaket/platform'` 뒤) 같은 여섯을 같은 차례로 더한다. 키는 하나, 배열 글자 하나(상수·펼침 없음, 시험이 소스를 읽는다, ci-fix2 2의 1). 주석에 '작업 공간 패키지라 platform 이름만으로는 밖에 두어지지 않아 SDK 여섯을 직접 의존성으로 두고 넣는다, 묶으면 모듈 번호가 길어져 첫 JS가 는다'를 짧게 더한다. `'@peaket/platform'`은 남긴다(정본 문장 그대로, 해가 없다).
   - `apps/web/instrumentation.ts`·`packages/platform`·`apps/partner`는 바꾸지 않는다. `tools/web-checks/budgets/js-baseline.json`도 바꾸지 않는다.
2. **정본**: 이 계획 커밋이 docs/frontend.md §5.18 '앱 서버 실행' 줄에 위 내용(작업 공간 패키지는 밖에 두어지지 않음, SDK 여섯 직접 의존성 + 같은 배열, 파트너는 구간 끝 정리 후보)을 더하고 redis 때의 '번호 길이 설명은 추정'을 이번 확인으로 고쳤다.

### 3. 공개 인터페이스

- `apps/web/next.config.ts`: 설정 객체의 `serverExternalPackages`가 열셋(redis 여섯 → `@peaket/platform` → OTel 여섯)을 담은 배열 글자 하나(키 하나). 다른 키는 그대로.
- `apps/web/package.json`: `dependencies`에 OTel 여섯(판 적기는 platform과 같다). 스크립트·다른 의존성은 그대로.
- 운영 빌드 산출물: `instrumentation`이 늦게 싣는 텔레메트리 서버 덩어리가 OTel SDK 여섯을 Turbopack 밖 모듈로 부르고, standalone에 그 여섯이 실린다.

### 4. 손댈 파일

| 파일 | 담당 | 무엇 |
| --- | --- | --- |
| `docs/frontend.md` §5.18 '앱 서버 실행' 줄 | 계획(이 커밋) | 위 2의 2 |
| `apps/web/package.json`, `pnpm-lock.yaml` | 구현(먼저) | 위 2의 1 |
| `apps/web/next.config.ts` | 구현 | 위 2의 1 |
| `apps/web/server/server-external.test.mjs` | 시험(구현 뒤) | CF4-01(기존 CF2-02를 고친다)·CF4-02 |
| `apps/web/test-int/` 아래 `*.build.test.mjs` 하나(새 파일이든 `standalone-scm.build.test.mjs`에 더하든 시험 담당이 고른다) | 시험 | CF4-03·CF4-04 |

- **구현 담당이 알아 둘 것**: 구현 커밋 뒤에는 기존 'CF2-02 HOT-390 V170-R11·HOT-400 serverExternalPackages는 정본의 redis 여섯과 @peaket/platform이다'가 **실패하는 것이 맞다**(정본이 열셋으로 바뀌었다). 구현 담당은 시험 파일을 고치지 않는다. 구현 담당은 ⓐ `tools/web-checks`에서 `PEAKET_BUILDS=prod node seed-css/build.mjs web` ⓑ 위 1의 측정과 같은 방법이나 `pnpm run budgets`의 js 프로젝트로 `web /` ≤ 175.7kB·`web /my/tickets` ≤ 161.6kB ⓒ `node --test --test-name-pattern="web 운영" boot/production-start.test.mjs`(파트너는 빌드하지 않았으면 이름으로 거른다) ⓓ `cd apps/web && node --test "test-int/*.build.test.mjs"`를 보고 커밋한다. 잰 값을 '시험 결과' 절이 아니라 커밋 본문에 적는다.

### 5. 시험 목록

- 이름 꼴: `CF4-<두 자리> <정본 ID> <설명>`(§8.6의 7). 정본 ID는 HOT-400(앱 서버 텔레메트리)·BAS-220(첫 JS 예산)·HOT-390(redis 여섯, CF4-01만).
- **시험 담당은 구현을 보지 않고 쓴다(ADR-0281 결정 2)**: 단언 값(열셋 이름, 판 적기, 밖 모듈 꼴)은 이 계획 2·3과 정본(docs/frontend.md §5.18 '앱 서버 실행', `packages/platform/package.json`)에서 가져온다. 판 적기는 시험이 `packages/platform/package.json`을 읽어 견준다(시험에 판 글자를 적지 않는다).
- **구현 전 트리에서 실패 확인(ADR-0281 결정 3)**: 출발점 `108f029a`의 제품 파일 위에서 돈다. CF4-01·02는 node 내장만 쓰므로 `node_modules` 없는 사본에서도 돈다. CF4-03·04는 운영 빌드가 필요하다. 이 계획 담당이 떠날 때 `D:/ticketpass-lane1-cf4/apps/web/.next`는 `108f029a` 그대로의 운영 빌드다(모듈 정의 3,172개). 구현 담당이 다시 빌드하면 덮이므로, 감독이 구현 전 빌드가 있는 폴더를 따로 주거나 시험 담당이 `108f029a` 사본을 빌드한다. 못 돌리면 그렇게 적고, 실패 확인은 검증 담당의 틀린 구현(M-01 등)으로 한다.

| 시험 | 파일 | 단언 | 구현 전 트리(`108f029a`)에서 |
| --- | --- | --- | --- |
| CF4-01 HOT-390·HOT-400 serverExternalPackages는 정본의 redis 여섯, @peaket/platform, OTel SDK 여섯이다 | `apps/web/server/server-external.test.mjs`(CF2-02를 고친다. CF2-01의 '키 하나'는 그대로 둔다) | 그 배열의 값(정렬)이 열셋과 같다(겹침·빠짐 없음) | 실패(일곱) |
| CF4-02 HOT-400 밖에 두는 OTel 패키지는 web의 직접 의존성이고 판 적기가 platform과 같다 | 같은 파일 | `serverExternalPackages`의 `@opentelemetry/` 이름마다 `apps/web/package.json` `dependencies`에 있고 값이 `packages/platform/package.json` `dependencies`의 값과 글자까지 같다. `@opentelemetry/` 이름이 하나도 없으면 실패한다(빈 통과 막기) | 실패(없음) |
| CF4-03 HOT-400·BAS-220 운영 빌드의 텔레메트리 서버 덩어리는 OTel SDK를 묶지 않고 밖 모듈로 부른다 | `apps/web/test-int/*.build.test.mjs` | `.next/server` 아래에서 `startAppServerTelemetry`를 정의한 덩어리를 Turbopack 내보내기 등록 꼴(`"startAppServerTelemetry",()=>…` 다시 내보내기 또는 `"startAppServerTelemetry",0,function(…)` 그 자리 정의)로 찾는다(없으면 실패). 이름 글자만으로 찾지 않는다. 부르기만 하는 instrumentation 덩어리(`{startAppServerTelemetry:s}=await …`)가 걸려 묶인 덩어리를 놓친 채 통과할 수 있어서다(시험 이의 2, 받음 2026-11-17). 그 덩어리 글자에 여섯 이름이 Turbopack 밖 모듈 부르기 꼴(`require("@opentelemetry/<이름>` 또는 `.y("@opentelemetry/<이름>`·`.x("@opentelemetry/<이름>`, 뒤에 `-<해시>`가 붙을 수 있다)로 나오고, 그 덩어리 크기가 100kB [가정] 미만이다(묶였을 때 606kB, 밖에 두면 18kB). 시험 담당이 다른 꼴을 고르면 이유를 '시험 결과'에 적는다 | 실패(SDK를 묶음) |
| CF4-04 HOT-400 standalone에 밖에 둔 OTel 패키지가 실린다 | 같은 파일 | standalone `apps/web` 폴더(서버 덩어리 폴더)에서 Node 해석으로 여섯을 모두 찾을 수 있다(`.next/node_modules/@opentelemetry/<이름>-<해시>` 연결이나 `node_modules` 어느 꼴이든). 해석은 require 조건(`createRequire`)과 import 조건(ESM, `import.meta.resolve`) 둘 다 해 보고 어느 하나로 풀리면 된다(Turbopack 밖 모듈 `.y(…)`는 `import()`로 부르고, standalone에는 넷의 import 조건 파일만 실린다). 풀린 실제 경로가 standalone 폴더 안이고 그 패키지일 때만 센다(위로 올라가 개발 설치에 닿은 것은 세지 않는다). 하나라도 못 찾으면 실패(시험 이의 1, 받음 2026-11-17) | 실패(없음) |

- **커밋하지 않는 재현과 되돌림(시험 담당이 '실패 확인'·'시험 결과'에 적는다)**:
  - R-1 첫 JS 측정: 운영 빌드 뒤 `tools/web-checks`에서 `pnpm run budgets --project js`(또는 위 1의 측정과 같은 방법). `108f029a`에서 `web /` 176.1·`web /my/tickets` 161.9로 실패, 구현 뒤 175.7·161.6 이하로 통과해야 한다(이 계획 담당이 본 값은 175.6·161.5). 최종 근거는 CI `web / budgets` 잡이다.
  - R-2 시작 확인(기존 시험): `tools/web-checks`의 `node --test --test-name-pattern="web 운영" boot/production-start.test.mjs`(BAS-220 RV-08, V-T31 ②). 구현 뒤 통과해야 한다(SDK가 standalone에 실리지 않으면 V-T31 ②의 mesh 경우가 뜨지 않아야 하는데 떠서 실패한다).
  - R-3 기존 빌드 시험: `cd apps/web && node --test "test-int/*.build.test.mjs"`(HOT-390 redis 밖에 둠·standalone 점 파일 등).
- 처음부터 통과가 예상되는 시험: 없다.
- 시간: CF4-01·02 1초 안. CF4-03·04는 빌드된 산출물을 읽기만 해 몇 초(빌드는 1~2분, 이 PC 2026-11-17).

### 6. 앞으로 막을 것(후보)

- **이 묶음에서 넣는 것**: CF4-01·02(밖 패키지 목록과 직접 의존성 판), CF4-03·04(SDK를 실제로 밖에 두고 standalone에 싣는지 산출물로 본다. 이름만 넣고 듣지 않는 이번 꼴을 막는다).
- **구간 끝 정리 목록 후보(이 묶음에서 하지 않는다, 감독이 PROGRESS '구간 끝 정리 목록(갈래 1)'에 올릴지 정한다)**:
  1. **첫 JS가 한도에 0.1kB 붙어 있다**: 고친 뒤에도 `web /` 175.6(한도 175.7), `web /my/tickets` 161.5(한도 161.6)로 `033bb26d`와 같다. 서버 쪽 모듈이 다시 늘어 번호가 여섯 자리가 되면 첫 화면 코드와 상관없이 경로마다 약 0.4~0.5kB가 한꺼번에 늘어 다시 깨진다. 번호 길이 문턱(Turbopack이 자리 수를 정하는 규칙)을 확인하고, 서버 모듈 수의 여유를 재는 검사나 기준선 규칙(§5.8 '첫 JS 열')을 wbs 7.5.2 전에 다시 볼지 정한다.
  2. **파트너 앱**: `apps/partner`도 `@peaket/platform` 하나만 넣어 SDK가 서버 묶음에 들어 있다(이번 CI에서 파트너 첫 JS는 통과). 같은 고침(SDK 여섯을 직접 의존성 + 밖 패키지)과 같은 시험을 파트너에 넣는다. 정본 §5.18이 이 묶음에서 파트너를 '구간 끝 정리 후보'로 적었다.
  3. `serverExternalPackages`에 적은 이름이 실제로 밖 모듈이 됐는지(덩어리에 그 이름의 밖 부르기가 있는지) 모든 이름에 대해 산출물로 보는 일반 시험(지금 redis는 `standalone-scm.build.test.mjs`, OTel은 이 묶음의 CF4-03이 따로 본다).

### 7. `Could not resolve …/app/sw.ts` 줄의 판정

- **판정: 이미 있던 소음이다. 이 묶음의 결함이 아니고 이번 실패와 관계없다.**
- 근거: `gh run view <실행> --repo peaket/peaket --job <잡> --log`로 받은 두 실행의 `web / budgets` 잡 로그에서 `Could not resolve "/__w/peaket/peaket/apps/web/.next/standalone/apps/web/app/sw.ts"`를 세면 초록 실행 43856980576(`033bb26d`)과 이번 실행 43877632398(`108f029a`) 모두 27줄이다. 두 실행 모두 같은 자리(Lighthouse 프로젝트가 21번 결제 데모를 끝낸 뒤, 다음 Lighthouse 주소를 잴 때)의 `[WebServer]` 줄로 나오고, 초록 실행에서는 그 단계의 29개가 모두 통과했다.
- 까닭(추정): `apps/web/app/serwist/[path]/route.ts`(BAT-350, `5a68392e`)가 `use cache`로 감싼 빌드에서 `app/sw.ts`를 esbuild로 묶는데, 운영 서버(standalone)에서 그 캐시가 다시 채워질 때 standalone 폴더에는 `app/sw.ts` 원본이 없어 묶기가 실패하는 것으로 본다. 정적 결과로 이미 낸 `/serwist/sw.js`가 있어 화면 시험은 깨지지 않는다. 서비스 워커를 standalone에서 다시 만들 일이 생기면 결함이 되므로, 감독이 따로 정리 후보로 올릴지 정한다(이 묶음에서 하지 않는다).
- 덧붙여 확인한 것: `033bb26d` budgets 잡의 `pnpm run budgets` 단계는 `Running 29 tests using 1 worker` 뒤 `29 passed (3.2m)`이고, 그 안에서 `[js] › budgets/js.spec.mjs:21:5 › §5.8 첫 JS web /`(1번)와 `… web /my/tickets`(5번)가 `✓`로 실제로 돌았다. `108f029a`에서는 같은 1번·5번이 `✘`이고 `2 failed`·`27 passed (3.1m)`다.

## 시험 이의

**계획 담당 판정(w8l1-cifix4-plan-71c0e94b, 2026-11-17)**: 아래 두 이의를 받고 5의 CF4-03·04 단언 칸을 시험이 고른 꼴대로 고쳤다. 셋째(impl 끝 시각)는 기록 담당 몫이라 판정하지 않는다.

1. **CF4-04 해석 조건(받음)**: 구현 뒤 운영 빌드의 standalone을 다시 봤다. `@opentelemetry/core`·`resources`·`sdk-trace`의 `dist`에는 `.mjs`만 있고 `.cjs`가 없다(`api`·`sdk-node`는 둘 다 있다). 텔레메트리 서버 덩어리는 여섯을 `await t.y("@opentelemetry/<이름>-<해시>")`로, 곧 import 조건으로 부르므로 운영 서버가 실제로 쓰는 해석은 import 조건이다. 그래서 `createRequire`만 적은 계획 문장이 틀렸고, require·import 조건 가운데 하나로 풀리면 실린 것으로 보는 것이 맞다. standalone 안 경로만 세는 것도 받는다. standalone이 `apps/web/.next` 아래라 위로 올라가면 개발 설치에 닿아 아무 빌드에서나 통과하는 구멍을 막는다. 계획이 적은 '어느 꼴이든'은 연결 꼴(`.next/node_modules`·`node_modules`)을 가리킨 것이고 standalone 밖까지 넓힌 뜻은 아니었다.
2. **CF4-03 덩어리 찾기(받음)**: 구현 뒤 덩어리에 `"startAppServerTelemetry",()=>n.Y]`(다시 내보내기 등록)가 있음을 봤다. 이름 글자만 찾으면 instrumentation 덩어리(구현 전에도 있는 1.4kB)가 먼저 걸려 크기 한도와 밖 모듈 꼴을 엉뚱한 덩어리에 대고 보게 된다. 등록 꼴로 찾는 것이 계획의 '정의한 덩어리'의 뜻과 같다. 밖 모듈 부르기 꼴과 크기 한도 100kB [가정]는 그대로다.
- 대안은 두지 않는다. 정본(docs/frontend.md §5.18)은 바꿀 것이 없다('Next.js 추적이 standalone에 싣는다'는 해석 조건을 정하지 않는다).

시험 담당이 적은 이의(원문):

- (고치지 않음, 계획 담당 몫) 5의 CF4-04 단언 칸은 'Node 해석(`createRequire`)으로 여섯을 찾는다'고 적었지만, 구현 뒤 운영 빌드의 standalone에는 `core`·`exporter-trace-otlp-proto`·`resources`·`sdk-trace`의 import 조건 파일(`dist/index.mjs`)만 실리고 require 조건 파일(`dist/index.cjs`)은 실리지 않아 `createRequire`만으로는 넷이 풀리지 않는다(Turbopack 밖 모듈 `.y(…)`는 `import()`로 부른다). 시험은 require와 ESM(import 조건) 해석을 둘 다 해 보고 어느 하나라도 standalone 안이면 실린 것으로 센다(아래 '시험 결과' 2). 계획 문장을 'Node 해석(require 또는 import 조건)'으로 고칠지는 계획 담당·리뷰가 정한다.
- (기록 담당 몫, 고치지 않음) 담당 표 impl 줄의 끝 시각 00:25는 실제 구현 커밋 시각(`148cd5e3`, 2026-11-17T00:21:32+09:00, 감독 확인 00:22)보다 3분 늦게 적혔다.

## 실패 확인

- **구현 전 트리**: `D:/ticketpass-lane1-cf4base`(분리 HEAD `3a66b368` = `108f029a` + 이 계획 문서, 제품 파일은 `108f029a`와 같다). 시험 담당이 그 폴더에서 `pnpm install --offline --frozen-lockfile` 뒤 `tools/web-checks`에서 `PEAKET_BUILDS=prod node seed-css/build.mjs web`로 운영 빌드를 새로 했다(2026-11-17T00:28, 그 전 `.next`는 2026-11-16T23:48의 다른 빌드라 쓰지 않았다). 텔레메트리 서버 덩어리는 `[root-of-the-server]__1_1qtb_4dz47o._.js` 606,251바이트, standalone에 `apps/web/.next/node_modules/@opentelemetry` 없음.
- 시험 파일 둘(`apps/web/server/server-external.test.mjs`, `apps/web/test-int/otel-external.build.test.mjs`)을 그 폴더에 복사해 `apps/web`에서 `node --test server/server-external.test.mjs test-int/otel-external.build.test.mjs`: **통과 1(CF2-01), 실패 4(CF4-01~04)**. 끝난 뒤 복사한 시험 파일을 되돌려 그 폴더의 git status를 비웠다.

  | 시험 | 결과 | 메시지(줄임) |
  | --- | --- | --- |
  | CF2-01 | 통과(바꾸지 않은 시험) | |
  | CF4-01 | 실패 | 배열 값이 일곱(`@peaket/platform`·redis 여섯)이고 OTel 여섯 `@opentelemetry/api`·`core`·`exporter-trace-otlp-proto`·`resources`·`sdk-node`·`sdk-trace`가 빠졌다(deepEqual 차이) |
  | CF4-02 | 실패 | `serverExternalPackages에 @opentelemetry/ 이름이 하나도 없다`(빈 통과 막기) |
  | CF4-03 | 실패 | `.next\server\chunks\[root-of-the-server]__1_1qtb_4dz47o._.js이 밖 모듈로 부르지 않는 OTel 패키지가 있다(서버 묶음에 들어갔다)`, 여섯 모두 |
  | CF4-04 | 실패 | `standalone 안에서 풀리지 않는 OTel 패키지가 있다(운영 서버가 텔레메트리를 띄우지 못한다)`, 여섯 모두 |

- R-1(같은 구현 전 빌드, scratchpad `cf4\measure.mjs`, js.spec 꼴): `web /` 176.1 > 175.7, `web /my/tickets` 161.9 > 161.6로 한도를 넘는다(`/events/0b8f…4e01` 193.5, `/search` 167.6, `/login` 159.8). 계획 1의 `108f029a` 값과 같다.
- 감독 요청 확인(CF4-02가 판 글자를 견주는지): 구현 위 폴더에서 `packages/platform/package.json`의 `@opentelemetry/sdk-node`만 `0.300.0` → `0.300.1`로 잠깐 바꾸자 CF4-02가 `@opentelemetry/sdk-node 판 적기가 다르다: web 0.300.0, platform 0.300.1`로 실패했다(CF2-01·CF4-01은 통과). `git checkout --`로 되돌렸다.
- 그 밖에 구현 위 standalone의 `.next/node_modules/@opentelemetry/sdk-node-<해시>` 연결 이름을 잠깐 바꾸자 CF4-04가 `@opentelemetry/sdk-node` 하나로 실패했다(이름 그대로의 해석은 standalone 밖 개발 설치로 풀려 세지 않는다). 이름을 되돌렸다(M-13 꼴, 검증 담당은 따로 넣는다).

## 시험 결과

- **시험 파일**: CF4-01·02는 `apps/web/server/server-external.test.mjs`(CF2-02를 CF4-01로 바꾸고 배열 읽기를 `externalNames()`로 묶었다. CF2-01은 그대로). CF4-03·04는 새 파일 `apps/web/test-int/otel-external.build.test.mjs`(산출물을 읽기만 해 `standalone-scm.build`의 복사와 겹치지 않게 따로 두었다. `test:build` 글롭에 들어간다).
- **계획과 다르게 고른 꼴(이유)**:
  1. CF4-03 '`startAppServerTelemetry`를 정의한 덩어리'는 Turbopack 내보내기 등록 꼴 `"startAppServerTelemetry",()=>…`(구현 뒤, 다시 내보내기) 또는 `"startAppServerTelemetry",0,function(…)`(구현 전, 그 자리 정의)로 찾는다. 이름 글자만 찾으면 부르기만 하는 instrumentation 덩어리(`{startAppServerTelemetry:s}=await …`, 1.4kB)도 걸려 묶인 덩어리를 놓친 채 통과할 수 있다. 밖 모듈 부르기 꼴과 크기 한도(100kB [가정])는 계획대로다.
  2. CF4-04는 require 해석(`createRequire`)과 ESM 해석(import 조건, 서버 덩어리 폴더를 현재 폴더로 둔 자식 Node의 `import.meta.resolve`)을 둘 다 해 보고, 풀린 실제 경로가 standalone 폴더 안이고 그 패키지 이름일 때만 센다. standalone은 `apps/web/.next` 아래라 위로 올라가면 개발 설치까지 닿아(이름 그대로 풀면 `D:/ticketpass-lane1-cf4/node_modules/.pnpm/…`) 아무 빌드에서나 통과하기 때문이다. import 조건을 더한 까닭은 위 '시험 이의' 첫 줄이다.
- **구현 위(`D:/ticketpass-lane1-cf4`, `148cd5e3`, 구현 담당의 운영 빌드 2026-11-17T00:16)**:
  - CF2-01·CF4-01·CF4-02: `node --test server/server-external.test.mjs` 통과 3, 실패 0.
  - CF4-03·CF4-04: 통과 2. 텔레메트리 서버 덩어리 `[root-of-the-server]__0r8xl9k644kau._.js` 18,203바이트, 여섯을 `await t.y("@opentelemetry/<이름>-<해시>")`로 부른다.
  - web 서버 단위 시험 전체 `node --test "server/**/*.test.mjs"`: 67 통과, 실패 0.
  - `apps/web`의 `node --test "test-int/*.build.test.mjs"`(R-3): 5 통과, 실패 0(CF4-03·04, ASVS 13.4.1 소스 관리 폴더, HOT-390 redis 밖, R170-8).
  - R-1 첫 JS(scratchpad `cf4\measure.mjs`, js.spec 꼴): `web /` **175.6** ≤ 175.7, `web /my/tickets` **161.5** ≤ 161.6(그 밖 `/events/0b8f…4e01` 193.0, `/search` 167.2, `/login` 159.4).
  - R-1 budgets js 프로젝트: 다른 네 앱을 빌드하지 않아 CI 명령 그대로(`pnpm run budgets`, 앱 다섯 서버)는 못 돌렸다. 대신 `tools/web-checks`에서 `pnpm install --offline --frozen-lockfile` 뒤, 가짜 API와 web 운영 서버만 `seed-css/apps.mjs`의 `mockApiServer()`·`serverCommand(web, 'prod')` 그대로 띄우고 `PEAKET_WEB_CHECKS_SERVERS=external npx playwright test -c playwright.budgets.config.mjs --project js --grep "첫 JS web "`: **8 통과**(`reports/sizes-js`: `web /` 175.6 한도 175.7, `web /my/tickets` 161.5 한도 161.6). 띄운 서버는 자기 PID만 끝냈다. 최종 근거는 CI `web / budgets` 잡이다.
  - R-2 `tools/web-checks`의 `node --test --test-name-pattern="web 운영" boot/production-start.test.mjs`: 통과 2(BAS-220 RV-08, V-T31 ② RV-08).
  - eslint(바꾼 시험 파일 둘) 오류 0. doc-check(`python -I -X utf8 tools/doc-check/check_all.py`) 오류 0, 경고 4(openapi 설명 셋·mermaid 건너뜀, 이 묶음과 관계없이 이미 있던 것).

## 리뷰

## 틀린 구현 목록

검증 담당이 하나씩 넣고 위 5의 시험(과 R-1·R-2)이 실패하는지 본다(B등급 표본). 번호는 이 묶음의 것이다.

| 번호 | 대상 | 넣을 틀린 구현 | 잡아야 할 시험 |
| --- | --- | --- | --- |
| M-01 | 구현 전 | 아무것도 바꾸지 않는다(지금 develop) | CF4-01·02·03·04, R-1 |
| M-02 | next.config | 여섯을 `serverExternalPackages`에 넣고 `package.json` 직접 의존성은 넣지 않는다(Turbopack이 앱 폴더에서 찾지 못해 다시 묶는다) | CF4-02, CF4-03 |
| M-03 | package.json | 직접 의존성만 넣고 `serverExternalPackages`에는 넣지 않는다 | CF4-01, CF4-03 |
| M-04 | next.config | 여섯 가운데 `@opentelemetry/sdk-node` 하나를 뺀다(가장 큰 SDK·gRPC가 다시 묶인다) | CF4-01, CF4-03 |
| M-05 | next.config | `@opentelemetry/api` 하나를 뺀다 | CF4-01, CF4-03 |
| M-06 | package.json | `@opentelemetry/sdk-node` 판 적기를 `^0.300.0`으로(platform은 `0.300.0`) | CF4-02 |
| M-07 | package.json | 여섯을 `dependencies`가 아니라 `devDependencies`에 넣는다(운영 설치·SBOM `--prod`에서 빠진다) | CF4-02 |
| M-08 | next.config | 여섯을 `serverExternalPackages` 대신 `transpilePackages`에 넣는다 | CF4-01, CF4-03 |
| M-09 | next.config | 여섯을 둘째 `serverExternalPackages` 키로 따로 둔다 | CF2-01(키 하나), CF4-01 |
| M-10 | next.config | `'@peaket/platform'`을 빼고 여섯만 넣는다 | CF4-01 |
| M-11 | instrumentation | 고치는 대신 `instrumentation.ts`의 `import()`에 `/* turbopackIgnore: true */`를 단다(길 나) | CF4-03(덩어리 없음)·CF4-04, R-2 |
| M-12 | 기준선 | 고치는 대신 `js-baseline.json`의 `web /`를 175.2, `web /my/tickets`를 160.9로 올린다(길 마) | CF4-01·02·03·04 |
| M-13 | 산출물 | (검증 사본에서만) 구현 뒤 운영 빌드의 standalone `apps/web/.next/node_modules/@opentelemetry/sdk-node-*` 연결을 지운다 | CF4-04, R-2 |

- 표본 밖에서 검증 담당이 더 넣어도 된다(예: 여섯 가운데 다른 하나를 뺀 것, 이름 오타).

## 검증

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | w8l1-cifix4-plan-71c0e94b | claude-opus-5-5 | 2026-11-16T23:25+09:00 | 2026-11-17T00:15+09:00 |
| impl | w8l1-cifix4-impl-d61b0a37 | claude-opus-5-5 | 2026-11-17T00:15+09:00 | 2026-11-17T00:25+09:00 |
| test | w8l1-cifix4-test-0e7c93a4 | claude-opus-5-5 | 2026-11-17T00:25+09:00 | 2026-11-17T00:40+09:00 |
