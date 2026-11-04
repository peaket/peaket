# 갈래 2 — 진행 상태

- **독자와 용도**: 갈래 2(병렬 세션)가 다음에 할 일, 구간 끝에 고칠 지적, 진행 로그를 적는다. 공용 턴 규칙과 미해결(소유자에게 물을 것)은 [docs/PROGRESS.md](../PROGRESS.md), 단계의 차례와 체크는 [docs/BUILD_ORDER.md](../BUILD_ORDER.md)가 정본이다(ADR-0189, ADR-0190 결정 3).
- **맡은 일**: BUILD_ORDER에서 줄 끝에 '갈래 2(루프는 건너뛴다)'가 붙은 단계다. 화면, 관제 콘솔(ops-svc 포함), 월렛 화면을 맡는다.
- **작업 폴더**: git worktree `D:/ticketpass-lane2`. 단계마다 `develop`에서 `feature/<WBS ID>-<요약>` 가지를 따고, 끝나면 `develop`에 커밋 하나로 합친다(PROGRESS 턴 규칙 '갈래').
- **이 갈래가 고치는 기록**: 이 파일, BUILD_ORDER의 자기 줄 체크, 커밋 본문의 정합 점검 행이다. 3일 넘는 작업을 ①②로 나누면 그 나눔 글을 wbs.md·wbs.csv 설명 칸에 쓴다(wbs §3). R 표·요약 §4·wbs 상태 칸은 고치지 않는다(갈래 1이 `node tools/ci/records.mjs`로 맞춘다).

## 다음 할 일
- BAS-220(wbs 0.6.4 ②, size-limit·Lighthouse CI 예산·화면 묶음별 보안 헤더 등)을 한다. BAS-180은 OPEN[18](SEED React·Storybook 설치가 공급망 규칙에 막힘)이 풀리면 나머지를 한다(제3자 고지는 끝남). 그 뒤 구간 1 갈래 2 차례(HOT-290~320 → HOT-340·350 → HOT-110·120 → HOT-360). 화면이 바뀌는 단계는 브라우저 확인을 한다.

## 구간 끝 정리 목록
- 새 맥락 리뷰의 중간·낮은 지적 가운데 그 단계에서 고치지 않은 것을 '단계 ID: 지적 한 줄(파일)' 꼴로 적는다. 이 구간의 자기 단계를 다 끝낸 뒤 한 번에 고친다(ADR-0190 결정 2).
- BAS-170: CSS 검사기가 `@import … layer(x)`를 층 선언으로 세지 않는다(빌드 산출물은 @import를 풀어 지금은 영향 없음)(tools/web-checks/seed-css/check-css.mjs)
- BAS-170: 토큰 형식 검사가 `$value`를 가진 토큰의 자식 키(DTCG 위반)와 배열·글꼴 값 안의 별칭을 보지 않는다(packages/ds/scripts/token-rules.mjs)
- BAS-170: 정적 서버가 127.0.0.1에만 떠 리눅스 Docker Engine에서는 `docker.mjs layers`가 이 PC의 서버에 닿지 못할 수 있다(Docker Desktop은 됨)(tools/web-checks/lib/serve.mjs)
- BAS-170: Windows에서 `serve-all.mjs`의 `child.kill()`이 셸 아래 서버(손자 프로세스)를 남긴다(tools/web-checks/seed-css/serve-all.mjs)
- BAS-170: `docker.mjs`가 pnpm 판(12.16.0)을 `packageManager`와 따로 적는다(tools/web-checks/lib/docker.mjs)
- BAS-170: 루트 color-scheme 재현 시험이 탐침(라이트) 화면만 본다. 운영 빌드의 관제·포렌식 첫 화면(`dark`)도 본다(tools/web-checks/seed-css/layers.spec.mjs)
- BAS-170: PoC 빌드 서버의 `--spa index.html`이 없는 파일을 가리킨다(Vite·webpack의 dist-poc에는 탐침만 있다)(tools/web-checks/seed-css/apps.mjs)
- BAS-190: 느리게 하기 보정식이 'Worker 시작까지'의 Worker 몫과 첫 프레임 기다림을 곱하지 않는다(지금 거짓 통과 없음). Worker 세션에도 CPU 느리게 하기를 걸 수 있는지 본다(tools/web-checks/seatmap/seatmap.spec.mjs)
- BAS-190: PoC 받기가 압축 없는 `no-store`라 실제 길(HTTP 캐시의 brotli 풀기)을 재지 않는다. 미리 압축한 `.br`로 한 번 잰다(tools/web-checks/lib/serve.mjs)
- BAS-190: Worker가 풀기 전 JSON 전체(`L.json`)를 붙들고 힙을 재지 않았다. 좌석 ID 열만 남기고 힙을 잰다(tools/web-checks/seatmap/page/worker.js)
- BAS-210: 기능 확인 범위가 넓다. 모듈 맨 위(Program)의 확인이 파일 전체를 통과시키고, 같은 함수 안에서 확인과 사용의 순서를 보지 않는다(packages/config/eslint/bcd-rule.mjs)
- BAS-210: TypeScript 문법을 거친 확인(`typeof (AbortSignal as any).any`)을 못 알아봐 헛보고하고, `globalThis.AbortSignal.any`는 놓친다(packages/config/eslint/bcd-rule.mjs)
- BAS-210: 목표 브라우저 질의에 Android Chrome(NFR-019 스캐너·콘솔)이 없다(Samsung이 대부분 대신 막는다)(packages/config/eslint/web-compat.mjs)
- BAS-210: `Retry-After`의 "1.5"를 날짜로 읽어 0ms가 되고, HTTP 날짜를 보정하지 않은 기기 시계와 견준다(packages/api-client/src/retry.ts)
- BAS-210: JSON이 아닌 응답을 늘 글자로 읽어 좌석 스냅샷(octet-stream)이 깨지고, 대기열 파일의 `cache: 'no-store'`를 넘길 칸이 없다(packages/api-client/src/client.ts)
- BAS-210: 지표 보내기가 머리 주석과 다르다. 60초 주기·`visibilitychange` 연결이 없고, fetch가 어떤 이유로든 실패하면 sendBeacon으로 가며, 숨길 때 묶음을 하나씩 기다려 뒤 묶음을 잃을 수 있고, `routeTemplate`이 목록에서 처음 맞는 틀을 써 고정 경로보다 동적 경로를 먼저 고를 수 있다(packages/telemetry/src/lite.ts)
- BAS-210: 뿌리 린트가 `**/src/gen/**`를 빼서 BAS-040에서 들어올 `packages/api-client/src/gen/`(orval 생성물)이 브라우저 지원 린트를 받지 않는다(eslint.config.mjs)

