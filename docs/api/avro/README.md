# Avro 이벤트 스키마 초안

- **독자와 용도**: Kafka(서비스끼리 사건 메시지를 주고받는 시스템)에 사건을 내거나 받는 서비스·데이터 개발자가, 메시지의 Avro 스키마(메시지 모양을 기계가 읽게 적은 파일)와 등록·호환 규칙을 확인할 때 읽는다. 이 폴더가 정본 자리다(`peaket` 저장소의 docs/api/avro/, ADR-0165). wbs 0.2.2에서 계약 검사를 붙이기 전까지는 초안이다.
- **원본 출처**: docs/api/asyncapi.yaml(메시지 필드와 설명), docs/api/guidelines.md §1과 docs/devops.md §6.5(호환 규칙), docs/streaming.md §2.6·§7(소비 방식과 키). 2026-10-22 소유자 요청으로 만들었다.
- **기준 기획 버전**: v1.0. 정본에 없던 규칙은 추천 적용(2026-10-22)이고 §2·§3에 표시했다. 정할 일은 §5에 있다. 칸마다의 필수 판정은 §6이다(소유자 결정 2026-10-29, ADR-0150).

## 1. 파일과 검사

- **범위**: asyncapi의 Kafka 메시지 가운데 Avro로 보내는 19개 전부다(trade 8, control 2, identity 1, support 1, telemetry 7. 2026-10-28 회차 판매 상태 `EventSaleChanged`를 더했다, ADR-0122). 파일 19개 안의 이름 붙은 타입은 66개(레코드 28개, 열거 38개)였다(2026-10-28 파일로 센 값). 2026-10-31에 열거 둘을 더해 68개(열거 40개)다(§1 끝 검사, 2026-11-01 정합 점검). 브라우저 지표 `RumSample`은 JSON이고 Kafka로 내는 곳이 없어 뺐다. 2026-10-31에 더한 조사용 요청 기록 `InvestigationRequest`(토픽 `investigation.requests`)도 JSON이라 뺐다. 노드 에이전트의 OTel 수집기가 Envoy 접근 로그에서 바로 내는데, 수집기의 Kafka 내보내기는 레지스트리 형식의 Avro를 만들지 못하기 때문이다(asyncapi 그 채널 설명, ADR-0171). 2026-10-31 기준 이름 붙은 타입은 68개(레코드 28개, 열거 40개)다. 실시간 채널(WebSocket·SSE. 관제 Socket.IO는 2026-10-28 ADR-0100으로 SSE로 바꿨다)은 Avro를 쓰지 않는다.
- **경로**: `peaket/<묶음>/<레코드>.avsc`이고 네임스페이스는 `peaket.<묶음>`이다(예: `peaket/trade/OrderEvent.avsc` = `peaket.trade.OrderEvent`). 레코드 이름은 asyncapi 메시지 이름과 같다.
- **만든 방법**: asyncapi.yaml을 §2 규칙대로 기계적으로 옮겼다. 필드 이름·순서·열거 값·설명은 asyncapi 그대로다. 다만 열거마다 asyncapi 값 앞에 읽는 쪽 전용 기호 `UNRECOGNIZED`를 하나 더 두고 그 기호를 기본값으로 한다(§2, 2026-10-28). 지금은 asyncapi를 고치면 이 파일도 함께 고친다. asyncapi가 적은 대로 wbs 0.2.2에서 계약 검사를 붙인 뒤에는 Avro가 원본이다(ADR-0165).
- **검사(2026-10-22)**:
  - Apache Avro 공식 Python 라이브러리 1.12.0과 fastavro 1.9.7로 18개가 모두 읽힌다.
  - 이름 붙은 타입(레코드·열거) 51개가 서로 겹치지 않는다. 파일 경로와 네임스페이스도 맞는다.
  - 레코드마다 선택 필드를 모두 채운 경우와 모두 비운 경우를 쓰고 다시 읽어, 36번 모두 같은 값이 나왔다.
  - asyncapi와 필드 이름·순서, 열거 값, 필수 여부, 타입 규칙이 같다. 일부러 틀리게 고친 세 곳(열거 값, 필수 필드, null 갈래 순서)을 이 검사가 모두 잡는 것도 확인했다.
  - Schema Registry 등록과 호환 검사는 아직 하지 않았다. CI에 붙이는 일은 wbs 0.2.2다.
