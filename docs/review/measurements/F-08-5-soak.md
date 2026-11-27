# F-08-5 장시간 시험 보고서(창 4a queue-svc·purchase-svc)

- **상태**: **부분 측정**. queue-svc 4a는 6시간을 돌렸지만 발생기 `dropped_iterations` 2,014로 **무효**, purchase-svc 4a는 2026-11-27 23:53:58~2026-11-28 00:25:43 KST(31분 45초)에 발생기 4GiB OOM으로 **무효**다. payment-svc·realtime-gw·Outbox·V-T10은 아직 `미측정`이다.
- **정본**: `docs/verification.md` §3.6(장시간 시험)·V-T10(636행), `docs/architecture.md` §7 NFR-003·NFR-006·NFR-027, `docs/perf-ledger.md` §2.3·§7. 계획은 `docs/review/plans/F-08-5.md`다.
- **한 줄 결론**: queue-svc 4a와 purchase-svc 4a 모두 **무효**다. queue는 6시간을 채웠지만 발생기 dropped 2,014·본구간 요청 0이고, purchase는 본구간 전에 발생기가 OOM으로 죽어 6시간·p99·오류율을 판정할 수 없다. 자원 기울기는 참고값이며 `통과`로 쓰지 않는다. 30,000건/초·100만·K1/K2/K7의 새 수치를 주장하지 않는다.

## 1. 무대와 명령

- queue 4a: Docker 잠금 `docker lane4-F-08-5`(09:54:24 잡음, 16:54:29 놓음), kind `lane4-f085`, 합본 queue-svc 단일·복제 3·CPU 1·메모리 2GiB·Redis TLS 켬.
- queue 4a 실행: `node loadtest/run.mjs v1 soak --phase 4a --target queue-svc --rate 500 --duration-min 360 --warmup-min 30 --out .cache/peaket-f085/2026-11-27-queue-4a`
- queue 4a 부하: 5,000명 진입(10초), 예열 30분, 본구간 6시간, 상태 조회·입장. 입장 28/s. 자원 표본은 `series.ndjson`에 1분 간격 391개(실행 끝까지, 예열 뒤 유효 358개·null 2개)다.
- purchase 4a: Docker 잠금 `docker lane4-F-08-5`(19:33:36 잡음, 2026-11-28 00:48:53 놓음), 같은 kind·합본(purchase-svc 포함, 복제 3·CPU 1·메모리 2GiB·Redis TLS 켬).
- purchase 4a 실행: `node loadtest/run.mjs v1 soak --phase 4a --target purchase-svc --rate 1000 --duration-min 360 --warmup-min 30 --out .cache/peaket-f085/2026-11-27-purchase-4a-r10`
- purchase 4a 부하: 5,000명×2석 홀드→해제, 1,000/s, 예열 30분·본구간 6시간 계획. 실제 2026-11-27 23:53:58~2026-11-28 00:25:43 KST(31분 45초)에 발생기 4GiB `OOMKilled`로 끝나 본구간에 들어가지 못했다.
- purchase 4a 산출물: 자원 표본 `series.ndjson` 53개(1분, 마지막 20분은 부하 없음), 요청 기록은 `console.ndjson` 1/100 표본 11,315건, 발생기 `cgroup.log` 1,901줄, `k6.log`.

## 2. 대상·세기

| 대상 | 세기 | 길이(분) | 판정 | 표시 | 실행 ID |
| --- | --- | --- | --- | --- | --- |
| queue-svc | 500 | 360 | 무효 | 무효 | 2026-11-27-f085-queue-4a |
| purchase-svc | 1000 | 360 | 무효 | 무효 | 2026-11-27-f085-purchase-4a |
| payment-svc | 150 | 360 | 미측정 | 미측정 | — |
| realtime-gw | 2500 연결·63/s | 360 | 미측정 | 미측정 | — |
| outbox-relay | 100 | 360 | 미측정 | 미측정 | — |

- NFR-027 종합: 무효(queue 4a, purchase 4a), 나머지 미측정

## 3. 자원 지표(참고값)

### 3.1 queue 4a

