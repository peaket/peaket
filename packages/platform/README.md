# @peaket/platform

서비스(NestJS 12 + Fastify 5)가 함께 쓰는 서버 공용 패키지다. 모든 서비스가 같은 모양의 계측, 오류 응답, 남은 시간 전파, 로그, 추적 문맥을 갖게 한다(docs/architecture.md §10, NFR-011). 게시하지 않고 `workspace:`로만 잇는다(ADR-0165).

- 만든 곳: openspec 변경 `add-service-template`(2026-11-01, wbs 0.3.1 ①, BUILD_ORDER FND-050), `add-service-logging`(2026-11-01, wbs 0.3.1 ②, BUILD_ORDER FND-060), `add-service-structure-and-request-checks`(2026-11-01, wbs 0.3.2 ①, BUILD_ORDER FND-070). 설계와 이유는 그 변경의 design.md에 있다.
- 새 서비스는 서비스 뼈대 `template/`를 복사해 시작한다(아래 '서비스 뼈대').
- 서비스는 빌드한 `dist/`를 쓴다(`pnpm --filter @peaket/platform build`). Node의 형 지우기는 데코레이터를 바꾸지 않기 때문이다.

## 쓰는 법

```ts
// main.ts. 실행: node --import @peaket/platform/telemetry/register dist/main.js
import { createService } from '@peaket/platform';
import { shutdownTelemetry } from '@peaket/platform/telemetry';
import { AppModule } from './app.module.js';

const svc = await createService({ name: 'queue-svc', module: AppModule, adminAuthz }); // 관리 역할 처리기가 있으면 identity GetAdminAuthz 포트
await svc.listen();
// 끝낼 때: await svc.close(); await shutdownTelemetry();
```

처리기에서:

```ts
import { LogPolicy, PLATFORM_LOGGER, requestLog, type PlatformLogger } from '@peaket/platform';

@Post('entries')
@LogPolicy({ entry: true, sloLatencyMs: 50 }) // 진입 경로, 이 경로의 SLO 지연
async enter() {
  requestLog().set({ queuePhase: 'waiting' });
  requestLog().identify({ sessionId }); // 원문은 남지 않고 sidRef만 남는다
  requestLog().dependency('redis', ms);
}
```

요청 검사와 허용 역할(모든 처리기에 `@Roles`가 있어야 시작한다, AZ-T1):

```ts
import { AcceptTextPlain, ContractBody, ContractHeaders, ContractRouteSchema, CurrentPrincipal, Roles, type Principal } from '@peaket/platform';
import { PostV1EventsEventIdHoldsBody, PostV1EventsEventIdHoldsHeader } from '@peaket/contracts/openapi/seats';

@Post('holds')
@Roles(['fan'], { scopes: ['ticket:buy'] })
hold(@ContractHeaders(PostV1EventsEventIdHoldsHeader) h: Headers, @ContractBody(PostV1EventsEventIdHoldsBody) body: Body, @CurrentPrincipal() me: Principal) {}

// 핫패스: Zod 파이프 대신 Fastify 경로 스키마(같은 계약 Zod)
@Post('entries')
@Roles(['fan'], { scopes: ['ticket:buy'] })
@AcceptTextPlain()
@ContractRouteSchema({ body: PostV1QueuesEventIdEntriesBody, responses: { 201: PostV1QueuesEventIdEntriesResponse } })
enter() {}
```

한 번만 처리할 쓰기(멱등 키, docs/api/guidelines.md §4)와 같은 트랜잭션의 Outbox 사건:

```ts
import { IdempotencyRequest, IdempotencyStore, Idempotent, writeOutbox } from '@peaket/platform';

// 받는 층: 키가 없거나 틀리면 인증 가드 바로 뒤에 400 idempotency-key-invalid
@Post('orders')
@Roles(['fan'], { scopes: ['ticket:buy'] })
@Idempotent({ operation: 'CREATE_ORDER' })
create(@ContractBody(Body) body: Body, @IdempotencyRequest() once: IdempotencyRequest) {}

// 어댑터: 키 행(첫 쓰기) → 업무 → Outbox(마지막 문장)를 한 트랜잭션에
const store = new IdempotencyStore({ clock });
await database.transaction((tx) =>
  store.run(tx, once, {
    execute: async () => {
      /* 업무 쓰기 */
      await writeOutbox(tx, clock, [{ topic: 'trade.orders', key: eventId, payload }]);
      return { resultRef: orderId, value: order };
    },
    replay: async (orderId) => loadOrder(tx, orderId), // 같은 키·같은 지문: 처음 결과
  }),
);
```

