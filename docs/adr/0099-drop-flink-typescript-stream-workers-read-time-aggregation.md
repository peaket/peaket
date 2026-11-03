# ADR-0099: Flink를 빼고 TypeScript 스트림 작업자와 ClickHouse 조회 시점 집계로 바꾼다 — 관제 실시간 표, 원본 적재, 봇 대기 중 재평가(2026-10-27)

- **상태**: 채택 (2026-10-27. 기술 검토(review/tech-review.md)의 높음-07 'Flink를 더 단순한 방법과 한 번도 비교하지 않았다'를 다시 보던 중, 소유자가 "자바를 백엔드에 사용하지도 않는 프로젝트에서 Flink를 도입할 가치가 충분히 있을까요? 아니면 더 합리적인 대안이 있나요?"라고 물었다. 검토 의견(같은 문서 §12.3, Kafka Connect + ClickHouse 머티리얼라이즈드 뷰와의 추가 비교 포함)을 본 뒤 "B안으로 정하고 다른 대안들에 대한 트레이드오프도 표로 정리해주세요."라고 정했다. 방향(B안)은 소유자 결정이고, 작업자 이름·표 모양·설정값·시험·일정 같은 세부는 추천 적용 2026-10-27이다. 수치는 [가정]이다. ADR-0071·0072의 Flink 실행 기반과 연산자 설계는 이 ADR로 대신한다. ADR-0071에서 이어받는 규칙(지표 출처 표, 심장 박동과 끝에서 끝까지 신선도, 봇 A안·패턴 숫자·격리 상한·그림자 기본, 판매 좌석 상태 규칙, 텔레메트리 키)은 그대로 둔다.) 2026-10-28(기술 검토 높음-26, 소유자 승인 '추천안 동의'): '남는 한계'의 MSK IAM Pod Identity 재인증 문제에 규칙을 둔다. 작업자·서비스·Debezium의 Kafka Connect 등 MSK에 IAM으로 붙는 클라이언트는 워크로드별 MSK 전용 역할을 고정 세션 이름으로 맡고, 역할을 못 맡으면 기본 자격으로 넘어가지 않고 실패한다. 작업자의 토큰 함수는 `generateAuthTokenFromRole`이다(docs/streaming.md §2.1·§2.3·§2.6·§10 ST-T14, docs/devops.md §9.4). 자격 갱신 주기를 넘겨 이어지는지는 실제 MSK에서 확인할 때까지 확인 필요로 남는다. 2026-10-28(ADR-0116, 소유자 승인 '추천안 동의'): 맥락의 'Outbox 릴레이 Debezium(Kafka Connect에서 돈다)'은 서비스별 폴링 릴레이(TypeScript)로 바뀌었다. 위 높음-26 규칙의 적용 대상에서 'Debezium의 Kafka Connect'가 빠지고 Outbox 릴레이가 더해지며, 남는 자바 MSK 클라이언트는 직접 띄운 Schema Registry다. 남는 한계의 'TypeScript 작업자와 Debezium에도 남는다'는 'TypeScript 작업자·Outbox 릴레이와 Schema Registry에 남는다'로 읽는다. 2026-10-28(기술 검토 낮음-033, 소유자 승인 '추천안 동의'): 결정 6의 재평가 키는 `tr:ra:dev:{deviceRef}:E`·`tr:ra:fp:{지문}:E`(넘음 표시는 뒤에 `:over`)로 이름을 바꿔, 해시 태그를 회차가 아니라 기기 가명·지문에 둔다. 스크립트가 함께 쓰는 키는 그 키와 넘음 표시 키뿐이라 같은 슬롯이면 되고, 판정 피처 키와 같은 규칙으로 한 회차의 키를 여러 샤드에 흩는다(docs/streaming.md §5.8, docs/data.md §3). 2026-10-28(기술 검토 낮음-152, 소유자 승인 '추천안 동의'): 결정 2의 '클라이언트(kafkajs 또는 Confluent 공식 클라이언트)는 wbs 0.5.1 PoC에서 정한다'를 '기본은 Confluent 공식 클라이언트 `@confluentinc/kafka-javascript`이고 kafkajs는 대체안이다. wbs 0.5.1 PoC는 기본안이 처리량·협력적 재조정·OTel 계측·MSK IAM을 채우는지 확인하고, 못 채우면 kafkajs와 견준다'로 바꾼다(docs/streaming.md §2.1 표 'Kafka 클라이언트' 행과 같은 뜻). 2026-10-29(소유자 결정, ADR-0150): 결정의 `OrderEvent.firstInStage`·`HoldAttempt.firstHeldInSession`은 선택 필드(기본 null)가 아니라 기본값 false다. false인 사건을 퍼널에 세지 않으므로 '표시가 없는 옛 메시지는 세지 않는다'와 결과가 같다. 2026-11-01(정합 점검, ADR-0177 해설서 검토 네 번째 묶음): 결정 1 표의 저장소 칸 `peaket-data`·`peaket-trust`는 공개 모노레포 `peaket`의 `services/<작업자 이름>`으로 읽는다(ADR-0165·0169, docs/streaming.md §13). 작업자는 셋이 아니라 넷이다. 2026-10-31에 부정 예매 사후 조사의 원천 적재 작업자 `inv-ingest`를 더했다(추천 적용, ADR-0171, docs/streaming.md §1). 넷은 상태를 서로 나눠 쓰지 않는다.
- **관련**: ADR-0026, ADR-0039, ADR-0042, ADR-0052, ADR-0053, ADR-0054, ADR-0068, ADR-0071, ADR-0072, ADR-0078, ADR-0082, ADR-0097, NFR-009, NFR-022, NFR-026, POL-006, POL-028, [docs/streaming.md](../streaming.md)(다시 씀), [docs/features/analytics.md](../features/analytics.md) §2·§3·§4.4·§5.5·§11, [docs/features/queue-admission.md](../features/queue-admission.md) §7, [docs/features/control-tower.md](../features/control-tower.md), [docs/observability.md](../observability.md) §5·§8, [docs/verification.md](../verification.md) §3.7, docs/api/asyncapi.yaml(`OrderEvent`·`HoldAttempt` 필드), wbs 4.3.1·4.3.3·4.3.9·4.6.2, [review/tech-review.md](../review/tech-review.md)(높음-07, §12.3)

