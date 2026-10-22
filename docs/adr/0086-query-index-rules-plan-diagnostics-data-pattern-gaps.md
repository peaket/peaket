# ADR-0086: 쿼리·인덱스 규칙과 실행 계획 진단을 정하고, 데이터 설계 패턴 점검에서 찾은 빈칸을 채운다(2026-10-22)

- **상태**: 채택 (2026-10-22. 소유자가 두 가지를 점검해 달라고 했다. 하나는 지금 DB 설계에 정규화·역정규화, 공통 코드, 계층구조, 데이터 변경 이력, 소프트 삭제, 통계 표, 상속관계, 동적 설계(EAV), JSON 설계가 되어 있는지다. 다른 하나는 MySQL 이름으로 된 실행 계획·인덱스 주제를 Aurora PostgreSQL·ClickHouse·Redis에서 어떻게 다루는지다. 주제는 EXPLAIN·ANALYZE, 풀 테이블 스캔, 복합 인덱스, filesort와 조기 종료, ICP·커버링·스킵 스캔·인덱스 머지·함수 인덱스·인덱스 숨기기·인덱스 정렬·MRR·옵티마이저 힌트, 히스토그램, 조인, 정렬, 페이징, 그룹핑, 스트리밍 집계와 사전 집계 표다. 점검 보고를 본 뒤 "보고서 권고를 추천대로 반영해 주세요. 새 ADR 1건과 data.md·devops·streaming·analytics·offline-gate 문서, ADR-0083 상태 줄을 고쳐 주세요."라고 했다. 결정 1은 소유자 승인이고, 결정 2~11의 값과 세부는 추천 적용이다. 추천 적용은 소유자가 방향을 승인하고 세부를 맡긴 부분에서 제안해 적용한 값으로, 바꾸고 싶으면 언제든 바꾼다. 외부 사실은 2026-10-22에 공식 문서·변경 기록·소스 원문으로 확인했다)
- **관련**: ADR-0014(Soft Hold·Hard Sale), ADR-0028(샤딩 배제·월 파티션·PgBouncer), ADR-0037(Drizzle), ADR-0051(현장 입장), ADR-0052(분석 저장소), ADR-0053(감사 체인), ADR-0054(마이그레이션 규칙), ADR-0063(장르 목록), ADR-0064(판매 종료), ADR-0066(CS 처리함·후기 신고), ADR-0067(쿼리 통계), ADR-0070(시간 초과 기본값), ADR-0071·0072(Flink·실시간 표), ADR-0081(페이지 나누기), ADR-0083(PostgreSQL 유지·파티션 규칙), docs/data.md §2·§3·§4·§5·§6, docs/devops.md §7.2·§7.3, docs/streaming.md §2.1·§4.3·§4.4, docs/features/analytics.md §4.1·§4.2·§5.5, docs/features/offline-gate.md §6.3, docs/observability.md §8, docs/infra.md §1

## 맥락

- **용어**: 인덱스는 책 뒤의 찾아보기처럼 행을 빨리 찾게 하는 구조다. 실행 계획은 DB가 쿼리를 어떤 순서와 방법으로 처리할지 세운 계획이다. 파티션은 큰 표를 기간 등으로 나눈 부분이다. 부분 인덱스는 조건에 맞는 행만 담는 인덱스이고, 커버링 인덱스는 쿼리에 필요한 칸을 모두 담아 표를 다시 읽지 않게 하는 인덱스다.
- **점검에서 찾은 빈칸(정본 직접 확인)**: 지금 정본의 인덱스 표준은 넷뿐이다(docs/data.md §5). 나머지 빈칸을 무게 순으로 적는다.
  - **돈·정합성**
    - 취소 기록 `order_cancellation`에 '진행 중인 취소는 티켓당 하나'라는 유일 제약이 없다. 회차 취소 일괄 환불 작업이 다시 시작되거나 두 기기에서 같은 티켓을 취소하면 취소 행이 둘 생길 수 있다. 결제사 멱등키(같은 요청을 한 번만 처리하게 하는 열쇠)가 `cancel-{cancellationId}`라서 취소 행이 다르면 키도 다르다.
    - 결제 표 `payment`에 회차 ID와 시각 칸이 없다. 정산서는 회차·결제사별 승인 금액 합이고(settlement §4.1), 결제 사건 `PaymentEvent`는 `eventId`를 싣는다. 그런데 결제 DB는 주문 DB와 조인할 수 없다.
    - 월 파티션을 떼어 낼 때 그 행을 가리키는 자식 행이 남아 있으면 오류가 난다. 자식 표를 같은 범위로 나누는 규칙이 없다.
    - 스캐너 변경 일련번호(`scanner_change.seq`)와 감사 체인 번호(`audit_chain.seq`)를 매기는 방법이 없다. DB 시퀀스로 매기면 번호를 먼저 받은 트랜잭션이 나중에 커밋될 수 있다. 그러면 '일련번호로 이어 받으니 빠짐이 없다'(offline-gate §6.3)가 깨진다.
  - **성능·운영**: 파티션 부모 표의 통계, 파티션 표의 인덱스 만들기, 부분 인덱스와 바인드 변수, PgBouncer(DB 연결을 나눠 쓰게 하는 연결 풀)와 prepared statement, `scan_event`를 회차마다 나눌 때의 파티션 수, 커지는 원장 표의 보존 기간(`seat_hold`·`order_event`·`payment_event`·`scanner_change`·`notification_delivery`), 느린 쿼리 계획 로그의 개인정보, 로비 큰 집합 읽기와 큰 키 만료, 엔진 판이 정해지지 않음, 분석 마감 실행이 도중에 실패할 때의 골드 표 상태.
  - **데이터 설계 패턴**: 상태·종류 칸의 허용 값 검사가 없다. 한 표에 여러 종류를 담는 표의 종류별 필수 칸 검사가 없다. 2인 승인자 목록을 JSON 배열에 둔다. 바뀌는 기준 정보의 판본 이력이 없다. `order_item` 칸이 정해져 있지 않다. 기본 키가 없는 표가 있다(`purchase_quota`·`seat_hold`·`seat_sale`·`order_event`). 같은 후기의 신고가 CS 처리함 건 둘로 생길 수 있다. CS 처리함 목록의 정렬 규칙이 없다.
  - **잘된 점(그대로 둔다)**: 오버셀(같은 좌석이 두 사람에게 팔리는 일)과 중복 결제의 마지막 방어선이 DB 제약이다. 서비스마다 논리 DB를 나눠 큰 조인이 없다. 분석 골드는 킴볼 방식(한 행의 뜻을 먼저 정하고, 비율 대신 분자·분모를 저장)이다. JSON은 통째로 읽고 쓰는 문서에만 쓰고, PostgreSQL에 EAV(속성 이름과 값을 행으로 늘어놓는 표)가 없다. 목록은 커서(마지막으로 본 행 다음부터 읽는 방식)가 기본이다.
