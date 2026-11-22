# ADR-0356: 대시보드·Grafana 접근·보존 설정을 저장소 파일로 두고, 서버 오류 수집 SDK를 공용 서버 패키지에 잠가 넣는다(2026-11-23)

- **상태**: 추천 적용(2026-11-23, F-01-2 계획 담당, docs/review/plans/F-01-2.md). 방향을 바꾸는 결정이 아니라 정본이 비워 둔 '어떻게'를 채운다. 감독이 다르게 정하면 이 ADR을 고친다.
- **관련**: [docs/observability.md](../observability.md) §3(템플릿 대시보드, 운영 확인 표)·§9(보존 표, Grafana 권한)·§11(Sentry), [docs/devops.md](../devops.md) §4.4('설정이 기대는 최소 판'), [docs/verification.md](../verification.md) V-T39·V-T47, [ADR-0067](0067-console-vs-observability-tools-and-measured-backend-choice.md) 결정 4·6, [ADR-0077](0077-observability-book-review-buckets-storage-retention.md), [ADR-0078](0078-aiops-review-demand-forecast-action-exits-correlation.md) 결정 3·6, [ADR-0120](0120-long-term-metrics-keep-mimir-classic-after-thanos-comparison.md), [ADR-0134](0134-tech-review-low-doc-fixes-data-streams-observability-hotpath.md), [ADR-0139](0139-personal-data-cross-border-transfer-register.md) 결정 3, [ADR-0331](0331-trim-per-batch-checks-defer-kind.md) 결정 9, [ADR-0332](0332-infra-build-out-segment-five.md) 결정 5·7
- **관련 ID**: OPS-040(wbs 4.1.2), OPS-050(wbs 4.1.3), V-T39, V-T47, ASVS v5.0.0-14.2.3·15.2.1·16.4.2

## 맥락

- 정본은 "모든 패널은 Dashboards as Code(대시보드 정의를 Git에 파일로 두고 그 파일로만 배포하는 방식)"(observability.md:125), "민감한 데이터 소스는 역할이 아니라 조직으로 나눈다"(:598~601), "Mimir 테넌트 `raw`·`agg5m`의 보존"(:573)을 정했다. 그러나 무엇을 어느 파일에 두고 무엇으로 맞는지 보는지는 비어 있다. 지금 생성기(`tools/local/dashboards.mjs`)는 서비스 두 개(`example-svc`·`v0-monolith`)만 만들고 폴더가 하나다.
- Sentry(앱 오류를 모아 알려 주는 서비스) 서버 SDK는 아직 어느 패키지에도 없다. 정본은 수집 설정 잠금(:635)과 최소 판(devops §4.4)만 정했다. 공용 서버 패키지는 이미 OpenTelemetry(지표·로그·요청 기록을 모으는 공통 표준과 도구) SDK를 스스로 띄운다(`packages/platform/src/telemetry-sdk.ts`). Sentry Node SDK는 기본값으로 자기 OpenTelemetry 설정을 띄우므로 둘이 겹칠 수 있다.
- 이 PC에는 사람 모집·외부 계정·클라우드 비용이 없다(소유자 결정 2026-10-31). Sentry 조직은 관측 백엔드 판정(wbs 4.8.2, OPS-520) 뒤에 만든다(ADR-0139 결정 3). Grafana 로그인을 이을 신원 공급자(IAM Identity Center 같은)도 없다. 배포 쪽 실행 확인은 '구간 5: 인프라 구축'으로 미뤘다(ADR-0331 결정 9, ADR-0332 결정 5: 설정이 서로 맞는지는 tools-check가 계속 본다).

## 결정

