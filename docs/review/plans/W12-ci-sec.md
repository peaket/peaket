# 작업 계획: W12-ci-sec(security-scan의 gitleaks·CodeQL 막음 고침)

- **무엇**: `develop` CI의 `security-scan`이 2026-11-20 20:31Z(BAT-087 합친 때)부터 매번 빨갛다(근거 실행 44900557822, 커밋 efbd61222). 비밀 탐지(gitleaks: 기록 전체에서 비밀처럼 보이는 글자를 찾는 도구)가 막음 7, 정적 분석(CodeQL: 코드를 돌리지 않고 값의 흐름을 따라가는 도구)이 높음 막음 5. gitleaks는 PR에서도 기록 전체를 보므로 모든 갈래의 초안 PR도 빨갛다. 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane4-sec`(가지 `feature/lane4-W12-ci-sec`, 출발점 `origin/develop` `de4d6a67`). 판정은 `tools/ci/scan-gate.mjs`, 설정은 `tools/ci/gitleaks.toml`·`gitleaks-ignore`·`scan-exceptions.json`·`codeql-config.yml`.
- **등급·차례**: 버그 고침이라 재현 시험부터 쓴다(§8.6의 5). 시험 먼저(계획 → 시험 → 구현 → 리뷰·검증), `Batch-Order` 꼬리말 없음. ADR·마이그레이션은 쓰지 않는다(갈래 4 몫 0341은 남긴다).
- **정본**: `docs/devops.md` §4.4 '외부 보안 검사 게이트'(오탐은 허용 목록, CodeQL 예외는 이슈·30일), `docs/infra.md` '로컬 데모의 비밀'(데모 비밀은 이 PC에서 만들어 Secret으로만), ADR-0263. 빈칸 둘을 이 계획 커밋에서 추천안으로 채웠다(아래 1의 6).

## 감독에게

1. **진짜 자격 증명은 없다.** 막음 12건 모두 손으로 보았다(아래 1). 그래서 멈추지 않고 계획을 끝냈다. 교체(폐기·재발급)할 것도 없다.
2. **문제 설명 바로잡기**: gitleaks 막음의 파일은 감독 메모와 조금 다르다. c0609b91 4건은 `apps/web/Dockerfile` 33·45줄, `deploy/envs/local/demo/web.yaml` 13줄, `tools/local/demo-objects.mjs` 95줄이다. 13fef82a 2건은 `apps/partner/Dockerfile` 22·33줄이다. 여섯 건 모두 **같은 값 하나**(Next 서버 액션 암호화 키로 쓰던 데모 상수)다. 94d5681a 1건은 `tools/local/demo.test.mjs` 420줄이다(근거: 그 실행 `secrets` 잡의 주석 7개).
3. **다른 갈래 영역과 겹침**: `apps/web/Dockerfile`(갈래 2가 `apps/web` 월렛을 하는 중. 이 묶음은 키 줄 둘만 지운다), `tools/web-checks/seats/server.mjs`(갈래 2 BAT-182 파일, 도우미 한 줄). 갈래 1 BAT-059(종료 세션·탈퇴, identity-svc)와는 `services/identity-svc/scripts/seed-demo.mjs` 변수 이름 하나만 같은 서비스다. 겹치면 합치기 순서만 정해 주면 된다.
4. **CodeQL 고침의 확인은 PR로 끝나지 않는다.** PR의 CodeQL은 바뀐 줄에 걸친 결과만 낸다(scan-gate 머리 주석). #32는 출발점(81줄)·도착점(75줄)을 고치지 않아 PR에서는 고쳤든 아니든 보이지 않는다. 그래서 (가) 가지를 올린 뒤 같은 가지로 수동 실행(`gh workflow run security-scan.yml --ref feature/lane4-W12-ci-sec`, 전체 분석, 코드 스캐닝에 올리지 않음)하거나 (나) 합친 뒤 `develop` 푸시 실행을 본다. 가지 올리기는 감독 몫이다(§8.6 '맡기기').
5. **다른 갈래 PR**: gitleaks는 PR의 트리에 있는 `gitleaks.toml`을 읽는다. 이 묶음이 `develop`에 들어간 뒤 각 갈래 가지가 `develop`을 받아야 그 PR의 `secrets` 잡이 초록이 된다.
6. **예외로 물러설 경우(OPEN 문안, 지금 만들지 않음)**: 전체 분석에서 #32~#35 가운데 코드 고침 뒤에도 남는 것이 있으면 묻는다. "OPEN[다음 번호] W12-ci-sec: CodeQL 오탐 <규칙>·<파일>이 코드 고침 뒤에도 남았다. (가) 도구가 알아보는 검사 꼴로 한 번 더 고친다(추천) (나) `scan-exceptions.json`에 30일 예외 줄과 GitHub 이슈(번호 필요, 만료 뒤 다시 막음)." 이슈는 이 묶음이 만들지 않는다.
7. **참고(결정 아님)**: CodeQL 판은 `codeql-action` 커밋 고정과 따로 오른다(아래 1의 7). 판 고정(`tools` 입력)은 다시 일어나면 ADR로 정할 거리다.

## 계획

### 1. 범위와 바른 동작

결과마다 분류는 셋 가운데 하나다: **진짜 결함**(코드가 실제로 위험), **오탐**(도구가 잘못 짚음. 가짜 값이거나 이미 막힌 흐름), **진짜 자격 증명**(실제 서비스에 쓰이는 비밀, 이번에는 없음).

1. **gitleaks jwt 1건(94d5681a, `tools/local/demo.test.mjs:420`) — 가짜 값 오탐.** V-T7 ⑥ 시험이 가림 함수(`redact`)에 넣는 JWT(서명된 토큰 문자열) 모양 입력이다. 머리는 HS256 한 줄, 본문은 숫자 `sub` 하나뿐이고 어느 무대의 키로 만든 토큰도 아니다. 지금 트리에도 471줄에 같은 값이 있다.
   - 바른 동작: 기록은 다시 쓰지 않는다. `gitleaks.toml`의 기존 '시험 코드의 가짜 값' 블록(규칙 `jwt` 포함, 시험 폴더·시험 파일 경로와 `AND`)의 `regexes`에 그 값 그대로의 꼴(`^…$`)을 하나 더한다. 꼴은 이 설정 파일이 스스로 걸리지 않게 파일 머리 규칙대로 일부 글자를 이스케이프한다. 앞으로는 시험이 JWT 모양 값을 실행 때 만든다(머리·본문 JSON을 그 자리에서 base64url로 바꾸고 서명 칸은 무작위 바이트). 그러면 새 시험 코드가 다시 걸리지 않는다.
2. **gitleaks generic-api-key 6건(c0609b91 4·13fef82a 2) — 가짜 값 오탐이지만 정본과 어긋난 꼴이라 고친다.** 값은 영어 문구를 base64로 쓴 32바이트 데모 상수다(`tools/local/demo-objects.mjs`의 `DEMO_SERVER_ACTIONS_KEY`). 로컬 kind 데모 이미지(`tools/local/demo-images.mjs`만 빌드, 운영 이미지 목록에 없음)와 데모 오버레이에만 쓰여 자격 증명이 아니다. 그러나 정본 `infra.md` '로컬 데모의 비밀'은 데모 비밀을 이 PC에서 만들어 Secret으로만 넣으라고 하고, 이 값은 이미지(Dockerfile `ENV`)와 값 파일에 박혀 있다. 값이 공개되었으므로 데모 밖에서 쓰면 안 된다.
   - 바른 동작(기록): `gitleaks.toml`에 새 허용 블록 하나. 까닭, `targetRules = ['generic-api-key']`, `condition = 'AND'`, 경로는 이력에 그 값이 있는 네 파일만(`apps/web/Dockerfile`·`apps/partner/Dockerfile`·`deploy/envs/local/demo/web.yaml`·`tools/local/demo-objects.mjs`, `^…$`로 묶음), 값 꼴은 그 값 그대로(끝의 `=` 하나는 있어도 없어도 되게 `\=?`). 경로만으로 푸는 블록·넓은 꼴·`gitleaks-ignore` 지문은 쓰지 않는다(지문 목록은 교체를 마친 실제 누출 전용).
   - 바른 동작(앞으로): 두 Dockerfile의 빌드·실행 단계에서 키 `ENV`를 지운다(빌드에는 키가 필요 없다: Next.js 16.4.6은 실행 때 받은 키가 빌드가 만든 키를 이긴다, `next/dist/server/app-render/encryption-utils.js` 78줄, 2026-11-21 확인. 키 확인은 `packages/config/next/server-actions-key.mjs`가 실행 때만 한다). `prepareDemoSecrets`가 비밀 파일에 `serverActionsKey`(무작위 32바이트 base64)를 만들고 예전 파일에는 채워 넣는다(기존 `pidHmacKey`와 같은 꼴). `demoSecrets`는 그 값으로 `demo-partner`와 새 `demo-web` Secret(네임스페이스 `web`)을 만들고, `web.yaml`은 키 줄을 지우고 `secretEnvFrom: demo-web`을 둔다. 상수 `DEMO_SERVER_ACTIONS_KEY`는 없앤다.
3. **CodeQL #36 `js/disabling-certificate-validation` `tools/local/demo-auth.mjs:266`(BAT-087 새 코드) — 진짜 결함.** `httpsJson`이 `rejectUnauthorized: false`로 인증서 확인을 끈다. 루프백(127.0.0.1) 데모 전용이라 실제 영향은 낮지만, 무대 계약 파일에 자체 서명 인증서(`caPem`, `cluster.mjs` 1384줄)가 이미 있어 끌 까닭이 없다.
   - 바른 동작: `httpsJson(o)`가 `o.ca`(PEM 글)를 받고, 없으면(`undefined`) 계약의 `caPem`을 쓴다. 그 인증서를 믿을 기준으로 삼아 인증서와 이름(`servername: o.host`)을 확인한다. 쓸 인증서가 없으면(빈 글 포함) 연결하지 않고 `caPem`을 말하는 오류로 거절한다(확인을 끄는 쪽으로 물러서지 않는다). `rejectUnauthorized: false`는 없앤다.
4. **CodeQL #35 `js/insufficient-password-hash` `services/identity-svc/src/modules/admin/adapters/local-pepper.ts:26` — 오탐(이름 짐작).** 출발점은 BAT-087이 더한 `services/identity-svc/scripts/seed-demo.mjs:65`의 변수 `passwords`(비밀번호가 아니라 해시 도구 객체)다. CodeQL은 이름에 password가 든 값을 비밀번호로 짐작해, 그 객체의 필드 `#context`(고정 글 `admin-pw-v1`)가 페퍼 HMAC으로 가는 것을 '약한 해시'로 짚었다. 실제 비밀번호는 PBKDF2 600,000회(`pbkdf2-admin-passwords.ts` 55줄) 뒤에만 HMAC에 들어간다.
   - 바른 동작: 그 변수 이름을 비밀번호가 아닌 이름(예 `hasher`)으로 바꾼다. 해시 꼴·반복 횟수·페퍼는 그대로, 소스 안 억제 주석은 쓰지 않는다.