- **확인한 외부 사실(2026-10-22, 원문)**
  - **PostgreSQL 18 문서**
    - 실행 계획: `EXPLAIN ANALYZE`에 BUFFERS(읽은 페이지 수)가 자동으로 붙고, 인덱스 스캔 노드에 'Index Searches'(인덱스를 몇 번 찾아 들어갔나)가 나온다. `EXPLAIN (GENERIC_PLAN)`으로 `$1`이 든 문장의 일반 계획을 본다. 노드의 시간과 행 수는 반복 한 번의 평균이고(전체는 `loops`를 곱한다), Buffers와 Index Searches는 반복의 합계다.
    - 인덱스: 복합 인덱스는 앞 열의 등호 조건과 첫 범위 조건이 읽는 범위를 줄인다. 그 오른쪽 조건은 인덱스 안에서 검사해 표 방문을 줄인다. 18부터 B-tree 스킵 스캔이 있다. `INCLUDE` 커버링 인덱스는 가시성 맵(페이지의 모든 행이 모두에게 보이는지 적은 비트)이 켜진 페이지만 표를 건너뛴다. 인덱스 여러 개는 비트맵 AND·OR로 합치고, 표 행은 물리 순서로 읽는다. 식 인덱스의 함수는 IMMUTABLE이어야 한다. ORDER BY와 같은 순서의 인덱스가 있으면 LIMIT n개만 읽고 멈춘다. `ALTER INDEX`에는 인덱스를 숨기는 형식이 없다.
    - 부분 인덱스는 계획을 세울 때 쿼리 조건과 맞춰 본다. 그래서 매개변수(`$1`)로 쓴 조건은 부분 인덱스를 쓰지 못한다.
    - 통계: ANALYZE가 열마다 가장 흔한 값 목록과 히스토그램 경계를 모은다(기본 100칸). 열 사이 관계는 `CREATE STATISTICS`(ndistinct·dependencies·mcv)로 모은다. 자동 청소는 파티션 부모 표의 ANALYZE를 하지 않는다. `pg_upgrade`는 통계를 유지하지만 확장 통계는 유지하지 않는다.
    - 파티션: 부모 표에는 `CREATE INDEX CONCURRENTLY`를 쓸 수 없다. 대신 파티션마다 동시에 만들고 부모 인덱스를 만들어 붙인다(부모 인덱스 만들기는 메타데이터만 바꾼다). `REINDEX`는 파티션마다 따로 트랜잭션으로 돈다. 남는 파티션이 적도록 가지치기가 될 때 수천 개까지 무난하고, 남는 파티션이 많을수록 계획 시간과 메모리가 는다.
    - 설정 기본값: prepared statement는 처음 5번 맞춤 계획을 쓴 뒤 일반 계획과 비교한다(`plan_cache_mode`로 바꾼다). `work_mem`은 4MB, `hash_mem_multiplier`는 2.0, 파티션끼리 조인·집계는 꺼짐, `log_temp_files`·`log_lock_waits`·`track_io_timing`은 꺼짐이다. `auto_explain`은 `log_min_duration` -1(끔), `log_analyze` 꺼짐, `log_parameter_max_length` -1(매개변수 값을 전부 기록), `sample_rate` 1이다. `log_timing`은 시계를 자주 읽어 오버헤드가 크다.
    - 그 밖: 외래 키를 만들어도 참조하는 쪽 열에 인덱스가 자동으로 생기지 않는다. enum 타입에서 있는 값은 뺄 수 없다. 기간 키 `UNIQUE (…, 칸 WITHOUT OVERLAPS)`는 범위 타입이 아닌 칸을 함께 쓰려면 `btree_gist` 확장이 필요하다. 행 값 비교는 왼쪽부터 처음 다른 칸에서 결과가 정해지고, NULL이 섞이면 결과가 NULL이다. 생성 열의 기본은 가상(읽을 때 계산)이다.
  - **PostgreSQL 18 소스(REL_18_STABLE)**: 파티션을 떼어 낼 때 그 범위를 가리키는 행이 남아 있으면 오류다(`tablecmds.c` `ATDetachCheckNoForeignKeyRefs`). 가상 생성 열에는 인덱스를 만들 수 없다(`indexcmds.c`). `timestamptz - interval`은 STABLE이라 식 인덱스에 쓸 수 없다(`pg_proc.dat`).
  - **Aurora PostgreSQL**: 18.3(2026-06-11), 18.4(2026-08-21), 18.6(2026-09-29), 18.6.1(2026-10-15)이 나왔다. 18.3~18.6에서 `pg_hint_plan` 1.8.0, `hypopg` 1.4.2, `pg_bigm` 1.2_20250903, `apg_plan_mgmt` 3.0, `auto_explain`, `pg_stat_statements` 1.11, `btree_gist`, `amcheck` 1.4를 지원한다. Aurora 쿼리 계획 관리는 알려진 좋은 계획만 쓰게 고정하고, 쓰지 않는 인덱스 찾기와 인덱스를 만들거나 지울 때의 영향 평가를 돕는다.
  - **PgBouncer·Drizzle**: 트랜잭션 풀링에서 프로토콜 수준 prepared statement는 `max_prepared_statements`가 0이 아닐 때만 된다(문서 기본값 200). 열 구조를 바꾸는 마이그레이션 뒤에는 'cached plan must not change result type' 오류가 날 수 있어 관리 콘솔에서 `RECONNECT`를 한다. Drizzle은 SQL 안의 동적 값을 `$1` 같은 자리표시자로 바꾼다.
  - **ClickHouse**: 보안 업데이트를 받는 줄은 26.9, 26.8 LTS(2026-08-27), 26.7, 26.3 LTS(2026-03-26)다. LTS는 1년 지원한다. 26.2부터 삽입 중복 판정이 삽입 한 건 단위다. 26.3 LTS부터 비동기 삽입이 기본으로 켜졌다. 26.6에 내림차순 정렬 키 상시 지원과 가상 스킵 인덱스(`EXPLAIN WHATIF`)가 생겼고 모든 삽입의 중복 제거가 기본으로 켜졌다. 26.7에 `EXPLAIN ANALYZE`가, 26.8에 INSERT 때 열 통계 만들기(25GiB 이하 표)가 생겼다. `force_primary_key = 1`이면 기본 키를 쓸 조건이 없는 쿼리를 오류로 막는다. FINAL과 함께 직접 쓴 PREWHERE는 FINAL보다 먼저 평가되어, 정렬 키 밖 열을 쓰면 결과가 틀릴 수 있다. 조건 캐시가 25.4부터 기본으로 켜져 같은 쿼리를 되풀이해 재면 빨라 보인다. dbt delete+insert는 중간 표 없이 대상 표를 바로 고쳐, 도중에 실패하면 모델이 잘못된 상태로 남을 수 있다.
  - **Redis·Valkey·ElastiCache**: Redis 코어 명령에는 실행 계획이 없고 기본으로 기본 키 접근만 준다. 보조 인덱스는 정렬 집합(점수 순으로 정렬된 집합)으로 직접 만든다. `SMEMBERS`는 O(N)으로 응답을 한 번에 돌려주며, 수십만 개 이상이면 `SSCAN`을 쓰라고 한다. 일반 클라이언트의 출력 버퍼에는 기본 상한이 없다. `UNLINK`는 메모리를 다른 스레드에서 돌려받아 주 스레드를 막지 않는다. 큰 키를 TTL로 지울 때 Redis OSS와 Valkey 7.2는 기본으로 주 스레드를 막는다. Valkey 8.0은 엔진 기본값이 막지 않음(yes)이지만, ElastiCache는 이 매개변수를 감춰 실제 값을 밝히지 않는다. `#!` 줄이 없는 Lua 스크립트는 선언하지 않은 다른 슬롯 키에 접근해도 바로 막히지 않는다. ElastiCache가 제공하는 판은 Valkey 7.2.6·8.0·8.1·8.2·9.0·9.1이고 Redis OSS는 7.1까지다. 검색 엔진(숫자·태그·전문 검색)은 Valkey 9.0 이상 노드 기반 클러스터에서만 된다. Lua 시간 상한 `lua-time-limit`는 5,000ms이고 바꿀 수 없으며, 넘으면 `SCRIPT KILL` 뒤 노드를 강제로 다시 시작할 수 있다. `latency-tracking`은 ElastiCache 기본값이 꺼짐이다. 서버리스에는 SLOWLOG·LATENCY·WAIT·로그 전달이 없다. 슬롯별 지표는 Valkey 8.0, COMMANDLOG는 8.1부터다.

