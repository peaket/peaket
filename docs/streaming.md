# 스트림 처리 설계(Flink): 관제 실시간 표, 봇 대기 중 재평가, 원본 적재

- **독자와 용도**: 데이터 엔지니어링·봇 탐지·플랫폼 담당자가 Flink(흘러드는 이벤트를 실시간으로 계산하는 스트림 처리 엔진) 잡 세 개(`analytics-ingest`, `ops-rt`, `trust-reassess`)와 실행 기반을 만들고 운영할 때 읽는 기준 문서다. 원본 적재의 표와 마감은 [features/analytics.md](features/analytics.md), 봇 판정은 [features/queue-admission.md](features/queue-admission.md) §7, 관제 화면은 [features/control-tower.md](features/control-tower.md), 경보와 지표 출처 표는 [observability.md](observability.md) §5·§8에서 다룬다.
- **원본 출처**: 설계서의 Flink 서술(관제 1초·10초 창, 세션 윈도우·CEP)은 한두 줄이었다. 이 문서의 규칙은 2026-10-20 Flink 설계 검증 뒤 정했고([ADR-0071](adr/0071-flink-design-verification-rt-upsert-heartbeat-bot-reassess.md)), 같은 날 연산자·설정·표·용량·실패 처리·배포 수준으로 자세히 정했다([ADR-0072](adr/0072-flink-detailed-design-operators-config-capacity-operations.md)).
- **기준 기획 버전**: v1.0. 작성 2026-10-20.
- **표시 규칙**: 방향은 소유자 승인(2026-10-20, 봇 탐지는 A안. 같은 날 "flink 설계쪽도 구체화 해주세요")이고, 잡 이름·연산자·표 모양·설정값·패턴은 추천 적용(2026-10-20)이다. 그중 검토 목록 네 가지(병렬도 4와 `ops-rt`의 JobManager 2대(대기 1대)·예비 TaskManager 1대, 체크포인트 허용 실패 3회, 상태 수명(판매류 중복 제거 7일, 좌석 판매 상태 180일), Flink 잡 경보의 장애 심각도 등급 SEV3)는 같은 날 소유자가 "추천대로 가주세요"로 승인했다(ADR-0072 상태 줄). ADR-0071의 검토 목록(재평가 기본 그림자와 적용 전환은 commander가 명령 5로, 재평가 격리 상한 대기 인원의 0.5%/10분, 패턴 기준(10분 안 기기 공유 5명·같은 요약값 20명), 관제 실시간 표 신선도 경보 SEV3, Flink 2.2.x 고정, 관제 실시간·재평가 잡은 온디맨드이고 원본 적재만 Spot)도 같은 날 "네"로 승인했다(ADR-0071 상태 줄). 측정으로 정할 값은 [가정, … 확정], 계산한 어림값은 [추정]으로 적는다. 외부 제품 사실은 2026-10-20에 원문으로 확인했고, 출처는 §16에 있다.

## 1. 잡 목록

| 잡 | 저장소 | 하는 일 | 입력 | 시간 기준 | 상태 | 출력 | 전달 보장 | 자원 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `analytics-ingest` | peaket-data | 원본 적재, 회차별 가명, 금지 필드 제거(analytics §3) | analytics §3.1의 토픽(메시지를 종류별로 모아 두는 통로) 10개(거래·제어 클러스터 7개, 시스템이 내보내는 지표·로그·요청 기록 같은 운영 신호인 텔레메트리 클러스터 3개) | 쓰지 않는다(창이 없고, 이 시각보다 이른 사건은 다 왔다고 보는 기준 시각인 워터마크도 없다) | 없다(소스 위치만 있다) | 브론즈, 적재 거절 기록 | 적어도 한 번. 중복은 실버가 지우고, 빠짐은 커버리지 대조(§6)가 잡는다 | Spot(싸지만 회수될 수 있는 클라우드 서버) 허용 |
| `ops-rt` | peaket-data | 관제 실시간 표(§4) | 거래·제어 클러스터의 `trade.orders`·`trade.payments`·`trade.seats`·`trade.tickets`·`trade.purchase-sessions`, 텔레메트리 클러스터의 `telemetry.queue`(`QueueAggregate`)·`telemetry.purchase`·`telemetry.trust-verdicts` | 누적은 처리 시각, 1초 칸은 이벤트 시각 | 중복 제거, 좌석 판매 상태, 첫 홀드(좌석을 잠시 잡아 두는 것), 누적, 칸 | `rt.cumulative`, `rt.bucket`(심장 박동은 두 표의 `_pulse` 행) | 상태는 체크포인트(작업 상태를 주기적으로 저장해 두는 지점. 장애가 나면 여기서 다시 시작한다)로 한 번만 반영한다. 표는 덮어쓰기라 다시 써도 같다 | 온디맨드(정가로 계속 쓰는 서버), 예비 TaskManager 1대 |
| `trust-reassess` | peaket-trust | 봇 대기 중 재평가와 행동 신호 원시 적재(§5) | 텔레메트리 클러스터의 `telemetry.behavior` | 처리 시각(상태 수명 10분 [가정]) | 기기별·지문별 pid 목록 | `telemetry.trust-candidates`, 행동 신호 원시 표(30일) | 적어도 한 번. 후보는 `eventKey`로 중복 제거 | 온디맨드 |

- `rt-pulse`(peaket-data)는 Flink 잡이 아니다. 1초마다 §3의 토픽 셋의 모든 파티션(토픽을 나눈 칸)에 `PipelinePulse`를 쓰는 작은 Deployment(복제 1개 [가정])다. 이것이 멈추면 신선도가 나빠진 것으로 보이므로 따로 감시하지 않는다.
- 세 잡은 상태를 서로 나눠 쓰지 않는다. 한 잡이 멈춰도 다른 잡과 거래 경로(Outbox, Saga)는 영향을 받지 않는다. Outbox는 보낼 이벤트를 같은 트랜잭션으로 표에 적어 두었다가 나중에 보내는 방식이다. Saga는 여러 서비스에 걸친 일을 단계별로 처리하고, 중간에 실패하면 앞 단계를 되돌리는 방식이다.
- Kafka(이벤트를 순서대로 쌓아 두고 여러 곳에 나눠 주는 메시지 시스템)는 MSK(클라우드 업체가 운영해 주는 관리형 서비스) 클러스터 두 개(거래·제어, 텔레메트리)다(infra §1). 잡은 클러스터마다 소스를 하나씩 둔다.

## 2. 실행 기반

### 2.1 버전과 산출물(2026-10-20 고정)

| 구성요소 | 버전·산출물 | 이유 |
| --- | --- | --- |
| Apache Flink | 2.2.x, 공식 이미지(Java 17)를 다이제스트로 고정 | 최신 안정판 2.3.0은 Kafka 커넥터가 아직 지원하지 않는다 |
| Flink Kafka 커넥터 | `flink-connector-kafka` 5.0.0-2.2 | 2.1.x·2.2.x 호환 |
| Flink Kubernetes Operator | 1.16.1 | 2.3.x~1.19.x 호환, `flinkVersion: v2_2` 지원 |
| Java | 17 | ClickHouse(대량 이벤트 집계에 강한 분석용 데이터베이스) 커넥터의 Flink 2.0 이상용 묶음이 요구한다 |
| ClickHouse 공식 Flink 커넥터 | `flink-connector-clickhouse-2.0.0` 묶음 | 제공사가 시험한 Flink는 2.0.0·2.0.1이다. 2.2에서의 동작은 확인 필요이고, wbs 4.3.1 PoC(본 개발 전에 위험한 부분만 먼저 만들어 확인하는 시험)로 본다. 안 되면 Flink 1.20 LTS(Kafka 커넥터 3.4.0, 커넥터 1.17 묶음)로 내린다 |
| Confluent 레지스트리 Avro | `flink-avro-confluent-registry` 2.2.x | Schema Registry는 Confluent다(api/guidelines) |
| S3 파일 시스템 | `flink-s3-fs-presto` 플러그인 | Flink 문서가 S3(클라우드 파일 저장소)에 체크포인트를 둘 때 권하는 구현이다 |
| MSK IAM 인증 | `aws-msk-iam-auth`(잡 JAR에 넣는다) | MSK IAM 인증(wbs 2.11.2) |

- 버전은 Renovate가 올리고, 공통 조치 기한(POL-041, asvs/analytics 15.1.1)을 따른다. Flink 마이너 버전 올리기는 세이브포인트(업그레이드나 되돌리기 때 일부러 남기는 작업 상태 저장본) 호환 시험(§13)을 통과한 뒤에만 한다.

### 2.2 배포

- 잡마다 FlinkDeployment를 하나씩 둔다(애플리케이션 모드). 세션 클러스터는 두지 않는다. 세션 클러스터는 화면 업로드를 꺼도 REST로 잡을 받기 때문이다.
- 잡은 DataStream API(프로그램이 기능을 불러 쓰는 창구)로 작성한다. ClickHouse 공식 커넥터는 DataStream만 지원한다. 늦게 온 사건을 같은 칸에 고쳐 쓰는 허용 지연(`allowedLateness`)도 DataStream의 창 기능이다.
- JobManager를 멈춤 없이 쓸 수 있게 하는 고가용성은 쿠버네티스(컨테이너로 만든 앱을 여러 서버에서 실행하고 관리하는 플랫폼) HA로 한다. 체크포인트·세이브포인트·HA 메타데이터는 S3 버킷 `peaket-flink-state-<환경>`에 SSE-KMS로 암호화해 둔다. 암호화 키는 저장소 암호화 KMS(암호 키를 안전하게 보관하고 대신 써 주는 클라우드 서비스) 키다. 업그레이드는 `savepoint` 모드(docs/devops.md §6.5)로 한다.
- Operator의 자동 확장(`job.autoscaler.enabled`, 기본값은 꺼짐)은 켜지 않고 병렬도를 고정한다. 확장 결정도 업그레이드 과정을 거쳐 반영되어 잡이 잠깐 멈추기 때문이다. 병렬도를 바꿀 때는 업그레이드와 같은 규칙(동결 창·마감 실행 중 금지, POL-028)을 따른다.
- 네임스페이스는 `ops-rt`·`analytics-ingest`가 `data`, `trust-reassess`가 `trust`이다. Operator는 `flink-operator`에 두고 두 네임스페이스를 지켜본다 [추천 적용]. 매니페스트는 공용 차트 `peaket-flink-job`(§13)이 만든다.

`ops-rt`의 FlinkDeployment 요지(값은 §2.4·§2.5, [가정]):

