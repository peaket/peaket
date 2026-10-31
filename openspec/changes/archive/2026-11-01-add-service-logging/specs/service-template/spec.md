## ADDED Requirements

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
