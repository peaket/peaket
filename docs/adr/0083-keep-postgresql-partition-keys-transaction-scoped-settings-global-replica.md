# ADR-0083: 관계형 원장 DB는 PostgreSQL을 유지하고(MySQL 비교), 파티션 표의 키 규칙·트랜잭션 범위 설정·교차 리전 복제본의 빈칸을 채운다(2026-10-22)

- **상태**: 채택 (2026-10-22. 소유자가 "현재설계에서 postgresql 이랑 mysql중에 어떤게 합리적인지 봐주세요"라고 물었다. 비교 보고(PostgreSQL 유지 권고, 어느 DB를 쓰든 고쳐야 할 빈틈 4건)를 본 뒤 "PostgreSQL 유지 비교를 새 ADR로 남기고, 월 파티션 유일 제약 등 빈틈 4건도 data.md·infra.md·ADR 상태 줄에 반영해 주세요"라고 했다. 결정 1은 소유자 승인이고, 결정 2~7의 값과 세부는 추천 적용이다(소유자가 방향을 승인하고 세부를 맡긴 부분에서 제안해 적용한 값으로, 바꾸고 싶으면 언제든 바꾼다). 외부 사실은 2026-10-22에 원문으로 확인했다) 2026-10-22(ADR-0086): '남는 한계'의 두 글자 조각 확장(pg_bigm)은 Aurora PostgreSQL 18.3~18.6이 지원함을 확인했다(1.2_20250903). 넣을지는 부하 시험 뒤 정한다. 엔진 판을 Aurora PostgreSQL 18.x(18.6.1 이상)로 고정했다. 결정 2의 파티션 규칙에 자식 표를 부모와 같은 범위로 나누기(떼어 낼 때 그 범위를 가리키는 행이 남으면 오류다), `scan_event`·`seat_hold`·`scanner_change`를 회차 ID 범위로 달마다 나누기(회차마다 파티션 하나가 아니다), 부모 표 ANALYZE, 파티션 표의 인덱스 만들기 절차를 더했다(docs/data.md §2, docs/devops.md §7.2). 2026-10-27(ADR-0094): 알려진 한계의 검색은 pg_trgm을 쓰지 않고 미리 계산한 정규화·낱자·초성 칸의 앞부분 일치로 바꿨다. DB의 문자 분류 설정이 C면 pg_trgm이 한글을 단어 글자로 보지 않는다는 점도 PostgreSQL 18 소스로 확인했다. 2026-10-28(기술 검토 중간-081, 소유자 승인 '추천안 동의'): 결정 6의 ticket 도쿄 보조 클러스터는 '리전 장애 때 조회 유지'가 아니라 티켓 원장 보존(RPO 약 1초)과 복구 기준점으로 읽는다. 도쿄에는 그것을 읽을 ticket-svc·gw-scanner·NLB가 없어 리전 장애 당일 현장은 오프라인 판정으로만 버틴다. 당일 조회용 도쿄 파일럿 라이트는 소유자가 고를 안이다(docs/infra.md §4·§6, review/open-items.md 45번). 2026-10-28(ADR-0121, 소유자 승인 '추천안 동의'): 좌석 Redis 장애 때의 DB 비상 홀드 경로를 없앴다. 그래서 결정 3의 비상 경로 잠금 대기(`SET LOCAL lock_timeout = '100ms'`)와 그 409는 쓰지 않는다. 트랜잭션에만 걸 값은 `SET LOCAL`로 걸고 세션 `SET`을 쓰지 않는다는 규칙은 그대로다. 결정 1의 근거 ②(비상 경로의 밀리초 잠금 대기)는 더 이상 근거가 아니다. ①·③·④·⑤는 그대로라 PostgreSQL을 유지한다는 판단은 바뀌지 않는다. 2026-10-28(ADR-0114, 소유자 승인 '추천안 동의'): 결정 2 ②의 주문·결제·티켓 월 파티션과 ③의 `payment_per_order`를 거둔다(주문당 결제 1건은 `payment.order_id` UNIQUE). `order_idempotency`는 같은 날 기술 검토 중간-046으로 멱등 기록 표(계정 × 작업 범위, 24시간)가 되어 남는다. 검토한 대안의 '나누지 않기'를 골랐다. 결정 1의 근거 ⑤는 회차 범위 파티션 표(`scan_event`)가 `ticket`을 외래 키로 가리키는 곳에만 남는다. 2026-10-28(ADR-0116, 소유자 승인 '추천안 동의'): Outbox 릴레이를 모든 환경에서 폴링 릴레이 하나로 정해 Debezium을 뺐다. 그래서 결정 2 ⑤의 `publish.via.partition.root`와 결정 7의 `max_slot_wal_keep_size` 확인은 쓰지 않는다. Outbox 일 파티션(⑤의 나머지)과 미리 만들기(⑥)는 그대로다.
- **관련**: ADR-0014(Soft Hold·Hard Sale, 비상 경로), ADR-0021(CockroachDB 기각), ADR-0028(샤딩 배제·월 파티션·PgBouncer), ADR-0031(환경·리전 장애), ADR-0037(Drizzle), ADR-0054(마이그레이션 규칙), ADR-0070(시간 초과 기본값·Outbox·CDC 슬롯 정리), docs/data.md §2·§4·§5·§6, docs/infra.md §1·§4·§6, docs/devops.md §7.2, docs/architecture.md §5, docs/features/seat-hold.md §9, docs/features/payment.md §10, docs/features/offline-gate.md §10

