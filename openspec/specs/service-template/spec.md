# service-template Specification

## Purpose
서비스(NestJS·Fastify)가 함께 쓰는 서버 공용 패키지 `packages/platform`이 밖으로 보이는 행동이다. 모든 서비스가 같은 모양의 네 신호 지표, RFC 9457 오류 응답, 남은 시간 전파를 갖고, 실행 중에는 API 문서 경로를 내지 않으며, CI가 서비스 문서를 계약과 견준다. 요청마다 정규 로그 줄 하나를 남기고(추적과 같은 문턱의 표본, 가명과 IP 앞부분), OTel SDK를 시작 코드 한 곳에서 시작하며, 외부로 나가는 요청에는 추적 문맥을 싣지 않는다. 서비스 뼈대와 층 규칙을 주고, 요청을 계약 스키마로 검사하며(일반 경로와 핫패스가 같은 표본을 같게 거른다), 본문은 JSON만(표시한 경로만 text/plain도) 받고, 끝난 세션을 막고 역할을 요청마다 판정하며, DB 풀 대기를 짧게 끝낸다. 다시 보내면 두 번 생길 수 있는 쓰기는 멱등 키로 한 번만 처리하고, 보낼 사건은 업무와 같은 트랜잭션의 Outbox에 적어 Lease를 쥔 릴레이 하나가 순서대로 잃지 않고 보낸다(Outbox 일 파티션의 미리 만들기·지우기 포함). 규칙의 정본은 docs/observability.md §3·§5·§6·§7·§8, docs/api/guidelines.md §1·§2·§4·§5, docs/data.md §2·§4, docs/architecture.md §3.1·§5, docs/security/authz-matrix.md §5, docs/features/identity.md §3, docs/devops.md §3.1·§4.4, docs/verification.md V-T28·V-T31·V-T41, ADR-0116이다(openspec 변경 add-service-template·add-service-logging·add-service-structure-and-request-checks·add-idempotency-and-outbox, 2026-11-01, BUILD_ORDER FND-050·060·070·080).

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

### Requirement: 멱등 키는 신원 판정 뒤, 모양 검사 전에 본다

`@Idempotent`를 단 처리기는 인증 가드가 신원을 판정한 바로 뒤에 `Idempotency-Key`를 보고, 없거나 따옴표 없는 UUID v4가 아니면 400 `idempotency-key-invalid` Problem으로 SHALL 답한다. 두 검사 길(Zod 파이프, 경로 스키마)의 머리 스키마는 이 머리를 보지 않는다(docs/api/guidelines.md §4, BUILD_ORDER FND-080).

#### Scenario: 키 없음

- **WHEN** 허용 역할의 신원으로 멱등 처리기를 키 없이 부른다(본문이나 다른 머리가 틀려도)
- **THEN** 400이고 Problem `type`이 `…/idempotency-key-invalid`다. 두 검사 길이 같다

#### Scenario: 형식이 틀린 키

- **WHEN** 키가 큰따옴표로 감싼 UUID, v7 같은 다른 판의 UUID, 같은 머리 둘이다
- **THEN** 셋 다 400 `idempotency-key-invalid`다

#### Scenario: 익명 요청

- **WHEN** 신원 머리 없이 키 없는 요청을 보낸다
- **THEN** 401이 먼저다

#### Scenario: 키는 맞고 모양이 틀림

- **WHEN** 키가 맞고 본문이 계약에 맞지 않는다
- **THEN** 400 `about:blank`다(멱등 기록을 남기지 않는다)

#### Scenario: 공개 경로의 멱등 장식자

- **WHEN** `public`을 허용한 처리기에 `@Idempotent`를 단 서비스를 띄운다
- **THEN** 앱 초기화가 실패하고 그 처리기 이름을 알린다

### Requirement: 같은 범위의 같은 키는 한 번만 처리한다

멱등 기록은 업무 쓰기와 같은 트랜잭션에 적고, 같은 계정 × 작업 × 키로 다시 온 요청은 업무를 다시 하지 않고 처음 커밋한 결과를 SHALL 돌려준다. 지문이 다르면 422 `idempotency-key-reused`, 첫 요청이 1초 [가정] 안에 끝나지 않으면 409 `idempotency-request-in-progress`와 `Retry-After: 1`이다(guidelines §4, ADR-0146 결정 1, ASVS v5.0.0-2.3.4).

