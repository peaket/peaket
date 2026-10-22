# ADR-0076: 관측 아키텍처를 레퍼런스와 대조해 보강한다 — 수집기 2단 구성, 지표는 Prometheus가 긁기, 수집 대상 목록, 브라우저 수집 경로, 이상 탐지·자동화 원칙(2026-10-21)

- **상태**: 채택 (2026-10-21. 소유자가 관측 가능성 레퍼런스 아키텍처 그림을 보이며 현재 구조와 모범 사례를 조사해 달라고 했다. 그림의 흐름은 계측 원천 세 가지 → 컬렉터 → 추적·메트릭·로그·프로파일·이상 탐지 → 객체 스토리지 → AIOps·근본 원인 분석·데이터 분석이다. 대조 보고를 본 뒤, 추천안 '보강해 주세요'(컬렉터 2단 구성, 수집 대상 목록, 문서 충돌 정리, 이상 탐지·AIOps 원칙 기록)에 '승인'했다. 결정 하나하나의 세부는 추천 적용이며 소유자 검토 대상이다. 외부 사실은 2026-10-21에 각 공식 문서와 GitHub 원문으로 확인했다) 2026-10-21 소유자 검토: 게이트웨이 수집기 복제 3과 브라우저 표본 비율(대기·로비 1%, 좌석 선택·결제 100%, 그 밖 10%)은 소유자가 "판단이 안 서지만 추천대로 가주세요"라고 정했다. 측정 전 값이라 가정 표시는 그대로 두고 4.1.4에서 확정한다. 같은 때 소유자가 머신러닝 이상 탐지를 쓰지 않는 것이 맞는지 물어 근거를 다시 확인했다. Datadog 이상 탐지 알고리즘은 같은 요일·같은 시각이 비슷하다는 반복 패턴을 가정하고 주간 패턴이면 최소 3주치 기록이 필요한데(Datadog 문서 2026-10-21), 오픈은 공연마다 규모와 시각이 달라 그 가정이 맞지 않는다. 포트폴리오에는 합성 데이터만 있어(planning/01 §4.2) 학습 모델이 배우는 것은 시험 스크립트의 모양이다. 봇 판정의 머신러닝 모델(그림자 실행 뒤 적용, docs/features/queue-admission.md §7)은 결정 9와 따로다. 결정 9의 'AWS 성숙도 모델 3단계(상관·이상 탐지)를 목표로 한다'는 넘친 표현이다. 원문 3단계 설명에는 평소 패턴과 다른 값을 거의 실시간으로 알리는 이상 탐지기가 들어 있으므로, 정확히는 '3단계 가운데 신호 상관까지, 이상 탐지는 규칙·통계로 대신'이다(docs/observability.md §13 고침). 같은 날 소유자 결정: "확정하되, Phase 4에서 Datadog을 체험할 때 Watchdog 이상 탐지를 사람을 부르지 않는 힌트로 켜 두고, Game Day에서 넣은 장애를 우리 규칙보다 먼저 잡는지와 헛경보 수를 세어 주세요." 결정 9를 확정하고 wbs 4.8.2에 비교 측정을 더했다(+0.5일). 세부(추천 적용)는 docs/observability.md §13 'Datadog 이상 탐지 힌트 비교'와 docs/perf-ledger.md §8이다. 원문에서 확인한 제약(2026-10-21, Datadog 문서): Watchdog은 지표 이상에 최소 2주, 오류 로그 이상에 24시간 기록이 있어야 찾기 시작하고(6주가 가장 좋음), 로그 이상은 10분 넘게 이어진 오류 로그만, 요청 추적은 초당 0.5건 이상인 엔드포인트만 보며, 오류·지연 변화 없는 요청 수 변화는 무시한다. 무료 체험은 14일이다. 그래서 Watchdog의 지표 이상은 체험 안에서 거의 평가할 수 없어, 지표 쪽은 같은 계열 알고리즘의 이상 탐지 모니터(`basic`: 계절성 없이 적은 기록으로 바로 쓰는 알고리즘)로 대신 견주고 그 사실을 결과에 적는다. 판정 규칙은 측정 전에 고정한다. Datadog이 우리 규칙이 놓친 주입 장애를 1건 이상 잡고 헛경보가 시험 10시간당 1건 [가정] 이하이면 호출하지 않는 힌트 위젯을 새 ADR로 검토하고, 그렇지 않으면 결정 9를 그대로 둔다. 어느 쪽이든 사람 호출과 자동 조치에는 쓰지 않는다. 2026-10-21(ADR-0077): 결정 2·결정 5의 exemplar 라이브러리 이름 prom-client는 `@prometheus-io/client`로 바뀌었다(npm에서 옛 패키지 지원 종료 표시). 결정 1의 게이트웨이 수집기가 Tempo로 보내는 추적은 운영 설계에서 Tempo 분배기가 관측 전용 Kafka에 쓴다(Tempo 마이크로서비스 모드). 결정 5의 브라우저 지표 히스토그램은 표준 칸 목록을 쓴다. 2026-10-21(ADR-0079): 결정 5의 브라우저 수집 경로는 앱마다 그 앱 게이트웨이가 아니라 화면 배포 넷 모두 gw-fan의 텔레메트리 입구로 보내고 CloudFront가 `X-Peaket-App`을 붙인다(gw-scanner는 CloudFront를 거치지 않고 gw-ops는 허용 IP만 받음). `RumSample`은 판 2로 넓혔다. 2026-10-21(ADR-0078 결정 3): 결정 2의 예외로 Tempo metrics-generator의 서비스 그래프 지표는 Mimir `raw` 테넌트로 바로 원격 쓰기를 한다(경보와 자동 제어 입력에는 쓰지 않는다, docs/observability.md §1).
- **관련**: ADR-0022(대역 외 제어), ADR-0026(Kafka 토픽), ADR-0049(관제 지표), ADR-0053(로그 가명·IP 앞부분), ADR-0054(공급망·이미지 서명), ADR-0065(T=0 진입의 사전 요청 없는 `text/plain`), ADR-0067·0068(관제 콘솔과 관측 도구, 관측 백엔드 판정, 제어 입력은 클러스터 안 Prometheus), ADR-0069(정규 로그 줄·표본 비율), ADR-0070(진단 증거·쿠버네티스 이벤트), ADR-0072(Flink 지표), ADR-0073, docs/observability.md §1·§2·§5·§6·§7·§9·§10·§11·§13, docs/infra.md §4, docs/architecture.md §3.1·§6.3, docs/api/asyncapi.yaml `telemetry.rum`, planning/03 용어 '텔레메트리 수집기', wbs 4.1.4·4.8.2

