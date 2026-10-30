# 제안: 화면 앱 골격과 전체 화면 퍼블리싱

## Why

소유자가 "일단 초기 프로젝트 세팅을 해서 PEAKET 전체 화면 디자인부터 퍼블리싱하고 전체 페이지를 구성해주세요"라고 요청했다(2026-10-31). 화면 설계는 끝나 있다(docs/design/d5의 69개 화면, d2 컴포넌트 카탈로그, tokens.json). 그런데 화면 앱·디자인 시스템 패키지는 아직 하나도 없고, 빌드 순서(docs/BUILD_ORDER.md)에서는 화면 골격(BAS-170·180·210)과 화면 구현(HOT-290~390)이 서버 기반·v0·증명 핵심 뒤에 있다. 퍼블리싱(디자인을 실제 HTML·CSS·컴포넌트로 옮기는 일)은 서버 없이 목업 데이터로 할 수 있으므로, 화면 모양을 먼저 확정해 두면 뒤 단계는 데이터 연결만 하면 된다.

## What Changes

- **작업 공간 골격**: pnpm 작업 공간에 `apps/*`, `apps/widgets/*`, `packages/*`를 더하고, Turborepo(`turbo.json`)와 TypeScript 기본 설정(`packages/config`)을 둔다(frontend §2.2, devops §4.4).
- **`@peaket/ds`**: `docs/design/tokens.json`을 Style Dictionary 5로 CSS 변수(SEED 변수 덮어쓰기, 라이트·다크), Tailwind 4 `@theme`, TS 상수로 만든다. CSS 층 순서 선언을 두고, 디자인 캔버스 키트(`peaket.css`)를 옮겨 그 클래스를 내는 d2 카탈로그의 컴포넌트(CMP)를 만든다(d2 §1·§2). 부품 속을 `@seed-design/react`로 바꾸는 일은 wbs 0.6.2(BAS-180)에서 같은 API로 한다(design.md 결정 5).
- **화면 앱 여섯**: 정본의 프레임워크로 앱 골격을 만든다. 소비자 웹 `apps/web`(Next.js 16, FSD 층, `(cached)`·`(request)` 경로 묶음), 대기실 경량 페이지 `apps/web/queue-room`(프레임워크 없음, Vite 8), 파트너 콘솔 `apps/partner`(Next.js 16), 관제 콘솔 `apps/console-host`(webpack 5 + React Router 8)와 원격 위젯 패키지 둘, 스캐너 `apps/scanner`(Vite 8 + React), 포렌식 데모 `apps/forensics`(Vite 8).
- **전체 화면 퍼블리싱**: d5 §2 인벤토리의 69개 화면을 정본 경로에 목업 데이터로 그린다. 화면마다 d5 상태 표의 상태를 `?state=` 값으로 골라 볼 수 있고, 앱마다 화면·상태 목록 페이지(`/preview`, 개발 빌드에서만)를 둔다.
- **빌드 순서와 정본**: 순서를 바꾼 결정을 ADR-0170으로 남기고, BUILD_ORDER에 이 단계를 체크해 넣으며 겹치는 단계(FND-030·BAS-170·180·210·HOT-290~390 등)에 '퍼블리싱은 끝남, 남은 것은 연결'을 적는다.
- 데이터 연결(API 클라이언트, 실시간, 결제·본인확인 SDK), CSP·보안 헤더, 다국어, PWA, Module Federation 원격 적재, 린트(Steiger·ESLint 규칙), 시각 회귀·Storybook은 하지 않는다. 각자 정본의 단계에서 한다(design.md 결정 9).

## Capabilities

### New Capabilities

- 없음. 화면을 목업 데이터로 그리는 퍼블리싱이라 시스템 행동(서버가 받는 요청과 응답)이 생기지 않는다. 화면 모양과 상태의 정본은 docs/design/d5·d3·d2이므로 명세를 따로 쓰지 않는다(`skip_specs: true`).

### Modified Capabilities

- 없음.

## Impact

- **정본**: docs/frontend.md §2.2~§2.7(구조·앱별 프레임워크·경로표·셸), docs/design/d1 §4(배치), d2 §1~§2(토큰·CMP), d3(화면별 컴포넌트·상태·접근성), d5 §2~§8(인벤토리·셸·와이어프레임·상태 표), tokens.json. 화면 SCR-001~069.
- **결정**: ADR-0040(SEED), ADR-0059·0060·0061·0063·0066(화면), ADR-0079(프론트엔드 RADIO), ADR-0091·0092(관제 성능·Zustand), ADR-0100(관제·파트너 통신), ADR-0111(SEED 스타일 속성), ADR-0165·0169(모노레포), ADR-0167(사이클과 브라우저 확인), 새 ADR-0170(퍼블리싱을 먼저 한다).
- **ASVS**: docs/security/asvs/frontend.md(화면 공통 추적 표). 서버 입력·인증·저장이 없는 퍼블리싱이라 새 추적 표를 쓰지 않고, 구현 위치 줄만 고친다.
- **WBS**: 0.6.1·0.6.2·0.6.4의 골격 부분, 0.2.1의 작업 공간 부분, 2.6.3·2.9.x·2.10.x·4.x·5.x 화면 작업의 퍼블리싱 부분. 연결·시험·CI 부분은 그 작업에 남는다.
- **코드**: `apps/` 여섯과 위젯 둘, `packages/ds`·`packages/config`, 뿌리 `package.json`·`pnpm-workspace.yaml`·`turbo.json`·잠금 파일, `.claude/launch.json`(로컬 미리보기).
- **외부**: npm 공개 패키지(정본의 판, 새 판 3일 대기). 원격 저장소·배포는 없다. 브라우저 확인은 Claude in Chrome으로 한다(ADR-0167, OPEN[06] 기본값).
