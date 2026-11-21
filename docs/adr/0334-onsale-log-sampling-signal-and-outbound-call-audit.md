# ADR-0334: 온세일 구간의 정상 로그 줄 표본은 ops-svc가 `LOG_SAMPLING` 설정으로 내고, 바깥 호출과 지표 라벨은 정적 검사로 지킨다(2026-11-22)

- **상태**: 채택(추천 적용, 2026-11-22, BUILD_ORDER BAT-215 계획 `bat215-plan-eec48d28`). 방향(신호 출처는 ops-svc의 `control.settings` `LOG_SAMPLING`)은 소유자 결정 OPEN[09](2026-11-02, docs/progress-archive.md:45)이고, 이 ADR은 OPS-010·OPS-020을 구현하기 전에 그 세부를 정한다(docs/architecture.md §8.6 4의 2). 구현 시점(감독 결정, 2026-11-22): 결정 1·2·4~6은 BAT-215가 만든다. 결정 3(생산)은 미룬다: ops-svc의 `control.settings` Outbox 표·릴레이는 갈래 4 BAT-360이 만들고, 온세일 구간의 `LOG_SAMPLING` 내기는 BAT-365(OPS-300)가 한다. 그때까지 서비스는 시작 설정 값의 비율로 남는다.
- **관련**: [ADR-0069](0069-ops-control-principles-audit-self-safety-alert-hygiene-wide-events.md)(정규 로그 줄·`sampleRate`), [ADR-0103](0103-control-as-state-startup-sync-broadcast-topics-compacted-settings.md)(제어 상태 시작 작업·방송형 읽기), [ADR-0125](0125-entry-path-head-sampling-collector-sizing-shared-sample-threshold.md)(표본 문턱), [ADR-0053](0053-crypto-hardening-pseudonyms-webhooks-stores-runbook-audit.md)(나가는 호출엔 경로 틀만), [ADR-0077](0077-observability-book-review-buckets-storage-retention.md)(라벨 규칙), [ADR-0331](0331-trim-per-batch-checks-defer-kind.md) 결정 9, [ADR-0332](0332-infra-build-out-segment-five.md) 결정 7
- **관련 ID**: C-T75, C-T76, AC-T7, OPS-010, OPS-020, POL-028, ASVS v5.0.0-15.3.2·14.2.3·16.2.2·16.2.4

## 맥락

- 정규 로그 줄의 정상 표본 비율은 실행 중에 `service.logs.setSampleOneIn`으로 바꿀 수 있지만, 서비스가 온세일 구간을 알 신호가 없었다(docs/observability.md §7 '표본').
- 소유자는 OPEN[09]에서 ops-svc가 대형·중형 온세일 윈도우(T-10분~T+60분, POL-028) 시작에 `LOG_SAMPLING`(값 `oneIn`, `expiresAt`은 윈도우 끝)을 내고 플랫폼이 로그 레벨 설정처럼 적용하는 안을 골랐다. 계약(Avro 열거 기호와 값 레코드)과 일정의 출처, 겹친 윈도우, 중복은 정하지 않았다.
- ops-svc에는 회차 오픈 시각·규모를 읽는 곳이 없다. 규모(`LARGE`·`MEDIUM`·`SMALL`)와 오픈 시각은 core-svc 회차에 있다.
- 바깥 제공자 호출의 추적 머리 누출은 identity-svc 두 곳을 고쳤고(BOT-110), 나머지 서비스는 사람이 하나씩 봤을 뿐 막는 검사가 없다(BUILD_ORDER OPS-020 줄).
- 지표 라벨 금지 목록(docs/observability.md §8)도 막는 검사가 없다.

## 결정

