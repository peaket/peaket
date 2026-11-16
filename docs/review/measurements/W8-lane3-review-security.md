# W8 갈래 3 웨이브 끝 리뷰(보안 관점): BAT-415·BAT-420

- **무엇**: 웨이브 8 갈래 3의 두 묶음 BAT-415(GAT-070·GAT-080, 부정 예매 운영자 취소·결제 후 일반 취소·예매 취소 다듬기)와 BAT-420(GAT-090·GAT-110, 마감 뒤 환급의 입장 기록 대조·회차 취소 요청·판정·확정·파트너 요청·환급 미룸)을 보안 눈으로 본 결과다(2026-11-16).
- **리뷰 담당**: `l3w8-rev-security`(claude-opus-5-5). 계획·시험·구현에 관여하지 않았고 코드를 고치지 않았다.
- **본 범위**: 가지 `wave/lane3-w8`, `git diff 853758eb..b9577fb5`(커밋 92개). 계획은 `docs/review/plans/BAT-415.md`·`BAT-420.md`의 `## 계획` 절만 읽었다(리뷰·검증 절은 읽지 않았다). 정본은 `docs/security/asvs/transfer-refund.md`(메모와 8.2.1·8.2.2·8.3.1·15.4.2·16.5.3·2.3.5 행), `docs/security/authz-matrix.md`(테넌트 표·행 보안 정책 절), `docs/data.md`의 닿는 줄을 `git show b9577fb5:<경로>`로 읽었다.
- **본 것**: 역할과 권한(commander 요청, 판정자가 아닌 확정자, 재인증의 동작·요소·패스키, 파트너 테넌트 대조, 팬 결제자 대조), 내부 gRPC·HTTP 호출자 검사(OperatorCancelTickets·EventCancelTickets·GetEntryRecords·SetEventRefundHold·CancelFraudTickets)와 토큰 없을 때 운영 시작 거절, 상수시간 비교, 입력 검사(취소 ID 9~64자, 소문자 UUID, 사유 목록), 멱등 키 범위, 로그·응답·CS 건에 실리는 개인정보, 새 마이그레이션의 권한, 감사 기록.

## 요약

| 심각도 | 건수 | 번호 |
| --- | --- | --- |
| 높음 | 0 | — |
| 중간 | 2 | S1, S2 |
| 낮음 | 9 | S3~S11 |

- 묶음별: BAT-415 2건(S7, S8), BAT-420 10건(S1~S6, S8, S9, S10, S11). S8은 두 묶음에 함께 닿는다.
- 막는 지적(합치기 전에 꼭 고칠 것)은 없다. 새 내부 RPC 다섯은 모두 내부 토큰을 상수시간으로 비교하고, 운영에서 토큰이 없으면 시작하지 않는다(`internalGrpcTokenFromEnv`). 팬 취소는 결제자를 먼저 본 뒤 회차 상태를 보고, commander 요청과 확정은 재인증(동작 APPROVAL, 패스키, 1회용 jti)을 거친다.

## 지적

### S1. 공제 차액·이상 표시 CS 건이 실패해도 아무도 모른다