## 맥락

- **소유자 질문(2026-10-22)**: 지금 설계에서 PostgreSQL과 MySQL 가운데 무엇이 합리적인가.
- **지금 설계가 PostgreSQL 기능에 기대는 곳**
  - 오버셀의 마지막 방어선: `seat_sale`의 활성 상태 부분 유니크 인덱스, 홀드 원장 `seat_hold`의 HELD 부분 유니크, `payment_attempt`의 활성 시도 부분 유니크(docs/data.md §2·§5, ADR-0014).
  - 좌석 Redis 장애 때 비상 경로: 좌석 ID 순 `SELECT … FOR UPDATE`와 짧은 잠금 대기, 목표 p99 300ms(docs/features/seat-hold.md §9).
  - 서버 쪽 시간 초과: 서비스 DB 사용자의 역할 기본값 `statement_timeout`·`idle_in_transaction_session_timeout`(docs/architecture.md §5, ADR-0070).
  - 마이그레이션: 파일마다 트랜잭션, `CREATE INDEX CONCURRENTLY`만 트랜잭션 밖, `NOT VALID` 뒤 `VALIDATE CONSTRAINT`, 문장마다 잠금 대기 제한(docs/devops.md §7.2, ADR-0054).
  - CDC: Debezium이 논리 복제 슬롯으로 Outbox를 읽고, 슬롯이 붙잡은 WAL을 경보로 본다(docs/data.md §4, ADR-0070).
  - 운영 손잡이: `pg_stat_statements`·postgres_exporter, `pg_stat_activity`·`pg_blocking_pids()`, `pg_monitor`·`pg_signal_backend` 역할, pgAudit(docs/devops.md, docs/observability.md).
  - 공연명·아티스트 검색: `pg_trgm` 삼중자 인덱스(docs/data.md §5).
