# F-08-9 재시도 측정 결과(릴레이·장애 주입·P-T1, 2026-11-28)

- **결론: V-T27은 무효, V-T28 ①②③은 무효, P-T5는 무효, P-T1은 무효(부분)다.** 릴레이 30분 부하는 넣었고 `f089_sent` 22,680,000행 = `f089_received` 22,680,000행, 빠진 행 0·순서 뒤집힘 0·`eventKey` 불일치 0·`maxKeyRepeats` 1,260으로 **유실·순서 증거는 유효**하다. 그러나 ① 같은 실행 P-T5 결제 부하가 없고(실행기 인자 오류), ② V-T28 ①②③ 장애 주입기가 릴레이 파드에 `kill` 실행 파일이 없어 **한 번도 적용되지 않았으며**, ③ 리더 변경 시간이 없다. 계획 3.3의 완료 조건을 모두 만족하지 못해 V-T27을 통과로 세지 않는다. P-T5는 별도 300/s 두 번이 모두 발생기 dropped로 무효, P-T1은 발생기 dropped와 Toxiproxy 미적용으로 무효다. **새 30k/s·100만·K1/K2/K7 수치는 주장하지 않는다.**
- **작업 폴더·가지**: `D:/ticketpass-freeze-F-08-9`, `freeze/lane4-F-08-9`, 측정 시작 HEAD `618f3b042`. 동결 로컬 트랙이다(ADR-0373·ADR-0386).
- **Docker 잠금**: `docker lane4-F-08-9` 한 자리(2026-11-28 01:29:49~04:0x KST). `docker-all`은 쓰지 않았다. kind 이름 `lane4-f09`, 게이트웨이 포트는 겹침을 피해 `18541~18545`로 올렸다. **F-08-5가 끝난 뒤 남아 있던 `lane4-f085-control-plane`이 18441~18445 포트와 8.4GiB를 잡고 있어 `docker stop`(삭제 아님)으로 멈췄다.** 다음 F-08-5 세션이 필요하면 `docker start lane4-f085-control-plane`으로 되살릴 수 있다.
- **무대**: kind `lane4-f09`, v1 합본 복제 3·2GiB, Redis TLS 켬, purchase·payment 릴레이 각 2복제( purchase 릴레이 메모리 한도 1Gi로 올림), PostgreSQL 18(v1, CPU 한도 1코어·2GiB), Kafka 3.9.1(Strimzi, 브로커 메모리 4GiB·heap 2GiB·liveness `failureThreshold 30`), Toxiproxy 2.13.0(제어 API 루프백, `TOXIPROXY_AUTH_TOKEN`), pg-simulator(현재 트리 빌드, 웹훅 중복 endpoint 포함). 소비자는 **릴레이 파드 밖 별도 파드**(2GiB)에서 돌렸다(이전 창 OOM 원인 제거). 검색 무대는 이번에 띄우지 않았다(SR-T13 ①은 이미 측정).

## 1. 실행 표

| 실행 | 실행 ID | 시작(KST) | 끝(KST) | 유효 | 판정 |
| --- | --- | --- | --- | --- | --- |
| V-T27 릴레이 30분 | `2026-11-28-relay-fault-f089` | 02:21:33 | 02:51:33(드레인·증거 03:36) | 부분 | **무효** — 부하·지연·유실은 유효, P-T5·V-T28 없음 |
| V-T28 ①②③ | 같은 실행 | 02:31:33(① 계획) | — | 무효 | 주입기 `kill` 없음, `applied=false` 3줄 |
| P-T5 1차(300/s) | 별도 실행(장부 폴더 없음) | 03:37:03 | 03:41:25 | 무효 | 발생기 dropped 14,309 |
| P-T5 2차(300/s) | 별도 실행(장부 폴더 없음) | 03:41:44 | 03:45:36 | 무효 | 발생기 dropped 17,735 |
| P-T1 1차 | `2026-11-28-pt1-f089`(1차) | 03:45:50 | 03:54:00 | 무효 | 발생기 dropped 1,214·Toxiproxy 미적용 |
| P-T1 2차 | `2026-11-28-pt1-f089`(2차) | 03:54:34 | 04:03:29 | 무효 | 발생기 dropped 841·Toxiproxy 미적용 |