#### Scenario: 다시 보냄

- **WHEN** 같은 계정이 같은 키·같은 본문으로 두 번 보낸다
- **THEN** 두 번째는 첫 번째와 같은 상태 코드·같은 결과이고 업무 행은 하나다

#### Scenario: 다른 본문

- **WHEN** 같은 키로 본문만 다른 요청을 보낸다
- **THEN** 422 `idempotency-key-reused`이고 업무 행은 늘지 않는다

#### Scenario: 처리 중

- **WHEN** 첫 요청의 트랜잭션이 아직 열려 있을 때 같은 키·같은 지문이 온다
- **THEN** 첫 요청이 1초 안에 커밋하면 그 결과를, 되돌리면 새로 처리한 결과를, 1초를 넘기면 409와 `Retry-After: 1`을 받는다

#### Scenario: 실패는 저장하지 않음

- **WHEN** 첫 요청의 업무가 던져 트랜잭션이 되돌아간 뒤 같은 키로 다시 보낸다
- **THEN** 다시 처리한다

#### Scenario: 범위와 보관

- **WHEN** 다른 계정이 같은 키를 쓰거나, 보관 기간(24시간 [가정])이 지난 키가 다시 온다
- **THEN** 새 요청으로 처리한다. 정비 함수는 보관 기간이 지난 행만 나눠 지운다

### Requirement: 본문은 해석 전 바이트를 남긴다

플랫폼 본문 해석기(JSON, 표시한 경로의 `text/plain`)는 해석 전 원시 바이트를 요청에 SHALL 남기고, 요청 지문은 메서드·받은 그대로의 경로와 쿼리·그 바이트로 만든다(guidelines §4, R-223).

#### Scenario: 같은 값의 다른 바이트

- **WHEN** 같은 JSON 값을 공백만 다르게 보낸다
- **THEN** 처리기는 같은 값을 받지만 원시 바이트와 지문은 다르다

#### Scenario: text/plain 경로

- **WHEN** `@AcceptTextPlain()` 경로에 `text/plain` 본문을 보낸다
- **THEN** 원시 바이트가 남고 JSON 해석 값이 처리기에 간다

### Requirement: Outbox는 커밋한 사건만 seq 순서로 잃지 않고 보낸다

서비스는 업무와 같은 트랜잭션에서 Outbox 행을 쓰고, 릴레이는 커밋한 행만 `seq` 순서로 보내고 모든 확인을 받은 뒤에 보낸 표시를 SHALL 한다. 보내다 실패하면 행이 남아 다시 나간다. `SKIP LOCKED`를 쓰지 않아 다른 릴레이가 잡은 앞 묶음을 건너뛰지 않는다(ADR-0116 결정 3, ADR-0143 결정 3, V-T28).

#### Scenario: 되돌린 트랜잭션

- **WHEN** Outbox 행을 쓴 트랜잭션이 되돌아간다
- **THEN** 그 사건은 나가지 않는다

#### Scenario: 순서와 표시

- **WHEN** 사건 여럿을 커밋한 뒤 릴레이가 한 번 돈다
- **THEN** 보내기 포트가 `seq` 순서로 키·값·머리를 그대로 받고, 그 행들에 보낸 시각이 적힌다

#### Scenario: 보내기 실패

- **WHEN** 보내기 포트가 실패한다
- **THEN** 행은 보내지 않은 채 남고 다음 묶음에서 다시 나가며, 오류 지표가 오르고 다음 시도까지 0.1초에서 5초까지 늘려 쉰다

#### Scenario: 묶음을 잡은 다른 릴레이

- **WHEN** 한 릴레이가 묶음을 잡고 보내는 동안 다른 릴레이가 묶음을 돈다
- **THEN** 뒤 릴레이는 앞 묶음이 끝날 때까지 기다린 뒤 그 뒤의 행만 보낸다(같은 행을 두 번 보내지 않고, 앞 행을 건너뛰지 않는다)