- **검사(2026-10-28)**: 열거 31개 모두에 `UNRECOGNIZED`(맨 앞 기호)와 `"default": "UNRECOGNIZED"`를 더한 뒤, 18개 파일이 JSON으로 읽히고, 이름 붙은 타입 51개가 겹치지 않고, 열거마다 기본값이 기호 목록 안에 있으며, 파일 경로·네임스페이스가 맞는 것을 직접 쓴 검사로 확인했다. 작업 환경에 Avro 라이브러리가 없어 라이브러리로 다시 읽는 검사는 하지 않았다(wbs 0.2.2의 CI가 한다). 같은 날 `trade/EventSaleChanged.avsc`(레코드 하나, 열거 둘, ADR-0122)를 더한 뒤 같은 검사를 다시 돌려 19개 파일, 이름 붙은 타입 53개, 열거 33개에서 겹침과 기본값 오류가 없음을 확인했다. 같은 날 `schemaVersion`·`OrderEvent.idempotencyKey`를 빼고 `SettingChanged.value`를 레코드 유니온으로 바꾼 뒤(기술 검토 낮음-026) 다시 돌려, 19개 파일이 JSON으로 읽히고 이름 붙은 타입 66개·열거 38개에서 겹침이 없으며 열거마다 맨 앞 `UNRECOGNIZED`와 기본값이 있음을 확인했다(다른 묶음이 같은 날 더한 타입 포함).
- **검사(2026-10-29, ADR-0150)**: 필수 여부를 §6대로 바꾼 뒤 직접 쓴 검사로 다시 확인했다. 19개 파일이 JSON으로 읽히고, 이름 붙은 타입 66개가 겹치지 않으며, 열거마다 맨 앞 `UNRECOGNIZED`와 기본값이 있다. asyncapi와 견준 필드 이름·순서, 필수 목록, 기본값, `x-present-when`, 열거 기호, uuid 형식도 어긋남이 0건이었다. 조건(`x-present-when`)이 같은 메시지의 필수 열거 칸을 가리키는지, 조건부 칸을 가리키면 그 칸이 있어야 하는 조건이 이 조건 안에 들어 있는지, 조건 값이 그 열거의 기호인지도 본다. 일부러 틀리게 고친 세 곳(필수 칸 하나를 null 허용으로, 조건 하나를 다른 기호로, 기본값 false 하나를 지움)을 모두 잡았고, 고치기 전 판에 돌려도 어긋남은 0건이었다. Avro 라이브러리 검사는 이번에도 하지 못했다(wbs 0.2.2의 CI가 한다).
- **바꿈(2026-10-30)**: 열거 기호를 셋 더했다. `CaseRequestedKind`에 봇 판정 이의 제기 `VERIFICATION_APPEAL`(queue-svc가 냄, docs/features/bot-defense.md §12), `SessionTerminatedReason`에 역할 변경 `ROLE_CHANGED`(docs/security/authz-matrix.md §5.4)와 비밀번호 바꾸기 `PASSWORD_CHANGED`(docs/security/auth-controls.md §3.5)다. 열거 끝에 더해 기존 기호의 순서는 그대로이고, 새 기호를 모르는 옛 읽는 쪽은 기본값 `UNRECOGNIZED`로 읽는다(§2). `BehaviorSignal`은 로비 입장 때도 낸다는 설명만 바꿨다(칸 변화 없음). 칸 수와 이름 붙은 타입 수(66개)는 그대로다. 세 파일이 JSON으로 읽히고 열거마다 맨 앞 `UNRECOGNIZED`와 기본값이 있으며, asyncapi 열거와 기호가 같음을 직접 쓴 검사로 확인했다(추천 적용 2026-10-30). 같은 날 `CaseRequestedKind` 끝에 소명 `APPEAL`(core-svc support 모듈이 냄, openapi `POST /v1/appeals`, docs/features/transfer-refund.md §7.1)을 하나 더 더했다. 같은 방식으로 열거 끝에 더했다(추천 적용 2026-10-30).
- **바꿈(2026-10-31, ADR-0171 결정 4, BUILD_ORDER FRN-030)**: 부정 예매 사후 조사가 끝단 요청·대기·구매 세션·홀드·주문·결제를 한 사람의 여정으로 잇도록 칸을 더했다. 모두 첫 등록 전이라 §6의 규칙대로(늘 있으면 필수, 사건 종류에 따라 있는 칸만 null 허용) 넣었다(추천 적용 2026-10-31).
  - 여정 ID `journeyId`(UUIDv7, 토큰 클레임 `jny`): `QueueEntryRecord`·`PurchaseSessionStarted`·`HoldAttempt`·`BehaviorSignal`은 필수, `OrderEvent`는 CREATED에만, `TrustVerdict`는 로비 입장·사전 검증의 실시간 판정(category PASS·CHALLENGED)에만 있다(추가 검증 제출은 본문에 토큰이 없고, 재평가 후보에는 여정이 없어 비운다). `PaymentEvent`에는 없다(payment-svc는 여정을 모르고 주문 ID로 잇는다).
  - 기기 가명 `deviceRef`: `TrustVerdict`에 더했고, `BehaviorSignal.deviceRef`는 탐지 가명 키에서 조사용 가명 키 `inv-ref-key`로 바꿨다(identity-svc `device.device_ref`와 같은 값, 기기 키 통일). 칸 모양은 그대로다.
  - `HoldAttempt`: 좌석 `seatIds`(직접 선택이거나 잡았을 때)와 잡은 시각 `heldAt`(잡았을 때).
  - `OrderEvent`: 예매자 휴대폰 번호의 조사용 가명 `contactRef`(CREATED).
  - `PaymentEvent`: 결제 수단 연결값 `paymentMethodRef`와 카드 BIN `cardBin`(결제사 응답에 카드 정보가 있을 때). 두 결제사 모두 카드 지문과 가상카드 여부를 주지 않아(2026-10-31 공식 문서 확인, docs/features/payment.md) 연결값은 약한 값이고 가상카드 칸은 두지 않았다.
  - `BehaviorSignal`: 화면 `screen`(LOBBY·EVENT_DETAIL·SEAT·PAYMENT, 새 열거 `BehaviorSignalScreen`)을 필수로 더하고, purchase-svc도 내게 되어(좌석·결제 화면) `netClass`를 필수에서 조건부(screen LOBBY·EVENT_DETAIL)로 풀었다. `asn`의 조건에 screen을 더했다.
  - `CaseRequested.category`의 소명 대상 종류에 `FRAUD_CASE`를 더했다(문자열 칸이라 설명만 바뀜).
  - `SeatEvent`: 우선 구매 보류(이의가 인정된 부정 예매 표 취소의 되돌림, 구매 세션 없음)를 위해 홀드 종류 `holdKind`(새 열거 `SeatEventHoldKind`)와 권리 ID `priorityGrantId`를 더하고, `purchaseSessionId`의 조건을 holdKind FAN으로 좁혔다. 첫 등록 전이라 조건을 좁혀도 된다.
  - 분석 원본 적재(analytics-ingest)는 새 조사 칸을 브론즈에 싣기 전에 버린다(docs/features/analytics.md). 조사 적재 작업자 `inv-ingest`가 같은 토픽을 함께 읽는다(§4, docs/streaming.md §6.4).
  - 직접 쓴 검사(asyncapi를 YAML로 읽어 avsc와 견줌)로 19개 파일이 JSON으로 읽히고, 이름 붙은 타입 68개가 겹치지 않으며, 열거 40개마다 맨 앞 `UNRECOGNIZED`와 기본값이 있고, 필드 이름·순서, 필수 목록, null 첫 갈래와 기본값 null, 기본값 false, `x-present-when`(값이 그 열거의 기호인지, 조건부 칸을 가리키면 그 칸의 조건을 품는지), 열거 기호, uuid·시각 형식이 asyncapi와 어긋남 0건임을 확인했다. Avro 라이브러리 검사는 하지 못했다(wbs 0.2.2의 CI가 한다).