| 지표 | 시작값 | 시간당 기울기 | 기준(시작값 1%) | 판정 | 표시 | 실행 ID |
| --- | --- | --- | --- | --- | --- | --- |
| GC 뒤 힙 | 107.05 MiB | +0.126 MiB/h | 1.070 MiB/h | 기준 안 | 실측(PC) | 2026-11-27-f085-queue-4a |
| RSS | 220.32 MiB | +0.465 MiB/h | 2.203 MiB/h | 기준 안 | 실측(PC) | 2026-11-27-f085-queue-4a |
| 열린 FD | 53 | +0.071/h | 0.53/h | 기준 안 | 실측(PC) | 2026-11-27-f085-queue-4a |
| 활성 핸들 | 11 | -0.049/h | 0.11/h | 기준 안(감소) | 실측(PC) | 2026-11-27-f085-queue-4a |
| DB 연결 | 0 | 0/h | 0/h | 기준 안 | 실측(PC) | 2026-11-27-f085-queue-4a |
| Redis 연결 | 4 | 0/h | 0.04/h | 기준 안 | 실측(PC) | 2026-11-27-f085-queue-4a |

- queue 4a 기울기는 **참고값**이다. 발생기 dropped 2,014·본구간 요청 0으로 유효 부하가 유지되지 않아 NFR-027 `통과` 근거가 아니다.
- queue 4a 표본 간격 최대 2.0002분(2분 기준 0.0002분 초과), `limit_hit` 0, 재시작 0.
- queue 4a p99·오류율: 본구간 `http_reqs{phase:main}` 0이라 `판정 못 함`. 전체 요청 p99 12.35ms는 참고값일 뿐 NFR-027 p99가 아니다.

### 3.2 purchase 4a

| 지표 | 시작값 | 시간당 기울기 | 기준(시작값 1%) | 판정 | 표시 | 실행 ID |
| --- | --- | --- | --- | --- | --- | --- |
| GC 뒤 힙 | 115.77 MiB | -0.534 MiB/h | 1.158 MiB/h | 판정 못 함(32분) | 실측(PC) | 2026-11-27-f085-purchase-4a |
| RSS | 260.40 MiB | -0.661 MiB/h | 2.604 MiB/h | 판정 못 함(32분) | 실측(PC) | 2026-11-27-f085-purchase-4a |
| 열린 FD | 61 | +1.584/h | 0.61/h | 판정 못 함(32분) | 실측(PC) | 2026-11-27-f085-purchase-4a |
| 활성 핸들 | 16 | -0.983/h | 0.16/h | 판정 못 함(32분) | 실측(PC) | 2026-11-27-f085-purchase-4a |
| DB 연결 | 23 | +0.140/h | 0.23/h | 판정 못 함(32분) | 실측(PC) | 2026-11-27-f085-purchase-4a |
| Redis 연결 | 7 | 0/h | 0.07/h | 판정 못 함(32분) | 실측(PC) | 2026-11-27-f085-purchase-4a |

- purchase 4a 기울기는 **32분 부하 창**(2026-11-27 23:53:36~2026-11-28 00:25:37, 표본 33개)의 참고값이다. 6시간·표본 330개 기준을 못 채워 NFR-027 `통과` 근거가 아니다. FD +1.584/h는 32분 창의 값이고 6시간 미달로 단정하지 않는다.
- purchase 4a 표본 53개(전체 52분, 마지막 20분은 부하 없음), 표본 간격 최대 1.0003분, 재시작 0.
- purchase 4a `limit_hit`: 409 표본 6,839건(hold 표본 9,061건의 75.5%)·422 표본 0건. 30초 다시 잡기 대기(`REHOLD_WAIT_MS`)가 원인이고, 성공 홀드는 표본 2,221건(×100 ≈ 222,100건, 예열 30분에 약 123/s)이다.
- purchase 4a 5xx: hold 표본 1건·release 표본 2건. `seat_hold` 누적 1,389,158행(이전 실행 포함), `purchase_order` 0행(홀드→해제만 했다).
- purchase 4a p99·오류율: k6 요약이 없다(발생기 OOM). `판정 못 함`. `dropped_iterations`도 요약이 없어 읽지 못했다. `k6.log`는 `Insufficient VUs, reached 100 active VUs and cannot initialize more`다.

