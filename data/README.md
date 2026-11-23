# data/

분석 저장소의 ClickHouse 이전 파일과 dbt 모델(브론즈 → 실버 → 골드)을 둔다.

- 무엇을 어느 팀이 맡는지: [docs/architecture.md](../docs/architecture.md) §10, 분석 설계: [docs/features/analytics.md](../docs/features/analytics.md)
- `clickhouse/rt/`: 관제 실시간 표(F-04-1, `services/ops-rt`가 이전 실행기로 만든다)
- `clickhouse/bronze/`: 분석 브론즈(F-04-3, `services/analytics-ingest`가 이전 실행기로 만든다)
- dbt 프로젝트(F-04-4, wbs 4.3.5): `dbt_project.yml`, `models/`(staging·silver·gold), `macros/`, `seeds/`(고정 차원), `tests/`(A-T21 등), `tests_int/`(실제 ClickHouse 통합 시험)
- 지표 사전·결정 규칙(F-04-5, analytics §6·§7): `models/metrics/metrics.yml`(지표 사전)·`rules.yml`(결정 규칙), 판마다 쌓는 `metric_value`·`quality_check`·`fct_rule_check`(F12)와 현재 판만 읽는 지표 뷰 `mtr_*`. 마감 실행기가 바깥 품질 검사 실패를 `--vars '{quality_failed: [<지표 코드>]}'`로 넘긴다
- 마감 실행기(F-04-6, analytics §3.2·§4·§7): `services/close-runner`가 R0~R3 예정을 찾아 `--vars`로 회차·판·단계를 넘기고, R3이면 정산서와 F15·F8을 대조한 뒤 현재 판을 바꾼다. `macros/close.sql`은 R2 판의 온세일 사실(`onsale_run`)과 앞 판의 오래된 날짜별 사실·차원(`carry_run`·`carry_before`)을 잇는다. 기준 자료 파일은 `ref-event/`·`ref-seat-map/`에서 실어 `bronze.brz_intake_log`에 남긴다
- 공연 리포트·파트너 판매 요약(F-04-7, analytics §8): `models/metrics/mtr_event_report.sql`(현재 판의 지표 카드·결정 규칙 판정·품질)과 `models/metrics/partner_sales_gold.sql`(R3 현재 판의 판매량·매진 시각·등급별 판매·환불·판매 곡선, 작은 칸 합치기). ops-svc 리포트 생성기와 파트너 API가 읽는다

## dbt 실행

의존성은 해시가 든 잠금 파일로만 설치한다(docs/devops.md §4.4).

```bash
cd data
uv sync --locked
# 연결: PEAKET_ANALYTICS_CLICKHOUSE_HOST·_PORT·_USER·_PASSWORD (운영 사용자 an_transform)
PYTHONUTF8=1 .venv/Scripts/dbt build --profiles-dir . --vars '{event_id: <회차 UUID>, run_id: <판 UUID>, stage: R0}'
PYTHONUTF8=1 .venv/Scripts/dbt run-operation swap_current_run --profiles-dir . --args '{event_id: <회차>, run_id: <판>}'
# 통합 시험(Docker 잠금을 잡은 뒤, 먼저 `pnpm --filter @peaket/close-runner build`)
PYTHONUTF8=1 .venv/Scripts/python -m unittest tests_int.test_dbt_models tests_int.test_metrics_rules tests_int.test_close_runner -v
```

마감 실행기 한 번(데모 시계)은 저장소 뿌리에서 다음과 같이 돌린다. 기준 자료 폴더가 있으면 먼저 싣는다.

```bash
PEAKET_ANALYTICS_CLICKHOUSE_HOST=127.0.0.1 PEAKET_ANALYTICS_CLICKHOUSE_USER=... PEAKET_ANALYTICS_CLICKHOUSE_PASSWORD=... \
PEAKET_DBT_BIN=data/.venv/Scripts/dbt.exe PEAKET_DBT_PROJECT_DIR=data PEAKET_CLOSE_INTAKE_DIR=<수집 폴더> \
node services/close-runner/dist/main.js run-once --now 2026-03-06T03:40:00Z
```

Windows는 `PYTHONUTF8=1`이 있어야 한글이 든 파일을 읽는다. 리눅스는 `.venv/bin/dbt`다.
