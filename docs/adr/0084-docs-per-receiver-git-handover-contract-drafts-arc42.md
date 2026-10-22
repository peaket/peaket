# ADR-0084: 문서를 받는 사람별로 보강한다 — Git 저장소, arc42 안내, 인프라·관제 인수 문서, 계약 파일 초안(proto·Avro), 경영진 요약(2026-10-22)

- **상태**: 채택 (2026-10-22. 소유자가 멘토(SI 아키텍트)의 조언을 보이며, 전체 설계 문서가 그 기준(C4·ADR·arc42를 바탕으로, 표준 명세 파일, 관측·인프라 이중화 문서, 받는 사람별 문서, 문서의 Git 관리)을 따르는지 봐 달라고 했다. 점검 결과를 본 뒤 "이 폴더를 Git 저장소로 만들어 첫 기록을 남기고, 충돌이 없는 새 문서(인프라·관제팀 인수 문서, 내부 통신 .proto 초안, arc42 안내)부터 추천 순서대로 보완해 주세요. 기존 문서 수정은 다듬기 작업이 반영된 뒤에 해 주세요."라고 했고, 이어서 "경영진용 1~2쪽 요약과 Avro 스키마 초안을 이어서 만들어 주세요."라고 했다. 저장소를 만드는 것과 새 문서의 종류는 소유자 결정이다. 문서 안에서 정한 값과 규칙은 추천 적용이고 소유자 검토 대상이다)
- **관련**: ADR-0016(폴리레포와 계약 저장소), ADR-0026(Kafka 토픽 분리와 Avro), ADR-0031(환경과 리전 장애), ADR-0032(관제 도구), ADR-0054(배포 순서와 호환 규칙), ADR-0057(운영 환경은 설계로만), ADR-0058(CDN 배포), ADR-0071(대기 중 재평가), ADR-0074(git flow), ADR-0075(감사 공개 앵커), ADR-0077(관측 전용 Kafka), ADR-0082(서비스 메시)

## 맥락

- **점검에서 찾은 빈칸(직접 확인)**:
  - arc42 입구 문서가 없었다. C4 3단계 그림이 없었고, 2단계 그림에는 이어지지 않은 상자(gw-partner·gw-scanner·trust-svc)와 서비스 → Kafka 선이 없었다.
  - 내부 gRPC와 Kafka 사건의 계약은 글과 asyncapi의 JSON Schema로만 있었다(.proto·.avsc 파일 없음).
  - 인스턴스 사양표, 이중화 그림, 인프라·관제팀이 넘겨받을 문서, 직접 만든 관제·관측 시스템의 데이터 흐름도, 대시보드 목록, 저장소별 키 관리 권한이 없었다.
  - 폴더가 Git 저장소가 아니었다. 문서 저장소는 공개로 계획되어 있다(docs/devops.md §2.1).
  - 대상 문서 가운데 17개에 '독자와 용도' 줄이 없었다(ASVS 추적 표 13개, 분석 기능 설계, 품질 요구사항, 개인정보 목록, 비밀·키 목록).