## 맥락

- 대조 결과(2026-10-21): 큰 틀은 레퍼런스와 같은 모양이다. 신호·저장·데이터 분석은 레퍼런스보다 촘촘하다. 빈칸은 다음과 같다.
  - ① **컬렉터**가 상자 하나로만 있다. 에이전트·게이트웨이 구분, 복제 수, trace ID 기준 부하 분산, 수집기 자신의 감시가 없다.
  - ② **수집 대상**: kube-state-metrics와 Aurora·ElastiCache·MSK·ClickHouse·CloudFront 지표를 어떻게 모을지가 없다.
  - ③ **지표 수집 방식**이 문서마다 다르다. 관측 구조도는 수집기가 Prometheus로 밀어 넣는 그림이고, Flink 문서는 Prometheus가 긁는다.
  - ④ **RUM 경로**가 문서마다 다르다. 관측 문서는 수집기 → Prometheus·ClickHouse, 이벤트 계약은 `telemetry.rum`을 4.8.2로 미룸, 분석 문서는 싣지 않음이다. 브라우저가 보내는 공개 수집 주소, 표본 비율, 브라우저 trace 전파 여부도 없다.
  - ⑤ **로그 표본**을 앱과 수집기 가운데 어디서 거르는지가 없다.
  - ⑥ **exemplar와 신호 연결 설정**이 한 줄뿐이다.
  - ⑦ **법정 접속기록 분기**를 어느 구성 요소가 하는지 이름이 없다.
  - ⑧ **Pyroscope 저장 위치**가 없다.
  - ⑨ architecture §3.1의 admission-ctrl 행에 'Kafka(관제 메트릭 발행)'가 있지만, 이벤트 계약에는 발행자가 없다.
  - ⑩ '시계열 선행 예측 모델'이라는 말에 정의가 없다(실제로는 `predict_linear`뿐).
  - ⑪ 이상 탐지·AIOps를 규칙 기반으로만 하는 이유가 적혀 있지 않다.
