## ADDED Requirements

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
