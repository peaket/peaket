# service-template Specification

## Purpose
서비스(NestJS·Fastify)가 함께 쓰는 서버 공용 패키지 `packages/platform`이 밖으로 보이는 행동이다. 모든 서비스가 같은 모양의 네 신호 지표, RFC 9457 오류 응답, 남은 시간 전파를 갖고, 실행 중에는 API 문서 경로를 내지 않으며, CI가 서비스 문서를 계약과 견준다. 요청마다 정규 로그 줄 하나를 남기고(추적과 같은 문턱의 표본, 가명과 IP 앞부분), OTel SDK를 시작 코드 한 곳에서 시작하며, 외부로 나가는 요청에는 추적 문맥을 싣지 않는다. 서비스 뼈대와 층 규칙을 주고, 요청을 계약 스키마로 검사하며(일반 경로와 핫패스가 같은 표본을 같게 거른다), 본문은 JSON만(표시한 경로만 text/plain도) 받고, 끝난 세션을 막고 역할을 요청마다 판정하며, DB 풀 대기를 짧게 끝낸다. 규칙의 정본은 docs/observability.md §3·§6·§7·§8, docs/api/guidelines.md §1·§2·§5, docs/architecture.md §3.1·§5, docs/security/authz-matrix.md §5, docs/features/identity.md §3, docs/devops.md §3.1·§4.4, docs/verification.md V-T31·V-T41이다(openspec 변경 add-service-template·add-service-logging·add-service-structure-and-request-checks, 2026-11-01, BUILD_ORDER FND-050·060·070).

## Requirements

### Requirement: 요청마다 네 신호를 잰다

서비스 템플릿으로 띄운 서비스는 모든 HTTP 요청의 지연을 표준 칸 히스토그램으로, 처리 중 요청 수를 게이지로, 5xx 응답을 오류 카운터로 SHALL 센다(NFR-011, ADR-0077 결정 1·5, docs/observability.md §3·§8).

#### Scenario: 지연 히스토그램의 칸이 표준 목록과 같다

- **WHEN** 서비스가 요청 하나에 답하고 관리 포트의 `/metrics`를 읽는다
- **THEN** `http_server_request_duration_seconds`의 `le` 칸은 0.005, 0.01, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.8, 1, 1.5, 1.8, 2, 2.5, 3, 5, 10, 30, 60, +Inf다
- **AND** 라벨은 `service`·`route`(경로 틀)·`method`·`status_class`이고 실제 자원 ID는 들어가지 않는다

#### Scenario: 5xx는 오류 카운터를 올린다

- **WHEN** 처리기가 예상하지 못한 예외를 던진다
- **THEN** `http_server_errors_total{status_class="5xx"}`가 1 오르고 정상 분기 카운터는 오르지 않는다

#### Scenario: 처리 중 요청 수

- **WHEN** 요청 하나가 처리기 안에서 기다리는 동안 `/metrics`를 읽는다
- **THEN** 그 경로의 `http_server_active_requests`는 1이고, 응답이 끝나면 0이다

### Requirement: 정상 분기 거절은 오류와 따로 센다

정상 분기로 표시한 Problem(예: 좌석 경합 409)으로 답한 응답은 오류 카운터가 아니라 정상 분기 카운터에 SHALL 든다(docs/api/guidelines.md §2, NFR-003, ADR-0069 결정 5, docs/verification.md §2.7).

#### Scenario: 409 경합 패배

- **WHEN** 처리기가 정상 분기로 표시한 409 Problem을 던진다
- **THEN** `http_server_business_rejections_total{status_class="4xx"}`가 1 오르고 `http_server_errors_total`은 오르지 않는다

### Requirement: 지표는 관리 포트에서만 낸다

서비스는 지표를 앱 요청을 받는 포트가 아닌 관리 포트에서만 SHALL 낸다(ASVS v5.0.0-13.4.5).

#### Scenario: 앱 포트의 /metrics

- **WHEN** 앱 포트로 `GET /metrics`를 보낸다
- **THEN** 404 Problem이 온다

### Requirement: 오류 응답은 RFC 9457 Problem이다

서비스의 모든 오류 응답은 `application/problem+json` 본문의 Problem이고, 예상하지 못한 오류는 내부 정보를 SHALL 싣지 않는다(docs/api/guidelines.md §2, ASVS v5.0.0-16.5.1·16.3.4).

#### Scenario: 이름 붙은 오류