1. **대시보드 생성기를 넓힌다.** `tools/local/dashboards.mjs` 하나가 계속 원천이다(CLAUDE.md의 생성 파일 규칙 그대로).
   - 대상: docs/architecture.md §3.1 서비스 맵 표의 업무 서비스 전부와 지금의 두 개. 목록을 손으로 적지 않고 그 표를 읽는다. 표에 있는데 대시보드가 없거나, 표에 없는 대시보드가 남으면 `--check`가 실패한다.
   - 폴더: 대시보드마다 주인 팀 폴더에 둔다. 팀은 `.github/CODEOWNERS`의 그 서비스 폴더 줄이 정한다(가상 팀 지도, docs/architecture.md §10). 파일은 `deploy/local/dashboards/<폴더>/<이름>.json`에 두고 Grafana 파일 공급자의 '폴더 구조를 폴더로' 설정으로 싣는다.
   - 온세일 공용 대시보드 하나를 '온세일 공용' 폴더에 둔다. 첫 행은 서비스를 고르는 변수가 있는 네 신호이고, 주석 셋(배포, 장애 주입, 운영 사건 줄 `ops_event`)을 둔다(observability.md:125, ADR-0078 결정 3). 주석은 Loki(정형 로그 저장소) 데이터 소스 uid `loki`를 쓴다. 로컬에는 Loki가 없어 주석이 실제로 그려지는지는 구간 5(INF-040)에서 본다.
   - 화면에서 고친 것은 저장하지 않는다(공급자 `allowUiUpdates: false`, observability.md:601).
   - 데이터 소스 연결(exemplar → Tempo 등, :126)은 OPS-080(F-01-4)이 더한다.

2. **Grafana 조직·팀·폴더는 원천 파일 하나와 적용 스크립트로 둔다.**
   - 원천: `deploy/platform/observability/grafana/access.yaml`. 조직 둘('PEAKET 관측'·'PEAKET 제한'), 팀(CODEOWNERS의 가상 팀), 폴더(팀별과 '온세일 공용'), 역할 연결(운영자 Viewer, 엔지니어 Editor, 조직 관리자), 신원 공급자 그룹 이름 자리를 적는다. 값의 정본은 observability.md:598~602다.
   - 데이터 소스와 대시보드 공급자는 Grafana 파일 프로비저닝(`deploy/platform/observability/grafana/provisioning/`)에 두고, 항목마다 조직(`orgId`)을 적는다. 로컬 Grafana의 설정 ConfigMap은 이 파일에서 만든다(사본을 두지 않는다).
   - 조직·팀은 Grafana 파일 프로비저닝이 다루지 않으므로(구현 때 Grafana 13.2 문서로 확인한다), 원천 파일을 읽어 Grafana HTTP API로 없는 것만 만드는 멱등 적용 스크립트(`tools/local/grafana-access.mjs`)를 둔다. 로컬은 `cluster.mjs observability`가 프로비저닝 전에 부른다. 운영의 적용 방식(배포 뒤 작업 등)은 INF-020이 정한다.
   - 맞는지 보는 정적 검사 `tools/ci/observability-config.mjs --check`(tools-check)를 둔다. PostgreSQL 쿼리 문장 데이터 소스는 제한 조직에만 있어야 하고, 기본 조직의 데이터 소스·대시보드가 그 uid를 가리키면 실패한다.
   - 버린 안: Terraform Grafana 공급자(`infra/`)는 운영에는 맞지만 로컬 Grafana에 적용하려면 포트 전달 뒤 Terraform을 돌려야 하고, 대시보드는 여전히 파일 프로비저닝이라 원천이 둘로 갈린다. Grafana Operator는 클러스터에 컨트롤러 하나를 더한다.
   - 신원 공급자 연결(SSO)은 계정이 없어 이 결정에서 켜지 않는다. 그룹 이름 자리만 원천에 두고, 실제 연결은 INF-020에서 한다.

