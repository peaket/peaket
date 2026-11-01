## ADDED Requirements

### Requirement: Kafka 클라이언트는 MSK IAM으로 붙을 때 작업자 전용 역할을 고정 세션 이름으로 맡는다

공용 Kafka 모듈은 MSK IAM 인증을 고르면 모든 연결(생산자·키 단위 소비자·관리 연결·방송형 읽기)이 TLS와 OAUTHBEARER로 붙고, 토큰은 작업자 전용 MSK 역할을 세션 이름 `<작업자>-<환경>`으로 맡아 SHALL 만든다. 역할을 맡지 못하면 기본 자격으로 넘어가지 않고 실패한다. 인증을 고른 설정은 덧붙일 설정으로 보안 방식·SASL 설정·TLS 인증서 검증·믿을 CA를 바꿀 수 없다(docs/streaming.md §2.6, docs/devops.md §9.4, ST-T14 ①, 기술 검토 높음-26).

#### Scenario: 고정 세션 이름

- **WHEN** 작업자 `purchase-svc`가 환경 `prod`에서 토큰을 두 번 만든다
- **THEN** 두 번 모두 세션 이름 `purchase-svc-prod`로 역할을 맡고, 토큰은 맡은 역할의 자격으로 서명된다

#### Scenario: 역할을 맡지 못함

- **WHEN** 역할 신뢰를 거둬 STS가 AccessDenied로 답한다
- **THEN** 토큰을 만들지 않고 실패하며, 파드 자격으로 토큰을 만들지 않는다

#### Scenario: 환경 값으로 인증을 고른다

- **WHEN** `PEAKET_KAFKA_AUTH`가 없다
- **THEN** 평문으로 붙는다(로컬·CI 브로커)
- **WHEN** `PEAKET_KAFKA_AUTH=msk-iam`인데 `PEAKET_KAFKA_MSK_ROLE_ARN`이 없다
- **THEN** 시작에서 실패한다

#### Scenario: 모든 연결이 인증으로 붙는다

- **WHEN** TLS + OAUTHBEARER 리스너만 연 브로커에 생산자·관리 연결·키 단위 소비자·방송형 읽기를 MSK IAM 인증으로 띄운다
- **THEN** 넷 모두 토큰 함수를 부르고 붙어 사건을 보내고 받는다

#### Scenario: TLS 검증을 끄려 한다

- **WHEN** MSK IAM 인증을 고른 설정에 `enable.ssl.certificate.verification` 같은 TLS 검증·CA 설정을 덧붙인다
- **THEN** 설정을 만들지 않고 거절한다