- **WHEN** 처리기가 `seat-already-held`(409) Problem을 확장 필드와 함께 던진다
- **THEN** 응답은 409, `type`은 `https://peaket.example/problems/seat-already-held`, 본문에 `title`·`status`·`instance`·`traceId`와 확장 필드가 있다

#### Scenario: 예상하지 못한 오류

- **WHEN** 처리기가 내부 SQL 문장을 메시지로 가진 예외를 던진다
- **THEN** 응답은 500이고 본문은 `type`·`title`·`status`·`traceId`뿐이며 그 메시지와 스택이 없다
- **AND** 원본 예외는 같은 `traceId`로 서버 기록에 남는다

#### Scenario: 없는 경로와 잘못된 본문

- **WHEN** 없는 경로를 부르거나 JSON이 아닌 본문을 JSON으로 보낸다
- **THEN** 404 또는 400의 `about:blank` Problem이 온다

#### Scenario: 서버 바쁨

- **WHEN** 처리기가 `Retry-After` 2초를 단 429 `server-busy` Problem을 던진다
- **THEN** 응답에 `Retry-After: 2` 머리가 있다

### Requirement: 디버그 정보는 로컬·CI에서만 싣는다

Problem의 `debug` 확장은 로컬·CI 환경에서 켰을 때만 싣고, 다른 환경에서 켜면 서비스가 SHALL 시작하지 않는다(ADR-0081, ASVS v5.0.0-13.4.2).

#### Scenario: 운영에서 켬

- **WHEN** `PEAKET_ENV=prod`(또는 없음)에 `PEAKET_DEBUG_ERRORS=true`로 서비스를 만든다
- **THEN** 시작이 설정 오류로 실패한다

#### Scenario: 로컬에서 켬

- **WHEN** `PEAKET_ENV=local`에 `PEAKET_DEBUG_ERRORS=true`로 띄운 서비스에서 예상하지 못한 예외가 난다
- **THEN** 500 Problem에 `debug`(예외 이름과 스택 요약)가 있다

### Requirement: 남은 시간을 이어받고 모자라면 바로 실패한다

서비스는 게이트웨이가 넣은 남은 시간을 받아 줄어들기만 하게 이어 주고, 모자라면 일을 시작하지 않고 SHALL 실패한다(docs/api/guidelines.md §5, ADR-0009 결정 4).

#### Scenario: 받은 남은 시간

- **WHEN** `x-peaket-deadline-ms: 40`인 요청을 받고 시계가 10ms 흐른다
- **THEN** 처리기가 보는 남은 시간은 30ms이고, 상한 100ms인 다음 호출에 주는 시간도 30ms다

#### Scenario: 모자란 남은 시간

- **WHEN** 남은 시간이 5ms인데 처리기가 20ms가 필요하다고 확인한다
- **THEN** 504 Problem `deadline-exceeded`로 답한다

#### Scenario: 너무 긴 값

- **WHEN** `x-peaket-deadline-ms`가 서비스 상한(기본 15,000ms)보다 크거나 숫자가 아니다
- **THEN** 남은 시간은 서비스 상한에서 시작한다

### Requirement: 문서 경로를 내지 않고 문서 파일만 뽑는다

실행 중인 서비스는 API 문서 경로를 내지 않고, 문서는 뽑기 함수로만 파일로 SHALL 만든다(D-T38, ASVS v5.0.0-13.4.5).

#### Scenario: 문서 경로

- **WHEN** 앱 포트로 `/api`·`/api-json`·`/docs`를 부른다
- **THEN** 모두 404다

#### Scenario: 문서 뽑기

- **WHEN** 계약 Zod로 응답 스키마를 단 처리기를 가진 모듈의 문서를 뽑는다
- **THEN** 파일에 그 경로·메서드와 응답 스키마가 있다

### Requirement: 서비스 OpenAPI 문서를 계약과 견준다

CI는 서비스가 맡는다고 적은 계약 작업을 서비스가 뽑은 문서와 경로·메서드·매개변수·요청과 응답 본문의 모양으로 견주고, 어긋나면 SHALL 실패한다(D-T38, docs/devops.md §3.1).

#### Scenario: 계약에 없는 응답 필드

- **WHEN** 서비스 문서의 200 응답에 계약에 없는 칸이 있다
- **THEN** 검사가 실패하고 그 작업과 칸 이름을 보인다

#### Scenario: 맡은 경로를 빼먹음

- **WHEN** 서비스가 맡는다고 적은 작업 하나가 서비스 문서에 없다
- **THEN** 검사가 실패한다

