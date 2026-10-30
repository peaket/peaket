# 설계: 화면 앱 골격과 전체 화면 퍼블리싱

## Context

- 화면 설계의 정본은 docs/design/d5(69개 화면의 셸·와이어프레임·상태 표), d3(화면별 컴포넌트·상태·접근성), d2(토큰 규칙과 CMP 카탈로그), tokens.json이다. 앱 구조와 프레임워크의 정본은 docs/frontend.md §2다.
- 저장소에는 아직 화면 앱·공용 패키지가 없다. 뿌리 `package.json`에는 OpenSpec만 있고 `pnpm-workspace.yaml`에는 공급망 설정만 있다(ADR-0167).
- 같은 시각에 감독 루프(Sidabari4Loop)가 `D:\ticketpass`의 `develop`에서 BUILD_ORDER를 위에서부터 진행하고 있다(지금 FND-010).
- 그림 시안(디자인 캔버스)의 공유 주소는 정본에 없었다(d5 §0.1). 작업 중 소유자가 캔버스(화면 보드 417개, 9쪽, 공용 키트 `peaket.css`)를 넘겨주어(2026-10-31), 이 변경은 캔버스 보드를 시각 기준으로 옮긴다. 보드는 저장소에 복사하지 않고 작업 폴더 밖에서 읽기만 한다(2026-10-30 소유자가 캔버스 복사본을 되돌린 결정).

## Goals / Non-Goals

**Goals**

- 69개 화면 전부를 정본 경로에 정본 셸로 그리고, 화면마다 d5 상태 표의 상태를 골라 볼 수 있게 한다.
- 앱 구조·프레임워크·판은 정본(frontend §2.2·§2.3)대로 두어, 뒤 단계가 구조를 바꾸지 않고 데이터만 잇게 한다.
- 디자인 토큰은 tokens.json 하나에서 만들고, 화면 코드는 시맨틱 토큰만 쓴다(d2 §1).

**Non-Goals**

- 서버 연결, 실시간 연결, 결제·본인확인·사람 확인 SDK, 로그인, 저장소(IndexedDB·서비스 워커), CSP·보안 헤더, 다국어 주소, PWA, Module Federation 원격 적재, 린트 도구, 시험 자동화, 성능 예산 측정. 각자 정본의 단계에서 한다(결정 9).

## Decisions

### 1. 퍼블리싱을 빌드 순서보다 먼저 한다(ADR-0170)

소유자 요청이다. 퍼블리싱은 서버·계약 코드 생성 없이 목업 데이터로 끝나고, 뒤 단계(HOT-290~390 등)는 같은 화면에 데이터만 잇는다. 기능 순서(최소 기반 → v0 → 증명 핵심)는 바꾸지 않는다. BUILD_ORDER에는 이 단계를 '끝남'으로 더하고, 겹치는 단계의 설명에 퍼블리싱이 끝났음을 적어 루프가 같은 화면을 다시 그리지 않게 한다.

### 2. 루프와 부딪치지 않게 따로 작업하고 끝에 합친다

`develop`에 루프의 커밋되지 않은 변경이 있으므로, 이 변경은 git worktree(`D:\ticketpass-screens`)의 작업 가지 `feature/0.6.4-screen-publishing`에서 한다. 보관과 커밋까지 그 가지에서 하고, 루프가 커밋을 끝낸 틈에 `develop`에 병합한다(devops §2.2.1의 작업 가지 → `develop`). 원격이 없어 PR은 열지 않는다.

### 3. 작업 공간과 빌드 도구

- `pnpm-workspace.yaml`의 `packages`에 `apps/*`, `apps/widgets/*`, `apps/web/queue-room`, `packages/*`를 더한다. `services/*`는 처음 서비스가 생기는 단계(FND-050)에서 더한다.
- Turborepo 2.11 작업은 `build`·`dev`·`typecheck`이다. `lint`·`test`·`size`·`e2e`는 그 도구를 두는 단계(BAS-210·220)에서 더한다.
- TypeScript는 레지스트리 `latest` 7.0을 쓰고 `strict`를 켠다(frontend §5.14.3). Next.js 빌드가 7.0과 맞지 않으면 6.x로 내리고 그 까닭을 여기에 적는다.
- 설치는 뿌리에서만 한다. 공급망 설정(devops §4.4)은 그대로 두고, 설치 스크립트가 꼭 필요한 패키지만 `allowBuilds`에 이유와 함께 더한다(frontend §5.14.5).

### 4. 토큰 빌드

