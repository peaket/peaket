# ADR-0319: gitops-check의 몫과 공급망 검증(2026-11-20)

- **상태**: 채택(추천 적용, 2026-11-20, BAT-085 계획, 전체 감독 결정 3·6). [ADR-0054](0054-delivery-pipeline-change-freeze-and-safe-deploys.md)·[ADR-0082](0082-istio-ambient-mesh-app-boundary-meshless-portfolio-runs.md)·[ADR-0130](0130-tech-review-medium-doc-fixes-accounts-security-privacy.md)·[ADR-0169](0169-one-public-monorepo-and-private-bot-repository.md)의 결정을 구현하는 검사 범위와 규칙을 정한다.
- **관련**: [docs/devops.md](../devops.md) §3.2 '배포 상태'·§3.4 '출시 후보 빌드는 캐시를 쓰지 않는다'·§4.3·§5.3, [docs/security/asvs/delivery.md](../security/asvs/delivery.md) 13.2.5·13.3.1·15.2.4, [ADR-0054](0054-delivery-pipeline-change-freeze-and-safe-deploys.md), [ADR-0130](0130-tech-review-medium-doc-fixes-accounts-security-privacy.md), [ADR-0169](0169-one-public-monorepo-and-private-bot-repository.md), [ADR-0263](0263-external-security-scan-tools-pinned-semgrep-replaced.md), 계획 [docs/review/plans/BAT-085.md](../review/plans/BAT-085.md)
- **관련 ID**: D-T28, D-T32 ②·③, D-T33 ①~③, D-T42(이동하지 않음), BAS-150, ASVS v5.0.0-13.2.5·13.3.1·15.2.4

## 맥락

- 정본은 `deploy/`가 바뀌면 `gitops-check`가 최종 오버레이를 만들고 메시 필수(D-T28)·허용 레지스트리(D-T33)·서명/출처 증명(D-T32 ③)을 본다고 정했다. 그런데 저장소에는 워크플로도 검사 스크립트도 없고, `tools-check`가 게이트웨이 라우트 생성 대조와 메시 정책 생성 대조를 대신 돌고 있었다.
- `gitops-check`가 한 번에 너무 많은 것을 하면(스키마 검사·ArgoCD 차이·동결 게이트·라우트 생성) 실패의 까닭이 섞이고, 뒤 묶음이 정할 도구(kubeconform 등)를 앞당겨 들이게 된다. 정본은 이 묶음의 몫을 static으로 좁혔다.
- 출시 후보 빌드가 기본 가지(`develop`)의 캐시를 복원하면 오염된 캐시가 출시 산출물에 들어간다(2026-05-11 'Mini Shai-Hulud'). 정본은 출시·핫픽스 후보 빌드에 캐시를 쓰지 말라고 정했다. 그런데 워크플로 검사는 D-T32 ①(권한·금지 단계)만 보고 있었고, `image-build.mjs`에는 캐시 관련 인자가 없었다.
- 서명·출처 증명의 신원이 `develop`이거나 자체 호스트 실행기면 운영 승격 PR에서 거부해야 한다. `workflow.repository`·`.path`·`.ref`·`runner_environment`를 보는 판정 함수와 고정물이 없었다.
- 우리 GHCR 패키지는 아직 없고 첫 푸시는 비공개가 기본이다. 그래서 실제 익명 끌어오기는 첫 출시 뒤에 잰다.

## 결정

1. **`gitops-check`는 static만 한다**:
   - 새 워크플로 `.github/workflows/gitops-check.yml`은 `workflow_call`, `permissions: contents: read`, 15분 상한이다. `ci.yml`이 바뀐 범위 `gitops`에서 부르고 `ci-summary`의 `needs`에 넣는다.
   - 검사는 `tools/ci/gitops-check.mjs --check [--root] [--env] [--image]`가 한다: ① 최종 오버레이 렌더(환경 값이 있으면 Helm, 없으면 배포 단위 값) ② D-T28(운영만: 네임스페이스 `istio.io/dataplane-mode: ambient` 값, `istio-system/default` STRICT PeerAuthentication 하나, `PEAKET_GRPC_LB_PROFILE=headless-round-robin` 금지) ③ D-T33(환경별 허용 레지스트리 접두사, 데모 GHCR·운영 ECR, 다른 계정·`peaket-evil` 거부) ④ 배포 값의 `image.digest`(태그 금지) ⑤ 승격 값의 cosign 서명·SLSA 출처 증명.
   - 값 파일(`deploy/envs/<환경>`)이 없으면 서명 검사는 '아직 승격 없음'을 남기고 건너뛴다. 태그만 있는 값이나 다이제스트가 없는 값은 건너뛰지 않고 실패다.
   - 게이트웨이 라우트 생성 대조(D-T42)는 이 묶음에서 `tools-check`에 그대로 둔다(중복·범위 누락 위험). kubeconform·ArgoCD 차이 미리보기·변경 동결 게이트는 뒤 묶음이다.
