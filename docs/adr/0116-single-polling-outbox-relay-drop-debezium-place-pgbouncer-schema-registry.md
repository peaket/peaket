# ADR-0116: Outbox 릴레이를 모든 환경에서 폴링 릴레이 하나로 정하고 Debezium(Kafka Connect)을 빼며, PgBouncer·Schema Registry를 띄울 곳을 정한다(2026-10-28)

- **상태**: 채택 (2026-10-28. 기술 검토(review/tech-review.md)의 중간-013 'Outbox 릴레이를 운영(Debezium)과 로컬(폴링)로 나누지 말고 하나로 한다'에 소유자가 "나머지 건수들은 모두 추천안에 동의합니다. 그렇게 모두 수정해주세요."라고 정했다. 방향(폴링 릴레이 하나, Debezium은 바꿀 조건으로 남김, PgBouncer 배치를 정하고 Schema Registry는 같은 날 기술 검토 중간-088이 정한 배치를 따름)은 소유자 결정(추천안 승인)이고, 보내는 순서 규칙·주기·묶음·배치·자원·경보·시험·일정 같은 세부는 추천 적용이다. 수치는 [가정]이다) 2026-10-29(ADR-0140·0143, 소유자 결정 '추천대로 반영'): 보내는 규칙은 그대로이고, ops-svc의 `control.settings`와 identity-svc의 `control.sessions-terminated`도 각 서비스 Outbox로 보낸다(ADR-0143 결정 3). '릴레이가 멈춘 동안 결제 확정 알림이 늦는다'에서 결제 확정 자체는 당기기(ADR-0140)로 이어지고 늦는 것은 알림과 관제 표다. RB-39 ⑤는 당기기가 맞춘다. 2026-11-01(BUILD_ORDER FND-080, openspec 변경 add-idempotency-and-outbox, 추천 적용): 릴레이와 Lease를 `packages/platform`에 만들었다. Lease는 12초·갱신 한도 8초·다시 시도 2초 [가정]로 두어 이어받기가 약 14초(결정 2의 '15초 안')이고, 보내기는 포트로 두어 Kafka 어댑터는 FND-090에서 고른 클라이언트로 만든다. 일 파티션은 따로 만든 표를 붙이고(ATTACH) `DETACH … CONCURRENTLY`로 지운다(docs/data.md §2). 2026-11-01(BUILD_ORDER FND-110, openspec 변경 add-local-cluster-and-relay-deployment): 서비스별 `<서비스>-outbox-relay`는 서비스와 같은 이미지의 다른 시작 명령(`startOutboxRelayProcess`, 서비스 뼈대 `relay.ts`)이고, 공용 차트(`deploy/charts/peaket-service`)가 복제 2·한 파드씩 바꾸기·그 Lease 하나만 다루는 Role로 띄운다. 리더가 되면 정비를 바로 돌고, 끝낼 때 묶음을 마친 뒤 Lease를 놓는다. kind에서 리더를 SIGSTOP으로 멈추면 11.1·13.5초(두 번)에 이어받았다(V-T28 ①의 kind 부분). 같은 날 결정 3의 `seq` 순서가 글자 순서로 정렬돼 자릿수가 바뀌는 묶음에서 뒤집히는 구현 결함을 찾아 고쳤다. 2026-11-01(정합 점검, ADR-0177 해설서 검토 네 번째 묶음): 결정 10의 '상태 줄에 바뀐 점을 덧붙일 ADR'(0070·0083·0084·0099)에는 ADR-0028도 든다. PgBouncer 배치(서비스 DB마다 공용 Deployment 하나)를 ADR-0028 상태 줄에 덧붙였다(docs/architecture.md §11 이 ADR 행의 '상태 줄을 덧붙인 ADR').
- **관련**: ADR-0026(멱등 소비자·키 규칙), ADR-0028(결정 4 PgBouncer), ADR-0070(Outbox·CDC 슬롯 정리), ADR-0083(결정 2 ⑤ `publish.via.partition.root`, 결정 4 마이그레이션 직접 연결, 결정 7 `max_slot_wal_keep_size`), ADR-0084(Outbox `payload`는 `bytea`, Debezium 변환기), ADR-0099(스트림 작업자, 판매 좌석 순서), ADR-0109(발송 원장의 `SKIP LOCKED`), ADR-0113(주문 전이 함수), ADR-0114(Outbox 일 파티션 유지), 기술 검토 높음-26(MSK IAM 규칙)·중간-088(Schema Registry의 생산자 쪽 장애 동작과 등록 경로), NFR-005, NFR-006, POL-022, [docs/data.md](../data.md) §1·§4·§5.1, [docs/streaming.md](../streaming.md) §3·§4.5·§7·§9·§12·§15·§17, [docs/infra-handover.md](../infra-handover.md) §3.2·§3.4·§4.1·§9, [docs/infra.md](../infra.md) §10(RB-39), [docs/observability.md](../observability.md) §5, [docs/devops.md](../devops.md) §9.4, [docs/api/avro/README.md](../api/avro/README.md) §3, docs/api/asyncapi.yaml, [docs/verification.md](../verification.md) §2.7·§9, planning/03 POL-022, wbs 0.3.2·2.11.2·2.12.3·4.2.4, [review/tech-review.md](../review/tech-review.md)(중간-013)

