## ADDED Requirements

### Requirement: 로컬·CI 클러스터는 한 명령으로 같은 구성으로 뜬다

로컬 PC와 CI는 같은 스크립트로 kind 클러스터를 SHALL 띄운다. 클러스터에는 Strimzi Kafka(운영과 같은 3.9.x, KRaft), PostgreSQL 18, 계정·인증 토큰 없이 도는 AWS 흉내 서버가 있고, 도구(kind·kubectl·helm)는 공식 주소에서 받아 고정한 SHA-256과 맞을 때만 쓰며, 이미지는 다이제스트로 고정한다. 사용자의 kubeconfig는 바꾸지 않는다(docs/infra.md §3, 기술 검토 낮음-010).

#### Scenario: 받은 도구의 해시가 다르다

- **WHEN** 받은 kind·kubectl·helm 파일의 SHA-256이 고정한 값과 다르다
- **THEN** 그 파일을 쓰지 않고 실패한다

#### Scenario: 클러스터를 띄운다

- **WHEN** `node tools/local/cluster.mjs up`을 부른다
- **THEN** Kafka가 Ready이고 PostgreSQL과 AWS 흉내 서버의 롤아웃이 끝난다

### Requirement: AWS 흉내 서버는 우리가 쓰는 기능을 계정 없이 흉내 낸다

로컬·CI의 AWS 흉내 서버는 계정·인증 토큰 없이 S3 Object Lock(보존 기한·법적 보존), KMS 비대칭 서명(ECC_NIST_P256, ECDSA_SHA_256), Secrets Manager 판을 SHALL 흉내 낸다(docs/infra.md §3).

#### Scenario: 보존 중인 증거는 지울 수 없다

- **WHEN** COMPLIANCE 보존 기한이나 법적 보존이 걸린 객체의 판을 지운다
- **THEN** AccessDenied로 거절된다

#### Scenario: KMS 서명

- **WHEN** P-256 서명 키로 서명한 메시지를 검증한다
- **THEN** 맞는 메시지는 검증되고, 바뀐 메시지는 검증 실패이며, 공개키만 꺼낼 수 있다

### Requirement: 비밀이 필요한 CI 단계는 포크 PR에서 건너뛰었다고 표시한다

비밀이 필요한 CI 단계는 포크에서 온 PR에서 실패하지 않고 건너뛰며, 그 사실을 알림과 잡 요약에 SHALL 남긴다. 조직 안 PR과 푸시에서 비밀이 빠졌으면 건너뛰지 않고 실패한다(docs/devops.md §4.5, 기술 검토 낮음-010).

#### Scenario: 포크 PR

- **WHEN** 포크 저장소에서 온 PR에서 비밀 `LOCALSTACK_AUTH_TOKEN`이 필요한 단계가 돈다
- **THEN** 단계 출력 `run`이 false이고, '포크 PR 건너뜀' 알림과 잡 요약 줄이 남으며 잡은 실패하지 않는다

#### Scenario: 조직 안 PR에서 비밀이 빠짐

- **WHEN** 같은 저장소의 PR에서 그 비밀이 없다
- **THEN** 단계가 오류로 실패한다