```yaml
apiVersion: flink.apache.org/v1beta1
kind: FlinkDeployment
metadata: { name: ops-rt, namespace: data }
spec:
  image: <ECR>/peaket-data/ops-rt@sha256:<다이제스트>
  flinkVersion: v2_2
  serviceAccount: ops-rt                     # Pod Identity 역할이 붙은 잡 전용 계정
  flinkConfiguration:
    execution.checkpointing.interval: 10s
    execution.checkpointing.min-pause: 5s
    execution.checkpointing.timeout: 2min
    execution.checkpointing.tolerable-failed-checkpoints: "3"
    execution.checkpointing.externalized-checkpoint-retention: RETAIN_ON_CANCELLATION
    execution.checkpointing.incremental: "true"
    execution.checkpointing.dir: s3://peaket-flink-state-prod/ops-rt/checkpoints
    execution.checkpointing.savepoint-dir: s3://peaket-flink-state-prod/ops-rt/savepoints
    state.backend.type: rocksdb
    high-availability.type: kubernetes
    high-availability.storageDir: s3://peaket-flink-state-prod/ops-rt/ha
    restart-strategy.type: exponential-delay
    pipeline.max-parallelism: "128"
    taskmanager.numberOfTaskSlots: "2"
    slotmanager.redundant-taskmanager-num: "1"
    web.submit.enable: "false"
    web.cancel.enable: "false"
    web.rescale.enable: "false"
    metrics.reporter.prom.factory.class: org.apache.flink.metrics.prometheus.PrometheusReporterFactory
    metrics.reporter.prom.port: "9249"
  podTemplate:
    spec:
      nodeSelector: { karpenter.sh/nodepool: data, karpenter.sh/capacity-type: on-demand }
      securityContext: { runAsNonRoot: true, seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: flink-main-container           # Operator가 정한 이름, 바꾸지 않는다
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: [ALL] } }
  jobManager:
    replicas: 2                                 # HA일 때만 1보다 크게 둘 수 있다
    resources: { requests: { cpu: "1", memory: 2048Mi }, limits: { cpu: "1", memory: 2048Mi } }
  taskManager:
    resources: { requests: { cpu: "2", memory: 4096Mi }, limits: { cpu: "2", memory: 4096Mi } }
  job:
    jarURI: local:///opt/flink/usrlib/ops-rt.jar
    entryClass: io.peaket.data.rt.OpsRtJob
    parallelism: 4
    upgradeMode: savepoint
    state: running
    allowNonRestoredState: false
```

### 2.3 관리 화면·권한·네트워크

- `web.submit.enable`·`web.cancel.enable`·`web.rescale.enable`을 끈다(기본값은 모두 켜짐). 인그레스·외부 서비스는 두지 않는다. REST의 상호 TLS(양쪽이 서로 인증서를 확인하며 통신을 암호화하는 방식)는 기본으로 꺼져 있으므로 네트워크 정책을 경계로 삼는다. 전송 암호화는 아래에 적은 메시 mTLS(같은 방식으로 메시가 하는 암호화)가 맡는다.
- 운영 중에는 Flink 화면을 열지 않는다. 잡 상태는 Operator 상태(FlinkDeployment `status`)와 Prometheus(지표를 모아 저장하는 도구) 지표로 본다.
- 잡 서비스 계정은 잡마다 하나씩 둔다. 쿠버네티스 권한은 자기 네임스페이스의 파드(쿠버네티스에서 앱이 실행되는 가장 작은 단위)·ConfigMap 정도만 준다. 네이티브 쿠버네티스 모드는 TaskManager 파드를 만들 때, 쿠버네티스 HA는 ConfigMap에 리더 정보를 둘 때 이 권한을 쓴다. AWS 권한은 Pod Identity 역할로 잡마다 나눈다.

| 잡 | S3 | KMS | MSK(IAM) | 그 밖 |
| --- | --- | --- | --- | --- |
| `ops-rt` | 상태 버킷의 `ops-rt/` 읽기·쓰기 | 상태 버킷 암호화 키 사용(SSE-KMS) | 거래·제어 5개 토픽과 텔레메트리 3개 토픽 읽기, 자기 소비자 그룹 | ClickHouse 사용자 `rt_writer`(rt 쓰기, `rt.seed` 읽기) |
| `analytics-ingest` | 상태 버킷의 `analytics-ingest/`, 분석 수집 버킷 읽기 | 위와 같고, 분석 가명 키 `kms:GenerateMac`도 쓴다 | 10개 토픽 읽기 | ClickHouse 사용자 `bronze_writer` |
| `trust-reassess` | 상태 버킷의 `trust-reassess/` | 위와 같다 | `telemetry.behavior` 읽기, `telemetry.trust-candidates` 쓰기 | ClickHouse 사용자 `trust_raw_writer` |

- Flink 파드도 서비스 메시(서비스끼리 주고받는 통신을 앱 대신 처리하는 층)에 넣는다. 그래서 JobManager·TaskManager 사이의 RPC·블롭·데이터 교환과 REST를 메시 mTLS로 암호화한다(docs/architecture.md 보안 기본 규칙의 '전송 구간 암호화 강제'). Flink 자체의 내부 TLS(`security.ssl.internal.*`)는 쓰지 않는다 [가정, wbs 4.3.1 PoC에서 메시 주입과 Flink RPC가 함께 되는지 확인]. 안 되면 Flink 내부 TLS를 켠다(추천 적용 2026-10-20, ADR-0073). 메시는 Istio(서비스 메시 제품)의 앰비언트 방식이라 Flink 파드에 사이드카를 넣지 않는다. 노드(파드가 실행되는 서버 한 대)의 프록시가 L4에서 암호화하고, 웨이포인트는 두지 않는다. 그래서 위의 확인은 'Flink RPC가 앰비언트 L4 경로에서 되는지'로 읽는다. 포트폴리오의 로컬 실행은 메시 없이 돈다(ADR-0082).
- 비밀 값(ClickHouse 사용자, Schema Registry 자격)은 Secrets Manager에 두고, External Secrets Operator가 파드에 넣는다(ADR-0053).
- 파드는 Pod Security Standards의 Restricted 기준(devops §4.3)을 맞춘다. 파일을 쓰는 곳은 emptyDir(임시 파일, RocksDB 로컬 디렉터리)뿐이다. 읽기 전용 루트 파일 시스템은 Flink 이미지가 쓰는 경로를 모두 emptyDir로 돌린 뒤에 켠다(wbs 4.3.1에서 확인).

네트워크 정책(잡마다):

| 방향 | 상대 | 쓰임 |
| --- | --- | --- |
| 들어옴 | `flink-operator` 네임스페이스 → JobManager REST(8081) | 상태 조회, 세이브포인트, 업그레이드 |
| 들어옴 | 관측(지표·로그·요청 기록으로 시스템 안을 들여다보는 일) 네임스페이스(Prometheus) → 지표 포트(9249) | 지표 수집 |
| 들어옴·나감 | 같은 잡의 JobManager·TaskManager끼리 | RPC, 블롭, 데이터 교환 |
| 나감 | MSK 두 클러스터(IAM 인증), Schema Registry | 소비·생산, 스키마(데이터의 구조 정의) 조회 |
| 나감 | ClickHouse(HTTPS) | 삽입, 시작값 조회 |
| 나감 | S3·KMS·STS(내부망에서 이 서비스들을 부르는 주소인 VPC 엔드포인트), DNS | 체크포인트, 가명 키, 자격 증명 |
| 나감 | 쿠버네티스 API | TaskManager 파드 요청, HA ConfigMap |

### 2.4 체크포인트·상태·재시작

| 설정 | `ops-rt` | `trust-reassess` | `analytics-ingest` | 기본값과 이유 |
| --- | --- | --- | --- | --- |
| `execution.checkpointing.interval` | 10초 [가정, 4.3.9에서 확정] | 30초 [가정] | 60초 [가정] | 기본값은 없다(꺼짐). 다시 처리할 구간과 Kafka 커밋 주기를 정한다 |
| `execution.checkpointing.min-pause` | 5초 | 10초 | 30초 | 기본값 0. 체크포인트가 길어져도 처리할 시간을 남긴다 |
| `execution.checkpointing.timeout` | 2분 | 5분 | 10분 | 기본값 10분 |
| `execution.checkpointing.tolerable-failed-checkpoints` | 3 | 3 | 3 | 기본값 0(한 번 실패하면 잡 실패). S3의 일시 오류로 잡이 재시작하지 않게 한다 |
| `execution.checkpointing.externalized-checkpoint-retention` | `RETAIN_ON_CANCELLATION` | 같다 | 같다 | 기본값은 외부에 보존하지 않는다. 잡을 멈춰도 마지막 체크포인트로 되살릴 수 있게 한다 |
| `execution.checkpointing.incremental` | 켬 | 켬 | 끔 | 기본값 끔. RocksDB 상태는 바뀐 부분만 올린다 |
| `execution.checkpointing.num-retained` | 1 | 1 | 1 | 기본값 1 |
| `state.backend.type` | `rocksdb` | `rocksdb` | `hashmap` | 기본값 `hashmap`. 상태가 메모리보다 커질 수 있는 두 잡만 RocksDB를 쓴다 |
| `restart-strategy.type` | `exponential-delay` | 같다 | 같다 | 기본값(처음 1초, 최대 1분, 1.5배, 지터 0.1, 1시간 안정되면 초기화)을 그대로 쓴다. 지터는 재시작 시각을 일부러 조금씩 흩뜨리는 정도다 |
| `pipeline.max-parallelism` | 128 | 128 | 128 | 기본값은 자동 계산이다. 키별 상태를 나누는 단위라서 처음부터 고정한다 |

- 상태 수명(TTL, 상태를 쓸 수 있는 시간)은 처리 시각 기준만 지원된다. 목록·맵은 원소마다 수명이 따로 끝난다. RocksDB는 압축(compaction) 때 수명이 끝난 상태를 지운다(Flink 문서). 수명을 짧은 값에서 긴 값으로 바꿔 복원하지 않는다(Flink 문서가 권하지 않는다).
- 연산자마다 UID를 고정한다(§4.2·§5.8·§6.1 표). UID가 바뀌면 세이브포인트의 상태를 찾지 못한다.
- Kafka 소스는 체크포인트가 끝날 때 오프셋(메시지를 어디까지 읽었는지 나타내는 위치 번호)을 Kafka에 커밋한다(`commit.offsets.on.checkpoint`, 기본값은 켜짐). 장애를 복구할 때는 체크포인트 안의 위치를 쓴다. 커밋된 오프셋은 소비 진도 감시와 §8의 '세이브포인트가 맞지 않을 때' 시작점으로 쓴다.

### 2.5 자원

| 잡 | 병렬도 | JobManager | TaskManager | 노드 |
| --- | --- | --- | --- | --- |
| `ops-rt` | 4 | 2대(대기 1대), CPU 1·메모리 2GiB | 2대 × 슬롯 2, CPU 2·메모리 4GiB, 예비 1대 | 데이터 노드 풀, 온디맨드 |
| `trust-reassess` | 4 | 1대, CPU 1·메모리 2GiB | 2대 × 슬롯 2, CPU 2·메모리 4GiB | 데이터 노드 풀, 온디맨드 |
| `analytics-ingest` | 4 | 1대, CPU 0.5·메모리 1GiB | 2대 × 슬롯 2, CPU 1·메모리 2GiB | 데이터 노드 풀, Spot 허용 |

