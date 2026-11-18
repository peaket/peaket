# ADR-0293: 팬 재인증 토큰에 받는 쪽 작업(`op`)을 싣고, 받는 서비스는 자기 작업의 토큰만 받는다(2026-11-18)

- **상태**: 채택(2026-11-18, 소유자 결정 OPEN[50] (나)). BAT-415-reauth 리뷰 RV-01(중간, 보안)이 찾은 틈을 막는 길로 소유자가 (나)를 골랐다. 이 ADR은 묶음 BAT-408(단계 GAT-045)의 계획 담당이 그 결정의 세부(작업 이름 목록, `purpose` 값, 받는 쪽 확인 규칙, 이음 기간, 시험)를 정한 것이다. [ADR-0050](0050-crypto-corrections-and-key-management.md) 결정 9(팬 토큰 키로 액세스·재인증 토큰을 함께 서명하고 `typ`으로 나눔)와 identity §3 '재인증 토큰의 묶음'(세션 `sid`·작업 묶음 `act`)은 그대로 두고, 그 위에 묶음 하나를 더한다.
- **관련**: [docs/features/identity.md](../features/identity.md) §3 '재인증 토큰의 묶음'·§7.1 '재인증 흐름과 토큰', [docs/security/authz-matrix.md](../security/authz-matrix.md) §6 '받는 쪽 작업 `op`의 값', [docs/features/transfer-refund.md](../features/transfer-refund.md) §3.1 '팬 취소의 재인증 확인', [docs/frontend.md](../frontend.md) §4.1 '재인증', `docs/api/proto/peaket/identity/v1/identity.proto` `IssueReauthTokenRequest`, 계획 [docs/review/plans/BAT-408.md](../review/plans/BAT-408.md)
- **관련 ID**: I-T85, R-T39 ⑧, POL-019, FR-017, FR-047

## 맥락

- **재인증 토큰**은 팬이 방금 소셜 제공자(카카오·네이버·구글)로 다시 로그인했다는 5분짜리 증명이다(identity §7.1). 토큰에는 그 세션(`sid`)과 거친 작업 묶음(`act`: 그 밖의 민감 작업 `FAN_SENSITIVE`, 양도·계좌 입력 `FAN_HIGH_RISK`)이 실려 있다. 받는 서비스는 서명·만료·세션·작업 묶음을 보고, 같은 토큰을 두 번 받지 않으려고 토큰 번호(`jti`)를 한 번만 적는다.
- **틈(RV-01)**: 한 번 적기는 받는 서비스마다 따로다. identity는 PostgreSQL `reauth_token_use`에, purchase-svc 팬 취소는 좌석 Redis에 적는다. 그래서 `FAN_SENSITIVE` 토큰 하나를 5분 안에 identity 작업(예: 다른 기기 로그아웃)에 한 번, 예매 취소에 한 번 쓸 수 있다. `FAN_HIGH_RISK`도 받는 서비스가 여럿이다(양도는 ticket-svc, 환급 계좌는 payment-svc, 계좌를 담은 예매 취소는 purchase-svc, 굿즈 주문 취소는 core-svc). 묶음을 둔 까닭('다른 작업에 쓰지 못하게', identity §3)과 어긋난다.
- **고른 길**: 소유자가 고른 (나)는 identity가 토큰에 '이 토큰을 받을 작업'을 하나 싣고, 웹이 재인증을 시작할 때 그 작업을 고르며, 받는 서비스는 자기 작업이 적힌 토큰만 받는 것이다. 토큰 하나가 한 받는 곳에서만 쓰이므로 서비스마다 따로인 한 번 적기로도 충분하다. 고르지 않은 길: (가) 팬 취소만의 `act`를 더하기(받는 서비스가 늘 때마다 같은 틈이 다시 생김), (다) 한 번 적기를 identity 한 곳에서 하기(취소·양도가 identity 동기 호출에 기대 identity 장애가 그 작업을 막음, identity §10의 무상태 확인과 어긋남).
- **지금 코드(2026-11-18, 가지 `feature/lane3-BAT-415` 머리 `4aaf2762`)**: 팬 재인증 토큰을 받는 곳은 identity 다섯(탈퇴 `withdraw-account`, 다른 기기 로그아웃 `end-device-session`, 로그인 수단 해제 `unlink-provider`·추가 `add-provider`, 계정 합치기 `confirm-merge`, 모두 `FAN_SENSITIVE`)과 purchase-svc 팬 취소(`jwks-fan-reauth-gate.ts`) 하나다. 웹에서 실제로 재인증을 시작하는 화면은 탈퇴·다른 기기 로그아웃·로그인 수단 화면 셋이고 모두 `purpose`를 비워 보낸다. 양도·돌려주기·기기 키·환급 계좌·배상 계좌·굿즈 취소의 받는 쪽과 취소 화면의 재인증은 아직 없다.