## 맥락

- **언어**: Flink 잡 셋(원본 적재 `analytics-ingest`, 관제 실시간 표 `ops-rt`, 봇 대기 중 재평가 `trust-reassess`)은 이 프로젝트에서 유일하게 자바로 짜는 업무 코드였다.
  - 백엔드 서비스 10개는 NestJS(Node.js)다.
  - Kafka(MSK), Outbox 릴레이 Debezium(Kafka Connect에서 돈다), Schema Registry도 자바로 만든 서버다. 그러나 설정만 하는 완제품이라 언어가 문제 되지 않는다.
  - Flink 잡은 DataStream API로 연산자를 직접 짜는 코드다. 그래서 같은 규칙(가명 처리, 지표 규칙, `eventKey`, Avro 계약 클래스)이 TypeScript·SQL(dbt)·자바 세 곳에 생기고, 빌드(Gradle·Java 17)·시험·보안 패치·MSK IAM 클라이언트도 한 갈래씩 늘었다.
- **일의 크기와 모양**:
  - 입력은 피크 약 1만 건/초, 시험 3만 건/초다. 초당 20만 건의 진입은 queue-svc가 1초 단위로 미리 합쳐 보내므로 스트림 처리까지 오지 않는다(ADR-0026).
  - 상태는 합쳐 1GB 안이다(중복 제거 약 100MB, 좌석 판매 상태 약 300MB, 재평가 약 250MB [추정]).
  - 원본 적재는 상태가 없다. 관제 실시간 표는 중복을 지우고 누적과 1초 칸을 센다. 재평가는 10분 안에 같은 기기나 같은 행동 요약값으로 들어온 서로 다른 사람을 센다.
  - 세션 창과 CEP(순서 있는 사건에서 패턴을 찾는 기능)는 일부러 쓰지 않았다(ADR-0071 결정 6).
- **Flink를 써서 생긴 장치**: Flink가 다른 도구보다 확실히 잘하는 일은 초당 수십만 건이 넘는 입력, 수십 GB가 넘는 상태, 사건 시각 기준의 복잡한 창, 순서 패턴, 여러 흐름을 시간으로 맞붙이기, 과거를 같은 상태로 다시 계산하기다. 이 설계는 그 일을 쓰지 않는다. 오히려 Flink 때문에 생긴 장치가 있었다.
  - 빈 파티션이 워터마크(이 시각 전 사건은 다 왔다고 보는 표시)를 붙잡지 않게 하는 규칙
  - Kafka 보관 7일보다 긴 누적을 다시 만드는 시작값 절차
  - 세이브포인트(업그레이드 때 남기는 작업 상태 저장본) 호환 시험
  - 대기 JobManager와 예비 TaskManager, 상태 버킷
  - 제공사가 시험하지 않은 판에서 도는지 봐야 하는 ClickHouse 커넥터와 자바 MSK IAM 라이브러리의 PoC
  - 남는 한계 셋(재시작 직후 누적이 잠깐 뒤로 감, 시작값 경계의 재발행 중복, 지표 규칙을 dbt와 자바 두 곳에 둠)
