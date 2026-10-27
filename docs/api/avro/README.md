# Avro 이벤트 스키마 초안

- **독자와 용도**: Kafka(서비스끼리 사건 메시지를 주고받는 시스템)에 사건을 내거나 받는 서비스·데이터 개발자가, 메시지의 Avro 스키마(메시지 모양을 기계가 읽게 적은 파일)와 등록·호환 규칙을 확인할 때 읽는다. 정본 저장소는 `peaket-contracts`이고(docs/architecture.md §10), 이 폴더는 그 저장소를 만들기 전의 초안이다.
- **원본 출처**: docs/api/asyncapi.yaml(메시지 필드와 설명), docs/api/guidelines.md §1과 docs/devops.md §6.5(호환 규칙), docs/streaming.md §2.6·§7(소비 방식과 키). 2026-10-22 소유자 요청으로 만들었다.
- **기준 기획 버전**: v1.0. 정본에 없던 규칙은 추천 적용(2026-10-22)이고 §2·§3에 표시했다. 정할 일은 §5에 있다.

## 1. 파일과 검사

- **범위**: asyncapi의 Kafka 메시지 가운데 Avro로 보내는 18개 전부다(trade 7, control 2, identity 1, support 1, telemetry 7). 브라우저 지표 `RumSample`은 JSON이고 Kafka로 내는 곳이 없어 뺐다. 실시간 채널 3개(WebSocket·SSE·Socket.IO)는 Avro를 쓰지 않는다.
- **경로**: `peaket/<묶음>/<레코드>.avsc`이고 네임스페이스는 `peaket.<묶음>`이다(예: `peaket/trade/OrderEvent.avsc` = `peaket.trade.OrderEvent`). 레코드 이름은 asyncapi 메시지 이름과 같다.
- **만든 방법**: asyncapi.yaml을 §2 규칙대로 기계적으로 옮겼다. 필드 이름·순서·열거 값·설명은 asyncapi 그대로다. 지금은 asyncapi를 고치면 이 파일도 함께 고친다. asyncapi가 적은 대로 원본이 `peaket-contracts`로 옮겨 가면, 그때부터는 Avro가 원본이다.
- **검사(2026-10-22)**:
  - Apache Avro 공식 Python 라이브러리 1.12.0과 fastavro 1.9.7로 18개가 모두 읽힌다.
  - 이름 붙은 타입(레코드·열거) 51개가 서로 겹치지 않는다. 파일 경로와 네임스페이스도 맞는다.
  - 레코드마다 선택 필드를 모두 채운 경우와 모두 비운 경우를 쓰고 다시 읽어, 36번 모두 같은 값이 나왔다.
  - asyncapi와 필드 이름·순서, 열거 값, 필수 여부, 타입 규칙이 같다. 일부러 틀리게 고친 세 곳(열거 값, 필수 필드, null 갈래 순서)을 이 검사가 모두 잡는 것도 확인했다.
  - Schema Registry 등록과 호환 검사는 아직 하지 않았다. CI에 붙이는 일은 wbs 0.2.2다.

## 2. 옮긴 규칙(추천 적용 2026-10-22)

