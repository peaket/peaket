# 성능 장부 (Performance Ledger)

- **독자와 용도**: 성능 측정 엔지니어와 기술 면접관·코드 검토자가 참조하는 기준 문서다. 성능 측정 엔지니어는 측정 결과가 객관적 증거가 되려면 남겨야 할 필수 산출물과 절차를 여기서 확인한다. 기술 면접관과 코드 검토자는 10대 핵심 KPI(성과를 재는 지표) 수치를 믿을 근거(실험 조건, 원천 데이터, 재현 스크립트)를 여기서 검증한다. 측정마다 원시 데이터는 저장소의 `docs/perf-ledger/runs/` 디렉터리 아래에 1회 실행당 폴더 하나로 따로 보존한다. 이 문서의 장부 요약 표는 자동화 도구가 그 폴더들의 메타데이터를 읽어 한꺼번에 만든다.
- **원본 출처**: 설계서 §10 KPI 10선과 '측정 방식', docs/planning/01-overview.md §3(핵심 KPI와 벤치마크 도구), docs/architecture.md §9.3(초기 v0 병목 분석과 v1 아키텍처 해결책), docs/observability.md §12(팀이 정한 목표인 SLO의 부하 시험과, 일부러 장애를 내고 대응을 연습하는 Game Day 훈련), POL-026(테스트·윤리 규칙), docs/verification.md(규칙 검사와, 잰 범위의 결과를 식으로 늘려 더 큰 규모의 값을 구하는 100만 외삽, ADR-0057).
- **기준 기획 버전**: v1.0. 벤치마크 틀은 2026-10-10에 만들었고, 실제 데이터는 Phase 1(작업 목록 WBS 1.4.1)부터 차례로 쌓는다. 이 문서에 실은 예시 데이터 행은 서식 표준을 보여 주려고 쓴 것이다.
- **자동화 도구 체계**: `tools/perf-ledger/` 아래 스크립트(데이터 수집기 `collect.py`, 색인 갱신 도구 `index.py`, 벡터 시각화 도구 `charts.py`, 부하 시험 도구인 k6의 결과 파서 `k6-summary.js`)로 관리한다. 자세한 사용법은 `tools/perf-ledger/README.md`에 적혀 있다.

## 1. 객관적 성능 증거의 3대 조건

| 필수 조건 | 조건의 의미 | 충족 및 보증 방법 |
| --- | --- | --- |
| 재현 가능성 (Reproducibility) | 같은 소스 코드, 같은 측정 환경 사양(로컬 PC 또는 클라우드), 같은 부하 시나리오로 자동화 명령 하나만 실행해 언제든 다시 잴 수 있어야 한다. 결과 수치는 실행마다 흔들리므로 반복 횟수와 중앙값을 함께 적는다(§3의 6). | `manifest.json`에 대상 Git 커밋 해시(커밋마다 하나뿐인 고정 길이 식별 값), 시나리오 파일 경로, 부하 매개변수, 인프라 프로파일 이름을 그대로 남기고, 실행에 쓰는 셸 명령 하나를 기록한다. |
| 원천 데이터 무결성 (Raw Data Auditability) | 시각화 차트는 2차 가공물일 뿐이므로, 가공하지 않은 기계 측정 원본 데이터를 반드시 원래 모양 그대로 보존해야 한다. | k6 실행 요약 JSON, 서버 시계열 메트릭 CSV, 비즈니스 불변식 검증 결과 CSV를 실행 폴더에 보존한다. 모든 차트는 스크립트가 이 파일들로 그리며, 같은 파일이면 늘 같은 차트가 나온다. |
| 측정 환경 조건의 투명성 (Context Completeness) | 측정 일시, 동시 접속 규모, 인프라 노드(앱이 실행되는 서버 한 대) 대수와 사양, 부하 발생기(Load Generator) 상태, 클라우드 비용까지 측정 배경을 빠짐없이 공개해야 한다. | `manifest.json`의 필수 메타데이터 필드(§2.2)를 모두 빠짐없이 채운다. 필수 항목이 비어 있으면 그 측정은 무효로 처리한다. |

손으로 캡처한 스크린샷과 화면 녹화 영상은 설명을 돕는 보조 자료일 뿐이다. 핵심 성능 지표의 공학적 근거로는 쓰지 않는다.

## 2. 측정 1회의 표준 산출물 구조

### 2.1 디렉터리 구조

```
docs/perf-ledger/
  runs/<run-id>/            단일 측정 실행 디렉터리 (예: 2026-11-02-k1-v0-local-10k)
    manifest.json           실행 환경 및 파라미터 메타데이터 (§2.2)
    k6-summary.json         k6 부하 도구 출력 원시 요약 JSON
    metrics-summary.json    쿼리 식별자별 요약(예열을 뺀 구간의 p50·p99·최대·평균). collect.py가 원본에서 만든다
    metrics/<name>.csv      Prometheus 시계열 메트릭 원본 (쿼리 식별자별 분리. 큰 원본이라 Git이 아니라 S3 원본 버킷에 둔다, §9)
    invariants.csv          비즈니스 불변식 검증 결과 (docs/verification.md §2.5의 불변식 SQL: 차례 전 입장, 같은 세대 순번 중복, 오버셀, 1인 한도 초과, 이중 결제, 결제-발권 불일치, 정산 돈 불변식)
    invariants-detail.ndjson 불변식 위반 행(불변식마다 1,000줄까지). 합성 데이터라도 ID 목록이라 Git이 아니라 S3 원본 버킷에 둔다(services/invariant-checker, 추천 적용 2026-11-02)
    traces/                 p99 이상치 요청의 OpenTelemetry 분산 트레이스 JSON (선택 사항)
    grafana/                측정 구간 Grafana 대시보드 렌더링 이미지 및 스냅샷 URL (보조 자료)
    infra.txt               실행 당시 측정 환경 사양(로컬은 CPU·메모리·WSL 설정과 CPU 배치, 클라우드는 인스턴스 타입), 커널 및 소프트웨어 버전 원본
    stdout.log              벤치마크 러너 스크립트 실행 콘솔 전체 출력 로그
    cost.csv                AWS 비용 할당 태그 기반 실측 인프라 비용 (클라우드 실행 한정)
    timeline.csv            Game Day 장애 주입 및 대응 시간선 로그 (§8, 관제 KPI 전용)
    hint_compare.csv        Datadog 이상 탐지 힌트 비교 (§8, wbs 4.8.2 비교 실행 한정)
    backend_cost.csv        관측 백엔드 비교의 비용 환산 입력·가격·결과 (§11, wbs 4.8.2 비교 실행 한정)
    confusion.csv           봇 탐지 등급·라운드별 오차 행렬과 사람 층별 집계 (K6 봇 탐지 한정, ADR-0039·0048)
    bot_cost.csv            등급·라운드별 1장당 획득 비용 원본 수량 (K6, §10.4)
    bot_outcomes.csv        봇 세션 끝 결과(등급·라운드·풀이 성공률별, K6, §10.5)
    bot_prices.json         1장당 획득 비용 단가 (K6, §10.4)
    SHA256SUMS              디렉터리 내 전체 산출물 파일(S3에 둔 원본 포함)의 암호학적 해시 지문 목록
  charts/                   charts.py가 원시 CSV로부터 생성한 표준 SVG 차트
  timestamps/<날짜>.txt     그날 끝난 실행들의 `SHA256SUMS` 해시 목록과, 그 파일의 OpenTimestamps 증명 `<날짜>.txt.ots`(§9)
```

Git에 두는 것과 S3 원본 버킷에 두는 것은 나눈다(추천 적용 2026-10-28, 기술 검토 낮음-056). Git에는 `manifest.json`, `k6-summary.json`, `metrics-summary.json`, `invariants.csv`, `infra.txt`, 작은 CSV(`cost.csv`·`timeline.csv`·`hint_compare.csv`·`backend_cost.csv`·`confusion.csv`·`bot_cost.csv`·`bot_outcomes.csv`), `bot_prices.json`, `SHA256SUMS`, `charts/`, `timestamps/`를 둔다. 큰 원본(`metrics/*.csv`, `traces/`, `grafana/`, `stdout.log`)과 불변식 위반 행 `invariants-detail.ndjson`은 S3 원본 버킷의 `runs/<run-id>/`에 두고, Git에는 해시만 남는다. 원본 위치는 manifest의 `raw_uri`에 적는다. 그래서 측정이 쌓여도 저장소가 GitHub 권장 크기(1GB 미만이 이상적, 5GB 미만을 강하게 권함, GitHub 문서 2026-10-27 확인)를 넘지 않는다.

### 2.2 manifest.json 필수 메타데이터 필드

| 필드명 | 설명 및 데이터 유형 | 입력 예시 |
| --- | --- | --- |
| `run_id` | 일시-KPI-버전-프로파일 조합의 고유 식별자 | `2026-11-02-k1-v0-local-10k` |
| `kpi` | 검증할 KPI의 식별자. K1~K10, Game Day `G-nn`, 또는 성능이나 보안 같은 품질 요구사항인 NFR의 번호 | `K1` |
| `version` | 아키텍처 버전 (`v0`: 처음 만들 법한 단순한 설계의 베이스라인, `v1`: 최종 아키텍처, ADR-0096) | `v0` |
| `profile` | 표준 인프라 환경 프로파일 (§4, docs/infra.md §3) | `local-10k`, `cloud-calib` |
| `scale` | 부하 규모 객체 (`users`: 가상 대기자 수, `arrival_rps`: 도착률, `duration_s`, `warmup_s`) | 동시 10,000명, 20,000 RPS(초당 요청 수), 유지 600초, 예열 120초 |
| `scenario` | k6 실행 스크립트의 상대 경로, 실행 인자, 오픈 모델(응답 속도와 상관없이 사용자가 정해진 속도로 계속 도착하게 하는 부하 시험 방식) 여부 | `loadtest/k1-entry.js`, `open_model: true` |
| `commit` | 벤치마크 대상 `peaket` 저장소의 커밋 해시. 코드와 문서가 한 저장소에 있어 커밋 하나가 둘 다 가리킨다. `commit.code`에 적고, `commit.docs` 칸은 비워 둔다. k6 시나리오는 공개 `peaket`의 `loadtest/`에 있어 `commit.code`가 가리킨다. 봇을 함께 돌린 실행은 비공개 `peaket-bots`의 커밋 해시를 `commit.loadtest` 칸에 적는다(칸 이름은 그대로 둔다, ADR-0169) | `git rev-parse HEAD` 해시값 |
| `raw_uri` | 큰 원본(`metrics/`·`traces/`·`grafana/`·`stdout.log`)을 둔 S3 원본 버킷 주소. 파일마다 해시는 `SHA256SUMS`에 있다(§2.1·§9, 추천 적용 2026-10-28, 기술 검토 낮음-056) | `s3://<원본 버킷>/runs/2026-11-02-k1-v0-local-10k/` |
| `generator` | 부하 발생기 대수, 인스턴스 사양, k6 버전, 발생기 병목을 보여 주는 지표 `dropped_iterations` | 1대(PC, 코어 8개 배정), k6 v0.50.0, `dropped_iterations: 0` |
| `host` | 같은 PC에서 잴 때 점마다 남기는 호스트 지표: 호스트 전체 CPU 사용률, 실행을 기다리는 프로세스 수(`procs_running`), 파드별 CPU 스로틀 비율, 코어 배치, 표시('호스트 포화'·'코어 혼합'. 기준은 docs/verification.md §3.5 6번, ADR-0096), 게이트웨이·진입 서버 파드의 커널 연결 대기열 카운터 `ListenOverflows`·`ListenDrops`의 측정 전후 값(늘었으면 `valid: false`, 사유 '커널 연결 버림', docs/verification.md §3.5 8번, 소유자 결정 2026-10-30, ADR-0154). 수집 도구 반영은 wbs 6.1.1 | `cpu_pct: 72`, `procs_running: 18`, `flags: []` |
| `redis_tls`, `paired_run` | 대기열·좌석 Redis 연결의 TLS 켬·끔(`true`/`false`)과, 같은 조건으로 반대 설정을 잰 짝 실행의 `run_id`. Redis 측정은 둘을 한 번씩 재고 판정은 켠 값으로 한다(docs/verification.md §3.5 7번, 추천 적용 2026-10-28, 기술 검토 낮음-072) | `redis_tls: true`, `paired_run: 2026-11-02-q-t5-v1-local-10k-notls` |
| `experiment` | 여러 구성을 함께 비교하는 실험의 묶음 ID와 이 실행의 구성 이름(예: 서비스 분리 세 구성 비교, docs/verification.md §3.8). 수집 도구 반영은 wbs 2.12.5 | `split-3way`, `by-role` |
| `started_at`, `ended_at` | 부하 시험의 시작·종료 시각. ISO8601 UTC 타임스탬프 | `2026-11-02T05:00:00Z` |
| `region` | 클라우드에서 실행할 때 배포한 리전(클라우드 데이터센터가 모인 지역), 또는 `local` 표기 | `local`, `ap-northeast-2` |
| `cost_krw`, `exchange_rate` | 부하 시험에 든 실측 AWS 인프라 비용(원)과 적용 환율 | 0 (로컬) 또는 실측 비용 |
| `valid` | 벤치마크가 유효한지 판정한 플래그(`true`/`false`)와 무효 사유 `invalid_reason` | 부하 발생기 CPU가 포화되면 `false`로 표시 |
| `verdict` | 최종 검증 판정 결과 (`pass`, `fail`, `baseline`). 아래 `checks`가 있으면 `collect.py`가 정한다: 모두 `pass`면 `pass`, 하나라도 `fail`이면 `fail`, 최소 시행 수 미달(`observed`)이 있으면 비우고 `notes`에 '관측값(시행 n번, 최소 시행 수 미달)'을 더한다. `--verdict pass`가 점검과 어긋나면(`fail`·`observed`가 있음) 측정 폴더를 만들지 않고 거부한다. `fail`은 점검 밖의 까닭(불변식 위반 등)이 있을 수 있어 그대로 두고, `baseline`도 그대로 두고 점검 결과만 남긴다(§7, 추천 적용 2026-11-02) | `pass` |
| `notes` | 스팟 인스턴스 회수, 캐시(자주 쓰는 값을 가까운 곳에 복사해 둔 것)를 데우는 구간의 예외 처리 같은 특이 사항 | 자유롭게 적는다 |
| `k6_eval`, `k6_plan`, `k6_cost` | K6 봇 탐지에만 쓴다. 등급·라운드별 탐지율과 Wilson 95% 구간(3단계는 목표가 없다), 등급별 하락폭, 사람 오탐(사람을 봇으로 잘못 잡는 것)과 Clopper-Pearson 단측 95% 상한(판정 기록끼리 독립 가정, 1인 1판정 기록), 사람 쪽 원천(`public` 공개 자료 기준·`mock` 모의 사람(리허설)·`live` 실제 사람 기준(출시 뒤))과 자료 이름·판·해시·출처 표시·조정용과 판정용을 나눈 씨앗값(추천 적용 2026-10-31, ADR-0174), 사람 단위 확인(ADR-0112), 사전 등록 계획 판정, 1장당 획득 비용과 웃돈별 손익(`collect.py --confusion --k6-plan --k6-source --bot-cost --bot-prices`, §10) | 1단계 물량형 봇 탐지 96.2%(94.8~97.2%), 사람 오탐 1/947명(공개 자료 기준, 상한 0.50%, 계획 통과) |
| `latency_crosscheck` | 같은 시간 창의 k6 p99(요청 백 건 중 아흔아홉 건이 이 시간 안에 끝난다는 뜻)와, 서버가 실제로 잰 품질 값인 서버 SLI(같은 경로에서 값을 구간별로 나눠 센 서버 히스토그램의 p99와 기준값 안 비율), 둘의 차이, '측정 지점 의심' 표시(서버 SLI는 목표 안인데 k6 값이 목표 밖일 때, ADR-0077). 수집은 `collect.py --checks` 파일의 `crosscheck`(서버 히스토그램 점검 이름 `check`, k6 하위 지표 이름 `k6_metric`)로 한다. 목표는 그 점검의 기준값 칸(`le`)이고, `target_ms`를 따로 적으면 같은 값이어야 한다. 같은 창·같은 경로를 견주도록 시나리오가 측정 구간·경로 요청에 태그를 달고(예: `http_req_duration{phase:measure,route:entry}`) 그 이름을 `k6_metric`에 적는다(기본값을 두지 않는다). k6는 기준(threshold)을 건 하위 지표만 요약에 남기므로 시나리오의 `thresholds`에 그 이름을 둔다(예: `max>=0`). 서버 p99는 그 점검의 측정 창 칸 개수에서 Prometheus `histogram_quantile`과 같은 선형 보간(누적 개수가 거꾸로 가면 앞 칸 값으로 맞춤)으로 구하고, 서버 SLI가 목표 안이라는 것은 서버 p99가 목표 이하이고 그 점검이 `pass`라는 뜻이다(추천 적용 2026-11-02) | 진입 k6 p99 182ms, 서버 p99 151ms·200ms 안 99.6%, 차이 31ms, 의심 아님 |
| `pg_sim` | 결제 시뮬레이터의 기본 승인 지연 분포와 매개변수, 시험이 넣은 지연, 결제 확정 p99를 우리 몫(결제사 승인 호출 구간을 뺀 값)과 가정 분포를 더한 종단 둘로 나눈 값(docs/features/payment.md §2.1, NFR-006, 기술 검토 낮음-120) | `dist: lognormal`, `p50_ms: 300`, `p99_ms: 1500`, `own_p99_ms`, `e2e_p99_ms` |
| `checks` | 비율·백분위 목표마다 한 줄: 이름 `name`, 허용 비율 `allowed`(1 − 목표. p99면 0.01), 시행 수 `trials`(n), 목표를 어긴 수 `violations`(k. 백분위는 기준값을 넘은 수), 정확 이항 단측 95% 상한 `cp_upper`, 최소 시행 수 `min_trials`, 결과 `result`(`pass`·`fail`·`observed`. `observed`는 최소 시행 수 미달)(§7, 기술 검토 중간-002). 입력은 `collect.py --checks <JSON>`이다. 점검마다 시행 수·어긴 수를 직접 적거나(`trials`·`violations`), 서버 히스토그램(`histogram`: 지표 이름, 라벨 선택자, 기준값 칸 경계 `le`(초))을 주면 측정 창(시작 + 예열 ~ 끝)의 끝과 시작에서 칸 카운터 합을 Prometheus로 읽어 그 차이로 센다. 창 시작에 없던 시계열(측정 중에 뜬 파드)은 0부터 다 세고, 같은 경계를 다르게 적은 칸(`1`·`1.0`)은 합친다. `increase()`는 막 뜬 시계열의 첫 표본을 세지 않고 외삽 소수를 만들어 쓰지 않는다. 창 안에서 사라진 시계열(창 시작에 있다 사라진 것과 창 안에서 생겼다 사라진 것)이나 카운터 되돌아감(파드 종료·재시작, 창 시작의 합이 쓰는 조회 유예 5분 앞부터 봄)이 있으면 셀 수 없어 거부한다. 점검이 하나도 없거나, 기준값과 같은 칸 경계가 없거나, 모르는 키나 `NaN`·`Infinity`가 있으면 측정 폴더를 만들지 않고 거부한다(ADR-0077, 추천 적용 2026-11-02) | `{"name": "entry_p99_200ms", "allowed": 0.01, "trials": 3000, "violations": 0, "cp_upper": 0.000998, "min_trials": 299, "result": "pass"}` |
| `evidence` | 증거 수준(측정함·구현함·설계만·계산만, docs/planning/02 §2 '증거 수준'). 실행 폴더가 있는 측정은 기본이 측정함이다. 외삽이나 문서 인용 값을 장부에 남길 때만 `collect.py --evidence 계산만`으로 적는다. 장부 요약 표(§5)의 '증거 수준' 칸이 이 값이다(추천 적용 2026-11-02) | `측정함` |

