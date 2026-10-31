# 설계: 서비스 템플릿 로그·추적 문맥

## 맥락

정본이 정한 것:

- 정규 로그 줄: 요청이 끝날 때 서비스마다 한 줄이다. 필수 13필드(`ts`·`level`·`service`·`env`·`version`·`traceId`·`spanId`·`eventId`·`route`·`status`·`durationMs`·`msg`·`err`)에 `az`·`pod`·`app`·`client`·`pg`·`queuePhase`·`flags`·`dep`·`sampleRate`를 더한다(ADR-0069 결정 11, observability §7). Pino로 표준 출력에 JSON을 쓴다.
- 표본: 정상 줄은 온세일 1%·평시 10% [가정]이고, 4xx·5xx·서킷 503·'곧 입장' 완충 응답·SLO 지연 초과는 전수다. 앱이 정하고 수집기는 다시 거르지 않는다. 정상 표본은 trace ID 끝 56비트 R ≥ (1 − p) × 2^56이고, 같은 값을 서버 span의 `peaket.sample.keep`에 단다. 머리 표본(진입 경로)의 정상 줄은 늘 남기고, 진입 경로의 의도한 거절(403·429)은 정상 줄과 같은 문턱으로 줄인다(ADR-0076 결정 4, ADR-0125 결정 1·3, observability §6·§7).
- 가명: `pidRef`·`sidRef`·`accountRef` = `HMAC-SHA256(로그 가명 키, 값)`의 앞 16바이트(base64url). 키는 Secrets Manager의 256비트 난수이고 플랫폼 로거만 쓴다. IP는 앞부분(IPv4 /24, IPv6 /48)만(ADR-0053 결정 1, secrets-and-keys). External Secrets Operator가 비밀을 환경 변수로 넣고, 교체한 비밀은 30일 안에 파드가 다시 떠서 읽는다(devops §8.3).
- 가림: Pino `redact`로 이름·전화·이메일·주소·연계정보·토큰·쿠키·`Authorization`·`paymentKey` 일부·`paymentToken`·환불 계좌·가상계좌·QR 서명을 먼저 가리고, 수집기가 다시 본다. 본문은 어떤 수준에서도 남기지 않는다(observability §7).
- 신뢰 경계: 외부 제공자 어댑터는 `traceparent`·`tracestate`·`baggage`를 싣지 않고, 공용 HTTP 클라이언트의 외부용 설정이 span은 만들되 전파 헤더를 싣지 않는다. 같은 출처 앱 서버는 브라우저가 보낸 값을 부모로 쓰지 않고 링크로만 남긴다. 시험은 V-T31(③ CI의 외부 호출 헤더 검사)이다(ADR-0130, observability §6, verification V-T31).
- OTel Node SDK 실험 패키지는 판을 고정하고 `packages/platform` 시작 코드 한 곳에서만 부른다. 서비스 코드는 `@opentelemetry/api`만 쓴다(devops §4.4).

정본에 없는 작은 세부는 아래처럼 정했다(추천 적용 2026-11-01). 정본 문서에도 같은 날짜로 적는다.

## 결정

1. **패키지와 판**: `pino` 10.4.0, `@opentelemetry/sdk-node`·`instrumentation-http`·`exporter-trace-otlp-proto` 0.300.0, `instrumentation-undici` 0.34.0, `core`·`resources`·`sdk-trace` 3.0.0. 실험 판(0.x)은 범위 없이 정확한 판으로 적는다. OTLP 내보내기가 끌고 오는 `protobufjs`의 설치 스크립트(판 표기 경고만 찍는다)는 `allowBuilds: false`로 돌리지 않는다.