`packages/ds/scripts/build-tokens.mjs`가 Style Dictionary 5로 tokens.json을 읽어 `src/gen/`에 셋을 만든다: SEED 변수를 덮어쓰는 CSS 변수(라이트는 `:root`, 다크는 `[data-seed-color-mode]`·`[data-seed-user-color-scheme]` 선택자), Tailwind 4 `@theme`(기본 중단점을 지우고 480·768·1280·1440만), TS 상수(Canvas 좌석맵이 읽는 색과 `pattern.seat.*`). 만든 파일은 커밋하고, 다시 만들어 차이가 없는지 보는 명령(`tokens:check`)을 둔다. 대비 계산 CI·시각 회귀·DTCG 이름 검사는 BAS-170에 남긴다.

### 5. 캔버스 키트, SEED, Tailwind

- 캔버스의 모든 보드는 공용 키트 `peaket.css`(tokens.json·d2에서 옮긴 SEED 모양의 클래스)로 그려져 있다. 이 키트를 `packages/ds/src/styles/kit.css`로 옮겨 `components` 층에 두고, 화면은 보드와 같은 클래스 이름으로 옮긴다. 키트의 색 변수 블록은 토큰 빌드가 tokens.json에서 만든다(키트 변수 이름 ↔ tokens.json 경로 대응표).
- `@peaket/ds`의 React 부품은 지금 키트 클래스를 내는 얇은 부품이다. 부품 속을 `@seed-design/react`로 바꾸는 일은 BAS-180(packages/ds 뼈대)에서 부품 API를 지키며 한다. 그래서 이 변경은 SEED CSS(base·recipe)를 싣지 않는다. 키트가 SEED 값으로 이미 그려져 있고, 둘을 함께 실으면 바탕 규칙이 겹쳐 캔버스와 달라진다.

- 층 순서 선언 `@layer theme, base, seed-base, seed-components, components, utilities;`를 앱이 가장 먼저 싣는 CSS 맨 앞에 둔다(d2 §1). SEED를 싣는 BAS-180에서도 이 순서를 그대로 쓴다.
- Next.js의 Turbopack이 `seed-layered` 조건을 고르는지는 PoC FE-T36의 일이다. 고르지 못하면 SEED 부품 CSS가 층 밖에 실리므로, 정본의 대비책대로 SEED 부품 요소에는 Tailwind 유틸을 겹치지 않고 부품 속성으로만 모양을 바꾼다. 피켓이 직접 그리는 부품은 Tailwind 유틸과 `components` 층 CSS로 그린다.
- `@peaket/ds` 부품은 `src/components/<이름>/`에 두고, 패키지 `exports`의 와일드카드(`"./*"`)로 하나씩 가져온다. 묶음 하나로 모아 내보내지 않아 쓰지 않는 부품이 번들에 섞이지 않는다.
- 앱의 Tailwind는 `@source`로 `packages/ds/src`를 함께 읽는다.

### 6. 앱과 경로

| 앱 | 폴더 | 프레임워크 | 개발 포트 | 화면 |
| --- | --- | --- | --- | --- |
| 소비자 웹 | `apps/web` | Next.js 16 App Router, FSD 층(`src/_app`·`_pages`·`widgets`·`features`·`entities`·`shared`) | 3000 | SCR-001~006, 009~017, 019, 038~043, 050, 051, 054~061 |
| 대기실 경량 페이지 | `apps/web/queue-room` | TypeScript + Vite 8, 프레임워크 없음, DOM 템플릿과 `textContent` | 3004 | SCR-007, 008, 018, 015(굿즈 대기) |
| 파트너 콘솔 | `apps/partner` | Next.js 16 | 3001 | SCR-020~027, 037, 044, 062, 063 |
| 관제 콘솔 | `apps/console-host` + `apps/widgets/queue`·`purchase` | webpack 5 + React Router 8 데이터 라우터 | 3002 | SCR-028~032, 045~049, 053, 064~068 |
| 스캐너 | `apps/scanner` | Vite 8 + React | 3003 | SCR-033~036, 052 |
| 포렌식 데모 | `apps/forensics` | Vite 8 + React | 3005 | SCR-069 |

