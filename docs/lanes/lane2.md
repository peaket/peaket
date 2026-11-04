# 갈래 2 — 진행 상태

- **독자와 용도**: 갈래 2(병렬 세션)가 다음에 할 일, 구간 끝에 고칠 지적, 진행 로그를 적는다. 공용 턴 규칙과 미해결(소유자에게 물을 것)은 [docs/PROGRESS.md](../PROGRESS.md), 단계의 차례와 체크는 [docs/BUILD_ORDER.md](../BUILD_ORDER.md)가 정본이다(ADR-0189, ADR-0190 결정 3).
- **맡은 일**: BUILD_ORDER에서 줄 끝에 '갈래 2(루프는 건너뛴다)'가 붙은 단계다. 화면, 관제 콘솔(ops-svc 포함), 월렛 화면을 맡는다.
- **작업 폴더**: git worktree `D:/ticketpass-lane2`. 단계마다 `develop`에서 `feature/<WBS ID>-<요약>` 가지를 따고, 끝나면 `develop`에 커밋 하나로 합친다(PROGRESS 턴 규칙 '갈래').
- **이 갈래가 고치는 기록**: 이 파일, BUILD_ORDER의 자기 줄 체크, 커밋 본문의 정합 점검 행이다. 3일 넘는 작업을 ①②로 나누면 그 나눔 글을 wbs.md·wbs.csv 설명 칸에 쓴다(wbs §3). R 표·요약 §4·wbs 상태 칸은 고치지 않는다(갈래 1이 `node tools/ci/records.mjs`로 맞춘다).

## 다음 할 일
- 구간 1 갈래 2의 남은 단계를 이어 한다: HOT-290(wbs 2.10.1 ①)부터 HOT-300·310·320·340·350·360 차례. OPEN[18]이 풀려 선행 BAS-180이 2026-11-04에 끝났다. 그 뒤 구간 2의 갈래 2 단계(BAS-040부터)로 간다. 화면이 바뀌는 단계는 브라우저 확인을 한다. SEED 스타일 부품(`@seed-design/react`)을 처음 쓰는 단계는 ADR-0192 결정 5와 ADR-0191 결정 3을 먼저 한다.

## 구간 끝 정리 목록
- 새 맥락 리뷰의 중간·낮은 지적 가운데 그 단계에서 고치지 않은 것을 '단계 ID: 지적 한 줄(파일)' 꼴로 적는다. 이 구간의 자기 단계를 다 끝낸 뒤 한 번에 고친다(ADR-0190 결정 2).

## 진행 로그
- 2026-11-04 갈래 파일을 만들었다(ADR-0190 결정 3). 지난 병렬 세션 기록(PRF-010~120)은 [docs/progress-archive.md](../progress-archive.md)에 있다.
- 2026-11-04 BAS-170 토큰 파이프라인(wbs 0.6.1, FE-T36·FE-T40·FE-T44·FE-T45): SEED CSS 3.1.0 base를 싣고 토큰 형식·대비 계산 CI, 층 순서 PoC(Turbopack 별칭이 조용히 무시되던 것과 진입점 차례를 고침, CSS 크기는 예산 초과라 기준선으로 막음), 대기실 셸 시각 회귀, CI 화면 잡을 더했다. 자세한 것은 커밋 본문.
- 2026-11-04 BAS-180 일부(wbs 0.6.2, ADR-0040 결정 7): SEED 제3자 고지 파일과 생성·검사 스크립트를 더했다. SEED React(SEED 패키지 다섯)와 Storybook(semver 6.3.1)은 공급망 규칙 trustPolicy no-downgrade에 막혀 OPEN[18]로 물었다.
- 2026-11-04 BAS-190 5만 석 Canvas PoC(wbs 0.5.4, K5): 열 단위 파일(객체 배열보다 압축 전 3.4배·brotli 3.0배 작음)을 Worker의 OffscreenCanvas로 풀고 그려 K5 랩 조건 Chromium에서 §5.2 예산 안이었다(다섯 번). WebKit의 튐(그리기 한 번 175ms)은 iOS 실기기 확인 목록으로 남겼다. 자세한 것은 커밋 본문.
- 2026-11-04 BAS-210 화면 공용 패키지 골격(wbs 0.6.4 ①, FE-T3·FE-T4·FE-T15·FE-T22): api-client 실행 정책·telemetry·validation·console-contract를 더하고 화면 코드에 브라우저 지원 린트를 걸었다. eslint-plugin-compat의 판 자료가 `AbortSignal.any` 같은 새 기능을 몰라 MDN 자료를 직접 읽는 보조 규칙을 더했다. 자세한 것은 커밋 본문.
- 2026-11-04 BAS-220 성능 예산·보안 헤더·정적 자산(wbs 0.6.4 ②, FE-T1): 대기실 size-limit, 경로별 첫 JS와 Lighthouse 적재 지표 검사, 묶음별 보안 헤더 값 한 곳, 서버 액션 키 확인, 올릴 파일 목록·SBOM, Turborepo 캐시, CI `budgets` 잡을 더했다. 소비자 웹 랩 LCP 12.5초(글꼴 전체 2MB)는 기준선으로 막고 HOT-290에 넘겼다. 자세한 것은 커밋 본문.
- 2026-11-04 HOT-110 좌석맵 패키지(wbs 2.6.2 ①, FE-T15 단위 부분): `packages/seatmap`(열 단위 파일 검사·풀기, 격자 색인 누른 좌석 찾기, 스냅샷·델타 이진 형식, 색 + 무늬, Worker와 메인 스레드 대체)을 만들고 계약에 팬 파일 `SeatMapColumns`를 나눴다. 자세한 것은 커밋 본문.
- 2026-11-04 HOT-120 두 단계 그리기(wbs 2.6.2 ②): 전체 배치(등급 면 색·남은 상태 글자) → 좌석, 구역 비트맵 캐시, 미니맵·[+]·[−]·[전체 보기]·구역 누르기 확대를 `packages/seatmap`에 더하고, 시연 페이지로 세 엔진 검사와 첫 그림 시각 대조(−0.5ms)를 붙였다. iOS 실기기는 소유자 몫. 자세한 것은 커밋 본문.
- 2026-11-04 구간 1 끝 정리: 목록 22개를 고쳤다(api-client Retry-After·이진 응답·캐시, 지표 보내기 일정·길, 린트 규칙 차례·TS·globalThis·Android Chrome·생성물 범위, 좌석맵 섞인 등급, 정적 자산 SBOM·public·예산 요약, CSS·토큰 검사기, 검사 서버·컨테이너 도구, 좌석맵 PoC 보정·brotli·힙). 자세한 것은 커밋 본문.
- 2026-11-04 BAS-180 ds 뼈대(wbs 0.6.2): OPEN[18]을 소유자 결정대로 풀었다(예외는 semver 6.3.1 하나, SEED는 출처 증명 있는 앞 판, ADR-0191). Storybook·addon-a11y와 이야기 69개, axe·동작·시각 회귀 검사를 더하고, 모양은 캔버스 키트로 두고 대화상자 속만 SEED 동작 부품으로 바꿨다(ADR-0192). 자세한 것은 커밋 본문.
