# ADR-0357: 사건을 내는 서비스의 Avro 바이트는 공용 인코더가 설정의 스키마 ID로 만든다 — 주문 사건과 텔레메트리 토픽부터(2026-11-23)

- **상태**: 추천 적용(2026-11-23, F-04-2 계획 담당, docs/review/plans/F-04-2.md). 방향을 바꾸는 결정이 아니라 정본(docs/api/avro/README.md §3 '생산자 스키마 ID', docs/streaming.md §2.6, ADR-0150 결정 5)이 비워 둔 '어떻게'를 채운다. 결정 9의 나머지 토픽을 맡을 기능은 감독이 정한다(계획 '감독에게' 1·2). 감독이 다르게 정하면 이 ADR을 고친다.
- **관련**: [ADR-0335](0335-stream-worker-avro-avsc-own-registry-lookup.md)(스트림 작업자의 Avro 읽기, `avsc`), [ADR-0150](0150-event-schema-required-fields-always-present.md)(필수 칸·인코딩 실패), [ADR-0249](0249-first-visit-cookie-telemetry-sink-honeypot-gate.md) 결정 4(텔레메트리 버퍼), [ADR-0171](0171-post-sale-forensics-in-launch-scope.md) 결정 4(조사 칸), [ADR-0116](0116-single-polling-outbox-relay-drop-debezium-place-pgbouncer-schema-registry.md)(Outbox 릴레이), docs/api/avro/README.md §2·§3, docs/devops.md §4.4·D-T39, docs/features/analytics.md §3.4·§13·§16
- **관련 ID**: OPS-190(wbs 4.3.3), A-T26, ST-T16, D-T39

## 맥락

- 정본은 '생산자는 실행 중에 레지스트리(사건 모양을 번호로 보관하는 Schema Registry)를 부르지 않고, 공용 Avro 인코더가 설정 `schema-ids`의 ID와 자기 계약 판의 스키마로 Confluent 형식 바이트를 만든다'고 정했다(docs/api/avro/README.md §3). Confluent 형식은 맨 앞 1바이트 0, 스키마 ID 4바이트, Avro(사건을 짧은 바이트로 담는 형식) 본문이다.
- 2026-11-23 저장소에는 그 인코더가 없다. `packages/platform/src/avro.ts`(BAS-030)는 다섯 바이트 껍데기 `encodeConfluent`와 시작 확인 `assertStartupSchema`만 있고, 어느 서비스도 부르지 않는다. 사건을 내는 서비스는 모두 asyncapi 모양의 UTF-8 JSON 바이트를 낸다(예: `services/purchase-svc/src/modules/booking/adapters/order-events.ts`, `services/trust-svc/src/modules/scoring/adapters/json-telemetry-recorder.ts`). 홀드 시도 `HoldAttempt`는 아예 버린다(`discardHoldAttempts`).
- 2026-11-23 BAT-220이 스트림 작업자의 Avro 읽기를 만들었다(ADR-0335). 그 읽기는 매직 바이트가 0이 아닌 값을 거절하므로, 지금 JSON 사건은 관제 실시간 표(`ops-rt`, F-04-1)와 원본 적재(`analytics-ingest`, F-04-3)가 읽지 못한다.
- 계약 판의 스키마(`.avsc`)는 docs/api/avro/에만 있고, 서비스가 실행 중에 읽을 꼴로 내보낸 곳이 없다(`@peaket/contracts`는 Zod 스키마·타입과 proto 설명자만 낸다).
- 정본에 없는 것: 인코더의 자리, 설정 파일을 파드가 읽는 자리, 시작 확인이 레지스트리에 닿지 못했을 때의 경보 신호, 텔레메트리의 `eventKey` 식, `HoldAttempt.retryNo`의 뜻(BUILD_ORDER OPS-190 줄의 '정본에 없다').
- 서비스 안에도 JSON을 읽는 소비자가 있는 토픽이 있다: `trade.payments`(purchase-svc 결과 반영), `trade.seats`(purchase-svc 홀드 원장, queue-svc 판매 상태), `trade.purchase-sessions`(queue-svc), `identity.accounts-withdrawn`(queue-svc·core-svc), `control.*`(공용 제어 동기화), `audit.data-accessed`·`ops.command-events`(ops-svc). 이 토픽의 생산자만 바꾸면 그 소비자가 멈춘다.

