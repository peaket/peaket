# ADR-0369: 토스페이먼츠 지급대행은 상점별 셀러와 JWE 전송 어댑터로 잇고, 지급 결과는 단건 조회로 정산서 전이·지급 사건에 반영하며, 실패 세 갈래 재요청과 결제사 잔액 대사는 정산 일꾼이 한다(2026-11-23)

- **상태**: 채택(2026-11-23, 추천 적용, BUILD_ORDER F-07-6 계획). BAT-630 리뷰 RV-04(셀러 등록 JWE·실지급 HTTP 없음)·RV-05(정산 웹훅 수신기 미조립)와 F-07-5 계획이 넘긴 G-16(KYC 보류가 결제사를 가리지 않음)과 G-17의 지급 사건·지표·09시 지급 묶음 자동 만들기를 닫는다(09시 자동 만들기는 감독 결정 2026-11-23, 15시 미승인 만료는 F-06-3).
- **관련**: [ADR-0047](0047-settlement-payout-via-pg-agency.md), [ADR-0050](0050-crypto-corrections-and-key-management.md), [ADR-0053](0053-crypto-hardening-pseudonyms-webhooks-stores-runbook-audit.md), [ADR-0062](0062-open-items-delegated-decisions.md), [ADR-0327](0327-sale-review-request-and-sale-open.md) 결정 9, [ADR-0368](0368-settlement-statement-notify-dispute-adjust-flow.md), docs/features/settlement.md §3·§5.1·§5.2·§5.5·§6·§8·§11·§12·§13, docs/planning/03-policies-glossary.md §2.12, docs/data.md `toss_seller`·`payout`·`payout_batch`·`payout_retry_audit`·`settlement_case_request`·`pg_balance_reconciliation`, docs/api/guidelines.md §8·§8.1, docs/security/secrets-and-keys.md
- **관련 ID**: FR-062, J-T4, J-T5, J-T6, J-T7, J-T15, J-T16, J-T25, J-T34, J-T37, J-T38

## 맥락

- BAT-630(R-769)은 토스페이먼츠 지급을 10억 원 미만 조각으로 나누고 요청당 20건으로 묶는 규칙, 멱등키, 실패 코드 분류, 웹훅 서명 확인을 포트(바깥 시스템과 잇는 자리를 인터페이스로 둔 것)와 대역(진짜 대신 쓰는 시험용 가짜)으로 만들었다. 실제로 결제사에 보내는 전송 어댑터, 셀러(지급을 받는 파트너를 결제사에 등록한 것) 등록, 지급 결과를 정산서에 반영하는 길은 없었다.
- 설정 모양이 정본과 달랐다. settlement §8은 JWE(본문을 암호화해 감싸는 표준 형식)를 보안 키 하나로 `alg=dir`·`enc=A256GCM` 대칭 암호화한다고 적는데, 코드 설정은 공개 키 PEM과 키 ID를 받았다.
- 웹훅 서명 원문이 정본과 달랐다. 정본은 `{본문}:{전송 시각}`의 HMAC-SHA256(비밀 키로 만든 위조 확인 값)인데 코드는 본문만 서명했고, 5분 넘게 늦은 웹훅은 정본(단건 조회는 한다)과 달리 버렸다. `seller.changed`는 본문의 상태를 그대로 믿었다(정본은 셀러 단건 조회로만 바꾼다).
- 실행은 결제사가 준 지급 ID를 저장하지 않아, 웹훅이 와도 지급 건을 찾을 수 없었다. 지급 건 상태가 바뀌어도 정산서는 `PAID`·`FAILED`가 되지 않았고 지급 사건(`PAYOUT_*`)도 없었다.
- `seller.changed`가 PEAKET의 판매자 확인 상태(`seller_kyc.status`)를 덮어써, 토스 셀러가 `KYC_REQUIRED`가 되면 포트원 결제분 정산서까지 보류됐다(settlement §6은 토스 결제분만 보류한다).
- 토스 셀러는 일반 상점과 에스크로 상점에 따로 등록하고(settlement §3), 셀러·잔액·KYC가 상점마다 따로라고 추정한다(§14). 그런데 셀러 칸은 파트너마다 하나였다.
- 지급 실패 세 갈래의 자동 재요청, 응답 없음의 같은 키 재전송, 결제사 잔액 대사(§5.5)는 규칙만 있고 코드가 없었다.
- 토스페이먼츠 지급대행은 계약 뒤에 발급되는 보안 키가 있어야 부를 수 있다. 저장소의 토스 시험 키는 결제용이고 지급대행 키 넷은 비어 있다(소유자 결정 2026-11-17: 지급대행·KYC는 공식 문서 규격을 따른 모의 서버로 증명한다). 그래서 실제 결제사 호출은 이 결정의 범위 밖이다.