- 확인한 사실(2026-10-21 원문)
  - **OpenTelemetry 수집기 배포 패턴**
    - 수집기는 앱 옆이나 노드마다 두는 에이전트와, 중앙에 두는 게이트웨이로 나눈다.
    - 게이트웨이의 장점은 자격 증명과 샘플링·거르기 정책을 한곳에서 관리하는 것이다. 단점은 관리할 부품, 지연, 자원이 늘어난다는 것이다.
    - 테일 샘플링을 여러 복제로 돌리려면 앞단에 trace ID 기준 부하 분산 내보내기(load-balancing exporter)를 둔 2단 구성을 쓴다.
  - **쿠버네티스 시작 가이드**: 수집기를 두 벌 둔다. 노드마다 도는 DaemonSet은 노드·파드·컨테이너 지표와 로그를 맡고, Deployment는 클러스터 지표와 이벤트를 맡는다.
  - **테일 샘플링 프로세서(beta)**: 한 trace의 span은 모두 같은 수집기 인스턴스가 받아야 판정이 맞는다.
  - **부하 분산 내보내기**(추적·로그 beta, 지표 alpha)
    - `routing_key`로 `traceID`·`service` 등을 고른다.
    - 대상 목록은 고정(static), DNS(헤드리스 서비스), k8s 해석기로 얻는다.
  - **그 밖의 구성 요소 안정 단계**: k8sattributes 프로세서 stable, filelog 수신기 beta, k8sobjects 수신기 beta(리더 선출 확장을 지원), prometheus 내보내기 beta, clickhouse 내보내기(로그·추적 beta)다.
  - **파이프라인**: 같은 수신기·프로세서·내보내기를 여러 파이프라인에 쓸 수 있다.
  - **수집기 자체 지표**: 수집기는 자기 지표를 기본으로 `:8888/metrics`에 낸다. 예: `otelcol_exporter_send_failed_*`, `otelcol_exporter_queue_size`·`otelcol_exporter_queue_capacity`, `otelcol_receiver_refused_*`.
  - **CNCF 관측 백서**
    - 모든 신호에 같은 메타데이터(라벨)를 붙여 신호를 잇는다.
    - 머신러닝 이상 탐지는 사람을 부르거나 자동으로 조치하는 데 쓰기에는 논란이 있지만, 문제 해결의 힌트로는 가치가 있다.
  - **Google SRE 책 6장**
    - 임계값을 스스로 배우거나 원인을 자동으로 찾는 '마법' 같은 시스템은 피한다.
    - 예외는 사용자 요청량의 갑작스러운 변화를 잡는 단순 규칙이다.
  - **AWS 관측 성숙도 모델**: ① 수집 ② 분석 ③ 상관·이상 탐지 ④ 학습 모델로 하는 선제적·자동 원인 찾기, 네 단계다.
  - **브라우저**
    - Fetch 표준의 CORS 안전 목록 요청 헤더는 `accept`·`accept-language`·`content-language`·`content-type`(일부 값) 등뿐이다. 그래서 `traceparent`를 교차 출처 요청에 붙이면 사전 요청이 생긴다.
    - OpenTelemetry 웹 계측은 교차 출처로 trace 헤더를 보내려면 `propagateTraceHeaderCorsUrls`에 주소를 따로 넣어야 한다.
    - Beacon 표준: `sendBeacon`의 요청은 자격 증명 모드가 include라 쿠키가 함께 간다. 메서드·헤더 같은 설정을 바꿔야 하면 `fetch`에 `keepalive`를 켜서 쓰라고 한다. keepalive 요청은 `fetch`와 같은 진행 중 한도를 나눠 쓴다.
    - Fetch 표준: 진행 중인 keepalive 요청 본문의 합이 64KiB를 넘으면 네트워크 오류다.
    - Reporting API: 보고는 자격 증명 same-origin으로 보낸다. 같은 출처 수집 주소는 쿠키를 받고, 교차 출처 주소는 받지 않는다.
  - **exemplar와 신호 연결**
    - Prometheus는 `--enable-feature=exemplar-storage`로 긁은 exemplar를 저장한다.
    - prom-client는 OpenMetrics 등록부에서 exemplar(`traceId`·`spanId`)를 붙인다. OpenTelemetry JS의 Prometheus 내보내기 문서에는 exemplar 언급이 없다.
    - Grafana에는 Tempo의 trace→logs·metrics·profiles 연결, Loki의 파생 필드(로그→추적), Prometheus의 exemplar가 있다.
  - **수집 대상**
    - kube-state-metrics는 쿠버네티스 API를 지켜 객체 상태 지표를 만든다.
    - YACE(prometheus-community)는 CloudWatch 지표를 Prometheus 형식으로 내놓는다.
    - MSK(Provisioned)는 Prometheus로 감시할 수 있다(열린 모니터링).
    - ClickHouse(직접 운영)는 서버 설정 파일의 Prometheus 절로 지표를 Prometheus에 내놓을 수 있다(ClickHouse 모니터링 문서).
  - **Pyroscope 2.0**은 프로파일을 객체 스토리지에 바로 쓴다.
  - **평가 기간의 지표 복사**
    - Prometheus 설정 문서: 원격 쓰기(`remote_write`)는 AWS SigV4 서명(`sigv4`)을 지원하고, 서명 서비스 이름의 예로 AMP의 `aps`를 든다.
    - Datadog 문서: 에이전트의 OpenMetrics·Prometheus 점검이 Prometheus 노출 주소를 긁는다. 이렇게 가져온 지표는 기본으로 사용자 정의 지표로 센다.