- 숫자는 [가정, 4.3.9 측정에서 확정]이고, 근거는 §11에 있다. 자원 요청과 한도는 같은 값으로 둔다(쿠버네티스에 들어오는 설정을 규칙으로 검사하는 Kyverno가 둘 다 요구한다, devops §4.3).
- `ops-rt`·`trust-reassess`의 TaskManager는 온디맨드로 둔다. 창·중복 제거 상태를 들고 있어서 Spot이 회수되면 잡이 재시작하기 때문이다. `ops-rt`는 예비 TaskManager 1대(`slotmanager.redundant-taskmanager-num`)를 둔다. 그래서 TaskManager를 잃었을 때 새 파드를 기다리지 않는다.
- `analytics-ingest`는 Spot을 허용한다. 지연을 견디고, 빠진 것은 적어도 한 번 전달과 커버리지 대조(§6)가 메우기 때문이다.

### 2.6 Kafka 연결

| 잡 | 소스 | 소비자 그룹 | 커밋이 없을 때 시작 위치 | 워터마크 |
| --- | --- | --- | --- | --- |
| `ops-rt` | 거래·제어 클러스터 5개 토픽 | `peaket.ops-rt.<환경>` | 가장 이른 곳(`committedOffsets(EARLIEST)`)과 §4.7 시작값 | 없다 |
| `ops-rt` | 텔레메트리 클러스터 3개 토픽 | 같다 | 가장 늦은 곳(LATEST). 1초 칸에는 최근 사건만 의미가 있다 | 이벤트 시각 − 0.5초, 빈 입력 30초(§3) |
| `trust-reassess` | 텔레메트리 클러스터 `telemetry.behavior` | `peaket.trust-reassess.<환경>` | LATEST(상태가 10분이라 지난 사건이 필요 없다) | 없다 |
| `analytics-ingest` | 거래·제어 7개, 텔레메트리 3개 | `peaket.analytics-ingest.<환경>` | EARLIEST(보관된 7일 치 전부) | 없다 |

- 인증은 MSK IAM이다. 소비자·생산자 설정에 `security.protocol=SASL_SSL`, `sasl.mechanism=AWS_MSK_IAM`, `sasl.jaas.config=software.amazon.msk.auth.iam.IAMLoginModule required;`, `sasl.client.callback.handler.class=software.amazon.msk.auth.iam.IAMClientCallbackHandler`를 넣는다(AWS 문서). 이 라이브러리가 Pod Identity 자격 증명을 읽는지는 확인 필요다(wbs 4.3.1 PoC).
- 역직렬화는 `ConfluentRegistryAvroDeserializationSchema.forSpecific`(계약에서 만든 Avro 클래스)를 Kafka 레코드 역직렬화기로 감싸서 하고, 토픽·파티션·오프셋·Kafka 시각을 함께 넘긴다. 레지스트리가 잠시 멈춰도 이미 받은 스키마 ID는 캐시(자주 쓰는 값을 가까운 곳에 복사해 둔 것)에서 읽는다. 새 스키마 ID를 못 읽으면 그 레코드는 거절 처리(§4.2·§6.3)로 간다.
- 새 파티션을 찾는 주기는 기본값(5분)을 쓴다. 이벤트 시각은 Kafka 레코드 시각이 아니라 메시지 안의 시각(`second`·`occurredAt`·`producedAt`)이다.
- `client.id.prefix`는 `<잡>-<환경>`이다. 소스 지표 `pendingRecords`(아직 읽지 않은 레코드 수)와 `sourceIdleTime`으로 밀림과 끊김을 본다(§14).
- `trust-reassess`의 Kafka 싱크는 전달 보장을 `AT_LEAST_ONCE`로 적어 둔다. 기본값이 `NONE`(보장 없음)이라서, 적지 않으면 체크포인트 때 기다리지 않는다.

### 2.7 지표와 로그

- 지표는 Prometheus 리포터(포트 9249)로 내보내고, 클러스터의 Prometheus가 PodMonitor로 수집한다. 쓰는 지표는 §14에 있다.
- 로그는 표준 출력으로 낸다. OTel 수집기(노드 에이전트 → 중앙 수집 단계인 게이트웨이, ADR-0076)가 이 로그를 Loki(로그 저장소)로 보낸다(observability §7). 로그 라이브러리는 JNDI 조회를 끈 설정으로 쓰고, 버전은 조치 기한 안의 것을 쓴다(asvs/analytics 1.3.8). 레코드 내용(가명 처리 전 식별값, 행동 요약값)은 로그에 남기지 않는다.

## 3. 시간 기준과 빈 파티션

Flink의 워터마크는 '이 시각 이전 사건은 다 왔다'는 표시다. 병렬 입력이 여럿이면 그 입력들의 워터마크 중 가장 작은 값이 된다. 그래서 사건이 없는 파티션 하나가 전체를 붙잡는다. 거래 토픽은 키가 회차라서(ADR-0026) 온세일(판매가 열리는 시각 앞뒤로 접속이 몰리는 기간) 중에는 대부분의 파티션이 비어 있다. 반대로 빈 입력을 짧은 시간 만에 '쉼'으로 표시하면, 쉬다가 돌아온 파티션의 사건이 늦은 사건으로 버려진다.

1. 거래 토픽(`trade.*`)은 이벤트 시각 창에 넣지 않는다. 거래 숫자는 누적(§4)으로만 센다. `analytics-ingest`와 `trust-reassess`도 워터마크를 쓰지 않는다. 워터마크가 없는 거래 소스는 1초 칸 연산자와 이어 붙이지 않는다(이어 붙이면 그 연산자의 워터마크가 멈춘다).
2. 이벤트 시각 창에 들어가는 토픽은 `telemetry.queue`·`telemetry.purchase`·`telemetry.trust-verdicts` 셋이다. `rt-pulse`가 1초마다 이 토픽들의 모든 파티션에 `PipelinePulse`(파티션 직접 지정)를 넣는다. 그래서 파티션이 비지 않고 워터마크가 늘 나아간다. 심장 박동은 다른 사건과 같은 연산자(누적·1초 칸)를 지나 `_pulse` 행으로 남는다. 그래서 신선도를 다른 사건과 같은 길로 잰다(§4.5).
3. 워터마크 = 그 입력에서 본 가장 늦은 이벤트 시각 − 0.5초 [가정, 4.3.9에서 확정]. 빈 입력 표시(`withIdleness`)는 30초 [가정]로 두고, 안전망으로만 쓴다.
4. 허용 지연은 10초 [가정]다. 그 안에 늦게 온 사건은 같은 칸을 고쳐 다시 쓴다. 그보다 늦은 사건은 버리고, `numLateRecordsDropped`로 세어 NFR-009 누락률에 넣는다.
5. 사건이 드문 토픽(`control.settings`)은 `ops-rt` 입력에 넣지 않는다. 설정이 바뀐 시각은 조회할 때 ops-svc 명령 기록에서 가져와 붙인다.
6. `PipelinePulse`가 실리는 토픽의 다른 소비자(`analytics-ingest` 등)는 이 메시지를 건너뛴다(계약 시험으로 확인).

## 4. 관제 실시간 잡(`ops-rt`)

### 4.1 지표

지표 정의는 지표 사전(analytics §6)에 있는 같은 이름 지표의 정의를 쓴다. 같은 사건 묶음을 넣었을 때 골드와 같은 값이 나오는지 시험한다(§10 ST-T9). 실시간 숫자는 잠정값이며, 확정 숫자로 고쳐 쓰지 않는다(analytics §4.4).

| 지표(코드) | 종류 | 원천 | 차원 |
| --- | --- | --- | --- |
| 판매 좌석(`sold_seats`) | 누적 | 좌석 판매 상태(§4.2): `SeatEvent`의 PENDING·SOLD·RETURNED | 전체, 등급, 구역 |
| 판매 금액(`sales_amount`) | 누적 | `PaymentEvent`(승인은 +, 입금 되돌림은 −. 취소·부분 취소·환불은 빼지 않는다. 지표 사전 26번·정산서 '판매 대금'과 같은 총액이다. 추천 적용 2026-10-20, ADR-0073) | 전체 |
| 확정 주문(`orders_confirmed`), 발권 티켓(`tickets_issued`) | 누적 | `OrderEvent` CONFIRMED(입금 되돌림 DEPOSIT_REVERSED는 −), `TicketEvent` ISSUED(무효 VOIDED는 −). 지금 확정·유효한 수다 | 전체 |
| 잔여석 | 조회 때 계산 | 판매 대상 좌석 수(회차 기준 자료, analytics §3.2 `brz_ref_seat_map`) − 판매 좌석. 홀드 중이거나 결제 진행 중인 좌석은 빼지 않는다(좌석맵 화면이 따로 보여 준다) | 전체, 등급, 구역 |
| 퍼널 단계 누적(`funnel_admitted`, `funnel_first_hold`, `funnel_payment_accepted`, `funnel_approved`, `funnel_issued`) | 누적 | `QueueAggregate.admissions`, 구매 세션마다 첫 `HoldAttempt` HELD, 주문마다 처음 본 `OrderEvent` ACCEPTED·APPROVED·CONFIRMED(입금 되돌림 뒤 다시 확정되어도 다시 세지 않는다). 콘솔 판매 중 탭의 다섯 단계 퍼널 위젯은 같은 단계의 Prometheus 카운터를 보여 준다(observability §8, ADR-0071 결정 4). 이 누적은 등급별 상세·파트너 화면·마감 대조에 쓴다 | 전체, 등급(첫 홀드만) |
| 대기열 진입·입장·빠진 번호 누적(`queue_entries`, `queue_admissions`, `queue_removed`), 지금 대기 인원(조회 때 진입 − 입장 − 빠진 번호) | 누적 | `QueueAggregate` | 전체 |
| 진입·입장·빠진 번호의 초당 수 | 1초 칸 | `QueueAggregate`(`second`) | 전체 |
| 홀드 결과별 수(`hold_result`: HELD·CONFLICT·LIMIT·ERROR), 홀드 경합 패배율(조회 때) | 1초 칸 | `HoldAttempt` | 결과, 등급 |
| 판정 종류별 수(`verdict`), 추가 검증 격리율(조회 때, 잠정) | 1초 칸 | `TrustVerdict`(`shadow` false만) | 판정 종류 |
| 심장 박동(`pulse`) | 누적(가장 늦은 발행 시각), 1초 칸(받은 수) | `PipelinePulse` | 토픽 |

- 입장 속도, 퍼널 다섯 단계 카운터(`funnel_stage_total`), 오류율, 결제 성공률은 이 잡이 만들지 않는다. 판단과 제어에 쓰는 숫자는 클러스터 안의 Prometheus에서 나온다(observability §8 지표 출처 표, ADR-0068 결정 2).
- 회차 ID가 없는 행(심장 박동)은 `event_id`를 `_pulse`로 쓴다.

### 4.2 연산자와 사건 대응

연산자(UID 고정):

