# 갈래 4 — 진행 상태

- **독자와 용도**: 갈래 4(병렬 세션)가 다음에 할 일과 진행 로그를 적는다. 공용 턴 규칙과 미해결(소유자에게 물을 것)은 [docs/PROGRESS.md](../PROGRESS.md), 단계의 차례와 체크는 [docs/BUILD_ORDER.md](../BUILD_ORDER.md) '기능 묶음' 표가 정본이다(ADR-0286).
- **맡은 일**: '기능 묶음' 표의 '갈래' 칸이 4인 묶음이다. 배포 기반·환경(BAS-080~160), 관측 나머지·알림·SLO(OPS-050~140·250), 관제 명령 서버 ops-svc 제어 평면(OPS-260~320), 오토스케일(OPS-430·440), 실시간 전파 서비스(HOT-090 realtime-gw)를 맡는다. 주로 고치는 곳은 `deploy/envs`·`deploy/charts`·`deploy/local`, `packages/platform`, `services/ops-svc`, 새 `realtime-gw`다.
- **작업 폴더**: git worktree `D:/ticketpass-lane4`(처음이면 `git worktree add`로 만든다). 묶음마다 최신 `origin/develop`에서 `feature/lane4-<묶음 ID>` 가지를 따고, 끝나면 합치기 줄(PROGRESS 턴 규칙 '갈래'의 합치는 법, ADR-0286 결정 3)로 합친다.
- **이 갈래가 고치는 기록**: 이 파일, BUILD_ORDER의 자기 줄 체크, 커밋 본문의 정합 점검 행이다. R 표·요약 §4·wbs 상태 칸은 고치지 않는다(전체 감독이 `node tools/ci/records.mjs`로 맞춘다). 구간 끝 정리 목록은 이 폴더의 lane4-cleanup.md(처음 적을 때 만든다)에 쓴다.
- **ADR 번호(첫 바퀴)**: 0296~0298. 모자라면 전체 감독에게 더 받는다(`docs/lanes/coord.md`).

## 다음 할 일
- **다시 시작하면 BAT-080 첫 일**: 진단 e2e 둘을 `ci-kind.yml`에 되돌리고, 실패할 때 파드·moto 로그를 남기게 한 다음 원인을 고친다(BAT-075에서 넘김, 전체 감독 결정 2026-11-19).
- **멈춤(소유자 결정 "모두 멈춤", 2026-11-19)**: W11-ci-conc(R-698)·W11-rtgw-flake(R-700)·BAT-075(R-704)까지 합치고 멈췄다. 다시 열면 아래 차례로 한다.
- 다음 차례: ① **W11-ci-range**(C, 감독 결정): 가지 푸시는 `github.event.before`와만 견줘 범위를 골라, 기다리다 밀려 취소된 가운데 푸시의 바뀐 파일을 아무 실행도 범위 검사하지 않는다 — develop 푸시는 마지막으로 끝까지 돈 실행의 커밋과 견주거나 전체 범위로(`.github/workflows/ci.yml` `changes` 잡, docs/devops.md §3.4 한계 문장). ② 그 옆 작은 묶음 후보: `tools/ci/records.mjs`가 `변경 요약:` 줄에 `R-NNN:` 머리가 없으면 겹쳐 더함(lane4-cleanup.md). ③ BAT-076(BAS-120 스테이징 Terraform ①) — 막힘: 새 도구 이미지·`terraform providers lock`은 소유자 결정, 시작 때 OPEN 문안(도구·판·다이제스트·잠금 파일 만들 곳)을 감독에게. ④ BAT-080(BAS-130·140, BAS-140에 BAT-052·053·075가 넘긴 것) → BAT-085(BAS-150·160, BAS-150에 BAT-075가 넘긴 진단 주석 입장 정책) → BAT-355·360·365·390(ops-svc 제어 평면) → BAT-245~275(선행 OPS-010~030이 갈래 1에서 `develop`에 들어온 뒤). 묶음을 시작할 때 장부 범위를 그 묶음 몫으로 좁힌다(감독 승인, BAT-075처럼). 선행이 없는 묶음은 건너뛴다.
- 작업 폴더: `D:/ticketpass-lane4`(묶음 가지), 구현 전 트리 `D:/ticketpass-lane4-base`(분리 HEAD), 리뷰 읽기 사본 `D:/ticketpass-lane4-review`, 작은 묶음용 `D:/ticketpass-lane4-ci`·`D:/ticketpass-lane4-flake`(합친 뒤 지워도 됨). kind 클러스터 이름은 `lane4-`로 시작한다. Docker·합치기 잠금은 도우미로만 잡고 놓는다(`bash D:/ticketpass-locks/lock.sh take|drop|who <docker|merge> lane4-<묶음>`, 갈래마다 한 담당만, 2026-11-18 감독 규칙). 무거운 시험은 초안 PR CI로 돌린다(ADR-0286 결정 5, ADR을 바꾸는 묶음은 꼭 — 가지 푸시는 spec-check 전수 검사를 하지 않음, 소유자 결정 (다)). 자기 작업 가지 강제 푸시는 이 세션 권한에서 막혀, 다시 올린 가지는 `feature/lane4-<묶음>-r2` 같은 새 이름으로 올린다. 담당 표 역할 칸은 plan·test·impl·review·verify 그대로, 역할·세션마다 한 행.