- 실행 사이에 다른 시험·빌드를 돌리지 않았다. P-T5·P-T1은 V-T27 본구간이 끝난 뒤 **별도 실행**으로 시도했고, V-T27의 같은 실행 P-T5로 세지 않는다.

## 2. V-T27 — 부하·지연·유실(부하 증거 유효, 완료 조건 미충족)

- **발생기**: 호스트 Node `pg` writer가 `f089_sent`에 보낸 행을 먼저 적고 같은 트랜잭션에서 `outbox`에 넣었다. 180묶음 × 126,000행 = **22,680,000행**, 02:21:33~02:51:33(1,797.9초), 평균 **12,614.8행/s**(목표 12,600/s). 같은 좌석 키 20,000개를 묶음마다 6~7번 뒤집어 `maxKeyRepeats` **1,260**을 만들었다. 발생기 자체 dropped는 없다(호스트 writer, k6 아님).
- **전송**: outbox `sent_at`을 받은 행 22,680,000, 미전송 0. 릴레이 published 평균 **11,950/s**로 도착률보다 약 650/s 모자랐고, 30분 동안 backlog가 쌓였다.

| 항목 | 값 | 비고 |
| --- | --- | --- |
| `f089_sent` / `f089_received` | 22,680,000 / 22,680,000 | id 기준 |
| 빠진 행(안티조인) | **0** | `RELAY_EVIDENCE_SQL.missing` |
| 같은 키 `seq` 순서 뒤집힘 | **0** | `lag(seq)` |
| `eventKey` 불일치 | **0** | id별 `count(distinct event_key)` |
| `maxKeyRepeats` | **1,260** | `f089_sent` 키별 최대 |
| outbox 미전송·죽은 행 | **0** | `sent_at is null` |
| 소비자 재시작 중복 | 2,413 | id 기준 중복 제거 전. 릴레이 이중 발송이 아니라 소비자 파드 재시작 재배달이다 |
| 릴레이 지연 p50·p99·max | **57.786초·147.362초·152.269초** | 324표본, 5초 간격 |
| 묶음 처리 p99 | **4.156초** | 322표본 |
| DB CPU(릴레이 켬) | **0.991코어 = 99.08%** | 1코어 한도, 1,797.9초 |
| DB CPU(릴레이 끈 기준 10분) | **0.300코어 = 30.0%** | 같은 12,600/s, 7,560,000행, 591.6초 |
| DB CPU 증가분 | **+69.1%p** | 문턱 5%p [가정]을 크게 넘음 |
| 릴레이·Kafka 재시작 | 0 / 0 | 토픽 `f089.relay.main.v1` 6파티션 유지 |

- **트리거**: `relay-lag`(p99 147.362초 > 0.2초 [가정]), `batch`(p99 4.156초 > 0.05초 [가정]), `db-cpu`(+69.1%p > 5%p [가정]). 계획 3.3 실패 시나리오대로 유실이 없으면 이 트리거만으로 `fail`은 아니지만, 이 창에서는 **릴레이가 12,600/s를 지속하지 못했다**는 사실을 ADR-0116 결정 6·NFR-006 판정 근거로 남긴다. 1코어 PostgreSQL과 1Gi 릴레이 한도에서 2배 [가정] 도착률을 30분 유지하면 backlog가 단조 증가한다.
- **판정: 무효(부분).** 유실·순서·`eventKey`·`maxKeyRepeats`·지연·DB CPU는 측정됐지만, 같은 실행 P-T5와 V-T28 ①의 리더 변경 시간이 없어 계획 3.3 완료 조건 2·3을 만족하지 못한다. 통과로 세지 않는다.

## 3. V-T28 ①②③ — 무효(주입 0회)

- **실제 일**: 02:31:33에 ① leader-stop을 넣으려고 `kubectl exec purchase-svc-outbox-relay-... -- kill -STOP 1`을 불렀고, 릴레이 컨테이너에 `kill` 실행 파일이 없어 `OCI runtime exec failed: exec: "kill": executable file not found in $PATH`로 끝났다. 주입기 프로세스가 이 예외로 멈춰 ② Kafka 30초 정지·③ DB 연결 끊기는 **시도조차 되지 않았다**.
- `faults.ndjson`에는 계획 시각·길이 그대로 `applied=false` 3줄을 남겼다. `validateFaultRecords`는 이 기록을 거부하므로 V-T28은 무효다. 숨기지 않는다.

