# 제안: 로컬 kind 클러스터와 CI 구성, 서비스별 Outbox 릴레이 배포(wbs 0.4.1, BUILD_ORDER FND-110)

## Why

로컬·CI 측정 환경(docs/infra.md §3 '로컬')이 아직 없다. 정본은 kind/k3d 위의 쿠버네티스, LocalStack, Strimzi를 같은 구성으로 로컬과 CI에서 쓰라고 한다. 그런데 LocalStack은 계정과 인증 토큰이 있어야 뜨고(infra §3), 소유자는 외부 서비스 계정을 만들지 않기로 했다(2026-10-31 결정 [02]). FND-080·090은 서비스별 Outbox 릴레이 Deployment·Lease 권한·준비 프로브·파드 이름과, 실제 쿠버네티스 Lease로 리더를 이어받는지(V-T28 ①)를 이 단계로 넘겼다(R-224·R-225).

## What Changes

- **도구와 클러스터**(`tools/local/`): kind v0.33.0·kubectl v1.35.8·helm v3.22.1을 공식 주소에서 판·SHA-256으로 고정해 받는 스크립트와, 클러스터 `peaket`(쿠버네티스 1.35.8 노드 이미지 다이제스트)에 Strimzi 0.47.0 + Kafka 3.9.1(KRaft 하나), PostgreSQL 18, 계정 없는 AWS 흉내 서버를 한 명령으로 띄우는 스크립트(`up`·`image`·`status`·`down`). 사용자의 kubeconfig는 건드리지 않는다.
- **LocalStack 대역**: moto 5.2.5(Apache-2.0, 계정·토큰 없음)를 쓴다(추천 적용 2026-11-01). 쓰는 기능(S3 Object Lock 보존·법적 보존, KMS P-256 서명·검증, Secrets Manager 판)을 시험으로 확인한다.
- **Kafka 판**: 정본은 로컬 Strimzi를 운영 MSK와 같은 3.9.x로 맞춘다(docs/devops.md §9.4). Strimzi 1.x는 Kafka 4.x만 받아, 3.9를 받는 마지막 판 0.47.0과 Kafka 3.9.1을 쓴다(추천 적용).
- **서비스 이미지 뼈대**: `packages/platform/template/Dockerfile`(기본 이미지 다이제스트, 잠금 파일대로 설치, 실행 이미지에는 빌드 산출물만)과 `.dockerignore`.
- **릴레이 프로세스**: `startOutboxRelayProcess`·`loadOutboxRelayProcessConfig`(`PEAKET_POD`·`PEAKET_OUTBOX_DATABASE_URL`·`PEAKET_MAINTENANCE_DATABASE_URL`·`PEAKET_KAFKA_BROKERS`), Lease 리더만 릴레이와 정비 반복을 돌고 리더가 되면 정비를 바로 깨운다. 관리 포트 `/metrics`·`/ready`·`/livez`. 끝낼 때 묶음을 마치고 Lease를 놓는다. 서비스 뼈대의 시작 파일 `template/src/relay.ts`.
- **생존 프로브**: 서비스와 릴레이의 관리 포트에 `/livez`(docs/architecture.md §5 '프로브 규칙').
- **공용 차트 시작**(`deploy/charts/peaket-service`): 서비스 Deployment(준비 `/ready`·생존 `/livez`·`PEAKET_POD`·토큰 없음·preStop 5초)와 `<서비스>-outbox-relay` Deployment(복제 2, 같은 이미지·다른 명령, 한 파드씩), Lease 하나만 다루는 Role. 나머지(Rollout·PDB·KEDA·NetworkPolicy·ExternalSecret)는 wbs 0.4.4.
- **CI**: `ci-kind.yml`(로컬과 같은 스크립트로 클러스터를 띄워 시험), 바뀐 범위 `kind`, 비밀이 필요한 단계의 포크 PR 건너뛰기 표시 `tools/ci/fork-guard.mjs`.
- **찾은 결함**: Outbox 릴레이가 `seq`를 글자로 바꾼 이름으로 정렬해 자릿수가 다른 번호가 한 묶음에 섞이면 순서가 뒤집혔다(FND-080 코드). 재현 시험부터 만들어 고친다.

## Impact

- 정본: docs/infra.md §3(로컬 구성·LocalStack 준비물), docs/devops.md §3.1(`ci-kind.yml` 행)·§4.5(포크 PR)·§9.4(로컬 Kafka 판), docs/security/secrets-and-keys.md(LocalStack 토큰 행), docs/security/asvs/delivery.md(13.1.1·13.2.2·13.4.1), docs/observability.md §3(운영 확인 표), docs/verification.md V-T28, docs/planning/01-overview.md §5.2(LocalStack 위험), ADR-0133 상태 줄, wbs 0.4.1.
- ID: wbs 0.4.1, V-T28 ①(kind 부분), 기술 검토 낮음-010, ADR-0010·0070·0116·0133·0141, ASVS v5.0.0-13.1.1·13.2.2·13.4.1·16.5.2.
- 코드: `tools/local/`(새), `tools/ci/fork-guard.mjs`·`changes.mjs`, `.github/workflows/ci-kind.yml`·`ci.yml`, `deploy/local/`·`deploy/charts/peaket-service/`(새), `packages/platform`(릴레이 프로세스, `/livez`, 정비 깨우기, 릴레이 정렬 고침, 뼈대 시작 파일·Dockerfile), 뿌리 개발 의존성 `yaml`(잠금 파일에 이미 있던 판).
- 넘김: 부하(V-T27)를 건 V-T28 ①~③ 전체와 성능 장부 기록(wbs 2.12.3), 차트의 나머지와 오버레이·정책(wbs 0.4.4), 정비 DB 역할과 릴레이 역할을 만드는 마이그레이션(BAS-060), 이미지 빌드·서명 잡(build-image.yml), MSK IAM 인증(FND-120).
