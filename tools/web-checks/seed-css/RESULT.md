# FE-T36 PoC 결과 — SEED CSS 싣기와 층 순서

- **언제·무엇으로**: 2026-11-04, BUILD_ORDER BAS-170(wbs 0.6.1). `@seed-design/css` 3.1.0, Next.js 16.4(Turbopack), webpack 5, Vite 8, Tailwind 4.3.3, Playwright 1.64.1. 앱 다섯을 이 PC(Windows 11)에서 두 번 빌드했다: 경로 검사는 운영 빌드(`PEAKET_POC` 없이), 탐침은 PoC 빌드(`PEAKET_POC=seed-css`. Vite·webpack은 탐침 진입점 하나만 묶는다).
- **브라우저**: Chromium·WebKit은 이 PC와 컨테이너(`mcr.microsoft.com/playwright:v1.64.1-noble`, 다이제스트 고정) 둘 다, Firefox는 컨테이너에서 봤다(이 PC의 Firefox 1555가 side-by-side 구성 오류로 뜨지 않았다). 컨테이너의 세 엔진은 이 PC에서 띄운 서버를 `host.docker.internal`로 봤다.
- **판정 기준**: docs/frontend.md §5.17 FE-T36(이 PoC로 ①의 판정을 '처음 나온 차례'로 고쳤다).

## 결과

| 항목 | 결과 |
| --- | --- |
| ① 층 차례 | 다섯 앱 모두 맞다. 빌드 도구(lightningcss)는 층 순서 선언문을 그 차례의 층 블록(`@layer theme{…}`… 빈 `@layer seed-components;`)으로 바꾸고, Tailwind는 자기 `properties` 층을 맨 앞에 둔다. 그래서 '첫 규칙이 선언문인지' 대신 '층을 가진 첫 CSS가 여섯 층을 정한 차례로 처음 선언하는지'로 본다. `properties`가 맨 앞이 아니면 실패로 본다 |
| ② SEED 규칙의 층 | 고친 뒤 다섯 앱 모두 SEED base는 `seed-base`, 탐침이 쓴 recipe(action-button)는 `seed-components` 안이다. 고치기 전 Next.js 두 앱은 recipe가 층 밖이었다(아래 결함 1) |
| ③ SEED 전체 CSS | 없다(표지 `.seed-manner-temp`가 없다) |
| ④ 계산된 스타일 | 고친 뒤 다섯 앱 × 세 엔진 모두 맞다: 같은 요소의 `px-8`이 SEED 여백을 이기고(32px), SEED 버튼 배경은 Tailwind 초기화에 지워지지 않고 피켓 주조색이다 |
| 루트 color-scheme | 고친 뒤 다섯 앱의 탐침(라이트) 화면 × 세 엔진 모두 운영체제 다크에서도 `light`(스캐너는 `light only`)다. 고치기 전에는 SEED base 때문에 모두 `light dark`였다(아래 결함 4) |
| 크기 | 다섯 앱 모두 §5.8 예산을 넘는다(아래 표) |

## 찾은 결함과 고친 것