| 주입 | 계획 | 적용 | 증거 |
| --- | --- | --- | --- |
| ① leader-stop | 600초, SIGSTOP 20초 | false | `kill` 실행 파일 없음(위 오류) |
| ② kafka-stop | 1200초, 30초 | false | ① 예외로 실행되지 않음 |
| ③ db-cut | 1500초, 0초 | false | ① 예외로 실행되지 않음 |

- 리더 변경 시간·옛 리더 재개 뒤 보내기·끊긴 DB 연결 수는 **미측정**이다. 이 실행의 `duplicateIds` 0은 릴레이 이중 발송이 없었다는 뜻이지, V-T28 ①을 대신하지 않는다.
- **판정: 무효.** ②가 정확히 30초가 아니면 무효라는 계획 3.3 규칙에 해당한다.

## 4. P-T5 — 별도 실행 2회 모두 무효

- V-T27 같은 실행에 결제 부하를 넣으려 했으나, `v1 payment` 실행기가 `--prom-url`을 `--record` 없이 받지 않아 **같은 실행 P-T5가 시작조차 하지 못했다**(`loadtest/run.mjs` 인자 오류). 이 실패는 측정 조건이 아니라 실행기 사용 오류다.
- 별도 실행으로 300/s를 두 번 시도했다. 50,000명·warm 1초·본구간 165초, 좌석 100,000개.
  - 1차: 발생기 2대(각 4CPU·3GiB), VU 최대 3,643, **dropped 14,309**, 결제 확정 p99 **13,276.8ms**.
  - 2차: 발생기 1대(8CPU·8GiB), VU 최대 4,258, **dropped 17,735**, 결제 확정 p99 **8,896.7ms**.
- 두 회차 모두 `payment_status` p99가 8~12초대이고, 300/s × 8~13초 > VU 상한이라 발생기가 반복을 시작하지 못했다. **V-T27의 P-T5 p99로 쓰지 않는다.**
- **판정: 무효.** 같은 실행 P-T5·브로커 재시작 구간 p99·ADR-0140 당기기 반영 수는 **미측정**이다.

## 5. P-T1 — 무효(부분)

- **실행**: `v1 payment` 10,102명·100/s·warm 1초·본구간 100초, `--fault-drop-pct 5`·`--fault-delay-pct 2`, 불변식 검사. 1차는 발생기 2대(자동 분할 2CPU·1GiB), 2차는 1대(8CPU·8GiB).
- **발생기**: 1차 dropped **1,214**·시나리오 오류 608, 2차 dropped **841**·오류 2,511. 둘 다 무효다. 2차 VU 최대 1,987, `payment_status` p99 18초대.
- **Toxiproxy**: 프록시 `sim`(18080→`pg-simulator:8790`)를 만들고 직접 `/sim/ledger` 200을 확인했다. 그러나 토글 감시기가 PowerShell `Tee-Object`의 UTF-16 로그를 읽지 못해 지연·시간 초과·연결 끊김을 **적용하지 못했다**. `toxics.ndjson`에 `applied=false` 3줄로 남겼다. 프록시 자체는 살아 있고 다음 창에서 쓸 수 있다.
- **불변식(1차)**: PASS **15**, SKIPPED 2(S3·P5, ticket 원본 없음), FAIL 0. **P1·P2·P4·P6 PASS**, P3 PASS. P6(원장이 모르는 결제사 승인) 위반 0.
- **시뮬레이터 원장 대조**: P-T5·P-T1 누적 승인 **10,899**, payment 원장 기록 **10,899**, missing **0**, duplicatePayments **0**, verdict **pass**.
- **웹훅 중복**: 같은 `tosspayments-webhook-transmission-id`(`wh_781f4bcdc1e2fcfafcb8ab37`)를 2회 보냈고(`sent=2`, events=1), `webhook_receipt`에 `SIMULATOR:wh_...` **1행**만 남았다(`processed=1`). 이 몫은 pass다.
- **못 한 것**: Toxiproxy 지연·시간 초과·연결 끊김 적용, 발생기 유효 회차의 P6·이중 결제 판정, ticket-svc 5분 중단·이중 발권·일일 대사. S3·P5가 SKIPPED라 **이중 발권은 미측정**이다(P-T1 전체 통과 아님).
- **판정: 무효(부분).** 불변식·원장 대조·웹훅 중복은 통과했지만 발생기 dropped와 Toxiproxy 미적용으로 P-T1의 증거 조건을 모두 만족하지 못한다.