- **문서끼리 어긋난 곳(직접 확인)**: 운영 감사 로그 보존(docs/observability.md §7 '영구'와 §9 '2년·3년'), docs/infra.md §1 그림의 'MSK ×2' 표기와 §2 그림의 스캐너 경로, planning/01-overview.md의 'ADR 73건', docs/architecture.md §3.2의 'OpenAPI 3.0', asyncapi의 `defaultContentType: application/avro`와 JSON Schema payload, 셔플 결과 파일을 게시하는 서비스(docs/architecture.md §3.1과 §9.4·docs/features/queue-admission.md §2), wbs의 법률 확인 필요 건수 경위(11건에서 끝남), docs/infra.md §9의 메시 제품 표현(ADR-0082 이전 문장), 00-summary.md의 prototype/ 참조(폴더는 2026-10-22에 지워졌다).
- **작업 순서**: 쉬운 말 다듬기 작업(review R-94)이 같은 폴더의 기존 문서 48개를 고치고 있었다. 그래서 새 문서를 먼저 만들고, 기존 문서는 다듬기가 반영된 뒤 고쳤다.
- **확인한 외부 사실(2026-10-22, 원문)**:
  - AWS: c7g·m7g·r7g EC2는 서울과 도쿄 리전에 있다(EC2 리전별 인스턴스 문서). ElastiCache cache.r7g.large는 2 vCPU·13.07GiB, cache.r7g.xlarge는 4 vCPU·26.32GiB이고, MSK kafka.m7g는 서울에 있다(가격표 API).
  - Apache Avro 1.12.0 명세: uuid는 string이나 길이 16인 fixed에, timestamp-millis는 long에, date는 int에 붙인다. 유니온 필드의 기본값은 처음으로 맞는 갈래로 읽는다. 열거 기본값은 읽는 쪽에 없는 기호를 만났을 때 쓰고, 없으면 오류다. 쓴 쪽과 읽는 쪽 레코드는 이름이 같아야 맞춘다. int와 long은 가변 길이로 쓴다.
  - Confluent 문서: 주제 이름 전략은 TopicNameStrategy(기본)·RecordNameStrategy·TopicRecordNameStrategy다. TopicRecordNameStrategy의 주제는 `<토픽>-<레코드 전체 이름>`이고, 한 토픽에 여러 레코드 종류를 섞을 수 있으며 호환 검사는 토픽 안의 레코드 이름마다 한다. `auto.register.schemas`와 `use.latest.version`의 동작, BACKWARD_TRANSITIVE의 뜻, BACKWARD 계열은 소비자를 모두 먼저 올린다는 것.
  - Debezium 3.7 문서: Outbox payload를 Avro로 쓰려면 열을 `bytea` 같은 바이너리로 두고 `BinaryDataConverter`로 그대로 보낸다. 하트비트와 트랜잭션 메타데이터는 대리 변환기가 필요하다.
  - AsyncAPI 3.0.0 명세: 메시지 payload를 Multi Format Schema Object로 적을 수 있고, Avro 1.9.0 형식(`application/vnd.apache.avro+json;version=1.9.0`)이 구현을 권하는 목록에 있다.

## 결정

1. **문서를 Git 저장소로 관리한다(소유자 결정, 세부는 추천 적용)**: `main`의 첫 커밋(c037a15)이 다듬기 전 기준점이고, 기본 가지는 `develop`이다. 문서마다 CRLF와 LF가 섞여 있어 줄바꿈 자동 변환을 끈다(`.gitattributes` `* -text`, `core.autocrlf false`). 작업 가지는 git flow(ADR-0074)대로 `develop`에 스쿼시로 합친다. 맞는 WBS·이슈 번호가 없는 작업은 가지 이름에 번호를 붙이지 않고 커밋 본문에 그렇게 적는다.
2. **받는 사람별 새 문서를 둔다(소유자 결정)**:
   - docs/infra-handover.md: 인프라·관제팀 인수 문서다(사양표, 이중화 그림, 데이터 흐름도 2장, 장애 종류별 실행표, 도쿄 전환 준비물, 데이터 지도와 키 관리 권한, 당직 시작 페이지, 대시보드 목록).
   - docs/api/proto/: 내부 gRPC 계약 초안이다(파일 8개, 서비스 8개, 호출 19개, buf v2 STANDARD 형식 검사·FILE 호환 검사).
   - docs/api/avro/: Kafka 사건의 Avro 스키마 초안이다(asyncapi의 Kafka 메시지 18개).
   - docs/arc42.md: arc42 12칸과 PEAKET 문서의 대응표, C4 3단계 그림 3장이다.
   - planning/00-executive-summary.md: 의사결정자용 2쪽 요약이다.
