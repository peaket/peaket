# ADR-0263: 외부 보안 검사 게이트는 gitleaks를 체크섬 고정 실행 파일로 CI에서만, CodeQL·Scorecard는 커밋 고정 액션으로, Trivy는 다이제스트 고정 이미지를 네트워크 없이 쓰고, Semgrep 몫은 CodeQL 프로토타입 오염 쿼리와 직접 만든 ESLint 규칙이 맡는다

- **상태**: 채택(2026-11-10, 추천 적용. 도구를 받는 것은 소유자 결정 OPEN[31] "모두 추천대로", 2026-11-10). BUILD_ORDER BAS-011 ②, 기능 묶음 BAT-202(ADR-0256), wbs 0.1.4 ②.
- **관련**: POL-041, ADR-0037 결정의 `sql.raw()` 규칙(지키는 도구를 Semgrep에서 ESLint로 바꾼다), ADR-0054, ADR-0165, ADR-0169, ADR-0222, ADR-0253, ADR-0259 결정 10·12, [docs/devops.md](../devops.md) §3.1 `security-scan.yml`·`build-image.yml` 행·§4.4 '외부 보안 검사 게이트'·§4.5·§9.3·§14 D-T12, [docs/security/asvs/delivery.md](../security/asvs/delivery.md) 13.1.1·13.3.1·13.4.1·15.3.6, [docs/architecture.md](../architecture.md) §8.3 SQL 주입 행
- **관련 ID**: D-T12, ASVS v5.0.0-13.1.1, 13.3.1, 13.4.1, 15.3.6, 16.5.3

## 맥락

- 용어: 비밀 탐지(gitleaks)는 커밋 이력에서 키·토큰 꼴의 글자를 찾는 검사다. 정적 분석(CodeQL)은 코드를 실행하지 않고 읽어 값이 흘러가는 길을 따라 약점을 찾는다. 설정 검사(Trivy)는 인프라 코드·쿠버네티스 매니페스트·Dockerfile의 위험한 설정을 찾는다. OpenSSF Scorecard는 저장소의 공급망 습관(액션 고정, 토큰 권한 등)에 점수를 매긴다. SARIF는 이런 도구가 결과를 담는 표준 JSON 꼴이다.
- BAS-010 ①(ADR-0259 결정 10)은 외부 도구 없이 되는 몫만 만들었다. 소유자는 2026-11-10 OPEN[31]에 "모두 추천대로"라고 답했다: gitleaks CLI(MIT, 판·체크섬 고정 실행 파일을 CI에서 받기), CodeQL 액션, Scorecard 액션(결과 공개 게시 `publish_results` 끔, 결과 파일만), Trivy(다이제스트 고정 이미지, 액션은 쓰지 않음)는 받고, Semgrep은 지금 받지 않는다. gitleaks의 커밋 전 검사는 이 PC의 응용 프로그램 제어가 낯선 실행 파일을 막아(`pnpm-native.exe`가 막힌 것과 같다) 두지 않는다.
- 정본은 Semgrep 사용자 규칙에 두 가지를 맡겼다: 프로토타입 오염 꼴(ASVS 15.3.6, asvs/delivery 15.3.6 행)과 `sql.raw()`를 허용 목록 밖에서 부르는 곳(ADR-0037, architecture §8.3). Semgrep이 없으면 이 둘을 지킬 곳이 없다.
- 조직 Actions 정책은 GitHub 소유 액션(`actions/*`·`github/*`)과 `hashicorp/setup-terraform`만 허용하고 커밋 SHA 고정을 강제한다(2026-11-10 조직 API 확인, `infra/stacks/global/github/actions.tf`). `ossf/scorecard-action`은 허용 목록에 없다. 코드 스캐닝 기본 설정은 '설정 안 됨'이다(같은 날 확인).
- 이 PC에서는 gitleaks·CodeQL을 돌리지 못한다. Docker는 돌아 Trivy 이미지는 로컬에서도 쓸 수 있다.

## 결정

