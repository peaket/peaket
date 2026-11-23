# 갈래 6 — 분석 적재 빠른 길

- **독자와 용도**: 갈래 6(병렬 세션, ADR-0373 결정 3·4)이 다음에 할 일과 진행 로그를 적는다. 공용 턴 규칙과 미해결은 [docs/PROGRESS.md](../PROGRESS.md), 기능의 차례와 상태는 [docs/BUILD_ORDER.md](../BUILD_ORDER.md) '기능 단위 계획' 표가 정본이다.
- **맡은 일**: 파트너 콘솔과 관제 콘솔이 읽는 데이터의 적재 파이프라인(소유자 2026-11-23). 차례 F-04-1 → F-04-3 → F-04-4 → F-04-5 → F-04-6 → F-04-7 → F-04-8. 포렌식(F-04-9~F-04-19, `inv`·조사·연구 내보내기)은 동결이라 하지 않는다.
- **절차**: 빠른 길 — 시험 먼저·역할 나누기 없이 구현과 시험을 함께 하고, 완료 정의의 동작을 돌려 보인 명령과 숫자를 `docs/review/plans/<기능 ID>.md`에 남긴다.

## 다음

- F-04-7(공연 리포트·결정 규칙·파트너 판매 요약) → F-04-8. F-04-6은 끝났다.

## 진행 로그

- 2026-11-23 F-04-1(B, OPS-160, R-791): 작업자 `services/ops-rt`(거래·텔레메트리 토픽 일곱 → ClickHouse `rt` 원시 표 다섯, 쓰기 뒤 커밋, 버리는 그룹 다시 채우기)·`services/rt-pulse`(1초 심장 박동), `data/clickhouse/rt` 표·매개변수 뷰 셋, ops-svc `realtime-table` 모듈(회차마다 0.5초 조회·신선도 두 길·Degraded 3분/5분·거래 사건 끊김 60초·파트너 `live-snapshot` 1분 계산, gw-partner를 ops-svc로), 관제 위젯 키 `rt-sales.summary`와 판매 중 탭 '구역별 잔여석' 실제 값. 통합 ops-rt 5/5(ST-T1 원시 결제 4,700건 → 판매 금액 3,000,000·판매 좌석 3,000 정답과 같음, ST-T4 ClickHouse 30초 멈춤 뒤 500/500, ST-T2 끈 파티션 7.5초·나머지 1.4초), ops-svc 3/3, 장부 10/10 자동 시험. 계획 docs/review/plans/F-04-1.md.
- 2026-11-23 F-04-3(B, OPS-200·OPS-205 일부, A-T21·A-T22·ST-T22, R-792): 작업자 `services/analytics-ingest`(10토픽, 회차 가명 HMAC-SHA256·KMS GenerateMac/로컬 키, 키 실패면 쓰지 않고 다시 시도, 허용 목록 = 계약 판 − 조사 칸 일곱 − actor, 금지 칸 버림·셈, 쓰기 뒤 커밋, 거절 위치, 커버리지 위치 표·대조 명령, 다시 적재)·`data/clickhouse/bronze` 15표. 통합 4/4(조사 값 0건·두 회차 가명 다름, 강제 종료 뒤 2,000/2,000·커버리지 빈 곳 0, 키 실패 동안 0행, 다시 적재 그대로). 포렌식 몫은 동결 빈칸. 계획 docs/review/plans/F-04-3.md.
- 2026-11-23 F-04-20(B, OPS-190 일부, A-T26 ④, R-797, 감독 결정으로 F-04-2에서 나눔): queue-svc 관제 1초 대기 집계 `QueueAggregate`(진입·빠진 번호·입장 확정·곧 입장 응답을 세는 줄만, 1초마다 telemetry.queue). 막힌 생산자에서 진입 201·입장 확정 200(두 요청 150~169ms), 세기 한 번 0.6µs, 단위 703/703, 통합 entry-store의 Redis 마감 흔들림은 develop 판과 번갈아 돌려 흔들림으로 판정. 계획 docs/review/plans/F-04-20.md.
- 2026-11-23 F-04-4(B, OPS-220, A-T18·A-T21, R-801): `data/` dbt 프로젝트 `analytics` — staging 12·실버 10·골드 사실 14(F12는 F-04-5)·차원 12 표, run_id 판과 `gold.current_run` 바꾸기, 설치는 PyPI 해시 잠금(dbt-core 1.12.7·dbt-clickhouse 1.10.3, 소유자 결정). 실제 ClickHouse 통합 2/2: F15 판매 500,000 − 되돌림 100,000 = F11 판매 금액 400,000, 판매 좌석 1, 재실행 멱등·현재 판 바꾸기. 장부 빈칸 37(막지 않음). 계획 docs/review/plans/F-04-4.md.
- 2026-11-23 F-04-5(B, OPS-230 일부, A-T11·A-T20 ③·A-T25, R-802): 지표 사전 metrics.yml·결정 규칙 rules.yml 18행·F12 규칙 판정(95% Wilson 구간·보류 사유 넷)·같은 규모 기준선·품질 검사·현재 판 지표 뷰 여섯. 실제 ClickHouse 통합 2/2: 전환율 950/1,200 = 0.7917, 구간 [0.7678, 0.8137] → 걸림, 기준선 n=11 사분위, 입장 900 → 표본 부족, 바깥 품질 실패 → 보류, R0 → 미확정·매진 소요 잠정. 장르 랭킹 동결. 계획 docs/review/plans/F-04-5.md.
- 2026-11-24 F-04-6(B, OPS-240, A-T7·A-T9·A-T18, R-803): 마감 실행기 `services/close-runner`(R0~R3 예정·할 일 고르기·두 번에 나눈 빌드·20분 상한·`gold.close_run_log`·R3 정산서 대조·실패해도 판 바꾸기), `data/macros/close.sql`(R2 판 온세일 동결·앞 판 날짜별·회차 차원 잇기, 새 `run_id` 별칭이 WHERE를 가리는 결함을 `src.run_id`로 고침), `data/models/gold` F1~F8·F11·dim_event·dim_section·dim_tier, `dim_date` 공휴일, 기준 자료 파일 싣기·`bronze.brz_intake_log`. 실제 ClickHouse 통합 1/1: L이 R0→R1(실패 주입 뒤 다시)→R2→매일(F15 3석·F2 2석 동결)→90일 지움→앞 판 잇기→R3 정산서 0원 차이·판매 좌석 3·판매 금액 400,000, M R3 1원 차이→품질 FAIL. 회귀 F-04-4 2/2·F-04-5 2/2, 유닛 9/9·타입 검사·lint·dbt parse. 장부 빈칸 47(막지 않음). 계획 docs/review/plans/F-04-6.md.