## 6. SR-T13 ①·NFR-028 — 이번에 다시 재지 않음

- 검색은 이전 창의 `2026-11-27-search-10k-f089`(10k fail: random 검색 503 1.08%)·`2026-11-27-search-20k-f089`(20k pass)와 NFR-028 pass를 그대로 인용한다. 이번 창은 Docker 한 자리에서 릴레이·결제만 쟀고 검색 무대를 띄우지 않았다. 새 수치 없음.
- SR-T13 ②는 BAT-056 인용 그대로다.

## 7. 산출물

- `docs/perf-ledger/runs/2026-11-28-relay-fault-f089/`: `timeline.csv`(5초 지표), `faults.ndjson`(applied=false 3줄), `faults-error.txt`, `f089-evidence.json`, `db-cpu.csv`, `generator.csv`, `host.json`, `manifest.json`(`valid:false`), `pt5-attempt-1-summary.json`·`pt5-attempt-2-summary.json`(별도 실행, 무효), `k6-summary.json`(같은 실행 P-T5 없음).
- `docs/perf-ledger/runs/2026-11-28-pt1-f089/`: `summary.json`(2차), `attempt-1-summary.json`, `invariants-attempt-1.csv`, `records.ndjson`, `k6.log`, `infra.txt`, `generator.json`, `host.json`, `webhook-duplicate.json`, `reconcile.json`, `toxics.ndjson`(applied=false), `manifest.json`(`valid:false`).
- 원본 임시 파일: `.cache/peaket-f09/run2/`(커밋하지 않음).

## 8. 한계와 다음 창 전에 고칠 것

1. **V-T28 주입기**: 릴레이 컨테이너에 `kill`이 없다. `sh -c 'kill -STOP 1'`(셸 내장)로 바꾸고, 주입 뒤 `/proc/1/stat`가 `T`인지 확인한다. ②는 `/proc/<java-pid>/stat`를 확인하고, Strimzi liveness `failureThreshold`를 30으로 둔 지금 무대를 그대로 쓴다.
2. **P-T5**: `v1 relay-fault`의 `--payment-rate`/`--payment-mode`는 계획만 있고 실행 경로가 없다. 같은 30분 실행에 결제 k6를 붙이는 오케스트레이션이 필요하다. 50,000명·100,000좌석 상한 때문에 300/s를 30분 지속할 수 없다는 것도 이번에 확인했다(166초가 좌석 한계). P-T5를 같은 실행에 넣으려면 좌석 상한을 늘리거나 결제 전용 부하 발생기를 따로 만들어야 한다.
3. **P-T1 발생기**: 100/s에서도 `payment_status` p99가 8~18초라 VU가 모자란다. 발생기 수를 늘리거나(자동 분할 2CPU·1GiB를 피하려면 `--cpus`/`--memory-mi`를 기본값과 다르게 준다) 검증 시나리오의 대기 상한을 조정해야 한다. Toxiproxy 토글은 로그를 UTF-8로 쓰거나 감시기를 UTF-16 대응으로 고친다.
4. **릴레이 처리량**: 1코어 PG·1Gi 릴레이에서 12,600/s를 지속하지 못했다(published 11,950/s, lag p99 147초). 이는 측정 결과이지 무효 사유가 아니지만, 다음 창에서 릴레이 메모리·배치·DB CPU를 올려 같은 세기로 다시 재야 한다.
5. 이번 값은 동결 로컬 트랙 기록이다. v1 출시 계약·정본 판정 칸에 쓰지 않는다.