### 2.3 서버 시계열 메트릭 규약 (Prometheus Query Alias)

| 쿼리 식별자 | 메트릭의 의미 | 연계 시각화 차트 |
| --- | --- | --- |
| `origin_rps` | 백엔드 인그레스 게이트웨이(안쪽 서비스 앞에 둔 입구 서버)에 최종적으로 도달한 초당 HTTP 요청 수 | 비례 불변 스케일링 곡선 |
| `cdn_hit_ratio` | CloudFront(AWS의 CDN) 엣지(CDN이 사용자 가까이에 둔 서버)의 캐시 적중률(백분율) | 비례 불변 곡선 보조 지표 |
| `p99_ms` | 검증할 핵심 경로의 서버 쪽 지연 시간 p99 백분위수 (ms) | 트래픽 폭발 타임라인 차트 |
| `error_rate` | HTTP 5xx 서버 오류와 시간 초과가 생긴 비율 (%) | 트래픽 폭발 타임라인 차트 |
| `redis_cpu` | 대기열·좌석용 Redis(메모리에 데이터를 두는 빠른 저장소) 클러스터 인스턴스의 CPU 사용률 | 병목 분석 차트 |
| `event_loop_lag_ms` | 핫패스(요청이 가장 많이 지나는 경로)에 있는 마이크로서비스의 Node.js 이벤트 루프 지연 시간 p99 (ms) | 내부 런타임 병목 차트 |
| `heap_after_gc_mb`, `rss_mb`, `open_fds`, `active_handles`, `db_conns`, `redis_conns` | 장시간 시험의 자원 시계열(1분 간격, GC 뒤 힙·RSS·열린 FD·활성 핸들·DB·Redis 연결 수). 데우기 30분 [가정]이 끝난 뒤 구간의 시간당 기울기로 NFR-027을 판정한다(docs/verification.md §3.6, ADR-0070) | 장시간 시험 자원 추세 차트 |
| `rt_freshness_p95_s`, `rt_loss_ratio`, `rt_query_p95_ms` | 관제 실시간 표 시험(NFR-009)의 심장 박동 신선도 1분 p95(초, 측정값 백 개 중 아흔다섯 개가 이 안에 든다는 뜻), 누락률(읽지 못해 거절한 수 + 생산자가 버린 수 ÷ 전체), 조회 시점 집계의 p95(ms). 한계 찾기(V-T19)는 단계마다 입력 건수와 이 셋을 남긴다. `kpi`는 `NFR-009`이고 결과는 '실측(PC)'이다(docs/verification.md §3.7, ADR-0071·0099) | 트래픽 폭발 타임라인 차트 |
| `queue_reflect_p99_ms`, `reflect_stage_ms`, `seat_delta_e2e_p99_ms`, `ws_batches_per_s` | 반영 지연 시험의 값(추천 적용 2026-10-28, ADR-0110). 입장 임박 구간의 차례 반영 지연 p99(Q-T47, `kpi: NFR-002`)와 그 단계별 p99(생성 대기·캐시 나이·폴링 대기·왕복), 좌석 전파 종단 지연 p99(S-T12, `kpi: NFR-004`, 망 지연 주입 여부를 `notes`에)와 realtime-gw의 초당 묶음 수. 같은 PC 시계로 재므로 결과는 '실측(PC)'이다 | 트래픽 폭발 타임라인 차트 |
| `admission_soon_ratio`, `admission_soon_wait_p99_s`, `admission_arrival_delay_p95_s` | 입장 제어 루프 시험(Q-T46, `kpi: FR-037`)의 곧 입장 응답 비율(곧 입장 ÷ 입장 확정 요청), 곧 입장으로 기다린 시간 p99, 도착 지연 p95(오는 중 시간 W의 근거, 추천 적용 2026-10-28, ADR-0104) | 트래픽 폭발 타임라인 차트 |

앞 여섯 식별자의 쿼리 예시는 `tools/perf-ledger/queries.example.txt`에 있다. 장시간 시험과 관제 실시간 표 시험의 식별자는 그 시험을 만들 때(wbs 6.5.1·4.3.9) 더한다. 반영 지연과 입장 제어 루프 시험의 식별자도 그 시험을 만들 때(wbs 2.2.2·2.6.1·2.3.1) 더한다. 이 명세는 서비스 공통 템플릿의 Recording Rule 표준에 맞춰 동기화된다.

## 3. 표준 부하 측정 절차

1. **로컬 사전 리허설**: 본 측정과 선택 보정(클라우드) 전에 같은 k6 부하 스크립트를 작은 규모로 끝까지 돌려 스크립트에 문제가 없는지 확인한다.
2. **부하 발생기 용량 보정 (Calibration)**: 부하 발생기 1대가 왜곡 없이 보낼 수 있는 최대 초당 요청 수를 미리 재서 장부에 기록한다. 실제 측정 중 k6의 `dropped_iterations`가 1건이라도 생기면 부하 발생기 자체의 병목으로 보고 그 측정을 바로 무효로 한다. 보정 방법(빈 응답 대역, 도착률 단계, 통과 기준)과 발생기 CPU·메모리의 무효 판정, 결과는 docs/verification.md §3.9다(`node loadtest/run.mjs calibrate`, 추천 적용 2026-11-03, wbs 1.2.1).
3. **분산 시계 동기화 검증**: 측정을 시작하기 직전에 부하 발생기와 대상 서버 클러스터의 NTP 시계가 맞는지 반드시 점검하고, 오차 범위를 `stdout.log`에 기록한다.
4. **개방형 부하 모델 강제 (Open Workload Model)**: k6의 arrival-rate(open model) 방식으로 가상 사용자가 도착하는 속도를 강제로 고정한다. 대상 서버가 느려져도 들어오는 트래픽이 줄지 않는 실제 환경의 파괴적인 특성을 그대로 재현한다.
5. **초기 웜업 구간 분리**: 벤치마크를 시작한 뒤 처음 `warmup_s` 동안의 데이터는 JIT 컴파일과 캐시 적재 단계로 보고 최종 집계에서 반드시 뺀다. 실제 분석 구간은 manifest에 적는다.
6. **통계적 반복 검증**: 로컬 환경은 같은 조건으로 최소 3회 반복 실행해 지표의 중앙값과 신뢰 범위를 구한다. 클라우드 환경은 FinOps 예산 범위(docs/planning/01 §5.1) 안에서 할 수 있었던 실행 횟수를 있는 그대로 기록한다.
7. **동일 조건 대조 원칙**: 초기 베이스라인(v0)과 개선 아키텍처(v1)는 같은 환경 프로파일에서 실행해야 한다. `infra.txt`를 대조해 하드웨어 자원이 같음을 증명한다. v1 합격은 v0 대비 비율이 아니라 NFR과 K의 절대값으로 판정하고, 비율은 보조 숫자로 적는다. v0는 일부러 망가뜨리지 않은 '처음 만들 법한 단순한 설계'다(docs/verification.md §1.4, ADR-0096).
8. **산출물 자동 수집**: 결과 디렉터리를 만들고 산출물을 모으는 일은 `collect.py` 자동화 스크립트로만 한다. 엔지니어가 손으로 파일을 옮기거나 고치는 것은 금지한다.
9. **장부 인덱스 자동 갱신**: `index.py` 스크립트를 실행해 이 문서 §5의 요약 표를 자동으로 맞춘다. 마크다운 표를 손으로 고치는 것은 금지한다.
10. **무효 측정의 투명한 보존**: 부하 발생기 병목, 스팟 인스턴스 중도 회수, NTP 시계 오차, 인프라 사양 불일치, 데이터 불변식 위반이 드러난 측정도 지우지 않는다. `valid: false` 플래그와 자세한 무효 사유를 적어 영구 보존한다.
11. **같은 PC에서의 측정**: 발생기와 대상을 같은 PC에서 돌리면 CPU를 나눠 쓰고, 그 배치를 `infra.txt`에 적는다. 발생기 CPU 사용률은 80% 이하, 메모리는 90% 이하로 둔다(k6 권고, docs/verification.md §3.5 3번). WSL 안에서 CPU를 고정해도 실제 코어가 고정된다는 보장은 없으므로 반복 사이의 편차를 함께 적는다(docs/verification.md §3.2·§3.5). 점마다 호스트 지표를 `host`에 남기고, 호스트가 포화한 점은 계산에서 빼되 지우지는 않는다(ADR-0096).
12. **클라이언트·서버 지연 대조(ADR-0077)**: 측정마다 같은 시간 창의 k6 p99와 서버 SLI를 `latency_crosscheck`에 함께 남긴다. 차이는 네트워크·게이트웨이·클라이언트 쪽 지연이다. 서버 SLI는 목표 안인데 k6 값이 목표 밖이면 '측정 지점 의심'으로 표시하고, SLI를 재는 위치(게이트웨이·서비스)를 다시 본다.

## 4. 인프라 환경 프로파일

