# 갈래 6 — 분석 적재 빠른 길

- **독자와 용도**: 갈래 6(병렬 세션, ADR-0373 결정 3·4)이 다음에 할 일과 진행 로그를 적는다. 공용 턴 규칙과 미해결은 [docs/PROGRESS.md](../PROGRESS.md), 기능의 차례와 상태는 [docs/BUILD_ORDER.md](../BUILD_ORDER.md) '기능 단위 계획' 표가 정본이다.
- **맡은 일**: 파트너 콘솔과 관제 콘솔이 읽는 데이터의 적재 파이프라인(소유자 2026-11-23). 차례 F-04-1 → F-04-3 → F-04-4 → F-04-5 → F-04-6 → F-04-7 → F-04-8. 포렌식(F-04-9~F-04-19, `inv`·조사·연구 내보내기)은 동결이라 하지 않는다.
- **절차**: 빠른 길 — 시험 먼저·역할 나누기 없이 구현과 시험을 함께 하고, 완료 정의의 동작을 돌려 보인 명령과 숫자를 `docs/review/plans/<기능 ID>.md`에 남긴다.

## 다음

- F-04-3(analytics-ingest): 갈래 1의 F-04-2(분석 이벤트 계약·telemetry 토픽)가 develop에 들어온 뒤 시작한다.

## 진행 로그

- 2026-11-23 F-04-1(B, OPS-160, R-791): 작업자 `services/ops-rt`(거래·텔레메트리 토픽 일곱 → ClickHouse `rt` 원시 표 다섯, 쓰기 뒤 커밋, 버리는 그룹 다시 채우기)·`services/rt-pulse`(1초 심장 박동), `data/clickhouse/rt` 표·매개변수 뷰 셋, ops-svc `realtime-table` 모듈(회차마다 0.5초 조회·신선도 두 길·Degraded 3분/5분·거래 사건 끊김 60초·파트너 `live-snapshot` 1분 계산, gw-partner를 ops-svc로), 관제 위젯 키 `rt-sales.summary`와 판매 중 탭 '구역별 잔여석' 실제 값. 통합 ops-rt 5/5(ST-T1 원시 결제 4,700건 → 판매 금액 3,000,000·판매 좌석 3,000 정답과 같음, ST-T4 ClickHouse 30초 멈춤 뒤 500/500, ST-T2 끈 파티션 7.5초·나머지 1.4초), ops-svc 3/3, 장부 10/10 자동 시험. 계획 docs/review/plans/F-04-1.md.
