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

## 시험 결과

- 작업 폴더(`f81981e1` + 이 시험)에서 `node --test tools/ci/check-workflows.test.mjs`: 50개 중 통과 49, 실패 0, 건너뜀 1(CI 밖 시험). CC-01·CC-02·CC-03 모두 통과.

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

## 검증

(아직)

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | w11ci-plan-1b7c | claude-opus-5-5 | 2026-11-19T06:05+09:00 | 2026-11-19T06:20+09:00 |
| impl | w11ci-impl-4e90 | claude-opus-5-5 | 2026-11-19T06:15+09:00 | 2026-11-19T06:17+09:00 |
| test | w11ci-test-7a35 | claude-opus-5-5 | 2026-11-19T06:17+09:00 | 2026-11-19T06:22+09:00 |
| review | w11ci-review-2c58 | claude-opus-5-5 | 2026-11-19T06:22+09:00 | 2026-11-19T06:30+09:00 |