| 프로파일 명칭 | 인프라 구성 내용 | 비용 성격 |
| --- | --- | --- |
| `local-1k`, `local-10k`, `local-100k` | 개발용 컴퓨터에서 로컬로 돌리는 kind/k3d 클러스터다. 사용자 가까운 곳에서 파일을 대신 응답하는 CDN의 엣지 계층은 로컬 Nginx 캐시 컨테이너(앱과 실행 환경을 한 묶음으로 만든 실행 단위)로 대신한다. 비례 불변 곡선, 예매 계층의 실제 크기 측정, 진입 서버 1대 처리량과 비례 확인(USL: 서버를 늘릴 때 처리량이 덜 늘어나는 모양을 나타낸 식, 보조), 서비스 분리 세 구성 비교, 장애 기록 검사에 쓴다. 포트폴리오 기간의 기본 측정 환경이다(ADR-0057) | 0원 (로컬 자원) |
| `local-bot` | 로컬 kind/k3d 클러스터에 봇 등급 분류표(ADR-0039)에 따른 합성 봇과 정상 사용자 세션을 넣어 판정 정확도를 잰다(K6 검증, 절차 §10). 다른 상용 사이트를 공격하는 것은 엄격히 금지한다(POL-026) | 0원 (로컬 자원) |
| `local-poc` | 구성 요소 하나를 따로 재는 PoC다(wbs 0.5.1, 추천 적용 2026-11-01, openspec 변경 `add-foundation-poc`). kind 클러스터 대신 PC의 Docker 엔진에 측정용 망 하나를 만들고, 그 안에 측정 대상(Valkey 클러스터 주 노드 셋·복제 셋, Kafka 브로커 셋, HTTP 비교 앱)과 측정 도구(Node 측정 도구, k6)를 컨테이너로 띄워 CPU 한도를 둔다. kind에는 Strimzi·PostgreSQL·흉내 서버가 함께 돌아 잡음이 되고, Docker Desktop 포트 전달을 거치면 그 비용이 측정에 섞이기 때문이다. 동시 대기자가 없는 측정이라 `scale.users`는 비운다. 무대와 규칙은 `loadtest/poc/README.md`다 | 0원 (로컬 자원) |
| `local-gen` | 부하 발생기 보정이다(wbs 1.2.1, 추천 적용 2026-11-03). kind 클러스터 안의 발생기 파드 하나(CPU 몫 고정)가 빈 응답 대역(nginx)에 왜곡 없이 보낼 수 있는 최대 도착률과 가상 사용자당 메모리를 잰다. 대상이 아니라 발생기를 재므로 `scale.users`는 비우고, `kpi`는 NFR-013, `version`은 그 보정을 쓸 측정의 판(지금은 v0)으로 적는다. 절차와 판정은 docs/verification.md §3.9다 | 0원 (로컬 자원) |
| `cloud-calib` | 선택 보정이다. 서울 리전 c7g.xlarge 8대를 3시간 [가정] 띄워 진입 서버 1·2·4대의 처리량을 재고, PC와 비교한 환산 계수를 얻는다(docs/verification.md §6) | 약 4달러(정가로 계속 쓰는 온디맨드 서버의 가격표, 2026-10-13 조회) |
| `cloud-cdn` | 선택 보정이다. PC에서 CloudFront 배포 1개에 무료 범위(월 요청 1,000만 건, 전송 1 TB) 안의 요청을 보내 같은 파일 요청을 묶는지 확인한다. 엣지 1곳 몫만 확인된다(docs/verification.md §6) | 무료 범위 안(넘으면 요청 건수만큼 요금이 붙는다) |
| `cloud-msk-iam` | 선택 보정이다. 서울 리전에 EKS 클러스터 1개(노드 c7g.xlarge 1대)와 MSK kafka.t3.small 2대를 9시간 [가정] 띄워, Pod Identity 자격과 MSK 토큰이 바뀌는 동안 재인증이 이어지는지 본다(ST-T14 ②, docs/verification.md §6, ADR-0154). 재는 것은 성능이 아니라 재인증 실패·연결 끊김 건수다 | 약 3.5달러(EKS·MSK·노드·공인 IPv4의 시간 요금, 2026-10-30 가격표) |
| `cloud-burst` | 실행하지 않는다(ADR-0057). 지출 상한이 늘면 진입 폭발(20만 RPS) 측정 1회를 먼저 한다 | 시간 단위 인스턴스 요금·요청 요금 |
| `cloud-failover` | 실행하지 않는다. 선택 보정은 `cloud-calib`·`cloud-cdn`·`cloud-msk-iam` 세 가지만 하므로(ADR-0057, ADR-0154) 관리형 Aurora PostgreSQL(AWS가 운영해 주는 PostgreSQL 호환 관계형 데이터베이스)·ElastiCache의 장애 조치 시간은 문서 인용으로 둔다(docs/verification.md §5.3). 나중에 재기로 하면 새 ADR(아키텍처 결정과 그 이유를 남긴 기록)로 정한다 | 0원 |
| `cloud-staging` | 설계로만 둔다. 운영과 같은 다중 AZ(리전 안의 독립된 데이터센터 묶음) 구성이다(docs/infra.md §3). 포트폴리오 기간에는 띄우지 않고, Game Day는 로컬 측정 환경에서 한다(ADR-0057) | 대규모 비용(실행하지 않는다) |

프로파일마다 자세한 인프라 구성(토폴로지)과 FinOps 예산 지침은 docs/infra.md §3과 docs/planning/01 §5.1을 따른다. 장부에는 프로파일 이름과 `infra.txt` 스냅샷(어느 시점의 전체 상태를 찍어 둔 것)을 영구 보존한다.

## 5. 장부 요약 원장

측정은 1회 실행당 1개의 레코드로 관리한다. 아래 마커 블록 안은 `index.py` 도구가 자동으로 맞춘다.