2. **공급망 검증의 판정**:
   - `tools/ci/supply-chain-verify.mjs`는 이미지 인덱스와 플랫폼 이미지를 모두 `cosign verify --recursive`로 본다. 신원 정규식은 `^https://github\.com/peaket/peaket/\.github/workflows/build-image\.yml@refs/heads/(release|hotfix)/`로 **앞을 앵커**하고, 발급자는 `https://token.actions.githubusercontent.com`으로 고정한다.
   - 출처 증명은 `cosign verify-attestation --type slsaprovenance1`로 받아 SLSA v1의 `predicateType`·`buildDefinition.buildType`·`externalParameters.workflow.repository`·`.path`·`.ref`·`internalParameters.github.runner_environment`를 본다. `ref`가 `refs/heads/develop`·`main`이거나 실행기가 `self-hosted`면 실패다.
   - 증명에 `runner_environment`가 없는 판이면 인증서의 Fulcio 확장 `1.3.6.1.4.1.57264.1.11`을 읽는 작은 DER 파서로 같은 값을 본다(새 패키지 없음). 둘 다 없으면 닫힘 실패(fail-closed)다.
   - 공개 인증서·증명 고정물은 `tools/ci/fixtures/`에 두고 개인 키는 두지 않는다. 실제 승격 이미지 검증은 첫 승격 PR에서 한 번 더 본다.
3. **출시 후보 빌드의 캐시 금지(D-T32 ②)**:
   - `build-image.yml`의 빌드 잡에는 `actions/cache`, `cache-from`, `cache-to`, `--cache-from`, `--cache-to`, `--mount=type=cache`, `cache-mode` 가운데 하나도 없어야 한다. `check-workflows.mjs`가 PR에서 막는다.
   - `image-build.mjs`는 `GITHUB_REF`가 `refs/heads/release/*`·`refs/heads/hotfix/*`이면 OCI 빌드와 스모크 다시 빌드 **둘 다** `--no-cache`를 붙인다. `develop`·PR은 캐시를 허용한다(지금 캐시가 없어 동작 변화 없음).
4. **GHCR(D-T33 ③)은 측정으로 남긴다**: 이 묶음은 공개 GHCR 이미지의 다이제스트를 끌어오기 비밀 없이 받는 것만 잰다. 우리 패키지의 실제 익명 끌어오기는 첫 출시 후보 게시와 패키지 공개 설정(소유자 몫) 뒤에 잰다. 결과는 `docs/review/measurements/BAT-085-ghcr.md`에 적는다.
5. **레지스트리 값**: 데모·로컬·CI는 `ghcr.io/peaket/`, 스테이징·운영은 `<ECR_ACCOUNT>.dkr.ecr.ap-northeast-2.amazonaws.com/`다. ECR 계정 ID는 12자리로 고정해 다른 계정의 `*.dkr.ecr…`을 받지 않는다. 지금 값은 `0000-0000-0000` [가정]이고 AWS 계정이 생기면 바꾼다. 접두사 뒤에는 반드시 `/`를 둔다.

## 결과

- `deploy/` PR마다 최종 오버레이 검사가 돌고, 승격 값이 생기면 서명·출처 검증까지 돈다. 장부 D-T28·D-T32 ②·③·D-T33 ①·②와 ASVS 13.2.5의 구현 위치가 생긴다.
- 출시 후보 빌드가 캐시를 쓰는 PR과 `develop`/자체 호스트 서명을 승격하는 PR이 정적 검사에서 막힌다.
- 남는 것: kubeconform 스키마 검사·ArgoCD 차이 미리보기·변경 동결 게이트(뒤 묶음), 실제 ECR·운영 클러스터의 서명 검증(환경이 생긴 뒤), GHCR 패키지 공개와 익명 끌어오기 측정.

## 다른 선택지

| 선택지 | 고르지 않은 까닭 |
| --- | --- |
| kubeconform·ArgoCD 차이까지 이 묶음에 넣는다 | 새 도구와 클러스터 자격 증명이 필요하고, 실패 원인이 섞인다. 정본이 뒤 묶음으로 미뤘다 |
| 게이트웨이 라우트 생성 대조를 `gitops-check`로 옮긴다 | `tools-check`와 중복되거나 한쪽에서 빠질 위험이 있다. 이 묶음은 옮기지 않는다 |
| 서명 신원을 정규식 앵커 없이 본다 | `build-image.yml.evil@…`이 통과한다 |
| 증명에 `runner_environment`가 없으면 통과시킨다 | 자체 호스트 실행기 서명을 거부하지 못한다(fail-open) |
| 출시 빌드도 캐시를 쓴다 | 기본 가지 캐시 오염이 출시 산출물로 들어간다 |
| GHCR 익명 끌어오기를 지금 닫는다 | 우리 패키지가 아직 없고 공개 설정은 소유자 몫이다 |
