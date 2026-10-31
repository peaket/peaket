# ADR-0023: 대규모 트래픽 핫패스 서비스(queue-svc, purchase-svc)의 NestJS Fastify 어댑터 채택

- **상태**: 채택 (2026-10-08 설계서 16장에 최초 수립, 같은 날 아키텍처 결정 레코드(ADR)로 공식 이관) 2026-10-28(기술 검토 중간-026, 소유자 승인 '추천안 동의'): 결정 3의 `enableAutoPipelining`은 ioredis 옵션이다. ioredis README가 최선의 노력으로만 유지한다며 새 프로젝트에 node-redis를 권해, 기본 클라이언트를 node-redis로 두는 쪽을 추천하고 PoC(V-T33, docs/architecture.md §9.4)로 확정한다. node-redis는 같은 이벤트 루프 차례의 명령을 기본으로 묶어 보내므로 결정 3의 효과(소켓 호출 줄이기)는 그대로다. 결과는 PoC 뒤 새 ADR로 남긴다. 2026-10-28(기술 검토 낮음-001, 소유자 승인 '추천안 동의'): 결정 1의 '사전 컴파일된 JSON Schema 기반 직렬화'는 경로에 스키마를 줄 때만 쓰인다(NestJS `@RouteSchema()`, Fastify 문서 2026-10-28 확인). 검사를 Zod 파이프로만 하면 그 이득이 없다. 그래서 핫패스 경로(대기열 진입·입장 확정, 좌석 홀드·해제·연장, 결제 접수)는 계약에서 만든 Zod 스키마를 `z.toJSONSchema()`로 바꿔 `@RouteSchema()`의 요청·응답 스키마로 넣고, 그 경로에서는 Zod 파이프를 뺀다. `text/plain` 본문(ADR-0065)은 그 형식의 본문 해석기와 `content` 스키마로 검사한다. 검토한 대안의 'Fastify 대비 2배 이상'은 측정 전 주장으로 읽는다. 이득은 V-T41(Express + Zod 파이프, Fastify + Zod 파이프, Fastify + 경로 스키마)로 재고, 경로 스키마가 요청당 CPU를 5% [가정] 넘게 줄이지 못하면 Zod 파이프 하나로 되돌리고 Fastify를 고른 이유를 라우팅·로깅 오버헤드로만 적는다(docs/architecture.md §6.1, docs/api/guidelines.md §1, docs/verification.md §9). 2026-10-28(기술 검토 낮음-143, 소유자 승인 '추천안 동의'): 결정 1의 '핫패스 두 서비스만 Fastify'를 'HTTP를 받는 모든 NestJS 서비스가 Fastify 어댑터를 쓴다'로 바꾼다. 미들웨어·쿠키 파싱·원시 본문(결제 웹훅 서명 검증)·보안 헤더·요청 크기 제한·접근 로그가 어댑터마다 달라, 플랫폼 라이브러리를 한 벌만 두려는 것이다. 처리량 차이는 V-T41에서 재고, ②가 ①보다 낫지 않으면 어댑터를 모든 서비스에서 함께 다시 고른다. Express 전용 미들웨어가 꼭 필요한 서비스가 생기면 그때 예외로 적는다(docs/architecture.md §6.1). 2026-11-01(openspec 변경 `add-service-structure-and-request-checks`, BUILD_ORDER FND-070, 추천 적용 2026-11-01): 서비스 템플릿에 두 검사를 만들었다. Zod 파이프는 `nestjs-zod` 5.5.0의 peer가 NestJS 11까지라 같은 일을 하는 파이프를 `packages/platform`에 두었고, 경로 스키마의 검사기는 Fastify 기본 Ajv 설정(형 바꾸기, 정의 밖 칸 지우기)을 끄고 `strictNumbers`를 켜 Zod와 같게 했다. 위 2026-10-28 줄의 '`text/plain` 본문은 그 형식의 본문 해석기와 `content` 스키마로 검사한다'는 해석기만 그대로다. 형식별 `content` 스키마는 맞는 형식이 없으면 Fastify가 검사를 건너뛰어 본문 없는 POST가 통과했으므로 본문 스키마 하나를 둔다(코드 리뷰 2026-11-01, docs/api/guidelines.md §1).
- **관련 문서**: 설계서 16장(Fastify 및 비동기 처리), 20장(Redis 클라이언트 최적화), §9(지연 시간 예산)
- **관련 ID**: NFR-001, NFR-003, NFR-005

