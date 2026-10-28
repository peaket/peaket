# ADR-0125: 진입 경로는 머리 표본으로 줄이고, 꼬리 표본 수집기의 크기를 피크로 정하며, 로그와 추적이 같은 문턱으로 표본을 고른다(2026-10-28)

- **상태**: 채택 (2026-10-28. 기술 검토(review/tech-review.md)의 중간-072 'T=0 피크의 관측 신호 양을 계산하지 않았고 진입 경로를 테일 샘플링에서 빼는 규칙이 없다'에 소유자가 "나머지 건수들은 모두 추천안에 동의합니다. 그렇게 모두 수정해주세요."라고 정했다. 방향은 소유자 결정(추천안 승인)이고, 비율·크기·한도 같은 세부는 추천 적용이다. 수치는 [가정]이고 wbs 4.1.4에서 확정한다. ADR-0076 결정 1·4·7을 보완하며, ADR-0076 본문은 고치지 않는다)
- **관련**: ADR-0026, ADR-0049, ADR-0065, ADR-0069(결정 11·12), ADR-0076(결정 1·4·6·7), ADR-0077, NFR-001, [docs/observability.md](../observability.md) §1·§5·§6·§7·§14, docs/verification.md(V-T30), wbs 4.1.4, [review/tech-review.md](../../review/tech-review.md)(중간-072)

## 맥락

- **꼬리 표본은 버릴 span도 먼저 모은다**: 꼬리 표본(trace가 끝난 뒤 남길지 정하는 방식)은 버릴 span까지 모두 게이트웨이 수집기에 모아 판정 대기(`decision_wait`) 동안 메모리에 둔다. OTel 수집기의 꼬리 표본 처리기는 beta이고, 기본값은 판정 대기 30초, 메모리에 두는 trace 수(`num_traces`) 5만이다. trace 수가 그보다 많아지면 원형 버퍼에서 가장 오래된 trace부터 판정 전에 버린다(`otelcol_processor_tail_sampling_sampling_trace_dropped_too_early`). 오류 trace도 함께 버려진다(opentelemetry-collector-contrib `processor/tailsamplingprocessor` README, 2026-10-28 확인).
- **진입 피크를 넣으면 넘친다(추정)**: T=0 진입은 초당 20만 건이다. 요청마다 Envoy(gw-queue)·queue-svc·Redis span이 약 4개 [추정] 생기면 초당 약 80만 span이 복제 3에 몰린다. 복제 하나에 초당 약 6.7만 trace가 오고, 판정 대기 10초면 약 67만 trace를 메모리에 두어야 한다. 기본 `num_traces` 5만이면 열에 아홉이 판정 전에 버려지고, 판정 대기를 기본값 30초로 두면 필요한 trace 수가 세 배다. span 하나 약 1KiB [추정]면 복제마다 수 GiB다.
- **복제 수를 피크에 맞춰 늘리기 어렵다**: 게이트웨이 수집기 복제 수는 trace가 두 복제로 갈라지지 않게 한 번에 하나씩만 바꾼다(ADR-0076 결정 1). 그래서 피크 직전에 몇 배로 늘리는 프리워밍이 맞지 않는다.
- **로그도 같은 피크를 받는다**: Envoy 접근 로그의 일반 사본(Loki)은 표본 없이 모두 간다. 줄 하나 약 500바이트 [추정]면 진입 피크에 초당 약 100MB다. Loki 기본 한도는 테넌트 초당 4MB(`ingestion_rate_mb`, 순간 6MB), 스트림 하나 초당 3MB(`per_stream_rate_limit`, 순간 15MB)다(Loki 설정 문서, 2026-10-28 확인). Loki 라벨은 `service` 등 넷뿐이라 한 게이트웨이의 줄은 한 스트림에 모인다(docs/observability.md §7).
- **로그와 추적이 다른 1%를 고른다**: 앱 로그의 정상 표본은 traceId 해시 1%이고(ADR-0076 결정 4), 추적의 정상 1%는 꼬리 표본기가 고른다. 꼬리 표본기의 `probabilistic` 정책은 기본으로 trace ID를 FNV-1a로 해시하므로, 두 쪽이 서로 다른 1%를 고른다. 그러면 남긴 정상 trace에 짝이 되는 로그 줄이 대부분 없다.
- **확인한 규약(2026-10-28 원문)**:
  - OTel 확률 표본 규약(상태: Development)은 trace ID의 끝 56비트(7바이트)를 무작위 값 R로, 버릴 몫 문턱 T = (1 − p) × 2^56으로 두고 R ≥ T면 남긴다. 확률 p1로 고른 것은 p2 ≥ p1인 쪽에서도 반드시 고른다(일관된 표본). trace ID가 W3C Trace Context Level 2대로 무작위여야 한다.
  - OTel SDK 명세에서 `TraceIdRatioBased`는 이 방식을 쓰는 `ProbabilitySampler`(Development)로 바뀌는 중이고, SDK는 2027-01-01 전에는 옛 동작을 바꾸지 않는다. `ParentBased`는 부모의 표본 표시를 따른다.
  - 꼬리 표본기가 `tracestate`의 문턱을 읽게 하는 기능(`processor.tailsamplingprocessor.usetracestate`)은 alpha이고 꺼져 있으며, 확률 정보가 없으면 다시 FNV 해시로 돌아간다. `string_attribute`·`boolean_attribute` 정책과 판정 캐시(`decision_cache`: 남긴 trace ID를 기억해 늦은 span도 남김)가 있다.
  - Envoy Gateway의 추적 설정은 앞선 표본 결정이 없을 때 고를 비율(`samplingRate` 0~100 또는 `samplingFraction`)을 받는다(envoyproxy/gateway `api/v1alpha1/envoyproxy_tracing_types.go`). Envoy 접근 로그 형식은 `%TRACE_ID%`로 요청의 trace ID를 싣는다(없으면 빈 문자열, Envoy 문서).
  - 수집기의 확률 표본 처리기(`probabilistic_sampler`)는 로그에서 alpha이고, `proportional` 모드는 위 규약의 56비트 무작위 값과 문턱으로 고른다.