| asyncapi(JSON Schema) | Avro | 근거 |
| --- | --- | --- |
| `string` | `string` | — |
| `string`, `format: uuid` | `string` + `logicalType: uuid` | Avro 1.12 명세: uuid는 string이나 길이 16인 fixed에 붙인다 |
| `string`, `format: date-time` | `long` + `logicalType: timestamp-millis` | 1970-01-01부터의 밀리초로 담는 시각(Avro 명세). 분석 표의 `DateTime64(3)`와 같은 정밀도다 |
| `string`, `format: date` | `int` + `logicalType: date` | 1970-01-01부터의 날 수(Avro 명세). 상품 정산서의 주 시작·끝(한국 날짜)에만 쓴다 |
| `integer` | `long` | 금액(원)이 int 범위(약 21억)를 넘을 수 있다. Avro는 int와 long을 가변 길이로 써서 작은 값은 크기가 같다(Avro 명세) |
| `number` | `double` | — |
| `boolean` | `boolean` | — |
| 문자열 `enum` | `enum` 이름 `<레코드><필드>`(예: `OrderEventType`) | Avro 열거는 이름 붙은 타입이라 네임스페이스 안에서 이름이 하나여야 한다. 기호는 asyncapi 값 그대로다 |
| `array` | `array` | — |
| 속성이 있는 `object` | 안쪽 `record`(예: `OrderEventItem`) | — |
| 속성이 없는 `object` | `BehaviorSignal.features` 하나뿐이고, openapi `BehaviorSummary`와 같은 필드의 `record`로 정했다 | §5 |

- **null 규칙**: asyncapi `required`에 있는 필드는 null을 허용하지 않는다. JSON 기본값이 있는 필드(`TrustVerdict.shadow`의 false)는 null 없이 그 기본값을 둔다. 그 밖의 필드는 `["null", 타입]`과 기본값 null이다. null을 첫 갈래에 둔다. Avro 명세가 유니온의 기본값을 처음으로 맞는 갈래로 읽기 때문이다.
- **설명**: asyncapi 설명을 `doc`에 그대로 옮겼다. 설명이 없는 `eventId`·`pid`·`schemaVersion`에는 '회차 ID'·'사람 식별값'·'메시지 형식 판'만 붙였다.
- **Kafka 키**: 키는 레지스트리 직렬화기로 감싸지 않고 UTF-8 문자열로 둔다. 레지스트리 형식은 메시지 안에 스키마 ID를 넣으므로(Confluent 문서), 키를 그렇게 쓰면 같은 회차라도 스키마 ID에 따라 키 바이트가 달라질 수 있다. 키 필드는 docs/streaming.md §7을 따른다.
- **추적 정보**: W3C Trace Context(docs/observability.md §2)는 스키마 필드가 아니라 Kafka 레코드 헤더로 보낸다.

## 3. 등록과 호환

| 항목 | 규칙 | 근거 |
| --- | --- | --- |
| 저장소 | Confluent Schema Registry. 어디에 둘지는 아직 정하지 않았다(docs/infra-handover.md §3.2) | 정본(docs/api/guidelines.md §1) |
| 호환 모드 | BACKWARD_TRANSITIVE. 새 스키마의 소비자가 지난 모든 판으로 쓴 데이터를 읽어야 한다. 소비자를 먼저, 생산자를 나중에 배포한다 | 정본(docs/devops.md §6.5). Confluent 문서도 BACKWARD 계열은 옛 스키마의 소비자가 새 데이터를 읽는다는 보장이 없으니 소비자를 모두 먼저 올리라고 한다 |
| 바꾸면 안 되는 것 | 열거 기호를 지우거나 이름을 바꾸지 않는다. Avro는 읽는 쪽 열거에 없는 기호를 만나면, 열거 기본값이 없을 때 오류를 낸다(Avro 명세). null을 허용하던 필드를 나중에 null 불가로 바꾸면 옛 null 데이터를 못 읽는다. 필드 삭제와 의미 변경은 확장·축소 변경으로 한다 | Avro 명세, 정본(docs/devops.md §6.5) |
| 주제(subject) 이름 | `TopicRecordNameStrategy`로 `<토픽>-<네임스페이스.레코드>`다(예: `trade.orders-peaket.trade.OrderEvent`). 토픽 4개에 레코드가 여러 종류 실려서(§4) 모든 토픽에 이 방식을 쓴다 | 추천 적용 2026-10-22. Confluent 문서: 한 토픽에 여러 레코드 종류를 섞을 때 쓰는 방식이고, 호환 검사는 토픽 안의 레코드 이름마다 한다 |
| 등록 | 생산자는 `auto.register.schemas=false`로 스스로 등록하지 않는다. `peaket-contracts`가 계약 패키지를 게시할 때(`main` 병합 뒤, docs/devops.md §2.2.5) 같은 워크플로가 등록한다. `use.latest.version`은 기본값(false)으로 둬, 생산자는 자기가 빌드된 판으로 쓴다 | 추천 적용 2026-10-22. 설정 이름과 동작은 Confluent 문서 |
| Outbox 릴레이 | Outbox 표의 `payload` 열은 `bytea`로 두고, 서비스가 레지스트리 직렬화기로 만든 바이트를 넣는다. Debezium Outbox 라우터는 `value.converter=io.debezium.converters.BinaryDataConverter`로 그 바이트를 그대로 Kafka 값으로 보낸다. 커넥터의 하트비트와 트랜잭션 메타데이터는 이 변환기로 보낼 수 없어 대리 변환기 설정을 따로 둔다. 로컬과 v0의 폴링 릴레이도 같은 바이트를 보낸다 | 추천 적용 2026-10-22. Debezium 3.7 문서 'Using Apache Avro as the payload format' |
| 스트림 작업자 소비 | 스트림 작업자(TypeScript)는 쓴 쪽 스키마(메시지에 실린 스키마 ID)로 읽은 뒤 레코드 이름으로 나눈다. 그래서 레코드가 여러 종류 실리는 토픽도 읽기 스키마를 따로 두지 않는다(docs/streaming.md §2.6, 추천 적용 2026-10-27, ADR-0099) | Avro 명세: 쓴 쪽과 읽는 쪽이 둘 다 레코드면 이름이 같아야 맞춘다. 쓴 쪽 스키마로 읽으면 이 맞춤이 필요 없다 |