#### Scenario: 제어 사건

- **WHEN** `control.sessions-terminated`·`control.settings` 사건을 Outbox에 쓴다
- **THEN** 같은 릴레이가 그 주제·키로 순서대로 보낸다

### Requirement: 릴레이는 Lease를 쥔 하나만 보낸다

릴레이 복제들은 쿠버네티스 Lease로 리더 하나를 뽑고, 리더만 묶음을 SHALL 돈다. 리더가 멈추면 Lease가 끝난 뒤 다른 복제가 15초 [가정] 안에 이어받고, 갱신하지 못한 리더는 남이 잡기 전에 스스로 내려온다(ADR-0116 결정 2).

#### Scenario: 둘 가운데 하나

- **WHEN** 두 복제가 함께 시작한다
- **THEN** 하나만 리더이고 다른 하나는 묶음을 돌지 않는다

#### Scenario: 리더가 멈춤

- **WHEN** 리더가 갱신을 멈춘다
- **THEN** 다른 복제가 Lease 기간이 지난 뒤 다음 시도에서 리더가 된다(합쳐 15초 안)

#### Scenario: 갱신 실패

- **WHEN** 리더가 갱신 한도 동안 갱신하지 못한다
- **THEN** 리더 지표가 0이 되고 묶음을 돌지 않는다

#### Scenario: 겨룸

- **WHEN** 두 복제가 같은 판의 Lease를 함께 고친다
- **THEN** `resourceVersion`이 맞은 하나만 리더가 된다

### Requirement: 릴레이 지표

릴레이는 `outbox_relay_lag_seconds`·`outbox_relay_published_total`·`outbox_relay_errors_total`·`outbox_relay_batch_seconds`·`outbox_relay_is_leader`와 `outbox_partitions_ahead_days`·`outbox_partitions_overdue`를 `service` 라벨로 SHALL 낸다. 지연과 파티션 지표는 리더가 아니어도 잰다(ADR-0116 결정 5, docs/observability.md §5).

#### Scenario: 밀린 행

- **WHEN** 보내지 않은 가장 오래된 행이 10초 전에 만들어졌다
- **THEN** 리더가 아닌 복제도 지연을 10초로 낸다

### Requirement: Outbox 일 파티션을 미리 만들고 지난 것을 지운다

정비 함수는 한국 시각 하루 단위 ID 범위 파티션을 7일 [가정] 앞까지 만들고, 3일 [가정] 지난 파티션을 정비 시간(04:00~06:00 KST)에 보내지 않은 행이 없을 때만 SHALL 지운다(data.md §2·§4의 7번, ADR-0083·0116).

#### Scenario: 미리 만들기

- **WHEN** 미리 만들기를 두 번 부른다
- **THEN** 오늘부터 7일 뒤까지 여덟 파티션이 한 번씩만 생기고, 경계는 그날 0시(KST)의 UUID다

#### Scenario: 보내지 않은 행이 남은 파티션

- **WHEN** 지울 파티션에 보내지 않은 행이 있다
- **THEN** 지우지 않고 막힌 목록으로 돌려준다

#### Scenario: 정비 시간 밖

- **WHEN** 정비 시간 밖에 지우기를 부른다
- **THEN** 아무것도 지우지 않는다

### Requirement: Kafka 클라이언트는 필수 설정으로만 만든다

서비스·작업자·Outbox 릴레이의 Kafka 생산자와 소비자는 공용 설정으로 SHALL 만들어진다: 생산자는 `acks=all`·멱등 켬·동시 요청 5 이하·파티셔너 `murmur2_random`·전달 상한(Outbox 릴레이 10초, 그 밖 5초), 소비자는 자동 커밋 끔·`cooperative-sticky`·세션 45초·`group.protocol=classic`이고 고정 멤버십이 없다. 필수 값을 덮어쓰는 코드는 실행 때 거절되고 CI 정적 검사가 막는다(ADR-0142 결정 3, docs/streaming.md §2.6, D-T45).

#### Scenario: 필수 값 덮어쓰기