3. **보존과 원격 쓰기도 저장소 파일로 둔다.**
   - Mimir 테넌트별 보존 값(`raw`·`agg5m`)은 Mimir 실행 설정 덮어쓰기 파일(`deploy/platform/observability/mimir/`)에 둔다. 값은 observability.md:573을 따른다.
   - Prometheus 원격 쓰기는 둘이다. `raw`에는 모두 보내고, `agg5m`에는 5분 집계 기록 규칙의 결과만 보낸다(`write_relabel_configs`, ADR-0077).
   - 5분 집계 기록 규칙은 이름을 `agg5m:`으로 시작하고 평가 간격 5분인 규칙 묶음에만 둔다(추천 적용). 그래서 `agg5m`으로 보내는 거름은 이름 앞머리 하나로 정해지고, 정적 검사가 '그 앞머리를 단 규칙은 모두 5분 묶음 안에 있다'를 본다.
   - 위 2의 정적 검사가 보존 값, 원격 쓰기 둘, 거름, 규칙 이름·간격을 함께 본다. 28일 남은 예산 규칙은 OPS-090(F-01-5)이 더한다.
   - 실제 Mimir(모놀리식)에 올려 보존과 골라 보내기가 먹는지는 INF-040이 본다(ADR-0120의 확인).

4. **서버 오류 수집 SDK는 `packages/platform`이 켜고, 서비스는 설정을 바꾸지 못한다.**
   - `createService`가 시작할 때 오류 수집을 켠다. 받는 곳 주소(DSN)는 환경 변수 `PEAKET_SENTRY_DSN`이고, 비어 있으면 끈다(네트워크 호출 없음, 시작 로그 한 줄). 조직이 없는 동안은 모든 환경이 비어 있다(ADR-0139 결정 3).
   - 수집 설정 잠금(observability.md:635의 끄는 값·거름·`beforeSend` 마스킹·`accountRef`만)은 한 함수 안에 고정하고, `createService` 옵션으로 덮어쓰지 못한다. `beforeSend`의 마스킹은 로그와 같은 가림 함수(`redactDeep`, observability.md §7)를 쓴다.
   - 보내는 것: 공용 예외 필터가 5xx로 끝낸 예상하지 못한 오류, 처리되지 않은 예외·거절. 4xx와 정상 분기 거절은 보내지 않는다. 사건에는 응답과 같은 `traceId`를 태그로 단다.
   - 성능 추적·프로파일·화면 녹화는 켜지 않는다. SDK가 자기 OpenTelemetry 설정이나 자동 계측을 띄우지 않게 한다(`@sentry/node`의 OpenTelemetry 설정 건너뛰기 옵션, 또는 OpenTelemetry를 싣지 않는 가벼운 Node 패키지가 10.57.0 이상에 있으면 그것. 구현 담당이 고르고 계획 파일 '구현 메모'에 적는다).
   - 받는 곳이 멈추면 SDK가 사건을 버리고 요청을 기다리게 하지 않는다(observability.md:642). 끝낼 때 남은 사건을 보내는 시간은 2초 [가정]이고, 종료 순서(`shutdown.ts`)를 늦추지 않는다.
   - 수집 설정이 먹는지는 로컬 가짜 수신기(Sentry 사건 묶음을 받는 작은 HTTP 서버)로 V-T39 ①이 본다. 실제 Sentry·GlitchTip(Sentry SDK를 그대로 받는 오픈소스 오류 수집 서버) 서버는 띄우지 않는다.

5. **최소 판 검사는 `tools/ci/min-versions.mjs`가 한다(tools-check).**
   - devops §4.4 '설정이 기대는 최소 판'의 항목마다, 그 줄의 '<판> 이상'을 읽어 최소 판으로 쓴다. 판 숫자를 스크립트에 옮겨 적지 않는다.
   - Sentry는 잠금 파일(`pnpm-lock.yaml`)의 `@sentry/*` 판이 모두 최소 판 이상이고 서로 같아야 한다(브라우저·서버 같은 판). PgBouncer는 `deploy/`·`tools/local/`의 이미지 이름표가 최소 판 이상이어야 한다.
   - 판은 숫자 마디로 견준다. 정본 줄이나 잠금 파일을 읽지 못하면 통과로 보지 않고 실패한다.

