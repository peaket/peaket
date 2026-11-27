# loadtest/

부하 시험 자리입니다. k6 시나리오(오픈 모델 도착률)와 카오스 실험 스크립트를 둡니다. 합성 봇 시뮬레이터는 공개하지 않으므로 여기 두지 않고 비공개 저장소 `peaket-bots`에 둡니다(POL-026).

- 측정 규칙과 기록: [docs/perf-ledger.md](../docs/perf-ledger.md), 시나리오·발생기 설계와 보정 결과: [docs/verification.md](../docs/verification.md) §3.9, 저장소 구성: [docs/devops.md](../docs/devops.md) §2.1, 결정: ADR-0169
- `scenarios/`·`lib/`·`runner/`·`run.mjs`: v0 측정용 k6 시나리오와 실행 도구(wbs 1.2.1, 아래).
- `poc/`: 기반 PoC 측정 틀(wbs 0.5.1, [poc/README.md](poc/README.md)). Redis 한 키·클라이언트 셋·좌석 샤드, HTTP 어댑터·검사 방식, Kafka 기본 클라이언트를 PC의 Docker 망 안에서 잰다.
- `nightly/`: 야간 축소 성능 상대 비교. 기준값 `threshold.json`(A/A 실행 10번으로 정하는 `max_ratio`, 러너에서 정하기 전까지 비움)과 설정 `config.json`·`config-aa.json`(시나리오·판마다 실행 수·두 판을 kind에 올리는 준비 명령 `prepare.mjs`·실행 명령 `k6-run.mjs`)을 둔다. 비교 도구는 `tools/perf-ledger/nightly.py`, 워크플로는 `.github/workflows/perf-nightly.yml`이다(docs/devops.md §3.3, D-T40). `test/`의 30ms 지연 패치와 설정은 D-T40 ② 시험용이다.
- `k5/`: K5 랩 판정(`seatmap-lab.mjs`, 머리 없는 Chrome으로 v0 좌석맵을 20회, docs/verification.md §3.10).
- `queries/v0.txt`: Before 측정의 서버 지표 질의(`collect.py --queries`).

## 쓰는 법(v0 시나리오와 발생기 보정)

저장소 뿌리에서 실행합니다. Node 24, Docker 엔진, `openssl`이 있어야 합니다. 먼저 클러스터와 v0를 올립니다.

```bash
node tools/local/cluster.mjs up && node tools/local/cluster.mjs v0
corepack pnpm --filter @peaket/invariant-checker build   # --invariants를 쓸 때(PowerShell은 pnpm.ps1을 막는다)

node loadtest/run.mjs calibrate --cpus 4 --rates 1000,2000,4000,8000 --record   # 발생기 보정(성능 장부 local-gen)
node loadtest/run.mjs v0 queue --users 10000 --entry-rate 1000 --admit-per-second 28 --warm 30 --main 120 --invariants
node loadtest/run.mjs v0 seat-hold --users 2000 --rate 2000 --mode hot --hot-count 1
node loadtest/run.mjs v0 payment --users 20000 --rate 300 --seats-per-order 2 --warm 10 --main 50 --invariants

# Before 측정(docs/verification.md §3.10). 장부에 남길 때는 Prometheus를 연다(별도 PowerShell 창): node tools/local/cluster.mjs prometheus
node loadtest/run.mjs v0 queue --users 100000 --entry-rate 1000 --admit-per-second 28 --warm 30 --main 120 --settle --hpa-timeline --record --run-id <ID> --prom-url http://127.0.0.1:9090
node loadtest/run.mjs v0 seat-hold --users 1000 --rate 2000 --mode hot --hot-count 1 --keep --db-stats
node loadtest/run.mjs v0 seat-deltas --users 1000 --rate 125 --connections 5000
node loadtest/run.mjs v0 payment --users 11002 --rate 100 --warm 10 --main 100 --fault-drop-pct 5 --fault-delay-pct 2 --kill-app-at 50 --invariants
node loadtest/run.mjs v0 gate --scanners 10 --rate 10
node loadtest/k5/seatmap-lab.mjs --reps 20
```

