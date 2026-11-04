# 스트림 처리 설계: 관제 실시간 표, 봇 대기 중 재평가, 원본 적재

- **독자와 용도**: 데이터 엔지니어링·봇 탐지·플랫폼 담당자가 스트림 작업자 넷(`analytics-ingest`, `ops-rt`, `trust-reassess`, `inv-ingest`)과 관제 실시간 표의 조회 시점 집계를 만들고 운영할 때 읽는 기준 문서다. 스트림 작업자는 Kafka 토픽을 계속 읽어 ClickHouse·Redis·Kafka에 쓰는 작은 TypeScript 서비스다. 조회 시점 집계는 원본 사건을 그대로 두고, 읽을 때마다 SQL로 중복을 지우고 세는 방식이다. 원본 적재의 표와 마감은 [features/analytics.md](features/analytics.md), 봇 판정은 [features/queue-admission.md](features/queue-admission.md) §7, 관제 화면은 [features/control-tower.md](features/control-tower.md), 경보와 지표 출처 표는 [observability.md](observability.md) §5·§8에서 다룬다.
- **원본 출처**: 설계서의 스트림 처리 서술(Flink의 1초·10초 창, 세션 윈도우·CEP)은 한두 줄이었다. 2026-10-20에 Flink 잡 셋으로 자세히 정했고([ADR-0071](adr/0071-flink-design-verification-rt-upsert-heartbeat-bot-reassess.md)·[ADR-0072](adr/0072-flink-detailed-design-operators-config-capacity-operations.md)), 2026-10-27에 Flink를 빼고 이 문서를 다시 썼다([ADR-0099](adr/0099-drop-flink-typescript-stream-workers-read-time-aggregation.md)). Flink로 짠 설계는 두 ADR과 git 이력(develop d10c955까지의 이 문서)에 있다.
- **기준 기획 버전**: v1.0. 작성 2026-10-20, 다시 씀 2026-10-27.
- **표시 규칙**: 방향은 소유자 결정이다(2026-10-27, "B안으로 정하고 다른 대안들에 대한 트레이드오프도 표로 정리해주세요.", ADR-0099). 작업자 설정·표 모양·뷰·시험은 추천 적용(2026-10-27)이다. ADR-0071에서 이어받은 규칙은 2026-10-20 소유자 승인이다. 지표 출처 표, 심장 박동과 끝에서 끝까지 신선도, 봇 판정의 A안·패턴 숫자·격리 상한·그림자 기본, 판매 좌석 상태 규칙, 텔레메트리 키가 여기에 든다. 측정으로 정할 값은 [가정, … 확정], 계산한 어림값은 [추정]으로 적는다. 외부 제품 사실은 2026-10-27에 원문으로 확인했고, 출처는 §17에 있다.

## 1. 작업자 목록

| 작업자 | 폴더(`peaket`) | 하는 일 | 입력 | 상태 | 출력 | 전달 보장 | 자원 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `analytics-ingest` | `services/analytics-ingest` | 원본 적재, 회차별 가명, 금지 필드 제거(analytics §3) | analytics §3.1의 토픽(메시지를 종류별로 모아 두는 통로) 10개. 거래·제어 클러스터 7개와, 시스템이 내보내는 운영 신호인 텔레메트리 클러스터 3개다 | 없다(회차 키 캐시는 메모리) | 브론즈, 적재 거절 기록 | 적어도 한 번. 중복은 실버가 지우고, 빠짐은 커버리지 대조(§6)가 잡는다 | Spot(싸지만 회수될 수 있는 클라우드 서버) 허용 |
| `ops-rt` | `services/ops-rt` | 관제 실시간 표의 원시 사건 적재(§4). 집계하지 않는다 | 거래·제어 클러스터의 `trade.orders`·`trade.payments`·`trade.seats`(`SeatEvent`만. 같은 토픽의 회차 판매 상태 `EventSaleChanged`는 건너뛴다, ADR-0122)·`trade.tickets`, 텔레메트리 클러스터의 `telemetry.queue`(`QueueAggregate`·`PipelinePulse`)·`telemetry.purchase`·`telemetry.trust-verdicts` | 없다 | `rt` 원시 표 다섯(§4.3) | 적어도 한 번. 중복은 조회 시점 집계가 `eventKey`로 지운다 | 온디맨드(정가로 계속 쓰는 서버) |
| `trust-reassess` | `services/trust-reassess` | 봇 대기 중 재평가와 행동 신호 원시 적재(§5) | 텔레메트리 클러스터의 `telemetry.behavior` | 세션·캐시 Redis의 정렬 집합(10분) | `telemetry.trust-candidates`, 행동 신호 원시 표(30일) | 적어도 한 번. 후보는 `eventKey`로 중복 제거 | 온디맨드 |
| `inv-ingest` | `services/inv-ingest` | 부정 예매 사후 조사의 원천 적재(조사 갈래, §6.4, 추천 적용 2026-10-31, ADR-0171). 가명 처리를 하지 않고 실명 계정·원문 IP를 그대로 싣는다 | 텔레메트리 클러스터의 `investigation.requests`(JSON)·`telemetry.queue`(`QueueEntryRecord`)·`telemetry.purchase`·`telemetry.trust-verdicts`·`telemetry.behavior`, 거래·제어 클러스터의 `trade.purchase-sessions`·`trade.orders`·`trade.payments`·`trade.seats`(`SeatEvent`)·`trade.tickets` | 없다(계정 연결 값 묻기의 짧은 중복 캐시만 메모리) | ClickHouse 조사 저장소 `inv` 표 넷(docs/data.md '부정 예매 사후 조사의 표') | 적어도 한 번. 중복은 표 엔진이 키로 지운다 | 온디맨드 |

- `rt-pulse`(`services/rt-pulse`)는 1초마다 §3의 토픽 셋의 모든 파티션(토픽을 나눈 칸)에 `PipelinePulse`를 쓰는 작은 Deployment(복제 1개 [가정])다. 이것이 멈추면 신선도가 나빠진 것으로 보이므로 따로 감시하지 않는다.
- 작업자는 서비스와 같은 Node.js·NestJS 판의 독립 실행 앱이다. HTTP는 상태 확인과 지표에만 연다.
- 네 작업자는 상태를 서로 나눠 쓰지 않는다(2026-10-31에 `inv-ingest`를 더했다). 한 작업자가 멈춰도 다른 작업자와 거래 경로(Outbox, Saga)는 영향을 받지 않는다. Outbox는 보낼 이벤트를 같은 트랜잭션으로 표에 적어 두었다가 나중에 보내는 방식이다. Saga는 여러 서비스에 걸친 일을 단계별로 처리하고, 중간에 실패하면 앞 단계를 되돌리는 방식이다.
- Kafka(이벤트를 순서대로 쌓아 두고 여러 곳에 나눠 주는 메시지 시스템)는 MSK(클라우드 업체가 운영해 주는 관리형 서비스) 클러스터 두 개(거래·제어, 텔레메트리)다. 관측 전용 세 번째 MSK 클러스터(Tempo 쓰기 경로, ADR-0077)는 작업자가 쓰지 않는다(infra §1).
- Flink(흘러드는 이벤트를 실시간으로 계산하는 스트림 처리 엔진)는 쓰지 않는다. 고른 이유와 대안, 다시 볼 조건은 §16에 있다.

## 2. 공용 소비 규칙과 실행 기반

### 2.1 클라이언트와 라이브러리(2026-10-27 확인)