## 결정

1. **수집기는 세 종류로 나눈다(추천 적용)**:

   | 수집기 | 배치 | 받는 것 | 하는 일 | 내보내는 곳 |
   | --- | --- | --- | --- | --- |
   | 에이전트 | 모든 노드의 DaemonSet | 서비스 SDK의 추적(OTLP, 노드 안), 컨테이너 표준 출력 로그(filelog), Envoy 접근 로그(파일 경로로 나눈 전용 filelog) | 메모리 상한, 쿠버네티스 메타데이터 붙이기(k8sattributes), 묶기 | 추적: 부하 분산 내보내기(`routing_key` traceID, k8s 해석기)로 게이트웨이 수집기의 같은 복제. 로그: 게이트웨이 수집기. 법정 접속기록 사본: 결정 7 |
   | 게이트웨이 수집기 | 관측 노드 풀의 Deployment, 복제 3개 [가정, 4.1.4에서 확정] | 에이전트의 추적·로그, 브라우저 수집 경로(결정 5) | 테일 샘플링(§6 정책), 개인정보 2차 마스킹(원문 IP가 남아 있으면 앞부분만 남김. IP 처리는 결정 7대로 에이전트에서 끝나야 한다) | Tempo, Loki, Prometheus 노출(브라우저 지표만, 결정 2). 평가 기간에는 추적·로그를 Datadog에도 보낸다(ADR-0067·0068) |
   | 클러스터 수집기 | 관측 노드 풀의 Deployment 2개, 리더 선출 | 쿠버네티스 이벤트(k8sobjects) | 한 번만 받기(리더만 받음) | Loki |

   - 수집기 배포판은 OpenTelemetry Collector Contrib 이미지를 버전 고정과 서명 확인(ADR-0054)으로 쓴다.
   - 게이트웨이 수집기 복제 수를 바꿀 때는 한 번에 하나씩 바꾼다. 바뀌는 순간 진행 중인 trace가 두 복제로 갈라질 수 있기 때문이다(남는 한계).