- k6 1.4.2(다이제스트 고정)를 kind 안의 발생기 파드(네임스페이스 `loadtest`, CPU·메모리 요청 = 한도)로 띄우고 입구의 클러스터 안 주소(`https://v0-gateway.v0.svc.cluster.local:8443`)로 보냅니다. 포트 전달은 쓰지 않습니다(Windows에서 끊깁니다). 파드의 입력(시나리오·토큰·인증서·환경 파일)은 kind 노드 컨테이너의 실행 폴더(`/var/local/peaket-loadtest/<실행>`)에 `docker cp`로 넣고 파드가 hostPath로 붙입니다. 이 PC에서 `kubectl exec -i`의 표준 입력이 잘리기 때문입니다(2026-11-03 확인). 파드와 실행 폴더는 실행이 끝나면(실패해도) 지웁니다.
- 가상 사용자마다 시험 계정 토큰을 이 PC에서 서명해 파드로 넘깁니다(`tools/local/v0-token.mjs`, 개인키는 `.cache/peaket-tools/v0-token-key.json`에만). 가상 사용자 IP는 측정용 대역 198.18.0.0/15에서 붙입니다(131,072명까지).
- 회차는 실행마다 새로 엽니다(UUID). 대기열은 `--admit-per-second`로, 좌석·결제 시나리오는 모두를 곧바로 부르도록 엽니다. 판매 종료 시각을 실행 예상 끝 + 10분으로 두어, 끝난 회차는 입장 루프가 불러도 곧바로 돌아옵니다(회차 목록과 키는 남습니다).
- 인자 규칙(어기면 클러스터를 건드리기 전에 종료 코드 2): 본구간 5초 이상, 예상 시간 + 10분이 3시간(토큰 수명 상한) 이하, 좌석 홀드는 도착률 × 2 ≤ 0.6 × 10 × 가상 사용자 수(입구의 IP당 한도의 60%), 보정은 단계 수 × (예열 + 본구간 + 30) + 600 ≤ 11,400초, 결제는 도착률 × (예열 + 본구간) + 2 ≤ 가상 사용자 수.
- 부하 실행은 한 번에 하나입니다. 실행 잠금(네임스페이스 `loadtest`의 ConfigMap `loadtest-lock`)을 잡은 실행만 돌고, 잠금을 잡은 실행만 앞 실행이 남긴 것을 지웁니다. 다른 실행이 돌고 있으면 거절합니다.
- Ctrl+C 같은 종료 신호를 받으면 발생기 파드·실행 폴더·시험 키·실행 잠금을 지우고 끝냅니다. 강제로 죽어(Windows `taskkill /F` 등) 남은 것과 계속 나가는 부하는 `node loadtest/run.mjs cleanup`으로 지웁니다. 그래도 남은 파드는 실행 시간 상한(`activeDeadlineSeconds`)에서 끝납니다.
- 산출물은 `.cache/peaket-loadtest/<날짜>-<시나리오>-<실행>/`(또는 `--out`)입니다: `summary.json`(본구간 값으로 바꾼 k6 요약), `records.ndjson`(시험 기록, docs/verification.md §2.5), `generator.json`(발생기 CPU·메모리와 판정), `console.ndjson`, `cgroup.log`, `k6.log`, `infra.txt`, `run.json`, 그리고 `--invariants`면 `invariants.csv`. 토큰은 남기지 않습니다.
- `--record --run-id <ID>`는 `tools/perf-ledger/collect.py`로 장부에 옮깁니다(장부 표는 `python tools/perf-ledger/index.py`). 발생기 CPU 평균 80% 초과·메모리 90% 초과·`dropped_iterations` 1건 이상이면 `valid: false`와 사유가 남습니다.
- 불변식 검사기(`--invariants`)는 v0 DB 전체를 봅니다. 다른 시험이 일부러 깨뜨린 상태가 섞이지 않게 새로 올린 클러스터에서 돌립니다.
- 종료 코드: 0 실행을 마치고 산출물을 씀(발생기 판정이 무효여도), 1 k6가 돌지 못함·보정 단계 실패·불변식 FAIL, 2 인자 오류, 128 + 신호 번호(Ctrl+C 130, SIGTERM 143) 종료 신호를 받아 정리하고 끝냄.