- **기술 검토 2판의 추천을 바꾼 이유**: 2판은 'Flink를 남기고 단순한 기준선과 비교해 잰다'를 추천했다. 잡마다 다시 따져 보니, 단순한 길이 정확도와 부품 수에서 같거나 낫다는 것을 측정 전에도 구조로 보일 수 있었다. 결과가 뻔한 비교를 하려고 Flink를 만드는 것은 기술을 끼워 맞추지 않는다는 원칙(ADR-0097)과 맞지 않는다.
- **확인한 사실(2026-10-27 원문)**:
  - Confluent 공식 JavaScript Kafka 클라이언트 `@confluentinc/kafka-javascript`(1.11.0)는 librdkafka 기반이고, KafkaJS와 같은 모양의 설정에서 OAUTHBEARER 토큰 함수를 받는다. Schema Registry용 `@confluentinc/schemaregistry`(1.11.0)와 ClickHouse 공식 Node 클라이언트 `@clickhouse/client`(1.24.1)가 있다. AWS의 JavaScript MSK IAM 서명 도구 `aws-msk-iam-sasl-signer-js`(1.0.3)는 기본 자격 사슬 말고 역할을 맡아(`generateAuthTokenFromRole`) 토큰을 만들 수도 있다.
  - ClickHouse는 매개변수 뷰(조회할 때 값을 넘겨 쓰는 뷰)를 지원한다. 26.2부터 모든 삽입의 중복 판정(`deduplicate_insert`)이 기본으로 켜지고, `insert_deduplication_token`으로 삽입에 직접 이름을 붙일 수 있다. 머티리얼라이즈드 뷰는 넣는 묶음에만 도는 트리거이고, 뷰 오류는 기본값(`materialized_views_ignore_errors` 끔)에서 원본 삽입까지 실패시킨다. Kafka 엔진은 `AWS_MSK_IAM` 인증을 받는다.
  - ClickHouse Kafka Connect 싱크(1.7.0)의 정확히 한 번(기본 꺼짐)은 다시 보낼 때 같은 묶음을 만들어 ClickHouse의 같은 묶음 거르기에 맡기는 방식이다. 그래서 Kafka 메시지 한 줄이 두 번 들어가는 것까지만 막는다. Kafka Connect의 기본 변환 16종에는 키를 쓰는 해시가 없고, 데드 레터 토픽은 실패한 메시지를 그대로 받는다. Debezium FAQ는 Kafka Connect가 갑자기 멈췄다 다시 뜨면 같은 사건을 다시 보낼 수 있다고 적는다.
  - RisingWave 3.1.0(2026-09-21, Apache-2.0)은 서빙·스트리밍·메타·압축 노드로 나뉘고, 영속 데이터를 객체 저장소에 둔다. Kafka 원천은 Avro·Schema Registry·MSK IAM을 받고, ClickHouse 싱크는 복구 중 중복 쓰기가 생길 수 있어 ReplacingMergeTree를 권한다. JavaScript 함수는 내장 QuickJS에서 돌고 외부 네트워크에 닿지 못한다.
  - Flink 2.2 SQL은 `MATCH_RECOGNIZE`로 순서 패턴을 쓰고, PyFlink로 Python 잡을 쓸 수 있다. Amazon Managed Service for Apache Flink는 자바·스칼라·Python·SQL 잡을 돌린다. AWS는 관리형 Kafka Connect(MSK Connect)도 둔다.

## 결정

1. **Flink를 쓰지 않는다(소유자 결정 B안).** 잡 셋은 같은 이름의 TypeScript 스트림 작업자(Kafka 토픽을 계속 읽어 ClickHouse·Redis·Kafka에 쓰는 작은 서비스)로 바꾼다.

   | 작업자 | 저장소 | 하는 일 | 쓰는 곳 | 노드 |
   | --- | --- | --- | --- | --- |
   | `analytics-ingest` | peaket-data | 원본 적재(회차별 가명, 금지 필드 제거, 거절 기록) | 브론즈, `bronze.brz_rejected` | Spot 허용 |
   | `ops-rt` | peaket-data | 관제 실시간 표의 원시 사건 적재(집계하지 않는다) | `rt` 원시 표 | 온디맨드 |
   | `trust-reassess` | peaket-trust | 봇 대기 중 재평가와 행동 신호 원시 적재 | 세션·캐시 Redis, `telemetry.trust-candidates`, `trust.behavior_raw` | 온디맨드 |

   작업자는 서비스와 같은 Node.js·NestJS 판의 독립 실행 앱이고(HTTP는 상태 확인과 지표만 연다), 쿠버네티스 Deployment로 2개씩 [가정] 띄운다. 심장 박동 발행기 `rt-pulse`는 그대로 둔다.