#### Scenario: 계약과 같은 판

- **WHEN** 서비스 문서가 설명·예시·형식만 계약과 다르다
- **THEN** 검사가 통과한다

### Requirement: 요청마다 정규 로그 줄 하나를 남긴다

서비스 템플릿으로 띄운 서비스는 요청이 끝날 때마다 표준 출력에 JSON 정규 로그 줄 하나를 SHALL 남긴다. 줄에는 필수 공통 필드와 정규 로그 줄 필드가 있고, 예상하지 못한 오류의 원본은 그 줄의 `err`에 든다(ADR-0069 결정 11, docs/observability.md §7, ASVS v5.0.0-16.2.1·16.3.4).

#### Scenario: 정상 요청의 줄

- **WHEN** `x-peaket-app: web`과 크롬 130의 User-Agent로 경로 틀 `/items/{itemId}`인 경로를 실제 ID와 쿼리로 부르고, 처리기가 결제사 `toss`와 의존성 `redis` 7ms를 더한다
- **THEN** 줄 하나에 `ts`(KST 오프셋 ISO 8601)·`level` `info`·`service`·`env`·`version`·`traceId`·`route`(경로 틀)·`status` 200·`durationMs`·`msg`·`app` `web`·`client` `chrome/130`·`pg` `toss`·`dep.redis` 7·`sampleRate`가 있다
- **AND** 줄에 User-Agent 원문과 실제 경로가 없다

#### Scenario: 예상하지 못한 오류

- **WHEN** 처리기가 내부 SQL 문장을 메시지로 가진 예외를 던진다
- **THEN** 줄 하나가 `level` `error`, `status` 500, 응답과 같은 `traceId`, `err`에 예외 이름·메시지·스택을 갖고, 다른 기록 줄은 없다

#### Scenario: 4xx의 오류 내용

- **WHEN** JSON이 아닌 본문을 JSON으로 보낸다
- **THEN** 줄의 `err`에는 오류 종류와 HTTP 상태 문구만 있고 본문 일부가 든 원래 메시지와 스택이 없다

#### Scenario: 라우터 앞에서 끝난 요청

- **WHEN** 잘못된 URL로 부른다
- **THEN** `route` `unmatched`인 줄 하나가 남는다

### Requirement: 정상 줄은 추적과 같은 문턱으로 표본을 고른다

정상 응답의 줄은 trace ID 끝 56비트가 문턱 이상일 때만 남기고 `sampleRate`에 N을 적으며, 같은 결과를 서버 span의 `peaket.sample.keep`에 단다. 4xx·5xx·SLO 지연 초과·표시한 응답은 `sampleRate` 1로 모두 SHALL 남긴다(ADR-0076 결정 4, ADR-0125 결정 3, docs/observability.md §6·§7).

#### Scenario: 문턱

- **WHEN** 비율이 10건에 1건이고 trace ID 끝 56비트가 (1 − 1/10) × 2^56 이상인 요청과 미만인 요청이 200으로 끝난다
- **THEN** 앞의 줄만 남고 그 `sampleRate`는 10이다

#### Scenario: 전수

- **WHEN** 문턱 밖의 요청이 409·500으로 끝나거나, SLO 지연(기본 500ms)을 넘거나, 처리기가 전수로 표시한다
- **THEN** 줄이 남고 `sampleRate`는 1이다

#### Scenario: 진입 경로

- **WHEN** 진입 경로로 표시한 처리기가 문턱 밖의 요청에 429로 답하고, 같은 경로의 다른 요청은 문턱 밖이지만 들어온 trace의 표본 표시가 켜진 채 200으로 끝난다
- **THEN** 429 줄은 남지 않고, 200 줄은 `sampleRate` 0으로 남으며 서버 span에 `peaket.sample.mode` `head`가 있다

### Requirement: 로그와 추적의 식별값은 가명과 IP 앞부분만 쓴다

정규 로그 줄의 사람 식별값은 로그 가명 키로 만든 HMAC 가명만 쓰고, 서버 span의 클라이언트 IP는 앞부분만 SHALL 남긴다. 운영 환경에서 로그 가명 키가 없으면 서비스가 시작하지 않는다(ADR-0053 결정 1, docs/observability.md §2·§7, ASVS v5.0.0-16.2.5).

#### Scenario: 가명

- **WHEN** 처리기가 pid·세션 ID·계정 ID로 `identify`를 부른다
- **THEN** 줄에 `pidRef`·`sidRef`·`accountRef`(HMAC-SHA256 앞 16바이트의 base64url)가 있고 원문 값은 줄 어디에도 없다

