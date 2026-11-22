# ADR-0370: 지급대행 등록과 정산 계좌 변경은 payment-svc 한 길이 예금주 조회부터 세 곳 등록·수정까지 하고, 판매 승인 조건은 켜진 결제사에만 걸며, 포트원 지급은 수기 정산건과 30분 동기화로 잇는다(2026-11-23)

- **상태**: 채택(2026-11-23, 추천 적용, BUILD_ORDER F-07-7 계획). F-07-6 계획이 넘긴 G-03(판매 승인에서 셀러 등록 부르기·세 조건 다시 켜기)·G-16(이미 만든 예약지급 취소)과 BAT-630 리뷰 RV-06, LCH-120 단계 줄(포트원 지급대행, 정산 계좌 변경, SCR-020·027, BOT-122가 넘긴 재인증)을 닫는다.
- **관련**: [ADR-0047](0047-settlement-payout-via-pg-agency.md), [ADR-0053](0053-crypto-hardening-pseudonyms-webhooks-stores-runbook-audit.md) 결정 5, [ADR-0108](0108-portone-console-payout-reconciliation-and-account-rules.md), [ADR-0206](0206-admin-passkey-step-up.md), [ADR-0285](0285-mesh-port-allow-source-generated-policies.md) 결정 9, [ADR-0327](0327-sale-review-request-and-sale-open.md) 결정 9, [ADR-0341](0341-audit-chain-mac-worker-five-minute-anchor-verification-job.md) 결정 7, [ADR-0368](0368-settlement-statement-notify-dispute-adjust-flow.md), [ADR-0369](0369-toss-payout-agency-transport-seller-retry-balance-recon.md), docs/features/settlement.md §3·§5.3·§6·§8·§9·§13·§15, docs/features/identity.md §2 '위험 운영 명령 재인증', docs/data.md `payout_account`·`payout_account_change`·`portone_partner`·`settlement_case_request`, docs/planning/03-policies-glossary.md §2.12 T9·T10, docs/design/d5-screen-blueprint.md §6.1·§6.10
- **관련 ID**: FR-052, FR-062, POL-014, POL-020, POL-039, I-T53, J-T8, J-T9, J-T14, J-T17, S-T41, J-T39, J-T40, J-T41, J-T42

## 맥락

- 정산 계좌 변경(`PUT /v1/partner/payout-account`)은 R-588 때 만든 첫 모양이 있다. 재인증 토큰의 패스키 요소와 한 번 쓰기(jti), If-Match, 3영업일 보류는 맞다. 그런데 예금주를 결제사에 조회하지 않고 파트너가 적은 이름을 믿으며, 이름이 달라도 계좌를 저장하고(`holderVerified=false`), 두 결제사에 수정 요청을 보내지 않고, 변경을 감사 기록에 남기지 않는다. settlement §3·§6은 예금주 조회가 다르면 받지 않고 계좌를 남기지 않는다고 적는다.
- 예금주 이름 비교 함수는 '(주)'·'㈜'·'주식회사'·공백·몇 영문 표기만 지운다. settlement §3의 규칙(NFKC, 설정 파일 하나에 둔 법인 표기 목록, 문장부호, 영문 대소문자)과 다르다.
- 판매 승인(SCR-048)은 지급대행 어댑터가 없던 때의 예외(ADR-0327 결정 9)로 세 조건(예금주 일치, 포트원 파트너 등록, 토스 셀러 PARTIALLY_APPROVED 이상)을 보지 않는다. F-07-6이 토스 셀러 등록 경로를 만들었지만 부르는 곳이 없다. payment-svc의 PEAKET 판매자 확인(`seller_kyc`)도 쓰는 길이 없어, 실제 흐름에서는 모든 정산서가 KYC 보류가 된다.
- 포트원 결제분 지급은 operator가 일괄 지급 ID를 적는 기록만 있다. 수기 정산건 만들기, 지급일 09시 실행 건, 지급 내역 동기화가 없어 포트원 정산서는 `SCHEDULED`에서 끝나지 않는다.
- 이미 결제사에 접수된 토스 예약지급(REQUESTED)을 취소하는 곳이 없다. 그래서 `seller.changed`가 KYC_REQUIRED를 알려도, 정산 계좌를 막 바꿨어도 예약지급이 그대로 나간다(BAT-630 RV-06).
- 포트원 플랫폼 API(예금주 조회·파트너·정산건·지급 내역)는 결제 API와 같은 시크릿으로 부르지만, 파트너 정산 서비스는 계약 뒤에 상점에 켜진다. 저장소의 포트원 시험 시크릿은 결제 채널용이다. 토스 지급대행 보안 키도 계약 뒤에 나온다(ADR-0369). 그래서 두 결제사 모두 지금은 실제로 부를 수 없다.
- 파트너 콘솔의 SCR-020 정산 계좌·내 계정 패스키 줄과 SCR-027 정산서 탭은 퍼블리싱 목업이다. 지금 계좌를 읽는 API도 없다(PUT만 있고 If-Match에 쓸 판을 줄 곳이 없다).
- settlement §6의 정산 계좌 변경 1단계는 "TOTP로 다시 인증"이라고 적었지만, identity '위험 운영 명령 재인증'과 openapi `putPartnerPayoutAccount`는 비밀번호·TOTP 뒤 패스키까지 요구한다(I-T53 ②③). 정본끼리 어긋났다.