## 4. NFR-027 판정

- **queue-svc 4a**: **무효**. 발생기 `dropped_iterations` 2,014건(VU 최대 112/400), `generator.judge.valid=false`. 본구간 상태 조회 요청이 0으로 집계돼 p99 첫/마지막 30분·오류 이항 상한을 판정할 수 없다. 재시작 0은 확인했다.
- **purchase-svc 4a**: **무효**. 2026-11-27 23:53:58~2026-11-28 00:25:43 KST(31분 45초)에 발생기 4GiB가 `OOMKilled`로 끝났다. 예열만 돌았고 본구간은 0분이다. k6 요약이 없어 p99·오류율·`dropped_iterations`를 판정할 수 없다. 30초 다시 잡기 대기로 409가 표본 6,839건(75.5%)이고, 성공 홀드는 약 123/s로 계획 1,000/s의 12%다. 503도 소수 있었다. 재시작 0은 확인했다. 45분 입장 토큰 만료·같은 회차 재입장 차단(`q:adm`)은 이번 31분에는 닿지 않았지만, 같은 5,000명으로 6시간을 돌리면 45분 뒤 401이 되는 별도 한계다.
- **payment-svc·realtime-gw·Outbox**: **미측정**. 4a~4c의 나머지 창을 아직 열지 않았다.
- V-T10: **미측정**. 이번에 돌리지 않았다.

## 5. 누수 주입 대조

| 구분 | 무대 | 대상 | 세기 | 길이(분) | 누수율 | FD 시작 | 판정 | 표시 | 실행 ID |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 누수 | 4c | purchase-svc | 1000 | 360 | 10분에 1개 | 100 | 미측정 | 미측정 | — |
| 고친 | 4a | purchase-svc | 1000 | 360 | — | 100 | 미측정 | 미측정 | — |

- V-T10 종합: 미측정

## 6. 한계

- queue 4a는 6시간을 채웠지만 발생기 dropped 2,014·본구간 요청 0으로 무효다. purchase 4a는 발생기 4GiB OOM으로 31분 45초 만에 끝나 6시간 창을 채우지 못했다.
- purchase 4a의 성공 홀드는 약 123/s다. 10,000석·5,000명×2석·30초 다시 잡기 대기로는 1,000/s를 채울 수 없다. 계획의 `loadBudget`이 purchase를 `sustainable:true`로 본 것은 30초 대기를 반영하지 않은 잘못이다.
- 같은 5,000명으로 6시간을 돌리면 45분 입장 토큰이 만료되고, 이미 입장한 계정의 재입장은 `q:adm`이 409로 막는다. 6시간 purchase 창은 새 계정 무리(코호트) 순환이나 시험용 토큰 수명 연장 없이는 유효 부하를 유지할 수 없다.
- 서비스 하나씩이라 클러스터 규모 누수와 6시간보다 긴 주기 누수는 보지 못한다. 누수 판 4c와 고친 판 4a는 다른 무대 인스턴스다(DB·Redis·Kafka가 새것).

## 7. 게이트·장부

- queue 4a 장부: `docs/perf-ledger/runs/2026-11-27-f085-queue-4a/`(valid=false, `dropped_iterations 2014`).
- purchase 4a 장부: `docs/perf-ledger/runs/2026-11-27-f085-purchase-4a/`(valid=false, 발생기 4GiB OOMKilled, `k6-summary` 없음, `console-sample.ndjson`·`series.ndjson`·`cgroup.log`·`k6.log` 첨부).
- `node --test loadtest/test/f085-soak.test.mjs` 8/8, `loadtest/test/v1.test.mjs` 49/49, `args090.test.mjs` 32/32, `node --check`·`eslint` 0, `pnpm lint` 0, doc-check 오류 0·경고 12, ledger `--batch F-08-5` V-T10 빈칸 1, release-scope 통과.

## 8. 주장하지 않는 것

- 30,000건/초·100만·K1/K2/K7은 주장하지 않는다(문서 인용만).
- queue 4a·purchase 4a의 자원 기울기를 NFR-027 통과 근거로 쓰지 않는다.
- purchase 4a는 6시간 측정이 아니다. p99·오류율·dropped의 판정을 주장하지 않는다.