2. **정규 로그 줄 모양**(observability §7에 적는다):
   - 한 줄 = JSON 객체 하나, 표준 출력. `msg`는 `request`(끊긴 요청은 `request aborted`).
   - `ts`는 주입한 시계의 벽시계 값을 KST 오프셋을 붙인 ISO 8601로 쓴다(`2026-11-01T14:03:05.120+09:00`). 감독 규칙의 'KST 고정'과 ASVS 16.2.2의 'UTC 또는 시간대 오프셋'을 함께 맞춘다. delivery.md 16.2.2의 'UTC ISO 8601'을 이 뜻으로 고친다.
   - `level`은 이름(`info`·`warn`·`error`)이다. 5xx는 `error`, 정상 분기가 아닌 4xx는 `warn`, 그 밖은 `info`다. 정규 로그 줄은 서비스 로그 수준 설정과 관계없이 `info`부터 낸다(수준을 올려도 표본 집계가 깨지지 않게).
   - 바탕 필드: `service`(서비스 이름), `env`(`PEAKET_ENV`), `version`(`PEAKET_VERSION`, 없으면 `unknown`), `az`(`PEAKET_AZ`, 없으면 뺌), `pod`(`PEAKET_POD`, 없으면 호스트 이름. 쿠버네티스 파드의 호스트 이름은 파드 이름이다). 값을 넣는 일은 배포 차트(wbs 0.4.x)가 한다.
   - 요청 필드: `traceId`·`spanId`(OTel 서버 span. SDK가 없으면 `traceId`는 요청마다 만든 값이고 `spanId`는 뺀다), `route`(지표와 같은 경로 틀, 없으면 `unmatched`), `method`(지표 라벨과 같다. 더한 필드), `status`, `durationMs`(단조 시계, 소수 셋째 자리), `app`(게이트웨이가 넣는 `x-peaket-app`이 `web`·`partner`·`console`·`scanner` 가운데 하나일 때만), `client`(User-Agent에서 뽑은 `계열/주 판`, 예: `chrome/130`. 원문은 쓰지 않는다. 계열은 edge·samsung·whale·opera·firefox·chrome·safari, 나머지는 `other`), `eventId`(경로 매개변수 `eventId`가 있으면 그 값).
   - 처리기가 `requestLog()`로 더하는 필드: `eventId`·`pg`·`queuePhase`(`lobby`·`waiting`·`purchase`)·`flags`(이름 목록)·`commandId`·`orderId`, `identify({ pid, sessionId, accountId })`가 만드는 `pidRef`·`sidRef`·`accountRef`, `dependency(이름, ms)`가 더하는 `dep`(이름마다 합, 이름은 소문자·숫자·`-` 32자까지).
   - 모르는 값은 칸을 뺀다(`null`로 쓰지 않는다).
   - `err`: 5xx의 예상하지 못한 오류는 `{ type: 예외 이름, message, stack }`. 이름 붙은 오류는 `{ type: Problem 이름, message: 제목 }`. 그 밖의 4xx는 `{ type: 오류 코드나 이름, message: HTTP 상태 문구 }`이고 원래 메시지는 쓰지 않는다(JSON 해석 오류의 메시지에는 본문 일부가, Nest의 404 메시지에는 쿼리 문자열이 들어간다). 스택은 5xx에만 남긴다.
   - 라우터 앞에서 끝난 요청(`frameworkErrors`, 잘못된 URL)도 같은 모양의 줄을 `route: unmatched`로 남긴다. 응답이 닿기 전에 끊긴 요청은 `aborted: true`이고 정상 줄처럼 표본을 고른다. 줄은 처리기가 끝나 응답을 보내려 할 때(`onSend`) 그 상태와 `err`로 쓴다. 끊긴 때 바로 쓰면 그 뒤 처리기가 던진 오류가 어디에도 남지 않는다(코드 리뷰). 처리기가 시작하기 전에 끊기면(preHandler 전) 바로 쓰고 `status`가 없다. 본문이 없는 GET은 처리기가 도는 중에도 onRequestAbort가 오므로 같은 규칙으로 기다린다. 처리기가 남은 시간 + 1초 안에 응답을 보내지 않으면 그때 `status` 없이 전수로 쓴다(다시 본 리뷰).
   - 예상하지 못한 오류를 따로 쓰던 `reportToStderr`와 `reportError` 선택지는 없앤다. 그 내용은 이 줄의 `err`에 든다(한 요청 한 줄).