## 결정

1. **지급대행 등록·수정은 payment-svc의 한 길이다.** `PayoutAgencies.sync({ promoterId, seller, account, mode })`가 차례대로 ① 포트원 예금주 조회(`GET /platform/bank-accounts/{bank}/{accountNumber}/holder`) ② 예금주와 판매자 상호·대표자 비교(결정 2) ③ 포트원 파트너 등록(`POST /platform/partners`, 없을 때) 또는 수정(`PATCH /platform/partners/{id}`) ④ 토스 두 상점 셀러 등록(ADR-0369 결정 3, 없을 때) 또는 수정(`POST /v2/sellers/{id}`)을 한다. 쓰는 곳은 판매 승인 요청(core-svc가 내부 `POST /internal/v1/settlements/payout-registrations`로 부른다)과 정산 계좌 변경(SCR-020) 둘이다. 계좌번호 원문은 이 함수의 메모리 밖으로 나가지 않는다(DB·로그·트레이스·응답·예외 메시지·감사에 없음, 예금주 조회 트레이스는 경로 템플릿만, ADR-0053 결정 5). 예금주가 다르면 아무 결제사도 부르지 않고 422 `payout-account-holder-mismatch`다. 조회 실패는 503 `payout-holder-lookup-unavailable`이다. ③④에서 한 곳이 실패하면 성공한 곳의 결과는 남기고 502 `payout-agency-update-failed`(실패한 곳 `failedAgencies`)이며, 다시 부르면 실패한 곳만 나간다.
2. **예금주 이름 비교는 settlement §3의 네 단계다.** NFKC → 법인 표기 지우기(목록은 `services/payment-svc/src/modules/settlement/domain/holder-name-rules.json` 하나) → 공백·문장부호(괄호·점·쉼표·하이픈·가운뎃점) 지우기 → 영문 소문자. 음역은 하지 않는다. 같은 함수를 판매 승인 요청·정산 계좌 변경·(뒤 기능의) 출금 대사·계좌 대조가 쓴다.
3. **결제사마다 켜진 것만 부른다.** 포트원 플랫폼 API는 결제 시크릿에 더해 `PEAKET_PAYOUT_PORTONE_ENABLED=true` [가정 이름]일 때만 켠다(파트너 정산 계약이 있다는 표시, 기본 계약 ID `PEAKET_PAYOUT_PORTONE_CONTRACT_ID` [가정 이름]이 같이 있어야 하고 반만 있으면 시작하지 않는다). 토스 지급대행은 ADR-0369 결정 2의 설정이다. 꺼진 결제사는 건너뛰고 등록 결과에 '연동 전'으로 남긴다. 다만 그 결제사에 등록 행(`portone_partner`·`toss_seller`)이 이미 있는데 지금 꺼져 있으면 건너뛰지 않고 503이다(옛 계좌로 지급되는 것을 막는다). 예금주 조회는 포트원만 하므로, 포트원 플랫폼이 꺼져 있으면 정산 계좌 변경은 503 `payout-holder-lookup-unavailable`이고 판매 승인 요청은 ADR-0327 결정 9의 '모양만 본다' 예외를 그대로 쓴다.
4. **판매 승인 조건은 켜진 결제사에만 다시 건다.** core-svc는 승인 전에 payment 내부 `GET /internal/v1/settlements/promoters/{promoterId}/payout-registration`을 읽어, 포트원 플랫폼이 켜져 있으면 예금주 일치와 포트원 파트너 등록을, 토스 지급대행이 켜져 있으면 일반 상점(`STANDARD`) 셀러 `PARTIALLY_APPROVED`·`APPROVED`를 본다. 하나라도 모자라면 409 `sale-review-payout-registration-incomplete`이고 승인 상태를 바꾸지 않는다. 같은 읽기로 SCR-048 확인 항목 5와 SCR-065 결제사 등록 탭의 `payoutAccount`·`pgRegistration`을 채운다(가짜 상태 없음, 꺼진 결제사는 지금처럼 '연동 전'). 승인이 성공하면 같은 요청 안에서 payment 내부 `PUT /internal/v1/settlements/promoters/{promoterId}/seller-verification`(상호·대표자·확인 시각, `VERIFIED`)을 부른다. payment가 답하지 않으면 승인은 503이고 바뀌지 않는다(fail-closed). core의 payment 주소(`PEAKET_PAYMENT_HTTP_URL`)가 없는 조립은 운영 환경이면 시작하지 않고, local·ci·시험 조립은 지금의 '연동 전' 동작이다. 에스크로 셀러가 택배 상품 공개의 조건이 되는 일(§3)은 이 결정의 범위 밖이다.
5. **정산 계좌 변경의 차례.** 재인증(ADR-0206, `act=PAYOUT_ACCOUNT`, `factors`에 passkey, jti 한 번 쓰기) → If-Match → 본문(`bankCode` 은행 코드 목록·`accountNumber` 숫자 6~20자·`holderName` 1~100자, 모르는 칸 400) → PEAKET 판매자 확인(`seller_kyc` 상호·대표자)이 없으면 409 `payout-seller-unverified` → 결정 1(`mode=CHANGE`) → 은행·끝 4자리·`hold_until` = 지금 + 3은행영업일 저장 → 보류 기간 안에 지급일이 오는 토스 예약지급 취소(결정 6)와 포트원 정산서의 실행 제외(결정 7) → 변경 기록 `payout_account_change` 한 행. 불일치 거부와 결제사 실패도 기록 행을 남긴다(결과 `HOLDER_MISMATCH`·`AGENCY_FAILED`, 계좌는 끝 4자리만). 기록은 정산 일꾼이 ops-svc 감사 받기(`POST /internal/v1/ops/audit-records`, 종류 `PAYOUT_ACCOUNT_CHANGED`, ADR-0341 결정 7)로 보내고 보낸 시각을 채운다(보내지 못하면 30분마다 다시). 부분 실패(502)면 새 은행·끝 4자리와 보류를 저장하고 `agency_sync_pending=true`로 둔다. 이 표시가 있으면 보류가 끝나도 지급 묶음에서 `HELD`·`ACCOUNT_CHANGE`이고, 다음 성공한 변경이 지운다. 변경 알림(등록 이메일·전화)은 파트너 이메일·문자 발송이 없어 운영 전이다(GAT-270 '운영 전'의 파트너 이메일과 같다). 지금 계좌는 새 `GET /v1/partner/payout-account`(은행·끝 4자리·예금주 확인·보류 끝·판 `ETag`·`agencySyncPending`)로 읽는다.
6. **이미 만든 토스 예약지급은 REQUESTED일 때만 취소한다.** 이유 둘: 그 상점 셀러의 단건 조회가 `KYC_REQUIRED`일 때(ADR-0369 결정 4·9), 정산 계좌를 바꿔 보류 기간 안에 지급일이 올 때. `POST /v2/payouts/{id}/cancel`이 성공하면 지급 건 `CANCELED`, 정산서 T10(`SCHEDULED` → `HELD`, 사유 `KYC`·`ACCOUNT_CHANGE`), `PAYOUT_HELD` 사건을 한 트랜잭션에 쓴다. 정산서의 조각 하나라도 이미 `IN_PROGRESS`·`COMPLETED`면 취소하지 않고 결과를 기다린다(settlement §12 'KYC 필요가 지급 요청 뒤'). 취소가 실패하면(결제사가 이미 진행 중이라고 답함 등) 지급 건을 바꾸지 않고 다음 단건 조회 결과를 따른다.
7. **포트원 결제분 지급은 수기 정산건 → 09시 실행 건 → 30분 동기화다.** 승인된 포트원 묶음의 실행(`executeBatch`)이 정산서마다 수기 정산건(`POST /platform/transfers/manual`, 아이디 = 정산서 ID, 금액 = 지급액, 정산일 = 지급일)을 만들고(같은 아이디가 이미 있으면 조회로 확인만), 지급 건 한 행·정산서 T9·`PAYOUT_SCHEDULED`를 한 트랜잭션에 쓴다. 지급일 09:00 KST에 정산 일꾼이 그 묶음의 정산서를 다시 보고 계좌 변경 보류·`agency_sync_pending`·판매 중지인 것을 실행에서 빼고(T10 `HELD`, 수기 정산건 취소 [가정 경로]) CS 처리함 `PORTONE_PAYOUT_EXECUTION` 건(대상 = 묶음 ID, 사건 키 `portone-execution:{묶음 ID}`, 뺀 정산서 목록)을 `settlement_case_request`로 연다. operator가 일괄 지급 ID를 적은 뒤(지금 경로) 30분마다 지급 내역(`GET /platform/payouts`, 일괄 지급 ID와 수기 정산건 아이디로 이음 [가정])을 읽어 `SUCCEEDED`는 ADR-0369 결정 6의 `applyPayoutFact(COMPLETED)`로, `FAILED`·`STOPPED`·`CANCELLED`는 `FAILED`와 실패 갈래(코드 표는 계약 뒤, 모르면 '모름')로 반영한다. 포트원 재지급은 콘솔 실행이라 자동 재요청이 없고 CS `PAYOUT_FAILED` 건이다.
8. **포트원 사후 대사는 이 결정의 범위 밖이다.** 출금 대사(J-T20), 파트너 계좌 대조와 `ACCOUNT_MISMATCH` 보류(J-T21), 원장 잔액 대조와 대사 멈춤(J-T22), 지표 넷(`settlement_portone_withdrawal_unmatched_total`·`_partner_account_mismatch`·`_balance_diff_krw`·`_ledger_sync_age_seconds`)과 15시 실행 기록 없음 경보는 ADR-0108의 주 통제이지만, 2.75일 안에 위 결정과 함께 넣을 수 없어 다음 기능으로 둔다(감독이 기능 행을 정한다, F-07-7 계획 Q-02). 그 사이 포트원 실제 지급은 계약·키가 없어 일어나지 않는다(결정 3).
9. **화면은 실제 API만 쓰고 목업은 `?state=` 미리보기에만 남긴다.** SCR-020 '정산 계좌'는 `GET`·`PUT /v1/partner/payout-account`와 재인증 두 단계(`POST /v1/partner/auth/reauthentications`, 비밀번호·TOTP → 패스키 `navigator.credentials.get`)를 쓴다. '내 계정'은 프로필(`GET /v1/partner/auth/sessions/me`)과 패스키 줄(`GET`·`POST /v1/partner/auth/passkeys`, `POST /v1/partner/auth/passkey-registrations`, `DELETE /v1/partner/auth/passkeys/{passkeyId}`, `act=ACCOUNT_SECURITY`)을 잇는다. API가 없는 줄(인증 앱 다시 등록·복구 코드·로그인 기기)은 실제 화면에서 그리지 않는다. SCR-027 '정산서' 탭은 `GET /v1/partner/events/{eventId}/settlements`·`POST /v1/partner/settlements/{statementId}/disputes`를 쓰고, 보류 사유·지급일 연기·KYC 예고(정산서 칸 `kycNotice`)를 보인다. 배상 줄과 상계 내역은 F-07-8 몫이다.
10. **계약 변경은 구현 커밋이 openapi를 고치고 생성기를 함께 돌린다.** 새 `getPartnerPayoutAccount`, `putPartnerPayoutAccount`의 409·422·502·503 문제 종류와 200 `holderVerified`(늘 true, 불일치는 저장하지 않음)·`agencySyncPending`, `SettlementStatement.kycNotice`(파트너 응답만), `OpsSaleReviewDetail`·`OpsPromoterDetail`의 `payoutAccount.holderVerified`·`pgRegistration.tossEnabled`·`portoneEnabled`와 `tossSellers[].status`의 `PENDING`·`REJECTED`, 판매 승인 요청·승인의 새 응답, 문제 목록의 새 종류 다섯(`payout-account-holder-mismatch` 422, `payout-seller-unverified` 409, `payout-holder-lookup-unavailable` 503, `payout-agency-update-failed` 502, `sale-review-payout-registration-incomplete` 409). 세부는 F-07-7 계획 I-02다. 내부 경로 셋은 openapi에 넣지 않는다(다른 내부 경로와 같다). core-svc → payment-svc 내부 HTTP 한 쌍을 ADR-0285 결정 9 표와 메시 정책에 더한다.