## 결정

1. **점검 보고의 권고를 추천대로 반영한다(소유자 승인).** 결정 2~11이 그 내용이다. 쿼리별 인덱스와 기대 실행 계획은 docs/data.md §5.1이 정본이다.
2. **엔진 판을 정본에 고정한다(추천 적용).**
   - Aurora PostgreSQL 18.x, 18.6.1 이상. 스킵 스캔, EXPLAIN 개선, `uuidv7()`, 기간 키가 18에 기댄다.
   - ClickHouse 26.8 LTS. `EXPLAIN ANALYZE`, 내림차순 정렬 키, 가상 스킵 인덱스가 있다. 다음 LTS로 옮길 때 streaming §4.4 설정 표를 다시 맞춘다.
   - ElastiCache Valkey 8.1 이상, 노드 기반 클러스터 모드. 슬롯별 지표와 COMMANDLOG가 있고, 노드 기반에서만 SLOWLOG·로그 전달을 쓸 수 있다.
3. **돈·정합성 제약을 DB에 둔다(추천 적용).**
   - ① `order_cancellation`에 `event_cancellation_request_id`(회차 취소 일괄 환불이면 그 요청, 아니면 NULL)를 두고, `UNIQUE (order_id, ticket_id) WHERE status <> 'VOIDED'`를 건다. 티켓은 주문 하나에 속하므로 '티켓당 진행 중 취소 하나'와 같고, 주문 ID 범위로 나눠도(결정 4) 파티션 키를 담는다. 팬 취소와 일괄 환불 작업은 `INSERT … ON CONFLICT DO NOTHING`으로 넣고, 이미 있으면 그 취소를 이어서 처리한다.
   - ② `payment`에 `event_id`(결제를 만들 때 주문에서 복사, 바뀌지 않음), `created_at`, `approved_at`, `status_changed_at`을 둔다. `payment_cancel`에 `created_at`·`canceled_at`을 둔다. 일일 대사(결제사 거래 내역과 우리 원장을 맞대어 보는 일)의 실행 기록은 `reconciliation_run`(결제사, 대사 날짜, 상태, 맞은 건수, 어긋난 건수, 끝난 시각)이다. 정산 계산은 그 회차 판매 기간의 모든 날짜에 그 결제사의 대사가 끝났는지 먼저 확인한다.
   - ③ 순서가 중요한 일련번호는 DB 시퀀스로 매기지 않는다. 같은 트랜잭션에서 카운터 행을 `UPDATE … RETURNING`으로 올려 매긴다. 행 잠금이 커밋까지 이어지므로 번호 순서와 커밋 순서가 같아진다. 스캐너 변경은 회차별 카운터 표 `scanner_seq`(회차 ID, 마지막 번호), 감사 체인은 머리 행 `audit_chain_head`(마지막 번호, 마지막 MAC)를 쓴다.
   - ④ 기본 키를 정한다: `purchase_quota (account_id, event_id)`, `seat_sale (event_id, seat_id, order_id)`, `seat_hold (event_id, seat_id, fencing_token)`, `order_event (order_id, seq)`.