## 결정

1. **전송은 JWE를 쓰는 HTTP 어댑터 하나다.** `HttpTossPayoutTransport`가 `https://api.tosspayments.com`(외부 허용 목록과 같은 곳)을 플랫폼 외부 HTTP 클라이언트로 부른다. 인증은 그 결제 상점의 시크릿 키 Basic 인증이다. 지급 요청·취소·셀러 등록·수정의 요청 본문과 응답 본문은 JWE compact 형식이고 `Content-Type: text/plain`이다. 보호 머리는 `alg=dir`, `enc=A256GCM`, 사용자 머리 `iat`(만든 시각, ISO 8601)와 `nonce`(예측할 수 없는 난수 생성기 CSPRNG로 만든 16바이트 [가정])다. 키는 보안 키(64자 hex)를 32바이트로 푼 값이다. 받은 JWE의 `alg`·`enc`가 다르거나 복호가 실패하면 그 응답을 쓰지 않고 '응답을 받지 못함'과 같이 다룬다(결정 7, 같은 키로 다시 보냄). 라이브러리는 검증된 JOSE 구현 `jose` 6.2.14(platform·identity-svc·ticket-svc와 같은 판)를 payment-svc 의존에 더한다. 시간 한도는 지급 요청·취소 10초, 단건 조회·셀러·잔액 5초, 정산(수수료) 조회 60초 [가정]다(결제사 안내상 정산 조회는 60초까지 걸린다).
2. **설정은 결제 상점마다다.** `PEAKET_PG_TOSS_PAYOUT_SECRET_KEY_STANDARD`·`…_ESCROW`(시크릿 키)와 `PEAKET_PG_TOSS_PAYOUT_SECURITY_KEYS_STANDARD`·`…_ESCROW`(보안 키, 쉼표로 이음, 첫째가 지금 키이고 둘째부터 교체 중의 옛 키, 각 64자 hex)다. 옛 이름 넷(`PEAKET_PG_TOSS_PAYOUT_API_KEY`·`_JWE_KEY_ID`·`_JWE_PUBLIC_KEY`·`_WEBHOOK_SECRETS`)은 정본과 다른 모양이라 없앤다. 한 상점의 값이 반만 있거나 키 모양이 틀리면 시작하지 않는다. 두 상점 모두 없으면 지금처럼 지급 실행은 503 `payout-gateway-unavailable`, 잔액 확인은 생략, 셀러 등록은 503 `payout-gateway-unavailable`이다. 계약 조건 가운데 지급대행 이용료는 설정 `PEAKET_TOSS_PAYOUT_FEE_MONTHLY_KRW`(기본 300,000)·`…_FEE_FREE_COUNT`(1,000)·`…_FEE_PER_ITEM_KRW`(100)로 둔다(공개 안내 값 [가정], settlement §14). PEAKET 몫 인출은 받는 방식이 정해지기 전까지 0이라 설정을 두지 않고, KYC 기간(약 5영업일 추정)은 계산에 쓰는 곳이 없어 settlement §6 문장으로만 둔다.
3. **셀러는 파트너·결제 상점마다 한 행이다.** 새 표 `toss_seller`(파트너 ID, 결제 상점, 토스 셀러 ID, 참조 ID, 상태, 사업자 유형, 등록·확인 시각)를 payment 0028이 만들고, `seller_kyc`의 토스 칸(0026) 값은 일반 상점 행으로 옮긴 뒤 더 쓰지 않는다(칸 지우기는 다음 마이그레이션). 셀러 등록은 payment-svc 내부 `POST /internal/v1/settlements/toss-sellers`이고, 두 상점 모두에 `POST /v2/sellers`를 보낸다. 참조 ID는 `{파트너 ID}-{STANDARD|ESCROW}` [가정]이다. 계좌번호는 요청에 바로 넘기고 DB·로그·응답에 남기지 않는다(응답은 은행·끝 4자리와 상점별 셀러 상태). 이미 등록된 상점은 다시 등록하지 않고 단건 조회로 상태만 고친다. 한 상점만 실패하면 성공한 행은 남기고 실패를 그대로 돌려주며, 다시 부르면 실패한 상점만 보낸다. 셀러 상태는 단건 조회(`GET /v2/sellers/{id}`) 결과로만 바꾼다. core-svc 판매 승인 요청에서 이 경로를 부르는 일과 판매 승인의 세 조건(settlement §3)을 다시 켜는 일은 예금주 조회·포트원 파트너 등록과 함께 LCH-120(F-07-7)이 한다. §3의 순서가 예금주 조회(포트원)를 먼저 요구하기 때문이다.
4. **KYC 보류는 결제사와 상점을 가린다.** 지급 묶음을 만들 때 토스 정산서는 PEAKET 판매자 확인(`seller_kyc` VERIFIED·사업자·대표자 확인)에 더해 그 정산서 상점의 토스 셀러가 `PARTIALLY_APPROVED`·`APPROVED`여야 묶이고, 아니면(셀러가 없을 때 포함) `HELD`·`KYC`다. 포트원 정산서는 토스 셀러 상태를 보지 않는다. `seller.changed`는 `seller_kyc`를 바꾸지 않는다. KYC 예고(J-T19)는 그 묶음 상점의 셀러 상태로 본다.
5. **웹훅 서명은 `{본문}:{전송 시각}`이다.** 머리 `tosspayments-webhook-signature`의 `v1:` 값(쉼표나 공백으로 나뉜 최대 4개 [가정])을 두 상점의 지금·옛 보안 키로 만든 HMAC-SHA256과 상수 시간으로 비교해 하나라도 맞으면 받는다. 틀리면 400과 보안 로그 `settlement_webhook_signature_invalid`·지표다. 전송 시각이 지금과 5분 넘게 다르면 본문의 상태는 쓰지 않고 보안 로그 `settlement_webhook_late`를 남긴 뒤, 본문에서 지급 ID·셀러 ID만 꺼내 단건 조회로 확정한다. 같은 전송 ID는 반영을 마친 뒤 기록하고, 기록된 것은 다시 처리하지 않는다. 수신기는 `start.ts`가 늘 조립한다. 설정이 없으면 정산 사건(`payout.changed`·`seller.changed`)을 400으로 돌려주고 결제 웹훅 경로로 넘기지 않는다.
6. **지급 결과는 한 함수로 반영한다.** 실행 응답, 웹훅 뒤 단건 조회, 재요청이 모두 `applyPayoutFact`를 부른다. 지급 건 상태는 끝나지 않은 상태(`REQUESTED`·`IN_PROGRESS`)에서만 바뀐다(조건부 갱신). 정산서 전이는 ADR-0368 결정 2의 조건부 전이를 쓰고, 지급 건·정산서·감사·사건을 한 트랜잭션에 쓴다.
   - 실행이 접수되면 지급 건에 결제사 지급 ID를 저장하고, 그 정산서의 모든 조각이 접수되면 T9(docs/planning/03 §2.12 전이 번호) `CONFIRMED → SCHEDULED`와 `PAYOUT_SCHEDULED`(금액 = 정산서 지급액)를 쓴다.
   - 지급 건이 모두 `COMPLETED`이면(재요청으로 대신한 옛 순번은 빼고) T11 `SCHEDULED → PAID`와 `PAYOUT_COMPLETED`다. 하나라도 `FAILED`이면 T12 `SCHEDULED → FAILED`와 `PAYOUT_FAILED`(금액 = 실패한 지급 건)다. 묶음은 모든 정산서가 `PAID`면 `COMPLETED`, 실패가 남아 있으면 `PARTIAL_FAILED`다.
   - 지급 묶음 때의 보류(T7)는 `PAYOUT_HELD`(금액 = 지급액), 상계로 남은 금액이 0이 된 미수금은 `RECEIVABLE_CLOSED`를 같은 트랜잭션에 쓴다(ADR-0368 결정 3이 이 단계로 남긴 사건).