| 명령 | 재는 것 | 주요 인자(기본값) |
| --- | --- | --- |
| `calibrate` | 발생기 용량(빈 응답 대역 nginx에 보내 왜곡 없이 보낸 가장 높은 단계)과 가상 사용자당 메모리 | `--cpus 4` `--memory-mi 4096` `--target-cpus 8` `--rates 1000,2000,4000,8000` `--warm 10` `--main 30` |
| `cleanup` | 강제로 끝난 실행이 남긴 발생기 파드·실행 폴더·시험 키·빈 응답 대역·실행 잠금을 지운다(계속 나가던 부하가 멈춘다) | 없음 |
| `v0 queue` | K1(Q-T2의 v0 쪽): 진입 뒤 대기자들이 만드는 조회 도착률 | `--users` `--entry-rate` `--admit-per-second`(필수) |
| `v0 seat-hold` | K2·K3(S-T1·S-T10의 v0 쪽): 홀드 도착률과 좌석 고르기 | `--users` `--rate`(필수) `--mode spread` `--hold-size 2` `--hot-count 1` `--pairs 1` `--release-ms 0` |
| `v0 payment` | K7: 홀드 → 주문 → 시뮬레이터 인증 → 결제 확정 → 주문 보기 | `--users` `--rate`(필수) `--seats-per-order 2`, rate × (warm + main) + 2 ≤ users(가상 사용자 하나가 결제 하나, 도착률 실행기는 구간마다 한 번 더 시작할 수 있다) |
| `v0 seat-deltas` | K4(S-T12의 v0 쪽): 변경분 연결 C개(받는 파드가 맺는다)와 홀드 도착률. 받은 메시지·바이트·종단 지연 | `--users` `--rate` `--connections`(필수) `--listener-pods`(⌈연결 ÷ 500⌉) `--hold-size 2` |
| `v0 gate` | K10(O-T1의 v0 한계): 온라인 검표 중 입구를 끊었다 되돌린다. 구간별 분당 판정과 멈춘 시간 | `--scanners` `--rate`(필수) `--cut-at 60` `--cut-s 60`, `--main` 기본 180 |
| `v1 queue`·`v1 seat-hold`·`v1 payment` | K1·K2·K7의 v1 쪽(docs/verification.md §3.9 'v1 경로', BUILD_ORDER PRF-215): 한 프로세스 합본(`node tools/local/cluster.mjs v1`)으로 보낸다. 게이트웨이가 없어 신원 머리를 넣고 구매 요청은 서명한다(`lib/purchase-auth.mjs`). K1은 입장 속도를 시험 회차의 결제사 승인 상한으로 시드하고, K7 ②는 반복 안에서 입장한 뒤 결제한다 | v0와 같다. `--namespace`·`--settle`·`--hpa-timeline`은 없다 |
| 공통 | — | `--warm 30` `--main 60` `--cpus 4` `--memory-mi 4096` `--generators`(기본 최고 도착률 ÷ 1,000, 나누면 CPU 2·메모리 1GiB씩. F-08 계획은 800/s 기준으로 실행마다 값을 준다) `--namespace v0` `--settle` `--hpa-timeline` `--record --run-id` `--profile`(사용자 수로 local-1k·10k·100k) `--prom-url` `--invariants` `--out` |
| seat-hold·payment만 | — | seat-hold `--keep`(놓지 않기), `--db-stats`(교착·HOT 통계), payment `--fault-drop-pct` `--fault-delay-pct` `--kill-app-at` |
| v1만(F-08-8) | docs/verification.md §4.1 'DB 쓰기 처리량'·'Redis 메모리' | queue·seat-hold·payment `--db-stats`(purchase·payment DB의 `pg_stat_database` 차이와 무대 PostgreSQL 전체의 `pg_stat_wal` WAL 바이트 → `db-stats.json`), `--redis-stats`(끝에 대기열·좌석 Valkey `INFO memory` → `redis-stats.json`). 못 읽으면 값은 null이고 그 실행은 무효(통과로 세지 않는다). `--record`면 장부 원본에 붙는다. v0는 `--redis-stats`를 받지 않는다 |
| `v1 entry-steps` | MSR-020 진입 서버 비례 확인(docs/verification.md §3.3, 계획 docs/review/plans/F-08-2.md 6.3): 도착률 단계 올리기 한 번. 단계마다 새 회차, 준비 구간에 사전 검증을 마치고 진입(`route:entry`)만 정한 도착률로 보낸다(`scenarios/v1-entry.js`). 단계가 SLO(p99 200ms·오류율 0.1% 미만)·발생기·커널 카운터·호스트 포화 가운데 하나라도 어기면 다음 단계를 보내지 않는다. 첫 단계부터 어기면 첫 단계를 절반으로 낮춰 한 번만 다시 돈다 | `--replicas N` `--pod-cpus <0.25·0.5·1~16>`(무대와 같아야 한다) 그리고 `--start-rate r --step-rate d` 또는 `--x1-estimate X̂₁`(첫 단계 0.5 × N × X̂₁, 0.1 × N × X̂₁씩), `--max-steps 8` `--warm 10` `--main 30` `--rest 20` `--generators`(기본 최고 도착률 ÷ 800) `--cpus 2` `--memory-mi 1024`(발생기) `--record --run-id-prefix <ID 앞>`(단계마다 `<앞>-s<단계>`) `--prom-url` `--out`. 결과: `steps.json`(`{ n, podCpus, steps: [{ rate, kept, reasons, entryP99Ms, entryOverRatio, errorRate, sent, dropped, kernel, host }], x, saturated, limitedBy }`)·`step-<번호>/`(요약·`host.json`). 종료 코드는 X를 찾으면 0, 찾지 못하면 1, 인자 오류 2 |
| `v1 compare`·`v1 compare-report` | F-08-10 V-T18 서비스 분리 효과 비교(계획 docs/review/plans/F-08-10.md 6~7절): (가) 합본과 축소 (나) 네 역할 배포를 결제 300 TPS·진입 0/100/120%로 견준다. 측정 창 전에는 `command.json` 계획만 쓰고 Docker·kind·k6를 시작하지 않는다. `compare-report`는 실행 폴더의 `comparison-run.json`을 모아 `comparison.json`·`comparison.md`를 쓴다 | `v1 compare --config bundle|by-role --entry none|100|120 --rep 1..3 [--entry-max-rate N] [--payment-tps 300] [--record --run-id <ID> --out <폴더> --prom-url …]`, `v1 compare-report [--experiment split-3way] [--runs <폴더>] [--out <comparison.json>]`. `entryRate`는 F-08-2 1 vCPU X₁ 800/s를 인용하고 0.5 vCPU 320/s는 쓰지 않는다. (다) 10개 서비스는 미측정 |

