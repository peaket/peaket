# 갈래 2 — 진행 상태

- **독자와 용도**: 갈래 2(병렬 세션)가 다음에 할 일, 구간 끝에 고칠 지적, 진행 로그를 적는다. 공용 턴 규칙과 미해결(소유자에게 물을 것)은 [docs/PROGRESS.md](../PROGRESS.md), 단계의 차례와 체크는 [docs/BUILD_ORDER.md](../BUILD_ORDER.md)가 정본이다(ADR-0189, ADR-0190 결정 3).
- **맡은 일**: BUILD_ORDER에서 줄 끝에 '갈래 2(루프는 건너뛴다)'가 붙은 단계다. 화면, 관제 콘솔(ops-svc 포함), 월렛 화면을 맡는다.
- **작업 폴더**: git worktree `D:/ticketpass-lane2`. 단계마다 `develop`에서 `feature/<WBS ID>-<요약>` 가지를 따고, 끝나면 `develop`에 커밋 하나로 합친다(PROGRESS 턴 규칙 '갈래').
- **이 갈래가 고치는 기록**: 이 파일, BUILD_ORDER의 자기 줄 체크, 커밋 본문의 정합 점검 행이다. 3일 넘는 작업을 ①②로 나누면 그 나눔 글을 wbs.md·wbs.csv 설명 칸에 쓴다(wbs §3). R 표·요약 §4·wbs 상태 칸은 고치지 않는다(갈래 1이 `node tools/ci/records.mjs`로 맞춘다).

## 다음 할 일
- BAS-180(wbs 0.6.2)을 한다: `packages/ds` 속을 같은 API로 @seed-design/react로 바꾸기, Storybook·addon-a11y, Apache-2.0 NOTICE, 이유 있는 비활성 버튼, 첫 브라우저 확인. 그 뒤 구간 1 갈래 2 차례(BAS-190 → BAS-210 → BAS-220 → HOT-290~320 → HOT-340·350 → HOT-110·120 → HOT-360). 화면이 바뀌는 단계는 브라우저 확인을 한다.

## 구간 끝 정리 목록
- 새 맥락 리뷰의 중간·낮은 지적 가운데 그 단계에서 고치지 않은 것을 '단계 ID: 지적 한 줄(파일)' 꼴로 적는다. 이 구간의 자기 단계를 다 끝낸 뒤 한 번에 고친다(ADR-0190 결정 2).
- BAS-170: CSS 검사기가 `@import … layer(x)`를 층 선언으로 세지 않는다(빌드 산출물은 @import를 풀어 지금은 영향 없음)(tools/web-checks/seed-css/check-css.mjs)
- BAS-170: 토큰 형식 검사가 `$value`를 가진 토큰의 자식 키(DTCG 위반)와 배열·글꼴 값 안의 별칭을 보지 않는다(packages/ds/scripts/token-rules.mjs)
- BAS-170: 정적 서버가 127.0.0.1에만 떠 리눅스 Docker Engine에서는 `docker.mjs layers`가 이 PC의 서버에 닿지 못할 수 있다(Docker Desktop은 됨)(tools/web-checks/lib/serve.mjs)
- BAS-170: Windows에서 `serve-all.mjs`의 `child.kill()`이 셸 아래 서버(손자 프로세스)를 남긴다(tools/web-checks/seed-css/serve-all.mjs)
- BAS-170: `docker.mjs`가 pnpm 판(12.16.0)을 `packageManager`와 따로 적는다(tools/web-checks/lib/docker.mjs)
- BAS-170: 루트 color-scheme 재현 시험이 탐침(라이트) 화면만 본다. 운영 빌드의 관제·포렌식 첫 화면(`dark`)도 본다(tools/web-checks/seed-css/layers.spec.mjs)
- BAS-170: PoC 빌드 서버의 `--spa index.html`이 없는 파일을 가리킨다(Vite·webpack의 dist-poc에는 탐침만 있다)(tools/web-checks/seed-css/apps.mjs)

## 진행 로그
- 2026-11-04 갈래 파일을 만들었다(ADR-0190 결정 3). 지난 병렬 세션 기록(PRF-010~120)은 [docs/progress-archive.md](../progress-archive.md)에 있다.
- 2026-11-04 BAS-170 토큰 파이프라인(wbs 0.6.1, FE-T36·FE-T40·FE-T44·FE-T45): SEED CSS 3.1.0 base를 싣고 토큰 형식·대비 계산 CI, 층 순서 PoC(Turbopack 별칭이 조용히 무시되던 것과 진입점 차례를 고침, CSS 크기는 예산 초과라 기준선으로 막음), 대기실 셸 시각 회귀, CI 화면 잡을 더했다. 자세한 것은 커밋 본문.
