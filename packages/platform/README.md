# @peaket/platform

서비스(NestJS 12 + Fastify 5)가 함께 쓰는 서버 공용 패키지다. 모든 서비스가 같은 모양의 계측, 오류 응답, 남은 시간 전파, 로그, 추적 문맥을 갖게 한다(docs/architecture.md §10, NFR-011). 게시하지 않고 `workspace:`로만 잇는다(ADR-0165).

- 만든 곳: openspec 변경 `add-service-template`(2026-11-01, wbs 0.3.1 ①, BUILD_ORDER FND-050)과 `add-service-logging`(2026-11-01, wbs 0.3.1 ②, BUILD_ORDER FND-060). 설계와 이유는 그 변경의 design.md에 있다.
- 서비스는 빌드한 `dist/`를 쓴다(`pnpm --filter @peaket/platform build`). Node의 형 지우기는 데코레이터를 바꾸지 않기 때문이다.

## 쓰는 법

```ts
// main.ts. 실행: node --import @peaket/platform/telemetry/register dist/main.js
import { createService } from '@peaket/platform';
import { shutdownTelemetry } from '@peaket/platform/telemetry';
import { AppModule } from './app.module.js';

const svc = await createService({ name: 'queue-svc', module: AppModule });
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

하위 경로:

| 경로 | 하는 일 |
| --- | --- |
| `@peaket/platform/telemetry` | `startTelemetry`·`shutdownTelemetry`. OTel Node SDK를 시작하는 유일한 곳(docs/devops.md §4.4). NestJS를 읽지 않아 앱 서버도 쓸 수 있다 |
| `@peaket/platform/telemetry/register` | `--import`로 읽는 등록 파일. 환경 변수로 `startTelemetry`를 부른다 |
| `@peaket/platform/testing` | V-T31 ③ 탐침 `probeTraceHeaders`. 외부 어댑터의 시험이 모의 서버가 받은 헤더에 추적 헤더가 없는지 본다. 텔레메트리를 시작하지 않은 채 부르면 실패한다 |

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
| `pnpm --filter @peaket/platform test` | Vitest 시험(남은 시간, Problem, 지표, 문서 뽑기, 정규 로그 줄, 가명, SDK를 띄운 추적 문맥과 V-T31 ③) |
| `pnpm --filter @peaket/platform typecheck` | 타입 검사 |
| `pnpm --filter @peaket/platform build` | `dist/` 빌드 |

## 아직 없는 것

인증 가드·층 의존 린트·요청 검사(0.3.2), 프로브와 시간 초과 기본값(0.3.6), gRPC 채널 생성 함수(0.3.3), Kafka 감싸기의 추적 헤더(0.3.2 ③), 엣지 게이트웨이의 추적 헤더 지우기와 앱 서버 연결(2.11.1), 동적 로그 수준 명령(관제 명령 8), exemplar·Pyroscope(4.1.1).