- **비교하며 찾은 빈칸(어느 DB든 해당)**
  1. 월 파티션과 전역 유일 규칙이 부딪친다. ADR-0028 결정 3은 주문·결제·티켓 표를 월 범위 파티션으로 둔다. 그런데 `purchase_order`는 `created_at`을 파티션 키로 두면서 `idempotency_key UNIQUE`를, `payment`는 `order_id UNIQUE`(승인 요청은 주문당 한 번)를 가지고, `ticket`은 `device_key`·`transfer_offer`·`scan_event` 등의 외래 키 대상이다. 파티션 표의 유일·기본 키 제약은 파티션 키 열을 모두 담아야 하므로 이대로는 만들 수 없거나 같은 달 안에서만 유일하다. 월말 자정에 걸친 재시도는 중복 주문을 막지 못한다. 회차로 나누는 `scan_event`의 기본 키 `id`도 파티션 키를 담지 않는다. 일 단위로 나누는 Outbox는 Debezium 기본 설정이면 변경이 파티션 이름으로 나간다. 다음 파티션을 미리 만드는 규칙도 없다(맞는 파티션이 없는 행을 넣으면 오류다).
  2. docs/data.md §5의 'fillfactor로 HOT 최적화'(비상 경로의 좌석 상태 갱신)는 좌석 상태 변경에 듣지 않는다. HOT는 인덱스가 참조하는 열을 바꾸지 않는 갱신에만 되는데, 부분 인덱스의 조건 열도 그 열로 친다. `seat_hold`·`seat_sale`의 `status`가 조건 열이다.
  3. 세션 단위 설정이 트랜잭션 풀링과 부딪친다. docs/data.md §5는 비상 경로에 '세션 레벨 짧은 lock_timeout'을 적었지만 ADR-0070은 PgBouncer 트랜잭션 풀링이라 세션 SET을 쓰지 않는다. 마이그레이션 실행기는 세션 단위 `pg_advisory_lock`과 문장마다 세션 `SET lock_timeout`을 쓰는데, 어느 경로로 DB에 붙는지 정해져 있지 않다.
  4. ticket DB의 교차 리전 읽기 복제본(docs/infra.md §4)을 만드는 방식이 없다. Aurora PostgreSQL은 교차 리전 Aurora 복제본을 지원하지 않고 Global Database로만 다른 리전에 읽기 클러스터를 둔다. 그런데 ADR-0031은 'Aurora Global Database 기반 자동 전환'을 기각했다.
  - 덤: Aurora에서 `max_slot_wal_keep_size`를 쓸 수 있는지가 확인 필요로 남아 있었다(docs/data.md §4, wbs 0.3.2).
