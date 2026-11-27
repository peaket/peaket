# F-08-5 장시간 시험 보고서(창 4a queue-svc)

- **상태**: **부분 측정**. 2026-11-27 10:22:42~16:53:40 KST에 queue-svc 4a 6시간을 돌렸고, 발생기 `dropped_iterations` 2014로 **무효**다. purchase-svc 4a·4b·4c·V-T10은 아직 `미측정`이다.
- **정본**: `docs/verification.md` §3.6(장시간 시험)·V-T10(636행), `docs/architecture.md` §7 NFR-003·NFR-006·NFR-027, `docs/perf-ledger.md` §2.3·§7. 계획은 `docs/review/plans/F-08-5.md`다.
- **한 줄 결론**: queue-svc 4a는 **무효**다. 6시간을 채웠지만 발생기가 반복을 2,014건 시작하지 못했고, 본구간 `http_reqs`가 0이라 NFR-027 판정 근거가 없다. 자원 기울기는 참고값이며 `통과`로 쓰지 않는다. 30,000건/초·100만·K1/K2/K7의 새 수치를 주장하지 않는다.

## 1. 무대와 명령

- 측정 창 4a, Docker 잠금 `docker lane4-F-08-5`(09:54:24 잡음, 16:54:29 놓음), kind `lane4-f085`, 합본 queue-svc 단일·복제 3·CPU 1·메모리 2GiB·Redis TLS 켬.
- 실행: `node loadtest/run.mjs v1 soak --phase 4a --target queue-svc --rate 500 --duration-min 360 --warmup-min 30 --out .cache/peaket-f085/2026-11-27-queue-4a`
- 5,000명 진입(10초), 예열 30분, 본구간 6시간, 상태 조회·입장. 입장 28/s.
- 자원 표본은 `series.ndjson`에 1분 간격으로 391개 남겼다(실행 끝까지, 예열 뒤 유효 358개·null 2개).

## 2. 대상·세기

| 대상 | 세기 | 길이(분) | 판정 | 표시 | 실행 ID |
| --- | --- | --- | --- | --- | --- |
| queue-svc | 500 | 360 | 무효 | 무효 | 2026-11-27-f085-queue-4a |
| purchase-svc | 1000 | 360 | 미측정 | 미측정 | — |
| payment-svc | 150 | 360 | 미측정 | 미측정 | — |
| realtime-gw | 2500 연결·63/s | 360 | 미측정 | 미측정 | — |
| outbox-relay | 100 | 360 | 미측정 | 미측정 | — |

- NFR-027 종합: 무효(queue 4a), 나머지 미측정

## 3. 자원 지표(queue 4a, 참고값)

| 지표 | 시작값 | 시간당 기울기 | 기준(시작값 1%) | 판정 | 표시 | 실행 ID |
| --- | --- | --- | --- | --- | --- | --- |
| GC 뒤 힙 | 107.05 MiB | +0.126 MiB/h | 1.070 MiB/h | 기준 안 | 실측(PC) | 2026-11-27-f085-queue-4a |
| RSS | 220.32 MiB | +0.465 MiB/h | 2.203 MiB/h | 기준 안 | 실측(PC) | 2026-11-27-f085-queue-4a |
| 열린 FD | 53 | +0.071/h | 0.53/h | 기준 안 | 실측(PC) | 2026-11-27-f085-queue-4a |
| 활성 핸들 | 11 | -0.049/h | 0.11/h | 기준 안(감소) | 실측(PC) | 2026-11-27-f085-queue-4a |
| DB 연결 | 0 | 0/h | 0/h | 기준 안 | 실측(PC) | 2026-11-27-f085-queue-4a |
| Redis 연결 | 4 | 0/h | 0.04/h | 기준 안 | 실측(PC) | 2026-11-27-f085-queue-4a |

- 위 기울기는 **참고값**이다. 발생기 dropped 2014·본구간 요청 0으로 유효 부하가 유지되지 않아 NFR-027 `통과` 근거가 아니다.
- 표본 간격 최대 2.0002분(2분 기준을 0.0002분 초과), `limit_hit` 0, 재시작 0.
- p99·오류율: 본구간 `http_reqs{phase:main}` 0이라 `판정 못 함`. 전체 요청 p99 12.35ms는 참고값일 뿐 NFR-027 p99가 아니다.

## 4. NFR-027 판정

- **queue-svc 4a**: **무효**. 발생기 `dropped_iterations` 2,014건(VU 최대 112/400), `generator.judge.valid=false`. 본구간 상태 조회 요청이 0으로 집계돼 p99 첫/마지막 30분·오류 이항 상한을 판정할 수 없다. 재시작 0은 확인했다.
- **purchase-svc·payment-svc·realtime-gw·Outbox**: **미측정**. 4a~4c의 나머지 창을 아직 열지 않았다.
- V-T10: **미측정**. 이번에 돌리지 않았다.

## 5. 누수 주입 대조

| 구분 | 무대 | 대상 | 세기 | 길이(분) | 누수율 | FD 시작 | 판정 | 표시 | 실행 ID |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 누수 | 4c | purchase-svc | 1000 | 360 | 10분에 1개 | 100 | 미측정 | 미측정 | — |
| 고친 | 4a | purchase-svc | 1000 | 360 | — | 100 | 미측정 | 미측정 | — |

- V-T10 종합: 미측정

## 6. 한계

- 서비스 하나씩이라 클러스터 규모 누수와 6시간보다 긴 주기 누수는 보지 못한다. queue 4a는 발생기 한계로 무효다.
- 누수 판 4c와 고친 판 4a는 다른 무대 인스턴스다(DB·Redis·Kafka가 새것).

## 7. 게이트·장부

- 성능 장부: `docs/perf-ledger/runs/2026-11-27-f085-queue-4a/`(valid=false, `dropped_iterations 2014`).
- `node --test loadtest/test/f085-soak.test.mjs` 8/8, `node --check`·`eslint` 0, `pnpm lint` 0, doc-check 오류 0·경고 12, ledger `--batch F-08-5` V-T10 빈칸 1, release-scope 통과.

## 8. 주장하지 않는 것

- 30,000건/초·100만·K1/K2/K7은 주장하지 않는다(문서 인용만).
- queue 4a의 자원 기울기를 NFR-027 통과 근거로 쓰지 않는다.