2. **공용 소비 규칙(추천 적용).** peaket-platform의 스트림 소비 모듈(`@peaket/stream-worker`)에 둔다. 클라이언트(kafkajs 또는 Confluent 공식 클라이언트)는 wbs 0.5.1 PoC에서 정한다.
   - 자동 커밋은 끈다. 쓰기(ClickHouse 삽입, Redis 스크립트, Kafka 발행)가 성공했다는 답을 받은 뒤에만 그 묶음의 오프셋을 커밋한다. 그래서 작업자가 죽어도 빠지는 것이 없고, 다시 읽은 것은 읽는 쪽이 중복을 지운다(ADR-0026 결정 3).
   - 묶음은 파티션마다 만들고, 삽입마다 `insert_deduplication_token`(토픽·파티션·첫 오프셋·끝 오프셋)을 붙인다. 같은 묶음을 다시 보내면 ClickHouse가 거른다. 재시작 뒤 묶음 경계가 달라져 생긴 중복은 실버와 조회 시점 집계가 흡수한다.
   - 실패한 묶음은 버리지 않는다. 지수 지연(0.2초에서 최대 30초 [가정])으로 다시 시도하고, 그동안 그 파티션의 소비를 멈춘다. ClickHouse가 멈추면 누락 대신 신선도가 나빠지고, 회복하면 밀린 것을 이어 싣는다.
   - 읽지 못한 레코드는 원문을 복사하지 않고 위치만 남긴다. 원본 적재는 `bronze.brz_rejected`에, 나머지는 거절 수와 위치 로그에 남긴다. 데드 레터 토픽은 두지 않는다(ADR-0072 결정 7).
   - 재조정(소비자 그룹 안에서 파티션을 다시 나누는 일)과 종료 때는 처리 중인 묶음을 마치고 커밋한 뒤 파티션을 넘긴다. 마치지 못한 묶음은 커밋하지 않는다. 작업자에는 상태가 없어, 다시 뜨면 커밋한 위치에서 이어 읽는다.

3. **원본 적재(추천 적용).** `analytics-ingest`는 지금 규칙을 그대로 TypeScript로 옮긴다.
   - 토픽 10개를 읽는다.
   - 회차 키는 KMS `GenerateMac`으로 회차마다 한 번 얻어 메모리에만 두고, 가명은 서비스와 같은 가명 처리 라이브러리로 만든다.
   - 금지 필드를 지우고, 원천별 브론즈 표에 쓰고, 거절 기록을 남긴다.
   - 가명 키를 못 얻으면 원문을 쓰지 않고 멈춘다(fail-closed).
   - '적어도 한 번'과 (파티션, 오프셋) 커버리지 대조(analytics §7)를 그대로 쓴다.

4. **관제 실시간 표는 원시 사건 + 조회 시점 집계다(추천 적용).**
   - `ops-rt`는 거래 4개 토픽(`trade.orders`·`trade.payments`·`trade.seats`·`trade.tickets`. 첫 홀드는 생산자 표시로 세므로 `trade.purchase-sessions`는 읽지 않는다)과 텔레메트리 3개 토픽의 사건을 `rt` 원시 표 다섯(`rt.sale_event`, `rt.queue_aggregate`, `rt.hold_attempt`, `rt.verdict`, `rt.pulse`)에 그대로 쓴다. 사람 식별값은 싣지 않는다. 중복이 들어와도 되므로 일반 복제 엔진(ReplicatedMergeTree)을 쓰고, 병합 때의 중복 제거에 기대지 않는다.
   - ops-svc의 `an_rt_reader`가 회차마다 0.5초 [가정]에 한 번 매개변수 뷰(`rt.v_cumulative`, `rt.v_bucket`, `rt.v_freshness`)를 읽는다. 결과는 회차마다 한 번만 계산해 콘솔 구독과 파트너 판매 현황(1분 지연)에 나눠 준다.
   - 세는 규칙(정의는 지표 사전과 같다):
     - `eventKey`마다 가장 이른 Kafka 위치의 한 줄만 남긴다.
     - 판매 좌석은 좌석마다 그 순서의 마지막 판매 상태가 SOLD인 수다. 회차 하나의 판매 사건은 한 파티션에 순서대로 온다(ADR-0026).
     - 판매 금액은 승인 합에서 입금 되돌림을 뺀다.
     - 확정 주문은 확정을 더하고 입금 되돌림을 뺀다. 발권 티켓은 발권을 더하고 무효를 뺀다.
     - 퍼널 단계는 생산자가 실은 '처음' 표시로 센다(결정 5).
     - 대기열 누적은 `QueueAggregate`의 합이다.
     - 1초 칸은 사건 시각을 초로 자른 칸(`toStartOfSecond`)으로 세고, 끝난 칸만 그린다.
   - 워터마크·허용 지연·누적 상태·시작값 절차(`rt.seed`)·세이브포인트가 없어진다. 늦게 온 사건도 버리지 않고 제 칸에 들어간다. 재시작해도 숫자가 뒤로 가지 않는다.
   - 보존은 판매 기간과 마감 대조를 덮도록 `rt.sale_event`·`rt.queue_aggregate`·`rt.hold_attempt` 400일, `rt.verdict` 90일, `rt.pulse` 7일이다 [가정]. 판매 기간이 보존 기간보다 긴 회차의 문제(기술 검토 중간-090)가 함께 풀린다.
   - 미리 합산(머티리얼라이즈드 뷰)은 읽기 비용이 커질 때의 첫 단계로만 쓰고, 중복에 안전한 숫자(퍼널 단계와 1초 칸을 `eventKey`의 서로 다른 개수로 세기)에만 쓴다. 판매 금액·대기열 누적·판매 좌석은 계속 읽을 때 센다. 뷰는 실시간 원시 표에만 걸고 브론즈에는 걸지 않는다(뷰 오류가 원본 삽입을 실패시키므로).
   - 실시간 숫자는 잠정이고 확정 숫자로 고쳐 쓰지 않는다(analytics §4.4, 그대로).