- **확인한 외부 사실(2026-10-22, 원문)**
  - MySQL 8.4 참조 설명서: `CREATE INDEX` 문법에 조건절이 없어 부분 인덱스가 없다. 키 부분에 식을 쓸 수 있고 UNIQUE 인덱스는 NULL을 여러 개 허용한다. `innodb_lock_wait_timeout`은 초 단위이고 최솟값이 1이며 `SET_VAR` 힌트가 적용되지 않는다. `max_execution_time`은 읽기 전용 SELECT에만 걸린다. 설명서의 서버 시스템 변수 절(329개)과 InnoDB 변수 절(160개)에 트랜잭션 안에서 멈춘 연결만 끊는 변수는 없다. `init_connect`는 전역 설정이고 `CONNECTION_ADMIN` 권한 사용자에게는 실행되지 않는다. 'Atomic DDL is not transactional DDL'이며 DDL은 진행 중인 트랜잭션을 암묵적으로 끝낸다. 중복 키 오류는 그 레코드에 공유 잠금을 걸고, 세 세션이 같은 행을 넣다가 첫 세션이 되돌리면 교착이 난다(설명서 예시). 파티션 표의 모든 유일 키는 파티션 식의 모든 열을 담아야 하고, InnoDB 파티션 표는 외래 키를 갖거나 외래 키의 대상이 될 수 없다. `TIMESTAMP`의 범위는 '2038-01-19 03:14:07' UTC까지다. ngram 전문 검색 파서가 한국어·중국어·일본어를 지원한다. 기본 동작은 연결마다 스레드 하나이고 연결이 늘면 성능이 떨어지며, 스레드 풀은 상용 Enterprise 판 기능이다.
  - PostgreSQL 18 문서·소스: 파티션 표의 유일·기본 키 제약은 파티션 키 열을 모두 담아야 한다. 맞는 파티션이 없는 행을 넣으면 오류다. 기본(DEFAULT) 파티션이 있으면 새 파티션을 더할 때 기본 파티션을 훑어 새 범위의 행이 없는지 확인한다. 파티션 표를 가리키는 외래 키는 12부터 된다(12 출시 노트). `statement_timeout`·`lock_timeout`·`idle_in_transaction_session_timeout`·`transaction_timeout`은 밀리초 단위이고 `lock_timeout`은 잠금 시도마다 따로 걸린다. `SET LOCAL`은 현재 트랜잭션에만 걸린다. 유일성 검사는 커밋 전의 충돌 행을 만나면 그 트랜잭션이 끝날 때까지 기다린다. HOT는 인덱스가 참조하는 열을 바꾸지 않을 때만 되고, 소스(`relcache.c`)는 인덱스 조건 열도 HOT를 막는 열에 넣는다. `pg_trgm`은 3글자 조각을 뽑지 못하는 패턴이면 인덱스 전체를 훑는다. 연결마다 백엔드 프로세스 하나다. `uuid` 비교는 바이트 순서(`uuid.c`의 `memcmp`)이고 `uuidv7()`가 있다. 발행 옵션 `publish_via_partition_root`의 기본값은 false다. `autovacuum_vacuum_scale_factor`의 기본값은 0.2이고 표마다 따로 줄 수 있다.
  - PgBouncer 기능 표: 트랜잭션 풀링에서 `SET/RESET`과 세션 단위 advisory 잠금은 'Never'다.
  - Debezium: PostgreSQL 커넥터의 `publish.via.partition.root`가 false(기본)면 파티션마다 그 이름으로, true면 부모 표 이름으로 변경을 내보낸다. MySQL 커넥터는 binlog가 지워져 위치를 잃으면 실패하고 새 스냅샷이 필요하다.
  - AWS: Aurora PostgreSQL은 교차 리전 Aurora 복제본을 지원하지 않고, Global Database로 다른 리전에 읽기 전용 보조 클러스터를 둘 수 있다. 보조 클러스터를 Global Database에서 떼어 내면 복제가 멈추고 읽기·쓰기가 되는 독립 클러스터가 된다. Aurora MySQL은 binlog로 다른 리전에 읽기 복제본을 만들 수 있다. Backtrack(Aurora MySQL 전용)은 binlog를 켠 클러스터를 되감으면 보통 오류가 나고, Backtrack을 켠 클러스터에서는 교차 리전 읽기 복제본을 만들 수 없다. Aurora MySQL binlog 보존은 최대 2,160시간(90일)이다. RDS Proxy는 추적 목록 밖의 세션 변수를 바꾸면 그 세션을 연결에 고정한다(`innodb_lock_wait_timeout`은 목록에 없다). Aurora PostgreSQL Limitless Database는 아시아 태평양(타이베이)을 뺀 모든 리전에서 쓸 수 있다. Aurora PostgreSQL 매개변수 목록에 `max_slot_wal_keep_size`(MB, 기본값 없음)가 있다.
  - 서울 리전 RDS 가격표(가격 목록 API `AmazonRDS` ap-northeast-2, 2026-10-20 게시판): Aurora MySQL과 Aurora PostgreSQL의 온디맨드 인스턴스(db.r7g.large 시간당 0.333달러, db.r7g.2xlarge 1.331달러 등), 저장(GB-월 0.12달러), I/O(100만 건 0.24달러), I/O 최적화 저장(GB-월 0.27달러), RDS Proxy(vCPU-시간 0.018달러)가 같다.
  - Drizzle 0.45.4 소스: MySQL 선택 빌더에 `for('update'|'share', { noWait } | { skipLocked })`가 있고, MySQL 인덱스는 SQL 식을 받지만 조건(`where`)이 없다. MySQL 마이그레이터도 대기 중인 마이그레이션 전부를 한 트랜잭션에 넣는다. PostgreSQL 표 정의(`pg-core/table.ts`)와 drizzle-kit의 PostgreSQL 직렬화기에는 파티션 선언이 없다.

