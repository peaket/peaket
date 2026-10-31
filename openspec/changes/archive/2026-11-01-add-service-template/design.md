# 설계: 서비스 템플릿 뼈대

## 맥락

정본이 정한 것: 모든 HTTP 서비스는 NestJS + Fastify 어댑터 한 벌을 쓴다(architecture §6.1). 계측은 OTel 규약과 `@prometheus-io/client`로 하고 지표 정의는 `packages/platform` 한 곳에 둔다(devops §4.4). 지연 히스토그램은 표준 칸 20개를 쓰고 개별 서비스가 바꾸지 않는다(observability §8). 처리 중 요청 게이지는 `http_server_active_requests`다(ADR-0077 결정 5). 409 경합 패배는 오류가 아니라 정상 분기로 따로 센다(guidelines §2, NFR-003, ADR-0069 결정 5). 오류 본문은 RFC 9457 Problem 하나다(guidelines §2). 남은 시간은 줄어들기만 하고 모자라면 바로 실패한다(guidelines §5). 서비스는 API 문서 경로를 내지 않고, `@nestjs/swagger` 문서는 CI 안에서만 파일로 뽑아 계약과 견준다(D-T38, ASVS 13.4.5).

정본에 없는 작은 세부는 아래처럼 정했다(추천 적용 2026-11-01). 정본 문서에도 같은 날짜로 적는다.

## 결정

1. **패키지 모양**: `@peaket/platform`은 ESM TypeScript이고 `tsc`로 `dist/`를 만든다(서비스는 빌드한 JS를 쓴다. Node의 형 지우기는 데코레이터를 바꾸지 않는다). 시험은 Vitest로 소스를 바로 돈다. 2026-11-01 확인: TypeScript 7.0.2는 `emitDecoratorMetadata`를 내고, Vitest 5에서 NestJS 12의 생성자 주입이 돈다. NestJS 12는 ESM 패키지다.
   - `@nestjs/swagger` 12.0.5의 동반 의존성은 TypeScript `^5.5 || ^6`이다. 이것은 빌드 때 쓰는 swagger 플러그인용이다. 플러그인은 쓰지 않고 TypeScript 7을 그대로 쓴다(설치 경고 하나가 남는다).
   - `swagger-ui-dist`가 끌고 오는 `@scarf/scarf` 설치 스크립트는 `allowBuilds`에 `false`로 적어 돌리지 않는다. 설치 때 사용 통계를 보내는 스크립트이고 문서 뽑기에 필요 없다.
2. **지표**(observability §3·§8에 적는다):
   - `http_server_request_duration_seconds`(히스토그램, OTel `http.server.request.duration`): 라벨 `service`·`route`·`method`·`status_class`, 칸은 표준 목록.
   - `http_server_active_requests`(게이지): 라벨 `service`·`route`·`method`. 처리 중에는 상태 코드를 모르므로 `status_class`는 없다. ADR-0077의 '라벨은 지연 히스토그램과 같다'를 '처리 중에 알 수 있는 라벨은 같다'로 읽는다(해석).
   - `http_server_errors_total`(카운터): 5xx 응답. 라벨은 히스토그램과 같다.
   - `http_server_business_rejections_total`(카운터): 정상 분기로 표시한 Problem(예: 좌석 경합 409)으로 답한 응답. 라벨은 히스토그램과 같다. 정상 분기는 오류를 던진 코드가 Problem에 표시한다. 상태 코드만으로는 경합 409와 처리 중 409(`idempotency-request-in-progress`)를 가를 수 없어서다.
   - `route`는 Fastify 경로 틀을 계약 표기로 바꾼 값(`/v1/events/:eventId` → `/v1/events/{eventId}`)이고, 맞는 경로가 없으면 `unmatched`다. 실제 자원 ID는 라벨에 들어가지 않는다(observability §8).
   - Node 기본 지표(`collectDefaultMetrics`, 이벤트 루프 지연 포함)를 함께 낸다(포화도).
   - 지표는 앱 포트와 다른 관리 포트(기본 9464, OTel Prometheus 내보내기 기본 포트)의 `GET /metrics`로만 낸다. 관리 포트에는 지표 말고 다른 경로가 없다. 프로브(`/livez` 등)는 wbs 0.3.6에서 같은 포트에 더한다.