| 구성요소 | 판·산출물 | 이유 |
| --- | --- | --- |
| 공용 소비 모듈 | 공용 서버 패키지 `packages/platform`의 `@peaket/stream-worker`(하위 내보내기 `@peaket/platform/stream-worker`. Kafka 클라이언트를 쓰는 부분만 두어 네이티브 모듈을 Kafka를 쓰는 코드만 싣는다. 키 단위 처리·보류 표·제어 동기화·정비 함수는 `@peaket/platform`에 있다, 추천 적용 2026-11-01, openspec 변경 add-maintenance-control-and-consumers) | 커밋 순서, 묶음, 중복 거르기 표시, 다시 시도, 거절 기록, 지표를 한 곳에 둔다. 서비스의 Kafka 소비자도 같은 모듈을 쓴다. 스트림 작업자의 묶음 규칙(쓰기 뒤 커밋·파티션별 묶음·중복 토큰)은 OPS-150(wbs 4.3.1)에서 더한다 |
| Kafka 클라이언트 | Confluent 공식 JavaScript 클라이언트 `@confluentinc/kafka-javascript`(1.11.0, librdkafka 기반, KafkaJS 호환 API)가 기본이다. kafkajs는 대체안이다(추천 적용 2026-10-28, 기술 검토 낮음-152) | 서비스와 같은 클라이언트를 쓴다. 기본 클라이언트가 처리량·협력적 재조정·OTel 계측·MSK IAM을 채우는지는 wbs 0.5.1 PoC(본 개발 전에 위험한 부분만 먼저 만들어 확인하는 시험)에서 확인하고, 못 채우면 kafkajs와 견준다(docs/architecture.md §9.4). 2026-11-01 PoC에서 확정했다(ADR-0176 결정 5): 텔레메트리 5,600/s와 거래 300/s를 함께 넣어 거래 `acks=all` p99 7.8·7.9·7.8ms, 협력적 재조정·강제 종료에서 빠짐 0(ST-T18), MSK IAM 토큰 함수(ST-T14 ①). 재인증(ST-T14 ②)만 실제 MSK에서 남았다 |
| Schema Registry와 Avro | `@confluentinc/schemaregistry`(1.11.0) | Schema Registry는 Confluent다(api/guidelines) |
| MSK IAM 인증 | `aws-msk-iam-sasl-signer-js`(1.0.3)의 `generateAuthTokenFromRole`로 OAUTHBEARER 토큰을 만든다. 작업자별 MSK 전용 역할을 고정 세션 이름으로 맡는다(§2.3·§2.6) | MSK IAM 인증(wbs 2.11.2). EKS Pod Identity(쿠버네티스 파드에 AWS 권한을 주는 기능) 자격을 그대로 쓰면 자격이 갱신될 때 세션 이름이 바뀌어 재인증(연결을 유지한 채 새 토큰으로 다시 인증하는 것)이 끊긴다(자바 aws-msk-iam-auth README의 문제 해결 절). 그래서 기본 자격 사슬(환경 변수·파드 권한 같은 자격을 정해진 순서로 찾는 방식)로 토큰을 만드는 `generateAuthToken`은 운영 환경에서 쓰지 않는다(추천 적용 2026-10-28, 기술 검토 높음-26). JavaScript 서명 도구 저장소에도 같은 실패가 보고됐다(기본 자격 사슬에서 세션 이름이 바뀌어 'Cannot change principals during re-authentication', 이슈 #19·#27). 1.0.1부터 기본 자격 사슬도 세션 이름을 고정하지만(PR #29), 그 설정은 웹 ID 토큰 방식(IRSA, AWS SDK `fromTokenFile`)만 쓰고 Pod Identity가 쓰는 컨테이너 자격(`fromHttp`)은 세션 이름을 받지 않는다(AWS SDK 소스). `generateAuthTokenFromRole`은 준 세션 이름(안 주면 `MSKSASLDefaultSession`)으로 역할을 맡으므로 재인증 때 주체가 같다(서명 도구 1.0.3 소스, 2026-10-29 확인, https://github.com/aws/aws-msk-iam-sasl-signer-js/issues/27 ). 실제 MSK에서 자격 갱신 주기를 넘겨 계속 소비되는지는 확인 필요다(wbs 0.5.1 PoC, ST-T14. 실제 MSK·EKS 확인은 선택 클라우드 보정에서 한다, docs/verification.md §6, ADR-0154) |
| ClickHouse 클라이언트 | `@clickhouse/client`(1.24.1, 공식 Node 클라이언트) | HTTPS 삽입·조회와 서버 설정 전달 |
| ClickHouse 서버 | 26.8 LTS(2026-08-27, 1년 지원) | ClickHouse는 대량 이벤트 집계에 강한 분석용 데이터베이스다. `EXPLAIN ANALYZE`(26.7)가 있고, 내림차순 정렬 키 상시 지원과 가상 스킵 인덱스(26.6)가 있다. 26.3 LTS와 다른 기본값은 둘이다. ① 삽입 중복 판정의 단위: 26.6부터 삽입 한 건 단위다(서버 설정 `insert_deduplication_version`의 기본값이 `new_unified_hash`로 바뀌었고, 26.7부터는 이 방식만 남았다). 같은 삽입을 다시 보내면 거르지만, 서로 다른 삽입이 같은 파트를 만들어도 지우지 않는다. 그래서 묶음 경계가 달라진 중복은 여전히 실버와 조회 시점 집계가 지운다(§2.4). ② 25GiB 이하 표의 INSERT 때 열 통계(26.8). 모든 삽입의 중복 판정 기본 켬(`deduplicate_insert='enable'`, 비동기 삽입 포함, 26.2)과 비동기 삽입 기본 켬은 26.3 LTS에도 있다(ClickHouse CHANGELOG 26.2·26.6·26.7, v26.3.9.8-lts·v26.8.9.10-lts의 `Settings.cpp`·`ServerSettings.cpp`, 2026-10-28 확인, 기술 검토 중간-091). 다음 LTS로 옮길 때 §4.4 설정 표를 다시 맞춘다(추천 적용 2026-10-22, ADR-0086) |

- 판은 Renovate가 올리고, 공통 조치 기한(POL-041, asvs/analytics 15.1.1)을 따른다. 서비스와 같은 pnpm 잠금 파일과 레지스트리 고정 규칙(devops §4.4)을 쓴다.

### 2.2 배포

- 작업자마다 Deployment를 하나씩 두고 복제는 2개다 [가정]. PodDisruptionBudget(자발적 중단 때 남길 최소 파드 수)은 1이다. 두 파드는 같은 소비자 그룹에서 파티션을 나눠 읽고, 한 파드가 죽으면 남은 파드가 재조정으로 그 파티션을 넘겨받는다. 재조정은 소비자 그룹 안에서 파티션을 다시 나누는 일이다.
- 판 올리기는 롤링이다(새 파드 1개를 먼저 띄우고, 옛 파드를 하나씩 멈춘다). 옛 파드는 우아한 종료를 한다. 새로 가져오기를 멈추고, 처리 중인 묶음을 마쳐 커밋한 뒤 그룹에서 나간다. 종료 유예는 30초 [가정]이고, NestJS 종료 설정은 devops §6.4를 따른다.
- 자동 확장은 켜지 않고 복제 수를 고정한다. 소비자 수는 파티션 수를 넘어도 늘지 않고, 늘리고 줄일 때마다 재조정이 일어나기 때문이다. 복제 수를 바꿀 때는 업그레이드와 같은 규칙(동결 창·마감 실행 중 금지, POL-028)을 따른다.
- 네임스페이스는 `ops-rt`·`analytics-ingest`가 `data`, `trust-reassess`가 `trust`이다. 매니페스트는 서비스와 같은 공용 차트(§13)가 만든다.

### 2.3 권한·네트워크

- 작업자에 들어오는 연결은 지표 수집(Prometheus)과 상태 확인뿐이다. 관리 API는 없다. Prometheus는 지표를 모아 저장하는 도구다.
- 쿠버네티스 서비스 계정은 작업자마다 하나씩 두고, 쿠버네티스 API 권한은 주지 않는다. AWS 권한은 Pod Identity 역할로 작업자마다 나눈다. 쿠버네티스는 컨테이너로 만든 앱을 여러 서버에서 실행하고 관리하는 플랫폼이다.
- MSK 권한은 두 단계로 준다(추천 적용 2026-10-28, 기술 검토 높음-26, 규칙은 docs/devops.md §9.4). 작업자의 Pod Identity 역할 → 작업자별 MSK 전용 역할(`sts:AssumeRole`) → 아래 표의 토픽·소비자 그룹 권한 순이다. Pod Identity 역할에는 아래 표의 S3·KMS 칸 권한(지금은 `analytics-ingest`의 `kms:GenerateMac`뿐)과 그 MSK 전용 역할을 맡는 권한만 있고 MSK 권한은 없다. MSK 전용 역할의 신뢰 정책은 그 작업자의 Pod Identity 역할만 믿는다. Pod Identity 자격을 그대로 쓰지 않는 이유는 자격이 갱신될 때 STS(임시 자격을 내주는 AWS 서비스) 세션 이름이 바뀌어, MSK가 재인증 때 '주체가 바뀌었다'며 연결을 끊기 때문이다(aws-msk-iam-auth README, 2026-10-28 확인).

| 작업자 | S3·KMS | MSK(IAM, 작업자별 MSK 전용 역할) | 저장소 사용자 |
| --- | --- | --- | --- |
| `ops-rt` | 없다 | 거래·제어 4개 토픽과 텔레메트리 3개 토픽 읽기, 자기 소비자 그룹 | ClickHouse `rt_writer`(`rt` 원시 표 쓰기만) |
| `analytics-ingest` | 분석 가명 키 `kms:GenerateMac`(S3 권한은 없다. 수집 버킷 파일은 마감 실행기가 싣는다, §6.1) | 10개 토픽 읽기 | ClickHouse `bronze_writer` |
| `trust-reassess` | 없다 | `telemetry.behavior` 읽기, `telemetry.trust-candidates` 쓰기 | ClickHouse `trust_raw_writer`, 세션·캐시 Redis 사용자(재평가 키 접두사 `tr:ra:`만, RBAC) |
| `inv-ingest` | ASN 분류표 S3 읽기(trust-svc가 만드는 판, docs/features/bot-defense.md §3.1) | 거래·제어 5개 토픽과 텔레메트리 5개 토픽(`investigation.requests` 포함) 읽기, 자기 소비자 그룹. `investigation.requests`의 읽기 권한은 이 작업자만 가진다 | ClickHouse `inv_ingest`(`inv` 표에 넣기만), identity-svc `BatchGetInvestigationRefs` 호출(메시 신원 허용 목록, docs/api/proto/README.md §2) |

- 작업자 파드도 서비스 메시(서비스끼리 주고받는 통신을 앱 대신 처리하는 층)의 앰비언트 L4 경로에 넣어 전송을 암호화한다(docs/architecture.md 보안 기본 규칙의 '전송 구간 암호화 강제', ADR-0082). 포트폴리오의 로컬 실행은 메시 없이 돈다.
- 비밀 값(ClickHouse 사용자, Schema Registry 자격, Redis 사용자)은 Secrets Manager에 두고, External Secrets Operator가 파드에 넣는다(ADR-0053). 파드는 시작할 때 읽은 값을 끝까지 쓰므로, 30일 자동 교체는 다른 서비스 파드와 같은 규칙을 따른다: ClickHouse·Schema Registry는 교대 사용자 전략이라 옛 판도 다음 교체까지 유효하고, 교체 사이에 작업자 파드가 한 번 이상 다시 뜨게 한다(docs/devops.md §8.3 '저장소 비밀 교체', 추천 적용 2026-10-28, 기술 검토 중간-064). Redis 사용자는 비밀번호 두 개를 겹쳐 둔다.
- 파드는 Pod Security Standards의 Restricted 기준(devops §4.3)을 맞추고, 읽기 전용 루트 파일 시스템으로 돈다. 작업자는 디스크에 쓰지 않는다.

네트워크 정책(작업자마다):

| 방향 | 상대 | 쓰임 |
| --- | --- | --- |
| 들어옴 | 관측(지표·로그·요청 기록으로 시스템 안을 들여다보는 일) 네임스페이스의 Prometheus → 지표 포트 | 지표 수집 |
| 나감 | MSK 두 클러스터(IAM 인증), Schema Registry | 소비·생산, 스키마(데이터의 구조 정의) 조회 |
| 나감 | ClickHouse(HTTPS) | 삽입 |
| 나감 | 세션·캐시 Redis(TLS, `trust-reassess`만) | 재평가 |
| 나감 | KMS·STS(내부망에서 이 서비스들을 부르는 주소인 VPC 엔드포인트, KMS는 `analytics-ingest`만), DNS | 가명 키, 자격 증명 |
| 나감 | identity-svc gRPC(`inv-ingest`만), S3 VPC 엔드포인트(`inv-ingest`의 ASN 분류표만) | 계정 연결 값, 망 유형 분류(추천 적용 2026-10-31, ADR-0171) |

### 2.4 커밋·묶음·다시 시도

| 설정 | `ops-rt` | `analytics-ingest` | `trust-reassess` | 이유 |
| --- | --- | --- | --- | --- |
| 자동 커밋 | 끔 | 끔 | 끔 | 쓰기가 성공했다는 답을 받은 뒤에만 오프셋(메시지를 어디까지 읽었는지 나타내는 위치 번호)을 커밋한다. 그래서 작업자가 죽어도 빠지는 것이 없다 |
| 묶음 | 2,000건 또는 0.25초 [가정] | 10,000건 또는 1초 [가정] | 원시 적재는 10,000건 또는 1초, 재평가는 메시지마다 [가정] | 묶음이 작거나 너무 자주 보내면 ClickHouse 병합이 밀려 삽입이 느려진다 |
| 중복 거르기 표시 | `insert_deduplication_token` = 토픽·파티션·첫 오프셋·끝 오프셋 | 같다 | 원시 적재에만 | 같은 묶음을 다시 보내면 ClickHouse가 거른다 |
| 다시 시도 | 버리지 않는다. 0.2초에서 최대 30초까지 지수 지연 [가정], 그동안 그 파티션 소비를 멈춘다 | 같다 | 같다 | 누락 대신 신선도가 나빠진다. 회복하면 밀린 것을 이어 싣는다 |
| 동시 묶음 | 파티션마다 1개, 작업자 전체 4개 [가정] | 같다 | 같다 | 파티션 안의 순서를 지키고, 넘으면 새로 가져오기를 멈춘다(백프레셔, 받는 쪽이 밀리면 보내는 쪽을 늦추게 하는 장치) |

- 커밋은 파티션마다, 그 파티션의 앞선 묶음이 모두 성공했을 때 '끝 오프셋 + 1'로 한다.
- 재시작 뒤 묶음 경계가 달라지면 같은 사건이 다른 묶음으로 다시 들어갈 수 있다. 이 중복은 실버(브론즈)와 조회 시점 집계(`rt`)가 `eventKey`로 지운다. 모든 소비자는 중복을 전제한다(ADR-0026 결정 3).
- 읽지 못한 레코드(역직렬화 실패, 레지스트리가 모른다고 답한 스키마 ID, 필수 필드 없음)는 원문을 복사하지 않고 위치만 남긴다. 레지스트리에 닿지 않아 처음 보는 ID를 읽지 못한 것은 읽지 못한 레코드가 아니라 다시 시도할 장애로 보고, 그 파티션 소비를 멈춘다(§2.6, 추천 적용 2026-10-28, 기술 검토 중간-088). 모르는 열거 기호는 읽지 못한 레코드가 아니다(§2.6). 원본 적재는 `bronze.brz_rejected`(§6.3)에, 나머지 둘은 거절 수(`stream_rejected_total`)와 위치 로그에 남긴다. 데드 레터 토픽(처리에 실패한 메시지를 옮겨 두는 토픽)은 두지 않는다. 가명 처리 전 식별값이 다른 토픽에 한 벌 더 생기기 때문이다(ADR-0072 결정 7). 서비스 소비자도 같은 이유로 두지 않는다(아래 '서비스 소비자의 규칙', ADR-0142).
- 재조정과 종료 때는 처리 중인 묶음을 마치고 커밋한 뒤 파티션을 넘긴다. 마치지 못한 묶음은 커밋하지 않는다.
- 작업자에는 체크포인트·세이브포인트 같은 상태 저장본이 없다. 다시 뜨면 커밋한 위치부터 읽는다.
- **서비스 소비자의 규칙(추천 적용 2026-10-29, ADR-0142)**: 같은 공용 소비 모듈을 쓰는 서비스 소비자는 위 표의 '파티션마다 묶음 하나' 대신 키 단위 동시 처리를 쓴다. 파티션 안에서 업무 키(주문 ID 등) 단위로 동시에 처리하고, 앞 사건이 모두 끝난 위치까지만 커밋한다(ADR-0142). 회차 키(§7) 때문에 인기 회차의 사건이 파티션 하나에 몰려도, 그 파티션을 맡은 소비자 하나가 사건을 하나씩 차례로 처리하느라 밀리지 않게 하려는 것이다.
  - 가져온 사건을 업무 키로 나눈다. 같은 키는 순서대로, 다른 키는 동시에 처리한다. 파티션마다 동시에 처리하는 키는 32개 [가정]이다.
  - 업무 키는 소비자마다 정한다. purchase-svc 주문 Saga(`trade.payments`)는 주문 ID, purchase-svc 홀드 원장 적재(`trade.seats`)는 `회차 ID:좌석 ID`(좌석 ID는 공연장 좌석이라 회차를 붙인다, 추천 적용 2026-11-04, BUILD_ORDER PRF-141), core-svc 알림(`trade.orders`)은 주문 ID다.
  - 재조정 때는 처리 중인 키를 마치고 그 위치를 커밋한 뒤 파티션을 넘긴다. 다시 받은 사건은 `eventKey`로 거른다.
  - 보류 사건: 처리 못 하는 사건은 Kafka 데드 레터 토픽이 아니라 그 서비스 DB의 보류 표 `held_event`로 옮기고, 같은 업무 키의 뒤 사건도 함께 보류한다(ADR-0142). 대상은 다시 해도 같은 결과일 실패(검증 실패, 상태 전이 불가, 코드 예외)를 5회 [가정] 겪은 사건이다. 표에는 토픽·파티션·오프셋·`eventKey`·업무 키·오류 요약과 사건 값이 든다. 다른 키는 계속 처리한다.
  - 저장소 연결 실패·시간 초과는 보류하지 않는다. 스트림 작업자처럼 그 파티션을 멈춰 기다린다.
  - 보류가 1건 이상이면 결제·주문 토픽은 SEV2, 그 밖은 SEV3이다(docs/observability.md §5). 원인을 고친 뒤 RB-11 '보류 사건 다시 처리'로 다시 넣는다. 보류 행은 다시 처리한 뒤 7일 [가정]에 지운다(Kafka 보존과 같다).
  - 스트림 작업자 넷은 묶음으로 쓰므로 지금 규칙(파티션마다 묶음 하나, 읽지 못한 레코드는 위치만 남김)을 그대로 쓴다.
  - 시험은 ST-T18(키 단위 동시 처리)과 ST-T19(보류 사건)이다(§10).
  - 구현(추천 적용 2026-11-01, openspec 변경 add-maintenance-control-and-consumers): 실행기는 파티션 넷 [가정]을 함께 받아 업무 키 줄에 넘기고, 1초 [가정]마다와 재조정·종료 때 앞 사건이 모두 끝난 위치를 커밋한다. 같은 결과일 실패는 0.2·0.4·0.8·1.6초 [가정] 쉬며 모두 5회 해 보고, 일시 실패(연결 오류 코드, PostgreSQL 08xxx·57P01~03·57014·55P03·53300·40001·40P01, node-postgres가 코드 없이 던지는 연결 끊김·시간 초과 글, 풀 대기 초과 429·503 Problem, 공용 일시 오류 표시)는 0.2~30초 [가정] 늘려 쉬며 그 파티션 가져오기를 멈춘다. 받기 처리기 안에서는 오래 기다리지 않는다: 파티션을 받은 뒤 보류 키 읽기(5초 [가정] 한도)나 값 읽기가 일시 실패면 그 파티션을 멈추고 그 사건부터 다시 받으며, 이미 받은 오프셋이 다시 오면 버린다. 보류 행과 로그의 오류 요약에는 쿼리 매개변수 값을 남기지 않는다. 가져오기 멈춤은 파티션마다 멈춤 이유를 세어 모두 풀릴 때만 연다(클라이언트의 resume 한 번이 앞선 멈춤을 모두 풀기 때문이다). 넘기기·종료 때 처리 중인 키를 마치기는 30초 [가정]까지만 기다리고, 넘으면 끝난 위치까지만 커밋한다. librdkafka는 파티션을 내놓을 때 앱이 건 멈춤을 지우지 않으므로 배정받을 때마다 멈춤을 푼다. 받고 끝나지 않은 사건은 파티션마다 1,000건 [가정]까지다. 값을 읽지 못한 사건은 업무 키를 몰라 Kafka 키 그대로 보류한다. 일시 실패로 멈춘 동안에는 키 자리를 기다리지 않고 받고(쓰는 클라이언트는 받기 처리기가 모두 돌아와야 가져오기 멈춤을 적용한다), 다시 시작할 때 받은 가장 큰 오프셋 + 1로 맞춘다(멈춘 동안 버린 캐시를 건너뛰지 않게, 코드 리뷰 2026-11-01). 다시 받은 사건 거르기(`eventKey`)는 처리기가 자기 트랜잭션에서 한다. 처리기는 사건 머리의 추적을 잇는 소비 span(`process <토픽>`) 안에서 돈다(docs/observability.md §2).

### 2.5 자원

| 작업자 | 복제 | CPU·메모리(파드마다) | 노드 |
| --- | --- | --- | --- |
| `ops-rt` | 2 | 1 · 1GiB | 데이터 노드 풀, 온디맨드 |
| `analytics-ingest` | 2 | 1 · 1GiB | 데이터 노드 풀, Spot 허용 |
| `trust-reassess` | 2 | 0.5 · 512MiB | 일반 노드 풀, 온디맨드 |

- `inv-ingest`의 복제·자원·노드와 네임스페이스(§2.2), 소비자 그룹과 시작 위치(§2.6)는 아직 정하지 않았다(docs/review/open-items.md 98번, 2026-11-01 정합 점검).
- 숫자는 [가정, 4.3.9 측정에서 확정]이고, 근거는 §11에 있다. 자원 요청과 한도는 같은 값으로 둔다(쿠버네티스에 들어오는 설정을 규칙으로 검사하는 Kyverno가 둘 다 요구한다, devops §4.3).
- 합은 CPU 5개·메모리 5GiB다. Flink로 짠 설계(CPU 15.5개·메모리 31GiB)의 약 3분의 1이다 [가정].
- `ops-rt`·`trust-reassess`는 온디맨드로 둔다. Spot이 회수되면 관제 신선도와 재평가가 잠깐 끊기기 때문이다. `analytics-ingest`는 지연을 견디고, 빠진 것은 커버리지 대조(§6)가 찾으므로 Spot을 허용한다.

### 2.6 Kafka 연결

| 작업자 | 소스 | 소비자 그룹 | 커밋이 없을 때 시작 위치 |
| --- | --- | --- | --- |
| `ops-rt` | 거래·제어 클러스터 4개 토픽, 텔레메트리 클러스터 3개 토픽 | `peaket.ops-rt.<환경>` | 가장 이른 곳(EARLIEST). 누적은 원시 행이 다 있어야 맞는다. 보관 기간(7일)보다 오래된 판매류 사건은 브론즈에서 채운다(§4.7) |
| `analytics-ingest` | 거래·제어 7개, 텔레메트리 3개 | `peaket.analytics-ingest.<환경>` | EARLIEST(보관된 7일 치 전부) |
| `trust-reassess` | 텔레메트리 클러스터 `telemetry.behavior` | `peaket.trust-reassess.<환경>` | 가장 늦은 곳(LATEST). 상태가 10분이라 지난 사건이 필요 없다 |

- 인증은 MSK IAM이다. 클라이언트에 `security.protocol=SASL_SSL`, `sasl.mechanism=OAUTHBEARER`를 두고, 토큰 함수가 서명 도구(§2.1)로 토큰을 만든다.
- 토큰 함수는 `generateAuthTokenFromRole({ region: 'ap-northeast-2', awsRoleArn: <작업자별 MSK 전용 역할>, awsRoleSessionName: '<작업자>-<환경>' })`를 부른다(추천 적용 2026-10-28, 기술 검토 높음-26). 세션 이름이 바뀌지 않으므로 재인증 때 주체가 같다. 이 함수는 Pod Identity 자격으로 그 역할을 맡는다(AWS SDK `fromTemporaryCredentials`가 기본 자격 사슬로 STS를 부른다). 역할을 맡지 못하면 예외를 던져 연결이 실패하고, 기본 자격으로 넘어가 다른 신원으로 붙지 않는다(서명 도구 1.0.3과 AWS SDK 소스, 2026-10-28 확인). 그 실패는 소비 밀림 경보와 재시작 수로 드러난다(§9).
- 서비스(NestJS)의 Kafka 생산자·소비자도 같은 공용 모듈의 같은 토큰 함수를 쓴다. 역할과 세션 이름만 서비스별이다(docs/devops.md §9.4). 서비스별 Outbox 릴레이(`<서비스>-outbox-relay`)도 같은 함수를 쓰고, 세션 이름은 `<서비스>-outbox-relay-<환경>`이다(ADR-0116).
- 토큰 함수가 고정 세션 이름으로 역할을 맡는지, 역할을 못 맡을 때 실패하는지는 로컬에서 STS를 흉내 내어 확인한다. 2026-11-01에 확인했다(ST-T14 ①, `packages/platform` `test/msk-iam.test.ts`, openspec 변경 add-foundation-poc): 가짜 STS(`AWS_ENDPOINT_URL_STS`)에 두 번 부르면 두 번 모두 세션 이름이 `purchase-svc-prod`이고, 토큰은 파드 자격이 아니라 맡은 역할의 자격으로 서명되며, 역할 신뢰를 거두면(AccessDenied) 토큰을 만들지 않고 실패한다. 공용 설정 함수(`kafkaProducerConfig`·`kafkaConsumerConfig`)는 인증 `auth: { mechanism: 'msk-iam' }`을 받으면 KafkaJS 호환 묶음에 TLS와 OAUTHBEARER 토큰 함수를 싣고(클라이언트가 `security.protocol=sasl_ssl`을 만든다), 덧붙일 설정으로 보안 방식·SASL 이름을 바꾸지 못하게 한다(겉의 librdkafka 값이 호환 묶음을 이긴다, `KAFKA_AUTH_LOCKED`). 서비스와 Outbox 릴레이는 환경 값 `PEAKET_KAFKA_AUTH=msk-iam`·`PEAKET_KAFKA_MSK_ROLE_ARN`·`AWS_REGION`으로 고르고(`kafkaAuthFromEnv`), 값이 없으면 평문이다(로컬·CI). 토큰 만료 값은 '지금부터 몇 ms'가 아니라 만료 시각(epoch ms)이다(librdkafka `md_lifetime_ms`). 토큰 함수 실패를 따로 세는 지표는 두지 않는다: 연결이 되지 않아 소비 밀림·재시작 수로 드러난다. 자격 갱신 주기를 넘겨 재인증이 이어지는지는 실제 MSK와 EKS Pod Identity가 있어야 확인된다(ST-T14, wbs 0.5.1 PoC) [확인 필요]. 그 확인은 선택 클라우드 보정에서 작은 MSK·EKS를 9시간 [가정] 띄워 한다(docs/verification.md §6, 소유자 결정 2026-10-30, ADR-0154).
- 역직렬화는 `@confluentinc/schemaregistry`의 Avro 역직렬화기로 한다. 쓴 쪽 스키마(메시지에 실린 스키마 ID)로 읽은 뒤 레코드 이름으로 나눈다. 그래서 레코드가 여러 종류 실리는 토픽(`telemetry.queue`·`telemetry.purchase`·`telemetry.trust-verdicts`의 `PipelinePulse`)도 따로 읽기 스키마를 두지 않는다(docs/api/avro/README.md §3). 토픽·파티션·오프셋·Kafka 시각도 함께 넘긴다. 레지스트리가 잠시 멈춰도 이미 받은 스키마 ID는 캐시(자주 쓰는 값을 가까운 곳에 복사해 둔 것)에서 읽는다. 처음 보는 스키마 ID를 레지스트리에 닿지 못해 읽지 못하면(시간 초과·5xx) 그 파티션 소비를 멈추고 §2.4의 다시 시도 규칙으로 기다린다. 거절하지 않으므로 빠지는 레코드가 없고, 그동안 소비 밀림이 는다. 새로 뜬 파드는 캐시가 비어 있어 이 경우를 먼저 겪는다. 레지스트리가 그 ID를 모른다고 답할 때(404)만 거절 처리로 간다(ST-T16, 추천 적용 2026-10-28, 기술 검토 중간-088).
- 모르는 열거 기호: 쓴 쪽 스키마로 읽으면 Avro의 열거 기본값 맞추기를 거치지 않는다. 그래서 공용 소비 모듈이 작업자가 빌드된 계약 판의 기호 목록에 없는 값을 `UNRECOGNIZED`로 바꿔 넘기고 `stream_unrecognized_symbol_total{worker, topic, record, field}`로 센다. 레코드는 버리지 않는다. `ops-rt`는 그 사건을 '모르는 상태'로 싣고, 원본 적재는 원래 기호를 그대로 싣는다(브론즈는 원문 보관이다). 생산자가 새 기호를 소비자보다 먼저 내도(배포 순서 어김, 동결 창·마감 실행 중이라 작업자를 못 올린 때) 숫자가 조용히 빠지지 않고 경보로 보인다(docs/api/avro/README.md §3, ST-T15, 추천 적용 2026-10-28, 기술 검토 중간-087).
- 이벤트 시각은 Kafka 레코드 시각이 아니라 메시지 안의 시각(`second`·`occurredAt`·`producedAt`)이다.
- `client.id`는 `<작업자>-<환경>-<파드>`다. 소비 밀림(아직 읽지 않은 메시지 수)은 파티션마다 `stream_consumer_lag_records`로 본다(§14).
- `trust-reassess`의 Kafka 생산은 `acks=all`과 멱등 생산자(같은 메시지를 두 번 보내도 한 번만 남기는 생산자 설정)로 한다. 트랜잭션 생산자는 쓰지 않는다(ADR-0026 결정 3). 발행 확인을 받은 뒤에 입력 오프셋을 커밋한다.

**Kafka 클라이언트 필수 설정(추천 적용 2026-10-29, ADR-0142 결정 3)**: 공용 모듈이 아래 값으로 클라이언트를 만든다. 작업자·서비스·Outbox 릴레이가 이 값을 덮어쓰면 정적 검사 D-T45가 CI를 실패시킨다(docs/devops.md). 쓰는 클라이언트 `@confluentinc/kafka-javascript`(KafkaJS 호환 API)의 기본값은 멱등 생산 꺼짐, 동시에 보내는 요청 수 사실상 무제한, 모두 멈추는 재조정, 자동 커밋 켬이라 문서가 기대는 동작과 다르기 때문이다(저장소의 MIGRATION.md와 librdkafka CONFIGURATION.md, 2026-10-29 확인). 설정 함수(`kafkaProducerConfig`·`kafkaConsumerConfig`)는 필수 값을 librdkafka 이름으로 KafkaJS 호환 묶음 밖에 두고(겉의 값이 이긴다), 덧붙일 설정에 필수 이름이나 호환 별칭이 있으면 예외를 낸다. 정적 검사는 `tools/ci/check-kafka-settings.mjs`이고 `tools-check` 잡이 돈다(추천 적용 2026-11-01).

| 쪽 | 설정 | 값 | 이유 |
| --- | --- | --- | --- |
| 생산자 | `acks` | `all` | 복제본이 받은 뒤에만 보냈다고 본다 |
| 생산자 | 멱등 생산 | 켬 | 다시 보내도 한 번만 남고 보낸 순서가 지켜진다 |
| 생산자 | 동시에 보내는 요청 수 | 5 이하 | librdkafka가 멱등 생산에 요구하는 상한이다 |
| 생산자 | 파티셔너(키로 파티션을 고르는 규칙) | `murmur2_random` | 자바 클라이언트와 같은 파티션을 고른다. librdkafka 네이티브 설정의 기본(`consistent_random`, CRC32)과 섞이면 같은 회차가 다른 파티션으로 갈 수 있다 |
| 생산자 | 전달 상한(`message.timeout.ms`) | Outbox 릴레이 10초(docs/architecture.md §5의 'Kafka 보내기 상한'과 같다), 그 밖의 생산자 5초 [가정] | 브로커가 멈췄을 때 기다리는 끝을 정한다 |
| 생산자(텔레메트리) | 버퍼가 찼을 때 | 새 사건을 버리고 `telemetry_dropped_total{record}`로 센다(ADR-0141 결정 6) | 요청 처리를 막지 않는다. 버린 수는 누락률(§4.5)과 분석 커버리지에 들어간다 |
| 생산자(텔레메트리) | 필수 칸이 비어 Avro로 만들지 못할 때 | 버퍼가 찼을 때와 같이 버리고 같은 지표로 센다. 오류 기록에는 레코드와 칸 이름만 남긴다(소유자 결정 2026-10-29, ADR-0150 결정 5) | 요청 처리를 막지 않는다. 한 종류가 계속 실패하면 누락률 경보로 보인다. 거래 사건(Outbox)은 사건을 만드는 일이 업무 트랜잭션 안에 있어 그 트랜잭션이 함께 실패한다 |
| 소비자 | 자동 커밋 | 끔 | 처리를 마친 뒤에만 커밋한다(§2.4) |
| 소비자 | 재조정 | 협력적 방식(`cooperative-sticky`) | 파드 하나가 바뀔 때 그룹 전체가 멈추지 않는다. KafkaJS 호환 설정 묶음(`kafkaJS`)은 재조정 방식을 주지 않으면 round-robin(그룹 전체가 멈추는 방식)을 넣으므로 직접 넣는다(v1.11.0 소스 `lib/kafkajs/_consumer.js`, 2026-10-30 확인). 로컬 확인 2026-10-30(ST-T20): Kafka 3.9.2 브로커와 `@confluentinc/kafka-javascript` 1.11.0(librdkafka 2.16.0)로 재 보니, 값을 주지 않은 그룹은 브로커에 `roundrobin`으로 보였고 둘째 소비자가 들어올 때 첫째가 파티션 6개를 모두 내놓았다. 직접 넣은 그룹은 `cooperative-sticky`로 보였고 옮길 3개만 내놓았다 |
| 소비자 | 세션 시간 초과·그룹 프로토콜(`group.protocol`) | 45초. 그룹 프로토콜은 `classic`(이전 방식)으로 설정에 적는다 | 45초는 librdkafka 기본값과 같지만, KafkaJS 호환 설정 묶음은 세션 시간 초과를 주지 않으면 30초를 넣으므로 직접 넣는다. 이 묶음은 `group.protocol`이 없으면 이전 방식으로 보고 위 값을 채운다(v1.11.0 소스 `lib/kafkajs/_consumer.js`, 2026-10-30 확인). 세션 시간 초과와 위의 협력적 재조정은 이전 방식의 설정이다. 새 방식(KIP-848, `consumer`)에서는 이 설정들을 쓸 수 없고 브로커가 정한다. 새 방식은 Kafka 3.9에서 조기 접근(운영에 쓰지 말라고 적음)이고 4.0부터 정식이다. librdkafka 문서는 기본값을 다음 판들에서 `consumer`로 바꾼다고 적으므로 기본값에 맡기지 않는다. 2026-10-30에 다시 보니 최신 판 v2.16.0(2026-10-06, `@confluentinc/kafka-javascript` 1.11.0이 싣는 판)과 master 모두 기본값은 `classic`이고 같은 문장이 그대로 있다. 새 방식은 librdkafka 2.12.0부터 운영에 써도 되는 판이지만 기본으로 켜지 않는다(변경 기록). 로컬 확인 2026-10-30(ST-T20): Kafka 3.9.2 브로커와 `@confluentinc/kafka-javascript` 1.11.0(librdkafka 2.16.0)로 재 보니, 값을 주지 않은 그룹은 소비자를 강제로 죽인 뒤 남은 소비자가 파티션을 모두 다시 받기까지 28.9초(세션 30초), 직접 넣은 그룹은 44.7초(세션 45초)였다. 두 그룹 모두 브로커에서 그룹 종류가 Classic이었다 (2026-10-29 확인, https://kafka.apache.org/39/configuration/broker-configs/, https://kafka.apache.org/41/operations/consumer-rebalance-protocol/, https://github.com/confluentinc/librdkafka/blob/master/CONFIGURATION.md, https://github.com/confluentinc/librdkafka/blob/v2.16.0/CONFIGURATION.md, https://github.com/confluentinc/librdkafka/blob/master/CHANGELOG.md, 그룹 프로토콜을 설정에 적는 것은 추천 적용 2026-10-29) |
| 소비자 | 묶음 | 공용 모듈이 여러 번 받은 것을 모아 만든다. `js.consumer.max.batch.size`는 기본 32건 그대로 둔다(2026-11-01 PoC, ADR-0176 결정 5). 이 값은 `eachBatch`의 묶음 크기이고, 공용 모듈이 쓰는 `eachMessage`에서는 미리 받아 두는 양에만 걸린다. 키 단위 소비(파티션마다 32키, 처리기 1ms)로 재면 1·32·128·제한 없음(-1)이 초당 4만 3천~5만 1천 건로 같은 범위다 | 한 번에 넘기는 기본 묶음이 작업자 묶음(§2.4)보다 훨씬 작다 |
| 소비자 | 고정 멤버십(`group.instance.id`, 재시작한 소비자가 같은 자리로 돌아오게 하는 설정) | 쓰지 않는다 | Deployment 파드는 롤링 때 이름이 바뀌어 효과가 없다 |

### 2.7 지표와 로그

- 지표는 서비스와 같은 OTel·Prometheus 경로로 내고, 클러스터의 Prometheus가 PodMonitor로 수집한다. 쓰는 지표는 `stream_consumer_lag_records{worker, topic, partition}`, `stream_insert_seconds{worker, table}`, `stream_insert_retries_total{worker}`, `stream_rejected_total{worker, topic, reason}`, `stream_unrecognized_symbol_total{worker, topic, record, field}`(모르는 열거 기호, §2.6), `stream_paused_partitions{worker}`, ops-svc의 `rt_query_seconds{view}`·`rt_freshness_seconds{path}`다(§14).
- 로그는 표준 출력으로 낸다. OTel 수집기(노드 에이전트 → 중앙 수집 단계인 게이트웨이, ADR-0076)가 이 로그를 Loki(로그 저장소)로 보낸다(observability §7). 레코드 내용(가명 처리 전 식별값, 행동 요약값)은 로그에 남기지 않는다.

## 3. 시간 기준과 심장 박동

1. 작업자는 시간 창을 만들지 않는다. 사건 시각을 열로 싣고, 칸은 읽을 때 나눈다(§4.3). 그래서 '이 시각 전 사건은 다 왔다'는 기준(Flink의 워터마크)을 기다리지 않고, 사건이 없는 파티션이 계산을 붙잡지도 않는다. 늦게 온 사건도 버리지 않고 제 칸에 들어간다.
2. 심장 박동: `rt-pulse`가 1초마다 텔레메트리 토픽 셋(`telemetry.queue`·`telemetry.purchase`·`telemetry.trust-verdicts`)의 모든 파티션에 `PipelinePulse`(파티션 직접 지정)를 넣는다. `ops-rt`가 이를 `rt.pulse`에 싣고, ops-svc가 이것으로 신선도(§4.5)와 파티션별 끊김을 잰다.
3. 거래 토픽(`trade.*`)에는 심장 박동을 넣지 않는다. 거래 토픽의 생산자는 Outbox 릴레이 하나로 둔다. Outbox 릴레이는 서비스마다 둔 폴링 릴레이이고(DB의 Outbox 표를 짧은 주기로 읽어 Kafka로 보낸다), 거래 토픽 쓰기 권한은 릴레이 역할(Outbox 릴레이, `trade.seats`·`trade.purchase-sessions`는 Redis Stream 릴레이도)에 주고 요청 처리 파드에는 주지 않는다(docs/data.md §4의 7번, ADR-0116). 거래 쪽 끊김은 소비 밀림, 온세일 중 60초 무사건 경보, Outbox 릴레이 지연(`outbox_relay_lag_seconds`)으로 본다(§9·§14).
4. 사건이 드문 토픽(`control.settings`)은 `ops-rt`가 읽지 않는다. 설정이 바뀐 시각은 조회할 때 ops-svc 명령 기록에서 가져와 붙인다. 이 토픽도 ops-svc Outbox(ops DB)로 내고, `control.sessions-terminated`는 identity-svc Outbox(identity DB)로 낸다(추천 적용 2026-10-29, ADR-0143 결정 3).
5. `PipelinePulse`가 실리는 토픽의 다른 소비자(`analytics-ingest` 등)는 이 메시지를 건너뛴다(계약 시험으로 확인).

## 4. 관제 실시간 표(`ops-rt`와 조회 시점 집계)

### 4.1 지표

지표 정의는 지표 사전(analytics §6)에 있는 같은 이름 지표의 정의를 쓴다. 같은 사건 묶음을 넣었을 때 골드와 같은 값이 나오는지 시험한다(§10 ST-T9). 실시간 숫자는 잠정값이며, 확정 숫자로 고쳐 쓰지 않는다(analytics §4.4).

| 지표(코드) | 종류 | 원천 | 차원 |
| --- | --- | --- | --- |
| 판매 좌석(`sold_seats`) | 누적 | 좌석마다 마지막 판매 상태(`SeatEvent`의 PENDING·SOLD·RETURNED, §4.3 규칙) | 전체, 등급, 구역 |
| 판매 금액(`sales_amount`) | 누적 | `PaymentEvent`(승인은 +, 입금 되돌림은 −. 취소·부분 취소·환불은 빼지 않는다. 지표 사전 26번·정산서 '판매 대금'과 같은 총액이다. 추천 적용 2026-10-20, ADR-0073) | 전체 |
| 확정 주문(`orders_confirmed`), 발권 티켓(`tickets_issued`) | 누적 | `OrderEvent` CONFIRMED(입금 되돌림 DEPOSIT_REVERSED는 −), `TicketEvent` ISSUED(무효 VOIDED는 −). 지금 확정·유효한 수다 | 전체 |
| 잔여석 | 조회 때 계산 | 판매 대상 좌석 수(회차 기준 자료, analytics §3.2 `brz_ref_seat_map`) − 판매 좌석. 홀드 중이거나 결제 진행 중인 좌석은 빼지 않는다(좌석맵 화면이 따로 보여 준다) | 전체, 등급, 구역 |
| 퍼널 단계 누적(`funnel_admitted`, `funnel_first_hold`, `funnel_payment_accepted`, `funnel_approved`, `funnel_issued`) | 누적 | `QueueAggregate.admissions`, `HoldAttempt` HELD 가운데 `firstHeldInSession`이 true인 것, `OrderEvent` ACCEPTED·APPROVED·CONFIRMED 가운데 `firstInStage`가 true인 것. 입금 되돌림 뒤 다시 확정되어도 다시 세지 않는다. 콘솔 판매 중 탭의 다섯 단계 퍼널 위젯은 같은 단계의 Prometheus 카운터를 보여 준다(observability §8, ADR-0071 결정 4). 이 누적은 등급별 상세·파트너 화면·마감 대조에 쓴다 | 전체, 등급(첫 홀드만) |
| 대기열 진입·입장·빠진 번호 누적(`queue_entries`, `queue_admissions`, `queue_removed`), 지금 대기 인원(조회 때 진입 − 입장 − 빠진 번호) | 누적 | `QueueAggregate` | 전체 |
| 진입·입장·빠진 번호의 초당 수 | 1초 칸 | `QueueAggregate`(`second`) | 전체 |
| 홀드 결과별 수(`hold_result`: HELD·CONFLICT·LIMIT·ERROR·RECENTLY_RELEASED), 홀드 경합 패배율(조회 때) | 1초 칸 | `HoldAttempt` | 결과, 등급 |
| 판정 종류별 수(`verdict`), 추가 검증 격리율(조회 때, 잠정) | 1초 칸 | `TrustVerdict`(`shadow` false만) | 판정 종류 |
| 심장 박동(`pulse`) | 신선도, 1초 칸(받은 수) | `PipelinePulse` | 토픽, 파티션 |

- 입장 속도, 퍼널 다섯 단계 카운터(`funnel_stage_total`), 오류율, 결제 성공률은 이 표에서 만들지 않는다. 판단과 제어에 쓰는 숫자는 클러스터 안의 Prometheus에서 나온다(observability §8 지표 출처 표, ADR-0068 결정 2).

### 4.2 원시 표에 싣는 사건

| 사건 | 거르기 | 싣는 표 | 싣는 열 |
| --- | --- | --- | --- |
| `SeatEvent` PENDING·SOLD·RETURNED | 홀드 쪽(HELD·RELEASED·EXPIRED)과 판매 예약 삭제(AVAILABLE, 판매 좌석 수를 바꾸지 않는다)는 거른다 | `rt.sale_event`(원천 SEAT) | 좌석 ID, 등급, 구역, 종류 |
| `OrderEvent` ACCEPTED·APPROVED·CONFIRMED·DEPOSIT_REVERSED | 나머지 종류는 거른다 | `rt.sale_event`(원천 ORDER) | 종류, `firstInStage` |
| `PaymentEvent` APPROVED·DEPOSIT_REVERSED | 나머지 종류는 거른다 | `rt.sale_event`(원천 PAYMENT) | 종류, 금액 |
| `TicketEvent` ISSUED·VOIDED | 나머지 종류는 거른다 | `rt.sale_event`(원천 TICKET) | 종류 |
| `QueueAggregate` | 없다 | `rt.queue_aggregate` | 파드(메시지 키 '회차:파드'의 ':' 뒤. 계약에는 `pod` 필드가 없다, 추천 적용 2026-10-29, ADR-0146 결정 8), 초, 진입·입장·빠진 수 |
| `HoldAttempt` | 없다 | `rt.hold_attempt` | 결과, 등급, `firstHeldInSession` |
| `TrustVerdict` | `shadow` true는 거른다 | `rt.verdict` | 판정 종류 |
| `PipelinePulse` | 없다 | `rt.pulse` | 토픽, 파티션, 발행 시각 |

- 배포 설정의 점검 회차 목록(밖에서 1분마다 도는 합성 점검용으로 숨긴 회차, docs/features/queue-admission.md §6)에 든 회차의 사건은 싣지 않는다(analytics §3.1, 기술 검토 중간-075, 2026-11-01 정합 점검).
- 모든 행에 회차 ID, `eventKey`(심장 박동은 없다), 사건 시각, 적재 시각을 싣는다. `rt.sale_event`에는 Kafka 파티션·오프셋도 싣는다(판매 좌석의 순서, §4.3).
- 사람 식별값(pid, 계정, 대기 참여, 구매 세션, 주문, 티켓 ID)은 싣지 않는다. '주문마다 한 번', '구매 세션마다 첫 홀드'는 생산자가 실은 표시(`firstInStage`·`firstHeldInSession`)로 센다(ADR-0099 결정 5). 생산자는 purchase-svc다. 주문 상태 기록과 구매 세션 상태로 그 사건이 처음인지 안다.
- 판매 좌석은 판매 상태가 Outbox 한 곳(purchase-svc의 `seat_sale`, seat-hold §6)에서 회차 키로 온다. 그래서 한 회차의 좌석 사건은 한 파티션에 순서대로 도착한다. 상태는 없음·PENDING·SOLD·RETURNED이고, 판매 좌석은 마지막 상태가 SOLD인 좌석의 수다. 가상계좌 입금 되돌림(주문 Confirmed → AwaitingDeposit, 좌석 SOLD → PENDING, docs/planning/03 §2)도 이 규칙으로 바르게 빠진다. 등급·구역은 `SeatEvent`의 `tierId`·`sectionId`(계약 보강, analytics §3.4)에서 받는다.

### 4.3 표(ClickHouse `rt` DB)

ClickHouse는 복제본을 2벌 두므로(infra §4) 복제 엔진을 쓴다. 원시 표는 중복을 받아도 되므로 일반 복제 엔진(ReplicatedMergeTree)이고, 병합 때의 중복 제거에 기대지 않는다. 이름과 TTL은 [가정]이다.

```sql
CREATE TABLE rt.sale_event ON CLUSTER '{cluster}'
(
    event_id        LowCardinality(String),
    event_key       UUID,
    source          LowCardinality(String),   -- SEAT·ORDER·PAYMENT·TICKET
    type            LowCardinality(String),   -- PENDING·SOLD·RETURNED·ACCEPTED·APPROVED·CONFIRMED·DEPOSIT_REVERSED·ISSUED·VOIDED
    seat_id         String,                   -- 좌석 사건만, 그 밖은 ''
    tier_id         LowCardinality(String),
    section_id      LowCardinality(String),
    amount          Int64,                    -- 결제 사건만(원), 그 밖은 0
    first_in_stage  Bool,                     -- 주문 사건만
    occurred_at     DateTime64(3),
    kafka_partition UInt32,
    kafka_offset    UInt64,
    loaded_at       DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplicatedMergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (event_id, source, event_key)
TTL toDateTime(occurred_at) + INTERVAL 400 DAY;

CREATE TABLE rt.queue_aggregate ON CLUSTER '{cluster}'
(
    event_id    LowCardinality(String),
    event_key   UUID,
    pod         LowCardinality(String),
    second      DateTime,
    entries     UInt32,
    admissions  UInt32,
    removed     UInt32,
    loaded_at   DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplicatedMergeTree
PARTITION BY toYYYYMM(second)
ORDER BY (event_id, second, event_key)
TTL second + INTERVAL 400 DAY;

CREATE TABLE rt.hold_attempt ON CLUSTER '{cluster}'
(
    event_id               LowCardinality(String),
    event_key              UUID,
    result                 LowCardinality(String),   -- HELD·CONFLICT·LIMIT·ERROR·RECENTLY_RELEASED(§4.1, 2026-11-01 정합 점검)
    tier_id                LowCardinality(String),
    first_held_in_session  Bool,
    occurred_at            DateTime64(3),
    loaded_at              DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplicatedMergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (event_id, occurred_at, event_key)
TTL toDateTime(occurred_at) + INTERVAL 400 DAY;

CREATE TABLE rt.verdict ON CLUSTER '{cluster}'
(
    event_id     LowCardinality(String),
    event_key    UUID,
    category     LowCardinality(String),
    occurred_at  DateTime64(3),
    loaded_at    DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplicatedMergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (event_id, occurred_at, event_key)
TTL toDateTime(occurred_at) + INTERVAL 90 DAY;

CREATE TABLE rt.pulse ON CLUSTER '{cluster}'
(
    topic            LowCardinality(String),
    kafka_partition  UInt32,
    produced_at      DateTime64(3),
    loaded_at        DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplicatedMergeTree
PARTITION BY toYYYYMMDD(produced_at)
ORDER BY (topic, kafka_partition, produced_at)
TTL toDateTime(produced_at) + INTERVAL 7 DAY;
```

읽는 규칙은 회차를 매개변수로 받는 매개변수 뷰(조회할 때 값을 넘겨 쓰는 뷰) 셋에 둔다. `rt.v_cumulative(event_id)`는 누적을 지표·차원·값 행으로 돌려준다. `rt.v_bucket(event_id, from_ts)`는 1초 칸을, `rt.v_freshness()`는 신선도를 돌려준다. 판매 좌석과 판매 금액의 요지는 아래와 같다.

```sql
-- eventKey마다 가장 이른 Kafka 위치의 한 줄만 남긴다(다시 보낸 사건과 다시 읽은 행을 지운다)
WITH sale AS (
    SELECT event_key,
           any(source) AS source, any(type) AS type, any(seat_id) AS seat_id,
           any(tier_id) AS tier_id, any(section_id) AS section_id, any(amount) AS amount,
           min(kafka_offset) AS first_offset
    FROM rt.sale_event
    WHERE event_id = {event_id:String}
    GROUP BY event_key
),
seat AS (   -- 좌석마다 마지막 판매 상태(회차 하나는 한 파티션이라 오프셋 순서가 사건 순서다)
    SELECT seat_id, any(tier_id) AS tier_id, any(section_id) AS section_id,
           argMax(type, first_offset) AS last_type
    FROM sale
    WHERE source = 'SEAT'
    GROUP BY seat_id
)
SELECT 'sold_seats' AS metric, '' AS dim, toInt64(countIf(last_type = 'SOLD')) AS value FROM seat
UNION ALL
SELECT 'sales_amount', '', sumIf(amount, type = 'APPROVED') - sumIf(amount, type = 'DEPOSIT_REVERSED')
FROM sale WHERE source = 'PAYMENT'
-- 등급·구역별 판매 좌석, 확정 주문·발권 티켓, 퍼널 단계, 대기열 누적도 같은 방식으로 이어 붙인다
```

- 퍼널 단계는 '처음' 표시가 true인 사건의 `eventKey` 서로 다른 개수로 센다(`uniqExact`). 대기열 누적은 `eventKey`로 중복을 지운 `QueueAggregate`의 합이다. 1초 칸은 `toStartOfSecond(occurred_at)`로 나누고, 칸마다 `eventKey`의 서로 다른 개수로 센다.
- ops-svc는 회차마다 0.5초 [가정]에 한 번 세 뷰를 읽고, 결과를 회차마다 한 번만 계산해 여러 화면(콘솔의 SSE 위젯 흐름(ADR-0100), 파트너 판매 현황의 1분 주기 REST 조회)에 나눠 준다. 1초 칸은 끝난 칸(지금보다 1초 앞까지)만 그린다. 이미 그린 칸에 늦은 사건이 들어오면 다음 조회에서 고쳐 그린다.
- '최근 10초·60초' 같은 이동 합과 10초 단위 보조 지표는 1초 칸을 더해 구한다. 구간별 증가량(분당 주문 등)은 누적 값의 차이로 구한다.
- 조회 규칙(추천 적용 2026-10-22, ADR-0086): ops-svc의 `rt` 조회 사용자(`an_rt_reader`)는 설정 프로필에 `force_primary_key = 1`을 둔다. 기본 키(정렬 키)를 쓸 조건이 없는 쿼리는 오류로 막힌다(줄이는 효과까지는 검사하지 않는다, ClickHouse 문서). 뷰는 모두 회차 ID로 정렬 키의 앞을 고른다. 조회마다 실행 시간 상한은 1초 [가정]이다. 회차를 넘나드는 골드 비교 조회는 다른 사용자로 둔다.
- 진단: 조회 종류별로 `system.query_log`의 `read_rows`·`query_duration_ms`·ProfileEvents `SelectedMarks`를 본다. 26.8은 `EXPLAIN indexes = 1`(인덱스별로 고른 파트와 그래뉼(기본 8,192행 묶음) 수)과 `EXPLAIN ANALYZE`(실제 단계별 시간, 분산 실행 쿼리는 안 됨)를 쓸 수 있다. 성능을 잴 때는 조건 캐시(25.4부터 기본 켬)를 끈다. 켜 두면 같은 쿼리를 되풀이해 잴 때 실제보다 빨라 보인다(추천 적용 2026-10-22, ADR-0086).
- 파트너 판매 현황은 화면이 1분마다 REST로 묻는다(`GET /v1/partner/events/{eventId}/live-snapshot`, 1분 지연, control-tower §11). ops-svc는 회차마다 1분에 한 번 `rt.v_cumulative` 결과로 계산해 둔 값을 돌려준다. 2026-10-28에 SSE에서 바꿨다(기술 검토 낮음-024).
- 누적은 원시 행에서 다시 세므로, 작업자가 재시작해도 숫자가 뒤로 가지 않는다.

### 4.4 적재 설정(ClickHouse 삽입)

| 설정 | `ops-rt` | `analytics-ingest`·`trust-reassess` | 뜻 |
| --- | --- | --- | --- |
| 묶음 | 2,000건 또는 0.25초 [가정] | 10,000건 또는 1초 [가정] | 묶음의 최대 레코드 수와 버퍼에 머무는 최대 시간 |
| 동시 묶음 | 파티션마다 1개, 전체 4개 [가정] | 같다 | 넘으면 새로 가져오기를 멈춘다 |
| 묶음 크기 상한 | 8MB | 16MB | 넘으면 묶음을 나눈다 |
| 레코드 크기 상한 | 64KB | 1MB | 넘는 레코드는 거절한다 |
| 다시 시도 | 버리지 않는다(§2.4) | 같다 | 그동안 그 파티션 소비를 멈춘다 |
| 서버 설정 | `async_insert=1`, `wait_for_async_insert=1`, `deduplicate_insert='enable'`, `insert_deduplication_token` | 같다 | 디스크에 쓴 뒤 응답하고, 같은 묶음을 다시 보내면 거른다 |

- 숫자는 [가정, 4.3.9에서 확정]이다. 묶음이 너무 작거나 너무 자주 보내면 ClickHouse의 병합이 밀려 삽입이 느려진다. 그래서 `stream_insert_seconds`와 묶음당 건수를 보고 맞춘다(ClickHouse 문서).
- `wait_for_async_insert=0`은 쓰지 않는다(디스크에 쓰기 전에 응답하므로 데이터를 잃을 수 있다).
- 대상 판 26.8 LTS의 기본값과 같은 설정(`async_insert=1`, `wait_for_async_insert=1`, 모든 삽입의 중복 판정)도 표에 그대로 적어 둔다. 판을 올릴 때 기본값이 바뀌어도 동작이 그대로이게 하려는 것이다. 26.8은 25GiB 이하 표에 INSERT 때 열 통계를 만든다. 실시간 표처럼 삽입이 잦은 표의 비용을 4.3.9 측정에 넣고, 비용이 크면 그 표만 끈다(추천 적용 2026-10-22, ADR-0086).

### 4.5 신선도와 지연 예산(NFR-009)

- **SLI**(실제로 재는 서비스 품질 값): ops-svc가 읽을 때마다 두 길의 신선도를 `rt_freshness_seconds{path}`로 낸다. 누적 길(`cumulative`)은 '지금 − 텔레메트리 셋의 모든 파티션 가운데 가장 늦은 파티션의 마지막 심장 박동 발행 시각'이다. 1초 칸 길(`bucket`)은 화면에 보이는 마지막 끝난 칸을 기준으로 잰다. 둘 중 큰 값을 콘솔 판매 중 탭의 머리에 보여 준다(docs/design/d5 §7.2). 1분 창의 p95(잰 값 백 개 중 아흔다섯 개가 이 값 이하라는 뜻)가 NFR-009 판정값(5초 미만)이다.
- **심장 박동 수**: 1초 칸마다 받은 심장 박동 수가 그 토픽의 파티션 수보다 작으면, 어떤 파티션의 사건이 늦거나 빠지고 있다는 뜻이다. 이 값은 엔지니어 화면에 파티션별로 보인다.
- **누락률**: (읽지 못해 거절한 수 + 텔레메트리 생산자가 버린 수(ADR-0026)) ÷ 전체로 구한다. 0.1% 미만이 목표다. 작업자는 늦은 사건과 실패한 묶음을 버리지 않으므로, ClickHouse가 멈추면 누락 대신 신선도가 나빠진다.
- **Degraded 전환**: 신선도 p95가 5초를 넘는 상태가 3분 넘게 이어지면 콘솔의 실시간 표 패널을 Prometheus 대체 표시로 바꾼다. 신선도 p99(잰 값 백 개 중 아흔아홉 개가 이 값 이하라는 뜻)는 60초까지 허용한다(observability §10). 신선도 p95가 5초 미만인 상태가 5분 [가정] 이어지면 실시간 표로 자동으로 되돌린다(추천 적용 2026-10-21, ADR-0078 결정 2). 소비 밀림·삽입 재시도·조회 시간은 원인을 살피는 패널로 둔다.

| 구간 | 예산 | 근거 |
| --- | --- | --- |
| 생산자 묶음과 Kafka 복제 | 0.05초 [가정] | 텔레메트리 생산자 설정 |
| 작업자 묶음 | 최대 0.25초 [가정] | §2.4 |
| ClickHouse 비동기 삽입 반영 | 최대 0.2초 | ClickHouse 문서(적응형 시간, 직접 운영할 때 기본 최대 200ms) |
| ops-svc 조회 주기 | 0.5초 [가정] | §4.3 |
| 조회 실행 | 0.05초 [추정, 4.3.9에서 확인] | §11 |
| 푸시와 그리기 | 0.3초 [추정] | |
| 합(최악, 누적) | 약 1.4초 [추정] | 5초 목표 안에서 여유가 크다 |
| 1초 칸 | 약 2.4초 [추정] | 끝난 칸만 그려 1초를 더한다 |

- Flink로 짠 설계는 누적 약 2.3초, 1초 칸 약 3.9초였다[추정]. 칸이 닫히고 워터마크가 나아갈 때까지 기다려야 했기 때문이다.
- 심장 박동은 텔레메트리 경로만 지난다. 그래서 거래 쪽 앞단 지연(Outbox → Kafka)과 끊김은 Outbox 릴레이 지연 지표(`outbox_relay_lag_seconds`, 폴링 주기 100ms [가정], ADR-0116)와 거래 토픽의 소비 밀림·마지막 사건 시각(§14)으로 따로 본다.

### 4.6 실시간 대비 대조(analytics §4.4)

- 마감 때 판매 좌석·판매 금액은 `rt.v_cumulative`의 값과 골드를 비교한다. 둘은 같은 사건을 같은 `eventKey`로 중복을 지우고 같은 규칙의 SQL로 센다. 그래서 원천 유실이 없고 규칙이 지표 사전과 같으면 차이는 0이다. 규칙이 같은지는 같은 고정 사건을 dbt 모델과 실시간 뷰에 넣어 시험한다(§10 ST-T9). R3의 골드 쪽 값은 날짜별 판매 사실(`fct_sales_daily`)의 합이라, R2 뒤에 판 몫도 들어간다. 원시 표 보존 400일(§4.7)이 같은 범위를 덮는다(analytics §4.3, 추천 적용 2026-10-28, 기술 검토 높음-23).
- 차이가 나면 원인은 원천 유실, `eventKey`가 다른 재발행, 규칙 차이 중 하나다. 그 지표의 결정 규칙은 '판정 보류'로 두고, 원인을 데이터 품질 절에 적는다.

### 4.7 원시 행의 보존과 다시 채우기

- 보존은 `rt.sale_event`·`rt.queue_aggregate`·`rt.hold_attempt` 400일, `rt.verdict` 90일, `rt.pulse` 7일이다 [가정]. 판매 기간과 R3까지의 마감 대조를 덮는 길이다. 판매 기간(오픈~판매 종료)이 400일 [가정]을 넘는 회차는 판매 승인 때 승인 화면에 경고하고, 그 회차의 R3 실시간 대비 대조는 '판정 보류(원시 표 보존 초과)'로 둔다. 보존을 회차마다 늘리는 열은 두지 않는다. 표 TTL은 표마다 하나(`+ INTERVAL 400 DAY`, §4.3)라 회차별로 늘릴 수 없기 때문이다(추천 적용 2026-10-29, ADR-0146 결정 7). 이 보존으로, 판매 기간이 400일 안이면 앞부분을 못 세던 문제가 함께 풀린다.
- 원시 표를 잃으면(ClickHouse 복원 뒤 빈 구간) 두 길로 다시 채운다. 절차는 장애 때 따라 하는 절차서인 런북 RB-34(infra §10)에 있다.
  1. Kafka 보관 기간(7일) 안의 구간: `ops-rt`를 오프셋 구간 지정 모드로 띄워 그 구간만 다시 싣는다. 별도 소비자 그룹을 쓰고 커밋하지 않는다.
  2. 그보다 오래된 판매류 사건: 마감 실행기(`close-runner`)의 다시 채우기 명령이 브론즈(적재 뒤 90일)에서 `INSERT … SELECT`로 `rt.sale_event`를 채운다.
- 겹쳐 실려도 읽을 때 `eventKey`로 지우므로 결과가 같다. 브론즈보다 오래된 구간은 골드 회차 요약으로만 남고, 그 회차의 실시간 누적은 '다시 채우지 못함'으로 표시한다.

### 4.8 미리 합산(머티리얼라이즈드 뷰)을 쓸 때

머티리얼라이즈드 뷰는 데이터가 들어오는 순간 미리 합산해 두는 ClickHouse 기능이다. 읽기 비용이 커져 바꿀 조건 1(§16)에 닿았을 때의 첫 단계로만 쓴다. 뷰는 넣는 묶음만 보고 계산하므로, Kafka 안의 중복(같은 사건을 다시 보낸 것)을 두 번 셀 수 있다. 그래서 중복에 안전한 숫자에만 쓴다.

| 숫자 | 뷰로 미리 합산 | 이유 |
| --- | --- | --- |
| 퍼널 단계 | 된다 | '처음' 표시가 true인 사건의 `eventKey` 서로 다른 개수(`uniqExact` 상태)는 같은 사건이 두 번 와도 같다 |
| 1초 칸(홀드 결과, 판정 종류) | 된다 | 칸마다 `eventKey` 서로 다른 개수로 세면 중복에 안전하다 |
| 판매 좌석 | 지금은 안 된다 | 좌석마다 마지막 상태를 남기려면 '마지막'을 가를 생산자 순번이 있어야 한다. Kafka 위치로 가르면 다시 보낸 옛 사건이 더 늦은 위치로 들어와 이긴다 |
| 판매 금액, 확정 주문, 발권 티켓 | 안 된다 | 합계는 같은 사건을 두 번 더한다 |
| 대기열 누적 | 안 된다 | 같은 이유다. 1초 집계 메시지(`QueueAggregate`)를 다시 받으면 두 번 더한다 |

- 뷰는 `rt` 원시 표에만 건다. 브론즈에는 걸지 않는다. 뷰에서 오류가 나면 기본값(`materialized_views_ignore_errors` 끔)에서는 원본 표의 삽입도 실패하기 때문이다.
- 뷰는 넣는 순간에만 계산한다. 규칙을 고치면 지난 값을 다시 넣어 채운다(`INSERT … SELECT`).

## 5. 봇 대기 중 재평가(`trust-reassess`)

### 5.1 역할

판정은 trust-svc가 로비 입장·사전 검증 요청 때 그 자리에서 한다(queue-admission §7. 로비 입장을 더했다, 추천 적용 2026-10-30, docs/features/bot-defense.md §4.1). 판정에 쓰는 피처 가운데 회차별 기기 공유 수와 호스팅·프록시 대역 진입 수도 trust-svc가 Redis(메모리에 데이터를 두는 빠른 저장소)에서 바로 센다(§5.5). 이 작업자는 판정과 따로, 사람들이 기다리는 동안 한 사람만 봐서는 보이지 않는 여러 사람 사이의 패턴을 찾아 추가 검증 후보를 낸다. 예를 들어 같은 기기에 계정 다섯 개가 차례로 들어오면, 판정 때는 다섯 번째부터 의심스럽지만 이 작업자는 앞의 네 명도 다시 본다.

### 5.2 입력

입력은 `telemetry.behavior`의 `BehaviorSignal`이다. trust-svc가 로비 입장·사전 검증 때 기기 식별값을 기기 가명(`deviceRef`. 2026-10-31부터 identity-svc와 같은 조사용 가명 키, ADR-0171)으로 바꾼 뒤 낸다(ADR-0053). 로비 입장에는 행동 요약이 없어 `features`가 비므로 R1만 쓰인다(추천 적용 2026-10-30, docs/features/bot-defense.md §4.1). 필드는 `pid`, `deviceRef`, `eventId`, `netClass`(HOSTING·PROXY·OTHER), `asn`(HOSTING·PROXY일 때만), `features`(브라우저가 낸 요약값, ADR-0065 결정 9), `ts`, `eventKey`다(`schemaVersion`은 2026-10-28에 뺐다, 기술 검토 낮음-026).

### 5.3 패턴

| 패턴 | 키 | 조건 [가정, 4.3.8과 그림자 기간에 확정] | 후보 |
| --- | --- | --- | --- |
| R1 기기 공유 소급(`DEVICE_SHARE`) | 회차, `deviceRef` | 10분 안에 서로 다른 pid 5명 이상 | 그 기기의 pid 모두(이미 판정을 통과한 사람 포함) |
| R2 행동 요약값 복제(`BEHAVIOR_REPLAY`) | 회차, 요약값 지문 | 10분 안에 서로 다른 pid 20명 이상 | 그 지문의 pid 모두. 사람이 되풀이할 수 없는 똑같은 값으로 자동화를 가리는 실시간 판정이라 ADR-0173 결정 5(행동 요약을 계정끼리 견주지 않는다)의 범위 밖이고, 결과는 자동화의 근거로만 쓰며 계정 연결·'같은 사람' 판단에 쓰지 않는다(2026-10-31 FRN-080) |

- 요약값 지문은 정해진 순서의 특징값을 소수 넷째 자리 [가정]로 반올림한 문자열의 SHA-256이다(보안 용도가 아니라 같은 값을 묶는 열쇠다). 서로 다른 사람에게서 같은 값이 나올 가능성은 낮고, 녹화한 움직임을 여러 계정에서 재생하면 같은 값이 나온다. 포인터 이동 엔트로피와 입력 간격 분산이 모두 0인 요약값(키보드·터치만 쓴 경우 등)은 지문을 만들지 않는다. 키보드 보조기기 사용자를 한 무리로 묶지 않기 위해서다(queue-admission §7).
- 시간 기준은 작업자가 받은 시각(처리 시각)이고, 키 수명은 10분이다.
- 세션 창과 CEP는 쓰지 않는다(§5.7).

### 5.4 출력

- `telemetry.trust-candidates`(`TrustCandidate`, 키 pid): `eventId`, `pid`, `pattern`, `evidenceCount`, `windowStart`, `detectedAt`, `eventKey`. `eventKey`는 `SHA-256("PEAKET-reassess-v1" ‖ 회차 ID ‖ pid ‖ 패턴 ‖ 10분 칸 시작)`으로 만든 UUIDv8(RFC 9562 §5.8)이다. 그래서 같은 후보를 다시 내도 값이 같다.
- 행동 신호 원시 표(ClickHouse `trust.behavior_raw`, 30일 TTL, data-classification 행동 신호 행): 입력을 그대로 적재한다. 다만 여정 ID `journeyId`는 싣지 않는다. 이 표는 대기 중 재평가가 쓰는 탐지 자료이고, 여정을 잇는 일은 조사 저장소 `inv`만 한다(추천 적용 2026-10-31, ADR-0171). 정렬 키는 `(event_id, ts)`, 파티션은 `toYYYYMMDD(ts)`(30일 보존과 맞는다, ADR-0077)이고, 복제 엔진을 쓴다. 적재는 §2.4·§4.4 규칙을 따른다.

### 5.5 trust-svc의 처리

- **판정 피처(동기)**: 로비 입장·사전 검증 요청 때(로비 입장은 추천 적용 2026-10-30, docs/features/bot-defense.md §4.1) 세션·캐시 Redis에 회차별 기기 공유 수 `tr:devshare:{deviceRef}:E`(Set, 10분, 원소 상한 20개)와 호스팅·프록시 대역 진입 수 `tr:asnhost:{asn}:E:{10초 칸}`(카운터, 만료 30초)를 쓰고 읽는다 [가정]. 기기 공유 수는 작은 정수를 문턱과 견주므로 어림값(HyperLogLog)이 아니라 Set으로 정확히 센다. 두 키는 다른 키와 한 Lua에서 함께 쓰지 않아 해시 태그를 회차가 아니라 기기 가명·ASN에 둔다. 그래서 오픈 직전 사전 검증이 몰려도 한 회차의 키가 한 샤드에 모이지 않는다(추천 적용 2026-10-28, 기술 검토 낮음-033, docs/data.md §3). 통신사 대역은 세지 않는다(사람 대부분이 몇몇 통신사 대역에 몰려 있어서 신호가 약하고, 한 키에 요청이 몰린다).
- **재평가 모드**: 명령 5(봇 판정 강도) 프로필에 있는 값이다. 값은 끔·그림자·적용이고, 기본값은 그림자다.
  - 그림자: `TrustVerdict`(source `REASSESS`, action `NONE`, `shadow` true)만 낸다.
  - 적용: 아직 기다리는 사람이면 queue-svc의 `IsolateWaiting`(서비스끼리 함수를 부르듯 호출하는 gRPC 방식, 메시 mTLS, 후보 `eventKey`로 멱등)을 부른다. queue-svc는 1인 1순번 중복 확인 키로 그 사람의 대기표(로비 참가자는 참가를 증명하는 서명된 문자열인 참가 토큰)를 찾아, 빠진 번호와 `VERIFYING`을 쓴다(queue-admission §7 격리 기록, ADR-0062). 응답은 격리함·대기 중 아님·이미 격리됨·상한 도달(`ISOLATE_RESULT_CAP_REACHED`)이다. 이미 입장한 사람은 라벨만 남긴다(넷째 응답은 2026-11-01 정합 점검, queue.proto, docs/features/bot-defense.md §8).
- **후보 중복**: trust-svc는 처리한 후보 `eventKey`를 10분 [가정] 동안 기억해서, 같은 후보를 두 번 처리하지 않는다.
- **격리 상한**: 재평가로 건 격리는 회차의 지금 대기 인원의 0.5% [가정]를 10분 안에 넘지 않는다. 대기 인원은 trust-svc가 알 길이 없어, queue-svc가 격리를 쓰는 Lua에서 10분 칸의 재평가 격리 수와 대기 인원(발급 번호 − serving − 빠진 번호)을 함께 보고 넘으면 격리하지 않고 상한 도달로 답한다. trust-svc는 그 답을 받으면 그림자로만 남기고 SEV3를 띄운다(2026-11-01 정합 점검, docs/features/bot-defense.md §8, ADR-0156 결정 10). 잘못된 패턴이나 숫자 때문에 사람을 한꺼번에 격리하는 사고를 막기 위해서다.
- 격리는 차단이 아니다. 추가 검증(사람 확인과 본인확인 재통과), 이의 제기, 자동화된 결정의 설명 요구(개인정보 보호법 §37의2, POL-006)는 그대로다.

### 5.6 그림자에서 적용으로

ADR-0039 평가 절차의 그림자 실행 단계를 거친다. 그림자 기간에 낸 후보를 마감 단계 R2(오픈 7일 뒤)의 표본 검토와 사후 라벨로 대조해, 사람 오탐(사람을 봇으로 잘못 잡는 것)이 상한(NFR-022, 0.5%)을 넘지 않는지 확인한다. 그 뒤 commander가 명령 5로 재평가 모드를 그림자에서 적용으로 바꾼다. 넘으면 그 패턴은 적용하지 않고, 패턴의 기준 숫자를 고치거나 패턴을 뺀다.

### 5.7 세션 창과 CEP를 쓰지 않는 이유

- 세션 창은 활동이 멈춘 뒤에야 결과를 내므로 동기 판정에 쓸 수 없다. 쉬지 않는 봇이라면 창이 닫히지도 않는다. 세션 단위의 사후 분석은 확정 길(dbt, 마감 단계 R2의 표본 검토·사후 라벨)이 맡는다.
- CEP에는 순서가 있는 사건 기록이 필요하다. 브라우저는 원시 좌표·입력 시각의 순서를 보내지 않고 요약값만 보낸다(ADR-0065 결정 9, 개인정보 판단). 순서가 있는 서버 사건(홀드 시도 간격 등)으로 CEP를 쓰려면 계약을 따로 정한다. 그때는 스트리밍 엔진을 다시 본다(§16 바꿀 조건 2).

### 5.8 Redis 키와 스크립트

| 키 | 자료형 | 내용 | 수명 |
| --- | --- | --- | --- |
| `tr:ra:dev:{deviceRef}:E` | 정렬 집합(점수로 정렬되는 집합) | R1: pid → 받은 시각(ms) | 10분(쓸 때마다 늘린다) |
| `tr:ra:fp:{지문}:E` | 정렬 집합 | R2: 같은 모양 | 10분 |
| 위 키 뒤에 `:over`를 붙인 키 | 문자열 | 넘음 표시. 값은 표시를 켠 메시지의 (파티션, 오프셋) | 10분 |

- Lua 스크립트(Redis 안에서 한 번에 도는 짧은 프로그램) 하나가 메시지마다 아래를 원자적으로 한다.
  1. 넘음 표시가 있으면 새 pid만 후보로 돌려준다. 다만 표시를 켠 메시지 자신을 다시 읽은 경우(값의 파티션·오프셋이 같다)에는 집합 전체를 돌려준다.
  2. 넘음 표시가 없으면 pid를 넣고, 10분보다 오래된 것을 지우고, 서로 다른 pid 수를 센다.
  3. 문턱(5·20)에 닿으면 넘음 표시를 켜고(값은 이 메시지의 파티션·오프셋) 집합 전체를 후보로 돌려준다. 그 뒤로는 집합에 더 넣지 않는다. 그래서 키 하나의 크기는 문턱보다 크게 자라지 않는다.
- 작업자는 돌려받은 후보를 `TrustCandidate`로 Kafka에 내고, 발행 확인을 받은 뒤 입력 오프셋을 커밋한다. 발행 전에 작업자가 죽으면 그 메시지를 다시 읽어 같은 후보를 다시 낸다(1의 예외 규칙). trust-svc는 같은 후보를 `eventKey`로 한 번만 처리한다. Flink 때는 체크포인트가 상태와 읽은 위치를 함께 되돌려 이 일을 했다.
- 해시 태그는 기기 가명·지문이다. 스크립트는 키 하나와 그 `:over` 키만 함께 쓰므로 둘이 같은 슬롯이면 되고, 회차 단위로 모을 까닭이 없다. 판정 피처 키(`tr:devshare:…`)와 같은 규칙이고, 한 회차의 키를 여러 샤드에 흩는다(추천 적용 2026-10-28, 기술 검토 낮음-033. ADR-0099 때는 회차 태그 `{event:E}`로 한 샤드에 모았다). 대형 회차 로비 피크에서도 초당 수천 건의 스크립트 호출이라, 모았더라도 한 샤드로 버틸 양이다 [추정].
- 메모리는 10분 피크 신호 약 100만 개 기준 약 100MB다 [추정]. 세션·캐시 클러스터가 메모리를 비우려고 키를 지우면 그 키의 문맥(최대 10분)을 잃는다(§15).

## 6. 원본 적재(`analytics-ingest`)

- 심장 박동(`PipelinePulse`)과 `QueueAggregate`는 건너뛴다. 배포 설정의 점검 회차 목록에 든 회차의 사건도 건너뛴다(analytics §3.1, 기술 검토 중간-075, 2026-11-01 정합 점검).
- 거절이 1건이라도 생기면 SEV3다.
- 마감 커버리지(analytics §7): 파티션마다 대상 오프셋 구간에 있는 고유한 (파티션, 오프셋) 수가 구간 길이와 같은지 본다. 적재 거절 기록(§6.3)의 오프셋도 구간에 넣는다. 모자라면 그 구간을 Kafka 보관 기간(7일) 안에서 다시 적재한다(RB-34). 이 대조는 트랜잭션(여러 변경을 한꺼번에 반영하거나 한꺼번에 취소하는 작업 단위) 생산자를 쓰지 않는다는 것(ADR-0026 결정 3, 트랜잭션 표시는 오프셋을 차지한다)과 토픽이 삭제 보존(압축 아님) 방식이라는 것을 전제로 한다. 그래서 원본 적재가 읽는 토픽 가운데 압축 토픽 `control.settings`는 이 대조에서 뺀다. 압축은 같은 키의 옛 값을 지우므로 지운 자리의 오프셋이 빈 구간으로 보이고, 압축이 지난 구간을 다시 적재해도 키마다 마지막 값만 남기 때문이다. 설정이 바뀐 시각의 원본은 ops-svc 명령 기록이다(§3, docs/features/analytics.md §7). 텔레메트리 생산자가 버퍼가 차서 버린 사건(`telemetry_dropped_total{record}`, §2.6)은 Kafka에 닿지 않아 이 대조로 보이지 않는다. 그 몫은 분석의 커버리지 검사가 버린 수로 따로 표시한다(ADR-0141 결정 6).
- 다시 적재는 같은 작업자를 오프셋 구간 지정 모드로 띄워 그 구간만 싣는다. 별도 소비자 그룹을 쓰고 커밋하지 않는다. 겹쳐 실린 행은 브론즈가 중복을 허용하고 실버가 지운다.

### 6.1 단계

| 단계 | 하는 일 | 출력 |
| --- | --- | --- |
| 소비 | 클러스터별로 읽는다(토픽·파티션·오프셋·Kafka 시각 포함) | 레코드 |
| 역직렬화 | Avro를 읽고 스키마 버전을 기록한다. 읽지 못하면 거절 기록으로 보낸다 | 사건 또는 거절 |
| 가명 처리 | 식별값을 회차별 가명으로 바꾼다(§6.2) | 가명 사건 |
| 금지 필드 제거 | 스키마별 허용 목록 밖의 필드와 금지 필드를 지운다(analytics §3.3). 2026-10-31에 더한 조사 칸(`journeyId`·`deviceRef`·`contactRef`·`paymentMethodRef`·`cardBin`)과 우선 구매 보류 칸(`SeatEvent`의 `holdKind`·`priorityGrantId`)은 허용 목록에 넣지 않아 여기서 버린다. 조사 갈래와 연구 갈래를 잇는 키가 분석 저장소에 생기지 않게 하려는 것이다(추천 적용 2026-10-31, ADR-0171 결정 2). 조사 요청 기록 `investigation.requests`는 읽지 않는다 | 브론즈 행 |
| 나누기 | 원천별 브론즈 표로 나눈다 | 표별 행 |
| 삽입 | 브론즈 표마다 묶어 넣는다(§4.4 설정) | ClickHouse |
| 거절 기록 | 위치만 넣는다 | `bronze.brz_rejected` |

- 분석 수집 버킷의 파일(기준 자료·운영 기록·비용·SLO)은 이 작업자가 싣지 않는다. 개인정보가 없는 파일이라 가명 처리가 필요 없어, 마감 실행기(`close-runner`, 쿠버네티스 CronJob)가 ClickHouse `s3()` 표 함수로 크기 상한·형식 검사를 거쳐 브론즈에 싣는다(analytics §3.2, 추천 적용 2026-10-28, 기술 검토 낮음-042). Flink 때 '파일 소스를 넣을지'로 남았던 빈칸은 이것으로 닫는다.

### 6.2 가명 처리와 키

- 회차 키는 `HMAC(분석 가명 키, "PEAKET-analytics-v1" ‖ 회차 ID)`이다. KMS `GenerateMac`으로 작업자 파드마다 회차당 한 번 얻어 메모리에만 둔다(analytics §3.3). 디스크·로그에는 쓰지 않는다.
- 가명 키를 얻지 못하면 원문을 쓰지 않고, 그 레코드의 파티션 소비를 멈춘 채 다시 시도한다(fail-closed). 그동안 소비 밀림이 늘어 경보가 뜬다(§14).
- 브론즈 행에는 키 버전을 함께 적는다.

### 6.3 적재 거절 기록

- 읽지 못한 레코드(역직렬화 실패, 모르는 스키마 ID, 필수 필드 없음)는 원문을 복사하지 않고 위치만 `bronze.brz_rejected`에 남긴다. 원문은 Kafka에 7일 동안 남아 있으므로 고친 코드로 다시 적재할 수 있다. 가명 처리 전 식별값이 다른 곳에 복제되지 않게 하려는 것이다.
- 거절이 1건이라도 생기면 SEV3다. 그 회차의 마감 리포트 '데이터 품질' 절에 건수를 적는다.

```sql
CREATE TABLE bronze.brz_rejected ON CLUSTER '{cluster}'
(
    topic        LowCardinality(String),
    partition    UInt32,
    offset       UInt64,
    kafka_ts     DateTime64(3),
    schema_id    Nullable(UInt32),
    error_class  LowCardinality(String),  -- DESERIALIZE·UNKNOWN_SCHEMA·MISSING_FIELD 등
    loaded_at    DateTime64(3)
)
ENGINE = ReplicatedMergeTree
ORDER BY (topic, partition, offset)
TTL toDateTime(loaded_at) + INTERVAL 90 DAY;
```

### 6.4 조사 적재(`inv-ingest`, 추천 적용 2026-10-31, ADR-0171)

부정 예매 사후 조사(판매가 끝난 뒤 실제 기록으로 한 사람이나 한 조직이 여러 계정으로 산 표를 묶어 찾는 일, docs/features/forensic-replay.md)의 원천을 싣는 작업자다. 원본 적재(`analytics-ingest`)와 같은 소비 모듈을 쓰지만 작업자·소비자 그룹·저장소 사용자가 따로이고, 서로의 표를 읽지 않는다. 이 작업자는 가명 처리를 하지 않는다. 조사 갈래는 실명 계정·주문·결제·접속 기록으로 부정 예매를 조치하는 갈래이기 때문이다(ADR-0171 결정 2). 그래서 분석 저장소에는 어떤 행도 쓰지 않는다.

**원천과 싣는 곳**: 표의 칸은 docs/data.md '부정 예매 사후 조사의 표'가 정본이다. 단계(`inv_step.step`)는 한 사람이 회차에 들어와 나갈 때까지 밟은 일이다.

| 원천 | 거르는 것 | `inv_request` | `inv_step` | `inv_behavior` | `inv_link` |
| --- | --- | --- | --- | --- | --- |
| `investigation.requests` `InvestigationRequest`(JSON) | 없음 | 한 줄. `net_class`는 ASN 분류표로 채운다 | — | — | (회차, pid, 계정) |
| `telemetry.queue` `QueueEntryRecord` | `QueueAggregate`·`PipelinePulse` 건너뜀 | — | `QUEUE_ENTER`(enteredAt, 검증 경로), 입장 확정이면 `ADMIT`(admittedAt) | — | (여정, pid) |
| `trade.purchase-sessions` `PurchaseSessionStarted` | `PurchaseSessionEnded` 건너뜀 | — | — | — | (여정, 구매 세션) |
| `telemetry.purchase` `HoldAttempt` | `PipelinePulse` 건너뜀 | — | `HOLD_TRY`(좌석, 잡은 시각, 결과) | — | — |
| `trade.seats` `SeatEvent` | `RELEASED`·`EXPIRED`만, `EventSaleChanged` 건너뜀 | — | `HOLD_END`(구매 세션으로 여정에 잇는다) | — | — |
| `trade.orders` `OrderEvent` | — | — | `CREATED`는 `ORDER`, `CONFIRMED`는 `SALE`, `REFUNDED`·`PARTIALLY_REFUNDED`는 `CANCEL` | — | `CREATED`의 (여정, 계정, 연락처 가명) |
| `trade.payments` `PaymentEvent` | — | — | `PAY_TRY`(결제 수단 연결값·BIN, 주문 ID로 여정에 잇는다) | — | (주문의 여정, 결제 수단 연결값) |
| `trade.tickets` `TicketEvent` | 양도·돌려주기·회수·입장·환급 사건만 | — | `TRANSFER`, `ENTRY_SCAN`, `CANCEL` | — | — |
| `telemetry.behavior` `BehaviorSignal` | 없음(SEAT·PAYMENT도 싣는다) | — | — | 화면별 요약 | (여정, pid, 기기 가명) |
| `telemetry.trust-verdicts` `TrustVerdict` | `PipelinePulse` 건너뜀 | — | — | — | (여정, pid, 기기 가명) |

- **계정의 연결 값**: 회차에서 처음 본 계정은 identity-svc `BatchGetInvestigationRefs`로 묶어(500개 [가정]씩) 연락처 가명·연결 기기 가명·같은 본인확인 시도 기록을 받아 `inv_link`에 싣는다. 파드 메모리의 짧은 캐시(10분 [가정])로 같은 계정을 거듭 묻지 않을 뿐이고, 캐시를 잃어도 다시 물어 같은 행을 다시 넣을 뿐이다(표가 중복을 지운다). identity-svc가 답하지 않으면 그 묶음만 뒤로 미뤄 다시 묻고(1분 [가정] 간격), 사건 적재는 멈추지 않는다.
- **여정 잇기**: 대기열 경로 요청에는 여정 ID가 없고(게이트웨이가 대기열 토큰을 풀지 않는다), `QueueEntryRecord`는 대기가 끝날 때 와서 적재 때 여정을 채울 수 없다. 그래서 작업자는 상태를 두지 않고, 요청에 있는 값만 싣는다. 여정·기기 가명이 빈 행은 읽는 쪽(ops-svc 조사 모듈, `inv_reader`)이 `inv_link`와 (회차, pid)로 잇는다.
- **계산하지 못한 조사용 가명(추천 적용 2026-10-31, ADR-0171)**: 생산자가 라벨 키를 받지 못해 비운 사건(`refMissing` 참)은 그대로 싣고 `ref_missing`을 남긴다. 이 작업자는 원문이 없고 원문을 받으려고 기다리지도 않으므로 나중에 채우지 않는다. 빈 값으로는 `inv_link` 행을 만들지 않는다. 조사용 가명 값은 키 판 접두어(`k1.` 등)가 붙은 문자열 그대로 싣는다(docs/data.md '부정 예매 사후 조사의 표').
- **행동 요약의 쓰임(추천 적용 2026-10-31, ADR-0173 결정 5)**: `inv_behavior`는 세션 하나가 사람 입력인지 자동화인지 보는 데만 쓴다. 이 작업자는 행동 요약으로 `inv_link` 행을 만들지 않고, 읽는 쪽도 계정끼리 견주거나(유사도·군집·정렬) 묶음 잇기·묶음 점수에 넣지 않는다(docs/features/forensic-replay.md §6.7.3).
- **원문 IP**: 원문 IP는 `inv_request`에만 있다. 법정 접속기록 저장소와 서로 복사하지 않고, 같은 요청은 `requestId`로 대조만 한다(docs/observability.md §7 '원문 IP를 두는 곳').
- **중복과 순서**: 적어도 한 번 전달이라 같은 사건이 다시 올 수 있다. 표마다 `ReplacingMergeTree`의 정렬 키(요청은 `requestId`, 단계·행동은 원천의 `eventKey`)로 지운다. 도착 순서에 기대지 않는다. 시각은 원천의 사건 시각이다.
- **기록 고정과 적재 지연**: 온세일 윈도우가 끝나면(T+60분) ops-svc 조사 모듈이 그 회차를 고정하고 해시를 남긴다(docs/data.md `fraud_snapshot`). 고정하기 전에 이 작업자의 모든 파티션 커밋 위치가 T+60분 + 5분 [가정] 뒤의 사건까지 갔는지 본다. 아직이면 기다리고, 30분 [가정] 넘게 못 따라오면 그 판에 '늦은 적재'를 표시해 고정하고(`fraud_snapshot.late`) SEV3를 낸다. 고정 뒤에 늦게 온 사건은 다음 판(판매 종료까지 다시 고정하는 판)에 들어간다. 판의 범위는 사건 시각이 아니라 이 작업자가 행을 넣은 시각(`ingested_at`)으로 정하고, 같은 키의 중복은 가장 이른 적재 행만 센다. 그래서 늦게 온 옛 시각의 행이나 다시 들어온 중복이 지난 판의 해시를 바꾸지 않는다(docs/data.md '부정 예매 사후 조사의 표', 추천 적용 2026-10-31).
- **보존**: 행마다 `retain_until`(그 회차 공연일 + 30일 [가정])을 싣는다. 지우기는 ops-svc 파기 작업 `inv-partition-purge`가 `retain_until`이 지난 회차 파티션을 표마다 지우고 결과를 남기는 것이고, 표의 TTL은 보조다. TTL은 백그라운드 병합 때 지워져 지우는 때가 보장되지 않기 때문이다(추천 적용 2026-10-31, ADR-0173). 이 작업자(`inv-ingest`)는 지우지 않는다. 공연 날짜가 바뀌면 정비 잡이 그 회차 파티션의 `retain_until`을 고친다. 조치한 사건의 증거는 증거 묶음(`evidence_bundle`)으로 따로 떼어 분쟁·수사가 끝날 때까지 둔다(ADR-0171 결정 5).
- **용량 [추정]**: 대형 온세일(100만 명) 한 회차에 요청 기록은 사람당 10건 안팎이라 약 1,000만 행, 단계 약 200만 행이다(docs/features/forensic-replay.md §7.2와 같은 추정). T=0 진입 순간의 요청 기록은 초당 약 20만 건 × 약 350바이트(압축 전)로, 노드 에이전트의 Kafka 내보내기를 압축(zstd)하면 텔레메트리 클러스터에 초당 수십 MB가 더 들어간다. 텔레메트리 클러스터의 여유와 파티션 수는 docs/infra.md §4에서 V-T19 부하 시험으로 확인한다(확인 필요). 넘치면 진입(`QUEUE_ENTRY`) 요청 기록만 노드 에이전트에서 묶음 압축을 키운다. 조사 사본은 법정 사본과 다른 filelog 수신기로 읽고 큐가 차면 버리고 센다(`inv_copy_dropped_total`, docs/observability.md §7). 그래서 넘쳐도 법정 접속기록 갈래는 멈추지 않고, 잃는 것은 조사 기록뿐이다(추천 적용 2026-10-31, ADR-0171).

## 7. 키 규칙(ADR-0026 결정 1)

| 토픽 | 메시지 | 키 |
| --- | --- | --- |
| `trade.*` | 거래 사건 | 회차(`eventId`. 한 회차는 토픽마다 한 파티션이고, 순서는 아래 범위만 지켜진다). 정산은 파트너 ID |
| `telemetry.queue` | `QueueAggregate` | '회차:파드' |
| `telemetry.queue` | `QueueEntryRecord` | pid |
| `telemetry.purchase` | `HoldAttempt` | `purchaseSessionId` |
| `telemetry.trust-verdicts` | `TrustVerdict` | `queueEntryId`(없으면 키를 두지 않는다) |
| `telemetry.behavior` | `BehaviorSignal` | pid |
| `telemetry.trust-candidates` | `TrustCandidate` | pid |
| 위 텔레메트리 셋 | `PipelinePulse` | 키 없음, 파티션 직접 지정 |
| `investigation.requests` | `InvestigationRequest`(JSON) | 키 없음(docs/api/asyncapi.yaml, 2026-11-01 정합 점검) |

- 회차 하나의 거래 사건은 토픽마다 한 파티션에 온다. 그래서 `rt.sale_event`의 Kafka 위치 순서가 그 회차의 사건 순서다. 판매 좌석 규칙(§4.3)은 이 전제에 기댄다. 키 규칙을 바꾸면 생산자가 늘어나기만 하는 순번을 실어야 한다(§15).
- 같은 좌석·주문의 사건이 커밋 순서대로 Kafka에 들어가는 것은 Outbox 릴레이의 보내는 규칙이 지킨다(Outbox 행의 `seq` 순서, 트랜잭션 마지막에 넣기, 리더 하나, `SKIP LOCKED` 없이 잠금을 기다리기, docs/data.md §4의 7번, ADR-0116). 서로 다른 좌석 사이의 순서는 커밋 순서와 다를 수 있고, 판매 좌석 규칙은 그 순서를 쓰지 않는다. 확인은 V-T28이다. `trade.seats`에는 생산자가 둘이다(홀드 사건은 좌석 Redis Stream 릴레이, 판매 사건과 `EventSaleChanged`는 purchase-svc Outbox 릴레이). 두 생산자 사이의 순서는 보장하지 않으므로, 받는 쪽은 펜싱 토큰·판 번호·상태 기계로 늦게 온 사건을 거른다(asyncapi info '키와 순서', 추천 적용 2026-10-28, 기술 검토 낮음-025).
- 인기 회차 쏠림: 키가 회차라 인기 회차 하나의 거래 사건은 토픽마다 파티션 하나, 곧 소비자 파드 하나에 몰린다(메시가 공연 ID 해시 분산을 기각한 것과 같은 쏠림, docs/architecture.md §5). 대형 온세일 피크의 한 회차 몫(`SeatEvent` 약 3,000/초, `OrderEvent` 약 1,500/초, §11)을 한 파티션에 넣어, 그 파티션을 맡은 `ops-rt`·`analytics-ingest` 파드가 따라잡는지를 ST-T17(wbs 4.3.3)에서 잰다. 생산자는 운영과 같은 폴링 Outbox 릴레이다(ADR-0116이라 측정 길과 운영 길이 같다).
- 같은 쏠림은 서비스 소비자에게도 온다. purchase-svc 주문 Saga는 `trade.payments` 사건마다 DB 트랜잭션을 하고 발권을 부르므로, 차례대로 처리하면 인기 회차의 결제 확정이 소비자 하나의 처리 속도에 묶인다. 그래서 회차 키는 그대로 두고, 서비스 소비자는 키 단위 동시 처리(§2.4)로 한 파티션 안의 다른 주문을 함께 처리한다(ADR-0142). 인기 회차 결제 결과를 한 파티션에 승인 초당 300건으로 넣어도 결제 확정 p99가 3초 안인지는 P-T48(docs/features/payment.md)이, 같은 키의 순서·커밋 위치·재조정 중 빠짐과 중복 반영이 없는지는 ST-T18이 본다. 키 단위 동시 처리로도 P-T48을 통과하지 못하면 결제 토픽을 주문 키의 새 토픽으로 옮긴다(ADR-0142 되돌릴 조건).
- 파티션 수는 계약(docs/api/asyncapi.yaml)에서 정하고, 줄이지 않는다(devops §7.5). 이 문서의 계산은 토픽마다 파티션 12개 [가정, 4.3.3에서 확정]로 잡았다.

## 8. 복구와 판 올리기

- **장애 복구**: 작업자는 상태가 없다. 다시 뜨면 커밋한 위치부터 읽는다. 다시 읽은 행은 중복으로 들어가고, 읽을 때(`rt`)와 실버(브론즈)에서 지워진다. 재평가는 Redis 키가 남아 있으면 그대로 이어 가고, 지워졌으면 최대 10분의 문맥을 잃는다.
- **판 올리기**: 롤링과 우아한 종료(§2.2)로 한다. 동결 창과 마감 실행 중에는 올리지 않는다(저장소의 배포 정의대로 쿠버네티스를 맞추는 배포 도구인 ArgoCD의 동기화 창, devops §8).
- **원시 표 바꾸기**: 열은 더하기만 하고 기본값을 둔다. 새 열을 읽는 뷰와 작업자를 먼저 배포하고, 생산자(계약 필드)를 나중에 배포한다(devops §6.5).
- **되돌리기**: 이전 이미지로 같은 롤링을 한다. 상태가 없으므로 상태 호환 시험이 따로 필요 없다. 표에 열을 더한 판은 옛 판이 그 표에 그대로 쓸 수 있는지만 본다.

## 9. 운영 확인 표(docs/architecture.md §8.4)

| 확인할 동작 | 사건·필드 | SLI | 대시보드 패널 | 경보(종류·심각도) | 배포 뒤 확인 방법 |
| --- | --- | --- | --- | --- | --- |
| 관제 실시간 표가 5초 안에 반영 | `rt.pulse`, `rt_freshness_seconds{path}` | 신선도 1분 p95 5초 미만(NFR-009) | SCR-029 판매 중 탭 머리 신선도(docs/design/d5 §7.2), 엔지니어 화면 '실시간 표' | 3분 넘게 5초 초과 → Degraded 전환과 SEV3(`kind` hygiene) | 카나리 동안 신선도 p95 비교 |
| 사건을 빠뜨리지 않음 | `stream_rejected_total`, 생산자 버림 수 | 누락률 < 0.1% | 같은 화면 '누락' | 10분 누락률 0.1% 초과 SEV3, 거절 > 0 SEV3 | 배포 전후 누락률 |
| 모르는 열거 기호가 숫자에서 조용히 빠지지 않음(추천 적용 2026-10-28, 기술 검토 중간-087) | `stream_unrecognized_symbol_total{worker, topic, record, field}` | — | '스트림 작업자' 화면 '모르는 기호' | 5분 [가정] 넘게 0보다 크면 SEV3(`kind` hygiene). 그 열거에 기호를 더한 생산자 배포가 소비자보다 먼저 나갔다는 뜻이다 | 생산자 배포 전후 이 수가 0인지 본다 |
| 거래 사건이 끊기지 않음 | 거래 토픽 소비 밀림·마지막 사건 시각, Outbox 릴레이 지연(`outbox_relay_lag_seconds`) | — | '스트림 작업자' 화면 | 온세일 윈도우 안에서 60초 [가정] 넘게 거래 사건이 없으면 SEV3. 릴레이 지연이 5초 [가정]를 1분 넘게 넘으면 SEV2(ADR-0116) | 배포 직후 거래 처리량 |
| 작업자가 멈추거나 되풀이 실패하지 않음 | 재시작 수, 파드 상태 | — | '스트림 작업자' 화면 | 10분 안 재시작 3회 [가정] SEV3 | 롤링 뒤 준비 상태 |
| 삽입이 이어짐 | `stream_insert_retries_total`, `stream_paused_partitions`, `stream_insert_seconds` | — | 작업자별 삽입 | 재시도가 5분 [가정] 넘게 이어지면 SEV3 | 배포 뒤 첫 묶음 성공 |
| 소비가 밀리지 않음 | `stream_consumer_lag_records` | — | '스트림 작업자' 화면 | 10분 동안 계속 늘면 SEV3 | 배포 전후 비교 |
| 조회 시점 집계가 가벼움 | `rt_query_seconds{view}` | 회차당 조회 p95 0.25초 미만 [가정] | '실시간 표' | 10분 넘게 0.25초 초과 SEV3 | 카나리 동안 비교 |
| 재평가가 사람을 한꺼번에 격리하지 않음 | `trust_reassess_candidates_total{pattern}`, `trust_reassess_isolations_total{mode}` | — | 봇 패널 '재평가' | 격리 상한 도달 SEV3 | 그림자 기간 표본 검토 |
| 원본 적재가 빠짐없음 | 마감 커버리지 대조, 적재 거절 기록 | — | 리포트 '데이터 품질' | 마감 보류(analytics §7), 거절 > 0 SEV3 | 마감 리포트 |
| 조사 적재가 기록 고정 전에 따라옴(추천 적용 2026-10-31, ADR-0171) | `stream_consumer_lag_records{worker="inv-ingest"}`, 고정 판의 '늦은 적재' 표시(`fraud_snapshot.late`), `inv_ingest_ref_lookup_failures_total` | — | '스트림 작업자' 화면 '조사 적재' | 고정 대기 30분 [가정] 초과 SEV3, 계정 연결 값 묻기 실패가 10분 [가정] 이어지면 SEV3 | 온세일 뒤 첫 고정 판에 '늦은 적재' 표시가 없는지 |
| 분석 저장소에 조사 칸이 없음(추천 적용 2026-10-31, ADR-0171) | 브론즈 표의 열 목록, `investigation.requests` 소비자 그룹 목록 | — | — | 계약 검사·마이그레이션 검사가 막는다(ST-T22) | 배포 전 CI |

## 10. 시험 포인트

| # | 시나리오 | 합격 기준 | 연결 |
| --- | --- | --- | --- |
| ST-T1 | 같은 거래 사건을 두 번 보내고(`eventKey`가 같다), 처리 중에 `ops-rt` 파드를 강제로 종료한다 | 판매 좌석·금액 누적이 정답과 같다(두 번 세지 않는다) | V-T13, analytics §4.4 |
| ST-T2 | 텔레메트리의 한 파티션에만 사건이 오고 나머지는 비어 있다(심장 박동 켬·끔) | 켬: 1초 칸이 끊기지 않고 신선도가 정상이다. 끔: 1초 칸은 그대로 나오지만 심장 박동이 없는 파티션 때문에 신선도가 나빠져 보이고, 3분 뒤 Degraded로 바뀐다 | V-T14 |
| ST-T3 | 사건을 5초·15초·10분 늦게 보낸다 | 셋 모두 제 1초 칸에 들어간다(버리지 않는다). 이미 그린 칸은 다음 조회에서 고쳐진다 | 4.3.9 |
| ST-T4 | ClickHouse를 30초 멈춘다 | 작업자는 묶음을 버리지 않고 그 파티션 소비를 멈췄다가, 돌아오면 이어 싣는다. 누락은 0이고 그동안 신선도가 나빠져 보인다. 원본 적재는 커버리지 대조에서 빈 구간이 없다 | V-T15 |
| ST-T5 | 한 기기 가명으로 pid 6명이 10분 안에 사전 검증한다. 모드는 그림자다 | 후보 6건, `TrustVerdict` 그림자 6건, 격리 0건 | 4.3.8 |
| ST-T6 | 모드 적용, 격리 상한을 넘는 후보 | 상한까지만 격리되고 나머지는 그림자로 남는다. SEV3가 뜬다. 이미 입장한 사람은 격리되지 않는다 | 4.3.8 |
| ST-T7 | 원시 표를 비운 뒤(복원 사고) 다시 채우기를 돌린다. Kafka 7일 안은 작업자 다시 읽기, 그보다 오래된 판매류는 브론즈에서 채운다 | 누적이 정답과 같다. 겹쳐 실린 행은 결과를 바꾸지 않는다 | 4.3.1, RB-34 |
| ST-T8 | 다른 네임스페이스에서 작업자 파드의 지표 포트가 아닌 포트로 연결한다 | 연결이 막힌다. 작업자에는 관리 API가 없다 | asvs/analytics 13.4.5 |
| ST-T9 | 같은 고정 사건 묶음(판매·반환·입금 되돌림과 다시 입금·부분 취소 포함)을 dbt 모델과 실시간 뷰에 넣는다 | 판매 좌석(전체·등급·구역)·판매 금액·확정 주문·발권 티켓이 골드와 같다. 다시 확정된 주문은 퍼널에 한 번만 들어간다 | 4.3.9, analytics §4.4 |
| ST-T10 | 좌석 하나에 PENDING → SOLD → PENDING(입금 되돌림) → SOLD → RETURNED와 그 중복, 다시 보낸 옛 사건을 보낸다 | 판매 좌석이 +1 → 0 → +1 → 0으로 바뀌고, 중복과 다시 보낸 옛 사건은 무시된다 | 4.3.1 |
| ST-T11 | 사건을 계속 보내면서 작업자를 롤링으로 올린다 | 누적이 끊김 없이 정답과 같다. 새 파드는 커밋한 위치에서 이어 읽는다 | wbs 4.6.2, devops D-T20 |
| ST-T12 | 가명 키 요청(KMS)을 실패하게 함 | 원문을 쓰지 않고 그 파티션에서 멈춰 다시 시도하며, 소비 밀림 경보가 뜬다. KMS가 돌아오면 빠짐 없이 이어 간다 | 4.3.4 |
| ST-T13 | 재평가 문턱을 넘긴 메시지를 처리한 직후, 후보를 발행하기 전에 `trust-reassess`를 강제로 종료한다 | 다시 뜬 뒤 그 메시지를 다시 읽어 문턱 때의 후보 전체를 다시 낸다. trust-svc는 같은 후보를 한 번만 처리한다 | 4.3.8 |
| ST-T14 | MSK IAM 토큰 함수(기술 검토 높음-26). ① 로컬: 흉내 낸 STS로 토큰 함수를 부르고, 역할 신뢰를 거둬 역할을 맡지 못하게 한다. ② 실제 MSK와 EKS Pod Identity: 작업자를 Pod Identity 자격과 MSK 토큰이 각각 한 번 이상 바뀔 때까지 돌린다(만료 시각을 기록해 확인한다) | ①: 맡은 역할의 세션 이름이 늘 `<작업자>-<환경>`이다. 역할을 못 맡으면 기본 자격으로 넘어가지 않고 연결이 실패하며 소비 밀림 경보가 뜬다. ②: 재인증 실패('Cannot change principals during re-authentication')와 연결 끊김이 0건이고 소비 밀림이 늘지 않는다 [확인 필요] | wbs 0.5.1, ②는 선택 보정(docs/verification.md §6, ADR-0154), devops §9.4. ①은 2026-11-01 통과(`test/msk-iam.test.ts`, §2.6, openspec 변경 add-foundation-poc). ②는 실제 MSK·EKS가 있어야 해 소유자 몫이다 |
| ST-T15 | 모르는 열거 기호(기술 검토 중간-087): 작업자가 빌드된 계약 판에 없는 기호(예: `OrderEventType`의 새 상태)를 넣은 새 판 스키마로 사건을 내고, 옛 판으로 빌드한 `ops-rt`·`analytics-ingest`가 읽는다 | 레코드를 거절하지 않는다. `ops-rt`는 `UNRECOGNIZED`로 싣고 `stream_unrecognized_symbol_total`이 늘며 5분 [가정] 뒤 SEV3가 뜬다. 원본 적재는 원래 기호를 그대로 싣는다. 나머지 판매 누적은 정답과 같다 | wbs 0.2.2, docs/api/avro/README.md §3 |
| ST-T17 | 인기 회차 한 파티션(추천 적용 2026-10-28, 기술 검토 낮음-025): 로컬에서 한 회차의 `trade.seats`(약 3,000/초)와 `trade.orders`(약 1,500/초) 사건을 폴링 Outbox 릴레이와 좌석 Redis Stream 릴레이로 30분 [가정] 넣는다. 같은 때 다른 회차 11개는 그 10분의 1로 넣는다 | 그 파티션을 맡은 `ops-rt`·`analytics-ingest` 파드의 소비 밀림이 5초 [가정] 안에 머물고 신선도 p95가 NFR-009 안이다. 파드 하나의 그 파티션 처리량 상한과 CPU를 성능 장부에 '실측(PC)'으로 남긴다. 밀림이 계속 늘면 그 값을 §11의 파드당 처리량과 견주어 키 규칙(§15) 재검토 조건으로 기록한다 | 4.3.3 |
| ST-T16 | 레지스트리 정지(기술 검토 중간-088): 컨테이너 레지스트리를 멈춘 채 ① 작업자 파드를 하나 새로 띄우고 ② 서비스 생산자 파드를 새로 띄워 주문을 만든다. 그 뒤 레지스트리를 되살린다 | ①: 새 파드는 처음 보는 ID에서 그 파티션 소비를 멈추고 다시 시도한다. 거절은 0건이고, 되살린 뒤 빠짐 없이 이어 읽는다. ②: 생산자는 설정의 스키마 ID로 Outbox 바이트를 만들어 주문이 성공하고, 시작 확인 실패 경보(SEV3)만 뜬다 | wbs 0.2.2, G-30 |
| ST-T18 | 키 단위 동시 처리(추천 적용 2026-10-29, ADR-0142): 로컬에서 한 회차의 `trade.payments` 사건을 한 파티션에 넣는다. 주문 수백 개의 사건을 섞고, 같은 주문의 사건 몇 개는 잇달아 넣는다. 처리 중에 소비자 파드를 하나 더 띄워 재조정을 일으키고, 다른 실행에서는 처리 중인 파드를 강제로 종료한다 | 같은 주문의 사건은 넣은 순서대로 반영된다(순서가 뒤집힌 수 0). 커밋 위치는 늘 '그 앞의 사건이 모두 끝난 위치' 이하다. 재조정과 강제 종료 뒤에도 빠진 사건 0건, 두 번 반영한 사건 0건이다(다시 받은 사건은 `eventKey`로 거른다). 파티션마다 동시에 처리한 키 수가 32개 [가정]를 넘지 않는다 | P-T48, wbs 0.5.1. 2026-11-01 통과(`packages/platform` `test-int/keyed-consumer.int.test.ts`, 실제 Kafka 3.9.2와 PostgreSQL, openspec 변경 add-foundation-poc): 파티션 넷·사건 4,000개를 흘리며 소비자를 하나 더 띄우고, 다른 실행에서는 소비자 프로세스를 SIGKILL로 죽였다(그룹을 떠나지 않아 세션 45초 뒤 넘어간다). 둘 다 빠짐 0·두 번 반영 0·같은 주문 순서 뒤집힘 0이고, 커밋 위치를 0.2초마다 떠 '그 앞의 사건이 모두 반영됐다'를 확인했으며(위반 0), 파티션마다 동시에 처리한 키는 32개 이하였다. 같은 시험에 두 경우를 더했다. ① 일시 실패로 멈춘 파티션을 넘긴 뒤 같은 소비자가 다시 받으면 멈춤이 풀려 이어 받는다(배정 때 멈춤 풀기를 빼면 실패한다) ② 처리기가 멈춰 넘기기 기다림 30초 한도를 넘기면 그 파티션을 버리고 끝난 위치까지만 커밋하며, 새 주인이 멈춰 있던 사건부터 다시 받아 빠짐이 없다(이미 반영한 사건은 eventKey로 걸러진다). 끝나지 않은 사건을 넘겨 커밋하도록 깨면 커밋 위치 확인이 위반으로 실패한다 |
| ST-T20 | 소비자 설정 기본값과 직접 넣은 값(로컬, 2026-10-30 실행): Kafka 3.9.2 브로커(공식 컨테이너 한 대, KRaft)에 파티션 6개 토픽을 두고, `@confluentinc/kafka-javascript` 1.11.0의 KafkaJS 호환 소비자 둘을 같은 그룹에 붙인다. ① 값을 주지 않은 그룹 ② 공용 모듈 값(`group.protocol=classic`, 세션 45초, cooperative-sticky)을 넣은 그룹. 소비자 하나가 붙은 뒤 둘째를 붙이고, 둘째를 강제로 죽인다 | ①은 배정 방식 `roundrobin`, 둘째가 들어올 때 첫째가 6개를 모두 내놓음, 죽인 뒤 회복 28.9초. ②는 `cooperative-sticky`, 첫째가 3개만 내놓음, 회복 44.7초. 둘 다 그룹 종류 Classic. 통과 기준: ②에서 첫째가 옮길 파티션만 내놓고, 회복이 세션 45초 ±5초 [가정]이며, 그룹 종류가 Classic이다(2026-10-30 통과) | wbs 0.5.1, ADR-0142 |
| ST-T19 | 보류 사건(추천 적용 2026-10-29, ADR-0142): 한 파티션에 주문 A의 사건 셋과 다른 주문들의 사건을 섞어 넣는다. 주문 A의 첫 사건은 처리기가 늘 예외를 내는 독 사건(계속 실패하는 사건)이다. 다른 실행에서는 저장소 연결을 끊는다 | 독 사건은 5회 [가정] 실패한 뒤 `held_event`로 옮겨지고, 주문 A의 뒤 사건 둘도 함께 보류된다. 다른 주문의 처리는 멈추지 않는다. 결제 토픽 보류 SEV2가 뜬다. 처리기를 고친 뒤 RB-11로 다시 넣으면 주문 A의 사건이 순서대로 반영되고 중복 반영은 없다. 저장소 연결을 끊은 실행에서는 아무것도 보류되지 않고 그 파티션이 멈춰 기다렸다가, 되살리면 이어 처리한다 | RB-11, wbs 0.5.1 |
| ST-T21 | 조사 적재 대응(추천 적용 2026-10-31, ADR-0171): 한 사람의 여정(로비 입장 → 진입 → 입장 확정 → 홀드 경합 패배·홀드 → 주문 → 결제 승인 → 양도 → 입장 스캔)의 사건과 그 요청 기록을 보내고, 같은 묶음을 한 번 더 보낸다 | `inv_step`에 단계 열이 순서대로 하나씩 남고(다시 보낸 묶음은 늘지 않는다), 홀드 시도 행에 좌석과 잡은 시각이, 결제 행에 결제 수단 연결값·BIN이 있다. 대기열 경로 요청 행은 여정이 비어 있어도 (회차, pid)로 그 여정에 이어 읽힌다. `inv_link`에 계정·연락처·기기 가명이 남는다 | FR-072 |
| ST-T22 | 두 갈래 나눔(추천 적용 2026-10-31, ADR-0171 결정 2): 조사 칸이 든 사건을 원본 적재로 싣고, `analytics-ingest` 자격으로 `investigation.requests`를 읽으려 하고, `an_forensic_reader`로 `inv` 표를 읽으려 하고, `inv_ingest`로 분석 표에 쓰려 한다 | 브론즈·실버에 `journeyId`·`deviceRef`·`contactRef`·`paymentMethodRef`·`cardBin` 열이 없다. 토픽 읽기는 MSK 권한 거부, 두 ClickHouse 접근은 권한 오류다 | FR-071 |
| ST-T23 | 기록 고정(추천 적용 2026-10-31, ADR-0171 결정 6): T+60분 고정 직전에 `inv-ingest` 한 파티션을 10분 멈추고, 다른 실행에서는 40분 멈춘다. 같은 입력으로 고정을 두 번 한다 | 10분: 고정이 기다렸다가 빠짐없이 고정한다. 40분: 30분 뒤 '늦은 적재'로 고정되고 SEV3가 뜨며, 늦은 사건은 다음 판에 들어간다. 같은 입력의 두 해시가 같다 | FR-072 |
| ST-T24 | 조사 저장소 보존(추천 적용 2026-10-31, ADR-0171 결정 5): 그 회차 공연일 + 30일 [가정]이 지난 회차와 공연 날짜가 바뀐 회차를 만들고 파기 작업 `inv-partition-purge`를 한 번 돌린다(추천 적용 2026-10-31, ADR-0173) | 지난 회차의 파티션이 표마다 지워지고 `ops_event` `INV_PARTITION_PURGE`(회차·표마다 지운 행 수·결과)가 남으며 그 회차 사건은 증거 묶음만 남는다(리플레이·그래프는 410). 날짜가 바뀐 회차는 새 `retain_until`을 따른다. TTL 병합을 기다리지 않아도 지워진다 | FR-074 |

## 11. 용량 산정

입력량 [추정](대형 온세일 피크):

| 원천 | 초당 | 근거 |
| --- | --- | --- |
| `HoldAttempt` | 약 2,000 | NFR-003 홀드 피크 초당 2,000건 |
| `TrustVerdict` | 약 1,700 | 로비 사람 확인 검증 초당 1,700건(architecture §9.4) |
| `SeatEvent`(홀드 쪽 포함, 거르기 전) | 약 3,000 | 홀드 피크 + 판매 |
| `OrderEvent` | 약 1,500 | 결제 300 TPS × 주문 상태 약 5개(TPS: 초당 처리 건수) |
| `TicketEvent`, `PaymentEvent` | 약 1,800 | 발권(주문당 1~4매)과 결제 사건 |
| `QueueAggregate`, 심장 박동 | 약 200 | queue-svc 파드 수, 입장 초당 약 28명, 3개 토픽 × 12 파티션 |
| 합 | 약 1만 | NFR-009 시험 부하(초당 3만 건)는 이 값의 약 3배다 |

- 위 표는 관제 실시간 표와 원본 적재의 입력이다. 텔레메트리 클러스터 전체의 피크는 초당 약 5,600건이다 [추정]. 홀드 시도 약 2,000, 판정 약 1,700, 1초 집계와 심장 박동 약 200에, 재평가 작업자가 읽는 `BehaviorSignal` 약 1,700(§5.8의 '10분 피크 신호 약 100만 개')을 더한 값이다. 2026-10-29 전 문서의 '약 4천 건'은 `BehaviorSignal`을 빠뜨린 값이다(추천 적용 2026-10-29, ADR-0141 결정 6).
- `QueueEntryRecord`(사람별 대기 기록)는 대기가 끝날 때 사람마다 한 건이라, 매진 순간에 한꺼번에 생긴다. queue-svc는 파드마다 초당 2,000건 [가정]으로 나눠 보낸다. 버퍼가 차서 버린 수는 `telemetry_dropped_total{record}`로 세고(§2.6), 분석은 커버리지 대조로 그 빈 곳을 표시한다(docs/features/analytics.md §7). 나눠 보내는 동안 분석 적재가 그만큼 늦다(ADR-0141 결정 6).
- 작업자 2개가 토픽마다 파티션 12개를 나눠 읽는다. 시험 부하에서는 파드 하나가 초당 약 1만 5천 건을 Avro로 읽고 묶어 넣어야 한다. Node.js 소비자 하나는 한 스레드라 이 값을 낼 수 있는지 4.3.9에서 잰다 [가정]. 모자라면 복제를 파티션 수까지 늘린다.

원시 표 크기 [추정](대형 회차 하나):

| 표 | 행 수 | 근거 |
| --- | --- | --- |
| `rt.sale_event` | 약 27만 | 판매류 사건(좌석 판매 상태·주문·결제·발권) |
| `rt.hold_attempt` | 약 720만 | 홀드 피크 초당 2,000 × 온세일 1시간 [가정] |
| `rt.verdict` | 약 610만 | 판정 초당 1,700 × 로비·온세일 1시간 [가정] |
| `rt.queue_aggregate` | 약 14만 | 파드 40개 × 3,600초 [가정] |
| `rt.pulse` | 하루 약 310만(전체) | 3개 토픽 × 12 파티션 × 86,400초 |

- 조회 비용 [추정]: 누적 뷰는 회차의 판매류 행(대형 회차 약 27만)을 `eventKey`로 묶어 센다. 한 번에 수십 ms로, 회차마다 0.5초에 한 번이면 회차당 코어 0.1개 안팎이다. 1초 칸 뷰는 최근 몇 분만 읽는다(홀드 초당 2,000 × 60초 = 약 12만 행). 이 어림은 V-T12에서 `rt_query_seconds`로 확인하고, 한계는 V-T19로 찾는다.
- 재평가 Redis는 약 100MB다 [추정](§5.8).

## 12. 실패 처리

| 장애 | 작업자의 동작 | 화면과 경보 | 회복 |
| --- | --- | --- | --- |
| 텔레메트리 MSK 장애 | 텔레메트리 소비가 멈추고 심장 박동도 끊긴다. 거래 누적은 이어진다 | 신선도가 나빠지고 3분 뒤 Degraded 전환, SEV3 | Kafka가 돌아오면 커밋 위치에서 이어 읽는다 |
| 거래·제어 MSK 장애 | 판매 누적이 멈춘다. 심장 박동은 텔레메트리 쪽으로 지나므로 신선도는 정상으로 보인다. 결제 확정은 멈추지 않는다. 결과 사건이 5초 [가정] 안에 오지 않으면 purchase-svc가 payment-svc `BatchGetPayments`로 직접 묻는다(당기기, ADR-0140). 확정 지연이 5~10초 [추정] 늘고, 결제 확인 알림과 설정형 명령·세션 종료 전파·홀드 원장 적재는 Kafka가 돌아올 때까지 늦다 | 온세일 중 거래 사건 60초 없음 경보(SEV3), Outbox 릴레이 지연(SEV2, 릴레이가 보내지 못해 Outbox 표에 쌓인다), 당기기로 반영한 수(`payment_result_pulled_total`)가 1분 동안 0보다 크면 SEV3(docs/observability.md §5), 브로커 경보(`OfflinePartitionsCount` 등, ADR-0141 결정 4) | 위와 같다. 그동안 판매 숫자 옆에 '거래 사건 끊김'을 보여 준다. MSK가 돌아오면 릴레이가 쌓인 행을 `seq` 순서로 이어 보낸다. 당기기로 이미 반영한 결제의 사건은 순번 비교로 건너뛴다. 따라잡는 시간은 Game Day G-31에서 잰다 |
| Schema Registry 장애 | 캐시한 스키마 ID는 계속 읽는다. 처음 보는 ID(새로 뜬 파드는 모두 처음이다)는 거절하지 않고 그 파티션 소비를 멈춰 다시 시도한다. 생산자(서비스·rt-pulse)는 실행 중에 레지스트리를 부르지 않아 영향이 없다(docs/api/avro/README.md §3 '생산자 스키마 ID', 추천 적용 2026-10-28, 기술 검토 중간-088) | 소비 밀림·멈춘 파티션 SEV3, 신선도가 나빠지면 Degraded | 레지스트리를 되살리면 커밋 위치부터 이어 읽는다. 빠진 레코드는 없다(RB-34, G-30) |
| ClickHouse 장애 | 작업자가 그 파티션 소비를 멈추고 다시 시도한다(버리지 않는다). 조회도 실패한다 | 삽입 재시도·소비 밀림 SEV3, 신선도 악화와 Degraded | 회복하면 밀린 것을 이어 싣는다. 누락은 없다 |
| Redis 장애(재평가) | 스크립트가 실패해 그 파티션 소비를 멈추고 다시 시도한다 | 소비 밀림 SEV3 | 회복하면 이어 간다. 키가 지워졌으면 최대 10분 문맥을 잃는다 |
| KMS 장애(원본 적재) | 가명 키를 못 얻어 그 파티션에서 멈추고 다시 시도한다(원문은 쓰지 않는다) | 소비 밀림 경보 | KMS가 회복되면 이어 간다 |
| 작업자 파드 장애 | 남은 파드가 재조정으로 파티션을 넘겨받고 커밋 위치부터 읽는다 | 재시작 수, 신선도 잠깐 악화 | 다시 읽은 행은 읽을 때와 실버에서 중복으로 지워진다 |
| 읽지 못한 레코드 | 원본 적재는 거절 기록을 남기고, 나머지는 거절 수만 센다 | 거절 > 0 SEV3 | 코드를 고쳐 Kafka 보관 기간 안에 다시 적재한다 |
| 조회 시점 집계가 느려짐 | 콘솔 숫자가 늦게 바뀐다 | 조회 시간 경보 SEV3, 신선도가 나빠지면 Degraded | 미리 합산(§4.8)이나 회차별 조회 묶기, 그래도 안 되면 바꿀 조건 1(§16) |
| 시계 차이 | 심장 박동의 발행 시각은 `rt-pulse`가 도는 노드의 시계 기준이다 | 노드 시계 오프셋 경보(20ms, observability §5) | — |

## 13. 이미지·배포·시험 도구

- **코드 위치**: 모노레포(코드 전부를 저장소 하나에 폴더로 나눠 담는 방식) `peaket`의 `services/analytics-ingest`·`services/ops-rt`·`services/rt-pulse`·`services/trust-reassess`·`services/inv-ingest`(`inv-ingest`는 2026-11-01 정합 점검, §1)에 작업자를 두고, `rt` 표·뷰의 이전 파일은 `data/`(예: `data/clickhouse/rt/`)에 둔다. 공용 소비 모듈은 `packages/platform`의 `@peaket/stream-worker`(하위 내보내기 `@peaket/platform/stream-worker`)이고, 패키지로 게시하지 않고 `workspace:` 프로토콜로 가져다 쓴다(ADR-0165). 빌드는 서비스와 같은 pnpm·TypeScript로 한다(추천 적용 2026-10-27).
- **이미지**: 서비스와 같은 Node.js 기본 이미지(다이제스트 고정)를 쓴다. 공용 빌드 워크플로가 SBOM(소프트웨어에 들어간 부품 목록)·서명·출처 증명(어느 커밋에서 어떤 빌드 절차로 만들었는지 서명해 남긴 기록)을 붙인다(devops §4). 클러스터 입장 정책이 그 서명을 확인한다.
- **차트**: 서비스와 같은 공용 차트가 Deployment, 서비스 계정, 네트워크 정책, ExternalSecret, PodMonitor, PodDisruptionBudget을 만든다. 환경 값은 `envs/<환경>/<작업자>.yaml`(이미지 다이제스트, 복제 수, 자원)이고, AppProject는 `data`·`trust`다(devops §5.2).
- **배포 흐름**: 작업자 코드를 바꾸는 `peaket` PR(코드 변경을 합쳐 달라는 요청) → CI(코드를 올릴 때마다 자동으로 하는 검사·빌드. 바뀐 범위의 단위·통합·계약 시험, ADR-0165) → 이미지 다이제스트 갱신 PR → ArgoCD 동기화(동결 창에는 막힌다) → 롤링 → 확인(준비 상태, 첫 묶음 성공, 신선도, 누락률).
- **시험**:
  1. 단위: 소비 모듈의 커밋 순서(쓰기 성공 전에는 커밋하지 않는다), 다시 시도와 멈춤, 거절, 재조정 중 처리를 본다. 재평가 Lua 스크립트(문턱, 넘음 표시, 다시 읽을 때 다시 내기)는 컨테이너(앱과 실행 환경을 한 묶음으로 만든 실행 단위)로 띄운 실제 Redis로 본다.
  2. 뷰: 고정 사건으로 매개변수 뷰의 결과를 정답과 맞춘다(ST-T9·T10, ClickHouse 컨테이너).
  3. 통합: 컨테이너로 띄운 Kafka, Schema Registry, ClickHouse, Redis로 ST-T1~T4·T7·T11~T13을 돌린다.
  4. 계약: Avro 호환은 `contract-check`(BACKWARD_TRANSITIVE)가 지난 출시 태그의 스키마를 모두 올린 로컬 레지스트리 컨테이너로 본다(ADR-0165). 열거 규칙(맨 앞 `UNRECOGNIZED`와 기본값, 기호 지우기 금지)도 같은 검사가 본다(추천 적용 2026-10-28, 기술 검토 중간-087·088). `PipelinePulse` 건너뛰기와 새 필드(`firstInStage`·`firstHeldInSession`)는 소비자 계약 시험으로 본다.
  5. 성능: docs/verification.md §3.7(V-T12~V-T15, V-T19).

## 14. 대시보드·경보·런북

- **대시보드 '스트림 작업자'**(지표와 로그를 그래프로 보여 주는 도구 Grafana, 작업자마다): 파드 상태와 재시작 수, 파티션별 소비 밀림(`stream_consumer_lag_records`), 멈춘 파티션 수(`stream_paused_partitions`), 묶음 삽입 시간·재시도(`stream_insert_seconds`·`stream_insert_retries_total`), 거절 수(`stream_rejected_total`), 뷰별 조회 시간(`rt_query_seconds`), 신선도(`rt_freshness_seconds{path}`), 파티션별 심장 박동 수, 재평가(후보·격리·상한).
- **경보**: §9 표의 경보를 observability §5의 '스트림 작업자 신호'로 둔다. 모두 SEV3(`kind` hygiene, 재평가 상한만 control)이다. 운영 명령이 아니라 엔지니어 호출과 런북으로 이어진다. 관제 실시간 표가 낡으면 Degraded 전환은 자동으로 일어난다.
- **런북**: RB-34 '스트림 작업자 복구'(infra §10): ① 파드 상태, 재시작, 소비 밀림, 삽입 재시도, 거절 수로 멈춤·되풀이 실패·의존성 장애를 가른다 ② 의존성 장애면 회복을 기다린다. 작업자는 커밋하지 않고 멈춰 기다린다(표 §12) ③ 코드 문제면 이전 이미지로 되돌린다. 상태가 없어 그대로 이어 간다 ④ 원본 적재의 빈 구간과 거절 구간을 Kafka 보관 기간 안에 다시 적재하고, 실시간 원시 표를 잃었으면 다시 채운다(§4.7) ⑤ 마감 리포트의 실시간 대비 대조와 커버리지를 확인한다.

## 15. 남는 한계

- 조회 시점 집계의 비용은 측정 전 [추정]이다(§11, V-T12·V-T19).
- 판매 좌석의 순서는 회차 하나의 거래 사건이 한 파티션에 온다는 키 규칙(§7)에 기댄다. 키 규칙을 바꾸면 생산자가 늘어나기만 하는 순번을 실어야 한다.
- 서비스 소비자의 키 단위 동시 처리(§2.4)에서도 같은 주문의 사건은 차례대로라, 한 주문 안의 느린 처리는 그 주문만큼 늦다. 보류된 사건을 다시 넣기 전까지 그 주문은 멈춰 있다. 결제 확정이면 당기기(ADR-0140)가 상태를 다시 맞추지만, 보류 원인이 처리기 오류면 같은 오류를 낸다(ADR-0142).
- 퍼널의 '처음' 표시가 틀리면 퍼널도 틀린다. 생산자(purchase-svc)의 규칙이 지표 사전과 같은지는 ST-T9(골드 대조)로만 확인한다. 지표 사전이 바뀌면 뷰 규칙과 생산자 규칙도 같은 PR에서 바꾼다.
- 재평가 상태는 세션·캐시 Redis에 있다. Redis 장애나 메모리 정리로 키가 지워지면 최대 10분의 문맥을 잃는다.
- Node.js 소비자의 파티션당 처리량: 2026-11-01 PoC에서 키 단위 소비 방식(파티션 여섯을 넷씩 함께, 파티션마다 32키, 처리기 1ms)으로 초당 4만 3천~5만 1천 건였다(ADR-0176 결정 5). 실제 처리기(DB 트랜잭션)를 단 처리량은 wbs 4.3.9에서 잰다.
- MSK IAM 재인증 실패는 전용 역할과 고정 세션 이름(§2.3·§2.6)으로 피하도록 짰다. 자바 클라이언트 README가 안내하는 우회와 같은 원리지만, JavaScript 클라이언트(기본 `@confluentinc/kafka-javascript`, 대체 kafkajs)로 자격 갱신 주기를 넘겨 이어지는지는 아직 확인하지 않았다. 확인에는 실제 MSK와 EKS가 있어야 하고, 포트폴리오는 운영 클러스터를 띄우지 않는다(ADR-0057). 그래서 선택 클라우드 보정에서 작은 MSK(kafka.t3.small 2대)와 EKS를 9시간 [가정], 약 3.5달러로 띄워 확인한다(docs/verification.md §6, 소유자 결정 2026-10-30, ADR-0154). 확인 전까지 이 규칙은 원문 근거의 설계로만 둔다(ST-T14, docs/review/open-items.md 42번).
- 심장 박동 신선도는 텔레메트리 경로만 잰다. 거래 쪽 앞단 지연과 끊김은 Outbox 릴레이 지연 지표, 거래 토픽 소비 밀림, 60초 무사건 경보로 본다. Outbox 릴레이의 순서 보장은 '같은 주문·좌석의 트랜잭션은 잠금으로 줄을 선다'와 'Outbox 행은 마지막에 넣는다'에 기댄다. 이 규칙을 어긴 코드는 V-T28과 코드 검토로만 잡는다(ADR-0116). Prometheus 판단 숫자의 신선도는 제어 입력 없음 규칙(ADR-0069)으로 본다.
- R1은 공용 기기(PC방, 가족 태블릿)를 잡을 수 있다. 격리는 추가 검증이라서 사람은 통과한다. 상한과 그림자 모드 시작으로 피해 규모를 묶어 둔다.
- R2는 녹화한 움직임을 재생하면서 잡음을 섞는 봇을 놓친다. CEP를 쓰지 않으므로 순서 패턴은 브라우저 요약값(입력 간격 분산)과 서버 쪽 신호에만 기댄다.
- 수치(묶음, 조회 주기, 복제·자원, 보존, 패턴 숫자, 격리 상한, 지연 예산, 파티션 수)는 [가정]이고, 4.3.8·4.3.9·V-T19와 그림자 기간의 표본 검토에서 정한다.
- 조사 적재(§6.4)는 대기 상태 파일 조회처럼 게이트웨이를 지나지 않는 요청을 보지 못하고, 노드가 갑자기 사라지면 그 노드에서 아직 보내지 못한 요청 기록을 잃는다(법정 사본 갈래와 같은 한계, docs/observability.md §7). 진입 피크의 텔레메트리 클러스터 부담은 확인 필요다(추천 적용 2026-10-31, ADR-0171).

## 16. 대안과 바꿀 조건(ADR-0099)

2026-10-27에 Flink 잡 셋(ADR-0071·0072)을 이 설계로 바꿨다. 대안별 자세한 비교는 ADR-0099 '검토한 대안'에 있다. 아래는 요약이다.

| 대안 | 가장 큰 장점 | 가장 크게 걸리는 점 | 판단 |
| --- | --- | --- | --- |
| 이 설계(TypeScript 스트림 작업자 + 조회 시점 집계 + Redis) | 이미 있는 부품과 한 언어. 판매 숫자가 확정 숫자와 같은 사건·키·SQL에서 나온다 | 읽을 때 계산하는 비용, 소비자의 정확성을 우리 코드가 맡는다 | 고른다 |
| Flink 잡 셋(이전 설계) | 규모가 크게 늘어도 같은 구조로 간다. 사건 시각 처리·상태 복구·과거 재계산이 엔진에 있다 | 자바 업무 코드(규칙이 세 언어에 나뉨), 워터마크·시작값·세이브포인트(업그레이드 때 남기는 작업 상태 저장본) 장치, 운영 자원 약 3배 | 바꿀 조건이 오면 다시 본다 |
| Flink SQL만, 관리형 Flink(클라우드 업체가 운영하는 Flink) | 규칙을 SQL로 쓰거나 실행 기반 운영을 맡긴다 | ClickHouse 커넥터는 DataStream만, 가명 처리는 자바 함수, Flink 장치는 그대로 | 엔진이 필요하면 Flink의 첫 형태로 본다 |
| RisingWave(러스트로 만든 스트리밍 데이터베이스) | 자바 없이 SQL, 들어올 때마다 고쳐 두는 뷰 | 운영할 분산 시스템이 하나 더, KMS 가명 처리를 안에서 못 한다 | 바꿀 조건 1·4에서 Flink SQL과 함께 본다 |
| Kafka Connect(Kafka의 데이터를 다른 저장소로 옮기는 도구) + ClickHouse 머티리얼라이즈드 뷰 | 적재 코드를 짜지 않는다 | 가명 처리에 자바 변환기, 데드 레터가 원문을 복제, 뷰가 Kafka 안의 중복을 두 번 더한다 | 쓰지 않는다 |
| ClickHouse만(Kafka 엔진 + 뷰) | 새 부품이 없다 | 가명 처리 전 식별값이 ClickHouse에 들어가고, 뷰가 중복을 센다 | 미리 합산(§4.8)에만 |
| Kafka Streams·ksqlDB·Spark(다른 스트림 처리 도구) | 성숙한 도구 | 모두 JVM이고 Flink보다 나은 점이 없다 | 쓰지 않는다 |

바꿀 조건(이 설계에서 스트리밍 엔진으로) [가정, 숫자는 V-T19로 정한다]:

1. 조회 시점 집계가 신선도 목표를 위협할 때: 회차당 조회 p95가 조회 주기의 절반(0.25초)을 넘거나, 온세일 중 ClickHouse CPU가 경보 기준을 넘을 때다. 먼저 미리 합산(§4.8)과 회차별 조회 묶기를 하고, 그래도 넘으면 엔진으로 간다.
2. 순서 패턴(CEP)이나 세션 창이 필요해질 때(§5.7): 그때는 Flink SQL의 `MATCH_RECOGNIZE`(순서 패턴을 SQL로 찾는 구문)가 진짜 이유가 된다.
3. 여러 흐름을 시간 기준으로 맞붙이는 실시간 기능이 생길 때: 예를 들어 결제·좌석·봇 신호를 합친 실시간 위험 점수다.
4. 재평가 상태가 Redis 예산을 넘거나, 입력이 초당 수십만 건으로 커질 때다.

그때는 Flink SQL(관리형 포함)과 RisingWave를 그 시점의 사실로 다시 비교한다.

## 17. 참고 자료(2026-10-27 확인)

- Kafka·Schema Registry 클라이언트: [confluent-kafka-javascript](https://github.com/confluentinc/confluent-kafka-javascript)(README·MIGRATION.md: librdkafka 기반, KafkaJS 모양의 설정, OAUTHBEARER 토큰 함수), npm `@confluentinc/kafka-javascript` 1.11.0·`@confluentinc/schemaregistry` 1.11.0, [aws-msk-iam-sasl-signer-js](https://github.com/aws/aws-msk-iam-sasl-signer-js)(1.0.3, 기본 자격 사슬·`generateAuthTokenFromRole`·자격 공급자 지정. 2026-10-28에 v1.0.3 소스 `src/mskCredentialProvider.ts`·`src/getMSKAuthToken.ts`를 확인했다: 역할은 AWS SDK `fromTemporaryCredentials`로 맡고 세션 이름을 주지 않으면 `MSKSASLDefaultSession`이며, 역할을 못 맡으면 예외를 던진다. 토큰 수명은 자격의 남은 시간과 900초 가운데 짧은 쪽이다)
- MSK IAM 재인증: [aws-msk-iam-auth README](https://github.com/aws/aws-msk-iam-auth)의 문제 해결 절 'Failure during re-authentication due to session name change (EKS Pod Identity/Other Credential Providers)'(전용 역할과 고정 세션 이름 `awsRoleArn`·`awsRoleSessionName`, `awsStsRegion`, 역할을 못 맡을 때 기본 자격으로 넘어가지 않게 하는 `awsAddDefaultProviders="false"`), 같은 저장소의 v2.3.9 릴리스 노트(2026-09-24, 기본 자격으로 넘어갈 때 경고를 남김), AWS SDK for JavaScript v3 소스 `packages/credential-providers/src/fromTemporaryCredentials.ts`(맡을 때 쓰는 자격을 주지 않으면 Node 기본 자격 사슬로 STS를 부른다). 모두 2026-10-28 확인(기술 검토 높음-26)
- ClickHouse: [Node.js 클라이언트](https://github.com/ClickHouse/clickhouse-js)(npm `@clickhouse/client` 1.24.1), [CREATE VIEW](https://clickhouse.com/docs/sql-reference/statements/create/view)(매개변수 뷰), [Deduplicating inserts on retries](https://clickhouse.com/docs/guides/developer/deduplicating-inserts-on-retries)(`deduplicate_insert` 26.2부터 기본 켬, `insert_deduplication_token`, 뷰 대상까지 중복 거르기), [Asynchronous inserts](https://clickhouse.com/docs/optimize/asynchronous-inserts)(쓰기 조건, 적응형 시간, `wait_for_async_insert`), [Incremental materialized view](https://clickhouse.com/docs/materialized-view/incremental-materialized-view)(넣는 묶음에만 도는 트리거, 다시 채우기), [Refreshable materialized view](https://clickhouse.com/docs/materialized-view/refreshable-materialized-view), [Kafka 엔진](https://clickhouse.com/docs/engines/table-engines/integrations/kafka)(`AWS_MSK_IAM`), 소스 `src/Core/Settings.cpp`(`materialized_views_ignore_errors` 기본 끔: 뷰 오류가 원본 삽입을 실패시킨다), [Kafka Connect Sink](https://clickhouse.com/docs/integrations/kafka/clickhouse-kafka-connect-sink)와 [clickhouse-kafka-connect DESIGN.md](https://github.com/ClickHouse/clickhouse-kafka-connect/blob/main/docs/DESIGN.md)(1.7.0, 정확히 한 번 기본 꺼짐·KeeperMap 상태·같은 묶음 다시 보내기, 데드 레터)
- Apache Kafka 소스: `connect/runtime` `SinkConnectorConfig`(데드 레터 토픽은 싱크·변환·변환기에서 실패한 메시지를 받는다), `connect/transforms`(기본 변환 16종, MaskField는 빈 값이나 정해 둔 값으로 덮는다, InsertField의 `offset.field`)
- [Debezium FAQ](https://debezium.io/documentation/faq/)(Kafka Connect가 갑자기 멈추면 같은 사건을 다시 보낼 수 있고, 소비자는 중복을 전제해야 한다). 2026-10-28부터 Outbox 릴레이는 Debezium이 아니라 폴링 릴레이지만(ADR-0116), 보낸 뒤 표시하기 전에 멈추면 같은 행을 다시 보내므로 중복 전제는 같다
- RisingWave: GitHub 릴리스 3.1.0(2026-09-21)·저장소 정보(Apache-2.0), 문서 [Architecture](https://docs.risingwave.com/get-started/architecture)(서빙·스트리밍·메타·압축 노드, 객체 저장소), [Kafka](https://docs.risingwave.com/ingestion/sources/kafka)(Avro·Schema Registry), Amazon MSK(`AWS_MSK_IAM`), [ClickHouse 싱크](https://docs.risingwave.com/integrations/destinations/clickhouse)(복구 중 중복 쓰기, ReplacingMergeTree 권장), [JavaScript UDF](https://docs.risingwave.com/sql/udfs/use-udfs-in-javascript)(내장 QuickJS, 외부 네트워크 없음)
- Apache Flink 2.2 문서: [MATCH_RECOGNIZE](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/table/sql/queries/match_recognize/), [Python API](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/python/overview/). 2026-10-20에 확인한 Flink·Operator·ClickHouse Flink 커넥터 사실은 ADR-0071·0072에 있다
- AWS 문서: [What is Amazon Managed Service for Apache Flink?](https://docs.aws.amazon.com/managed-flink/latest/java/what-is.html)(자바·스칼라·Python·SQL), [MSK Connect](https://docs.aws.amazon.com/msk/latest/developerguide/msk-connect.html), [Configure clients for IAM access control](https://docs.aws.amazon.com/msk/latest/developerguide/configure-clients-for-iam-access-control.html)