Outbox 릴레이 Deployment(`<서비스>-outbox-relay`, 복제 2)의 시작 명령:

```ts
const elector = new LeaseElector({ api: inClusterLeaseApi('purchase-outbox-relay'), identity: process.env.PEAKET_POD!, clock });
const relay = new OutboxRelay({ database, publisher, leader: elector, clock, metrics: new OutboxRelayMetrics(registry, 'purchase-svc') });
elector.start();
relay.start(); // 끝낼 때: await relay.stop(); await elector.stop();
```

| 내보내는 것 | 하는 일 | 정본 |
| --- | --- | --- |
| `createService` | 시작 설정을 검사하고, 앱 포트(NestJS·Fastify)와 관리 포트(`/metrics`)를 만든다. 요청마다 네 신호를 재고 요청 맥락(trace-id, 남은 시간)을 열며, 요청이 끝나면 정규 로그 줄 하나를 쓴다. `logger`(서비스 로거)와 `logs.setSampleOneIn`(정상 줄 표본 비율)을 돌려준다 | docs/observability.md §3·§7 |
| `requestLog()`·`LogPolicy` | 정규 로그 줄에 회차·결제사·대기 단계·플래그·의존성 소요·가명을 더하고, 표본과 관계없이 남길 응답을 표시한다. `LogPolicy`는 경로의 진입 경로 표시와 SLO 지연 | docs/observability.md §6·§7, ADR-0069·0125 |
| `PLATFORM_LOGGER`·`createPlatformLogger` | 서비스 로거(Pino). 요청 안이면 `traceId`·`spanId`를 넣고, 연락처·인증 값·결제 값·원문 식별값 칸을 가린다 | docs/observability.md §7 |
| `ipPrefix`·`LogPseudonymizer` | IP 앞부분(IPv4 /24, IPv6 /48)과 로그 가명(HMAC-SHA256 앞 16바이트) | ADR-0053 결정 1 |
| `createExternalHttpClient` | 외부 제공자 호출. span은 경로 틀로 만들되 `traceparent`·`tracestate`·`baggage`를 싣지 않고, 리디렉트를 따르지 않으며, 시간 초과는 min(상한, 남은 시간)이다 | docs/observability.md §6, V-T31, ASVS 14.2.3·15.3.2 |
| `withoutTracePropagation` | 그 안의 요청에는 추적 문맥을 싣지 않는다(PEAKET 밖을 부르는 다른 클라이언트) | docs/observability.md §6 |
| `ProblemError` | 이름 붙은 오류. 전역 필터가 RFC 9457 Problem 본문(`application/problem+json`)으로 바꾼다. 정상 분기(예: 좌석 경합 409)는 `normalBranch: true`로 표시한다 | docs/api/guidelines.md §2 |
| `currentDeadline()` | 지금 요청의 남은 시간. `budgetFor(상한)`은 다음 호출에 줄 시간, `ensure(필요한 시간)`은 모자라면 504 `deadline-exceeded`를 던진다 | docs/api/guidelines.md §5 |
| `CLOCK`·`fakeClock` | 주입하는 시계(벽시계·단조 시계)와 시험용 시계 | 시간 의존 로직은 Clock 주입 |
| `emitOpenApi`·`contractSchema` | CI 안에서만 서비스 OpenAPI 문서를 파일로 뽑는다(미리 보기 모드라 제공자를 만들지 않는다). `contractSchema`는 계약 Zod를 swagger 데코레이터용 스키마로 바꾼다. 기본은 입력 기준이라 계약과 같은 모양이 된다(`{ io: 'output' }`은 기본값이 채워진 뒤의 모양). 실행 중인 서비스는 문서 경로를 내지 않는다 | D-T38, docs/devops.md §3.1 |
| `LATENCY_BUCKETS_SECONDS` | 지연 히스토그램 표준 칸 20개. 개별 서비스가 바꾸지 않는다 | docs/observability.md §8 |
| `@ContractBody`·`@ContractQuery`·`@ContractParams`·`@ContractHeaders` | 계약 생성 Zod로 요청을 검사하는 매개변수 장식자(Zod 파이프). 쿼리·경로·머리는 검사 전에 계약 형식대로 문자열을 바꾸고, 겹친 쿼리는 400이다. 실패는 `about:blank` 400 | docs/api/guidelines.md §1·§2, ASVS 15.3.7 |
| `@ContractRouteSchema`·`contractRouteSchema` | 핫패스의 Fastify 경로 스키마(`@RouteSchema()` 대신 처리기에 단다. 함수는 스키마만 만든다). 플랫폼 검사기는 형 바꾸기·정의 밖 칸 지우기를 하지 않아 Zod 파이프와 같게 거르고, 실패는 인증 가드가 신원을 판정한 뒤 400으로 낸다. 닫지 않은 객체의 정의 밖 칸은 처리기까지 오므로 쓸 칸을 골라 쓴다. 같은 처리기에 Zod 파이프를 함께 달지 않는다. NestJS의 `@RouteConfig()`도 함께 달지 않는다(경로 설정을 통째로 덮어 플랫폼 표시가 빠진다. 그래도 검사는 하고 익명 요청이 401 대신 400을 받는다, 마지막 확인 2026-11-01) | ADR-0023, V-T41 표본 묶음 |
| `@AcceptTextPlain()` | 그 경로만 `text/plain` 본문을 JSON으로 읽는다. 그 밖의 경로와 `application/json` 밖 형식은 415 | asvs/delivery.md 3.5.2, ADR-0065 |
| `@Roles`·`@CurrentPrincipal`·`currentPrincipal` | 처리기의 허용 역할(authz-matrix §5.5 값, `scopes`, 위험 작업 `fresh`)과 판정한 요청자. 신원은 게이트웨이 머리, 관리 역할·테넌트는 요청마다 `adminAuthz`(5초 캐시) | ADR-0172, authz-matrix §5.2 |
| `service.auth.terminateSession` | 세션 종료 사건을 받아 종료 세션 목록(종료 시각 + 15분)에 넣고 역할 캐시를 지운다 | identity §3, ASVS 7.4.1 |
| `createDatabase`·`databaseModule`·`DATABASE` | node-postgres 풀과 Drizzle. 풀 대기 한도(핫패스 100ms·일반 1초)를 넘으면 429 `server-busy`. `transaction(fn, { tenantId, statementTimeoutMs, isolationLevel })`은 첫 문장에서 `SET LOCAL`로 건다 | architecture §5, ADR-0037·0070·0083, authz-matrix §5.3 |
| `serverBusy` | 자기 과부하 거절 Problem(429, `Retry-After` 1초) | docs/api/guidelines.md §2 |
| `@Idempotent`·`@IdempotencyRequest` | 멱등 키(따옴표 없는 UUID v4)를 신원 판정 뒤·모양 검사 전에 보고(400 `idempotency-key-invalid`), 계정 × 작업 범위와 요청 지문(SHA-256(메서드 LF 경로와 쿼리 LF 본문 바이트))을 처리기에 준다. 두 검사 길의 Nest 장식자는 머리 스키마에서 이 머리를 뺀다. 계약이 키를 요구하는 처리기에 빠뜨리거나 공개 역할 처리기에 달면 시작 실패 | guidelines §4 |
| `IdempotencyStore`·`idempotencyRecordTable`·`deleteExpiredIdempotencyRecords` | 멱등 기록(`idempotency_record`)을 업무와 같은 트랜잭션에. 다른 지문 422 `idempotency-key-reused`, 처리 중 1초 [가정] 뒤 409 `idempotency-request-in-progress`, 24시간 [가정] 보관과 나눠 지우기 | ADR-0146 결정 1 |
| `rawBodyOf` | 플랫폼 본문 해석기가 남긴 해석 전 본문 바이트(지문·구매 세션 요청 서명) | guidelines §4 |
| `writeOutbox`·`CONTROL_TOPICS` | Outbox 행(UUIDv7 ID, 추적 머리)을 같은 트랜잭션의 마지막 문장으로 넣는다. 제어 사건도 같은 길이다 | ADR-0116 결정 3, ADR-0143 결정 3 |
| `OutboxRelay`·`OutboxRelayMetrics`·`OutboxPublisher` | 폴링 릴레이(리더만, `FOR UPDATE` `seq` 순서 500행, 보내기 10초 상한, 실패하면 0.1~5초 늘려 쉬기)와 지표 일곱. 보내기 포트의 Kafka 어댑터는 `@peaket/platform/stream-worker`의 `kafkaOutboxPublisher` | ADR-0116 결정 3·5 |
| `LeaseElector`·`kubernetesLeaseApi`·`inClusterLeaseApi` | 쿠버네티스 Lease로 리더 하나(12초·갱신 한도 8초·다시 시도 2초 [가정]) | ADR-0116 결정 2 |
| `ensureOutboxPartitions`·`dropExpiredOutboxPartitions`·`outboxHealth` | Outbox 일 파티션(KST 하루 ID 범위) 7일 앞까지 만들기, 정비 시간에 3일 지난 것 지우기(보내지 않은 행이 있으면 남김), 지연·파티션 지표 값 | docs/data.md §2·§4의 7번 |
| `uuidv7`·`uuidLowerBound` | 주입한 시계의 UUIDv7과 ID 범위 경계 | docs/data.md §2 |
| `kafkaProducerConfig`·`kafkaConsumerConfig`·`KAFKA_REQUIRED` | Kafka 필수 설정(생산자 `acks=all`·멱등·동시 5·`murmur2_random`·전달 상한 Outbox 릴레이 10초·그 밖 5초, 소비자 자동 커밋 끔·`cooperative-sticky`·세션 45초·`classic`). 덧붙일 설정에 필수 이름이 있으면 예외. 정적 검사는 `tools/ci/check-kafka-settings.mjs`(D-T45) | ADR-0142 결정 3, docs/streaming.md §2.6 |
| `KeyedPartition`·`TransientError`·`isTransientError` | 파티션 하나의 키 단위 처리(같은 키 차례대로, 다른 키 32개 [가정]까지 동시에, 커밋 위치는 끝나지 않은 가장 작은 오프셋), 같은 결과일 실패 5회 [가정] 뒤 보류와 같은 키 뒤 사건 보류, 일시 실패는 파티션 멈춤 | ADR-0142 결정 1·2 |
| `heldEventTable`·`drizzleHeldEventStore`·`reprocessHeldEvents`·`heldEventCounts`·`deleteReprocessedHeldEvents` | 보류 표 `held_event`, 다시 처리(RB-11, 업무 키마다 들어온 순서), 보류 수, 다시 처리한 지 7일 [가정] 지난 행 지우기 | docs/data.md §4의 15번 |
| `startControlSync`·`SettingsStore`·`ControlState`·`Readiness` | 시작 작업 셋(제어 상태·설정 끝까지·종료 세션 15분 되감기)과 준비 표시(관리 포트 `/ready`), Kafka 없으면 30초 [가정] 뒤 준비와 `control_sync_lagging`, 2초 [가정] 다시 맞춤, 설정 판(occurredAt)·지우는 표시·만료, 이 서비스의 로그 수준 설정 적용, 종료 세션 → `service.auth.terminateSession` | ADR-0103 결정 2·3·4, D-T29 |
| `ensureMonthlyPartitions`·`dropMonthlyPartitions`·`monthlyPartitionsAhead`·`analyzeTable` | 회차 ID(UUIDv7)·발송 시각 범위 월 파티션(KST 그달 1일, 3개월 [가정] 앞, 첫 파티션 포함), 조건부 지우기, 부모 표 ANALYZE | ADR-0086 결정 4 |
| `takeStatSnapshot`·`statSnapshotTable` | 매일 `pg_stat_user_tables`·`pg_stat_user_indexes` 스냅샷(하루 한 벌, 90일 [가정]) | ADR-0086 결정 7 |
| `deleteExpiredRows`·`retentionOverdueSeconds`·`reindexBloatedIndexes` | 보존 기한 나눠 지우기(1만 건 [가정]씩 자식 먼저, 0.5초 쉬기, 지키는 선·정비 시간 끝), 기한 넘김 시간, 부푼 B-tree 인덱스 `REINDEX CONCURRENTLY`(`pgstattuple`) | ADR-0114 결정 3 |
| `ackAndTrimStream`·`expireStreamAfterSale` | Redis Stream 확인 뒤 `XTRIM MINID`(확인하지 않은 항목은 남김), 키 수명 판매 종료 + 1일 [가정]. 명령 보내기 포트(`sendCommand`)만 받는다 | ADR-0070, docs/data.md §3 |
| `MaintenanceRunner`·`platformMaintenanceTasks`·`monthlyPartitionTasks`·`retentionTask`·`reindexTask` | 정비 반복(릴레이 프로세스의 Lease 리더, 10분 [가정]마다, 매일 일과 정비 시간 일, 지표) | docs/data.md §2 |

