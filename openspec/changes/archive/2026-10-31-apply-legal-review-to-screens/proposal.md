# 제안: 사후 포렌식 법률 검토 결과를 퍼블리싱 화면에 옮기기

## Why

사후 포렌식(판매가 끝난 뒤 실제 기록으로 부정 예매를 찾아 소명과 2인 승인을 거쳐 취소·이용 제한을 정하는 기능)의 자체 법률 검토(ADR-0173)를 FRN-080에서 정책·설계·계약과 화면 설계서(docs/design/d5)에 반영했다. 그런데 이미 퍼블리싱한 화면 코드(`apps/`)는 그 전 문구와 상태 그대로다. 예를 들어 소명 화면은 아직 "결정될 때까지 양도가 잠깁니다"라고 말하지만, 정본은 잠금에 최대 기한(소명 요청 + 14일 [가정])을 두었다. 승인 화면에는 승인자가 자기 판단 이유를 적고 범위를 줄이고 요약을 열어야 승인하는 칸이 없다. BUILD_ORDER FRN-090이 이 일을 맡는다. FRN-070에서 정본에 넣고 "데이터 연결 때 더한다"던 SCR-070 '후보 만들기 다시 시도 중' 상태와 SCR-027 [부정 예매 조치] 탭도 이 단계의 설명에 들어 있다.

## What Changes

- **소비자 웹(`apps/web`)**
  - SCR-042 소명 제출: 잠금 안내를 최대 기한 문장으로, 제출 뒤 처리 일정 글을 바꾼다. 상태를 더한다: 양도 잠금 풀림, 조치 결과(취소·전액 환급·이용 제한·이의 기한·[이의 내기]), 이의 결과(인정·기각, 인정이면 우선 구매 카드), 받은 사람 변형 넷(받은 표 확인 요청, 제출됨 · 받은 표, 결과 · 취소 대상에서 빠짐, 결과 · 취소됨). CMP-063 AppealForm·AppealCaseCard에 필요한 칸을 더한다(`packages/ds`).
  - SCR-041 양도 받기: 결제자 고지 블록에 "결제한 분의 부정 예매로 확인되면 이 표가 취소될 수 있고, 환급은 결제한 분에게 갑니다".
  - SCR-011 주문·결제: 상태 '부정 예매 조사로 양도가 잠기는 회차'(결제 전 warning 상자, 결제 버튼은 그대로).
  - SCR-014 티켓 양도: 상태 '부정 예매 조사로 잠김'(양도 입력을 숨기고 잠금 기한과 ( 소명 보기 › )).
  - SCR-017 계정 설정: 탈퇴 대화의 대조값 보관 안내 두 줄(이용 제한 중, 소명 요청을 받은 계정)과 그때 "탈퇴 뒤 바로 다시 가입할 수 있습니다"를 숨김.
  - SCR-056 문의하기: 문의 유형 '외부 되팔이 게시물 신고'와 그 안내.
  - SCR-002 공연 상세: '예매 안내사항'에 '부정 예매 조사' 항목(POL-046 사전 고지, d5 §5.2 ⑯). 새 맥락 리뷰가 찾은 빠진 줄이다.
  - SCR-014의 409 `transfer-locked` 상태(§9.2 글, 잠김 구성).
- **관제 콘솔(`apps/console-host`)**
  - SCR-046 부정 예매 조치: 요약을 처음 연 시각, 대상 줄(계정 1·2… 체크로 빼기), 내 판단 이유(필수), 범위에 따라 바뀌는 승인 단추 글, 상태(요약을 아직 받지 못함, 판단 이유 없음, 범위를 줄임, 여러 건 한꺼번에 없음)와 오류(409 `fraud-summary-not-viewed`, 422 `approval-reason-required`·`approval-scope-invalid`).
  - SCR-070: '후보 만들기 다시 시도 중' 상태, 외부 게시물 등록의 확인 칸 셋·가릴 자리·신고 출처 규칙과 422 오류, 원천 만료 조건 글(회차 공연일 + 30일).
  - SCR-071: 잠금 문구("늦어도 14일 뒤 풀립니다"), 받은 사람 안내와 받은 사람 진술 줄, 조치 요청의 이용 제한 끝(요청 + 1년까지)·받은 사람 표 기본 빠짐·의견 칸 안내, 소명 요청 확인 대화상자 글, 내보내기 `COMPLAINT`, 상태(이용 제한이 너무 김, 양도 잠금 최대 기한 지남, 고소·고발용 요약 받음). 행동 값 나란히 보기가 없음을 시험으로 확인한다.
