# ADR-0318: Kyverno CEL 입장 정책과 오프라인 검증(2026-11-20)

- **상태**: 채택(추천 적용, 2026-11-20, BAT-085 계획, 전체 감독 결정 3·4·6). [ADR-0054](0054-delivery-pipeline-change-freeze-and-safe-deploys.md) 결정 4(검증 실패 때의 폴백)와 [ADR-0130](0130-tech-review-medium-doc-fixes-accounts-security-privacy.md)(중간-062·063)을 구현하는 값·모양을 정한다. 두 ADR의 결정은 바꾸지 않는다.
- **관련**: [docs/devops.md](../devops.md) §4.3 '배포 때 검증(Kyverno)'·§3.2 '배포 상태'·§5.2 '네임스페이스 지도', [docs/infra.md](../infra.md) §4.1·§9, [docs/infra-handover.md](../infra-handover.md) §3.1, [docs/security/asvs/delivery.md](../security/asvs/delivery.md) 13.2.5·13.3.1·13.4.2, [ADR-0070](0070-incident-response-evidence-probes-timeouts-throughput-soak.md)(Node 실행 옵션), [ADR-0082](0082-istio-ambient-mesh-app-boundary-meshless-portfolio-runs.md), [ADR-0102](0102-control-plane-direct-grpc-dedicated-pool-ops-db-audit-chain-worker-break-glass.md), [ADR-0169](0169-one-public-monorepo-and-private-bot-repository.md), [ADR-0263](0263-external-security-scan-tools-pinned-semgrep-replaced.md), [ADR-0285](0285-mesh-port-allow-source-generated-policies.md), 계획 [docs/review/plans/BAT-085.md](../review/plans/BAT-085.md)
- **관련 ID**: D-T11, D-T18 ②, D-T28, D-T33 ①~③, BAS-150, ASVS v5.0.0-13.2.5·13.3.1·13.4.2

## 맥락

- 정본은 입장 정책을 Kyverno의 CEL 기반 `ImageValidatingPolicy`와 `ValidatingPolicy`로 만들고, 데모는 감사(Audit), 스테이징·운영은 거부(Deny)로 두라고 정했다. 그런데 저장소에는 정책도, 설치 값도, 정책을 환경별로 만드는 원천도 없었다.
- Kyverno 1.19에서 옛 `ClusterPolicy`·`Policy` 형식이 폐기되고 1.20에서 제거됐다. `verifyImages` 규칙을 포함한 옛 형식은 쓸 수 없다. v1.20.0 공식 차트(3.10.0)는 CEL 정책 형식을 기본으로 설치한다.
- 정책 값(모드·허용 레지스트리·데모 이미지·핫패스 목록)을 환경 파일마다 손으로 적으면, 한 곳을 고치고 다른 곳을 놓치는 결함이 생긴다. 정본은 "한 원천에서 생성"을 요구한다(ADR-0285의 메시 정책 생성기와 같은 꼴).
- 온세일 확장 중 입장 정책이 Sigstore나 Kyverno 장애에 묶이면 K9(60초 확장)를 깬다. 정본은 서명 번들의 투명성 로그 증명으로 오프라인 확인이 되는지, 또는 검증 결과가 캐시되는지를 PoC로 확인하고, 실패하면 승격 단계 검증과 승격 다이제스트 허용 목록으로 바꾸라고 정했다(ADR-0054 결정 4).
- 이 PC에는 우리 이미지가 게시된 GHCR 패키지가 없고, 조직 패키지는 첫 푸시 때 비공개가 기본이다. 그래서 우리 이미지의 익명 끌어오기(D-T33 ③)는 첫 출시 뒤에 잰다.

## 결정

