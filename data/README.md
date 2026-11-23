# data/

분석 저장소의 ClickHouse 이전 파일과 dbt 모델(브론즈 → 실버 → 골드)을 둔다.

- 무엇을 어느 팀이 맡는지: [docs/architecture.md](../docs/architecture.md) §10, 분석 설계: [docs/features/analytics.md](../docs/features/analytics.md)
- `clickhouse/rt/`: 관제 실시간 표(F-04-1, `services/ops-rt`가 이전 실행기로 만든다)
- `clickhouse/bronze/`: 분석 브론즈(F-04-3, `services/analytics-ingest`가 이전 실행기로 만든다)
- dbt 프로젝트(F-04-4, wbs 4.3.5): `dbt_project.yml`, `models/`(staging·silver·gold), `macros/`, `seeds/`(고정 차원), `tests/`(A-T21 등), `tests_int/`(실제 ClickHouse 통합 시험)

## dbt 실행

의존성은 해시가 든 잠금 파일로만 설치한다(docs/devops.md §4.4).

```bash
cd data
uv sync --locked
# 연결: PEAKET_ANALYTICS_CLICKHOUSE_HOST·_PORT·_USER·_PASSWORD (운영 사용자 an_transform)
PYTHONUTF8=1 .venv/Scripts/dbt build --profiles-dir . --vars '{event_id: <회차 UUID>, run_id: <판 UUID>, stage: R0}'
PYTHONUTF8=1 .venv/Scripts/dbt run-operation swap_current_run --profiles-dir . --args '{event_id: <회차>, run_id: <판>}'
# 통합 시험(Docker 잠금을 잡은 뒤)
PYTHONUTF8=1 .venv/Scripts/python -m unittest tests_int.test_dbt_models -v
```

Windows는 `PYTHONUTF8=1`이 있어야 한글이 든 파일을 읽는다. 리눅스는 `.venv/bin/dbt`다.