2. **지표는 Prometheus가 긁는다(추천 적용)**:
   - 클러스터 Prometheus가 ServiceMonitor·PodMonitor로 긁는다. 대상은 서비스(`/metrics`, OpenMetrics), Envoy, Flink(Prometheus 리포터), exporter(결정 3), 수집기 자체 지표다.
   - 이유: 제어 입력(AIMD·KEDA)이 읽는 지표가 텔레메트리 수집기의 장애에 묶이지 않게 하려는 것이다(ADR-0068 결정 2를 넓힘).
   - 긁을 수 없는 브라우저 지표만 게이트웨이 수집기의 Prometheus 노출(prometheus 내보내기)로 내놓고, Prometheus가 그것을 긁는다.
   - 서비스 템플릿의 히스토그램은 OpenMetrics exemplar(`traceId`·`spanId`)를 붙인다. 라이브러리는 prom-client의 exemplar 기능이 기본값이다 [가정, 4.1.1 PoC에서 확정]. Prometheus는 exemplar 저장을 켠다.
   - 평가 기간(wbs 4.8.2)에 지표를 후보로 복사할 때도 수집기를 거치지 않는다.
     - AMP: Prometheus 원격 쓰기(`remote_write`의 `sigv4`, 서명 서비스 이름 `aps`)로 보낸다. ADR-0068의 '수집기에 Prometheus Remote Write Exporter와 SigV4 인증 확장을 더함'은 이것으로 바꾼다.
     - Datadog: 평가 기간에만 Datadog 에이전트의 OpenMetrics 점검으로 같은 `/metrics`를 긁는다. Datadog은 이렇게 긁은 지표를 기본으로 사용자 정의 지표로 세므로 4.8.2의 비용 환산에 넣는다.
3. **수집 대상 목록(추천 적용)**:

   | 대상 | 수집 방법 |
   | --- | --- |
   | 서비스·게이트웨이 | 지표 `/metrics`(긁기), 추적 OTLP(노드 에이전트), 로그 표준 출력(filelog) |
   | 쿠버네티스 객체 상태(파드 재시작, 복제 수, HPA 등) | kube-state-metrics |
   | 노드·컨테이너 자원 | node_exporter(netstat 포함, ADR-0067), kubelet·cAdvisor |
   | Aurora PostgreSQL | postgres_exporter(쿼리 통계 상위 20개, ADR-0067), CloudWatch(YACE) |
   | ElastiCache(Redis) | CloudWatch(YACE), 앱 쪽 계측(ioredis 지연, `redis_command_timeout_total`) |
   | MSK(Kafka) | MSK 열린 모니터링(Prometheus), 소비 지연은 소비자 쪽(kafkajs·Flink) 지표 |
   | ClickHouse | 서버 설정의 Prometheus 절로 지표를 내놓고 긁는다(포트·경로는 4.1.4에서 정함) |
   | CloudFront·WAF·NLB | CloudWatch(YACE) |
   | Flink | Prometheus 리포터(PodMonitor, ADR-0072) |
   | 관측 부품 자체(수집기·Prometheus·Mimir·Loki·Tempo·Pyroscope·Alertmanager) | 각자의 `/metrics`(결정 6) |
   | 프로파일 | Pyroscope SDK로 Pyroscope에 보내고 S3(KMS)에 저장한다. OpenTelemetry 프로파일 신호는 Alpha라 아직 쓰지 않는다 |
   | eBPF 자동 계측(OpenTelemetry eBPF Instrumentation) | 지금은 넣지 않는다. 네트워크 계층 관측이 필요해지면 다시 본다 |