## 결정

1. **진입 경로는 꼬리 표본에서 빼고 머리 표본으로 줄인다(소유자 승인, 비율은 추천 적용).**
   - 대상은 gw-queue를 지나는 요청(로비 입장, 사전 검증 토큰, 대기열 진입, 입장 확정)이다. gw-queue의 Envoy가 trace를 시작할 때 0.1% [가정, wbs 4.1.4에서 확정]만 고른다(Envoy Gateway 추적 설정의 `samplingFraction` 1/1000). 브라우저는 교차 출처인 대기열 API에 `traceparent`를 붙이지 않으므로(ADR-0065·0076), 이 결정이 그 trace의 첫 결정이다.
   - queue-svc와 그 뒤에서 불리는 서비스(trust-svc 등)의 SDK는 부모 기반(`ParentBased`)이라 그 표시를 따른다. 고르지 않은 요청의 span은 만들지만 내보내지 않으므로 수집기에 오지 않는다.
   - 고른 trace는 Envoy의 고정 태그와 SDK가 `peaket.sample.mode="head"`를 단다. 꼬리 표본기의 첫 정책이 이 값(`string_attribute`)이면 그대로 남긴다. 이미 천분의 일로 줄었기 때문이다.
   - 입장 확정은 초당 약 28건으로 작지만 같은 게이트웨이라 같은 규칙을 쓴다. 게이트웨이 하나에 비율 하나라서 설정이 단순하다.
   - 이 경로의 오류와 지연은 지금처럼 지표(gw-queue 히스토그램, 표본이 아니다)와 정규 로그 줄(5xx·SLO 지연 초과는 전수)로 모두 센다. 그래서 trace를 줄여도 SLO 판정과 오류 수는 그대로다.