## 결정

1. **관계형 원장 DB는 Aurora PostgreSQL을 그대로 쓴다. MySQL(Aurora MySQL)로 바꾸지 않는다(소유자 승인).** 이유는 무게 순으로 다섯이다.
   - ① 오버셀의 마지막 방어선이 부분 유니크 인덱스 셋이다. MySQL은 '비활성이면 NULL이 되는 식 + UNIQUE'로 같은 효과를 낼 수 있지만, 활성 상태의 정의가 인덱스 식으로 흩어져 상태를 하나 더할 때 놓치기 쉽다.
   - ② 비상 경로 p99 300ms는 밀리초 단위 잠금 대기 상한에 기댄다. MySQL의 행 잠금 대기 상한은 초 단위이고 최솟값이 1초라(문장 힌트로도 바꿀 수 없다), 1초를 기다리거나 바로 실패(NOWAIT)하는 둘 가운데 하나가 된다.
   - ③ ADR-0070의 서버 쪽 시간 초과(모든 문장의 상한, 트랜잭션 안에서 멈춘 연결 끊기, DB 사용자별 기본값)에 MySQL 대응이 없다. 감시 작업이 오래된 트랜잭션을 찾아 끊는 장치를 새로 만들어야 한다.
   - ④ 마이그레이션 규칙은 트랜잭션 안의 DDL에 기댄다. MySQL DDL은 바로 확정되어, 여러 문장 가운데 하나가 실패하면 반쯤 바뀐 상태가 남는다.
   - ⑤ 월 파티션 표를 같은 DB 안의 외래 키가 가리킨다(결정 2). InnoDB 파티션 표는 외래 키를 쓸 수 없다.
   - MySQL의 장점은 이 설계에서 판단을 뒤집지 않는다. 연결이 가볍지만 연결이 늘면 느려지고 스레드 풀은 유료판이며, 관리형 프록시는 세션 변수를 바꾸면 연결을 고정한다. 옛 행 청소(VACUUM)가 없지만, 쓰기량이 동시 입장 상한에 묶여 판매 확정 초당 약 28건, 결제 피크 300 TPS, 홀드 원장 초당 약 500건이다(ADR-0028). binlog CDC는 보존 기간이 정해져 저장소가 끝없이 차지는 않지만, 그보다 오래 멈추면 위치를 잃고 다시 스냅샷한다. 한국어 n-gram 검색은 내장이지만 공연 목록이 작다. Backtrack은 binlog CDC·교차 리전 복제본과 맞지 않는다.
   - 서울 가격은 두 엔진이 같아 비용은 근거가 아니다. Aurora PostgreSQL Limitless Database(서울 사용 가능)는 셀 확장(ADR-0028)이 모자랄 때 볼 선택지로만 적고 근거로 쓰지 않는다(공급사 기능이고 재지 않았다).