5. **퍼널의 '처음' 표시는 생산자가 싣는다(추천 적용, 계약 보강).**
   - `OrderEvent.firstInStage`(그 주문이 이 단계에 처음 들어올 때 true)와 `HoldAttempt.firstHeldInSession`(그 구매 세션의 첫 HELD일 때 true)을 선택 필드(기본 null)로 더한다.
   - purchase-svc가 주문 상태 기록과 구매 세션 상태로 정한다. 그래서 실시간 표에 주문·구매 세션 ID를 싣지 않아도 '주문마다 한 번'을 센다.
   - BACKWARD_TRANSITIVE 호환이고 소비자를 먼저 배포한다. 표시가 없는(null) 옛 메시지는 퍼널에 세지 않는다.

6. **봇 대기 중 재평가(추천 적용, 소유자 승인 A안의 규칙 그대로).**
   - `trust-reassess`는 `telemetry.behavior`를 읽어, 세션·캐시 Redis(판정 피처와 같은 클러스터)의 R1(회차·기기 가명)·R2(회차·요약값 지문) 키마다 '처리 시각을 점수로 둔 정렬 집합'에 pid를 넣는다.
   - Lua 스크립트 하나로 넣기 → 10분보다 오래된 것 지우기 → 서로 다른 pid 수 세기 → 문턱(5·20)에 닿으면 넘음 표시(10분)를 켜고 모든 pid를 후보로 내기를 한 번에 한다. 넘음 표시가 켜져 있는 동안 새 pid는 바로 후보로 낸다. 키 수명은 10분이다.
   - 후보 형식·`eventKey`·그림자 기본·격리 상한·trust-svc 처리(docs/streaming.md §5.4~§5.6)는 그대로다. 행동 신호 원시 표(`trust.behavior_raw`, 30일)도 이 작업자가 싣는다.

7. **신선도와 누락률(추천 적용, NFR-009 목표 그대로).**
   - SLI는 `rt_freshness_seconds{path}`다. 누적 길은 '지금 − 텔레메트리 셋의 모든 파티션 가운데 가장 늦은 파티션의 마지막 심장 박동 발행 시각'이고, 1초 칸 길은 끝난 칸을 기준으로 잰다. 1분 p95가 5초 미만이면 합격이다.
   - 지연 예산: 생산자 묶음 0.05초 [가정] + 작업자 묶음 0.25초 [가정] + 비동기 삽입 반영 최대 0.2초 + 조회 주기 0.5초 [가정] + 조회 실행 0.05초 [추정] + 푸시·그리기 0.3초 [추정] = 약 1.4초다. 1초 칸은 약 2.4초다 [추정]. Flink 설계는 약 2.3초·3.9초였다.
   - 누락률은 (읽지 못해 거절한 수 + 텔레메트리 생산자가 버린 수) ÷ 전체다. 작업자는 늦은 사건과 실패한 묶음을 버리지 않는다.
   - Degraded 전환(3분 넘게 5초 초과 → Prometheus 대체 표시, 5분 [가정] 정상이면 복귀)은 그대로다(ADR-0071 결정 5, ADR-0078).