- **심각도**: 중간
- **ASVS**: v5.0.0-16.5.3(안전하게 실패하기), v5.0.0-16.3(보안에 닿는 일은 기록을 남긴다)
- **묶음**: BAT-420(몫 D, 몫 A)
- **파일:줄**: `services/purchase-svc/src/modules/refund/adapters/http-deduction-gap-notice.ts` 22~34줄(`open`), `services/purchase-svc/src/modules/refund/adapters/http-entry-flag-notice.ts` 17~30줄(`open`), `services/purchase-svc/src/modules/refund/application/event-refund-service.ts` 170~185줄(`#openDeductionGaps`), `services/purchase-svc/src/relay-app.ts`·`src/start.ts`의 `HttpDeductionGapNotice(opsClient, env.PEAKET_INTERNAL_TOKEN)` 조립, `services/ops-svc/src/modules/cases/application/receive-case-requested.ts` 13~16줄
- **틀린 점**: 두 어댑터가 ops-svc 응답 상태(`res.ok`)를 보지 않고, 연결 오류까지 `catch {}`로 삼킨다. 그래서 401(내부 토큰 없음)·500·시간 초과가 모두 '보냄'과 같다. 부르는 쪽 `#openDeductionGaps`의 `catch`와 경고 로그(`event-refund-deduction-gap-failed`)는 이 실패를 볼 수 없다. 어댑터 주석은 "실패는 부른 쪽 로그가 본다"고 적었지만 사실이 아니다.
- **근거**: 공제 차액 건은 회차 취소 확정 때 한 번만 찾는다("다시 시작하면 다시 찾지 않으므로", 어댑터 주석). 소유자 결정 OPEN[45]는 이 차액을 CS가 승인 업무로 돌려주게 정했으므로, 건이 사라지면 팬이 받아야 할 돈이 기록 없이 남는다. `PEAKET_INTERNAL_TOKEN`(내부 HTTP 토큰)은 시작 때 꼭 있어야 하는 값이 아니어서(ticket-svc `start.ts`도 경고만 한다) 운영 설정이 빠지면 모든 건이 조용히 401이 된다. 이상 표시(`ENTRY_AFTER_CANCEL`) 건은 행에 `entry_recorded_at`이 남아 다시 찾을 수 있지만, 차액 건은 남는 표시가 없다.
- **고칠 쪽**: 구현(어댑터가 2xx가 아니면 던지거나 실패를 돌려주고, 부르는 쪽이 경고와 지표를 남김). 계획(차액 건을 열었는지 표시하는 칸이나 다시 찾는 길, 운영에서 `PEAKET_INTERNAL_TOKEN`이 없으면 시작 실패로 할지).
- **확인 필요**: ops-svc `CsCaseStore.open`이 무엇으로 중복을 거르는지. `receive-case-requested.ts`는 `category`를 버리고 `kind`·`sourceId`만 넘긴다. 차액 건(`REFUND_FAILED`, 분류 `DEDUCTION_GAP`)과 같은 취소 ID의 환급 실패 건(`REFUND_FAILED`, 분류 `REFUND`, `HttpRefundFailureNotice`)이 `(kind, target_ref)`로 합쳐진다면, 앞서 닫힌 환급 실패 건에 차액 건이 묻힌다. CS 담당은 두 건을 가르지 못한다.

### S2. 파트너 회차 취소 경로가 테넌트 표의 행 보안 규칙을 따르지 않는다

- **심각도**: 중간
- **ASVS**: v5.0.0-8.2.2(데이터 항목 단위 권한, IDOR 막기), v5.0.0-8.4.1(여러 테넌트를 가르는 통제)
- **묶음**: BAT-420(몫 P)
- **파일:줄**: `services/ops-svc/migrations/0013_event_cancellation_request_partner.sql`(전체), `services/ops-svc/src/modules/event-cancellations/application/event-cancellations.ts` 141~172줄(`requestByPartner`)·179~209줄(`partnerStatus`)·381~387줄(`#ownedEvent`), `docs/security/authz-matrix.md` 82줄·209줄
- **틀린 점**: authz-matrix는 `event_cancellation_request`를 테넌트 표(`promoter_id`를 가진 표)로 적고, "파트너 요청 경로는 그 서비스의 파트너 전용 DB 사용자로 접속하고, 테넌트 표에는 PostgreSQL 행 보안 정책(RLS: 표의 행마다 누가 보고 바꿀 수 있는지 DB가 거르는 규칙)을 켠다"고 정했다. 0013은 `promoter_id` 칸과 CHECK만 더하고 RLS·파트너 DB 사용자·`SET LOCAL app.tenant_id`가 없다. 파트너 경로는 관제 경로와 같은 앱 연결로 표 전체를 읽고 쓴다.
- **근거**: 지금은 앱 코드(`#ownedEvent`의 core 판매 설정 `promoterId` 대조)가 막는다. 그러나 정본이 두 겹 방어를 요구했고, 앱 대조 한 줄이 빠지거나 `partnerStatus`처럼 `store.list({ eventId })`로 읽는 새 경로가 생기면 DB가 다른 파트너 행을 거르지 않는다. 계획(`## 계획`)과 transfer-refund 정본 어디에도 이 예외가 적혀 있지 않다.
- **고칠 쪽**: 계획(ops-svc에도 파트너 DB 역할과 RLS를 둘지, 아니면 authz-matrix에 'ops-svc는 앱 대조만'이라는 예외와 까닭을 적을지 정함). 고르면 구현 또는 정본.
- **확인 필요**: ops-svc가 이 규칙에서 빠지기로 한 ADR이 있는지(이번 범위에서 찾지 못했다).