2. **파티션 표의 키 규칙(추천 적용).**
   - ① 파티션 표의 기본 키와 유일 규칙은 파티션 키 열을 모두 담는다.
   - ② 주문(`purchase_order`)·결제(`payment`)·티켓(`ticket`)은 그 표의 시간순 ID(서버가 만드는 UUIDv7)의 범위로 한 달씩 나눈다. 경계는 한국 시각 매월 1일 0시를 유닉스 밀리초로 바꿔 앞 48비트에 두고 나머지 비트를 0으로 채운 UUID다. PostgreSQL은 `uuid`를 바이트 순서로 비교하므로 경계의 순서가 시각의 순서와 같다. 기본 키 `id`가 파티션 키를 담으므로, 같은 DB 안에서 이 표들을 가리키는 외래 키(티켓: `device_key`·`transfer_offer`·`scan_event`·`gate_flag`·`booth_authorization`·`ticket_addon`, 주문: `order_item`·`order_cancellation` 등, 결제: `payment_event`·`payment_cancel`)가 그대로 선다. `created_at`은 열로 남되 파티션 키가 아니다. 5년 보존이 지난 달은 지금처럼 파티션째 지운다(docs/data.md §6).
   - ③ 파티션 키를 담을 수 없는 전역 유일 규칙은 파티션하지 않는 작은 표가 맡고, 원장 행과 같은 트랜잭션에서 넣는다.
     - `order_idempotency`(purchase): 기본 키 `idempotency_key`와 `order_id`·`account_id`·`created_at`. 주문 생성 트랜잭션에서 함께 넣고, 다시 온 요청은 이 표로 첫 주문을 찾는다(계정이 같은지도 본다). 24시간 [가정, wbs 0.3.2에서 확정] 지난 행은 정비 시간에 지운다.
     - `payment_per_order`(payment): 기본 키 `order_id`와 `payment_id`. 주문당 결제 1건(지금의 `payment.order_id UNIQUE`)을 이 표가 맡는다. 결제 파티션을 지울 때 그 달 범위의 `payment_id` 행을 함께 지운다.
   - ④ 회차로 나누는 `scan_event`는 기본 키를 `(event_id, id)`로 둔다. 단말이 만든 ID로 거르는 중복 저장은 같은 회차 안에서 지켜진다(다시 보내는 기록은 같은 회차로 온다).
   - ⑤ Outbox는 ID(UUIDv7) 범위로 하루씩 나누고 기본 키는 `id`다. Debezium은 `publish.via.partition.root=true`로 두어 부모 표 이름으로 변경을 내보낸다(발행 옵션 `publish_via_partition_root`). 기본값이면 파티션 이름으로 나가 커넥터의 수집 표 목록과 라우팅이 어긋난다.
   - ⑥ 파티션은 미리 만든다. 월 파티션은 3개월 앞, Outbox 일 파티션은 7일 앞까지 [가정, wbs 0.3.2에서 확정] 만들어 두고, 미리 만든 수가 월 2개·일 3개 [가정]보다 적으면 SEV2(`hygiene`) 경보다. 기본(DEFAULT) 파티션은 두지 않는다. 미리 만들기를 놓쳤을 때 INSERT 실패는 막아 주지만, 그 범위의 행이 기본 파티션에 있으면 새 파티션을 만들 수 없고(먼저 옮겨야 한다) 없어도 기본 파티션을 훑어야 한다. Drizzle 0.45.4에는 파티션 선언이 없어, 부모 표와 첫 파티션은 손으로 쓴 SQL 마이그레이션 파일로 만들고 이후 파티션 만들기와 지우기는 Outbox 정리 잡과 같은 정비 잡이 한다.
