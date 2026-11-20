# ADR-0325: 데모는 로컬·클라우드 두 경로로 재생한다(2026-11-20)

- **상태**: 채택(2026-11-20, 감독 결정 2·6·7). BAT-086 계획 담당이 감독에게 올렸고, 감독이 로컬을 기본(0원)·클라우드를 절차만으로 확정했다.
- **관련**: [docs/verification.md](../verification.md) §7·V-T7, [docs/infra.md](../infra.md) §3 '데모', [docs/devops.md](../devops.md) §5.1·§5.2·§11·§14, [docs/review/plans/BAT-086.md](../review/plans/BAT-086.md), [deploy/envs/local/demo/README.md](../../deploy/envs/local/demo/README.md), [deploy/envs/demo/README.md](../../deploy/envs/demo/README.md), [deploy/demo/cloud-plan.yaml](../../deploy/demo/cloud-plan.yaml), [tools/local/demo.mjs](../../tools/local/demo.mjs), [tools/local/demo/runner.mjs](../../tools/local/demo/runner.mjs), [ADR-0057](0057-verification-without-full-scale-infra.md), [ADR-0095](0095-sale-pause-single-commander-and-two-person-approval-demo.md), [ADR-0153](0153-public-docs-scope-no-click-demo-session-canonical-browse-pages.md), [ADR-0165](0165-four-repositories-monorepo-gitops-shared-workflows-private-loadtest.md), [ADR-0283](0283-cut-batch-overhead-keep-high-yield-checks.md), [ADR-0318](0318-kyverno-image-admission-policies-and-offline-verification.md)·[ADR-0319](0319-gitops-check-scope-and-supply-chain-verification.md)
- **관련 ID**: BUILD_ORDER BAT-086·BAT-087(BAS-160), V-T7, D-T48(시연만), docs/design/d5-screen-blueprint.md §10.6

## 맥락

- 늘 켜 두는 데모는 두지 않는다(ADR-0057). 기본은 실제 앱을 로컬에서 녹화하고 재현 스크립트로 다시 보이는 것이다(ADR-0153).
- BAT-087이 로컬 데모 무대를 만들었다: 이 PC에서만 빌드하는 `peaket/<워크로드>:demo` 이미지, `deploy/envs/local/demo` 오버레이(포트 18441~18445·`PEAKET_ENV=local`·`pullPolicy: Never`), 실제 백엔드를 보는 게이트웨이 다섯, 기본 합성 시드, 데모 인증(팬 gRPC·관리 TOTP·패스키).
- 첫 출시 전에는 GHCR에 서명한 출시 후보가 없어 `deploy/envs/demo`의 값 파일이 비어 있다(첫 출시 뒤 승격 묶음 몫). 그래서 클라우드 데모를 지금 실행할 수 없다.
- BAT-086은 재현 스크립트·클라우드 절차·운영 판 호환 검사 시연만 한다. 데모 무대 자체는 BAT-087 몫이다.
- 같은 재현 스크립트가 로컬과 클라우드에서 돌아야 한다는 요구가 생겼다. 두 경로의 이미지 출처·환경 값·비용 책임이 다르다.

## 결정

1. **두 경로를 가른다.**
   - **로컬(기본, 0원)**: BAT-087의 `peaket/<워크로드>:demo` 이미지와 `deploy/envs/local/demo/` 오버레이를 쓴다. `imagePullSecrets`가 없고 `pullPolicy: Never`이며 `PEAKET_ENV=local`이다. `node tools/local/cluster.mjs demo`가 무대를 올린다.
   - **클라우드(선택, 절차만)**: `deploy/envs/demo/*.yaml`의 **서명된 GHCR 다이제스트**만 쓴다. 공개 패키지라 끌어오기 비밀이 없고, `PEAKET_ENV=demo`다. 이 묶음은 실행하지 않는다.
