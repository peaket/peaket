## ADDED Requirements

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
