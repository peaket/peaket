# 작업 계획: W11-lanes(기록 크기 점검에 lane4·lane5 더하기)

- **무엇**: ADR-0286 '확인'의 둘째 줄. 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane4`(가지 `feature/lane4-W11-lanes`, 출발점 `origin/develop` `08120a67`), 구현 전 트리 `D:/ticketpass-lane4-base`(`08120a67`, 커밋 금지). 시험은 `node --test tools/ci/records.test.mjs`(node 내장만).
- **등급·차례**: B, 정방향(`Batch-Order: impl-first`), ADR-0283 결정 2의 짧은 고리: 계획 → 구현 → 시험(실패 확인을 같은 커밋) → 리뷰 → (반영) → 검증 → 기록.
- **정본**: ADR-0283 결정 1(상한 40,960바이트, 줄 끝 LF로 센 UTF-8 바이트), ADR-0286 결정 1·4와 '확인'.

## 계획

### 1. 범위와 바른 동작

1. 크기를 보는 파일은 여섯이다: `docs/PROGRESS.md`, `docs/lanes/lane1.md`~`lane5.md`. 목록은 이름을 하나씩 적는다(폴더 훑기·글롭 아님). 갈래 6·7은 ADR-0286 결정 7로 열 때 그 묶음이 더한다.
2. 보지 않는 파일: 정리 목록 `docs/lanes/lane*-cleanup.md`(갈래 4·5 것 포함), `docs/progress-archive.md`, 감독 기록 `docs/lanes/coord.md`, 목록 밖 갈래 6 파일(`docs/lanes/` 아래 `lane6.md`).
3. 나머지(상한·`>` 비교·CRLF·`--check` 1·맞추기 경고·없는 파일 건너뛰기·`--next-r`)는 W10-guards G1 그대로다. 갈래 4·5 파일이 없어도 경고하고 건너뛴다(다른 파일은 본다).
4. 파일 목록을 적은 글을 맞춘다: `records.mjs` 머리 주석 11~13줄, `tools/ci/README.md` `records.mjs` 행.
5. 정본 빈칸(이 계획 커밋에서 고침): ADR-0283 결정 1과 `docs/architecture.md` §8.6 4 '10. 기록과 커밋'이 `lane1.md`~`lane3.md`라 적어 `lane5.md`까지로 고쳤다. `docs/PROGRESS.md` 15줄 '기록 상한'도 `lane1.md`~`lane3.md`라 적지만, ADR-0286 결정 4가 갈래 2~5에 PROGRESS를 고치지 못하게 하므로 **전체 감독에게 넘긴다**(기록 단계): `` `docs/lanes/lane1.md`~`lane3.md`. `` → `` `docs/lanes/lane1.md`~`lane5.md`. ``, 뒤 괄호에 '감독 기록 `coord.md`'도 뺀다고 더함.

### 2. 손댈 파일

| 담당 | 파일 | 할 일 |
| --- | --- | --- |
| 구현 | `tools/ci/records.mjs` | `RECORD_SIZE_FILES`(289줄)에 두 경로, 머리 주석 |
| 구현 | `tools/ci/README.md` | `records.mjs` 행의 파일 목록 |
| 시험 | `tools/ci/records.test.mjs` | `LANES`(426줄)를 다섯으로, 아래 시험 |

### 3. 시험 목록

- 값(경로 여섯, 40,960)은 정본에서 글로 적고 `records.mjs` 상수를 가져오지 않는다. 기존 `sized`·`sizedRepo`·`cli`를 쓴다. ★는 구현 전 트리에서 실패해야 한다.

| 시험 | 사건 | 단언 |
| --- | --- | --- |
| RS-03 ★ | `LANES`를 다섯으로 늘려 lane4·lane5 사례가 생김 | 그 파일만 40,961바이트면 1과 그 경로·`40961` 줄, 다른 다섯 경로 없음 |
| RS-04 | 기존 넷에 `lane4-cleanup.md`·`lane5-cleanup.md`·`docs/lanes/coord.md`(각 100,000바이트) 더함 | 0, 출력에 `cleanup`·`coord` 없음 |
| RS-10 ★ | 기존 사례에 'lane4 없음 + lane5 40,961바이트' 더함, 뒤 사례 이름을 '여섯 파일이 모두 없으면' | 1과 `docs/lanes/lane5.md` 줄 / 모두 없으면 0 |
| RS-12 ★ | 여섯 파일 모두 40,961바이트 | 1, 여섯 경로가 서로 다른 줄에 하나씩 |
| RS-13 | 목록 밖 `lane6.md`(`docs/lanes/` 아래) 40,961바이트(나머지 작게) | 0, 출력에 `lane6` 없음 |

- RS-01·02·05~09·11은 그대로 통과해야 한다(`sizedRepo`가 여섯 파일을 작게 둔다).
- RS-04·RS-13은 구현 전에도 통과한다. 아래 4의 M3·M4·M5로 실패를 본다.

### 4. 틀린 구현 표본(검증 담당용)

| # | 틀린 구현 | 잡을 시험 |
| --- | --- | --- |
| M1 | lane4만 더함 | RS-03(lane5), RS-10, RS-12 |
| M2 | lane5만 더함 | RS-03(lane4), RS-12 |
| M3 | `docs/lanes/lane*.md` 글롭(정리 목록도 봄) | RS-04 |
| M4 | `docs/lanes/`의 `.md`를 모두 보되 `-cleanup`만 뺌(coord 봄) | RS-04 |
| M5 | `lane\d+\.md`로 폴더 훑기(lane6도 봄) | RS-13 |
| M6 | 경로 오타(`docs/lanes/` 아래 `lane-4.md`, `docs/` 바로 아래 `lane5.md`) | RS-03, RS-12 |
| M7 | 목록을 고치다 `docs/PROGRESS.md`를 빠뜨림 | RS-01·02·12 |
| M8 | 새 두 파일이 없으면 2로 끝남 | RS-10 |

### 5. 범위 밖

- `docs/PROGRESS.md` 고치기(위 1의 5, 감독 몫), 갈래 6·7 파일, `records.mjs --check`를 CI에 걸기(W10 RV-01 정리 목록), `lane4.md`·`lane5.md` 글 정리(지금 2.4KB로 상한 안).

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
| plan | w11-lanes-plan-4a1c | claude-opus-5-5 | 2026-11-18T20:44+09:00 | 2026-11-18T20:51+09:00 |

- 다른 담당은 자기 커밋에서 이 표에 자기 행을 더한다.