4. **로그 표본은 앱에서 정한다(추천 적용)**:
   - Pino가 요청이 끝날 때 정한다.
   - 전수: 4xx·5xx, SLO 지연 초과, 서킷 503, '곧 입장' 완충 응답.
   - 그 밖의 2xx: traceId 해시로 온세일 1%·평시 10% [가정]을 남긴다.
   - 수집기에서는 로그를 다시 거르지 않는다. 정규 로그 줄(ADR-0069)도 같은 규칙을 따른다.
   - 이유: 요청 결과와 소요를 아는 곳은 앱이다. SLO 지연 초과 요청을 전수로 남겨, 테일 샘플링이 남긴 느린 추적과 로그가 짝이 맞게 한다.
5. **브라우저 수집 경로와 표본(추천 적용)**:
   - **수집 경로**: 화면 앱마다 같은 출처 경로 `/_t/rum`(성능·오류 지표)과 `/_t/csp`(CSP 위반 보고)를 둔다 [가정].
     - CloudFront가 그 경로를 그 앱의 게이트웨이(gw-fan·gw-partner·gw-ops·gw-scanner)로 보내고, 게이트웨이가 게이트웨이 수집기의 OTLP/HTTP 수신기로 넘긴다.
     - 같은 출처라 CORS 사전 요청이 없다.
     - 화면은 `fetch`에 `keepalive: true`와 `credentials: 'omit'`을 주어 보낸다. 지원하지 않는 브라우저에서만 `sendBeacon`을 쓴다.
     - `sendBeacon`과 CSP 보고는 같은 출처면 쿠키를 함께 보낸다. 그래서 게이트웨이가 `/_t/*` 경로에서 `Cookie`·`Authorization` 헤더를 지우고 수집기로 넘긴다. 수집기와 Loki에 세션 쿠키가 닿지 않게 하려는 것이다.
   - **공개 경로 보호**: 본문 64KiB 상한(브라우저의 keepalive 요청 합계 상한과 같게), WAF의 IP당 속도 제한 [가정]을 둔다. 형식이 맞지 않으면 버리고, 사용자 식별값은 싣지 않는다.
     - 공개 경로라 지어낸 값이 섞일 수 있으므로, 브라우저 지표로는 사람을 호출하거나 자동 조치하지 않는다. CSP 위반 급증은 SEV3(티켓)만 낸다.
   - **표본**: 대기·로비 화면 1% [가정], 좌석 선택·결제 화면 100%(동시 입장 상한이 있어 양이 작다), 그 밖 10% [가정].
   - **저장**
     - 브라우저 지표는 Prometheus에 둔다(결정 2). 원본 사건은 ClickHouse에 싣지 않는다(docs/features/analytics.md와 같다).
     - `telemetry.rum` 채널은 쓰지 않고 예약으로만 둔다.
     - 브라우저 오류 묶기와 화면 녹화는 Sentry가 맡는다.
   - **브라우저 trace 전파**
     - 같은 출처 요청에만 `traceparent`를 붙인다.
     - 대기열 API(교차 출처, 사전 요청 없이 받는 `text/plain` 진입, ADR-0065)와 결제사 SDK 출처에는 붙이지 않는다. 교차 출처 전파는 켜지 않는다(`propagateTraceHeaderCorsUrls`에 아무 주소도 넣지 않음).
