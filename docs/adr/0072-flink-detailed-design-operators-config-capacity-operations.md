# ADR-0072: Flink 상세 설계 — 연산자·상태, 설정값, 표 정의, 용량, 실패 처리, 배포·시험, 운영(2026-10-20)

- **상태**: 채택 (2026-10-20. ADR-0071 반영 뒤 소유자가 "flink 설계쪽도 구체화 해주세요"라고 요청했다. ADR-0071의 결정은 그대로 두고, 잡마다 연산자·상태·설정값·표·용량·실패 처리·배포·경보를 docs/streaming.md에 구현 수준으로 적었다. 이 과정에서 고친 세부(실시간 표 누적의 버전, 심장 박동 표, 중복 제거 수명, 잔여석 정의, 좌석 사건의 등급·구역 필드)는 아래 결정 2~4에 적었다. 모든 세부는 추천 적용 2026-10-20이고 수치는 [가정]이다.) 같은 날 검토 목록 네 가지(병렬도 4와 `ops-rt`의 JobManager 2대(대기 1대)·예비 TaskManager 1대, 체크포인트 허용 실패 3회, 상태 수명(판매류 중복 제거 7일, 좌석 판매 상태 180일), Flink 잡 경보의 SEV3)에 소유자가 "추천대로 가주세요"라고 해 승인으로 확정했다. 숫자는 측정 전 가정값으로 남아 4.3.9 측정과 운영에서 고친다. 2026-10-20(ADR-0073, 3차 전수 점검): 판매 금액은 승인 금액 합(총액, 입금 되돌림만 뺌)으로, 확정 주문·퍼널·발권 누적은 주문·티켓마다 처음 한 번만 세는 규칙으로, 누락률에 거절 수를 넣었고 Flink 파드도 서비스 메시 mTLS로 둔다(docs/streaming.md §2.3·§4). 2026-10-26(4차 점검 3부): 위 보완의 '처음 한 번만 세는 규칙'은 퍼널 단계 누적에만 해당하고, 확정 주문·발권 티켓 누적은 지금 확정·유효한 수(입금 되돌림·무효는 뺌)로 읽는다(ADR-0073 결정 3, docs/streaming.md §4.1). 결정 4의 계약 클래스 역직렬화는 레코드가 한 종류인 토픽에만 쓰고, 여러 종류가 실리는 토픽은 유니온 읽기 스키마나 레코드 이름별 분기로 읽는다(wbs 0.2.2에서 정함, ADR-0084 결정 5, docs/streaming.md §2.6). 2026-10-27(ADR-0099, 소유자 결정 'B안'): Flink를 빼서 이 ADR의 연산자·UID·설정 키·FlinkDeployment·RocksDB·세이브포인트 호환 시험·`rt` 덮어쓰기 표는 쓰지 않는다. 판매 좌석 상태 규칙(결정 3: 마지막 판매 상태, 입금 되돌림 포함), `SeatEvent` 등급·구역, 거절 기록(결정 7), 경보의 SEV3 등급은 스트림 작업자 설계로 옮겼다. D-T20은 '스트림 작업자 판 올리기', RB-34는 '스트림 작업자 복구'로 바꿨다(docs/streaming.md).
- **관련**: ADR-0026, ADR-0052, ADR-0053, ADR-0054, ADR-0057, ADR-0068, ADR-0069, ADR-0070, ADR-0071, NFR-009, NFR-022, POL-028, docs/streaming.md(§1~§16), docs/features/analytics.md §3.4·§5.5, docs/api/asyncapi.yaml(`SeatEvent`, `PipelinePulse`, 소비 작업), docs/observability.md §5·§9·§14, docs/infra.md §10(RB-34), docs/devops.md §5.2·§6.5·§14, docs/security/asvs/analytics.md, docs/security/data-classification.md, wbs 4.3.1·4.3.3·4.3.4·4.3.9·4.6.2·4.7.1

## 맥락