### Game Day 로컬 ①·②(F-08-12)

`v1 gameday-local`은 14종(① G-02·G-10·G-29·G-30·G-31, ② G-17~G-25)의 계획과 판정만 다룹니다. 측정 창 전에는 `gameday-local-plan.json`(또는 `run.json`)만 쓰고 **Docker·kind·k6·브라우저를 시작하지 않습니다.**

```bash
node loadtest/run.mjs v1 gameday-local --window 3a
node loadtest/run.mjs v1 gameday-local --window 3c --scenario G-23 --partial --record --run-id 2026-11-28-g23-f0812 --out .cache/peaket-f0812/g23
node loadtest/run.mjs v1 gameday-local --window 3a --judge .cache/peaket-f0812/g23/run.json --out .cache/peaket-f0812/judge.json
```

- 로컬 Prometheus에 경보 규칙이 없어 **G-21·G-23·G-31은 `판정 못 함`**입니다. G-10·G-18·G-19·G-22·G-25도 무대가 없고, G-02·G-20·G-23·G-24·G-29·G-31은 일부만 할 수 있습니다. G-17은 설계만입니다. 이 무대에서 통과 가능한 시나리오는 0입니다.
- 탐지는 T0(주입)→T1p(`ALERTS` firing), 전파는 T2(명령 접수)→T3(파드 반영)입니다. 로컬 T1(Alertmanager)은 null이고 K8 판정은 `requireAlertmanager:true`로 T1을 요구합니다.
- 실행 ID는 `-f0812`로 끝나고, Docker 잠금은 `docker lane4-F-08-12` 한 자리만 씁니다(`docker-all` 금지). 14종 실제 실행·측정은 측정 창 몫이며 이 명령은 실행하지 않습니다.
- 정본·계획: `docs/observability.md` §12, `docs/verification.md` §5.2, `docs/review/plans/F-08-12.md` §6~§10.

### 보내기 비교·Sentry 판정·M4 2편(F-08-15)

`v1 backend-send`는 보내기 비교·Sentry vs GlitchTip 판정·M4 블로그 2편의 **계획과 미실행 표시**만 다룹니다. 실제 전송·외부 계정·Sentry/GlitchTip 설치·**Docker·kind·k6·브라우저를 쓰지 않습니다.**

```bash
node loadtest/run.mjs v1 backend-send --plan loadtest/plan/f0815-plan.json --check
node loadtest/run.mjs v1 backend-send --plan loadtest/plan/f0815-plan.json --out .cache/peaket-f0815
node loadtest/run.mjs v1 backend-send --plan loadtest/plan/f0815-plan.json --report docs/review/measurements/F-08-15.md
```

- 판정은 끝까지 `미측정`·`판정 못 함`이고, 비용은 `[추정]`·`미계산`입니다. 통과를 만들지 않습니다.
- M4 초안은 `docs/blog/m4-control-gameday.md`·`m4-scaling-cost.md`이고 게시는 소유자 몫입니다.
- Docker 잠금은 `docker lane4-F-08-15` 한 자리만 씁니다(`docker-all` 금지). 실제 전송·측정은 측정 창 몫이며 이 명령은 실행하지 않습니다.
- 정본·계획: `docs/observability.md` §1·§11, `docs/perf-ledger.md` §11, `docs/review/plans/F-08-15.md` §6~§10.

### 진입 서버 비례 확인(MSR-020)

무대는 진입 서버 수·CPU 몫·켤 서비스를 정해 올립니다: `node tools/local/cluster.mjs v1 --redis-tls on --replicas N --cpus <몫> --services queue-svc`(넷을 다 켜지 않으면 합본은 single 모드로 뜬다). 단계 올리기 뒤 계산은 `node loadtest/runner/entry-scale.mjs choose|report`입니다.

```bash
node loadtest/run.mjs v1 entry-steps --replicas 1 --pod-cpus 1 --start-rate 400 --step-rate 400 --out .cache/peaket-f08/msr020/probe
node loadtest/run.mjs v1 entry-steps --replicas 4 --pod-cpus 0.5 --x1-estimate 900 --record --run-id-prefix 2026-11-27-msr020-n4-c05-r1-f082 --prom-url http://127.0.0.1:9090
node loadtest/runner/entry-scale.mjs choose --x1 1800 --docker-cpus 32             # CPU 몫 1 → 0.5 → 0.25(계획 6.4)
node loadtest/runner/entry-scale.mjs report --design <1 vCPU 세 폴더> --point 1=<세 폴더> --point 2=<세 폴더> … --out <폴더>   # entry-scale.json·usl.csv
```

