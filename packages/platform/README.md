# @peaket/platform

서비스(NestJS 12 + Fastify 5)가 함께 쓰는 서버 공용 패키지다. 모든 서비스가 같은 모양의 계측, 오류 응답, 남은 시간 전파를 갖게 한다(docs/architecture.md §10, NFR-011). 게시하지 않고 `workspace:`로만 잇는다(ADR-0165).

- 만든 곳: openspec 변경 `add-service-template`(2026-11-01, wbs 0.3.1 ①, BUILD_ORDER FND-050). 설계와 이유는 그 변경의 design.md에 있다.
- 서비스는 빌드한 `dist/`를 쓴다(`pnpm --filter @peaket/platform build`). Node의 형 지우기는 데코레이터를 바꾸지 않기 때문이다.

## 쓰는 법

```ts
import { createService } from '@peaket/platform';
import { AppModule } from './app.module.js';

const svc = await createService({ name: 'queue-svc', module: AppModule });
await svc.listen();
```

| 내보내는 것 | 하는 일 | 정본 |
| --- | --- | --- |
| `createService` | 시작 설정을 검사하고, 앱 포트(NestJS·Fastify)와 관리 포트(`/metrics`)를 만든다. 요청마다 네 신호를 재고 요청 맥락(trace-id, 남은 시간)을 연다 | docs/observability.md §3 '서비스 템플릿이 내는 HTTP 지표' |
| `ProblemError` | 이름 붙은 오류. 전역 필터가 RFC 9457 Problem 본문(`application/problem+json`)으로 바꾼다. 정상 분기(예: 좌석 경합 409)는 `normalBranch: true`로 표시한다 | docs/api/guidelines.md §2 |
| `currentDeadline()` | 지금 요청의 남은 시간. `budgetFor(상한)`은 다음 호출에 줄 시간, `ensure(필요한 시간)`은 모자라면 504 `deadline-exceeded`를 던진다 | docs/api/guidelines.md §5 |
| `CLOCK`·`fakeClock` | 주입하는 시계(벽시계·단조 시계)와 시험용 시계 | 시간 의존 로직은 Clock 주입 |
| `emitOpenApi`·`contractSchema` | CI 안에서만 서비스 OpenAPI 문서를 파일로 뽑는다(미리 보기 모드라 제공자를 만들지 않는다). `contractSchema`는 계약 Zod를 swagger 데코레이터용 스키마로 바꾼다. 기본은 입력 기준이라 계약과 같은 모양이 된다(`{ io: 'output' }`은 기본값이 채워진 뒤의 모양). 실행 중인 서비스는 문서 경로를 내지 않는다 | D-T38, docs/devops.md §3.1 |
| `LATENCY_BUCKETS_SECONDS` | 지연 히스토그램 표준 칸 20개. 개별 서비스가 바꾸지 않는다 | docs/observability.md §8 |

## 설정(환경 변수)

| 이름 | 기본값 | 뜻 |
| --- | --- | --- |
| `PEAKET_ENV` | 없음(운영으로 본다) | `local`·`ci`·`demo`·`staging`·`prod` |
| `PEAKET_DEBUG_ERRORS` | `false` | `true`면 Problem에 `debug`(예외 이름·스택 요약)를 싣는다. `local`·`ci`가 아니면 시작하지 않는다 |
| `PORT` | 8080 | 앱 포트 |
| `PEAKET_MANAGEMENT_PORT` | 9464 | 관리 포트(`/metrics`). 앱 포트와 달라야 한다 |
| `PEAKET_MAX_DEADLINE_MS` | 15000 | 받은 남은 시간(`x-peaket-deadline-ms`)의 상한 |

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
| `pnpm --filter @peaket/platform test` | Vitest 시험(남은 시간, Problem, 지표, 문서 뽑기) |
| `pnpm --filter @peaket/platform typecheck` | 타입 검사 |
| `pnpm --filter @peaket/platform build` | `dist/` 빌드 |

## 아직 없는 것

정규 로그 줄·로그 가명·추적 문맥 규칙(wbs 0.3.1 ②), 인증 가드·층 의존 린트·요청 검사(0.3.2), 프로브와 시간 초과 기본값(0.3.6), gRPC 채널 생성 함수(0.3.3).