3. **비상 경로의 짧은 잠금 대기는 트랜잭션 범위로 건다(추천 적용).** 좌석 Redis 장애 때 정렬 잠금 경로는 트랜잭션의 첫 문장으로 `SET LOCAL lock_timeout = '100ms'` [가정, S-T9·K3 시험에서 확정]를 실행한다. `SET LOCAL`은 그 트랜잭션에만 걸리므로 PgBouncer 트랜잭션 풀링에서도 다음 사용자에게 남지 않는다. 잠금을 얻지 못한 요청은 좌석 경합 탈락과 같은 409(`seat-already-held`)로 끝낸다. ADR-0070의 '세션 SET을 쓰지 않는다'는 그대로다.
4. **마이그레이션 잡은 PgBouncer를 거치지 않는다(추천 적용).** 실행기는 세션 단위 `pg_advisory_lock`과 세션 `SET lock_timeout`·`statement_timeout`을 쓰므로 클러스터 쓰기 엔드포인트에 직접 붙는다(DDL 역할, TLS `verify-full`). 앱 연결은 지금처럼 PgBouncer를 거친다.
5. **HOT 문장을 바로잡는다(추천 적용).** `seat_hold`·`seat_sale`의 `status` 전이는 부분 유니크 인덱스의 조건 열을 바꾸므로 HOT가 되지 않는다. fillfactor는 인덱스 밖 열만 바꾸는 갱신(`purchase_quota.used` 등)에 쓴다. 상태 전이가 많은 `seat_hold`는 표별 `autovacuum_vacuum_scale_factor`를 0.02 [가정](기본 0.2)로 낮춰 청소를 앞당기고, 죽은 행 수와 인덱스 크기를 S-T9·K3 시험에서 잰다.
6. **ticket DB의 교차 리전 읽기 복제본은 Aurora Global Database의 보조 클러스터다(추천 적용).** 도쿄 리전에 읽기 인스턴스 1대를 둔 보조 클러스터로, 현장 스캐너의 티켓 검증 조회와 리전 장애 때의 원장 보존에만 쓴다. 평소에는 관리형 전환(switchover·failover)으로 쓰기를 도쿄로 옮기지 않는다. ADR-0031이 기각한 것은 Global Database를 이용한 리전 자동 전환이고, 리전 장애 때 판매를 멈추는 절차(ADR-0031)는 그대로다. 리전 복구(RB-18)에서는 사람이 보조 클러스터를 Global Database에서 떼어 읽기·쓰기가 되는 독립 클러스터로 만들고, 새로 세운 스택의 티켓 원장으로 쓴다(docs/infra.md §6). 나머지 세 클러스터는 Global Database에 넣지 않는다(교차 리전 백업 사본만 둔다).
7. **`max_slot_wal_keep_size`(덤, 추천 적용).** AWS의 Aurora PostgreSQL 매개변수 목록에 있다(기본값 없음). 바꿀 수 있는지와 값은 wbs 0.3.2에서 `describe-db-cluster-parameters`의 `IsModifiable`로 확인하고 정한다. 정하면 슬롯 경보 기준(10GB [가정])보다 크게 둔다. 그 값을 넘으면 슬롯이 무효가 되어 커넥터가 이어 읽지 못하므로 경보가 먼저 울리게 한다.

## 검토한 대안

| 대안 | 채택하지 않은 이유 |
| --- | --- |
| MySQL(Aurora MySQL)로 바꾸기 | 결정 1의 다섯 가지. 바꿀 대상은 아직 문서뿐이지만 PostgreSQL 전용 이름이 57개 파일 292곳(2026-10-22 집계)에 있고, 결정 1의 장치들을 우회 방법으로 다시 설계하고 다시 재야 한다 |
| `created_at` 월 파티션을 두고 기본 키·유일 규칙에 `created_at`을 더하기 | 유일 규칙이 같은 달 안에서만 지켜지고, 외래 키마다 부모의 `created_at`을 함께 들고 다녀야 한다 |
| 결제를 `order_id` 범위로 나누기 | 주문당 1건은 파티션 안에서 지켜지지만 기본 키가 `(order_id, id)`가 되어 `payment_event`·`payment_cancel`이 두 열로 가리켜야 한다 |
| 주문·결제·티켓을 나누지 않기 | 5년 누적 주문 약 1,700만 건·티켓 약 3,500만 장(docs/architecture.md §9)이라 한 표로도 감당할 크기다. 그러나 ADR-0028 결정 3의 목적(보존 기한이 지난 달을 파티션째 지움, 인덱스 크기 억제)을 버리는 결정이라 이번 범위 밖이다 |
| 기본(DEFAULT) 파티션 두기 | 결정 2 ⑥ |
| 비상 경로에 `NOWAIT` | 잠금이 잠깐만 겹쳐도 바로 실패해 비상 경로의 성공률이 떨어진다 |
| ticket 복제를 논리 복제로 다른 리전 클러스터에 | AWS가 Aurora PostgreSQL을 다른 리전에서 읽는 방법으로 안내하는 것은 Global Database다. 논리 복제는 슬롯·발행과 지연·장애 처리를 직접 맡아야 한다 |

## 결과와 트레이드오프