5. **CodeQL #33·#34 `js/path-injection` `services/purchase-svc/src/modules/inventory/adapters/layout-seat-map.ts:33·44` — 오탐(검사를 못 봄).** 출발점은 회차 취소 내부 API 본문(`refund/inbound/event-refund.controller.ts` 102·115줄)이다. 본문의 `eventId`는 `z.uuid()`로 검사하고, 파일 출처(`FileSeatMapSource.load`·`stamp`)와 `LayoutSeatMap.#get`이 다시 `KEY_PART`(`^[A-Za-z0-9_-]{1,64}$`)로 막아 폴더 밖으로 나갈 수 없다(기존 시험 `[ASVS v5.0.0-1.2.4]`가 본다). CodeQL은 다른 모듈에서 가져온 정규식 검사를 막는 검사로 알아보지 못한다.
   - 바른 동작: `FileSeatMapSource`가 파일 경로를 한 도우미에서 만든다: `KEY_PART` 검사를 남기고, `resolve(dir, eventId + '.json')`의 `relative(resolve(dir), …)`가 `..`로 시작하지 않고 절대 경로가 아니며 하위 폴더가 아닐 때만 그 경로를 쓰고, 아니면 `undefined`(파일에 닿지 않음). 같은 꼴이 `tools/web-checks/seats/server.mjs`의 `within()`에 있다. 동작은 바뀌지 않는다.