하위 경로:

| 경로 | 하는 일 |
| --- | --- |
| `@peaket/platform/telemetry` | `startTelemetry`·`shutdownTelemetry`. OTel Node SDK를 시작하는 유일한 곳(docs/devops.md §4.4). NestJS를 읽지 않아 앱 서버도 쓸 수 있다 |
| `@peaket/platform/telemetry/register` | `--import`로 읽는 등록 파일. 환경 변수로 `startTelemetry`를 부른다 |
| `@peaket/platform/stream-worker` | Kafka 클라이언트(`@confluentinc/kafka-javascript`)를 쓰는 유일한 곳: `createKafkaProducer`·`createKafkaConsumer`·`createKafkaAdmin`(필수 설정으로만), Outbox 보내기 어댑터 `kafkaOutboxPublisher`(생산 span이 쓴 요청에 링크), 키 단위 소비자 실행기 `runKeyedConsumer`(소비 span, 1초 커밋, 넘기기 전 마치기), 방송형 읽기 `kafkaBroadcastSource`, `withTraceHeaders`·`withConsumerSpan` |
| `@peaket/platform/testing` | V-T31 ③ 탐침 `probeTraceHeaders`. 외부 어댑터의 시험이 모의 서버가 받은 헤더에 추적 헤더가 없는지 본다. 텔레메트리를 시작하지 않은 채 부르면 실패한다. 제어 사건 JSON 대역 `jsonControlCodec`(Avro 디코더는 BAS-030) |