### S3. 판매 재개 막기가 회차 ID가 없거나 여럿이면 열린다

- **심각도**: 낮음
- **ASVS**: v5.0.0-16.5.3(검증이 실패하면 열지 않는다)
- **묶음**: BAT-420(몫 H)
- **파일:줄**: `services/ops-svc/src/modules/commands/application/create-command.ts` 25~28줄(`eventIdOf`)·48~53줄, `services/ops-svc/src/modules/commands/application/execute-command.ts`의 `SALE_RESUME` 확인
- **틀린 점**: 확정된 회차의 판매 재개를 막는 확인은 `eventId !== undefined`일 때만 돈다. `eventIdOf`는 `params.eventIds` 배열이면 첫 회차만 돌려준다. 그래서 `SALE_RESUME` 명령의 `params`에 회차 ID가 없거나 `eventIds: [보통 회차, 취소 확정 회차]`면 확인을 건너뛴다.
- **근거**: openapi는 `SALE_STOP`·`SALE_RESUME`의 params를 `{eventId, reasonCode, suspensionRef}`로 적었다. 실행기가 `eventIds`를 쓰지 않으면 실제 피해는 없지만, 확인이 '없으면 통과'로 짜여 있다.
- **고칠 쪽**: 구현(`SALE_RESUME`은 회차 ID가 없으면 거절, 배열이면 모두 확인).
- **확인 필요**: `SALE_RESUME` params 검사가 `eventId`를 필수로 보는지, 실행기가 `eventIds`를 읽는지.

### S4. ops-svc 멱등 기록 표를 지우는 일이 없다

- **심각도**: 낮음
- **ASVS**: v5.0.0-14.2.7(쓸모없어진 데이터를 정한 때 지운다)
- **묶음**: BAT-420(몫 Q·P)
- **파일:줄**: `services/ops-svc/migrations/0014_idempotency_record.sql`, `services/ops-svc/src/modules/event-cancellations/adapters/db/drizzle-store.ts` 112~121줄
- **틀린 점**: 새 `idempotency_record`에는 관리 계정·파트너 계정 ID(`account_ref`)와 요청 해시가 쌓인다. 읽을 때는 `IDEMPOTENCY_RETENTION_MS` 안의 행만 보지만, 지우는 정비 일(`platformMaintenanceTasks`의 `idempotency-records-delete`)이 ops-svc에는 조립되어 있지 않다(ops-svc 소스에 정비 실행기가 없다).
- **근거**: 다른 서비스는 같은 표를 플랫폼 정비 일로 지운다. 여기서는 행이 끝없이 남는다.
- **고칠 쪽**: 구현(ops-svc에 정비 실행기 또는 지우는 일을 조립) 또는 계획(다음 단계 몫으로 적기).
- **확인 필요**: docs/data.md가 ops 멱등 기록의 보존 기간을 따로 정했는지.

### S5. 파트너 상태 응답에 commander가 낸 요청의 반려 사유가 실린다

- **심각도**: 낮음
- **ASVS**: v5.0.0-8.2.2(데이터 항목 단위 권한), v5.0.0-15.3.1(필요한 칸만 돌려준다)
- **묶음**: BAT-420(몫 P, R-T36 ⑧)
- **파일:줄**: `services/ops-svc/src/modules/event-cancellations/application/event-cancellations.ts` 183줄(`store.list({ eventId, limit: 1 })`), 196줄, 202~204줄
- **틀린 점**: 파트너 상태는 그 회차의 가장 최근 요청을 경로와 관계없이 준다. commander가 판매 중지(예: 부정 거래 의심·법적 요청) 뒤 낸 요청이면 `reason`은 비우지만, commander가 판정 전에 쓴 `rejectionReason`과 `fault`·`judgementSummary`는 그대로 싣는다.
- **근거**: 코드 주석은 "판매 중지로 운영자가 직접 낸 요청의 사유는 내부 사유라 싣지 않는다"고 했다. 판정 전 반려 사유도 같은 commander의 내부 글이다.
- **고칠 쪽**: 계획(정본 R-T36 ⑧에 commander 요청의 어느 칸을 파트너에게 보일지 적음) 뒤 구현.
- **확인 필요**: openapi `getPartnerEventCancellation`이 commander 요청의 `rejectionReason`을 보이기로 정했는지.