7. **전송 결과는 넷이고, 멱등키는 지급 건과 지급일로 정한다.** 전송 결과는 접수, 오류 응답, 응답 없음, 처리 중(409 `IDEMPOTENT_REQUEST_PROCESSING`)이다. 멱등키는 정렬한 `refPayoutId` 목록과 지급일의 SHA-256이다. 같은 묶음·같은 지급일이면 같은 키이고, 순번이나 지급일이 바뀌면 새 키다.
   - 응답 없음·처리 중이면 묶음을 `APPROVED`로 둔 채 다음 전송 시각을 1분에서 두 배씩, 30분 상한 [가정]으로 미루고 같은 키로 다시 보낸다. 전송 일꾼은 1분 [가정]마다 돌고 리더 파드만 보낸다. 묶음 행의 다음 전송 시각을 조건으로 잡아 두 파드가 같은 묶음을 함께 보내지 않는다.
   - 마감은 지급일 전 영업일 22:00 KST [가정]다. 마감을 넘기면 자동 전송을 멈추고, 묶음 지급일을 다음 은행 영업일로 미루며, CS 처리함 `PAYOUT_DELAYED`(대상 = 묶음 ID)와 묶인 정산서마다 `PAYOUT_HELD`를 쓴다. 처음 요청이 결제사에 들어가지 않았음을 operator가 상점관리자에서 확인한 뒤 실행을 다시 부르면, 지급일이 바뀌었으므로 새 키로 나간다. 바뀐 지급일을 사건에 싣는 일은 받는 쪽(GAT-270)과 함께 한다.
   - 오류 응답이면 키를 바꾸지 않고 CS 처리함 `PAYOUT_ERROR`(첫 오류 코드, 결제사 오류 원문은 관제 역할에만)를 만들며 묶음은 `APPROVED`로 둔다. 같은 묶음을 다시 보내면 같은 키다. 단 오류가 예약 날짜 오류 [가정: 결제사 코드 목록은 계약 때 확인]면 지급일을 다음 은행 영업일로 바꿔 새 키로 한 번만 자동으로 다시 보내고, 또 날짜 오류면 `PAYOUT_ERROR`다.
   - 요청 직전에 그 상점의 지급 가능 잔액에서 이 묶음 밖의 끝나지 않은 토스 예약지급 합을 뺀 값이 이 묶음의 아직 보내지 않은 금액보다 작으면 보내지 않는다. 응답 없음과 같은 간격으로 다시 보고, 처음 모자랄 때 `PAYOUT_DELAYED` 한 건을 만들며, 마감 규칙도 같다. 묶음을 만들 때의 비교(settlement §5.1)도 이 묶음 합계에 끝나지 않은 예약지급 합을 더한다.
   - 20건 묶음 가운데 일부만 접수되면 접수되지 않은 묶음만 같은 키로 다시 보낸다. 묶음 나누기는 정산서 ID·순번 차례로 고정한다.