- **바꿈(2026-11-04, BUILD_ORDER BOT-037)**: 탈퇴 사건 `identity/AccountWithdrawn.avsc`(토픽 `identity.accounts-withdrawn`, 레코드 하나, 칸 다섯 모두 필수)를 더했다. 파일 20개(identity 2), 이름 붙은 타입 69개(레코드 29개, 열거 40개)다. 처음 등록 전이라 §6 규칙대로 늘 있는 칸은 필수로 두었다. `pids`는 문자열 배열이다(1~2개는 asyncapi `minItems`·`maxItems`가 적고, Avro에는 그 제약이 없어 받는 쪽이 본다). 직접 견준 검사로 asyncapi와 필드 이름·순서·필수 목록·형식(uuid·시각)이 같음을 확인했다(Avro 라이브러리 검사는 wbs 0.2.2의 CI가 한다).
- **바꿈(2026-11-04, BUILD_ORDER BOT-041)**: 로그인 수단 연결·해제 `identity/LoginMethodChanged.avsc`(토픽 `identity.login-methods-changed`, 레코드 하나, 열거 둘 `LoginMethodChange`·`LoginMethodProvider`, 칸 다섯 모두 필수)를 더했다. 파일 21개(identity 3), 이름 붙은 타입 72개(레코드 30개, 열거 42개)다. 열거마다 맨 앞 `UNRECOGNIZED`와 기본값을 두었다(§2).
- **바꿈(2026-11-05, BUILD_ORDER BOT-044, ADR-0209)**: `SessionTerminatedReason` 끝에 `LOGIN_METHOD_CHANGED`(팬 계정의 로그인 수단이 바뀌어 다른 세션을 끝냄, ASVS 7.4.3)를 더했다. 2026-10-30과 같이 열거 끝에 더해 기존 기호의 순서는 그대로이고, 새 기호를 모르는 옛 읽는 쪽은 기본값 `UNRECOGNIZED`로 읽는다. 파일·타입 수는 그대로다.
- **바꿈(2026-11-06, BUILD_ORDER HOT-011, ADR-0219 결정 5·6)**: `trade/EventSaleChanged.avsc`의 끝에 셈 시각 `countedAt`(null 허용 timestamp-millis)과 평균 구매 매수 `avgTicketsPerOrder`(null 허용 double)를 기본값 null로 더했다. 내는 쪽이 같은 판을 다시 낼 때 그때의 셈을 싣는다. 이름 붙은 타입 수는 그대로다.
- **바꿈(2026-11-05, BUILD_ORDER HOT-010, ADR-0214 결정 3)**: `trade/EventSaleChanged.avsc`의 `paying` 뒤에 매진 등급 `soldOutTiers`(문자열 배열, 기본값 `[]`, 없으면 빈 배열)를 더했다. 2026-11-12 R-504: BACKWARD_TRANSITIVE를 위해 `"default": []`를 넣었다. 옛 데이터는 이 칸이 없으므로 빈 배열로 읽는다. 이름 붙은 타입 수는 그대로다.

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
| 문자열 `enum` | `enum` 이름 `<레코드><필드>`(예: `OrderEventType`). 기호는 맨 앞의 `UNRECOGNIZED`와 asyncapi 값이고, `"default": "UNRECOGNIZED"`를 둔다(추천 적용 2026-10-28, 기술 검토 중간-087) | Avro 열거는 이름 붙은 타입이라 네임스페이스 안에서 이름이 하나여야 한다. 열거 기본값은 읽는 쪽이 자기 열거에 없는 기호를 만났을 때 그 자리에 쓰는 값이고, 기본값이 없으면 오류가 난다(Avro 1.12.0 명세 '스키마 맞추기'). `UNKNOWN`이라는 이름을 쓰지 않은 것은 `PaymentEventType`·`PaymentEventResult`에 이미 업무 상태 `UNKNOWN`(결제 결과 모름)이 있어서다. 모르는 새 상태를 그 상태로 읽으면 결과 모름 처리가 잘못 돈다 |
| `array` | `array` | — |
| 속성이 있는 `object` | 안쪽 `record`(예: `OrderEventItem`) | — |
| 속성이 없는 `object` | `BehaviorSignal.features` 하나뿐이고, openapi `BehaviorSummary`와 같은 필드의 `record`로 정했다 | §5 |

- **null 규칙(소유자 결정 2026-10-29, ADR-0150)**: 늘 값이 있는 칸은 필수다. asyncapi `required`에 넣고, Avro에서는 null을 허용하지 않으며 기본값을 두지 않는다. 사건 종류·결과에 따라 없을 수 있는 칸만 `["null", 타입]`과 기본값 null로 둔다. 참·거짓 칸은 null 없이 기본값 false를 둔다(asyncapi `default: false`, 예: `TrustVerdict.shadow`). null을 첫 갈래에 둔다. Avro 명세가 유니온의 기본값을 처음으로 맞는 갈래로 읽기 때문이다. 칸마다의 판정은 §6에 있다. 조건부 칸 가운데 조건을 같은 메시지의 다른 칸 값으로 말할 수 있는 칸에는 `x-present-when`을 asyncapi 속성과 avsc 필드에 같은 값으로 둔다(§6). Avro 명세는 정의하지 않은 속성을 직렬화에 영향 없는 메타데이터로 허용한다.
- **설명**: asyncapi 설명을 `doc`에 그대로 옮겼다. 설명이 없는 `eventId`·`pid`에는 '회차 ID'·'사람 식별값'만 붙였다. 모든 메시지에 있던 `schemaVersion`(메시지 형식 판)과 `OrderEvent.idempotencyKey`는 2026-10-28에 뺐다. 판은 레지스트리의 스키마 ID가 말하고, 중복 제거 키는 `eventKey` 하나이기 때문이다. `SettingChanged.value`는 문자열 JSON에서 키별 레코드 일곱(`BotLevelValue` 등)의 유니온으로 바꿨다(추천 적용 2026-10-28, 기술 검토 낮음-026, asyncapi info '공통 필드').
- **Kafka 키**: 키는 레지스트리 직렬화기로 감싸지 않고 UTF-8 문자열로 둔다. 레지스트리 형식은 메시지 안에 스키마 ID를 넣으므로(Confluent 문서), 키를 그렇게 쓰면 같은 회차라도 스키마 ID에 따라 키 바이트가 달라질 수 있다. 키 필드는 docs/streaming.md §7을 따른다. 모든 생산자는 파티셔너(키로 파티션을 고르는 규칙) `murmur2_random`(자바 클라이언트 기본과 같은 murmur2 해시)을 쓴다. librdkafka 기본(`consistent_random`, CRC32)과 섞이면 같은 회차가 다른 파티션으로 가 '한 회차는 토픽마다 한 파티션' 전제가 깨진다(docs/streaming.md §2.6, D-T45, ADR-0142 결정 3).
- **추적 정보**: W3C Trace Context(docs/observability.md §2)는 스키마 필드가 아니라 Kafka 레코드 헤더로 보낸다.

## 3. 등록과 호환

