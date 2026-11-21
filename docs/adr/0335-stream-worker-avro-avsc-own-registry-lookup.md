# ADR-0335: 스트림 작업자의 Avro 읽기는 `avsc`와 직접 짠 레지스트리 조회로 한다(2026-11-22)

- **상태**: 채택(감독 승인 2026-11-22, BUILD_ORDER BAT-220 계획 `bat220-plan-3a8b52c3`의 '감독에게' 2 (가)). OPS-150을 구현하기 전에 정한 것이다(docs/architecture.md §8.6 4의 2). docs/streaming.md §2.1 표의 한 줄과 §2.6의 한 줄을 바꾼다(결정 4).
- **관련**: [ADR-0099](0099-drop-flink-typescript-stream-workers-read-time-aggregation.md) 결정 2(공용 소비 모듈), [ADR-0191](0191-trust-policy-exact-version-exceptions-seed-semver.md)(신뢰 증거가 약해진 판의 예외), docs/devops.md §4.4(의존성과 취약점), docs/api/avro/README.md §3(등록과 호환), docs/streaming.md §2.6
- **관련 ID**: ST-T15, ST-T16, OPS-150

## 맥락

- 정본은 Avro(사건을 바이트로 담는 형식) 읽기 라이브러리를 `@confluentinc/schemaregistry` 1.11.0으로 적어 두었다(docs/streaming.md §2.1 '클라이언트와 라이브러리' 표, 2026-10-27 확인). OPS-150이 처음으로 Avro를 실제로 푸는 코드를 만든다. 그 전에는 저장소에 Avro 라이브러리가 없었다.
- 2026-11-22 `npm view @confluentinc/schemaregistry@1.11.0 dependencies`로 본 직접 의존은 28개다. 그 가운데 클라이언트 쪽 필드 암호화 규칙용인 `@aws-sdk/client-kms`·`@aws-sdk/credential-providers`·`@azure/identity`·`@azure/keyvault-keys`·`@google-cloud/kms`·`node-vault`, HTTP용 `axios`·`axios-retry`, 규칙 언어 `jsonata`·`@bufbuild/cel`, 검증용 `joi`·`ajv`·`validator`가 있다. 작업자가 쓰는 일은 Avro 풀기와 'ID로 스키마 받기' 둘뿐이다.
- 공급망 위험: 의존 하나하나가 탈취된 계정이 올린 악성 판이 들어오는 길이다(docs/devops.md §4.4의 npm 웜 사례). 전이 의존이 많을수록 `trustPolicy: no-downgrade`에 걸려 예외(ADR-0191)를 다룰 일이 늘고, 갱신과 취약점 경보도 는다. 작업자 이미지에 클라우드 세 곳의 SDK가 쓰이지 않은 채 실린다.
- 그 패키지가 안에서 Avro를 푸는 데 쓰는 것은 `avsc`다(5.7.9, 레지스트리 `latest`, 직접 의존 0, 2026-11-22 확인).

## 결정