1. **Turbopack 별칭이 조용히 무시됐다**: `turbopack.resolveAlias`에 `'@seed-design/css/recipes/<부품>' → '@seed-design/css/recipes/<부품>.layered'`처럼 패키지 이름을 대상으로 주자, 빌드는 오류 없이 층 없는 판(`<부품>.mjs`)을 썼다. Turbopack이 대상을 앱 폴더에서 푸는데 앱은 `@seed-design/css`를 직접 잇지 않아 못 찾고 원래 요청으로 돌아간 것으로 본다. 파트너 탐침에서 recipe 규칙 59개가 층 밖이었고, 유틸이 져서 여백이 16px였다. 대상을 `@peaket/ds`가 잇는 판의 층 판 파일 경로로 주게 고쳤다(`packages/ds/scripts/seed-layered-alias.mjs`).
2. **진입점의 가져오기 차례가 층 차례를 깼다**: Vite·webpack은 CSS를 가져온 차례대로 한 파일에 잇는다. 관제 탐침(진입점처럼 부품을 먼저, 전역 CSS를 나중에 가져옴)의 CSS가 `@layer seed-components`로 시작해 그 층이 가장 약한 층이 됐고, Tailwind 초기화가 SEED 여백을 0으로 지웠다. 관제·스캐너·포렌식 진입점(`main.tsx`)이 전역 CSS를 맨 먼저 가져오게 고쳤다. Vite의 PoC 빌드는 진입점이 둘이라 전역 CSS가 공유 덩어리로 빠져 이 결함이 가려졌다(진입점 하나인 운영 빌드에서는 드러난다).
3. 줄인 HTML(html-webpack-plugin)은 속성 값의 따옴표를 빼 검사기가 스타일시트를 놓쳤다(검사기 결함, 고침).
4. **SEED base가 맨 바깥 color-scheme을 바꿨다**(새 맥락 리뷰가 찾음): SEED base의 `:root, [data-seed-color-mode="system"]{color-scheme: light dark}`가 키트의 `.pk{color-scheme: light}`(body)보다 바깥인 `<html>`에 걸려, 운영체제가 다크면 밝은 화면의 바깥 스크롤바가 어둡게 그려졌다`@peaket/ds`의 `ds.css`에 맨 바깥이 키트 테마를 따르는 규칙을 두었다(light-only·dark-only 판은 SEED 규칙 그대로). develop에서는 맨 바깥에 CSS color-scheme이 없어 메타를 따랐다: 웹(`light dark`)·관제·포렌식(`dark light`)은 운영체제를 따랐고, 파트너(메타 없음)는 밝았고, 스캐너는 `light`였다. SEED base는 파트너·스캐너를 바꿨다. 이 규칙은 웹·파트너를 늘 `light`(다크 미리보기 `.pk.dark`는 `dark`), 관제·포렌식을 늘 `dark`로 정해 키트 테마와 맞춘다. 그래서 웹·관제·포렌식은 develop과 다르게 운영체제를 따르지 않는다(동작 변경, 확인 리뷰가 짚음). 메타는 CSS가 실리기 전 첫 그림에만 쓰이고, SEED 색 모드 스크립트를 실을 때(BUILD_ORDER HOT-290) 이 규칙과 함께 다시 맞춘다. 2026-11-05(HOT-291): 소비자 웹이 SEED 색 모드 스크립트를 실어, 운영체제 다크면 `data-seed-user-color-scheme="dark"`로 맨 바깥 `color-scheme`과 키트 바탕이 다크가 된다(`ds.css`·`kit-tokens.css`, 세 엔진 시험 `csp/theme.spec.mjs`).
5. 검사기가 따옴표 밖의 이스케이프(Tailwind `.content-\[\'\'\]`)를 문자열 시작으로 읽어 그 뒤 규칙(소비자 웹 utilities 947개 가운데 613개)을 보지 못했고, 문자열 안의 `/*`를 주석으로 지웠다(새 맥락 리뷰가 찾음, 둘 다 거짓 통과). 문자 단위로 이스케이프·문자열·주석을 가리게 고쳤다.
6. CI에서는 소비자 웹이 가져오는 `@peaket/contracts`의 빌드 산출물(`dist/`, git에 없음)이 없어 웹 빌드가 실패할 자리였다(새 맥락 리뷰가 찾음, 산출물을 치우고 재현). 빌드 스크립트가 앱이 기대는 작업 공간 패키지를 먼저 빌드한다.
7. PoC 빌드(진입점 둘)로 경로를 검사하면 Vite가 전역 CSS를 공유 덩어리로 빼 진입점 차례 결함을 가렸다(새 맥락 리뷰가 찾음). 경로 검사는 운영 빌드로, 탐침은 탐침 진입점 하나만 묶은 PoC 빌드로 나눴다.

## 크기(운영 빌드의 첫 화면 CSS, gzip, kB = 1,000바이트)

| 앱·경로 | §5.8 경로 묶음 | 크기 | 예산 |
| --- | --- | --- | --- |
| web `/`, `/events/…`, `/search`, `/login` | 홈·공연 상세·굿즈, 그 밖 소비자 화면 | 34.2 | 25 |
| web `/booking/…/seats`, `/booking/…/checkout` | 좌석 화면, 결제 화면 | 34.2 | 20 |
| web `/my/tickets` | 월렛 | 34.2 | 15 |
| partner `/events` | 파트너 콘솔 | 31.7 | 30 |
| console `/` | 관제 콘솔 | 31.3 | 30 |
| scanner `/` | 스캐너 | 29.6 | 15 |
| forensics `/` | 포렌식 리플레이 | 29.5 | 20 |

- 화면마다 쓰는 부품과 상관없이 퍼블리싱 키트(`packages/ds/src/styles/kit.css`, gzip 약 18kB, 부품 전부)와 SEED base(약 8kB)가 모든 화면에 실려서다. 소비자 웹은 모든 경로가 같은 CSS를 싣는다.
- 그래서 넘은 경로는 예산을 다시 정하는 wbs 7.5.2(BUILD_ORDER LCH-200)까지 이 값(`css-baseline.json`) + 0.5kB [가정]를 넘지 않게만 막는다(추천 적용 2026-11-04). SEED React로 속을 바꾸는 BAS-180에서 바뀐 부품의 키트 CSS를 빼면 이 값을 낮춘다.
