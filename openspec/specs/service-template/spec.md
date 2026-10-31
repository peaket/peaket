# service-template Specification

## Purpose
서비스(NestJS·Fastify)가 함께 쓰는 서버 공용 패키지 `packages/platform`이 밖으로 보이는 행동이다. 모든 서비스가 같은 모양의 네 신호 지표, RFC 9457 오류 응답, 남은 시간 전파를 갖고, 실행 중에는 API 문서 경로를 내지 않으며, CI가 서비스 문서를 계약과 견준다. 규칙의 정본은 docs/observability.md §3·§8, docs/api/guidelines.md §2·§5, docs/devops.md §3.1이다(openspec 변경 add-service-template, 2026-11-01, BUILD_ORDER FND-050).

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