#### Scenario: 키 없음

- **WHEN** `PEAKET_ENV=prod`에 `PEAKET_LOG_PSEUDONYM_KEY` 없이 서비스를 만든다
- **THEN** 시작이 설정 오류로 실패한다

#### Scenario: IP 앞부분

- **WHEN** `203.0.113.77`과 `2001:db8:abcd:12::1`을 앞부분으로 바꾼다
- **THEN** `203.0.113.0/24`와 `2001:db8:abcd::/48`이다

#### Scenario: 가림

- **WHEN** 서비스 로거로 `email`·`authorization`·`paymentKey`가 든 객체를 기록한다
- **THEN** `email`·`authorization`은 `[REDACTED]`이고 `paymentKey`는 뒤 4자만 남는다

### Requirement: 외부로 나가는 요청에는 추적 문맥을 싣지 않는다

외부 제공자를 부르는 공용 클라이언트는 span을 만들되 `traceparent`·`tracestate`·`baggage`를 SHALL 싣지 않는다. 탐침 시험은 기본 클라이언트로 바꾸면 실패한다(V-T31 ③, ADR-0130, docs/observability.md §6, ASVS v5.0.0-14.2.3).

#### Scenario: 외부 호출 클라이언트

- **WHEN** OTel SDK가 돌고 표본 표시를 켠 span과 Baggage가 있는 맥락에서 외부 호출 클라이언트로 모의 서버를 부른다(호출하는 쪽이 `traceparent`를 직접 넣어도)
- **THEN** 모의 서버가 받은 요청에 세 헤더가 없고, 클라이언트 span에는 경로 틀이 있고 쿼리가 없다

#### Scenario: 기본 클라이언트로 바꿈

- **WHEN** 같은 맥락에서 기본 `fetch`로 부른다
- **THEN** 탐침이 `traceparent`·`baggage`를 잡는다

#### Scenario: 리디렉트

- **WHEN** 외부 서버가 302로 답한다
- **THEN** 클라이언트는 따라가지 않고 302를 돌려준다

### Requirement: 들어오는 추적 문맥은 신뢰 경계에 따라 잇는다

메시 모드는 들어온 부모를 잇고, 앱 서버용 모드는 들어온 `traceparent`를 부모로 쓰지 않고 새 trace의 링크로만 SHALL 남긴다(ADR-0130, docs/observability.md §6).

#### Scenario: 메시 모드

- **WHEN** 서비스가 `traceparent`를 단 요청을 받는다
- **THEN** 서버 span과 정규 로그 줄의 `traceId`는 받은 trace-id다

#### Scenario: 앱 서버용 모드

- **WHEN** 앱 서버용 모드에서 `traceparent`·`baggage`를 단 요청을 받는다
- **THEN** 서버 span은 새 trace-id이고 받은 값은 링크로만 있으며 Baggage는 맥락에 없다

### Requirement: OTel SDK는 플랫폼 시작 코드 한 곳에서 시작한다

OTel Node SDK는 `@peaket/platform/telemetry`의 시작 함수 한 곳에서만 SHALL 시작하고, 서버 span에 경로 틀과 표본 속성을 단다(docs/devops.md §4.4, docs/observability.md §2·§6).

#### Scenario: 서버 span

- **WHEN** SDK를 시작한 뒤 서비스가 경로 틀 `/items/{itemId}`인 경로를 실제 ID와 쿼리로 받는다
- **THEN** 서버 span 이름은 `GET`과 경로 틀이고 `http.route`·`url.path`가 경로 틀이며 `peaket.sample.keep`이 있고 `url.query`는 비어 있다

### Requirement: 서비스 안 구조 뼈대가 뜨고 층은 안쪽으로만 부른다

서비스 템플릿은 받는 층·유스케이스 층·도메인 층·어댑터로 나눈 서비스 뼈대를 주고, 그 뼈대는 그대로 띄워 요청을 처리할 수 있어야 한다. 층을 거꾸로 부르는 import는 공용 린트가 SHALL 실패시킨다(docs/architecture.md §3.1, 기술 검토 낮음-008, docs/devops.md §3.1).

#### Scenario: 뼈대가 뜬다

- **WHEN** 뼈대 서비스를 띄우고 그 예시 경로를 허용 역할의 신원으로 부른다
- **THEN** 받는 층 → 유스케이스 → 도메인 → 포트 → 어댑터를 지난 값이 200으로 돌아온다

