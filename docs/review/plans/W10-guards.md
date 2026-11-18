# 작업 계획: W10-guards(기록 크기 점검과 Docker 호출 시간 제한)

- **무엇**: ADR-0283 결정 1(기록 상한)과 결정 4(Docker 호출에 시간 제한)를 코드로 지키게 하는 작은 묶음의 작업 목록이다. 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-w10`, 가지 `feature/lane1-W10-guards`, 출발점 `origin/develop` `55216411`. 구현 전 트리(분리 HEAD, 커밋하지 않음)는 `D:/ticketpass-w10-base`(`55216411`). 두 폴더 모두 `node_modules`가 없다. `tools/ci/*.mjs` 시험은 node 내장만 써서 `node --test tools/ci/<이름>.test.mjs`로 그대로 돈다. TypeScript 시험 도우미의 형 검사(typecheck)는 이 PC에서 돌리지 않고 CI에 맡긴다. Docker를 띄우는 시험은 이 묶음에서 돌리지 않는다. 2026-11-18 계획 담당 `w10-guards-plan-165e372c`(claude-opus-5-5)가 썼고, 시험·제품 코드는 쓰지 않았다.
- **묶음 ID**: 묶음 표에 없는 일이라 이 파일 이름 `W10-guards`를 쓴다(§8.6 '합치기 전 역할 확인'의 '묶음 가르기').
- **등급**: B(배포·운영 도구). 틀린 구현 표본은 아래 6이다.
- **차례**: 정방향 묶음이다(이 계획 커밋에 `Batch-Order: impl-first`). ADR-0283 결정 2의 짧은 고리를 처음 쓴다: 계획 → 구현 → 시험(구현 전 트리에서 실패 확인을 같은 커밋에) → 리뷰 → 리뷰 반영 시험(재현 시험과 실패 확인을 한 커밋) → 리뷰 반영 구현(고침과 시험 결과를 한 커밋) → 검증(고친 곳 확인 포함) → 기록. 리뷰 반영 계획 커밋은 따로 두지 않고(리뷰 절의 지적 목록이 고칠 목록), 다시 리뷰는 하지 않는다(보안 높음 지적만 리뷰 담당이 다시 본다). 목표 커밋 수는 8개 안팎이다.
- **정본**: [ADR-0283](../../adr/0283-cut-batch-overhead-keep-high-yield-checks.md) 결정 1·2·4(이 커밋에서 결정 1·4에 정한 값을 한 구절씩 적었다), docs/architecture.md §8.6 4 '묶음 절차'·'역할 나누기'·'자주 놓친 결함'.

## 계획

### 1. 범위

| # | 항목 | 정본 | 고칠 것 |
| --- | --- | --- | --- |
| G1 | 기록 크기 점검 | ADR-0283 결정 1 | `tools/ci/records.mjs`가 `docs/PROGRESS.md`와 `docs/lanes/lane1.md`·`lane2.md`·`lane3.md`의 크기를 본다. 상한을 넘으면 `--check`가 알리고 1로 끝난다 |
| G2 | Docker 호출 시간 제한 점검 | ADR-0283 결정 4 | 새 점검 `tools/ci/check-docker-timeouts.mjs`가 시험 파일의 Docker 호출마다 시간 제한이 있는지 보고, `tools-check` 잡이 돌린다 |
| G3 | 시험 도우미에 시간 제한 넣기 | ADR-0283 결정 4 | `apps/`·`services/`·`packages/`의 시험 파일 41개, Docker 호출 48곳에 `timeout: 300_000`을 넣는다(시험 파일이라 시험 담당 몫, §8.6 '바꾸는 파일') |

### 2. 바른 동작과 근거

**G1 기록 크기 점검(ADR-0283 결정 1)**

1. 보는 파일은 네 개뿐이다: `docs/PROGRESS.md`, `docs/lanes/lane1.md`, `docs/lanes/lane2.md`, `docs/lanes/lane3.md`. 정리 목록 파일(`docs/lanes/lane1-cleanup.md`~`lane3-cleanup.md`)과 `docs/progress-archive.md`는 보지 않는다(결정 1 '상한 없음').
2. 상한은 40,960바이트다(40×1,024, 이 커밋에서 결정 1에 적음). 크기는 파일 글의 줄 끝 CRLF를 LF로 바꾼 뒤의 UTF-8 바이트 수다(`.gitattributes`가 `eol=lf`라 저장소 글은 LF다. Windows 편집기가 CRLF로 저장해도 CI와 같은 값이 나오게). 글자 수가 아니라 바이트 수다(한글 한 글자는 3바이트).
3. 크기가 40,960을 **넘으면** 걸린다. 40,960 그대로는 통과다(결정 1 '넘기지 않는다').
4. `--check`: 걸린 파일마다 표준 출력에 한 줄을 찍고, 하나라도 걸리면 1로 끝난다. 기록 표(R 표·요약 §4·wbs 상태 칸)에 고칠 것이 있으면 그 줄들과 함께 찍는다. 파일은 고치지 않는다(지난 줄 옮기기는 사람이 고르는 일이라 스크립트가 하지 않는다). 기록 표도 맞고 크기도 맞으면 지금처럼 `기록 표가 맞다` 한 줄이고 0이다.
5. `--check` 없이(맞추기): 기록 표는 지금처럼 고쳐 쓴다. 걸린 파일은 표준 오류에 `경고: ` 줄로만 찍고 끝 코드는 지금과 같다(0). 갈래 1이 커밋 전에 돌리는 맞추기(`docs/PROGRESS.md` 턴 규칙)가 크기 때문에 멈추지 않게 하되 눈에는 보이게 한다.
6. 네 파일 가운데 없는 파일은 건너뛴다(표준 오류에 `경고: ` 한 줄, 끝 코드는 바꾸지 않는다). 하나가 없어도 나머지는 본다. 지금 시험(`tools/ci/records.test.mjs`의 `seedRepo`)은 이 파일들을 만들지 않으므로 없는 파일을 2로 끝내면 기존 시험이 깨진다. 읽을 수 없는 기록 표 파일(지금의 다섯)은 지금처럼 2다.
7. `--next-r`는 크기를 보지 않는다(지금처럼 다음 R 번호만 찍고 0).
8. 크기는 `--root` 아래 작업 트리의 파일로 잰다(`--rev`와 상관없다).

**G2 Docker 호출 시간 제한 점검(ADR-0283 결정 4)**

1. 보는 파일: `git ls-files`(git이 추적하는 파일, `--root` 저장소)로 `apps/`·`services/`·`packages/` 아래의 확장자 `.ts`·`.tsx`·`.mts`·`.cts`·`.js`·`.mjs`·`.cjs` 파일 가운데 시험 파일만. 시험 파일은 역할 확인(§8.6 '바꾸는 파일')과 같은 정의다: 파일 이름이 `*.test.*`·`*.spec.*`이거나 경로의 폴더 마디 하나가 정확히 `test`·`test-int`·`test-sim`·`__tests__`·`e2e`다(`test-intx`·`contest`·`testing` 같은 비슷한 이름은 아니다). 추적하지 않는 파일은 보지 않는다.
2. 찾는 호출: 호출 이름 `execFileSync`·`execFile`·`spawnSync`·`spawn`·`execSync`·`exec`(앞에 `child_process.`·`cp.` 같은 점 이름이 붙어도, `promisify(execFile)(…)`처럼 괄호로 싸여도) 뒤의 첫 인자가 글 조각(따옴표 `'`·`"`·역따옴표 `` ` ``)이고 그 글이 `docker`이거나 `docker `(빈칸 뒤 명령, `execSync('docker rm -f x')` 꼴)로 시작하는 것. `dockerd`·`docker-compose`·`kubectl`은 아니다. 주석 안의 글도 똑같이 본다(단순하게 둔다. 걸리면 주석 글을 바꾼다).
3. 호출 하나의 범위는 이름 뒤 여는 괄호부터 짝이 맞는 닫는 괄호까지다(여러 줄이어도). 괄호를 셀 때 글 조각(`'…'`·`"…"`·`` `…` ``) 안의 괄호는 세지 않는다.
4. 그 범위 안에 `timeout` 키가 정수 숫자로 바로 적혀 있어야 통과다: `timeout:` 뒤(빈칸 허용)에 숫자와 `_`만으로 된 글(예 `300_000`, `300000`, `30_000`)이 오고, 그 뒤(빈칸 허용)가 `,`나 `}`다. 값은 `_`를 뗀 정수로 1 이상 300,000 이하(이 커밋에서 결정 4에 적음). 다음은 모두 실패다: `timeout` 없음, 줄인 꼴(`{ timeout }`), 변수(`timeout: T`), 식(`timeout: 5 * 60_000`), 지수(`3e5`), 0, 300,001 이상.
5. 300,000ms(5분)를 고른 까닭: 지금 시험 설정의 준비 단계 시간 한도(vitest `hookTimeout`)는 통합 120초, `services/bundle`과 시뮬레이션(`vitest.sim.config.mjs`) 300초가 가장 길다. 이미지를 처음 받는 `docker run`(PostgreSQL·Kafka)도 정상 엔진에서는 그 준비 한도 안에 끝나야 하므로, 한 호출에 300초를 주면 지금 통과하는 실행을 새로 막지 않으면서 엔진이 멈췄을 때는 몇 시간이 아니라 5분 안에 실패한다. 호출마다 값을 나누지(`run`은 길게, `port`·`rm`은 짧게) 않는 것은 묶음을 작게 두고 점검을 단순하게 하려는 것이다. 더 짧은 값(예 `docker exec`에 30초)은 써도 된다.
6. 출력과 끝 코드:
   - 문제마다 한 줄 `막음: <경로>:<줄> <까닭>`. 경로는 저장소 뿌리에서 `/`로 쓴 상대 경로, 줄은 호출 이름이 있는 줄(1부터). GitHub Actions(환경 변수 `GITHUB_ACTIONS=true`)에서는 `막음: ` 대신 `::error::`로 시작한다(`check-lint-disables.mjs`와 같다). 까닭 글은 셋 가운데 하나이고 모두 `timeout`이라는 낱말을 담는다: 없음, 정수 숫자가 아님, 1~300000 밖(값을 적는다).
   - 문제를 모두 찍는다(첫 문제에서 멈추지 않는다).
   - 마지막 줄: 통과면 `통과: 시험 파일 <N>개, Docker 호출 <M>곳`, 문제가 있으면 `막음: 시험 파일 <N>개, Docker 호출 <M>곳, 문제 <K>건`. N은 본 시험 파일 수, M은 찾은 Docker 호출 수(통과·실패 모두).
   - 범위 안에서 Docker 호출을 하나도 찾지 못하면 `막음: Docker 호출을 찾지 못했다(검사 범위를 확인한다)`를 찍고 1로 끝난다(빈 결과가 '통과'로 새지 않게, §8.6 '자주 놓친 결함').
   - 끝 코드: 0 통과, 1 문제 있음(또는 호출 0곳), 2 인자 오류·git 오류(`--root`가 git 저장소가 아님 등). 2일 때는 표준 오류에 까닭을 찍는다.
7. CI: `.github/workflows/tools-check.yml`의 `node tools/ci/check-kafka-settings.mjs` 바로 뒤에 `- run: node tools/ci/check-docker-timeouts.mjs` 한 줄(주석 한 줄 포함). `ci.yml`은 고치지 않는다. `ci.yml`의 `tools-check` 잡은 바뀐 범위에 `tools`·`ci`·`infra`·`js`가 있으면 돌고, `js`는 `apps/`·`services/`·`packages/` 아래가 바뀌면 켜지므로(`tools/ci/changes.mjs`) 시험 도우미를 베껴 온 새 서비스도 이 잡이 본다. 이 점검은 node 내장만 써서 `lint-guard`처럼 따로 잡을 둘 까닭이 없고, 정적 검사 `check-kafka-settings.mjs`(D-T45)가 같은 잡에서 같은 꼴로 돈다. 새 잡을 만들지 않으므로 `ci-summary`의 `needs`도 그대로다.

**G3 시험 도우미에 시간 제한(ADR-0283 결정 4)**

- 시험 담당이 아래 3의 '시험 담당이 고칠 시험 도우미' 파일의 Docker 호출마다 `timeout: 300_000`을 옵션 객체에 넣는다(이미 더 짧은 정수 값이 있으면 그대로 둔다). 옵션 객체가 없는 호출(`execFile('docker', args, () => res())`)은 `execFile('docker', args, { timeout: 300_000 }, () => res())`처럼 옵션을 더한다. 다른 동작(인자, `stdio`, `encoding`, 오류 처리)은 바꾸지 않는다.
- TypeScript 파일은 `ExecFileSyncOptions`·`ExecFileOptions`에 있는 `timeout`만 쓴다(형 검사는 CI가 본다). 시간 제한에 걸리면 node가 자식 프로세스를 끝내고 오류(`ETIMEDOUT`)를 던지므로, 감싼 `try`가 있는 정리 호출(`rm -f -v`)은 지금처럼 오류를 삼킨다.

### 3. 손댈 파일과 공개 인터페이스

**구현 담당(시험 파일은 건드리지 않는다)**

| 파일 | 할 일 |
| --- | --- |
| `tools/ci/records.mjs` | 위 2의 G1. 머리 주석의 쓰는 법·끝 코드 설명에 크기 점검을 더한다. 명령줄 인자는 그대로(`--check`·`--next-r`·`--rev`·`--root`) |
| `tools/ci/check-docker-timeouts.mjs`(새 파일) | 위 2의 G2. 명령줄 `node tools/ci/check-docker-timeouts.mjs [--root <저장소>]`. `--root` 기본값은 이 파일 기준 저장소 뿌리(`check-lint-disables.mjs`와 같은 법). 모르는 인자는 2 |
| `.github/workflows/tools-check.yml` | 위 2의 G2 7의 한 줄과 주석 |
| `tools/ci/README.md` | 스크립트 표에 `check-docker-timeouts.mjs` 행(무엇·근거 ADR-0283 결정 4·돌리는 곳 `tools-check.yml`)을 더하고, `records.mjs` 행에 크기 점검 한 구절 |

- 내보내는 것(시험이 써도 되는 공개 인터페이스, 이름 그대로): `check-docker-timeouts.mjs`는 `export const MAX_TIMEOUT_MS = 300_000`, `export function inScope(path)`(저장소 상대 경로 `/` 꼴 → 보는 파일이면 `true`), `export function dockerCalls(text)`(파일 글 → 호출마다 `{ line, ok, reason }` 배열, `ok`가 `true`면 `reason`은 `null`). `records.mjs`는 새로 내보내지 않아도 된다(시험은 명령줄로 본다).
- 구현 커밋 시점에는 실제 저장소에서 `node tools/ci/check-docker-timeouts.mjs`가 48곳을 모두 막아 1로 끝나는 것이 맞다(도우미의 시간 제한은 시험 담당이 넣는다). 구현 담당은 이 결과(문제 48건 안팎)를 커밋 본문에 적고, 기존 `node --test tools/ci/records.test.mjs`가 모두 통과하는지 본다.

**시험 담당(시험 파일과 이 계획 파일만)**

| 파일 | 할 일 |
| --- | --- |
| `tools/ci/records.test.mjs` | 아래 4의 RS 시험을 더한다 |
| `tools/ci/check-docker-timeouts.test.mjs`(새 파일) | 아래 4의 DT 시험 |
| 아래 목록의 시험 도우미 41개 | 위 2의 G3 |

시험 담당이 고칠 시험 도우미(2026-11-18 `55216411` 기준, 파일 41개·호출 48곳. 괄호 안은 호출 줄):

- `apps/web/test-int/`: `cache-cluster.int.test.mjs`(23), `cache-handler.int.test.mjs`(21), `cache-keys-case.heavy.test.mjs`(43), `cache-keys.heavy.test.mjs`(27), `start-cache.heavy.test.mjs`(33)
- `packages/platform/test-int/`: `containers.ts`(14, 150, 165), `postgres.ts`(18)
- `services/admission-ctrl/test-int/`: `kms-seed.int.test.ts`(13), `valkey.ts`(6)
- `services/bundle/test-int/support.ts`(15)
- `services/core-svc/test-int/`: `kafka.ts`(12, 123), `local-partner-stack.int.test.ts`(57), `postgres.ts`(18), `search-standby.int.test.ts`(17)
- `services/identity-svc/test-int/`: `admin-password.int.test.ts`(17), `admin-totp.int.test.ts`(18), `investigation.int.test.ts`(24), `kms-failover.int.test.ts`(14), `kms-hashers.int.test.ts`(11), `postgres.ts`(18), `valkey.ts`(6)
- `services/invariant-checker/test-int/postgres.ts`(10)
- `services/ops-svc/test-int/postgres.ts`(18)
- `services/payment-svc/test-int/`: `kafka.ts`(10), `postgres.ts`(18)
- `services/purchase-svc/test-int/`: `kafka.ts`(11, 122), `postgres.ts`(18), `valkey.ts`(8)
- `services/queue-svc/test-int/`: `kafka.ts`(11, 122), `kms-seed-sealer.int.test.ts`(11), `valkey.ts`(6)
- `services/queue-svc/test-sim/`: `cluster.ts`(7, 86), `nginx-expiry.sim.test.ts`(18), `reflect.sim.test.ts`(38)
- `services/ticket-svc/test-int/`: `postgres.ts`(14), `valkey.ts`(6)
- `services/trust-svc/test-int/`: `device-key.int.test.ts`(17), `kafka.ts`(11, 122), `valkey.ts`(5)
- `services/v0-monolith/test-int/`: `postgres.ts`(18), `valkey.ts`(8)

목록은 구현된 점검(`node tools/ci/check-docker-timeouts.mjs`)의 출력으로 다시 확인한다. 목록에 없는 곳이 나오면 그것도 고치고 '시험 결과'에 적는다.

### 4. 시험 목록

- 이름은 ID로 시작한다(`RS-NN`은 G1, `DT-NN`은 G2·G3). 단언 값(40,960, 300,000, 네 파일 경로)은 정본(ADR-0283 결정 1·4)에서 숫자로 적고 코드의 상수를 가져오지 않는다.
- RS 시험은 지금 `records.test.mjs`의 `seedRepo()`·`cli()`를 쓴다. 기록 표가 걸리지 않게 먼저 `cli(dir)`로 맞춘 뒤(또는 그 결과를 알고) 크기 파일을 써서 `--check`를 돌린다. 크기 파일은 원하는 바이트 수를 정확히 맞춰 쓴다(예 `'가'`(3바이트)와 `'a'`로 채움).
- DT 시험은 임시 폴더에 `git init`하고 파일을 쓴 뒤 `git add`하여(점검이 `git ls-files`를 본다) `--root`로 돌린다. 1을 기대하는 시험은 끝 코드만 보지 말고 `막음: <경로>:<줄>` 줄까지 본다(스크립트가 없을 때 node도 1로 끝나므로).

| 시험 | 사건 | 단언 |
| --- | --- | --- |
| RS-01 ① 상한 그대로는 통과 | 기록 표를 맞춘 seedRepo에 `docs/PROGRESS.md`를 정확히 40,960바이트(LF, 한글 섞음)로 쓰고 `--check` | 0, 표준 출력에 `docs/PROGRESS.md` 없음 |
| RS-02 ① 상한을 1바이트 넘으면 막는다 | 같은 곳에 40,961바이트 | 1, 표준 출력 한 줄에 `docs/PROGRESS.md`와 `40961`, PROGRESS 글이 그대로(고치지 않음) |
| RS-03 ① 갈래 파일 셋도 본다 | `docs/lanes/lane1.md`·`lane2.md`·`lane3.md`를 하나씩만 40,961바이트로(사례 셋, 나머지 파일은 작게 있음) | 사례마다 1, 그 파일 경로가 든 줄이 있고 다른 셋의 경로는 없음 |
| RS-04 ① 정리 목록과 보관 파일은 보지 않는다 | `docs/lanes/lane1-cleanup.md`·`lane2-cleanup.md`·`lane3-cleanup.md`·`docs/progress-archive.md`를 각각 100,000바이트, 네 기록 파일은 작게 | 0, 표준 출력에 `cleanup`·`progress-archive` 없음 |
| RS-05 ② 글자 수가 아니라 바이트 수다 | PROGRESS를 `'가'` 13,654자(40,962바이트, 글자 수는 상한 아래)로 | 1, `docs/PROGRESS.md`·`40962` 줄 |
| RS-06 ② CRLF는 LF로 바꿔 잰다 | PROGRESS를 LF로 세면 40,960바이트인 글을 CRLF로 저장(파일 바이트는 상한보다 큼) / LF로 세면 40,961인 글을 CRLF로 | 앞은 0, 뒤는 1이고 줄에 `40961` |
| RS-07 ④ 기록 표와 크기 둘 다 걸리면 둘 다 찍는다 | 맞추지 않은 seedRepo(R-265가 표에 없음)에 PROGRESS 40,961바이트, `--check` | 1, 표준 출력에 `R-265` 줄과 `docs/PROGRESS.md` 줄이 모두, 파일은 그대로 |
| RS-08 ④ 걸린 파일을 모두 찍는다 | PROGRESS·lane2 둘 다 40,961바이트 | 1, 두 경로가 각각 다른 줄에 |
| RS-09 ⑤ 맞추기는 크기로 멈추지 않는다 | 맞추지 않은 seedRepo에 PROGRESS 40,961바이트, 인자 없이 | 0, 기록 표가 맞춰짐(consistency-review에 R-265 행), 표준 오류에 `경고:`와 `docs/PROGRESS.md`, PROGRESS 글이 그대로 |
| RS-10 ⑥ 없는 크기 파일은 건너뛰고 나머지는 본다 | 맞춘 seedRepo에 lane2만 없음·lane1 40,961바이트 / 네 파일 모두 없음 | 앞은 1과 `docs/lanes/lane1.md` 줄, 뒤는 0 |
| RS-11 ⑦ `--next-r`는 크기를 보지 않는다 | PROGRESS 40,961바이트에서 `--next-r` | 0, 표준 출력이 `R-266` 한 줄 |
| DT-01 ① 시간 제한이 있으면 통과 | `services/a/test-int/pg.ts`에 `execFileSync('docker', args, { encoding: 'utf8', timeout: 300_000 })` | 0, 마지막 줄 `통과: 시험 파일 1개, Docker 호출 1곳` |
| DT-02 ① 시간 제한이 없으면 그 줄을 막는다 | 같은 파일 3째 줄에 `timeout` 없는 호출 | 1, `막음: services/a/test-int/pg.ts:3 ` 로 시작하고 `timeout`이 든 줄, 마지막 줄에 `문제 1건` |
| DT-03 ② 호출 꼴마다 찾는다 | `timeout` 없는 호출을 사례마다: `execFile`, `spawnSync`, `spawn`, `execSync('docker rm -f x')`, `exec("docker ps")`, `` execFileSync(`docker`, …) ``, `promisify(execFile)('docker', […], { encoding: 'utf8' })`, `child_process.execFileSync('docker', …)`, 여는 괄호 뒤 줄바꿈 | 사례마다 1과 그 파일:줄 |
| DT-04 ③ 여러 줄 호출과 글 속 괄호 | 옵션이 셋째 줄에 있는 여러 줄 호출(`timeout` 있음 / 없음) / 인자에 `')'`·`'({'`가 든 글이 있고 그 뒤 옵션에 `timeout: 300_000` / 같은 꼴에 `timeout` 없음 | 있음은 0, 없음은 1이고 줄은 호출 이름이 있는 첫 줄 |
| DT-05 ④ 값의 경계 | `timeout: 300_000` / `300000` / `1` / `30_000` 은 통과, `300_001` / `0` / `T`(변수) / `{ timeout }` / `5 * 60_000` / `3e5` 는 막음(사례마다) | 통과 사례 0, 막음 사례 1과 그 파일:줄(값이 숫자면 줄에 그 값) |
| DT-06 ① 문제를 모두 찍는다 | 두 파일에 막을 호출 셋(한 파일에 둘) | 1, `막음: <경로>:<줄>` 줄 셋, 마지막 줄 `문제 3건` |
| DT-07 ⑤ 보는 곳 | `timeout` 없는 호출을 사례마다 `apps/w/test-int/a.mjs`, `packages/p/test-int/b.ts`, `services/s/test-sim/c.ts`, `services/s/test/d.ts`, `services/s/src/e.int.test.ts`, `services/s/src/f.spec.ts`, `services/s/__tests__/g.ts`, `apps/w/e2e/h.ts`에 (각각 0곳 막음 방지를 위해 통과 호출 하나를 `services/ok/test-int/ok.ts`에 함께 둠) | 사례마다 1과 그 경로 |
| DT-08 ⑤ 보지 않는 곳 | 통과 호출 하나(`services/ok/test-int/ok.ts`)와 함께 `timeout` 없는 호출을 `services/s/src/x.ts`, `services/contest/a.ts`, `services/s/test-intx/a.ts`, `services/s/testing/a.ts`, `loadtest/test/a.test.mjs`, `tools/local/cluster.mjs`, `deploy/a.test.mjs`에 / `git add` 하지 않은 `services/s/test-int/new.ts` / 확장자 `.md`의 `services/s/test-int/README.md` | 0, 그 경로가 출력에 없음, 마지막 줄 `Docker 호출 1곳` |
| DT-09 ② Docker가 아닌 명령은 보지 않는다 | 통과 호출 하나와 함께 `execFileSync('kubectl', …)`, `execFileSync('dockerd', …)`, `execFileSync('docker-compose', …)`, `execFileSync('node', ['docker'])`(모두 `timeout` 없음) | 0, `Docker 호출 1곳` |
| DT-10 ⑥ 호출이 하나도 없으면 막는다 | 범위 안 시험 파일은 있으나 Docker 호출 없음 / 범위 안 파일 없음 | 둘 다 1, `Docker 호출을 찾지 못했다` |
| DT-11 ⑥ GitHub Actions 표시 | DT-02 사건을 `GITHUB_ACTIONS=true`로 | 1, 문제 줄이 `::error::services/a/test-int/pg.ts:3 `로 시작 |
| DT-12 ⑥ 인자와 저장소 오류는 2 | `--root`가 git 저장소가 아닌 빈 폴더 / 모르는 인자 `--bogus` | 둘 다 2 |
| DT-13 ⑦ 실제 저장소의 시험 도우미가 모두 통과한다 | 저장소 뿌리에서 인자 없이 `node tools/ci/check-docker-timeouts.mjs` | 0, 마지막 줄 `통과: 시험 파일 <N>개, Docker 호출 <M>곳`에서 M ≥ 48(2026-11-18 지금 수. 도우미를 지워 줄면 시험을 고친다) |
| DT-14 ⑦ CI가 돌린다 | `.github/workflows/tools-check.yml`을 글로 읽음 | `node tools/ci/check-docker-timeouts.mjs`를 돌리는 `run` 줄이 있다(주석 줄이 아님) |

- 시험 수: RS 11개, DT 14개, 모두 25개. 사례를 여럿 둔 시험은 사례마다 `test`를 나누어도 되고(이름은 같은 ID로 시작) 한 시험에 묶어도 된다.
- DT-03·DT-05·DT-07처럼 시험 안에서 `dockerCalls`·`inScope`를 바로 불러도 되지만, 하나 이상은 명령줄로 본다(부르는 쪽이 결과를 실제로 쓰는지, §8.6 '자주 놓친 결함').

### 5. 구현 전 트리에서 실패를 볼 수 없는 시험과 그 까닭

- **DT-01~DT-14 전부(구현 전 트리 `D:/ticketpass-w10-base`에서)**: 점검 스크립트가 없어 실행조차 안 되는 실패라 세지 않는다(§8.6 7 '바탕이 없어 실행조차 안 되는 실패'). 그래서:
  - **DT-13은 구현 커밋 트리에서 도우미를 고치기 전에 돌려 실패를 본다**: 점검이 있고 도우미에 시간 제한이 없으므로 1과 문제 48건 안팎이 나와야 한다. 이것이 G3의 실패 확인이다. 시험 담당은 이 결과(명령·문제 수)를 '실패 확인'에 적은 뒤 도우미를 고친다.
  - DT-14는 구현 커밋에서 `tools-check.yml` 줄을 잠시 지운 트리(커밋하지 않음)로 실패를 본다.
  - 나머지 DT는 아래 6의 틀린 구현(검증 담당)으로 실패를 본다. 시험 담당은 구현 커밋에서 통과를 보고, 할 수 있으면 손으로 틀린 구현 하나씩(예 6의 M11·M13)을 넣어 실패를 본 결과를 '실패 확인'에 덧붙인다.
- **RS 가운데 구현 전 트리에서 처음부터 통과하는 것**: RS-01(상한 그대로 통과), RS-04(정리 목록·보관 파일 안 봄), RS-06 앞 사례(CRLF로 커진 파일 통과), RS-10 뒤 사례(파일이 모두 없음), RS-11(`--next-r`). 구현 전에는 크기를 아예 보지 않아 통과한다. 6의 M1·M2·M5·M6·M10으로 실패를 본다.
- **RS 가운데 구현 전 트리에서 실패해야 하는 것**: RS-02·RS-03·RS-05·RS-06 뒤 사례·RS-07·RS-08·RS-09·RS-10 앞 사례(크기 줄·경고가 없거나 끝 코드가 0). 시험 담당은 `tools/ci/records.test.mjs`를 `D:/ticketpass-w10-base`에 복사해 `node --test tools/ci/records.test.mjs`로 돌린다.

### 6. 틀린 구현 표본(검증 담당용, 15개)

| # | 틀린 구현 | 잡을 시험 |
| --- | --- | --- |
| M1 | 상한을 40,000바이트로 | RS-01 |
| M2 | `>` 대신 `>=`(40,960도 막음) | RS-01 |
| M3 | 상한을 41,000바이트로 | RS-02 |
| M4 | 바이트가 아니라 글자 수(`text.length`)로 잼 | RS-05 |
| M5 | CRLF를 LF로 바꾸지 않고 디스크 바이트로 잼 | RS-06 |
| M6 | `docs/lanes/lane*.md`를 모두 봄(정리 목록 포함) | RS-04 |
| M7 | `docs/PROGRESS.md`만 봄 | RS-03 |
| M8 | 첫 걸린 파일에서 멈춤 | RS-08 |
| M9 | 맞추기(인자 없음)에서도 1로 끝나거나 기록 표를 쓰지 않음 | RS-09 |
| M10 | 없는 크기 파일에서 2로 끝남 / 하나 없으면 나머지를 안 봄 | RS-10, 기존 명령줄 시험 |
| M11 | `timeout` 키가 있는지만 봄(0·변수·식도 통과) | DT-05 |
| M12 | 값 상한을 600,000으로 | DT-05 |
| M13 | `execFileSync`만 찾음(`execFile`·`spawn`·`promisify(execFile)(…)`를 놓침) | DT-03, DT-13 |
| M14 | 괄호를 셀 때 글 조각 속 괄호도 셈(호출 범위가 일찍 끝나 뒤의 `timeout`을 못 봄) | DT-04 |
| M15 | 범위를 `test-int` 폴더만으로(`test-sim`·이름 꼴 `*.test.*` 놓침) / 호출 0곳을 통과로 | DT-07, DT-13(M ≥ 48), DT-10 |

- 더 넣어 볼 것(시간이 되면): 시험 도우미 하나(`services/queue-svc/test-sim/cluster.ts`의 `dockerAsync`)에서 `timeout`을 다시 뺌 → DT-13. 추적하지 않는 파일도 봄(`git ls-files` 대신 폴더 훑기) → DT-08.
- 살아남은 틀린 구현의 처리는 ADR-0283 결정 2대로다: 통과 기준(위 2)에 걸리면 이 묶음에서 시험을 더하고, 나머지는 정리 목록에 적는다.

### 7. 정한 값(이 커밋에서 ADR-0283에 적음, 모두 '추천 적용, 2026-11-18, W10-guards 계획')

- 결정 1: 40KB = 40,960바이트(40×1,024). 줄 끝을 LF로 바꾼 UTF-8 바이트 수, 넘으면 걸리고 40,960은 통과. `--check`는 1, 맞추기는 경고만. 정리 목록과 보관 파일은 안 봄.
- 결정 4: Docker 호출 하나에 300,000ms(5분) 이하의 정수를 옵션에 바로 적는다. 점검 `tools/ci/check-docker-timeouts.mjs`, `tools-check` 잡. 범위는 git이 추적하는 `apps/`·`services/`·`packages/`의 시험 파일이고 `tools/`·`loadtest/`는 뺀다.

### 8. 범위 밖

- `tools/`(`tools/local/cluster.mjs`의 `docker build`, `tools/ci/image-build.mjs`·`scan-tools.mjs`·`contract-breaking.mjs`, `tools/spec-check/run-local.mjs`, `tools/web-checks/lib/docker.mjs`, `tools/local/e2e/`)와 `loadtest/`(`run.mjs`·`poc/`·`nightly/`·`e2e/`·`micro/`·`test/`)의 Docker 호출. 이미지 만들기·kind처럼 오래 걸리는 일이 섞여 한 값으로 묶기 어렵고, `loadtest/test`는 이미 `timeout`을 받는다(변수 꼴이라 이 점검 규칙과 맞지 않는다). 필요하면 정리 목록 후보로 둔다.
- `records.mjs --check`를 CI에 거는 일(지금도 CI에서 돌지 않는다. 기록 커밋 때 갈래 1이 돌린다).
- `docs/PROGRESS.md`의 지난 줄을 옮기는 일(지금 39,495바이트로 상한 안이다).
- vitest `hookTimeout`·`testTimeout` 값 바꾸기, Docker 엔진 멈춤을 미리 알아보는 확인(예 `docker info`) 더하기.
- Docker를 띄우는 시험을 이 묶음에서 돌리기(지시서). 도우미 고침은 CI(형 검사·통합 잡)가 본다.
- `docs/devops.md` 고치기. 점검의 정본 자리는 ADR-0283 결정 4와 `tools/ci/README.md` 표다.

## 시험 이의

(시험이 정본과 어긋나 보이면 구현 담당이 여기에 적는다. 없으면 비워 둔다.)

## 실패 확인

2026-11-18 시험 담당 `w10-guards-test-bd3092cd`가 돌렸다. 복사한 시험 파일은 돌린 뒤 구현 전 트리에서 지웠다(`git status` 깨끗함).

- **RS(구현 전 트리 `D:/ticketpass-w10-base`, `55216411`)**: `tools/ci/records.test.mjs`를 복사해 `node --test tools/ci/records.test.mjs`. 47개 가운데 10개 실패, 37개 통과. 실패한 것은 RS-02, RS-03(사례 셋 모두), RS-05, RS-06, RS-07, RS-08, RS-09, RS-10이다. 까닭은 모두 크기 점검이 없어서다: `--check`가 크기를 넘은 파일에도 0으로 끝나거나(RS-02·03·05·06 뒤 사례·08·10 앞 사례), 기록 표 줄만 찍고 `docs/PROGRESS.md` 줄이 없거나(RS-07), 맞추기가 표준 오류에 `경고:` 줄을 찍지 않는다(RS-09). 통과한 RS-01·RS-04·RS-11은 위 5가 적은 대로 구현 전에도 통과하는 것이다(RS-06 앞 사례와 RS-10 뒤 사례도 통과하지만 같은 시험의 뒤·앞 사례가 실패해 시험 단위로는 실패로 셌다). 기존 시험 34개는 그대로 통과.
- **DT(구현 전 트리)**: `tools/ci/check-docker-timeouts.test.mjs`를 복사해 돌리면 `check-docker-timeouts.mjs`가 없어 모듈을 찾지 못하고(`ERR_MODULE_NOT_FOUND`) 파일 전체가 실패 1로 끝난다. 실행조차 안 되는 실패라 세지 않는다(14개 모두 셈 밖).
- **DT-13(구현 커밋 `f4f5c2ca` 트리, 도우미 고치기 전)**: `node --test tools/ci/check-docker-timeouts.test.mjs` → 14개 가운데 DT-13 하나만 실패. 점검이 끝 코드 1과 마지막 줄 `막음: 시험 파일 1078개, Docker 호출 48곳, 문제 48건`을 냈고, 막은 곳은 위 3의 목록(파일 41개·호출 48곳)과 파일·줄까지 같았다. 이것이 G3의 실패 확인이다.
- **DT-14(구현 커밋 트리에서 `tools-check.yml`의 점검 줄을 잠시 지움, 커밋하지 않고 되돌림)**: `node --test --test-name-pattern="^DT-14" tools/ci/check-docker-timeouts.test.mjs` → 실패 1.
- **손으로 넣은 틀린 구현(스크립트·시험·`git-fixture.mjs`를 임시 폴더에 복사해 그 사본만 바꿈, DT-01~12만 돌림)**: M11(`timeout` 낱말만 있으면 통과) → DT-05 실패. M12(상한 600,000) → DT-05 실패. M13(`execFileSync`만 찾음) → DT-03·DT-06 실패. M14(글 조각 속 괄호도 셈) → DT-04 실패. M15 앞(`test-int` 폴더만 봄) → DT-07 실패. M15 뒤(호출 0곳을 통과로) → DT-10 실패. 원본 사본은 12개 모두 통과. 여섯 모두 잡혔다.

## 시험 결과

2026-11-18 시험 담당 `w10-guards-test-bd3092cd`, 구현 커밋 `f4f5c2ca` 위에 이 시험 커밋의 바뀐 파일을 얹은 트리(`D:/ticketpass-w10`)에서 돌렸다.

- `node --test tools/ci/check-docker-timeouts.test.mjs`(새 파일, DT-01~14): 14개 모두 통과. `GITHUB_ACTIONS=true`로 돌려도 14개 통과(시험이 그 환경 변수를 떼고 DT-11만 켠다).
- `node --test tools/ci/records.test.mjs`: 47개 모두 통과(기존 34개, 새 RS 13개. RS-03은 갈래 파일마다 하나씩 셋으로 나눴다).
- `node --test tools/ci/changes.test.mjs`: 40개 모두 통과. `node --test tools/ci/check-workflows.test.mjs`: 47개 가운데 44개 통과, 3개 건너뜀(뿌리 개발 의존성 `yaml`이 이 PC에 없어서 건너뛰는 시험, CI는 설치 뒤 돈다), 실패 0.
- G3: 위 3의 목록 파일 41개·호출 48곳의 옵션에 `timeout: 300_000`을 넣었다(줄마다 한 곳씩, 다른 글자는 그대로). 꼴은 넷이다: `stdio` 배열 뒤(`docker` 도우미 함수 40곳), `promisify(execFile)(…, { encoding: 'utf8', timeout: 300_000 })`(6곳), `{ stdio: 'ignore', timeout: 300_000 }`(`services/core-svc/test-int/local-partner-stack.int.test.ts`), 옵션이 없던 `execFile('docker', args, { timeout: 300_000 }, () => res())`(`services/queue-svc/test-sim/cluster.ts` 86줄). 목록에 없는 곳은 나오지 않았다. 넣은 뒤 `node tools/ci/check-docker-timeouts.mjs` → 끝 코드 0, `통과: 시험 파일 1078개, Docker 호출 48곳`. TS 도우미의 형 검사와 Docker를 띄우는 통합 시험은 이 PC에서 돌리지 않았다(CI 몫, 지시서).
- `node tools/ci/check-workflows.mjs`: `통과: 워크플로 19개`. `python -I -X utf8 tools/doc-check/check_all.py`: 오류 0, 경고 4(이 묶음과 상관없는 기존 경고).
- 구현 결함 의심: 없음. 계획과 다르게 구현한 두 점(주석 안의 `timeout` 글을 가림, 범위 밖 값의 까닭에 적은 꼴과 정수를 함께 적음)은 계획의 단언과 어긋나지 않는다(DT-05는 `300_001`·`300001` 어느 꼴이든 받는다).

## 리뷰

(리뷰 담당이 채운다: 계획 항목이 다 구현됐나, 정본과 어긋나나, 구현 커밋이 시험 파일을 건드렸나, 자주 놓친 결함에 걸리나. 지적 목록이 그대로 고칠 목록이다.)

## 검증

(검증 담당이 채운다: 위 6의 틀린 구현을 넣은 결과와 놓친 것, 리뷰 반영으로 고친 곳 확인.)

## 확인

(기록 담당·감독이 채운다: ADR-0283 '확인'의 첫 B 묶음 측정. 가중 토큰, 벽시계, 커밋 수, 리뷰와 검증이 찾은 결함 수를 BAT-056(B, 1.5일, 커밋 18)과 견준다.)

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | w10-guards-plan-165e372c | claude-opus-5-5 | 2026-11-18T14:20+09:00 | 2026-11-18T14:55+09:00 |
| impl | w10-guards-impl-0bbaa2ef | claude-opus-5-5 | 2026-11-18T14:43+09:00 | 2026-11-18T14:50+09:00 |
| test | w10-guards-test-bd3092cd | claude-opus-5-5 | 2026-11-18T14:56+09:00 | 2026-11-18T15:12+09:00 |

- 다른 담당은 자기 커밋에서 이 표에 자기 행(역할·세션 ID·모델·시작·끝)을 더한다. 세션 ID는 구현 `w10-guards-impl-0bbaa2ef`, 시험 `w10-guards-test-bd3092cd`, 리뷰 `w10-guards-review-79646c1e`, 검증 `w10-guards-verify-c4a72407`이다(지시서). 리뷰 반영 커밋은 `Fix-By`의 역할(시험·구현) 행으로 센다.