6. **수집기 자신을 감시한다(추천 적용)**:
   - 각 수집기의 자체 지표를 Prometheus가 긁는다.
   - 다음은 SEV3(`kind` hygiene)다 [가정, 4.1.4에서 확정].
     - 내보내기 실패(`otelcol_exporter_send_failed_*`)가 5분 넘게 0보다 큼
     - 큐 사용률(`otelcol_exporter_queue_size ÷ otelcol_exporter_queue_capacity`)이 80%를 넘음
     - 받기 거절(`otelcol_receiver_refused_*`)이 5분 넘게 이어짐
     - Tempo나 Loki의 수집량이 5분 동안 0
   - SLO 경보와 제어 입력은 결정 2대로 수집기를 거치지 않는다. 그래서 수집기가 멈춰도 사람 호출과 자동 제어는 그대로이고, 잃는 것은 원인 분석용 추적·로그다.
7. **법정 접속기록 분기는 에이전트의 두 파이프라인이 한다(추천 적용)**:
   - Envoy 접근 로그 전용 filelog 수신기를 두 파이프라인에 함께 연결한다.
     - ① 법정 사본: 원문 IP·단말을 그대로 전용 접속기록 DB(ClickHouse 전용 DB, clickhouse 내보내기)로 보낸다.
     - ② 일반 사본: IP 앞부분(IPv4 /24, IPv6 /48)만 남겨 게이트웨이 수집기를 거쳐 Loki로 보낸다.
   - 원문 IP가 일반 경로로 새지 않게, 일반 파이프라인의 IP 처리는 에이전트에서 끝낸다.
8. **신호를 같은 이름으로 잇는다(추천 적용)**:
   - 모든 신호에 같은 자원 속성을 붙인다: `service.name`, `deployment.environment`, `k8s.namespace.name`, `k8s.pod.name`, `k8s.node.name`(에이전트의 k8sattributes).
   - Grafana 데이터 소스 연결은 Dashboards as Code에 함께 둔다.
     - Prometheus exemplar → Tempo
     - Loki의 traceId 파생 필드 → Tempo
     - Tempo → Loki(같은 traceId), Tempo → Pyroscope(같은 서비스·시간대)
9. **이상 탐지와 자동화의 원칙(추천 적용, 소유자가 기록을 요청)**:
   - **호출과 자동 조치에 쓰는 규칙**: 사람을 부르거나 자동으로 조치하는 것은 단순하고 설명할 수 있는 규칙만 쓴다. 다중 창 소진 속도, 확실하고 임박한 원인, 처리량 급감(지난주·기준선 비교), 선형 고갈 예측(`predict_linear`), 법정 기한이다.
   - **머신러닝 이상 탐지**: 지금은 쓰지 않는다. 쓰게 되더라도 사람을 부르지 않는 '힌트' 위젯으로만 쓴다.
   - **자동화(AIOps 자리)**: 줄이는 쪽만 규칙으로 하고(POL-021 C-3), 늘리거나 구조를 바꾸는 것은 사람이 승인한다.
   - **근본 원인 분석**: 사람이 한다. 시스템은 진단 증거, 미리 채운 조회 링크, 판단 순서를 준다. 자동 근본 원인 분석은 하지 않는다.
   - **목표 단계**: AWS 성숙도 모델의 3단계(상관·이상 탐지)를 목표로 한다. 4단계(학습 모델로 하는 선제적·자동 원인 찾기)는 목표로 두지 않는다.
     - 이유 1: 회차마다 70분짜리 짧은 폭주라 배울 평소 패턴이 적다.
     - 이유 2: 판매 오픈 때는 헛경보와 설명할 수 없는 자동 조치의 비용이 크다(Google SRE).
   - observability §13의 '시계열 선행 예측 모델'은 선형 고갈 예측(§5 자원 누수 의심 신호)으로 고쳐 쓴다.