8. **실행 기반과 운영(추천 적용).**
   - **없앤다**: Flink Kubernetes Operator, FlinkDeployment, JobManager·TaskManager, RocksDB, 상태 버킷 `peaket-flink-state-<환경>`, Flink 관리 화면 잠금과 내부 TLS 판단, `flink/common` Maven 패키지, Gradle·Java 17 빌드, 차트 `peaket-flink-job`.
   - **배포 기준**: 작업자는 서비스와 같은 이미지·차트·보안 기준(Pod Security Restricted, 네트워크 정책, Pod Identity, 메시 앰비언트 L4)을 쓴다.
   - **자원**: `ops-rt` CPU 1·메모리 1GiB, `analytics-ingest` CPU 1·1GiB, `trust-reassess` CPU 0.5·512MiB이고, 2개씩이다 [가정, wbs 4.3.9에서 확정]. 합은 CPU 5개·메모리 5GiB로, Flink 설계(CPU 15.5개·31GiB)의 약 3분의 1이다 [가정].
   - **판 올리기**: 롤링이다. 새 파드가 준비된 뒤 옛 파드를 멈추고, 옛 파드는 처리 중인 묶음을 마쳐 커밋한 뒤 그룹에서 나간다. 동결 창·마감 실행 중 배포 금지는 그대로다(POL-028).
   - **지표**: `stream_consumer_lag_records`, `stream_insert_seconds`, `stream_insert_retries_total`, `stream_rejected_total`, `stream_paused_partitions`, `rt_query_seconds`, `rt_freshness_seconds`.
   - **경보**: 'Flink 잡 신호'를 '스트림 작업자 신호'로 바꾼다. 모두 SEV3(hygiene)다.
     - 10분 안 재시작 3회
     - 소비 밀림이 10분 동안 계속 늘어남
     - 온세일 윈도우 안에서 거래 토픽에 60초 넘게 사건이 없음
     - 삽입 재시도가 5분 넘게 이어짐
     - 거절 1건 이상
     - 조회 시점 집계 p95가 0.25초를 10분 넘게 넘음 [가정]
     
     재평가 격리 상한 도달은 그대로 control이다.
   - **바꾼 이름**: 런북 RB-34는 '스트림 작업자 복구'로 바꾼다. 시험 D-T20은 '스트림 작업자 판 올리기(롤링 중 커밋한 위치에서 이어 읽고 숫자가 정답과 같다)'로, Game Day G-07은 '스트림 작업자 밀림 주입'으로 바꾼다.

9. **바꿀 조건(B안에서 스트리밍 엔진으로, 추천 적용).** 아래 가운데 하나가 오면 그 시점의 사실로 스트리밍 엔진(Flink SQL과 관리형 Flink, RisingWave)을 다시 비교한다. 숫자는 [가정]이고 V-T19로 정한다.
   1. 조회 시점 집계가 신선도 목표를 위협할 때: 회차당 조회 p95가 조회 주기의 절반(0.25초)을 넘거나, 온세일 중 ClickHouse CPU가 경보 기준을 넘을 때다. 먼저 중복에 안전한 숫자를 미리 합산하고 회차별 조회를 묶는다. 그래도 넘으면 엔진으로 간다.
   2. 순서 패턴(CEP)이나 세션 창이 필요해질 때: 예를 들어 개인정보 판단을 다시 해 순서 있는 서버 사건의 계약을 새로 정할 때다. 그때는 Flink SQL의 `MATCH_RECOGNIZE`가 진짜 이유가 된다.
   3. 여러 흐름을 시간 기준으로 맞붙이는 실시간 기능이 생길 때: 예를 들어 결제·좌석·봇 신호를 합친 실시간 위험 점수다.
   4. 재평가 상태가 Redis 예산을 넘거나, 입력이 초당 수십만 건으로 커질 때다.

10. **측정(추천 적용).**
    - V-T12~V-T15를 B안으로 고친다. 기준은 그대로다.
    - V-T19를 새로 둔다. 입력을 초당 3만 건에서 늘려 가며 신선도 p95가 5초를 넘거나 ClickHouse가 포화되는 지점을 성능 장부에 남기고, 그 값을 바꿀 조건 1의 숫자로 쓴다.
    - 성능 장부 필드 `rt_checkpoint_ms`는 `rt_query_p95_ms`(조회 시점 집계 p95)로 바꾼다.
    - 시험 포인트 ST-T1~ST-T12는 docs/streaming.md §10에서 B안으로 다시 쓴다.

11. **보안·데이터(추천 적용).**
    - ClickHouse 사용자의 권한을 고친다. `bronze_writer`(원본 적재)와 `trust_raw_writer`(재평가)는 그대로다. `rt_writer`(`ops-rt`)는 `rt` 원시 표 쓰기만 하고, `rt.seed`는 없앤다. ops-svc의 `an_rt_reader`는 `rt` 뷰와 `bronze.brz_ref_seat_map`(잔여석 계산)을 읽는다. 마감 실행기의 `an_transform`은 마감 대조 때 `rt` 뷰를 읽고, 원시 표를 다시 채울 때 `rt`에 쓴다(docs/streaming.md §4.7).
    - 실시간 원시 행에는 개인정보가 없다(데이터 분류표 행을 고친다).
    - Flink 상태(체크포인트·세이브포인트) 분류 행, 상태 버킷 암호화, Flink 관리 화면·JNDI 항목은 없앤다. asvs/analytics의 1.3.8·13.4.5 근거는 작업자 기준으로 고친다.