## 맥락

- **지금 규칙(data.md §4의 7번)**: 운영 환경의 표준은 Debezium(DB 변경 기록을 읽어 Kafka로 보내는 도구)을 쓰는 CDC 릴레이이고, Debezium은 Kafka Connect(자바 실행 기반)에서 돈다. 로컬 개발과 v0는 `FOR UPDATE SKIP LOCKED`로 Outbox 표를 주기적으로 읽는 폴링 릴레이다.
- **둘로 나뉘어 생긴 문제**
  - ① 포트폴리오에서 재고 시험하는 릴레이(폴링)와 운영 설계의 릴레이(Debezium)가 달라, 측정이 운영 길을 대표하지 못한다. 결제 확정 3초(결제사 2초 + 내부 1초)의 내부 1초는 Outbox 릴레이를 지난다(P-T5).
  - ② 운영에만 생기는 부품과 설정: Kafka Connect, 논리 복제 슬롯(커넥터가 멈추면 WAL이 쌓여 슬롯 경보를 둔다, ADR-0070), Aurora에서 `max_slot_wal_keep_size`를 바꿀 수 있는지 확인 필요(ADR-0083 결정 7), 하트비트·트랜잭션 메타데이터용 대리 변환기(ADR-0084), `publish.via.partition.root`(ADR-0083), 자바 MSK IAM 설정(기술 검토 높음-26).
  - ③ 배치가 정해지지 않았다. 인수 문서는 Debezium·Schema Registry·PgBouncer를 '쓰기로 정했지만 어디에 띄울지는 정하지 않았다'고 적었다(§3.2·§9). 셋 다 멈추면 판매 경로가 멈출 수 있는 부품이다.
- **일의 크기**: 판매 확정은 평균 초당 약 28건, 결제 승인은 피크 약 300건이고, Outbox 합계는 초당 수천 건 이하다(ADR-0028 맥락, infra-handover §3.2). 짧은 주기로 묶어 읽는 폴링 릴레이로 지연 예산을 넉넉히 맞출 크기다.
- **순서 요구**: 관제 실시간 표의 판매 좌석은 '좌석마다 마지막 판매 상태'로 센다. 회차 하나의 판매 사건이 한 파티션에 순서대로 온다는 것에 기댄다(ADR-0099 남는 한계, docs/streaming.md §7). Debezium은 WAL의 커밋 순서로 보낸다. 폴링 릴레이도 같은 주문·좌석 사건의 순서를 지켜야 한다. 그런데 지금 로컬 규칙의 `SKIP LOCKED`는, 릴레이가 둘 이상 돌면 잠긴 앞 묶음을 건너뛰고 뒤 사건을 먼저 보낼 수 있다.

## 결정