2. **한 명령은 `node tools/local/demo.mjs all`이다.** 저장소 뿌리에서 Node 24와 Docker만 있으면 ① 선행 점검(`doctor`) ② 무대(`cluster.mjs demo`) ③ 기본 시드(`demo-seed --apply`) ④ S1~S9 재생 ⑤ 측정 파일 ⑥ 정리(데모 네임스페이스 + kind 클러스터)까지 한다. 중간에 하나라도 실패하면 그 단계에서 멈추고 exit 1이다. `--keep`이면 무대를 남긴다.
3. **두 경로가 같은 시나리오·같은 시드를 쓴다.** 시나리오는 `tools/local/demo/scenarios.mjs`(정본 d5 §10.6을 `plan --check`로 대조), 시드는 `deploy/envs/demo/seed/base.yaml` 하나다. 클라우드 경로도 같은 `play`를 쓴다. 경로마다 달라지는 것은 무대 값(이미지 출처·오버레이·`PEAKET_ENV`)뿐이다.
4. **데모 시계는 실제 10분을 기다리지 않는다.** 재생은 파트너 회차 고치기 API로 회차 오픈을 지금+30초로 당기고(공개 전에만), 화면의 조건을 기다린다. 고정 `sleep`으로 화면을 넘기지 않는다.
5. **S7 2인 승인은 브라우저 맥락 둘로 한다.** 요청자와 데모 승인자를 따로 열어 ① 요청자가 자기 명령을 승인하면 403 ② 승인자 맥락이 승인하면 성공 ③ 감사 기록에 두 계정이 따로 남는지를 본다. OPS-290의 데모 도우미는 기다리지 않는다(ADR-0095의 더 단순한 방법).
6. **Playwright는 `tools/web-checks` 1.64.1을 빌려 쓴다.** 새 패키지를 루트에 넣지 않는다.
7. **클라우드 값은 `deploy/demo/cloud-plan.yaml`에 두고 산술로 검사한다.** TTL ≤ 6시간 [가정], 시간당 추정 × TTL × 환율 ≤ 예산(5만 원 상한 안), 정리 차례에 클러스터·부하 분산기·DNS·비밀·볼륨·로그가 모두 있어야 한다. `node tools/local/demo.mjs cloud-plan --check`(또는 `tools/ci/cloud-plan.mjs --check`)가 보고, 실제 자원은 만들지 않는다.
8. **장부 범위는 V-T7 하나다.** D-T48(운영 판 호환)은 이미 자동 시험이라 이 묶음은 `compat`으로 시연만 하고 장부 범위에 넣지 않는다.

## 검토한 대안 (트레이드오프)

| 대안 | 이런 점이 낫다 | 이런 점이 걸린다 | 판단 |
| --- | --- | --- | --- |
| A. 로컬 기본 + 클라우드 절차(이 결정) | 첫 출시 전에도 0원으로 재현되고, 클라우드 절차를 같은 스크립트로 미리 정한다 | 클라우드 실행은 첫 출시 뒤까지 검증되지 않는다 | 고른다 |
| B. 클라우드만 쓴다 | 운영과 같은 이미지·환경을 본다 | 출시 전에는 서명 다이제스트가 없고, 비용·계정·TTL이 소유자 몫이라 지금 재현할 수 없다 | 쓰지 않는다 |
| C. 로컬만 두고 클라우드 절차를 버린다 | 문서·검사가 줄어든다 | 면접·발표 때 몇 시간 켜는 선택 경로가 사라지고, 예산·정리 규칙을 미리 정할 수 없다 | 쓰지 않는다 |
| D. 데모 무대를 BAT-086에서 함께 만든다 | 한 묶음으로 끝난다 | BAS-160의 1.25일 약속과 BUILD_ORDER 차례가 깨진다(감독이 BAT-087로 분리) | 쓰지 않는다 |
| E. 화면 클릭을 디자인 캔버스로 대신한다 | 화면 코드가 필요 없다 | 실제 앱과 같은 일을 두 번 하고 정본과 어긋난다(ADR-0153) | 쓰지 않는다 |

## 결과

- 빈 PC에서 `node tools/local/demo.mjs all` 한 번으로 무대·시드·S1~S9 재생·측정·정리가 이어진다. 걸린 시간은 `docs/review/measurements/BAT-086-demo.md`에 남는다.
- 클라우드 데모는 `deploy/demo/cloud-plan.yaml`의 값 검사와 `docs/devops.md` §5.1 절차로만 존재한다. 첫 출시 뒤 승격 묶음이 `deploy/envs/demo`의 서명 다이제스트를 채우면 같은 `play`로 돈다.
- 대가: `tools/local/demo.mjs`와 `tools/local/demo/`(시나리오·재생기·측정·호환·클라우드 검사)가 는다. 정본 문서 넷(infra·devops·verification·d5)과 BUILD_ORDER·lane4가 이 경로를 가리킨다.
- 남는 한계: 이 묶음의 재생은 S1·S3·S4·S6을 실제 API로 끝까지 부르고, S2·S5·S7·S8·S9는 화면 증거와 실패 사유까지만 남긴다(사람 확인·재인증·스캐너 기기 등록·매진 픽스처가 다음 몫). 클라우드 실행, ArgoCD·카나리·동결 창, 데모 도우미(OPS-290), 성능 수치는 이 결정의 범위가 아니다.

## 되돌릴 조건

- 로컬 무대가 첫 출시 뒤에도 서명 GHCR 다이제스트를 요구하게 되면(예: 이미지 정책이 로컬까지 강제) 로컬 경로를 클라우드와 합치거나, 로컬 전용 예외를 새 ADR로 다시 정한다.
- 클라우드 데모를 처음 실행했을 때 `cloud-plan`의 시간당 추정이 실제 청구와 20% 넘게 다르면 추정 항목·환율·TTL을 다시 고른다.
- 같은 `play`가 두 경로에서 다른 결과를 내면 경로별 차이(환경 값·시드 시각)를 먼저 좁히고, 그래도 다르면 시나리오를 경로별로 나누는 것을 검토한다.