- ADR-0071은 잡 셋과 규칙(덮어쓰기, 심장 박동, 지표 출처 표, 대기 중 재평가, 버전 고정)을 정했지만, 구현에 필요한 연산자 구성, 상태와 수명, 설정 키와 값, 표 정의, 자원, 장애별 동작, 배포·시험 도구, 경보와 런북은 비어 있었다.
- 구체화하다 보니 ADR-0071의 몇 가지 세부가 그대로는 안 맞았다.
  1. 누적의 버전을 '처리 건수'로 두면, 상태를 잃거나 시작값에서 다시 시작할 때 건수가 0부터 다시 올라가 표의 옛 행(더 큰 버전)이 이긴다. 그러면 새 값이 화면에 나오지 않는다.
  2. 심장 박동을 별도 표(`rt.pulse`)에 바로 쓰면 1초 칸 창과 누적 타이머를 지나지 않아, 정작 재야 할 창 대기를 신선도에서 뺀다.
  3. 거래 사건 7일 중복 제거를 `trade.seats` 전체에 걸면 홀드 사건(피크 초당 수천 건)까지 7일 동안 기억해야 한다. 그런데 판매 좌석에는 판매 상태 사건만 필요하다.
  4. 주문 상태도에서 가상계좌 입금 오류는 Confirmed → AwaitingDeposit이고 좌석은 SOLD → PENDING으로 돌아간다(planning/03 §2). 'SOLD는 +1, RETURNED는 −1'만으로는 판매 좌석이 틀린다.
  5. `SeatEvent`에는 등급·구역이 없어 판매 좌석을 등급·구역별로 셀 수 없다.
  6. 잔여석을 '판매 대상 − 판매 − 홀드 중'으로 두면 홀드 사건(Redis Stream 릴레이)과 판매 사건(Outbox)의 순서가 서로 보장되지 않아 홀드 중 수가 어긋난다.
- 확인한 사실(2026-10-20 원문):
  - Apache Flink 2.2 문서: 타이머는 키·시각마다 하나라 같은 시각에 여러 번 걸어도 한 번 불린다. 상태 수명은 처리 시각만 지원하고 목록·맵은 원소마다 끝나며, RocksDB는 압축 때 끝난 상태를 지우고 값마다 8바이트를 더 쓴다. 수명을 짧은 값에서 긴 값으로 바꿔 복원하는 것은 권하지 않는다. 설정 키와 기본값: `execution.checkpointing.interval`(없음), `min-pause`(0), `timeout`(10분), `tolerable-failed-checkpoints`(0), `externalized-checkpoint-retention`(`NO_EXTERNALIZED_CHECKPOINTS`, 값은 `DELETE_ON_CANCELLATION`·`RETAIN_ON_CANCELLATION`), `incremental`(false), `num-retained`(1), `state.backend.type`(`hashmap`), `restart-strategy.exponential-delay.*`(처음 1초, 최대 1분, 1.5배, 1시간, 지터 0.1), `pipeline.max-parallelism`(-1). Kafka 소스는 `committedOffsets(OffsetResetStrategy.EARLIEST)`·`timestamp`·`latest`로 시작 위치를 정하고 파티션 발견 기본은 5분이며, `pendingRecords`·`sourceIdleTime`·`watermarkLag`를 낸다. Kafka 싱크 전달 보장 기본은 `NONE`이고 `AT_LEAST_ONCE`는 체크포인트 때 남은 레코드의 확인을 기다린다. Prometheus 리포터는 `PrometheusReporterFactory`, 기본 포트 9249다. 쿠버네티스 HA는 `high-availability.type: kubernetes`와 `high-availability.storageDir`이다. S3 체크포인트에는 `flink-s3-fs-presto`를 권한다. 체크포인트 폴더의 `shared/`는 여러 체크포인트가 함께 쓰는 상태다. `flink-avro-confluent-registry` 2.2.1이 있고 release-2.2 소스에 `ConfluentRegistryAvroDeserializationSchema.forSpecific`이 있다. 지표 `numRestarts`, `busyTimeMsPerSecond`, `backPressuredTimeMsPerSecond`, `lastCheckpointDuration`, `numberOfFailedCheckpoints`가 있다.
  - Flink Kubernetes Operator 1.16 문서: `flinkVersion`에 `v2_2`가 있다. JobManager `replicas`는 HA가 아니면 1이어야 한다. 자원은 쿠버네티스 표준 `resources`(요청·한도)이고 옛 `resource` 표기는 폐기 예정이다. 주 컨테이너 이름 `flink-main-container`는 바꾸면 안 된다. `kubernetes.operator.job.upgrade.last-state-fallback.enabled` 기본 켜짐, 세이브포인트 기록 1일·10개, `job.autoscaler.enabled` 기본 꺼짐.
  - ClickHouse 문서: `ClickHouseAsyncSink`는 요소 변환기와 `maxBatchSize`·`maxInFlightRequests`·`maxBufferedRequests`·`maxBatchSizeInBytes`·`maxTimeInBufferMS`·`maxRecordSizeInBytes`·클라이언트 설정을 받고, 서버 설정(예: `insert_deduplicate`)을 넘길 수 있다. 기본 형식은 RowBinary 계열이고 묶음을 기본 3회 다시 넣은 뒤 버린다. 묶음이 작거나 너무 자주 보내면 병합이 밀려 느려진다.
  - AWS 문서: MSK IAM 인증의 Java 클라이언트 설정은 `SASL_SSL`, `AWS_MSK_IAM`, `IAMLoginModule`, `IAMClientCallbackHandler`다.