## 설정(환경 변수)

| 이름 | 기본값 | 뜻 |
| --- | --- | --- |
| `PEAKET_ENV` | 없음(운영으로 본다) | `local`·`ci`·`demo`·`staging`·`prod` |
| `PEAKET_DEBUG_ERRORS` | `false` | `true`면 Problem에 `debug`(예외 이름·스택 요약)를 싣는다. `local`·`ci`가 아니면 시작하지 않는다 |
| `PORT` | 8080 | 앱 포트 |
| `PEAKET_MANAGEMENT_PORT` | 9464 | 관리 포트(`/metrics`). 앱 포트와 달라야 한다 |
| `PEAKET_MAX_DEADLINE_MS` | 15000 | 받은 남은 시간(`x-peaket-deadline-ms`)의 상한 |
| `PEAKET_LOG_PSEUDONYM_KEY` | 없음 | 로그 가명 키(base64로 32바이트, External Secrets Operator가 넣는다). `demo`·`staging`·`prod`에서 없으면 시작하지 않는다 |
| `PEAKET_LOG_SAMPLE_ONE_IN` | 10 | 정상 줄 표본 'N건에 1건'(평시 10%) |
| `PEAKET_LOG_SLO_LATENCY_MS` | 500 | 경로에 SLO 지연을 적지 않았을 때 전수로 남기는 지연(NFR-011) |
| `PEAKET_LOG_LEVEL` | `info` | 서비스 로거 수준. 정규 로그 줄은 이 값과 관계없이 `info`부터 낸다 |
| `PEAKET_VERSION`·`PEAKET_AZ`·`PEAKET_POD` | `unknown`·없음·호스트 이름 | 로그의 `version`·`az`·`pod`(배포 차트가 넣는다) |
| `OTEL_SERVICE_NAME` | 없음 | 등록 파일이 쓰는 서비스 이름(필수) |
| `PEAKET_TRACE_INBOUND` | `mesh` | 들어온 추적 문맥을 잇는가. 앱 서버는 `untrusted`(링크로만) |
| `OTEL_EXPORTER_OTLP_ENDPOINT`·`OTEL_TRACES_EXPORTER`·`OTEL_SDK_DISABLED` | OTel 기본값 | 추적 내보내기(OTLP HTTP/protobuf). `none`이면 보내지 않는다 |