1. **Avro 풀기는 `avsc` 5.7.9.** `packages/platform`에만 정확한 판(범위 없이)으로 두고, `@peaket/platform/stream-worker` 하위 내보내기에서만 싣는다. Kafka를 쓰지 않는 서비스는 싣지 않는다.
2. **레지스트리 조회는 공용 소비 모듈이 직접 짠다.** Confluent Schema Registry REST의 `GET /schemas/ids/{id}` 하나만 쓴다.
3. **직접 짠 조회의 규칙(추천 적용, 2026-11-22, BAT-220 계획)**:
   - 주소: 운영·스테이징·데모는 `https`만 받고 다른 주소면 시작하지 않는다. local·ci만 `http`를 받는다. 인증서 검증을 끄는 선택은 두지 않는다. 다른 주소로 보내는 응답(3xx)은 따라가지 않는다.
   - 인증: Basic 인증이다. 자격은 Secrets Manager에서 받은 값을 쓴다(docs/streaming.md §2.3 비밀 값 줄). 자격은 로그·오류 글·주소·지표에 넣지 않는다.
   - 캐시: 스키마 ID를 키로 하고 성공한 조회만 넣는다. 레지스트리에서 한 ID의 스키마는 바뀌지 않으므로 만료는 없다. 상한은 1,000개 [가정]이고, 넘으면 가장 오래 쓰지 않은 것부터 뺀다. 같은 ID를 동시에 찾으면 요청 하나를 함께 기다린다.
   - 스키마 ID 대조: 메시지 앞 다섯 바이트(매직 바이트 0과 4바이트 스키마 ID, docs/api/avro/README.md §3)를 먼저 본다. 매직 바이트가 0이 아니거나 ID가 1부터 `MAX_SCHEMA_ID`(packages/platform/src/avro.ts)까지의 밖이면 `DESERIALIZE`로 거절한다. 조회는 그 ID로만 하고, 받은 스키마는 그 ID의 캐시 칸에만 넣는다.
   - 실패 분류: 404만 `UNKNOWN_SCHEMA` 거절이다. 그 밖의 실패(시간 한도 초과, 연결·TLS 오류, 5xx, 401·403, 그 밖의 4xx, Avro 스키마로 읽히지 않는 응답, 1MiB [가정]를 넘는 응답)는 다시 시도할 장애다(docs/streaming.md §2.6 레지스트리 줄의 시간 한도와 분류).
4. **정본 표 고침**: docs/streaming.md §2.1 '클라이언트와 라이브러리' 표의 'Schema Registry와 Avro' 줄과 §2.6의 역직렬화 줄을 이 결정으로 바꾼다. docs/devops.md §4.4에 판을 고정한 줄을 더한다.
5. **새 의존의 확인**: 설치 때 `trustPolicy: no-downgrade`와 라이선스 허용 목록(docs/devops.md §4.4 '라이선스')을 통과했는지와 그 근거(판, 게시일, 출처 증명 유무, 라이선스)를 구현 담당이 BAT-220 계획 파일 '구현 메모'에 적는다. 막히면 멈추고 감독에게 넘긴다(ADR-0191의 단계).

## 검토한 대안

| 안 | 좋은 점 | 나쁜 점 |
| --- | --- | --- |
| (가) `avsc` + 직접 짠 조회(고름) | 의존 0, 쓰는 일만 싣는다, 이미지가 작다 | 조회·캐시·인증·TLS를 우리가 지키고 시험해야 한다 |
| (나) `@confluentinc/schemaregistry` 1.11.0(앞 정본) | 공식 클라이언트, 레지스트리 기능 전부 | 직접 의존 28개(클라우드 세 곳의 KMS SDK·vault 등), 쓰지 않는 코드가 공급망의 길이 된다 |
| (다) 레지스트리 없이 빌드된 스키마로만 읽기 | 조회가 없다 | 쓴 쪽 스키마로 읽는 정본 규칙(docs/streaming.md §2.6)과 어긋나고, 새 판 생산자의 바이트를 읽지 못한다 |

## 결과

- 작업자 이미지에 클라우드 SDK가 실리지 않는다. 조회 규칙(결정 3)은 BAT-220 계획 §6 'OPS-150 ⑩'의 시험으로 덮는다.
- 레지스트리의 스키마 참조(`references`)와 규칙 기능은 쓰지 못한다. 지금 계약의 Avro 파일은 파일마다 따로 서므로 쓰지 않는다. 참조가 든 응답이 오면 'Avro 스키마로 읽히지 않는 응답'이라 그 파티션이 멈추고 소비 밀림 경보로 보인다.
- 생산자 쪽 Avro 바이트 만들기(BAT-225, ST-T16 ②)도 같은 `avsc`를 쓴다.

## 되돌릴 조건

- 스키마 참조나 레지스트리 규칙(필드 암호화 등)이 필요해지면 (나)를 다시 본다.
- `avsc`가 더 관리되지 않거나(오래 게시가 없고 보안 문제가 풀리지 않음) 신뢰 증거가 약해진 판만 남으면 다른 라이브러리를 본다.
