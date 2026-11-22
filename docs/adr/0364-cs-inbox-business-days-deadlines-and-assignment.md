# ADR-0364: CS 처리함 첫 구현 — 영업일 달력, 건 종류별 기한, 기한 알림, 배정 규칙(2026-11-23)

- **상태**: 채택(2026-11-23, 추천 적용. 기능 F-06-2 계획 담당이 정본 빈칸을 구현 전에 정했다. 방향을 바꾸는 결정은 없고, 단계 사이 일의 나눔(결정 7)은 BUILD_ORDER 단계 줄과 정본 문장이 서로 달라 맞춘 것이다).
- **관련**: [docs/features/transfer-refund.md](../features/transfer-refund.md) §7.1·§11·§12·§13, [docs/design/d5-screen-blueprint.md](../design/d5-screen-blueprint.md) §7.6, [docs/data.md](../data.md) `cs_case`, openapi `/v1/ops/cases`, asyncapi `support.cases-requested`, [ADR-0062](0062-open-items-delegated-decisions.md)·[ADR-0066](0066-screen-feedback-12-items.md)·[ADR-0073](0073-third-consistency-audit-delegated-decisions.md)·[ADR-0354](0354-feature-vertical-slices-after-cutover.md), 계획 [docs/review/plans/F-06-2.md](../review/plans/F-06-2.md)
- **관련 ID**: GAT-280, R-T12, R-T20, R-T48~R-T51, P-T19 ②, PRF-175

## 맥락

- ops-svc `cases` 모듈은 건을 여는 골격(내부 HTTP `/internal/v1/cs-cases`, 받는 종류 넷)뿐이다. 목록·상세·갱신 API, 기한 계산, 기한 알림, 배정이 없다. purchase-svc가 보내는 `COMPENSATION_PENDING`은 받는 종류가 아니라 조용히 버려진다(`accepted: false`). queue-svc가 Kafka로만 내는 `VERIFICATION_APPEAL`은 ops-svc에 소비자가 없어 건이 되지 않는다.
- 정본은 "기한은 영업일(공휴일 달력)로 세고 1영업일 전에 알린다"(transfer-refund §7.1, d5 §7.6)고만 하고, 달력의 출처와 세는 법은 "구현 단계에서 정한다"(payment §12, transfer-refund §12)로 남아 있다. purchase-svc는 공제율 계산(GAT-070)에서 공휴일 파일 `PEAKET_HOLIDAY_CALENDAR_FILE`을 이미 읽는다. ops-svc의 다른 영업일 계산(관리 역할 변경 승인 기한)은 UTC 요일로 주말만 건너뛴다.
- 계좌 입력 요청 재발송은 payment §4.1·§6이 "GAT-250·GAT-280", BUILD_ORDER GAT-130 줄이 "GAT-100 계좌 입력 요청 재발송"으로 서로 다른 단계에 적었다.

## 결정

1. **영업일 달력**: 날짜는 한국 표준시(KST)로 센다. 토·일과 공휴일 파일의 날짜가 비영업일이다. 공휴일 파일은 purchase-svc와 같은 꼴·같은 환경 값(`PEAKET_HOLIDAY_CALENDAR_FILE`, `["2026-01-01", …]` 또는 `{ "holidays": [...] }`)이고, 운영자가 공공데이터포털 특일 정보(대체·임시 공휴일 포함)로 해마다 갱신한다. 코드에 날짜를 박지 않는다. local·ci는 파일이 없으면 주말만 빼고, staging·prod의 ops-svc는 파일이 없거나 읽지 못하면 시작하지 않는다.
   - "N영업일 뒤"는 시작 시각의 KST 같은 시각에서 영업일을 N번 넘긴 날의 같은 시각이다. 시작한 날이 비영업일이어도 그날은 세지 않는다(다음 영업일이 첫째 날). "다음 영업일"은 1영업일이다. 시간 단위 기한(확인 4시간, 판정 30분)은 벽시계로 센다.
   - "1영업일 전"은 기한에서 영업일 하나를 뺀 같은 시각이다. 기한까지 1영업일이 안 남은 건은 열리자마자 임박이다.