3. **인수 문서의 값(추천 적용)**: 노드 풀은 핫패스 c7g(기본 c7g.2xlarge, 온디맨드), 일반 m7g, 데이터 m7g·r7g, 관측 r7g로 두고 모두 [가정]이다. 측정(wbs 2.12.1 → 4.8.1 → 6.4.1)으로 확정한다. 가용성 등급은 1등급 판매 경로·1등급 공연 당일·2등급 판단·보조·3등급 사후·분석·관측의 넷이다. 키 끄기와 삭제 예약은 긴급 접근 역할에 commander 한 명의 승인을 더해 두 사람이 하고, 삭제 대기는 KMS 최대값인 30일로 두며, CloudTrail 이벤트로 SEV2 경보를 낸다. 도쿄 전환 준비물은 결제사에 도쿄 NAT 고정 IP 미리 등록, ECR 교차 리전 복제, 다중 리전 비밀, RB-18의 CloudFront 원본 전환 절차, 분기 1회 읽기 연습이다.
4. **내부 gRPC 계약 규칙(추천 적용)**: 정상적인 업무 결과(거절, 입금 대기 등)는 응답의 결과 값(enum)으로 돌려주고, 처리하지 못했을 때만 gRPC 상태 코드를 쓴다(코드별 쓰는 때와 부르는 쪽이 할 일은 docs/api/proto/README.md §2). 부르는 쪽은 남은 데드라인을 넘기고, 앱 코드는 재시도하지 않으며, 상태를 바꾸는 호출은 멱등 키로 같은 결과를 돌려준다.
5. **Avro 규칙(추천 적용)**:
   - 타입: 시각은 `long`+`timestamp-millis`, 날짜는 `int`+`date`, UUID는 `string`+`uuid`, 정수는 `long`이다. 열거 이름은 `<레코드><필드>`다. asyncapi `required` 밖의 필드는 null을 첫 갈래로 둔 유니온과 기본값 null이다.
   - 등록: 주제 이름은 모든 토픽에 TopicRecordNameStrategy를 쓴다. 생산자는 `auto.register.schemas=false`로 스스로 등록하지 않고, 계약 패키지를 게시할 때 같은 워크플로가 등록한다.
   - 전송: Outbox `payload` 열은 `bytea`이고 Debezium은 `BinaryDataConverter`로 바이트를 그대로 보낸다(docs/data.md에 적었다). Kafka 키는 UTF-8 문자열이고, 추적 정보는 레코드 헤더로 보낸다.
   - 행동 신호: `BehaviorSignal.features`는 브라우저가 낸 요약값(openapi BehaviorSummary와 같은 필드)만 싣고, 헤더 순서 같은 서버 쪽 특징은 trust-svc 실시간 판정에만 쓴다(asyncapi 설명을 맞췄다).
   - Flink: 레코드가 여러 종류 실리는 토픽은 유니온 읽기 스키마나 레코드 이름별 분기로 읽는다. 어느 쪽인지는 wbs 0.2.2에서 정한다(docs/streaming.md §2.6에 적었다).
6. **기존 문서를 정본 쪽으로 맞춘다**:
   - 운영 감사 로그는 영구 보존과 법정 최소(2년·3년 이상)를 함께 적었다(docs/observability.md §9).
   - 셔플 결과 파일은 admission-ctrl 리더가 게시한다(docs/architecture.md §3.1을 §9.4와 queue-admission §2에 맞춤).
   - 그 밖에 'ADR 84건', 'OpenAPI 3.1', 법률 확인 필요 12건의 경위, 메시 인증서 문장(ADR-0082), prototype/ 폴더가 지워졌다는 사실을 고쳤다.
7. **기존 문서를 보강한다**:
   - docs/architecture.md: §3.2 통신 표에 관제 서비스 → 결제·구매·코어, 코어 → 결제 경로를 더했다. C4 1단계 그림에 알림 발송·외부 감시·상태 페이지·OpenTimestamps를 더했다. C4 2단계 그림에는 파트너·운영자·현장 스태프 경로, 게이트웨이 뒤 연결, trust-svc 연결, 서비스 → Kafka 선, 데이터 저장소 묶음을 더했다. Mermaid C4의 자동 배치가 그림마다 달라지지 않게 배치 설정 줄(`UpdateLayoutConfig`)을 넣었다.
   - docs/infra.md: §2 그림에 CloudFront를 거치지 않는 스캐너 경로를 더했다.
   - docs/observability.md: §9 보존 표에 Kafka·감사 기록·WAF 로그·백업 행을 더했다.
   - 독자 줄 17개를 넣었다.