- 호스트 지표(docs/verification.md §3.5 6·8번): 본구간 시작·끝 표시를 보고 kind 노드 `/proc/stat`, 합본·대기열 Valkey·발생기 파드의 cgroup `cpu.stat`, 합본 파드 `/proc/net/netstat`을 읽어 `host.json`(CPU 사용률 %, `procs_running`, 논리 프로세서, 스로틀, 준 CPU 합, 커널 카운터 증가, 표시)을 남긴다. '호스트 포화'·'호스트 지표 없음'인 단계는 지킴으로 세지 않고, X(N)을 정한 단계가 그렇다면 그 점은 E(N)·설계 식·USL에서 뺀다(장부 행은 남긴다).
- 발생기를 나누면 합친 p99는 발생기별 p99의 위 한계라, 단계 판정은 200ms를 넘은 진입의 비율(≤ 1%)로 한다(`entryOverRatio`).

## 게이트웨이 차단 상한·검색 IP 한도(`gw`, V-T43·SR-T13 ②)

게이트웨이(Envoy Gateway)의 차단 상한(서킷 브레이커: 뒤의 서비스에 동시에 보내는 요청 수와 기다리는 요청 수의 상한)을 바꿔 가며 재고, 같은 무대에서 검색 IP 한도를 잽니다(BUILD_ORDER BAS-090, 묶음 BAT-056 계획 `docs/review/plans/BAT-056.md` §2·§5). 정본은 docs/infra.md §4.1 '게이트웨이 차단 상한'과 docs/features/search.md §12 SR-T13 ②입니다. 먼저 클러스터와 게이트웨이를 올립니다(같은 `PEAKET_CLUSTER` 값으로).

```bash
PEAKET_CLUSTER=lane1-b056m node tools/local/cluster.mjs up && PEAKET_CLUSTER=lane1-b056m node tools/local/cluster.mjs gateways

node loadtest/run.mjs gw capacity --proxy-cpus 0.5 --rates 500,1000,1500,2000,3000 --delay fixed:5   # M1 포화 처리량
node loadtest/run.mjs gw sweep --mix normal --delay normal --rate 1500 --max-parallel 16 --max-pending 2   # M-A 동시 상한 한 값(보류는 운영 꼴 ⌈동시 ÷ 8⌉, 값마다 한 번)
node loadtest/run.mjs gw sweep --max-parallel 24 --max-pending 1,3,12 --rate 1500   # M-B 보류 확인(셋의 503 수가 같은지)
node loadtest/run.mjs gw sweep --max-parallel 24 --max-pending 3 --delay fixed:50 --repeat 3   # M-C 과부하(V-T43 ②)
node loadtest/run.mjs gw ip-limit --case single   # M-S(SR-T13 ②). many·mixed·v6-64도 같은 꼴
node loadtest/run.mjs gw limits --from <a/sweep.json>,<b/sweep.json> --saturation 2600 --pod-cpus 2   # k와 운영 차단 상한 셈(BAT-058, 클러스터를 쓰지 않는다)
```

| 명령 | 하는 일 | 인자(기본값) |
| --- | --- | --- |
| `gw sweep` | 라우트 하나에 임시 상한 정책을 걸고(단계마다 값 바꿈) 부하를 넣어 단계마다 판정한다(정상 부하는 V-T43 ①, 과부하는 ②) | `--gateway gw-queue` `--route gw-queue-buy` `--rate 1500` `--mix normal|single` `--delay normal|fixed:<ms>` `--max-parallel <목록>`(필수) `--max-pending <수 또는 목록>`(1024) `--max-connections same|<수>`(same) `--workers <1~64>`(기대 일꾼 수, 없으면 그 게이트웨이 `EnvoyProxy`의 `spec.concurrency`) `--warm 10` `--main 60` `--repeat 1` `--generators`(⌈도착률 합 ÷ 1,000⌉) `--cpus 4` `--memory-mi 4096` `--record --run-id-prefix <접두>` `--out` |
| `gw capacity` | 프록시 파드의 CPU·Envoy 일꾼 수를 묶고(그 게이트웨이의 `EnvoyProxy`. gw-queue 밖 넷은 `peaket-proxy`를 함께 써서 넷 모두 묶인다) 도착률을 올려 포화 처리량(포화 앞 단계 도착률 ÷ 프록시 CPU)을 잰다. 프록시 CPU는 kubelet 요약 통계의 envoy 컨테이너 누적값으로 잰다 | `--gateway gw-queue` `--route gw-queue-buy` `--proxy-cpus 0.5` `--rates 500,1000,1500,2000,3000` `--delay fixed:5` `--warm 10` `--main 30` |
| `gw limits` | `gw sweep` 결과(`sweep.json` 여럿)로 r_min·평균 지연·여유 배수 k·운영 차단 상한(gw-queue와 나머지 넷)·r_pc를 센다(docs/infra.md §4.1 '값의 식', ADR-0287 결정 7). 클러스터를 쓰지 않는다 | `--from <sweep.json>[,<sweep.json>…]`(필수) `--saturation <vCPU 하나의 초당 건수>`(필수) `--pod-cpus <코어>`(필수) `--out`. 기본값이 없다 |
| `gw ip-limit` | 검색 IP 한도를 `X-Forwarded-For` 값을 바꿔 가며 잰다 | `--case single|many|mixed|v6-64`(필수) `--rate` `--ips`(경우마다 기본: single 150/s·IP 1, many 1,000/s·IP 1,000, mixed 1,000/s·IP 2만 + 한 IP 150/s, v6-64 1,000/s·/64 안 주소 100) `--main 60` |

