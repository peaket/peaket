# 제안: 기반 PoC — Redis 한 키·클라이언트·좌석 샤드, HTTP 어댑터·검사 방식, Kafka 클라이언트·MSK IAM·키 단위 소비(wbs 0.5.1, BUILD_ORDER FND-120)

## Why

docs/architecture.md §9.4는 본 개발 전에 위험한 부분을 PoC(본 개발 전에 위험한 부분만 먼저 만들어 확인하는 시험)로 먼저 재라고 한다. 이 단계의 몫은 Redis 한 키 `INCR` 20만/s, Redis 클라이언트 셋 비교(V-T33), 좌석 샤드 하나의 처리량(S-T27), HTTP 어댑터·검사 방식 비교(V-T41), Kafka 기본 클라이언트 확인과 MSK IAM 토큰 함수(ST-T14 ①)다. 판정 기준은 정본에 이미 있고 아직 잰 값이 없다. FND-070은 V-T41의 구성과 표본 묶음을, FND-090은 MSK IAM 토큰 함수를 공용 설정 함수에 붙이는 일, ST-T18 전체, `js.consumer.max.batch.size`, Kafka 외부 계측 패키지 비교를 이 단계로 넘겼다(R-223·R-225).

## What Changes

- **측정 틀**(`loadtest/poc/`): PC의 Docker 컨테이너로 Valkey 클러스터(주 노드 셋·복제 셋, TLS 켬·끔), 측정 도구 이미지, Kafka 3.9.x 브로커를 띄우고 정해진 도착률(오픈 모델)로 요청을 보내 지연을 '보내기로 한 시각'부터 잰다. 결과는 성능 장부 규칙(docs/perf-ledger.md)대로 `docs/perf-ledger/runs/`에 '실측(PC)'으로 남긴다. V-T41은 k6로 잰다.
- **성능 장부 도구**: k6가 아닌 측정 도구의 요약(`--bench-summary`)을 받아 장부 표의 p99·오류율 칸을 채운다. 컨테이너 PoC용 프로파일 `local-poc`를 더한다.
- **MSK IAM 토큰 함수**(`packages/platform`): Kafka 공용 설정 함수가 MSK IAM 인증을 받는다(SASL_SSL·OAUTHBEARER). 토큰 함수는 작업자 전용 역할을 고정 세션 이름 `<작업자>-<환경>`으로 맡고, 역할을 못 맡으면 기본 자격으로 넘어가지 않고 실패한다. 흉내 낸 STS로 시험한다(ST-T14 ①).
- **키 단위 소비 시험 전체**(ST-T18): 실제 Kafka로 처리 중 소비자 추가·강제 종료, 일시 실패로 멈춘 파티션을 넘긴 뒤 다시 받기, 넘기기 기다림 한도 뒤 버린 파티션을 새 주인이 받기를 시험한다. 결함이 나오면 재현 시험부터 고친다.
- **판정 기록**: 결과와 판정을 새 ADR과 정본(§9.4, V-T33·V-T41·S-T27·ST-T14·ST-T18, devops §4.4 네이티브 모듈 설치)에 남긴다.

## Impact

- 정본: docs/architecture.md §5(Redis 클라이언트 설정 이름)·§9.4, docs/verification.md V-T33·V-T41·§3.5, docs/features/seat-hold.md S-T27, docs/streaming.md §2.1·§2.6·ST-T14·ST-T18, docs/devops.md §4.4, docs/perf-ledger.md §4·§5, docs/security/asvs/delivery.md, docs/observability.md §3 운영 확인 표, ADR-0023·0054·0127·0128·0133·0134·0137·0142 상태 줄, wbs 0.5.1.
- ID: wbs 0.5.1, NFR-001·NFR-003·NFR-021, V-T33·V-T41·S-T27·ST-T14 ①·ST-T18, 기술 검토 중간-026·낮음-001·낮음-003·낮음-004·낮음-072·낮음-152·높음-26, ASVS v5.0.0-13.2.x·13.3.x.
- 코드: `loadtest/poc/`(새), `tools/perf-ledger/collect.py`·`index.py`, `packages/platform`(Kafka 설정 함수의 MSK IAM, 토큰 함수, ST-T18 통합 시험), 의존성 `aws-msk-iam-sasl-signer-js` 1.0.3.
- 넘김: 자격 갱신을 넘는 재인증(ST-T14 ②)은 실제 MSK·EKS가 있어야 하므로 선택 클라우드 보정 `cloud-msk-iam`(소유자 몫, ADR-0154). 실제 서비스 경로(게이트웨이·인증·멱등 포함)의 홀드 p99(S-T1)는 wbs 2.x.