## 검토한 대안

| 대안 | 판단 |
| --- | --- |
| 기존 문서를 먼저 고친다 | 다듬기 작업과 같은 파일을 동시에 고치게 되어 기각했다. 새 문서부터 만들었다 |
| 문서를 arc42 순서로 다시 나눈다 | 절 참조 약 3,800곳과 문서 지도가 깨지고, 받는 사람별 읽기 순서(00-summary §2)와도 겹쳐 기각했다. 대응표 문서 하나(docs/arc42.md)만 둔다 |
| 계약 파일을 바로 `peaket-contracts`에 둔다 | 그 저장소는 아직 없다(wbs 0.1.1). 문서 저장소에 초안을 두고 wbs 0.2.2에서 옮긴다 |
| Avro 주제 이름을 TopicNameStrategy와 토픽별 유니온으로 | 여러 레코드가 실리는 토픽 4개에서 생산자가 유니온의 최신 판으로 직렬화하도록 설정해야 하고, Flink의 클래스 하나로 읽기와도 맞지 않아 기각했다 |
| Avro 주제 이름을 RecordNameStrategy로 | 토픽과 상관없이 레코드 이름 하나로 묶여, 어느 토픽에 어떤 레코드를 실을 수 있는지를 등록으로 정할 수 없어 기각했다 |
| Outbox payload를 jsonb로 두고 Debezium이 Avro로 바꾼다 | 커넥터가 JSON에서 스키마를 추론해 계약 스키마와 다른 스키마가 등록되므로 기각했다 |
| 경영진 요약을 planning/01에 넣는다 | 독자(면접관·협업 엔지니어)와 분량이 달라 따로 둔다 |

## 결과와 트레이드오프

- **좋은 점**
  - 경영진, 인프라·관제팀, 개발자가 먼저 읽을 문서가 생겼다.
  - 계약을 기계로 검사할 수 있다(protoc 컴파일, Avro 파서와 asyncapi 대조).
  - 문서 이력이 Git에 남는다.
- **남는 한계**
  - 사양값은 측정 전 추정이다.
  - proto와 Avro는 buf와 Schema Registry로 아직 검사하지 않았다(wbs 0.2.2).
  - 인수 문서의 절차는 운영 환경을 띄우지 않으므로 실제 훈련으로 검증하지 못한다(ADR-0057).
  - Mermaid C4 2단계 그림은 선이 많아 복잡하고, 배치 설정 줄에 기댄다.
  - 새 문서와 기존 문서 사이의 숫자는 사람이 맞춰야 한다. 문서 검사 도구는 경로·ID·절만 본다.
- **반영 수치(2026-10-22)**: ADR 83 → 84, 검토 기록 R-95, 질문 44. WBS 일정은 그대로다.

## 되돌릴 조건

- 문서 공개 범위를 정하면서 인수 문서를 내부 저장소로 옮기기로 하면 경로를 바꾸고 이 ADR의 상태 줄에 적는다.
- wbs 0.2.2의 buf·Schema Registry 검사에서 이 규칙(주제 이름 전략, 자동 등록 끔 등)이 맞지 않으면 새 ADR로 바꾼다.
- 측정(wbs 2.12.1·4.8.1)에서 사양이 틀리면 인수 문서의 값을 고친다. 이 ADR은 사양값을 정본으로 두지 않는다.

## 소유자 검토 대상(추천 적용)

- 인스턴스 종류와 크기, 가용성 등급 넷, 키 끄기·삭제 권한(두 사람, 30일 대기), 도쿄 전환 준비물
- gRPC 상태 코드와 데드라인·재시도 규칙
- Avro: TopicRecordNameStrategy, 생산자 자동 등록 끔, Outbox `bytea`, 행동 신호에 헤더 특징을 싣지 않음
- 소유자가 정할 일(00-summary §7 질문 44): 문서 공개 범위, Avro 필수 필드(첫 등록 전에 정해야 한다), 데이터센터 구역 하나를 통째로 멈추는 장애 연습, prototype/ 폴더가 지워진 뒤의 시연 녹화(wbs 0.10.4)