| UID | 하는 일 | 키 | 상태와 수명 | 출력 |
| --- | --- | --- | --- | --- |
| `ops-rt.src.trade` | 거래·제어 클러스터 소스(5개 토픽) | — | 소스 위치 | 레코드 |
| `ops-rt.src.telemetry` | 텔레메트리 클러스터 소스(3개 토픽), 워터마크 생성 | — | 소스 위치 | 레코드 |
| `ops-rt.parse` | Avro 레코드를 내부 사건으로 바꾼다. 쓰지 않는 종류(홀드 쪽 `SeatEvent` HELD·RELEASED·EXPIRED, 판매 예약 삭제 `SeatEvent` AVAILABLE(판매 좌석 수를 바꾸지 않는다), `QueueEntryRecord`)를 거른다. 읽지 못한 레코드는 거절 수(`rt_rejected_total{topic, reason}`)만 센다 | — | 없다 | 내부 사건 |
| `ops-rt.dedupe.sale` | 판매류 사건(`SeatEvent` PENDING·SOLD·RETURNED, `OrderEvent`, `PaymentEvent`, `TicketEvent` ISSUED) 가운데 처음 본 `eventKey`만 통과시킨다 | `eventKey` | 본 표시, 7일 [가정] | 사건 |
| `ops-rt.dedupe.queue` | `QueueAggregate` 가운데 처음 본 `eventKey`만 통과시킨다 | `eventKey` | 본 표시, 10분 [가정] | 사건 |
| `ops-rt.seat-state` | 좌석 판매 상태 기계(아래) | 회차, 좌석 | 마지막 판매 상태·등급·구역, 마지막 변경 뒤 180일 [가정] | 지표 변화량 |
| `ops-rt.first-hold` | 구매 세션의 첫 HELD만 퍼널에 더한다. 세션 종료(`PurchaseSessionEnded`)를 받으면 지운다 | 구매 세션 | 첫 홀드 표시, 1일 [가정] | 지표 변화량 |
| `ops-rt.first-stage` | 주문마다 단계(ACCEPTED·APPROVED·CONFIRMED)를 처음 봤을 때만 퍼널에 더한다(추천 적용 2026-10-20, ADR-0073) | 주문, 단계 | 본 표시, 7일 [가정] | 지표 변화량 |
| `ops-rt.expand` | 나머지 사건을 지표 변화량으로 바꾼다(아래 표) | — | 없다 | 지표 변화량 |
| `ops-rt.cumulative` | 누적: 키마다 값과 바뀜 표시를 두고, 처리 시각의 다음 초 경계에 타이머를 건다. 타이머는 키·시각마다 하나라서 1초에 한 번만 내보낸다. 버전은 내보낸 처리 시각(ms)이다 | 회차, 지표, 차원 | 값, 바뀜 표시. 30일 동안 갱신이 없으면 지운다 | `rt.cumulative` 행 |
| `ops-rt.bucket` | 1초 텀블링 이벤트 시각 창, 허용 지연 10초로 합·건수·최댓값을 집계한다. 버전은 그 칸이 받은 사건 수다 | 회차, 지표, 차원 | 창 상태(칸이 닫히고 10초 뒤에 지운다) | `rt.bucket` 행 |
| `ops-rt.sink.cumulative`, `ops-rt.sink.bucket` | ClickHouse 싱크(§4.4) | — | 보내는 중인 묶음 | ClickHouse |

사건 → 지표 변화량:

| 사건 | 조건 | 변화량 |
| --- | --- | --- |
| `SeatEvent` PENDING·SOLD·RETURNED | 좌석 판매 상태 기계가 판매 상태 변화를 낼 때 | `sold_seats` ±1(전체·등급·구역) |
| `PaymentEvent` APPROVED | — | `sales_amount` +`amount` |
| `PaymentEvent` DEPOSIT_REVERSED | — | `sales_amount` −`amount`(승인이 취소된 금액). CANCELED·PARTIAL_CANCELED는 판매 금액을 바꾸지 않는다(환급은 따로, 정산서 '환급') |
| `OrderEvent` ACCEPTED·APPROVED·CONFIRMED | 주문마다 그 단계를 처음 볼 때(`ops-rt.first-stage`) | `funnel_payment_accepted`·`funnel_approved`·`funnel_issued` +1 |
| `OrderEvent` CONFIRMED·DEPOSIT_REVERSED | — | `orders_confirmed` +1·−1 |
| `TicketEvent` ISSUED·VOIDED | — | `tickets_issued` +1·−1 |
| `QueueAggregate` | — | 누적 `queue_entries`·`queue_admissions`·`queue_removed`와 `funnel_admitted`에 +값. 같은 값을 그 초(`second`)의 1초 칸에도 더한다 |
| `HoldAttempt` | 모든 결과 | `hold_result{result, tier}` 1초 칸 +1 |
| `HoldAttempt` HELD | 그 구매 세션의 첫 HELD | `funnel_first_hold{tier}` +1 |
| `TrustVerdict` | `shadow` false | `verdict{category}` 1초 칸 +1 |
| `PipelinePulse` | — | `_pulse` 행: 누적은 가장 늦은 `producedAt`(합이 아니라 최댓값), 1초 칸은 받은 수 |

좌석 판매 상태 기계(`ops-rt.seat-state`):

- 판매 상태는 Outbox 한 곳(purchase-svc의 `seat_sale`, seat-hold §5)에서 회차 키로 온다. 그래서 한 좌석의 사건은 순서대로 도착하고, 상태 기계와 `eventKey` 중복 제거만으로도 값이 정확하다.
- 상태는 없음·PENDING·SOLD·RETURNED다. SOLD가 아닌 상태에서 SOLD가 되면 +1, SOLD에서 다른 상태가 되면 −1이다. 가상계좌 입금 되돌림(주문 Confirmed → AwaitingDeposit, 좌석 SOLD → PENDING, planning/03 §2)도 −1로 잡힌다.
- 상태가 수명이 다해 지워진 뒤에 사건이 오면, 사건 종류가 가리키는 이전 상태였다고 본다(RETURNED는 SOLD에서, SOLD와 PENDING은 SOLD가 아닌 상태에서).
- 등급·구역은 `SeatEvent`의 `tierId`·`sectionId`(계약 보강, analytics §3.4)에서 받는다.

### 4.3 표(ClickHouse `rt` DB)

ClickHouse는 복제본을 2벌 두므로(infra §4) 복제 엔진을 쓴다. 이름과 TTL은 [가정]이다.

```sql
CREATE TABLE rt.cumulative ON CLUSTER '{cluster}'
(
    event_id  LowCardinality(String),   -- 심장 박동은 '_pulse'
    metric    LowCardinality(String),
    dim       String,                   -- '' 또는 'tier:…'·'section:…'·'topic:…'
    value     Int64,
    version   UInt64,                   -- 내보낸 처리 시각(ms)
    as_of     DateTime64(3)
)
ENGINE = ReplicatedReplacingMergeTree(version)
ORDER BY (event_id, metric, dim)
TTL toDateTime(as_of) + INTERVAL 90 DAY;

CREATE TABLE rt.bucket ON CLUSTER '{cluster}'
(
    event_id      LowCardinality(String),
    metric        LowCardinality(String),
    dim           String,
    bucket_start  DateTime64(3),
    value         Int64,
    max_value     Int64,                -- 심장 박동의 가장 늦은 발행 시각(ms), 그 밖은 0
    version       UInt64                -- 그 칸이 받은 사건 수
)
ENGINE = ReplicatedReplacingMergeTree(version)
PARTITION BY toYYYYMMDD(bucket_start)
ORDER BY (event_id, metric, dim, bucket_start)
TTL toDateTime(bucket_start) + INTERVAL 90 DAY;

CREATE TABLE rt.seed ON CLUSTER '{cluster}'
(
    event_id      LowCardinality(String),
    metric        LowCardinality(String),
    dim           String,
    value         Int64,
    seeded_upto   String,               -- 파티션별 오프셋 O(JSON), §4.7
    created_at    DateTime64(3)
)
ENGINE = ReplicatedReplacingMergeTree(created_at)
ORDER BY (event_id, metric, dim)
TTL toDateTime(created_at) + INTERVAL 30 DAY;
```

- 읽기: ops-svc는 `FINAL`(최근 몇 분 범위)이나 `argMax(value, version)`로 키마다 마지막 값을 읽는다. ReplacingMergeTree는 병합할 때만 중복을 지우고, 언제 지울지는 보장하지 않는다. 그래서 병합에 기대지 않고 읽을 때 마지막 값을 고른다.
- '최근 10초·60초' 같은 이동 합과 10초 단위 보조 지표는 조회할 때 1초 칸을 더해 구한다. 구간별 증가량(분당 주문 등)은 누적 값의 차이로 구한다.
- 실시간 표 안에서는 머티리얼라이즈드 뷰로 합산하지 않는다. 뷰는 삽입 묶음마다 돌아서, 다시 보낸 값도 더해 버리기 때문이다(analytics §5.5).
- 파트너 판매 현황을 서버에서 브라우저로 한 방향으로 계속 보내는 SSE(1분 지연, control-tower §11)는 `rt.cumulative`를 읽는다.
- 누적의 버전은 처리 시각이다. 그래서 재시작 직후 몇 초 동안 숫자가 잠깐 뒤로 갈 수 있다(체크포인트 시점의 값에서 다시 세기 때문이다). 다시 처리하면 곧 같은 값으로 돌아온다. 1초 칸은 버전이 사건 수라서 뒤로 가지 않는다.

### 4.4 싱크

ClickHouse 공식 커넥터의 `ClickHouseAsyncSink`(요소 변환기는 `POJOConvertor`, 형식은 기본값인 RowBinary)를 쓴다.

| 설정 | `ops-rt` | `analytics-ingest`·`trust-reassess` | 뜻 |
| --- | --- | --- | --- |
| `maxBatchSize` | 2,000 | 10,000 | 묶음의 최대 레코드 수 |
| `maxTimeInBufferMS` | 250 | 1,000 | 레코드가 버퍼에 머무는 최대 시간 |
| `maxInFlightRequests` | 2 | 2 | 넘으면 역압이 걸린다 |
| `maxBufferedRequests` | 20,000 | 50,000 | 넘으면 역압이 걸린다 |
| `maxBatchSizeInBytes` | 8MB | 16MB | 묶음 크기 상한 |
| `maxRecordSizeInBytes` | 64KB | 1MB | 이보다 큰 레코드는 거절한다 |
| 재시도 | 3회(기본) | 3회(기본) | 넘으면 그 묶음을 버리고 `numOfDroppedRecords`가 늘어난다 |
| 서버 설정 | `async_insert=1`, `wait_for_async_insert=1` | 위와 같고, `insert_deduplicate=1`을 더한다 | 디스크에 쓴 뒤 응답한다 |

- 숫자는 [가정, 4.3.9에서 확정]이다. 묶음이 너무 작거나 너무 자주 보내면 ClickHouse의 병합이 밀려 삽입이 느려진다. 그래서 `numRequestSubmitted`·`actualRecordsPerBatch`를 보고 맞춘다(ClickHouse 문서).
- `wait_for_async_insert=0`은 쓰지 않는다(디스크에 쓰기 전에 응답하므로 데이터를 잃을 수 있다).
- 커넥터는 재시도해도 실패한 묶음을 버린다(데드 레터 큐가 없다). `numOfDroppedRecords`가 0보다 크면 SEV3다. 누적은 다음 초의 값이 메우고, 1초 칸은 버린 수를 누락률에 넣는다.