1. **판을 고정한다.** 첫 고정은 게시 뒤 2주가 넘은 가장 새 안정판이다(2026-11-10 GitHub API·레지스트리 원격 조회). gitleaks 8.30.1(2026-03-21)의 `gitleaks_8.30.1_linux_x64.tar.gz` SHA-256 `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`(`linux_arm64`는 `e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080`), `github/codeql-action` v4.39.1(2026-10-21, 주석 태그를 따라간 커밋 `9b3254085494b55a0f7c4c2b3d2d52cc712ce370`, 기본 CodeQL 묶음 2.27.3), `ossf/scorecard-action` v2.5.0(2026-10-12, 커밋 `fa7117db83c52d787ae5a89f35`+`0999701505d78e`(두 조각을 이은 40자리. 문서 점검이 12자리 숫자를 계정 번호로 읽어 나눠 적었다)), `aquasec/trivy:0.76.1`(2026-10-21, 여러 플랫폼 묶음 다이제스트 `sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c`, GHCR `ghcr.io/aquasecurity/trivy:0.76.1`도 같은 값)이다. 실행 파일 판·체크섬과 이미지 다이제스트는 `tools/ci` 아래 한 파일의 고정 표에 두고, 액션은 워크플로의 `uses:` 줄에 둔다. 올릴 때는 게시 뒤 3일(devops §4.4 '새 버전 대기')이 지난 판을 고르고 체크섬·다이제스트를 공식 배포에서 다시 읽는다.
2. **gitleaks는 CI에서만 돈다.** PR·푸시·주 1회 예약 실행마다 지금 커밋에서 닿는 전체 이력을 본다(이력이 짧아 범위 계산을 두지 않는다. 한 번에 3분 [가정]을 넘으면 범위로 바꾼다). 보고서와 기록에는 비밀을 가린다(`--redact`). 검사 전에 실행 때 만든 미끼 비밀을 같은 설정으로 찾게 해, 못 찾으면 실패다. 누출이 하나라도 있으면 막고, 도구가 누출 아닌 까닭으로 끝나거나 보고서가 없어도 막는다. 설정 `tools/ci/gitleaks.toml`은 기본 규칙을 잇고, 허용 목록은 까닭을 단 좁은 경로·꼴의 오탐만 둔다. 이미 교체를 마친 실제 누출의 이력 지문은 `tools/ci/gitleaks-ignore`에 이슈 번호·교체한 날과 함께 둔다. 실제 비밀을 찾으면 RB-26대로 폐기·재발급한다. 커밋 전 검사는 미룬다(이 PC의 응용 프로그램 제어).
3. **CodeQL은 JS·TS를 빌드 없이 기본 쿼리 묶음으로 본다.** 설정 `tools/ci/codeql-config.yml`이 시험·생성물·빌드 결과를 뺀다. PR에서는 코드 스캐닝에 올리지 않고 받은 SARIF로 판정하고, `develop` 푸시와 예약 실행만 올린다. `security-events: write`는 이 잡에만 준다.
4. **판정은 저장소 도구 하나가 한다.** `tools/ci/scan-gate.mjs`가 gitleaks·CodeQL·Trivy의 SARIF를 읽어, 보안 등급(`security-severity`) 7.0 이상(높음·치명)과 프로토타입 오염 쿼리 셋(`js/prototype-polluting-assignment`·`js/prototype-pollution`·`js/prototype-pollution-utility`, 등급 6.1)은 막고 나머지는 알림만 남긴다. 그 셋이 돌았다는 흔적(규칙 목록)이 SARIF에 없거나, 결과 파일이 없거나 틀리면 막는다(닫힘 실패). 소스 안 억제 주석(SARIF `suppressions`)은 예외로 보지 않는다. 비밀 검사 결과는 등급과 상관없이 하나라도 있으면 막는다.
5. **고치지 못한 검사 결과의 예외는 파일 하나에 둔다.** `tools/ci` 아래의 `scan-exceptions.json`의 한 줄은 도구, 규칙 ID, 파일 경로, 사유, 이슈 번호, 만든 날, 만료일이고 만료일은 만든 날부터 30일 [가정]을 넘지 못한다. 만료되면 다시 막고, 쓰이지 않는 예외도 막는다. 의존성 취약점 예외는 그대로 `vuln-exceptions.json`이다(ADR-0259 결정 10). 비밀 검사의 오탐은 만료가 없는 탐지 규칙 조정이라 예외 파일이 아니라 각 도구 설정의 허용 목록에 둔다.
6. **Semgrep 몫은 둘로 대신한다.** 프로토타입 오염(ASVS 15.3.6)은 결정 4의 CodeQL 쿼리 셋(값이 흐르는 길을 따라가므로 꼴 비교보다 넓게 본다)과, `packages/config/eslint`에 직접 만든 규칙 `no-prototype-mutation`(`__proto__` 읽기·쓰기, `Object.setPrototypeOf`·`Reflect.setPrototypeOf`(두 번째 인자가 `null`인 것은 받는다), 내장 원형 고치기, 깊은 병합·경로 대입 함수 가져오기)이 맡는다. 같은 규칙을 화면(`peaket-web/`)과 서비스(`peaket-service/`) 이름 둘로 걸어 줄 안 주석 끄기 검사가 그대로 본다. 외부 JSON은 이미 있는 공용 안전 파서(`@peaket/validation`)가 맡는다. `sql.raw()`는 ESLint 규칙 `peaket-service/sql-raw-allowlist`가 맡는다: `drizzle-orm`에서 가져온 `sql`(이름을 바꿔 가져온 것 포함)의 `raw`에는 글자 그대로의 문자열이나 같은 파일의 그런 상수만 넘기고, 그 밖은 파일과 까닭을 적은 허용 목록(`packages/config/eslint/sql-raw-allowlist.json`)에 든 파일만 받는다. 이 규칙은 `packages/platform/src`도 보도록 린트 경로를 넓힌다.
7. **Trivy는 네트워크 없이 내장 검사 규칙으로만 돈다.** `docker run --network none`으로 다이제스트 고정 이미지를 띄우고 검사 규칙을 받지 않는다(`--skip-check-update`). 취약점 자료(DB)를 쓰지 않는 두 가지만 한다. ① IaC 설정 검사: `security-scan.yml`에서 `infra/`, `deploy/`(로컬 kind 전용 `deploy/local` 빼고), 운영 이미지의 Dockerfile(`services/`, `packages/platform/template`)을 보고 높음 이상은 막는다. 도구·부하 시험용 Dockerfile(`tools/`·`loadtest/`)은 운영으로 가지 않아 뺀다. ② 이미지 비밀 검사: `build-image.yml` 빌드 잡이 만든 OCI 묶음을 플랫폼마다 본다(잡 권한은 그대로 `contents: read`). 제3자 패키지의 예시 키 같은 오탐은 Trivy 비밀 규칙 설정(`tools/ci` 아래)의 허용 규칙에 까닭과 함께 둔다. 이미지 취약점 검사와 그 기한 판정은 게시 잡(BAS-020)과 승격 차단(BAS-140)의 몫이다.
8. **Scorecard는 주 1회 결과 파일만 남긴다.** 매주 월요일 09:00 KST와 수동 실행에서 돈다. `publish_results: false`이고 SARIF는 코드 스캐닝에 올리지 않고 잡 산출물로만 둔다. 잡 권한은 `contents: read`·`actions: read`이고 PR을 막지 않는다. 이 액션은 안에서 `ghcr.io/ossf/scorecard-action:v2.5.0`을 태그로 부른다(2026-11-10 다이제스트 `sha256:1e1481c65fc2407d3fd6ab18a23c741eb4d1c0d9359ebafc4b3ab13aa61d8627`). 액션 커밋을 고정해도 이 태그가 옮겨지면 다른 코드가 돈다. 남는 위험으로 적는다.
9. **이미지 안 소스 관리 폴더를 막는다(ASVS 13.4.1).** 빌드 잡의 스모크(`tools/ci/image-smoke.mjs`)가 이미지 안 전체에서 `.git`·`.svn`·`.hg`(폴더와 `.git` 파일)를 찾으면 실패한다. `/proc`·`/sys`·`/dev`는 보지 않고 심볼릭 링크는 따라가지 않는다.
10. **허용 목록을 저장소와 맞춘다(D-T12).** 워크플로 검사(`tools/ci/check-workflows.mjs`)가 GitHub 소유가 아닌 액션이 `infra/stacks/global/github/variables.tf`의 `actions_patterns_allowed`에 들었는지 본다(D-T12 ①). `ossf/scorecard-action@*`을 그 목록에 더하고, 조직에 적용(`terraform apply`)하는 것은 소유자 몫이다. 조직 정책이 태그 참조를 실제로 막는지는 소유자가 적용 뒤 한 번 본다(D-T12 ②).
11. **첫 결과는 CI가 낸다.** 이 PC에서 gitleaks·CodeQL을 못 돌리므로, 이 묶음은 `develop`에 푸시한 뒤 `security-scan` 결과를 기다려 나온 것을 분류(고치기, 오탐 허용, 30일 예외)하는 데까지 한다(ADR-0222의 'CI를 기다리지 않는다'의 예외).
12. **설계로 받아들인 결과는 ADR을 근거로 1년마다 다시 본다(리뷰 전 첫 검사에서 정함).** 로컬에서 미리 돌린 Trivy 설정 검사가 막은 두 건 가운데 GIT-0003(공개 저장소의 취약점 알림 꺼짐)은 `infra/stacks/global/github/repositories.tf`에서 저장소마다 따로 된 리소스 `github_repository_vulnerability_alerts`(`enabled = true`)로 켜고(지금 provider 6.13.0에서 저장소 리소스의 `vulnerability_alerts` 속성은 지울 예정이다. 적용은 소유자 몫이고, 조직 수준 설정이 있으면 적용이 실패할 수 있다), GIT-0001(공개 저장소)은 소유자가 정한 공개 모노레포(ADR-0169)라 고칠 것이 아니다. 30일 예외를 계속 갱신하는 대신 `scan-exceptions.json`에 이슈 번호 대신 `adr`과 다시 볼 날(`reviewOn`, 1년 [가정] 안)을 적은 '받아들인 결과' 줄을 둔다. 판정 도구가 ADR 파일이 있는지와 다시 볼 날을 본다. 받아들인 결과가 늘면 이 ADR을 다시 본다.
13. **리뷰 뒤 더한 규칙(2026-11-10).** 관점 리뷰(높음 둘: `ci.yml`이 부르는 잡 권한 밖의 `actions: read`로 CI가 시작하지 못함, 받아들인 결과 한 줄이 아무 도구·아무 ADR로 1년 동안 같은 파일의 결과를 모두 덮음)와 독립 틀린 구현 검사의 지적을 docs/devops.md §4.4 '리뷰 뒤 더한 규칙' ①~⑦로 정했다. 요지: Scorecard를 따로 된 워크플로로 떼고, 예외·받아들인 결과는 결과 수를 맞추며 받아들인 결과는 IaC 설정 검사와 그 규칙 ID를 적은 ADR에만, 도구가 실제로 보는지 미끼로 먼저 확인하고, 허용 목록·린트 규칙의 넓은 꼴과 우회 길을 막는다.
14. **첫 CI 결과의 분류(2026-11-10, 결정 11).** `develop` a8547992의 첫 실행에서 세 검사가 막았다. ① gitleaks는 갈래 1 측정 무대(PRF-215)의 오탐 4건이었고 갈래 1이 허용 블록으로 좁혔다(R-461). ② Trivy 이미지 비밀 검사는 BuildKit OCI 묶음 tar를 열지 못했다(`manifest.json`도 `index.json`도 없음). 묶음을 OCI 레이아웃 폴더로 푼 뒤 그 폴더를 검사하고, 미끼도 같은 모양으로 만든다. ③ CodeQL은 보안 등급 7.0 이상 23건을 냈다. 21건은 코드를 고쳤다: 이스케이프 빠짐, 태그·주석을 거르는 정규식, 개발용 서버의 경로·요청 대상·타이머, 느려질 수 있는 정규식, 치우친 난수, 사용자 값으로 고르는 메서드. 결제 시뮬레이터(`services/pg-simulator`)의 `js/missing-rate-limiting` 2건은 고칠 결함이 아니다. 운영에 배포하지 않는 시험용 서버이고(docs/security/asvs/verification-tools.md), 부하 시험·규칙 모델과 같은 까닭으로 CodeQL 범위(`tools/ci/codeql-config.yml`의 `paths-ignore`)에서 뺀다. 30일 예외로 두지 않은 까닭은 두 가지다. 예외 줄에는 이슈 번호가 필요하다. 그리고 공개 저장소에 이슈를 만드는 일은 공개 게시라 소유자 확인 없이 하지 않는다. 첫 결과를 막기 전에 미리 보지 못한 까닭: 이 PC에서 CodeQL을 돌리지 못하고, gitleaks는 rebase 전 HEAD로만 돌렸다. rebase 뒤에는 HEAD로 다시 돌린다.