## 결정

1. **인코더 자리**: `packages/platform`에 새 하위 내보내기 `@peaket/platform/avro`를 둔다. Kafka 네이티브 모듈을 싣지 않고 `avsc` 5.7.9(ADR-0335 결정 1과 같은 판)만 싣는다. Outbox만 쓰는 API 파드(Kafka 연결이 없다)도 이 내보내기로 바이트를 만든다. 레지스트리 조회(`schemaRegistrySource`, ADR-0335 결정 2·3)도 여기서 다시 내보낸다. 그래서 ADR-0335 결정 1의 '`@peaket/platform/stream-worker` 하위 내보내기에서만 싣는다'를 '`stream-worker`와 `avro` 하위 내보내기에서만'으로 넓힌다. Kafka도 Avro도 쓰지 않는 서비스는 여전히 싣지 않는다.
2. **계약 판 스키마**: `packages/contracts`의 생성기가 docs/api/avro/의 `.avsc`를 `src/gen/avro/`로 옮겨 `@peaket/contracts/avro`로 내보낸다(레코드 전체 이름 → 스키마 JSON). 생성물 대조(`gen:check`)가 이 폴더도 본다. 서비스와 스트림 작업자는 이 생성물을 '자기가 빌드된 계약 판'으로 쓴다. 손으로 고치지 않는다(CLAUDE.md 생성 파일 규칙).
3. **인코딩 규칙**: 인코더는 asyncapi 모양의 사건(`@peaket/contracts/asyncapi` 타입)을 받아 다음 차례로 바이트를 만든다.
   - 주제 이름은 `<토픽>-<네임스페이스.레코드>`(`TopicRecordNameStrategy`, docs/api/avro/README.md §3)이고, 스키마 ID는 설정에서 찾는다.
   - 날짜·시각 글(`date-time`)은 그 칸의 논리 타입대로 밀리초(`timestamp-millis`)로, 날짜(`date`)는 날 수로 바꾼다. 사건을 만드는 코드가 바꾸지 않는다.
   - 계약에 없는 칸은 바이트에 쓰지 않는다(Avro는 스키마의 칸만 쓴다). 그래서 업무 기록에 있는 계정 ID 같은 값이 계약에 없으면 나가지 않는다.
   - 필수 칸이 비었거나, 칸 속성 `x-present-when`의 조건이 맞는데 값이 없거나, 열거 값이 `UNRECOGNIZED`이거나 기호 목록 밖이면 바이트를 만들지 않고 인코딩 오류를 낸다. 오류에는 레코드 이름과 칸 경로만 싣고 값은 싣지 않는다.