4. **파티션 표 운영 규칙(추천 적용).**
   - ① 자식 표는 부모와 같은 UUIDv7 범위로 한 달씩 나누고, 기본 키에 부모 ID를 담는다. 주문의 자식(`order_item`·`order_cancellation`·`order_event`)은 `order_id`로 나눈다. 결제의 자식(`payment_event`·`payment_cancel`)은 `payment_id`, 티켓의 자식(`device_key`·`transfer_offer`·`gate_flag`·`booth_authorization`·`ticket_addon`)은 `ticket_id`로 나눈다. 보존 기간이 지나면 자식 파티션을 먼저 떼어 내고 부모 파티션을 나중에 떼어 낸다. 그 범위를 가리키는 행이 남아 있으면 떼어 내기가 오류로 끝나므로, 정비 잡은 SEV3로 알리고 다음 정비 시간에 다시 한다.
   - ② `scan_event`·`seat_hold`·`scanner_change`는 회차 ID(UUIDv7)의 범위로 한 달씩 나눈다(회차를 만든 달). 회차마다 파티션 하나면 1년에 약 2,100~4,800개가 생기기 때문이다(architecture §9.5). `scan_event`의 기본 키 `(event_id, id)`는 그대로다. 티켓은 회차를 만든 뒤 발권되므로 이 표들의 파티션은 같은 보존 기간이면 티켓 파티션보다 먼저 지워진다.
   - ③ 정비 잡은 새 파티션을 만든 직후와 매일 한 번 파티션 부모 표에 `ANALYZE`를 돌린다.
   - ④ 파티션 표에 인덱스를 더할 때는 파티션마다 `CREATE INDEX CONCURRENTLY`를 하고, 부모에 `CREATE INDEX … ON ONLY`로 만든 뒤 `ALTER INDEX … ATTACH PARTITION`으로 붙인다. 이 파일은 마이그레이션 실행기의 트랜잭션 밖 파일로 쓴다(docs/devops.md §7.2).
