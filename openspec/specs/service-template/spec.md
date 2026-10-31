# service-template Specification

## Purpose
서비스(NestJS·Fastify)가 함께 쓰는 서버 공용 패키지 `packages/platform`이 밖으로 보이는 행동이다. 모든 서비스가 같은 모양의 네 신호 지표, RFC 9457 오류 응답, 남은 시간 전파를 갖고, 실행 중에는 API 문서 경로를 내지 않으며, CI가 서비스 문서를 계약과 견준다. 요청마다 정규 로그 줄 하나를 남기고(추적과 같은 문턱의 표본, 가명과 IP 앞부분), OTel SDK를 시작 코드 한 곳에서 시작하며, 외부로 나가는 요청에는 추적 문맥을 싣지 않는다. 규칙의 정본은 docs/observability.md §3·§6·§7·§8, docs/api/guidelines.md §2·§5, docs/devops.md §3.1·§4.4, docs/verification.md V-T31이다(openspec 변경 add-service-template·add-service-logging, 2026-11-01, BUILD_ORDER FND-050·060).

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