## 검토한 다른 안

- **Semgrep을 다이제스트 고정 이미지로 받기**: 사용자 규칙을 꼴로 쉽게 쓴다. 소유자가 지금 받지 않기로 했고, 프로토타입 오염은 값의 흐름을 따라가는 CodeQL이 더 넓게 본다. `sql.raw()` 규칙은 가져온 이름과 인자 모양만 보면 되어 ESLint로 충분하다.
- **ESLint 기본 규칙(`no-proto`·`no-extend-native`)만 쓰기**: 새 코드가 들지 않지만, 줄 안 주석 끄기 검사(`peaket-web/`·`peaket-service/` 이름만 본다, ADR-0259 결정 12)가 이 규칙들을 보지 못한다. 그래서 같은 일을 하는 규칙을 우리 이름 아래 둔다.
- **PR에서 바뀐 커밋만 비밀 검사하기**: 빠르지만 기준 커밋 계산(새 가지, 0으로 채운 앞 커밋)에서 틀리기 쉽다. 이력이 짧은 지금은 전체를 본다.
- **CodeQL 결과를 PR마다 코드 스캐닝에 올리기**: PR 화면에 표시가 붙지만, 포크 PR의 읽기 전용 토큰에서 올리기가 실패할 수 있고 화면에서 '무시'한 경고가 저장소 밖 예외가 된다. 판정은 SARIF로 하고 올리기는 `develop`만 한다.
- **Trivy 액션(`trivy-action`)이나 `setup-trivy`**: 2026-03 태그 탈취 사고(CVE-2026-33634)가 있었다(devops §3.1). 다이제스트 고정 이미지를 직접 띄운다.
- **이미지 비밀 검사를 `security-scan.yml`에 두기**: 이미지는 빌드 잡에만 있다. 그 잡에서 같은 권한으로 본다.