12. **문서와 용어(추천 적용).**
    - docs/streaming.md를 이 결정대로 다시 쓴다. 절 번호는 그대로 두고, §16에 대안과 바꿀 조건을 둔다.
    - 용어 사전은 '실시간 표 덮어쓰기'를 '조회 시점 집계'로 바꾸고 '스트림 작업자'를 더한다. 워터마크·체크포인트(Flink의 뜻)·세이브포인트는 '이 설계는 쓰지 않는다(ADR-0099)'를 붙여 남긴다. 옛 ADR과 대안 비교를 읽을 때 쓴다.
    - architecture §6.1 '일부러 쓰지 않거나 미룬 기술' 표에 Flink·RisingWave·Kafka Connect 합산 행을 둔다.

13. **일정(WBS, 추천 적용).**
    - 4.3.1 −1일: Flink 실행 기반·시작값 PoC를 빼고 공용 소비 모듈·원시 표·매개변수 뷰·회차별 캐시를 넣는다.
    - 4.3.3 +0.25일: 퍼널 '처음' 표시를 넣는다.
    - 4.3.9 +0.5일: V-T19를 넣는다.
    - 4.6.2 −0.25일: 세이브포인트 업그레이드·호환 시험을 빼고 작업자 판 올리기 시험을 넣는다.
    - 4.3.4·4.3.8·4.7.1과 3.2.2는 설명만 고친다.
    - 합계는 449.25일 → 448.75일이다 [가정].

## 검토한 대안 (트레이드오프)

| 대안 | 이런 점이 낫다 | 이런 점이 걸린다 | 판단 | 다시 볼 조건 |
| --- | --- | --- | --- | --- |
| B. TypeScript 스트림 작업자 + ClickHouse 조회 시점 집계 + Redis(이 결정) | 이미 있는 부품(NestJS·ClickHouse·Redis)과 한 언어로 끝난다. 판매 숫자가 확정 숫자와 같은 사건·같은 키·같은 SQL에서 나온다. 늦은 사건도 버리지 않고, 재시작해도 숫자가 뒤로 가지 않는다. 실시간 표에 사람 식별값이 없다. 운영 자원이 약 3분의 1이다 [가정] | 읽을 때 계산하는 비용이 ClickHouse에 걸린다(대형 회차 판매 사건 약 27만 개, 한 번에 수십 ms [추정]). '적어도 한 번' 소비자를 직접 바르게 짜야 한다. Node.js 소비자는 한 스레드라 파티션 수(토픽마다 12개 [가정])까지만 늘어난다 | 고른다 | 결정 9 |
| A. Flink 잡 셋(ADR-0071·0072, 이전 설계) | 입력과 상태가 크게 늘어도 같은 구조로 간다. 사건 시각 처리, 상태 복구, 과거 재계산(세이브포인트)이 엔진에 들어 있다. 널리 쓰이는 엔진이다 | 자바 업무 코드와 Gradle·Maven 빌드가 생겨 규칙이 세 언어에 나뉜다. 워터마크·시작값·세이브포인트 장치, 제공사 시험 범위 밖 커넥터, 운영 자원 CPU 15.5개·31GiB [가정], 남는 한계 셋 | 쓰지 않는다 | 결정 9의 조건 2~4, 또는 조건 1에서 미리 합산으로도 모자랄 때 |
| H. Flink SQL만(자바 연산자 없이) | 업무 규칙을 SQL로 쓴다 | ClickHouse 공식 Flink 커넥터는 DataStream만 지원하고, 회차별 KMS 가명 처리는 자바 함수가 필요하다. 실행 기반(JobManager·TaskManager·체크포인트)은 A와 같다 | 쓰지 않는다 | 엔진이 필요해지면 A의 첫 형태로 본다 |
| F. 관리형 Flink(Amazon Managed Service for Apache Flink) | Operator·HA·상태 저장소 운영을 클라우드 업체가 맡는다. 자바·스칼라·Python·SQL 잡을 돌린다 | 잡 코드와 워터마크·세이브포인트 같은 Flink 장치는 그대로다 | 쓰지 않는다 | A를 다시 고를 때 함께 본다 |
| C. RisingWave(러스트로 만든 스트리밍 데이터베이스, PostgreSQL처럼 SQL을 받는다) | 자바가 없고 SQL로 쓴다. 입력이 들어올 때마다 결과를 고쳐 두는 뷰라 읽기가 싸다. Kafka(Avro·Schema Registry·MSK IAM)를 읽는다 | 운영할 분산 시스템이 하나 더 생긴다(서빙·스트리밍·메타·압축 노드, 객체 저장소 상태, 메타 저장 DB). ClickHouse로 보낼 때 복구 중 중복이 생길 수 있다. JavaScript 함수가 외부 네트워크에 닿지 못해 KMS 가명 처리를 안에서 할 수 없으므로, 원본 적재는 따로 필요하다 | 쓰지 않는다 | 결정 9의 조건 1·4에서 SQL로 계속 쓰고 싶을 때 Flink SQL과 함께 본다 |
| G. Kafka Connect + ClickHouse 머티리얼라이즈드 뷰 | 적재 코드를 짜지 않는다. 싱크가 Kafka 메시지 한 줄을 한 번만 넣는다(정확히 한 번 모드). 읽기가 가장 싸다. AWS 관리형(MSK Connect)도 있다 | 회차별 KMS 가명 처리에 자바 변환기가 필요하다. 데드 레터 토픽이 원문을 한 벌 더 만든다. 토픽 하나가 표 하나로 간다. 뷰는 Kafka 안의 중복(Debezium 재전송 등)을 두 번 더하고, 규칙을 고치면 지난 숫자를 다시 넣어야 하며, 뷰 오류가 원본 삽입을 실패시킨다 | 쓰지 않는다 | 적재하면서 바꿀 일이 없고 Kafka 위치만으로 중복을 가려도 되는 데이터를 많이 실을 때 |
| D. ClickHouse만(Kafka 엔진 + 머티리얼라이즈드 뷰) | 새 부품이 없다. Kafka 엔진이 MSK IAM을 받는다 | 가명 처리 전 식별값이 ClickHouse에 들어간다(키를 ClickHouse에 둘 수 없다). 뷰가 Kafka 안의 중복을 두 번 센다. 봇 재평가 같은 '문턱을 넘으면 내보내기'에 맞지 않는다 | 쓰지 않는다. 미리 합산이 필요하면 중복에 안전한 숫자에만 뷰를 쓴다(결정 4) | 없다 |
| E. Kafka Streams·ksqlDB·Spark | 성숙한 도구다 | 모두 JVM이고, 이 일에서 Flink보다 나은 점이 없다 | 쓰지 않는다 | 없다(엔진이 필요하면 A·C를 본다) |