3. **Problem**(guidelines §2에 적는다):
   - 코드는 `ProblemError`(이름 `type`, 상태, 제목, 설명, 확장 필드, 정상 분기 표시, `Retry-After`)를 던진다. `type`은 `https://peaket.example/problems/<케밥 이름>`이다. 확장 필드가 표준 칸(`type`·`title`·`status`·`detail`·`instance`·`traceId`·`debug`)과 겹치면 만들 때 던진다.
   - 이름 없는 오류(Nest HTTP 예외, Fastify의 본문 해석 오류, 없는 경로)는 `type: about:blank`와 HTTP 상태 문구를 제목으로 낸다(RFC 9457 §4.2.1). 이름 붙은 `type` 목록은 wbs 0.2.3에서 만든다. 설명(`detail`)은 싣지 않는다. 응답 상태로 믿는 것은 HTTP 예외의 4xx·5xx와 Fastify 자체 오류(`code`가 `FST_`)의 상태뿐이고, 다른 오류가 단 `statusCode`는 믿지 않는다(코드 리뷰). 라우터 앞 오류(`frameworkErrors`, 잘못된 URL)도 같은 Problem으로 바꾸고 `instance`를 싣지 않는다.
   - 예상하지 못한 오류(HTTP 예외가 아닌 것)는 500, `about:blank`, `Internal Server Error`, `traceId`만 낸다(`instance`도 뺀다). 원본 예외는 같은 `traceId`로 서버 기록에 남긴다(ASVS 16.3.4·16.5.1). 기록 함수는 주입할 수 있고 기본은 표준 오류 출력의 JSON 한 줄이다. 정규 로그 줄은 FND-060에서 Pino로 바꾼다.
   - `traceId`는 지금 요청의 OTel 스팬이 있으면 그 trace-id, 없으면 요청마다 만든 무작위 32자리 16진수다. OTel SDK 시작과 신뢰 경계 규칙은 FND-060에서 한다.
   - `debug`(예외 이름·메시지·스택 앞 10줄)는 `PEAKET_DEBUG_ERRORS=true`이고 `PEAKET_ENV`가 `local`·`ci`일 때만 싣는다. 다른 환경이나 환경 없음에서 켜면 시작이 실패한다. `PEAKET_ENV`는 `local`·`ci`·`demo`·`staging`·`prod` 가운데 하나이고, 없으면 운영으로 본다(닫힘 실패).
4. **deadline**(guidelines §5에 적는다):
   - 게이트웨이는 경로마다 정한 최대 허용 시간(밀리초)을 요청 헤더 `x-peaket-deadline-ms`에 덮어써 넣는다(HTTPRoute 요청 헤더 바꾸기의 `set`이라 바깥에서 보낸 같은 이름의 값은 남지 않는다. 게이트웨이 설정은 wbs 2.11.x). Envoy의 `x-envoy-expected-rq-timeout-ms`는 Envoy 문서가 '내부 요청에 붙인다'고만 적어 바깥 요청의 첫 구간에서 믿을 수 없어 쓰지 않는다(2026-11-01 원문 확인).
   - 서비스는 받은 때부터 min(헤더 값, 서비스 상한)을 남은 시간으로 둔다. 헤더가 없거나 양의 정수가 아니면 서비스 상한이다. 상한 기본값은 15,000ms다(Envoy 경로 시간 초과 기본값 15초, infra §4.1).
   - 다음 호출에는 min(남은 시간, 그 호출의 상한)을 준다. gRPC에는 절대 시각으로 준다(채널 생성 함수는 FND-100).
   - 남은 시간이 기준보다 모자라면 시작하지 않고 504 Problem `deadline-exceeded`로 끝낸다. 게이트웨이의 시간 초과도 504라 클라이언트가 보는 결과가 같다. 5xx라 오류 카운터에 든다(느린 의존성의 신호다).
   - 시각은 주입한 시계로 잰다(`Clock`: 벽시계 `now()`와 단조 시계 `monotonicMs()`). 남은 시간은 단조 시계로, gRPC용 절대 시각은 벽시계로 바꾼다.
