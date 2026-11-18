# 갈래 4 — 진행 상태

- **독자와 용도**: 갈래 4(병렬 세션)가 다음에 할 일과 진행 로그를 적는다. 공용 턴 규칙과 미해결(소유자에게 물을 것)은 [docs/PROGRESS.md](../PROGRESS.md), 단계의 차례와 체크는 [docs/BUILD_ORDER.md](../BUILD_ORDER.md) '기능 묶음' 표가 정본이다(ADR-0286).
- **맡은 일**: '기능 묶음' 표의 '갈래' 칸이 4인 묶음이다. 배포 기반·환경(BAS-080~160), 관측 나머지·알림·SLO(OPS-050~140·250), 관제 명령 서버 ops-svc 제어 평면(OPS-260~320), 오토스케일(OPS-430·440), 실시간 전파 서비스(HOT-090 realtime-gw)를 맡는다. 주로 고치는 곳은 `deploy/envs`·`deploy/charts`·`deploy/local`, `packages/platform`, `services/ops-svc`, 새 `realtime-gw`다.
- **작업 폴더**: git worktree `D:/ticketpass-lane4`(처음이면 `git worktree add`로 만든다). 묶음마다 최신 `origin/develop`에서 `feature/lane4-<묶음 ID>` 가지를 따고, 끝나면 합치기 줄(PROGRESS 턴 규칙 '갈래'의 합치는 법, ADR-0286 결정 3)로 합친다.
- **이 갈래가 고치는 기록**: 이 파일, BUILD_ORDER의 자기 줄 체크, 커밋 본문의 정합 점검 행이다. R 표·요약 §4·wbs 상태 칸은 고치지 않는다(전체 감독이 `node tools/ci/records.mjs`로 맞춘다). 구간 끝 정리 목록은 이 폴더의 lane4-cleanup.md(처음 적을 때 만든다)에 쓴다.
- **ADR 번호(첫 바퀴)**: 0296~0298. 모자라면 전체 감독에게 더 받는다(`docs/lanes/coord.md`).

## 다음 할 일
- **첫 일(ADR-0286 '확인')**: `tools/ci/records.mjs`의 `RECORD_SIZE_FILES`에 `docs/lanes/lane4.md`·`lane5.md`를 더하고 시험(`tools/ci/records.test.mjs`)을 고친다. 역할 나누기(ADR-0270·0281)대로, B 등급 짧은 고리(ADR-0283 결정 2).
- 그다음 묶음 표 차례대로: BAT-052(HOT-090 realtime-gw, A, 새 서비스 선행을 이 갈래가 만든다) → BAT-075(BAS-080·120) → BAT-080(BAS-130·140) → BAT-085(BAS-150·160) → BAT-355·360·365·390(ops-svc 제어 평면) → BAT-245~275(선행 OPS-010~030이 갈래 1에서 `develop`에 들어온 뒤). 선행이 없는 묶음은 건너뛴다.
- kind 클러스터 이름은 `lane4-`로 시작한다. 갈래 1도 kind를 쓰므로 Docker 잠금을 지키고 무거운 시험은 초안 PR CI로 돌린다(ADR-0286 결정 5).

## 진행 로그
