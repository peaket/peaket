# deploy/

배포 상태가 들어갈 자리다. 어느 환경에 무엇을 띄울지(공용 Helm 차트, 배포 단위 기본 값, 환경 값과 이미지 다이제스트, 클러스터 애드온, Kyverno 정책, ArgoCD 프로젝트, 변경 동결 달력)를 적는다. ArgoCD는 `develop` 가지의 이 폴더만 읽는다.

- 구조와 규칙: [docs/devops.md](../docs/devops.md) §5.2(구조)·§5.3(승격), 결정: ADR-0169
- 처음 채우는 작업: wbs 0.4.4. 지금 있는 것(2026-11-01, wbs 0.4.1, openspec 변경 `add-local-cluster-and-relay-deployment`):

| 자리 | 담는 것 |
| --- | --- |
| `charts/peaket-service/` | 공용 서비스 차트의 시작. 서비스 Deployment·Service(관리 포트의 준비 `/ready`·생존 `/livez`, 파드 이름 `PEAKET_POD`, 서비스 계정 토큰 없음, preStop 5초)와 서비스별 Outbox 릴레이 `<서비스>-outbox-relay` Deployment(복제 2, 같은 이미지·다른 시작 명령, 한 파드씩 바꾸기)와 그 Lease(차트가 미리 만든다) 하나의 읽기·고치기만 다루는 Role. 이미지 태그는 `PEAKET_ENV` local·ci에서만, 다른 환경은 다이제스트만 받는다. Rollout·PDB·KEDA·NetworkPolicy·ExternalSecret·우선순위는 wbs 0.4.4에서 더한다 |
| `local/` | 로컬·CI kind 클러스터 정의(`kind.yaml`)와 클러스터 안의 시험용 저장소: Strimzi Kafka 3.9.1(`kafka.yaml`), PostgreSQL 18(`postgres.yaml`), 계정 없는 AWS 흉내 서버(`aws.yaml`). 로컬 관측 최소(Prometheus·Grafana, `observability.yaml`)와 템플릿 대시보드(`dashboards/<서비스>.json`, `tools/local/dashboards.mjs`가 만든다, docs/observability.md §3). 띄우는 법은 [tools/local/README.md](../tools/local/README.md) |