## 결정

1. **새 클레임 `op`(받는 쪽 작업)**: 팬 재인증 토큰(`typ` reauth+jwt, 팬 토큰 키)에 문자열 클레임 `op`를 꼭 싣는다. 값 하나는 그 토큰을 받을 API 작업 하나다. 다만 한 API가 본문에 따라 작업 묶음이 갈리면(예매 취소의 환급 계좌) 값을 둘로 나눈다. `act`는 지우지 않고 `op`에서 정해진 값을 그대로 싣는다(`op` 하나에 `act` 하나). 관리 계정 재인증 토큰(관리 토큰 키)에는 `op`를 싣지 않는다(결정 7).
2. **`op` 값 목록과 웹 `purpose` 값(정본은 authz-matrix §6 '받는 쪽 작업 `op`의 값')**:

   | `op` | `act` | 받는 서비스 | 받는 작업 | 웹 `purpose` | 2026-11-18 |
   | --- | --- | --- | --- | --- | --- |
   | `ACCOUNT_WITHDRAW` | `FAN_SENSITIVE` | identity-svc | `DELETE /v1/identity/account` | `account-withdraw` | 받는 쪽·화면 있음 |
   | `SESSION_END` | `FAN_SENSITIVE` | identity-svc | `DELETE /v1/identity/sessions/{sessionId}` | `session-end` | 받는 쪽·화면 있음 |
   | `SCANNER_SESSION_END` | `FAN_SENSITIVE` | identity-svc | `DELETE /v1/identity/scanner-sessions/{sessionId}` | `scanner-session-end` | 아직(GAT-230) |
   | `LOGIN_METHOD_ADD` | `FAN_SENSITIVE` | identity-svc | 웹 앱 서버 `POST /link/{provider}` 뒤 identity 제공자 잇기 | `login-method-add` | 받는 쪽·화면 있음 |
   | `LOGIN_METHOD_REMOVE` | `FAN_SENSITIVE` | identity-svc | `DELETE /v1/identity/providers/{provider}` | `login-method-remove` | 받는 쪽·화면 있음 |
   | `ACCOUNT_MERGE` | `FAN_SENSITIVE` | identity-svc | `POST /v1/identity/merge-proposals/{proposalId}/confirmation` | `account-merge` | 받는 쪽·화면 있음 |
   | `CONTACT_CHANGE` | `FAN_SENSITIVE` | identity-svc | `PATCH /v1/identity/profile`(휴대폰 번호를 바꿀 때) | `contact-change` | 아직 |
   | `TICKET_CANCEL` | `FAN_SENSITIVE` | purchase-svc | `POST /v1/tickets/{ticketId}/cancellation`(본문에 환급 계좌 없음) | `ticket-cancel` | 받는 쪽 있음, 화면은 GAT-090 |
   | `TICKET_CANCEL_REFUND_ACCOUNT` | `FAN_HIGH_RISK` | purchase-svc | 같은 API(본문에 `refundAccount` 있음) | `ticket-cancel-refund-account` | 받는 쪽 있음, 화면은 GAT-090 |
   | `DEVICE_KEY_ISSUE` | `FAN_SENSITIVE` | ticket-svc | `POST /v1/tickets/{ticketId}/device-keys`(재발급, 입장 시작 뒤 등록) | `device-key-issue` | 아직 |
   | `TICKET_RETURN` | `FAN_SENSITIVE` | ticket-svc | `POST /v1/tickets/{ticketId}/returns` | `ticket-return` | 아직 |
   | `TRANSFER_REQUEST` | `FAN_HIGH_RISK` | ticket-svc | `POST /v1/tickets/{ticketId}/transfers` | `transfer-request` | 아직 |
   | `REFUND_ACCOUNT` | `FAN_HIGH_RISK` | payment-svc | `POST /v1/cancellations/{cancellationId}/account` | `refund-account` | 아직 |
   | `COMPENSATION_ACCOUNT` | `FAN_HIGH_RISK` | payment-svc | `POST /v1/compensations/{compensationId}/account` | `compensation-account` | 아직 |
   | `SHOP_CANCEL_REFUND_ACCOUNT` | `FAN_HIGH_RISK` | core-svc | `POST /v1/shop/orders/{orderId}/cancellations`(본문에 환급 계좌 있음) | `shop-cancel-refund-account` | 아직 |

   - 표의 열다섯 값은 이 결정으로 모두 정한다. '아직'인 작업은 받는 쪽을 만드는 단계가 그 값으로 확인한다(값을 새로 짓지 않는다). 새 받는 작업이 생기면 이 표와 authz-matrix §6에 줄을 더한다.
   - `FAN_HIGH_RISK`는 지금처럼 양도 요청과 환급·배상 계좌 입력(계좌를 담은 취소 포함)뿐이다.
