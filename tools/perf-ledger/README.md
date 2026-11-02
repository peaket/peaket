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
python tools/perf-ledger/collect.py --run-id 2026-11-02-k1-v0-local-10k --kpi K1 --version v0 --profile local-10k --users 10000 --rps 20000 --duration 600 --warmup 120 --scenario loadtest/k1-entry.js --k6-summary ./summary.json --prom-url http://localhost:9090 --start 2026-11-02T10:00:00Z --end 2026-11-02T10:10:00Z --queries tools/perf-ledger/queries.example.txt --infra-file ./infra.txt --invariants ./invariants.csv --cost-file ./cost.csv --notes "예열 2분 제외"
```

- 폴더 `docs/perf-ledger/runs/<run-id>/`를 만들고 `manifest.json`, `k6-summary.json`, `metrics/*.csv`, `metrics-summary.json`, 첨부 파일, `SHA256SUMS`를 쓴다.
- `metrics-summary.json`은 `metrics/<이름>.csv`마다 예열(`--warmup`)을 뺀 구간의 p50·p99·최대·평균이다(docs/perf-ledger.md §2.1). 백분위는 가장 가까운 순위 방식(정렬한 값의 ⌈q × n⌉번째)이고, 시계열이 여럿이면 첫 시계열만 쓰며 시계열 수와 그 라벨을 함께 적는다(`charts.py`와 같다).
- `--raw-bucket s3://<원본 버킷>`을 주면 큰 원본(`metrics/`·`traces/`·`grafana/`·`stdout.log`)을 S3 원본 버킷의 `runs/<run-id>/` 아래에 파일마다 gzip으로 묶은 `<경로>.gz`로 올리고, manifest `raw_uri`에 그 주소를 적는다(docs/perf-ledger.md §2.1·§9, 기술 검토 낮음-056). `SHA256SUMS`는 올리기 전에 만들어 올린 원본(압축 전)의 해시도 담는다. 올리기 전에 해시를 다시 대조하고, 모두 올라가면 폴더의 원본을 지워 Git에는 작은 파일과 해시만 남긴다. 하나라도 실패하면 아무것도 지우지 않고 종료 코드 1로 멈추며, 고친 뒤 `collect.py --upload-raw <run-id>`로 다시 올린다. 올리기는 AWS CLI(`aws s3 cp`)를 부르므로 그 실행 환경에 AWS CLI와 버킷 쓰기 권한이 있어야 한다(버킷은 버전 관리를 켠다, §9). 원본을 확인할 때는 `aws s3 cp <raw_uri><경로>.gz - | gunzip | sha256sum`을 `SHA256SUMS`의 그 줄과 견준다. `--raw-bucket`이 없으면 원본은 폴더에 남고 `stdout.log`에 그 사실을 적는다.
- `--redis-tls true|false`와 `--paired-run <run-id>`는 대기열·좌석 Redis 연결의 TLS 켬·끔과, 같은 조건으로 반대 설정을 잰 짝 실행이다(manifest `redis_tls`·`paired_run`, docs/perf-ledger.md §2.2, docs/verification.md §3.5 7번, 기술 검토 낮음-072). 짝이 없거나, TLS를 끈 실행에 `--verdict pass|fail`을 주면 '판정은 TLS를 켠 실행으로 한다'는 안내를 `stdout.log`에 남긴다.
- `--bench-summary ./result.json`은 k6가 아닌 측정 도구(`loadtest/poc/bench`)의 결과다. 그 안의 `bench` 칸(`p99_ms`·`error_rate`·`requests`·`dropped`)을 manifest `bench`에 옮기고 파일을 `bench-summary.json`으로 붙인다. 장부 표는 k6 요약이 없으면 이 값을 쓰고, 10ms보다 작은 p99는 소수 둘째 자리까지 적는다. `dropped`(동시에 기다리는 요청이 상한을 넘어 보내지 못한 요청, k6 `dropped_iterations`와 같은 뜻)가 0보다 크면 `valid: false`다(wbs 0.5.1, 2026-11-01).
- `--prom-url`이 없으면 시계열 내보내기를 건너뛴다. `--queries` 파일은 한 줄에 `이름=PromQL`이다.
- k6 요약의 `dropped_iterations`가 0보다 크면 `valid: false`로 적는다(발생기 병목).
- `--commit`을 주지 않으면 현재 폴더의 `git rev-parse HEAD`를 시도하고, 저장소가 아니면 비워 둔다. 값은 manifest `commit.code`에 들어간다. 코드와 문서가 `peaket` 한 저장소에 있어 커밋 하나가 둘 다 가리키므로 `commit.docs`는 비워 둔다(docs/perf-ledger.md §2.2, ADR-0165).
- `--extra 경로`를 여러 번 주면 파일이나 폴더를 그대로 복사한다(트레이스, Grafana PNG).
- `--timeline ./timeline.csv`는 Game Day 시간선(docs/perf-ledger.md §8), `--invalid-reason "스팟 회수"`는 사람이 판단한 무효 사유, `--verdict pass|fail|baseline`은 판정이다.
- `--step`은 시계열 간격(초, 기본 1). 같은 run-id 폴더가 있으면 멈추며 `--force`로만 덮어쓴다.
- `--confusion ./confusion.csv`는 K6(봇 탐지) 측정의 혼동 행렬이다. 열은 `tier,round,label,predicted,count[,stratum]`이고 label·predicted는 `bot` 또는 `human`, 사람 행의 tier는 `-`다. tier는 `<유형>-L<단계>`(예: `volume-L1`)로 쓰며 3단계는 탐지율 목표를 판정하지 않는다. 사람 행은 판정 세션만 세고(ADR-0112), 그중 stratum이 빈 행만 합계에 쓰며, stratum이 있는 행은 층별 오탐 집계에만 쓴다. 등급·라운드별 탐지율과 Wilson 95% 구간, 등급별 하락폭, 사람 오탐률과 단측 95% 상한(Clopper-Pearson)을 manifest의 `k6_eval`에 적고 장부 표의 판정 칸에 요약을 붙인다(ADR-0039·0048).
- `--k6-plan N:C`는 사전 등록한 판정 세션을 낸 사람 수와 합격 오탐 수다(예: `947:1`, 1인 1판정 세션, ADR-0112). 오탐 C건의 상한이 0.5%를 넘는 조합은 거부한다. 마지막 라운드 사람 합계로 통과·실패·판정 보류(표본 부족)를 낸다.
- `--human-sessions ./human_sessions.csv`는 사람 세션 한 줄이 한 행인 파일이다(ADR-0112). 열은 `participant,site,role,stratum,round,predicted,score`이고 role은 `judge`(판정 세션) 또는 `ref`(참고 세션), predicted는 `bot` 또는 `human`, score는 위험 점수다. 한 세션이 여러 층에 속하면 stratum을 `;`로 나눠 적는다. 도구는 ① 참가자마다 judge가 꼭 하나인지 ② judge 수가 `--k6-plan`의 N과 같은지 ③ judge 수와 그 오탐 수가 `confusion.csv` 마지막 라운드 사람 합계와 같은지 확인하고, 하나라도 어긋나면 측정 폴더를 만들지 않고 실행을 거부한다(종료 코드 1). `--confusion`과 `--k6-plan`이 함께 있어야 한다. 통과하면 manifest `k6_eval`에 `human_units`(사람 수·판정 세션 수·참고 세션 수·확인 결과), `sessions_per_person`(사람당 세션 수 → 사람 수), `human_icc`(세션 2개 이상인 사람의 위험 점수로 낸 일원 랜덤 효과 ICC(1)과 F 분포로 낸 단측 95% 상한. 사람마다 세션 수가 달라도 되는 꼴), `ref_strata`(참고 세션의 층별 오탐), `judged_fp_refs`(판정 세션이 오탐인 사람의 참고 세션 결과 건수)를 적는다. 이 파일은 개인 단위 자료라 측정 폴더에 복사하지 않고, 가명 코드는 manifest·`stdout.log`에 남기지 않는다(실행 거부 메시지는 고칠 곳을 찾도록 화면에만 코드 몇 개를 보인다). 원본은 평가 실행 뒤 30일 안에 지운다(docs/perf-ledger.md §10.1).
- `--bot-outcomes ./bot_outcomes.csv`는 봇 세션의 끝 결과다(기술 검토 중간-104). 열은 `tier,round,solve_rate,sessions,detected,blocked,verify_passed,admitted`이고 풀이 성공률(`0`·`0.5`·`0.95`)마다 한 행이다. 도구는 같은 등급·라운드에서 풀이 성공률별 `detected` 합이 `confusion.csv`의 봇 판정 수와 같은지, `blocked + verify_passed ≤ detected`인지, `admitted ≤ sessions`인지 확인하고 어긋나면 실행을 거부한다. 통과하면 파일을 `bot_outcomes.csv`로 복사하고 manifest `k6_eval`에 `verify_pass`(verify_passed ÷ detected), `e2e_success`(admitted ÷ sessions, 둘 다 Wilson 95% 구간), `bot_share_est`를 적는다. `bot_share_est`는 마지막 라운드 1·2단계 등급을 합친 탐지율 d와 같은 등급을 합친 풀이 성공률별 통과율 r로 docs/planning/01 §3.2 표준 시나리오의 봇 점유율 (50만 × (1 − d) + 50만 × d × r) ÷ (그 값 + 49.75만)을 다시 계산한 값이고, 같은 내용을 manifest `notes` 끝에 한 줄로 붙인다(docs/perf-ledger.md §10.2).
- `--bot-cost ./bot_cost.csv --bot-prices ./bot_prices.json`은 1장당 획득 비용과 웃돈별 손익을 manifest의 `k6_cost`에 적는다. 열과 단가 키는 docs/perf-ledger.md §10.5에 있다.
- 콘솔 출력은 `stdout.log`에도 남는다.

## 3. 장부 표 갱신

```bash
python tools/perf-ledger/index.py
```

`docs/perf-ledger/runs/*/manifest.json`을 읽어 `docs/perf-ledger.md`의 `<!-- ledger:begin -->`과 `<!-- ledger:end -->` 사이 표를 다시 쓴다. p99와 오류율은 `k6-summary.json`에서 읽는다.

```bash
python tools/perf-ledger/index.py --stamp 2026-11-02   # 날짜를 빼면 오늘(UTC)
python tools/perf-ledger/index.py --upgrade            # 몇 시간 뒤, 증명 확정
```

- `--stamp`는 표를 다시 쓴 뒤, 그날(UTC, manifest `ended_at`, 없으면 `collected_at`) 끝난 실행들의 `SHA256SUMS` 해시를 `docs/perf-ledger/timestamps/<날짜>.txt`에 `<해시>  runs/<run-id>/SHA256SUMS` 줄로 모으고 `ots stamp`로 OpenTimestamps 증명 `<날짜>.txt.ots`를 만든다(docs/perf-ledger.md §9, 기술 검토 낮음-056). 하루 한 번, 그날 측정이 끝난 뒤 돌린다.
- 같은 날을 다시 돌리면 내용이 같을 때는 아무것도 바꾸지 않는다. 이미 `.ots`가 있는 날의 해시 목록이 달라졌으면(고정 뒤 변경) 고치지 않고 종료 코드 1로 멈춘다.
- `--upgrade`는 `timestamps/*.ots`마다 `ots upgrade`를 불러 확정 증명으로 갱신한다(보통 몇 시간 뒤). 갱신한 `.ots`를 Git에 넣는다. 아직 확정되지 않은 것은 다음에 다시 돌린다.
- OpenTimestamps 클라이언트(`ots` 명령, opentimestamps-client)가 그 실행 환경에 있어야 한다. 없으면 `.txt`만 쓰고 종료 코드 1로 알린다.

## 4. 그래프

```bash
python tools/perf-ledger/charts.py scale --runs 2026-11-02-k1-v1-local-1k 2026-11-02-k1-v1-local-10k 2026-11-02-k1-v1-local-100k --out docs/perf-ledger/charts/scale-v1.svg
python tools/perf-ledger/charts.py before-after --pairs K1=2026-11-02-k1-v0-local-10k:2026-11-09-k1-v1-local-10k --metric p99 --out docs/perf-ledger/charts/before-after-p99.svg
python tools/perf-ledger/charts.py timeline --run 2026-11-16-k1-v1-local-100k --series origin_rps,p99_ms,error_rate --out docs/perf-ledger/charts/burst.svg
python tools/perf-ledger/charts.py usl --points docs/perf-ledger/charts/k1-entry-usl.csv --target 200000 --out docs/perf-ledger/charts/k1-entry-usl.svg
```

- `scale`: 각 측정의 `scale.users`를 가로축으로, `metrics/origin_rps.csv`의 평균(예열 제외)과 k6 p99를 세로축으로 그린다.
- `before-after`: KPI별로 두 측정의 값(`p99` 또는 `error_rate`)을 막대로 그린다.
- `timeline`: `metrics/<이름>.csv`를 시간축으로 겹쳐 그린다.
- `usl`: 진입 서버 대수별 처리량 표(CSV 열 `n,throughput[,run_id]`, `throughput`은 SLO를 지킨 가장 높은 도착률)에 USL(Universal Scalability Law)을 맞춘다. N=1 점이 있어야 하고 서로 다른 N이 6개보다 적으면 경고한다. 경합 계수 α, 일관성 계수 β, 결정계수, 정점 N, `--target` 처리량에 필요한 N과 외삽 배수(필요한 N ÷ 측정 최대 N)를 출력하고 같은 이름의 `.json`에 남긴다. 측정 범위 밖 곡선은 점선이다. 절차와 판정 기준은 `docs/verification.md` §3.3이다(ADR-0057).

원본을 S3 원본 버킷으로 옮긴 실행은 폴더에 `metrics/*.csv`가 없다. `scale`은 그때 `metrics-summary.json`의 `origin_rps` 평균(예열 뺌)을 쓴다. `timeline`은 시계열 전체가 필요하므로 `raw_uri`에서 `metrics/<이름>.csv.gz`를 받아 풀어 둔 뒤 그린다(없으면 받을 주소를 알려 준다).

SVG는 의존성 없이 생성되며 브라우저와 GitHub에서 바로 보인다.

## 5. 측정 전 점검(리허설)

```bash
python tools/perf-ledger/collect.py --selftest
```

임시 폴더에 가짜 요약으로 전체 흐름을 돌려 도구가 정상인지 확인한다. 클라우드 측정 전에 한 번 돌린다. S3와 OpenTimestamps는 부르지 않고 가짜 버킷(임시 폴더)과 가짜 `ots`로 바꿔 끼워, `metrics-summary.json` 값, 원본 올리기와 폴더 정리, 버킷 원본과 `SHA256SUMS`의 해시 일치, 올리기 실패 뒤 `--upload-raw`, `redis_tls`·`paired_run`, 하루 해시 묶음과 고정 뒤 변경의 거부를 확인한다. K6 쪽은 docs/verification.md V-T25의 세 경우(참가자 947명이 판정 세션 하나씩이면 판정하고 사람 단위 집계를 남김, 한 참가자가 판정 세션 둘이면 거부, 판정 세션 946개면 거부)와 판정 세션이 없는 참가자, 봇 끝 결과의 세 확인(detected 합, blocked + verify_passed, admitted)의 거부, ICC(1)·F 분위수의 알려진 값(Shrout·Fleiss 1979 예제, F 분포표)도 확인한다.

명령줄 시험은 `node --test "tools/perf-ledger/*.test.mjs"`다. 도구를 명령줄로 부르고(Prometheus는 시험이 띄운 흉내 서버, k6는 가짜 명령) manifest·장부 표·종료 코드를 본다. CI의 `tools-check.yml`이 이 시험과 `--selftest`를 함께 돌린다.

## 6. 비율·백분위 점검과 지연 대조(`--checks`)

```bash
python tools/perf-ledger/collect.py --run-id … --checks ./checks.json --k6-summary ./summary.json --prom-url http://localhost:9090 --start … --end … --warmup 120
```

`checks.json`의 `checks`는 비율·백분위 목표마다 한 줄이다. 시행 수·어긴 수를 직접 적거나(`"trials": 3000, "violations": 0`), 서버 히스토그램(`"histogram": {"metric": "http_server_request_duration_seconds", "match": "route=\"/v1/queues/{eventId}/entries\"", "le": 0.2}`)을 주면 측정 창(시작 + 예열 ~ 끝)의 끝과 시작의 칸 카운터 합을 Prometheus에서 읽어 그 차이로 센다(창 시작에 없던 시계열은 0부터, 창 안에서 사라진 시계열(생겼다 사라진 것 포함)·카운터 되돌아감이 있으면 거부). 도구가 점검마다 `cp_upper`·`min_trials`·`result`(`pass`·`fail`·`observed`)를 적고 판정(`verdict`)을 정한다. `--verdict pass`가 점검과 어긋나거나, 기준값과 같은 칸 경계가 없거나, 모르는 키·`NaN`·`Infinity`가 있으면 측정 폴더를 만들지 않고 거부한다. `crosscheck`(`{"check": "<히스토그램 점검 이름>", "k6_metric": "http_req_duration{phase:measure}"}`, 목표는 그 점검의 기준값 칸. k6는 기준(threshold)을 건 하위 지표만 요약에 남기므로 시나리오에 그 이름의 기준을 둔다)를 주면 k6 p99와 서버 p99·기준값 안 비율을 `latency_crosscheck`에 남기고 '측정 지점 의심'을 표시한다(docs/perf-ledger.md §2.2·§7, ADR-0077). 외삽·문서 인용을 장부에 남길 때는 `--evidence 계산만`을 준다(장부 표의 '증거 수준' 칸).

## 7. 야간 축소 성능 상대 비교(`nightly.py`)

```bash
python tools/perf-ledger/nightly.py run --config loadtest/nightly/config.json --out results.json
python tools/perf-ledger/nightly.py compare --results results.json --threshold loadtest/nightly/threshold.json --alert-out alert.md
python tools/perf-ledger/nightly.py aa-threshold --results aa-01.json … aa-10.json --out loadtest/nightly/threshold.json
```

`run`은 설정의 준비 명령(인자 목록, 셸을 거치지 않음)으로 두 판의 주소를 받고 k6를 기준·새 순으로 판마다 `rounds`번 돌려 p99 중앙값의 비율을 남긴다. k6가 시나리오 기준을 넘어 종료 코드 99로 끝나도 요약이 있으면 쓰고, 회차마다 지난 요약을 먼저 지운다. `--deadline-s`(기본 7000초)를 넘기면 멈춘 명령을 끊고 종료 2로 끝낸다. `compare`는 그 비율을 `max_ratio`와 견준다: 비어 있으면 경고만(종료 0), 넘으면 종료 1과 SEV3 이슈 본문이다. 입력이 틀리거나 준비 명령·k6가 실패하면 모든 명령이 종료 2다. `aa-threshold`는 같은 판끼리 잰 A/A 결과 10개 이상에서 `max_ratio` = 1 + 가장 큰 벗어남을 쓴다(docs/devops.md §3.3, D-T40).