#### Scenario: 거꾸로 부르는 import

- **WHEN** 도메인 파일이 유스케이스·받는 층·어댑터 파일이나 웹·저장소 패키지(`@nestjs/common`·`drizzle-orm` 등)를 가져오거나, 유스케이스 파일이 어댑터를 가져오거나, 받는 층 파일이 어댑터를 가져온다
- **THEN** 린트가 그 줄을 오류로 내고, 뼈대 자체는 오류가 없다

### Requirement: 요청 값은 계약 형식으로 바꾼 뒤 계약 스키마로 검사한다

쿼리·경로·머리 값은 검사 전에 계약 스키마의 형식대로 바뀌고(숫자·불리언, 머리 이름 대소문자, 쉼표로 이은 배열), 같은 이름이 겹쳐 온 쿼리는 형과 관계없이 거절된다. 검사에 실패하면 Problem 400으로 SHALL 답한다(docs/api/guidelines.md §1·§2, ASVS v5.0.0-15.3.7).

#### Scenario: 문자열 값 바꾸기

- **WHEN** 정수 쿼리 `section=3`, 정수 머리 `X-Purchase-Seq: 5`, UUID 머리 `Idempotency-Key`, 쉼표로 이은 배열 쿼리 `eventIds=a,b`를 계약 스키마로 검사하는 경로를 부른다
- **THEN** 처리기는 `section` 3(숫자), `X-Purchase-Seq` 5(숫자), `eventIds` `["a","b"]`를 받고 200이다

#### Scenario: 겹친 쿼리와 형식 오류

- **WHEN** `section=1&section=2`, `section=x`, 필수 머리 없음 중 하나로 부른다
- **THEN** 400이고 본문은 `type` `about:blank`·`title` `Bad Request`·`status` 400·`instance`·`traceId`만 있다

### Requirement: 핫패스 경로 스키마와 Zod 파이프는 같은 표본을 같게 거른다

계약 Zod를 바꾼 Fastify 경로 스키마로 검사하는 경로와 Zod 파이프로 검사하는 경로는 같은 표본 요청 묶음(정상·형식 오류·모르는 칸·생성 스키마의 검사 규칙 위반)에 같은 받기·거르기 결과와 같은 Problem 400 본문을 SHALL 낸다. 경로 스키마는 본문의 형을 바꾸지 않고 정의 밖 칸을 지운 뒤 통과시키지 않는다(docs/api/guidelines.md §1, ADR-0023, 기술 검토 낮음-001, V-T41의 표본 묶음).

#### Scenario: 좌석 홀드와 대기열 진입 표본

- **WHEN** 좌석 홀드(JSON 본문)와 대기열 진입(`text/plain` 본문) 계약 스키마의 표본 묶음을 두 길로 보낸다
- **THEN** 표본마다 두 길의 상태 코드가 같고, 400이면 `traceId`·`instance`를 뺀 본문이 같다

#### Scenario: 생성 스키마의 검사 규칙

- **WHEN** 중복 항목 금지 배열에 같은 항목 둘, 칸 수 상한 10인 객체에 칸 11개, 칸 이름 상한 30자를 넘는 이름을 두 길로 보낸다
- **THEN** 두 길 모두 400이다

#### Scenario: 형 바꾸기와 칸 지우기 없음

- **WHEN** 정수 칸에 문자열 `"1"`을 넣은 본문과, 정의 밖 칸을 막은 객체에 모르는 칸을 넣은 본문을 경로 스키마 길로 보낸다
- **THEN** 둘 다 400이다

### Requirement: 본문은 JSON만 받고 표시한 경로만 text/plain도 받는다

본문이 있는 요청은 `application/json`만 받고, `text/plain` 수용을 표시한 경로(대기열 진입·입장 확정)만 `text/plain` 본문을 JSON으로 읽는다. 그 밖의 형식은 415로 SHALL 거절한다(docs/security/asvs/delivery.md 3.5.2, ADR-0065 결정 6).

#### Scenario: 형식별 결과

- **WHEN** 표시하지 않은 경로에 `text/plain`·`application/x-www-form-urlencoded`·형식 없는 본문을, 표시한 경로에 `text/plain` JSON 본문을 보낸다
- **THEN** 앞의 셋은 415(`about:blank`·`Unsupported Media Type`)이고, 뒤의 것은 처리기가 JSON 객체를 받는다

### Requirement: 끝난 세션은 수 초 안에 거절한다