## 4. 토픽과 레코드

| 토픽 | 레코드 | 키 | 내는 곳 | 주로 받는 곳 |
| --- | --- | --- | --- | --- |
| `trade.orders` | `OrderEvent` | `eventId` | purchase-svc(Outbox) | core-svc 알림, ops-rt |
| `trade.payments` | `PaymentEvent` | `eventId` | payment-svc(Outbox) | purchase-svc 주문 Saga, ops-rt |
| `trade.seats` | `SeatEvent` | `eventId` | purchase-svc(좌석 Redis Stream 릴레이, `seat_sale` Outbox) | purchase-svc 홀드 원장 적재, ops-rt |
| `trade.purchase-sessions` | `PurchaseSessionStarted`, `PurchaseSessionEnded` | `eventId` | purchase-svc(Redis Stream 릴레이) | queue-svc |
| `trade.tickets` | `TicketEvent` | `eventId` | ticket-svc(Outbox) | ops-rt |
| `trade.settlements` | `SettlementEvent` | 파트너 ID | payment-svc(Outbox) | analytics-ingest |
| `control.settings` | `SettingChanged` | 정하지 않음(§5) | ops-svc | 모든 서비스 |
| `control.sessions-terminated` | `SessionTerminated` | `accountId` | identity-svc | 모든 서비스 |
| `identity.accounts-merged` | `AccountMerged` | `mergedAccountId` | identity-svc | 각 도메인 서비스 |
| `support.cases-requested` | `CaseRequested` | `sourceId` | core-svc(Outbox) | ops-svc |
| `telemetry.queue` | `QueueAggregate`, `QueueEntryRecord`, `PipelinePulse` | '회차:파드', `pid`, 없음 | queue-svc, rt-pulse | ops-rt(`QueueAggregate`·`PipelinePulse`), analytics-ingest(`QueueEntryRecord`) |
| `telemetry.purchase` | `HoldAttempt`, `PipelinePulse` | `purchaseSessionId`, 없음 | purchase-svc, rt-pulse | ops-rt, analytics-ingest |
| `telemetry.trust-verdicts` | `TrustVerdict`, `PipelinePulse` | `queueEntryId`(없으면 없음), 없음 | trust-svc, rt-pulse | ops-rt, analytics-ingest |
| `telemetry.behavior` | `BehaviorSignal` | `pid` | trust-svc | trust-reassess |
| `telemetry.trust-candidates` | `TrustCandidate` | `pid` | trust-reassess | trust-svc |