1. **정책은 한 원천에서 환경별로 생성한다**:
   - 원천은 `deploy/policies/kyverno/policy-values.yaml` 하나다. 생성기 `node tools/ci/kyverno-policies.mjs --write|--check`가 `envs/{demo,staging,prod}/policies.yaml`을 만든다. 생성 파일은 손으로 고치지 않는다.
   - 생성기는 손 고침, 미해결 자리 표시(`<ECR_ACCOUNT>` 같은 꺾쇠), 환경 누락·중복, 접두사 끝의 `/` 누락, 글롭(`*`), 시스템 네임스페이스 혼입을 거부한다.
   - 데모는 `validationActions: [Audit]`·`failurePolicy: Ignore` [가정](데모 가용성), 스테이징·운영은 `[Deny]`·`Fail`이다. 웹훅 `timeoutSeconds: 15` [가정].
   - 정책은 서비스 네임스페이스 이름 목록(queue·purchase·ticket·trust·core·web·platform·ops-breakglass)에만 건다. `kube-*` 같은 넓은 제외를 쓰지 않는다. 시스템·애드온 네임스페이스(kube-system·kyverno·kube-node-lease·kube-public)는 목록에 넣지 않는다.
2. **정책 넷과 이름**:
   - `peaket-image-admission`(`ImageValidatingPolicy`): cosign 키 없는 서명의 신원(`build-image.yml@refs/heads/release/*`·`hotfix/*`, 발급자 `https://token.actions.githubusercontent.com`, Rekor `https://rekor.sigstore.dev`), SLSA v1 출처 증명의 `buildType`·`workflow.repository`·`.path`·`.ref`·`runner_environment=github-hosted`, 다이제스트 검증(`validationConfigurations.required: true`·`verifyDigest: true`). 컨테이너·초기 컨테이너·임시 컨테이너를 모두 본다. 허용 레지스트리는 이 정책이 보지 않는다(서명 검증 전에 GHCR 이미지가 거부되게 분리한다).
   - `peaket-registry-allowlist`(`ValidatingPolicy`): 모든 컨테이너·초기·임시 컨테이너 이미지가 환경의 허용 접두사로 시작하는가. 데모는 `ghcr.io/peaket/`, 스테이징·운영은 `<ECR_ACCOUNT>.dkr.ecr.ap-northeast-2.amazonaws.com/`다. 데모는 `imagePullSecrets`도 거부한다(공개 GHCR 익명 끌어오기).
   - `peaket-pod-baseline`(`ValidatingPolicy`): requests·limits, PSS Restricted, `latest`/태그 없는 이미지, hostPath, (스테이징·운영) 데모 전용 이미지, `PEAKET_ENV` 일치, Node 컨테이너의 `--disable-sigusr1`(command/args **또는** `NODE_OPTIONS`)과 디버그 옵션 금지. `sh -c "node …"`도 Node로 본다.
   - `peaket-hotpath-placement`(`ValidatingPolicy`): 핫패스 워크로드(queue-svc·admission-ctrl·purchase-svc·realtime-gw·web)의 `nodeSelector: {karpenter.sh/capacity-type: on-demand}` [가정, BAT-076 NodePool 라벨과 맞춘다], ops-svc의 관제 풀 toleration(`peaket.io/pool=ops:NoSchedule`)·`priorityClassName: peaket-control`.