## 검토한 대안

| 대안 | 판단 |
| --- | --- |
| 예금주 불일치도 계좌를 저장하고 `holderVerified=false`로 지급만 막는다(지금 모양) | 기각. settlement §3·§6은 받지 않고 남기지 않는다고 적는다. 남기면 끝 4자리라도 남의 명의 계좌가 화면에 보이고, 결제사에는 수정 요청을 보내지 않는 어정쩡한 상태가 생긴다 |
| 결제사 하나라도 실패하면 아무것도 저장하지 않는다 | 기각. 이미 성공한 결제사에는 새 계좌가 들어갔다. PEAKET 기록만 옛 값이면 출금 대사·계좌 대조가 오탐하고, 보류도 걸리지 않는다. 새 값과 보류·동기화 대기 표시를 저장하는 쪽이 안전하다 |
| 판매 승인 조건을 결제사 설정과 상관없이 다시 켠다 | 기각. 계약·키가 없는 지금은 어떤 파트너도 승인할 수 없게 되고 로컬 데모가 멈춘다. 꺼진 결제사의 결제분은 지급 묶음에서 보류되므로(ADR-0369 결정 4) 돈이 잘못 나가지 않는다 |
| core-svc가 예금주 조회·결제사 등록을 직접 한다 | 기각. 결제사 키와 지급 어댑터는 payment-svc 서비스 계정만 읽는다(ADR-0050, settlement §8). core는 계좌를 메모리로 넘기기만 한다 |
| 포트원 사후 대사까지 이번에 한다 | 이번에는 하지 않는다. 2.75일 안에 들지 않고(F-07-7 계획 §3 일수), 대사는 실제 포트원 지급이 시작되기 전에만 있으면 된다. 감독에게 새 기능 행을 묻는다 |
| 변경 알림을 가짜 발송기로 '보냄'이라고 남긴다 | 기각. 보내지 않은 알림을 보낸 것처럼 남기는 것은 가짜 상태다. 파트너 이메일 발송이 생길 때 잇는다 |