- **WHEN** 덧붙일 설정에 `acks`, `enable.auto.commit`, `session.timeout.ms` 같은 필수 이름을 넣어 만든다
- **THEN** 만들기가 그 이름을 알리며 실패한다

#### Scenario: D-T45

- **WHEN** 서비스 코드가 `acks=1`·멱등 끔(①), 동시 요청 6이나 다른 파티셔너(②), 다른 전달 상한(③), 자동 커밋 켬·다른 재조정·다른 그룹 프로토콜·다른 세션(④), 고정 멤버십(⑤)을 쓰거나 Kafka 클라이언트를 직접 가져온다
- **THEN** 정적 검사가 실패한다. 공용 설정 그대로인 코드(⑥)는 통과한다

### Requirement: 서비스 소비자는 파티션 안에서 업무 키 단위로 동시에 처리한다

공용 소비자는 같은 업무 키의 사건을 받은 순서대로, 다른 키는 동시에(파티션마다 32개 [가정]까지) SHALL 처리하고, 앞 사건이 모두 끝난 위치까지만 커밋한다. 파티션을 넘길 때는 처리 중인 키를 마친 뒤 커밋한다(ADR-0142 결정 1, ST-T18).

#### Scenario: 순서와 커밋 위치

- **WHEN** 한 파티션에 주문 A·B의 사건이 섞여 오고 B의 첫 사건이 오래 걸린다
- **THEN** A의 사건은 A 안에서 순서대로 끝나고, 커밋 위치는 B의 첫 사건 오프셋을 넘지 않는다

#### Scenario: 동시 키 한도

- **WHEN** 끝나지 않은 키가 32개인데 새 키의 사건이 온다
- **THEN** 키 하나가 끝날 때까지 그 사건을 받지 않는다

### Requirement: 처리 못 하는 사건은 보류 표로 옮긴다

같은 결과일 실패를 5회 [가정] 겪은 사건은 그 서비스 DB의 `held_event`로 SHALL 옮겨지고, 같은 업무 키의 뒤 사건도 함께 보류되며, 다른 키는 계속 처리된다. 저장소 연결 실패·시간 초과는 보류하지 않고 그 파티션을 멈춰 기다린다. 보류 행은 다시 처리할 수 있고, 다시 처리한 행은 7일 [가정] 뒤 지워진다(ADR-0142 결정 2, docs/data.md §4의 15번, ST-T19).

#### Scenario: 독 사건

- **WHEN** 주문 A의 첫 사건이 늘 예외를 내고 A의 사건 둘과 다른 주문 사건이 뒤에 있다
- **THEN** A의 세 사건이 보류되고 다른 주문은 처리되며 보류 수 지표가 3이다

#### Scenario: 저장소 연결 끊김

- **WHEN** 처리기가 연결 오류를 낸다
- **THEN** 아무것도 보류되지 않고 그 파티션 가져오기가 멈췄다가, 되살아나면 같은 사건부터 이어 처리한다

#### Scenario: 다시 처리

- **WHEN** 처리기를 고친 뒤 주문 A의 보류를 다시 처리한다
- **THEN** A의 사건이 들어온 순서대로 반영되고, 그 뒤 오는 A의 사건은 보류되지 않는다

### Requirement: 파드는 제어 상태·설정·종료 세션을 읽어야 준비 상태가 된다

서비스는 시작 작업(제어 상태, `control.settings` 끝까지, `control.sessions-terminated` 지금 − 15분부터)이 모두 끝나야 관리 포트 `/ready`가 200을 SHALL 답한다. 제어 상태를 못 읽으면 계속 준비 상태가 아니고, Kafka에 닿지 않으면 30초 [가정] 뒤 준비 상태가 되며 따라잡을 때까지 `control_sync_lagging{kind}`가 1이다. `/ready`는 의존성을 부르지 않는다(ADR-0103 결정 2, D-T29).

#### Scenario: 시작 작업 전

- **WHEN** 설정 토픽을 아직 끝까지 읽지 않았다
- **THEN** `/ready`가 503이고 남은 작업 이름을 알린다

#### Scenario: Kafka 없이 시작