- 분석 원본 적재 작업자(analytics-ingest)는 `trade.*`, `control.settings`, `telemetry.queue`(`QueueEntryRecord`), `telemetry.purchase`, `telemetry.trust-verdicts`를 모두 읽고 심장 박동 사건(`PipelinePulse`)은 건너뛴다(asyncapi `consumeAnalyticsIngest`).
- `PipelinePulse`는 한 레코드를 세 토픽에 쓰므로 주제가 셋이다(`telemetry.queue-peaket.telemetry.PipelinePulse` 등).

## 5. asyncapi와 다른 점과 정할 일

Outbox 열(docs/data.md §4)과 스트림 소비(docs/streaming.md §2.6)는 정본에 적었다(2026-10-22. 소비 방식은 2026-10-27 ADR-0099로 정했다). 아래 표는 남은 일과 그 기록이다.

| 항목 | 지금 | 이 초안의 처리와 제안 |
| --- | --- | --- |
| `BehaviorSignal.features` | asyncapi는 속성 없는 object다. 예전 설명에 '헤더 순서'가 있었다 | openapi `BehaviorSummary`와 같은 record로 정했다(docs/streaming.md §5.2 '브라우저가 낸 요약값'). 헤더 순서 같은 서버 쪽 특징은 trust-svc 실시간 판정에만 쓰고 싣지 않는다. 대기 중 재평가 패턴(docs/streaming.md §5.3)이 쓰지 않아서다. asyncapi 설명도 2026-10-22에 이렇게 맞췄다(추천 적용) |
| 필수 필드 | asyncapi에 `required`가 있는 메시지는 6개(`OrderEvent`, `PurchaseSessionStarted`, `PurchaseSessionEnded`, `SessionTerminated`, `AccountMerged`, `CaseRequested`)뿐이다. 나머지 12개는 기본값이 있는 필드 말고는 모두 null을 허용한다 | 첫 등록 전에 정해야 한다. 나중에 null 불가로 바꾸면 호환이 깨진다(§3). 제안은 메시지에 있는 `eventKey`, `type`이나 `kind`, 발생 시각, `schemaVersion`을 필수로 하는 것이다 |
| payload 형식 | asyncapi는 `defaultContentType: application/avro`인데 payload는 JSON Schema로 적었다 | AsyncAPI 3.0.0의 Multi Format Schema Object로 payload를 이 파일에 잇는다(`schemaFormat: application/vnd.apache.avro+json;version=1.9.0`, AsyncAPI가 권하는 형식 목록에 있다) |
| `control.settings` 키 | 정하지 않았다 | 같은 범위의 설정 변경이 순서대로 가도록 `scope`(asyncapi 설명대로 PLATFORM 또는 공연 ID)를 키로 쓰는 것을 제안한다 |
| Outbox `payload` 열 | docs/data.md §4에 적었다(2026-10-22) | 끝남 |
| 여러 레코드가 실리는 토픽의 소비 | docs/streaming.md §2.6 | 끝남: 스트림 작업자가 쓴 쪽 스키마로 읽고 레코드 이름으로 나눈다(2026-10-27, ADR-0099) |
| 퍼널의 '처음' 표시 | `OrderEvent.firstInStage`·`HoldAttempt.firstHeldInSession`을 선택 필드(기본 null)로 더했다(2026-10-27, ADR-0099) | 소비자(`ops-rt`)를 먼저, 생산자(purchase-svc)를 나중에 배포한다. null인 옛 메시지는 퍼널에 세지 않는다 |