5. **커지는 원장 표의 보존과 나누기(추천 적용, 기간 [가정, wbs 0.3.2에서 확정]).**
   - `order_event`·`payment_event`: 부모와 같은 범위, 부모와 같은 5년.
   - `seat_hold`: 회차 판매 종료 + 90일 [가정] 뒤 지운다. 홀드 사건은 분석 브론즈에도 90일 있다.
   - `scanner_change`: 입장 기록 마감 + 1년 [가정] 뒤 지운다. 개인정보가 없고, 현장 스태프 배정 기록과 같은 기간이다.
   - `scan_event`: 지금과 같은 5년(docs/security/data-classification.md 현장 게이트 입장 검표 기록)이다.
   - `notification_delivery`: 발송 시각 `sent_at` 범위로 한 달씩 나누고 기본 키를 `(dedup_key, sent_at)`으로 바꾼다. 중복 막기는 7일 [가정] 보존하는 유일 확인 표 `notification_dedup`(중복 키, 만든 시각)이 맡는다. 90일 파기는 파티션째 지우기가 된다.
6. **쿼리·인덱스 규칙(추천 적용).**
   - ① 쿼리 먼저: docs/data.md §5.1의 쿼리-인덱스 표(API·작업 → SQL 꼴 → 인덱스 → 기대 계획)를 정본으로 둔다. 새 쿼리는 표에 한 줄을 더하고, PR에 합성 데이터(5년치 규모) `EXPLAIN (ANALYZE, BUFFERS)` 결과를 붙인다.
   - ② 부분 인덱스의 조건 값(`'HELD'`, `'PENDING'` 등)은 SQL 문장에 상수로 쓴다. Drizzle에서는 `sql` 상수 조각으로 쓴다. PR 검토 때 `EXPLAIN (GENERIC_PLAN)`으로 일반 계획에서도 쓰이는지 본다.
   - ③ 상태 쓸기 작업(만료·기한·파기)은 대기 상태 행만 담은 부분 인덱스 `(기한) WHERE status = '대기 상태'`를 쓴다.
   - ④ 외래 키를 참조하는 쪽 열에는 인덱스를 둔다. 부모 행 삭제와 파티션 떼어 내기가 이 인덱스로 자식 행을 찾는다.
   - ⑤ 커버링 인덱스(`INCLUDE`)는 잘 바뀌지 않는 표(티켓, 기기 키, 스캔 기록, 후기)에 둔다. 상태가 계속 바뀌는 표(`seat_sale`·`seat_hold`)에는 효과가 작다.
   - ⑥ 식 인덱스는 IMMUTABLE 함수만 쓴다. 판매 종료(`starts_at - 24시간`, ADR-0064)는 식 인덱스로 만들 수 없으므로 `starts_at > now() + interval '24 hours'`처럼 열을 그대로 두고 비교한다. 생성 열에 인덱스가 필요하면 STORED로 만든다.
   - ⑦ 커서 목록은 `(<등호 열>, 정렬값, id)` 인덱스와 `(정렬값, id) < ($1, $2)` 행 값 비교로 읽는다. 커서 정렬 칸은 NOT NULL이다. 방향이 섞인 정렬(후기 별점 순)은 정렬을 받아들인다.
   - ⑧ 회차 단위 일괄 작업(일괄 환불 대상 고르기, 스캐너 패키지 만들기, 정산 합계)은 트랜잭션 첫 문장에 `SET LOCAL plan_cache_mode = force_custom_plan`을 둔다. 회차 크기(500석~5만 석)에 따라 좋은 계획이 달라서다.
   - ⑨ 배치·마감·정산 DB 역할만 `work_mem`을 64MB [가정]로 올린다(역할 기본값). 핫패스 역할은 기본 4MB다.
   - ⑩ 옵티마이저 힌트(`pg_hint_plan`)와 가상 인덱스(`hypopg`)는 스테이징 진단용으로만 설치한다. 운영에서 힌트를 쓰면 포스트모템에 남긴다. 인덱스는 숨기는 기능이 없으므로 지우기 전에 사용 통계와 힌트로 '없을 때' 계획을 먼저 본다. Aurora 쿼리 계획 관리는 K3 측정 뒤 대형 회차 핵심 쿼리에만 검토한다.
   - ⑪ PgBouncer `max_prepared_statements`를 0이 아닌 값(문서 기본 200)으로 둔다. ADR-0037의 핫패스 `.prepare()`가 트랜잭션 풀링에서 동작하려면 필요하다. 열 구조를 바꾸는 마이그레이션 뒤에는 관리 콘솔에서 `RECONNECT`를 한다.
