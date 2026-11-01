## ADDED Requirements

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