10. **그 밖의 정리(추천 적용)**:
    - admission-ctrl은 Kafka에 지표를 발행하지 않는다. 제어 지표는 Prometheus(`admission_*`), 제어 상태는 Redis `q:{event:E}:ctl`(ADR-0069)이다. architecture §3.1의 행을 고친다.
    - Pyroscope 저장소는 S3(KMS)다.
    - 관측 노드 풀에는 게이트웨이·클러스터 수집기와 저장소를 두고, 에이전트는 모든 노드에서 돈다. 노드마다 자원 요청을 둔다 [가정, 4.1.4].

## 검토한 대안

| 대안 | 고르지 않은 이유 |
| --- | --- |
| 수집기 하나(지금 그림대로) | 복제가 둘 이상이면 테일 샘플링 판정이 틀어진다. 노드 단위 로그 수집과 중앙 정책을 한 부품이 다 지게 된다 |
| 앱이 게이트웨이 수집기로 바로 보냄(에이전트 없음) | 컨테이너 로그를 파일에서 읽을 노드 단위 부품이 없다. 쿠버네티스 메타데이터를 붙이는 곳도 흩어진다 |
| 지표도 수집기로 밀어 넣기 | 수집기 장애가 AIMD·KEDA의 제어 입력을 끊는다 |
| 접근 로그 분기를 게이트웨이 수집기에서 함(routing 커넥터, alpha) | 원문 IP가 노드 밖 게이트웨이 수집기까지 일반 경로로 간다. 같은 일을 안정 단계가 높은 파이프라인 분기로 할 수 있다 |
| 머신러닝 이상 탐지로 호출 | Google SRE·CNCF가 헛경보와 설명 가능성을 이유로 권하지 않는다. 짧은 폭주라 배울 패턴도 적다 |
| eBPF 자동 계측을 지금 넣음 | 언어 SDK 계측으로 필요한 신호를 얻는다. 네트워크 계층이 필요해지면 다시 본다 |

## 결과와 트레이드오프

- 레퍼런스의 각 칸에 대응하는 부품과 경로가 문서에 생긴다. 대응은 observability §1에 있다.
- **남는 한계**
  - 게이트웨이 수집기 복제 수가 바뀌는 순간 진행 중인 trace가 갈라져 일부 판정이 불완전해질 수 있다.
  - 에이전트가 모든 노드에서 돌아 노드마다 자원을 쓴다.
  - 공개 수집 경로는 지어낸 지표를 받을 수 있다. 상한·속도 제한·표본으로 줄일 뿐 막지는 못한다.
  - 머신러닝 이상 탐지를 쓰지 않아, 규칙에 없는 새 유형의 이상은 늦게 잡힐 수 있다. 사후 분석과 경보 위생으로 메운다.
  - 이 한계들은 planning/01 §5.2에 적었다.
- **반영 수치(2026-10-21)**: ADR 75 → 76. 용어 1개(텔레메트리 수집기. '게이트웨이'는 Envoy API 게이트웨이로 남기고 수집기는 '게이트웨이 수집기'로 쓴다). WBS 4.1.4 신설 2.5일로 400.75 → 403.25일. 검토 기록 R-85.

## 되돌릴 조건

- 4.1.4 측정에서 게이트웨이 수집기 복제 변경 때 잃는 trace 비율이 크면, 게이트웨이 수집기를 StatefulSet과 고정 이름 해석으로 바꾸는 것을 새 ADR로 검토한다.
- 4.8.2 판정이 AWS 관리형이나 Datadog이면 결정 1의 내보내는 곳과 결정 2의 지표 복사 경로만 바꾼다. 에이전트·게이트웨이 수집기 구성은 그대로다.
- 규칙에 없는 이상을 사람이나 외부가 먼저 찾은 장애가 분기에 두 번 넘게 나오면(observability §5의 탐지 경로 집계), 머신러닝 힌트 위젯을 새 ADR로 검토한다.
- OpenTelemetry 프로파일 신호가 안정 단계가 되면 Pyroscope SDK를 OpenTelemetry 계측으로 바꾸는 것을 다시 본다.