3. **표본**(observability §6·§7에 적는다):
   - 비율은 'N건에 1건'인 정수 N이다. `PEAKET_LOG_SAMPLE_ONE_IN`(기본 10, 평시 10%)으로 시작하고, 실행 중에는 `service.logs.setSampleOneIn(n)`으로 바꾼다. 온세일 구간에 100으로 바꾸는 연결은 제어 상태 소비(FND-090)가 한다.
   - 문턱: R = trace ID의 끝 14자리(56비트), T = 2^56 − ⌊2^56 / N⌋, R ≥ T면 남긴다. (1 − 1/N) × 2^56 이상인 정수 R과 같은 조건이다. N = 1이면 모두 남긴다.
   - 전수(`sampleRate` 1): 4xx·5xx, 경로의 SLO 지연을 넘은 요청, 처리기가 `requestLog().keep()`으로 표시한 응답('곧 입장' 완충 응답 등). 서킷 503은 5xx라 전수다.
   - 정상(`sampleRate` N): 위가 아닌 응답과 끊긴 요청은 문턱을 넘으면 남긴다.
   - 경로 정책: 처리기에 `@LogPolicy({ entry: true, sloLatencyMs })`를 단다(Fastify 경로 설정에 들어간다). `sloLatencyMs`가 없으면 NFR-011의 REST p95 기준 500ms를 쓴다. `entry: true`(진입 경로)는 403·429를 정상 줄과 같은 문턱으로 줄이고, 들어온 trace의 표본 표시가 켜진 요청(게이트웨이의 머리 표본)의 정상 줄을 남긴다. 문턱 밖인데 머리 표본이라서 남긴 줄은 `sampleRate`를 0으로 적는다. 두 표본이 같은 요청을 고르는지는 [가정, wbs 4.1.4에서 확인]이라, 다시 셀 때 이 줄을 더하지 않아야 정상 수 추정(`sampleRate`의 합)이 치우치지 않는다.
   - 서버 span에는 요청을 받을 때 `peaket.sample.keep`(문턱 결과), `http.route`(경로 틀), `url.path`(경로 틀로 덮어씀)를 달고 이름을 `메서드 경로 틀`로 바꾼다. 진입 경로에서 표본 표시가 켜진 요청에는 `peaket.sample.mode="head"`를 단다.

