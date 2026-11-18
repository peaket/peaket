# 작업 계획: W11-ci-conc(develop CI를 다음 푸시가 취소하지 않게)

- **무엇**: 감독이 찾은 문제(2026-11-19, `develop` CI 15번 중 11번 '취소')를 고친다. 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane4-ci`(가지 `feature/lane4-W11-ci-conc`, 출발점 `origin/develop` `760f465b`), 구현 전 트리 `D:/ticketpass-lane4-ci-base`(`760f465b`, 커밋 금지). 시험은 `node --test tools/ci/check-workflows.test.mjs`.
- **등급·차례**: C, 정방향(`Batch-Order: impl-first`), ADR-0283 결정 2의 짧은 고리.
- **정본**: `docs/devops.md` §3.4 'CI 속도와 신뢰'의 concurrency 줄. PR 쪽만 적혀 있어 이 계획 커밋에서 'PR에서만 취소, 가지 푸시는 끝까지, 기다리는 실행은 가장 새 것 하나'를 더했다.

## 계획

### 1. 범위와 바른 동작

1. `ci.yml` 16~18줄의 그룹(`ci-${{ github.event.pull_request.number || github.ref }}`)은 그대로 두고, `cancel-in-progress: true`를 `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`로 바꾼다.
2. 그러면 PR은 새 푸시가 앞 실행을 취소하고, `develop`·`main`·`release/**`·`hotfix/**` 푸시는 앞 실행이 끝까지 돈다. 그사이 쌓인 실행은 가장 새 것 하나만 기다린다(중간 것의 '취소'는 맞다).
3. 규칙 4(사용자가 고칠 수 있는 값 금지): `github.event_name`은 사건 본문이 아니라 검사가 따로 빼 두었고 기존 시험이 `== 'schedule'`로 본다. 새 식은 통과한다.
4. `check-workflows.mjs`에 새 규칙은 더하지 않는다. `ci.yml` 한 파일의 일이라 실제 파일을 읽는 시험으로 지킨다.

### 2. 손댈 파일

| 담당 | 파일 | 할 일 |
| --- | --- | --- |
| 구현 | `.github/workflows/ci.yml` | 18줄 한 줄 |
| 시험 | `tools/ci/check-workflows.test.mjs` | 아래 시험 |

### 3. 시험 목록

- 값은 정본(위 `devops.md` 줄)에서 글로 적는다. YAML 패키지 없이 줄로 읽어 로컬에서도 건너뛰지 않는다. ★는 구현 전 트리에서 실패해야 한다.

| 시험 | 사건 | 단언 |
| --- | --- | --- |
| CC-01 ★ | 실제 `.github/workflows/ci.yml`의 맨 위 `concurrency:` 블록 | `group:` 값이 정확히 `ci-${{ github.event.pull_request.number \|\| github.ref }}`, `cancel-in-progress:` 값이 정확히 `${{ github.event_name == 'pull_request' }}` |
| CC-02 | 실제 `ci.yml` 전체 | `concurrency:`·`cancel-in-progress:` 줄이 각각 하나뿐 |
| CC-03 | 기존 규칙 4 통과 목록에 `github.event_name == 'pull_request'`를 더함 | 끝 코드 0 |

- CC-02·CC-03은 구현 전에도 통과한다(되돌림 막기). 실제 워크플로 전체의 검사 통과는 기존 'D-T12 ①' 시험이 본다.

### 4. 틀린 구현 표본(검증 담당용)

| # | 틀린 구현 | 잡을 시험 |
| --- | --- | --- |
| M1 | `cancel-in-progress: false`(PR도 취소 안 함) | CC-01 |
| M2 | 거꾸로 `${{ github.event_name == 'push' }}` | CC-01 |
| M3 | 큰따옴표 `"pull_request"`(GitHub 식은 작은따옴표만 받는다) | CC-01 |
| M4 | 그룹을 `ci` 하나로 | CC-01 |
| M5 | 맨 위는 그대로 두고 잡 `kind`에만 `cancel-in-progress: false` 블록을 더함 | CC-01·CC-02 |
| M6 | `cancel-in-progress:` 줄을 지움(기본값 거짓, PR도 취소 안 함) | CC-01 |

### 5. 범위 밖

- 다른 워크플로: `branch-policy.yml`·`merge-tree.yml`은 PR에서만 돌아 지금 꼴(PR 번호 그룹, 취소 참)이 맞고, `release.yml`·`branch-weekly.yml`은 이미 `cancel-in-progress: false`라 고칠 것이 없다.
- 기다리는 실행을 여럿 남기기(GitHub이 지원하지 않음), `ci-summary`가 '취소'를 실패로 세는 규칙(§3.1).

## 시험 이의

(아직)

## 실패 확인

- 시험 파일을 구현 전 트리(`D:/ticketpass-lane4-ci-base`, `760f465b`)에 복사해 `node --test tools/ci/check-workflows.test.mjs`를 돌렸다(2026-11-19 06:19). 50개 중 통과 46, 실패 1, 건너뜀 3. 확인 뒤 `git checkout -- .`로 되돌렸다.
- 실패 1은 CC-01 ★이다. 까닭: `cancel-in-progress` 값이 `true`이고 정본 값 `${{ github.event_name == 'pull_request' }}`와 다르다(단언 메시지 'concurrency.cancel-in-progress 값'). 그룹 값은 구현 전에도 같아 첫 단언은 통과했다.
- CC-02는 구현 전에도 통과한다. 구현 전 `ci.yml`도 `concurrency:`·`cancel-in-progress:` 줄이 맨 위 블록에 하나씩뿐이라, 이 시험은 고친 값이 아니라 잡에 따로 블록을 더해 맨 위 규칙을 덮는 것(M5)을 막는 되돌림 막기다.
- CC-03은 구현 전에도 통과한다. 규칙 4(`check-workflows.mjs`)는 이미 `github.event_name`을 사용자가 고칠 수 없는 값으로 보고(기존 `== 'schedule'` 시험), 검사 도구는 이번에 바꾸지 않았다. 새 식이 단계 `env`와 맨 위 `concurrency` 블록 어디에 있어도 검사가 막지 않음을 지킨다.
- 건너뜀 3 중 2는 구현 전 트리에 `node_modules`(yaml 패키지)가 없어 YAML 시험이 건너뛴 것이고, 1은 CI 밖이라 건너뛰는 시험이다. 새 시험 셋은 YAML 패키지 없이 줄로 읽어 건너뛰지 않았다.

- 리뷰 반영(VF-A3·A4·A5, 2026-11-19 06:50): 임시 사본(`git worktree add --detach`, `node_modules`는 디렉터리 연결, 끝나고 연결을 끊고 사본을 지움)에 결함을 하나씩 넣었다. 바꾸지 않은 사본은 51개 중 통과 50·건너뜀 1. A3(`ci-kind.yml` 잡 `kind`에 `concurrency:`)·A4(`ci.yml` 잡 `kind`에 따옴표 키 `"concurrency":`)는 CC-04가 각각 실패('ci-kind.yml의 잡 kind에 concurrency가 있다'·'ci.yml의 잡 kind에 concurrency가 있다'), A5(규칙 4가 `cancel-in-progress:` 줄을 건너뜀)는 CC-03 대조 단언이 끝 코드 0으로 실패했다. 셋 다 51개 중 실패 1.
- CC-05 ★(RV-02, 소유자 결정 (다), 2026-11-19 07:17): 구현 전 머리 `0650d4f6`(`ci.yml` 127줄 `mode:` 그대로)에서 52개 중 통과 50, 실패 1, 건너뜀 1. 실패는 CC-05이고 첫 단언이 `push refs/heads/develop changes=success specs=true specs_full=true: mode`에서 실제 `full`(기대 `pr`)이다. 그 mode면 `spec-check.yml` `runs-on` 식은 `peaket-runner2`다. 임시 사본(`git worktree add --detach`, 끝나고 지움)에 계획 4의 고친 식을 넣으면 52개 중 통과 51, 건너뜀 1로 통과한다(작업 폴더의 `ci.yml`은 고치지 않았다).

## 시험 결과

- 작업 폴더(`f81981e1` + 이 시험)에서 `node --test tools/ci/check-workflows.test.mjs`: 50개 중 통과 49, 실패 0, 건너뜀 1(CI 밖 시험). CC-01·CC-02·CC-03 모두 통과.
- 리뷰 반영 뒤(CC-04·CC-03 대조 더함) 작업 폴더: 51개 중 통과 50, 실패 0, 건너뜀 1(CI 밖 시험). CC-04는 YAML 패키지가 없으면 건너뛰지만 CI에서는 기존 시험 'CI에서는_yaml패키지가있어_YAML시험을건너뛰지않는다'가 패키지가 있음을 지켜 꼭 돈다.

## 리뷰

- 본 것: `git diff 760f465b..0db4c91d`(커밋 셋), `ci.yml`의 `on:`·`concurrency:`, 다른 워크플로의 `concurrency:`·`runs-on:`, `tools/ci/changes.mjs`의 기준 커밋 처리, `check-workflows.mjs` 규칙 4, 정본 `docs/devops.md` §3.4 267줄.
- 계획대로 됐다. 구현 커밋 `f81981e1`은 `ci.yml` 18줄 한 줄과 이 파일 담당 표 한 줄만 고쳤고 시험 파일은 건드리지 않았다. 시험 커밋 `0db4c91d`는 시험 파일과 이 파일만 고쳤다. 정본 줄(계획 커밋 `b9f87ea3`)과 `ci.yml` 값이 글자까지 같다.
- 동작 확인(지적 아님):
  - `cancel-in-progress:`에 식을 쓰는 꼴은 맞다. GitHub 문서 예시도 `${{ !contains(github.ref, 'release/') }}`처럼 식을 쓰고, 워크플로 맨 위 `concurrency`에서는 `github`·`inputs`·`vars` 문맥을 쓸 수 있다. `'pull_request'` 작은따옴표도 맞다.
  - 기다리는 실행: 한 그룹에는 도는 실행 하나와 기다리는 실행 하나만 있을 수 있다. 새 실행이 들어오면 `cancel-in-progress`와 상관없이 앞서 기다리던 것이 취소된다. 그래서 정본의 '가장 새 것 하나만 남는다'는 맞다.
  - 그룹은 섞이지 않는다. PR은 `ci-<번호>`, 가지 푸시는 `ci-refs/heads/<가지>`이고, 푸시 대상(`develop`·`main`·`release/**`·`hotfix/**`)은 PR 머리 가지가 아니다. `on:`에는 `pull_request`·`push`만 있고 `workflow_dispatch`·`schedule`은 없어 같은 그룹을 쓰는 다른 사건은 없다. 나중에 더해도 `event_name`이 `pull_request`가 아니라 취소하지 않고 같은 가지 푸시와 차례만 나눈다. `ci.yml`이 부르는 재사용 워크플로에는 `concurrency:`가 없어 부모 그룹과 부딪치지 않는다.
  - 규칙 4: `check-workflows.mjs` 213줄은 파일 모든 줄의 `${{ }}`를 보므로 맨 위 `concurrency` 블록도 검사 대상이다. `github.event_name`은 `github.event` 아래 경로가 아니라 통과한다.

| # | 심각도 | 자리 | 지적 | 고칠 것 |
| --- | --- | --- | --- | --- |
| RV-01 | 중간 | `docs/devops.md` 267줄 '결과가 남지 않기 때문이다', `ci.yml` `changes` 잡 `BASE_SHA` | 기다리다 취소된 가운데 푸시의 바뀐 파일은 다음 실행이 검사하지 않는다. 가지 푸시의 기준 커밋이 `github.event.before`(바로 앞 푸시 끝)라 `changes.mjs`가 마지막 푸시의 차이로만 범위를 고르기 때문이다. 예: 푸시 A가 돌고, B(명세 고침)가 기다리다 C(문서만)가 들어와 B가 취소되면, C 실행은 문서 범위만 돌고 B의 명세 검사는 `develop`에서 끝내 돌지 않는다. 고치기 전(전부 취소)보다 낫지만, 정본 문장은 결과가 커밋마다 남는 것처럼 읽힌다. 갈래는 PR 없이 `develop`에 바로 합치므로(ADR-0222) 이 실행이 유일한 검사다. | 이번 묶음에서는 정본 줄에 한계 한 문장을 더한다('가운데 푸시가 취소되면 그 바뀐 파일은 범위 검사에서 빠진다'). 바로잡기(가지 푸시는 마지막으로 끝까지 돈 실행의 커밋을 기준으로 하거나 `develop` 푸시는 전체 범위)는 따로 묶음을 만든다. |
| RV-02 | 중간 | `spec-check.yml` 63줄 `runs-on`, 계획 §5 | 앞 실행을 끝까지 돌리면 표준 러너만 쓰는 것이 아니다. `develop` 푸시에서 `specs_full`이 참이거나 `changes`가 실패하면 `spec-check`가 `mode: full`로 돌고, `large` 묶음은 저장소 변수 `PEAKET_LARGE_RUNNER`(지금 `peaket-runner2`로 설정됨)의 큰 러너로 간다. 큰 러너는 공개 저장소에서도 분 단위로 돈을 낸다. 전에는 다음 푸시가 이 실행을 중간에 끊어 돈이 덜 들었다(대신 결과가 없었다). 나머지 잡은 `ubuntu-24.04`·`ubuntu-24.04-arm` 표준 러너라 공개 저장소에서 무료다. 계획과 정본 어디에도 이 비용 변화가 없다. | 계획 §5나 정본 줄에 '큰 러너 잡은 끝까지 돌아 그만큼 분이 늘어난다'를 적고, 소유자 비용 한도(외부 비용 없이)와 맞는지 소유자 확인을 받는다. 코드는 바꾸지 않아도 된다. |
| RV-03 | 낮음 | `check-workflows.test.mjs` CC-03 | CC-03은 끝 코드 0만 본다. 규칙 4가 `concurrency` 블록을 아예 보지 않게 바뀌어도 이 시험은 통과하므로, 이름의 '맨 위 concurrency 블록에 두어도' 부분은 실제로 지키지 못한다. | 같은 표본의 `concurrency` 블록에 `${{ github.head_ref == 'x' }}`를 넣으면 끝 코드가 0이 아님을 보는 대조 단언을 하나 더한다(검증 담당 판단, 막는 지적 아님). |

- 막는 지적은 없다. `ci.yml` 고침은 그대로 합쳐도 된다. RV-01·RV-02는 문서 한두 문장과 소유자 확인이고, RV-01의 바로잡기는 다른 묶음 몫이다.
- RV-02는 소유자 결정 (다)(2026-11-19)로 처리: 가지 푸시는 spec-check 전수 검사를 돌리지 않는다(아래 리뷰 반영 계획 4).

## 리뷰 반영 계획

2026-11-19 전체 감독 결정과 검증 지적을 둘째 계획 커밋에 반영한다.

1. RV-01: `docs/devops.md` §3.4 concurrency 줄에 한계 한 문장을 더했다(가지 푸시는 `github.event.before`와만 견줘 범위를 고르므로 밀려 취소된 가운데 푸시의 바뀐 파일은 어떤 실행도 범위 검사를 하지 않는다). 바로잡기는 뒤 묶음 W11-ci-range.
2. 검증 '기준 대조': 그룹 값 `ci-${{ github.event.pull_request.number || github.ref }}`를 같은 정본 줄에 적었다. CC-01의 그룹 단언은 이제 정본 근거가 있다.
3. 시험 담당이 더할 것:

| 시험 | 사건 | 단언 |
| --- | --- | --- |
| CC-04 | `ci.yml`과 `ci.yml`이 `uses: ./.github/workflows/*.yml`로 부르는 워크플로를 YAML로 읽음(검증 A3·A4) | 어느 잡에도 `concurrency` 키가 없고, `concurrency`는 `ci.yml` 맨 위에만 있다 |
| CC-03 대조 | 같은 표본의 `concurrency` 블록에 `${{ github.head_ref == 'x' }}`(검증 A5, RV-03) | 끝 코드 1. 통과 기준 밖이지만 한 줄이라 함께 더한다 |

- CC-04는 바른 구현에서 통과하고 A3·A4 결함을 넣으면 실패해야 한다. 검증 담당은 고친 뒤 A3~A5를 다시 넣어 본다.

4. RV-02 — 소유자 결정 (다)(2026-11-19): 가지 푸시에서는 spec-check 전수 검사(full, 큰 러너)를 돌리지 않는다. PR(초안 PR 포함)과 일정 실행이 맡는다.
   - 구현 몫(가장 작은 고침): `ci.yml` 127줄 `mode:` 식 앞에 `github.event_name == 'pull_request' &&`를 붙이고 기존 조건은 괄호째 둔다. `mode: ${{ github.event_name == 'pull_request' && (needs.changes.result != 'success' || needs.changes.outputs.specs_full == 'true') && 'full' || 'pr' }}`. 가지 푸시는 늘 `pr`(형식 검사·시뮬레이션, 표준 러너)이다. 124줄 `if:`와 `spec-check.yml`은 그대로 둔다. `spec-check.yml` 63줄 `runs-on`은 full에서만 큰 러너를 쓰므로 큰 러너 잡이 뜨지 않는다. 121줄 잡 주석도 'PR에서만 전수 검사'로 맞춘다. 규칙 4: `github.event_name`은 통과한다.
   - 일정 실행 확인: `spec-check.yml`의 `schedule`(`cron: '0 18 * * 0'`, 월요일 03:00 KST, 주 1회)은 `inputs.mode`가 비어 `list` 잡 `MODE`가 `full`이고 `large` 묶음은 큰 러너로 간다. 그대로 둔다.
   - 정본(이 커밋): `docs/devops.md` §3.4 concurrency 줄, `docs/verification.md` §2.2 표 CI 행('관련 ADR이 바뀌는 PR에서'), ADR-0187 '결과와 트레이드오프'에 한 줄. RV-01 한계 문장은 §3.4에 이미 있다(확인).
   - 시험 담당이 더할 CC-05 ★: YAML로 `ci.yml` 잡 `spec-check`의 `if`·`with.mode`, `spec-check.yml`의 `on.schedule`·`list` 잡 `MODE`·`spec` 잡 `runs-on` 식을 읽는다. 시험 안 작은 평가기(문맥 이름을 값으로 바꾸고 `&&`·`||`·`==`·`!=`·`!`·괄호·작은따옴표 글자·`cancelled()`만 받음, 모르는 이름이면 던짐)로 센다. 큰 러너 변수는 `peaket-runner2`, `matrix.large`는 참으로 둔다.
     - push(`refs/heads/` 아래 `develop`·`main`·`release/x`·`hotfix/x`) × `changes` 결과 success·failure × `specs_full` 참·거짓: 잡이 불리지 않거나(`if` 거짓) `mode`가 `pr`이고, 그 mode의 `runs-on`이 `ubuntu-24.04`.
     - pull_request(포크 아님): `changes` 실패 또는 `specs_full` 참이면 `full`과 `peaket-runner2`, 둘 다 아니면 `pr`.
     - schedule(`spec-check.yml` 직접, `inputs.mode` 빔): `on.schedule`이 있고 `MODE`가 `full`, `runs-on`이 `peaket-runner2`.
     - 구현 전 트리에서는 push + (`specs_full` 참 또는 `changes` 실패) 사례가 `full`이라 실패한다.
   - 틀린 구현 표본:

| # | 틀린 구현 | 잡을 시험 |
| --- | --- | --- |
| S1 | `spec-check.yml` `runs-on`만 고쳐 push에서 표준 러너로 full(잡 130분 넘음) | CC-05(push `mode`) |
| S2 | 거꾸로 `github.event_name == 'push' &&` | CC-05 |
| S3 | 괄호 없이 앞에 붙임(push + `specs_full` 참이면 `full`) | CC-05 |
| S4 | PR에서 `changes` 실패 대비를 뺌 | CC-05(PR + 실패) |
| S5 | `spec-check.yml` `MODE` 기본값을 `inputs.mode \|\| 'pr'`로(일정 실행이 full 아님) | CC-05(schedule) |
| S6 | `if:`에 `github.event_name == 'push' &&`를 넣어 PR에서 건너뜀 | CC-05(PR) |

   - 감독에게: 소유자 결정의 '야간'은 지금 주 1회(월요일 03:00 KST) 일정이다. 매일로 바꿀지 정해 주면 따른다(바꾸지 않으면 손대지 않음). 또 이 고침은 `develop`뿐 아니라 `main`·`release/**`·`hotfix/**` 푸시에서도 full을 돌리지 않는다(그 가지에 들어가는 변경은 PR을 거친다).

## 검증

2026-11-19 검증 담당 `w11ci-verify-9f13`(claude-opus-5-5)가 `d2e6d20d` 트리로 했다. 계획·시험·구현·리뷰에는 관여하지 않았다. 결함은 작업 폴더 밖 임시 사본(`git worktree add --detach`, `node_modules`는 디렉터리 연결, 끝나고 연결을 끊고 `worktree remove --force`)에서 하나씩 넣고, 넣을 때마다 `node --test tools/ci/check-workflows.test.mjs`와 `node tools/ci/check-workflows.mjs`를 돌린 뒤 바로 되돌렸다. 바꾸지 않은 사본에서는 50개 중 통과 49, 건너뜀 1(CI 밖 시험)이고 검사는 '통과: 워크플로 19개'였다. 사본에 YAML 패키지가 있어 YAML 시험도 돌았다.

**틀린 구현 검사(C 등급, ADR-0283 결정 2)**

- 넣은 수 11, 잡힌 수 8, 놓친 수 3. 계획 4의 표본 M1~M6은 6개 모두 잡혔다. 검증 담당이 더한 A1~A5 가운데 A1·A2가 잡혔다. `check-workflows.mjs`는 열한 결함 모두에서 끝 코드 0이었다(계획 1의 4대로 concurrency 값은 시험만 본다).
- 잡힌 것(결함 → 실패한 시험):

| # | 넣은 결함 | 실패한 시험 |
| --- | --- | --- |
| M1 | `cancel-in-progress: false` | CC-01 |
| M2 | `${{ github.event_name == 'push' }}` | CC-01 |
| M3 | 큰따옴표 `"pull_request"` | CC-01 |
| M4 | `group: ci` | CC-01 |
| M5 | 맨 위는 `true` 그대로, 잡 `kind`에 `concurrency:`(`cancel-in-progress: false`) 블록 | CC-01, CC-02 |
| M6 | `cancel-in-progress:` 줄을 지움 | CC-01, CC-02(줄 0개) |
| A1 | `${{ github.ref != 'refs/heads/develop' }}`(`main`·릴리스·핫픽스 푸시는 취소) | CC-01 |
| A2 | 바른 줄 아래 `cancel-in-progress: true`를 한 줄 더(같은 키 둘) | CC-01, CC-02, BSL050(YAML 읽기 실패) |

- 시험마다 한 번 이상 실패를 보았다(CC-01·CC-02). CC-03은 아래 A5대로 실패하지 않았다.

**놓친 것과 처리(ADR-0283 결정 2)**

| # | 놓친 결함 | 까닭 | 처리 |
| --- | --- | --- | --- |
| A3 | `ci.yml`이 부르는 재사용 워크플로 `ci-kind.yml`의 첫 잡에 `concurrency:`(`group: kind-${{ github.ref }}`, `cancel-in-progress: true`)를 더함. `develop` 푸시가 이어지면 다음 실행의 `kind` 잡이 앞 실행의 `kind` 잡을 취소해 앞 실행의 `ci-summary`가 '취소'를 실패로 센다 | CC-01·CC-02는 `ci.yml` 한 파일만 줄로 읽는다. 리뷰가 '부르는 재사용 워크플로에는 `concurrency:`가 없다'고 확인한 것을 지키는 시험이 없다 | **이 묶음에서 시험 더함**(통과 기준 'develop 푸시는 취소하지 않는다'에 걸린다). 시험 담당에게: CC-04로 `ci.yml`과 `ci.yml`이 `uses: ./.github/workflows/*.yml`로 부르는 워크플로 모두에서 잡 단위 `concurrency` 키가 없고, `concurrency`는 `ci.yml` 맨 위에만 있음을 단언한다(아래 A4도 함께 잡도록 YAML로 읽어 키 이름을 본다) |
| A4 | `ci.yml` 잡 `kind`에 따옴표 키 `"concurrency":`(`group: kind-${{ github.ref }}`, `"cancel-in-progress": true`)를 더함. YAML로는 보통 키와 같아 A3과 같은 결과다 | CC-02가 줄 앞머리 `concurrency:`·`cancel-in-progress:`만 세어 따옴표 키를 보지 못한다. CC-02 이름의 '잡에 따로 두어 맨 위 규칙을 덮지 않는다'를 이 꼴에서는 지키지 못한다 | **이 묶음에서 시험 더함**(통과 기준에 걸린다). 위 CC-04를 YAML로 읽으면 함께 잡힌다. 꼴이 드물어 CC-02를 고치지 않고 CC-04에 맡겨도 된다 |
| A5 | RV-03 확인: `check-workflows.mjs` 규칙 4가 맨 위 `concurrency` 블록 줄을 건너뜀 | CC-03은 끝 코드 0만 본다. 대조로 바꾸지 않은 검사에 `ci.yml` 18줄을 `${{ github.head_ref == 'x' }}`로 바꿔 넣으면 끝 코드 1과 '사용자가 고칠 수 있는 값' 줄이 나왔고, 이 결함에서는 끝 코드 0이었다. 시험 50개는 모두 그대로 통과했다. 지금 검사는 맞게 동작한다 | 정리 목록으로(통과 기준 밖, 리뷰 RV-03과 같은 줄기). 고칠 때는 CC-03 표본의 `concurrency` 블록에 `github.head_ref`를 넣어 끝 코드가 0이 아님을 보는 대조 단언을 더한다 |

**기준 대조(정본 값과 시험 단언)**

- 취소 식: CC-01의 기대값 `${{ github.event_name == 'pull_request' }}`가 정본 `docs/devops.md` 267줄의 값과 글자까지 같다. 시험은 코드에서 값을 가져오지 않고 시험 파일 안 글로 적었다.
- 그룹 값 `ci-${{ github.event.pull_request.number || github.ref }}`은 정본 줄에 적혀 있지 않고 계획 1의 1('그대로 둔다')과 구현 전 `ci.yml`에서 왔다. 정본에 없는 값을 시험이 묶는 것이라 어긋남은 아니지만, 바꿀 일이 생기면 정본 근거가 없다(정리 목록, 막는 일 아님).
- 정본의 '`develop`·`main`·릴리스·핫픽스 가지 푸시'는 식이 `pull_request`가 아니면 모두 거짓이라 CC-01 하나로 덮인다(A1이 확인). '기다리는 실행은 가장 새 것 하나'는 GitHub 동작이라 시험 대상이 아니다.
- 이름과 단언이 어긋난 시험 둘: CC-02(따옴표 키·부르는 워크플로를 보지 못함, 위 A3·A4), CC-03(RV-03, 위 A5). 그 밖에는 찾지 못했다.

**고친 곳 확인**

2026-11-19 07:26~07:33 같은 검증 담당이 머리 `d3f8f605`(시험 `0aab575d` CC-04·CC-03 대조, `ec1cb8a5` CC-05, 구현 `d3f8f605` `ci.yml` `mode:` 식) 트리로 했다. 앞과 같은 임시 사본 방식(`node_modules` 디렉터리 연결, 끝나고 연결을 끊고 `worktree remove --force`)으로 결함을 하나씩 넣고 `node --test tools/ci/check-workflows.test.mjs`·`node tools/ci/check-workflows.mjs`를 돌린 뒤 되돌렸다. 바꾸지 않은 사본에서는 실패 0, 검사 끝 코드 0이었다.

- 넣은 수 9, 잡힌 수 9, 놓친 수 0. 계획 '리뷰 반영 계획' 4의 S1~S6은 모두 CC-05가, 앞서 놓친 A3·A4는 CC-04가, A5는 CC-03 대조 단언이 잡았다. `check-workflows.mjs`는 아홉 모두에서 끝 코드 0이었다(값은 시험만 본다).

| # | 넣은 결함 | 실패한 시험(첫 단언) |
| --- | --- | --- |
| S1 | `mode:`를 고치기 전 식으로 되돌리고 `spec-check.yml` `runs-on`에 `github.event_name != 'push' &&`를 넣음(push에서 표준 러너로 full) | CC-05('push refs/heads/develop … specs_full=true: mode') |
| S2 | `github.event_name == 'push' &&` | CC-05(같은 단언) |
| S3 | 괄호 없이 앞에 붙임 | CC-05(같은 단언) |
| S4 | PR에서 `changes` 실패 대비를 뺌(`specs_full`만 봄) | CC-05('pull_request … changes=failure … : mode') |
| S5 | `spec-check.yml` `list` 잡 `MODE`를 `inputs.mode \|\| 'pr'`로 | CC-05('일정 실행 list MODE') |
| S6 | 잡 `spec-check` `if:` 앞에 `github.event_name == 'push' &&` | CC-05('pull_request … specs_full=true: 잡이 불리지 않는다') |
| A3 | `ci-kind.yml` 첫 잡에 `concurrency:`(`cancel-in-progress: true`) | CC-04('ci-kind.yml의 잡 kind에 concurrency가 있다') |
| A4 | `ci.yml` 잡 `kind`에 따옴표 키 `"concurrency":` | CC-04('ci.yml의 잡 kind에 concurrency가 있다') |
| A5 | 규칙 4가 맨 위 `concurrency` 블록 줄을 건너뜀 | CC-03 대조 단언 |

- 대조: 바꾸지 않은 검사에 `ci.yml` 18줄을 `${{ github.head_ref == 'x' }}`로 바꾸면 끝 코드 1, A5를 넣으면 0이었다. 결함이 실제로 규칙 4를 끈 것을 확인했다.
- 셈에서 뺀 것 하나: 규칙 4가 `cancel-in-progress:`로 시작하는 줄만 건너뛰게 한 꼴은 위 대조에서도 끝 코드가 1이라(검사의 다른 길이 여전히 잡음) 규칙 4를 끄지 못한 결함이다. 잡힘·놓침 어느 쪽으로도 세지 않았다.
- 통과 기준(가지 푸시는 취소하지 않고 큰 러너 전수 검사를 띄우지 않음, PR은 취소하고 조건이 맞으면 전수 검사)에 걸린 놓침이 없어 '시험 더함 필요'는 없다. CC-05의 기대값(push는 `pr`·`ubuntu-24.04`, PR은 `changes` 실패나 `specs_full` 참일 때 `full`·`peaket-runner2`, 일정 실행은 `full`·큰 러너)은 정본 `docs/devops.md` §3.4 소유자 결정 (다) 문장과 같다.

## 확인

- 기록(갈래 4 감독, 2026-11-19): 커밋 13개(계획 4·구현 1·시험 1·리뷰 1·리뷰 반영 4·검증 2·기록 1), 06:05~07:40.
- 리뷰 RV-02(큰 러너 비용)는 소유자 결정 2026-11-19 (다) PR·일정만으로 처리: 가지 푸시에서 spec-check는 늘 pr 모드(표준 러너), 일정 실행(주 1회 월 03:00 KST)은 그대로 full. RV-01(밀려 취소된 가운데 푸시 범위)은 정본에 한계 한 문장, 바로잡기는 뒤 묶음 W11-ci-range. ADR을 바꾸는 묶음은 초안 PR CI를 꼭 거친다(정본 한 문장).
- 틀린 구현: 첫 검증 11/8(놓친 A3·A4·A5는 CC-04·CC-03 대조로 시험 더함), 고친 곳 확인 9/9.
- 게이트: `check-workflows.test.mjs` 52(통과 51·건너뜀 1), `check-workflows.mjs` 19개 통과, roles-check 통과, doc-check 오류 0. GitHub에서 고친 ci.yml을 받아들이는지는 합친 뒤 develop 첫 실행으로 본다.

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | w11ci-plan-1b7c | claude-opus-5-5 | 2026-11-19T06:05+09:00 | 2026-11-19T07:14+09:00 |
| impl | w11ci-impl-4e90 | claude-opus-5-5 | 2026-11-19T06:15+09:00 | 2026-11-19T06:17+09:00 |
| test | w11ci-test-7a35 | claude-opus-5-5 | 2026-11-19T06:17+09:00 | 2026-11-19T07:19+09:00 |
| review | w11ci-review-2c58 | claude-opus-5-5 | 2026-11-19T06:22+09:00 | 2026-11-19T06:30+09:00 |
| verify | w11ci-verify-9f13 | claude-opus-5-5 | 2026-11-19T06:27+09:00 | 2026-11-19T07:34+09:00 |
