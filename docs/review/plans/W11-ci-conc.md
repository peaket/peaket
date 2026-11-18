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

(아직)

## 시험 결과

(아직)

## 리뷰

(아직)

## 검증

(아직)

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | w11ci-plan-1b7c | claude-opus-5-5 | 2026-11-19T06:05+09:00 | 2026-11-19T06:20+09:00 |
| impl | w11ci-impl-4e90 | claude-opus-5-5 | 2026-11-19T06:15+09:00 | 2026-11-19T06:17+09:00 |
