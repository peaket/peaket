# BAT-085 오프라인 검증 PoC (측정 계획, 결과 없음)

- **상태**: 2026-11-20 검증 담당이 kind에서 시도했지만 선행 결함으로 측정하지 못했다(아래 '실행 결과'). 2026-11-20 구현 담당은 이 PC에서 Docker/kind를 돌리지 않았다.
- **정본**: [docs/devops.md](../../devops.md) §4.3 '온세일 확장을 막지 않기', [ADR-0318](../../adr/0318-kyverno-image-admission-policies-and-offline-verification.md) 결정 4, [ADR-0054](../../adr/0054-delivery-pipeline-change-freeze-and-safe-deploys.md) 결정 4.
- **도구**: Kyverno 3.10.0(appVersion v1.20.0), `node tools/local/cluster.mjs kyverno --env demo`로 설치·데모 정책 적용. 테스트 서명 키는 시험할 때 임시 폴더에 만들고 지운다(저장소에 비밀 키를 두지 않는다).

## 잴 것

1. **같은 다이제스트 캐시 통과**: 시험 이미지를 한 번 온라인으로 통과시킨 뒤 Kyverno admission controller의 egress를 로컬 레지스트리와 DNS만 남기고 막고, 같은 다이제스트 파드를 다시 띄운다. 통과하면 '검증 결과 캐시'가 동작한다고 본다.
2. **새 다이제스트 오프라인 번들**: 새 다이제스트를 키 기반 시험 서명과 오프라인 번들(투명성 로그 증명 포함)로 통과시키는지 본다. ①만 통과하면 오프라인 번들 검증은 아니다. 둘 다 통과해야 "오프라인 번들 검증"이라 부른다.

## 판정

- 둘 다 통과: 온세일 확장 위험이 줄고 키 없는 서명의 오프라인 번들은 첫 출시 뒤 G-20에서 한 번 더 잰다.
- 둘 다 실패: ADR-0054 결정 4의 폴백(승격 단계 `gitops-check` 검증 + 승격 다이제스트 허용 목록)을 쓴다.
- 한쪽만 통과: 통과한 쪽만 근거로 쓰고, 다른 쪽은 폴백 대상으로 남긴다.

## 결과

- 실행 시각, Kyverno 판, 걸린 시간, 파드 이벤트의 거부·통과 까닭, 실패 시 폴백 판단을 이 파일에 적는다.
- 시험 명령과 결과는 `ci-kind.yml`의 Kyverno 단계(또는 `tools/local/e2e/kyverno.e2e.mjs`)에 남긴다.

## 실행 결과(2026-11-20, 검증 담당 ses_pending_verify_bat085)

- **무대**: kind `peaket`(노드 하나), Kyverno 차트 3.10.0(appVersion v1.20.0), 네 컨트롤러 Running(admission 3/3). Docker 잠금 `lane4-BAT-085`를 13:14~14:06에 잡았다.
- **결과**: **측정 못 함**. ① 같은 다이제스트를 온라인으로 먼저 통과시키는 단계에서 Kyverno가 `offline verification failed`로 거부했다. egress 차단(NetworkPolicy)을 적용하지 못해 캐시 통과와 새 다이제스트 오프라인 번들을 판정하지 못했다.
- **까닭**: 커밋된 `kyverno.e2e.mjs`는 정책 스키마(CRD)에서 먼저 죽고, 스키마만 고친 임시 사본에서도 키 서명(`cosign --tlog-upload=false`) 이미지가 통과하지 못했다. 시험 하네스 결함이지, 캐시나 오프라인 번들이 나쁘다는 증거가 아니다.
- **egress 선택자**: `app.kubernetes.io/component=admission-controller`가 admission controller 파드 셋을 골랐다(라벨 있음). 차단 자체는 재지 못했다.
- **폴백 판단**: 지금 ADR-0054 결정 4의 폴백(승격 단계 검증+승격 다이제스트 허용 목록)을 선언하지 않는다. 계획 `docs/review/plans/BAT-085.md` '검증' 절의 V-01·V-02·V-06을 고친 뒤 다시 잰다.
- **한계**: 키 없는(keyless) 서명의 오프라인 번들은 첫 출시 이미지가 생긴 뒤 G-20에서 한 번 더 잰다.