<!-- ledger:begin -->
| 날짜 | 측정 ID | KPI | 버전 | 프로파일 | 규모 | p99(ms) | 오류율 | 판정 | 증거 수준 | 비용(원) | 폴더 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-01 | 2026-11-01-incr-batch-notls-r1-local-poc | NFR-001 | v1 | local-poc | 200,000 RPS | 4.39 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-incr-batch-notls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-incr-batch-tls-r1-local-poc | NFR-001 | v1 | local-poc | 200,000 RPS | 4.22 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-incr-batch-tls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-incr-batch-tls-r2-local-poc | NFR-001 | v1 | local-poc | 200,000 RPS | 4.06 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-incr-batch-tls-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-incr-batch-tls-r3-local-poc | NFR-001 | v1 | local-poc | 200,000 RPS | 4.14 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-incr-batch-tls-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-incr-incr-notls-r1-local-poc | NFR-001 | v1 | local-poc | 200,000 RPS | 22 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-incr-incr-notls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-incr-incr-tls-r1-local-poc | NFR-001 | v1 | local-poc | 200,000 RPS | 20 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-incr-incr-tls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-incr-incr-tls-r2-local-poc | NFR-001 | v1 | local-poc | 200,000 RPS | 50 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-incr-incr-tls-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-incr-incr-tls-r3-local-poc | NFR-001 | v1 | local-poc | 200,000 RPS | 43 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-incr-incr-tls-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-incrmax-notls-r1-local-poc | NFR-001 | v1 | local-poc | - | - | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-incrmax-notls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-incrmax-tls-r1-local-poc | NFR-001 | v1 | local-poc | - | - | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-incrmax-tls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-incrmax-tls-r2-local-poc | NFR-001 | v1 | local-poc | - | - | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-incrmax-tls-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-incrmax-tls-r3-local-poc | NFR-001 | v1 | local-poc | - | - | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-incrmax-tls-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-kafka-batch-keyed-local-poc | ST-T18 | v1 | local-poc | - | - | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-kafka-batch-keyed-local-poc/ |
| 2026-11-01 | 2026-11-01-kafka-batch-serial-local-poc | ST-T18 | v1 | local-poc | - | - | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-kafka-batch-serial-local-poc/ |
| 2026-11-01 | 2026-11-01-kafka-max-local-poc | ST-T18 | v1 | local-poc | - | 45 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-kafka-max-local-poc/ |
| 2026-11-01 | 2026-11-01-kafka-mixed-r1-local-poc | ST-T18 | v1 | local-poc | 5,900 RPS | 7.79 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-kafka-mixed-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-kafka-mixed-r2-local-poc | ST-T18 | v1 | local-poc | 5,900 RPS | 7.91 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-kafka-mixed-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-kafka-mixed-r3-local-poc | ST-T18 | v1 | local-poc | 5,900 RPS | 7.79 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-kafka-mixed-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-st27-five-same-rb100-notls-r1-local-poc | NFR-003 | v1 | local-poc | 6,000 RPS | 5.57 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-st27-five-same-rb100-notls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-st27-five-same-rb100-tls-r1-local-poc | NFR-003 | v1 | local-poc | 6,000 RPS | 5.66 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-st27-five-same-rb100-tls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-st27-five-same-rb100-tls-r2-local-poc | NFR-003 | v1 | local-poc | 6,000 RPS | 5.75 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-st27-five-same-rb100-tls-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-st27-five-same-rb100-tls-r3-local-poc | NFR-003 | v1 | local-poc | 6,000 RPS | 5.68 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-st27-five-same-rb100-tls-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-st27-five-same-tls-r1-local-poc | NFR-003 | v1 | local-poc | 6,000 RPS | 32 | 1.0% | 무효(측정 도구 멈춤: 오버셀 검사 기록을 좌석마다 자바스크) | 측정함 | 0 | perf-ledger/runs/2026-11-01-st27-five-same-tls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-st27-five-spread-rb100-tls-r1-local-poc | NFR-003 | v1 | local-poc | 6,000 RPS | 6.23 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-st27-five-spread-rb100-tls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-st27-one-same-rb100-notls-r1-local-poc | NFR-003 | v1 | local-poc | 2,000 RPS | 2.42 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-st27-one-same-rb100-notls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-st27-one-same-rb100-tls-r1-local-poc | NFR-003 | v1 | local-poc | 2,000 RPS | 2.67 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-st27-one-same-rb100-tls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-st27-one-same-tls-r1-local-poc | NFR-003 | v1 | local-poc | 2,000 RPS | 3.94 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-st27-one-same-tls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-st27-one-same-tls-r2-local-poc | NFR-003 | v1 | local-poc | 2,000 RPS | 3.27 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-st27-one-same-tls-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-st27-one-same-tls-r3-local-poc | NFR-003 | v1 | local-poc | 2,000 RPS | 3.76 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-st27-one-same-tls-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-behaviors-glide-r1-local-poc | V-T33 | v1 | local-poc | - | - | - | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-behaviors-glide-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-behaviors-glide-r2-local-poc | V-T33 | v1 | local-poc | - | - | - | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-behaviors-glide-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-behaviors-glide-r3-local-poc | V-T33 | v1 | local-poc | - | - | - | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-behaviors-glide-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-behaviors-ioredis-r1-local-poc | V-T33 | v1 | local-poc | - | - | - | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-behaviors-ioredis-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-behaviors-ioredis-r2-local-poc | V-T33 | v1 | local-poc | - | - | - | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-behaviors-ioredis-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-behaviors-ioredis-r3-local-poc | V-T33 | v1 | local-poc | - | - | - | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-behaviors-ioredis-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-behaviors-node-redis-deadline-r1-local-poc | V-T33 | v1 | local-poc | - | - | - | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-behaviors-node-redis-deadline-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-behaviors-node-redis-deadline-r2-local-poc | V-T33 | v1 | local-poc | - | - | - | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-behaviors-node-redis-deadline-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-behaviors-node-redis-deadline-r3-local-poc | V-T33 | v1 | local-poc | - | - | - | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-behaviors-node-redis-deadline-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-behaviors-node-redis-r1-local-poc | V-T33 | v1 | local-poc | - | - | - | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-behaviors-node-redis-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-behaviors-node-redis-r2-local-poc | V-T33 | v1 | local-poc | - | - | - | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-behaviors-node-redis-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-behaviors-node-redis-r3-local-poc | V-T33 | v1 | local-poc | - | - | - | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-behaviors-node-redis-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-hold-glide-notls-r1-local-poc | V-T33 | v1 | local-poc | 5,000 RPS | 2.67 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-hold-glide-notls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-hold-glide-tls-r1-local-poc | V-T33 | v1 | local-poc | 5,000 RPS | 2.73 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-hold-glide-tls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-hold-glide-tls-r2-local-poc | V-T33 | v1 | local-poc | 5,000 RPS | 2.78 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-hold-glide-tls-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-hold-glide-tls-r3-local-poc | V-T33 | v1 | local-poc | 5,000 RPS | 2.59 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-hold-glide-tls-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-hold-ioredis-notls-r1-local-poc | V-T33 | v1 | local-poc | 5,000 RPS | 2.84 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-hold-ioredis-notls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-hold-ioredis-tls-r1-local-poc | V-T33 | v1 | local-poc | 5,000 RPS | 2.78 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-hold-ioredis-tls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-hold-ioredis-tls-r2-local-poc | V-T33 | v1 | local-poc | 5,000 RPS | 2.78 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-hold-ioredis-tls-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-hold-ioredis-tls-r3-local-poc | V-T33 | v1 | local-poc | 5,000 RPS | 2.59 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-hold-ioredis-tls-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-hold-node-redis-notls-r1-local-poc | V-T33 | v1 | local-poc | 5,000 RPS | 3.07 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-hold-node-redis-notls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-hold-node-redis-tls-r1-local-poc | V-T33 | v1 | local-poc | 5,000 RPS | 3.43 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-hold-node-redis-tls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-hold-node-redis-tls-r2-local-poc | V-T33 | v1 | local-poc | 5,000 RPS | 3.17 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-hold-node-redis-tls-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-hold-node-redis-tls-r3-local-poc | V-T33 | v1 | local-poc | 5,000 RPS | 4.71 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-hold-node-redis-tls-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-incr-glide-notls-r1-local-poc | V-T33 | v1 | local-poc | 40,000 RPS | 22 | 0.3% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-incr-glide-notls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-incr-glide-tls-r1-local-poc | V-T33 | v1 | local-poc | 40,000 RPS | 10 | 0.3% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-incr-glide-tls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-incr-glide-tls-r2-local-poc | V-T33 | v1 | local-poc | 40,000 RPS | 2.67 | 0.1% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-incr-glide-tls-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-incr-glide-tls-r3-local-poc | V-T33 | v1 | local-poc | 40,000 RPS | 46 | 0.6% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-incr-glide-tls-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-incr-ioredis-notls-r1-local-poc | V-T33 | v1 | local-poc | 40,000 RPS | 3.39 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-incr-ioredis-notls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-incr-ioredis-tls-r1-local-poc | V-T33 | v1 | local-poc | 40,000 RPS | 3.10 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-incr-ioredis-tls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-incr-ioredis-tls-r2-local-poc | V-T33 | v1 | local-poc | 40,000 RPS | 3.29 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-incr-ioredis-tls-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-incr-ioredis-tls-r3-local-poc | V-T33 | v1 | local-poc | 40,000 RPS | 3.07 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-incr-ioredis-tls-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-incr-node-redis-notls-r1-local-poc | V-T33 | v1 | local-poc | 40,000 RPS | 12 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-incr-node-redis-notls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-incr-node-redis-tls-r1-local-poc | V-T33 | v1 | local-poc | 40,000 RPS | 38 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-incr-node-redis-tls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-incr-node-redis-tls-r2-local-poc | V-T33 | v1 | local-poc | 40,000 RPS | 25 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-incr-node-redis-tls-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-incr-node-redis-tls-r3-local-poc | V-T33 | v1 | local-poc | 40,000 RPS | 20 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-incr-node-redis-tls-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-max-glide-notls-r1-local-poc | V-T33 | v1 | local-poc | - | - | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-max-glide-notls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-max-glide-tls-r1-local-poc | V-T33 | v1 | local-poc | - | - | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-max-glide-tls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-max-glide-tls-r2-local-poc | V-T33 | v1 | local-poc | - | - | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-max-glide-tls-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-max-glide-tls-r3-local-poc | V-T33 | v1 | local-poc | - | - | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-max-glide-tls-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-max-ioredis-notls-r1-local-poc | V-T33 | v1 | local-poc | - | - | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-max-ioredis-notls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-max-ioredis-tls-r1-local-poc | V-T33 | v1 | local-poc | - | - | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-max-ioredis-tls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-max-ioredis-tls-r2-local-poc | V-T33 | v1 | local-poc | - | - | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-max-ioredis-tls-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-max-ioredis-tls-r3-local-poc | V-T33 | v1 | local-poc | - | - | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-max-ioredis-tls-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-max-node-redis-notls-r1-local-poc | V-T33 | v1 | local-poc | - | - | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-max-node-redis-notls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-max-node-redis-tls-r1-local-poc | V-T33 | v1 | local-poc | - | - | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-max-node-redis-tls-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-max-node-redis-tls-r2-local-poc | V-T33 | v1 | local-poc | - | - | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-max-node-redis-tls-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt33-max-node-redis-tls-r3-local-poc | V-T33 | v1 | local-poc | - | - | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt33-max-node-redis-tls-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-express-zod-entry-b-r1-local-poc | V-T41 | v1 | local-poc | 8,000 RPS | 97 | 0.0% | 무효(두 번째 회차: k6 가상 사용자 4,009명을 CPU) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-express-zod-entry-b-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-express-zod-entry-b-r2-local-poc | V-T41 | v1 | local-poc | 8,000 RPS | 98 | 0.0% | 무효(두 번째 회차: k6 가상 사용자 4,009명을 CPU) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-express-zod-entry-b-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-express-zod-entry-b-r3-local-poc | V-T41 | v1 | local-poc | 8,000 RPS | 102 | 0.0% | 무효(두 번째 회차: k6 가상 사용자 4,009명을 CPU) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-express-zod-entry-b-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-express-zod-entry-c-r1-local-poc | V-T41 | v1 | local-poc | 8,000 RPS | 2.54 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-express-zod-entry-c-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-express-zod-entry-c-r2-local-poc | V-T41 | v1 | local-poc | 8,000 RPS | 2.74 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-express-zod-entry-c-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-express-zod-entry-c-r3-local-poc | V-T41 | v1 | local-poc | 8,000 RPS | 3.59 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-express-zod-entry-c-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-express-zod-entry-r1-local-poc | V-T41 | v1 | local-poc | 10,400 RPS | 4.17 | 0.0% | 무효(첫 회차: k6 가상 사용자를 200명만 미리 만들어 ) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-express-zod-entry-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-express-zod-entry-r2-local-poc | V-T41 | v1 | local-poc | 10,400 RPS | 9.60 | 0.0% | 무효(첫 회차: k6 가상 사용자를 200명만 미리 만들어 ) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-express-zod-entry-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-express-zod-entry-r3-local-poc | V-T41 | v1 | local-poc | 10,400 RPS | 3.40 | 0.0% | 무효(첫 회차: k6 가상 사용자를 200명만 미리 만들어 ) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-express-zod-entry-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-express-zod-hold-b-r1-local-poc | V-T41 | v1 | local-poc | 7,600 RPS | 138 | 0.0% | 무효(두 번째 회차: k6 가상 사용자 4,009명을 CPU) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-express-zod-hold-b-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-express-zod-hold-b-r2-local-poc | V-T41 | v1 | local-poc | 7,600 RPS | 100 | 0.0% | 무효(두 번째 회차: k6 가상 사용자 4,009명을 CPU) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-express-zod-hold-b-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-express-zod-hold-b-r3-local-poc | V-T41 | v1 | local-poc | 7,600 RPS | 42 | 0.0% | 무효(두 번째 회차: k6 가상 사용자 4,009명을 CPU) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-express-zod-hold-b-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-express-zod-hold-c-r1-local-poc | V-T41 | v1 | local-poc | 7,600 RPS | 1.78 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-express-zod-hold-c-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-express-zod-hold-c-r2-local-poc | V-T41 | v1 | local-poc | 7,600 RPS | 2.39 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-express-zod-hold-c-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-express-zod-hold-c-r3-local-poc | V-T41 | v1 | local-poc | 7,600 RPS | 2.34 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-express-zod-hold-c-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-express-zod-hold-r1-local-poc | V-T41 | v1 | local-poc | 10,100 RPS | 10 | 0.0% | 무효(첫 회차: k6 가상 사용자를 200명만 미리 만들어 ) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-express-zod-hold-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-express-zod-hold-r2-local-poc | V-T41 | v1 | local-poc | 10,100 RPS | 8.76 | 0.0% | 무효(첫 회차: k6 가상 사용자를 200명만 미리 만들어 ) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-express-zod-hold-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-express-zod-hold-r3-local-poc | V-T41 | v1 | local-poc | 10,100 RPS | 5.91 | 0.0% | 무효(첫 회차: k6 가상 사용자를 200명만 미리 만들어 ) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-express-zod-hold-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-schema-entry-b-r1-local-poc | V-T41 | v1 | local-poc | 8,000 RPS | 93 | 0.0% | 무효(두 번째 회차: k6 가상 사용자 4,009명을 CPU) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-schema-entry-b-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-schema-entry-b-r2-local-poc | V-T41 | v1 | local-poc | 8,000 RPS | 106 | 0.0% | 무효(두 번째 회차: k6 가상 사용자 4,009명을 CPU) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-schema-entry-b-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-schema-entry-b-r3-local-poc | V-T41 | v1 | local-poc | 8,000 RPS | 97 | 0.0% | 무효(두 번째 회차: k6 가상 사용자 4,009명을 CPU) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-schema-entry-b-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-schema-entry-c-r1-local-poc | V-T41 | v1 | local-poc | 8,000 RPS | 1.16 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-schema-entry-c-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-schema-entry-c-r2-local-poc | V-T41 | v1 | local-poc | 8,000 RPS | 1.57 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-schema-entry-c-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-schema-entry-c-r3-local-poc | V-T41 | v1 | local-poc | 8,000 RPS | 1.93 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-schema-entry-c-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-schema-entry-r1-local-poc | V-T41 | v1 | local-poc | 10,400 RPS | 4.35 | 0.0% | 무효(첫 회차: k6 가상 사용자를 200명만 미리 만들어 ) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-schema-entry-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-schema-entry-r2-local-poc | V-T41 | v1 | local-poc | 10,400 RPS | 3.88 | 0.0% | 무효(첫 회차: k6 가상 사용자를 200명만 미리 만들어 ) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-schema-entry-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-schema-entry-r3-local-poc | V-T41 | v1 | local-poc | 10,400 RPS | 94 | 0.0% | 무효(첫 회차: k6 가상 사용자를 200명만 미리 만들어 ) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-schema-entry-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-schema-hold-b-r1-local-poc | V-T41 | v1 | local-poc | 7,600 RPS | 104 | 0.0% | 무효(두 번째 회차: k6 가상 사용자 4,009명을 CPU) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-schema-hold-b-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-schema-hold-b-r2-local-poc | V-T41 | v1 | local-poc | 7,600 RPS | 90 | 0.0% | 무효(두 번째 회차: k6 가상 사용자 4,009명을 CPU) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-schema-hold-b-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-schema-hold-b-r3-local-poc | V-T41 | v1 | local-poc | 7,600 RPS | 99 | 0.0% | 무효(두 번째 회차: k6 가상 사용자 4,009명을 CPU) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-schema-hold-b-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-schema-hold-c-r1-local-poc | V-T41 | v1 | local-poc | 7,600 RPS | 1.01 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-schema-hold-c-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-schema-hold-c-r2-local-poc | V-T41 | v1 | local-poc | 7,600 RPS | 1.09 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-schema-hold-c-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-schema-hold-c-r3-local-poc | V-T41 | v1 | local-poc | 7,600 RPS | 1.34 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-schema-hold-c-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-schema-hold-r1-local-poc | V-T41 | v1 | local-poc | 10,100 RPS | 4.29 | 0.0% | 무효(첫 회차: k6 가상 사용자를 200명만 미리 만들어 ) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-schema-hold-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-schema-hold-r2-local-poc | V-T41 | v1 | local-poc | 10,100 RPS | 2.79 | 0.0% | 무효(첫 회차: k6 가상 사용자를 200명만 미리 만들어 ) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-schema-hold-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-schema-hold-r3-local-poc | V-T41 | v1 | local-poc | 10,100 RPS | 3.35 | 0.0% | 무효(첫 회차: k6 가상 사용자를 200명만 미리 만들어 ) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-schema-hold-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-zod-entry-b-r1-local-poc | V-T41 | v1 | local-poc | 8,000 RPS | 97 | 0.0% | 무효(두 번째 회차: k6 가상 사용자 4,009명을 CPU) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-zod-entry-b-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-zod-entry-b-r2-local-poc | V-T41 | v1 | local-poc | 8,000 RPS | 89 | 0.0% | 무효(두 번째 회차: k6 가상 사용자 4,009명을 CPU) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-zod-entry-b-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-zod-entry-b-r3-local-poc | V-T41 | v1 | local-poc | 8,000 RPS | 98 | 0.0% | 무효(두 번째 회차: k6 가상 사용자 4,009명을 CPU) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-zod-entry-b-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-zod-entry-c-r1-local-poc | V-T41 | v1 | local-poc | 8,000 RPS | 1.66 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-zod-entry-c-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-zod-entry-c-r2-local-poc | V-T41 | v1 | local-poc | 8,000 RPS | 1.54 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-zod-entry-c-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-zod-entry-c-r3-local-poc | V-T41 | v1 | local-poc | 8,000 RPS | 2.58 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-zod-entry-c-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-zod-entry-r1-local-poc | V-T41 | v1 | local-poc | 10,400 RPS | 2.24 | 0.0% | 무효(첫 회차: k6 가상 사용자를 200명만 미리 만들어 ) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-zod-entry-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-zod-entry-r2-local-poc | V-T41 | v1 | local-poc | 10,400 RPS | 4.24 | 0.0% | 무효(첫 회차: k6 가상 사용자를 200명만 미리 만들어 ) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-zod-entry-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-zod-entry-r3-local-poc | V-T41 | v1 | local-poc | 10,400 RPS | 99 | 0.0% | 무효(첫 회차: k6 가상 사용자를 200명만 미리 만들어 ) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-zod-entry-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-zod-hold-b-r1-local-poc | V-T41 | v1 | local-poc | 7,600 RPS | 99 | 0.0% | 무효(두 번째 회차: k6 가상 사용자 4,009명을 CPU) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-zod-hold-b-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-zod-hold-b-r2-local-poc | V-T41 | v1 | local-poc | 7,600 RPS | 95 | 0.0% | 무효(두 번째 회차: k6 가상 사용자 4,009명을 CPU) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-zod-hold-b-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-zod-hold-b-r3-local-poc | V-T41 | v1 | local-poc | 7,600 RPS | 93 | 0.0% | 무효(두 번째 회차: k6 가상 사용자 4,009명을 CPU) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-zod-hold-b-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-zod-hold-c-r1-local-poc | V-T41 | v1 | local-poc | 7,600 RPS | 1.69 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-zod-hold-c-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-zod-hold-c-r2-local-poc | V-T41 | v1 | local-poc | 7,600 RPS | 1.48 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-zod-hold-c-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-zod-hold-c-r3-local-poc | V-T41 | v1 | local-poc | 7,600 RPS | 1.48 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-zod-hold-c-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-zod-hold-r1-local-poc | V-T41 | v1 | local-poc | 10,100 RPS | 4.94 | 0.0% | 무효(첫 회차: k6 가상 사용자를 200명만 미리 만들어 ) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-zod-hold-r1-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-zod-hold-r2-local-poc | V-T41 | v1 | local-poc | 10,100 RPS | 5.08 | 0.0% | 무효(첫 회차: k6 가상 사용자를 200명만 미리 만들어 ) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-zod-hold-r2-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-fastify-zod-hold-r3-local-poc | V-T41 | v1 | local-poc | 10,100 RPS | 2.76 | 0.0% | 무효(첫 회차: k6 가상 사용자를 200명만 미리 만들어 ) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-fastify-zod-hold-r3-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-max-express-zod-entry-local-poc | V-T41 | v1 | local-poc | - | 7.29 | 0.0% | 무효(첫 회차: k6 가상 사용자를 200명만 미리 만들어 ) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-max-express-zod-entry-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-max-express-zod-hold-local-poc | V-T41 | v1 | local-poc | - | 8.00 | 0.0% | 무효(첫 회차: k6 가상 사용자를 200명만 미리 만들어 ) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-max-express-zod-hold-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-max-fastify-schema-entry-local-poc | V-T41 | v1 | local-poc | - | 5.25 | 0.0% | 무효(첫 회차: k6 가상 사용자를 200명만 미리 만들어 ) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-max-fastify-schema-entry-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-max-fastify-schema-hold-local-poc | V-T41 | v1 | local-poc | - | 5.91 | 0.0% | 무효(첫 회차: k6 가상 사용자를 200명만 미리 만들어 ) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-max-fastify-schema-hold-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-max-fastify-zod-entry-local-poc | V-T41 | v1 | local-poc | - | 5.62 | 0.0% | 무효(첫 회차: k6 가상 사용자를 200명만 미리 만들어 ) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-max-fastify-zod-entry-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-max-fastify-zod-hold-local-poc | V-T41 | v1 | local-poc | - | 6.54 | 0.0% | 무효(첫 회차: k6 가상 사용자를 200명만 미리 만들어 ) | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-max-fastify-zod-hold-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-max2-express-zod-entry-local-poc | V-T41 | v1 | local-poc | - | 8.78 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-max2-express-zod-entry-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-max2-express-zod-hold-local-poc | V-T41 | v1 | local-poc | - | 8.63 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-max2-express-zod-hold-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-max2-fastify-schema-entry-local-poc | V-T41 | v1 | local-poc | - | 5.86 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-max2-fastify-schema-entry-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-max2-fastify-schema-hold-local-poc | V-T41 | v1 | local-poc | - | 8.11 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-max2-fastify-schema-hold-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-max2-fastify-zod-entry-local-poc | V-T41 | v1 | local-poc | - | 5.93 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-max2-fastify-zod-entry-local-poc/ |
| 2026-11-01 | 2026-11-01-vt41-max2-fastify-zod-hold-local-poc | V-T41 | v1 | local-poc | - | 8.15 | 0.0% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-01-vt41-max2-fastify-zod-hold-local-poc/ |
| 2026-11-03 | 2026-11-03-gen-calib-c4-r1000-mvzroid4a231 | NFR-013 | v0 | local-gen | 1,000 RPS | 0.45 | 0.0% | baseline | 측정함 | - | perf-ledger/runs/2026-11-03-gen-calib-c4-r1000-mvzroid4a231/ |
| 2026-11-03 | 2026-11-03-gen-calib-c4-r1000-mvzrtbumed2d | NFR-013 | v0 | local-gen | 1,000 RPS | 0.44 | 0.0% | baseline | 측정함 | - | perf-ledger/runs/2026-11-03-gen-calib-c4-r1000-mvzrtbumed2d/ |
| 2026-11-03 | 2026-11-03-gen-calib-c4-r1000-mvzry4zl666c | NFR-013 | v0 | local-gen | 1,000 RPS | 0.42 | 0.0% | baseline | 측정함 | - | perf-ledger/runs/2026-11-03-gen-calib-c4-r1000-mvzry4zl666c/ |
| 2026-11-03 | 2026-11-03-gen-calib-c4-r2000-mvzroid4a231 | NFR-013 | v0 | local-gen | 2,000 RPS | 0.46 | 0.0% | 무효(발생기가 반복을 시작하지 못함(dropped_itera) | 측정함 | - | perf-ledger/runs/2026-11-03-gen-calib-c4-r2000-mvzroid4a231/ |
| 2026-11-03 | 2026-11-03-gen-calib-c4-r2000-mvzrtbumed2d | NFR-013 | v0 | local-gen | 2,000 RPS | 0.42 | 0.0% | 무효(발생기가 반복을 시작하지 못함(dropped_itera) | 측정함 | - | perf-ledger/runs/2026-11-03-gen-calib-c4-r2000-mvzrtbumed2d/ |
| 2026-11-03 | 2026-11-03-gen-calib-c4-r2000-mvzry4zl666c | NFR-013 | v0 | local-gen | 2,000 RPS | 0.41 | 0.0% | 무효(발생기가 반복을 시작하지 못함(dropped_itera) | 측정함 | - | perf-ledger/runs/2026-11-03-gen-calib-c4-r2000-mvzry4zl666c/ |
| 2026-11-03 | 2026-11-03-gen-calib-c4-r4000-mvzroid4a231 | NFR-013 | v0 | local-gen | 4,000 RPS | 0.61 | 0.0% | 무효(발생기가 반복을 시작하지 못함(dropped_itera) | 측정함 | - | perf-ledger/runs/2026-11-03-gen-calib-c4-r4000-mvzroid4a231/ |
| 2026-11-03 | 2026-11-03-gen-calib-c4-r4000-mvzrtbumed2d | NFR-013 | v0 | local-gen | 4,000 RPS | 0.67 | 0.0% | 무효(발생기가 반복을 시작하지 못함(dropped_itera) | 측정함 | - | perf-ledger/runs/2026-11-03-gen-calib-c4-r4000-mvzrtbumed2d/ |
| 2026-11-03 | 2026-11-03-gen-calib-c4-r4000-mvzry4zl666c | NFR-013 | v0 | local-gen | 4,000 RPS | 0.56 | 0.0% | 무효(발생기가 반복을 시작하지 못함(dropped_itera) | 측정함 | - | perf-ledger/runs/2026-11-03-gen-calib-c4-r4000-mvzry4zl666c/ |
| 2026-11-03 | 2026-11-03-gen-calib-c4-r6000-mvzroid4a231 | NFR-013 | v0 | local-gen | 6,000 RPS | 2.47 | 0.0% | 무효(발생기가 반복을 시작하지 못함(dropped_itera) | 측정함 | - | perf-ledger/runs/2026-11-03-gen-calib-c4-r6000-mvzroid4a231/ |
| 2026-11-03 | 2026-11-03-gen-calib-c4-r6000-mvzrtbumed2d | NFR-013 | v0 | local-gen | 6,000 RPS | 2.59 | 0.0% | 무효(발생기가 반복을 시작하지 못함(dropped_itera) | 측정함 | - | perf-ledger/runs/2026-11-03-gen-calib-c4-r6000-mvzrtbumed2d/ |
| 2026-11-03 | 2026-11-03-gen-calib-c4-r6000-mvzry4zl666c | NFR-013 | v0 | local-gen | 6,000 RPS | 2.39 | 0.0% | 무효(발생기가 반복을 시작하지 못함(dropped_itera) | 측정함 | - | perf-ledger/runs/2026-11-03-gen-calib-c4-r6000-mvzry4zl666c/ |
| 2026-11-03 | 2026-11-03-gen-calib-c4-r8000-mvzroid4a231 | NFR-013 | v0 | local-gen | 8,000 RPS | 2.55 | 0.0% | 무효(발생기가 반복을 시작하지 못함(dropped_itera) | 측정함 | - | perf-ledger/runs/2026-11-03-gen-calib-c4-r8000-mvzroid4a231/ |
| 2026-11-03 | 2026-11-03-gen-calib-c4-r8000-mvzrtbumed2d | NFR-013 | v0 | local-gen | 8,000 RPS | 2.24 | 0.0% | 무효(발생기가 반복을 시작하지 못함(dropped_itera) | 측정함 | - | perf-ledger/runs/2026-11-03-gen-calib-c4-r8000-mvzrtbumed2d/ |
| 2026-11-03 | 2026-11-03-gen-calib-c4-r8000-mvzry4zl666c | NFR-013 | v0 | local-gen | 8,000 RPS | 2.24 | 0.0% | 무효(발생기가 반복을 시작하지 못함(dropped_itera) | 측정함 | - | perf-ledger/runs/2026-11-03-gen-calib-c4-r8000-mvzry4zl666c/ |
| 2026-11-03 | 2026-11-03-gen-calib-c8-r12000-mvzs2y231816 | NFR-013 | v0 | local-gen | 12,000 RPS | 1.31 | 0.0% | 무효(발생기가 반복을 시작하지 못함(dropped_itera) | 측정함 | - | perf-ledger/runs/2026-11-03-gen-calib-c8-r12000-mvzs2y231816/ |
| 2026-11-03 | 2026-11-03-gen-calib-c8-r16000-mvzs2y231816 | NFR-013 | v0 | local-gen | 16,000 RPS | 6.66 | 0.0% | 무효(발생기가 반복을 시작하지 못함(dropped_itera) | 측정함 | - | perf-ledger/runs/2026-11-03-gen-calib-c8-r16000-mvzs2y231816/ |
| 2026-11-03 | 2026-11-03-gen-calib-c8-r4000-mvzs2y231816 | NFR-013 | v0 | local-gen | 4,000 RPS | 0.57 | 0.0% | 무효(발생기가 반복을 시작하지 못함(dropped_itera) | 측정함 | - | perf-ledger/runs/2026-11-03-gen-calib-c8-r4000-mvzs2y231816/ |
| 2026-11-03 | 2026-11-03-gen-calib-c8-r8000-mvzs2y231816 | NFR-013 | v0 | local-gen | 8,000 RPS | 0.38 | 0.0% | 무효(발생기가 반복을 시작하지 못함(dropped_itera) | 측정함 | - | perf-ledger/runs/2026-11-03-gen-calib-c8-r8000-mvzs2y231816/ |
| 2026-11-03 | 2026-11-03-number-notls-r1-local-poc | NFR-001 | v1 | local-poc | 200,000 RPS | 792 | 63.0% | 무효(발생기 병목: 못 보낸 요청=34699) | 측정함 | 0 | perf-ledger/runs/2026-11-03-number-notls-r1-local-poc/ |
| 2026-11-03 | 2026-11-03-number-tls-r1-local-poc | NFR-001 | v1 | local-poc | 200,000 RPS | 395 | 55.1% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-03-number-tls-r1-local-poc/ |
| 2026-11-03 | 2026-11-03-number-tls-r2-local-poc | NFR-001 | v1 | local-poc | 200,000 RPS | 559 | 60.6% | 미판정 | 측정함 | 0 | perf-ledger/runs/2026-11-03-number-tls-r2-local-poc/ |
| 2026-11-03 | 2026-11-03-number-tls-r3-local-poc | NFR-001 | v1 | local-poc | 200,000 RPS | 875 | 57.6% | 무효(발생기 병목: 못 보낸 요청=358980) | 측정함 | 0 | perf-ledger/runs/2026-11-03-number-tls-r3-local-poc/ |
<!-- ledger:end -->

표준 서식 예시 (참고용 Mock 데이터):

| 날짜 | 측정 ID | KPI | 버전 | 프로파일 | 규모 | p99(ms) | 오류율 | 판정 | 증거 수준 | 비용(원) | 폴더 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 예시 | 2026-11-02-k1-v0-local-10k | K1 | v0 | local-10k | 10,000명, 20,000 RPS | 2,300 | 4.0% | baseline | 측정함 | 0 | runs/… |
| 예시 | 2026-11-09-k1-v1-local-10k | K1 | v1 | local-10k | 10,000명, 20,000 RPS | 80 | 0.0% | pass | 측정함 | 0 | runs/… |

K8(Game Day) 실행 행은 p99 칸에 장애별 탐지 시간($T_1 - T_0$)의 최댓값(ms)과 그 시나리오를, 규모 칸에 주입 세기를 적는다. 번 레이트 경보로 잡는 시나리오는 주입 세기를 소진 배수로 적는다(§8, 추천 적용 2026-10-28, 기술 검토 높음-12).

## 6. 시각화 그래프 체계

| 시각화 그래프 | 그래프 표현 내용 | 생성 CLI 명령 |
| --- | --- | --- |
| 비례 불변 스케일링 곡선 | 가로축: 동시 대기자 수, 세로축: 백엔드 원 서버로 들어오는 RPS와 p99 지연 시간. v0는 대기 인원에 비례해 늘고(v1과 같은 거리별 폴링을 원 서버가 모두 받는다, ADR-0096), v1은 활성 파일 수만큼만 완만히 늘어 거의 평평하다. 이 둘을 대비해 보여 준다. 설계 식과의 차이는 6.1.1 보고서에 표로 적는다(docs/verification.md §3.4) | `charts.py scale --runs …` |
| USL 확장 곡선(보조) | 가로축: 진입 서버 대수, 세로축: SLO 안에서 낼 수 있는 최대 처리량. 측정 점, 측정 범위에 맞춘 곡선, 외삽 구간(점선), 목표 처리량 선, 필요한 대수와 외삽 배수를 그린다. 20만 RPS 판단은 이 곡선이 아니라 설계 식(진입 서버 1대 처리량 × 대수, 상한은 Redis 한 키)으로 하고, 이 곡선은 비례 전제를 확인하는 보조 자료다. 비례 효율 E(N)과 호스트 포화 점 표시는 도구 반영 예정이다(wbs 6.1.1, docs/verification.md §3.3, ADR-0096) | `charts.py usl --points … --target 200000` |
| 아키텍처 전후 비교 차트 | 핵심 10대 KPI마다 베이스라인(v0)과 개선 아키텍처(v1)의 실측치를 나란히 놓은 막대 차트. 합격은 NFR·K의 절대값으로 판정하고, v0 대비 비율은 보조 숫자다(ADR-0096) | `charts.py before-after --pairs K1=runA:runB …` |
| 서비스 분리 세 구성 비교 | 가로축: 진입 폭주 단계(없음·100%·120%), 세로축: 결제 접수 p99와 오류율. 세 구성을 나란히 놓고 3회 반복 편차를 함께 그린다(docs/verification.md §3.8). 도구 반영 예정(wbs 2.12.5) | (도구 반영 예정) |
| 트래픽 폭발 타임라인 차트 | 초당 진입 폭발 구간 동안 들어오는 RPS, p99 지연 시간, 오류율을 1초 단위로 그린 시계열 추이 | `charts.py timeline --run … --series origin_rps,p99_ms,error_rate` |

모든 성능 차트는 벡터 형식(SVG)으로 `docs/perf-ledger/charts/`에 그려 원본 데이터 CSV와 함께 저장한다. 그래픽을 손으로 편집하는 일은 모두 금지한다.

## 7. 수치의 학술적 표시 규칙

| 표기 범주 | 정의 및 서술 원칙 |
| --- | --- |
| 실측 (Measured) | 이 장부의 실행 폴더에 원본 데이터가 영구 보존된 수치다. 반복 측정 횟수를 반드시 함께 적고(예: 로컬 3회 실행 중앙값, 클라우드 1회 실행), 환경을 '실측(PC)'과 '실측(클라우드)'로 나눠 적는다. |
| 외삽 (Extrapolated) | 잰 범위의 결과를 식으로 늘려 구한 수치다. 식은 설계가 예측하는 식(예: 원 서버 응답 = 활성 파일 수 ÷ 캐시 수명, 진입 용량 = min(진입 서버 1대 처리량 × 대수, Redis 한 키 처리량))이나 USL처럼 뜻이 있는 모델만 쓰고, 다항식 맞추기는 쓰지 않는다. 근거 실행 ID, 식과 계수, 측정 범위, 외삽 배수(목표 ÷ 측정 최대치. USL 곡선은 필요한 N ÷ 측정한 최대 N, docs/verification.md §3.3)를 반드시 적는다(예: 100만 명 원 서버 응답은 local-1k·10k·100k 실측과 맞는지 확인한 설계 식으로 계산한다, docs/verification.md §3, ADR-0057). |
| 문서 인용 (Cited) | 우리가 재지 않고 제공사 공식 문서에만 근거한 수치다(예: CloudFront 배포 하나의 한도, 관리형 장애 조치 시간, 노드 시작 시간). 문서 주소와 확인 날짜를 적고, 실측처럼 쓰지 않는다. |
| 설계 목표 (Target) | 개발하기 전에 아키텍처 요구사항으로 정한 목표 수치다(docs/planning/02 NFR 규약). |
| 하한선 (Lower Bound) | 상용 환경의 악의적 봇 트래픽처럼 전체 정답지가 없어서, 허니팟 함정·표본 검토·사후 이상 분석으로 찾아낸 최소 수치다. 실제 침투 규모는 이보다 크거나 같다는 뜻이다(FR-049). 허니팟 적중은 사람이 일으킨 접촉(링크를 미리 여는 확장 프로그램 등)이 섞일 수 있어, 적중 수에 표본 수동 검토로 잰 정밀도의 Wilson 95% 하한을 곱해 넣는다. 그래야 하한이 부풀지 않는다(추천 적용 2026-10-28, 기술 검토 낮음-122). |

기술 문서를 쓰거나 면접에서 답할 때는 위 5가지 표기 범주를 엄격히 구분해 쓰고, 서로 섞어 쓰지 않는다.

**비율·백분위의 판정(추천 적용 2026-10-28, 기술 검토 중간-002)**: 비율 목표(성공률 99.9%, 오거부 0.1% 미만)와 백분위 목표(p99 3초)는 docs/planning/02 §3.1 원칙 6의 식으로 판정한다. 시행 수 n과 목표를 어긴 수 k(백분위는 기준값을 넘은 수)를 장부에 함께 남기고, 어긴 비율의 정확 이항 단측 95% 상한(`ledgerlib.cp_upper(k, n)`, Clopper-Pearson)이 허용 비율 이하일 때만 `verdict: pass`로 적는다. 기준 이하 비율은 기준값에 맞춘 히스토그램 칸(ADR-0077)에서 센다. 최소 시행 수(k = 0)는 99.9%·0.1% 미만이 2,995번, p99가 299번, p95가 59번이다. 이보다 적으면 `verdict`를 `pass`로 두지 않고 `notes`에 '관측값(시행 n번, 최소 시행 수 미달)'으로 적는다. 수십 번 하는 Game Day의 명령 반영(K8)은 최댓값으로 판정한다(§8). 장부 도구는 `collect.py --checks`로 시행 수·어긴 수를 받아 이 판정을 한다(§2.2 `checks`·`verdict`, wbs 1.4.1, 2026-11-02). 이 식을 처음 쓰는 시험은 C-T2·S-T13·O-T1·O-T2다.

**KPI별 증거 수준(추천 적용 2026-10-28, 기술 검토 중간-111)**: 숫자의 표기 범주(위 표)와 별도로, KPI마다 무엇을 실제로 만들어 쟀는지를 측정함·구현함·설계만·계산만으로 적는다(정의는 docs/planning/02 §2 '증거 수준'). 실측은 측정함, 외삽과 문서 인용은 계산만에 해당한다. 아래는 포트폴리오에서 목표로 하는 수준이고, 지금(2026-10-28)은 구현 전이라 모두 '설계만'이다. 장부 요약 표(§5)의 '증거 수준' 칸이 행마다 이 수준을 보인다(manifest `evidence`, `index.py`, wbs 1.4.1, 2026-11-02).

| KPI | 측정함 | 계산만·설계만으로 남는 것 |
| --- | --- | --- |
| K1 | 1천·1만·10만 명 v0·v1 실측(PC), 진입 서버 1대·Redis 한 키 처리량 | 100만 명 값은 계산만(설계 식 외삽), CDN 몫과 셔플 결과 조회는 계산만(문서 인용) |
| K2·K3·K4 | 실제 크기(좌석 5만, 연결 5,000) 실측(PC) | 관리형 Redis·Aurora의 장애 조치 시간은 계산만(문서 인용) |
| K5 | 랩 판정(Playwright + web-vitals, 중급 모바일 프로필) | RUM 판정은 운영 뒤라 포트폴리오에서는 설계만 |
| K6 | 합성 봇 12칸과 공개 실제 사람 기록 947명(공개 자료 기준, 1인 1기록, `BehaviorScore`만. 추천 적용 2026-10-31, ADR-0174) | 우리 화면의 실제 사람 기준 오탐은 출시 뒤 첫 온세일 R2에서 확인(그 전에는 설계만), 운영 환경 봇 침투율은 하한선 추정(출시 뒤) |
| K7 | 결제 시뮬레이터에 장애를 넣은 1만 건 | 실제 결제사의 승인 한도·시간 초과는 계산만(추정, ADR-0036) |
| K8 | 로컬 실행·대체 장애 Game Day(docs/verification.md §5.2) | 모의 진행(G-17·G-28·G-32·G-33)과 G-26(관측 스택 AZ 장애)은 설계만 |
| K9 | 로컬 파드 확장 시간선 | 노드 기동 시간은 계산만(문서 인용), 온세일 1회 비용은 계산만(가격표 추정) |
| K10 | 시뮬레이션과 기기 벤치(오프라인 판정, 중복 입장 탐지) | 실제 관리형 기기 무리와 현장 망은 설계만 |

## 8. Game Day 장애 복구 시간선

관제의 핵심 기술 지표인 K8은 10대 장애를 60초 이내에 탐지하는지와 콘솔 운영 명령을 명령마다 3초 이내(최댓값 기준)에 파드(쿠버네티스에서 앱이 실행되는 가장 작은 단위)에 반영하는지를 본다. Game Day는 수십 번이라 p99가 사실상 최댓값이므로, p99 3초와 성공률 99.9%는 3,000번 이상 보내는 C-T2로 따로 판정한다(§7, 추천 적용 2026-10-28, 기술 검토 중간-002). 이 지표는 여러 구성 요소에서 실제로 잰 타임스탬프로 증명한다. 시나리오마다 다음 시간선을 `runs/<run-id>/timeline.csv`로 영구 보존하고, Grafana(지표와 로그를 그래프로 보여 주는 도구) 대시보드 주석과 ops-svc 감사 로그로 서로 대조해 검증한다.

| 시각 (UTC) | 발생 사건 | 데이터 원천 |
| --- | --- | --- |
| 주입 시점 ($T_0$) | 카오스 장애 주입 명령 실행 | Chaos Mesh·Toxiproxy 실행 이벤트 로그(운영 설계에는 AWS FIS도 포함, 포트폴리오 기간의 실행 방식은 docs/verification.md §5.2) |
| 알림 시점 ($T_1$) | 시나리오의 기대 알림이 처음 뜬 때(여러 시간 창으로 본 번 레이트(목표가 허용하는 실패량을 쓰는 속도) 경보, 원인·관제 자체 신호의 경보, G-07은 판매 중 탭 신선도의 경고 색, docs/observability.md §12) | Alertmanager 웹훅(일이 생기면 상대 서버가 우리 주소를 불러 알려 주는 방식) 수신 로그 |
| Datadog 이상 표시 ($T_{1d}$, wbs 4.8.2 비교에서만) | Watchdog 이상 또는 이상 탐지 모니터(`basic`)가 처음 표시한 시각이다. 사람을 부르지 않는다 | Datadog(관측 기능을 묶어 파는 상용 서비스) Watchdog 목록·모니터 이벤트 내보내기 |
| 명령 접수 ($T_2$) | 운영 명령의 최종 승인 완료(2인 명령은 두 번째 승인) | ops-svc 이벤트 소싱 감사 원장 |
| 파드 반영 ($T_3$) | 대상 마이크로서비스 파드가 제어 명령을 적용했다는 ack 수신 | ops-svc 이벤트 소싱 감사 원장 |
| 서비스 정상 복구 ($T_4$) | 핵심 SLI 지표의 정상 허용치 이내 복원 완료 | Prometheus(지표를 모아 저장하는 도구) 시계열 메트릭 |

- 장애별 탐지 시간 = $T_1 - T_0$. K8은 주입한 장애마다 60초 이내인지 판정한다(최댓값 기준). 평균은 쓰지 않고 모든 값을 기록한다(ADR-0049)
- 탐지 시간 나누기(추천 적용 2026-10-28, 기술 검토 높음-12): `timeline.csv`에 Prometheus 경보가 firing이 된 시각($T_{1p}$, `ALERTS{alertstate="firing"}`의 첫 표본)도 남긴다. $T_1 - T_0$는 조건이 성립하는 시간 + 긁기 간격 + 규칙 평가 간격 + Alertmanager 묶음 대기(`group_wait`) + 웹훅 전달이고, $T_1 - T_{1p}$가 묶음 대기와 전달이다. K8은 알림이 도착한 $T_1$로 판정한다.
  - 간격은 운영 설정(docs/observability.md §4 '긁기·평가·알림 간격')과 같아야 한다. 다르면 그 실행은 K8 판정에 쓰지 않고 manifest의 `valid` 사유에 적는다. 간격을 줄인 시험 설정은 탐지 시간을 실제보다 짧게 보이게 한다.
  - 번 레이트 경보로 잡는 시나리오는 주입 세기(소진 배수 k)를 함께 적는다. SEV1(2분 창 10배)의 탐지 시간은 약 120초 × 10 ÷ k에 간격 합(약 15초)을 더한 값이라, k가 약 27보다 작으면 60초를 넘을 수 있다(docs/observability.md §4).
- 제어 명령 전파 반영 시간 = $T_3 - T_2$
- Game Day 시나리오 33종 전체 목록은 docs/observability.md §12에 있다.
- Datadog 이상 탐지 힌트 비교(소유자 결정 2026-10-21, ADR-0076 상태 줄, docs/observability.md §13): 장애마다 $T_0$·$T_1$·$T_{1d}$, 우리 규칙과 Datadog 각각의 탐지 여부, 표시한 쪽(Watchdog 로그 이상·Watchdog 지표 이상·이상 탐지 모니터)을 `runs/<run-id>/hint_compare.csv`로 남긴다. 주입과 관계없는 이상 표시는 헛경보 행으로 같은 파일에 남기고, 같은 시간대에 우리 규칙이 낸 헛경보도 센다. Datadog이 먼저 잡은 시간은 $T_1 - T_{1d}$다. 체험 기간이 14일이라 Watchdog 지표 이상이 기준선 부족으로 동작하지 않았으면 그 사실을 `valid` 사유에 적는다.

## 9. 장기 보관 및 아카이빙 정책

- **나눠 두기(추천 적용 2026-10-28, 기술 검토 낮음-056)**: Git에는 manifest·k6 요약·지표 요약·불변식 결과·`SHA256SUMS`처럼 작은 파일만 버전 관리한다(§2.1 목록). 큰 원본(지표 CSV, 분산 트레이스(요청 하나가 여러 서비스를 거친 길과 시간을 남긴 기록), 대시보드 그림, 콘솔 로그)은 gzip으로 묶어 S3(AWS의 파일 저장소) 원본 버킷에 둔다. 버킷은 버전 관리를 켜서 같은 이름으로 덮어써도 옛 판이 남는다. 예전처럼 실행 폴더를 통째로 Git에 넣으면 실행 하나가 50MB까지 커져 측정이 쌓일수록 저장소가 수 GB가 된다.
- 원본 버킷과 따로, 클라우드 S3 아카이브 버킷에 장기 백업 사본을 동기화한다(docs/observability.md §9). 백업 아카이브에는 `SHA256SUMS` 해시 지문 목록을 반드시 함께 넣는다.
- **사후 조작의 증거(추천 적용 2026-10-28, 기술 검토 낮음-056)**: `SHA256SUMS`는 같은 폴더 안에서 다시 만들 수 있어 실수로 바뀐 파일만 잡는다. 그래서 `index.py`가 하루 한 번 그날 끝난 실행들의 `SHA256SUMS` 해시를 `timestamps/<날짜>.txt`로 모으고, 그 파일을 OpenTimestamps(공개 블록체인에 해시를 묶어 그 시각에 있었음을 누구나 확인하게 하는 무료 도구, 감사 앵커와 같은 도구, ADR-0075)로 고정한다. 증명 파일 `.ots`는 확정되면(보통 몇 시간 뒤) 갱신해 Git에 넣는다. 그러면 그날 뒤에 숫자나 원본을 바꾼 것이 드러난다. 남는 한계: 고정하기 전(측정이 끝난 날 안)에 바꾼 것과, 측정 자체를 꾸며 낸 것은 이 증거로 드러나지 않는다. 그 몫은 `stdout.log`·`infra.txt`와 다시 돌릴 수 있는 시나리오(§3)가 맡는다.
- 실험 중에 실패했거나 규격을 채우지 못한 무효 측정 결과도 마음대로 버리지 않는다. `valid: false` 플래그와 자세한 무효 사유를 기록해 남기는 것 자체가 투명한 엔지니어링의 핵심 자산이다.

## 10. K6 봇 탐지 평가 절차(ADR-0039·0048·0112·0174)

K6 측정을 어떻게 준비하고 장부에 넣는지 정한다. 결정과 근거는 ADR-0039, ADR-0048, ADR-0112, ADR-0174에 있다.

### 10.1 사람 표본: 공개 자료 기준·모의 사람·출시 뒤 실제 사람 기준

판정용 사람을 모으지 않는다(소유자 결정 2026-10-31, ADR-0174). 사람 오탐은 원천에 따라 셋으로 나눠 적고, 숫자마다 꼬리표를 붙인다. 꼬리표가 다른 숫자를 더하거나 서로 갈음하지 않는다(세부는 추천 적용 2026-10-31, ADR-0174).

| 꼬리표(원천) | 무엇으로 재나 | 쓰는 곳 |
| --- | --- | --- |
| 공개 자료 기준(`public`) | 다른 연구팀이 공개한 실제 사람 기록 | 출시 전 K6의 사람 쪽 합격 판정 |
| 모의 사람(리허설)(`mock`) | 모의 사람 생성기(wbs 1.2.2 ②) | 측정 절차·도구 리허설과 규칙 회귀. 합격 판정을 내지 않는다 |
| 실제 사람 기준(출시 뒤)(`live`) | 첫 온세일의 그림자 판과 R2 표본 검토(docs/features/bot-defense.md §13) | NFR-022의 실제 사람 기준(§10.6) |

판정 단위는 사람이다(ADR-0112). 공개 자료에서도 한 사람은 판정 기록 하나만 넣는다. 판정에 쓰는 행동 신호는 사람에게 붙은 특징이라, 같은 사람의 기록을 여럿 넣으면 기록끼리 독립이라는 상한 계산의 전제가 깨지기 때문이다.

| 항목 | 규칙(공개 자료 기준) |
| --- | --- |
| 크기와 합격 기준 | 결과를 보기 전에 `--k6-plan N:C --k6-source public`으로 등록하고 바꾸지 않는다. 기본은 947명·오탐 1건 이하이고, 더 크게 잡으면 1,549명·오탐 3건 이하다. n은 공개 자료에서 뽑은 판정용 사람 수다. 상한 0.5%는 판정 기록끼리(곧 사람끼리) 독립이라는 가정의 값이다 |
| 판정 | n명을 뽑은 뒤 한 번만 계산한다. 공개 자료는 사람이 많아 n을 못 채워 판정 보류가 되는 일은 없다. 이용 조건이 바뀌어 자료를 쓸 수 없게 되면 그 원천은 '측정 못 함'으로 적는다(`plan_verdict` `INSUFFICIENT`) |
| 자료와 이용 조건 | 이용 조건을 확인한 자료만 쓴다. 키 입력은 Aalto 136M Keystrokes(화면의 문장을 옮겨 치는 타자 시험, 약 16만 8천 명, '연구·비상업 목적, 저자 표시')다. 이 저장소는 포트폴리오(비상업)라 조건 안이고, 상업 운영으로 바뀌면 다시 확인한다(소유자 몫). 포인터는 The Attentive Cursor Dataset(1인 1궤적)이 후보인데 이용 조건이 적혀 있지 않아 허락 전에는 쓰지 않는다(허락 요청은 소유자 몫). 그동안 `BehaviorScore`의 포인터 칸은 '포인터 칸 측정 못 함(이용 허락 없음)'으로 적는다. 출처 표시는 측정 보고서와 manifest에 둔다 |
| 뽑기와 나누기 | 내려받은 자료 판(파일 해시)을 적고, 고정 씨앗값으로 사람 단위로 조정용과 판정용을 나눈 뒤 판정용에서 n명을 뽑는다. 씨앗값과 자료 판은 결과를 보기 전에 manifest `k6_plan`에 적는다. 한 사람에게 여러 세션이 있으면 그 사람의 첫 세션만 판정 기록이고, 나머지는 사람 안 상관을 참고로 잴 때만 쓴다 |
| 변환 | 공개 기록을 우리 행동 요약 형식으로 바꾼다(wbs 1.2.2 ②). 입력 시각 간격과 포인터 궤적 요약값만 옮기고 입력한 글자 내용은 옮기지 않는다. 변환 규칙은 결과를 보기 전에 정한다 |
| 보는 신호 | `BehaviorScore`(docs/features/bot-defense.md §4.2)만 자료에서 값을 채운다. 행동 요약에는 자료에 있는 칸(입력 간격, 허락 뒤 포인터 이동)만 채운다. 오탐은 `BehaviorScore` 혼자의 위험 기여(가중치 × 위험 값)가 그 판정 강도의 기준값의 절반 [가정, wbs 1.2.2에서 확정] 이상인 사람 기록의 비율로 센다. 이 기준은 결과를 보기 전에 manifest `k6_plan`에 적는다. 나머지 다섯 점수기(`HumanCheck`·`DeviceTrust`·`NetworkScore`·`AgeScore`·`ConsistencyScore`)와 확정 신호(차단 기기 목록·허니팟)는 공개 자료에 값이 없어 판정 전체(가중합)로 세지 않는다. 0으로 두면 `BehaviorScore` 혼자 기준값에 닿지 못하는 설정에서 오탐이 늘 0이 되고, 모의 사람 값을 넣으면 우리가 정한 분포가 합격을 움직이기 때문이다. 그 강도에서 `BehaviorScore`가 낼 수 있는 최대 기여(가중치 × 최대 위험 값)도 결과를 보기 전에 `k6_plan`에 적는다. 최대 기여가 기준(판정 기준값의 절반)에 못 미치면 자료와 관계없이 오탐이 0이 되므로, 그 강도의 결과는 합격이 아니라 '측정 무의미(점수기 기여가 기준에 못 미침)'로 적는다. 참고로 `BehaviorScore` 혼자의 위험 값 분포(판정용 사람 기록의 50·90·99 백분위)를 함께 적는다. 판정 강도는 §10의 세 강도 그대로다(추천 적용 2026-10-31, ADR-0174 결정 2) |
| 층 | 공개 자료는 층(기기 3종, 망 2종, 보조기기 사용자, 60세 이상, 공용 IP)을 보장하지 못한다. 자료의 메타데이터에 있는 층만 따로 보고하고 할당은 두지 않는다. 링크를 미리 여는 확장 프로그램·보안 도구를 켠 브라우저 층(허니팟 적중, FR-049, 기술 검토 낮음-122)은 그 확장 프로그램을 켠 브라우저를 모의 사람 시나리오로 돌려 회귀 시험으로 보고, 허니팟의 실제 정밀도는 출시 뒤 표본 검토로 잰다(docs/features/bot-defense.md §7·§13) |
| 세션 종류 | 사람 쪽에는 실제 사람의 입력 기록만 넣는다. 공개 자료 기록을 행동 요약으로 바꿔 사람 쪽에 넣는 것은 판정 경로에 값을 넣는 일이라 재생 세션이 아니다. '녹화한 사람 입력을 재생한 세션은 3단계 봇으로 센다'는 우리 화면에 녹화한 입력을 다시 흘려 넣는 공격 세션에 대한 말이다. 3단계 봇의 재생 궤적 재료로는 공개 자료의 조정용 사람 기록만 쓰고, 판정용 사람과 겹치지 않는다(추천 적용 2026-10-31, ADR-0174) |
| 조정용 표본 | 공개 자료에서 사람 단위로 나눈 조정용 사람만 쓴다. 규칙 조정과 3단계 봇의 재생 궤적에 쓰고 판정용에 넣지 않는다 |
| 한계 | 우리 화면이 아니다(문장을 옮겨 치는 과제·포인터 과제). 휴대폰 터치·IP·기기 신호가 없다. 참가자가 타자 시험 자원자·크라우드 작업자라 우리 이용자 구성과 다르다. 사람끼리의 독립은 자료를 만든 쪽의 모집에 기대는 가정이다. 그래서 '공개 자료 기준'은 실제 사람 기준이 아니고 NFR-022의 실제 사람 기준(§10.6)을 갈음하지 않는다 |
| 개인정보 | 공개 자료는 익명으로 공개된 연구 자료다. 그래도 내려받은 원본과 변환한 사람별 파일(§10.5)은 저장소와 장부 실행 디렉터리에 넣지 않고 측정 PC에만 두며, 측정이 끝나면 지운다(이용 조건이 더 짧게 정하면 그것을 따른다). 장부에는 혼동 행렬, 층별 집계, 자료 판의 해시만 남긴다(data-classification '공개 실제 사람 기록(봇 평가)') |
| 모의 사람(리허설) | 모의 사람 생성기(입력 리듬·포인터 궤적·기기·망·보조기기 사용을 흉내 낸 세션, 고정 씨앗값)의 세션을 원천 `mock`으로 같은 경로에 넣는다. 사전 등록·1인 1판정 검사(V-T25)와 혼동 행렬 경로(Q-T20)가 끝까지 도는지, 규칙을 바꿀 때 모의 사람 오탐이 갑자기 늘지 않는지 본다. 그 수치는 실제 성능이 아니므로 `plan_verdict`를 `REHEARSAL`로 적고 K6 합격 판정에 쓰지 않는다 |

실제 오탐률별 통과 확률(tools/perf-ledger의 `cp_upper`와 이항 분포로 계산, 판정 기록끼리 독립 가정):

| 실제 오탐률 | 600명·0건 | 947명·1건 | 1,549명·3건 |
| --- | --- | --- | --- |
| 0.05% | 74.1% | 91.8% | 99.2% |
| 0.1% | 54.9% | 75.5% | 92.8% |
| 0.2% | 30.1% | 43.5% | 62.5% |
| 0.5%(목표 경계) | 4.9% | 5.0% | 5.0% |

- 이 확률은 판정 기록끼리 독립일 때 맞는다. 같은 사람의 기록을 여럿 판정에 넣으면, 오탐이 일부 사람에게 몰릴 때 경계(평균 0.5%)에서 잘못 통과할 확률이 명목 5%보다 커진다. 정확 이항 분포로 계산하면 190명 × 5세션은 8~39%, 474명 × 2세션은 6~10%, 947명 × 1세션은 5.0%다(몰린 모양 넷, ADR-0112 맥락). 그래서 공개 자료에서도 판정 기록은 1인 1기록이다.
- 사람끼리의 독립은 남는 가정이다. 공개 자료에서는 자료를 만든 쪽의 모집에 기댄다. 사람 단위로 나눈 조정용 표본이 조정과 판정이 섞이는 것을 막는다. 자료에 같은 사람의 다른 세션이 있으면 사람 안 상관을 참고로 manifest에 남긴다(§10.5).

### 10.2 12칸 등급표

등급 이름은 `<유형>-L<단계>`로 쓴다. 유형은 `volume`(물량형), `speed`(속도형), `account`(계정 대량 생성형), `queue`(대기열 새치기형)다.

| 유형(OAT) | 1단계 HTTP 스크립트 | 2단계 브라우저 자동화 | 3단계 사람 입력 재생 |
| --- | --- | --- | --- |
| 물량형(OAT-005 Bulk purchase, OAT-021) | 여러 대여 명의 계정으로 홀드(결제하는 동안 좌석을 잠시 잡아 두는 것)·주문 API(프로그램끼리 요청과 응답을 주고받는 창구)를 반복 호출 | Playwright로 여러 계정이 동시에 좌석 선택·결제 | 조정용 사람 궤적을 변형해 여러 계정으로 재생 |
| 속도형(OAT-006, OAT-013) | 오픈 정각에 입장 확정·홀드 API를 가장 먼저 호출 | 브라우저에서 가장 짧은 클릭 경로를 자동화 | 사람 궤적을 시간 압축해 재생 |
| 계정 대량 생성형(OAT-019) | 대여 명의 풀로 가입·본인확인 API를 연속 호출 | 브라우저로 가입 흐름을 자동화 | 녹화한 가입 흐름을 변형해 재생 |
| 대기열 새치기형(OAT-005 Queue jumping) | 입장 토큰(입장 권한을 증명하는 서명된 문자열) 재사용, 순번 위조, 절차 건너뛰기 요청 | 브라우저 저장소·쿠키(브라우저가 사이트별로 저장했다가 요청마다 함께 보내는 작은 값) 조작 | 정상 흐름을 재생하면서 토큰을 바꿔치기 |

| 항목 | 규칙 |
| --- | --- |
| 1단계 수단 | JavaScript를 실행하지 않는 HTTP 클라이언트(k6, Node), 고정 IP 몇 개 |
| 2단계 수단 | Playwright(headless·headed), 지문 위장(`navigator.webdriver` 숨기기, 화면·글꼴·WebGL 값 바꾸기), 시험망 프록시 컨테이너로 IP·ASN을 돌아가며 바꾸기 |
| 3단계 수단 | 2단계에 더해, 조정용 사람 궤적(공개 자료에서 나눈 조정용 사람의 키 입력 시각, 포인터 자료는 이용 허락 전까지 모의 사람 궤적, 추천 적용 2026-10-31, ADR-0174)에 잡음과 시간 늘이기를 넣어 재생 |
| 사람 확인 | 시험 키는 늘 통과하거나 늘 실패하므로 사람 확인 시뮬레이터 어댑터를 쓴다. 풀이 성공률은 0%·50%·95%, 풀이 지연은 10~30초 [가정, 3.7.1에서 확정]로 둔다. 설정마다 따로 보고한다 |
| 명의 | 본인확인 시뮬레이터가 합성 신원을 '대여 명의 풀'로 내준다. 쓴 명의 수를 `bot_cost.csv`에 적는다. 1인 1계정과 1인 한도(POL-011)는 실서비스와 같다 |
| 세션 수 | 등급마다, 라운드마다 1,000세션(12등급 × 3라운드 = 36,000세션, `local-bot` 0원) |
| 탐지의 정의 | trust-svc가 추가 검증 큐로 보내거나 차단하면 봇 판정이다. 사람 세션이 그렇게 되면 오탐이다. 다만 공개 자료(`public`)의 사람 오탐은 판정 전체가 아니라 `BehaviorScore` 혼자의 위험 기여가 그 강도의 판정 기준값의 절반 [가정] 이상이면 오탐으로 센다(§10.1 '보는 신호'). 모의 사람(`mock`)은 다섯 점수기에도 값이 있으므로 판정 전체로 세어 모든 점수기와 확정 신호(허니팟 등)의 변경을 회귀로 잡고, 같은 기록으로 `public`의 `BehaviorScore` 혼자 기준도 함께 계산해 절차를 리허설한다(추천 적용 2026-10-31, ADR-0174 결정 2·4) |
| 추가 검증 다시 시도(추천 적용 2026-10-28, 기술 검토 중간-104) | 추가 검증 큐로 간 봇 세션은 그 설정의 사람 확인 풀이 성공률과 대여 명의로 사람 확인·본인확인을 다시 시도하고, 통과하면 원래 순번으로 돌아가 입장 확정까지 간다. 실서비스에서 대여 명의를 쓰는 봇이 하는 일과 같다(docs/features/queue-admission.md §7 '알려진 설계 한계' (1)) |
| 판정 강도 | 합격 판정은 '기본'으로 한다. '완화'·'강화'는 장부 실행을 나눠 민감도로 함께 남긴다 |
| 목표 | 1·2단계는 등급마다 탐지율 95% 이상(점추정, Wilson 95% 구간을 함께 적는다). 3단계는 §10.4의 비용 목표 |
| 함께 보고하는 값(추천 적용 2026-10-28, 기술 검토 중간-104) | 등급·라운드·풀이 성공률마다 ① 추가 검증 통과율 = 추가 검증을 통과해 돌아온 봇 세션 ÷ 탐지된 봇 세션(차단은 통과 못 함으로 센다) ② 끝에서 끝까지의 봇 성공률 = 입장 확정까지 간 봇 세션 ÷ 전체 봇 세션. 둘 다 Wilson 95% 구간을 함께 적는다. 합격 판정에는 쓰지 않는다. 탐지율이 95%여도 ①이 높으면 봇 점유율 목표(5%)를 지키지 못하므로, docs/planning/01 §3.2의 봇 점유율 추정(미탐지 봇 + 탐지 봇 × ①)을 이 값으로 다시 계산해 장부 `notes`에 남긴다. 표준 시나리오에서는 ①이 약 0.25%를 넘으면 5%를 넘는다 |

### 10.3 적응 라운드 [가정, 3.7.1에서 확정]

1. 라운드를 시작하기 전에 공격 변경 계획과 방어 규칙 버전을 장부 `notes`에 적는다.
2. 예산은 라운드마다 등급당 1,000세션, 봇 수정 8시간, 레이트 리밋(일정 시간에 받는 요청 수의 상한) 안의 요청이다.
3. 공격 스크립트는 세션 결과(통과·추가 검증·차단)만 입력으로 받고 점수나 규칙은 보지 않는다.
4. 라운드 사이에 방어 규칙을 바꾸는 것은 허용하고, 바꾼 내용을 같은 장부에 남긴다.
5. 등급마다 라운드 1과 비교한 마지막 라운드의 하락폭(%p)을 `k6_eval.tier_drops`로 보고한다. 2단계가 95% 아래로 떨어지면 ADR-0039의 되돌릴 조건을 따른다.

### 10.4 1장당 획득 비용

```text
1장당 획득 비용 = (명의 수 × 명의 단가 + 프록시 GB × GB 단가 + 풀이 수 ÷ 1,000 × 1,000건 단가
                  + 운영 시간 × 시간 단가 + 시험 인프라 비용) ÷ 얻은 장수
기대 처벌 비용 = 적발 확률 × 50 × (정가 + 웃돈)
1장 손익 = 웃돈 − 1장당 획득 비용 − 기대 처벌 비용
```

| 단가 | 기본값 | 근거 | 표시 |
| --- | --- | --- | --- |
| 명의 1개 | 5만 원(민감도 2만 원·10만 원) | 아이디 옮기기 수고비 2만 원에서 10만 원 넘게(아시아경제 2024-04-17 보도) | 추정 |
| 프록시 1GB | 7.00달러 | IPRoyal 주거용 프록시, 쓴 만큼 내는 요금제(2026-10-13 가격표) | 공개 가격 |
| 사람 확인 풀이 1,000건 | 1.45달러 | 2Captcha가 Cloudflare의 사람 확인 서비스인 Turnstile을 풀어 주는 가격(2026-10-13 가격표) | 공개 가격 |
| 운영 1시간 | 1만 원 | 1인 운영 인건비 | [가정, 3.7.1에서 확정] |
| 환율 | `usd_krw` 또는 manifest `exchange_rate` | 측정일 환율 | 측정 |
| 웃돈 | 20만 원, 90만 원 | 인기 공연 보도 사례 20만 원(아시아경제 2024-04-17), 정가 9만 9천 원 좌석을 100만 원 넘게 판 사례(데일리안 2026-08-28) | 추정 |
| 정가 | 15만 원 | 기대 처벌을 계산할 때 쓰는 기준값 | [가정, 3.7.1에서 확정] |
| 적발 확률 | 1%, 5% | 공개 자료가 없다 | [가정, 3.7.1에서 확정] |

- 시험에서 재는 값은 명의 수, 프록시 GB, 풀이 수, 운영 시간, 인프라 비용, 얻은 장수다. 얻은 장수가 0이면 1장당 비용은 '획득 없음'이다.
- 기대 처벌은 과징금 상한(판매금액의 50배, 공연법 §4의4)으로 계산하므로 크게 잡힌 값이다. 형사처벌(§41)은 금액으로 넣지 않는다.
- 단가는 측정할 때마다 그날의 가격표로 다시 확인하고 날짜를 남긴다. 명의 단가와 웃돈은 불법 시장 가격이라 공식 자료가 없다. 그래서 보도 사례의 범위로 민감도를 본다.
- 3단계 목표 형식(추천 적용 2026-10-28, 기술 검토 낮음-149): 등급마다 '1장당 획득 비용 ≥ 기준 웃돈 × 비율 k'. 합격식에는 플랫폼이 통제하는 값(봇이 1장을 얻는 데 드는 비용)만 둔다. 기대 처벌 비용은 적발 확률과 과징금 상한이라는 플랫폼 밖의 가정으로 만든 값이라, 시스템을 바꾸지 않고 가정만 바꿔도 목표를 채울 수 있어 합격식에서 뺐다. 기준 웃돈과 k(처음 값 1.0, 비용이 웃돈 이상이면 처벌이 없어도 봇이 남지 않는다)는 첫 측정 뒤 정한다 [가정, 3.7.1에서 확정].
- 기대 처벌은 합격 판정과 따로 민감도 표로 보인다. 등급마다 적발 확률 0%·1%·5% [가정]와 웃돈 20만·90만 원에서 '1장 손익'(위 식)을 한 칸씩 적는다. 이 표는 '법 집행이 함께하면 손익이 어떻게 바뀌는가'를 보이는 참고다.

### 10.5 장부 입력 파일과 필드

| 파일·옵션 | 형식 |
| --- | --- |
| `confusion.csv` | `tier,round,label,predicted,count[,stratum]`. 사람 행의 tier는 `-`다. stratum은 사람 행의 층 이름(예: `device-ios`, `assistive`, `age60`, `shared-ip`)이다. stratum이 빈 사람 행만 합계에 쓰고, 층 행은 층별 집계에만 쓴다(한 세션이 여러 층에 속할 수 있다). 사람 행은 판정 기록만 센다(ADR-0112) |
| `human_sessions.csv`(ADR-0112·0174) | `source,person,role,stratum,round,predicted,score`. 사람 기록 한 줄이 한 행이다. `source`는 원천(`public`·`mock`), `person`은 사람 코드(공개 자료는 자료의 익명 ID, 모의 사람은 생성기 번호), `role`은 `judge`(판정 기록) 또는 `ref`(같은 사람의 나머지 세션, 참고)다. `predicted`는 그 기록이 오탐 기준을 넘었는지, `score`는 그 기준에 쓴 값이다. `public`에서는 둘 다 `BehaviorScore` 혼자의 기준(그 점수기의 위험 기여가 판정 기준값의 절반 [가정] 이상인지)과 그 위험 기여이고, `mock`에서는 판정 전체(추가 검증·차단인지)와 위험 점수다(ADR-0174 결정 2·4). 도구는 모든 행의 원천이 `--k6-source`와 같은지, 사람마다 `judge`가 하나인지, `judge` 수가 N과 같은지, 사람 합계가 `confusion.csv`와 맞는지, `public` 파일에 입력한 글자 칸이 없는지 확인하고, 어긋나면 판정하지 않고 실행을 거부한다(측정 폴더를 만들지 않는다, V-T25). 이 파일은 장부 실행 디렉터리(Git)에 복사하지 않고 집계만 manifest에 적는다. 측정이 끝나면 지운다(§10.1 '개인정보'). 공격 쪽 스크립트는 이 파일을 보지 않는다 |
| `--k6-plan N:C`, `--k6-source` | `--k6-plan`은 사전 등록한 판정용 사람 수(판정 기록을 낸 사람 수)와 합격 오탐 수다(예: `947:1`). 오탐 C건의 상한이 0.5%를 넘는 조합은 도구가 거부한다. `--k6-source`는 원천이다(추천 적용 2026-10-31, ADR-0174 결정 6): `public`이면 `--k6-plan`이 있어야 하고 판정한다. `mock`이면 `--k6-plan`이 있어야 하고 같은 계산을 하되 `plan_verdict`를 `REHEARSAL`로 적는다(절차 리허설). `live`면 `--k6-plan`을 받지 않고(주면 거부) `human_sessions.csv` 대신 `fp_review.csv`를 읽어 출시 뒤 추정(§10.6)을 적는다 |
| `fp_review.csv`(추천 적용 2026-10-31, ADR-0174 결정 3·6) | `batch,sampled,human,bot,unsure,population`. 출시 뒤 R2 표본 검토의 집계다. `batch`는 `pass`(첫째 묶음, 적용 판과 그림자 판이 모두 통과시킨 세션) 또는 `shadow_challenge`(둘째 묶음, 그림자 판이 추가 검증으로 보낸 세션), `sampled`는 표본 수, `human`·`bot`·`unsure`는 라벨 수, `population`은 그 묶음을 뽑은 전체 세션 수다. 도구는 두 묶음이 다 있는지, 묶음마다 `sampled`가 200 [가정]과 `population` 가운데 작은 값 이상인지(전체가 200건 이하이면 모두 검토한 전수 검토다), `sampled ≤ population`인지, `human + bot + unsure = sampled`인지 확인하고 어긋나면 실행을 거부한다. 전수 검토인 묶음은 비율을 구간 없이 그 값으로 쓴다. 세션 ID나 사람 코드는 없다 |
| `bot_cost.csv` | `tier,round,ids,proxy_gb,solves,ops_hours,infra_krw,tickets` |
| `bot_outcomes.csv`(추천 적용 2026-10-28, 기술 검토 중간-104) | `tier,round,solve_rate,sessions,detected,blocked,verify_passed,admitted`. 봇 세션의 끝 결과를 등급·라운드·풀이 성공률(`0`·`0.5`·`0.95`)마다 센 값이다. 도구는 같은 등급·라운드에서 풀이 성공률별 `detected`의 합이 `confusion.csv`의 봇 판정 수와 맞는지, `blocked + verify_passed ≤ detected`인지, `admitted ≤ sessions`인지 확인하고 어긋나면 실행을 거부한다 |
| `bot_prices.json` | `id_krw`, `proxy_usd_per_gb`, `solve_usd_per_1k`, `hour_krw`, `usd_krw`(없으면 manifest 환율), `face_krw`, `premiums_krw`(목록), `catch_probs`(목록) |
| manifest `k6_eval` | 등급·라운드별 탐지율과 Wilson 구간(3단계는 `meets_target: null`). 탐지율은 원래 가중치 판(합격 판정)과 출시 첫 판(`BehaviorScore` 적용 가중치 0, `launch_detection`)을 함께 적는다(추천 적용 2026-10-31, ADR-0174 결정 5), `tier_drops`, 라운드별 사람 오탐과 단측 상한, `human_strata`(자료 메타데이터에 있는 층만), `plan_verdict`(PASS·FAIL·INSUFFICIENT·REHEARSAL·UNMEASURABLE. UNMEASURABLE은 '측정 무의미': `BehaviorScore`의 최대 기여가 기준에 못 미친 강도, 추천 적용 2026-10-31, ADR-0174 결정 2). 원천 칸(추천 적용 2026-10-31, ADR-0174): `human_source`(`public`·`mock`·`live`), `dataset`(자료 이름·판·파일 해시·출처 표시 문구), `split_seed`(조정용·판정용을 나눈 씨앗값과 뽑기 씨앗값), `behavior_only`(`BehaviorScore` 혼자의 위험 값 50·90·99 백분위, 참고), `live_fp`(§10.6, `live`일 때만). ADR-0112의 사람 단위 칸: `human_units`(사람 수·판정 기록 수·확인 결과), `sessions_per_person`(사람당 세션 수 분포), `human_icc`(위험 점수의 사람 안 상관, 점추정과 95% 상한. 자료에 같은 사람의 여러 세션이 있을 때만 참고로), `judged_fp_refs`(판정 기록이 오탐인 사람의 나머지 세션 결과 건수, 사람 코드 없이). 기술 검토 중간-104의 칸(추천 적용 2026-10-28): `verify_pass`(등급·라운드·풀이 성공률별 추가 검증 통과율과 Wilson 구간), `e2e_success`(끝에서 끝까지의 봇 성공률과 Wilson 구간), `bot_share_est`(docs/planning/01 §3.2 표준 시나리오의 봇 점유율을 마지막 라운드의 1·2단계 탐지율과 `verify_pass`로 다시 계산한 값, 풀이 성공률마다) |
| manifest `k6_plan`, `k6_cost` | 사전 등록 계획(N:C, 원천, 자료 판·해시, 씨앗값, 변환 규칙 판, `BehaviorScore` 혼자 기준(그 강도의 판정 기준값의 절반 [가정])과 그 강도에서 `BehaviorScore`가 낼 수 있는 최대 기여(§10.1 '보는 신호')), 등급·라운드별 1장당 획득 비용, 웃돈과 적발 확률의 경우마다 계산한 기대 처벌과 손익 |

### 10.6 출시 뒤 실제 사람 기준(방향은 소유자 결정 2026-10-31, 세부는 추천 적용 2026-10-31, ADR-0174 결정 3)

- 우리 화면의 실제 사람 오탐은 출시 뒤 첫 온세일에서 확인한다. 그 온세일은 `BehaviorScore`를 적용 판 가중치 0으로 두고 그림자 판에서만 원래 가중치로 돌린다(docs/features/bot-defense.md §10.1).
- 마감 단계 R2(오픈 + 7일, docs/features/analytics.md §4.2) 전에 표본 검토를 두 묶음으로 한다. 첫째 묶음은 적용 판과 그림자 판이 모두 통과시킨 세션에서 뽑은 200건 [가정]이고, 둘째 묶음은 그림자 판이 추가 검증으로 보낸 세션에서 뽑은 200건 [가정]이다. 묶음마다 200건이 최소 표본이고, 묶음의 전체가 200건 이하이면 모두 검토한다(전수 검토. 그 묶음의 비율은 구간 없이 그 값을 쓴다). 작은 온세일에서 둘째 묶음이 200건에 못 미쳐도 그래서 판정할 수 있다.
- 두 묶음을 섞어 무작위 순서로 내고, 검토 화면(SCR-067)에서 위험 점수 범주·판정·묶음을 가린다. 검토자는 세션 기록만 보고 사람·봇·판단 불가 라벨을 붙인다. 봇 라벨은 행동 요약 밖의 근거(확정 신호, 같은 기기·결제 수단 공유, 사후 라벨, 추가 검증 실패 같은 것)가 하나 이상 있을 때만 붙인다. 행동 요약만 보고 봇이라 하면 `BehaviorScore`와 같은 근거로 사람을 봇으로 보게 되어 오탐을 작게 보기 때문이다.
- 판단 불가는 오탐을 크게 보는 쪽으로 센다. 둘째 묶음에서는 사람으로, 첫째 묶음에서는 사람이 아닌 것으로 센다.
- 추정: 실제 사람 기준 오탐 = (그림자 판이 추가 검증으로 보낸 세션 가운데 사람의 추정 수) ÷ (그 회차 사람 세션의 추정 수)다. 분자는 그 세션 수에 둘째 묶음의 사람 비율 단측 97.5% 상한을, 분모는 적용 판과 그림자 판이 모두 통과시킨 세션 수(첫째 묶음의 `population`)에 첫째 묶음의 사람 비율 단측 97.5% 하한을 곱한다(Clopper–Pearson). 그림자 판만 통과시키고 적용 판이 추가 검증으로 보낸 사람도 분모에서 빠지므로 분모는 더 작게(오탐은 더 크게) 잡힌다. 두 구간을 각각 97.5%로 잡으면(본페로니 보정: 둘이 함께 맞을 확률이 95% 이상이 되게 나눠 잡는 방법) 결과를 '단측 95% 상한'으로 부를 수 있다. 추가 검증 쪽 사람을 분모에서 빼므로 비율도 크게 나오는 쪽이다. 정확한 식은 wbs 3.7.1에서 확정한다 [가정].
- 장부에는 `collect.py --k6-source live`가 `fp_review.csv`(§10.5)를 읽어 manifest `k6_eval.live_fp`(두 묶음의 표본 수와 사람·봇·판단 불가 수, 분자 상한, 분모 하한, 오탐 상한, R2 마감 날짜)를 적는다. N:C 판정은 하지 않는다(`--k6-plan`을 받지 않는다). 상한이 0.5%(NFR-022) 이하인지가 docs/features/bot-defense.md §10.3 ②의 조건이다.
- 첫 온세일 전에는 이 칸을 '출시 뒤 확인'으로 둔다. R2까지 표본 검토를 끝내지 못하면 '판정 보류'로 두고 `BehaviorScore`는 그림자에 남는다(ADR-0174 '되돌릴 조건').

## 11. 관측 백엔드 비교의 비용 환산(wbs 4.8.2, 추천 적용 2026-10-28, 기술 검토 중간-023)

세 후보(직접 운영, AWS 관리형 AMP·AMG, Datadog)의 연간 총비용(ADR-0067·0068의 판정 규칙 R2)을 같은 방법으로 낸다. 제어 입력과 실시간 숫자는 어느 후보든 클러스터 안 Prometheus가 맡으므로(ADR-0068 결정 2), 후보에 자료를 실제로 보내야만 알 수 있는 것은 둘뿐이다. 나머지는 계산한다.

### 11.1 두 단계

| 단계 | 하는 일 | 보내는가 |
| --- | --- | --- |
| ① 계산 | 로컬 측정에서 센 양(§11.2)을 4.8.1 비용 추정의 규모로 외삽하고(표시는 '외삽', ADR-0057), 가격표(§11.3)를 곱해 후보별 연간 서비스 요금을 낸다 | 보내지 않는다 |
| ② 보내기 | Datadog Watchdog·이상 탐지 힌트 비교(§8, 14일 체험)와 AMP·AMG의 장기 조회 동작(쿼리 기간 95일, QueryMetrics 초당 300건)만 확인한다 | 샘플 예산(§11.4) 안에서만 보낸다 |

### 11.2 로컬에서 세는 양

| 양 | 세는 곳 | 외삽 |
| --- | --- | --- |
| 활성 시계열 수 | Prometheus `prometheus_tsdb_head_series` | 서비스·파드 수에 비례 [가정] |
| 초당 수집 샘플 | `rate(prometheus_tsdb_head_samples_appended_total[5m])` | 시계열 수 ÷ 긁기 간격(5초 작업·15초 작업을 따로) |
| 로그 양(GB/일) | Loki `loki_distributor_bytes_received_total` | 요청 수에 비례 |
| 요청 기록 양(GB/일, span/초) | Tempo `tempo_distributor_bytes_received_total`, `tempo_distributor_spans_received_total`(꼬리 표본 뒤) | 요청 수 × 표본 비율 |
| 서버(노드) 수 | kube-state-metrics `kube_node_info`의 개수 | 4.8.1의 피크 노드 추정 칸 |
| 화면 사용자 수 | 운영자·엔지니어 수 [가정] | — |

### 11.3 가격표(조회 날짜를 함께 적는다)

| 후보 | 항목 | 값(조회 날짜) |
| --- | --- | --- |
| AMP(서울) | 수집 샘플 | 월 4천만 무료, 20억까지 1천만 샘플당 0.90달러, 다음 2,500억까지 1천만 샘플당 0.35달러(AWS 가격 목록 2026-10-14 게시본) |
| AMP(서울) | 저장·조회 | 저장은 10GB를 넘는 몫 GB·월 0.03달러, 조회는 10억 샘플당 0.10달러(처음 2천억 무료, 같은 게시본) |
| AMG | 사용자 | 작업 공간별 활성 Editor 월 9달러, Viewer 월 5달러(2026-10-20, ADR-0068) |
| Datadog(미국 사이트 정가, 연간 계약) | 서버·APM·지표·로그 | 인프라 Pro 서버당 월 15달러, APM Enterprise 40달러, 지표 조합은 서버당 100개 포함·초과 100개당 5달러, 로그 수집 GB당 0.10달러 등(2026-10-19, ADR-0067). 에이전트가 긁은 지표는 사용자 정의 지표로 센다(ADR-0076) |
| AWS X-Ray(서울, 요청 기록 저장소 비교 (다), docs/observability.md §1) | 저장·조회 | 저장한 trace 100만 건당 5달러, 조회·스캔 100만 건당 0.50달러, 월 10만 건·100만 건 무료(AWS 가격 목록 2026-09-11 게시본) |
| S3 Standard(서울) | 직접 운영의 객체 저장소 | GB·월 0.025달러(처음 50TB, AWS 가격 목록 2026-10-15 게시본) |

### 11.4 보내기의 샘플 예산과 비용 경보

- 보내기 전에 예산을 계산한다. 보낼 샘플 = 고른 시계열 수 × 86,400 ÷ 긁기 간격(초) × 보낼 날수다. 합이 4천만(AMP 무료 등급)을 넘지 않게 `write_relabel_configs`로 시계열을 고른다. 예: 2천 개를 15초마다 3일 보내면 약 3,456만 샘플이다.
- 왜 줄이는가: 활성 시계열 10만 개 [가정]를 15초마다 그대로 보내면 두 시간이 안 돼 무료 등급을 넘고, 하루면 약 5.76억 샘플이라 약 48달러다. 소유자 지출 상한(5만 원)을 하루 만에 넘을 수 있다.
- 보내는 것: 장기 조회를 볼 집계 시계열(`agg5m` 대상의 일부)과 서비스 하나의 SLI 히스토그램 [가정].
- AWS Budgets 경보를 건다(경보만 쓰는 예산은 무료, docs/infra.md §11). 실제 비용이 0달러를 넘거나 예측 비용이 1달러를 넘으면 알리고 [가정], 울리면 원격 쓰기를 끈다.
- Datadog은 14일 체험 안에서 끝내고, 체험이 끝나기 전에 에이전트와 연동을 지운다(ADR-0067 상태 줄).

### 11.5 직접 운영의 운영 시간: 연간 추정식과 민감도

- 로컬에서 몇 주 동안 잰 설치·대응 시간을 그대로 R2에 넣지 않는다. 1년 운영의 판 올림·용량 증설·실제 장애를 대표하지 못해 직접 운영 비용이 작게 나오고, 판정이 직접 운영 쪽으로 기울기 때문이다.
- 연간 운영 시간 = Σ부품(1년 판 올림 횟수 × 1회 시간) + Σ부품(1년 용량 조정 횟수 × 1회 시간) + 1년 장애 대응 시간 + 주마다 점검 시간 × 52 [가정].
  - 판 올림 횟수는 부품 저장소의 최근 12개월 릴리스 수(GitHub 릴리스, 조회 날짜)로 잡는다. 보안 패치만 따라가기로 하면 그 몫만 센다.
  - 1회 시간은 4.1.1부터 남긴 로컬 설치·판 올림 기록(ADR-0067 결정 5 ③)을 표본으로 쓴다. 표본이지 1년 값이 아니다.
  - 장애 대응 시간은 출처가 있으면 출처를 달고, 없으면 [가정]으로 둔다.
  - 시간 단가는 4.1.1 착수 때 출처를 달아 고정한 값이다(ADR-0067 R2).
- 민감도 표: 운영 시간을 0.5배·1배·1.5배로 넣은 R2 순위 셋을 함께 적는다. 판정은 1배 값으로 한다. 다만 직접 운영을 고르려면 1.5배에서도 1위여야 한다. 지금 구성을 유지하는 10% 규칙(ADR-0068 결정 5)도 1.5배 값으로 본다. 1.5배에서 순위가 바뀌면 '운영 시간에 민감'으로 표시하고 1.5배에서 1위인 후보를 고른다.
- 기록: `backend_cost.csv`는 `candidate,item,quantity,unit,unit_price_usd,price_date,annual_usd,source` 열이다. manifest에는 R2 순위 셋(`backend_r2`: 0.5배·1배·1.5배)과 판정을 남긴다.