6. **CodeQL #32 `js/resource-exhaustion` `tools/web-checks/seats/server.mjs:75`(BAT-182 새 코드) — 오탐(검사를 못 봄).** `/__seats/delta`의 `every`는 도우미 `int()`가 1~1,000ms로 묶는다. 그러나 `int()`가 검사한 식과 돌려주는 식이 서로 다른 `Number(v)` 호출이라 CodeQL이 상한을 보지 못한다. 시험 무대 서버(127.0.0.1 기본, 운영 미배포)다.
   - 바른 동작: `int()`가 `const n = Number(v)`를 한 번 만들어 그 `n`을 검사하고 그대로 돌려준다. 받는 범위는 그대로다.
7. **예전 코드 경보가 11-20에 새로 생긴 까닭**:
   - #33·#34: 코드 변화가 아니라 **CodeQL 판 변화**다. 13:07Z 분석(57de13831)은 CLI 2.27.4(질의 묶음 `codeql/javascript-queries` 2.5.0, 라이브러리 `codeql/javascript-all` 3.0.0)로 결과 2, 15:25Z 분석(a3e874700)은 2.27.5(2.5.1·3.0.1)로 결과 4였다. 그 사이 커밋은 a3e874700(문서·doc-check)뿐이다. `javascript-all` 3.0.1 변경 기록에 'Zod의 `parse`·`safeParse` 인자에서 결과로 흐름을 잇는다'가 있고, 두 경보의 흐름이 바로 `PreviewBody`·`StartBody.safeParse` → `parsed.data`를 지난다. 워크플로는 `codeql-action` v4.39.1에 고정했지만 `tools` 입력이 없어, 실행 기록대로 러너에 있던 2.27.4 대신 GitHub가 정한 기본 판 2.27.5 묶음을 받았다(작업 기록 'Using CodeQL CLI version 2.27.5').
   - #35: 판은 같고(2.27.5) **새 코드가 출발점**이 되었다. 20:36Z 분석(175e2d049, BAT-087 합친 뒤 첫 분석)에서 생겼고 출발점이 BAT-087의 새 파일 `seed-demo.mjs:65`다. 도착점(local-pepper.ts)은 11-05 코드 그대로다.
8. **정본 빈칸(이 계획 커밋에서 추천안으로 씀)**: `docs/devops.md` §4.4 '시험·데모 값의 꼴과 도구 판'(실행 때 만들기, 이미지·값 파일에 키 굽지 않기, CodeQL 판 변화와 PR 확인의 한계)과 `docs/infra.md` '로컬 데모의 비밀'에 서버 액션 키·데모 TLS 확인 방법 두 문장. 둘 다 '(추천 적용, 2026-11-21, W12-ci-sec)'.

### 2. 손댈 파일(구현 몫, 시험 파일 제외)

| 파일 | 할 일 | 영역 |
| --- | --- | --- |
| `tools/ci/gitleaks.toml` | 1의 1 값 꼴 하나 더함(기존 시험 블록), 1의 2 새 블록 | 갈래 4 |
| `apps/web/Dockerfile`, `apps/partner/Dockerfile` | 키 `ENV` 줄 지움, 주석 고침 | web은 갈래 2 영역 |
| `deploy/envs/local/demo/web.yaml`, `deploy/envs/local/demo/README.md` | 키 줄 지우고 `secretEnvFrom: demo-web`, 설명 고침 | 갈래 4(BAT-087) |
| `tools/local/demo-objects.mjs` | 상수 지움, `demo-partner`·`demo-web`이 `k.serverActionsKey` | 갈래 4 |
| `tools/local/demo-auth.mjs` | `prepareDemoSecrets`에 `serverActionsKey`·선택 인자 `secretsFile`(기본 `DEMO_SECRETS_FILE`), `httpsJson`의 `ca` 확인 | 갈래 4 |
| `services/identity-svc/scripts/seed-demo.mjs` | 변수 이름 하나 | 갈래 4(BAT-087) |
| `services/purchase-svc/src/modules/inventory/adapters/layout-seat-map.ts` | `FileSeatMapSource` 경로 도우미 | purchase-svc |
| `tools/web-checks/seats/server.mjs` | `int()` 한 줄 | 갈래 2 영역 |

- `scan-exceptions.json`·`gitleaks-ignore`·`codeql-config.yml`·`scan-gate.mjs`는 바꾸지 않는다. 구현 커밋은 시험 파일을 건드리지 않는다.

### 3. 시험 목록

