# Tasks

## 1. 작업 공간 골격

- [x] 1.1 뿌리 `package.json`(스크립트·Turborepo), `pnpm-workspace.yaml`의 `packages`, `turbo.json`, `packages/config`(TypeScript 기본 설정)을 만들고, 앱·패키지의 `package.json`에 정본 판의 의존성을 적어 뿌리에서 한 번에 설치한다(design.md 결정 3). 확인: `pnpm install --frozen-lockfile`이 공급망 설정 그대로 통과하고, `node tools/ci/check-workspace-protocol.mjs`·`check-codeowners.mjs`가 통과한다.

## 2. 디자인 시스템 패키지

- [x] 2.1 `packages/ds`의 토큰 빌드(Style Dictionary 5 → CSS 변수·Tailwind 4 `@theme`·TS 상수)와 층 순서·캔버스 키트 CSS(kit.css)를 싣는 스타일 진입점을 만든다(결정 4·5. SEED CSS는 싣지 않는다). 확인: `pnpm --filter @peaket/ds tokens:check`가 다시 만든 결과와 차이 없음을 보인다.
- [x] 2.2 d2 카탈로그의 공용 부품(CMP)과 앱 셸 변형(CMP-065: 소비자 일반·집중·스태프, 파트너, 관제, 스캐너), UI 아이콘을 만든다. 확인: `pnpm --filter @peaket/ds typecheck`가 통과하고, 앱의 `/preview`에서 부품이 그려진다.

## 3. 앱 골격과 화면 퍼블리싱

- [x] 3.1 소비자 웹 골격(`(cached)`·`(request)` 루트 레이아웃, FSD 층, 셸, 목업, `?state=`, `/preview`)과 SCR-001·002·003·015·016·019·054·056·057·058·059. 확인: `next build` 통과, 경로마다 개발 서버 응답 200.
- [x] 3.2 소비자 웹 계정·마이·스태프 화면 SCR-004·005·006·017·039~043·050·051·055·060·061. 확인: 같은 방법.
- [x] 3.3 소비자 웹 예매 화면 SCR-009~014·038과 대기실 경량 페이지(SCR-007·008·018과 굿즈 대기). 확인: `next build`·`vite build` 통과, 대기실 산출물에 React가 없음.
- [x] 3.4 파트너 콘솔 SCR-020~027·037·044·062·063과 SCR-059. 확인: `next build` 통과, 경로마다 200.
- [x] 3.5 관제 콘솔 SCR-028~032·045~049·053·064~068과 SCR-059, 원격 위젯 패키지 둘(한 앱 기준선), 포렌식 데모 SCR-069. 확인: webpack·vite 빌드 통과, 경로마다 화면이 그려짐.
- [x] 3.6 스캐너 SCR-033~036·052와 SCR-059. 확인: `vite build` 통과, 경로마다 화면이 그려짐.
- [x] 3.7 (구현 중 찾음) 통합 정리: 셸의 검색 모드·스태프 머리 폭 320 넘침·홀드 타이머 중복·겹침 창 제목 위 줄, 페이지끼리 가져오기(FSD 층 위반) 없애기, 관제 화면 조각 오류를 SCR-059 모양으로, ds·entities 안내 표. 확인: 전체 타입 검사와 세 앱 빌드 통과, 해당 화면을 폭 320·768·1280에서 열어 가로 스크롤 없음.

## 4. 정본 반영과 통합 확인

- [x] 4.1 ADR-0170을 쓰고 정본에 반영한다: BUILD_ORDER(새 단계 줄과 겹치는 단계의 설명), PROGRESS 진행 로그, wbs(해당 행 비고·CSV), docs/frontend.md(구현 위치), asvs/frontend.md(구현 위치), apps·packages README, 00-summary §4, consistency-review R 행. 확인: 문서 점검 오류 0.
- [x] 4.2 전체를 한 번에 확인한다: `pnpm turbo run typecheck build`, `node --test "tools/ci/*.test.mjs"`, 저장소 규칙 검사 셋, OpenSpec 검증, 새 파일의 줄바꿈 LF. 확인: 모두 통과한다.

> 4.1의 BUILD_ORDER·PROGRESS·00-summary §4·consistency-review 행은 감독 루프가 같은 파일을 동시에 고치므로, 이 가지를 `develop`에 병합한 직후 `develop`에서 그 줄만 따로 커밋한다(design.md 결정 2).

## Workflow follow-up

- 대조: OpenSpec 대조(verify 스킬).
- 브라우저 확인: 대조 뒤 peaket-browser-check 스킬(Claude in Chrome, 앱마다 `/preview`와 주요 화면을 360·1280·1440 폭에서). 결과는 `browser-check.md`.
- 코드 리뷰: 새 맥락의 리뷰 에이전트, 나온 것은 이 사이클에서 고친다(architecture §8.6).
- 보관: `pnpm exec openspec archive add-screen-publishing --yes`, 작업 가지에 커밋한 뒤 루프가 커밋을 끝낸 틈에 `develop`에 병합한다.