- **WHEN** Kafka에 닿지 않은 채 뜬다
- **THEN** 30초 뒤 `/ready`가 200이고 `control_sync_lagging{kind="settings"}`·`{kind="sessions"}`가 1이다. Kafka가 돌아와 따라잡으면 0이다

#### Scenario: 새 파드의 종료 세션

- **WHEN** 로그아웃 사건이 1분 전에 나왔고 파드가 지금 뜬다
- **THEN** 준비 상태가 된 뒤 그 세션의 요청은 401이다(I-T48)

### Requirement: 제어 상태와 설정은 판 번호가 큰 쪽을 따른다

제어 상태는 2초 [가정]마다 서비스 저장소에서 다시 읽어 판 번호가 큰 값을 SHALL 남긴다. 설정은 메시지 키마다 마지막 판을 두고, 지우는 표시는 그 키를 지우며, `expiresAt`이 지난 값은 무시하고, 적용한 판을 `control_settings_applied_version{service, key}`로 낸다(ADR-0103 결정 2·4, ADR-0143 결정 2, C-T51).

#### Scenario: 오래 끈 기능 플래그

- **WHEN** 8일 전에 끈 기능 플래그 사건이 압축 토픽에 남아 있고 파드가 새로 뜬다
- **THEN** 새 파드에서도 그 플래그가 꺼져 있다

#### Scenario: 만료된 로그 수준

- **WHEN** 이 서비스의 로그 수준을 DEBUG로 바꾼 설정의 `expiresAt`이 지났다
- **THEN** 서비스 로그 수준이 설정의 기본으로 돌아간다

### Requirement: Outbox 사건은 Kafka에 그대로 나가고 추적이 이어진다

Outbox 릴레이의 Kafka 보내기는 키·값·머리를 그대로 SHALL 보내고, 소비자의 처리 span은 그 사건을 쓴 요청의 trace에 이어진다. 브로커가 멈추면 행은 표에 남고, 돌아오면 빠짐 없이 나간다(ADR-0116 결정 3, observability §2, V-T28 ②).

#### Scenario: 브로커 정지

- **WHEN** 브로커를 멈춘 채 사건 셋을 쓰고, 20초 뒤 브로커를 되살린다
- **THEN** 멈춘 동안 행은 보내지 않은 채 남고, 되살린 뒤 셋이 한 번 이상 나가며 보내지 않은 행이 0이 된다

### Requirement: 정비 잡이 파티션·통계·보존 정리를 한다

정비 잡은 리더 하나가 돌고, 매일 Outbox·월 파티션을 미리 만들고(월은 3개월 [가정] 앞, 첫 파티션 포함) 부모 표를 `ANALYZE`하며 통계 스냅샷을 남긴다. 정비 시간(04:00~06:00 KST)에는 지난 파티션(조건을 만족한 것만)·멱등 기록·다시 처리한 보류 행·보존 기한이 지난 행(1만 건 [가정]씩 자식 먼저)을 SHALL 지우고, 30% [가정] 넘게 부푼 인덱스를 다시 만든다(ADR-0086 결정 4·7, ADR-0114 결정 3).

#### Scenario: 월 파티션

- **WHEN** 회차 ID 범위 월 파티션 표에 정비 잡을 두 번 돌린다
- **THEN** 이번 달부터 석 달 뒤까지 네 파티션이 한 번씩만 생긴다

#### Scenario: 보존 나눠 지우기

- **WHEN** 기한이 지난 부모 행 25건과 그 자식 행이 있고 묶음이 10건이다
- **THEN** 세 묶음으로 자식 → 부모 순서로 지워지고 기한이 지나지 않은 행은 남는다

#### Scenario: 지키는 선

- **WHEN** 두 번째 묶음 전에 지키는 선이 읽기 복제본 지연을 알린다
- **THEN** 그날 밤은 멈추고 다 못 지움 지표가 1이다

### Requirement: Redis Stream은 확인받은 항목만 지운다

좌석 Redis Stream 릴레이가 Kafka 확인을 받은 항목은 `XACK` 뒤 `XTRIM MINID`로 SHALL 지워지고, 아직 확인하지 않은 항목은 남는다. 키는 회차 판매 종료 + 1일 [가정]에 만료된다(ADR-0070, docs/data.md §3).