- 발생기는 클러스터 안 k6 파드이고 게이트웨이 프록시 Service로 바로 보냅니다(k6 `hosts`로 호스트 이름을 Service 주소로. 포트 전달·포트 매핑을 거치지 않습니다). 토큰은 접속 정보(`.cache/peaket-tools/gateways-e2e.json`)의 시험 키로 도구가 만듭니다(`ticket:buy`, 수명은 실행 길이 + 10분). 지연은 대역 백엔드의 요청 머리 `x-e2e-delay-ms`로 고릅니다.
- `--mix normal`은 진입(gw-queue)·홀드·결제 접수(gw-fan)를 1,500 : 15 : 3 비율로 보내고, `--delay`는 재는 흐름(`--route`에 맞는 것)에만 줍니다. 다른 흐름은 정본 분포(5ms 90%·20ms 9%·100ms 1%)입니다.
- 임시 정책은 이름 `peaket-sweep-<라우트>`, 이름표 `peaket.io/sweep: "true"`, 대상은 그 HTTPRoute 하나, `mergeType: StrategicMerge`, 칸은 `circuitBreaker`뿐입니다. 그 라우트를 이미 겨눈 다른 정책이 있으면 시작하지 않습니다(같은 대상을 두 정책이 겨누면 Envoy Gateway가 하나를 버립니다). 단계마다 프록시 관리 포트의 `/clusters`에서 그 규칙 묶음(`httproute/envoy-gateway-system/<라우트>/rule/<번호>`)의 상한이 새 값으로 보일 때까지 90초 기다리고, 안 보이면 그 단계는 부하를 넣지 않고 무효('상한이 실리지 않음')입니다. 관리 포트는 파드 안에만 열려 있어 그때만 포트 전달로 잠깐 엽니다(부하는 거치지 않습니다).
- 보류 상한(`--max-pending`)을 주면 동시 상한보다 크게 줄 수 없습니다(인자 오류). 주지 않은 기본 1024(Envoy 기본값)는 이 검사를 하지 않습니다.
- 성능 장부(`--record`)로 옮기는 인자는 `runner/gw-run.mjs` `gwCollectArgs`가 만듭니다(R1). '0건' 목표(정상 부하 503, 503의 `Retry-After`·Problem 빠짐)는 점검이 아니라 판정(`--verdict pass|fail`)과 `notes`의 건수(보낸 수·상태별 수)로 넘기고, 점검은 과부하의 '503 p99 ≤ 3ms'(`<흐름>_503_p99_3ms`, 허용 0.01) 하나뿐입니다. 점검이 있고 판정이 통과면 장부가 점검으로 판정을 정하고(503이 최소 시행 수보다 적으면 비움), 무효 단계는 `--invalid-reason`만 넘깁니다.
- 단계마다 그 게이트웨이 `EnvoyProxy`의 CPU 요청·한도와 일꾼 수를 결과 파일 `proxy` 칸과 장부 `notes`에 적습니다(R6). `capacity`는 CPU를 묶기 전에 원래 값을 그 `EnvoyProxy`의 주석 `peaket.io/sweep-restore`에 남기고, 어느 명령이든 시작할 때 그 주석이 남아 있으면 재지 않고 끝 코드 1로 멈춥니다(강제 종료로 되돌리지 못한 경우). `node loadtest/run.mjs cleanup`이 주석의 값으로 되돌리고 주석을 지웁니다(`runner/gw-run.mjs` `cleanupGw`).
- 실제 일꾼 수(ADR-0287 결정 10, BAT-058): `sweep`·`capacity`는 단계마다 상한이 실린 뒤(`capacity`는 CPU를 묶은 뒤) 부하를 넣기 전에 그 게이트웨이의 프록시 파드마다 통계(`/stats/prometheus`)의 `envoy_server_concurrency`(Envoy 통계 `server.concurrency`)를 읽습니다. 기대 값은 `sweep`이 `--workers`, 없으면 그 `EnvoyProxy`의 `spec.concurrency`(둘 다 없으면 기대 없이 읽은 값만 적음), `capacity`가 자기가 묶은 값(⌊CPU⌋, 1 이상)입니다. 한 파드라도 다르면 `일꾼 수가 <기대>가 아님(<파드> <값>)`, 못 읽으면 `일꾼 수를 못 읽음: …`으로 그 단계는 부하 없이 무효이고(`capacity`는 거기서 멈춤) 성능 장부에는 넘기지 않습니다(k6 요약이 없다). 읽은 값은 단계 줄 `workers`(`{ expected, source: flag|envoyproxy|capacity|null, pods }`)와 장부 `notes`에 적습니다.
- 흐름마다의 2xx 평균 응답 시간(`streams.<흐름>.latency2xx.avg`, 재는 흐름이 하나면 `latency.2xx.avg`에도)은 발생기마다의 k6 요약의 `gw_dur_2xx` 평균을 그 발생기의 2xx 수로 가중한 값입니다(합친 요약의 평균은 발생기 가운데 큰 값이라 쓰지 않는다). 발생기마다의 요약을 못 읽으면 `null`이고 `gw limits`가 그 단계를 쓰지 못합니다.
- `gw limits`는 정상 부하·gw-queue `gw-queue-buy`·같은 도착률·연결 = 동시·보류 = ⌈동시 ÷ 8⌉인 단계만 받고(섞이면 까닭을 찍고 끝 코드 1), 무효 단계는 통과로도 실패로도 세지 않습니다. r_min은 '한 번이라도 실패한 가장 큰 후보의 바로 위 후보이고 3회 모두 통과한 값', k는 r_min ÷ (도착률 × 평균 지연)을 0.1 단위로 올리고 하한 2, 상한은 정수로 셈해 한 번만 올립니다. 유효 단계마다 결과 줄 `workers.pods`(읽은 일꾼 수)가 모두 있고 `--pod-cpus`와 같아야 셈합니다(다르거나 칸이 없는 옛 결과 파일이면 섞인 입력, BAT-058 리뷰 반영 RV-04). 올리기 전 k가 5 이상이면(정수로 견줌: r_min × 1,000,000 ≥ 5 × 도착률 × 평균 지연µs, 경계 5는 넘은 쪽) 되돌릴 조건(ADR-0287)이라 상한을 내지 않고 `rollback: true`와 '운영 값에 쓰지 않음'을 남깁니다(RV-03). 결과 `limits.json`(`determined`·`inputs`·`runs`·`rMin`·`meanLatencyMs`·`kRaw`·`k`·`rPod`·`rPc`·`limits`·`rollback`·`reasons`·`next`·`warnings`). 끝 코드 0 정함, 1 파일을 못 읽음·입력이 섞임·r_min을 정하지 못함·되돌릴 조건(`determined: false`와 까닭·다음 할 일), 2 인자 오류.
- 단계 판정(`runner/gw.mjs` `judgeSweepStreams`·`judgeSweepStep`): ①·②는 계산이 아니라 부하 꼴로 가릅니다. `--delay normal`이면 정상 부하 단계(①), `--delay fixed:<ms>`면 과부하 단계(②)이고, 고정 지연인데 재는 흐름들의 도착률 × 지연이 동시 상한 이하이면 과부하가 아니라 인자 오류입니다(BAT-056 R8). ①은 보낸 흐름 모두를 합친 본구간 503 0건과 Envoy 넘침 0(R7), ②는 재는 흐름마다(`--route gw-fan-buy`면 홀드·결제 접수 둘) 게이트웨이 503의 발생기 p99 ≤ 3ms(접근 로그 `durationMs`로 교차 확인, 발생기 쪽만 넘으면 '측정 지점 의심'으로 무효), 둘 다 503 모두 숫자 `Retry-After`와 Problem 본문, 처리 중 최대 ≤ 동시 상한입니다. 상한이 실리지 않음·통계를 못 읽음·보낸 수 0·`dropped_iterations` 1 이상·발생기 무효·과부하인데 503 0건, 그리고 어느 흐름이든 2xx·503 밖의 응답(401·403·404·429·연결 실패·시간 넘김)이 한 건이라도 있으면 통과가 아니라 무효입니다(R2. `ip-limit`은 2xx·429 밖).
- 산출물은 `.cache/peaket-loadtest/<날짜>-gw-<명령>-<실행>/`(또는 `--out`)의 `sweep.json`·`capacity.json`·`ip-limit.json`(단계마다 세 상한 값·도착률·지연 꼴·보낸 수·상태별 수·넘침 카운터·처리 중·보류 최대·2xx와 503의 p50·p99·최대·`Retry-After` 있음·없음·값 목록·Problem 본문 맞는 수·접근 로그 503의 3ms 이하 비율·발생기 CPU·`dropped_iterations`·`valid`·`invalid_reason`·판정)과 `step-<번호>/`(요약·k6 로그·콘솔)입니다. `--record --run-id-prefix <YYYY-MM-DD-…>`는 단계마다 성능 장부 실행 하나(프로파일 `local-gw`, 실행 ID `<접두>-sweep-<번호>-p<동시>-q<보류>-c<연결>-r<되풀이>` 등)를 남깁니다.
- 임시 정책과 CPU 묶음은 정상 끝·오류·종료 신호 모두에서 되돌리고, `node loadtest/run.mjs cleanup`도 이름표로 임시 정책을 지우고 남은 CPU 묶음 주석을 되돌립니다. 종료 코드는 위와 같습니다(0 실행을 마치고 결과를 씀(판정이 실패·무효여도), 1 도구 오류, 2 인자 오류, 128 + 신호).