- 시험 담당은 먼저 `peaket-test-antipatterns` 스킬을 읽는다. 시험 이름은 `W12S-0n ①` 꼴. ★는 지금 트리(`de4d6a67`)에서 실패해야 한다. 시험 파일 안에도 비밀처럼 보이는 글자를 두지 않는다(값은 실행 때 만든다. 데모 상수를 견줘야 하면 문구 조각을 이어 붙여 그 자리에서 base64로 바꾼다).
- Docker는 필요 없다. openssl은 `tools/local/cluster.test.mjs`처럼 PATH에서 찾되, 없으면 건너뛰지 말고 실패한다(CI 우분투·이 PC 모두 있다).

| 시험 | 파일 | 단언 | 지금 실패 까닭 |
| --- | --- | --- | --- |
| W12S-01 ★ | (CI) `security-scan / secrets` | 막음 0, 미끼는 찾음 | 실행 44900557822에서 막음 7(새 시험 코드 없음. '실패 확인'에 그 실행을 적는다) |
| W12S-02 ★ | `tools/local/demo-images.test.mjs` | `DEMO_IMAGES`의 모든 Dockerfile `ENV`·`ARG` 이름과 `DEMO_BUILD_ARGS` 이름 가운데 `_KEY`·`_SECRET`·`_TOKEN`·`PASSWORD`로 끝나는 것이 없다(줄 이음 `\` 포함해 읽는다) | web 2·partner 2 줄. 기존 DS-12는 `_KEY=`를 못 본다 |
| W12S-03 ★ | `tools/local/demo-objects.test.mjs` | ① `demoSecrets`의 `demo-partner`·`demo-web`(네임스페이스 `web`)의 `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`가 입력 `keys.serverActionsKey`와 같다 ② 모듈이 `DEMO_SERVER_ACTIONS_KEY`를 내놓지 않는다 ③ `deploy/envs/local/demo/*.yaml`의 `env`에 그 이름이 없고 web·partner 오버레이의 `secretEnvFrom`이 `demo-web`·`demo-partner` | 상수가 있고 `demo-web`이 없고 `web.yaml` env에 키가 있다 |
| W12S-04 ★ | `tools/local/demo-auth.test.mjs` | 임시 폴더의 `secretsFile`로 ① 새로 만들면 `serverActionsKey`가 `checkServerActionsKey`를 지난다 ② 두 번 새로 만들면 값이 다르다 ③ 그 값이 없는 예전 파일에는 채워 넣고 다른 값은 그대로, 다시 불러도 같다 | `serverActionsKey`·`secretsFile`이 없다 |
| W12S-05 | `tools/local/demo.test.mjs` | V-T7 ⑥의 JWT 모양 입력을 실행 때 만든다. 단언(가림 결과)은 그대로 | 시험 고침이라 실패 확인 대상 아님 |
| W12S-06 ★ | `tools/local/demo-auth.test.mjs` | `gatewayCertArgs`로 인증서 A·B를 만들고 127.0.0.1 HTTPS 서버를 띄워 ① 서버 A·`ca: A` → 응답 JSON을 받는다 ② 서버 B·`ca: A` → 거절, 서버 처리기 0번 ③ `ca: ''` → 연결 0번, `caPem`을 말하는 오류 | ②③: 지금은 확인을 꺼 받아들인다 |
| W12S-07 ★ | `tools/ci/scan-tools.test.mjs` | `readGitleaksConfig`로 읽어 데모 키 값을 푸는 블록이 있고, 그 블록은 `generic-api-key`만·`AND`·경로가 위 네 파일에만 맞는다(`apps/web/src/a.ts`·`services/x/Dockerfile`·`deploy/envs/prod/web.yaml`은 안 맞음). 설정 전체는 `gitleaksConfigProblems` 0 | 그 값을 푸는 블록이 없다 |
| W12S-08 ★ | (CI) CodeQL 전체 분석 | 막음 0(#32~#36이 없다) | 실행 44900557822에서 막음 5 |

- 회귀 막기(새로 쓰지 않음): `services/purchase-svc/test/seat-layout.test.ts`의 `[ASVS v5.0.0-1.2.4]`(KEY_PART가 아닌 회차 ID는 파일에 닿지 않음)와 파일 읽기 시험이 구현 뒤에도 통과해야 한다. #32·#35는 동작이 같아 단위 시험이 아니라 W12S-08로 본다.

### 4. 틀린 구현 표본(검증 담당용)

| # | 틀린 구현 | 잡을 것 |
| --- | --- | --- |
| M1 | 데모 키 값 꼴을 경로 없는 블록(규칙만)에 넣음 | W12S-07 |
| M2 | 경로만으로 푸는 블록이나 `.*` 같은 넓은 꼴 | 기존 scan-tools 시험, W12S-07 |
| M3 | 오탐인데 `gitleaks-ignore`에 지문(가짜 이슈 번호)으로 넣음 | W12S-07(블록 없음) |
| M4 | 키를 `ARG`·`--build-arg`로 빌드에 넘김(이미지 기록에 남음) | W12S-02 |
| M5 | `web.yaml` env에 키를 남기고 값만 바꿈 | W12S-03 ③ |
| M6 | 상수를 다른 파일·이름으로 옮김 | W12S-03 ①②, W12S-04 ② |
| M7 | `ca`를 주되 `rejectUnauthorized: false`도 남김 | W12S-06 ② |
| M8 | CA가 없으면 확인을 끄고 진행(e2e 파일들의 꼴) | W12S-06 ③ |
| M9 | 소스 안 억제 주석·코드 스캐닝 '무시'로 경보를 숨김 | W12S-08(scan-gate가 예외로 안 봄) |
| M10 | 시험 JWT를 다른 글자 그대로의 토큰으로 바꿈 | W12S-01(새 결과) |

### 5. 범위 밖

- 알림만인 결과(`tools/local/demo/runner.mjs:85` 등급 6.3, Trivy 설정 알림 둘), 예외 #11(2026-12-12 만료), CodeQL 판 고정, 기록 다시 쓰기·강제 푸시.
- `tools/local/demo/runner.mjs:202`의 `ignoreHTTPSErrors`와 `tools/local/e2e/*`의 'CA가 없으면 확인 끔' 꼴: CodeQL 대상 밖이고 이번 막음과 무관하다. 구간 끝 정리 목록 후보.

### 6. 게이트

- 로컬(모두 Docker 없음, 잠금 불필요):
  - `node --test tools/ci/scan-tools.test.mjs tools/ci/scan-gate.test.mjs tools/ci/security-scan-workflow.test.mjs`
  - `node --test tools/local/demo-auth.test.mjs tools/local/demo-objects.test.mjs tools/local/demo-images.test.mjs tools/local/demo.test.mjs tools/local/demo-seed.test.mjs`
  - `pnpm --filter @peaket/purchase-svc test test/seat-layout.test.ts`, `pnpm exec turbo run typecheck --filter=@peaket/purchase-svc`(turbo가 막히면 그 패키지 폴더에서 `tsc --noEmit`)
  - `pnpm lint`, `python tools/doc-check/check_all.py`(오류 0), `node tools/ci/roles-check.mjs`
- gitleaks는 로컬에서 돌리지 않는다: 고정 표(`scan-tools.mjs` `PINS`)가 리눅스 x64·arm64 묶음뿐이고 이 PC(win32)에는 gitleaks·CodeQL이 없다. 그래서 W12S-01은 **초안 PR CI의 `security-scan / secrets`**로 본다(PR도 기록 전체를 본다).
- CodeQL(W12S-08)은 PR에서 바뀐 줄의 결과만 나오므로, PR의 `security-scan / codeql` 막음 0은 필요조건일 뿐이다. 완료는 전체 분석(감독에게 4의 (가) 수동 실행이나 (나) 합친 뒤 `develop` 푸시)에서 막음 0이고, 판정 보고서 `codeql-gate`에 #32~#36 위치가 없을 때다.
- 선택(시험 담당 한 명만, Docker 잠금 `bash D:/ticketpass-locks/lock.sh take docker lane4-W12-ci-sec` … `drop docker lane4-W12-ci-sec`): `node tools/local/demo-images.mjs --build`로 web·partner 데모 이미지를 만들고, 무작위 키를 `-e`로 준 실행은 서버가 뜨고 키 없이 준 실행은 뜨지 않는지(`assertServerActionsKey`), `docker image inspect`·`docker history`에 키 이름의 값이 없는지 본다.

## 실패 확인

- 까닭: 버그 고침이라 고치기 전 트리(`4ece10e7` 위에 시험만 더함)에서 ★ 시험이 실패하는지 본다(§8.6의 5, ADR-0281). 계획 표 밖 세부 W12S-02 ②③·W12S-03 ④·W12S-06 ④는 같은 정본 문장(빌드 인자·RUN 안 값, 상수 값이 남지 않음, 이름 확인)에서 더했다.
- W12S-01·08: 실행 44900557822에서 막음 7·5.
- 명령: `node --test tools/ci/scan-tools.test.mjs tools/local/demo-auth.test.mjs tools/local/demo-objects.test.mjs tools/local/demo-images.test.mjs tools/local/demo.test.mjs` → 시험 96, 실패 14(모두 W12S ★ 세부), 기존 시험은 모두 통과.
- 실패 까닭: W12S-02 ①③ web·partner Dockerfile의 키 `ENV` 넷 / W12S-03 ① `demo-web` Secret 없음, ② `DEMO_SERVER_ACTIONS_KEY`를 내놓음, ③ `web.yaml` env에 키, ④ 상수 값이 네 파일에 남음 / W12S-04 ①~③ `secretsFile`을 받지 않아 임시 파일을 만들지 않음 / W12S-06 ②③④ 확인을 꺼 다른 인증서·빈 `ca`·다른 이름도 받아들임 / W12S-07 ①② 데모 키 값을 푸는 허용 블록 없음. 통과(★ 아님): W12S-02 ②(지금도 맞음, 표본으로 잡는 것은 봄)·W12S-05 ①(시험 고침)·W12S-06 ①(바른 요청).

## 구현 메모

- gitleaks jwt(1의 1): `tools/ci/gitleaks.toml` '시험 코드의 가짜 값' 블록에 그 JWT 그대로의 꼴(`.` 이스케이프) 하나와 까닭 한 구절을 더했다.
- gitleaks generic-api-key(1의 2): 같은 파일에 새 블록(`generic-api-key`만·`AND`·이력의 네 파일 경로·그 값 그대로 `\=?`). 두 Dockerfile의 키 `ENV` 넷을 지우고 주석을 고쳤다. `demo-auth.mjs` `prepareDemoSecrets`가 `secretsFile`을 받고 `serverActionsKey`(무작위 32바이트)를 만들거나 예전 파일에 채운다. `demo-objects.mjs`는 상수를 지우고 `demo-web`·`demo-partner`가 `k.serverActionsKey`를 싣는다. `web.yaml`은 키 줄을 지우고 `secretEnvFrom: demo-web`, 오버레이 README를 고쳤다.
- #36: `httpsJson`이 `o.ca`(없으면 계약 `caPem`)를 `ca`로 주고 `servername`으로 이름을 확인한다. 빈 값이면 연결 전에 `caPem`을 말하는 오류로 거절한다. `rejectUnauthorized: false`는 없앴다.
- #35: `seed-demo.mjs`의 `passwords`를 `hasher`로(두 줄). #33·#34: `FileSeatMapSource`의 경로를 `#fileOf`(KEY_PART → `resolve` → `relative`가 `..`로 시작·절대·하위 폴더면 `undefined`)에서만 만든다. #32: `int()`가 `n = Number(v)` 하나를 검사하고 돌려준다.
- 게이트(이 PC, Docker 없음): `node --test tools/ci/scan-tools.test.mjs tools/ci/scan-gate.test.mjs tools/ci/security-scan-workflow.test.mjs` 57/57. `node --test tools/local/demo-auth.test.mjs tools/local/demo-objects.test.mjs tools/local/demo-images.test.mjs tools/local/demo.test.mjs tools/local/demo-seed.test.mjs` 84/84(demo-seed의 DS-05/06은 identity-svc `dist`가 있어야 해서 turbo build를 먼저 돌렸다). `pnpm --filter @peaket/purchase-svc test test/seat-layout.test.ts` 103/103. turbo typecheck purchase-svc·identity-svc 통과. 바꾼 `.mjs`·`.ts` 다섯 ESLint 0. `tools/web-checks`는 설치가 없어 `node --check seats/server.mjs`만 통과. `python tools/doc-check/check_all.py` 오류 0.
- 남은 확인: W12S-01(PR `security-scan / secrets`)과 W12S-08(전체 분석, 감독에게 4)은 CI 몫이다.

## 시험 결과

구현 트리 `9e8b66aa`에서 돌렸다(먼저 `pnpm exec turbo run build --filter=@peaket/identity-svc...`).

- 재현 시험: `node --test --test-name-pattern=W12S tools/ci/scan-tools.test.mjs tools/local/demo-auth.test.mjs tools/local/demo-objects.test.mjs tools/local/demo-images.test.mjs tools/local/demo.test.mjs` → 시험 17, 실패 0
- `node --test tools/ci/scan-tools.test.mjs tools/ci/scan-gate.test.mjs tools/ci/security-scan-workflow.test.mjs` → 시험 57, 실패 0
- `node --test tools/local/demo-auth.test.mjs tools/local/demo-objects.test.mjs tools/local/demo-images.test.mjs tools/local/demo.test.mjs tools/local/demo-seed.test.mjs` → 시험 84, 실패 0
- `pnpm --filter @peaket/purchase-svc test test/seat-layout.test.ts` → 시험 103, 실패 0
- W12S-01·08은 CI 몫이다(PR `security-scan / secrets`, 전체 분석).

## 리뷰

- 본 범위: 출발점 `de4d6a67`부터 `568e1cc58`까지 네 커밋. `origin/develop..HEAD`(두 점)로 보면 가지를 딴 뒤 `develop`에 들어온 커밋(`ec2201730`·`5f5eb248a`, 에이전트 훅)이 거꾸로 섞여 보여서, 갈라진 점 기준(`origin/develop...HEAD`, 세 점)으로 보았다.
- **막는 지적(높음·보안·통과 기준)은 없다.** 대조한 것:
  1. 계획 항목: 1의 1~6은 모두 코드에 들어갔다. 1의 7은 계획의 설명이고, 1의 8은 계획 커밋이 정본 두 문장으로 넣었다. '손댈 파일' 표의 파일은 모두 고쳤고, 표 밖 파일(`scan-exceptions.json`·`gitleaks-ignore`·`codeql-config.yml`·`scan-gate.mjs` 포함)은 고치지 않았다.
  2. gitleaks 허용 블록: 새 블록은 `targetRules = ['generic-api-key']`, `condition = 'AND'`이고, 경로는 그 네 파일만 `^…$`로 묶었으며, 값 꼴은 그 값 그대로(`^…\=?$`)다. 경로만으로 푸는 블록, 통째 허용, 넓은 꼴, `gitleaks-ignore` 지문은 없다. 시험 JWT는 기존 '시험 코드의 가짜 값' 블록(시험 경로와 `AND`)에 그 값 그대로의 꼴 하나만 더했다. 두 꼴 모두 `\.`·`\=`로 이스케이프해서 설정 파일 자체가 다시 걸리지 않는다. 진짜 비밀이 이 블록을 지나려면 그 공개 값과 글자까지 같아야 하므로 지나갈 길이 없다.
  3. 데모 키는 Secret으로만 들어간다: 두 Dockerfile의 빌드·실행 단계에서 키 `ENV` 넷을 지웠고, `ARG`·빌드 인자로 옮기지 않았다. 키는 `demoSecrets`가 비밀 파일 값으로 만든 `demo-web`·`demo-partner` Secret으로만 들어간다. 부르는 쪽은 비밀 객체를 통째로 넘기고(`cluster.mjs` 1441줄), Secret은 `kubectl create -f -`의 표준 입력으로 넣으며, Helm 설치(1479줄)보다 먼저 만든다. `demo-auth prepare`의 출력에는 개수만 나온다. 그래서 키가 로그나 이미지 기록에 남는 길은 보이지 않는다.
  4. HTTPS 확인: `rejectUnauthorized: false`를 지우고 `ca`와 `servername`을 준다. 그래서 Node 기본값대로 인증서 확인과 이름 확인이 모두 켜진다. 믿을 인증서가 빈 글이면 연결하기 전에 거절한다. `httpsJson`을 부르는 곳은 모두 무대 계약의 `hosts`를 쓰고, 이 목록은 `caPem`을 만들 때 쓴 인증서 이름 목록과 같다(`cluster.mjs` `listenerCertificates`).
  5. CodeQL 고침: 억제 주석은 없다. `#fileOf`는 KEY_PART 검사를 통과한 값으로만 경로를 만들어서, 받아 주는 값이 예전과 같다. `int()`가 받는 범위도 그대로이고, `seed-demo.mjs`는 변수 이름만 바꿨다. #35의 경보 문구가 "Password from an access to passwords"(GitHub 경보 API, 2026-11-21 확인)라서, 바꾼 변수 이름이 실제 출발점이 맞다.
  6. 커밋 경계: 구현 커밋 `9e8b66aae`는 시험 파일을 건드리지 않았다. 시험 커밋 `879b8d21d`·`568e1cc58`은 시험 파일 다섯과 이 계획 파일만 바꿨다.
  7. 새 비밀: 이 가지가 더한 줄에서 긴 base64·JWT·PEM 모양을 찾으면, 나오는 것은 `gitleaks.toml`에 이스케이프해 넣은 꼴 둘뿐이다. 시험에 쓰는 키·토큰·인증서는 모두 실행할 때 만든다.
  8. 재현 시험을 이 트리에서 다시 돌렸다: `node --test --test-name-pattern=W12S tools/ci/scan-tools.test.mjs tools/local/demo-auth.test.mjs tools/local/demo-objects.test.mjs tools/local/demo-images.test.mjs tools/local/demo.test.mjs`를 돌려 17개 모두 통과했다.
- 지적: 모두 중간·낮음이다. 이 묶음에서는 고치지 않고 구간 끝 정리 목록으로 넘긴다(ADR-0331 결정 5).

| 번호 | 등급 | 자리 | 근거 | 고칠 방향 |
| --- | --- | --- | --- | --- |
| RV-01 | 중간 | `docs/infra.md` 577줄('로컬 데모의 비밀' 끝 문장), `tools/local/demo/runner.mjs:202` | 새 정본 문장은 '데모 도구의 HTTPS 요청'이 모두 `caPem`으로 인증서를 확인한다고 쓴다. 그런데 데모 재생기의 브라우저 창은 `ignoreHTTPSErrors: true`로 확인을 끈다(계획 §5가 범위 밖으로 뺀 곳). 정본 문장이 실제 코드보다 넓다 | 문장을 'Node 요청 도우미(`httpsJson`)의 HTTPS 요청'으로 좁히고 브라우저 창 예외를 적는다. 아니면 정리 때 브라우저 창도 그 인증서를 믿게 고친다 |
| RV-02 | 낮음 | `tools/local/demo-auth.mjs:262` | `httpsJson`이 요청할 때마다 계약 파일을 동기로 다시 읽는다. 부르는 쪽은 이미 `ctx.contract`·`state.contract`를 들고 있어서, 실행 중에 계약 파일이 다시 쓰이면 주소·포트와 믿을 인증서가 서로 다른 계약에서 온다 | 부르는 쪽이 `ca: contract.caPem`을 넘기거나, 한 번 읽은 값을 쓴다 |
| RV-03 | 낮음 | `tools/local/demo-objects.mjs:268·363·364` | `serverActionsKey`가 선택 값(`?`)이고 검사가 없다. 값이 빠지면 키 없는 Secret이 만들어지고, web·partner 파드가 뜰 때에야(`assertServerActionsKey`) 멈춘다. 이때도 서버가 뜨지 않는 쪽으로 막히므로 보안 문제는 아니다 | 타입을 필수로 바꾸고, `demoSecrets`가 빈 값을 받으면 그 자리에서 던진다 |
| RV-04 | 낮음 | `tools/local/demo-objects.test.mjs:350`(W12S-03 ④) | 예전 상수가 남았는지 `tools/local` 바로 아래의 `.mjs`만 보고, 하위 폴더 `tools/local/demo/`·`tools/local/e2e/`는 보지 않는다(지금 트리에는 남은 곳이 없다는 것을 grep으로 확인했다) | 하위 폴더까지 찾아 들어가며 본다 |

- 남은 확인(지적 아님): W12S-01(PR의 `security-scan / secrets`)과 W12S-08(CodeQL 전체 분석)은 CI 몫이다. #32·#33·#34 고침이 먹히는지는 CodeQL이 새 검사 꼴을 알아보는지에 달려 있어서, 이 PC에서는 확인할 수 없다. 고친 뒤에도 남으면 '감독에게' 6의 OPEN 문안대로 간다.

## 검증

- 바탕: 임시 사본(`568e1cc58`을 떼어 낸 작업 트리, 이 묶음 작업 폴더와 따로)에 틀린 구현을 하나씩 넣었다. 계획이 가리킨 시험을 돌린 뒤 고친 파일만 되돌렸다. Docker는 쓰지 않았다.
- 고치지 않은 사본에서는 일곱 파일이 모두 통과했다: scan-tools 25, scan-gate 25, security-scan-workflow 7, demo-auth 12, demo-objects 16, demo-images 14, demo 29.
- 결과: 넣은 10, 잡힌 9, 놓친 1.

| # | 넣은 틀린 구현 | 실패한 시험 |
| --- | --- | --- |
| M1 | 데모 키 블록에서 `condition`·`paths`를 지워 규칙과 값 꼴만 남김 | W12S-07 ① |
| M2 | 값 꼴을 32바이트 base64면 무엇이든 받게 넓힘(`^[A-Za-z0-9+/]{43}\=?$`) | W12S-07 ②. 기존 설정 검사(`gitleaksConfigProblems`)는 이 꼴을 못 잡는다. 계획 4의 '기존 scan-tools 시험'은 `.*` 같은 꼴에만 맞다 |
| M3 | 허용 블록을 지우고 `gitleaks-ignore`에 c0609b91·13fef82a 지문 6줄을 가짜 이슈 번호 주석과 함께 넣음 | W12S-07 ①② |
| M4 | web Dockerfile에 `ARG NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, `DEMO_BUILD_ARGS.web`에 그 키 | W12S-02 ①②, 기존 DS-01·V-T7 ④(demo-images), V-T7 ④(demo) |
| M5 | `web.yaml` env에 키를 다른 값으로 남김(`secretEnvFrom`은 그대로) | W12S-03 ③ |
| M6 | 상수를 `demo-auth.mjs`의 다른 이름으로 옮김(문구를 그 자리에서 base64로 만듦). 새 파일과 채워 넣기 모두 그 값을 씀 | W12S-04 ①②. 글자 그대로가 아니라서 W12S-03 ④는 지나갔다(예상대로) |
| M7 | `ca`와 함께 `rejectUnauthorized: false`를 남김 | W12S-06 ②④ |
| M8 | 믿을 인증서가 없거나 빈 글이면 확인을 끄고 진행 | W12S-06 ③ |
| X1(더함) | 이름 확인을 끔(`checkServerIdentity: () => undefined`) | W12S-06 ④ |
| X2(더함) | `ca`를 주지 않아도 계약의 `caPem`으로 물러서지 않음(`const ca = o.ca`) | **놓침**(일곱 파일 모두 통과) |

- M9·M10은 CI 몫이다.
  - 근거: 수동 전체 security-scan 실행 44910774428에서 codeql·secrets·dependencies·iac-config가 모두 success였다. PR #45의 security-scan 네 잡도 pass였다.
  - 결과: 이 둘로 W12S-01(비밀 탐지 막음 0)과 W12S-08(CodeQL 전체 분석 막음 0)이 판정됐다.
- 판정 기준 대조(계획 1):
  1. 1의 2 허용 블록: W12S-07 ①②가 문장의 조건을 모두 단언한다(generic-api-key만, AND, 네 파일 `^…$`, 그 값 그대로, 끝 `=` 있음·없음). 안 맞아야 할 경로 7개와, 무작위로 만든 값·한 글자 바꾼 값까지 본다. 맞다.
  2. 1의 2 앞으로: Dockerfile 키 지움, 무작위 32바이트, 예전 파일에 채워 넣기, `demo-web`·`demo-partner`, `secretEnvFrom`, 상수 없앰을 본다. W12S-02 ①②③, W12S-03 ①~④, W12S-04 ①~③의 단언이 문장과 맞다.
  3. 1의 3 #36: 인증서 확인(W12S-06 ②), 이름 확인(④), 빈 글이면 연결 0번에 `caPem` 오류(③), 바른 요청(①)은 맞다. 'undefined면 계약의 `caPem`'을 보는 시험은 없다(X2). 실제로 부르는 곳(`demoAuth`·`demo-seed`·데모 재생기·e2e)은 모두 `ca` 없이 부르는 길을 쓴다.
  4. 1의 1 시험 JWT: 기존 시험 블록에 값 꼴을 더했는지는 로컬 시험이 없고 W12S-01이 본다. W12S-05 ①은 가림 결과를 머리와 서명 칸 둘 다로 본다.
  - 이름만 달고 실제로 보지 않는 W12S 시험은 없었다. 시험마다 제 읽는 법부터 확인한다: 표본 검사(W12S-02 ①②③), 수 하한(W12S-02 ②), 연결 수 세기(W12S-06 ③).
- 어느 표본에도 실패하지 않은 것:
  - 파일: `tools/ci/scan-gate.test.mjs`, `tools/ci/security-scan-workflow.test.mjs`. 표본이 그 영역을 건드리지 않았다.
  - W12S 세부: 02 ③, 03 ①②④, 04 ③, 05 ①, 06 ①. 03 ①②는 `demoSecrets`가 상수를 쓰는 표본을 넣지 않아 이번 표본으로는 확인하지 못했다.
  - 돌리지 않은 것: `demo-seed.test.mjs`, purchase-svc `seat-layout.test.ts`. #32~#35는 동작이 같아 W12S-08로 본다.
- 구간 끝 정리 목록으로 보냄. 감독 결정: X2는 막히는 쪽으로 깨지므로 보안 영향이 없다. 시험에는 계약 파일 자리 인자가 필요해 이 묶음 밖이다.
  - X2: `ca`가 없을 때 계약의 `caPem`을 쓰는지, 계약에도 없으면 거절하는지 보는 시험.
  - 가벼운 빈틈 ①: 허용 블록과 `gitleaks-ignore` 지문을 함께 두면 잡지 않는다. 지금 시험은 블록이 없을 때만 간접으로 잡는다.
  - 가벼운 빈틈 ②: W12S-04 ③은 채워 넣은 값이 무작위인지 보지 않는다(M6에서 ③은 통과했다).

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | w12sec-plan-3b7d | claude-opus-5-5 | 2026-11-21T21:31+09:00 | 2026-11-21T21:58+09:00 |
| test | w12sec-test-5c1e | claude-opus-5-5 | 2026-11-21T22:00+09:00 | 2026-11-21T22:45+09:00 |
| impl | w12sec-impl-7a4f | claude-opus-5-5 | 2026-11-21T22:18+09:00 | 2026-11-21T22:41+09:00 |
| review | w12sec-review-9d2b | claude-opus-5-5 | 2026-11-21T22:50+09:00 | 2026-11-21T22:58+09:00 |
| verify | w12sec-verify-1e6c | claude-opus-5-5 | 2026-11-21T22:50+09:00 | 2026-11-21T23:07+09:00 |

## 기록

- R-733. develop 합치기 전 `origin/develop`(5f5eb248a) 위로 다시 쌓음(들어온 변경은 에이전트 훅뿐, 겹친 파일 없음). 다시 쌓은 트리에서 `node --test` scan-tools·scan-gate·demo-auth·demo-objects·demo-images 92/92, `roles-check` 통과(커밋 6).
- W12S-01·08: 수동 전체 security-scan 실행 44910774428(가지 568e1cc58) codeql·secrets·dependencies·iac-config 모두 success, PR #45 security-scan 네 잡 pass. PR CI의 다른 빨강(contracts·tools DS-12/V-T7 ⑦·web/seats·node konva 흔들림)은 develop 44897193480과 같은 실패다.
- 정리 목록: `docs/lanes/lane4-cleanup.md`(RV-01~04, X2, 대조 빈틈).
