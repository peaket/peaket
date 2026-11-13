# 완성 장부: v0-baseline

`tools/ci/ledger.mjs`가 정본에서 다시 쓴다. 손으로 고치지 않는다(상태·등급·사유는 `docs/review/ledger-notes.md`). 원천: `docs/security/asvs/v0-baseline.md`. 전체 개수와 이 도구의 한계는 `docs/review/ledger/README.md`에 있다.

| 등급 | 자동 시험 | ID만 | 측정 | 사람 확인 | 미검증 | 다른 단계 | 없앰 | 해당 없음 | 빈칸 | 합계 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B | 28 | 2 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 31 |
| 합계 | 28 | 2 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 31 |

## docs/security/asvs/v0-baseline.md

| 항목 | 세부 | 제목 | 판정 기준 앞부분 | 상태 | 등급 | 근거 |
| --- | --- | --- | --- | --- | --- | --- |
| v5.0.0-1.2.4 | — | L1 | 데이터 조회·DB 쿼리는 파라미터 쿼리, ORM 등으로 SQL 등 DB 주입을 막는다(저장 프로시저 포함). | 자동 시험 | B | 시험: services/v0-monolith/test-int/queue.int.test.ts, services/v0-monolith/test-int/seat.int.test.ts |
| v5.0.0-2.1.1 | — | L1 | 데이터 항목이 기대 구조에 맞는지 확인하는 입력 검증 규칙을 문서에 정의한다. | ID만 | B | 다른 곳 시험: packages/validation/test/sale-policy.test.ts, services/core-svc/test/sale-eligibility.http.test.ts 외 8곳 (영역:… |
| v5.0.0-2.2.1 | — | L1 | 입력이 업무·기능 기대를 만족하는지 허용 목록(값·패턴·범위)이나 미리 정한 규칙의 기대 구조·논리 한도로 검증하고, L1은 업무·보안 결정에 쓰는 입력에… | 자동 시험 | B | 시험: services/v0-monolith/test-int/gate.int.test.ts, services/v0-monolith/test-int/queue.int.test.ts 외 4곳 |
| v5.0.0-2.3.4 | — | L2 | 한정 수량 자원이 로직 조작으로 이중 예약되지 않도록 업무 수준 잠금을 쓴다. | 자동 시험 | B | 시험: services/v0-monolith/test-int/gate.int.test.ts, services/v0-monolith/test-int/invariants.int.test.ts 외 4곳 |
| v5.0.0-2.4.1 | — | L2 | 데이터 유출, 쓰레기 데이터, 할당량 소진, 레이트 리밋 위반, 서비스 거부, 비싼 자원 남용으로 이어지는 과도한 호출을 막는 자동화 방지 통제를 둔다. | 자동 시험 | B | 시험: services/v0-monolith/test-int/queue.int.test.ts, services/v0-monolith/test/gateway-config.test.ts 외 3곳 |
| v5.0.0-4.1.1 | — | L1 | 본문이 있는 모든 HTTP 응답에 실제 내용과 맞는 `Content-Type`을 두고, 텍스트·XML처럼 IANA 미디어 타입이 정하는 경우 안전한 문자… | 자동 시험 | B | 시험: services/v0-monolith/test-int/queue.int.test.ts |
| v5.0.0-8.2.1 | — | L1 | 기능 접근을 명시적 권한이 있는 호출자로 제한한다. | 자동 시험 | B | 시험: services/v0-monolith/test-int/gate.int.test.ts, services/v0-monolith/test-int/queue.int.test.ts 외 3곳 |
| v5.0.0-8.2.2 | — | L1 | 데이터 접근을 그 데이터 항목에 명시적 권한이 있는 호출자로 제한해 IDOR·BOLA를 막는다. | 자동 시험 | B | 시험: services/v0-monolith/test-int/gate.int.test.ts, services/v0-monolith/test-int/queue.int.test.ts 외 2곳 |
| v5.0.0-13.3.1 | — | L2 | 키 보관소 같은 비밀 관리 도구로 백엔드 비밀을 안전하게 만들고 저장·접근 통제·폐기하며, 소스 코드와 빌드 산출물에 비밀을 넣지 않고, L3는 HSM 같은… | ID만 | B | 다른 곳 시험: loadtest/e2e/v0-rehearsal.e2e.mjs, loadtest/test/runner.test.mjs 외 13곳 (영역: services/v0-monolith) |
| v5.0.0-14.1.1 | — | L2 | 애플리케이션이 만들고 처리하는 민감 데이터를 Base64·JWT 본문처럼 인코딩만 된 것까지 모두 찾아, 따라야 할 데이터 보호·개인정보 법규와 표준을 반영한… | 자동 시험 | B | 시험: services/v0-monolith/test-int/gate.int.test.ts, services/v0-monolith/test-int/queue.int.test.ts 외 3곳 |
| v5.0.0-16.2.5 | — | L2 | 민감 데이터는 보호 등급에 따라 로그에 남긴다(자격 증명·결제 정보는 남기지 않고, 일부는 해시·마스킹). | 자동 시험 | B | 시험: services/v0-monolith/test-int/gate.int.test.ts, services/v0-monolith/test-int/queue.int.test.ts 외 1곳 |
| v5.0.0-4.4.1 | — | L1 | 모든 WebSocket 연결에 WSS를 쓴다. | 자동 시험 | B | 시험: services/v0-monolith/test/gateway-http-rules.test.ts, services/v0-monolith/test/gateway-server.test.ts |
| v5.0.0-4.4.2 | — | L2 | WebSocket 첫 HTTP 핸드셰이크에서 `Origin`을 허용 출처 목록과 대조한다. | 자동 시험 | B | 시험: services/v0-monolith/test-int/seat-review.int.test.ts, services/v0-monolith/test-int/seat.int.test.ts |
| v5.0.0-4.4.3 | — | L2 | 표준 세션 관리를 쓸 수 없으면 세션 관리 요구사항을 따르는 전용 토큰을 쓴다. | 해당 없음 | B | 나중 Phase로 미룸: v0 변경분 연결은 게이트웨이 신원 머리로 판정하고 전용 토큰이 없다. 종료 세션 목록은 연결할 때도 연결 중에도 보지 않는다(v0에는 종료 세션 사건을 받는 곳이 없다). v1… |
| v5.0.0-3.2.2 | — | L1 | HTML이 아니라 글로 보일 내용은 `textContent` 같은 안전한 렌더링 함수로 다룬다. | 자동 시험 | B | 시험: services/v0-monolith/test-int/seat.int.test.ts |
| v5.0.0-3.4.3 | — | L2 | HTTP 응답에 CSP를 둬 브라우저가 신뢰한 콘텐츠·자원만 싣고 실행하게 하고, 최소한 `object-src 'none'`·`base-uri 'none'`과… | 자동 시험 | B | 시험: services/v0-monolith/test-int/seat.int.test.ts |
| v5.0.0-3.4.4 | — | L2 | 모든 응답에 `X-Content-Type-Options: nosniff`를 둔다. | 자동 시험 | B | 시험: services/v0-monolith/test-int/seat.int.test.ts, services/v0-monolith/test/gateway-http-rules.test.ts 외 1곳 |
| v5.0.0-3.4.6 | — | L2 | 모든 HTTP 응답에 CSP `frame-ancestors`를 둬 기본적으로 끼워 넣을 수 없게 하고, 필요한 자원만 끼워 넣기를… | 자동 시험 | B | 시험: services/v0-monolith/test-int/seat.int.test.ts |
| v5.0.0-3.4.1 | — | L1 | 모든 응답에 HSTS를 둔다(최대 기간 1년 이상, L2부터 하위 도메인 포함). | 자동 시험 | B | 시험: services/v0-monolith/test/gateway-http-rules.test.ts, services/v0-monolith/test/gateway-server.test.ts |
| v5.0.0-2.3.1 | — | L1 | 같은 사용자의 업무 흐름을 정해진 순서대로만 처리하고 단계를 건너뛰지 못하게 한다. | 자동 시험 | B | 시험: services/v0-monolith/test-int/sale.int.test.ts, services/v0-monolith/test/sale-domain.test.ts |
| v5.0.0-2.3.3 | — | L2 | 업무 로직 수준의 트랜잭션으로 작업이 전부 성공하거나 이전의 올바른 상태로 되돌아가게 한다. | 자동 시험 | B | 시험: services/v0-monolith/test-int/sale.int.test.ts |
| v5.0.0-11.5.1 | — | L2 | 추측되면 안 되는 모든 난수와 문자열은 CSPRNG로 만들고 128비트 이상의 엔트로피를 갖는다(UUID는 이 조건을 만족하지 않는다). | 자동 시험 | B | 시험: services/v0-monolith/test-int/gate.int.test.ts, services/v0-monolith/test/sale-domain.test.ts |
| v5.0.0-14.2.1 | — | L1 | 민감 데이터는 HTTP 본문이나 헤더로만 서버에 보내고 URL·쿼리 문자열에 넣지 않는다. | 자동 시험 | B | 시험: services/v0-monolith/test-int/gate.int.test.ts, services/v0-monolith/test-int/sale.int.test.ts |
| v5.0.0-3.5.1 | — | L1 | CORS 사전 요청에 기대지 않는다면 민감 기능 요청이 애플리케이션에서 왔는지 확인한다(위조 방지 토큰, safelisted가 아닌 헤더 요구 등). | 자동 시험 | B | 시험: services/v0-monolith/test/gateway-config.test.ts, services/v0-monolith/test/gateway-http-rules.test.ts 외 1곳 |
| v5.0.0-4.1.3 | — | L2 | 로드밸런서·프록시·BFF 같은 중간 계층이 넣어 애플리케이션이 쓰는 헤더(`X-Real-IP`·`X-Forwarded-*`·`X-User-ID` 등)는 최종… | 자동 시험 | B | 시험: services/v0-monolith/test/gateway-config.test.ts, services/v0-monolith/test/gateway-http-rules.test.ts 외 3곳 |
| v5.0.0-9.1.1 | — | L1 | 자체 완결형 토큰은 서명이나 MAC을 검증한 뒤에만 내용을 받아들인다. | 자동 시험 | B | 시험: services/v0-monolith/test/gateway-server.test.ts, services/v0-monolith/test/gateway-token.test.ts |
| v5.0.0-9.1.2 | — | L1 | 자체 완결형 토큰의 생성·검증에는 맥락별 허용 목록의 알고리즘만 쓰고(`none` 제외, 되도록 대칭·비대칭 중 한쪽만), 둘 다 써야 하면 키 혼동을 막는… | 자동 시험 | B | 시험: services/v0-monolith/test/gateway-config.test.ts, services/v0-monolith/test/gateway-server.test.ts 외 1곳 |
| v5.0.0-9.2.1 | — | L1 | 유효 기간이 있으면 검증 시각이 그 안일 때만 받는다(`nbf`·`exp`). | 자동 시험 | B | 시험: services/v0-monolith/test/gateway-server.test.ts, services/v0-monolith/test/gateway-token.test.ts |
| v5.0.0-9.2.3 | — | L2 | 그 서비스를 위한 토큰(`aud`)만 받는다. | 자동 시험 | B | 시험: services/v0-monolith/test/gateway-config.test.ts, services/v0-monolith/test/gateway-server.test.ts 외 1곳 |
| v5.0.0-12.1.1 | — | L1 | TLS 1.2와 1.3처럼 권장되는 최신 버전만 켜고 가장 최신 버전을 우선한다. | 자동 시험 | B | 시험: services/v0-monolith/test/gateway-server.test.ts |
| v5.0.0-12.2.1 | — | L1 | 클라이언트와 외부에 노출된 HTTP 서비스 사이의 모든 연결에 TLS를 쓰고, 안전하지 않거나 암호화되지 않은 통신으로 돌아가지 않는다. | 자동 시험 | B | 시험: services/v0-monolith/test/gateway-config.test.ts, services/v0-monolith/test/gateway-server.test.ts |