1. **Outbox 릴레이는 모든 환경에서 폴링 릴레이 하나다(소유자 승인).** Debezium, Kafka Connect, 논리 복제 슬롯을 쓰지 않는다. Redis Stream 릴레이(홀드·구매 세션 사건)는 그대로다.
2. **배치(추천 적용).**
   - Outbox를 쓰는 서비스(purchase·payment·ticket·identity·core·ops)마다 작은 Deployment `<서비스>-outbox-relay`를 둔다. 서비스와 같은 이미지·같은 판이고 시작 명령만 다르다.
   - 복제 2개이고, 쿠버네티스 Lease(정해진 시간 동안만 유효한 권한)로 하나만 보낸다. 리더가 멈추면 다른 하나가 Lease가 끝난 뒤 이어받는다(15초 안 [가정]).
   - 서비스 파드 안에 두지 않는 이유: 요청 파드는 트래픽에 따라 늘고 줄며 배포 때 자주 바뀐다. 따로 두면 그 흔들림과 상관없다. 또 그 서비스가 Outbox로 내는 토픽(예: `trade.orders`)의 쓰기 권한을 릴레이 역할에만 주고 요청 처리 파드의 역할에는 주지 않을 수 있어, 거래 사건이 Outbox를 거치지 않고 나가는 일을 IAM이 막는다. 같은 토픽에 Redis Stream 릴레이도 쓰는 `trade.seats`는 그 릴레이의 역할에도 쓰기 권한을 준다.
   - 자원은 CPU 0.25·메모리 256MiB [가정]이고, 그 서비스와 같은 노드 풀(온디맨드)에 둔다.
   - DB에는 PgBouncer를 거쳐 붙는다(한 묶음이 트랜잭션 하나로 끝나 트랜잭션 풀링과 맞는다). DB 역할 `<서비스>_outbox_relay`는 Outbox 표의 읽기와 `sent_at` 고치기만 한다.
   - MSK에는 docs/devops.md §9.4 규칙대로 워크로드별 MSK 전용 역할을 고정 세션 이름 `<서비스>-outbox-relay-<환경>`으로 맡아 붙는다(JavaScript 서명 도구, docs/streaming.md §2.6).
3. **보내는 규칙(추천 적용).**
   - Outbox 행에 보내는 순서 칸 `seq`(DB 시퀀스로 매긴다)를 둔다. Outbox 행은 트랜잭션의 마지막 문장으로 넣는다.
   - 같은 주문·좌석을 바꾸는 트랜잭션은 앞 트랜잭션이 커밋한 뒤에야 그 행을 잡는다(조건부 UPDATE와 부분 유일 인덱스, ADR-0113). 그래서 뒤 사건의 `seq`가 늘 크다. 서로 관계없는 사건의 `seq`는 커밋 순서와 다를 수 있지만, 그 사이의 순서는 쓰는 곳이 없다.
   - 리더는 100ms [가정]마다(밀린 행이 있으면 쉬지 않고) 트랜잭션 하나에서 이렇게 한다. ① `SELECT … WHERE sent_at IS NULL ORDER BY seq LIMIT 500 FOR UPDATE` ② `seq` 순서로 Kafka에 보내고 모든 확인(`acks=all`)을 기다린다 ③ `UPDATE … SET sent_at = now()` ④ 커밋.
   - `SKIP LOCKED`를 쓰지 않는다. 리더가 바뀌는 순간 옛 리더가 아직 묶음을 잡고 있으면, `SKIP LOCKED`는 그 행을 건너뛰고 뒤 행을 먼저 보낸다. 기다리면 앞 묶음이 보낸 표시를 남긴 뒤에 이어 간다(PostgreSQL READ COMMITTED에서 잠긴 행은 앞 트랜잭션이 커밋한 뒤 조건을 다시 본다).
   - Kafka 생산자는 같은 파티션 안의 순서가 다시 보내기에도 지켜지는 멱등 생산자로 둔다. 구체 설정은 wbs 0.5.1에서 고른 클라이언트로 정한다(ADR-0099). 키(`msg_key`, UTF-8), 값(`payload`, 서비스가 공용 Avro 인코더로 만든 Confluent 형식 바이트, docs/api/avro/README.md §3), 헤더(추적 정보)는 행 그대로 보낸다(ADR-0084).
   - 보내다 실패하면 트랜잭션을 되돌리고(행은 보내지 않은 채 남는다) 0.1초에서 5초 [가정]까지 늘려 가며 다시 한다. 보낸 뒤 표시하기 전에 멈추면 같은 행이 다시 나간다. 받는 쪽은 `eventKey`로 중복을 지운다(ADR-0026 결정 3).
   - 릴레이 트랜잭션은 보내는 동안 열려 있다. 그래서 Kafka 보내기 시간 상한을 10초 [가정]로 두고, 릴레이 역할의 `statement_timeout`·`idle_in_transaction_session_timeout`은 5초·30초 [가정]로 둔다(architecture §5 '시간 초과 기본값'에 행을 더한다).
   - (2026-11-05 보충, BUILD_ORDER PRF-162 코드 리뷰) '마지막 문장'은 업무 문장 가운데 마지막이다. 공용 멱등 모듈이 업무 뒤에 쓰는 결과 참조 갱신(계정 × 키 범위의 행, 사건 순서와 무관)은 Outbox 뒤에 와도 된다. 같은 주문의 뒤 사건 seq가 크다는 약속은 주문 행 잠금을 Outbox INSERT 전에 잡아 커밋까지 쥐는 것으로 지킨다.