#### Scenario: 앞 항목이 아직 확인 전

- **WHEN** 항목 1·2·3을 읽고 2·3만 확인받았다
- **THEN** 1은 남고 2·3은 확인 표시 뒤 1보다 뒤라서 남는다. 1까지 확인받으면 셋 다 지워진다

### Requirement: 의존성마다 서비스 안 차단기를 둔다

서비스가 다른 서비스나 외부 제공자를 부르는 호출은 의존성마다 하나인 차단기를 SHALL 거친다. 기본값은 10초 [가정] 창에서 끝난 호출이 20건 [가정] 이상이고 그 가운데 실패가 50% [가정] 이상이면 열리고(끝난 시각으로 세고 진행 중인 호출은 넣지 않는다), 열린 뒤 5초 [가정]가 지나면 시험 호출 하나만 보내 성공하면 닫는다. 열린 동안은 의존성을 부르지 않고 503 `dependency-unavailable`과 `Retry-After`로 끝낸다. 실패는 서버 오류·시간 초과·연결 실패이고 업무 거절은 세지 않는다. 상태와 끊은 수를 지표로 낸다(ADR-0009 결정 2·5).

#### Scenario: 실패가 문턱을 넘으면 열린다

- **WHEN** 10초 안에 20번 불러 10번이 연결 실패로 끝난다
- **THEN** 다음 호출은 의존성을 부르지 않고 503 `dependency-unavailable`과 `Retry-After`로 끝나며 `circuit_breaker_state`가 2이고 `circuit_breaker_rejected_total{reason="open"}`이 오른다

#### Scenario: 적은 호출이나 업무 거절로는 열리지 않는다

- **WHEN** 호출이 19번뿐이고 모두 실패하거나, 30번 가운데 20번이 404·gRPC `NOT_FOUND` 같은 업무 거절이다
- **THEN** 차단기는 닫힌 채다

#### Scenario: 시험 호출이 성공하면 닫히고 새로 센다

- **WHEN** 열린 뒤 5초가 지나 시험 호출 하나가 성공한다
- **THEN** 차단기가 닫히고(상태 0), 바로 뒤의 실패 한 번으로 다시 열리지 않는다. 시험 호출이 끝나기 전에 온 다른 호출은 503이다

#### Scenario: 시험 호출 하나로만 판정한다

- **WHEN** 시험 호출이 5초 [가정] 안에 끝나지 않거나, 열리기 전부터 진행 중이던 호출이 반 열림 동안 실패·성공한다
- **THEN** 앞의 것은 실패로 세어 다시 열리고, 뒤의 것은 상태를 바꾸지 않는다. 두 경우 모두 부른 쪽은 그 호출의 진짜 결과를 받는다

#### Scenario: 동시 호출 상한

- **WHEN** 동시 호출 상한이 2인 차단기로 세 번째 호출이 동시에 온다
- **THEN** 세 번째는 의존성을 부르지 않고 429 `server-busy`로 끝나며 차단기 실패로 세지 않는다

#### Scenario: 남은 시간이 없으면 부르지 않는다

- **WHEN** 요청의 남은 시간이 0인 채 차단기로 부른다
- **THEN** 의존성을 부르지 않고 504 `deadline-exceeded`이며 차단기 실패로 세지 않는다

### Requirement: 구매 세션 쓰기 요청은 요청 서명과 일련번호를 확인한 뒤에만 처리한다

`@PurchaseSigned()`를 단 처리기는 인증 가드가 신원·역할과 멱등 키 형식을 본 뒤, 모양 검사보다 먼저 `X-Purchase-Seq`·`X-Purchase-Mac`을 SHALL 확인한다. MAC은 `HMAC-SHA256(요청 인증 키, METHOD ‖ LF ‖ 경로와 쿼리 ‖ LF ‖ 일련번호 ‖ LF ‖ base64url(SHA-256(본문)))`이고 상수 시간으로 견준다. 머리가 없거나 형식이 틀리거나, 구매 세션이 없거나, MAC이 틀리면 401이고 일련번호를 올리지 않는다. MAC이 맞아도 일련번호가 그 구매 세션의 마지막 번호보다 크지 않으면 401이다(ADR-0050 결정 8, docs/frontend.md §5.3).