| 항목 | 규칙 | 근거 |
| --- | --- | --- |
| 저장소 | Confluent Schema Registry를 Confluent Community License로 직접 띄운다. 운영은 EKS 안 Deployment 2개 [가정]다(다른 AZ, 일반 노드 풀, `platform` 네임스페이스, PodDisruptionBudget 최소 1). 하나는 Kafka 그룹으로 뽑힌 리더이고(`leader.eligibility` 기본값 true), 다른 하나는 읽기를 받고 쓰기는 리더로 넘긴다. 스키마는 MSK 거래·제어 클러스터의 압축 토픽 `_schemas`(복제 3)에 둔다. 환경마다 따로 둔다: 로컬·CI는 컨테이너 하나(시험마다 새로 띄운다), 데모는 데모 오버레이의 한 벌이다. 레지스트리끼리 스키마를 나눠 쓰지 않으므로 같은 스키마라도 환경마다 ID가 다를 수 있다(추천 적용 2026-10-28, 기술 검토 중간-088, docs/infra-handover.md §3.2) | 정본(docs/api/guidelines.md §1). 레지스트리 소스 `SchemaRegistryConfig`(master, 2026-10-28 확인): `kafkastore.topic` 기본 `_schemas`, 복제 기본 3, `leader.eligibility` 기본 true. 쓰기 권한을 사용자별로 나누는 보안 플러그인은 Confluent Enterprise 사용권이 있어야 한다(Confluent 문서 'Secure Schema Registry', 2026-10-28 확인) |
| 호환 모드 | BACKWARD_TRANSITIVE. 새 스키마의 소비자가 지난 모든 판으로 쓴 데이터를 읽어야 한다. 소비자를 먼저, 생산자를 나중에 배포한다 | 정본(docs/devops.md §6.5). Confluent 문서도 BACKWARD 계열은 옛 스키마의 소비자가 새 데이터를 읽는다는 보장이 없으니 소비자를 모두 먼저 올리라고 한다 |
| 바꾸면 안 되는 것 | 열거 기호를 지우거나 이름을 바꾸지 않는다. 열거마다 기본값이 있으면 레지스트리의 호환 검사는 기호를 지운 판도 받아들인다(Avro 호환 검사는 읽는 쪽에 기본값이 있으면 쓴 쪽 기호가 없어도 맞다고 본다). 그래서 이 규칙은 계약 검사(`contract-check`)가 지킨다. 기본값이 없는 열거라면 Avro는 읽는 쪽 열거에 없는 기호를 만났을 때 오류를 낸다(Avro 명세). null을 허용하던 필드를 나중에 null 불가로 바꾸면 옛 null 데이터를 못 읽는다. 그 반대(필수 칸을 null 허용으로 풀기)는 호환 검사를 통과하므로, 소비자를 먼저 고친 뒤 할 수 있다. 기본값 없는 필드를 새로 더하는 것도 거절되므로, 나중에 더하는 필드는 null 허용이거나 기본값이 있다(ADR-0150). 필드 삭제와 의미 변경은 확장·축소 변경으로 한다 | Avro 명세, 정본(docs/devops.md §6.5). Avro 1.12.0 `SchemaCompatibility`의 열거 검사와, 그 검사를 그대로 부르는 Confluent 레지스트리 `AvroSchema`(소스, 2026-10-28 확인) |
| 열거 기호 더하기 | 기호는 기본값이 있는 열거에만 더한다(지금은 40개 모두 있다, 2026-10-31 판, §1. 2026-11-01 정합 점검). 생산자는 `UNRECOGNIZED`를 내지 않는다(계약 검사와 생산자 단위 시험이 막는다). 소비자는 모르는 기호를 `UNRECOGNIZED`로 받아 '모르는 상태'로 세고(`stream_unrecognized_symbol_total{worker, topic, record, field}`) 경보한다(SEV3). 쓴 쪽 스키마로 읽는 소비자(아래 '스트림 작업자 소비', 서비스 소비자도 같은 모듈)는 Avro 맞추기를 거치지 않으므로, 공용 소비 모듈이 자기가 빌드된 계약 판의 기호 목록에 없는 값을 `UNRECOGNIZED`로 바꿔 업무 코드에 넘긴다. 원본 적재(브론즈)는 원래 기호를 그대로 싣고 같은 수를 센다. 그래서 늦게 올린 소비자도 레코드를 버리지 않고, 빠진 수는 경보로 보인다(ST-T15) | 추천 적용 2026-10-28, 기술 검토 중간-087. avsc 5.7.9(`@confluentinc/schemaregistry` 1.11.0이 쓰는 라이브러리) 소스: 읽는 쪽 스키마로 맞출 때 모르는 기호를 열거 기본값으로 바꾼다 |
| 주제(subject) 이름 | `TopicRecordNameStrategy`로 `<토픽>-<네임스페이스.레코드>`다(예: `trade.orders-peaket.trade.OrderEvent`). 토픽 5개에 레코드가 여러 종류 실려서(§4. 2026-10-28 `trade.seats`에 `EventSaleChanged`가 더해졌다, ADR-0122) 모든 토픽에 이 방식을 쓴다 | 추천 적용 2026-10-22. Confluent 문서: 한 토픽에 여러 레코드 종류를 섞을 때 쓰는 방식이고, 호환 검사는 토픽 안의 레코드 이름마다 한다 |
| 등록 | 서비스와 작업자는 `auto.register.schemas=false`로 스스로 등록하지 않는다. 데모·운영 등록은 생산자 서비스의 ArgoCD 동기화 앞(PreSync 훅)에 도는 등록 Job이 그 서비스가 내는 주제만 한다. 이미 있는 스키마는 같은 ID가 돌아오므로 다시 돌려도 된다. 호환 검사에 걸리면 Job이 실패해 동기화가 멈추고, 생산자는 배포되지 않는다. Job은 주제별로 등록한 스키마 ID와 스키마 원문 SHA-256을 그 네임스페이스의 ConfigMap `schema-ids`에 쓴다(D-T39). CI(GitHub 호스트 러너)는 운영 레지스트리에 닿지 않는다. 지난 출시 태그의 스키마를 모두 올린 로컬 레지스트리 컨테이너로 BACKWARD_TRANSITIVE 검사만 한다(docs/devops.md §3.1 `contract-check`, ADR-0165). 그래서 레지스트리를 인터넷에 열지 않는다(docs/devops.md §10.1). `use.latest.version`은 기본값(false)으로 둬, 생산자는 자기가 빌드된 판으로 쓴다. 커뮤니티판에는 쓰기 권한을 자격별로 나누는 기능이 없어, 등록을 등록 Job만 하는 것은 설정 규칙이지 권한 통제가 아니다(§5) | 추천 적용 2026-10-22, 등록 경로는 2026-10-28(기술 검토 중간-088). 설정 이름과 동작은 Confluent 문서 |
| 생산자 스키마 ID | Avro로 내는 모든 생산자(Outbox를 쓰는 서비스, Redis Stream 릴레이, 텔레메트리를 바로 내는 서비스, rt-pulse)는 실행 중에 레지스트리를 부르지 않는다. 공용 Avro 인코더(`packages/platform`)가 ConfigMap `schema-ids`의 ID와 자기 계약 판의 스키마로 Confluent 형식(맨 앞 1바이트 0, 스키마 ID 4바이트(빅 엔디언), Avro 바이너리)을 직접 만든다. 시작할 때 레지스트리에 닿으면 그 ID의 스키마가 자기 스키마와 같은지 한 번 견주고, 다르면 시작하지 않는다. 닿지 않으면 설정의 ID로 계속하고 경보를 낸다(SEV3). 이 확인은 준비 상태(readiness)에 넣지 않는다. 설정에 없는 주제를 내려 하면 시작하지 않는다(배포 순서 오류, D-T39). 그래서 온세일 확장으로 새로 뜬 파드는 레지스트리가 멈춰 있어도 주문을 만든다 | 추천 적용 2026-10-28, 기술 검토 중간-088. `@confluentinc/schemaregistry` 1.11.0 소스(2026-10-28 확인): 자동 등록을 꺼도 직렬화할 때 그 스키마의 ID를 레지스트리에 묻고(`getIdFullResponse`), `useSchemaId`를 줘도 그 ID의 스키마를 묻는다(`getBySubjectAndId`). 결과는 프로세스 캐시에만 남는다. Confluent 형식은 같은 소스의 `MAGIC_BYTE`·`idToBytes` |
| Outbox 릴레이 | Outbox 표의 `payload` 열은 `bytea`로 두고, 서비스가 공용 Avro 인코더로 만든 바이트(위 '생산자 스키마 ID')를 넣는다. 모든 환경의 Outbox 릴레이는 서비스별 폴링 릴레이이고, 그 바이트를 바꾸지 않고 그대로 Kafka 값으로 보낸다. 키는 행의 `msg_key`(UTF-8), 헤더는 추적 정보다. 릴레이는 레지스트리를 부르지 않는다. 운영에서 Debezium(`BinaryDataConverter`와 대리 변환기)을 쓰던 규칙은 2026-10-28에 없앴다(docs/data.md §4의 7번, ADR-0116) | 추천 적용 2026-10-22, 릴레이 하나로 정한 것은 2026-10-28(ADR-0116) |
| 스트림 작업자 소비 | 스트림 작업자(TypeScript)는 쓴 쪽 스키마(메시지에 실린 스키마 ID)로 읽은 뒤 레코드 이름으로 나눈다. 그래서 레코드가 여러 종류 실리는 토픽도 읽기 스키마를 따로 두지 않는다(docs/streaming.md §2.6, 추천 적용 2026-10-27, ADR-0099). 처음 보는 스키마 ID를 레지스트리가 멈춰 읽지 못하면 그 파티션 소비를 멈추고 다시 시도한다(거절하지 않는다). 레지스트리가 그 ID를 모른다고 답할 때만 거절한다(docs/streaming.md §12, ST-T16, 추천 적용 2026-10-28, 기술 검토 중간-088) | Avro 명세: 쓴 쪽과 읽는 쪽이 둘 다 레코드면 이름이 같아야 맞춘다. 쓴 쪽 스키마로 읽으면 이 맞춤이 필요 없다 |