2. **게이트웨이 수집기의 크기를 피크 식으로 정하고 4.1.4 결과로 남긴다(추천 적용).**

   ```
   복제당 초당 새 trace   = 진입을 뺀 피크의 초당 새 trace ÷ 복제 수
   num_traces(복제당)    ≥ 복제당 초당 새 trace × decision_wait × 2(여유)
   메모리(복제당)        ≈ 복제당 초당 새 trace × decision_wait × trace당 평균 span 수 × span 평균 크기 × 1.5
   expected_new_traces_per_sec = 복제당 초당 새 trace
   ```

   - 처음 값 [가정, wbs 4.1.4에서 확정]: 진입을 뺀 T=0 피크의 새 trace는 초당 약 5,000건 [추정](좌석 홀드 피크 초당 2,000건(NFR-003)에 스냅샷·결제·입장 확정·로그인 등을 더한 어림)이다. 복제 3이면 복제마다 약 1,700건이고, `decision_wait` 10초, `num_traces` 복제마다 3.5만, 메모리는 span 8개 [추정] × 1KiB [추정]로 복제마다 약 200MiB [추정]다.
   - `decision_wait`는 기본값 30초가 아니라 10초 [가정]로 둔다. 거의 모든 요청이 몇 초 안에 끝나고, 30초면 같은 trace 수에 메모리가 세 배 든다. 판정 대기보다 오래 걸리는 trace(결제사 승인을 60초까지 기다리는 경우 등)는 앞부분만 보고 판정한다(남는 한계). 남긴 trace의 늦은 span은 판정 캐시(`decision_cache.sampled_cache_size`, `num_traces`보다 훨씬 크게 [가정])로 이어 남긴다.
   - 남길 결과: 피크 span 수와 trace당 span 수 분포, 복제당 실제 메모리, `num_traces`, `decision_wait`, `..._sampling_trace_dropped_too_early`(0이어야 한다), `..._sampling_trace_removal_age`의 p1(판정 대기에 가까우면 위험하다), 늦은 span 비율.
   - 경보: `otelcol_processor_tail_sampling_sampling_trace_dropped_too_early`가 5분 넘게 0보다 크면 SEV3(`kind` hygiene)다. 판정 전에 버린 trace에는 오류 trace도 들기 때문이다.
   - 복제 수는 지금처럼 한 번에 하나씩 바꾼다(ADR-0076 결정 1). 그래서 피크 직전에 늘리지 않고, 이 식의 피크 값으로 미리 둔다.

3. **로그와 추적의 정상 표본은 같은 문턱으로 고른다(추천 적용).**
   - 서비스 템플릿이 요청마다 '정상 표본' 여부를 OTel 확률 표본 규약의 방식으로 한 번 계산한다. R = trace ID의 끝 56비트, T = (1 − p) × 2^56이고 R ≥ T면 남긴다. p는 지금 비율(온세일 1%, 평시 10% [가정])이다.
   - 이 값 하나로 ① 정규 로그 줄의 정상(2xx) 표본을 정하고 ② 서버 span에 `peaket.sample.keep`(참·거짓)을 단다. 꼬리 표본기의 정상 trace 정책은 이 속성을 `boolean_attribute`로 읽는다. 꼬리 표본기의 `probabilistic` 정책(기본 FNV 해시)은 쓰지 않는다. alpha 기능(`usetracestate`)에 기대지 않으려는 것이다.
   - 그래서 정상 trace를 남긴 요청은 정상 로그 줄도 남는다. 두 비율이 같으면 같은 요청을 고르고, 로그 비율이 더 크면 로그가 trace를 모두 품는다(일관된 표본).
   - 진입 경로의 머리 표본은 Envoy가 고르고, 그 방식이 trace ID 문턱인지는 [가정, wbs 4.1.4에서 확인]이다. 그래서 로그에는 '`traceparent`의 표본 표시가 켜진 요청의 정상 줄은 남긴다'를 더한다.
   - 오류·SLO 지연 초과·서킷 503·'곧 입장' 응답의 전수 규칙(ADR-0076 결정 4)은 그대로다. 다만 진입 경로의 의도한 거절(403·429) 줄은 앱 로그에서도 정상 줄과 같은 문턱으로 줄인다. 봇 차단이 몰리면 초당 수만 건이 되고, 그 수는 차단 효과 신호(`entry_blocked_ratio`, docs/observability.md §5)와 판정 기록이 모두 센다.
   - `sampleRate` 필드(정상 100 또는 10, 전수 1)는 그대로 싣는다.

