# 제안: 부정 거래 조사 화면 설계와 퍼블리싱

## Why

사후 포렌식(판매가 끝난 뒤 실제 기록으로 부정 예매를 묶어 찾고, 사람이 소명과 2인 승인을 거쳐 취소·이용 제한을 정하는 기능)이 출시 범위의 필수 기능이 됐다(ADR-0171, 소유자 승인 2026-10-31). 기획·기능 설계·계약·보안 문서는 FRN-010~040에서 끝났다. 그런데 화면 쪽은 비어 있다. 화면 설계서(docs/design/d5)에 SCR-070·071이 없고, SCR-069는 예전 '1단계·2단계' 설명 그대로이며, 관제 콘솔에 '부정 거래 조사' 메뉴도 없다. BUILD_ORDER FRN-050이 이 일을 맡는다. 화면 퍼블리싱을 먼저 끝내 둔 방식(ADR-0170)을 그대로 따라, 서버 없이 목업 데이터로 화면 모양과 상태를 확정해 둔다. 그러면 뒤 단계는 데이터만 잇는다.

## What Changes

- **화면 설계 문서**
  - d5: SCR-070 사건 목록·SCR-071 사건 작업대의 배치(데스크톱·태블릿·휴대폰), 상태 표, 고정 문구. SCR-069를 세 원천(조사·연구·합성)으로 다시 쓴다(원천 배지, 원천별 후보 패널). 관제 메뉴 표와 휴대폰 범위 표(§3.9)에 세 화면을 더하고, SCR-046에 사건 요약 칸, SCR-042에 부정 예매 소명 변형, 화면 흐름(§4.4)과 인벤토리(71개)를 고친다.
  - d2: 새 부품 CMP-080 LinkGraph(연결 그래프), CMP-081 CaseStatusBadge(사건 상태 배지), CMP-082 ReplaySourceBadge(원천 배지), CMP-083 StepBaselineChart(단계별 시간 대 정상 기준선)를 더하고, CMP-040·060·063·021·079에 변형을 더한다. 마감까지 남은 시간은 새 부품 대신 CMP-040 DeadlineBadge에 '취소 마감' 쓰임을 더한다.
  - d3: SCR-070·071 행을 더하고 SCR-069·046·042 행을 고친다.
  - ASVS 추적 표(docs/security/asvs/forensic-replay.md): 화면 쪽 행(연 IP 원문을 화면 메모리에만 두는 것)을 보태고 퍼블리싱 위치를 적는다.
- **관제 콘솔(`apps/console-host`)**: '부정 거래 조사' 메뉴(지정 부정 거래 조사관에게만, 법정 조치 아래), SCR-070 `/investigations`, SCR-071 `/investigations/:caseId`(연결 그래프는 목업 그림, IP는 가린 값만), SCR-046의 부정 예매 조치 상태(사건 요약 칸). 상태는 d5 상태 표대로 `?state=`, 지정은 `?designation=`로 골라 보고, `/preview`에 등록한다.
- **포렌식 리플레이(`apps/forensics`)**: 원천 배지(조사·연구·합성 데이터)와 원천별 후보 패널·고정 문구(docs/features/forensic-replay.md §2.1). 원천은 `?source=`로 골라 본다.
- **소비자 웹(`apps/web`)**: SCR-042 소명 제출의 부정 예매 변형(사유 범주·기한·잠긴 티켓 안내), CMP-063 AppealForm `fraud` 변형.
- 하지 않는 것: 디자인 캔버스 보드(소유자가 요청할 때만 고친다), 데이터 연결·API 클라이언트, 실제 그래프 배치 엔진, 파트너의 기획사 보고 화면·경로(design.md 결정 11).

## Capabilities

### New Capabilities

- 없음. 화면을 목업 데이터로 그리는 퍼블리싱이라 시스템 행동(서버가 받는 요청과 응답)이 생기지 않는다. 화면 모양과 상태의 정본은 docs/design/d5·d3·d2이므로 명세를 따로 쓰지 않는다(`skip_specs: true`, 앞선 퍼블리싱 변경 `add-screen-publishing`과 같다).

### Modified Capabilities

- 없음.

## Impact

- **정본(읽기)**: ADR-0171(결정 3·6·7), docs/planning/04 관제 IA §1.3·흐름 F-14·SCR-042·046·069·070·071, docs/features/forensic-replay.md §2·§6.2·§6.7, docs/features/control-tower.md §9.2, docs/security/authz-matrix.md §3.7·§4.1·§4.3, openapi 태그 `investigations`의 경로(`GET /v1/ops/fraud-clusters`, `GET /v1/ops/fraud-cases/{caseId}/graph`, `POST /v1/ops/fraud-cases/{caseId}/ip-reveals` 등. 이 계약에는 `operationId`가 없어 경로로 적는다)와 스키마 `FraudCluster`·`FraudCase`·`FraudCaseGraph`·`FraudCaseSummary`·`FraudAppealView`, `GET /v1/ops/approval-requests/{approvalId}`, `GET /v1/fraud-appeal-requests`, POL-038 ⑪·POL-046, FR-071~074.
- **정본(고침)**: docs/design/d5-screen-blueprint.md(§1.2·§1.7·§2·§3.3·§3.9·§4.4·§5.24·§7.7·§7.17, 새 §7.18·§7.19, §9.1 한 줄), docs/design/d2-design-system.md(§1.1·§2), docs/design/d3-screens.md(관제·소비자 행), docs/security/asvs/forensic-replay.md(머리 글, 14.3.1·14.3.3 행), docs/frontend.md §2.5 경로 표 두 줄(관제 경로에 070·071, 리플레이 줄의 '출시 뒤 선택').
- **함께 고친 정본(본 세션)**: 코드 리뷰 중에 소유자 쪽이 두 곳을 고쳤다. docs/planning/04 SCR-046 행(부정 예매 조치 상세는 요청자와 승인 자격자만 받고, 그 밖의 호출자에게는 상세를 보이지 않는다, 서버 404 '열 수 없음')과 docs/features/forensic-replay.md §2.2 '원천 만료'(연구 원천 문구 "이 회차의 가명 기록은 보존 기간(90일)이 지났습니다"). d5 §7.7의 옛 인용('승인 단추를 주지 않는다')은 새 문구로 바꿨다.
- **결정**: ADR-0170(퍼블리싱을 먼저, 방식), ADR-0061(세 크기와 콘솔 휴대폰 범위), ADR-0171, ADR-0167(사이클·브라우저 확인·E2E 시험 금지). 새 ADR은 없다(구조를 바꾸지 않는다).
- **ASVS**: docs/security/asvs/forensic-replay.md(이미 있는 표에 화면 쪽 줄을 보탠다), docs/security/asvs/frontend.md(화면 공통, 고치지 않음).
- **WBS·빌드 순서**: BUILD_ORDER FRN-050(캔버스 보드 뺌). 기록 문서(BUILD_ORDER·PROGRESS·wbs·00-summary·review)는 이 변경에서 고치지 않는다.
- **코드**: `apps/console-host`(새 화면 둘, `entities/fraud-case`, 메뉴·호스트 상태·목록 등록, SCR-046 상태), `apps/forensics`(원천 배지·원천별 패널), `apps/web`(SCR-042 변형), `packages/ds`(CMP-063 변형, CMP-081·082 부품). 의존성과 잠금 파일은 바꾸지 않는다.
- **외부**: 없음. 브라우저 확인은 Claude in Chrome이 연결돼 있지 않으면 OPEN[06] 기본값대로 적고, 이 PC의 Playwright(Chromium)로 대신 본다.