4. **가명과 IP 앞부분**:
   - 키: 환경 변수 `PEAKET_LOG_PSEUDONYM_KEY`(base64 또는 base64url로 정확히 32바이트). `demo`·`staging`·`prod`(환경 없음 포함)에서 없거나 길이가 틀리면 시작하지 않는다(가명 없이 원문을 쓸 수 없으니 닫힘 실패). `local`·`ci`에서 없으면 프로세스마다 무작위 키를 만들고 경고 줄을 하나 남긴다(그 가명은 다시 뜨면 이어지지 않는다). 키는 `PlatformConfig`에 넣지 않고 가명 함수 안에만 둔다(설정 객체를 통째로 기록해도 새지 않게).
   - 가명 = HMAC-SHA256(키, 값)의 앞 16바이트를 base64url로(22자).
   - 교체: 새 키는 파드가 다시 뜰 때 읽는다(devops §8.3의 30일 안 재시작). 배포가 도는 동안 두 키가 함께 쓰여 같은 사람이 두 가명으로 보일 수 있다(남는 것).
   - IP 앞부분: IPv4는 `a.b.c.0/24`, IPv6는 앞 세 칸 `x:y:z::/48`(소문자, 앞 0 뺌), IPv4가 든 IPv6(`::ffff:a.b.c.d`)는 IPv4로 본다. 형식이 틀리면 값을 쓰지 않는다. 서버 span의 `client.address`를 span 시작 때 이 값으로 바꾼다(수집기의 2차 처리 앞의 1차).
   - 가림: 서비스 로거(Pino)의 로그 형식기가 위 목록의 칸 이름을 대소문자와 깊이(여덟 단계, 그보다 깊으면 통째로 뺀다)에 관계없이 `[REDACTED]`로 바꾼 사본을 쓴다. Pino `redact`는 대소문자를 가리고 깊이를 경로로 정해야 해서 `Authorization`·깊은 `email`이 남았다(코드 리뷰). 클래스 객체(DTO)는 JSON에 나가는 자기 칸을, `toJSON`이 있으면 그 결과를 보고, `child()`로 붙이는 값도 붙이기 전에 가린다(Pino는 자식 값에 형식기를 걸지 않는다, 다시 본 리뷰). 어느 칸에 든 Error든 `{type, message, stack}`만 남기고(HTTP 클라이언트 오류의 설정 머리가 나가지 않게), 지나온 객체를 다시 만나면 `[Circular]`, 한 번에 5,000개를 넘으면 `[TRUNCATED]`로 끊는다(세 번째 리뷰). 끊긴 요청의 대비 타이머는 줄을 쓰면 지운다(세 번째 리뷰). `paymentKey`는 뒤 4자만 남긴다(`****abcd`, '일부'의 뜻, 결제사 문의에 맞춰 볼 수 있게). 원문 식별값 칸(`pid`·`sessionId`·`accountId`·`ip`·`clientIp`)도 가린다. 가명은 `identify()`로만 넣는다.

5. **서비스 로거**: `service.logger`(Pino)를 내준다. 모든 줄에 같은 바탕 필드와, 요청 안이면 `traceId`·`spanId`를 넣는다. NestJS 자체 기록도 이 로거로 보낸다(JSON 한 줄). 로그 수준은 `PEAKET_LOG_LEVEL`(기본 `info`). 동적 수준 명령은 관제 명령 8 단계에서 한다.

6. **신뢰 경계**(observability §6, V-T31에 적는다):
   - 전파기: W3C Trace Context + W3C Baggage를 묶은 경계 전파기다. `withoutTracePropagation(fn)` 안의 요청에는 넣지 않는다(HTTP·undici 자동 계측 모두 이 전파기를 거친다).
   - 외부 호출 클라이언트 `createExternalHttpClient({ provider, baseUrl, timeoutCapMs })`: 경로 틀(`/v1/payments/{paymentKey}`)과 값을 따로 받아 URL을 만들고, span(CLIENT, 이름 `메서드 경로 틀`, `url.template`·`server.address`·`server.port`·`peaket.provider`·응답 코드)을 직접 만든다. undici 자동 계측은 이 요청을 건너뛰고(쿼리가 든 `url.full`을 남기지 않게) 전파도 하지 않는다. 호출하는 쪽이 넣은 추적 헤더도 지운다. 리디렉트는 따르지 않는다(`redirect: manual`, ASVS 15.3.2). 시간 초과는 min(상한, 남은 시간)이고 남은 시간이 0이면 504 `deadline-exceeded`를 던진다. 소요 시간은 정규 로그 줄의 `dep[provider]`에 더한다. 제공자가 요구할 때만 `traceContext: 'w3c'`로 `traceparent`·`tracestate`를 싣는다(허용 목록, 지금은 없다). `baggage`는 어떤 경우에도 싣지 않는다.
   - 들어오는 쪽 두 모드: `mesh`(서비스 기본, 메시 안에서 받은 부모를 잇는다. 엣지 게이트웨이가 바깥 값을 지운 뒤라서다)와 `untrusted`(앱 서버용). `untrusted`는 들어온 `traceparent`를 부모로 쓰지 않고 새 trace를 시작하며, 형식이 맞으면 서버 span의 링크로만 남긴다. `tracestate`·`baggage`는 버린다. 앱 서버에 잇는 일은 뒤 단계다.
   - span 시작 때 `url.path`·`url.query`를 비우고(서비스의 서버 span은 Fastify 훅이 경로 틀로 다시 채운다), 자동 계측 HTTP 클라이언트 span의 `url.full`은 출처만 남긴다. `network.peer.address`도 IP 앞부분, `user_agent.original`은 계열·주 판으로 바꾼다(코드 리뷰). 진입 경로의 머리 표본은 들어온 `traceparent`의 표본 표시로만 본다. 부모가 없으면 SDK가 뿌리 span을 늘 고르기 때문이다(코드 리뷰). 경로 값 `.`·`..`는 보내기 전에 거절하고, 만든 URL의 경로가 틀과 값으로 만든 경로와 다르면 보내지 않는다(코드 리뷰). 탐침은 call이 모의 서버로 요청을 하나도 보내지 않아도 실패한다(코드 리뷰).
   - V-T31 ③ 탐침 `probeTraceHeaders(call)`(`@peaket/platform/testing`): 기록하는 모의 서버를 띄우고, 표본 표시를 켠 span과 Baggage가 있는 맥락에서 `call(baseUrl)`을 돌린 뒤 받은 요청의 헤더를 돌려준다. 먼저 기본 `fetch`로 대조 요청을 보내 `traceparent`가 실리는지 보고, 실리지 않으면(텔레메트리를 시작하지 않음) 던진다. 탐침이 아무것도 못 잡는 채로 통과하지 않게 하려는 것이다. 외부 어댑터를 만드는 단계는 어댑터마다 이 탐침 시험을 둔다.