- **좋은 점**
  - 주문 멱등키, 주문당 결제 1건, 티켓을 가리키는 외래 키가 DB 제약으로 선다. 월말 자정에 걸친 재시도도 중복 주문을 만들지 않는다.
  - 파티션 경계가 시간순 ID와 같아 보존 기한 계산과 파티션째 지우기는 그대로다.
  - 'PostgreSQL을 왜 쓰나'에 설계가 쓰는 기능(부분 유니크, 밀리초 잠금 대기, 서버 쪽 시간 초과, 트랜잭션 안 DDL, 파티션 표 외래 키)으로 답할 수 있다.
- **남는 한계**
  - 두 글자 검색어(예: '공연')는 `pg_trgm` 인덱스를 제대로 쓰지 못하고 인덱스 전체를 훑는다. 공연 목록이 작아 지금은 받아들인다. 두 글자 조각 확장(pg_bigm)은 Aurora PostgreSQL 지원 여부를 확인하지 않았다.
  - 상태 전이가 많은 표는 VACUUM이 따라가야 하고, 연결이 프로세스라 PgBouncer라는 운영 부품이 하나 더 있다.
  - 유일 확인 표 때문에 주문·결제마다 INSERT가 하나씩 는다. 멱등키 행은 24시간 [가정] 뒤 지우므로 그 뒤 같은 키가 오면 새 요청으로 처리한다.
  - UUIDv7의 시각은 서버 시계라, 경계 근처의 행은 시계 차이만큼 옆 달 파티션에 들 수 있다(제약과 조회에는 영향이 없다).
  - 비상 경로 100ms, 파티션 미리 만들기 수, 멱등키 보존 시간, `seat_hold` 청소 기준은 재기 전 값이다.
  - ticket 보조 클러스터는 복제 지연분을 잃을 수 있고(ADR-0031 상태 줄), 보조 클러스터 인스턴스와 복제 쓰기 I/O 비용이 든다.
- **반영 수치(2026-10-22)**: ADR 82 → 83, 검토 기록 R-93. WBS 일정은 그대로다(0.3.2·0.3.4의 설명만 고침).

## 되돌릴 조건

- 운영을 맡을 조직이 MySQL 도구와 경험만 갖췄다면 다시 본다. 그때도 결정 1의 다섯 가지를 대신할 방법과 측정이 먼저다.
- K3·결제 부하 시험에서 VACUUM 지연이나 연결 수가 병목으로 재지면 원인별 대응을 새 ADR로 연다.
- 두 글자 검색어의 응답이 부하 시험에서 느리게 재지면 검색 방식을 다시 본다.
- 파티션 수(5년 보존이면 표마다 약 60개)로 쿼리 계획 비용이 재지면 나누는 주기를 다시 본다.
- Aurora PostgreSQL이 교차 리전 Aurora 복제본을 지원하면 결정 6을 다시 본다.

## 소유자 검토 대상(추천 적용)

1. 주문·결제·티켓의 월 파티션 키는 UUIDv7 ID 범위, 경계는 한국 시각 매월 1일 0시.
2. 유일 확인 표 둘: `order_idempotency`(24시간 [가정] 보존), `payment_per_order`(결제와 같은 보존).
3. 스캔 기록 기본 키 `(event_id, id)`.
4. 파티션 미리 만들기(월 3개월·일 7일 앞), 기본 파티션 없음, 미리 만든 수 경보.
5. Debezium `publish.via.partition.root=true`.
6. 비상 경로 `SET LOCAL lock_timeout = '100ms'`와 409 `seat-already-held` 응답.
7. 마이그레이션 잡은 PgBouncer를 거치지 않고 직접 연결.
8. ticket 보조 클러스터: Global Database, 도쿄, 읽기 인스턴스 1대, 평소 관리형 전환 안 함, 리전 복구 때 떼어 내 독립 클러스터로 씀.
9. `seat_hold` 표별 `autovacuum_vacuum_scale_factor` 0.02.