3. **웹 `purpose`로 고른다**: 화면은 `POST /reauth/{provider}`의 폼 칸 `purpose`에 위 표의 웹 값을 싣는다. 앱 서버는 표에 없는 값(빈 값, 옛 `high-risk`, 대문자 `op` 이름, 모르는 값)이면 400으로 답하고 제공자로 보내지 않으며 로그인 진행 쿠키도 만들지 않는다. 표에 있으면 그 작업을 로그인 진행 쿠키에 봉인하고, 콜백에서 identity `SessionService.IssueReauthToken`의 새 칸 `operation`(enum `ReauthOperation`, 값은 `REAUTH_OPERATION_<op>`)으로 넘긴다. 쿠키에 작업이 없으면(배포 전에 만든 쿠키) 재인증 실패(그 밖의 실패)로 돌려준다.
4. **identity가 싣는다**: `IssueReauthToken`은 `operation`이 비었거나(`REAUTH_OPERATION_UNSPECIFIED`) 모르는 값이면 `INVALID_ARGUMENT`로 토큰을 주지 않는다. 토큰의 `op`는 받은 작업, `act`는 표의 값이다. 본인확인 재통과 판정(identity §7.1 ③)의 '고위험'은 그 작업의 `act`가 `FAN_HIGH_RISK`일 때다. 옛 칸 `purpose`(번호 8)는 지우지 않고 '쓰지 않음'으로 두며 identity는 읽지 않는다(웹도 채우지 않는다).
5. **받는 서비스의 확인 규칙**:
   - 받는 서비스는 요청이 어느 작업인지로 `op`(와 `act`)를 정한다. 토큰에서 읽은 값을 기대값으로 쓰지 않는다.
   - 공용 확인기 `packages/platform` `TokenVerifier.verifyReauth`에 기대 `op`를 넘기고, 확인기는 `sid`·`act`와 함께 토큰의 `op`가 같은 문자열인지 본다. 없거나(옛 토큰), 문자열이 아니거나, 다르면 거절(`TokenRejected`, 까닭 `claims`)이고 받는 서비스는 403 `reauth-required`다.
   - 팬 키 셋(`keySet` fan)으로 부르면서 기대 `op`를 넘기지 않거나, 관리 키 셋으로 부르면서 넘기면 부르는 쪽 코드 결함이다. 확인기는 토큰 거절이 아닌 오류를 던지고(받는 쪽의 '뜻밖 오류', purchase-svc는 500), 토큰을 받지 않는다.
   - 한 번 쓰기(`jti`)는 지금처럼 받는 서비스 안에서 하고, `op`·`act`·`sid`·`sub` 확인을 모두 통과한 뒤에만 적는다. 저장소 키·표는 바꾸지 않는다(마이그레이션 없음).
   - purchase-svc 팬 취소는 본문에 환급 계좌가 없으면 `TICKET_CANCEL`·`FAN_SENSITIVE`, 있으면 `TICKET_CANCEL_REFUND_ACCOUNT`·`FAN_HIGH_RISK`만 받는다. identity 다섯 작업은 표의 자기 값만 받는다.