## 파일

| 파일 | 하는 일 |
| --- | --- |
| `scenarios/v0-queue.js`·`v0-seat-hold.js`·`v0-payment.js` | v0 시나리오(docs/verification.md §3.9 '시나리오') |
| `scenarios/calibrate.js` | 발생기 보정 시나리오(대기 상태 조회와 같은 모양의 HTTPS GET) |
| `scenarios/common.js` | 시나리오가 함께 쓰는 k6 부분(요청·기록 내기·구간 표시·요약 쓰기·준비 구간) |
| `lib/model.mjs` | 오픈 모델 구간과 대기자 조회 도착률(서버와 같은 거리별 간격) |
| `lib/records.mjs` | 시험 기록 줄(KST 시각) |
| `lib/users.mjs`·`lib/seats.mjs` | 가상 사용자 가명·IP·머리, 좌석 고르기 |
| `runner/args.mjs`·`manifests.mjs`·`results.mjs` | 인자 검사, 발생기 파드·빈 응답 대역 객체, 발생기 지표·판정·보정 용량·기록 나누기·장부 인자 |
| `run.mjs` | 실행 도구 |
| `runner/gw.mjs`·`runner/gw-run.mjs`·`scenarios/gw.js` | 게이트웨이 차단 상한·검색 IP 한도 측정(`gw`): 인자·단계 펼치기·임시 정책·통계 읽기·판정·장부 점검(순수 함수), 실행 조립(클러스터는 주입), k6 시나리오 |
| `test/*.test.mjs` | 계산·실행 도구 시험과 시나리오 형식 검사(`node --test "loadtest/test/*.test.mjs"`, CI `loadtest-check.yml`) |
| `scenarios/v1-*.js`·`v1-common.js`, `lib/v1.mjs`·`lib/purchase-auth.mjs`, `queries/v1.txt` | v1 경로의 시나리오와 계산(신원·좌석 UUID·시각 기반 일련번호·VU별 사용자 나누기, k6·Node 공용 구매 요청 인증), 합본 서버 지표 질의(BUILD_ORDER PRF-215) |
| `e2e/v1-rehearsal.e2e.mjs` | v1 합본 리허설(K1·K2·K7 ② 작은 규모 한 번씩, 장부에 남기지 않음, `node --test loadtest/e2e/v1-rehearsal.e2e.mjs`) |
| `e2e/v0-rehearsal.e2e.mjs` | 실제 kind에서 시나리오마다 작은 규모로 끝까지 돌려 보는 리허설(docs/perf-ledger.md §3 1번, `node --test loadtest/e2e/v0-rehearsal.e2e.mjs`) |
| `plan/bat025-plan.json`·`plan/bat025-plan.mjs` | BAT-025(PRF-220) 측정 창 1의 실행 목록(A/A·Q-T5·K2·K1·K7 ②·규칙 검사)과 상태 파일로 이어 돌기(`.cache/peaket-bat025/state.json`, 쓰는 법은 [plan/README.md](plan/README.md)) |
| `analytics/` | F-04-8 측정 하네스. Kafka Avro 발생기·집계·검증·실행기로 초당 3만 건 신선도·누락률·강제 종료 정확성을 잰다([analytics/README.md](analytics/README.md), docs/review/plans/F-04-8.md) |