8. **지급 실패 세 갈래는 정산 일꾼이 처리한다(settlement §12).** 실패 코드는 계좌·점검(일시)·한도/KYC·모름으로 나눈다(코드 표는 공개 안내 기준 [가정], 결제사 원문 표는 계약 때 채운다).
   - 계좌: CS 처리함 `PAYOUT_FAILED`. 자동 재요청은 없다.
   - 점검(일시): 새 순번(정산서 행 잠금 안에서 그 정산서의 가장 큰 순번 + 1)으로 다음 은행 영업일(다음 날 09시 뒤의 첫 영업일) 예약지급을 건다. 같은 지급 건 줄기의 자동 재요청은 2번까지이고, 세 번째 실패는 `PAYOUT_FAILED`로 사람에게 보낸다.
   - 한도/KYC: CS 처리함 `SELLER_KYC_REQUIRED`. 그 상점 셀러가 단건 조회로 `APPROVED`가 되면 새 순번으로 한 번 다시 보낸다. KYC가 아닌 한도 초과는 사람이 CS 건에서 다시 요청한다.
   - 모름: `PAYOUT_FAILED`로 사람이 원인을 본다.
   - 재요청은 처음 지급 건과 금액·받는 셀러가 같아 새 2인 승인을 받지 않고, 새 표 `payout_retry_audit`에 옛 지급 건·옛 순번·새 순번·행위자(자동이면 `system`)·사유를 남긴다. 정산서는 새 지급 건이 접수되면 T13 `FAILED → SCHEDULED`다.
   - 사람의 재요청(`retryPayout`)도 같은 금액만 받는다. 정산 계좌를 바꾼 지 3영업일 안이면 409 `payout-account-change-hold`, 예금주가 확인되지 않았으면 409 `payout-account-mismatch`다(3영업일 보류를 재요청으로 우회하지 않게). 금액이나 셀러를 바꾼 재요청은 이 경로가 받지 않고 409 `payout-retry-approval-required`다. 바꿔야 하면 다시 계산(F-07-8)과 새 지급 묶음 승인으로 한다 [가정].
