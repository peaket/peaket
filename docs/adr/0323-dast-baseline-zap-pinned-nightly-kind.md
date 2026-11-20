# ADR-0323: DAST 기준선 — ZAP 고정 이미지·SARIF 판정·야간 kind 점검(2026-11-20)

- **상태**: 채택(2026-11-20, 감독 승인 결정 4). 갈래 3 BAT-045 계획 담당이 감독에게 4를 올렸고, 감독이 CI kind 야간 점검까지 하고 출시 후보 데모·운영 실제 점검은 데모 환경 뒤로 미루는 것을 승인했다.
- **관련**: [docs/devops.md](../devops.md) §3 표(DAST)·§3.1·§3.3, §4.4, [docs/quality/quality-requirements.md](../quality/quality-requirements.md) QR-SE-1 ③·NFR-016, [docs/security/asvs/delivery.md](../security/asvs/delivery.md) 15.2.1·16.3.1·16.3.2, [tools/ci/scan-tools.mjs](../../tools/ci/scan-tools.mjs), [tools/ci/dast-gate.mjs](../../tools/ci/dast-gate.mjs), [.github/workflows/dast-nightly.yml](../../.github/workflows/dast-nightly.yml), [ADR-0263](0263-external-security-scan-tools-pinned-semgrep-replaced.md), [ADR-0074](0074-git-flow-branching-release-and-hotfix.md) 결정 9, [ADR-0169](0169-one-public-monorepo-and-private-bot-repository.md)
- **관련 ID**: BUILD_ORDER BOT-161, ASVS v5.0.0-15.2.1·16.3.1·16.3.2, OPEN[46](2026-11-16 R-651)

## 맥락

- 저장소에 DAST(ZAP) 코드가 없었다. `tools/ci/scan-gate.mjs`는 gitleaks·CodeQL·Trivy만 판정하고, `tools/ci/scan-tools.mjs`의 고정 표에도 ZAP이 없었다. `.github/workflows`에 DAST 잡도 없었다.
- ZAP 공식 컨테이너 이미지를 받는 것은 허락됐다(OPEN[46], 2026-11-16 R-651). 판과 다이제스트를 고정해야 한다.
- `ops-api`·`scanner-api`는 허용 IP·기기 인증 뒤라 자동 점검이 로그인 뒤 화면을 볼 수 없다. 공개 입구 `www`·`api`·`partner`만 기준선 점검 대상이다.
- 출시 후보 데모 환경이 아직 없다. 데모·운영 실제 점검을 이 묶음에서 돌릴 수 없다.
- 예약 실행이 실패해도 GitHub 기본 알림에만 기대고 있었다(정리 목록 BAT-202).

## 결정

1. **도구 고정**: `tools/ci/scan-tools.mjs`의 `PINS.zap`에 공식 이미지 `zaproxy/zap-stable` 2.17.0과 다이제스트 `sha256:9624669db72f54d86c4b46a7064518bd9bf79d8c61a4c31befa9923489f328af`를 둔다(2026-11-03 게시, 3일 뒤 조건을 지남, 2026-11-20 조회). 판만 있는 값·`latest`는 쓰지 않는다. 새 판은 게시 3일 뒤 것의 다이제스트를 공식 배포에서 다시 읽는다(ADR-0263 결정 1).
2. **실행**: `node tools/ci/scan-tools.mjs dast --target <url> --out <폴더> [--host <호스트>]`가 다이제스트 고정 이미지를 `--network host`로 띄워 `zap-baseline.py`를 돌린다. 결과는 `<폴더>/zap.json`이다. 점검 전에 High가 나와야 하는 미끼 서버(`/.git/config`·`/WEB-INF/web.xml` 등)를 같은 도구로 먼저 돌려, High를 못 찾으면 대상 점검을 하지 않고 `DECOY_EXIT`(3)로 끝난다. 미끼 서버는 같은 프로세스에서 답해야 하므로 docker를 비동기로 돌린다.
3. **판정**: `node tools/ci/dast-gate.mjs --report <zap.json> --out <sarif>`가 ZAP JSON을 SARIF로 바꾼다. High(`riskcode=3`)는 `security-severity` 8.0, Medium(2)은 5.0, Low(1)은 3.0이다. `tools/ci/scan-gate.mjs --tool zap`이 기존 판정 규칙(7.0 이상 막음, Medium 이하는 알림)으로 High를 막는다. 결과 파일이 없거나 비었거나 JSON·SARIF 꼴이 아니거나 `site`·`@name`/`host`가 없으면 막는다. 보고서에는 요청·응답 본문·쿠키·공격 문자열을 옮기지 않는다. 중복은 규칙·주소로 합친다.
4. **야간 점검**: `.github/workflows/dast-nightly.yml`이 `develop` 야간(03:00 KST [가정])·수동 실행으로 kind에 `v0`와 게이트웨이를 올리고 `www`·`api`·`partner`를 점검한다. `ops-api`·`scanner-api`는 넣지 않는다. 결과 JSON·SARIF·판정 보고서를 산출물로 남긴다.
5. **예약 실패 알림**: 예약 실행이 실패하면 SEV3 이슈를 연다. `security-scan.yml`은 `ci.yml`이 `workflow_call`로도 부르므로 그 안에 `issues: write`를 두면 부르는 쪽 권한 규칙(10)을 넘는다. 그래서 `.github/workflows/security-scan-notify.yml`이 `workflow_run`으로 예약 실행 실패만 보고 이슈를 연다. DAST 워크플로 자신의 notify 잡은 `issues: write`를 그 잡만 받는다. 수동·PR 실행 실패는 이슈를 열지 않는다.
6. **출시 후보·데모**: `dast-nightly.yml`에 `workflow_call` 자리를 둘 뿐, 데모 환경이 생기기 전에는 부르지 않는다. release/promote가 부르는 배선은 데모 뒤에 더한다.
7. **판정 도구 대조**: SAST(CodeQL)·의존성(`pnpm audit`·`vuln-deadline`)·이미지(Trivy)·비밀(gitleaks)의 막는 문턱과 예외 만료를 devops §4.4 표에 그대로 두고, 결과를 읽지 못하면 통과로 보지 않는다(닫힘 실패). 승격 차단은 BAT-080 승격 자동화가 맡는다.