## 결과와 트레이드오프

- ADR 98 → 99개, docs/streaming.md를 다시 썼다. 문제 대장 R-117, 질문 60, WBS 193개·449.25일 → 448.75일, 용어 211 → 212개다. NFR 목표값은 그대로이고 NFR-009의 수단을 고친다.
- 자바 업무 코드와 Flink 실행 기반이 없어진다. 규칙은 TypeScript(적재·재평가)와 SQL(실시간·확정)에 있다.
- 실시간 원시 표에 사람 식별값이 없다. Flink 설계는 주문·구매 세션 ID를 상태와 체크포인트(S3)에 두었다.
- 남는 한계 셋(시작값 경계 재발행 중복, 재시작 직후 숫자가 뒤로 감, 커넥터·자바 MSK IAM 확인)이 없어진다.
- 대가는 셋이다. 조회 시점 집계의 비용, 소비자 정확성을 우리 코드가 맡는다는 점, 생산자 표시 계약이다.
- 'Flink를 썼다'는 줄은 포트폴리오에서 빠진다. Flink 설계는 ADR-0071·0072와 git 이력(develop d10c955까지의 docs/streaming.md)에 남는다.

## 되돌릴 조건

- 결정 9의 바꿀 조건이 오면 그때의 사실로 엔진을 다시 비교한다.
- V-T12에서 신선도 p95가 5초를 넘으면 작업자 묶음·조회 주기를 고치고, 그래도 넘으면 미리 합산(결정 4)을 쓴다.
- ST-T9에서 실시간 숫자가 골드와 다르면 지표 사전과 뷰 규칙을 같은 PR에서 맞춘다.

## 남는 한계

- 조회 시점 집계의 비용은 측정 전 [추정]이다(V-T12·V-T19).
- 판매 좌석의 순서는 회차 하나의 판매 사건이 한 파티션에 온다는 키 규칙(ADR-0026 결정 1)에 기댄다. 키 규칙을 바꾸면 생산자가 늘어나기만 하는 순번을 실어야 한다.
- 퍼널의 '처음' 표시가 틀리면 퍼널도 틀린다. ST-T9(골드 대조)로만 잡는다.
- 재평가 상태는 세션·캐시 Redis에 있어, Redis 장애나 메모리 정리로 키가 지워지면 최대 10분의 문맥을 잃는다. Flink 설계도 세이브포인트가 맞지 않으면 같았다.
- Node.js 소비자의 파티션당 처리량은 측정 전이다(wbs 0.5.1, 4.3.9).
- MSK IAM의 Pod Identity 재인증 문제(기술 검토 높음-26)는 TypeScript 작업자와 Debezium에도 남는다 [확인 필요].
- R1이 공용 기기를 잡을 수 있고, R2가 잡음을 섞어 재생하는 봇을 놓친다는 한계는 그대로다(docs/streaming.md §15).
