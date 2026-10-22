# tools/perf-ledger: 성능 장부 도구

측정 1회의 산출물을 한 폴더에 모으고(`collect.py`), 장부 표를 다시 만들고(`index.py`), 원본 CSV에서 그래프를 그린다(`charts.py`). 표준 라이브러리만 쓰고 Python 3.10 이상에서 돈다. 장부의 규칙은 `docs/perf-ledger.md`.

## 1. k6 요약 파일 만들기

k6 스크립트 끝에 `k6-summary.js`의 `handleSummary`를 붙이면 측정이 끝날 때 `summary.json`이 생긴다.

```javascript
export { handleSummary } from './tools/perf-ledger/k6-summary.js';
```

초 단위 시계열이 필요하면(폭발 시간선) k6를 Prometheus remote write로 내보내고 `collect.py`가 Prometheus에서 다시 뽑는다.

```bash
k6 run --out experimental-prometheus-rw scenario.js
```

## 2. 수집

```bash
python tools/perf-ledger/collect.py --run-id 2026-11-02-k1-v0-local-10k --kpi K1 --version v0 --profile local-10k --users 10000 --rps 20000 --duration 600 --warmup 120 --scenario peaket-loadtest/k1-entry.js --k6-summary ./summary.json --prom-url http://localhost:9090 --start 2026-11-02T10:00:00Z --end 2026-11-02T10:10:00Z --queries tools/perf-ledger/queries.example.txt --infra-file ./infra.txt --invariants ./invariants.csv --cost-file ./cost.csv --notes "예열 2분 제외"
```

- 폴더 `perf-ledger/runs/<run-id>/`를 만들고 `manifest.json`, `k6-summary.json`, `metrics/*.csv`, 첨부 파일, `SHA256SUMS`를 쓴다.
- `--prom-url`이 없으면 시계열 내보내기를 건너뛴다. `--queries` 파일은 한 줄에 `이름=PromQL`이다.
- k6 요약의 `dropped_iterations`가 0보다 크면 `valid: false`로 적는다(발생기 병목).
- `--commit`을 주지 않으면 현재 폴더의 `git rev-parse HEAD`를 시도하고, 저장소가 아니면 비워 둔다.
- `--extra 경로`를 여러 번 주면 파일이나 폴더를 그대로 복사한다(트레이스, Grafana PNG).
- `--timeline ./timeline.csv`는 Game Day 시간선(docs/perf-ledger.md §8), `--invalid-reason "스팟 회수"`는 사람이 판단한 무효 사유, `--verdict pass|fail|baseline`은 판정이다.
- `--step`은 시계열 간격(초, 기본 1). 같은 run-id 폴더가 있으면 멈추며 `--force`로만 덮어쓴다.
- `--confusion ./confusion.csv`는 K6(봇 탐지) 측정의 혼동 행렬이다. 열은 `tier,round,label,predicted,count[,stratum]`이고 label·predicted는 `bot` 또는 `human`, 사람 행의 tier는 `-`다. tier는 `<유형>-L<단계>`(예: `volume-L1`)로 쓰며 3단계는 탐지율 목표를 판정하지 않는다. 사람 행 중 stratum이 빈 행만 합계에 쓰고, stratum이 있는 행은 층별 오탐 집계에만 쓴다. 등급·라운드별 탐지율과 Wilson 95% 구간, 등급별 하락폭, 사람 오탐률과 단측 95% 상한(Clopper-Pearson)을 manifest의 `k6_eval`에 적고 장부 표의 판정 칸에 요약을 붙인다(ADR-0039·0048).
- `--k6-plan N:C`는 사전 등록한 판정용 사람 표본 수와 합격 오탐 수다(예: `947:1`). 오탐 C건의 상한이 0.5%를 넘는 조합은 거부한다. 마지막 라운드 사람 합계로 통과·실패·판정 보류(표본 부족)를 낸다.
- `--bot-cost ./bot_cost.csv --bot-prices ./bot_prices.json`은 1장당 획득 비용과 웃돈별 손익을 manifest의 `k6_cost`에 적는다. 열과 단가 키는 docs/perf-ledger.md §10.5에 있다.
- 콘솔 출력은 `stdout.log`에도 남는다.

## 3. 장부 표 갱신

```bash
python tools/perf-ledger/index.py
```

`perf-ledger/runs/*/manifest.json`을 읽어 `docs/perf-ledger.md`의 `<!-- ledger:begin -->`과 `<!-- ledger:end -->` 사이 표를 다시 쓴다. p99와 오류율은 `k6-summary.json`에서 읽는다.

## 4. 그래프

```bash
python tools/perf-ledger/charts.py scale --runs 2026-11-02-k1-v1-local-1k 2026-11-02-k1-v1-local-10k 2026-11-02-k1-v1-local-100k --out perf-ledger/charts/scale-v1.svg
python tools/perf-ledger/charts.py before-after --pairs K1=2026-11-02-k1-v0-local-10k:2026-11-09-k1-v1-local-10k --metric p99 --out perf-ledger/charts/before-after-p99.svg
python tools/perf-ledger/charts.py timeline --run 2026-11-16-k1-v1-local-100k --series origin_rps,p99_ms,error_rate --out perf-ledger/charts/burst.svg
python tools/perf-ledger/charts.py usl --points perf-ledger/charts/k1-entry-usl.csv --target 200000 --out perf-ledger/charts/k1-entry-usl.svg
```

- `scale`: 각 측정의 `scale.users`를 가로축으로, `metrics/origin_rps.csv`의 평균(예열 제외)과 k6 p99를 세로축으로 그린다.
- `before-after`: KPI별로 두 측정의 값(`p99` 또는 `error_rate`)을 막대로 그린다.
- `timeline`: `metrics/<이름>.csv`를 시간축으로 겹쳐 그린다.
- `usl`: 진입 서버 대수별 처리량 표(CSV 열 `n,throughput[,run_id]`, `throughput`은 SLO를 지킨 가장 높은 도착률)에 USL(Universal Scalability Law)을 맞춘다. N=1 점이 있어야 하고 서로 다른 N이 6개보다 적으면 경고한다. 경합 계수 α, 일관성 계수 β, 결정계수, 정점 N, `--target` 처리량에 필요한 N과 외삽 배수(필요한 N ÷ 측정 최대 N)를 출력하고 같은 이름의 `.json`에 남긴다. 측정 범위 밖 곡선은 점선이다. 절차와 판정 기준은 `docs/verification.md` §3.3이다(ADR-0057).

SVG는 의존성 없이 생성되며 브라우저와 GitHub에서 바로 보인다.

## 5. 측정 전 점검(리허설)

```bash
python tools/perf-ledger/collect.py --selftest
```

임시 폴더에 가짜 요약으로 전체 흐름을 돌려 도구가 정상인지 확인한다. 클라우드 측정 전에 한 번 돌린다.