## 진행 로그
- 2026-11-04 갈래 파일을 만들었다(ADR-0190 결정 3). 지난 병렬 세션 기록(PRF-010~120)은 [docs/progress-archive.md](../progress-archive.md)에 있다.
- 2026-11-04 BAS-170 토큰 파이프라인(wbs 0.6.1, FE-T36·FE-T40·FE-T44·FE-T45): SEED CSS 3.1.0 base를 싣고 토큰 형식·대비 계산 CI, 층 순서 PoC(Turbopack 별칭이 조용히 무시되던 것과 진입점 차례를 고침, CSS 크기는 예산 초과라 기준선으로 막음), 대기실 셸 시각 회귀, CI 화면 잡을 더했다. 자세한 것은 커밋 본문.
- 2026-11-04 BAS-180 일부(wbs 0.6.2, ADR-0040 결정 7): SEED 제3자 고지 파일과 생성·검사 스크립트를 더했다. SEED React(SEED 패키지 다섯)와 Storybook(semver 6.3.1)은 공급망 규칙 trustPolicy no-downgrade에 막혀 OPEN[18]로 물었다.
- 2026-11-04 BAS-190 5만 석 Canvas PoC(wbs 0.5.4, K5): 열 단위 파일(객체 배열보다 압축 전 3.4배·brotli 3.0배 작음)을 Worker의 OffscreenCanvas로 풀고 그려 K5 랩 조건 Chromium에서 §5.2 예산 안이었다(다섯 번). WebKit의 튐(그리기 한 번 175ms)은 iOS 실기기 확인 목록으로 남겼다. 자세한 것은 커밋 본문.
- 2026-11-04 BAS-210 화면 공용 패키지 골격(wbs 0.6.4 ①, FE-T3·FE-T4·FE-T15·FE-T22): api-client 실행 정책·telemetry·validation·console-contract를 더하고 화면 코드에 브라우저 지원 린트를 걸었다. eslint-plugin-compat의 판 자료가 `AbortSignal.any` 같은 새 기능을 몰라 MDN 자료를 직접 읽는 보조 규칙을 더했다. 자세한 것은 커밋 본문.