- 경로는 d5 §2 인벤토리와 frontend §2.5 표를 따른다. 소비자 웹은 `app/(cached)`(헤더 묶음 A)와 `app/(request)`(B·E·F)에 루트 레이아웃을 따로 둔다. Cache Components와 nonce는 FE-T35 PoC(HOT-290)에서 켜므로 지금은 끈다.
- 시스템 안내 화면(SCR-059)은 앱마다 오류·없는 주소 화면으로 둔다.
- 관제 원격 위젯은 정본이 허용한 한 앱 기준선(위젯 패키지를 `workspace:`로 이어 한 번에 빌드, frontend §2.2 '원격 위젯' 행)으로 붙인다. Module Federation 원격 적재와 FE-T29 비교는 관제 단계에서 한다.

### 7. 목업 데이터와 상태 보기

- 화면 데이터는 각 앱의 `fixtures`(합성 데이터, 고정 값)에서 읽는다. 실제 이름·연락처·계좌는 쓰지 않는다(공연·아티스트·회사 이름은 지어낸 것).
- 화면마다 `?state=<이름>`으로 상태를 고른다. 상태 이름은 캔버스 보드의 `state` 열거값(한국어)을 그대로 쓰고, 값이 없으면 보드의 기본값이다. 보드에 없고 d5 상태 표에만 있는 상태는 더한다. 다크는 `?theme=dark`(보드의 `dark` 속성)다.
- 앱마다 `/preview`에 화면·상태 목록을 둔다. 개발 서버에서만 열리고 운영 빌드에서는 404다. 데이터 연결 단계에서 목업과 상태 고르기를 걷어 낸다.

### 8. 퍼블리싱으로 그리는 범위와 근사

- 좌석맵(SCR-010)·좌석맵 에디터(SCR-022)·포렌식(SCR-069)·그래프·회전 QR·카메라 뷰·결제창·본인확인 창은 캔버스 보드가 그린 모양(SVG·CSS)을 그대로 옮긴다. 좌석은 색과 무늬를 함께 쓰고 SeatList 대안을 둔다(d2 §1). 실제 동작은 정본 단계에서 한다: 좌석 Worker·OffscreenCanvas·델타(HOT-090~130), Konva 편집(HOT-220), 실제 QR(wbs 5.1.3 PoC가 라이브러리를 고른다), 카메라·판정 Worker(wbs 5.x), 결제사·본인확인 SDK(HOT-350, BOT-010). 보드에 SVG가 없는 그래프는 Chart.js 4.6(CMP-033)으로 그린다.

### 9. 이 변경에서 하지 않는 것과 그 단계

| 하지 않는 것 | 하는 단계 |
| --- | --- |
| API 클라이언트·계약 코드 생성 | FND-030, BAS-040 |
| CSP·보안 헤더·Cache Components·nonce | HOT-290, HOT-450 |
| 다국어 주소(`/en` 등) | HOT-290~380 |
| Steiger·ESLint 규칙, size-limit, Lighthouse | BAS-010, BAS-210, BAS-220 |
| Storybook·시각 회귀·대비 CI·토큰 CI | BAS-170, BAS-180 |
| 좌석 Worker·델타·OffscreenCanvas | HOT-090~130 |
| PWA·서비스 워커(월렛·스캐너) | HOT-390, wbs 5.x |
| Module Federation 원격 적재 | 관제 단계(wbs 4.x) |
| 로고 워드마크·파비콘 | BAS-200(지금은 글자 로고) |

### 10. 브라우저 확인

대조(verify) 뒤 Claude in Chrome으로 앱마다 `/preview`와 주요 화면을 휴대폰 폭(360)과 데스크톱 폭(1280·1440)에서 열어 본다. 연결이 없으면 OPEN[06] 기본값대로 `browser-check.md`에 '못 함(연결 없음)'과 까닭을 적고, 내장 브라우저로 같은 시나리오를 본 결과를 함께 적는다.

## Risks / Trade-offs

- **보드와 정본 문서가 다를 때**: 소유자가 확인한 그림인 보드를 따르고(법정 고지 문구만 POL 원문), 다른 곳은 목록으로 남긴다. 캔버스 키트 값과 tokens.json이 다르면 tokens.json을 따르되 눈에 띄는 차이는 소유자에게 묻는다.
- **목업 상태 고르기가 운영 빌드에 남을 위험**: `/preview`는 운영 빌드에서 404이고, `?state=`는 연결 단계에서 걷어 낸다(결정 7).
- **루프와의 병합 충돌**: 뿌리 설정 파일(`package.json`·`pnpm-workspace.yaml`)은 루프의 FND-030도 고친다. 병합할 때 루프 쪽 값을 살려 맞춘다.
- **SEED 층과 Turbopack**: 결정 5의 대비책을 따르고, FE-T36 결과가 나오면 다시 본다.

