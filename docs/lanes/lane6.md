# 갈래 6 — 분석 적재 빠른 길

- **독자와 용도**: 갈래 6(병렬 세션, ADR-0373 결정 3·4)이 다음에 할 일과 진행 로그를 적는다. 공용 턴 규칙과 미해결은 [docs/PROGRESS.md](../PROGRESS.md), 기능의 차례와 상태는 [docs/BUILD_ORDER.md](../BUILD_ORDER.md) '기능 단위 계획' 표가 정본이다.
- **맡은 일**: 파트너 콘솔과 관제 콘솔이 읽는 데이터의 적재 파이프라인(소유자 2026-11-23). 차례 F-04-1 → F-04-3 → F-04-4 → F-04-5 → F-04-6 → F-04-7 → F-04-8. 포렌식(F-04-9~F-04-19, `inv`·조사·연구 내보내기)은 동결이라 하지 않는다.
- **절차**: 빠른 길 — 시험 먼저·역할 나누기 없이 구현과 시험을 함께 하고, 완료 정의의 동작을 돌려 보인 명령과 숫자를 `docs/review/plans/<기능 ID>.md`에 남긴다.

## 다음

- F-04-20(queue-svc `QueueAggregate`, 감독 결정) → F-04-4(dbt, 소유자 결정 '받아서 정본대로') → F-04-7 → F-04-5·F-04-6 필요한 몫 → F-04-8.

## 진행 로그

- 2026-11-23 F-04-1(B, OPS-160, R-791): 작업자 `services/ops-rt`(거래·텔레메트리 토픽 일곱 → ClickHouse `rt` 원시 표 다섯, 쓰기 뒤 커밋, 버리는 그룹 다시 채우기)·`services/rt-pulse`(1초 심장 박동), `data/clickhouse/rt` 표·매개변수 뷰 셋, ops-svc `realtime-table` 모듈(회차마다 0.5초 조회·신선도 두 길·Degraded 3분/5분·거래 사건 끊김 60초·파트너 `live-snapshot` 1분 계산, gw-partner를 ops-svc로), 관제 위젯 키 `rt-sales.summary`와 판매 중 탭 '구역별 잔여석' 실제 값. 통합 ops-rt 5/5(ST-T1 원시 결제 4,700건 → 판매 금액 3,000,000·판매 좌석 3,000 정답과 같음, ST-T4 ClickHouse 30초 멈춤 뒤 500/500, ST-T2 끈 파티션 7.5초·나머지 1.4초), ops-svc 3/3, 장부 10/10 자동 시험. 계획 docs/review/plans/F-04-1.md.
- 2026-11-23 F-04-3(B, OPS-200·OPS-205 일부, A-T21·A-T22·ST-T22, R-792): 작업자 `services/analytics-ingest`(10토픽, 회차 가명 HMAC-SHA256·KMS GenerateMac/로컬 키, 키 실패면 쓰지 않고 다시 시도, 허용 목록 = 계약 판 − 조사 칸 일곱 − actor, 금지 칸 버림·셈, 쓰기 뒤 커밋, 거절 위치, 커버리지 위치 표·대조 명령, 다시 적재)·`data/clickhouse/bronze` 15표. 통합 4/4(조사 값 0건·두 회차 가명 다름, 강제 종료 뒤 2,000/2,000·커버리지 빈 곳 0, 키 실패 동안 0행, 다시 적재 그대로). 포렌식 몫은 동결 빈칸. 계획 docs/review/plans/F-04-3.md.
- 2026-11-23 F-04-20(B, OPS-190 일부, A-T26 ④, R-797, 감독 결정으로 F-04-2에서 나눔): queue-svc 관제 1초 대기 집계 `QueueAggregate`(진입·빠진 번호·입장 확정·곧 입장 응답을 세는 줄만, 1초마다 telemetry.queue). 막힌 생산자에서 진입 201·입장 확정 200(두 요청 150~169ms), 세기 한 번 0.6µs, 단위 703/703, 통합 entry-store의 Redis 마감 흔들림은 develop 판과 번갈아 돌려 흔들림으로 판정. 계획 docs/review/plans/F-04-20.md.
- 2026-11-23 F-04-4(B, OPS-220, A-T18·A-T21, R-801): `data/` dbt 프로젝트 `analytics` — staging 12·실버 10·골드 사실 14(F12는 F-04-5)·차원 12 표, run_id 판과 `gold.current_run` 바꾸기, 설치는 PyPI 해시 잠금(dbt-core 1.12.7·dbt-clickhouse 1.10.3, 소유자 결정). 실제 ClickHouse 통합 2/2: F15 판매 500,000 − 되돌림 100,000 = F11 판매 금액 400,000, 판매 좌석 1, 재실행 멱등·현재 판 바꾸기. 장부 빈칸 37(막지 않음). 계획 docs/review/plans/F-04-4.md.