## 결과

- PR마다 비밀 탐지·정적 분석·IaC 설정 검사가 돌고, 이미지가 바뀌면 이미지 비밀 검사와 소스 관리 폴더 검사가 돈다. CodeQL은 저장소 전체를 보므로 PR 시간이 10~20분 [추정] 늘 수 있다. 화면·서비스 코드가 바뀌지 않은 PR(문서만 등)은 CodeQL을 건너뛴다.
- 판정 규칙(무엇을 막는지)과 예외가 저장소 파일과 시험에 있어, 코드 스캐닝 화면 설정에 기대지 않는다.
- `sql.raw()`를 새로 쓰는 코드는 상수 글자이거나 허용 목록에 까닭을 적어야 한다. 지금 있는 동적 인자(`packages/platform`의 멱등 작업 목록·파티션 범위, purchase-svc의 결제 끌어오기 단계 목록)는 처음 허용 목록에 까닭과 함께 든다.
- 커밋 전 비밀 검사가 없어, 비밀은 푸시된 뒤에 CI가 찾는다. 공개 저장소라 그때는 이미 노출로 보고 바꾼다(RB-26).
- 남는 위험: Scorecard 액션 안의 태그 참조 이미지(결정 8). 0.76.1 뒤의 Trivy 보안 수정판 0.76.2(2026-11-05)는 2주 규칙으로 아직 쓰지 않는다. 이 쓰임(네트워크 없음, 우리 저장소 파일만 읽음)에서는 그 수정 대상(이미지의 libcurl·musl, HTML 해석)에 닿는 길이 좁다 [추정].

## 되돌릴 조건

- 소유자가 Semgrep을 받기로 하면 결정 6의 ESLint 규칙과 견줘 더 잡는 꼴만 Semgrep 규칙으로 옮긴다.
- 전체 이력 비밀 검사가 3분 [가정]을 넘으면 PR은 바뀐 커밋만 보고 예약 실행만 전체를 본다.
- CodeQL이 PR 시간을 20분 [가정] 넘게 늘리면 PR은 바뀐 패키지만 보는 설정(diff 기반)을 본다.
- 이 PC의 응용 프로그램 제어가 gitleaks를 허용하거나 GitHub 푸시 보호를 켜기로 하면 커밋 전 검사를 다시 본다.