### 4.5 신선도와 지연 예산(NFR-009)

- **SLI**(실제로 재는 서비스 품질 값): ops-svc가 읽을 때마다 두 길의 신선도를 낸다. 1초 칸 길의 신선도는 지금 − 화면에 보이는 마지막 `_pulse` 칸의 시작 시각(칸 안에서 가장 이른 사건을 기준으로 잡는 보수적인 값)이다. 누적 길의 신선도는 지금 − `rt.cumulative`의 `_pulse` 값(받은 심장 박동의 가장 늦은 발행 시각)이다. 이 값을 `rt_freshness_seconds{path}`로 내고, 둘 중 큰 값을 콘솔 판매 중 탭의 머리에 보여 준다(design/d5 §7.2). 1분 창의 p95(잰 값 백 개 중 아흔다섯 개가 이 값 이하라는 뜻)가 NFR-009 판정값(5초 미만)이다.
- **심장 박동 수**: 1초 칸의 `_pulse` 값(받은 수)이 그 토픽의 파티션 수보다 작으면, 어떤 파티션의 사건이 늦거나 빠지고 있다는 뜻이다. 이 값은 엔지니어 화면에 보인다.
- **누락률**: (`numLateRecordsDropped` + 싱크 `numOfDroppedRecords` + 거절 수 + 텔레메트리 생산자가 버린 수(ADR-0026)) ÷ 전체로 구한다. 0.1% 미만이 목표다.
- **Degraded 전환**: 신선도 p95가 5초를 넘는 상태가 3분 넘게 이어지면 콘솔의 실시간 표 패널을 Prometheus 대체 표시로 바꾼다. 신선도 p99(잰 값 백 개 중 아흔아홉 개가 이 값 이하라는 뜻)는 60초까지 허용한다(observability §10). 신선도 p95가 5초 미만인 상태가 5분 [가정] 이어지면 실시간 표로 자동으로 되돌린다(추천 적용 2026-10-21, ADR-0078 결정 2). 체크포인트 지연과 역압은 원인을 살피는 패널로 둔다.

| 구간 | 예산 | 근거 |
| --- | --- | --- |
| 생산자 묶음과 Kafka 복제 | 0.05초 [가정] | 텔레메트리 생산자 설정 |
| 1초 칸이 닫힐 때까지 | 최대 1초 | 칸 크기 |
| 워터마크 여유 | 0.5초 [가정] | §3 |
| 워터마크가 나아가는 간격 | 최대 1초 | 사건이 없는 파티션은 심장 박동(1초)으로만 나아간다 |
| Flink 처리 | 0.1초 [추정] | |
| 싱크 버퍼 | 0.25초 [가정] | §4.4 |
| ClickHouse 비동기 삽입 반영 | 최대 0.2초 | ClickHouse 문서(적응형 시간, 직접 운영할 때 기본 최대 200ms) |
| ops-svc 조회 주기 | 0.5초 [가정] | |
| 푸시와 그리기 | 0.3초 [추정] | |
| 합(최악) | 약 3.9초 [추정] | 5초 목표 안에서 약 1초 여유가 있다 |

- 누적 숫자의 지연은 1초 타이머(최대 1초) + 싱크·반영·조회·그리기로 약 2.3초 [추정]이고, 여기에 원천의 앞단 지연(Outbox → Kafka)이 더해진다. 심장 박동은 텔레메트리 경로만 지난다. 그래서 거래 쪽 앞단 지연과 끊김은 CDC(데이터베이스의 변경 기록을 읽어 다른 시스템으로 흘려보내는 방식) 지연 지표와 거래 소스의 `sourceIdleTime`(§14)으로 따로 본다.

### 4.6 실시간 대비 대조(analytics §4.4)

- 마감 때 판매 좌석·판매 금액은 `rt.cumulative`의 마지막 값과 골드를 비교한다. 판매 좌석은 좌석 판매 상태 기계로, 판매 금액은 `eventKey` 중복 제거로 한 번만 세고, 체크포인트로 한 번만 반영한다. 그래서 원천 유실이 없고 규칙이 지표 사전과 같으면 차이는 0이다. 규칙이 같은지는 같은 고정 사건을 dbt 모델과 이 잡에 넣어 시험한다(§10 ST-T9).
- 차이가 나면 원인은 원천 유실, `eventKey`가 다른 재발행, §4.7 경계에서 생긴 재발행 중복, 규칙 차이 중 하나다. 그 지표의 결정 규칙은 '판정 보류'로 두고, 원인을 데이터 품질 절에 적는다.

### 4.7 세이브포인트가 맞지 않을 때 시작값 다시 만들기

판매 기간은 Kafka 보관 기간(7일)보다 길 수 있다. 그래서 누적을 Kafka 재처리만으로는 다시 만들 수 없다. 절차는 장애 때 따라 하는 절차서인 런북 RB-34(infra §10)에 있다.

1. 옛 잡을 멈추고, 소비자 그룹이 커밋한 파티션별 오프셋 O를 적는다.
2. 마감 실행기(`close-runner`)의 시작값 명령이 브론즈에 있는 파티션별 오프셋 O 앞까지의 거래 사건을 `eventKey`로 중복 제거한다. 그다음 같은 규칙(§4.2)으로 누적을 계산해 `rt.seed`에 쓴다.
3. 새 잡은 커밋된 오프셋 O부터 읽는다. `ops-rt.cumulative`는 키 상태가 없으면 `rt.seed`의 값을, 그것도 없으면 `rt.cumulative`의 마지막 값을 한 번 읽어 채운 뒤 이어서 센다. 30일 동안 갱신이 없어 지운 키에도 같은 경로를 쓴다(그때는 마지막 값이 곧 최종값이다).
4. 좌석 판매 상태는 다시 만들지 않는다. 상태가 없으면 사건 종류로 이전 상태를 보므로(§4.2), 판매 좌석 누적은 시작값에서 바르게 이어진다.
5. 이 절차는 wbs 4.3.1 PoC로 확인한다[가정]. 누적 상태의 모양(값·바뀜 표시)은 단순하게 두고, 호환되는 방향으로만 바꿔서(devops §6.5) 이 절차를 쓸 일을 줄인다.

## 5. 봇 대기 중 재평가 잡(`trust-reassess`)

### 5.1 역할

판정은 trust-svc가 사전 검증 요청 때 그 자리에서 한다(queue-admission §7). 판정에 쓰는 피처 가운데 회차별 기기 공유 수와 호스팅·프록시 대역 진입 수도 trust-svc가 Redis(메모리에 데이터를 두는 빠른 저장소)에서 바로 센다(§5.5). 이 잡은 판정과 따로, 사람들이 기다리는 동안 한 사람만 봐서는 보이지 않는 여러 사람 사이의 패턴을 찾아 추가 검증 후보를 낸다. 예를 들어 같은 기기에 계정 다섯 개가 차례로 들어오면, 판정 때는 다섯 번째부터 의심스럽지만 이 잡은 앞의 네 명도 다시 본다.

### 5.2 입력

입력은 `telemetry.behavior`의 `BehaviorSignal`이다. trust-svc가 사전 검증 때 기기 식별값을 탐지 가명으로 바꾼 뒤 낸다(ADR-0053). 필드는 `pid`, `deviceRef`, `eventId`, `netClass`(HOSTING·PROXY·OTHER), `asn`(HOSTING·PROXY일 때만), `features`(브라우저가 낸 요약값, ADR-0065 결정 9), `ts`, `eventKey`, `schemaVersion`이다.

### 5.3 패턴

| 패턴 | 키 | 조건 [가정, 4.3.8과 그림자 기간에 확정] | 후보 |
| --- | --- | --- | --- |
| R1 기기 공유 소급(`DEVICE_SHARE`) | 회차, `deviceRef` | 10분 안에 서로 다른 pid 5명 이상 | 그 기기의 pid 모두(이미 판정을 통과한 사람 포함) |
| R2 행동 요약값 복제(`BEHAVIOR_REPLAY`) | 회차, 요약값 지문 | 10분 안에 서로 다른 pid 20명 이상 | 그 지문의 pid 모두 |

- 요약값 지문은 정해진 순서의 특징값을 소수 넷째 자리 [가정]로 반올림한 문자열의 SHA-256이다(보안 용도가 아니라 같은 값을 묶는 열쇠다). 서로 다른 사람에게서 같은 값이 나올 가능성은 낮고, 녹화한 움직임을 여러 계정에서 재생하면 같은 값이 나온다. 포인터 이동 엔트로피와 입력 간격 분산이 모두 0인 요약값(키보드·터치만 쓴 경우 등)은 지문을 만들지 않는다. 키보드 보조기기 사용자를 한 무리로 묶지 않기 위해서다(queue-admission §7).
- 시간 기준은 처리 시각이고, 상태 수명은 10분이다. 워터마크를 쓰지 않으므로 빈 파티션 문제가 없다.
- 세션 창과 CEP는 쓰지 않는다(§5.7).

### 5.4 출력

- `telemetry.trust-candidates`(`TrustCandidate`, 키 pid): `eventId`, `pid`, `pattern`, `evidenceCount`, `windowStart`, `detectedAt`, `eventKey`, `schemaVersion`. `eventKey`는 `SHA-256("PEAKET-reassess-v1" ‖ 회차 ID ‖ pid ‖ 패턴 ‖ 10분 칸 시작)`으로 만든 UUIDv8(RFC 9562 §5.8)이다. 그래서 같은 후보를 다시 내도 값이 같다.
- 행동 신호 원시 표(ClickHouse `trust.behavior_raw`, 30일 TTL, data-classification 행동 신호 행): 입력을 그대로 적재한다. 정렬 키는 `(event_id, ts)`, 파티션은 `toYYYYMMDD(ts)`(30일 보존과 맞는다, ADR-0077)이고, 복제 엔진을 쓴다.

### 5.5 trust-svc의 처리

- **판정 피처(동기)**: 사전 검증 요청 때 세션·캐시 Redis에 회차별 기기 공유 수 `tr:{event:E}:devshare:{deviceRef}`(HyperLogLog, 10분)와 호스팅·프록시 대역 진입 수 `tr:{event:E}:asnhost:{asn}:{10초 칸}`(카운터, 만료 30초)를 쓰고 읽는다 [가정]. 통신사 대역은 세지 않는다(사람 대부분이 몇몇 통신사 대역에 몰려 있어서 신호가 약하고, 한 키에 요청이 몰린다).
- **재평가 모드**: 명령 5(봇 판정 강도) 프로필에 있는 값이다. 값은 끔·그림자·적용이고, 기본값은 그림자다.
  - 그림자: `TrustVerdict`(source `REASSESS`, action `NONE`, `shadow` true)만 낸다.
  - 적용: 아직 기다리는 사람이면 queue-svc의 `IsolateWaiting`(서비스끼리 함수를 부르듯 호출하는 gRPC 방식, 메시 mTLS, 후보 `eventKey`로 멱등)을 부른다. queue-svc는 1인 1순번 키로 그 사람의 대기표(로비 참가자는 참가를 증명하는 서명된 문자열인 참가 토큰)를 찾아, 빠진 번호와 `VERIFYING`을 쓴다(queue-admission §7 격리 기록, ADR-0062). 응답은 격리함·대기 중 아님·이미 격리됨이다. 이미 입장한 사람은 라벨만 남긴다.