7. **실행 계획 진단(추천 적용).**
   - `pg_stat_statements.track_planning`을 켜 파티션 표의 계획 시간을 본다.
   - `auto_explain`: `log_min_duration` 500ms [가정], `log_analyze` 켬, `log_timing` 끔, `log_buffers` 켬, `log_parameter_max_length` 0, `sample_rate` 0.1 [가정]. 매개변수 값을 로그에 남기지 않는다.
   - `log_temp_files` 10MB [가정], `log_lock_waits` 켬. `track_io_timing`은 스테이징에서 오버헤드를 재고 정한다.
   - 정비 잡이 매일 `pg_stat_user_tables`·`pg_stat_user_indexes`의 스냅샷을 남긴다(큰 표 순차 스캔, `idx_scan = 0`인 인덱스, 죽은 행 수, HOT 비율).
   - 계획 회귀 시험: 합성 5년치 데이터에서 핵심 쿼리의 `EXPLAIN (FORMAT JSON)`을 떠서, 금지 노드(큰 표의 순차 스캔 등)와 비용 변화를 CI에서 비교한다(wbs 2.12.1).
8. **ClickHouse(추천 적용).**
   - ops-svc의 `rt` 조회 사용자 설정 프로필에 `force_primary_key = 1`을 둔다. 회차를 넘나드는 골드 비교 조회는 다른 사용자로 둔다.
   - FINAL을 쓰는 조회에 `PREWHERE`를 직접 쓰지 않는다.
   - 성능 측정은 조건 캐시를 끄고 한다. 26.8의 INSERT 때 열 통계 만들기가 실시간 표의 삽입 비용을 늘리는지 wbs 4.3.9 싱크 측정에 넣는다.
   - 마감 실행(ADR-0052 결정 4)의 delete+insert를 '판 바꾸기'로 바꾼다. 실행마다 `run_id`를 붙여 새 행을 넣는다. 시험을 통과하면 '회차별 현재 판' 표 `gold.current_run`을 바꾸고, 지표 뷰는 현재 판의 행만 읽는다. 옛 판의 행은 다음 정비 때 지운다. 도중에 실패하면 현재 판이 그대로라, 읽는 쪽이 반쯤 지워진 회차를 보지 않는다.
9. **Redis·ElastiCache(추천 적용).**
   - T=0 로비 집합(`q:{event:E}:lobby_members`, 최대 약 100만 개)은 `SSCAN … COUNT 1000` [가정]으로 나눠 읽고, 받는 쪽에서 중복을 지운다. K1 PoC에서 100만 개 읽기 시간을 잰다.
   - 판매 종료 정비 잡이 그 회차의 큰 키(로비 집합, 묶음 집합)를 `UNLINK`로 먼저 지운다. TTL은 안전망으로 남긴다.
   - ElastiCache 매개변수 `latency-tracking`을 켜고, 슬로 로그를 CloudWatch Logs로 보낸다. 보내는 기록은 키 이름·값이 가려지고 주기마다 정해진 수만 가져와 빠질 수 있다.
   - 핫 키 찾기는 LFU 정책(자주 쓰인 정도로 지울 키를 고르는 방식)이 필요하므로, 대기열·좌석 클러스터에서는 슬롯별 지표로 대신한다.
   - Lua 스크립트는 첫 줄에 `#!lua`를 두고 쓰는 키를 모두 `KEYS`로 넘긴다. 스크립트 안에서 큰 컬렉션을 훑지 않는다.
   - 만료 정렬 집합 조회는 `ZRANGE … BYSCORE … LIMIT 0 n`을 쓴다. 건너뛰기(offset)가 크면 O(N)까지 커진다.