## 결과와 트레이드오프

- **좋은 점**: 판매 승인과 계좌 변경이 같은 규칙으로 세 곳을 맞추고, 남의 명의 계좌는 어디에도 남지 않는다. 계약·키가 들어오면 설정만으로 판매 승인 조건이 켜진다. 계좌를 바꾸거나 KYC가 필요해지면 이미 접수된 예약지급이 나가지 않는다. 포트원 정산서가 `PAID`·`FAILED`까지 간다. 파트너가 실제 화면에서 계좌와 패스키를 다룬다.
- **남는 한계**: 포트원 사후 대사(결정 8), 변경 알림(운영 전), 에스크로 셀러 조건의 상품 공개, 판매 중지 뒤 예약지급 취소(지금은 실행 직전 409)와 회차 취소 다시 계산의 예약 취소(J-T23, F-07-8)가 남는다. 포트원 플랫폼 응답 모양·지급 내역과 수기 정산건을 잇는 칸·수기 정산건 취소 경로는 공개 명세를 읽은 [가정]이다.
- **배포**: payment 0029(`payout_account_change`, `portone_partner`, `payout_account.agency_sync_pending`, `settlement_case_request.kind`에 `PORTONE_PAYOUT_EXECUTION`). core-svc의 payment 주소와 메시 허용 한 쌍. 새 설정 이름 둘은 비어 있고(계약 전), 로컬 데모는 pg-simulator의 포트원 플랫폼 흉내로 켤 수 있다.

## 되돌릴 조건

- 포트원 공개 명세나 계약에서 예금주 조회·파트너·수기 정산건·지급 내역의 모양이 이 결정의 [가정]과 다르면 어댑터와 이 ADR을 고친다.
- 포트원이 지급 생성 API를 주면 결정 7을 그 API로 바꾼다(ADR-0047 되돌릴 조건과 같다).
- 파트너 이메일·문자 발송이 생기면 결정 5의 알림을 그 발송으로 잇는다.

## 확인

- I-T53·J-T8·J-T9·J-T14·J-T17·S-T41 ①·J-T39·J-T40·J-T41·J-T42가 이 결정을 본다. `trace-check --ids "…"`와 `ledger --batch F-07-7 --require`로 확인한다.