9. **셀러 KYC가 풀리면 보류를 푼다.** `seller.changed` 뒤 단건 조회가 `KYC_REQUIRED`면 CS 처리함 `SELLER_KYC_REQUIRED`(대상 = 토스 셀러 ID)와 지표를 남긴다. `APPROVED`면 그 파트너·상점의 `HELD`·`KYC` 토스 정산서를 T8로 `CONFIRMED`(행위자 `system`, 사유 `toss-seller-approved`)로 돌리고(PEAKET 판매자 확인이 끝나지 않았으면 그대로), 결정 8의 한도/KYC 실패 지급 건을 다시 보낸다. 이미 만든 예약지급(`REQUESTED`)을 결제사에서 취소하는 T10은 LCH-120(F-07-7)이 한다.
10. **CS 건은 같은 트랜잭션에 적고 일꾼이 보낸다.** 지급 쪽 CS 건(`PAYOUT_ERROR`·`PAYOUT_FAILED`·`PAYOUT_DELAYED`·`SELLER_KYC_REQUIRED`·`PG_BALANCE_MISMATCH`)은 그 원인이 된 쓰기와 같은 트랜잭션에 새 표 `settlement_case_request`(사건 키, 종류, 대상, 보낸 시각)로 적고, 정산 일꾼이 ops-svc `POST /internal/v1/cs-cases`(ADR-0368 결정 5와 같은 경로)로 보낸다. 보내지 못하면 다음 30분 점검이 다시 보낸다. ops-svc는 이 다섯 종류를 받기 시작한다(같은 종류·대상의 열린 건은 하나).
11. **결제사 잔액 대사는 토스 결제 상점마다 한다(settlement §5.5).** 있어야 할 잔액 = 대사가 끝난 승인 − 취소·환불 − 결제사 수수료 − 완료한 지급 − 지급대행 이용료(결정 2의 설정, [가정]) − PEAKET 몫 인출(0)이다. 수수료는 토스페이먼츠 정산 조회의 `fees`를 지난 대사 뒤 기간만 읽어 누적에 더한다. 결제사가 보여 주는 잔액은 잔액 조회의 지급 가능 금액과 정산 대기 금액의 합이다. 매월 마지막 영업일 22:00 KST [가정]와, 토스 지급 묶음을 만든 뒤 다음 30분 점검에서 돈다(묶음을 멈추지 않는다). 결과는 새 표 `pg_balance_reconciliation`에 남기고(월 대사는 상점·달마다 한 행), 차이가 0이 아니면 `PG_BALANCE_MISMATCH`(대상 = `TOSS:{상점}`), 절댓값이 1만 원 [가정]을 넘으면 그 행에 `SEV3`를 적고 `settlement_pg_balance_diff_krw{pg,store}`를 낸다. 끝수·정산 대기 시점으로 설명되는 차이는 CS 건의 결과 메모로 닫는다(ops-svc 기존 경로). 포트원 쪽(이체 원장 계산 잔액과 operator 입력값)은 LCH-120(F-07-7)이 한다.
12. **지표 다섯과 미완료 점검.** `settlement_payout_failed_total{pg,reason}`, `settlement_webhook_signature_invalid_total`, `settlement_seller_kyc_required{pg}`, `settlement_pg_balance_diff_krw{pg,store}`, `settlement_payout_overdue_total{pg}`를 낸다. 지급일 다음 영업일 12:00 KST까지 끝나지 않은 토스 지급 건은 정산 일꾼이 단건 조회로 확인해 결정 6으로 반영하고, 그래도 끝나지 않았으면 `PAYOUT_DELAYED`(대상 = 지급 건 ID)와 `settlement_payout_overdue_total`을 남긴다(settlement §5.2). 15시 미승인 만료(`settlement_batch_unapproved`, 승인 업무 만료·지급일 미룸·파트너 알림)는 이 결정에 넣지 않는다. 승인 업무 만료 작업과 `payout_approval` 합치기가 있는 GAT-290(F-06-3)과 함께 한다(감독 결정 2026-11-23). 그 만료는 결정 13의 `PREPARED` 묶음도 함께 푼다.
13. **토스 지급 묶음은 09시에 미리 만든다(settlement §5.1, 감독 결정 2026-11-23).** 정산 일꾼(리더)이 지급일 전 영업일 09:00 KST에, 다음 은행 영업일이 지급일인 토스 확정 정산서를 결제 상점마다 모아 `PREPARED` 묶음 하나를 만든다(행위자 `system`). 보류(T7)·상계 계산·잔액 판정은 operator 확인 요청 때와 같은 함수를 쓴다. 보류는 그때 저장하고(`PAYOUT_HELD`), 잔액이 모자라면 지금처럼 `HELD`·`BALANCE`다. 그러나 `PREPARED`는 정산서를 묶지 않고(`payout_batch_id` 비움) 미수금 상계를 쓰지 않는다. 합계·건수만 묶음 행(`total_amount`·`statement_count`)에 미리 셈해 두어 SCR-049에서 operator가 본다(상세는 그 지급일의 지금 확정 정산서를 보인다). operator가 같은 결제사·상점·지급일로 확인 요청(`POST /v1/ops/payout-batches`, 지금 경로 그대로)을 하면 payment-svc가 그 `PREPARED` 묶음의 ID를 그대로 쓰며, 그때의 확정 정산서로 보류·상계·잔액을 다시 판정해 묶고 `PENDING_APPROVAL`로 바꾼다(한 트랜잭션, 묶음 행 조건 `status = 'PREPARED'`). 09시 뒤에 확정된 정산서도 들어가고, 같은 미수금을 두 번 상계하지 않는다. 확정 정산서가 없는 상점은 묶음을 만들지 않는다. 같은 날 다시 돌아도 묶음은 상점·지급일마다 하나다. core·잔액 원천이 답하지 않으면 다음 30분 점검이 다시 하고, 세 번 [가정] 실패하면 CS 처리함 `PAYOUT_DELAYED`(대상 = `TOSS:{상점}:{지급일}`)다. 포트원 묶음은 자동으로 만들지 않는다. operator가 콘솔에서 본 지급대행 계좌 잔액을 적어야 만들 수 있기 때문이다(settlement §5.1·§5.3). ops-svc와 계약은 바꾸지 않는다(묶음 상태 `PREPARED`는 openapi·SCR-049에 이미 있다).