4. **설정 파일의 자리**: 등록 Job이 쓴 ConfigMap `schema-ids`(키 `schema-ids.json`)를 서비스 차트가 파드의 `/etc/peaket/schema-ids/`에 붙이고, 서비스는 환경 값 `PEAKET_SCHEMA_IDS_FILE`이 가리키는 그 파일을 시작할 때 한 번 읽는다(`parseSchemaIds`). 파일이 없거나 읽지 못하거나, 내는 주제가 파일에 없으면 모든 환경에서 시작하지 않는다(D-T39 ③과 같은 분류). 로컬 클러스터와 한 프로세스 합본(`services/bundle`)에는 레지스트리가 없으므로, 로컬 도구가 계약의 주제를 이름 차례로 1부터 번호 매긴 고정 파일을 만들어 넘긴다 [추천]. 이 번호는 로컬에서만 뜻이 있다.
5. **시작 확인**: 내는 주제마다 시작할 때 레지스트리에서 그 ID의 스키마를 받아(`GET /schemas/ids/{id}`, 시간 한도 2초 [가정], 주제들을 함께 묻는다) 계약 판 스키마와 견준다. 견줄 때는 두 JSON을 읽어 키 차례를 무시하고 같은지 본다.
   - 다르거나 레지스트리가 그 ID를 모른다고 답하면(404) 시작하지 않는다. 앞의 것은 그 ID가 다른 스키마를 가리키고, 뒤의 것은 소비자가 그 바이트를 `UNKNOWN_SCHEMA`로 거절할 것이기 때문이다(ADR-0335 결정 3).
   - 닿지 못하면(시간 초과·연결·TLS 오류·5xx·401·403·그 밖의 4xx·스키마로 읽히지 않는 응답) 설정의 ID로 계속하고, 경고 로그 한 줄 `{ kind: 'schema-startup-check', subject, result: 'unavailable' }`(주소·자격 없음)과 게이지 `schema_startup_check_unavailable{subject}`를 1로 둔다. 이 게이지가 1이면 SEV3(`kind` hygiene)다(docs/features/analytics.md §16). 준비 상태(readiness)에는 넣지 않는다. 그래서 레지스트리가 멈춘 동안 새로 뜬 파드도 주문을 받는다(ST-T16 ②).
   - 레지스트리 주소는 `PEAKET_SCHEMA_REGISTRY_URL`(등록 Job과 같은 이름), 자격은 `PEAKET_SCHEMA_REGISTRY_USER`·`PEAKET_SCHEMA_REGISTRY_PASSWORD`(Secrets Manager에서 받은 Secret)다. 주소 규칙은 ADR-0335 결정 3 그대로다(운영·스테이징·데모는 https만). 주소가 없으면 local·ci만 확인을 건너뛰고(`result: 'skipped'`, 정보 로그), 다른 환경은 시작하지 않는다.
6. **`eventKey` 식**: 같은 사건을 다시 만들 길이 있으면 업무 키로 정하는 UUID 버전 8(SHA-256('<레코드>:' + 업무 키)의 앞 16바이트, purchase-svc `orderEventKey`와 같은 계산)이고, 없으면 주입한 시계의 UUIDv7이다.
   - Outbox 사건과 `TrustVerdict`·`BehaviorSignal`: 지금 식을 바꾸지 않는다.
   - `HoldAttempt`: UUIDv7. 시도 하나는 응답 뒤 한 번만 기록되고, 보내기가 실패하면 버린다(다시 만들지 않는다). 생산자 멱등 설정이 같은 묶음의 다시 보내기를 거른다.
   - `QueueEntryRecord`·`QueueAggregate`: 업무 키 UUID 버전 8이다. 대기표 하나는 한 번 끝나고 판매 종료 정리를 다시 돌려도 같은 값이 나와야 하기 때문이다. 업무 키(대기표·로비 참가·1초 칸·파드)를 무엇으로 할지는 그 발행을 만드는 기능의 계획이 정한다.
7. **`HoldAttempt` 칸 채우기**:
   - `retryNo`는 같은 구매 세션에서 그 시도 앞에 낸 홀드 시도의 수다(첫 시도 0, 멱등 재생은 세지 않는다). 지표 사전의 '재시도 순번'·'세션 첫 시도'(docs/features/analytics.md §5.2 F4, §6.3의 8번)가 이 값을 쓴다. purchase-svc는 응답을 보낸 뒤 구매 세션 상태 `s:session:{jti}`의 칸 `hn`을 '키가 있을 때만 1 올리는' Lua 한 번으로 올리고, 올린 값 − 1을 쓴다(docs/data.md §3). 응답 경로에 Redis 왕복을 더하지 않는다. 그 Lua가 실패하거나 키가 없으면 그 시도는 버리고 센다(결정 8).
   - `autoResult`는 자동 배정 결과 종류, `firstHeldInSession`은 지금 기록 그대로다. `tierId`가 없는 시도(좌석맵 판에서 첫 좌석을 찾기 전에 거절)는 필수 칸이 비어 결정 8로 버린다.
   - 보내기는 purchase-svc의 텔레메트리 버퍼(`TelemetrySink`)로 텔레메트리 클러스터 `telemetry.purchase`에 낸다. 키는 구매 세션 ID(`purchaseSessionId`)다(docs/streaming.md §7, docs/api/avro/README.md §4. 처음 판의 '회차 ID'는 정본 키 규칙과 달라 2026-11-23 F-04-2 구현 담당이 바로잡았다).
