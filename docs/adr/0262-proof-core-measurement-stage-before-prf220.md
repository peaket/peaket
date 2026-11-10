# ADR-0262: 증명 핵심 측정 앞에 측정 무대 단계(PRF-215)를 두고, 서비스 분리 효과 비교가 그 무대를 그대로 쓴다

- **상태**: 채택(2026-11-10, 소유자 결정 "가", OPEN[32]). BUILD_ORDER BAT-025(PRF-220) 계획(docs/review/plans/BAT-025.md)에서 나온 물음이다.
- **관련**: [docs/verification.md](../verification.md) §3(K1·K2·K7, §3.8 세 구성 비교), [docs/wbs/wbs.md](../wbs/wbs.md) 2.12.5·2.12.7·2.12.8, [ADR-0096](0096-evidence-design-entry-capacity-split-comparison-v0-baseline.md)(서비스 분리 효과 세 구성 비교와 그 일수), [ADR-0128](0128-tech-review-medium-doc-fixes-scope-evidence-tech-choices.md)(증명 핵심 먼저), [ADR-0256](0256-feature-batches-completion-ledger-risk-grades.md)(기능 묶음)
- **관련 ID**: K1, K2, K7, Q-T3, V-T18

## 맥락

- 정본은 증명 핵심 측정(wbs 2.12.7, BUILD_ORDER PRF-220)을 '한 프로세스 합본'(같은 v1 코드의 서비스를 Node 프로세스 하나에 띄운 구성, docs/verification.md §3.8 (가))으로 재라고 한다. 증명 핵심 수치(M2a)를 서비스를 나누기 전에 얻으려는 것이다(ADR-0128).
- 2026-11-10 BAT-025를 계획해 보니 잴 무대가 저장소에 없었다: 합본 시작 파일과 이미지, 연습용 클러스터(kind) 위의 v1 배포, v1 부하 시나리오와 실행 도구(`loadtest/run.mjs`)의 v1 경로. 합본 빌드는 뒤 단계인 서비스 분리 효과 비교(wbs 2.12.5, BUILD_ORDER HOT-500, 측정 창 2)의 몫이었다(ADR-0096, 2.12.5의 '합본 빌드와 갈래 스위치 1일').
- 만들려면 약 4.25~4.5일 [어림]이다(계획: 서비스 시작 파일을 설정을 받아 시작하는 함수로 나누기 0.75일, 합본 시작 파일과 이미지 0.75일, kind v1 배포 1~1.25일, v1 시나리오와 실행 도구 1.5일, 작은 리허설 0.25일).

## 결정

1. 증명 핵심 측정 앞에 측정 무대 단계 PRF-215(wbs 2.12.8, 4.25일 [어림])를 둔다. 묶음은 BAT-022(갈래 1, 구간 1)이고 BAT-025(PRF-220)의 선행이다.
2. 서비스 분리 효과 비교(HOT-500, wbs 2.12.5)는 PRF-215가 만든 합본 시작 파일·이미지·kind v1 배포·v1 시나리오를 그대로 쓴다. 그래서 2.12.5에서 합본 빌드 몫 0.75일 [어림]을 빼 1.25일로 하고(갈래 스위치와 세 구성 측정·기록은 남는다), 전체 일수는 3.5일 늘어난다.
3. 측정 구성은 정본 그대로 '한 프로세스 합본'이다. 서비스별 파드로 먼저 재는 안(OPEN[32] (나))과 PRF-220을 HOT-500 뒤로 미루는 안((다))은 고르지 않았다.
4. 합본에 넣을 서비스와 릴레이 자리(추천 적용 2026-11-10, BUILD_ORDER PRF-215, 계획 docs/review/plans/BAT-025.md §4의 1): 합본(`services/bundle`)은 queue-svc·admission-ctrl·purchase-svc·payment-svc 넷을 Node 프로세스 하나에 띄운다. 켜는 차례는 결제 → 구매 → 입장 제어 → 대기열(불리는 쪽이 먼저 선다)이고 닫는 차례는 그 반대다(입구부터 닫는다).
   - 서비스마다 시작 파일(`src/main.ts`)을 설정을 받아 시작하는 함수(`src/start.ts`의 `start({ env, logDestination?, onFatal? }) → { close() }`. `onFatal?`은 듣기 시작한 뒤 치명적으로 실패할 수 있는 queue-svc·purchase-svc(Kafka 소비자)만 받는다, 추천 적용 2026-11-10, BUILD_ORDER PRF-215, 코드 리뷰)와 얇은 시작 파일로 나눈다. 함수는 `process.env`를 읽지 않고 받은 환경 값만 읽으며, 조립(풀·실행기·소비자·판정자)과 종료 차례는 나누기 전 그대로다. 합본은 같은 함수를 부른다(시험 조립을 합본으로 쓰지 않는다).
   - Outbox·좌석 Stream 릴레이는 합본에 넣지 않고 같은 이미지의 따로 뜬 릴레이 파드로 띄운다(차트의 `outboxRelay`, purchase-svc·payment-svc 두 릴리스). 릴레이는 세 구성(docs/verification.md §3.8) 모두 같은 자리라 비교하는 변수가 아니다.
   - trust-svc·identity-svc·core-svc·ticket-svc는 넣지 않는다. local·ci의 대역(위험 판정 늘 축소 운영, 재확인은 토큰 판정, 발권은 '늘 발권')으로 뜨고, 회차·좌석 배치·판매 상태는 시드로 넣는다. 그 사실은 성능 장부 `notes`에 적는다.
   - 합본은 `PEAKET_ENV`가 local·ci가 아니면 시작하지 않는다(운영에 배포하지 않는 시험 도구다). 서비스별 환경 값과 리더 임대·포트는 docs/verification.md §3.8 '합본의 v1 무대'에 둔다.

## 결과

- 증명 핵심 수치를 서비스를 나누기 전(구간 1)에 얻고, 같은 무대를 측정 창 2가 다시 쓴다.
- 서비스 시작 파일을 함수로 나누면 운영 조립(돈·좌석·대기 순번 경로를 잇는 곳)이 바뀌므로, 그 묶음은 기존 프로세스 시험(서비스마다 시작 파일을 띄우는 통합 시험)을 그대로 통과해야 하고 조립을 시험 조립과 따로 띄워 본다(docs/architecture.md §8.6 '자주 놓친 결함').
- 측정 때 이 PC의 Docker 메모리(약 15.5GiB)가 모자라면 WSL 메모리를 늘리는 일은 시스템 설정이라 소유자 몫이다.
- 서비스 시작 파일을 실제 저장소로 띄운 시험(services/bundle/test-int/start-files.int.test.ts)이 나누기 전부터 있던 결함을 잡았다: purchase-svc는 purchase DB를 주면 시작하지 못했다(결제 시도 지표 묶음과 텔레메트리 버림 셈이 같은 지표 이름 `telemetry_dropped_total`을 서비스 레지스트리에 두 번 붙였다). 플랫폼 `telemetryDroppedCounter`가 이미 붙은 같은 이름의 묶음을 함께 쓰게 고쳤다(BUILD_ORDER PRF-215).

## 되돌릴 조건

- PRF-215를 하다 4.25일 [어림]의 두 배를 넘기면 멈추고, 서비스별 파드로 먼저 재는 안을 다시 소유자에게 묻는다.