## 알아 둘 것

- 가상 사용자 수 상한은 발생기 메모리 × 0.6 ÷ 가상 사용자당 2MiB [가정]로 잡습니다(`run.mjs`의 `ASSUMED_VU_MI`). 보정이 잰 값은 0.9~1.3MB라 넉넉한 쪽입니다(docs/verification.md §3.9 '보정 결과'). 대상이 느려져 가상 사용자가 모자라면 `dropped_iterations`가 생겨 그 실행은 무효입니다.
- 이 PC에서 발생기 하나(CPU 4개)가 놓침 없이 보내는 도착률은 1,000/s까지였습니다(2026-11-03 보정). 그보다 높으면 CPU가 남아도 드물게 반복을 놓쳐 무효가 될 수 있습니다(docs/verification.md §3.9 '보정 결과').
- K4(변경분 연결 5,000개)는 `v0 seat-deltas`의 받는 파드(가벼운 Node 클라이언트), K5는 `k5/seatmap-lab.mjs`, K10은 `v0 gate`, K9는 `--hpa-timeline`으로 잽니다. K6(봇)·K8(경보)은 그 측정 단계(BOT-170·OPS-500)에서 함께 잽니다(docs/verification.md §3.10).
- 최고 도착률이 1,000/s를 넘으면 발생기를 나눕니다(k6 실행 구간). 요청 수·실패·놓침·목표를 넘은 수는 더하고, p99는 발생기별 값의 아래·위 한계로 적습니다(장부는 위 한계). `--record`면 경로 목표 점검(`checks.json`)과 서버 지표(`--prom-url`)를 장부에 넣고, 큰 원본은 `.cache/perf-raw-outbox`에 둡니다(S3 올리기는 소유자 몫).