## 구현하며 정한 것과 정본과 다른 곳(2026-10-31)

- **공급망**: SEED 하위 패키지 다섯이 출처 증명 없이 게시돼 `trustPolicy`가 막았다. 처음에는 앞선 증명 판으로 고정했으나, 코드 리뷰에서 퍼블리싱 코드가 SEED 패키지를 하나도 가져오지 않고 고정한 판이 `@seed-design/react` 3.0.1의 요구 범위 밖임이 드러나, SEED 의존성 셋(`@seed-design/css`·`react`·`tailwind4-theme`)과 고정을 함께 뺐다. 처리 규칙은 docs/devops.md §4.4에 두었다. 게시 뒤 3일이 지나지 않은 판은 범위를 낮춰 그 앞 판을 쓴다(react-router 8.5.0, webpack-cli 7.2.3). 설치 스크립트 허용은 정본 목록의 `esbuild` 하나다.
- **TypeScript 7.0**: Next.js 16.4·Vite 8·webpack 5 빌드와 `tsc --noEmit`이 모두 7.0으로 돌았다(결정 3의 대비책은 쓰지 않았다).
- **스캐너 경로 고르기**: 정본 스택(frontend §2.3)에 라우터가 없어 History API로 짠 작은 경로 고르기를 앱 안에 두었다(경로 다섯). 관제는 정본대로 React Router 8 데이터 라우터다.
- **관제 보드 옮기기**: 관제·포렌식 보드는 크고(100~190KB) 마크업이 많아, 보드에서 TSX를 만드는 일회용 변환 스크립트로 옮긴 뒤 다듬었다. 스크립트는 저장소에 두지 않는다(캔버스를 저장소에 복사하지 않는 결정과 같은 까닭).
- **보드별 배치 고르기(남은 빚)**: 소비자 웹·파트너·대기실은 보드 셋을 한 페이지의 반응형으로 합쳤다. 관제·포렌식·스캐너는 보드마다 짜임이 크게 달라, 창 폭(스캐너는 방향까지)을 읽어 보드별 배치(`board-d/t/m`)를 고른다. 그래서 같은 화면의 마크업이 두세 벌이고 가장 큰 파일이 200KB 안팎이다. 데이터를 잇는 단계에서 화면마다 공통 부분을 부품으로 묶어 한 벌로 줄인다.
- **보드를 따른 곳(정본 문서와 다름)**: 대기열 일시정지 상태에서 예상 시간을 보인다(frontend §3.4는 숨긴다). 현장 운영 시간 띠의 '입장 기록 마감 예정'이 23:00이다(d5·planning/04는 22:00). SCR-021 휴대폰 보드끼리 토스페이먼츠 셀러 상태가 '승인 필요'와 '부분 승인'으로 다르다(각 보드를 따랐다).
- **보드에 없어 d5에서 더한 상태**: 화면마다 담당 보고에 적은 것(예: 홈 '빈 화면(오픈 예정)', 검색 '목록 불러오는 중', 대기열 '연결 끊김', 스캐너 거부 사유 여덟, 관제 '위젯 로딩'·'원격 위젯 적재 실패' 등). 상태 이름은 d5 표의 이름이다.
- **그리지 않은 것**: 정본 문구가 자리 표시이거나 없는 상태(SCR-022 '템플릿 바꾸기 확인', SCR-052 '일반 스태프', SCR-053 '관리 앱 연동 실패', 부스 탭 '본인확인기관 장애', 관제 화면의 로딩 스켈레톤).
- **tokens.json에 없는 키트 변수**: `--scrim`(대화상자 뒤 덮개, 라이트 0.48·다크 0.64)과 `--heat-ink`는 키트 값 그대로 둔다. 정본 토큰으로 둘지는 소유자가 정한다.
- **목업끼리 다른 값**: 공용 목업과 일부 보드의 값(좌석 표기 'R1구역 3열 12번'과 'R구역 12열 7번', LUMEN 판매 상태 등)이 다르다. 화면은 보드 값을 보인다. 데이터 연결 단계에서 목업을 걷어 내며 없어진다.
- **임시 주소**: 셔플 재현 규격·복구 소식 페이지 같은 바깥 주소는 `*.peaket.example`로 두었다. 판매 일시 중단 정적 페이지(`apps/web/public/sale-paused.html`)는 앱 CSS 없이 열려야 해서 파일 안 `<style>`을 쓴다. 배포 때 그 경로의 CSP가 이 스타일을 받아야 한다(HOT-450).