## 검토한 대안 (트레이드오프)

| 대안 | 이런 점이 낫다 | 이런 점이 걸린다 | 판단 |
| --- | --- | --- | --- |
| A. ZAP 기준선 + SARIF + 기존 scan-gate(이 결정) | 판정이 한 곳이고, High만 막아 초기 오탐이 배포를 막지 않는다 | 인증 뒤 화면·결제 흐름은 못 본다 | 고른다 |
| B. ZAP Full Scan·인증 점검을 넣는다 | 더 많이 본다 | 시간·계정·세션 관리가 필요해 야간 60분을 넘고, 정본 인증 시험과 겹친다 | 다음 묶음·별도 인증 시험 |
| C. ZAP 전용 워크플로 대신 `security-scan.yml`에 붙인다 | 워크플로가 하나다 | kind·서비스 기동이 필요한데 PR마다 90분짜리 잡이 돈다 | 쓰지 않는다(예약·수동만) |
| D. 예약 실패를 GitHub 기본 알림에 맡긴다 | 일이 없다 | 아무도 모르는 구멍이 남는다(BAT-202) | 쓰지 않는다 |
| E. `issues: write`를 `security-scan.yml` 맨 위에 둔다 | 잡 하나로 끝난다 | `ci.yml`이 부를 때 권한이 넘어 실행이 시작되지 않는다(규칙 10) | 쓰지 않는다. 별도 notify 워크플로 |

## 결과

- 야간에 공개 입구 셋이 ZAP 기준선으로 점검되고, High가 있으면 잡이 실패하며, 예약 실패는 SEV3 이슈로 남는다.
- 대가: `PINS.zap`, `dast-gate.mjs`, `scan-gate`의 `zap` 도구, `dast-nightly.yml`, `security-scan-notify.yml`이 는다. ZAP 이미지는 1.2GB 안팎이라 야간 러너 시간이 는다.
- 남는 한계: 로그인 뒤 화면·결제·마이페이지 인증 점검, ZAP Full Scan, 외부 침투 시험, 데모·운영 실제 점검, ZAP 오탐 예외 정책(첫 구현은 예외 없음)은 다음 묶음·소유자 몫이다.

## 되돌릴 조건

- 미끼 점검이 High를 안정적으로 찾지 못해 야간 잡이 자주 실패하면, 미끼 경로·수동 점검 규칙을 다시 고르거나 미끼를 별도 이미지로 만든다.
- ZAP 기준선이 60분을 넘거나 kind 자원이 모자라면 점검 대상을 줄이거나 러너를 키운다.
- 인증된 점검이 정본에 생기면 `www`·`api`·`partner`의 로그인 뒤 화면을 같은 워크플로에 더한다.