### S6. 관제 회차 취소의 자유 글에 길이 상한이 없다

- **심각도**: 낮음
- **ASVS**: v5.0.0-2.2.1(입력의 길이·형식 검사)
- **묶음**: BAT-420(몫 Q·W)
- **파일:줄**: `services/ops-svc/src/modules/event-cancellations/inbound/event-cancellations.controller.ts` 10~13줄(`RequestBody`·`JudgeBody`·`RejectBody`·`PauseBody`의 `reason: z.string().min(1)`), `application/event-cancellations.ts` 234줄
- **틀린 점**: commander 요청 사유, 판정 사유, 반려 사유, 멈춤·재개 사유가 상한 없이 DB와 감사 체인(키를 건 해시 체인 감사 기록) 본문에 들어간다. 파트너 경로만 1~1,000자를 본다. 234줄의 `fanNoticeReason.length > 200`은 UTF-16 단위로 세어, 같은 파일 55줄 `lengthOf`(코드 포인트) 규칙과 다르다.
- **근거**: 본문 크기 한도가 앞단에 있더라도, 감사 체인에 남는 글의 상한은 기능 규칙으로 정해 두는 편이 안전하다.
- **고칠 쪽**: 계획(상한 값) 뒤 구현.
- **확인 필요**: gw-ops 본문 크기 한도 값.

### S7. 결제사 멱등키 검사가 계획대로 좁혀지지 않았다

- **심각도**: 낮음
- **ASVS**: v5.0.0-2.2.1(입력 검사)
- **묶음**: BAT-415(보충 2, GAT-080 P13)
- **파일:줄**: `services/payment-svc/src/modules/payment/domain/payment-gateway.ts` 258줄
- **틀린 점**: 계획 보충 2는 `CANCEL_IDEM_KEY`를 `{9,64}`로 바꾼다고 적었지만 `/^cancel-[A-Za-z0-9_-]{1,64}$/` 그대로다. 앞단 `CANCELLATION_ID`(`confirmed-cancel.ts` 9줄, `deposit-cancel.ts` 8줄)는 9~64자로 바뀌었다.
- **근거**: 지금 길로는 앞단이 막아 결제사 어댑터(`portone-gateway.ts` 335줄, `toss-shaped.ts` 237줄)에 16자보다 짧은 키가 가지 않는다. 다만 어댑터 쪽 마지막 검사가 정본(포트원 멱등키 16자 이상)과 어긋난 채 남아, 새 부르는 길이 생기면 막지 못한다.
- **고칠 쪽**: 구현.
- **확인 필요**: 없음.

### S8. '호출자 purchase-svc만'은 공유 토큰 하나로만 지켜지고, TicketService 다른 RPC는 토큰을 보지 않는다