## 4. 토픽과 레코드

| 토픽 | 레코드 | 키 | 내는 곳 | 주로 받는 곳 |
| --- | --- | --- | --- | --- |
| `trade.orders` | `OrderEvent` | `eventId` | purchase-svc(Outbox) | core-svc 알림, ops-rt, inv-ingest |
| `trade.payments` | `PaymentEvent` | `eventId` | payment-svc(Outbox) | purchase-svc 주문 Saga, ops-rt, inv-ingest |
| `trade.seats` | `SeatEvent`, `EventSaleChanged`(회차 판매 상태, ADR-0122) | `eventId` | purchase-svc(좌석 Redis Stream 릴레이, `seat_sale`·`event_sale` Outbox) | purchase-svc 홀드 원장 적재, ops-rt(`SeatEvent`), queue-svc·core-svc(`EventSaleChanged`), analytics-ingest, inv-ingest(`SeatEvent`) |
| `trade.purchase-sessions` | `PurchaseSessionStarted`, `PurchaseSessionEnded` | `eventId` | purchase-svc(Redis Stream 릴레이) | queue-svc, inv-ingest(`PurchaseSessionStarted`) |
| `trade.tickets` | `TicketEvent` | `eventId` | ticket-svc(Outbox) | core-svc 알림(양도 알림, 추천 적용 2026-10-30), ops-rt, inv-ingest |
| `trade.settlements` | `SettlementEvent` | 파트너 ID | payment-svc(Outbox) | analytics-ingest |
| `control.settings` | `SettingChanged` | `<범위>:<종류>:<대상>`(압축 토픽, §5) | ops-svc | 모든 서비스의 모든 파드(파드마다 따로) |
| `control.sessions-terminated` | `SessionTerminated` | `accountId` | identity-svc | 모든 서비스의 모든 파드(파드마다 따로, 뜰 때 15분 되감기) |
| `identity.accounts-merged` | `AccountMerged` | `mergedAccountId` | identity-svc | 각 도메인 서비스 |
| `identity.accounts-withdrawn` | `AccountWithdrawn` | `accountId` | identity-svc(Outbox, 계정을 탈퇴 처리하는 트랜잭션) | queue-svc(서비스 소비자 그룹, 2026-11-04 BOT-037) |
| `identity.login-methods-changed` | `LoginMethodChanged` | `accountId` | identity-svc(Outbox, 로그인 수단을 잇거나 지운 트랜잭션) | core-svc notify(2026-11-04 BOT-041) |
| `support.cases-requested` | `CaseRequested` | `sourceId` | core-svc(Outbox), queue-svc(봇 판정 이의 제기, Outbox 없이 바로 냄. 추천 적용 2026-10-30, docs/features/bot-defense.md §12) | ops-svc |
| `telemetry.queue` | `QueueAggregate`, `QueueEntryRecord`, `PipelinePulse` | '회차:파드', `pid`, 없음 | queue-svc, rt-pulse | ops-rt(`QueueAggregate`·`PipelinePulse`), analytics-ingest·inv-ingest(`QueueEntryRecord`) |
| `telemetry.purchase` | `HoldAttempt`, `PipelinePulse` | `purchaseSessionId`, 없음 | purchase-svc, rt-pulse | ops-rt, analytics-ingest, inv-ingest |
| `telemetry.trust-verdicts` | `TrustVerdict`, `PipelinePulse` | `queueEntryId`(없으면 없음), 없음 | trust-svc, rt-pulse | ops-rt, analytics-ingest, inv-ingest |
| `telemetry.behavior` | `BehaviorSignal` | `pid` | trust-svc(LOBBY·EVENT_DETAIL), purchase-svc(SEAT·PAYMENT, 2026-10-31) | trust-reassess(LOBBY·EVENT_DETAIL만), inv-ingest |
| `telemetry.trust-candidates` | `TrustCandidate` | `pid` | trust-reassess | trust-svc |

