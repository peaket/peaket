# ADR-0191: 출처 증명이 빠진 판은 판 번호까지 콕 집어 예외로 받는다 — 지금은 semver 6.3.1 하나, SEED 둘은 스타일 부품을 붙일 때

- **상태**: 채택(2026-11-04, 소유자 결정 "추천대로 가겠습니다", OPEN[18]의 (가)). docs/devops.md §4.4 '신뢰 증거가 약해진 판을 만나면'의 "예외 목록(`trustPolicyExclude`)으로 풀지 않는다"를, 규칙의 앞 단계로 풀리지 않는 판에 한해 바꾼다. 규칙의 나머지(쓰는지 보기 → 압축 파일 차이 보기 → 범위 안의 앞 판 고정 → 부르는 쪽 앞선 판 → 소유자에게 묻기)는 그대로다.
- **관련**: [docs/devops.md](../devops.md) §4.4, [docs/design/d2-design-system.md](../design/d2-design-system.md) §1.1, [docs/frontend.md](../frontend.md) §5.14.5, ADR-0040(SEED를 디자인 토대로), ADR-0192(SEED React는 동작 부품으로), [docs/PROGRESS.md](../PROGRESS.md) OPEN[18], [docs/BUILD_ORDER.md](../BUILD_ORDER.md) BAS-180(wbs 0.6.2), `pnpm-workspace.yaml`, `tools/ci/check-trust-exceptions.mjs`
- **관련 ID**: ASVS v5.0.0-15.2.1(취약점 조치 기한), ASVS v5.0.0-15.2.4(의존성 출처), FE-T18, FE-T40

## 맥락

- 작업 공간은 pnpm 12의 `trustPolicy: no-downgrade`를 켜 두었다. 같은 패키지에서 앞서 나온 판보다 신뢰 증거(GitHub Actions 같은 CI의 신뢰 게시와 SLSA 출처 증명: 어느 저장소의 어느 커밋을 어느 CI가 빌드했는지 적은 증명서)가 약해진 판은 설치가 실패한다. 탈취된 계정으로 손으로 올린 판을 막으려는 장치다. npm 저장소 서명(올라온 파일이 그 파일이 맞다는 서명)은 모든 판에 붙으므로 이 검사와 상관없다.
- BAS-180을 처음 시도할 때(스타일 부품 `@seed-design/react` 3.1.0과 Storybook 10.6.5) 출처 증명이 없는 판 여섯이 걸렸다(npm 레지스트리 2026-11-04 확인).

| 패키지 | 막힌 판(게시) | 출처 증명 있는 앞 판(게시) | `@seed-design/react` 3.1.0을 붙일 때 앞 판 고정 |
| --- | --- | --- | --- |
| `@seed-design/react-menu` | 2.0.4(2026-10-07, `te6`) | 2.0.3(2026-10-01, GitHub Actions) | 된다: ^2.0.3 |
| `@seed-design/react-select` | 1.0.3(2026-10-07, `te6`) | 1.0.2(2026-10-01) | 된다: ^1.0.2 |
| `@seed-design/react-navigation-menu` | 2.0.3(2026-10-07, `te6`) | 2.0.2(2026-10-01) | 된다: ^2.0.2 |
| `@seed-design/react-dialog` | 2.0.3(2026-08-07, `te6`) | 2.0.2(2026-07-28) | 안 된다: `@seed-design/react` 3.0.0~3.1.1이 모두 ^2.0.3을 요구하고 뒤 판이 없다 |
| `@seed-design/react-dismissible-layer` | 1.0.2(2026-08-07, `te6`) | 1.0.1(2026-07-28) | 안 된다: react-dialog 2.0.3, 그리고 CI로 게시된 react-menu 2.0.3·react-select 1.0.2도 ^1.0.2를 요구한다 |
| `semver` | 6.3.1(2023-07-10, 출처 증명 없음) | 6.3.0(2019) | 안 된다: Storybook 10.6.5 → react-docgen 8 → @babel/core 7(7.29.7)이 ^6.3.1을 요구하고, 6.3.0에는 정규식 서비스 거부 결함 CVE-2022-25883이 있다 |

- semver 6.3.1이 '약해진 판'으로 걸리는 까닭은 pnpm이 주 판(6.x·7.x)을 가리지 않고 게시 시각으로 견주기 때문이다. 출처 증명이 있는 7.5.1(2023-05-12)이 먼저 나왔고, 6.3.1은 그 뒤 옛 6.x 줄에 위 결함 수정을 얹어 낸 판이다. semver 6은 Storybook(개발 도구) 작업 공간으로만 들어오고 화면 앱 의존성과 사용자에게 가는 묶음에는 들지 않는다.
- **세 판의 압축 파일을 풀어 앞 판과 견줬다(2026-11-04)**:
  - react-dialog 2.0.3 ↔ 2.0.2: `lib`·`src`가 같다. `package.json`의 판 번호와 의존성 범위 하나(`react-dismissible-layer` ^1.0.1 → ^1.0.2)만 다르다.
  - react-dismissible-layer 1.0.2 ↔ 1.0.1: `src/layer-stack.ts`의 한 줄이 다르다. `ctx.layers.at(-1)`을 `ctx.layers[ctx.layers.length - 1]`로 바꿨다(`Array.prototype.at`이 없는 Chrome 92·iOS Safari 15.4 아래 브라우저에서 오류가 나지 않게). 빌드 묶음은 그 한 줄을 반영해 다시 만들어졌다. 우리 지원 브라우저(iOS 16.4 이상 등, `packages/config/eslint/web-compat.mjs`)는 `at`을 모두 지원한다. 2026-10-31 비교 기록(devops §4.4)에는 이 한 줄이 빠져 있었다.
  - semver 6.3.1 ↔ 6.3.0: 위 결함을 고친 안전한 정규식(`safeRe`)만 더해졌다.
  - 세 판 모두 설치 스크립트가 없고, 네트워크 호출·`eval`·`new Function`·환경 변수 읽기·자식 프로세스 같은 수상한 호출이 없다.