- **후보 중복**: trust-svc는 처리한 후보 `eventKey`를 10분 [가정] 동안 기억해서, 같은 후보를 두 번 처리하지 않는다.
- **격리 상한**: 재평가로 건 격리는 회차의 지금 대기 인원의 0.5% [가정]를 10분 안에 넘지 않는다. 넘는 몫은 그림자로만 남기고 SEV3를 띄운다. 잘못된 패턴이나 숫자 때문에 사람을 한꺼번에 격리하는 사고를 막기 위해서다.
- 격리는 차단이 아니다. 추가 검증(사람 확인과 본인확인 재통과), 이의 제기, 자동화된 결정의 설명 요구(개인정보 보호법 §37의2, POL-006)는 그대로다.

### 5.6 그림자에서 적용으로

ADR-0039 평가 절차의 그림자 실행 단계를 거친다. 그림자 기간에 낸 후보를 표본 검토(R2)와 사후 라벨로 대조해, 사람 오탐(사람을 봇으로 잘못 잡는 것)이 상한(NFR-022, 0.5%)을 넘지 않는지 확인한다. 그 뒤 commander가 명령 5로 바꾼다. 넘으면 그 패턴은 적용하지 않고 숫자를 고치거나 뺀다.

### 5.7 세션 창과 CEP를 쓰지 않는 이유

- 세션 창은 활동이 멈춘 뒤에야 결과를 내므로 동기 판정에 쓸 수 없다. 쉬지 않는 봇이라면 창이 닫히지도 않는다. 세션 단위의 사후 분석은 확정 길(dbt, R2 표본 검토·사후 라벨)이 맡는다.
- CEP에는 순서가 있는 사건 기록이 필요하다. 브라우저는 원시 좌표·입력 시각의 순서를 보내지 않고 요약값만 보낸다(ADR-0065 결정 9, 개인정보 판단). 순서가 있는 서버 사건(홀드 시도 간격 등)으로 CEP를 쓰려면 계약을 따로 정한다.

### 5.8 연산자와 상태

| UID | 하는 일 | 키 | 상태와 수명 | 출력 |
| --- | --- | --- | --- | --- |
| `trust-reassess.src.behavior` | 텔레메트리 클러스터 소스 | — | 소스 위치 | 레코드 |
| `trust-reassess.parse` | 검증하고 지문을 계산한다. 읽지 못한 레코드는 거절 수만 센다 | — | 없다 | 신호 |
| `trust-reassess.sink.raw` | 원시 표 싱크(§4.4 설정) | — | 보내는 중인 묶음 | ClickHouse |
| `trust-reassess.r1` | 기기 공유 소급 | 회차, `deviceRef` | pid → 마지막 시각 맵(원소마다 10분), 넘음 표시(10분) | 후보 |
| `trust-reassess.r2` | 행동 요약값 복제 | 회차, 지문 | 위와 같다 | 후보 |
| `trust-reassess.sink.candidates` | Kafka 싱크(`AT_LEAST_ONCE`, 키 pid) | — | 보내는 중인 레코드 | `telemetry.trust-candidates` |

- R1·R2는 같은 방식으로 동작한다. pid를 맵에 넣다가, 서로 다른 pid가 문턱(5·20)에 닿으면 맵의 pid를 모두 후보로 낸다. 그다음 넘음 표시를 켜고 맵을 비운다. 넘음 표시가 켜져 있는 동안 새 pid는 바로 후보로 낸다. 그래서 키 하나의 상태는 문턱보다 크게 자라지 않는다.
- 같은 사람이 10분 칸 안에서 여러 번 걸려도 후보 `eventKey`가 같으므로, trust-svc는 한 번만 처리한다.

## 6. 원본 적재 잡(`analytics-ingest`)

- 워터마크를 쓰지 않고, `PipelinePulse`와 `QueueAggregate`를 건너뛴다.
- 싱크가 버린 수가 0보다 크면 SEV3다.
- 마감 커버리지(analytics §7): 파티션마다 대상 오프셋 구간에 있는 고유한 (파티션, 오프셋) 수가 구간 길이와 같은지 본다. 적재 거절 기록(§6.3)의 오프셋도 구간에 넣는다. 모자라면 그 구간을 Kafka 보관 기간(7일) 안에서 다시 적재한다(RB-34). 이 대조는 트랜잭션(여러 변경을 한꺼번에 반영하거나 한꺼번에 취소하는 작업 단위) 생산자를 쓰지 않는다는 것(ADR-0026 결정 3, 트랜잭션 표시는 오프셋을 차지한다)과 토픽이 삭제 보존(압축 아님) 방식이라는 것을 전제로 한다.
- 세이브포인트가 맞지 않으면 커밋된 오프셋부터 읽는다(§8). 겹쳐 읽은 구간은 브론즈가 중복을 허용하고 실버가 중복을 지워 흡수한다.

### 6.1 연산자

| UID | 하는 일 | 상태 | 출력 |
| --- | --- | --- | --- |
| `analytics-ingest.src.trade`, `analytics-ingest.src.telemetry` | 클러스터별 소스 | 소스 위치 | 레코드(토픽·파티션·오프셋·Kafka 시각 포함) |
| `analytics-ingest.parse` | Avro를 역직렬화하고 스키마 버전을 기록한다. 읽지 못하면 거절 기록으로 보낸다 | 없다 | 사건 또는 거절 |
| `analytics-ingest.pseudonymize` | 식별값을 회차별 가명으로 바꾼다(§6.2) | 회차 키 캐시(메모리, 상태 아님) | 가명 사건 |
| `analytics-ingest.strip` | 스키마별 허용 목록 밖의 필드와 금지 필드를 지운다(analytics §3.3) | 없다 | 브론즈 행 |
| `analytics-ingest.route` | 원천별 브론즈 표로 나눈다 | 없다 | 표별 행 |
| `analytics-ingest.sink.<표>` | 브론즈 표마다 싱크(§4.4 설정) | 보내는 중인 묶음 | ClickHouse |
| `analytics-ingest.sink.rejected` | 거절 기록 싱크 | 보내는 중인 묶음 | `bronze.brz_rejected` |

### 6.2 가명 처리와 키

- 회차 키는 `HMAC(분석 가명 키, "PEAKET-analytics-v1" ‖ 회차 ID)`이다. KMS `GenerateMac`으로 TaskManager마다 회차당 한 번 얻어 메모리에만 둔다(analytics §3.3). 디스크·로그·체크포인트에는 쓰지 않는다.
- 가명 키를 얻지 못하면 원문을 쓰지 않고, 그 레코드에서 잡을 실패시킨다(fail-closed). 잡은 재시작 전략에 따라 다시 시도한다. 그동안 소비 밀림이 늘어 경보가 뜬다(§14).
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

## 7. 키 규칙(ADR-0026 결정 1)

| 토픽 | 메시지 | 키 |
| --- | --- | --- |
| `trade.*` | 거래 사건 | 회차(`eventId`, 공연 단위 순서). 정산은 파트너 ID |
| `telemetry.queue` | `QueueAggregate` | '회차:파드' |
| `telemetry.queue` | `QueueEntryRecord` | pid |
| `telemetry.purchase` | `HoldAttempt` | `purchaseSessionId` |
| `telemetry.trust-verdicts` | `TrustVerdict` | `queueEntryId`(없으면 키를 두지 않는다) |
| `telemetry.behavior` | `BehaviorSignal` | pid |
| `telemetry.trust-candidates` | `TrustCandidate` | pid |
| 위 텔레메트리 셋 | `PipelinePulse` | 키 없음, 파티션 직접 지정 |

- `ops-rt`는 안에서 회차·지표·차원으로 다시 나눈다. 사건이 한 회차에 몰려도 지표·차원으로 나뉜다. 그래도 한 키로는 모자라면 소스 쪽에서 1초 부분합을 먼저 내는 2단계 집계로 바꾼다(4.3.9 측정으로 판단).
- 파티션 수는 계약 저장소에서 정하고, 줄이지 않는다(devops §7.5). 이 문서의 계산은 토픽마다 파티션 12개 [가정, 4.3.3에서 확정]로 잡았다.

## 8. 복구와 업그레이드

- **장애 복구**: 마지막 체크포인트에서 상태와 Kafka 위치를 함께 되돌린다. 좌석 판매 상태·누적·칸은 한 번만 반영된다. 표에 다시 쓴 값은 덮어쓰기라서 결과가 같다.
- **업그레이드**: Operator `savepoint` 모드, 연산자 UID 고정, 호환되는 상태 진화만 허용(docs/devops.md §6.5), `allowNonRestoredState: false`(옛 상태를 버리는 배포를 막는다)를 지킨다. 잡이 비정상이면 Operator가 마지막 체크포인트로 대신한다(`kubernetes.operator.job.upgrade.last-state-fallback.enabled`, 기본값은 켜짐). 체크포인트도 없으면 업그레이드가 실패한다. 동결 창과 마감 실행 중에는 업그레이드하지 않는다(저장소의 배포 정의대로 쿠버네티스를 맞추는 배포 도구인 ArgoCD의 동기화 창, devops §8).
- **세이브포인트가 맞지 않을 때**: 새 잡은 같은 소비자 그룹이 커밋한 오프셋부터 읽는다. `ops-rt`는 §4.7 절차로 시작값을 채운다. `trust-reassess`는 빈 상태로 시작한다(최대 10분의 문맥을 잃는다). `analytics-ingest`는 그대로 이어 간다. 빈 구간을 만들고 다시 채우는 단계는 없다.
- **되돌리기**: 이전 이미지로 같은 방식의 세이브포인트 업그레이드를 한다. 상태 모양을 바꾼 판은, 되돌리기 전에 옛 판이 새 세이브포인트를 읽는지 시험에서 확인한다(§13).
- **체크포인트·세이브포인트 정리**: 체크포인트는 마지막 1개만 남는다(`num-retained`). 세이브포인트 기록은 Operator가 정리한다(기본값 1일·10개). 체크포인트 폴더의 `shared/`에는 여러 체크포인트가 함께 쓰는 파일이 있다. 그래서 버킷 수명 규칙으로 파일 나이를 기준으로 지우지 않는다. 버킷 수명 규칙은 `savepoints/`에서 90일 [가정]이 지난 객체에만 적용한다.

## 9. 운영 확인 표(docs/architecture.md §8.4)