- **파트너 콘솔(`apps/partner`)**: SCR-027 [부정 예매 조치] 탭(회차 집계, 집계 전 상태).
- **포렌식 리플레이(`apps/forensics`)**: SCR-069 연구 원천 만료 문구와 행동 요약은 세션 하나씩만 본다는 것을 확인하고, 다르면 고친다.
- 하지 않는 것: 데이터 연결·API 클라이언트, 디자인 캔버스 보드 고침(소유자가 요청할 때만), 알림 문안 화면(알림은 화면이 아니다), 정본 문서 내용 변경(대조에서 정본의 틀린 곳을 찾으면 그 줄만 고치고 R 번호에 적는다).

## Capabilities

### New Capabilities

- 없음. 목업 데이터로 그리는 퍼블리싱이라 시스템 행동(서버가 받는 요청과 응답)이 생기지 않는다. 화면 모양과 상태의 정본은 docs/design/d5·d3·d2이므로 명세를 따로 쓰지 않는다(`skip_specs: true`, 앞선 `add-fraud-investigation-screens`와 같다).

### Modified Capabilities

- 없음.

## Impact

- **정본(읽기)**: ADR-0173(결정 3·4·5·6·7·9), ADR-0171, d5 §5.2 ⑯·§5.11·§5.14·§5.17·§5.23·§5.24·§5.30·§6.10·§7.7·§7.17·§7.18·§7.19·§9.2, d2 CMP-060·063, d3 SCR-042·046·056·071 행, POL-017·POL-038 ⑪·POL-046, FR-069·FR-072~074, openapi `FraudAppealView`(`party`·`lockActive`·`lockExpiresAt`·`actionResult`·`objectionStatus`·`objectionNote`)·`FraudCaseSummary`·`GET /v1/ops/approval-requests/{approvalId}`의 `summaryViewedAt`·`POST /v1/ops/approval-requests/{approvalId}/approvals`의 `reason`·`excludeAccountIds`·`excludeTicketIds`, `GET /v1/partner/events/{eventId}/fraud-report`, 탈퇴 409 `fraudHold`, 문의 유형 `RESALE_POST_REPORT`, 내보내기 종류 `COMPLAINT`(이 계약에는 `operationId`가 없어 경로로 적는다).
- **정본(고침)**: docs/security/asvs/forensic-replay.md 머리 글(퍼블리싱 위치 한 문장), d5 §7.7 '부정 예매 조치 · 범위를 줄임' 문장(바뀌는 수가 ① 요청 줄이고 사건 요약 칸은 그대로임을 분명히, 리뷰 결함 6).
- **결정**: ADR-0170(퍼블리싱 방식), ADR-0167(사이클, 브라우저 확인, E2E 시험 금지), ADR-0172·§8.6의 5(TDD 필수). 새 ADR은 없다(구조를 바꾸지 않는다).
- **ASVS·운영 확인**: docs/security/asvs/forensic-replay.md(화면 쪽 행 다시 봄), docs/security/asvs/frontend.md(화면 공통, 고치지 않음). 운영 확인 표(docs/features/forensic-replay.md §9)는 목업 화면이라 새 사건·필드가 없어 고치지 않는다.
- **WBS·빌드 순서**: BUILD_ORDER FRN-090. BUILD_ORDER 설명의 'SCR-012 잠금 안내'는 d5에서 SCR-011(§5.11, 결제 전 안내)의 상태다(design.md 결정 2).
- **코드**: `apps/web`, `apps/console-host`, `apps/partner`, `apps/forensics`(확인만일 수 있음), `packages/ds`(AppealForm). `apps/partner/package.json`에 `test` 명령을 더한다. 의존성과 잠금 파일은 바꾸지 않는다.
- **외부**: 없음. 브라우저 확인은 소유자가 연결해 둔 Claude in Chrome으로 한다.