1. **계약**: `SettingChanged.key`에 `LOG_SAMPLING`을 더하고 값 유니온에 `LogSamplingValue { oneIn: int }`(1 이상 10,000 이하)를 더한다. 범위는 `PLATFORM`, 메시지 키는 `PLATFORM:LOG_SAMPLING:*`이다(`*`는 모든 서비스. 마지막 마디가 서비스 이름이면 그 서비스만). `expiresAt`은 `LOG_LEVEL`과 함께 필수다(`x-present-when`). 열거에 기본값 `UNRECOGNIZED`가 있어 옛 소비자도 읽는다. 유니온 갈래는 소비자를 먼저 배포한다(SettingChanged `value` 설명). 계약 원본은 `docs/api/asyncapi.yaml` SettingChanged·`docs/api/avro/peaket/control/SettingChanged.avsc`·`docs/api/avro/README.md` 표이고, 구현 담당이 이 결정을 그대로 옮기고 생성물을 함께 만든다.
2. **소비(공용 서버 패키지)**: `startControlSync`의 설정 처리에 `LOG_SAMPLING`을 더해 받자마자 `setSampleOneIn(oneIn)`을 부른다. `expiresAt`이 지나면 시작 설정 값(`PEAKET_LOG_SAMPLE_ONE_IN`, 기본 10)으로 돌린다. 만료가 지난 값은 새 파드가 무시한다(로그 레벨과 같다, C-T51). 값이 틀리면(범위 밖, 갈래 불일치) 적용하지 않고 경고 줄 하나를 남긴다.
3. **생산(ops-svc)**: 1분 [가정]마다 core-svc에서 앞으로 2시간 [가정] 안의 대형·중형 회차 오픈 시각을 읽는다(내부 호출, 규모 없는 회차는 소형으로 본다). 윈도우는 [오픈 − 10분, 오픈 + 60분)이고, 지금 걸친 윈도우들의 끝 가운데 가장 늦은 것을 `expiresAt`으로 낸다. 끝이 바뀔 때(새 윈도우가 겹쳐 늘 때)만 다시 낸다. 행위자는 자동 조치(SYSTEM, docs/observability.md §7 `ops_event`)이고, `commandId`·`eventKey`는 `expiresAt`에서 정해진 값으로 만들어 복제 여럿·재시작이 같은 사건을 내도 소비자가 한 번만 적용한다(ADR-0052). Outbox로 낸다. core-svc를 읽지 못하면 내지 않고(이미 낸 값은 `expiresAt`까지 유지) 실패 지표를 올린다.
4. **표본 문턱은 그대로**: 비율만 바뀌고 문턱식·전수 규칙(4xx·5xx, SLO 초과, `keep()`, 진입 경로)은 docs/observability.md §7대로다.
5. **바깥 호출 점검**: `services/*/src`와 화면 앱 서버 코드가 바깥 제공자(docs/observability.md §6 '신뢰 경계의 추적 문맥' 나가는 쪽 목록)를 부를 때는 `createExternalHttpClient`만 쓴다. 전역 `fetch`·`globalThis.fetch`를 직접 부르는 곳은 공용 린트 규칙이 막고, 허용 목록(파일과 까닭: 같은 파드 안 관리 포트, 메시 안 내부 호출을 그 클라이언트에 주입하는 곳)만 둔다.
6. **지표 라벨 검사**: 공용 서버 패키지가 서비스 시작(`listen`) 때 레지스트리에 등록된 지표 전부를 훑어, 어기면 어긴 지표 이름과 라벨을 모두 들어 시작을 실패시킨다(C-T76). 환경과 관계없이 같다.
   - 라벨 이름은 소문자로 바꾸고 `_`·`-`를 뺀 뒤 금지 이름과 견준다. 금지 이름은 docs/observability.md §8 '사용 금지 라벨'을 이름으로 옮긴 `accountid`·`userid`·`pid`·`sid`·`sessionid`·`ci`·`token`·`queueseq`·`seq`·`seatid`·`ip`·`clientip`·`useragent`·`ua`·`orderid`다. `token`·`ip`로 끝나는 이름도 금지다.
   - 이름은 Prometheus 이름 규칙(`[a-zA-Z_:][a-zA-Z0-9_:]*`)을 따르고 Counter는 `_total`로 끝난다. 이미 있는 지표가 어기면 이름을 바꾸지 않고 구현 담당이 계획 파일에 적고 멈춘다(경보·대시보드가 그 이름을 읽는다).
7. **배포 쪽은 구간 5**: OTel 수집기 셋(테일 샘플링, 2차 마스킹, `k8sobjects`), Loki·Tempo·Pyroscope·Mimir, 관측 노드 풀, 쿼리 통계·노드 네트워크 수집기는 kind·Helm으로만 보이므로 INF-020이 만든다(ADR-0331 결정 9).

## 검토한 대안

- 서비스가 저마다 회차 일정을 읽어 비율을 정한다: 파드마다 core-svc를 부르고 판단이 갈린다. 소유자 결정과도 다르다.
- 운영자가 명령으로 바꾼다: 사람이 잊으면 피크에 로그가 열 배로 쌓인다.
- 린트 대신 사람 점검: BOT-110 뒤에도 같은 꼴이 남을 수 있다.

## 결과

- 온세일 구간에 정상 로그 줄이 1/10로 준다. core-svc가 멈추면 구간을 놓쳐 10으로 남는다(실패 지표로 본다).
- 계약이 한 갈래 는다. 소비자(공용 패키지)를 먼저 배포해야 한다.

## 되돌릴 조건

- 구간 5 관측 비용 측정(wbs 4.8.2)에서 정상 표본 1%가 원인 분석에 모자라면 `oneIn` 값만 바꾼다.
- core-svc 일정 읽기가 실패해 구간을 놓친 일이 두 번 [가정] 나오면 일정을 사건으로 받는 길(카탈로그 사건 소비)을 새 ADR로 본다.