4. **Envoy 접근 로그의 일반 사본은 수집기에서 줄이고, Loki 한도를 피크에 맞춘다(추천 적용).**
   - 에이전트의 일반 갈래(Loki로 가는 사본)에서 5xx와 SLO 지연 초과 줄은 모두 남긴다. 그 밖의 줄(2xx·3xx·4xx)은 결정 3과 같은 문턱(온세일 1%·평시 10% [가정])으로 줄인다. 줄의 trace ID는 Envoy 접근 로그 형식의 `%TRACE_ID%`로 싣는다. 고르지 않은 요청에도 trace ID가 있는지는 [가정, wbs 4.1.4 PoC에서 확인]이고, 비어 있으면 요청 ID(`x-request-id`)로 같은 비율을 고른다.
   - 법정 사본 갈래는 줄이지 않는다(ADR-0076 결정 7, 기술 검토 높음-21).
   - Envoy는 앱이 아니라 앱에서 표본을 정할 수 없다. 그래서 ADR-0076 결정 4의 '수집기에서는 로그를 다시 거르지 않는다'는 앱 로그의 규칙으로 읽고, Envoy 접근 로그 일반 사본만 에이전트에서 줄인다.
   - Loki 한도: 테넌트 `ingestion_rate_mb` 40·`ingestion_burst_size_mb` 60, 스트림 `per_stream_rate_limit` 15MB·`per_stream_rate_limit_burst` 30MB [가정, wbs 4.1.4에서 확정]로 둔다. 근거는 '표본 뒤 피크 + 오류 10% 폭주'다. 표본 뒤 진입 2xx 1%는 초당 약 1MB [추정]지만, 진입 오류가 10%로 오르면 gw-queue 스트림 하나에 초당 약 10MB [추정]가 몰린다. 기본 한도(4MB·3MB)로는 이것을 받지 못한다.
   - 그래도 넘치면 Loki가 거절하고 수집기가 다시 보내다 버린다. 오류 수와 지연은 지표와 법정 사본에 전수로 남는다. 거절은 수집기 자체 신호(보내기 실패, docs/observability.md §5)로 드러난다.

5. **시험(추천 적용).** 새 V-T30(docs/verification.md):
   - 합성 span 생성기로 게이트웨이 수집기 복제 하나에 '진입을 뺀 피크 몫'(초당 약 1,700 trace × span 8개 [추정])과 '진입을 넣은 몫'(초당 약 6.7만 trace × span 4개)을 각각 10분 넣는다. 앞은 판정 전 버림 0, 오류 trace 100% 남김, 메모리가 식의 값 안이다. 뒤는 버림이 생기는 것을 기록해 결정 1의 근거로 남긴다.
   - 요청 1만 건(정상·오류 섞음)에서 정상 trace를 남긴 요청은 모두 정상 로그 줄이 있고, 정상 로그 줄의 비율이 p ± 통계 오차 안이다.
   - 진입 부하에서 gw-queue trace가 0.1% ± 오차로 남고, queue-svc span이 고르지 않은 요청에서 내보내지지 않는다.
   - 표본 뒤 피크 로그 양과 오류 10% 폭주를 Loki에 넣어 거절 0건이다.

6. **정본 반영.**
   - docs/observability.md: §1 수집기 구성, §5 수집기 자체 신호, §6 테일 샘플링 행, §7 정형 로그 샘플링·게이트웨이 접근 로그 분기 행, §14 근거 표.
   - docs/verification.md(V-T30), wbs 4.1.4 설명(메인 세션). ADR-0076은 상태 줄에만 적는다.

## 검토한 대안