6. **새 오류 종류·상위 오류 요약은 ops-svc가 가져온다(pull).**
   - ops-svc의 포트 하나(오류 요약 원천)가 Sentry 호환 웹 API의 오류 목록을 1분 [가정]마다 읽어(observability.md:635) 두 값을 만든다. 배포 뒤 새로 생긴 오류 종류 수와, 많이 난 오류 상위 5개다. 토큰은 읽기 전용 범위만 받는다.
   - 무료 등급에서 그 API를 쓸 수 있는지는 Sentry 계정이 있어야 확인되므로 이 기능에서 확인하지 않는다. OPS-520(F-08-15) 운영 방식 판정이 문서 인용으로 함께 정한다.
   - GlitchTip이 두 질의를 지원하는지도 그때 그 문서·소스로 확인한다. 어댑터와 콘솔 요약 연결 시험(C-T30)은 위젯을 만드는 OPS-380(F-03-3)이 그 결과로 한다. 지원하면 PC의 GlitchTip으로, 아니면 PC에 직접 설치한 Sentry로 한다(observability.md:636·:643).

7. **이 기능이 만들지 않는 것.**
   - 브라우저 SDK(observability.md:635의 브라우저 몫, docs/frontend.md:1569): 대기실 경량 페이지를 뺀 앱에 싣는 일은 어느 WBS 단계에도 없다. V-T39 ②로 떼어 두고, 감독이 기능을 정한다.
   - 실제 Grafana·Mimir·Loki에 올린 확인(V-T47 ⑥), 신원 공급자 연결, 운영 적용 방식: INF-020·INF-040.
   - 오류 수집 0건이 5분 [가정] 넘을 때의 SEV3 경보(observability.md:642): 경보 규칙을 만드는 OPS-100(F-01-5).

## 검토한 대안

| 대안 | 판단 |
| --- | --- |
| 대시보드 대상 서비스를 생성기 안에 손으로 적는다 | 기각. 새 서비스를 더할 때 빠뜨려도 `--check`가 통과한다. 정본 표를 읽으면 빠짐이 실패로 보인다 |
| 조직·팀까지 모두 Terraform Grafana 공급자로 둔다 | 기각(결정 2). 운영 적용 방식은 INF-020에서 다시 본다 |
| Sentry SDK를 서비스마다 `main.ts`에서 켠다 | 기각. 서비스마다 설정이 달라질 수 있고, 잠금이 한 곳에서 지켜지지 않는다 |
| 최소 판을 스크립트 상수로 둔다 | 기각. 정본 값을 옮겨 적지 않는다는 규칙(CLAUDE.md)에 어긋나고, devops §4.4만 고쳐도 검사가 따라오지 않는다 |
| 오류 요약을 Sentry가 웹훅으로 ops-svc에 밀어 준다 | 기각. 웹훅은 유료 연동 기능이고(observability.md:636), 받는 쪽 입구를 하나 더 열어야 한다 |

## 결과

- **좋은 점**: 대시보드·조직·보존·원격 쓰기의 어긋남을 클러스터 없이 tools-check가 막는다. 오류 수집 잠금이 서비스마다 달라지지 않는다. 조직이 생기기 전에도 SDK와 잠금이 시험된다.
- **나쁜 점**: 실제로 올려서 도는지는 구간 5까지 모른다. 공용 서버 패키지에 의존성이 하나 늘어 모든 서비스 이미지가 커진다.
- **되돌릴 조건**: INF-040에서 파일 프로비저닝과 적용 스크립트로 조직 둘이 서지 않으면 결정 2를 Terraform 공급자나 Operator로 바꾼다. SDK가 기존 OpenTelemetry 설정과 겹쳐 요청 기록이 둘로 나오면 결정 4의 패키지 선택을 바꾼다.
