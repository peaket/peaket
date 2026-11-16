# 작업 계획: W7-L1-roles-check(합치기 전 역할 확인 스크립트)

- **무엇**: 웨이브 7 갈래 1의 첫 일인 `tools/ci/roles-check.mjs`(시험 `tools/ci/roles-check.test.mjs`)의 작업 목록이다(docs/architecture.md §8.6 4의 1, ADR-0270 결정 5). 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane1`, 가지 `wave/lane1-w7`, 출발점 `982a78a8`. 2026-11-16 작성. 그 뒤 `origin/develop`에 `0387780d`(R-640, 꼬리말 역할 값 `review`와 차례 계획 → 시험 → 구현 → 리뷰 → 리뷰 반영 → 검증 → 기록)가 들어왔고, 이 계획은 그것을 따른다. 감독이 이 커밋 뒤 가지를 최신 `develop` 위로 올린다.
- **묶음 ID**: 이 일은 묶음 표에 없다. 묶음 ID 대신 이 파일 이름 `W7-L1-roles-check`를 쓴다(아래 정본 빈칸 1). 이 일의 커밋은 모두 꼬리말 `Batch: W7-L1-roles-check`를 단다.
- **등급**: B(배포·운영 도구, 돈·좌석·순번 아님). 틀린 구현 표본은 아래 '틀린 구현 목록'이다.
- **정본**: ADR-0270 결정 1·2·5·7·8, docs/architecture.md §8.6의 4 '역할 나누기'와 7 '시험 규칙', 9 '설정 자리'. 이 계획이 정한 세부는 §8.6 '합치기 전 역할 확인' 아래 '세부' 줄과 ADR-0270 결정 5의 '추천 적용' 줄에 적었다.

## 계획

### 1. 공개 인터페이스

명령줄 하나만 밖에 내놓는다. 시험도 이 명령을 바깥에서 돌려 본다(§8.6 7 '내부 함수를 공개하지 않는다'). 내놓는 함수는 없다.

```text
node tools/ci/roles-check.mjs [--base <리비전>] [--head <리비전>] [--root <저장소>]
```

| 인자 | 기본값 | 뜻 |
| --- | --- | --- |
| `--base` | `origin/develop` | 합칠 대상. 여기서 닿는 커밋은 보지 않는다 |
| `--head` | `HEAD` | 합칠 작업 가지의 끝 |
| `--root` | 지금 폴더 | git 저장소 뿌리 |

- 보는 커밋: `git rev-list --reverse <base>..<head>`(오래된 것부터). 범위 밖 커밋(base에서 닿는 것)은 꼬리말이 없어도 보지 않는다.
- 계획 파일은 작업 트리가 아니라 `--head` 커밋의 것(`git show <head>:docs/review/plans/<묶음 ID>.md`)을 읽는다.
- 바뀐 파일은 커밋마다 `--no-renames`로 읽는다(옮기기는 옛 경로 지우기와 새 경로 더하기 둘로 센다). 더하기·고치기·지우기를 모두 바꾼 것으로 본다.

**끝 코드**

| 코드 | 뜻 |
| --- | --- |
| 0 | 모든 검사 통과 |
| 1 | 검사 하나라도 실패. 실패를 모두 찍은 뒤 끝낸다(첫 실패에서 멈추지 않는다) |
| 2 | 실행할 수 없음: 모르는 인자, 값 없는 인자, 리비전을 못 읽음, git 저장소가 아님, git 읽기 실패, **범위가 비었음**(빈 결과가 통과로 새지 않게, §8.6 4 '자주 놓친 결함') |

**출력 꼴**(표준 출력, 한 줄에 하나)

- 실패: `실패: [<검사 이름>] <묶음 ID 또는 -> <짧은 해시 7자 이상 또는 -> <까닭>`. 묶음 전체에 걸린 실패(구성·계획 파일·담당 표)는 해시 자리에 `-`, 묶음을 모르는 실패(꼬리말에 Batch 없음)는 묶음 자리에 `-`를 쓴다.
- 검사 이름은 이 아홉 가지뿐이다: `꼬리말`, `범위`, `차례`, `구성`, `시험 파일`, `코드 경로`, `세션`, `계획 파일`, `담당 표`.
- `GITHUB_ACTIONS=true`이면 앞머리 `실패: ` 대신 `::error::`를 쓰고 값의 `%`·줄바꿈을 branch-policy.mjs처럼 바꿔 쓴다.
- 통과: 마지막 줄 `통과: 묶음 <N>개, 커밋 <M>개`. 그 앞에 묶음마다 `묶음 <ID>: <종류> 커밋 <k>개(plan a·test b·impl c·review d·review-fix e·verify f·record g·doc h)` 한 줄(종류는 `코드`·`문서`·`기록만`). 실패해도 묶음 줄은 찍는다.
- 끝 코드 2는 `오류: <까닭>` 한 줄(Actions면 `::error::`)이다.
- 시험 담당이 '실패 확인'에 적은 출력 세부 셋(추천 적용, 2026-11-16):
  - 세션 겹침(⑦): 범위 차례로 세션마다 처음 나온 커밋의 역할을 그 세션의 역할로 본다. 그 세션이 다른 역할로 처음 나온 커밋마다(세션·새 역할 쌍마다 한 줄) 그 커밋의 묶음과 짧은 해시로 찍는다. 까닭에 세션 ID, 먼저 맡은 역할, 새 역할을 적는다(예 `실패: [세션] BAT-901 1a2b3c4 세션 s-x가 test와 impl을 함께 맡았다`). `Fix-By`가 있는 리뷰 반영은 그 역할로 센다.
  - Batch가 둘이거나 꼴이 틀린 커밋: 묶음 자리는 `-`이다(틀린 값을 그대로 찍지 않는다. 까닭에는 값을 적어도 된다). 그 커밋은 어느 묶음에도 넣지 않고, 커밋 하나로 보는 검사(⑤ 시험 파일, ⑥ 코드 경로, ⑦ 세션)는 그대로 하며 그 실패의 묶음 자리도 `-`다.
  - 끝 코드 2의 `오류:` 줄(Actions면 `::error::`)은 표준 출력에 한 줄만 찍는다. 표준 오류에는 쓰지 않는다. 묶음 줄과 `통과:` 줄은 찍지 않는다.

### 2. 손댈 파일

| 파일 | 담당 | 무엇 |
| --- | --- | --- |
| `tools/ci/roles-check.test.mjs` | 시험 | 아래 4의 시험. 가짜 저장소는 `tools/ci/git-fixture.mjs`의 `repo`·`commit`·`git`을 쓴다 |
| `tools/ci/roles-check.mjs` | 시험(빈 뼈대: '아직 없음'을 던진다. node 기본 끝 코드 1이지만 실패 시험은 끝 코드와 함께 출력 줄을 단언하므로 뼈대로는 통과하지 않는다), 구현(동작) | 검사 본체. 표 칸 읽기는 `tools/ci/records.mjs`의 `cells`, 직접 실행 판별은 `tools/ci/entry.mjs`의 `runIfMain`을 써도 된다 |
| `tools/ci/README.md` | 구현 | 스크립트 표에 `roles-check.mjs` 행(부르는 곳: 감독이 합치기 전에 손으로) |
| `docs/architecture.md` §8.6 4·9, ADR-0270 결정 5 | 계획(이 커밋) | 정본 빈칸 |

- 시험 담당의 빈 뼈대는 실패가 '모르는 파일'이 아니라 '아직 없음'으로 나도록 파일을 만들어 둔다. 시험 파일을 못 읽는 실패는 실패로 세지 않는다(ADR-0270 결정 3).
- CI와 `package.json`은 고치지 않는다(아래 6의 9). 시험은 이미 `tools-check.yml`의 `node --test "tools/ci/*.test.mjs"`가 돈다.

### 3. 검사 항목과 판정 규칙

번호 ①~⑩은 시험 이름의 세부 번호다. ADR-0270 결정 5의 항목은 ①(꼬리말), ③(차례), ⑤(시험 파일), ⑦(세션), ⑧·⑨(계획 파일의 절과 담당 표), ⑩(끝 코드)이고, 나머지는 아래 6의 정본 빈칸으로 정한 것이다.

1. **① 꼬리말**(검사 이름 `꼬리말`): 범위의 커밋마다 마지막 꼬리말 덩이(git이 꼬리말로 읽는 끝 문단)에 `Role`·`Agent-Session`·`Batch`가 정확히 하나씩 있다.
   - 키는 대소문자까지 그대로 맞아야 한다(`role:`·`ROLE:`은 없는 것으로 본다). git의 `%(trailers:key=…)`는 대소문자를 무시하므로 그것으로 고르지 않고, 꼬리말 덩이를 읽어 키를 직접 견준다.
   - 본문 가운데 문단의 `Role: plan`은 꼬리말이 아니다.
   - `Role` 값(앞뒤 공백을 뺀 뒤, 대소문자 그대로): `plan`·`test`·`impl`·`review`·`review-fix`·`verify`·`record`·`doc`. 다른 값은 실패.
   - `Agent-Session` 값: 비지 않고 공백이 없다.
   - `Batch` 값: `^[A-Za-z0-9][A-Za-z0-9._-]*$`이고 `..`가 없다(파일 이름으로 쓰므로).
   - `Role: review-fix`는 `Fix-By: test` 또는 `Fix-By: impl`이 정확히 하나 있어야 한다. 다른 역할에 `Fix-By`가 있으면 실패.
   - `Agent-Model`은 보지 않는다(ADR '알면 단다').
2. **② 범위**(`범위`): 범위에 부모가 둘 이상인 커밋(합치기 커밋)이 있으면 실패(묶음은 올린 뒤 앞으로 감기로 합친다, ADR-0270 결정 5). 범위가 비면 끝 코드 2.
3. **③ 차례**(`차례`): 묶음마다(`Batch` 값이 같은 커밋끼리, 범위 안 차례 그대로) 역할마다 **처음 나온** 커밋의 자리를 견준다. 다른 묶음의 커밋이 사이에 끼어도 된다(ADR-0270 결정 2의 겹쳐 돌리기).
   - 코드 묶음: 첫 plan < 첫 test < 첫 impl < 첫 review < 첫 verify. 첫 review-fix는 첫 review나 첫 verify 가운데 이른 것보다 뒤다.
   - 문서 묶음: 첫 plan < 첫 doc < 첫 review.
   - 막지 않는 것: 첫 test 뒤의 plan 커밋(구현 중 정본 빈칸), 첫 impl 뒤의 test 커밋, 첫 review 뒤의 doc 커밋. record는 차례를 보지 않는다.
4. **④ 구성**(`구성`): 묶음의 종류를 가른다. `doc` 커밋이 하나라도 있으면 문서 묶음, record만 있으면 기록만 묶음, 나머지는 코드 묶음이다.
   - 코드 묶음: plan·test·impl·review·verify가 하나 이상씩 있어야 한다.
   - 문서 묶음: plan·doc·review가 있어야 하고 test·impl·review-fix·verify가 없어야 한다.
   - 기록만 묶음(웨이브 보고서처럼 묶음 여럿을 닫는 기록): 구성·차례·계획 파일·담당 표를 보지 않는다. ⑥은 본다.
5. **⑤ 시험 파일**(`시험 파일`): `impl` 커밋과 `review-fix`+`Fix-By: impl` 커밋은 시험 파일을 바꾸지 않는다. 시험 파일은 경로가 다음 하나에 맞는 것이다(대소문자 그대로, 저장소 어디서나):
   - 파일 이름이 `<1자 이상>.test.<1자 이상>` 또는 `<1자 이상>.spec.<1자 이상>`
   - 폴더 마디(파일 이름이 아닌 경로 조각) 가운데 하나가 정확히 `test`·`test-int`·`__tests__`·`e2e`
   - 맞지 않는 예: `services/contest/a.ts`, `src/latest/a.ts`, `src/testing.ts`, `src/test.ts`, `apps/web/e2e-utils/a.ts`, `tools/ci/git-fixture.mjs`
6. **⑥ 코드 경로**(`코드 경로`): `plan`·`review`·`verify`·`record`·`doc` 커밋은 코드 경로를 바꾸지 않는다. 코드 경로는 ADR-0270 결정 8의 맨 위 폴더 일곱(`apps/`·`services/`·`packages/`·`data/`·`infra/`·`tools/`·`.github/`)으로 시작하는 경로다. `test`·`impl`·`review-fix`는 보지 않는다(시험 담당의 빈 뼈대가 제품 파일에 들어간다).
7. **⑦ 세션**(`세션`): 범위 전체에서 `Agent-Session` 값 하나는 역할 하나만 맡는다. 역할로 셀 때 `review-fix`+`Fix-By: test`는 test, `Fix-By: impl`은 impl이다. record(감독)도 한 역할로 센다. 같은 역할이면 묶음을 넘어 같은 세션을 써도 된다(ADR-0270 결정 1).
8. **⑧ 계획 파일**(`계획 파일`): 기록만 묶음이 아니면 `--head`에 `docs/review/plans/<Batch>.md`가 있다(작업 트리에만 있는 파일은 없는 것이다).
   - 코드 묶음은 절 `실패 확인`·`리뷰`·`검증`·`담당 표`, 문서 묶음은 `리뷰`·`담당 표`가 있어야 한다.
   - 절 = 펜스(```) 밖의 제목 줄로, 수준이 2나 3(`##`·`###`)이고, 앞 번호(`3. `·`3.1 ` 꼴)를 뺀 이름이 절 이름과 정확히 같다(`## 리뷰 대기`·`#### 리뷰`는 아니다).
   - 절이 비면 실패다: 그 제목부터 같거나 높은 수준의 다음 제목 전까지 빈 줄도 제목도 아닌 줄이 하나도 없으면 빈 절이다.
