# F-09-8 kind 재가동·야간 실행 복구 기록

이 파일은 F-09-8(INF-010·INF-030·INF-040)의 실행 기록이다. 절차는 `docs/runbooks/F-09-8-kind-nightly-recovery.md`, 장부 재확인 표는 `docs/review/measurements/F-09-8-kind-recheck.md`를 따른다. 실행하지 않은 것은 `건너뜀`과 까닭을 적고 통과로 세지 않는다.

- **상태**: 대기(리뷰 준비). 실행 차례에 아래 절을 채운다.
- **가지**: `freeze/lane1-F-09-8`(출발 `8a7081d94`). `develop`·`release/1.0.0`에 합치지 않는다.
- **동결 로컬 범위**: INF-020의 배포 묶음은 하지 않는다. kind 재가동·ci-kind 시험·DAST·야간 성능 수동 실행·kind 장부 재확인만 한다.

## 환경

| 무엇 | 값 |
| --- | --- |
| 날짜 | 대기 |
| 커밋 | 대기 |
| PC·OS | 대기 |
| Node·pnpm | 대기 |
| Docker 엔진 | 대기 |
| kind·kubectl·helm 판 | 대기(`tools/local/README.md`의 고정 판과 견준다) |
| 클러스터 이름·포트 | `freeze-f098`·`18641~18645` |
| Docker 잠금 | 대기(잡은 시각·놓은 시각) |

## kind 재가동

| 차례 | 명령 | 결과 | 걸린 시간 | 메모 |
| --- | --- | --- | --- | --- |
| 클러스터 | `node tools/local/cluster.mjs up` | 대기 | 대기 | — |
| 상태 | `node tools/local/cluster.mjs status` | 대기 | 대기 | — |
| 이미지 | `node tools/local/cluster.mjs image` | 대기 | 대기 | — |

## 실패와 고침

| 시험·단계 | 실패 줄 | 원인 | 고침 | 다시 실행 | 남은 위험 |
| --- | --- | --- | --- | --- | --- |
| 대기 | 대기 | 대기 | 대기 | 대기 | 대기 |

- 마지막 통과 커밋 `fe21934d`(2026-11-19) 뒤에 바뀐 것을 먼저 본다(ADR-0332 맥락: Kyverno 입장 시험, 게이트웨이 e2e, 데모 시드).
- 고침이 시험 파일을 바꿔야 하면 멈추고 시험 담당에게 넘긴다(ADR-0372 결정 3).

## 야간 수동 실행

| 무엇 | 명령 | 결과 | 숫자·판정 | 메모 |
| --- | --- | --- | --- | --- |
| DAST | `node --test --test-timeout=900000 tools/local/e2e/dast.e2e.mjs` | 대기 | High 0? | 기본 가지 예약은 병합 뒤 몫 |
| 야간 성능 실행 | `python -I -X utf8 tools/perf-ledger/nightly.py run --config loadtest/nightly/config.json --out .cache/nightly-results.json --deadline-s 7000` | 대기 | — | 가장 최근 출시 태그가 기준판 |
| 야간 성능 비교 | `python -I -X utf8 tools/perf-ledger/nightly.py compare --results .cache/nightly-results.json --threshold loadtest/nightly/threshold.json --alert-out .cache/nightly-alert.md` | 대기 | `max_ratio`와 견준 비율 | 기준값은 소유자·감독 결정 없이 바꾸지 않는다 |

## 장부 재확인

| 항목 | 상태 | 근거 |
| --- | --- | --- |
| 대기 | 대기 | `docs/review/measurements/F-09-8-kind-recheck.md` |

- 상태가 바뀐 항목만 `docs/review/ledger-notes.md`를 고치고, 장부 파일은 `node tools/ci/ledger.mjs`로 다시 쓴다.
- 실행하지 않은 항목을 `통과`로 적지 않는다. `동결`은 까닭을 적는다.

## 정리

| 무엇 | 결과 |
| --- | --- |
| 이 가지 클러스터 | 대기(`PEAKET_CLUSTER=freeze-f098 node tools/local/cluster.mjs down`) |
| 다른 클러스터·컨테이너 | 대기(그대로인지 확인) |
| Docker 잠금 | 대기(놓은 시각) |
| 남은 포트·`.cache` | 대기 |
