# Kyverno CEL 입장 정책(BAS-150·BAT-085)

이 폴더는 클러스터에 들어오는 파드를 검사하는 Kyverno CEL 정책의 원천과 생성 파일을 둔다. 정본은 [docs/devops.md](../../../docs/devops.md) §4.3, 결정은 [ADR-0318](../../../docs/adr/0318-kyverno-image-admission-policies-and-offline-verification.md)이다.

## 파일

| 파일 | 무엇 |
| --- | --- |
| `policy-values.yaml` | 한 원천. 환경별 모드·허용 레지스트리·데모 이미지·핫패스 워크로드·서명 신원 |
| `envs/demo/policies.yaml` | 생성 파일. 데모는 **Audit**(위반 기록, 기동 허용), 웹훅 `failurePolicy: Ignore` [가정] |
| `envs/staging/policies.yaml` | 생성 파일. 스테이징은 **Deny**(기동 거부), `failurePolicy: Fail` |
| `envs/prod/policies.yaml` | 생성 파일. 운영은 **Deny**(기동 거부), `failurePolicy: Fail` |

생성 파일은 손으로 고치지 않는다. 원천을 고친 뒤 생성기로 다시 만든다.

## 정책 넷

| 이름 | 종류 | 무엇을 본다 |
| --- | --- | --- |
| `peaket-image-admission` | `ImageValidatingPolicy` | ① cosign 키 없는 서명의 신원(`build-image.yml@refs/heads/release/*`·`hotfix/*`, 발급자 `token.actions.githubusercontent.com`, Rekor) ② SLSA v1 출처 증명의 `buildType`·`workflow.repository`·`.path`·`.ref`·`runner_environment=github-hosted` ③ 다이제스트 검증(`verifyDigest`)·필수 검증(`required`). 초기·임시 컨테이너도 본다 |
| `peaket-registry-allowlist` | `ValidatingPolicy` | 모든 컨테이너·초기·임시 컨테이너 이미지가 그 환경의 허용 레지스트리 접두사로 시작하는가. 데모는 `imagePullSecrets`도 거부한다 |
| `peaket-pod-baseline` | `ValidatingPolicy` | 자원 requests·limits, PSS Restricted, `latest`/태그 없는 이미지, hostPath, (스테이징·운영) 데모 전용 이미지, `PEAKET_ENV` 일치, Node 컨테이너의 `--disable-sigusr1`(command/args **또는** `NODE_OPTIONS`)와 디버그 옵션 금지 |
| `peaket-hotpath-placement` | `ValidatingPolicy` | 핫패스 워크로드의 `nodeSelector: {karpenter.sh/capacity-type: on-demand}` [가정], ops-svc의 관제 풀 toleration·`priorityClassName: peaket-control` |

정책은 서비스 네임스페이스 이름 목록(queue·purchase·ticket·trust·core·web·platform·ops-breakglass)에만 건다. `kube-*` 같은 넓은 제외를 쓰지 않는다. 시스템·애드온 네임스페이스(kube-system·kyverno·kube-node-lease·kube-public)는 목록에 없다.

## 생성기

```bash
node tools/ci/kyverno-policies.mjs --check   # 생성 파일이 원천과 같은지 본다(다르면 1)
node tools/ci/kyverno-policies.mjs --write   # 원천에서 생성 파일을 다시 만든다
```

`--check`는 손 고침, 미해결 자리 표시(`<ECR_ACCOUNT>` 같은 꺾쇠), 환경 누락·중복, 접두사 끝의 `/` 누락, 글롭(`*`), 시스템 네임스페이스 혼입에서 1로 끝난다. `--root <폴더>`로 다른 저장소 뿌리를 가리킬 수 있다(시험이 임시 폴더를 쓸 때).

## 값

- `ecr.account`는 12자리 계정 ID다(원천에서는 읽기 쉽게 4-4-4로 적어도 된다). 지금은 `0000-0000-0000` [가정]이고 AWS 계정이 생기면 실제 계정 ID로 바꾼다. 생성기는 다른 계정의 `*.dkr.ecr…`을 받지 않도록 이 값을 고정한다. 스테이징·운영 레지스트리는 `{ecr}.dkr.ecr.ap-northeast-2.amazonaws.com/`로 적고 생성기가 계정 ID로 바꾼다.
- 서명 신원·출처 증명 값은 [docs/devops.md](../../../docs/devops.md) §4.2의 정본 값이다. 바꿀 때는 정본과 ADR-0169를 먼저 고친다.
- 정책을 실제 클러스터에 올리는 값은 [deploy/platform/kyverno](../../platform/kyverno)에 있다. kind 시험은 그 값을 Helm으로 직접 설치하고 이 생성 파일을 적용한다.
- 오프라인 검증 PoC(같은 다이제스트 캐시·새 다이제스트 번들)는 [ADR-0318](../../../docs/adr/0318-kyverno-image-admission-policies-and-offline-verification.md) 결정 4와 [docs/devops.md](../../../docs/devops.md) §4.3이 정한다. 결과는 `docs/review/measurements/`에 남긴다(아직 잼 없음).
