# BAT-085 오프라인 검증 PoC (측정 계획, 결과 없음)

- **상태**: 아직 실행하지 않았다. 2026-11-20 구현 담당은 이 PC에서 Docker/kind를 돌리지 않았다(시험·검증 담당 몫, Docker 잠금 필요).
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