| 확인할 동작 | 사건·필드 | SLI | 대시보드 패널 | 경보(종류·심각도) | 배포 뒤 확인 방법 |
| --- | --- | --- | --- | --- | --- |
| 관제 실시간 표가 5초 안에 반영 | `_pulse` 행, `rt_freshness_seconds{path}` | 신선도 p95 ≤ 5초(NFR-009) | SCR-029 판매 중 탭 머리 신선도(design/d5 §7.2), 엔지니어 화면 '실시간 표' | 3분 넘게 5초 초과 → Degraded 전환과 SEV3(`kind` hygiene) | 카나리 동안 신선도 p95 비교 |
| 사건을 빠뜨리지 않음 | `numLateRecordsDropped`, `numOfDroppedRecords`, `rt_rejected_total`, 생산자 버림 수 | 누락률 < 0.1% | 같은 화면 '누락' | 10분 누락률 0.1% 초과 SEV3, 싱크 버림 > 0 SEV3 | 배포 전후 누락률 |
| 거래 사건이 끊기지 않음 | 거래 소스 `sourceIdleTime`, CDC 지연 | — | 'Flink 잡' 화면 | 온세일 창 안에서 60초 [가정] 넘게 거래 사건이 없으면 SEV3 | 배포 직후 거래 소스 처리량 |
| 잡이 멈추거나 되풀이 실패하지 않음 | `numRestarts`, Operator 상태 | — | 'Flink 잡' 화면 | 10분 안 재시작 3회 [가정] SEV3 | Operator 상태 `STABLE` |
| 체크포인트가 이어짐 | `lastCheckpointDuration`, `numberOfFailedCheckpoints` | — | 잡별 체크포인트 | 연속 실패 3회 [가정] SEV3 | 업그레이드 뒤 첫 체크포인트 성공 |
| 소비가 밀리지 않음 | `pendingRecords` | — | 'Flink 잡' 화면 | 10분 동안 계속 늘면 SEV3 | 배포 전후 비교 |
| 재평가가 사람을 한꺼번에 격리하지 않음 | `trust_reassess_candidates_total{pattern}`, `trust_reassess_isolations_total{mode}` | — | 봇 패널 '재평가' | 격리 상한 도달 SEV3 | 그림자 기간 표본 검토 |
| 원본 적재가 빠짐없음 | 마감 커버리지 대조, 적재 거절 기록 | — | 리포트 '데이터 품질' | 마감 보류(analytics §7), 거절 > 0 SEV3 | 마감 리포트 |

## 10. 시험 포인트

| # | 시나리오 | 합격 기준 | 연결 |
| --- | --- | --- | --- |
| ST-T1 | 같은 거래 사건을 두 번 보내고(`eventKey`가 같다), 누적 키를 처리한 뒤 TaskManager를 강제로 종료한다 | 판매 좌석·금액 누적이 정답과 같다(두 번 세지 않는다) | V-T13, analytics §4.4 |
| ST-T2 | 텔레메트리의 한 파티션에만 사건이 오고 나머지는 비어 있다(심장 박동 켬·끔) | 켬: 1초 칸이 2초 안에 나온다. 끔: 30초 뒤 빈 입력 표시로 이어지고, 그동안 신선도가 나빠져 보인다 | V-T14 |
| ST-T3 | 허용 지연 안(5초)과 밖(15초)으로 늦은 사건을 보낸다 | 안: 같은 칸이 고쳐지고 버전이 오른다. 밖: 버려지고 `numLateRecordsDropped`가 늘어난다 | 4.3.9 |
| ST-T4 | ClickHouse를 30초 멈춤 | 재시도 뒤에 들어가거나 버려진다. 버리면 버린 수가 세어져 SEV3가 뜨고, 누적은 다음 초에 맞는다. 원본 적재는 커버리지 대조가 빈 구간을 찾는다 | V-T15 |
| ST-T5 | 한 기기 가명으로 pid 6명이 10분 안에 사전 검증한다. 모드는 그림자다 | 후보 6건, `TrustVerdict` 그림자 6건, 격리 0건 | 4.3.8 |
| ST-T6 | 모드 적용, 격리 상한을 넘는 후보 | 상한까지만 격리되고 나머지는 그림자로 남는다. SEV3가 뜬다. 이미 입장한 사람은 격리되지 않는다 | 4.3.8 |
| ST-T7 | 세이브포인트와 맞지 않는 새 판 배포 | 커밋된 오프셋부터 읽고 `rt.seed`로 시작해, 누적이 정답과 같다(경계 재발행이 없을 때) | 4.3.1 PoC, RB-34 |
| ST-T8 | 다른 네임스페이스에서 Flink REST(8081)로 잡 업로드를 요청한다 | 연결이 막힌다. Operator에서는 상태 조회가 된다 | asvs/analytics 13.4.5 |
| ST-T9 | 같은 고정 사건 묶음(판매·반환·입금 되돌림과 다시 입금·부분 취소 포함)을 dbt 모델과 `ops-rt`에 넣는다 | 판매 좌석(전체·등급·구역)·판매 금액·확정 주문·발권 티켓이 골드와 같다. 다시 확정된 주문은 퍼널에 한 번만 들어간다 | 4.3.9, analytics §4.4 |
| ST-T10 | 좌석 하나에 PENDING → SOLD → PENDING(입금 되돌림) → SOLD → RETURNED와 그 중복을 보낸다 | 판매 좌석이 +1 → 0 → +1 → 0으로 바뀌고, 중복은 무시된다 | 4.3.1 |
| ST-T11 | 직전 릴리스로 고정 사건을 돌려 세이브포인트를 뜬 뒤 새 판으로 복원한다(`allowNonRestoredState` false) | 복원에 성공하고, 이어서 센 누적이 끊김 없이 같다. 상태 모양을 바꾼 판은 옛 판이 새 세이브포인트를 읽는지도 본다 | wbs 4.6.2, devops D-T20 |
| ST-T12 | 가명 키 요청(KMS)을 실패하게 함 | 원문을 쓰지 않고 잡이 실패·재시도하며, 소비 밀림 경보가 뜬다. KMS가 돌아오면 빠짐 없이 이어 간다 | 4.3.4 |

## 11. 용량 산정

입력량 [추정](대형 온세일 피크):

| 원천 | 초당 | 근거 |
| --- | --- | --- |
| `HoldAttempt` | 약 2,000 | NFR-003 홀드 피크 초당 2,000건 |
| `TrustVerdict` | 약 1,700 | 로비 사람 확인 검증 초당 1,700건(architecture §9.4) |
| `SeatEvent`(홀드 쪽 포함, 거르기 전) | 약 3,000 | 홀드 피크 + 판매 |
| `OrderEvent` | 약 1,500 | 결제 300 TPS × 주문 상태 약 5개(TPS: 초당 처리 건수) |
| `TicketEvent`, `PaymentEvent` | 약 1,800 | 발권(주문당 1~4매)과 결제 사건 |
| `QueueAggregate`, 구매 세션, 심장 박동 | 약 200 | queue-svc 파드 수, 입장 초당 약 28명, 3개 토픽 × 12 파티션 |
| 합 | 약 1만 | NFR-009 시험 부하(초당 3만 건)는 이 값의 약 3배다 |

- 병렬도가 4면 서브태스크마다 초당 2,500건 안팎이다. 키 중복 제거·합산은 서브태스크 하나가 이보다 훨씬 많이 처리할 수 있다고 어림했다. 이 어림은 4.3.9 측정으로 확인한다.

상태 크기 [추정]:

| 상태 | 키 수 | 크기 |
| --- | --- | --- |
| `ops-rt.dedupe.sale`(7일) | 대형 회차마다 판매류 사건 약 27만 개, 주에 약 100만 개 | 약 100MB |
| `ops-rt.seat-state`(180일) | 판매된 좌석 수, 약 400만 개 | 약 300MB |
| `ops-rt.dedupe.queue`(10분), `first-hold`(1일), 누적·칸 | 수만 개 | 수십 MB 이하 |
| `trust-reassess.r1`·`r2`(10분) | 로비 피크 10분 신호 약 100만 개 | 약 250MB |

- RocksDB의 키·값에 수명 표시(값마다 8바이트, Flink 문서)를 더해 키당 약 80~100바이트로 잡았다. 증분 체크포인트라서 매번 올리는 양은 바뀐 부분뿐이다. S3에 남는 양은 잡마다 상태 1벌과 세이브포인트 기록이므로 수 GB 안이다.

## 12. 실패 처리

| 장애 | 잡의 동작 | 화면과 경보 | 회복 |
| --- | --- | --- | --- |
| 텔레메트리 MSK 장애 | 텔레메트리 소스가 멈추고 심장 박동도 끊긴다. 거래 누적은 이어진다 | 신선도가 나빠지고 3분 뒤 Degraded 전환, SEV3 | Kafka가 돌아오면 커밋 위치에서 이어 읽는다 |
| 거래·제어 MSK 장애 | 판매 누적이 멈춘다. 심장 박동은 텔레메트리 쪽으로 지나므로 신선도는 정상으로 보인다 | 거래 소스 `sourceIdleTime` 경보(SEV3), CDC 지연 | 위와 같다. 그동안 판매 숫자 옆에 '거래 사건 끊김'을 보여 준다 |
| Schema Registry 장애 | 캐시한 스키마 ID는 계속 읽는다. 새 스키마 ID는 거절로 간다 | 거절 수 경보(SEV3) | 레지스트리가 회복되면 거절 구간을 다시 적재한다(RB-34) |
| ClickHouse 장애 | 싱크가 3회 재시도한 뒤 묶음을 버리거나, 역압이 쌓인다 | 버림 수 SEV3, 신선도 악화와 Degraded | 누적은 다음 초에 맞는다. 칸은 누락으로 남는다. 원본 적재는 커버리지 대조로 다시 적재한다 |
| S3 장애 | 체크포인트가 실패한다. 3회까지는 처리를 이어 간다 | 체크포인트 실패 SEV3 | 4회째에 잡이 실패한다. S3가 돌아오면 마지막 체크포인트로 복원한다 |
| KMS 장애(원본 적재) | 가명 키를 못 얻어 잡이 실패하고 재시도한다(원문은 쓰지 않는다) | 소비 밀림 경보 | KMS가 회복되면 이어 간다 |
| JobManager 장애 | `ops-rt`는 대기 JobManager가 이어받고, 나머지는 쿠버네티스가 다시 띄운다 | 신선도 잠깐 악화 | HA 메타데이터로 마지막 체크포인트에서 복원한다 |
| TaskManager 장애 | 잡이 마지막 체크포인트에서 재시작한다. `ops-rt`는 예비 TaskManager를 바로 쓴다 | 재시작 수, 신선도 잠깐 악화 | 표는 덮어쓰기라서 다시 쓴 값이 같다. 누적은 몇 초 동안 잠깐 뒤로 갈 수 있다(§4.3) |
| Operator 장애 | 돌던 잡은 계속 돈다. 업그레이드·자동 복구만 멈춘다 | Operator 파드 상태 | Operator가 회복되면 FlinkDeployment 상태를 다시 맞춘다 |
| 읽지 못한 레코드 | 원본 적재는 거절 기록을 남기고, 나머지 잡은 거절 수만 센다 | 거절 > 0 SEV3 | 코드를 고쳐 Kafka 보관 기간 안에 다시 적재한다 |
| 시계 차이 | 심장 박동의 발행 시각은 `rt-pulse`가 도는 노드의 시계 기준이다 | 노드 시계 오프셋 경보(20ms, observability §5) | — |