- 분석 원본 적재 작업자(analytics-ingest)는 `trade.*`, `control.settings`, `telemetry.queue`(`QueueEntryRecord`), `telemetry.purchase`, `telemetry.trust-verdicts`를 모두 읽고 심장 박동 사건(`PipelinePulse`)은 건너뛴다(asyncapi `consumeAnalyticsIngest`).
- `PipelinePulse`는 한 레코드를 세 토픽에 쓰므로 주제가 셋이다(`telemetry.queue-peaket.telemetry.PipelinePulse` 등).
- 조사 적재 작업자(inv-ingest, docs/streaming.md §6.4)는 표의 inv-ingest 행과 JSON 토픽 `investigation.requests`(Avro 아님, §1)를 읽어 ClickHouse 조사 저장소 `inv`에 싣고 `PipelinePulse`는 건너뛴다(asyncapi `consumeInvestigationIngest`, 추천 적용 2026-10-31, ADR-0171).

## 5. asyncapi와 다른 점과 정할 일

Outbox 열(docs/data.md §4)과 스트림 소비(docs/streaming.md §2.6)는 정본에 적었다(2026-10-22. 소비 방식은 2026-10-27 ADR-0099로 정했다). 아래 표는 남은 일과 그 기록이다.

| 항목 | 지금 | 이 초안의 처리와 제안 |
| --- | --- | --- |
| `BehaviorSignal.features` | asyncapi는 속성 없는 object다. 예전 설명에 '헤더 순서'가 있었다 | openapi `BehaviorSummary`와 같은 record로 정했다(docs/streaming.md §5.2 '브라우저가 낸 요약값'). 헤더 순서 같은 서버 쪽 특징은 trust-svc 실시간 판정에만 쓰고 싣지 않는다. 대기 중 재평가 패턴(docs/streaming.md §5.3)이 쓰지 않아서다. asyncapi 설명도 2026-10-22에 이렇게 맞췄다(추천 적용) |
| 필수 필드 | 정했다(2026-10-29, 소유자 결정 "B로 정함", ADR-0150). 처음에는 asyncapi에 `required`가 있는 메시지가 7개(`OrderEvent`, `EventSaleChanged`, `PurchaseSessionStarted`, `PurchaseSessionEnded`, `SessionTerminated`, `AccountMerged`, `CaseRequested`)뿐이었고, 나머지 12개는 기본값이 있는 필드 말고는 모두 null을 허용했다 | 끝남: 늘 값이 있는 칸은 필수, 사건 종류에 따라 있는 칸만 null 허용, 참·거짓은 기본값 false다(§2). 172칸을 필수 125, 기본값 false 5, 조건부 42로 나눴다(§6). 처음 제안(공통 셋만 필수)은 소비자가 쓰는 주체 ID·순서 칸을 null 허용으로 남겨 뒤에 조일 수 없어 기각했다 |
| payload 형식 | asyncapi는 `defaultContentType: application/avro`인데 payload는 JSON Schema로 적었다 | AsyncAPI 3.0.0의 Multi Format Schema Object로 payload를 이 파일에 잇는다(`schemaFormat: application/vnd.apache.avro+json;version=1.9.0`, AsyncAPI가 권하는 형식 목록에 있다) |
| `control.settings` 키 | 정했다(2026-10-28, 추천 적용, ADR-0103) | 끝남: 압축 토픽(`cleanup.policy=compact`)이고 키는 `<범위>:<종류>:<대상>`(예: `PLATFORM:FEATURE_FLAG:reviews`. 대상은 기능 플래그 이름·로그 레벨을 바꿀 서비스·Degraded 모드 이름이고 없으면 비운다)이다. 키마다 마지막 값이 남아 7일 보존에 지워지지 않고, 같은 키는 같은 파티션이라 한 설정의 순서가 지켜진다. 설정을 없앨 때는 값이 빈 지우는 표시를 낸다. 레코드 모양은 그대로다 |
| Outbox `payload` 열 | docs/data.md §4에 적었다(2026-10-22) | 끝남 |
| 여러 레코드가 실리는 토픽의 소비 | docs/streaming.md §2.6 | 끝남: 스트림 작업자가 쓴 쪽 스키마로 읽고 레코드 이름으로 나눈다(2026-10-27, ADR-0099) |
| 퍼널의 '처음' 표시 | `OrderEvent.firstInStage`·`HoldAttempt.firstHeldInSession`을 더했다(2026-10-27, ADR-0099). 2026-10-29에 null 허용에서 기본값 false로 바꿨다(ADR-0150) | 값이 false인 사건은 퍼널에 세지 않는다. null인 옛 메시지를 세지 않던 ADR-0099의 뜻과 결과가 같다. 첫 등록 전이라 배포 순서 제약은 없다 |
| 열거 기본 기호 | 정했다(2026-10-28, 추천 적용, 기술 검토 중간-087) | 끝남: 열거 모두(처음 31개, 2026-10-28 마지막 확인 38개) 맨 앞에 `UNRECOGNIZED`를 두고 기본값으로 했다(§2·§3). 첫 등록 전에 넣어야 하는 일이라 필수 필드(위 행, docs/review/open-items.md 2번)와 같은 때인 첫 등록 전에 넣었다 |
| 레지스트리 쓰기 권한 | 커뮤니티판은 인증만 하고, 쓰기 권한을 자격별로 나누지 못한다(보안 플러그인은 Confluent Enterprise 사용권) | 등록은 등록 Job만 하고 서비스·작업자는 자동 등록을 끈다(설정 규칙, §3). 생산자는 실행 중에 레지스트리를 부르지 않아, 레지스트리 내용이 잘못 바뀌어도 이미 뜬 쓰기 경로는 흔들리지 않는다. 쓰기 권한 통제가 필요해지면 레지스트리 앞의 프록시가 쓰기 요청(POST·PUT·DELETE)을 등록 Job 신원에서 온 것만 받게 하는 방법과 Enterprise 사용권을 견준다(추천 적용 2026-10-28, 기술 검토 중간-088) |

## 6. 칸마다의 필수 판정(소유자 결정 2026-10-29, ADR-0150)