## 결정

1. **상세 설계는 docs/streaming.md에 둔다(추천 적용).** §2 실행 기반(버전·산출물, FlinkDeployment 요지, 권한·네트워크 정책, 체크포인트·상태·재시작 설정 표, 자원, Kafka 연결, 지표·로그), §4.2·§5.8·§6.1 연산자 표(UID 고정), §4.3·§6.3 표 정의, §11 용량, §12 실패 처리, §13 이미지·배포·시험, §14 대시보드·경보·런북이다.
2. **실시간 표의 세부를 고친다(ADR-0071 결정 2·5 보완).**
   - 누적의 버전은 내보낸 처리 시각(ms)이다. 상태를 잃거나 시작값에서 다시 시작해도 새 행이 이긴다. 대가로 재시작 직후 몇 초 동안 숫자가 잠깐 뒤로 갈 수 있다. 1초 칸의 버전은 그대로 사건 수다.
   - 누적 키는 30일 동안 갱신이 없으면 지우고, 다시 사건이 오면 `rt.seed`, 없으면 `rt.cumulative`의 마지막 값을 한 번 읽어 이어 센다. 시작값 절차와 같은 경로다.
   - 심장 박동은 별도 표에 쓰지 않고 다른 사건과 같은 연산자를 지나 `rt.cumulative`·`rt.bucket`의 `_pulse` 행으로 남긴다. 신선도는 두 길(1초 칸, 누적)로 재고 큰 값을 쓴다. 1초 칸의 심장 박동 수가 파티션 수보다 작으면 늦거나 빠지는 파티션이 있다.
   - 지연 예산에 '워터마크가 나아가는 간격(심장 박동 1초)'을 넣어 최악 합을 약 3.9초 [추정]로 고쳤다.