4. **정리(추천 적용, ADR-0070·0083의 규칙을 고친다).**
   - Outbox 표는 ID 범위 일 파티션 그대로다(ADR-0114). 3일 [가정] 지난 파티션은 정비 시간에 떼어 내 지운다. 지우기 전에 그 파티션에 보내지 않은 행(`sent_at IS NULL`)이 없는지 본다. 있으면 지우지 않고 SEV2다.
   - 보내지 않은 행을 찾는 부분 인덱스 `(seq) WHERE sent_at IS NULL`을 둔다. `sent_at`을 고치면 행이 이 인덱스에서 빠지므로 HOT 갱신이 아니다. 죽은 행은 3일 뒤 파티션째 지워져 쌓이지 않는다.
   - 없어지는 것: 'Outbox 행은 INSERT만 하고 고치지 않는다'(Debezium Outbox 라우터의 제약), 복제 슬롯 WAL·비활성 경보, `max_slot_wal_keep_size` 확인, `publish.via.partition.root`, 대리 변환기.
5. **지표·경보(추천 적용).**
   - 지표: `outbox_relay_lag_seconds{service}`(가장 오래 기다린 보내지 않은 행의 나이. 두 복제 모두 5초마다 DB에서 잰다), `outbox_relay_published_total`, `outbox_relay_errors_total`, `outbox_relay_batch_seconds`, `outbox_relay_is_leader`.
   - 경보는 SEV2(`kind` cause, `dependency` outbox-relay)다. 지연이 5초 [가정]를 1분 넘게 넘거나, 리더가 1분 넘게 없으면(`outbox_relay_is_leader`의 합이 0이거나 지표가 없으면) 울린다. 런북은 RB-39다.
   - 문서에서 'CDC 지연'이라고 적은 곳(docs/streaming.md §3·§4.5·§9·§12·§15)은 이 지연으로 읽는다.
6. **바꿀 조건(논리 복제를 읽는 릴레이로, 추천 적용).** V-T27에서 아래 가운데 하나가 나오면 Debezium 또는 작은 논리 복제 소비자를 다시 비교한다. 그때 Aurora의 슬롯 WAL 보존(`max_slot_wal_keep_size`를 바꿀 수 있는지)부터 확인한다.
   1. 결제 접수부터 확정까지의 길에서 릴레이 지연 p99가 200ms [가정]를 넘을 때. 내부 1초 예산의 5분의 1이고, 이 길은 릴레이를 한두 번 지난다 [추정].
   2. 설계 피크의 2배 [가정]에서 릴레이의 읽기·표시가 그 DB 쓰기 인스턴스 CPU를 5%p [가정] 넘게 올릴 때.
   3. Outbox 일 파티션의 죽은 행이 청소를 앞질러, 묶음 하나의 처리 시간 p99가 50ms [가정]를 넘을 때.
7. **PgBouncer 배치(추천 적용).**
   - 서비스 DB마다 공용 Deployment 하나를 둔다(`pgbouncer-<DB>`: purchase·payment·ticket·ops·공유 클러스터).
   - 사이드카(서비스 파드마다 하나씩 붙이는 방식)는 쓰지 않는다. 파드마다 풀이 따로 생겨 DB 연결 수가 '파드 수 × 풀 크기'로 늘고, 연결 상한을 한곳에서 지킬 수 없기 때문이다.
   - 복제 3개를 AZ 셋에 하나씩 두고, PodDisruptionBudget(자발적 중단 때 남길 최소 파드 수)은 최소 2다. 앱은 쿠버네티스 Service로 붙는다. 자원은 복제마다 CPU 1·메모리 512MiB [가정]다(PgBouncer는 한 프로세스가 한 코어를 쓴다).
   - 가용성 등급은 그 DB를 쓰는 서비스와 같다(infra-handover §3.4). 복제 하나가 멈추면 남은 복제가 받는다. 트랜잭션 도중 끊긴 요청은 실패하고, 앱의 다시 시도 규칙을 따른다.
   - 노드 풀은 그 DB를 쓰는 서비스와 같다. purchase는 핫패스 풀, payment·ticket·공유 클러스터는 일반 풀, ops는 관제 풀이다(관제 풀을 따로 둔 이유가 그대로 걸린다, ADR-0102). 시간 초과 설정은 architecture §5 그대로이고, 마이그레이션 잡은 지금처럼 거치지 않는다(ADR-0083 결정 4).
   - 풀 크기(`max_client_conn`·`default_pool_size`)는 서비스 파드 수와 DB 연결 상한으로 wbs 2.11.2에서 정한다.