## 서비스 뼈대

`template/`는 서비스 하나의 최소 모양이다(docs/architecture.md §3.1). 새 서비스는 이 폴더를 `services/<이름>/`로 복사하고 예시 컨텍스트(`example`)를 바꾼다.

| 자리 | 층 | 가져올 수 있는 것 |
| --- | --- | --- |
| `src/main.ts`·`src/app.module.ts` | 시작·뿌리 | 모두 |
| `src/modules/<컨텍스트>/<컨텍스트>.module.ts` | 조립(포트에 어댑터를 묶는다) | 모두 |
| `…/inbound/` | 받는 층(REST·gRPC 처리기, Kafka 소비자) | 유스케이스·도메인, 계약 생성물, 플랫폼 |
| `…/application/` | 유스케이스 | 도메인, `@nestjs/common`의 주입 장식자, 플랫폼의 Problem·요청 맥락 |
| `…/domain/` | 업무 규칙·상태와 포트 | 도메인 안의 파일만 |
| `…/adapters/` | 포트 구현(저장소·다른 서비스·외부 제공자) | 도메인, Drizzle·pg·플랫폼 |
| `…/adapters/db/schema.ts`·`migrations/`·`drizzle.config.ts` | Drizzle 표 정의와 마이그레이션 SQL(`drizzle-kit generate`). 멱등 기록 표(`0001`)와 Outbox 부모 표(`0002`, 손으로 쓴 SQL, 파티션은 `ensureOutboxPartitions`가 만든다)를 함께 둔다 | — |

