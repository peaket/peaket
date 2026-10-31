# 제안: 서비스 템플릿 로그·추적 문맥(wbs 0.3.1 ②, BUILD_ORDER FND-060)

## Why

FND-050이 만든 서비스 템플릿(`packages/platform`)에는 로그가 없다. 예상하지 못한 오류만 표준 오류 출력에 JSON 한 줄로 남기고, OTel SDK를 시작하지 않아 `traceId`는 요청마다 새로 만든 값이다. 정본은 이 템플릿이 다음을 기본으로 넣으라고 한다.

- 요청 1건마다 1줄의 정규 로그 줄(필수 13필드와 `az`·`pod`·`app`·`client`·`pg`·`queuePhase`·`flags`·`dep`·`sampleRate`, ADR-0069 결정 11). 정상 줄은 추적과 같은 문턱으로 표본을 고르고 오류·지연 초과는 전수로 남긴다(ADR-0076 결정 4, ADR-0125 결정 3, observability §6·§7).
- 로그·추적의 식별값은 로그 가명 키 HMAC 가명(`pidRef`·`sidRef`·`accountRef`)만 쓰고, IP는 앞부분(IPv4 /24, IPv6 /48)만 남긴다(ADR-0053 결정 1, observability §2·§7).
- 신뢰 경계의 추적 문맥: 외부 제공자로 나가는 요청에는 `traceparent`·`tracestate`·`baggage`를 싣지 않고, 그것을 CI에서 확인한다(V-T31 ③, ADR-0130, observability §6).
- OTel Node SDK 시작은 `packages/platform` 시작 코드 한 곳에 둔다(devops §4.4).

서비스가 생기기 전에 이것이 있어야 첫 서비스부터 같은 모양의 로그와 추적을 갖는다.

## What Changes

- **정규 로그 줄**: 요청이 끝날 때 Pino로 표준 출력에 JSON 한 줄을 쓴다. 처리기는 `requestLog()`로 회차·결제사·대기 단계·플래그·의존성 소요·가명을 더한다. 예상하지 못한 오류의 기록(`reportToStderr`)은 이 줄의 `err`로 바뀐다. 라우터 앞에서 끝난 요청과 끊긴 요청도 한 줄을 남긴다.
- **표본**: 정상 줄은 trace ID 끝 56비트 문턱(OTel 확률 표본 규약)으로 고르고, 같은 값을 서버 span의 `peaket.sample.keep`에 단다. 4xx·5xx·SLO 지연 초과·표시한 응답은 전수다. 진입 경로 표시를 단 경로는 의도한 거절(403·429)도 문턱으로 줄이고, 머리 표본으로 고른 요청의 정상 줄을 남긴다.
- **로그 가명과 IP 앞부분**: 로그 가명 키(환경 변수, 256비트)로 만든 가명 함수, IP 앞부분 함수, Pino 가림 규칙(observability §7의 2단계 마스킹 1차).
- **OTel SDK 시작**(`@peaket/platform/telemetry`): HTTP·undici 자동 계측, 경계 전파기, 서버 span의 경로 틀과 IP 앞부분.
- **외부 호출 클라이언트**: span은 만들되 추적 헤더를 싣지 않고, 리디렉트를 따르지 않으며, 남은 시간을 시간 초과로 쓴다. 바깥에서 온 추적 문맥을 링크로만 남기는 앱 서버용 모드도 둔다(앱 서버 연결은 뒤 단계).
- **V-T31 ③ 탐침**(`@peaket/platform/testing`): 모의 서버가 받은 헤더를 기록해 추적 헤더가 없는지 본다. 기본 `fetch`로 바꾸면 실패하는 것을 시험으로 지킨다.
- 정본: 정규 로그 줄의 형식·표본 세부, 환경 변수 이름, 외부 클라이언트 규칙을 observability §3·§6·§7, delivery.md ASVS 행, verification V-T31에 '추천 적용 2026-11-01'로 적는다.

## Capabilities

### New Capabilities

- 없음.

### Modified Capabilities

- `service-template`: 정규 로그 줄, 로그 표본, 로그 가명·IP 앞부분, 추적 문맥 신뢰 경계, OTel SDK 시작 요구사항을 더한다.

## Impact

- 정본과 ID: NFR-011, ADR-0053 결정 1, ADR-0069 결정 11·12, ADR-0076 결정 4·5, ADR-0125 결정 3, ADR-0130(기술 검토 중간-066, V-T31), docs/observability.md §2·§6·§7, docs/devops.md §4.4, docs/security/secrets-and-keys.md(로그 가명 키), ASVS v5.0.0-14.2.3·15.3.2·16.2.1·16.2.2·16.2.5·16.3.4·16.4.1(docs/security/asvs/delivery.md), wbs 0.3.1 ②.
- 코드: `packages/platform/`(새 파일과 시작 코드), `pnpm-workspace.yaml`(`protobufjs` 설치 스크립트 거부), `pnpm-lock.yaml`.
- 문서: docs/observability.md §3·§7, docs/security/asvs/delivery.md, docs/verification.md(V-T31), docs/devops.md §4.4, packages/platform/README.md, wbs 0.3.1(md·csv), BUILD_ORDER, 00-summary §4, consistency-review(R 번호).
- 하지 않는 것(다른 단계): 엣지 게이트웨이의 `earlyRequestHeaders`로 바깥 추적 문맥 지우기와 V-T31 ①(게이트웨이 5개가 생기는 HOT-400), 앱 서버(Next.js)에 링크 모드 잇기와 V-T31 ②(앱 서버 계측을 넣는 단계), 직접 부르는 `fetch`를 찾는 Semgrep 규칙(BAS-010), 온세일 표본 비율을 제어 상태로 바꾸기(FND-090), 동적 로그 수준 명령(관제 명령 8), Kafka 감싸기의 추적 헤더(FND-090), Pyroscope·exemplar(4.1.1).