8. **Schema Registry 배치는 같은 날 기술 검토 중간-088이 정한 것을 따른다(추천 적용).** 배치·생산자 규칙·등록 경로의 정본은 docs/api/avro/README.md §3('저장소'·'등록'·'생산자 스키마 ID')과 docs/infra-handover.md §3.2다.
   - EKS 안 Deployment 2개(다른 AZ, 일반 노드 풀, `platform` 네임스페이스)이고, Kafka 그룹으로 뽑힌 리더 하나가 쓰기를 받는다. 스키마는 거래·제어 MSK의 압축 토픽 `_schemas`(복제 3)에 둔다.
   - 생산자는 실행 중에 레지스트리를 부르지 않는다(등록 Job이 쓴 스키마 ID 설정). Outbox 릴레이는 서비스가 넣은 `payload` 바이트를 그대로 보내므로 레지스트리를 부르지 않는다.
   - MSK 연결은 자바 클라이언트 규칙(docs/data.md §4의 7번, docs/devops.md §9.4)을 따른다. Debezium이 빠져, 이 규칙을 쓰는 자바 클라이언트는 직접 띄운 Schema Registry 하나다.
9. **측정·시험(추천 적용).**
   - V-T27: 한 DB에 설계 피크 거래 사건(초당 약 6,300건, docs/streaming.md §11)의 2배 [가정]를 Outbox로 30분 넣는다. 릴레이 지연 p50·p99, 묶음 처리 시간, DB 쓰기 인스턴스 CPU 증가분, Outbox 파티션의 죽은 행을 '실측(PC)'으로 성능 장부에 남기고 결정 6의 숫자와 견준다.
   - V-T28: 순서와 유실을 본다. ① 묶음을 보내는 중인 리더를 멈춘 채(프로세스 정지) Lease를 넘긴다 ② Kafka 브로커를 30초 멈춘다 ③ 릴레이의 DB 연결을 끊는다. 세 경우 모두 빠진 행이 0이고, 같은 주문·좌석의 사건은 `seq` 순서로 도착하며, 다시 보낸 사건은 `eventKey`가 같다.
   - P-T5(결제 확정 p99 3초)는 이제 운영 설계와 같은 릴레이를 지나 잰다.
10. **문서와 일정(추천 적용).**
    - data.md §1·§4의 7번·§5.1, streaming.md, infra-handover §3.2·§4.1·§9, infra.md §10(RB-39), observability §5, devops §9.4, avro README §3, asyncapi, verification §2.7·§9, architecture §5·§6.1, planning/03 POL-022와 용어, planning/01 §5.2, guide/10을 고친다. ADR-0070·0083·0084·0099의 상태 줄에 바뀐 점을 덧붙인다.
    - WBS: 0.3.2는 CDC 슬롯 지표를 빼고 운영 기준 폴링 릴레이(Lease, 순서 규칙, 지표, 서비스별 Deployment)를 넣는다(+0.25일 [가정]). 2.11.2는 PgBouncer·Schema Registry 배치가 정해져 설명만 고친다. 2.12.3에 V-T27·V-T28을 넣는다(+0.5일 [가정]). 4.2.4는 'CDC 슬롯 경보'를 'Outbox 릴레이 밀림 경보'로 바꾼다.

## 검토한 대안 (트레이드오프)

