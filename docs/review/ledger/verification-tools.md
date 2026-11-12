# 완성 장부: verification-tools

`tools/ci/ledger.mjs`가 정본에서 다시 쓴다. 손으로 고치지 않는다(상태·등급·사유는 `docs/review/ledger-notes.md`). 원천: `docs/security/asvs/verification-tools.md`. 전체 개수와 이 도구의 한계는 `docs/review/ledger/README.md`에 있다.

| 등급 | 자동 시험 | ID만 | 측정 | 사람 확인 | 미검증 | 다른 단계 | 없앰 | 해당 없음 | 빈칸 | 합계 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B | 9 | 7 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 18 |
| 합계 | 9 | 7 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 18 |

## docs/security/asvs/verification-tools.md

| 항목 | 세부 | 제목 | 판정 기준 앞부분 | 상태 | 등급 | 근거 |
| --- | --- | --- | --- | --- | --- | --- |
| v5.0.0-1.2.4 | — | L1 | 데이터 조회·DB 쿼리는 파라미터 쿼리, ORM 등으로 SQL 등 DB 주입을 막는다(저장 프로시저 포함). | ID만 | B | 다른 곳 시험: services/core-svc/test/search.http.test.ts, services/purchase-svc/test-int/booking-restrictions.int.test.ts 외… |
| v5.0.0-1.2.5 | — | L1 | OS 명령 주입을 막고 OS 호출은 파라미터화하거나 명령줄 인코딩을 쓴다. | ID만 | B | 다른 곳 시험: loadtest/test/manifests090.test.mjs, loadtest/test/review060.test.mjs 외 2곳 (영역: loadtest/nightly) |
| v5.0.0-2.1.1 | — | L1 | 데이터 항목이 기대 구조에 맞는지 확인하는 입력 검증 규칙을 문서에 정의한다. | ID만 | B | 다른 곳 시험: packages/validation/test/sale-policy.test.ts, services/core-svc/test/sale-eligibility.http.test.ts 외 7곳 (영역:… |
| v5.0.0-2.2.1 | — | L1 | 입력이 업무·기능 기대를 만족하는지 허용 목록(값·패턴·범위)이나 미리 정한 규칙의 기대 구조·논리 한도로 검증하고, L1은 업무·보안 결정에 쓰는 입력에… | 자동 시험 | B | 시험: loadtest/e2e/v0-rehearsal.e2e.mjs, loadtest/test/args090.test.mjs 외 6곳 |
| v5.0.0-2.3.4 | — | L2 | 한정 수량 자원이 로직 조작으로 이중 예약되지 않도록 업무 수준 잠금을 쓴다. | ID만 | B | 다른 곳 시험: packages/platform/test-int/idempotency.int.test.ts, packages/platform/test-int/template.int.test.ts 외 49곳 (영역:… |
| v5.0.0-4.1.1 | — | L1 | 본문이 있는 모든 HTTP 응답에 실제 내용과 맞는 `Content-Type`을 두고, 텍스트·XML처럼 IANA 미디어 타입이 정하는 경우 안전한 문자… | ID만 | B | 다른 곳 시험: services/purchase-svc/test/http.test.ts, services/v0-monolith/test-int/queue.int.test.ts (영역: loadtest… |
| v5.0.0-8.2.1 | — | L1 | 기능 접근을 명시적 권한이 있는 호출자로 제한한다. | 자동 시험 | B | 시험: services/pg-simulator/test/simulator.test.ts |
| v5.0.0-13.1.1 | — | L2 | 애플리케이션의 통신 필요(의존하는 외부 서비스, 사용자가 외부 위치를 줄 수 있는 경우 포함)를 모두 문서화한다. | ID만 | B | 다른 곳 시험: services/purchase-svc/test/consumers.test.ts (영역: loadtest/nightly) |
| v5.0.0-13.2.2 | — | L2 | 백엔드 통신을 최소 권한 계정으로 한다. | 자동 시험 | B | 시험: loadtest/test/manifests090.test.mjs, loadtest/test/review060.test.mjs 외 2곳 |
| v5.0.0-13.3.1 | — | L2 | 키 보관소 같은 비밀 관리 도구로 백엔드 비밀을 안전하게 만들고 저장·접근 통제·폐기하며, 소스 코드와 빌드 산출물에 비밀을 넣지 않고, L3는 HSM 같은… | 자동 시험 | B | 시험: loadtest/e2e/v0-rehearsal.e2e.mjs, loadtest/test/runner.test.mjs 외 2곳 |
| v5.0.0-13.4.2 | — | L2 | 운영 환경의 모든 구성요소에서 디버그 모드를 끈다. | 자동 시험 | B | 시험: services/pg-simulator/test/simulator.test.ts |
| v5.0.0-13.4.5 | — | L2 | 내부 API 문서와 모니터링 엔드포인트는 의도한 경우가 아니면 노출하지 않는다. | 자동 시험 | B | 시험: services/pg-simulator/test/simulator.test.ts |
| v5.0.0-14.1.1 | — | L2 | 애플리케이션이 만들고 처리하는 민감 데이터를 Base64·JWT 본문처럼 인코딩만 된 것까지 모두 찾아, 따라야 할 데이터 보호·개인정보 법규와 표준을 반영한… | ID만 | B | 다른 곳 시험: services/core-svc/test-int/sale-eligibility.int.test.ts, services/v0-monolith/test-int/gate.int.test.ts 외 4곳… |
| v5.0.0-14.2.4 | — | L2 | 보호 등급 문서에 정한 대로 암호화, 무결성 검증, 보존, 로그 기록 방식과 로그 속 민감 데이터 접근 통제, 개인정보 보호 기술을 구현한다. | 자동 시험 | B | 시험: loadtest/e2e/v0-rehearsal.e2e.mjs |
| v5.0.0-14.2.6 | — | L3 | 기능에 필요한 최소한의 민감 데이터만 돌려주고, 전체가 필요하면 사용자가 일부러 볼 때가 아니면 화면에서 가린다. | 자동 시험 | B | 시험: services/invariant-checker/test-int/invariants.int.test.ts |
| v5.0.0-16.2.5 | — | L2 | 민감 데이터는 보호 등급에 따라 로그에 남긴다(자격 증명·결제 정보는 남기지 않고, 일부는 해시·마스킹). | 자동 시험 | B | 시험: loadtest/test/before090.test.mjs, loadtest/test/lib.test.mjs 외 2곳 |
| v5.0.0-16.2.1 | — | L2 | 로그 항목에 언제, 어디서, 누가, 무엇을 같은 조사용 메타데이터를 넣는다. | 해당 없음 | B | 나중 Phase로 미룸: 운영의 1분 대조(ADR-0106)를 배포할 때 정규 로그 줄과 경보(SEV1, RB-36)로 더한다. 지금은 시험 실행 폴더의 결과 파일이 기록이다 |
| v5.0.0-16.4.1 | — | L2 | 모든 로그 구성요소가 로그 주입을 막도록 데이터를 인코딩한다. | 해당 없음 | B | 나중 Phase로 미룸: 위와 같다. 결과 파일은 CSV 인용 규칙과 JSON 직렬화로 쓴다 |