- **심각도**: 낮음(구조 한계, 기록 권함)
- **ASVS**: v5.0.0-8.2.1(기능 접근 권한), v5.0.0-8.3.1(인가를 서비스 층에서 강제)
- **묶음**: BAT-415(몫 F·B6), BAT-420(리뷰 D4)
- **파일:줄**: `packages/platform/src/internal-grpc.ts` 49~50줄, `services/ticket-svc/src/modules/ticket/inbound/ticket.grpc.ts` 62~68줄(`purchaseOnly`), `services/ticket-svc/src/start.ts` 194줄
- **틀린 점**: 호출자 머리(`INTERNAL_GRPC_CALLER_HEADER`)는 부르는 쪽이 스스로 적는 값이다. 내부 토큰은 모든 서비스가 같은 값을 쓰므로, 토큰을 가진 어느 서비스든 `purchase-svc`라고 적으면 `EventCancelTickets`(결제자·보유자 검사를 건너뛰고 회차의 표를 끝냄)와 `OperatorCancelTickets`를 부를 수 있다. 또 ticket-svc 서버 가로채기(`internal.services`)에는 `ScannerDeviceService`만 있어, 같은 `TicketService`의 `CancelTickets`(BAT-415가 `replay_only`·`reason`·첫 취소 칸을 더함)·`IssueTickets`는 토큰 없이도 받는다(이번 diff 전부터 그랬다).
- **근거**: ASVS 메모(BAT-415·BAT-420 계획 메모)는 이 호출자 검사를 8.2.1·8.3.1의 근거로 적었다. 호출자 머리는 실수로 다른 서비스가 부르는 것을 막을 뿐, 토큰이 새면 막지 못한다.
- **고칠 쪽**: 계획(ASVS 메모에 '호출자 머리는 자기 신고, 서비스별 신원은 후속'이라는 한계를 적고, `TicketService`를 가로채기 목록에 넣을지 정함).
- **확인 필요**: `TicketService`를 토큰 없이 부르는 쪽(gw·BFF 등)이 있는지. 없으면 목록에 넣는 것만으로 닫힌다.

### S9. ASVS 표의 글과 시험 칸이 코드와 어긋난다

- **심각도**: 낮음
- **ASVS**: 해당 표 v5.0.0-8.2.1·8.2.2
- **묶음**: BAT-420
- **파일:줄**: `docs/security/asvs/transfer-refund.md` 121줄(8.2.1), 122줄(8.2.2), 메모 'BAT-425 GAT-130 잔여 메모'
- **틀린 점**: 8.2.1 행은 "`gw-partner`는 회차 취소 요청을 검사한다"고 적었지만 소속 대조는 ops-svc(`#ownedEvent`)가 한다(새 BAT-420 메모가 맞다). BAT-425 메모의 "재인증 토큰은 아직 강제하지 않는다(후속)"는 이번에 요청·확정 모두 강제하게 되어 낡았다. 8.2.1·8.2.2 행의 시험 칸은 '미실행'인데, 태그를 단 시험(GAT-080 F14·F22, R-T36 ③, GAT-110 Q4)이 이 가지 통합 통과 확인에서 돈다.
- **근거**: 보안 검토자는 이 표로 적용 위치를 찾는다. 위치가 틀리면 gw-partner만 보고 끝낸다.
- **고칠 쪽**: 기록 담당(행 글의 위치와 시험 칸), 계획(메모 낡은 문장).
- **확인 필요**: 시험 칸을 묶음마다 고치는지, 기능 전체가 끝난 뒤 한 번에 고치는지(계획은 '닿는 태그만 단다'고 적었다).

### S10. 확정 때 판매 멈춤이 승인자가 아닌 'system'으로 기록된다

- **심각도**: 낮음
- **ASVS**: v5.0.0-16.2.1(누가 했는지 남긴다)
- **묶음**: BAT-420(몫 H, ADR-0280 결정 1)
- **파일:줄**: `services/ops-svc/src/adapters/event-sale-stopper.ts` 10줄, 21~35줄
- **틀린 점**: 판매 멈춤은 운영 명령 기록 없이 실행기를 바로 부르고, 처리자를 `system:event-cancellation`으로 넘긴다. purchase-svc 판매 중지 기록에도 사람 대신 'system'이 남는다.
- **근거**: 감사 체인의 `EVENT_CANCELLATION_APPROVED`(확정자)와 명령 ID(= 요청 ID)로 이을 수는 있다. 다만 판매 멈춤 쪽 기록만 보면 누가 멈췄는지 알 수 없다.
- **고칠 쪽**: 구현(확정자 계정을 처리자로 넘김) 또는 계획(지금 꼴을 정본에 적음).
- **확인 필요**: 없음.

### S11. '판매 승인 전 회차는 404'가 core 내부 경로의 동작에 기대는데 시험은 대역만 본다