## 검토한 대안

| 대안 | 판단 |
| --- | --- |
| JWE를 node:crypto로 직접 만든다 | 기각. settlement §8과 ASVS 11.2.1이 검증된 JOSE 라이브러리를 요구한다. 저장소에 이미 같은 판이 있다 |
| 셀러를 파트너마다 하나로 둔다(지금 `seller_kyc` 칸) | 기각. §3이 두 상점 등록을 요구하고 웹훅·잔액·KYC가 상점마다다. 한 칸이면 에스크로 상점의 KYC가 일반 상점 지급을 막거나 그 반대가 된다 |
| 셀러가 없는 토스 정산서는 묶는다 | 기각. 받을 셀러가 없으면 결제사가 거절한다. 판매 승인 조건이 꺼진 동안(ADR-0327 결정 9) 생긴 정산서는 셀러를 등록할 때까지 보류가 맞다 |
| 마감 뒤에도 새 지급일·새 키로 자동으로 다시 보낸다 | 기각. 처음 요청이 실제로 들어갔다면 두 번 지급될 수 있다. 응답을 받지 못한 요청은 사람이 상점관리자에서 확인한 뒤에만 새 키로 보낸다 |
| 마감 뒤 같은 키로 지급일만 바꿔 보낸다 | 기각. 같은 키에 다른 본문을 보낼 때의 결제사 동작이 공개 문서에 없다 |
| CS 건을 커밋 뒤에 바로 부르고 실패는 로그만 | 기각. 지급 실패·지연 건이 사라지면 사람이 모른다. 같은 트랜잭션에 적고 다시 보낸다 |
| 09시 `PREPARED` 묶음에 정산서를 바로 묶고 상계도 쓴다 | 기각. 요청 때까지 판매 중지·보류·새 확정이 바뀔 수 있고, 다시 판정하면 상계를 두 번 쓰거나 되돌려야 한다. 미리 셈만 하고 묶기·상계는 요청 때 한 번 한다 |
| 09시 자동 묶음을 바로 `PENDING_APPROVAL`로 만든다 | 기각. ops-svc 지급 승인 요청은 operator가 확인하고 요청하는 동작이라(POL-038) 묶음과 승인 업무가 한 번에 생긴다. 사람의 확인 없이 승인 대기를 만들지 않는다 |
| 포트원 묶음도 09시에 만든다 | 기각. 포트원은 잔액 조회 API가 없어 operator 입력값이 묶음을 만드는 조건이다(settlement §5.1) |
| 실제 토스 시험 서버를 부르는 잡을 켠다 | 이번에는 하지 않는다. 지급대행 보안 키가 계약 뒤에 나오고, 잡을 새로 켜는 일은 소유자 몫이다. 공개 안내 모양으로 만든 대역 서버로 계약 시험을 한다 |