6. **이음 기간은 두지 않는다**: `op`가 없는 토큰을 받는 기간을 두지 않는다. 까닭: ① 이 시스템은 아직 운영 환경에 올라가지 않아 살아 있는 토큰이 없다. ② 토큰은 5분짜리라 이음이 있어도 짧고, 없을 때 생기는 일은 403 `reauth-required` 뒤 화면이 재인증을 다시 받는 것뿐이다(닫힌 쪽이라 돈·티켓 위험이 없다). ③ `op` 없는 토큰을 받는 분기는 그 자체가 이 결정을 비켜 가는 길이 된다. 앞으로 운영 중에 표에 값을 더할 때의 배포 차례는 identity(새 enum 값을 낼 수 있게) → 웹 앱 서버(그 값을 고름) → 받는 서비스(그 값을 확인)다. 이 묶음은 셋을 한 번에 합친다.
7. **범위 밖**: 관리 계정 재인증 토큰(`OPS_COMMAND`·`APPROVAL`·`PERMISSION_CHANGE`·`PAYOUT_ACCOUNT`·`BOOKER_EXPORT`·`AUTHORITY_DATA`·`ACCOUNT_SECURITY`)은 바꾸지 않는다. 2026-11-18 코드에서 관리 작업 묶음마다 받는 서비스가 하나다(예: `BOOKER_EXPORT`는 core-svc, `PAYOUT_ACCOUNT`는 payment-svc). 한 묶음을 두 서비스가 받게 되면 같은 꼴로 관리 토큰에도 `op`를 더한다(아래 '되돌릴 조건').

## 결과

- 토큰 하나가 한 받는 작업에서만 쓰인다. RV-01의 틈(같은 `FAN_SENSITIVE` 토큰을 identity와 팬 취소에 한 번씩)이 닫히고, transfer-refund §3.1 '남는 한계'의 그 문장은 GAT-045가 끝나면 지운다.
- 한 화면에서 두 작업을 이어 하려면 재인증을 두 번 받는다. 지금 화면에는 그런 흐름이 없다. 취소 화면에서 환급 계좌를 함께 넣는 흐름은 처음부터 `ticket-cancel-refund-account` 하나로 받는다(GAT-090이 화면을 이을 때, 계좌 화면의 따로 된 재인증 시트와 겹치지 않게).
- 웹이 `purpose`를 바꾸면 identity·웹 앱 서버·받는 서비스가 함께 바뀐다(proto `ReauthOperation`, 생성물 `packages/contracts`). 배포 전에 열어 둔 브라우저 탭은 옛 빈 `purpose`를 보내 400을 받고, 화면을 새로 열면 풀린다.
- 받는 쪽의 거절 까닭 이름표는 늘지 않는다(`op` 어긋남은 `claims`).

## 되돌릴 조건

- 관리 재인증 작업 묶음 하나를 두 서비스가 받게 되면(예: `APPROVAL`을 ops-svc 밖에서도 받음) 관리 토큰에도 `op`를 더하는 결정을 다시 연다.
- 한 사용자 동작이 두 받는 작업을 늘 함께 부르는 흐름이 생겨 재인증을 두 번 받는 것이 불편 신고로 이어지면(분기 10건 [가정]), 그 둘을 묶은 `op` 하나를 더하거나 (다) identity 한 곳 한 번 쓰기를 다시 본다.

## 확인

- I-T85 ①~⑤(identity·웹 앱 서버·공용 확인기·화면 흐름)와 R-T39 ⑧(purchase-svc 팬 취소)이 정본의 판정 기준대로 돈다.
- `python -I -X utf8 tools/doc-check/check_all.py`에 이 변경이 만든 오류가 없다.