3. **판매 좌석은 좌석 판매 상태 기계로 센다(추천 적용).** 회차·좌석마다 마지막 판매 상태(없음·PENDING·SOLD·RETURNED)와 등급·구역을 두고, SOLD로 들어가면 +1, SOLD에서 나가면 −1이다(입금 되돌림 포함). 판매 상태 사건은 Outbox 한 곳에서 회차 키로 순서대로 온다. 상태 수명은 마지막 변경 뒤 180일 [가정]이고, 상태가 없을 때는 사건 종류가 뜻하는 이전 상태로 본다. `SeatEvent`에 `tierId`·`sectionId`(선택 필드)를 더한다. 중복 제거는 판매류 사건(좌석 판매 상태, 주문, 결제, 발권)만 7일, `QueueAggregate`는 10분이고, 홀드 쪽 좌석 사건은 쓰지 않는다. 잔여석은 '판매 대상 − 판매 좌석'이고 홀드와 결제 진행 중은 빼지 않는다(좌석맵 화면이 따로 보임). 판매 좌석·금액 규칙이 지표 사전과 같은지는 같은 고정 사건을 dbt 모델과 잡에 넣어 시험한다(ST-T9).
4. **입력과 연결(추천 적용).** `ops-rt`는 첫 홀드 상태를 지우려고 `trade.purchase-sessions`(세션 종료)도 읽는다. 잡은 MSK 클러스터마다 소스를 하나씩 두고, 소비자 그룹은 `peaket.<잡>.<환경>`, 커밋이 없을 때 시작 위치는 거래·원본 적재가 EARLIEST, 텔레메트리 1초 칸과 재평가가 LATEST다. 인증은 MSK IAM, 역직렬화는 Confluent 레지스트리 Avro(계약 클래스)를 레코드 역직렬화기 안에 싸 토픽·파티션·오프셋을 함께 넘긴다. Kafka 싱크는 `AT_LEAST_ONCE`를 적는다.
5. **실행 설정(추천 적용).** 애플리케이션 모드, 쿠버네티스 HA, 상태 버킷 `peaket-flink-state-<환경>`(SSE-KMS), RocksDB·증분 체크포인트(`ops-rt`·`trust-reassess`), `tolerable-failed-checkpoints` 3, `RETAIN_ON_CANCELLATION`, 재시작은 `exponential-delay` 기본값, `pipeline.max-parallelism` 128, `allowNonRestoredState: false`. 병렬도는 잡마다 4, `ops-rt` JobManager 2대(대기 1)와 예비 TaskManager 1대다. 자원·간격·수명은 §2.4·§2.5의 [가정]이다.
6. **보안(추천 적용).** 잡마다 서비스 계정과 Pod Identity 역할을 나누고(S3 접두사, KMS, MSK 토픽·그룹, ClickHouse 사용자), 네트워크 정책은 Operator → REST(8081), Prometheus → 지표(9249), 잡 안 파드끼리, MSK·레지스트리·ClickHouse·S3·KMS·STS·쿠버네티스 API만 연다. 파드는 Pod Security Standards Restricted를 맞춘다. 원본 적재는 가명 키를 못 얻으면 원문을 쓰지 않고 실패한다(fail-closed).
7. **읽지 못한 레코드(추천 적용).** 원본 적재는 원문을 복사하지 않고 위치만 `bronze.brz_rejected`에 남긴다(원문은 Kafka 7일 안에 다시 적재). 커버리지 대조는 거절 오프셋을 구간에 넣는다. 다른 잡은 거절 수만 센다. 거절 1건 이상이면 SEV3다.
8. **정리 규칙(추천 적용).** 체크포인트는 1개만 남기고 세이브포인트 기록은 Operator가 정리한다. 체크포인트 `shared/`에는 나이 기준 수명 규칙을 두지 않는다(여러 체크포인트가 함께 쓰는 파일). 버킷 수명 규칙은 `savepoints/` 90일 [가정]뿐이다.
9. **배포·시험(추천 적용).** 공용 모듈 `flink/common`(GitHub Packages Maven), Gradle·Java 17, 공식 이미지 + 잡 JAR + S3 Presto 플러그인, 공용 차트 `peaket-gitops/charts/peaket-flink-job`(FlinkDeployment·서비스 계정·네트워크 정책·ExternalSecret·PodMonitor). CI에 세이브포인트 호환 시험(직전 릴리스 → 새 판 복원)을 둔다(devops D-T20). 시험 ST-T9~T12를 더한다.
10. **운영(추천 적용).** 'Flink 잡' 대시보드, 경보(재시작 10분 3회, 소비 대기 10분 증가, 온세일 중 거래 소스 60초 쉼, 체크포인트 연속 실패, 거절 > 0)는 모두 SEV3이고 observability §5에 둔다. 런북 RB-34 'Flink 잡 복구'를 더한다.
11. **일정(WBS).** 4.3.1 +1일(공용 모듈·차트·네트워크 정책·보안 컨텍스트, 좌석 판매 상태·첫 홀드 연산자, 대시보드), 4.3.4 +0.5일(거절 기록, 다시 적재 명령), 4.6.2 +0.5일(세이브포인트 호환 시험), 4.7.1 +0.25일(RB-34). 4.3.3(`SeatEvent` 필드)과 4.3.9(ST-T9)는 설명만 더한다. 합계 +2.25일 [가정]이다.