## 결과와 트레이드오프

- **좋은 점**: 계약·키가 생기면 설정만 넣어 실제 지급이 돈다. 지급 결과가 정산서 상태와 파트너 사건으로 이어지고, 실패가 갈래마다 자동 재요청이나 CS 건으로 끝난다. KYC 보류가 그 결제사·상점에만 걸린다. 결제사에 남은 돈이 장부와 맞는지 달마다 본다.
- **남는 한계**: 결제사 원문 오류 코드 표·날짜 오류 코드·서명 머리 구분자·셀러 등록 본문 모양은 공개 안내를 읽은 [가정]이고 계약 때 원문으로 확인한다. 바뀐 지급일을 파트너에게 알리는 사건 칸과 받는 쪽은 GAT-270 몫이다. 15시 미승인 만료가 남는다(F-06-3). 이미 만든 예약지급 취소와 포트원 잔액 대사는 F-07-7이다. 은행 영업일은 아직 주말만 뺀다(F-07-5 C-04).
- **배포**: payment 0028(`toss_seller`, `payout`·`payout_batch` 칸, `payout_retry_audit`, `settlement_case_request`, `pg_balance_reconciliation`, `seller_kyc` 토스 칸 옮기기). 설정 이름이 바뀌므로 비밀 값을 넣을 때 새 이름을 쓴다(지금은 비어 있다).

## 되돌릴 조건

- 결제사 원문 규격(서명 원문·머리 구분자·셀러 등록 본문·오류 코드)이 이 결정의 [가정]과 다르면 어댑터와 이 ADR을 고친다.
- 셀러·잔액·KYC가 상점마다 따로가 아니라고 확인되면(settlement §14) 결정 3·4를 파트너 단위로 줄인다.
- GAT-290이 지급 승인 요청을 공통 승인 업무로 바꾸면 결정 13의 요청 때 다시 묶기와 15시 만료를 그 모양에 맞춘다.

## 확인

- J-T4·J-T5·J-T6·J-T7·J-T15·J-T16·J-T25·J-T34·J-T37·J-T38(⑨가 결정 13)이 이 결정을 본다. `trace-check --ids "…"`와 `ledger --batch F-07-6 --require`로 확인한다.