3. **설치 값**: Kyverno 공식 차트 3.10.0(appVersion v1.20.0)을 쓴다. admission controller 복제 3·PDB `minAvailable: 2`·`priorityClassName: peaket-control`·관제 풀 toleration·토폴로지 분산, 네 컨트롤러 이미지 다이제스트 고정, 웹훅 `timeoutSeconds: 15` [가정], 시스템 네임스페이스 제외. 값은 `deploy/platform/kyverno/values.yaml`, 운영 설치는 `application.yaml`(ArgoCD Application 자리)이 맡는다. kind 시험은 Helm으로 직접 설치한다.
4. **오프라인 검증 PoC의 통과 기준과 폴백**:
   - ① 같은 다이제스트를 한 번 온라인으로 통과시킨 뒤 Kyverno egress를 로컬 레지스트리·DNS만 남기고 막고 다시 띄워, 캐시로 통과하는지 잰다.
   - ② 새 다이제스트를 키 기반 시험 서명과 오프라인 번들로 통과시키는지 잰다.
   - 둘 다 통과해야 "오프라인 번들 검증"이라 부른다. ①만 통과하면 온세일 확장 위험은 줄지만 오프라인 번들 검증은 아니다. 둘 다 실패하면 ADR-0054 결정 4의 폴백(승격 단계 `gitops-check` 검증 + 승격 다이제스트 허용 목록)을 쓴다.
   - 키 없는(keyless) 서명의 오프라인 번들은 첫 출시 이미지가 생긴 뒤 G-20에서 한 번 더 잰다. 이 묶음의 한계로 기록한다.
   - 결과는 `docs/review/measurements/BAT-085-offline-verify.md`에 적는다. 이 ADR을 쓴 시점에는 Docker/kind를 돌리지 않았다(시험·검증 담당 몫, Docker 잠금 필요).
5. **kind 입장 시험**: Kyverno 1.20.0을 kind에 설치하고 `--env demo` 정책을 적용한다. ① 테스트 키로 서명한 이미지 통과·서명 없음/다른 키 거부 ② `--disable-sigusr1` 없는 Node 파드 거부 ③ 데모 정책 GHCR 통과·운영 정책 GHCR 거부 ④ 오프라인 PoC. 테스트 서명 키는 시험할 때 임시 폴더에 만들고 지운다. 저장소에 비밀 키를 두지 않는다.
6. **GHCR 익명 끌어오기(D-T33 ③)**: 이 묶음은 공개 GHCR 이미지(예: Kyverno)의 다이제스트를 끌어오기 비밀 없이 받는 것만 잰다. 우리 패키지의 실제 익명 끌어오기는 첫 출시 후보 게시와 패키지 공개 설정(소유자 몫) 뒤로 미룬다. 결과는 `docs/review/measurements/BAT-085-ghcr.md`에 적는다.
7. **이 ADR이 하지 않는 것**: BAS-160(데모 재현)은 BAT-086, 사람 접근(Identity Center·비상 접근·SSM 중계)은 BAT-081, Terraform NodePool/NodeGroup은 BAT-076·BAT-081이다. `data`·`observability`·`otel`·애드온 네임스페이스의 서드파티 이미지에는 이 정책을 걸지 않는다.

## 결과

- 장부 D-T11·D-T18 ②·D-T33 ①·②와 ASVS 13.2.5의 구현 위치가 생긴다. D-T28은 `gitops-check`(ADR-0319)가 본다.
- 정책 값이 한 곳에 모여 환경별 드리프트가 생성 대조(`--check`)로 잡힌다.
- 남는 것: 실제 스테이징·운영 클러스터의 Kyverno 설치·입장 강제(클러스터 애드온 단계), 오프라인 PoC의 실제 측정, 우리 GHCR 패키지 익명 끌어오기, 우리 스트림 작업자(`analytics-ingest`·`ops-rt`) 이미지의 입장 정책.

## 다른 선택지

| 선택지 | 고르지 않은 까닭 |
| --- | --- |
| 옛 `ClusterPolicy`의 `verifyImages` 규칙 | Kyverno 1.19에서 폐기, 1.20에서 제거됐다. CEL 형식이 기본이다 |
| 정책을 환경 파일마다 손으로 쓴다 | 값 드리프트를 생성 대조로 잡을 수 없다 |
| 서명 검증과 허용 레지스트리를 한 정책에 둔다 | GHCR 이미지가 서명 검증 단계까지 가서 거부 사유가 흐려진다. 레지스트리를 먼저 가른다 |
| 운영도 `Audit`로 시작한다 | fail-open이 된다. 정본은 스테이징·운영 `Deny`다 |
| 오프라인 PoC를 이 묶음에서 실행한다 | Docker/kind는 시험·검증 담당 몫이고 Docker 잠금이 필요하다. 스크립트와 기준만 남긴다 |