5. **요청 맥락**: Fastify `onRequest` 훅이 `AsyncLocalStorage.run`으로 요청 맥락(traceId, deadline, 경로 틀)을 연다. 처리기·가드·필터는 같은 맥락을 읽는다(architecture §6.1 'REQUEST 스코프 대신 AsyncLocalStorage').
6. **문서 뽑기(D-T38)**: `emitOpenApi`가 앱을 듣지 않고 미리 보기 모드로 만든 뒤 `SwaggerModule.createDocument`로 문서를 만들어 파일로 쓴다. 서비스의 `openapi:emit` 스크립트는 환경 변수 `OPENAPI_OUT`의 경로에 쓴다. `contractSchema(zod)`는 계약에서 만든 Zod를 Zod 4 `z.toJSONSchema`(`openapi-3.0`, 기본 입력 기준)로 바꿔 swagger 데코레이터에 넣는다. 생성 Zod의 입력 기준이 계약 모양이라서다(출력 기준이면 기본값 칸이 필수가 된다, 코드 리뷰). 실행하는 앱은 `SwaggerModule.setup`을 부르지 않아 `/api`·`/api-json`·`/docs`가 404다.
7. **비교 본체(D-T38, devops §3.1에 적는다)**:
   - 서비스는 `package.json`의 `peaket.contractOperations`에 맡는 계약 작업을 `"<메서드> <경로>"`로 적는다. 목록이 없거나 비면 실패한다.
   - 실패: 목록의 작업이 계약에 없음, 목록의 작업이 서비스 문서에 없음, 서비스 문서의 작업이 목록에 없음(계약에 없는 경로 포함).
   - 맡는 작업마다 견준다. 매개변수: (위치, 이름, 필수 여부, 모양)의 모음이 같아야 한다(머리 이름은 소문자로). 요청 본문: 있음·필수 여부, 내용 형식 모음, 형식별 모양. 응답: 2xx 상태 모음은 같아야 하고, 서비스가 적은 4xx·5xx는 계약에 있어야 하며 본문 모양이 같아야 한다. 계약의 4xx·5xx를 서비스가 적지 않은 것은 괜찮다(게이트웨이·공용 필터가 내는 오류가 있다).
   - 모양: `$ref`를 풀고 `type`(OpenAPI 3.0의 `nullable`은 `null` 형으로), `properties`, `required`, `items`, `enum`(`const` 포함), 조합, 객체형 `additionalProperties`만 본다. 설명·예시·형식(`format`)·길이·범위·기본값·`x-` 확장은 보지 않는다(정본 '모양만 견준다'). 요청에서는 읽기 전용, 응답에서는 쓰기 전용 칸을 뺀다. 같은 뜻의 다른 표기(Zod의 null 조각, `oneOf`와 `anyOf`, 값 목록 union과 열거, 스칼라 형 union과 형 배열, 숫자 열거의 형)는 같게 읽고, `$ref` 순환은 지나온 `$ref`로 멈춘다(코드 리뷰). 계약의 모든 작업을 계약 Zod로 바꾼 문서가 이 비교에서 계약과 같은지 플랫폼 시험(`contract-sweep.test.ts`)이 지킨다.
   - 서비스 문서를 만드는 것은 `pnpm --dir services/<이름> run openapi:emit`(시험에서는 바꿔 끼운다)이고, 만들지 못하면 실패다(닫힘 실패).
8. **CI 잡**: `ci-node.yml`이 잠금 파일대로 설치하고 `turbo run typecheck test build`를 돈다. 범위가 `js_all`이거나 범위를 고르지 못했으면 전체, 아니면 `--affected`(기준은 `TURBO_SCM_BASE`: PR은 대상 가지의 기준 커밋, 푸시는 앞 커밋. 없으면 전체)에 서비스 템플릿 시험을 늘 더한다(패키지 밖 정본과 견주는 시험이 있다). `typecheck`·`test`는 기대는 패키지의 `build`를 먼저 한다(플랫폼은 `dist/`를 내보낸다). `ci-node.yml`·`turbo.json`·`.nvmrc`가 바뀌면 전체, `docs/observability.md`가 바뀌면 자바스크립트 범위를 켠다. `packages/platform`·`service-openapi.mjs`가 바뀌면 계약 잡도 돈다. 린트·ASVS 태그 보고·컨테이너 통합 시험은 그 도구가 생기는 단계에서 더한다.

## 위험과 남는 것

- 정상 분기 표시는 오류를 던진 코드가 해야 한다. 표시를 빠뜨리면 경합 409가 정상 분기 카운터에 들지 않는다(오류 카운터에는 들지 않는다. 4xx라서). 기능 단계의 지표 시험이 본다(verification §2.7 지표 내보내기 층).
- 바깥에서 들어온 요청이 `x-peaket-deadline-ms`를 짧게 보내도 자기 요청만 빨리 실패한다. 길게 보내도 서비스 상한에 묶인다. 게이트웨이가 덮어쓰기 전에는 이 헤더를 믿지 않는 것과 같다.
- 모양 비교는 형식·범위를 보지 않는다. 그것은 생성 Zod(계약에서 만듦)로 서비스가 지킨다.