2. **건 종류별 기한**: 건을 열 때 `progress_due_at`·`result_due_at`을 정한다. 값은 transfer-refund §7.1 표와 d5 §7.6 표의 기한 칸이고, 코드는 그 표를 종류(필요하면 category)별 규칙 하나로 옮긴다. 기한을 세는 시작은 `CaseRequested.dueBaseAt`(새 선택 칸)이고, 없으면 `createdAt`이다. '회차 취소 확정 뒤'로 세는 건(일괄 환불 실패·배상 대기)은 보내는 쪽이 `dueBaseAt`에 확정 시각을 싣는다. 기한이 없는 종류는 두 칸을 비우고 `next_due_at`이 `infinity`다(소유자 결정 2026-11-11, open-items 93번). `JUDGEMENT_PENDING`은 요청 시각 + 1영업일이고, 회차 취소 요청 응답의 `judgementDueAt`(REQUESTED일 때)도 같은 달력으로 읽을 때 센다(새 칸·마이그레이션 없음).
3. **기한 알림**: ops-svc 배경 작업이 1분 [가정]마다 열린 건을 본다. 1영업일 전이 지나면 운영 경보 `CS_CASE_DUE_SOON`(SEV3), 기한이 지나면 `CS_CASE_OVERDUE`(SEV2)를 ops_alert에 한 번 연다(키는 건 ID·기한 종류·기한 값. 같은 기한은 한 번). 경보 세부에는 건 ID·종류·기한 종류(`PROGRESS`·`RESULT`)·기한·담당자 관리 계정 ID와 받는 사람(`ASSIGNEE`·`CS_LEAD`)만 싣고 팬 정보는 없다. 건이 RESOLVED가 되면 그 건의 경보를 푼다. 이 경보가 d5 알림 표 'CS 기한 1영업일 전·초과'의 관제 알림 원장이다. 콘솔에 실시간으로 띄우거나 호출하는 일은 관제 콘솔·경보 기능(F-03·F-01) 몫이고, SCR-045는 목록의 `dueState`로 배지와 위 배너를 그린다.
4. **받는 종류와 멱등**: 받는 종류는 `REFUND_FAILED`·`FLAGGED`·`JUDGEMENT_PENDING`·`REFUND_ACCOUNT_PENDING`·`COMPENSATION_PENDING`·`VERIFICATION_APPEAL`·`DISPUTE`·`SCANNER_UNREPORTED`·`APPROVAL_EXECUTION_FAILED`다. 나머지는 그 건의 상세를 읽을 기능(문의 F-06-5, 소명 F-06-3·F-06-4, 게시물 신고 LCH-150, 결제 뒤 미발권 BAT-012 등)이 더한다. `eventKey`를 `cs_case_request`에 한 번만 적어, 해결된 건의 사건이 다시 와도 새 건을 열지 않는다. 같은 (종류, 대상)의 열린 건이 있으면 그 건을 돌려준다(지금 동작). ops-svc는 Kafka `support.cases-requested`를 지금의 소비자 그룹(`peaket.ops-svc.<환경>`)에서 읽고 내부 HTTP와 같은 처리기를 부른다. 받지 않는 종류는 보류하지 않고 넘기며 지표로 센다.
5. **역할과 배정**: 목록·상세는 openapi의 네 역할이다. CS 담당자(`cs_agent`·`cs_lead`)의 목록에는 지급·대사·KYC 건이 없고 상세는 404다(open-items 72번). operator·commander는 모두 보고 지급·대사·KYC 건만 갱신한다(그 밖은 403). 배정은 `cs_agent`가 자기에게 맡거나 자기 배정을 풀 때만, `cs_lead`는 아무 CS 담당자에게나 맡긴다(대상이 활성 `cs_agent`·`cs_lead`가 아니면 422). 상태는 열림 → 진행 중 → 해결, 열림 → 해결이고 해결은 끝이다(다시 고치면 409). 해결할 때는 결과 메모(1~2,000자)가 필요하다. 갱신은 `If-Match`(판 번호)를 받고 응답에 `ETag`를 싣는다(docs/api/guidelines.md '동시 수정'). 갱신마다 감사 체인에 행위자·이전·다음 상태·배정을 남기고 메모 본문은 남기지 않는다.
6. **실패한 승인 업무의 재실행**: 승인 업무 실행이 실패해 `FAILED`가 되면(계약 조건 변경, 관리 역할 변경, 지급 묶음) ops-svc가 `APPROVAL_EXECUTION_FAILED` 건(대상 승인 ID, category 승인 종류)을 연다. 기한은 원래 승인 업무의 기한을 이어받고, 기한이 없는 승인이면 기한이 없다. 다시 실행은 지금처럼 승인자가 같은 승인 ID로 approve를 다시 부르는 것이고(실행 직전 재인증, ADR-0073), 성공하면 그 건을 시스템이 해결로 닫는다.
7. **단계 사이 나눔**: 계좌 입력 요청의 첫 발송과 재발송(R-T20 ②)은 GAT-130에 합친 GAT-100(기능 F-07-8)이 한다. 링크가 여는 화면(SCR-060·043)과 계좌 대기 상태가 그쪽에 있고, 팬 알림 종류도 아직 없기 때문이다. 이상 표시(`FLAGGED`, `ENTRY_AFTER_CANCEL`) 건의 취소 무효·환급 처리(P-T19 ②)와 결제 모델 시험의 `csConfirm`(시스템 잘못 환불 승인)은 예외 환불과 같은 돈·티켓 상태 전이라 GAT-300(기능 F-06-3)이 한다. 팬 문의의 분쟁 접수 생산자는 GAT-330(F-06-5)이다. GAT-280은 그 건들이 처리함에 들어와 기한·알림·배정·해결로 움직이는 바탕을 끝낸다.

## 결과

- 정본: transfer-refund §7.1 '첫 구현', §11 R-T20 세부 번호와 R-T48~R-T51, §12 '영업일 달력', §13 CS 기한 행. data.md `cs_case` 칸과 `cs_case_request`. openapi `CsCase`·목록 매개변수. asyncapi·avro `CaseRequested` 종류와 `dueBaseAt`. payment §4.1·§6의 재발송 단계 이름.
- 마이그레이션은 ops-svc 0030(필요하면 0031)이다. 생성물(packages/contracts·api-client)은 구현 담당이 `gen`으로 만든다.
- 남는 한계: 공휴일 파일 갱신은 사람 몫이다(해마다 12월 [가정]). purchase-svc는 파일이 없어도 시작하고, ops-svc의 관리 역할 변경 승인 기한은 UTC 주말 계산 그대로다(정리 목록).