서비스는 게이트웨이가 넘긴 신원 머리로 요청자를 알고, 세션 종료를 받은 세션의 요청은 그 세션의 액세스 토큰 수명(15분) 동안 401로 SHALL 거절한다(docs/features/identity.md §3, ASVS v5.0.0-7.4.1).

#### Scenario: 종료 뒤 요청

- **WHEN** 세션 S의 종료를 받은 뒤 S의 신원 머리로 팬 경로를 부른다
- **THEN** 401이고 `WWW-Authenticate`가 있다

#### Scenario: 15분이 지난 항목

- **WHEN** 종료 시각에서 15분이 지난 뒤 목록을 본다
- **THEN** S의 항목이 지워져 있다

#### Scenario: 신원 머리 없음

- **WHEN** 공개가 아닌 경로를 신원 머리 없이 부른다
- **THEN** 401이다

### Requirement: 처리기마다 허용 역할을 적고 역할은 요청마다 판정한다

모든 처리기는 허용 역할을 적어야 하고, 하나라도 없거나 표에 없는 값이면 서비스가 시작하지 않는다. 관리 역할은 토큰이 아니라 요청마다 identity 조회로 받은 지금 역할로 SHALL 판정한다(소유자 결정 2026-10-31, ADR-0172, docs/security/authz-matrix.md §5.2·§5.5, 시험 AZ-T1·AZ-T16).

#### Scenario: 허용 역할 없는 처리기

- **WHEN** 허용 역할을 적지 않은 처리기가 든 서비스를 띄운다
- **THEN** 시작이 실패하고 그 처리기 이름이 오류에 나온다

#### Scenario: 역할 판정과 바깥 머리

- **WHEN** 허용 역할이 `operator`·`commander`인 경로를 identity가 `viewer`로 답하는 세션으로, 바깥에서 넣은 `X-User-Role: commander`와 함께 부른다
- **THEN** 403이다

#### Scenario: 5초 캐시와 위험 작업

- **WHEN** identity가 `operator`로 답한 뒤 역할을 `viewer`로 바꾸고, 2초 뒤 같은 세션으로 일반 경로와 위험 작업 경로를 부른다
- **THEN** 일반 경로는 캐시로 통과하고 위험 작업 경로는 다시 물어 403이다
- **AND** 6초 뒤 일반 경로도 403이다

#### Scenario: identity가 답하지 않음

- **WHEN** 캐시가 없는 세션으로 관리 경로를 부르고 identity 조회가 실패한다
- **THEN** 503 `authz-unavailable`과 `Retry-After`로 닫는다

#### Scenario: 끝난 관리 세션

- **WHEN** identity가 그 세션을 유효하지 않다고 답한다
- **THEN** 401이다

### Requirement: DB 풀 대기는 짧게 끝내고 트랜잭션 설정은 남지 않는다

서비스의 DB 연결 풀은 연결을 기다리는 시간에 한도를 두어 넘으면 429 `server-busy`와 `Retry-After`로 답하고, 트랜잭션에 건 설정(테넌트·문장 시간 초과)은 그 트랜잭션이 끝나면 SHALL 사라진다(docs/architecture.md §5, ADR-0070, ADR-0083, docs/security/authz-matrix.md §5.3, ASVS v5.0.0-13.1.2).

#### Scenario: 풀 대기 초과

- **WHEN** 연결 하나짜리 풀의 연결을 잡은 채 다른 요청이 같은 풀을 쓴다
- **THEN** 다른 요청은 한도 안에 429 `server-busy`와 `Retry-After`로 끝난다

#### Scenario: 테넌트 설정과 행 보안

- **WHEN** 행 보안 정책이 `app.tenant_id`로 거르는 표를 테넌트 A로 건 트랜잭션에서 읽고, 같은 연결의 다음 트랜잭션에서 테넌트 없이 읽는다
- **THEN** 앞은 A의 행만, 뒤는 아무 행도 보이지 않는다

### Requirement: 서버는 계약 생성물을 Node로 읽는다

계약에서 만든 Zod 스키마 패키지는 번들러 없이 Node만으로 SHALL 읽힌다. 서비스는 묶지 않고 빌드해 데코레이터 메타데이터를 지킨다(FND-050 넘김, R-221).

#### Scenario: Node로 읽기

- **WHEN** 계약 패키지를 빌드한 뒤 Node 프로세스에서 모음 내보내기와 태그 내보내기를 가져온다
- **THEN** 스키마가 읽히고 표본 값을 검사한다