- **원칙**: 늘 값이 있는 칸은 필수, 사건 종류·결과에 따라 없을 수 있는 칸만 null 허용(조건부), 참·거짓은 기본값 false다(§2). 판정은 정본 문서(docs/data.md의 표, 기능 문서, asyncapi 설명)를 근거로 했고, 칸의 뜻을 새로 정한 곳은 ADR-0150 결정 6에 있다(추천 적용).
- **조건부 칸의 조건**: `x-present-when`이 있는 칸은 그 조건이 맞으면 값이 있어야 한다. 값은 조건 목록이고 하나라도 맞으면 된다. 조건 하나 안의 칸은 모두 맞아야 한다('이고'). 조건이 맞지 않을 때 비워야 한다는 뜻은 아니다. `x-present-when`이 없는 조건부 칸은 아래 글 조건을 따른다. 생산자 단위 시험이 사건 종류마다 예시 메시지를 만들어 두 가지를 모두 확인하고, 계약 검사가 asyncapi와 avsc의 필수 목록·기본값·조건이 같은지 본다(docs/devops.md §3.1).
- **세기**: 21종 207칸 = 필수 140, 기본값 false 9, 조건부 58(그 가운데 `x-present-when` 37). 2026-11-10 BOT-065에서 `TrustVerdict`에 표본 검토 라벨의 묶음 `reviewBatch`·적용 판 판정 `appliedVerdict`(source SAMPLE_REVIEW일 때)와 그림자 판정의 짝 `pairedEventKey`(shadow true일 때)를 더했다(셋 다 조건부, 새 열거 `TrustVerdictReviewBatch`·`TrustVerdictAppliedVerdict`, ADR-0258)(204칸 → 207칸). 2026-11-06 HOT-011에서 `EventSaleChanged`에 셈 시각 `countedAt`과 평균 구매 매수 `avgTicketsPerOrder`(둘 다 조건부, ADR-0219 결정 5·6)를 더했다(202칸 → 204칸). 2026-11-05 HOT-010에서 `EventSaleChanged`에 `soldOutTiers`(필수)를 더했다(201칸 → 202칸). 2026-11-04 BOT-037에서 `AccountWithdrawn`(필수 5칸)을, BOT-041에서 `LoginMethodChanged`(필수 5칸)를 더했다(191칸 → 201칸). 2026-10-31 FRN-040에서 조사용 가명 칸을 계산하지 못한 표시 `refMissing`(기본값 false)을 `TrustVerdict`·`BehaviorSignal`·`OrderEvent`·`PaymentEvent`에 하나씩 더했다(187칸 → 191칸, avsc 파일에서 다시 셈, ADR-0171). 2026-10-29의 172칸(필수 125, 기본값 false 5, 조건부 42, `x-present-when` 26)에 2026-10-31 조사 칸 13개를 더하고 `BehaviorSignal.netClass`를 필수에서 조건부로 옮겼고(185칸), 같은 날 우선 구매 보류 때문에 `SeatEvent`에 `holdKind`·`priorityGrantId`를 더했다(ADR-0171, 추천 적용 2026-10-31).

