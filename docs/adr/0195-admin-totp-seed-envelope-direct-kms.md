# ADR-0195: 관리 계정 TOTP 시드 봉투 암호화는 KMS 데이터 키를 바로 쓴다 — 새 의존성 없이 같은 계정 결속을 얻어서

- **상태**: 채택(2026-11-05, 추천 적용, BUILD_ORDER BOT-120). ADR-0053 결정 7의 수단('AWS Encryption SDK로 봉투 암호화')을 이 ADR로 바꾼다. 결정 7의 목적(암호화 컨텍스트 `{purpose: "peaket-admin-totp-v1", accountId}`로 암호문을 관리 계정에 묶고, 다른 계정 행으로 옮긴 암호문은 풀리지 않게 한다)은 그대로다.
- **관련**: ADR-0050(암호 정정과 키 관리, AES-256-GCM 봉투 암호화의 독자 구현), ADR-0053 결정 7, [docs/features/identity.md](../features/identity.md) §6 '관리 계정 TOTP와 로그인 2단계의 첫 구현', [docs/security/secrets-and-keys.md](../security/secrets-and-keys.md) 'TOTP 시드 암호화 키', [docs/security/asvs/auth.md](../security/asvs/auth.md) 11.4.2
- **관련 ID**: I-T41, ASVS v5.0.0-11.4.2

## 맥락

- ADR-0053 결정 7은 TOTP 시드를 AWS Encryption SDK로 봉투 암호화하고 암호화 컨텍스트로 계정에 묶으라고 정했다. ADR-0050은 같은 데이터를 'KMS 봉투 암호화로 독자 구현한 AES-256-GCM'으로 적었다. 두 문장의 수단이 다르다.
- 시드는 계정마다 20바이트 하나이고, 서비스는 identity-svc 하나만 다룬다. Encryption SDK가 주는 것(여러 키 공급자, 메시지 꼴, 서명 묶음)은 이 쓰임에 필요하지 않다.
- 저장소는 새 의존성에 게시 뒤 3일·신뢰 증거 검사(`pnpm-workspace.yaml`의 `minimumReleaseAge`·`trustPolicy`)를 건다. 이미 쓰는 `@aws-sdk/client-kms`만으로 같은 결속을 얻을 수 있으면 의존성을 늘리지 않는 편이 공급망 위험이 작다.

## 결정

1. 시드는 KMS `GenerateDataKey`(AES_256)를 암호화 컨텍스트 `{purpose: "peaket-admin-totp-v1", accountId}`로 불러 받은 데이터 키로 AES-256-GCM 암호화한다. 추가 인증 데이터는 같은 컨텍스트를 키 순서로 정렬한 JSON이다.
2. 풀 때는 KMS `Decrypt`에 같은 컨텍스트를 넘긴다. 컨텍스트가 다르면 KMS가 거절하고(`InvalidCiphertextException`), 데이터 키를 얻어도 GCM 태그가 맞지 않는다. 그래서 다른 계정 행으로 옮긴 암호문은 두 겹으로 풀리지 않는다(I-T41).
3. 저장 꼴은 판 1바이트(1) ‖ 암호화한 데이터 키 길이 2바이트 ‖ 암호화한 데이터 키 ‖ IV 12바이트 ‖ 태그 16바이트 ‖ 암호문이다. 판 바이트로 나중에 꼴을 바꿀 수 있다.
4. KMS 키 정책이 이 `purpose`가 있을 때만 복호를 허용하는 것(ADR-0053 결정 7)은 그대로 둔다. 로컬·CI는 설정의 키 값으로 데이터 키를 같은 꼴로 감싼다. 운영에서 키 값은 받지 않는다.

## 검토한 다른 안

| 안 | 고르지 않은 까닭 |
| --- | --- |
| AWS Encryption SDK(`@aws-crypto/client-node`) | 같은 결속을 주지만 의존성 묶음이 늘고, 이 쓰임(시드 하나)에는 SDK의 메시지 꼴·키 공급자 기능이 필요 없다 |
| KMS `Encrypt`로 시드를 바로 암호화 | 시드는 4KB보다 작아 된다. 다만 복호마다 KMS 왕복이 같고, 다른 KMS 대칭 키 쓰임(가상계좌 번호 등)과 같은 봉투 모양을 맞추려 데이터 키 방식을 고른다 |

## 결과

- 좋은 점: 새 의존성이 없다. 결속의 근거가 KMS 컨텍스트 확인과 GCM 태그 둘이다.
- 비용: 꼴과 직렬화를 직접 유지한다. 깨진 행은 `TotpSeedUnreadable`로 끝나야 하므로 꼴 검사(판, 길이, 빈 데이터 키)를 시험으로 지킨다.
- 다시 볼 조건: 다른 서비스가 같은 봉투를 쓰게 되거나 여러 리전 키 공급자가 필요해지면(ADR-0102의 복제 키 넘기기 너머) Encryption SDK를 다시 본다.