9. **⑨ 담당 표**(`담당 표`): '담당 표' 절 안의 첫 마크다운 표.
   - 머리는 정확히 `역할 | 세션 ID | 모델 | 시작 | 끝`(차례까지).
   - 줄마다 다섯 칸이 비지 않는다. 역할 칸은 `plan`·`test`·`impl`·`review`·`verify`·`doc` 가운데 하나.
   - 시작·끝은 오프셋이 붙은 ISO 8601(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$`, 예 `2026-11-16T07:41+09:00`)이고 달력에 있는 시각이며, 끝이 시작보다 이르지 않다(같아도 된다).
   - 그 묶음 커밋의 (역할, 세션) 쌍이 모두 표의 한 줄에 있다(record 빼고, review-fix는 Fix-By의 역할로). 커밋이 없는 줄이 더 있어도 된다.
10. **⑩ 끝 코드와 모아 찍기**: 위 실패를 모두 찍고 하나라도 있으면 1. 실패가 둘 이상이면 둘 다 찍힌다.

### 4. 시험 목록

- 시험 이름은 `RC-<두 자리> <검사 번호> <설명>` 꼴이다(예 `RC-05 ① Role 키의 대소문자가 다르면 빠진 것으로 본다`). 한 시험이 여러 사례를 돌면 단언 메시지에 사례 이름을 넣는다.
- 가짜 저장소 사건: 시험 파일 안에서 `repo()`로 만들고, 기준 커밋(꼬리말 없음, `README.md`) 위에 아래 '좋은 묶음'을 쌓는다. 시험마다 그것을 한 군데만 틀리게 바꿔 돌린다(`spawnSync(process.execPath, [script, '--base', base, '--head', head], { cwd: dir })`, `GITHUB_ACTIONS`는 지운다).
- 좋은 코드 묶음 `BAT-901`(세션 s-plan·s-test·s-impl·s-review·s-verify·s-sup): ① plan(계획 파일 골격) ② test(`services/a/src/x.ts` 뼈대, `services/a/test/x.test.ts`) ③ impl(`services/a/src/x.ts`) ④ review(계획 파일 '리뷰' 절) ⑤ verify(계획 파일 '검증' 절) ⑥ review-fix `Fix-By: test`(s-test, `services/a/test/x.test.ts`) ⑦ review-fix `Fix-By: impl`(s-impl, `services/a/src/x.ts`) ⑧ record(s-sup, `docs/PROGRESS.md`). 계획 파일은 네 절이 차 있고 담당 표에 다섯 역할이 있다.
- 좋은 문서 묶음 `BAT-902`: plan(s-plan, 같은 세션) → doc(s-doc, `notes/a.md`, 코드 경로 밖) → review(s-review, 같은 세션) → record(s-sup).
- 실패 단언은 끝 코드와 함께 `^실패: \[<검사 이름>\] <묶음> <그 커밋의 짧은 해시>`가 맞는지 본다(묶음 전체 실패는 `-`). 통과 단언은 끝 코드 0과 마지막 줄의 묶음·커밋 수를 본다.

| 시험 | 사건(좋은 묶음에서 바꾼 곳) | 단언 |
| --- | --- | --- |
| RC-01 ⑩ 좋은 코드 묶음은 통과한다 | BAT-901 그대로 | 0, `통과: 묶음 1개, 커밋 8개`, 묶음 줄의 역할별 수 |
| RC-02 ⑩ 좋은 문서 묶음은 통과한다 | BAT-902 그대로 | 0, 종류 `문서` |
| RC-03 ③⑦ 섞여 들어온 묶음 둘과 묶음을 넘은 같은 역할 세션은 통과한다 | BAT-901 impl 앞뒤에 BAT-903의 plan·test가 끼고, 두 묶음의 plan·review가 같은 세션 | 0, `묶음 2개` |
| RC-04 ① 꼬리말이 빠지면 실패한다 | Role 없음 / Agent-Session 없음 / Batch 없음(사례 셋, 각각 커밋 하나) | 1, `[꼬리말]`, Batch 없음은 묶음 자리 `-` |
| RC-05 ① Role 키·값의 대소문자가 다르면 빠진 것으로 본다 | `role: plan` / `ROLE: plan` / `Role: Plan` / `agent-session: s` | 1, `[꼬리말]` |
| RC-06 ① 마지막 꼬리말 덩이 밖의 Role은 세지 않는다 | 본문 둘째 문단에 `Role: impl`, 끝 덩이에는 Role 없음 | 1, `[꼬리말]` |
| RC-07 ① 같은 꼬리말이 둘이면 실패한다 | Role 둘(같은 값·다른 값), Agent-Session 둘 | 1, `[꼬리말]` |
| RC-08 ① 목록 밖 역할 값은 실패하고 앞뒤 공백은 지운다 | `Role: reviewer` / `Role: implementation`은 실패, `Role:  impl ` 은 통과 | 1·0 |
| RC-09 ① 리뷰 반영의 Fix-By | review-fix에 Fix-By 없음 / `Fix-By: plan` / impl 커밋에 Fix-By | 1, `[꼬리말]` |
| RC-10 ① Batch 값 꼴 | `../x`, `BAT 901`, `.hidden`, 빈 값 | 1, `[꼬리말]` |
| RC-11 ② 범위의 합치기 커밋은 실패한다 | BAT-901 가운데에 `merge --no-ff` 커밋(꼬리말은 다 있음) | 1, `[범위]` |
| RC-12 ② 실행할 수 없으면 2 | base=head(빈 범위) / 없는 리비전 / 모르는 인자 `--bogus` / 값 없는 `--base` / git 저장소가 아닌 폴더 | 2, `오류:` |
| RC-13 ② 범위 밖 커밋은 보지 않는다 | 기준 쪽에 꼬리말 없는 커밋 셋과 합치기 커밋 하나, 그 위에 BAT-901 | 0 |
| RC-14 ③ 시험보다 먼저 온 구현은 실패한다 | plan → impl → test / test → plan → impl / impl만 첫째 | 1, `[차례]`(해시는 먼저 온 커밋) |
| RC-15 ③ 늦은 계획 고침과 구현 뒤 시험 커밋은 통과한다 | plan → test → plan → impl …, impl 뒤 test 커밋 하나 더 | 0 |
| RC-16 ③ 리뷰·검증·리뷰 반영의 차례 | review가 첫 impl 앞 / verify가 첫 review 앞 / review-fix가 review·verify보다 앞(impl 뒤) | 1, `[차례]` 사례마다 |
| RC-17 ③ 차례는 묶음마다 본다 | BAT-901(맞음)과 BAT-903(impl이 test 앞)이 섞임 | 1, `[차례] BAT-903`만, BAT-901 실패 줄 없음 |
| RC-18 ③ 문서 묶음 차례 | doc이 plan 앞 / review가 doc 앞 | 1, `[차례]` |
| RC-19 ④ 코드 묶음의 역할이 빠지면 실패한다 | plan·test·impl·review·verify를 하나씩 뺀 다섯 사례(차례 실패도 함께 나와도 된다) | 1, `[구성] BAT-901 -` |
| RC-20 ④ 문서 묶음 구성 | review 없음 / test 커밋 섞임 / verify 커밋 섞임 | 1, `[구성]` |
| RC-21 ④ 기록만 묶음은 계획 파일 없이 통과한다 | `Batch: W7-L1` record 커밋 하나(계획 파일 없음, `notes/wave7.md`) | 0, 종류 `기록만` |
| RC-22 ⑤ 구현 커밋이 시험 파일을 바꾸면 실패한다 | impl 커밋이 `a.test.ts`·`b.spec.tsx`·`x/test/a.ts`·`x/test-int/a.ts`·`x/__tests__/a.ts`·`apps/web/e2e/a.ts`를 각각 더함·고침·지움(패턴 여섯 × 셋) | 1, `[시험 파일] BAT-901 <impl 해시>`, 까닭에 경로 |
| RC-23 ⑤ 시험 파일이 아닌 비슷한 경로는 통과한다 | impl이 `services/contest/a.ts`·`src/latest/a.ts`·`src/testing.ts`·`src/test.ts`·`apps/web/e2e-utils/a.ts`·`tools/ci/git-fixture.mjs`를 고침 | 0 |
| RC-24 ⑤ 시험 파일을 옮기는 구현 커밋은 실패한다 | impl이 `git mv x.test.ts x.ts` / `git mv a.ts test/a.ts` | 1, `[시험 파일]` |
| RC-25 ⑤ 구현 쪽 리뷰 반영도 시험 파일을 못 바꾼다 | `Fix-By: impl` 커밋이 `x.test.ts`를 고침(시험 쪽 `Fix-By: test`가 고치는 것은 RC-01에서 통과) | 1, `[시험 파일]` |
| RC-26 ⑥ 코드를 쓰지 않는 역할이 코드 경로를 바꾸면 실패한다 | plan→`tools/ci/x.mjs` / review→`services/a/src/x.ts` / verify→`services/a/test/x.test.ts` / record→`.github/workflows/a.yml` / doc→`packages/p/a.ts` / 기록만 묶음 record→`infra/a.tf` | 1, `[코드 경로]` 사례마다 |
| RC-27 ⑦ 다른 역할끼리 같은 세션은 실패한다 | impl 세션 = test 세션(같은 묶음) / BAT-901 impl 세션 = BAT-903 test 세션 / record 세션 = impl 세션 / `Fix-By: test` 커밋이 impl 세션 | 1, `[세션]`, 까닭에 세션 ID와 두 역할 |
| RC-28 ⑧ 계획 파일이 머리 커밋에 없으면 실패한다 | 계획 파일을 커밋하지 않고 작업 트리에만 둠 / 다른 이름(`bat-901.md`) | 1, `[계획 파일] BAT-901 -` |
| RC-29 ⑧ 머리 커밋의 계획 파일을 읽는다 | 계획 파일을 커밋한 뒤 작업 트리에서만 지움 | 0 |
| RC-30 ⑧ 절이 없거나 비면 실패한다 | 코드 묶음에서 `실패 확인`·`리뷰`·`검증`·`담당 표`를 하나씩 뺌 / `## 리뷰` 밑에 빈 줄만 / `## 리뷰 대기`만 / `#### 리뷰`만 / 펜스 안의 `## 검증`만 | 1, `[계획 파일]` 사례마다 |
| RC-31 ⑧ 절 제목의 허용 꼴 | `## 3. 리뷰`, `### 리뷰`, 내용이 하위 제목 밑에만 있는 `## 검증` / 문서 묶음에 `실패 확인`·`검증` 없음 | 0 |
| RC-32 ⑨ 담당 표 머리·칸 | 머리 차례 바뀜 / 칸 하나 없음 / 빈 칸 / 역할 칸 `record`·`감독` | 1, `[담당 표]` |
| RC-33 ⑨ 담당 표 시각 | 오프셋 없음(`2026-11-16T07:41`) / `2026-11-16 07:41+09:00` / `2026-13-01T00:00+09:00` / 끝 < 시작 → 실패, 끝 = 시작 → 통과 | 1·0 |
| RC-34 ⑨ 커밋의 역할·세션이 표에 있어야 한다 | 표에 s-verify 줄 없음 / s-impl이 `test` 줄로 적힘 / review-fix 세션은 test·impl 줄로 충분(통과) / record 세션은 표에 없어도 통과 | 1·0 |
| RC-35 ⑩ 실패를 모두 찍고 Actions 꼴을 쓴다 | 꼬리말 빠진 커밋 하나와 시험 파일을 고친 impl 커밋 하나 / 같은 사건을 `GITHUB_ACTIONS=true`로 | 1, 두 줄 모두, Actions면 `::error::[꼬리말]` 꼴 |

### 5. 차례

1. 계획(이 커밋): 이 파일, §8.6 4 '합치기 전 역할 확인'의 '세부'와 9 '설정 자리', ADR-0270 결정 5의 '추천 적용' 줄.
2. 시험: `roles-check.test.mjs`와 `roles-check.mjs` 빈 뼈대. '실패 확인' 절에 명령(`node --test tools/ci/roles-check.test.mjs`)·실패 수·까닭.
3. 구현: `roles-check.mjs` 동작과 `tools/ci/README.md` 행. 시험 파일은 고치지 않는다(어긋나 보이면 '시험 이의').
4. 리뷰: 바뀐 부분과 이 계획만 보고 '리뷰' 절.
5. 리뷰 반영: 시험 담당이 재현 시험(`Fix-By: test`) → 구현 담당이 고침(`Fix-By: impl`).
6. 검증: '틀린 구현 목록'을 넣어 보고 '검증' 절.
7. 기록(감독): 진행 로그, PROGRESS 턴 규칙의 '생기기 전에는 손으로' 문장을 명령으로 바꾸기, R 번호.
- 이 일의 마지막 합치기 전에 감독이 이 스크립트로 이 일 자신의 커밋을 본다(`node tools/ci/roles-check.mjs --base origin/develop --head wave/lane1-w7`).

### 6. 정본 빈칸과 정한 것

모두 '(추천 적용, 2026-11-16)'이다. 방향을 바꾸는 결정은 없다(ADR-0270 결정 5의 검사 항목을 기계로 읽을 수 있게 세부를 정했을 뿐이다).

1. **묶음 가르기 (추천 적용, 2026-11-16)**: 커밋마다 꼬리말 `Batch: <묶음 ID>`를 단다. 묶음 ID가 없는 일(이 일, 버그 고침)은 계획 파일 이름을 ID로 쓴다(예 `W7-L1-roles-check`, `W7-L1-fix-<짧은 이름>`). 계획 파일은 `docs/review/plans/<Batch>.md`. 제목의 묶음 ID로 가르지 않는 까닭: 제목에는 R·FR 같은 다른 ID가 같이 들고, 이 일처럼 ID가 없는 제목도 있다.
2. **리뷰 담당 커밋 (추천 적용, 2026-11-16)**: `Role: review`(0387780d R-640이 이미 목록에 더함). 계획 파일 '리뷰' 절만 쓰므로 코드 경로를 바꾸지 않는다(⑥).
3. **검증 담당 커밋 (추천 적용, 2026-11-16)**: `Role: verify`. 넣었던 틀린 구현은 되돌리고 '검증' 절만 커밋하므로 코드 경로를 바꾸지 않는다(⑥). 살아남은 결함의 시험은 시험 담당이 `review-fix`+`Fix-By: test`로 쓴다.
4. **문서만 고치는 묶음 (추천 적용, 2026-11-16)**: 작성 담당은 `Role: doc`. 계획 → 작성 → 리뷰 차례, 계획 파일에는 '리뷰'와 '담당 표' 절만 있으면 된다(시험·검증이 없으므로). `doc` 커밋도 코드 경로를 바꾸지 않는다.
5. **합치기 커밋·범위 밖 커밋 (추천 적용, 2026-11-16)**: 범위 `base..head`만 본다. 범위 안 합치기 커밋은 실패(올린 뒤 앞으로 감기만 쓴다). 빈 범위는 끝 코드 2. 웨이브 보고서처럼 묶음 여럿을 닫는 기록은 `Role: record`만 있는 묶음(`Batch: W7-L1` 등)으로 두고 계획 파일을 보지 않는다.
6. **세션 (추천 적용, 2026-11-16)**: 같은 역할은 묶음을 넘어 세션을 이어 써도 된다. 한 세션이 두 역할을 맡으면 실패다. 감독(record)도 한 역할로 센다.
7. **리뷰 반영의 시험 쪽·구현 쪽 (추천 적용, 2026-11-16)**: `Role: review-fix`에 꼬리말 `Fix-By: test|impl`을 더 단다. 세션으로 짐작하지 않는 까닭: 재현 시험을 새 시험 세션이 쓸 수도 있다. 세션 검사(⑦)는 Fix-By의 역할로 센다.
8. **코드를 쓰지 않는 역할의 코드 경로 (추천 적용, 2026-11-16)**: 결정 1 표의 '하지 않는 것'(계획은 시험·제품 코드를 쓰지 않는다, 리뷰는 코드를 고치지 않는다, 감독은 코드·시험을 쓰지 않는다)을 기계로 본다. 이것이 없으면 코드 커밋에 `record`를 달아 모든 검사를 비켜 갈 수 있다.
9. **CI·package.json (추천 적용, 2026-11-16)**: 잇지 않는다. 합치기는 PR 없이 감독이 로컬에서 앞으로 감기로 하므로, 푸시 뒤 CI가 실패해도 합치기를 막지 못하고 웨이브 7 전 기록에는 꼬리말이 없다. 감독이 합치기 바로 전에 `node tools/ci/roles-check.mjs --base origin/develop --head <작업 가지>`를 손으로 돌린다. 시험은 기존 `tools-check.yml`이 돈다. 뿌리 `package.json` 스크립트는 더하지 않는다(이 PC에서 pnpm이 막힐 때가 있어 node로 바로 부른다).
10. **담당 표의 꼴 (추천 적용, 2026-11-16)**: 머리 `역할 | 세션 ID | 모델 | 시작 | 끝`, 역할 칸은 Role 값, 시각은 오프셋이 붙은 ISO 8601. 감독(record)은 표에 적지 않는다.

### 7. 기계로 보지 않는 것

- 시험이 실제로 먼저 실패했는지(‘실패 확인’ 절의 내용), 리뷰·검증의 내용, 리뷰·검증 담당을 웨이브마다 새로 띄웠는지(지난 웨이브 세션은 범위 밖이다), 다른 모델을 썼는지, 세션 ID를 지어냈는지. 감독이 웨이브 보고서에 적는다.
- ~~`loadtest/`·`specs/`는 ⑥에서 보지 않는다~~: 아래 8의 2(RV-02)로 바꿨다. 이제 ⑥은 허용 목록으로 보므로 `loadtest/`·`specs/`의 `.md`가 아닌 파일도 막는다.
- 시험 설정(RV-04)과, 리뷰·검증 커밋이 계획 파일을 고쳤는지(RV-05)는 아직 보지 않는다(아래 8의 4).

### 8. 리뷰 지적 RV-01~RV-03과 감독 결정의 보탬(2026-11-16)

리뷰 절의 RV-01~RV-03(중간, 통과 기준)을 이 묶음 안에서 고친다. 아래가 위 3의 ③·⑤·⑥과 ①을 바꾸고, 다르면 이것이 이긴다. 방향을 바꾸는 결정은 아니다. 결정 5의 검사 항목('구현이 시험 파일을 바꾸지 않는다', '시험 먼저', 결정 1 표의 '코드를 쓰지 않는다')을 저장소의 실제 파일과 리뷰 반영 차례에 맞게 좁혔을 뿐이다. 정본 문장은 docs/architecture.md §8.6 4 '합치기 전 역할 확인'의 세부에 적었다.

1. **RV-01 시험 파일 패턴 넓히기 (추천 적용, 2026-11-16)**: 2026-11-16 `git ls-files`로 세어 보니 지금 패턴 밖의 시험은 파이썬 시험 `tools/doc-check/test_*.py` 5개와 폴더 `services/*/test-sim/` 9개(도우미 `cluster.ts`·`record.ts`·`pollers.mjs` 포함)다. 나머지(`fixtures/` 18개)는 모두 `test/`·`test-int/` 아래라 이미 잡힌다. 그래서 ⑤의 시험 파일에 둘을 더한다.
   - 파일 이름이 `test_<1자 이상>.py`(파이썬 시험 꼴).
   - 폴더 마디가 정확히 `test-sim`.
   - 넓히지 않는 것: `test-*` 폴더를 통째로(`test-ints/`가 시험 폴더가 되어 RC-23과 어긋나고 지금 쓰는 곳이 없다), 제품 폴더 안의 시험 도우미(`apps/web/src/shared/lib/test-ts-resolve.mjs`·`packages/platform/src/testing.ts`처럼 이름에 test가 든 소스. 제품 빌드에 드는 파일이라 시험 파일로 묶으면 구현 담당이 못 고친다).
   - 새 시험 폴더 꼴이 생기면 이 목록(§8.6 세부)부터 고친다.
2. **RV-02 코드를 쓰지 않는 역할이 바꿔도 되는 경로를 허용 목록으로 (추천 적용, 2026-11-16)**: 막는 목록(맨 위 폴더 일곱)으로는 `deploy/`(Helm 차트 28개)·`loadtest/`·`specs/`·뿌리 설정(`package.json`·`pnpm-lock.yaml`·`eslint.config.mjs`·`turbo.json`·`renovate.json`·`.gitignore` 등)이 빠진다. 앞으로 생길 폴더도 빠진다. 그래서 ⑥을 허용 목록으로 바꾼다.
   - `plan`·`review`·`verify`·`record`·`doc` 커밋이 바꿔도 되는 경로: `docs/`로 시작하는 경로, 그리고 코드 경로(맨 위 폴더 일곱) 밖에 있고 이름이 `.md`로 끝나는 파일(뿌리 `README.md`·`CLAUDE.md`, `.claude/skills/*/SKILL.md`, `specs/README.md` 등). 대소문자는 그대로 본다.
   - 그 밖의 경로는 모두 실패다. 코드 경로 안의 `.md`(예 `tools/ci/README.md`)는 지금처럼 막는다. 그 파일은 구현 담당이 고친다(결정 8은 코드 경로를 바꾸는 묶음을 코드 묶음으로 본다).
   - 감독 결정 '구현 뒤 plan 커밋은 정본·계획 문서만 바꿀 때 허용'은 이 규칙이 그대로 지킨다. plan 커밋은 언제나 이 허용 목록 안만 바꿀 수 있다.
   - 검사 이름은 그대로 `코드 경로`다. 까닭에는 '문서 밖 경로'와 그 경로를 적는다.
3. **RV-03 리뷰 반영도 시험 먼저 (추천 적용, 2026-11-16)**: 리뷰 반영 커밋은 꼬리말 `Finding: <지적 번호>`를 하나 이상 단다. 지적 하나에 한 줄이고, 여럿이면 줄을 되풀이한다. 값 꼴은 `Batch`와 같다(예 `RV-01`, `A2-17`). `Finding`은 `review-fix` 밖의 커밋에 달면 실패다(①).
   - 차례(③): 묶음 안에서 `Fix-By: impl` 커밋의 `Finding` 값마다, 그 커밋보다 앞에 같은 값을 단 `Fix-By: test` 커밋이 있어야 한다. 같은 지적의 첫 `Fix-By: impl`이 첫 `Fix-By: test`보다 먼저 오거나, 시험 쪽 커밋이 없으면 실패다. 지적마다 따로 보므로, 둘째 바퀴의 새 지적도 시험이 먼저다.
   - 재현 시험이 없어도 되는 고침: `Fix-By: impl` 커밋이 바꾼 파일이 모두 `.md`이면(예 `tools/ci/README.md` 문구) 시험 쪽 커밋을 요구하지 않는다. 설정·워크플로·코드는 예외가 아니다. 시험 없이 고칠 만한 문서 지적은 plan 커밋(허용 목록 안)이 고쳐도 된다.
   - 실패 줄은 `[차례] <묶음> <그 Fix-By: impl 커밋 해시>`이고, 까닭에 지적 번호를 적는다.
4. **감독 결정: 첫 구현 전 plan·test 섞기 (2026-11-16, 갈래 3 사례)**: 첫 `Role: impl` 커밋 전에는 plan과 test 커밋이 섞여도 된다(예 plan → test → plan → test → plan → impl). 위 3의 ③ '역할별 처음 나온 커밋끼리 견줌'과 맞는다. 견주는 것은 첫 plan < 첫 test < 첫 impl뿐이라 그 사이의 섞임은 막지 않는다.
   - 지키는 것: 첫 test가 첫 impl보다 앞이다. 첫 plan이 첫 test보다 앞이다(ADR-0270 결정 2. 계획 없이 쓴 시험은 실패). 구현 쪽(impl·`Fix-By: impl`) 커밋은 시험 파일을 바꾸지 않는다(⑤). 역할마다 세션이 다르다(⑦).
   - 구현 뒤의 plan 커밋은 허용 목록 안만 바꿀 때 통과한다(위 2).
5. **구간 끝 정리 목록 후보**: RV-04(구현 커밋이 시험 설정 `vitest*.config.mjs`의 include·exclude나 패키지 시험 스크립트를 바꿔 시험을 빼는 것)와 RV-05(리뷰·검증 커밋이 그 묶음의 계획 파일을 고쳤는지)는 이 묶음에서 고치지 않는다. 감독이 갈래 1의 구간 끝 정리 목록에 올린다.
6. **바뀌는 기존 시험(시험 담당 몫, `Fix-By: test`)**:
   - RC-26의 통과 사례 가운데 `.md`가 아닌 `notes/services/`·`toolbox/`·`.githubx/`·`loadtest/`·`specs/`는 이제 실패다. 통과 사례는 `docs/apps/`와 코드 경로 밖의 `.md`로 바꾼다.
   - 좋은 묶음 BAT-901의 리뷰 반영 두 커밋에 같은 `Finding: RV-901`을 단다(시험 쪽이 먼저).
   - 리뷰 반영을 쓰는 다른 사건(RC-09·RC-16·RC-25·RC-27 등)에도 `Finding`을 단다. 없으면 ①에서 새 실패가 나온다.

**더하는 시험**(이름 꼴은 위 4와 같다)

| 시험 | 사건(좋은 묶음에서 바꾼 곳) | 단언 |
| --- | --- | --- |
| RC-36 ⑤ 파이썬 시험과 test-sim 폴더도 시험 파일이다 | impl 커밋이 `tools/doc-check/test_public.py` / `services/q/test-sim/cluster.ts`(시험 이름 꼴이 아닌 도우미) / `services/q/test-sim/a.sim.test.ts`를 각각 더함·고침·지움 | 1, `[시험 파일] BAT-901 <impl 해시>` |
| RC-37 ⑤ 파이썬·test-sim과 비슷한 경로는 시험 파일이 아니다 | impl이 `services/q/py/test_.py`(뒤가 빔)·`services/q/py/contest_a.py`·`services/q/py/test_a.pyc`·`services/q/py/test_a.py.txt`·`services/q/test-sims/a.ts`·`services/q/Test-sim/a.ts`·`apps/web/src/shared/lib/test-ts-resolve.mjs`를 고침 | 0 |
| RC-38 ⑥ 코드를 쓰지 않는 역할은 문서 밖 경로를 못 바꾼다 | review→`deploy/charts/a/templates/deployment.yaml` / plan→`loadtest/a.mjs` / verify→`specs/a.tla` / record→`package.json`·`pnpm-lock.yaml`·`eslint.config.mjs`·`turbo.json`·`.gitignore`(사례마다) / doc→`.claude/settings.json` / 기록만 묶음 record→`notes/a.txt` / plan→`tools/ci/README.md`(코드 경로 안의 `.md`) / 지우기(record가 `deploy/a.yaml`을 지움) | 1, `[코드 경로]` 사례마다, 까닭에 그 경로 |
| RC-39 ⑥ 허용 목록 안은 통과한다 | plan→`docs/api/openapi.yaml`·`docs/wbs/wbs.csv` / doc→`README.md`·`CLAUDE.md` / review→`.claude/skills/x/SKILL.md` / record→`specs/README.md`·`deploy/README.md` | 0 |
| RC-40 ③ 구현 뒤의 plan 커밋 | 첫 impl 뒤 plan 커밋이 `docs/PROGRESS.md`만 고침 → 통과 / 같은 자리의 plan 커밋이 `services/a/src/x.ts`도 고침 → 실패 | 0·1(`[코드 경로]`) |
| RC-41 ③ 첫 구현 전에는 plan과 test가 섞여도 된다 | plan → test → plan → test → plan → impl … / plan → plan → test → test → impl … | 0 |
| RC-42 ③ 첫 구현 전 섞기의 경계 | test → plan → test → impl(첫 test가 첫 plan보다 앞) / plan → plan → impl → test(첫 impl 앞에 test가 없음) | 1, `[차례]` 사례마다 |
| RC-43 ① Finding 꼬리말 | review-fix에 Finding 없음 / 값이 `RV 01`·`../x`·빈 값 / impl·test·review 커밋에 Finding / review-fix에 `Finding` 두 줄(`RV-01`·`RV-02`)은 통과 / `finding: RV-01`은 없는 것 | 1·0, `[꼬리말]` |
| RC-44 ③ 리뷰 반영은 지적마다 시험 쪽이 먼저다 | `Fix-By: impl`(RV-01)만 있음 / `Fix-By: impl`(RV-01) → `Fix-By: test`(RV-01) / test(RV-01) → impl(RV-01) → impl(RV-02, 시험 쪽 없음) / test(RV-01)이 다른 묶음 BAT-903에만 있음 | 1, `[차례] BAT-901 <그 Fix-By: impl 해시>`, 까닭에 지적 번호 |
| RC-45 ③ 리뷰 반영 차례의 통과 꼴 | test(RV-01·RV-02 두 줄) → impl(RV-01) → impl(RV-02) / test(RV-01) → test(RV-01) → impl(RV-01) / impl(RV-03)이 `tools/ci/README.md`·`docs/PROGRESS.md`만 고침(시험 쪽 없음) | 0 |
| RC-46 ③ 문서 예외의 경계 | 시험 쪽 없는 `Fix-By: impl`(RV-03)이 `tools/ci/README.md`와 `tools/ci/roles-check.mjs`를 함께 고침 / `.github/workflows/a.yml`만 고침 / `tools/ci/README.md.bak`만 고침 | 1, `[차례]` |

틀린 구현 표본에 M-34~M-42를 더했다('틀린 구현 목록' 표 끝).

## 실패 확인

- 돌린 명령: `node --test tools/ci/roles-check.test.mjs`(작업 폴더 `D:/ticketpass-lane1`, 2026-11-16 시험 담당).
- 결과: 시험 35개 가운데 35개 실패, 통과 0개. 처음부터 통과한 시험은 없다.
- 실패 까닭: 35개 모두 뼈대 `tools/ci/roles-check.mjs`가 표준 오류에 '아직 없음'을 쓰고 끝 코드 99로 끝나서다(시험마다 첫 단언 '끝 코드가 0/1/2가 아니다 … 끝 코드 99'). 시험 파일을 못 읽어 실행조차 안 된 실패는 없다.
- 사건 만들기 점검: 뼈대로는 시험마다 첫 사례에서 멈추므로, 단언만 비운 사본(작업 폴더 밖 임시 파일)으로 35개 시험의 모든 사례를 돌려 가짜 저장소 만들기가 오류 없이 끝나는 것을 봤다(약 3분 30초). 구현 뒤 전체 시험도 이만큼 걸린다.
- 시험이 계획 4의 표보다 더 보는 것(같은 규칙의 경계·목록 밖 값, '자주 놓친 결함'):
  - RC-01: 기본 인자(`--base origin/develop`·`--head HEAD`, 로컬 `main`을 머리로 옮겨 기본값이 main이면 빈 범위가 되게 함)와 `--root`.
  - RC-04: `Agent-Session` 값이 빔·공백이 듦, 꼬리말 덩이가 아예 없는 커밋(묶음 `-`). RC-05: `batch:`(묶음 `-`)·`Fix-by:`. RC-06: 꼬리말 덩이 뒤에 글 문단이 온 커밋(묶음 `-`). RC-07: Agent-Session 둘(같은 값·다른 값), Batch 둘(묶음 자리는 보지 않음).
  - RC-08: 목록 밖 Role 값 여덟(`reviewer`·`implementation`·`review_fix`·`reviewfix`·`tests`·`Review`·`supervisor`·빈 값). RC-09: `Fix-By` 값 `plan`·`verify`·`Test`·빈 값, 둘, test·record 커밋의 Fix-By. RC-10: `BAT..901`·`-x`·`_x`·`BAT/901`도 실패, `B`·`a.b_C-9`(기록만 묶음)는 통과.
  - RC-12: 없는 head, 위치 인자 `extra`, 값 없는 `--head`·`--root`, `--root`가 저장소가 아님, Actions의 빈 범위(`::error::`). 끝 코드 2의 출력은 표준 출력의 한 줄로 본다.
  - RC-15: record가 맨 앞이어도 통과. RC-16: review-fix가 첫 review 뒤·첫 verify 앞이면 통과. RC-18: 첫 review 뒤 doc 커밋은 통과. RC-19: review-fix·record가 없는 코드 묶음은 통과. RC-20: plan 없음·impl·review-fix 섞임도 실패.
  - RC-21: 코드 묶음과 기록만 묶음이 함께면 통과. RC-22: 맨 위 폴더 마디 `test/a.ts`, `a.test.b`도 시험 파일. RC-23: 대소문자가 다른 `Test/`·`E2E/`·`a.Test.ts`·`a.SPEC.ts`, `tests/`·`test-ints/`·`__tests/`, `e2e.ts`, 이름 앞이 빈 `.test.ts`, 뒤가 빈 `a.test`·`a.spec`은 시험 파일이 아님.
  - RC-26: `apps/`·`data/`와 지우기도 실패, `docs/apps/`·`notes/services/`·`toolbox/`·`.githubx/`·`loadtest/`·`specs/`는 통과. RC-28: 다른 폴더의 계획 파일. RC-29: 작업 트리의 계획 파일을 깨뜨려도 통과.
  - RC-30: `## 리뷰` 밑에 하위 제목만, `# 리뷰`만도 실패. RC-31: `### 3.1 검증`. RC-32: 머리 이름 다름·칸 더 있음, 다섯 칸 하나씩 빔, 역할 칸 `review-fix`·`Plan`, 절에 표가 없음은 실패, 담당 표 뒤의 다른 표는 통과(다른 절의 표는 좋은 묶음에도 있다).
  - RC-33: 11월 31일·2026-02-29·24시·60분·콜론 없는 오프셋·오프셋을 맞추면 끝이 이른 경우는 실패, `Z`·초·음수 오프셋·2028-02-29 23:59·오프셋이 달라도 같은 순간·오프셋을 맞추면 끝이 뒤인 경우는 통과.
  - RC-34: 표의 세션 이름이 다르면 실패, 커밋 없는 줄이 더 있으면 통과. RC-35: 실패해도 묶음 줄을 찍고, Actions에서 경로의 `%`를 `%25`로 쓴다.
- 계획이 정하지 않아 느슨하게 둔 단언: RC-27(세션)의 실패 줄은 묶음·해시 자리를 보지 않고 까닭에 세션 ID와 두 역할이 드는지만 본다(세션 충돌이 어느 커밋·묶음의 실패인지 계획에 없다). RC-07 Batch 둘과 RC-10 Batch 값 꼴은 묶음 자리를 보지 않는다(틀린 값을 그대로 쓸지 `-`를 쓸지 계획에 없다).
- 조임(2026-11-16, 위 1의 '출력 세부 셋'을 계획이 정한 뒤, 같은 시험 세션): 위 줄의 느슨한 단언을 없앴다. RC-27은 `[세션]` 줄 수와 각 줄의 묶음·해시(새 역할로 처음 나온 커밋)를 보고, 까닭에 세션 ID·먼저 맡은 역할·새 역할이 이 차례로 드는지 본다. 세션 하나가 역할 셋을 맡으면 두 줄이고, 같은 새 역할의 두 번째 커밋은 줄을 더하지 않는다는 사례도 더했다. RC-07(Batch 둘, 같은 값·다른 값)과 RC-10은 묶음 자리 `-`를 보고, 그 커밋이 BAT-901 묶음 줄 수에서 빠지는지 본다. RC-10에는 꼴이 틀린 Batch 커밋의 `[시험 파일]`·`[코드 경로]`·`[세션]` 실패가 묶음 자리 `-`로 찍히는 사례를 더했다. 끝 코드 2(RC-12)는 표준 오류가 비어 있는지도 본다.
- 조인 뒤 다시 돌림: `node --test tools/ci/roles-check.test.mjs` 35개 가운데 35개 실패(모두 뼈대의 끝 코드 99), 처음부터 통과 0개. 단언만 비운 사본으로 바꾼 시험(RC-01·07·10·12·27)의 사건 만들기가 오류 없이 끝나는 것도 봤다.
- 리뷰 반영 RV-01~RV-03의 재현 시험(2026-11-16, 위 8의 6·표, `Fix-By: test` 커밋): 좋은 묶음 BAT-901의 리뷰 반영 두 커밋과 리뷰 반영을 쓰는 다른 사건(RC-20의 문서 묶음 등)에 `Finding`을 달았다. RC-26 통과 사례를 `docs/apps/`와 코드 경로 밖의 `.md`(`notes/services/a.md`·`toolbox/a.md`·`.githubx/a.md`·`loadtest/README.md`·`specs/a.md`)로 바꿨다. RC-36~46을 더했다. 계획보다 더 본 것: RC-36의 `test_a.py`(뒤 한 글자), RC-37의 `Test_a.py`, RC-38의 옛 RC-26 통과 사례 `toolbox/a.mjs`·`.githubx/a.yml`과 대소문자 `notes/a.MD`·`Docs/a.yaml`·코드 경로 안의 `apps/README.md`(까닭에 '문서 밖 경로'와 경로), RC-43의 plan·verify·record·doc 커밋의 Finding과 값 `A2-17`, RC-44 셋째 사례에서 시험이 먼저인 impl(RV-01)에는 `[차례]` 줄이 없음. RC-37의 `services/q/Test-sim/a.ts`는 `services/r/Test-sim/a.ts`로 썼다(RC-36의 `services/q/test-sim/`과 대소문자만 달라 Windows 한 저장소에서 부딪히지 않게 부모만 바꿨고 뜻은 같다).
- 정본 §8.6 세부와 ADR-0270 결정 1 표에서 온 사례(감독 보탬): RC-47 '⑥ test 커밋은 시험 파일 밖의 코드 파일(빈 뼈대)을 바꿔도 통과한다'(test 커밋이 `services/a/src/y.ts`·`packages/p/src/a.ts`·`apps/web/src/a.ts`·`tools/ci/new-check.mjs`를 더함 → 0). 좋은 묶음의 test 커밋이 `services/a/src/x.ts` 뼈대를 더하므로 RC-01도 같은 것을 묵시로 보지만, 그것만 단언하는 사례는 없었다.
- 돌린 명령: `node --test tools/ci/roles-check.test.mjs`(구현 `dd8caac0` 그대로, 약 7분 10초). 47개 가운데 실패 5개, 통과 42개.
  - 실패 5개(RC-36·38·43·44·46): 모두 지금 구현이 새 규칙을 몰라 끝 코드 0으로 통과시켜서다(첫 사례의 '끝 코드가 1이 아니다 … 끝 코드 0'). 단언이 틀린 실패나 시험 파일을 못 읽은 실패는 없다.
  - 처음부터 통과(이미 있는 동작): RC-37·39·41·42·45·47과 통과 사례를 바꾼 RC-26(통과 쪽 단언이거나 지금 구현의 '첫 plan < 첫 test < 첫 impl', '코드 경로 일곱'이 이미 지킴), RC-40(구현 뒤 plan 커밋의 `services/` 고침은 지금 ⑥도 막음). 검증 담당이 틀린 구현(M-34~M-42)으로 한 번은 실패를 봐야 한다. `Finding`을 단 기존 RC-01~35도 모두 통과한다(지금 구현은 `Finding`을 읽지 않는다).
  - 단언만 비운 사본으로 새·바뀐 시험(RC-09·16·20·25·26·27·36~47)의 사건 만들기가 오류 없이 끝나는 것을 봤다.

## 시험 이의

- 2026-11-16, 구현 담당 `w7l1-roles-impl-db02969f`(리뷰 반영 RV-01~03): **RC-38의 사례 'plan → Docs/a.yaml'** 하나가 이 PC(Windows)에서 실패한다(끝 코드 0). 까닭은 시험 사건이다. 가짜 저장소에 이미 `docs/` 폴더(BAT-901의 계획 파일)가 있고, git이 `core.ignorecase=true`(Windows 기본)라 `Docs/a.yaml`을 써서 `git add -A`하면 색인에 소문자 docs 폴더의 a.yaml로 들어간다. 그래서 그 커밋이 실제로 바꾼 경로는 허용 목록 안(소문자 docs 폴더 아래)이고, 계획 8의 2대로 통과가 맞다. 작업 폴더 밖 임시 저장소에서 `docs/`가 없는 채로 `Docs/a.yaml`을 커밋하면 색인에 `Docs/a.yaml`로 남고, 구현은 `[코드 경로] … 문서 밖 경로 Docs/a.yaml` 실패와 끝 코드 1을 낸다(대소문자를 그대로 본다). 고칠 쪽은 시험 담당이다(예: 이 사례만 `docs/`와 부딪히지 않는 이름, 이를테면 `Specs/a.yaml`로 바꾸거나 사건 저장소에 `core.ignorecase=false`를 둔다). 구현은 이 사례 때문에 바꾸지 않았다. RC-38에서 이 사례 앞의 열한 사례는 통과했고, 뒤의 뿌리 설정 다섯(`package.json` 등)은 이 사례에서 시험이 멈춰 돌지 않았다(같은 규칙이고, 리뷰 반영 전 구현에서 실패하던 `record → package.json` 꼴이다).
  - 시험 담당 판단(2026-11-16, `w7l1-roles-test-659fff14`): 이의가 맞다. 시험 사건 문제이고 구현은 맞다. Windows 파일 체계가 대소문자를 가리지 않아 `Docs/a.yaml`이 이미 있는 `docs/` 폴더에 써지므로 `core.ignorecase=false`로는 못 고친다. 그래서 사례를 `docs/`가 없는 범위(기록만 묶음 W7-L1의 record 커밋 하나)에서 `Docs/a.yaml`을 더하는 것으로 바꿨다. 뜻(코드를 쓰지 않는 역할이 대소문자만 다른 `Docs/`를 바꾸면 실패)은 그대로다. RC-38의 사례마다 커밋이 바꾼 경로에 그 경로가 정말 드는지도 먼저 본다(사건이 조용히 바뀌지 않게). 고친 뒤 `node --test --test-name-pattern=RC-38 tools/ci/roles-check.test.mjs`는 1개 통과(뿌리 설정 다섯을 포함한 열여덟 사례 모두), `node --test tools/ci/roles-check.test.mjs`(구현 `28d7780a`)는 47개 가운데 47개 통과(약 7분 20초)다.

## 리뷰

- 누가: 리뷰 담당 `w7l1-roles-review-2c7ed993`, 2026-11-16. 받은 것은 `git diff origin/develop...HEAD`, `git log origin/develop..HEAD`, 이 계획 파일, ADR-0270, docs/architecture.md §8.6 4 '역할 나누기'(1132~1151줄)와 '자주 놓친 결함'(1153~1167줄)뿐이다. 구현 담당의 설명은 받지 않았다.
- 모델: 구현 담당과 같은 claude-opus-5-5의 새 맥락이다. 다른 모델을 쓸 수 없었다(ADR-0270 결정 6).
- 돌린 것:
  - `node tools/ci/roles-check.mjs --base origin/develop --head HEAD`: 끝 코드 1. 실패 셋은 아직 없는 review·verify 커밋(`[구성]`)과 빈 '리뷰'·'검증' 절(`[계획 파일]`)뿐이다. 묶음 줄은 `코드 커밋 5개(plan 2·test 2·impl 1·…)`다.
  - `node --test --test-reporter=tap tools/ci/roles-check.test.mjs`: 35개 가운데 35개 통과, 실패 0(약 5분 25초).
  - 구멍이 의심되는 곳은 작업 폴더 밖 임시 저장소(scratchpad `review-rc/mk.sh <폴더> <변형>`: 좋은 코드 묶음 BAT-901 다섯 커밋을 쌓고 한 군데만 바꾼다)를 만들어 `node D:/ticketpass-lane1/tools/ci/roles-check.mjs --root <폴더> --base base --head HEAD`로 봤다.
- 계획 항목 대조: 검사 ①~⑩, 시험 RC-01~35(시험 이름 35개가 표와 같다), 정본 빈칸 10개(9의 CI·`package.json`은 바뀐 부분에 없다), 출력 세부 셋(세션 겹침은 새 역할로 처음 나온 커밋, 꼴이 틀린 Batch는 묶음 자리 `-`, 끝 코드 2는 표준 출력 한 줄)이 모두 구현과 시험에 있다. 정본(§8.6 '합치기 전 역할 확인'의 세부, ADR-0270 상태 줄 보탬)과 구현이 어긋나는 곳은 없다.
- 구현 커밋 `dd8caac0`의 `git show --stat`: 계획 파일, `tools/ci/README.md`, `tools/ci/roles-check.mjs` 셋뿐이고 시험 파일 패턴에 드는 파일은 없다.
- 구멍이 아니라고 본 것(임시 저장소나 코드로 확인): 꼬리말 키 대소문자(키를 그대로 견줌)와 값 앞뒤 공백(지움), `Role : impl`처럼 콜론 앞 공백(덩이 전체가 꼬리말이 아니게 되어 실패, git도 같음), 옮기기(`diff-tree --no-renames`), 지운 시험 파일(`--name-only`에 든다), 경로 구분자(git은 늘 `/`로 준다), 범위 안 합치기 커밋, 빈 `Agent-Session`, 묶음을 넘은 같은 세션의 다른 역할(범위 전체에서 셈), 꼴이 틀린 Batch로 묶음을 비켜 가기(커밋 하나로 보는 ⑤⑥⑦은 그대로 함), `record`·`doc`을 달아 코드 커밋 숨기기(⑥), 빈 담당 표(행이 없으면 커밋마다 `[담당 표]` 실패), 빈 범위(끝 코드 2).
- 너무 엄격해 올바른 묶음을 막는 곳은 찾지 못했다. 꼬리말 덩이에 `BREAKING CHANGE: …`가 섞이면 덩이 전체가 꼬리말이 아니게 되지만, `git interpret-trailers --parse`도 같은 덩이를 꼬리말로 읽지 않고 `origin/develop` 기록에 그런 줄이 없다. 지난 기록 커밋(진행·장부)이 코드 경로를 바꾼 적도 없다.

| 번호 | 심각도 | 파일:줄 | 무엇이 틀렸나 | 재현 | 고칠 쪽 | 처리 |
| --- | --- | --- | --- | --- | --- | --- |
| RV-01 | 중간 | `tools/ci/roles-check.mjs:30-31`·`192-196`, 계획 3의 ⑤(82~85줄) | 시험 파일 패턴이 저장소에 지금 있는 시험을 못 잡는다. `tools/doc-check/test_*.py` 다섯 개(파이썬 시험, 이름 꼴 `test_*.py`)와 `services/queue-svc/test-sim/`의 도우미 `cluster.ts`·`record.ts`·`pollers.mjs`(폴더 `test-sim`)를 구현 커밋이 바꿔도 통과한다. 패턴은 정본(§8.6 1147줄, ADR-0270 결정 5)의 닫힌 목록을 그대로 옮긴 것이라 구현 잘못은 아니다 | 임시 저장소 변형 `py`(impl 커밋이 `tools/doc-check/test_public.py`도 고침)·`sim`(impl이 `services/q/test-sim/cluster.ts`도 고침): 둘 다 `통과: 묶음 1개, 커밋 5개`, 끝 코드 0 | 계획(정본 빈칸: 패턴에 `test_*.py`와 폴더 `test-sim` 등을 더할지) → 시험 → 구현 | 이 묶음 안에서 고친다(통과 기준: 규칙 위반이 통과한다) |
| RV-02 | 중간 | `tools/ci/roles-check.mjs:28`, 계획 3의 ⑥(86줄)·7(174줄) | 코드를 쓰지 않는 역할(plan·review·verify·record·doc)이 코드 경로 밖의 실행 파일을 바꿔도 통과한다. `deploy/`(Helm 차트 `deployment.yaml`·`networkpolicy.yaml` 등 28개, 보안 설정 포함), `loadtest/`(86개), `specs/`, 뿌리의 `package.json`·`pnpm-lock.yaml`·`eslint.config.mjs`·`turbo.json`. 계획은 `loadtest/`·`specs/`만 적어 두었고 `deploy/`와 뿌리 설정은 언급이 없다. 목록은 ADR-0270 결정 8의 맨 위 폴더 일곱 그대로다 | 임시 저장소 변형 `rootcfg`(review 커밋이 `package.json`·`eslint.config.mjs`·`loadtest/a.mjs`·`specs/a.yml`도 고침): 끝 코드 0. `deploy/`도 같은 길(목록에 없음) | 계획(정본 빈칸: ADR-0270 결정 8의 코드 경로에 `deploy/`와 뿌리 설정을 더할지, 방향을 바꾸는 결정이면 소유자) → 시험 → 구현 | 이 묶음 안에서 고친다(통과 기준·보안 설정) |
| RV-03 | 중간 | `tools/ci/roles-check.mjs:367-373`, 계획 3의 ③(75줄), §8.6 1145줄 | 리뷰 반영의 시험 먼저를 보지 않는다. ADR-0270 결정 2와 §8.6 4의 5는 시험 담당이 재현 시험을 먼저 쓰고 구현 담당이 고친다고 하고 계획 5의 5도 그 차례인데, `Fix-By: impl` 커밋이 `Fix-By: test` 없이 오거나 그보다 먼저 와도 통과한다. §8.6 세부 '차례'가 '첫 리뷰나 첫 검증 뒤'만 정해서 생긴 빈칸이다 | 임시 저장소 변형 `fiximplonly`(review 뒤 `Fix-By: impl` 커밋 하나만): 끝 코드 0. `fiximplfirst`(`Fix-By: impl` 다음에 `Fix-By: test`): 끝 코드 0 | 계획(정본 빈칸: 첫 `Fix-By: test` < 첫 `Fix-By: impl`을 넣을지, 재현 시험이 필요 없는 고침의 예외를 둘지) → 시험 → 구현 | 이 묶음 안에서 고친다(통과 기준: 시험 먼저 규칙 위반이 통과한다) |
| RV-04 | 낮음 | `tools/ci/roles-check.mjs:321-323` | 구현 커밋이 시험 설정(`services/*/vitest*.config.mjs`의 `include`·`exclude`, 패키지 `package.json`의 시험 스크립트)을 바꿔 시험을 빼도 ⑤는 못 잡는다. 정본의 시험 파일 정의 밖이다 | 임시 저장소 변형 `cfg`(impl 커밋이 `services/a/vitest.config.mjs`도 고침): 끝 코드 0 | 계획(정본에 시험 설정 파일을 시험 쪽으로 볼지) | 구간 끝 정리 목록 후보 |
| RV-05 | 낮음 | `tools/ci/roles-check.mjs:376-399`, 계획 7(173줄) | 리뷰·검증 커밋이 있는지와 계획 파일 절이 찼는지를 따로 볼 뿐, 리뷰·검증 커밋이 그 계획 파일을 고쳤는지는 보지 않는다. 다른 역할 커밋(구현 등)이 '리뷰'·'검증' 절을 채우고, 리뷰·검증 커밋은 다른 파일만 고쳐도 통과한다. 계획 7은 절의 내용을 기계로 보지 않는다고만 적었다 | 임시 저장소 변형 `verifynoplan`(verify 커밋이 `notes/v.md`만 고치고 '검증' 절은 plan 커밋이 채움): 끝 코드 0 | 계획(리뷰·검증 커밋이 `docs/review/plans/<Batch>.md`를 고쳐야 한다는 줄을 넣을지) | 구간 끝 정리 목록 후보 |

- '자주 놓친 결함' 대조: 경계 양쪽(끝 = 시작 통과, 끝 < 시작 실패), 목록 밖 값마다 거부(Role 여덟·Fix-By 넷·Batch 꼴), 차례를 바꾼 경우(RC-14), 빈 결과가 통과로 새지 않음(빈 범위 2, 빈 담당 표), 부르는 쪽 경계(시험이 명령을 자식 프로세스로 돌림), 시작 파일 조립(`runIfMain`을 명령으로 거침)은 시험에 있다. 걸리는 것은 '허용·거부 목록은 목록 밖의 값마다 본다'의 목록 자체가 저장소의 실제 시험·코드 경로를 다 덮지 못한 RV-01·RV-02다.
- 관찰(지적 아님): 결정 2의 겹쳐 돌리기로 묶음 N+1의 계획·시험 커밋이 같은 가지에 먼저 들어오면, N+1이 끝날 때까지 가지 전체가 `[구성]`으로 실패한다. 앞으로 감기로 가지 끝까지 합치므로 맞는 동작이지만, 감독은 N만 합치려면 N+1 커밋을 N 뒤에 두고 `--head`를 N의 마지막 커밋으로 줘야 한다.

### 둘째 보기(고친 곳만, 2026-11-16)

- 본 것: 첫 리뷰(`3e3050eb`) 뒤 커밋 넷만 봤다(`git log 3e3050eb..HEAD`, `git diff 3e3050eb..HEAD`). 계획 `970142d1`(위 '계획' 절 8, §8.6 세부, ADR-0270 상태 줄 보탬), 시험 쪽 리뷰 반영 `325fe4d2`(`Fix-By: test`, `Finding: RV-01~03`), 구현 쪽 리뷰 반영 `28d7780a`(`Fix-By: impl`, 같은 Finding 셋), 시험 `9426377b`(RC-38 사건 고침)다. 같은 리뷰 세션, 같은 모델의 새 맥락이다(다른 모델을 쓸 수 없었다).
- 구현 쪽 리뷰 반영 `28d7780a`의 `git show --stat`은 계획 파일, `tools/ci/README.md`, `tools/ci/roles-check.mjs` 셋뿐이다. 시험 파일은 건드리지 않았다. 구현 뒤 시험 커밋 `9426377b`는 '시험 이의'에 적힌 사건 문제(Windows `core.ignorecase`로 대문자 `Docs/` 경로가 이미 있는 소문자 docs 폴더 아래로 커밋됨)만 고쳤다. 단언을 구현에 맞춰 느슨하게 하지 않았고, 커밋된 경로를 먼저 확인하는 단언을 더했다.
- 돌린 것:
  - `node tools/ci/roles-check.mjs --base origin/develop --head HEAD`: 끝 코드 1. 묶음 줄 `코드 커밋 10개(plan 3·test 3·impl 1·review 1·review-fix 2·…)`. 실패는 아직 없는 verify 커밋(`[구성]`)과 빈 '검증' 절(`[계획 파일]`) 둘뿐이다. 이 '둘째 보기' 커밋은 리뷰 하나를 더할 뿐이라 결과가 같다.
  - `node --test --test-reporter=tap tools/ci/roles-check.test.mjs`: 47개 가운데 47개 통과, 실패 0(약 8분).
  - 첫 리뷰의 재현 사건(scratchpad `review-rc/mk.sh`, 리뷰 반영 사건에 `Finding: RV-1`을 달도록 고침)을 새 구현으로 다시 돌렸다. 결과는 아래 표와 같다.

| 지적 | 재현 변형 | 첫 보기 | 둘째 보기 | 판정 |
| --- | --- | --- | --- | --- |
| RV-01 | `py`(impl이 `tools/doc-check/test_public.py`도 고침), `sim`(impl이 `services/q/test-sim/cluster.ts`도 고침) | 0 | 1, `[시험 파일] BAT-901 <impl 해시>`, 까닭에 경로 | 닫힘 |
| RV-02 | `rootcfg`(review가 `package.json`·`eslint.config.mjs`·`loadtest/a.mjs`·`specs/a.yml`도 고침), 새 변형 `deploy`(review가 `deploy/charts/x/networkpolicy.yaml`도 고침) | 0 | 1, 경로마다 `[코드 경로] … 문서 밖 경로 …` | 닫힘 |
| RV-03 | `fiximplonly`(`Fix-By: impl`만), `fiximplfirst`(impl 다음에 test) | 0 | 1, `[차례] BAT-901 <Fix-By: impl 해시> 지적 RV-1의 …` | 닫힘 |
| 통과 꼴 | `good`, 새 변형 `fixproper`(test(RV-1) → impl(RV-1)) | 0 | 0 | 막지 않음 |
| RV-04·RV-05 | `cfg`, `verifynoplan` | 0 | 0 | 계획대로 구간 끝 후보로 남김 |

- 정본 대조: 구현은 §8.6 세부의 새 문장(꼬리말의 `Finding`, 차례의 '첫 구현 전 섞기'와 '지적마다 시험 먼저', 바꾸는 파일의 `test_*.py`·`test-sim`과 허용 목록)과 계획 8의 1~4와 맞는다. `Finding` 값 꼴은 Batch와 같은 검사(`idOk`)를 쓰고, `review-fix` 밖의 커밋에 달면 `[꼬리말]` 실패다. 첫 구현 전 plan·test 섞기는 '역할별 처음 나온 커밋끼리 견줌'을 그대로 써서 따로 고친 곳이 없다(RC-41·42가 경계를 본다).
- 새 규칙에서 구멍이 아니라고 본 것: 같은 Finding의 시험 쪽 커밋이 다른 묶음에만 있으면 실패(묶음마다 셈), 시험 쪽이 뒤에 오면 실패(차례대로 셈), `finding:` 소문자 키는 없는 것, `Docs/`처럼 대소문자가 다른 `docs/`는 허용 목록 밖, 코드 경로 안의 `.md`(`tools/ci/README.md`)는 코드를 쓰지 않는 역할에 막힘.
- 지나친 막음: 찾지 못했다. 허용 목록 밖을 바꾼 지난 `docs(...)` 커밋(`specs/results/*.json`, `loadtest/plan/*.json` 등)은 ADR-0270 전 기록이고, 웨이브 7부터는 그런 파일을 코드 묶음이 바꾼다(계획 8의 2). 측정 결과 파일을 감독(record)이 커밋해야 하는 때가 오면 그때 허용 목록을 다시 본다(지적 아님).

| 번호 | 심각도 | 파일:줄 | 무엇이 틀렸나 | 재현 | 고칠 쪽 | 처리 |
| --- | --- | --- | --- | --- | --- | --- |
| RV-06 | 낮음 | `tools/ci/roles-check.mjs:391-399`, 계획 8의 3(192줄) | '지적마다 시험 먼저'는 같은 Finding을 단 `Fix-By: test` 커밋이 앞에 있는지만 본다. 그 커밋이 시험 파일을 하나도 바꾸지 않아도(계획 파일만 고치거나 빈 커밋) 뒤의 `Fix-By: impl`이 통과한다. 재현 시험 없이 시험 쪽 커밋만 남기면 RV-03의 규칙을 비켜 간다. 정본 문장과 계획 8의 3은 시험 쪽 커밋이 시험 파일을 바꿔야 한다고 정하지 않았으므로 구현 잘못은 아니다 | 새 변형 `fixtestdoc`(`Fix-By: test`(RV-1)가 계획 파일만 고침 → `Fix-By: impl`(RV-1)이 `services/a/src/x.ts`를 고침), `fixtestempty`(시험 쪽이 빈 커밋): 둘 다 끝 코드 0 | 계획(지적마다 시험 쪽 커밋 하나 이상이 시험 파일을 바꿔야 한다는 줄을 넣을지) → 시험 → 구현 | 구간 끝 정리 목록 후보(RV-05처럼 커밋 내용의 진위에 가깝고, 일부러 꾸며야 비켜 간다) |

- 결론: RV-01~RV-03은 정본 결정대로 닫혔다. 새 발견은 RV-06(낮음, 구간 끝 후보) 하나다. 이 묶음 안에서 더 고칠 지적은 없다.

## 틀린 구현 목록

검증 담당이 하나씩 넣고 `node --test tools/ci/roles-check.test.mjs`가 실패하는지 본다(B등급 표본). 번호는 위 3의 검사 번호다.

| 번호 | 검사 | 넣을 틀린 구현 | 잡아야 할 시험 |
| --- | --- | --- | --- |
| M-01 | ① | 꼬리말 키를 대소문자 무시로 견준다 | RC-05 |
| M-02 | ① | 본문 어디든 `Role:` 줄을 꼬리말로 읽는다 | RC-06 |
| M-03 | ① | Role이 둘이면 첫 값을 쓴다 | RC-07 |
| M-04 | ① | Role 값 목록을 보지 않는다(아무 값이나 받음) | RC-08 |
| M-05 | ① | review-fix의 Fix-By가 없으면 impl로 친다 | RC-09 |
| M-06 | ① | Batch가 없으면 묶음 `-`로 모아 통과시킨다 | RC-04 |
| M-07 | ② | 합치기 커밋을 건너뛴다(`--no-merges`) | RC-11 |
| M-08 | ② | 빈 범위를 0으로 끝낸다 | RC-12 |
| M-09 | ③ | 차례를 첫 plan < 첫 impl만 본다(test를 건너뛰어도 통과) | RC-14 |
| M-10 | ③ | 처음 나온 자리 대신 마지막 자리로 견준다 | RC-15 |
| M-11 | ③ | 차례를 묶음마다가 아니라 범위 전체로 본다 | RC-03, RC-17 |
| M-12 | ③ | review-fix 차례를 보지 않는다 | RC-16 |
| M-13 | ④ | 코드 묶음에 verify가 없어도 통과시킨다 | RC-19 |
| M-14 | ④ | 문서 묶음에 test 커밋이 섞여도 통과시킨다 | RC-20 |
| M-15 | ⑤ | 시험 파일 패턴에서 `e2e/`를 뺀다 | RC-22 |
| M-16 | ⑤ | 시험 파일 패턴에서 `test-int/`를 뺀다 | RC-22 |
| M-17 | ⑤ | 시험 파일 패턴에서 `*.spec.*`를 뺀다 | RC-22 |
| M-18 | ⑤ | 폴더 마디 대신 글자 포함으로 본다(`contest/`도 시험 폴더) | RC-23 |
| M-19 | ⑤ | 옮기기를 찾아 새 경로만 본다(`--no-renames`를 뺀다) | RC-24 |
| M-20 | ⑤ | 지운 파일은 세지 않는다(더하기·고치기만) | RC-22 |
| M-21 | ⑤ | `Fix-By: impl` 커밋은 시험 파일 검사를 하지 않는다 | RC-25 |
| M-22 | ⑥ | record 커밋은 코드 경로 검사를 하지 않는다 | RC-26 |
| M-23 | ⑥ | 코드 경로 목록에서 `tools/`를 뺀다 | RC-26 |
| M-24 | ⑦ | 세션 검사를 묶음 안에서만 한다 | RC-27 |
| M-25 | ⑦ | review-fix를 Fix-By와 상관없이 한 역할로 센다 | RC-27 |
| M-26 | ⑦ | 세션을 (묶음, 역할)마다 하나로 묶어 같은 역할의 이어 쓰기를 실패로 본다 | RC-03 |
| M-27 | ⑧ | 계획 파일을 작업 트리에서 읽는다 | RC-28, RC-29 |
| M-28 | ⑧ | 절 이름을 앞부분 맞추기로 본다(`리뷰 대기`도 리뷰) | RC-30 |
| M-29 | ⑧ | 빈 절도 있는 것으로 본다 | RC-30 |
| M-30 | ⑨ | 끝이 시작보다 일러도 통과시킨다 | RC-33 |
| M-31 | ⑨ | 커밋 세션이 표에 있는지만 보고 역할은 보지 않는다 | RC-34 |
| M-32 | ⑩ | 실패를 찍기만 하고 0으로 끝낸다 | RC-04 등 모든 실패 시험 |
| M-33 | ⑩ | 첫 실패에서 멈춘다 | RC-35 |
| M-34 | ⑤ | 시험 파일 패턴에서 폴더 `test-sim`을 뺀다 | RC-36 |
| M-35 | ⑤ | 시험 파일 패턴에서 `test_*.py`를 뺀다 | RC-36 |
| M-36 | ⑤ | `test_*.py`를 이름 앞부분만 본다(`test_a.pyc`도 시험 파일) | RC-37 |
| M-37 | ⑥ | 허용 목록 대신 옛 막는 목록(맨 위 폴더 일곱)으로 본다 | RC-38 |
| M-38 | ⑥ | 코드 경로 안의 `.md`도 허용한다 | RC-38 |
| M-39 | ③ | 리뷰 반영 차례를 묶음의 첫 `Fix-By: test` < 첫 `Fix-By: impl`로만 본다(지적마다 보지 않음) | RC-44 |
| M-40 | ③ | 시험 쪽 커밋을 다른 묶음에서도 찾는다 | RC-44 |
| M-41 | ③ | 문서 예외를 '바꾼 파일 가운데 `.md`가 하나라도 있으면'으로 본다 | RC-46 |
| M-42 | ① | `Finding` 꼬리말이 없어도 리뷰 반영을 받는다 | RC-43 |

## 검증

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | w7l1-roles-plan-680fac67 | claude-opus-5-5 | 2026-11-16T07:41+09:00 | 2026-11-16T09:24+09:00 |
| test | w7l1-roles-test-659fff14 | claude-opus-5-5 | 2026-11-16T08:00+09:00 | 2026-11-16T10:10+09:00 |
| impl | w7l1-roles-impl-db02969f | claude-opus-5-5 | 2026-11-16T08:38+09:00 | 2026-11-16T09:59+09:00 |
| review | w7l1-roles-review-2c7ed993 | claude-opus-5-5 | 2026-11-16T09:01+09:00 | 2026-11-16T10:22+09:00 |