## 맥락
- 대기열 진입 구간의 목표 처리량인 200,000 RPS와 좌석 홀드 트랜잭션의 p99 50ms 미만 지연 시간 목표를 달성하려면, Node.js 런타임 내 HTTP 계층의 직렬화 및 파싱 오버헤드를 극단적으로 낮추어야 한다.
- 초기에는 RxJS 스트림을 도입하여 백엔드 Redis I/O 효율을 높이자는 가설이 제기되었으나, RxJS는 I/O 횟수를 줄이는 것이 아니라 단지 함수형 리액티브 래핑에 따른 클로저 생성 및 스택 프레임 오버헤드만 가산시킨다는 점이 확인되었다. 실질적인 Redis I/O 처리량은 네트워크 자동 파이프라이닝, 서버 측 Lua 원자 실행, 그리고 바이너리 직렬화가 좌우한다.

## 결정
1. 대규모 트래픽을 직접 감당하는 핫패스 마이크로서비스(`queue-svc`, `purchase-svc`)는 기본 Express 대신 `Fastify` 어댑터를 사용한다. 사전 컴파일된 JSON Schema(`fast-json-stringify`) 기반 직렬화와 `Pino` 비동기 로거를 결합하여 HTTP 계층의 CPU 소모를 최소화한다.
2. 백엔드 서비스의 핵심 비즈니스 로직에는 RxJS를 기본 기술로 채택하지 않는다. NestJS의 공식 인터셉터(`timeout`, `catchError`) 등 Observable 반환이 필수적인 프레임워크 접점에서만 최소한으로 제한 사용하며, 서비스 제어 흐름과 스트림 처리는 표준 `async/await`, 네이티브 타이머, Node.js `Readable/Transform` 스트림으로 단일화한다.
3. 고성능 Redis I/O 최적화를 위해 클라이언트 차원의 `enableAutoPipelining` 설정을 활성화하여 동일 이벤트 루프 틱에서 발생하는 다중 쿼리를 단일 TCP 패킷으로 일괄 전송한다. 복합 상태 변경은 Lua 스크립트를 통해 네트워크 왕복 1회로 끝내며, 초고속 캐시 경로는 Buffer 바이너리 직렬화를 적용한다.

## 검토한 대안
| 대안 | 기각 사유 및 한계점 |
| --- | --- |
| 기본 Express 어댑터 유지 | 미들웨어 체인 오버헤드와 런타임 JSON 직렬화 병목으로 인해 고부하 구간에서 CPU 포화가 조기에 발생하며 초당 처리량이 Fastify 대비 2배 이상 저하된다. |
| 백엔드 전반에 RxJS 연산자로 I/O 제어 | 네트워크 I/O 왕복 횟수 자체를 물리적으로 줄이지 못하며, 요청당 생성되는 Observable 인스턴스와 가비지 컬렉션(GC) 압박으로 인해 핫패스 p99 지연 시간만 악화된다. |

## 결과와 트레이드오프
- Fastify 기반 컴파일 직렬화와 Redis 자동 파이프라이닝의 결합을 통해 대기열 처리 노드의 단위 CPU당 처리량이 극대화되고 지연 시간 변동성이 억제된다.
- Express 전용으로 작성된 일부 서드파티 미들웨어 패키지와의 호환성이 제한되므로, Fastify 플러그인 생태계에 부합하는 대안 라이브러리를 선별하여 탑재해야 한다.
