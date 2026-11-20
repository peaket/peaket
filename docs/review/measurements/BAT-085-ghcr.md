# BAT-085 GHCR 익명 끌어오기 측정 (측정 계획, 결과 없음)

- **상태**: 2026-11-20 검증 담당이 계획·감독 결정대로 미뤘다(D-T33 ③은 첫 출시 뒤). 2026-11-20 구현 담당은 이 PC에서 Docker/kind를 돌리지 않았다.
- **정본**: [docs/devops.md](../../devops.md) §5.1·D-T33 ③, [ADR-0318](../../adr/0318-kyverno-image-admission-policies-and-offline-verification.md) 결정 6.

## 잴 것

1. **공개 GHCR 이미지**: 로컬 kind가 끌어오기 비밀 없이 공개 GHCR 이미지의 다이제스트를 받는지 잰다(예: Kyverno 이미지 `reg.kyverno.io/kyverno/kyverno:v1.20.0@sha256:9de4…`). 파드를 만들고 `ImagePullBackOff` 없이 뜨는지, `imagePullSecrets`가 없는지 본다.
2. **우리 패키지(첫 출시 뒤)**: `ghcr.io/peaket/<이미지>@sha256:…`를 같은 방법으로 받는다. 첫 푸시는 조직 패키지가 **비공개**가 기본이라 소유자가 패키지 공개 설정을 바꿔야 한다. 이 묶음에서는 미룬다.

## 판정

- 공개 GHCR 이미지가 비밀 없이 뜨면 '익명 끌어오기 경로' 자체는 확인된 것이다.
- 우리 패키지는 첫 출시 후보 게시 뒤 같은 측정을 한 번 더 하고, 그때 공개 설정이 안 되어 있으면 소유자에게 올린다.

## 결과

- 실행 시각, 이미지·다이제스트, 파드 이벤트, 걸린 시간을 이 파일에 적는다. 우리 패키지 몫은 '아직'으로 남긴다.
- 데모 입장 정책의 `peaket-registry-allowlist`가 `imagePullSecrets`를 거부하는지도 같은 kind에서 함께 본다(D-T33 ①).

## 실행 결과(2026-11-20, 검증 담당 ses_pending_verify_bat085)

- **D-T33 ③은 미룬다**: 계획·감독 결정대로 우리 패키지의 익명 끌어오기는 첫 출시 후보 게시 뒤에 잰다.
- **곁들여 본 것**: 호스트 Docker가 `ghcr.io/sigstore/cosign/cosign:v2.4.1`을 끌어오기 비밀 없이 받았다(kind e2e가 cosign을 쓸 때). 이것은 kind 파드의 익명 끌어오기가 아니므로 ③의 근거로 쓰지 않는다.
- **우리 패키지**: 아직 게시된 이미지가 없다. 첫 푸시는 조직 패키지가 비공개가 기본이라 소유자가 공개 설정을 바꿔야 한다.
- **정적 확인**: 데모 정책의 `imagePullSecrets` 금지와 GHCR 접두사는 단위 시험(GV-05·GV-06, KV-09)이 본다.
