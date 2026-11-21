# 작업 계획: W12-ci-web(화면 쪽 숨은 CI 실패 셋: partner 린트 시험·seats 타입 검사 차례·queue-room 대기)

- **무엇**: `develop`의 CI 실패 가운데 화면 쪽 셋을 가르고 고칠 곳을 정한다. 셋 다 바뀐 경로에 화면이 있을 때만 도는 잡이고, `develop` CI가 2026-11-19부터 다른 잡(tools-check·contract-check 등)으로 이미 빨개서 새 실패가 묻혔다. 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane2-b176`, 가지 `feature/lane2-W12-ci-web`, 출발점 `origin/develop` `dd9f08485`. 2026-11-21 작성. 감독이 맡긴 묶음이라 갈래 2 밖 파일도 고친다(아래 4).
- **근거 실행**: GitHub Actions 44910775075(PR #45, 머리 `568e1cc58`), 44912722163(`develop` 푸시, `dd9f08485`). 로그는 `gh run view <실행> --repo peaket/peaket --job <잡> --log-failed`로 봤다.
- **차례**: 정방향(계획 → 구현 → 시험 → 리뷰·검증 → 기록, `Batch-Order: impl-first`). 구현은 워크플로 한 곳(실패 ②), 시험은 시험 파일 한 곳(실패 ①)을 고친다. 실패 ③은 코드를 고치지 않는다. 새 ADR·정본 고침은 없다.

## 감독에게

1. **갈래 4 몫(고치지 않음)**: seats 잡 설치 단계의 `@swc/core postinstall` 오류(`ERR_SWC_NATIVE_CACHE`, PR #45 seats 로그 318·329줄, 첫 실패 실행 44740952185에도 있음). 원인 후보: 컨테이너 잡의 설치 단계 `HOME`이 `/github/home`이고, SWC가 그 아래 `.cache`의 부모 폴더가 다른 사용자도 쓸 수 있다고 보고 네이티브 묶음을 거절한 뒤 wasm 대체본 옮기기도 실패(`ENOENT … rename`, 373줄). 설치 단계는 끝 코드 0으로 지나가고 seats 실패의 원인이 아니다(아래 2). 같은 잡의 Playwright 단계처럼 `HOME: /root`를 주는 길이 후보다.
2. **node 잡의 남은 일**: Turborepo는 첫 실패에서 멈춘다. 44912722163의 node 잡은 36개 일 가운데 25개만 끝내고 `@peaket/partner#test`에서 멈췄다(`@peaket/web:test`는 시작만 함). 실패 ①을 고치면 남은 11개가 처음 돈다. 거기서 새 실패가 나오면 이 묶음에서 고치지 않고 새 일로 넘긴다(ADR-0283 결정 6). 로컬에서는 web 단위 시험 1,031개가 모두 통과했다(아래 2).
3. **흔들림 정리 목록 한 줄(실패 ③)**: 아래 3의 문안을 `docs/lanes/lane2-cleanup.md`에 기록 커밋에서 더하기를 권한다. 실행 44910775075의 실패 산출물 `queue-room-checks`(4,467바이트, 7일 보관)에 그 시험의 `error-context.md`(실패 때 화면 모습)가 있다. 이 계획은 내려받지 않았다. 원인 후보 가르기에 쓸 수 있다.
4. **정본 어긋남 하나(이 묶음 밖)**: ADR-0329 상태 줄이 아직 "제안 … 아직 커밋하지 않았다"다. 규칙은 a79a82834로 이미 들어갔고 정본 `docs/frontend.md` §2.2도 고쳐졌다. 채택 여부는 소유자 몫이라 이 묶음은 고치지 않는다.
5. **초안 PR**: seats·queue-room은 무거운 브라우저 잡이라 확인은 초안 PR CI 하나로 한다(ADR-0331 결정 7). 가지 올리기와 초안 PR 열기는 감독 몫이다. 이 묶음이 바꾸는 `apps/`·`.github/workflows/ci-web.yml`이 바뀐 범위 `js`·`web`을 켜므로(`tools/ci/changes.mjs` 79행) 세 잡이 모두 돈다.

## 계획

### 1. 실패 ① `node / node` → `@peaket/partner#test`