7. **OTel SDK 시작**(`@peaket/platform/telemetry`, devops §4.4에 적는다):
   - `startTelemetry({ serviceName, version, env, inbound, spanProcessors })`가 `NodeSDK`를 만든다. 자원 속성 `service.name`·`service.version`·`deployment.environment.name`, 경계 전파기, HTTP·undici 자동 계측, 위 결정 4·6의 span 처리기, 표본기는 SDK 기본(부모 기반, 뿌리는 모두 기록)이다. 꼬리 표본은 수집기가 한다(observability §6).
   - 내보내기: 시험은 `spanProcessors`를 넣는다. 아니면 OTLP(HTTP/protobuf, 주소는 표준 환경 변수 `OTEL_EXPORTER_OTLP_ENDPOINT`)로 묶어 보낸다. `OTEL_TRACES_EXPORTER=none`이면 보내지 않고, `OTEL_SDK_DISABLED=true`면 시작하지 않는다. SDK의 지표·로그 내보내기는 켜지 않는다(지표는 `/metrics`, 로그는 표준 출력).
   - 서비스 실행 명령은 `node --import @peaket/platform/telemetry/register dist/main.js`다. 등록 파일은 환경 변수(`OTEL_SERVICE_NAME`·`PEAKET_VERSION`·`PEAKET_ENV`)로 `startTelemetry`를 부른다. 자동 계측은 계측할 모듈(Fastify가 쓰는 `node:http`)보다 먼저 서야 하기 때문이다.

## 위험과 남는 것

- 정규 로그 줄 필드 일부(`pg`·`queuePhase`·`flags`)는 처리기가 넣어야 한다. 빠뜨리면 칸이 빈다. 기능 단계의 운영 확인 표가 본다.
- 엣지 게이트웨이가 바깥 추적 문맥을 지우기 전(HOT-400 전)에는 메시 모드의 서비스가 바깥에서 온 부모를 잇는다. 지금은 바깥에 열린 서비스가 없다.
- 머리 표본만으로 남긴 줄(`sampleRate` 0)은 Envoy의 표본 방식이 확인되면(4.1.4) 줄어들거나 없어진다.
- 외부 어댑터가 탐침 시험을 두지 않으면 V-T31 ③이 그 어댑터를 보지 못한다. 직접 부르는 `fetch`는 BAS-010의 Semgrep 규칙이 찾는다.