10. **데이터 설계 패턴 규칙(추천 적용).**
    - ① 공통 코드: 상태·종류 칸마다 `CHECK (… IN (…))`를 둔다. enum 타입은 값을 뺄 수 없어 쓰지 않는다. 허용 값의 원본은 서비스 코드의 상수 목록 하나이고, openapi·Avro 열거형, Drizzle 타입, CHECK가 같은지 CI가 본다. 부분 인덱스 조건을 바꿀 때는 새 인덱스 동시 생성 → 계획 확인 → 옛 인덱스 동시 삭제 순서다.
    - ② 상속관계: 한 표에 여러 종류를 담는 `venue`·`settlement_statement`·`admin_account`에는 종류별 필수 칸 CHECK를 둔다. `settlement_statement.performance_id`는 `event_id`로 이름을 맞춘다.
    - ③ 같은 대상의 열린 CS 건은 하나다: `cs_case`에 `UNIQUE (kind, target_ref) WHERE status <> 'RESOLVED' AND kind IN ('CONTENT_REPORT','RIGHTS_REQUEST')`. ops-svc는 이벤트를 `INSERT … ON CONFLICT DO NOTHING`으로 받는다.
    - ④ JSON: 2인 승인자는 JSON 배열 대신 DB마다 승인 자식 표에 둔다(승인 업무 `approval_vote`, 운영 명령 `command_approval`, 회차 취소 `event_cancellation_approval`). 각 표는 `UNIQUE (요청 ID, 승인자)`와 요청자와 다른지 검사하는 CHECK를 둔다. `gate_flag.scan_event_ids`는 자식 표 `gate_flag_scan`으로 바꾼다. `scanner_change.payload`에는 판 번호 `v`를 넣는다.
    - ⑤ 변경 이력: 판매 승인한 회차의 승인 판본은 `event_revision`(회차, 판 번호, 승인한 내용 JSON, 승인자, 시각)에 남긴다. 파트너 계약 조건은 `promoter_contract`(파트너, 수수료율, 유효 기간)에 남기고, 기간 키 `UNIQUE (promoter_id, valid_during WITHOUT OVERLAPS)`로 기간이 겹치지 않게 한다. 판매자 정보 변경 요청은 `seller_profile_change`에 둔다.
    - ⑥ 정규화·역정규화: 복사한 칸의 목록(칸, 원본, 복사 시점, 바뀌는지, 맞추는 방법)을 docs/data.md §2에 둔다. 게이트 구역은 좌석 값이 있으면 좌석, 없으면 구역 값을 쓰고, 발권 때 티켓에 복사한다. 오픈 뒤 바꾸면 ticket-svc가 티켓 값을 고치고 `scanner_change`로 알린다. 다른 논리 DB를 가리키는 ID는 하루 한 번 고아 행(가리키는 대상이 없는 행) 수를 세어 지표로 낸다.
    - ⑦ 계층구조: 계정 병합은 사슬을 펴서 저장한다. 흡수 계정을 가리키던 계정도 새 대표 계정을 가리키게 한다.
    - ⑧ 소프트 삭제: 후기를 지우면 본문·별점·사진 키와 계정 ID를 바로 비운다. 신고 기록이 가리키는 후기 ID·회차·상태·시각만 남기고, 그 행도 신고 기록 보존이 끝나면 지운다.
    - ⑨ 통계 표: 일괄 환불 진행률은 `order_cancellation`을 요청별 상태로 묶어 센다. `event_cancellation_request.done_count`·`failed_count`는 작업자가 묶음마다 한 번만 올리는 화면용 값이다. 후기 요약(평균 별점·후기 수)은 커버링 인덱스로 매번 집계하고 CDN에 캐시한다.
    - ⑩ 그 밖: CS 처리함 목록은 '다음 기한' 순이다(`cs_case.next_due_at` = 진행 경과 기한과 결과 기한 중 이른 것, STORED 생성 열). `order_item` 칸은 주문 ID, 줄 번호, 좌석 ID, 등급, 단가(주문 때 가격), 티켓 ID(발권 뒤, ticket DB라 외래 키 없음)다. `seat_sale`에는 가상계좌 PENDING 기한 `pending_until`(입금 기한 + 10분 [가정])을 둔다.
11. **하지 않는 것.**
    - 장르 값(한국어 표시값, ADR-0063)은 그대로 둔다. 이름을 바꿀 일이 생기면 그때 코드 키와 화면 이름을 나눈다.
    - 공연(회차 묶음) 단계는 design/d5 §1.6 31번 결정을 기다린다.
    - `pg_bigm`(두 글자 조각 검색)은 Aurora 18이 지원하지만, 넣을지는 부하 시험 뒤 정한다(ADR-0083 되돌릴 조건).
    - 탈퇴 회원 거래 기록의 분리 보관은 정책에 정해져 있다(planning/03 §1, docs/security/data-classification.md). DB 안의 위치(별도 스키마·역할)는 wbs 7.4.1 내부 관리계획에서 정한다.

## 검토한 대안