## 검토한 대안

| 대안 | 판단 |
| --- | --- |
| 누적 버전을 처리 건수로 두고 상태를 잃으면 표의 버전을 읽어 이어 감 | 기각. 매번 마지막 버전을 읽어야 하고, 읽기를 빠뜨리면 화면이 멈춘다. 처리 시각 버전은 잠깐 뒤로 가는 것 말고는 실패 방식이 없다 |
| 심장 박동을 별도 표에 바로 씀(ADR-0071 원안) | 기각. 창 대기를 재지 않는다 |
| 좌석 사건 전체를 7일 중복 제거 | 기각. 홀드 사건까지 기억해 상태가 커지고, 판매 좌석에는 필요 없다 |
| 판매 좌석을 SOLD +1·RETURNED −1 계수로 셈 | 기각. 입금 되돌림(SOLD → PENDING)을 놓친다 |
| 좌석 등급·구역을 잡 안에서 기준 자료로 찾아 붙임 | 기각. 오픈 직후 조회가 막히면 잡이 멈추고 기준 자료 적재에 의존한다. 생산자(purchase-svc)는 좌석 등급을 이미 안다 |
| 읽지 못한 원본 레코드를 Kafka 데드 레터 토픽에 복사 | 기각. 가명 처리 전 식별값이 다른 토픽에 한 벌 더 생긴다 |
| 세션 클러스터 하나에 잡 셋 | 기각(ADR-0071). 화면 업로드를 꺼도 REST로 잡을 받는다 |

## 결과와 트레이드오프

- 새 결정 기록 1개(ADR 71 → 72), 런북 33 → 34(RB-34), 시험 ST-T9~T12와 devops D-T20, WBS 176개·393.5일 → 395.75일(+2.25일), 문제 대장 R-81, 용어 2개(체크포인트, 세이브포인트). NFR 수와 목표값은 그대로다.
- 상태는 `ops-rt` 약 0.5GB, `trust-reassess` 약 0.25GB [추정]다. 증분 체크포인트라 매번 올리는 양은 작다.
- 누적 숫자는 재시작 직후 몇 초 동안 뒤로 갈 수 있다. 잠정 숫자라 받아들인다.
- 잔여석이 홀드·결제 진행 중을 빼지 않아 화면의 잔여석이 실제 살 수 있는 좌석보다 많아 보일 수 있다(홀드 TTL과 결제창 유지 시간 동안).

## 되돌릴 조건

- 4.3.9에서 신선도 p95가 5초를 넘으면 칸 크기·워터마크 여유·심장 박동 간격·싱크 묶음을 고친다.
- ST-T9에서 판매 좌석·금액이 골드와 다르면 지표 사전과 이 잡의 규칙을 같은 PR에서 맞춘다.
- 4.3.1 PoC에서 ClickHouse 커넥터·MSK IAM 라이브러리·읽기 전용 루트 파일 시스템이 안 되면 docs/streaming.md §2.1의 대안(Flink 1.20 LTS 등)과 §2.3의 완화로 바꾸고 남는 한계에 적는다.

## 남는 한계

- 시작값 경계를 넘는 재발행 중복, 재시작 직후 누적의 잠깐 뒤로 감, 판매 좌석 규칙이 지표 사전과 같은지는 시험으로만 확인한다는 점은 docs/streaming.md §15에 적었다.
- 파티션 수(토픽마다 12개)와 자원은 [가정]이고 계약 저장소와 4.3.9 측정에서 정한다.
- ClickHouse의 Keeper와 클러스터 이름 같은 복제 설정은 이 문서에서 정하지 않았다(infra §4의 복제 2벌을 따름).