## 진행 로그
- 2026-11-18 W11-lanes(R-686): 기록 크기 점검(`records.mjs --check`)에 `docs/lanes/lane4.md`·`lane5.md`를 더함(ADR-0286 '확인'). B 짧은 고리 커밋 8개, 틀린 구현 22/21(놓친 VF-V10은 시험 RS-14 더함), 리뷰 RV-02는 lane4-cleanup.md. 계획 `docs/review/plans/W11-lanes.md`.
- 2026-11-19 BAT-052(R-690): 새 서비스 realtime-gw(좌석 델타 WebSocket, ADR-0296·0297)와 platform `verifyAdmissionToken`. A 등급, 커밋 18개, 관점 리뷰 높음 3 고침, 틀린 구현 80/73, PR #24 CI 초록. 뺀 몫은 BAT-053·066·095·182·BAS-140. 계획 `docs/review/plans/BAT-052.md`.
- 2026-11-19 BAT-053(R-694): realtime-gw 전파 Degraded 자동 전환(ADR-0298 — 박자 늦음 판정·고정 격자 1초 차례·버퍼 1초 연결은 박자 맨 뒤). A 등급, 커밋 17개, 관점 리뷰 높음 4와 보안 다시 보기 SEC-06 고침, 틀린 구현 61/56, 통합 두 번 35/35. 계획 `docs/review/plans/BAT-053.md`.
- 2026-11-19 W11-ci-conc(R-698): develop 푸시 CI를 다음 푸시가 취소하지 않게(`cancel-in-progress`는 PR에서만), 소유자 결정 (다)로 가지 푸시는 spec-check 전수 검사(큰 러너)를 돌리지 않음. C, 커밋 13개. 계획 `docs/review/plans/W11-ci-conc.md`.
- 2026-11-19 W11-rtgw-flake(R-700): realtime-gw Degraded 시험(BAT-053)이 느린 CI에서 벽시계 5초를 넘기던 것을 계산량 줄이기와 두 시험만의 한도로 고침(판정 값 그대로). C 시험만, 커밋 5개. 계획 `docs/review/plans/W11-rtgw-flake.md`.
- 2026-11-19 BAT-075(R-704): 공용 gRPC 서버·종료 차례·준비 프로브 5·3·6·진단 수집(ADR-0303), 서비스 여섯 gRPC 서버 공용으로. B, 높음 1·보안 중간 8 고침, PR CI 회귀 둘 고침, kind 진단 e2e는 BAT-080으로 넘김. 계획 `docs/review/plans/BAT-075.md`.
- 2026-11-19 BAT-080(R-711): BAS-140 배포 상태 — 공용 차트 Rollout·PDB·KEDA·ExternalSecret·우선순위 클래스, AppProject 아홉·ApplicationSet(Git 파일 생성기), 승격 계획 CLI·워크플로, identity·realtime-gw 배포 값과 realtime-gw 경보. BAT-075가 넘긴 진단 e2e 둘을 복귀해 kind에서 통과시키고 실패 수집과 보고서 상대 경로(RV-20)를 고침. 리뷰 RV-01~22(높음 4·보안 3 포함) 반영, 검증 주입 39/39. 최종 CI `44523873279` kind 성공·진단 e2e 단계 성공, node는 known flake(앞선 실행 `realtime-gw` S-T42 ② 타이밍, 마지막 실행 I-T26 공제 밴드 시계 의존 — R-710에서 고친 자리)로 빨강이며 둘 다 이 묶음 변경 밖. BAS-130은 BAT-081로 분리(감독 결정, BAT-076 뒤). 계획 `docs/review/plans/BAT-080.md`.