## 13. 이미지·배포·시험 도구

- **저장소**: peaket-data에 `flink/common`(소스·싱크 만들기, Kafka·레지스트리·ClickHouse 설정, 가명 처리, 지표), `flink/ops-rt`, `flink/analytics-ingest`를 둔다. peaket-trust의 `flink/trust-reassess`는 `flink/common`을 GitHub Packages(Maven)에서 버전을 지정해 받는다. 빌드는 Gradle과 Java 17로 한다 [추천 적용].
- **이미지**: 공식 Flink 2.2 Java 17 이미지(다이제스트 고정)에 잡 JAR(`/opt/flink/usrlib/<잡>.jar`, 커넥터와 MSK IAM 라이브러리 포함)과 S3 Presto 플러그인(`/opt/flink/plugins/`)을 넣는다. 공용 빌드 워크플로가 SBOM(소프트웨어에 들어간 부품 목록)·서명·출처 증명(어느 커밋에서 어떤 빌드 절차로 만들었는지 서명해 남긴 기록)을 붙인다(devops §4). 클러스터 입장 정책이 그 서명을 확인한다.
- **차트**: `peaket-gitops/charts/peaket-flink-job/`이 FlinkDeployment, 서비스 계정, 네트워크 정책, ExternalSecret, PodMonitor를 만든다. 환경 값은 `envs/<환경>/<잡>.yaml`(이미지 다이제스트, 병렬도, 자원)이고, AppProject는 `data`·`trust`다(devops §5.2).
- **배포 흐름**: 잡 저장소 PR(코드 변경을 합쳐 달라는 요청) → CI(코드를 올릴 때마다 자동으로 하는 검사·빌드. 단위·통합·세이브포인트 호환 시험) → 이미지 다이제스트 갱신 PR → ArgoCD 동기화(동결 창에는 막힌다) → Operator 세이브포인트 업그레이드 → 확인(Operator `STABLE`, 첫 체크포인트, 신선도, 누락률).
- **시험**:
  1. 연산자 단위: Flink 연산자 시험 도구(test harness)로 상태 수명, 타이머(1초 경계, 키·시각마다 하나), 허용 지연, 좌석 상태 기계를 본다.
  2. 잡 통합: 내장 클러스터(MiniCluster)와, 컨테이너(앱과 실행 환경을 한 묶음으로 만든 실행 단위)로 띄운 Kafka, Schema Registry, ClickHouse를 써서 ST-T1~T4·T9·T10을 돌린다.
  3. 세이브포인트 호환: 직전 릴리스 JAR로 고정 사건을 돌려 세이브포인트를 뜨고 새 JAR로 복원한다(ST-T11, devops D-T20).
  4. 계약: Avro 호환은 `contract-check.yml`(BACKWARD_TRANSITIVE)이 본다. `PipelinePulse` 건너뛰기와 새 필드는 소비자 계약 시험으로 본다.
  5. 성능: docs/verification.md §3.7(V-T12~V-T15).

## 14. 대시보드·경보·런북

- **대시보드 'Flink 잡'**(지표와 로그를 그래프로 보여 주는 도구 Grafana, 잡마다): 상태와 가동 시간(`runningTime`), 재시작 수(`numRestarts`), 소비 대기(`pendingRecords`), 소스 쉼(`sourceIdleTime`), 워터마크 지연(`watermarkLag`), 바쁨·역압(`busyTimeMsPerSecond`·`backPressuredTimeMsPerSecond`), 체크포인트(`lastCheckpointDuration`·`lastCheckpointSize`·`numberOfFailedCheckpoints`), 늦어서 버린 수(`numLateRecordsDropped`), 거절 수, 싱크(`numOfDroppedRecords`·`totalBatchRetries`·`writeLatencyHistogram`·`actualRecordsPerBatch`), 신선도(`rt_freshness_seconds{path}`), 심장 박동 수, 재평가(후보·격리·상한).
- **경보**: §9 표의 경보를 observability §5의 'Flink 잡 신호'로 둔다. 모두 SEV3(`kind` hygiene, 재평가 상한만 control)이다. 운영 명령이 아니라 엔지니어 호출과 런북으로 이어진다. 관제 실시간 표가 낡으면 Degraded 전환은 자동으로 일어난다.
- **런북**: RB-34 'Flink 잡 복구'(infra §10): ① Operator 상태와 쿠버네티스 이벤트로 멈춤·되풀이 실패·업그레이드 실패를 가른다 ② 의존성 장애면 회복을 기다리고(표 §12), 코드 문제면 이전 이미지로 되돌린다 ③ 세이브포인트가 맞지 않으면 커밋된 오프셋에서 다시 시작하고, `ops-rt`는 시작값(§4.7)을 만든다 ④ 원본 적재의 빈 구간과 거절 구간을 Kafka 보관 기간 안에 다시 적재한다 ⑤ 마감 리포트의 실시간 대비 대조와 커버리지를 확인한다.

## 15. 남는 한계

- 시작값 경계를 넘는 재발행 중복은 실시간 표에서 두 번 세어질 수 있다. 이 차이는 R0 대조에서 드러난다.
- 누적의 버전이 처리 시각이라서 재시작 직후 몇 초 동안 숫자가 잠깐 뒤로 갈 수 있다.
- 심장 박동 신선도는 텔레메트리 경로만 잰다. 거래 쪽 앞단 지연과 끊김은 CDC 지연 지표와 거래 소스 쉼 경보로 본다. Prometheus 판단 숫자의 신선도는 제어 입력 없음 규칙(ADR-0069)으로 본다.
- ClickHouse 공식 커넥터의 Flink 2.2 동작, MSK IAM 라이브러리의 Pod Identity 자격 증명, 읽기 전용 루트 파일 시스템은 확인 필요다(wbs 4.3.1 PoC).
- 판매 좌석·금액의 규칙이 지표 사전과 같은지는 ST-T9로만 확인한다. 지표 사전이 바뀌면 이 잡의 규칙도 같은 PR에서 바꾼다.
- R1은 공용 기기(PC방, 가족 태블릿)를 잡을 수 있다. 격리는 추가 검증이라서 사람은 통과한다. 상한과 그림자 모드 시작으로 피해 규모를 묶어 둔다.
- R2는 녹화한 움직임을 재생하면서 잡음을 섞는 봇을 놓친다. CEP를 쓰지 않으므로 순서 패턴은 브라우저 요약값(입력 간격 분산)과 서버 쪽 신호에만 기댄다.
- 수치(워터마크 여유, 허용 지연, 체크포인트 설정, 상태 수명, 병렬도·자원, 싱크 묶음, 패턴 숫자, 격리 상한, 지연 예산, 파티션 수)는 [가정]이고, 4.3.1·4.3.8·4.3.9와 그림자 기간의 표본 검토에서 정한다.

## 16. 참고 자료(2026-10-20 확인)

- Apache Flink 2.2 문서: [Windows](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/datastream/operators/windows/)(허용 지연 기본 0, 슬라이딩 겹침, 세션 창), [Generating Watermarks](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/datastream/event-time/generating_watermarks/)(빈 입력과 `withIdleness`), [Process Function](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/datastream/operators/process_function/)(타이머는 키·시각마다 하나), [Working with State](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/datastream/fault-tolerance/state/)(수명은 처리 시각만, 원소마다 수명, RocksDB 압축 때 정리, 값마다 8바이트), [Kafka 커넥터](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/connectors/datastream/kafka/)(시작 위치, 파티션 발견 기본 5분, 체크포인트 때 오프셋 커밋, 소스 지표, 싱크 전달 보장 기본 `NONE`), [Performance Tuning](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/table/tuning/)(MiniBatch·Local-Global), [Configuration](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/deployment/config/)(체크포인트·상태·재시작 키와 기본값, `web.*`, `slotmanager.redundant-taskmanager-num`), [Metrics](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/ops/metrics/)(`numLateRecordsDropped`, `numRestarts`, 역압·체크포인트 지표), [Metric Reporters](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/deployment/metric_reporters/)(Prometheus 리포터, 기본 포트 9249), [Kubernetes HA](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/deployment/ha/kubernetes_ha/), [Amazon S3](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/deployment/filesystems/s3/)(체크포인트에 Presto 구현 권장), [Checkpoints](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/ops/state/checkpoints/)(`shared/` 폴더), [Large State Tuning](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/ops/state/large_state_tuning/)(증분 체크포인트), [Confluent Avro 형식](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/connectors/table/formats/avro-confluent/)(`flink-avro-confluent-registry` 2.2.1), Flink 소스 저장소 release-2.2의 `ConfluentRegistryAvroDeserializationSchema`(`forSpecific`·`forGeneric`)
- Flink Kubernetes Operator 1.16: [Job Management](https://nightlies.apache.org/flink/flink-kubernetes-operator-docs-release-1.16/docs/custom-resource/job-management/)(업그레이드 모드, 자동 확장 반영, Blue/Green), [Reference](https://nightlies.apache.org/flink/flink-kubernetes-operator-docs-release-1.16/docs/custom-resource/reference/)(`flinkVersion` v2_2, `replicas`는 HA일 때만 1보다 큼, `allowNonRestoredState`), [Pod Template](https://nightlies.apache.org/flink/flink-kubernetes-operator-docs-release-1.16/docs/custom-resource/pod-template/)(`flink-main-container`, `resources`), [Configuration](https://nightlies.apache.org/flink/flink-kubernetes-operator-docs-release-1.16/docs/operations/configuration/)(마지막 체크포인트 대체 기본 켜짐, 세이브포인트 기록 1일·10개, `job.autoscaler.enabled` 기본 꺼짐). 영어 주소가 중국어 경로로 넘어가지만 내용은 영어다. [Flink 내려받기](https://flink.apache.org/downloads/)(버전과 커넥터 호환)
- ClickHouse 문서: [Flink 커넥터](https://clickhouse.com/docs/integrations/apache-flink)(DataStream만, 버전 호환, 적어도 한 번, `ClickHouseAsyncSink` 설정, 기본 재시도 3회, 서버 설정 전달, 기본 RowBinary, 버림 지표), [Asynchronous inserts](https://clickhouse.com/docs/optimize/asynchronous-inserts)(쓰기 조건, 적응형 시간, `wait_for_async_insert`, 26.2부터 중복 제거), [ReplacingMergeTree](https://clickhouse.com/docs/engines/table-engines/mergetree-family/replacingmergetree)(병합 때만 중복 제거), [Deduplicating inserts on retries](https://clickhouse.com/docs/guides/developer/deduplicating-inserts-on-retries)
- AWS 문서: [Configure clients for IAM access control](https://docs.aws.amazon.com/msk/latest/developerguide/configure-clients-for-iam-access-control.html)(Java 클라이언트 `AWS_MSK_IAM` 설정)