| 대안 | 이런 점이 낫다 | 이런 점이 걸린다 | 판단 |
| --- | --- | --- | --- |
| A. 지금 그대로(진입도 꼬리 표본) | 진입 오류 trace도 100% 남는다는 약속이 이론상 그대로다 | 피크에 판정 전 버림이 생겨 오류 trace도 버려진다. 메모리 수 GiB, 복제 수를 피크에 맞추기 어렵다 | 쓰지 않는다 |
| B. 진입은 머리 표본 0.1%, 나머지는 꼬리 표본(이 결정) | 수집기 부하가 진입량과 거의 무관해진다. 진입 오류·지연은 지표와 로그로 전수 센다 | 진입 경로의 오류 trace는 0.1%만 남는다 | 고른다 |
| C. 게이트웨이 수집기를 크게(복제·메모리를 진입 피크에 맞춤) | trace 약속을 지킨다 | 버릴 span 수십만 개를 매초 옮기고 판정하는 비용이 든다. 복제 수를 한 번에 하나씩만 바꾸는 제약이 남는다 | 쓰지 않는다 |
| D. 진입 경로를 추적하지 않는다 | 가장 싸다 | 진입 경로의 구간별 지연(Envoy·queue-svc·Redis)을 볼 길이 없다 | 쓰지 않는다 |
| E. 꼬리 표본기의 `probabilistic` 정책 + `usetracestate`(alpha)로 문턱을 맞춘다 | 수집기 설정만으로 규약 방식이 된다 | alpha이고 꺼져 있으며, 확률 정보가 없으면 FNV 해시로 돌아간다. SDK가 `th`를 써야 한다 | 쓰지 않는다. beta가 되고 SDK의 `ProbabilitySampler`가 나오면 다시 본다 |
| F. Loki 한도만 표본 없는 피크(초당 약 100MB)에 맞춘다 | 접근 로그가 모두 남는다 | Loki 인제스터·저장 비용이 크고, 같은 줄은 법정 사본에 이미 모두 있다 | 쓰지 않는다 |

## 결과와 트레이드오프

- 게이트웨이 수집기의 피크 부하가 진입량(초당 20만 건)과 떨어진다. 피크 크기를 식으로 정하고 실제 값을 4.1.4에서 남긴다.
- 남긴 정상 trace와 정상 로그 줄이 같은 요청을 가리킨다. 표본 비율로 다시 세는 규칙(ADR-0069 결정 12)도 그대로 쓸 수 있다.
- 대가: 진입 경로의 오류 trace는 0.1%만 남는다. 진입 오류를 조사할 때는 정규 로그 줄(전수)과 지표로 먼저 본다. Envoy 접근 로그 일반 사본의 정상 줄은 1%만 Loki에 있다(원문은 법정 사본에 모두 있지만 그 저장소는 일반 조사에 쓰지 않는다).
- 일정: wbs 4.1.4에 머리 표본·속성 정책·크기 측정·V-T30·Loki 한도를 넣는다(+0.5일 [가정], 메인 세션이 고친다).

## 되돌릴 조건

- V-T30이나 부하 시험에서 진입을 뺀 피크에도 판정 전 버림이 생기면, `decision_wait`를 줄이거나 복제 수를 미리 늘린다. 그래도 버리면 꼬리 표본 대상을 더 줄인다(예: 좌석 상태 조회).
- 진입 경로의 장애 조사에서 0.1%로 원인을 못 찾는 일이 거듭되면, 진입 오류만 따로 남기는 길(Envoy가 응답 뒤 오류 요청의 접근 로그에 구간 지연을 더 싣기 등)을 비교한다.
- 꼬리 표본기의 tracestate 문턱 기능이 beta가 되고 쓰는 SDK가 `ProbabilitySampler`를 내면, 결정 3의 속성 방식을 그 기능으로 바꿀지 다시 본다.

## 남는 한계

- 진입 경로의 오류 trace는 천분의 일만 남는다.
- 판정 대기(10초 [가정])보다 오래 걸리는 trace는 앞부분만 보고 판정한다. 늦게 온 오류 span은 판정 캐시에 없으면 따로 새로 판정되어 조각으로 남거나 버려진다.
- 확률 표본 규약과 `ProbabilitySampler`는 아직 Development라 바뀔 수 있다. 계산은 서비스 템플릿 한곳에 둔다.
- trace ID가 무작위라는 전제(Node SDK·Envoy)는 [가정, wbs 4.1.4에서 확인]이다. 무작위가 아니면 문턱 방식의 비율이 틀어진다.
- Loki 한도를 넘는 폭주(오류 10%를 크게 넘는 경우)에서는 일반 로그 일부를 잃는다.