| 메시지 | 칸 | 필수 | 기본값 false | 조건부(이 조건이면 값이 있다) |
| --- | --- | --- | --- | --- |
| `EventSaleChanged` | 12 | `eventId`·`status`·`available`·`held`·`paying`·`soldOutTiers`(2026-11-05)·`version`·`changedAt`·`eventKey` | — | `previousStatus`: 회차의 첫 상태를 낼 때는 없다. `countedAt`(2026-11-06): 셈을 실은 사건(판이 바뀔 때와 같은 판의 다시 내기)이면 있다. `avgTicketsPerOrder`(2026-11-06): 그 회차에서 결제가 끝난 주문이 100건 [가정] 이상이면 있다 |
| `OrderEvent` | 15 | `eventId`·`orderId`·`accountId`·`type`·`amount`·`seatIds`·`items`·`seatAssignment`·`occurredAt`·`eventKey` (안쪽 `OrderEventItem`의 `seatId`·`tierId`·`sectionId`·`price`도 필수) | `firstInStage`·`refMissing`(2026-10-31) | `purchaseSessionId`: `x-present-when` type CREATED; `journeyId`: `x-present-when` type CREATED(2026-10-31); `contactRef`: `x-present-when` type CREATED 이고 refMissing false(2026-10-31) |
| `PaymentEvent` | 16 | `eventId`·`orderId`·`pg`·`type`·`amount`·`attemptNo`·`occurredAt`·`eventSeq`·`eventKey` | `refMissing`(2026-10-31) | `payMethodCategory`: 결제 수단이 정해진 뒤의 사건(결제창 이탈처럼 수단을 고르기 전에 끝난 실패는 없다); `paymentMethodRef`·`cardBin`: 결제사 응답의 카드 정보에 BIN이 있고 refMissing false인 사건(둘은 함께 있거나 함께 빈다, 2026-10-31); `result`: 승인 흐름의 정규화 결과가 있는 사건(payment §2.1). 입금 되돌림·취소에는 없을 수 있다; `failureCategory`: `x-present-when` type FAILED; `latencyMs`: 결제사 승인 호출의 응답을 받은 사건만 |
| `PurchaseSessionEnded` | 6 | `eventId`·`purchaseSessionId`·`admissionJti`·`reason`·`endedAt`·`eventKey` | — | — |
| `PurchaseSessionStarted` | 7 | `eventId`·`purchaseSessionId`·`admissionJti`·`journeyId`(2026-10-31)·`startedAt`·`maxStayUntil`·`eventKey` | — | — |
| `SeatEvent` | 14 | `eventId`·`seatId`·`tierId`·`sectionId`·`type`·`occurredAt`·`eventKey` | — | `fencingToken`: `x-present-when` type HELD·RELEASED·EXPIRED; `sectionVersion`: `x-present-when` type HELD·RELEASED·EXPIRED; `seatEpoch`: `x-present-when` type HELD·RELEASED·EXPIRED; `holdId`: `x-present-when` type HELD·RELEASED·EXPIRED; `holdKind`: `x-present-when` type HELD·RELEASED·EXPIRED(2026-10-31); `purchaseSessionId`: `x-present-when` type HELD·RELEASED·EXPIRED 이고 holdKind FAN(2026-10-31에 조건을 좁힘); `priorityGrantId`: `x-present-when` type HELD·RELEASED·EXPIRED 이고 holdKind PRIORITY(2026-10-31) |
| `SettlementEvent` | 17 | `promoterId`·`statementId`·`kind`·`pg`·`type`·`occurredAt`·`eventKey` | — | `eventId`: `x-present-when` kind EVENT; `pgStore`: `x-present-when` pg TOSS; `periodStart`: `x-present-when` kind PRODUCT; `periodEnd`: `x-present-when` kind PRODUCT; `amount`: `x-present-when` type PAYOUT_SCHEDULED·PAYOUT_COMPLETED·PAYOUT_FAILED·PAYOUT_HELD·RECEIVABLE_OPENED·RECEIVABLE_CLOSED; `salesAmount`: `x-present-when` type STATEMENT_NOTIFIED; `refundAmount`: `x-present-when` type STATEMENT_NOTIFIED; `feeAmount`: `x-present-when` type STATEMENT_NOTIFIED; `revision`: `x-present-when` type STATEMENT_NOTIFIED; `supersedesId`: STATEMENT_NOTIFIED의 두 번째 판부터(첫 판은 null) |
| `TicketEvent` | 13 | `ticketId`·`eventId`·`orderId`·`accountId`·`type`·`occurredAt`·`eventKey` | — | `scanId`: `x-present-when` type ENTRY_SCANNED; `scanResult`: `x-present-when` type ENTRY_SCANNED; `reason`: `x-present-when` type ENTRY_SCANNED 이고 scanResult REJECT; `gateZone`: `x-present-when` type ENTRY_SCANNED; `direction`: `x-present-when` type ENTRY_SCANNED; `scannedAt`: `x-present-when` type ENTRY_SCANNED |
| `SessionTerminated` | 4 | `accountId`·`sessionId`·`reason`·`terminatedAt` | — | — |
| `SettingChanged` | 8 | `commandId`·`key`·`scope`·`value`·`actor`·`occurredAt`·`eventKey` | — | `expiresAt`: `x-present-when` key LOG_LEVEL |
| `AccountMerged` | 4 | `mergeId`·`primaryAccountId`·`mergedAccountId`·`confirmedAt` | — | — |
| `AccountWithdrawn` | 5 | `eventKey`·`accountId`·`pids`·`withdrawnAt`·`purgeBy` | — | — |
| `LoginMethodChanged` | 5 | `eventKey`·`accountId`·`change`·`provider`·`occurredAt` | — | — |
| `CaseRequested` | 7 | `eventKey`·`kind`·`sourceId`·`category`·`createdAt` | `followUp`·`hold` | — |
| `BehaviorSignal` | 11 | `pid`·`eventId`·`journeyId`(2026-10-31)·`screen`(2026-10-31)·`ts`·`eventKey` | `refMissing`(2026-10-31) | `deviceRef`: 로비 입장·사전 검증 본문에 기기 ID가 있고 refMissing false일 때; `netClass`: `x-present-when` screen LOBBY·EVENT_DETAIL(2026-10-31에 필수에서 옮김); `asn`: `x-present-when` screen LOBBY·EVENT_DETAIL 이고 netClass HOSTING·PROXY; `features`: 사전 검증 본문에 행동 요약이 있을 때(로비 입장에는 없다. 로비 입장은 추천 적용 2026-10-30, docs/features/bot-defense.md §4.1) |
| `HoldAttempt` | 15 | `eventId`·`purchaseSessionId`·`journeyId`(2026-10-31)·`mode`·`tierId`·`result`·`retryNo`·`latencyMs`·`occurredAt`·`eventKey` | `firstHeldInSession` | `sectionId`: PICK이거나, AUTO에서 좌석을 잡았을 때; `seatIds`: `x-present-when` mode PICK, 또는 result HELD(2026-10-31); `autoResult`: `x-present-when` mode AUTO; `heldAt`: `x-present-when` result HELD(2026-10-31) |
| `PipelinePulse` | 4 | `kind`·`topic`·`partition`·`producedAt` | — | — |
| `QueueAggregate` | 7 | `eventId`·`second`·`entries`·`removed`·`admissions`·`soonResponses`·`eventKey` | — | — |
| `QueueEntryRecord` | 15 | `eventId`·`queueEntryId`·`journeyId`(2026-10-31)·`pid`·`entryMode`·`enteredAt`·`verifyRoute`·`eventKey` | — | `number`: 순번을 받은 뒤 끝났을 때(로비 참가 취소처럼 셔플 전에 끝나면 없다); `firstEtaSec`: number와 같다; `turnAt`: 차례가 왔을 때; `admittedAt`: 입장 확정으로 끝났을 때; `admissionJti`: 입장 확정으로 끝났을 때; `removedAt`: 입장 확정 없이 빠졌을 때; `removeReason`: 입장 확정 없이 빠졌을 때 |
| `TrustCandidate` | 7 | `eventId`·`pid`·`pattern`·`evidenceCount`·`windowStart`·`detectedAt`·`eventKey` | — | — |
| `TrustVerdict` | 15 | `eventId`·`category`·`action`·`source`·`occurredAt`·`eventKey` | `shadow`·`refMissing`(2026-10-31); `reviewBatch`·`appliedVerdict`: `x-present-when` source SAMPLE_REVIEW(2026-11-10); `pairedEventKey`: `x-present-when` shadow true(2026-11-10) | `queueEntryId`: 대기 번호가 생긴 뒤의 판정; `pid`: `x-present-when` source REASSESS; `journeyId`: `x-present-when` source REALTIME 이고 category PASS·CHALLENGED(2026-10-31); `deviceRef`: 판정 입력에 기기 식별값이 있었고 refMissing false일 때(2026-10-31) |

- **구현 때 생산자 시험으로 확인할 판정**(ADR-0150 '남는 한계'): `HoldAttempt.tierId`(좌석 선택 방식의 오류 응답에서도 등급을 아는지), `PaymentEvent`의 `result`·`payMethodCategory`·`latencyMs` 조건, `QueueEntryRecord`의 순번·결과 칸 조건, `EventSaleChanged.previousStatus`(회차의 첫 상태도 사건으로 내는지), `BehaviorSignal`의 `deviceRef`·`features`(로비 입장·사전 검증 본문의 선택 칸). 2026-10-31에 더한 조사 칸도 같다: `HoldAttempt.seatIds`·`heldAt`(자동 배정 실패와 경합 패배에서 비는지), `TrustVerdict.journeyId`(실시간 판정에 늘 있는지), `PaymentEvent.paymentMethodRef`·`cardBin`(결제사가 카드 정보를 실제로 채우는지, 포트원은 결제대행사마다 다를 수 있다). 필수 칸이 실제로 빌 수 있으면 소비자를 먼저 고친 뒤 그 칸만 null 허용으로 푼다(§3).