8. **인코딩 실패**: ADR-0150 결정 5 그대로다. 텔레메트리는 그 기록을 버리고 `telemetry_dropped_total{record}`를 1 올리며, 경고 로그에 레코드와 칸 이름만 남긴다. Outbox 사건은 인코딩 오류가 그 업무 트랜잭션을 실패시킨다(주문이 생기지 않는다).
9. **이번에 바꾸는 토픽**: 한 토픽의 값은 한 형식이다. 서비스 안에 JSON을 읽는 소비자가 없는 토픽만 이번에 Avro로 바꾼다: `trade.orders`(purchase-svc 주문 사건과 회차 환급 팬 알림 사건), `telemetry.purchase`(`HoldAttempt`), `telemetry.trust-verdicts`(`TrustVerdict`), `telemetry.behavior`(trust-svc·purchase-svc의 `BehaviorSignal`). 맥락의 마지막 줄 토픽들은 그 소비자를 같은 기능에서 Avro 읽기로 바꿀 때 생산자도 함께 바꾼다. 사람별 대기 기록·1초 집계(`telemetry.queue`)는 queue-svc에 아직 생산자가 없다.

## 검토한 대안

| 대안 | 판단 |
| --- | --- |
| 인코더를 `@peaket/platform/stream-worker`에 둔다 | 기각. Outbox만 쓰는 API 파드가 Kafka 네이티브 모듈까지 싣게 된다(응용 프로그램 제어 정책에 막힌 일이 있다). |
| 서비스가 실행 중에 docs/api/avro의 파일을 읽는다 | 기각. 이미지에 문서 폴더가 없고, 빌드된 계약 판과 실행 판이 갈릴 수 있다. |
| 시작 때 레지스트리에 스스로 등록한다(`auto.register.schemas=true`) | 기각. 정본이 금한다(docs/api/avro/README.md §3 '등록'). |
| 레지스트리에 닿지 못하면 시작하지 않는다 | 기각. 레지스트리가 멈춘 동안 온세일 확장 파드가 주문을 못 받는다(ST-T16 ②). |
| 모든 토픽을 이번에 Avro로 바꾼다 | 기각. 서비스 소비자 일곱 곳을 함께 바꿔야 해 5일 상한을 넘는다(ADR-0354 결정 2). |
| 로컬에서 설정 파일이 없으면 JSON으로 낸다 | 기각. 시험과 로컬이 운영과 다른 형식을 보게 되어 결함을 숨긴다. |

## 결과

- 주문 사건과 텔레메트리 세 토픽을 스트림 작업자가 그대로 읽는다. 관제 실시간 표·원본 적재·조사 적재가 시험용 바이트가 아니라 실제 생산자 바이트로 시험할 수 있다.
- purchase-svc·trust-svc의 시험 가운데 JSON 값을 읽던 것(예: `services/purchase-svc/test/order-events.test.ts`)은 Avro로 풀도록 시험 담당이 고친다.
- 로컬·합본에 고정 설정 파일이 하나 는다. 로컬에 레지스트리가 없으므로 로컬에서는 시작 확인이 늘 'skipped'다.
- 결정 9의 나머지 토픽은 JSON으로 남는다. 그 토픽을 읽는 스트림 작업자는 그때까지 실제 생산자 바이트를 읽지 못한다.

## 되돌릴 조건

- 생산자 시작이 레지스트리 조회 때문에 2초 [가정]를 넘게 늦어지는 일이 온세일 확장에서 잦으면, 시작 확인을 시작 뒤 배경 작업으로 옮기고 mismatch만 파드를 내리게 바꾼다.
- 스키마 참조나 레지스트리 규칙이 필요해지면 ADR-0335의 되돌릴 조건과 함께 다시 본다.