다른 컨텍스트는 그 모듈의 공개 파일(`index.ts`)로만 가져온다. 규칙은 `@peaket/config/eslint/service-layers`이고 뿌리 `pnpm lint`가 `services/*`와 이 뼈대를 본다. 서비스의 의존성은 `@peaket/platform`·`@nestjs/common`·`drizzle-orm`·`zod`, 개발 의존성은 `drizzle-kit`이다.

## 서비스 OpenAPI 차이(D-T38)에 넣기

서비스 `package.json`에 두 가지를 둔다. `tools/ci/service-openapi.mjs`가 CI 계약 잡에서 견준다.

```json
{
  "scripts": { "openapi:emit": "node dist/openapi-emit.js" },
  "peaket": { "contractOperations": ["POST /v1/queues/{eventId}/entries"] }
}
```

`openapi-emit.js`는 `emitOpenApi({ module: AppModule, out: process.env.OPENAPI_OUT, title: 'queue-svc' })`를 부른다.

## 명령

| 명령 | 하는 일 |
| --- | --- |
| `pnpm --filter @peaket/platform test` | Vitest 시험(남은 시간, Problem, 지표, 문서 뽑기, 정규 로그 줄, 가명, SDK를 띄운 추적 문맥과 V-T31 ③, 요청 검사와 두 길의 표본 일치, 본문 형식, 인증 가드, 멱등 키·원시 본문, UUIDv7·파티션 경계, Lease, 릴레이 반복, Kafka 필수 설정, 키 단위 처리와 보류, 제어 동기화와 준비 표시, 정비 반복, 서비스 뼈대) |
| `pnpm --filter @peaket/platform test:integration` | 실제 PostgreSQL 18·Kafka 3.9.2·Valkey 8.1 컨테이너(`docker run`) 시험: Drizzle 설정, 풀 대기 429, 행 보안과 `SET LOCAL`, 멱등 기록(처리 중·다른 본문·보관), Outbox 쓰기·릴레이 순서·실패 뒤 다시·두 릴레이, 일 파티션 만들기·지우기, Kafka로 보내기와 브로커 정지(V-T28 ②)·키 단위 소비·방송형 읽기, 보류 표, 월 파티션·통계 스냅샷·보존 지우기·인덱스 다시 만들기·정비 반복, Stream 정리, 뼈대의 Drizzle 어댑터. Docker 엔진이 있어야 한다 |
| `pnpm --filter @peaket/platform typecheck` | 타입 검사 |
| `pnpm --filter @peaket/platform build` | `dist/` 빌드 |

## 아직 없는 것

릴레이·정비 Deployment·실제 Lease 확인(FND-110), MSK IAM 토큰 함수(FND-120), Avro 인코더·디코더(BAS-030), 마이그레이션 직후 파티션 만들기와 `pgstattuple`·정비 역할(BAS-060), 온세일 구간 로그 표본 비율 연결(미해결 OPEN[09]), 현장 스태프 역할 판정(GAT-170), 프로브와 시간 초과 기본값(0.3.6), gRPC 채널 생성 함수(0.3.3), 엣지 게이트웨이의 추적 헤더 지우기와 앱 서버 연결(2.11.1), 동적 로그 수준 명령(관제 명령 8), exemplar·Pyroscope(4.1.1).