- **심각도**: 낮음
- **ASVS**: v5.0.0-8.2.2
- **묶음**: BAT-420(몫 P, R-T36 ③)
- **파일:줄**: `services/ops-svc/src/adapters/http-core-event-owners.ts`(`find`), `services/ops-svc/src/modules/event-cancellations/application/event-cancellations.ts` 381~387줄
- **틀린 점**: 소속 대조는 core `GET /internal/v1/events/{eventId}/sale-config`가 판매 승인 전 회차에 404를 준다는 가정 위에 있다. 통합 시험(R-T36 ③)은 core 대신 작은 HTTP 서버를 띄워 그 답을 흉내 낸다.
- **근거**: core가 승인 전 회차에도 판매 설정을 주면, 파트너가 승인 전 자기 회차에 회차 취소를 요청할 수 있다(소속은 맞으므로 다른 파트너 데이터가 새지는 않는다).
- **고칠 쪽**: 시험(core 내부 경로의 승인 전 404를 core 쪽 시험으로 묶음) 또는 계획.
- **확인 필요**: core 내부 판매 설정 경로가 승인 전 회차에 무엇을 주는지.

## 확인했고 문제없던 것

- 내부 토큰 비교는 `timingSafeEqual`(상수시간 비교)이고, 처리자 증명은 토큰을 키로 한 HMAC이다. `FraudCancellationService`는 서버 가로채기(토큰 없으면 UNAUTHENTICATED)와 처리기의 호출자 `ops-svc`·처리자 `approved_by` 증명을 둘 다 본다. `SetEventRefundHold`는 `EventRefundService` 가로채기 안에 있고 호출자 `ops-svc`를 본다.
- 릴레이(`relay-app.ts`)는 ticket-svc 주소가 있으면 운영에서 토큰이 없을 때 시작하지 않고, 입장 기록 대조는 ticket-svc 주소가 없으면 local·ci에서만 대역을 쓴다(`refund-wiring.ts`, fail-closed).
- 입력: ticket-svc 운영자 취소·회차 취소·입장 기록 대조와 purchase 미룸·부정 예매 취소는 소문자 UUID만 받고(대문자를 고쳐 받지 않음) 대상 수 상한(500·200·100)과 중복 금지를 둔다. ticket-svc 사유 목록은 purchase 일곱과 같다(0009 CHECK 포함). 결제 취소 ID는 9~64자다.
- 팬 쪽: 견적·취소 모두 결제자 확인 뒤에 회차 취소 확정 여부를 본다(남의 표로 회차 상태를 알 수 없음). 새 키 재취소가 잇는 첫 취소는 사유 `USER`인 기록뿐이다. 팬 취소 HTTP는 재인증 계약 전이라 여전히 403 `reauth-required`로 닫혀 있다.
- 관제: commander 요청은 재인증(동작 APPROVAL, 패스키, 세션·계정 대조, jti 1회용)을 판매 중지 확인보다 먼저 해, 판매 중지가 아닌 회차에 다른 사람의 요청 ID를 알려 주지 않는다. 확정은 판정자와 다른 사람이 재인증 뒤 하고, 상태 저장은 판 번호 조건부다. 멱등 기록은 계정 × 작업 × 키 범위이고 요청 해시를 상수시간으로 비교한다.
- 로그·CS 건: 새 로그는 취소 ID·요청 ID·회차 ID만 싣고 계정 ID·이메일·계좌를 싣지 않는다. CS 건 본문에는 금액·개인정보가 없다. 부정 예매 처리기 오류 로그는 `errorSummary`로 줄인다.
- 감사: 요청·판정·미리보기·확정·시작·반려·멈춤·재개·확정 실패가 감사 체인에 남는다. 부정 예매 취소는 `requested_by`·`approved_by`(서로 달라야 함, 0022 CHECK)와 승인 ID를 남긴다.
- 새 마이그레이션(payment 0021, purchase 0022~0024, ticket 0008·0009, ops 0013·0014)에는 GRANT가 없다. 이 서비스들은 원래 앱 역할 하나로 접속한다(역할을 나눈 것은 core-svc뿐). 이번 변경이 권한을 넓히지는 않았다.