- `te6`는 SEED 패키지의 관리자 목록(cometkim, te6, junghyeonsu, daangn-oss)에 있는 계정이다. SEED가 CI로 게시한 판(react-menu 2.0.3 등)이 손으로 올린 dismissible-layer 1.0.2를 요구하는 것도 이 판이 SEED 쪽의 정상 판이라는 정황이다.
- 소유자가 이 비교를 보고 (가)를 골랐다(이 판들을 판 번호까지 적어 예외로 받는다). 같은 날 BAS-180을 진행하며 ADR-0192로 `@peaket/ds`가 스타일 부품 대신 동작 부품 `@seed-design/react-dialog`만 직접 쓰기로 했다. 그러자 규칙의 '부르는 쪽의 앞선 판' 단계가 열렸다. ds가 부르는 쪽이 되어 react-dialog 2.0.2(출처 증명 있음)를 고를 수 있고, 2.0.2가 요구하는 `react-dismissible-layer` ^1.0.1 안에서 1.0.1(출처 증명 있음)로 고정할 수 있다.

## 결정

1. **지금의 예외는 하나이고, Storybook 작업 공간에만 둔다**: Storybook을 뿌리와 따로 둔 작업 공간 `tools/storybook`(자기 잠금 파일)에 두고, 그 `pnpm-workspace.yaml`의 `trustPolicyExclude`에 `semver@6.3.1`만 적는다. 뿌리 작업 공간에는 예외가 없다. 이름만 적거나 범위로 적지 않으므로 semver의 다른 판이나 새 판이 출처 증명 없이 오면 여전히 설치가 실패한다. 처음에는 Storybook을 `packages/ds`에 두었는데, Storybook이 들여온 `@babel/core` 7이 화면 앱의 `next → styled-jsx` 선택 의존성으로 이어져 semver 6.3.1이 앱 의존성 그래프에 섞였다(2026-11-04 새 맥락 리뷰). 그래서 떼어 냈다.
2. **SEED는 규칙대로 푼다**: `@peaket/ds`가 `@seed-design/react-dialog`를 2.0.2로 정확히 적어 직접 쓰고, `overrides`로 `@seed-design/react-dismissible-layer`를 1.0.1로 고정한다. SEED 예외는 두지 않는다.
3. **SEED 스타일 부품을 붙일 때(ADR-0192 결정 5)**: `@seed-design/react`를 붙이는 단계는 위 표대로 `react-menu`·`react-select`·`react-navigation-menu`를 `overrides`로 앞 판에 고정하고, `@seed-design/react-dialog@2.0.3`·`@seed-design/react-dismissible-layer@1.0.2`를 `trustPolicyExclude`에 판 번호까지 적는다. 소유자가 이 두 판을 2026-11-04에 이미 받아들였으므로 다시 묻지 않는다. 그 전에 SEED가 출처 증명 있는 뒤 판을 내면 예외 대신 그 판을 쓴다. 그 단계는 같은 판인지(압축 파일 해시) 다시 보고 devops §4.4 예외 표에 줄을 더한다.
4. **예외를 둘 수 있는 조건**(devops §4.4에 적는다): 규칙의 앞 단계(쓰는지 보기, 범위 안 앞 판, 부르는 쪽 앞선 판)로 풀리지 않을 때만, 두 판의 압축 파일 차이를 보고 수상한 것이 없다고 적은 뒤, 소유자 결정을 받아 판 번호까지 적는다. 예외마다 까닭과 지울 조건을 그 절의 표에 둔다. `tools/ci/check-trust-exceptions.mjs`가 막는다: 작업 공간 파일마다 `trustPolicy: no-downgrade`가 있어야 하고, 예외는 '이름@정확한 판'이어야 하며, devops §4.4 예외 표에 그 판이 있어야 한다.
5. **지울 조건**: semver 예외는 Storybook이 react-docgen을 거쳐 Babel 7을 부르지 않게 되면(Babel 8은 semver를 쓰지 않는다) 지운다. dismissible-layer 고정은 SEED가 출처 증명 있는 1.0.3 이상을 내면 풀고 올린다. 판을 올릴 때마다 표를 다시 본다.

## 결과

- BAS-180의 나머지(대화상자 속을 SEED 동작 부품으로, Storybook·`addon-a11y`, 이유 있는 비활성 버튼 시험, 첫 브라우저 확인)와 그 뒤 HOT-290~320·340·350·360이 풀린다.
- **남는 위험**: 예외로 받은 semver 6.3.1은 "어느 CI가 어느 커밋에서 빌드했는가"를 증명하지 못한다. 이 결정은 지금 받은 파일 내용을 사람이 읽고 받아들인 것이다. 잠금 파일의 무결성 값(해시)이 그 파일 내용을 고정하므로, 같은 판 번호로 다른 내용이 들어올 수는 없다. 개발 도구로만 들어와 화면 묶음에는 들지 않는다. 앞으로 같은 일이 생기면 그때마다 소유자가 정한다(결정 4).
- dismissible-layer 1.0.1은 1.0.2의 옛 브라우저 수정(`at` 빼기)이 없다. 우리 지원 브라우저는 `at`을 지원하므로 동작에 영향이 없다.
- 되돌릴 조건: 예외로 받은 판에서 악성 동작이 알려지면 Storybook을 빼고 react-docgen을 쓰지 않는 이야기 도구로 옮긴다(`@storybook/react-vite`는 문서 생성을 꺼도 react-docgen을 설치한다).