- **실패**: `apps/partner/src/_pages/seatmap-editor/security.test.mjs:22` 'konva는 CMP-051 폴더 밖에서 가져오지 않는다 [ASVS v5.0.0-15.1.4]'. 25행 단언이 `['no-restricted-imports']`를 기대하는데 실제는 `['no-restricted-imports', 'peaket-web-boundaries/route-reexport-only']`다(PR #45 node 로그 784~805줄, `develop` 44912722163도 같음).
- **재현(로컬, `dd9f08485`)**: `pnpm --filter @peaket/partner test` → 195개 중 194 통과, 1 실패(같은 시험, 같은 차이). 한 파일만은 `pnpm --filter @peaket/partner exec node --test src/_pages/seatmap-editor/security.test.mjs`(6개 중 1 실패).
- **원인**: 25행 표본은 Next.js 경로 파일(`apps/partner/app/(console)/events/[id]/seatmap/page.tsx`)에 `import Konva from 'konva';` 다음 `export const k = Konva;`를 둔다. a79a82834(2026-11-21, QR-MA-2, ADR-0329)가 경로 파일 규칙 `peaket-web-boundaries/route-reexport-only`(`packages/config/eslint/web-boundaries.mjs` 284~312행)를 켰고, 이 규칙은 경로 파일의 `export const`를 경로 설정 이름이 아니면 막는다. 그래서 표본 하나가 konva 금지와 경로 파일 규칙을 함께 어긴다. konva 금지는 그대로 걸린다.
- **어느 쪽이 정본에 맞나**: 규칙이 맞다. 정본 `docs/frontend.md` §2.2 'Next.js 경로 폴더' 행이 경로 파일에는 다시 내보내기와 글자 값 경로 설정만 둔다고 적고, ADR-0329 결정 5가 그 규칙을 정했다. konva 금지(`eslint.config.mjs` 99~115행 `PARTNER_KONVA_OUTSIDE`, ADR-0264 결정 2)는 `apps/partner/app/**`를 덮고 잃은 것이 없다. 시험 표본이 새 정본에 뒤처졌다.
- **고칠 곳(시험 몫)**: 25행 표본을 경로 파일 규칙이 받는 꼴로 바꿔 konva 금지 하나만 보게 한다. 같은 경로 파일에서 다음 둘을 `['no-restricted-imports']`로 단언한다(로컬에서 두 꼴 모두 정확히 그 결과임을 확인했다, 경로 파일 규칙은 걸리지 않음).
  - 정적 가져오기 뒤 이름 내보내기: `import Konva from 'konva';\nexport { Konva as default };\n`(원래 25행의 '경로 파일 안 정적 가져오기'를 지킨다)
  - 경로 파일의 본디 꼴인 다시 내보내기로 konva를 잇는 우회: `export { default } from 'konva';\n`
  - 단언을 `includes`로 느슨하게 하거나 두 규칙 이름을 함께 기대하지 않는다. 앞은 다른 규칙이 섞여도 못 알아채고, 뒤는 konva 보안 시험을 경로 파일 규칙에 묶는다(그 규칙의 시험은 `packages/config/eslint/web-boundaries.test.mjs`다).
  - 시험 이름과 다른 단언(24·26·28·30·31·34행)은 바꾸지 않는다.
- **왜 미리 안 잡혔나**: a79a82834는 `@peaket/config` 시험과 전체 린트(린트: 코드 규칙 검사기)만 돌렸고 PR 없이 `develop`에 들어갔다(커밋 본문 '확인' 줄). 깨진 시험은 뿌리 `eslint.config.mjs`를 읽는 partner 쪽 시험이라 그 확인에 들지 않았다. 그 뒤 첫 `develop` 실행 44895323580(`417c64e36`)에서 바로 실패했지만 이미 빨간 CI에 묻혔다.

### 2. 실패 ② `web / seats` 타입 검사

- **실패**: seats 잡 `pnpm --filter @peaket/web typecheck`에서 TS2307 `Cannot find module '@peaket/search-normalize/refine'` 셋(`apps/web/src/_pages/search/ui/SearchResults.tsx:15`, `apps/web/src/widgets/app-shell/model/autocomplete.ts:8`·`:11`)과 TS7006 하나(`apps/web/src/widgets/app-shell/model/suggestion-source.ts:75`)(PR #45 seats 로그 415~418줄).
- **재현(로컬, `dd9f08485`, 빌드 산출 `dist/`가 하나도 없는 새 작업 폴더)**: seats 잡과 같은 차례로 `pnpm --filter @peaket/seatmap typecheck`(통과) → `pnpm --filter @peaket/web typecheck` → 같은 오류 넷, 끝 코드 1. `pnpm --filter "@peaket/web^..." run --if-present build`(search-normalize·contracts·validation·platform, 약 6초) 뒤 다시 돌리면 통과한다. 이어서 잡의 다음 두 단계도 돌려 봤다: `pnpm --filter @peaket/seatmap test` 128/128, `pnpm --filter @peaket/web test` 1,031/1,031.
- **원인**: 잡 차례 문제다. `@peaket/search-normalize`는 `./refine`을 빌드 산출(`dist/refine.d.ts`·`dist/refine.js`)로만 내보낸다(`packages/search-normalize/package.json` `exports`). seats 잡(`.github/workflows/ci-web.yml` 428~467행)은 설치(445행) 바로 뒤 타입 검사(447~448행)와 단위 시험(449~450행)을 돌고, 의존 패키지 빌드는 그 뒤의 `node seed-css/build.mjs web`(452행, 스크립트 26행이 `--filter "@peaket/web^..." run --if-present build`)에서야 한다. TS7006은 같은 원인의 뒤따른 오류다: 못 찾은 모듈에서 다시 내보낸 `refineLocally`가 `any`가 되어 콜백 인자 `s`의 타입을 정하지 못한다. 단위 시험도 같은 dist를 읽는다(`autocomplete.test.mjs` 81행이 `packages/search-normalize/dist/index.js`를 가져온다).
- **언제부터**: 잡을 만든 ac2dd3cfa(2026-11-20, BAT-182 HOT-357) 때부터다. `develop`에 들어간 첫 실행 44740952185(`57de13831`)부터 매번 같은 오류로 실패했고, 한 번도 타입 검사 뒤 단계(단위 시험·5만 석 화면 시나리오)를 CI에서 돌지 못했다. `./refine`과 웹의 가져오기는 그 전부터 있었다(22138bda0·9e474282b, 2026-11-16, 둘 다 `Batch: BAT-165`, HOT-270·280). 감독 메모의 'BAT-167 refine'은 BAT-167이 아니라 이 BAT-165 커밋들이다.
- **같은 꼴 훑기**: `ci-web.yml`에서 빌드 전에 화면 앱의 타입 검사·단위 시험을 도는 잡은 seats 하나다(tokens는 `@peaket/ds`, budgets는 `@peaket/config`·`@peaket/queue-room` 시험이고 지금 통과한다).
- **고칠 곳(구현 몫)**: `.github/workflows/ci-web.yml` seats 잡의 설치 단계(445행)와 타입 검사(447행) 사이에 의존 패키지 빌드 한 단계를 넣는다.
  ```yaml
      # 소비자 웹이 가져오는 작업 공간 패키지 가운데 빌드 산출(dist)로만 내보내는 것(@peaket/search-normalize/refine 등)을 먼저 만든다.
      # 타입 검사와 단위 시험(autocomplete.test.mjs가 dist를 읽는다)이 그것을 본다. seed-css/build.mjs 첫 단계와 같은 명령이다
      - run: pnpm --filter "@peaket/web^..." run --if-present build
  ```
  - 좌석맵 패키지는 dist에 기대지 않는다(의존이 `@peaket/ds`·`zod`뿐, 위 재현에서 빌드 없이 통과). 필터에 넣지 않는다.
  - 다른 단계·잡은 바꾸지 않는다. `turbo run typecheck`(의존 빌드를 저절로 함)로 바꾸는 길은 의존 패키지 전부의 타입 검사까지 더 돌아 고르지 않았다.

### 3. 실패 ③ `web / queue-room` 대기 — 흔들림

- **실패**: WebKit 한 엔진에서 `tools/web-checks/queue-room/tabs.spec.mjs:178` 'FE-T6 차례가 오면 입장 확정은 보이는 리더만 한 번 보낸다(…)'가 189행 `leader.waitForURL(/\/booking\//, { timeout: 30_000 })`에서 30초를 넘겼다(PR #45 queue-room 로그 364·381~401줄, 36개 중 35 통과, 다시 시도 없음). 같은 시험이 Chromium 4.9초, Firefox 5.0초에 통과했다.
- **판정: 흔들림(코드가 같아도 가끔 실패하는 시험).** 근거 둘과 다시 돌리기 하나.
  - **같은 코드가 통과**: PR 머리 `568e1cc58`과 `develop` `dd9f08485`는 `apps/web`·`tools/web-checks`·`packages`·`.github`가 같다(`git diff --stat` 빔). `develop` 44912722163의 queue-room은 통과했다. PR #45가 기준 대비 바꾼 화면 쪽 파일은 `apps/web/Dockerfile`과 `tools/web-checks/seats/server.mjs`뿐이고 이 잡은 둘 다 쓰지 않는다.
  - **이력**: 2026-11-16~21 `ci.yml` 실행 199개 가운데 queue-room이 끝난 58개는 성공 52·실패 2·취소 4다. 다시 돌린 실행 11개의 앞 시도에는 queue-room 실패가 없었다. 다른 실패 하나도 WebKit 여러 탭 시험이다: 44354516602(2026-11-18, BAT-171 PR)의 `tabs.spec.mjs:144` 'FE-T6 리더가 멈춰 방송이 끊기면 …'이 1.5분 뒤 `page.goto: Test ended`로 끝났다. 앞선 기록도 WebKit이다(`docs/lanes/lane1-cleanup.md`의 FE-T3 WebKit 흔들림, 실행 42707868451).
  - **다시 돌리기**: 이 묶음은 queue-room 쪽 파일을 바꾸지 않으므로 초안 PR의 같은 잡이 다시 돌리기를 겸한다. 결과는 검증 담당이 '검증' 절에 적는다. 계획 담당은 남의 PR(#45) 잡을 다시 돌리지 않았다.
- **시험이 기다리는 조건**: 대기표 앞 인원 15·처리 속도 5(약 3초 뒤 차례)로 첫 탭을 열고 1.5초 기다린 뒤 보이는 탭·숨긴 탭을 연다. 첫 탭이 폴링 리더 잠금(`queue-poll:{회차}`, `apps/web/queue-room/src/live/tabs.ts` 82~102행)을 쥐고, 차례가 오면 그 탭만 입장 확정을 보내고 `/booking/`으로 간다(`apps/web/queue-room/src/live/controller.ts` 668~669행 `leaderNow`).
- **원인 후보(가르지 못함)**:
  - (가) 리더가 바뀜: 첫 탭이 잠금을 청하는 때는 대기표 확인 뒤 `setActive(true)`(controller 597행)다. 느린 CI WebKit에서 그것이 1.5초 고정 대기보다 늦으면 두 번째 탭이 먼저 잠금을 쥐고 입장해 이동하고, 첫 탭은 방송을 받아 '이미 다른 기기나 탭의 대기표로 입장했습니다' 화면에 남는다. 그러면 189행이 30초를 기다린다. 산출물의 `error-context.md`에 그 화면이 있으면 (가)다.
  - (나) WebKit 페이지 멈춤: 한 문맥에 탭 셋을 여는 WebKit이 CI 컨테이너에서 가끔 멈춘다(위 두 기록과 같은 꼴).
- **처리**: 이 묶음에서 코드·시험을 고치지 않는다. 초안 PR CI에서 다시 본다. 정리 목록 문안(감독에게 3): "CI 흔들림(568e1cc58, 실행 44910775075): 대기실 FE-T6 WebKit '차례가 오면 입장 확정은 보이는 리더만 한 번 보낸다'가 `leader.waitForURL` 30초를 넘겼다. 같은 트리의 develop 실행 44912722163은 통과했다. 2026-11-16~21 58회 중 2회 실패, 둘 다 WebKit `tabs.spec.mjs`(다른 하나는 44354516602의 144행). 후보: 1.5초 고정 대기 뒤 리더가 첫 탭이 아님(첫 탭이 리더 잠금을 쥔 것을 확인하고 다음 탭을 열면 풀린다), 또는 WebKit 여러 탭 멈춤". 같은 시험이 한 번 더 흔들리면 (가)를 가정하고 고정 대기 대신 첫 탭의 리더 확인을 기다리게 고치는 시험 묶음을 연다.

### 4. 손댈 파일과 담당

| 담당 | 파일 | 할 일 | 영역 |
| --- | --- | --- | --- |
| 구현 | `.github/workflows/ci-web.yml` | seats 잡에 의존 패키지 빌드 한 단계(위 2) | 공용(BAT-182가 만든 잡) |
| 시험 | `apps/partner/src/_pages/seatmap-editor/security.test.mjs` | 25행 표본을 경로 파일이 받는 꼴 둘로(위 1) | 파트너 콘솔 |

- 구현 커밋은 시험 파일을, 시험 커밋은 시험 파일과 이 계획 파일 밖을 건드리지 않는다(§8.6 '바꾸는 파일').
- 바꾸지 않는 것: `packages/config/eslint/web-boundaries.mjs`·`eslint.config.mjs`(규칙은 정본대로), `tools/web-checks/queue-room/**`·`apps/web/queue-room/**`(실패 ③), seats 잡의 다른 단계(아래 7).
- **시험 담당이 따로 쓸 새 시험은 없다.** 실패 ②는 워크플로 차례라 seats 잡 자체가 재현이고(W8-L2-ci-loadtest와 같은 꼴), 잡 글을 견주는 구조 시험은 설정을 시험에 다시 적는 일이라 더하지 않는다. 시험 담당은 실패 ①의 기존 시험 고침만 맡는다.

### 5. 확인 방법

- **구현 담당(커밋 전 최소 확인)**: 작업 폴더 뿌리에서 빌드 산출이 없는 상태로(`packages/{search-normalize,contracts,validation,platform}/dist`가 있으면 지우고) 고친 seats 잡의 차례대로 `pnpm --filter "@peaket/web^..." run --if-present build` → `pnpm --filter @peaket/seatmap typecheck` → `pnpm --filter @peaket/web typecheck`. 둘 다 끝 코드 0이어야 한다. 계획 담당은 재현 뒤 자기가 만든 dist 넷을 지워 두었다(계획 커밋 때 이 폴더에 `packages/*/dist`가 없다).
- **시험 담당**: `pnpm --filter @peaket/partner exec node --test src/_pages/seatmap-editor/security.test.mjs` 6/6, `pnpm --filter @peaket/partner test` 195/195. `pnpm lint` 오류 0(시험 파일도 화면 규칙을 받는다).
- **초안 PR CI(감독이 연다, ADR-0331 결정 7)**: `node / node`(partner 시험 통과, 남은 일 11개가 처음 돈다: 감독에게 2), `web / seats`(타입 검사·단위 시험·`pnpm run seats` 화면 시나리오가 CI에서 처음 끝까지 돈다), `web / queue-room`(실패 ③ 다시 보기), `ci-summary`. 다른 잡(tools-check·contract-check 등)의 실패는 이 묶음 몫이 아니다.
- 문서: `python -I -X utf8 tools/doc-check/check_all.py` 오류 0.

### 6. 틀린 구현 표본(검증 담당용, B 꼴 4개)

각 표본은 잠깐 넣고 돌린 뒤 `git checkout -- <파일>`로 되돌린다. 기준선은 고친 상태의 `security.test.mjs` 6/6, 위 5의 seats 차례 통과다.

| 번호 | 넣을 곳 | 틀린 구현 | 기대 |
| --- | --- | --- | --- |
| M1 | `eslint.config.mjs` 101행 `PARTNER_KONVA_OUTSIDE.files` | 세 글롭 가운데 `'apps/partner/app/**/*.{…}'` 항목을 뺀다(경로 파일에서 konva 금지를 잃음) | 'konva는 CMP-051 폴더 밖에서 …'만 실패(새 경로 파일 단언 둘). 53행 시험의 표본에는 `app/` 경로 파일이 없어 그대로 통과 |
| M2 | `eslint.config.mjs` 기본 내보내기 배열(128·131행) | `PARTNER_KONVA_OUTSIDE`를 `NO_MOCKS_IN_APPS` 앞으로 옮긴다(같은 규칙 이름의 뒤 설정이 konva 목록을 통째로 덮음, 91행 주석의 위험) | 같은 시험 실패(24행과 새 경로 파일 단언 등 konva 단언). 목업 단언(30·31행)은 통과 |
| M3 | `.github/workflows/ci-web.yml` seats | 더한 빌드 단계를 `pnpm --filter @peaket/web typecheck` 뒤로 옮긴다 | dist를 지운 뒤 잡 차례대로 돌리면 web 타입 검사가 TS2307 셋·TS7006 하나로 실패 |
| M4 | 같은 곳 | 필터를 `"@peaket/seatmap^..."`로 바꾼다(빌드할 대상을 틀림) | M3과 같은 실패(seatmap의 의존에는 빌드할 패키지가 없다) |

- M1·M2는 계획 담당이 저장소 파일을 바꾸지 않고 설정 배열을 메모리에서 바꿔 ESLint에 넘겨 미리 돌려 봤다. 새 경로 파일 표본 둘이 M1·M2에서 모두 아무 오류도 내지 않았다(곧 고친 단언이 실패한다). M2에서는 24행 표본도 오류가 없어졌고 목업 표본은 그대로 막혔다.
- M3·M4는 시험 파일이 아니라 잡 차례가 잡는다. 검증 담당은 dist를 지운 새 상태에서 잡의 `run:` 줄을 적힌 차례대로 돌려 본다(초안 PR을 다시 띄우지 않는다).

### 7. 이번에 안 함

- **seats 잡의 쓰지 않는 운영 빌드 단계**(`node seed-css/build.mjs web`, 452행): BAT-182 리뷰 RV-04(낮음)가 화면 시나리오는 그 빌드를 쓰지 않는다고 짚었다. 빼면 잡이 10분 안팎 줄지만 이 실패와 상관없고 리뷰 낮음이라 정리 몫이다(ADR-0331 결정 5).
- **설치 단계 `@swc/core` 오류**: 갈래 4 몫(감독에게 1).
- **실패 ③의 시험 고침**: 위 3 '처리'.
- **ADR-0329 상태 줄**: 감독에게 4.

## 실패 확인

실패 ①은 시험 표본만 바꾸고 제품 코드는 그대로라 고친 시험은 기준 트리에서도 통과한다. ADR-0331 결정 2대로 고친 단언이 틀린 규칙에서 실패하는지는 검증의 M1·M2가 본다. 여기에는 고치기 전·뒤 결과를 적는다.

- **고치기 전(구현 커밋 `bd6c92c4b`, 시험 파일은 `dd9f08485`와 같음)**: `pnpm --filter @peaket/partner exec node --test src/_pages/seatmap-editor/security.test.mjs` → 6개 중 5 통과·1 실패. 실패는 22행 'konva는 CMP-051 폴더 밖에서 가져오지 않는다 [ASVS v5.0.0-15.1.4]'의 25행 단언이다. 실제 `['no-restricted-imports', 'peaket-web-boundaries/route-reexport-only']`, 기대 `['no-restricted-imports']`로 CI 로그와 같은 차이다.
- **고친 뒤**: 같은 명령 6/6 통과, 실패 0.

## 구현

- **바꾼 것**: `.github/workflows/ci-web.yml` seats 잡의 설치 단계 바로 뒤, `pnpm --filter @peaket/seatmap typecheck` 앞에 위 2의 단계(주석 두 줄과 `- run: pnpm --filter "@peaket/web^..." run --if-present build`)를 계획 글 그대로 넣었다. 다른 단계·잡은 그대로다. 같은 워크플로에는 이 꼴의 단계가 없었고(`ci-node.yml`의 `turbo run build --filter=…^...`는 turbo를 쓰는 잡이다), 명령은 `tools/web-checks/seed-css/build.mjs` 26행과 같은 꼴이다.
- **확인(작업 폴더 뿌리, 시작 때 `packages/*/dist` 없음)**: 고친 잡의 차례대로 의존 빌드(끝 코드 0, search-normalize·contracts·validation·platform의 dist 넷이 생김) → `pnpm --filter @peaket/seatmap typecheck` 0 → `pnpm --filter @peaket/web typecheck` 0 → `pnpm --filter @peaket/seatmap test` 128/128 → `pnpm --filter @peaket/web test` 1,031/1,031. 워크플로 검사 `node tools/ci/check-workflows.mjs`(워크플로 23개 통과)·`check-docker-timeouts.mjs`·`check-lint-disables.mjs`·`check-workspace-protocol.mjs` 모두 0, 워크플로를 읽는 시험 `node --test`(check-workflows·changes·ci-summary·check-docker-timeouts·web-test-split·security-scan-workflow) 130개 중 129 통과·실패 0(1개는 CI 밖에서 건너뛰는 시험). `python -I -X utf8 tools/doc-check/check_all.py` 오류 0(경고 4는 이 묶음과 상관없는 기존 경고). 확인 뒤 만든 dist 넷은 지웠다.
- **더함(초안 PR #51 CI 실행 44917763456)**: seats 잡이 타입 검사를 지나 `pnpm --filter @peaket/web test`까지 갔으나, web의 test 스크립트가 함께 도는 `queue-room/test/edge.test.mjs`·`vite-config.test.mjs`가 `ERR_MODULE_NOT_FOUND: Cannot find package 'vite'`로 실패했다. 설치 단계 필터가 `@peaket/seatmap...`·`@peaket/web...`뿐이라 `@peaket/queue-room`의 의존(vite)이 깔리지 않았다. 설치 단계에 `--filter "@peaket/queue-room..."`를 더했다(같은 워크플로의 다른 잡이 queue-room을 까는 꼴과 같다). 시험 파일과 web test 스크립트는 그대로다. 확인: 필터 이름이 `apps/web/queue-room/package.json`의 이름과 같고 `pnpm ls -r --depth -1`에 세 필터로 `@peaket/queue-room`이 잡힌다(vite는 그 devDependencies에 있다). 워크플로 검사 넷 0, `node --test tools/ci/check-workflows.test.mjs` 63개 중 62 통과·실패 0(1개 건너뜀). 필터 설치는 로컬에서 흉내 내지 못해 초안 PR CI로 본다.

## 시험 결과

- **바꾼 것**: `apps/partner/src/_pages/seatmap-editor/security.test.mjs` 25행 단언 하나를 위 1의 두 꼴로 바꿨다. 같은 경로 파일(`apps/partner/app/(console)/events/[id]/seatmap/page.tsx`)에서 `import Konva from 'konva';` 뒤 `export { Konva as default };`, 그리고 `export { default } from 'konva';`가 각각 정확히 `['no-restricted-imports']`인지 본다(`deepEqual`, 느슨한 `includes` 아님). 기대 규칙은 정본의 konva 금지(ADR-0264 결정 2)이고, 경로 파일 규칙(`docs/frontend.md` §2.2, ADR-0329 결정 5)은 걸리지 않아야 한다. 표본 위에 그 꼴을 고른 까닭을 한 줄 주석으로 달았다. 시험 이름과 다른 단언은 그대로이고 새 시험은 없다.
- **결과(작업 폴더 뿌리)**: 위 한 파일 6/6. `pnpm --filter @peaket/partner test` 195/195(실패 0, 건너뜀 0). 이 폴더엔 `packages/*/dist`가 없어 처음엔 `instrumentation.test.mjs` 셋과 `sale-policy/model/form.test.mjs`가 dist 없음으로 실패했다. CI처럼 의존 패키지를 먼저 빌드(`pnpm --filter "@peaket/partner^..." run --if-present build`, contracts·validation·platform)한 뒤 다시 돌린 결과이고, 확인 뒤 만든 dist 셋은 지웠다. `pnpm lint` 끝 코드 0. `python -I -X utf8 tools/doc-check/check_all.py` 오류 0(경고 4는 구현 절과 같은 기존 경고).

## 리뷰

- 담당 `lane2-w12ciweb-review`(claude-opus-5-5). 짧은 대조 리뷰(ADR-0283 결정 2, ADR-0331)다. 범위는 `dd9f08485..9092f4d26`(계획 `d8f064e8f`, 구현 `bd6c92c4b`, 시험 `9092f4d26`)이다. 코드·시험은 고치지 않았다.
- **막는 지적(높음·보안·통과 기준)은 없다.** 대조한 것:
  1. **계획 항목**: 위 4 표의 두 파일만 바뀌었다. 구현은 2의 단계를 주석 두 줄까지 글자 그대로, 설치 단계와 `pnpm --filter @peaket/seatmap typecheck` 사이(`ci-web.yml` 446~448행)에 넣었다. 시험은 1의 두 꼴을 `deepEqual`로 넣었고, 시험 이름과 다른 단언(24·29·31·33·34행)은 그대로다. 바꾸지 않기로 한 `eslint.config.mjs`·`web-boundaries.mjs`·대기실 쪽 파일은 diff에 없다.
  2. **정본**: 경로 파일 규칙(`web-boundaries.mjs` `routeReexportOnly`)은 가져오기, `export { … }`, `export … from`, `export *`, 이름 하나짜리 `export default`만 받는다. 새 표본 둘은 그 꼴이라 ADR-0329 결정 5와 맞는다. konva 금지(ADR-0264 결정 2, `eslint.config.mjs` 99~115행)는 지금도 `apps/partner/app/**`를 덮는다.
  3. **시험이 약해졌나**: 저장소 파일은 그대로 두고, 뿌리 설정 배열을 메모리에서 바꿔 ESLint에 넘겨 봤다. 원래 설정에서 두 표본은 정확히 `['no-restricted-imports']` 하나만 내고, 알림 글도 konva 금지의 것이다. konva 설정에서 `app/**` 글롭을 빼면(검증 표본 M1) 둘 다 `[]`가 된다. konva 묶음만 빼도 둘 다 `[]`다. 그러니 고친 단언은 konva 금지를 잃으면 떨어진다. 다른 규칙 때문에 우연히 맞는 것이 아니다. 옛 표본(`export const k`)은 konva 금지를 잃어도 경로 파일 규칙 하나가 남는 자리였다. 새 표본은 다시 내보내기로 잇는 우회(`export { default } from 'konva'`)도 막는지 본다. 그래서 '경로 파일에서도 konva 금지'를 지키는 범위가 오히려 넓어졌다. 이 폴더에서 `security.test.mjs`를 다시 돌려 6개 모두 통과했다.
  4. **seats 빌드 단계**: `@peaket/web`이 기대는 작업 공간 패키지 가운데 `build` 스크립트가 있는 것은 contracts·platform·search-normalize·validation 넷뿐이다(`packages/*/package.json`). 넷 다 설치 필터 `@peaket/web...` 안에 있다. pnpm은 여러 패키지 스크립트를 의존 차례대로 돌므로, platform·validation보다 contracts를 먼저 빌드한다. 좌석맵 쪽 의존(ds·config)에는 빌드할 것이 없다. 이 잡에는 캐시(`actions/cache`, turbo 원격 캐시)가 없어서 캐시가 낡을 걱정도 없다. 더한 시간은 계획 재현 기준 약 6초로, 잡 상한 35분에 견주면 작다(같은 빌드를 뒤에서 한 번 더 하는 것은 RV-04). 리뷰가 `node tools/ci/check-workflows.mjs`를 다시 돌려 워크플로 23개 모두 통과했다.
  5. **역할 경계·꼬리말**: 구현 커밋 `bd6c92c4b`는 `ci-web.yml`과 이 파일만 바꿨다. 시험 커밋 `9092f4d26`은 시험 파일과 이 파일만 바꿨다. 세 커밋 모두 꼬리말 덩이(Role·Agent-Session·Agent-Model·Batch·Co-Authored-By, 계획은 `Batch-Order: impl-first`도)를 갖췄고, 세션 ID가 담당 표 행과 같다. `node tools/ci/roles-check.mjs --base dd9f08485`의 실패는 '코드(정방향) 묶음에 review·verify 커밋이 없다' 하나뿐이다(이 커밋과 검증이 채운다).
- 지적은 모두 중간·낮음이다. 이 묶음에서 고치지 않고 정리 목록으로 넘긴다(ADR-0331 결정 5).

| 번호 | 등급 | 자리 | 근거 | 고칠 방향 |
| --- | --- | --- | --- | --- |
| RV-01 | 중간 | 이 계획 '감독에게' 2, 5 '초안 PR CI'의 seats 줄 | seats 잡은 BAT-182에서 생긴 뒤로 CI에서 타입 검사 다음 단계(단위 시험, `node seed-css/build.mjs web`, `pnpm run seats`)를 한 번도 돌지 못했고, 이 묶음 뒤에 처음 돈다. 그런데 '새 실패는 이 묶음에서 고치지 않고 새 일로'(ADR-0283 결정 6)라는 판정 기준은 node 잡에만 적혀 있다. 또 로컬 확인은 전체 설치에서 했지만, CI는 일부만 설치한다(작업 공간 34개 중 10개, 실행 44912722163 seats 로그 250행). 리뷰가 web 시험 파일 127개의 가져오기를 훑었다. 설치 범위 밖에서 가져오는 것은 `services/identity-svc/scripts/mock-idv.mjs`(Node 내장 모듈만 씀)와 뿌리 개발 의존 `yaml`(같은 로그 389~394행에서 설치됨)뿐이었다. 그래서 막힐 곳은 보이지 않는다 | 검증 담당이 '검증' 절에 seats 판정 기준을 적는다: 'web 타입 검사 통과까지가 이 묶음 몫이고, 그 뒤 단계의 새 실패는 감독에게 2처럼 새 일로 넘긴다'. 계획을 고치는 커밋은 필요 없다 |
| RV-02 | 낮음 | `apps/partner/src/_pages/seatmap-editor/security.test.mjs:27~28` | 두 표본이 konva 금지 하나만 내는 것은, 경로 파일 규칙이 무엇을 다시 내보내는지(출처)를 보지 않아서다. `'konva'`에서 가져와도 받는다. 정본 `docs/frontend.md` §2.2 'Next.js 경로 폴더' 첫 문장은 'src/_pages·src/_app의 것을' 다시 내보낸다고 출처까지 말한다. 반면 ADR-0329 결정 5와 규칙은 문장 꼴만 본다. 뒤에 규칙이 출처까지 보게 바뀌면, 두 표본에 규칙이 다시 둘 걸려 이번과 같은 꼴로 깨진다 | 지금은 고치지 않는다. 경로 파일 규칙에 출처 검사를 더하는 묶음이 생기면, 그 묶음이 이 단언도 함께 고친다(경로 파일 표본은 konva 알림 글이 정확히 하나인지만 보고, 경로 파일 규칙은 `web-boundaries.test.mjs`가 맡는다). §2.2 문장과 규칙이 다른 점은 정리 목록에 한 줄로 적는다 |
| RV-03 | 낮음 | `security.test.mjs:27~28` | 경로 파일 규칙이 받는 꼴 가운데 `export * from 'konva'`와 `import Konva from 'konva'; export default Konva;`는 표본에 없다. 리뷰가 돌려 보니 둘 다 지금 설정에서는 정확히 `['no-restricted-imports']`를 내고, M1에서는 `[]`가 된다. 지금도 막히지만, 시험이 지켜 주지는 않는다 | 다음에 이 파일을 고칠 때 같은 경로 파일 표본 둘을 더한다(정리 목록) |
| RV-04 | 낮음 | `.github/workflows/ci-web.yml:448`·`:455`, 이 계획 7 첫 줄 | (가) 새 단계(448행)와 `seed-css/build.mjs` 26행의 첫 단계가 같은 의존 빌드를 두 번 한다. tsc 증분 빌드 설정이 없어서 두 번째도 약 6초가 든다. (나) 계획 7이 BAT-182 RV-04에서 옮겨 적은 '운영 빌드 단계를 빼면 잡이 10분 안팎 준다'는 CI에서 잰 값과 맞지 않는다. 같은 실행 44912722163에서 reflow 잡의 `node seed-css/build.mjs web partner console`(`PEAKET_BUILDS=prod`)은 39초, budgets 잡의 `node seed-css/build.mjs`는 34초였다 | (가)는 받아들인다. 다만 정리 때 BAT-182 RV-04대로 455행을 빼더라도 448행은 남겨야 한다(그때는 그것이 유일한 의존 빌드다). 그 정리 줄에 이 점을 적는다. (나)는 그 정리 줄에 잰 값(1분 안쪽)을 적어 우선순위를 낮춘다 |
| RV-05 | 낮음 | 이 계획 '감독에게' 4, 7 끝 줄 | 이 계획을 커밋한 뒤(23:47) `develop`의 `c06b480cf`(2026-11-21 23:58)가 ADR-0329 상태를 '채택'으로 바꿨다. 그래서 '감독에게' 4는 이미 처리됐다. 출발점 뒤 `develop` 커밋들은 이 묶음 파일(`ci-web.yml`, 시험 파일, ESLint 설정 둘, `apps/web`, `packages/search-normalize`)을 건드리지 않아 겹치지 않는다 | 기록 때 감독이 '감독에게' 4를 처리됨(`c06b480cf`)으로 적고 넘긴다. 따로 고칠 커밋은 없다 |

- **판정: 통과.** 막는 지적이 없으므로 검증으로 넘긴다. 남은 확인은 초안 PR CI 몫이다: node 잡의 남은 일 11개, seats 잡의 첫 끝까지 실행(RV-01), queue-room 다시 보기.

## 검증

(검증 담당이 채운다)

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | lane2-w12ciweb-plan | claude-opus-5-5 | 2026-11-21T23:10+09:00 | 2026-11-21T23:50+09:00 |
| impl | lane2-w12ciweb-impl | claude-opus-5-5 | 2026-11-21T23:48+09:00 | 2026-11-22T00:28+09:00 |
| test | lane2-w12ciweb-test | claude-opus-5-5 | 2026-11-22T00:04+09:00 | 2026-11-22T00:10+09:00 |
| review | lane2-w12ciweb-review | claude-opus-5-5 | 2026-11-22T00:12+09:00 | 2026-11-22T00:32+09:00 |

## 기록

(감독이 채운다)