#### Scenario: 맞는 서명

- **WHEN** 구매 세션의 키로 서명한 일련번호 1의 홀드 요청이 온다
- **THEN** 처리기가 돌고 그 구매 세션의 마지막 번호가 1이 되며 처리기는 구매 세션 참조를 받는다

#### Scenario: 다시 보낸 요청

- **WHEN** 같은 일련번호로 서명한 요청이 한 번 더 온다
- **THEN** 401이고 처리기가 돌지 않는다

#### Scenario: 본문을 바꾼 요청

- **WHEN** 서명한 뒤 본문 한 글자를 바꿔 보낸다
- **THEN** 401이고 마지막 번호는 그대로다

#### Scenario: 머리 없음과 순서

- **WHEN** 두 머리가 없거나 형식이 틀린 요청, 서명이 틀리고 본문 모양도 틀린 요청, 멱등 키와 서명이 함께 틀린 요청이 온다
- **THEN** 앞의 둘은 400이 아니라 401이고, 마지막은 400 `idempotency-key-invalid`다(멱등 키 형식이 먼저). 익명 요청은 구매 세션을 찾기 전에 401이다

#### Scenario: 시작 확인

- **WHEN** 계약이 두 머리를 요구하는 처리기에 `@PurchaseSigned()`가 없거나, 공개 역할 처리기에 달거나, 구매 세션 포트 없이 띄운다
- **THEN** 서비스가 시작하지 않는다

#### Scenario: 시험 벡터

- **WHEN** 구현과 따로 계산한 벡터(공유 비밀·jti → 키, MAC 입력 → MAC)로 키와 MAC을 만든다
- **THEN** 값이 모두 같다(FE-T7 서버 쪽)

### Requirement: 서비스 사이 gRPC 채널은 공용 함수로만 만든다

서비스 사이 gRPC 클라이언트는 공용 채널 함수로 SHALL 만들어진다. 채널에는 재시도·헤지 정책이 없고 `grpc.enable_retries`를 끄지 않으며(투명 재시도만), 부하 분산은 설정 `PEAKET_GRPC_LB_PROFILE`의 `service`(pick_first, 기본)·`headless-round-robin`(round_robin, `local`·`ci`만) 가운데 하나다. DNS 서비스 설정을 읽지 않고 의존성마다 따로 연결한다. 호출마다 남은 시간과 호출 상한 가운데 짧은 쪽을 데드라인으로 걸고 추적 머리를 싣는다(ADR-0082 결정 4, docs/api/guidelines.md §5).

#### Scenario: 정책 없음과 덮어쓰기 거절

- **WHEN** 채널 설정을 만들거나, 덧붙일 설정에 `grpc.enable_retries`·`grpc.service_config` 같은 잠긴 이름을 넣는다
- **THEN** 서비스 설정에 `retryPolicy`·`hedgingPolicy`·`methodConfig`가 없고 `grpc.enable_retries`가 없으며, 잠긴 이름은 예외다

#### Scenario: 앱이 다시 보내지 않는다

- **WHEN** 서버가 첫 호출에 `UNAVAILABLE`로 답한다
- **THEN** 클라이언트는 `UNAVAILABLE`을 받고 서버는 그 호출을 한 번만 받았다

#### Scenario: 부하 분산 프로필

- **WHEN** 서버 둘의 주소로 `headless-round-robin` 설정과 `service` 설정 채널을 각각 만들어 여러 번 부른다
- **THEN** 앞의 것은 두 서버가 모두 받고 뒤의 것은 한 서버만 받는다. 운영 환경에서 `headless-round-robin`을 고르면 서비스가 시작하지 않는다

#### Scenario: 데드라인과 추적 머리

- **WHEN** 남은 시간이 300ms인 요청 안에서 호출 상한 1초로 부른다
- **THEN** 서버가 받은 데드라인은 지금부터 300ms 안이고, 메타데이터의 `traceparent`가 호출 span을 가리킨다