| 대안 | 채택하지 않은 이유 |
| --- | --- |
| 취소 중복을 앱 검사로만 막기 | '물리 유일 제약이 마지막 방어선'(docs/data.md §5) 원칙과 어긋난다 |
| 일련번호를 DB 시퀀스로 매기기 | 번호 순서와 커밋 순서가 어긋나 이어 받기에서 빠질 수 있다 |
| 자식 표를 나누지 않고 보존 기한 뒤 DELETE | 큰 DELETE와 청소 부담이 생기고, 떼어 내기 전 참조 확인도 오래 걸린다 |
| `scan_event`를 회차마다 파티션 하나로 | 1년에 수천 개라 계획 시간과 메모리가 는다 |
| `scan_event`를 해시로 나누기 | 파티션 수는 고정되지만 보존 기한이 지난 회차를 파티션째 지울 수 없다 |
| enum 타입 | 있는 값을 뺄 수 없다 |
| 전 서비스가 함께 쓰는 공통 코드 표 | 논리 DB끼리 참조 금지(docs/data.md §1)와 어긋나고 배포가 서로 묶인다 |
| 인덱스를 바로 지우기 | 되돌리려면 다시 만들어야 한다. 사용 통계와 힌트로 먼저 본다 |
| 힌트·계획 고정을 평소에 쓰기 | 데이터와 통계가 바뀌어도 계획이 따라가지 않는다 |
| ClickHouse 26.3 LTS | `EXPLAIN ANALYZE`·내림차순 키·가상 인덱스가 없고, 지원이 26.8 LTS보다 먼저 끝난다 |
| 마감 실행을 delete+insert 그대로 | 도중에 실패하면 골드가 반쯤 지워진 채 남는다 |
| 로비 집합을 `SMEMBERS`로 한 번에 읽기 | O(N) 응답이 한 번에 오고 출력 버퍼 상한이 없다 |

## 결과와 트레이드오프

- **좋은 점**
  - 이중 환급, 일련번호 빠짐, 파티션 지우기 실패를 DB 규칙이 막는다.
  - 핵심 쿼리마다 인덱스, 기대 계획, 진단 방법이 정본에 있다.
  - 엔진 판이 정해져 문서의 기능 설명이 판과 맞는다.
- **대가**
  - 표와 인덱스가 는다(유일 확인 표, 카운터 행, 자식 표, 판본 표, 승인 자식 표). 쓰기마다 INSERT가 조금 는다.
  - 자식 표마다 파티션이 5년에 약 60개 생긴다.
  - 판 바꾸기 마감은 바꾸는 동안 그 회차의 골드 행이 두 벌이다.
  - `auto_explain` 표본에 측정 비용이 든다.
- **남는 한계**
  - 기대 실행 계획은 모두 측정 전이다. 값은 [가정]이다.
  - Aurora 메이저 판 올리기에서 통계가 유지되는지는 확인하지 않았다. 판을 올린 뒤 ANALYZE를 한다.
  - ElastiCache Valkey 8의 큰 키 만료 방식은 공개되지 않았다. 판매 종료 정비 잡의 `UNLINK`로 대신한다.
  - 자식 행이 남은 달은 떼어 내기가 늦어질 수 있다.
- **반영 수치(2026-10-22)**: ADR 85 → 86, 검토 기록 R-98, 질문 46. WBS 일정은 그대로다(0.3.2·0.3.4·2.12.1·4.3.6의 설명만 고친다). 측정에서 일이 넘치면 소유자와 다시 정한다.

## 되돌릴 조건

- 부하 시험에서 카운터 행(`scanner_seq`·`audit_chain_head`)의 잠금 대기가 병목으로 재지면 묶음 번호 방식을 새 ADR로 연다.
- 자식 표 파티션 때문에 계획 시간이 늘어 재지면 나누는 주기를 다시 본다.
- `auto_explain` 표본이 핫패스 p99(요청 백 건 중 아흔아홉 건이 이 시간 안에 끝난다는 뜻)를 늘리면 표본 비율을 낮춘다.
- ClickHouse 다음 LTS에서 기본값이 바뀌면 streaming §4.4를 다시 맞춘다.
- ElastiCache가 큰 키 만료 방식을 밝히면 `UNLINK` 정비를 다시 본다.

## 소유자 검토 대상(추천 적용)

1. 엔진 판: Aurora PostgreSQL 18.6.1 이상, ClickHouse 26.8 LTS, ElastiCache Valkey 8.1 이상 노드 기반.
2. 취소 유일 제약 `(order_id, ticket_id)`와 `event_cancellation_request_id`.
3. 결제 칸(`event_id`·시각들)과 대사 실행 기록 `reconciliation_run`.
4. 일련번호는 카운터 행(`scanner_seq`·`audit_chain_head`).
5. 자식 표 같은 범위 나누기, `scan_event`·`seat_hold`·`scanner_change` 회차 범위 월 파티션, 부모 표 ANALYZE.
6. 보존: `seat_hold` 판매 종료 + 90일, `scanner_change` 입장 기록 마감 + 1년, `notification_dedup` 7일.
7. 진단 값: `auto_explain` 500ms·표본 10%, `log_temp_files` 10MB, 배치 역할 `work_mem` 64MB, 로비 `SSCAN` 1,000개씩.
8. ClickHouse 마감 '판 바꾸기'와 `rt` 조회 사용자 `force_primary_key = 1`.
9. 승인 자식 표, 판본 표(`event_revision`·`promoter_contract`·`seller_profile_change`), 후기 삭제 때 비우는 칸.