| 대안 | 이런 점이 낫다 | 이런 점이 걸린다 | 판단 | 다시 볼 조건 |
| --- | --- | --- | --- | --- |
| A. 폴링 릴레이 하나(이 결정) | 로컬·v0·운영이 같은 코드라 측정이 운영 길을 대표한다. 자바 실행 기반, 슬롯, WAL 보존 위험, 대리 변환기가 없다. 순서와 다시 보내기를 우리 코드로 설명할 수 있다 | 폴링 주기만큼 늦는다(100ms [가정]). 보낸 표시(UPDATE)가 DB 쓰기를 늘린다. 순서 규칙(`seq`, 마지막에 넣기, 리더 하나, `SKIP LOCKED` 없이)을 지켜야 한다 | 고른다 | 결정 6 |
| B. 운영은 Debezium, 로컬은 폴링(이전 설계) | 커밋 순서로 곧바로 보낸다. 폴링 부하와 표시 UPDATE가 없다 | 측정한 길과 운영 길이 다르다. Kafka Connect·슬롯·WAL 위험·자바 MSK IAM이 운영에만 있다. 배치를 정하지 않았다 | 쓰지 않는다 | 없다(다시 볼 때는 C·D로 본다) |
| C. 모든 환경에 Debezium | 운영과 측정의 길이 같다 | 로컬에도 Kafka Connect와 논리 복제가 필요하다. B의 부품이 그대로다. 이 크기에서 얻는 지연 이득이 작다 | 쓰지 않는다 | 결정 6 |
| D. 작은 논리 복제 소비자를 직접 짜기 | 커밋 순서로 보내고 폴링이 없다. 자바가 없다 | 슬롯 관리, 다시 시작할 위치, 처음 스냅샷을 직접 짠다. Aurora의 슬롯 WAL 보존 위험은 그대로다 | 쓰지 않는다 | 결정 6에서 C와 함께 본다 |
| E. LISTEN/NOTIFY로 깨우고 폴링으로 받치기 | 커밋하자마자 릴레이를 깨운다 | 받는 쪽이 세션 연결을 오래 쥐어야 해 PgBouncer 트랜잭션 풀링 밖으로 붙어야 한다. 100ms 폴링으로 예산을 맞추는 지금은 얻는 것이 작다 | 쓰지 않는다 | 폴링 주기를 줄여도 결정 6의 1이 걸릴 때 |
| F. 서비스 파드 안에서 Lease로 하나만 보내기 | Deployment가 늘지 않는다 | 요청 파드의 확장·배포가 리더를 자주 바꾼다. 요청 파드에 거래 토픽 쓰기 권한이 생긴다 | 쓰지 않는다 | 없다 |

## 결과와 트레이드오프

- Debezium·Kafka Connect가 빠져, 자바 MSK 클라이언트는 직접 띄운 Schema Registry 하나만 남는다. 기술 검토 높음-26 규칙(워크로드별 MSK 전용 역할, 고정 세션 이름, 기본 자격으로 넘어가지 않기)은 그대로이고, 적용 대상에서 Kafka Connect가 빠지고 Outbox 릴레이(JavaScript)가 더해진다.
- 결제 확정 길에 폴링 주기만큼 지연이 더해진다(릴레이 한 번에 최대 약 0.1초 [가정]).
- Outbox 행마다 UPDATE가 하나 더해진다.
- 인수 문서 §3.2에 Outbox 릴레이 행이 생기고 PgBouncer 행이 채워진다(Schema Registry 행은 중간-088이 더했다).
- '운영은 CDC'라는 설계 줄은 빠진다. Debezium 설계는 ADR-0070·0083·0084와 git 이력에 남는다.

## 되돌릴 조건

- 결정 6의 조건이 오면 그때의 사실로 논리 복제 릴레이를 다시 비교한다.
- V-T28에서 같은 주문·좌석 사건의 순서가 뒤집히면, 순서 규칙(결정 3)을 고치고 고칠 때까지 릴레이 복제를 1개로 줄인다.

## 남는 한계

- 순서 보장은 '같은 주문·좌석의 트랜잭션은 잠금으로 줄을 선다'와 'Outbox 행은 마지막에 넣는다'에 기댄다. 이 규칙을 어긴 코드는 V-T28과 코드 검토로만 잡는다.
- 리더가 바뀌는 동안(최대 약 15초 [가정]) 그 서비스의 사건이 늦는다.
- 서비스 DB 사이(예: payment와 purchase)의 사건 순서는 지금처럼 보장하지 않는다.
- 릴레이가 멈춘 동안 사건은 Outbox 표에 쌓여 사라지지 않지만, 결제 확정 알림과 관제 실시간 표가 그만큼 늦는다.
