# 완성 장부: settlement

`tools/ci/ledger.mjs`가 정본에서 다시 쓴다. 손으로 고치지 않는다(상태·등급·사유는 `docs/review/ledger-notes.md`). 원천: `docs/features/settlement.md`, `docs/security/asvs/settlement.md`. 전체 개수와 이 도구의 한계는 `docs/review/ledger/README.md`에 있다.

| 등급 | 자동 시험 | ID만 | 측정 | 사람 확인 | 미검증 | 다른 단계 | 없앰 | 해당 없음 | 빈칸 | 합계 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 103 | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 12 | 120 |
| B | 70 | 48 | 0 | 0 | 0 | 0 | 0 | 23 | 12 | 153 |
| 합계 | 173 | 53 | 0 | 0 | 0 | 0 | 0 | 23 | 24 | 273 |

## docs/features/settlement.md

| 항목 | 세부 | 제목 | 판정 기준 앞부분 | 상태 | 등급 | 근거 |
| --- | --- | --- | --- | --- | --- | --- |
| J-T1 | — | 정산서 계산 | 판매 3,000만 원, 환급 200만 원, 수수료율 10%에서 수수료 280만 원, 부가세 28만 원, 지급액 2,492만 원이 나온다. 지급 건 합계 =… | 자동 시험 | A | 시험: services/payment-svc/test-int/settlement.int.test.ts, services/payment-svc/test/settlement-notify-dispute.test.ts 외… |
| J-T2 | — | 이의 기간 | 2영업일 안에 이의를 내면 DISPUTED가 되고, 그 정산서만 묶음에서 빠진다. 같은 파트너의 다른 정산서는 지급된다 | 자동 시험 | A | 시험: services/payment-svc/test/settlement-notify-dispute.test.ts |
| J-T3 | — | 지급 묶음 2인 승인 | 요청자와 같은 사람이 승인하면 403이다. 승인 전에는 결제사에 요청이 나가지 않는다. 합계가 25억 원인 묶음(`int` 상한 약 21억 4,748만 원을… | 자동 시험 | A | 시험: services/ops-svc/test/payout-approval.test.ts |
| J-T4 | — | 토스페이먼츠 분할 | 25억 원 정산서는 10억 원 미만 3건으로 나눈다. 요청당 20건을 넘으면 요청을 나눈다 | 자동 시험 | A | 시험: services/payment-svc/test/settlement-toss-payout.test.ts |
| J-T5 | — | 멱등 | 같은 지급 건을 다시 보내도 중복 지급이 없다. 오류 응답 뒤 자동 재시도가 멱등키를 바꾸지 않는다(시뮬레이터). 지급 API가 응답하지 않게 하면(시간 초과)… | 자동 시험 | A | 시험: services/payment-svc/test-int/settlement-toss-payout.int.test.ts, services/payment-svc/test/settlement-toss-execute… |
| J-T6 | — | 지급 웹훅 서명 | 서명 불일치는 버리고 보안 이벤트로 남긴다. 키 교체 중에는 서명 4개 중 하나가 맞으면 받는다. 받은 뒤에도 단건 조회로 확정한다 | 자동 시험 | A | 시험: services/payment-svc/test/payout-adapters.test.ts, services/payment-svc/test/settlement-toss-webhook.test.ts |
| J-T7 | — | KYC 보류 | 시뮬레이터 셀러가 KYC_REQUIRED면 토스페이먼츠 결제분만 HELD가 되고 CS 처리함 건이 생긴다. APPROVED 웹훅 뒤 다시 요청한다. 연결:… | 자동 시험 | A | 시험: services/payment-svc/test/settlement-payout-failure.test.ts, services/payment-svc/test/settlement-toss-seller.test.t… |
| J-T8 | — | 정산 계좌 변경 | 예금주가 다르면 거부하고 계좌를 남기지 않는다. 같으면 두 결제사 정보를 수정하고, 등록 이메일·전화로 알리고, 3영업일 지급을 보류한다. 표기 차이(추천 적용… | 빈칸 | A | — |
| J-T9 | — | 포트원 지급 | 수기 정산건 아이디 중복 생성이 없다. 지급일에 '포트원 일괄 지급 실행' 건이 생기고, 실행을 기록한 뒤 지급 내역 조회로 PAID가 된다 | 자동 시험 | A | 시험: services/ops-svc/test/payout-approval.test.ts |
| J-T10 | — | 테넌트 격리 | 파트너 A가 B의 정산서 ID로 이의하면 없는 정산서 ID와 같은 404이고, B의 회차 정산서 목록을 부르면 없는 회차와 같은 200 빈 목록이다. 둘 다… | 자동 시험 | A | 시험: services/payment-svc/test/settlement-notify-dispute.test.ts |
| J-T11 | — | 지급 뒤 환불 | J-T1의 정산서(수수료율 10%)를 지급한 뒤 토스페이먼츠 결제분 50만 원을 환불하면, 미수금은 50만 원 − 수수료 몫 5만 원 − 부가세 5천 원 =… | 빈칸 | A | — |
| J-T12 | — | 0 이하 정산서 | 지급액이 70만 원인 정산서에 감액 조정(`AGREED_DEDUCTION`) 100만 원을 승인하면 지급액이 −30만 원이 되어 CARRIED_OVER가 되고… | 자동 시험 | A | 시험: services/payment-svc/test-int/settlement-flow.int.test.ts, services/payment-svc/test/settlement-adjustment.test.ts |
| J-T13 | ① | 잔액 부족 `HELD`(2026-11-22, BAT-630) | ① 토스페이먼츠 `availableAmount`가 묶음 합계보다 작으면 묶음을 만들지 않고 그 정산서를 `HELD`·`BALANCE`로 저장한 뒤 409… | 자동 시험 | A | 시험: services/payment-svc/test/settlement-balance-hold.test.ts |
| J-T13 | ② | 잔액 부족 `HELD`(2026-11-22, BAT-630) | ② 포트원 운영자 입력값이 작아도 같다. | 자동 시험 | A | 시험: services/payment-svc/test/settlement-balance-hold.test.ts |
| J-T13 | ③ | 잔액 부족 `HELD`(2026-11-22, BAT-630) | ③ 잔액 확인 증빙(`evidence.balanceConfirmed`)이 없으면 재확정 409 `payout-balance-unconfirmed`, 있으면… | 자동 시험 | A | 시험: services/payment-svc/test/settlement-balance-hold.test.ts |
| J-T13 | ④ | 잔액 부족 `HELD`(2026-11-22, BAT-630) | ④ HELD 정산서는 다음 묶음에 들어가지 않고, 증빙으로 푼 것만 들어간다. | 자동 시험 | A | 시험: services/payment-svc/test/settlement-balance-hold.test.ts |
| J-T13 | ⑤ | 잔액 부족 `HELD`(2026-11-22, BAT-630) | ⑤ 잔액 원천이 실패하면 503 `pg-balance-unavailable`이고 정산서·묶음을 바꾸지 않는다. 포트원 묶음 확인 요청에 잔액 입력이 없으면… | 자동 시험 | A | 시험: services/payment-svc/test/settlement-balance-hold.test.ts |
| J-T14 | — | 민감 정보 | 계좌번호, 보안 키, JWE 원문이 로그·응답·분석 이벤트에 없다(정적 검사와 로그 표본 검사) | 빈칸 | A | — |
| J-T15 | ① | 지급 실패 | ① 계좌 해지 … 은 파트너 계좌 확인 요청이 가고 자동 재요청이 없다. | 자동 시험 | A | 시험: services/payment-svc/test/settlement-payout-failure.test.ts |
| J-T15 | ② | 지급 실패 | ② 원천사 점검 … 는 새 순번(가장 큰 순번 + 1)으로 다음 영업일 예약지급이 자동으로 걸리고, 같은 건을 세 번째로 실패시키면 CS 처리함으로 간다. | 자동 시험 | A | 시험: services/payment-svc/test-int/settlement-toss-payout.int.test.ts, services/payment-svc/test/settlement-payout-failur… |
| J-T15 | ③ | 지급 실패 | ③ `KYC_REQUIRED` 실패를 만든다. … 은 그 셀러의 토스페이먼츠 지급이 HELD가 된다. 금액이 같은 재요청은 새 2인 승인 없이 나가고 감사… | 자동 시험 | A | 시험: services/payment-svc/test/settlement-payout-failure.test.ts |
| J-T16 | — | 늦은 지급 웹훅 | 서명은 맞고 `transmission-time`이 10분 전인 `payout.changed`를 보낸다. 이때 본문으로 상태를 바꾸지 않고, '늦은 웹훅' 보안… | 자동 시험 | A | 시험: services/payment-svc/test/settlement-toss-webhook.test.ts |
| J-T17 | — | 예금주 조회 URL 가림 | 예금주 조회를 부른 뒤 트레이스·로그·OTel Collector 출력 어디에도 계좌번호가 없고 경로 템플릿만 남는다 | 빈칸 | A | — |
| J-T18 | — | 상품 정산서 | 에스크로 구매 확정 전 주문, 받은 지 7일이 안 된 택배·현장 수령, 반품 요청 중인 항목은 빠진다. 부가 상품은 연결 회차가 끝난 다음 날 들어간다… | 자동 시험 | A | 시험: apps/partner/src/_pages/product-builder/model/settlement-live.test.mjs, services/core-svc/test/export.test.ts 외 1곳 |
| J-T19 | ① | KYC 예고(2026-11-22, BAT-630) | ① `PARTIALLY_APPROVED` 셀러의 지급일 앞뒤 6일 토스 지급 합계가 1,000만 원이면 묶음 상세와 SCR-049에 예고가 나온다. | 자동 시험 | A | 시험: services/payment-svc/test/settlement-kyc-notice.test.ts |
| J-T19 | ② | KYC 예고(2026-11-22, BAT-630) | ② 999만 원이거나 셀러가 `APPROVED`이거나 지급일이 창 밖이면 나오지 않는다. | 자동 시험 | A | 시험: services/payment-svc/test/settlement-kyc-notice.test.ts |
| J-T19 | ③ | KYC 예고(2026-11-22, BAT-630) | ③ `seller.changed` 웹훅이 `PARTIALLY_APPROVED`·`KYC_REQUIRED`·`APPROVED`를 그 상점 토스 셀러… | 자동 시험 | A | 시험: services/payment-svc/test/settlement-kyc-notice.test.ts |
| J-T20 | ① | 포트원 출금 대사(추천 적용 2026-10-28, ADR-0108) | ① 정상 일괄 지급 … 은 `MATCHED`이고 경보가 없다. | ID만 | A | 시험: services/payment-svc/test/payout-adapters.test.ts |
| J-T20 | ② | 포트원 출금 대사(추천 적용 2026-10-28, ADR-0108) | ② 지급 건과 금액이 다른 출금 … 는 다음 30분 동기화에서 SEV2(보안)와 CS 처리함 건이 하나씩 생기고, 그다음 동기화에서 같은 건이 다시 생기지… | ID만 | A | 시험: services/payment-svc/test/payout-adapters.test.ts |
| J-T20 | ③ | 포트원 출금 대사(추천 적용 2026-10-28, ADR-0108) | ③ 다른 계좌로 간 지급 … 는 다음 30분 동기화에서 SEV2(보안)와 CS 처리함 건이 하나씩 생기고, 그다음 동기화에서 같은 건이 다시 생기지 않는다. | ID만 | A | 시험: services/payment-svc/test/payout-adapters.test.ts |
| J-T20 | ④ | 포트원 출금 대사(추천 적용 2026-10-28, ADR-0108) | ④ 지급 건과 이어지지 않는 가상계좌 출금 … 는 다음 30분 동기화에서 SEV2(보안)와 CS 처리함 건이 하나씩 생기고, 그다음 동기화에서 같은 건이 다시… | ID만 | A | 시험: services/payment-svc/test/payout-adapters.test.ts |
| J-T20 | ⑤ | 포트원 출금 대사(추천 적용 2026-10-28, ADR-0108) | ⑤ 지급 내역은 SUCCEEDED인데 출금이 없는 경우를 만든다. … 는 1시간 [가정] 뒤 `MISSING`과 건이 생긴다. 로그·트레이스에 계좌번호 전체와… | ID만 | A | 시험: services/payment-svc/test/payout-adapters.test.ts |
| J-T21 | — | 포트원 계좌 대조와 보류(추천 적용 2026-10-28… | 시험 환경 콘솔에서 파트너 A의 정산 계좌를 바꾸고, B의 정산 내역 금액을 고친 뒤, 다음 날 A·B가 든 포트원 묶음의 실행 건을 만든다. 08시 대조에서… | 빈칸 | A | — |
| J-T22 | ① | 포트원 잔액 대조와 대사 멈춤(추천 적용 2026-10-28… | ① operator가 원장 계산값보다 큰 잔액을 적는다 … 은 원장 계산값으로 판정하고 CS 처리함 건이 생긴다. | 빈칸 | A | — |
| J-T22 | ② | 포트원 잔액 대조와 대사 멈춤(추천 적용 2026-10-28… | ②이체 원장 조회를 1시간 넘게 실패하게 한다 … 는 SEV2가 뜨고, 실행 건에 'commander 확인 필요'가 붙는다. | 빈칸 | A | — |
| J-T22 | ③ | 포트원 잔액 대조와 대사 멈춤(추천 적용 2026-10-28… | ③ 녹화한 원장 응답의 칸 이름을 바꿔 어댑터 계약 시험에 넣는다. … 은 계약 시험(payment P-T16)이 실패한다 | 빈칸 | A | — |
| J-T26 | ① | 정산 리포트·관람객 명단 내려받기(추천 적용 2026-10-28, 기술… | ① 사유가 없으면 거절되고, 사유를 넣으면 내려받은 건수와 함께 접속기록에 남는다(control-tower C-T19). | 자동 시험 | A | 시험: apps/partner/src/_pages/settlement/model/roster-live.test.mjs, services/core-svc/test/export.test.ts |
| J-T26 | ② | 정산 리포트·관람객 명단 내려받기(추천 적용 2026-10-28, 기술… | ② 스트리밍으로 보내 내려받는 동안 서버 RSS 증가가 100MB 이하 [가정]이고 첫 바이트가 2초 [가정] 안에 온다. | 자동 시험 | A | 시험: apps/partner/src/_pages/settlement/model/roster-live.test.mjs, services/core-svc/test/export.test.ts |
| J-T26 | ③ | 정산 리포트·관람객 명단 내려받기(추천 적용 2026-10-28, 기술… | ③ 410과 보유 기간 끝 안내가 나온다. | 자동 시험 | A | 시험: apps/partner/src/_pages/settlement/model/roster-live.test.mjs, services/core-svc/test/export.test.ts |
| J-T26 | ④ | 정산 리포트·관람객 명단 내려받기(추천 적용 2026-10-28, 기술… | ④ 내려받기는 2,000건을 모두 싣고 원천이 `nextCursor` null을 줄 때만 멈춘다. 보기 응답의 `nextCursor`는 원천 값 그대로다(짧은… | 자동 시험 | A | 시험: services/core-svc/test/export-paging-limit.test.ts, services/core-svc/test/export.test.ts 외 1곳 |
| J-T26 | ⑤ | 정산 리포트·관람객 명단 내려받기(추천 적용 2026-10-28, 기술… | ⑤ 보인 건수·행위자(계정 ID·역할)·파트너·회차·조건·접속지(요청의 클라이언트 IP)를 실은 `LIST` 사건 하나가 core Outbox(토픽… | 자동 시험 | A | 시험: services/core-svc/test-int/export-audit.int.test.ts, services/core-svc/test/export-audit.test.ts 외 1곳 |
| J-T26 | ⑥ | 정산 리포트·관람객 명단 내려받기(추천 적용 2026-10-28, 기술… | ⑥ 파일을 주지 않고 내려받기 이력도 남지 않는다(이력과 `DOWNLOAD` 사건이 한 트랜잭션). 연결: FR-027 | 자동 시험 | A | 시험: services/core-svc/test-int/export-audit.int.test.ts, services/core-svc/test/export-audit.test.ts 외 1곳 |
| J-T23 | ① | 다시 계산과 대사 미완 결제(추천 적용 2026-10-28, 기술 검토… | ① NOTIFIED·DISPUTED·CONFIRMED 정산서마다 회차 취소를 확정한다 … 판본 2인 새 판이 CALCULATED로 생기고 옛 판은 금액 그대로… | 빈칸 | A | — |
| J-T23 | ② | 다시 계산과 대사 미완 결제(추천 적용 2026-10-28, 기술 검토… | ② 토스페이먼츠 예약지급이 REQUESTED인 정산서와 IN_PROGRESS인 정산서에서 회차 취소를 확정한다 … REQUESTED는 예약 취소 → HELD →… | 빈칸 | A | — |
| J-T23 | ③ | 다시 계산과 대사 미완 결제(추천 적용 2026-10-28, 기술 검토… | ③ 대사 불일치 결제 1건이 남은 회차를 계산한 뒤, 지급 전과 지급 뒤에 각각 불일치를 푼다. 결과: … 그 결제만 빠진 정산서와 뺀 목록이 나오고, 풀린 뒤… | 빈칸 | A | — |
| J-T24 | — | 미수금 이동 기록과 되돌림(추천 적용 2026-10-28, 기술 검토… | 미수금 100만 원을 정산서 A(30만 원)·B(70만 원)에서 나눠 상계하고, B의 지급을 실패시킨 뒤 다시 계산한다. 같은 미수금을 두 정산서가 동시에… | 자동 시험 | A | 시험: services/invariant-checker/test-int/invariants.int.test.ts, services/invariant-checker/test-int/payment-migrated.int… |
| J-T25 | ① | 지급대행 잔액 대사(추천 적용 2026-10-28, 기술 검토… | ① 승인·취소·수수료·지급이 장부와 맞는 상점 … 은 차이 0이고 건이 없다 | 자동 시험 | A | 시험: services/payment-svc/test/settlement-pg-balance-recon.test.ts |
| J-T25 | ② | 지급대행 잔액 대사(추천 적용 2026-10-28, 기술 검토… | ② 결제사 쪽 잔액만 3만 원 적은 상점 … CS 처리함 '결제사 잔액 대사 차이' 건과 SEV3가 생기고, 묶음은 멈추지 않는다 | 자동 시험 | A | 시험: services/payment-svc/test/settlement-pg-balance-recon.test.ts |
| J-T25 | ③ | 지급대행 잔액 대사(추천 적용 2026-10-28, 기술 검토… | ③ 끝수 차이 1원만 나는 상점을 둔 채 지급 묶음을 만들고 월말 대사를 돌린다. 결과: … 건이 생기고 '설명된 차이'로 닫을 수 있다. 정산 불변식… | 자동 시험 | A | 시험: services/payment-svc/test/settlement-pg-balance-recon.test.ts |
| J-T27 | — | 정산 화면의 역할(소유자 결정 2026-10-30, open-items… | `cs_agent`·`cs_lead`로 정산서 목록·미수금 목록·지급 묶음 경로를 부르면 403이다. CS 처리함 목록에는 정산 건 가운데 '정산 이의'만… | 빈칸 | A | — |
| J-T28 | — | 배상금 미리 지급의 미수금 생성·상계(추천 적용, 2026-11-20… | `PAID`일 때만 `partner_receivable` 1행(`COMPENSATION_ADVANCE`·`pg NULL`·remaining =… | 자동 시험 | A | 시험: services/payment-svc/test-int/compensation-transfer.int.test.ts, services/payment-svc/test-int/settlement-a1v.int.te… |
| J-T29 | ① | 계약 조건 변경의 2인 승인(2026-11-20, BAT-615… | ① `POST /v1/ops/promoters`로 상호와 첫 계약(수수료율 875bp·보증 700bp·`PERFORMANCE_BOND`)을 넣으면 201이고… | 자동 시험 | A | 시험: services/core-svc/test/ops-promoter.http.test.ts |
| J-T29 | ② | 계약 조건 변경의 2인 승인(2026-11-20, BAT-615… | ② operator가 875→900bp·보증 700→650bp를 요청하면 202 `PENDING_APPROVAL`이고… | 자동 시험 | A | 시험: services/core-svc/test-int/promoter-contract.int.test.ts, services/core-svc/test/ops-promoter.http.test.ts 외 1곳 |
| J-T29 | ③ | 계약 조건 변경의 2인 승인(2026-11-20, BAT-615… | ③ 반려하면 `REJECTED`이고 지금 계약·기간 수가 그대로이며 대기 표시가 지워진다. 곧바로 새 요청이 202다. 요청자 철회는 `WITHDRAWN`이고… | 자동 시험 | A | 시험: services/core-svc/test/ops-promoter.http.test.ts, services/ops-svc/test/contract-approval.test.ts |
| J-T29 | ④ | 계약 조건 변경의 2인 승인(2026-11-20, BAT-615… | ④ 같은 파트너의 두 번째 요청은 409이고, 동시에 넣으면 하나만 202·다른 하나 409다(부분 유일 인덱스). 같은 승인을 동시에 두 commander가… | 자동 시험 | A | 시험: services/core-svc/test/ops-promoter.http.test.ts, services/ops-svc/test-int/approval-request.int.test.ts |
| J-T29 | ⑤ | 계약 조건 변경의 2인 승인(2026-11-20, BAT-615… | ⑤ 바꿀 칸 0개·지금과 같은 값·10,001bp·보증 −1·보증 종류 밖·사유 없음·2,001자·모르는 칸은 400/422이고 승인·계약 행이 0이다. | 자동 시험 | A | 시험: services/core-svc/test/ops-promoter.http.test.ts, services/ops-svc/test/contract-approval.test.ts |
| J-T29 | ⑥ | 계약 조건 변경의 2인 승인(2026-11-20, BAT-615… | ⑥ core 적용이 503/409이면 승인은 `FAILED`·감사 기록이고, 같은 승인 ID로 다시 승인하면 core가 한 번만 적용한다. | 자동 시험 | A | 시험: services/ops-svc/test-int/approval-request.int.test.ts, services/ops-svc/test/contract-approval.test.ts |
| J-T29 | ⑦ | 계약 조건 변경의 2인 승인(2026-11-20, BAT-615… | ⑦ 계약 승인 상세는 요청자·commander만 200이고 `cs_lead`·`cs_agent`·다른 operator는 404다. | 자동 시험 | A | 시험: services/ops-svc/test/approval-visibility.test.ts |
| J-T29 | ⑧ | 계약 조건 변경의 2인 승인(2026-11-20, BAT-615… | ⑧ viewer는 목록·상세 403, CS는 읽기 200이지만 `payoutAccount=null`이고 응답에 계좌번호 전체·토스 셀러 ID·포트원 파트너… | 자동 시험 | A | 시험: services/core-svc/test/ops-promoter.http.test.ts, services/ops-svc/test/approval-visibility.test.ts |
| J-T29 | ⑨ | 계약 조건 변경의 2인 승인(2026-11-20, BAT-615… | ⑨ 승인 상태·투표·감사가 한 트랜잭션이고 core의 기간·현재 값·대기 표시도 한 트랜잭션이다. 연결: FR-052, POL-038 ⑨, ASVS… | 자동 시험 | A | 시험: services/core-svc/test-int/promoter-contract.int.test.ts, services/core-svc/test/ops-promoter.http.test.ts 외 2곳 |
| J-T30 | ① | 판매 승인·상품 게시 때 수수료율 고정(2026-11-20… | ① 계약 875bp인 파트너의 공연을 첫 승인하면 모든 회차 `event.commission_rate_bp=875`… | 자동 시험 | A | 시험: services/core-svc/test-int/promoter-contract.int.test.ts, services/core-svc/test/product-commission.test.ts |
| J-T30 | ② | 판매 승인·상품 게시 때 수수료율 고정(2026-11-20… | ② 승인 뒤 계약을 900bp로 바꿔도 이미 승인된 회차·설정 사본은 875 그대로이고, 그 뒤 새 공연을 승인하면 900이다. | 자동 시험 | A | 시험: services/core-svc/test-int/promoter-contract.int.test.ts, services/core-svc/test/product-commission.test.ts |
| J-T30 | ③ | 판매 승인·상품 게시 때 수수료율 고정(2026-11-20… | ③ 재승인에서 회차 하나를 더하면 기존 회차는 875, 더한 회차는 그때의 900이다. | 자동 시험 | A | 시험: services/core-svc/test-int/promoter-contract.int.test.ts, services/core-svc/test/product-commission.test.ts |
| J-T30 | ④ | 판매 승인·상품 게시 때 수수료율 고정(2026-11-20… | ④ database 조립의 `COMMISSION_RATE_SOURCE`가 계약 표를 읽는다. 첫 게시 875bp, 같은 상품을 고쳐도 875, 900bp 계약… | 자동 시험 | A | 시험: services/core-svc/test-int/promoter-contract.int.test.ts, services/core-svc/test/product-commission.test.ts |
| J-T30 | ⑤ | 판매 승인·상품 게시 때 수수료율 고정(2026-11-20… | ⑤ 마이그레이션 뒤 기존 파트너마다 계약 한 기간(1000bp·1000bp·`DEPOSIT`)과 `promoter.commission_rate_bp=1000`이… | 자동 시험 | A | 시험: services/core-svc/test-int/promoter-contract.int.test.ts, services/core-svc/test/product-commission.test.ts |
| J-T32 | ① | SCR-049 정산 지급 화면(2026-11-22, BAT-630… | ① 지급일 탭이 `GET /v1/ops/payout-batches`로 묶음 목록(지급일·결제사·상점·건수·합계·상태·승인 기한)을 보이고, GET… | 자동 시험 | A | 시험: apps/console-host/src/pages/settlements/ui/wiring.test.mjs |
| J-T32 | ② | SCR-049 정산 지급 화면(2026-11-22, BAT-630… | ② 상세가 `GET /v1/ops/payout-batches/{batchId}`로 묶인 정산서·지급 건·HELD 제외 목록·KYC 예고를 보이며 계좌는 은행·끝… | 자동 시험 | A | 시험: apps/console-host/src/pages/settlements/ui/wiring.test.mjs |
| J-T32 | ③ | SCR-049 정산 지급 화면(2026-11-22, BAT-630… | ③ viewer는 읽기, operator는 확인 요청·포트원 실행 기록, commander는 재인증 뒤 승인·반려하고 요청자 본인·viewer·CS는… | 자동 시험 | A | 시험: apps/console-host/src/pages/settlements/ui/wiring.test.mjs |
| J-T32 | ④ | SCR-049 정산 지급 화면(2026-11-22, BAT-630… | ④ 디자인 보드는 `?state=` 미리보기에만 남는다. 연결: FR-062, ASVS 8.2.1·8.2.2·8.2.3, POL-038 ⑥ | 자동 시험 | A | 시험: apps/console-host/src/pages/settlements/ui/wiring.test.mjs |
| J-T33 | ① | 보증금·이행보증보험 징수(2026-11-22, BAT-630… | ① 미수금 발생 30일 뒤 계약 보증 비율(그 미수금 근거 정산서 판매 대금 × `guaranteeRateBp`)만큼 `GUARANTEE`로 충당하고 남은… | 자동 시험 | A | 시험: services/payment-svc/test/settlement-guarantee-collection.test.ts |
| J-T33 | ② | 보증금·이행보증보험 징수(2026-11-22, BAT-630… | ② 30일 전이면 409 `guarantee-not-due`, 보증 한도를 다 쓰면 409 `guarantee-capacity-exhausted`이고 행은… | 자동 시험 | A | 시험: services/payment-svc/test/settlement-guarantee-collection.test.ts |
| J-T33 | ③ | 보증금·이행보증보험 징수(2026-11-22, BAT-630… | ③ commander가 재인증(`act=APPROVAL`)하고 `Idempotency-Key`가 필요하며, 같은 키 재요청은 같은 충당 한 건이다. | 자동 시험 | A | 시험: services/payment-svc/test/settlement-guarantee-collection.test.ts |
| J-T33 | ④ | 보증금·이행보증보험 징수(2026-11-22, BAT-630… | ④ `DEPOSIT`·`PERFORMANCE_BOND` 둘 다 같은 규칙이다. 연결: FR-062, POL-039 ⑤, ASVS 2.3.3·2.3.4·8.2.1 | 자동 시험 | A | 시험: services/payment-svc/test-int/settlement.int.test.ts, services/payment-svc/test/settlement-guarantee-collection.test… |
| J-T34 | ① | 토스페이먼츠 지급대행(2026-11-22, BAT-630… | ① 25억 원 정산서 지급액을 10억 원 미만 3건으로 나누고 요청당 20건까지 보낸다. | 자동 시험 | A | 시험: services/payment-svc/test/settlement-toss-payout.test.ts |
| J-T34 | ② | 토스페이먼츠 지급대행(2026-11-22, BAT-630… | ② 같은 지급 건 묶음은 같은 멱등키, 새 순번은 새 키를 쓴다. | 자동 시험 | A | 시험: services/payment-svc/test/settlement-toss-payout.test.ts |
| J-T34 | ③ | 토스페이먼츠 지급대행(2026-11-22, BAT-630… | ③ 실패 코드를 계좌·일시·한도/KYC·모름으로 나눈다. | 자동 시험 | A | 시험: services/payment-svc/test/settlement-toss-payout.test.ts |
| J-T34 | ④ | 토스페이먼츠 지급대행(2026-11-22, BAT-630… | ④ `payout.changed` 웹훅은 서명을 검증하고 본문을 믿지 않고 단건 조회로 확정하며, `seller.changed`가 KYC 상태를 바꾼다. 실제… | 자동 시험 | A | 시험: services/payment-svc/test/settlement-toss-payout.test.ts |
| J-T31 | ① | 지급 묶음 승인 ID 대조(2026-11-22, BAT-625… | ① `approveBatch`가 ops-svc 지급 승인 기록(`GET /internal/v1/payout-approvals/{approvalId}`)의 종류… | 자동 시험 | A | 시험: services/payment-svc/test/settlement-approval-verification.test.ts |
| J-T31 | ② | 지급 묶음 승인 ID 대조(2026-11-22, BAT-625… | ② 없는 승인 ID·다른 배치·금액·통화·건수·결제사·상점·지급일 불일치는 4xx이고 `payout_batch` 상태를 바꾸지 않는다. | 자동 시험 | A | 시험: services/payment-svc/test/settlement-approval-verification.test.ts |
| J-T31 | ③ | 지급 묶음 승인 ID 대조(2026-11-22, BAT-625… | ③ 정족수 미달(승인자 없음·요청자=승인자·`requiredApprovals≠2`·승인 시각 없음)도 4xx다. | 자동 시험 | A | 시험: services/payment-svc/test/settlement-approval-verification.test.ts |
| J-T31 | ④ | 지급 묶음 승인 ID 대조(2026-11-22, BAT-625… | ④ ops-svc가 5xx·시간 초과·연결 실패·응답 모양 위반이면 503이고 아무것도 바꾸지 않는다. | 자동 시험 | A | 시험: services/payment-svc/test/settlement-approval-verification.test.ts |
| J-T31 | ⑤ | 지급 묶음 승인 ID 대조(2026-11-22, BAT-625… | ⑤ 같은 승인 ID 재요청은 처음 결과와 같고 ops를 다시 부르지 않으며, 같은 승인 ID를 다른 배치에 쓰거나 이미 다른 승인으로 처리된 배치에 새 승인… | 자동 시험 | A | 시험: services/payment-svc/test/settlement-approval-verification.test.ts |
| J-T31 | ⑥ | 지급 묶음 승인 ID 대조(2026-11-22, BAT-625… | ⑥ 성공·거절마다 `payout_batch_audit`에 배치·승인 ID·요청자·승인자·금액·통화·시각·사유를 남기고, 서비스 로그에… | 자동 시험 | A | 시험: services/payment-svc/test/settlement-approval-verification.test.ts |
| J-T31 | ⑦ | 지급 묶음 승인 ID 대조(2026-11-22, BAT-625… | ⑦ 내부 경로는 없는 승인에 404, 늘 `no-store`이고 사유 글·계좌·내부 토큰을 싣지 않는다. 연결: FR-062, POL-038, ASVS… | 자동 시험 | A | 시험: services/ops-svc/test/payout-approval.test.ts |
| J-T35 | ① | 정산서 통지·이의·확정(2026-11-23, F-07-5… | ① 회차·상품 정산서를 계산하면 한 트랜잭션에 정산서 `NOTIFIED`, 감사 `CALCULATED→NOTIFIED` 한 줄… | 자동 시험 | A | 시험: services/payment-svc/test-int/settlement-flow.int.test.ts, services/payment-svc/test/settlement-notify-dispute.test… |
| J-T35 | ② | 정산서 통지·이의·확정(2026-11-23, F-07-5… | ②이의는 `NOTIFIED`이고 기한 전일 때만 받는다. 기한 1밀리초 전은 202, 기한 시각은 409… | 자동 시험 | A | 시험: services/payment-svc/test/settlement-notify-dispute.test.ts |
| J-T35 | ③ | 정산서 통지·이의·확정(2026-11-23, F-07-5… | ③이의를 받으면 ops-svc CS 처리함 `STATEMENT_DISPUTE` 건 하나가 열린다(대상 = 정산서 ID). ops가 503이어도 이의는 202로… | 자동 시험 | A | 시험: services/ops-svc/test/cases.test.ts, services/ops-svc/test/cs-case-settlement-dispute.test.ts 외 1곳 |
| J-T35 | ④ | 정산서 통지·이의·확정(2026-11-23, F-07-5… | ④ 기각은 `cs_lead`만 하고(`cs_agent`·viewer·operator·commander는 403), 사유가 비거나 2,001자면 400… | 자동 시험 | A | 시험: services/ops-svc/test/settlement-dispute-dismissal.test.ts, services/payment-svc/test/settlement-notify-dispute.test… |
| J-T35 | ⑤ | 정산서 통지·이의·확정(2026-11-23, F-07-5… | ⑤ 자동 확정은 기한이 지난 `NOTIFIED`만 `CONFIRMED`·`STATEMENT_CONFIRMED`로 바꾸고 `DISPUTED`·`HELD`·기한 전… | 자동 시험 | A | 시험: services/payment-svc/test/settlement-notify-dispute.test.ts |
| J-T35 | ⑥ | 정산서 통지·이의·확정(2026-11-23, F-07-5… | ⑥이의와 자동 확정을 같은 정산서에 겹쳐 부르면 둘 중 하나만 이긴다. 이의가 이기면 `DISPUTED`이고 확정 0건, 확정이 이기면 `CONFIRMED`이고… | 자동 시험 | A | 시험: services/payment-svc/test-int/settlement-flow.int.test.ts |
| J-T35 | ⑦ | 정산서 통지·이의·확정(2026-11-23, F-07-5… | ⑦ 기한은 KST 공휴일 달력으로 센다. 금요일 06:00 KST 통지의 기한은 화요일 06:00 KST이고, 그 월요일이 공휴일 파일에 있으면 수요일… | 자동 시험 | A | 시험: services/payment-svc/test/settlement-business-calendar.test.ts |
| J-T35 | ⑧ | 정산서 통지·이의·확정(2026-11-23, F-07-5… | ⑧ 상품 정산서 일꾼은 주의 첫 영업일 06시(KST)에 지난주 월~일 상품 정산서를 계산·통지하고, 같은 날 다시 돌아도 같은 주를 두 번 만들지 않는다… | 자동 시험 | A | 시험: services/payment-svc/test/settlement-notify-dispute.test.ts |
| J-T35 | ⑨ | 정산서 통지·이의·확정(2026-11-23, F-07-5… | ⑨ 판매 중지·KYC·계좌 변경·계좌 불일치로 확정 정산서가 모두 빠진 지급 묶음 요청은 409이고, 그 정산서들은 `HELD`·그 사유로… | 자동 시험 | A | 시험: services/payment-svc/test-int/settlement-flow.int.test.ts, services/payment-svc/test/settlement-sale-suspension.test… |
| J-T35 | ⑩ | 정산서 통지·이의·확정(2026-11-23, F-07-5… | ⑩ 기각 응답에는 정산서 ID·종류·회차·기간·금액 항목·상태·이의 기한만 있고 `pg`·`pgStore`·`payoutBankCode`·payoutAccoun… | 자동 시험 | A | 시험: services/ops-svc/test/settlement-dispute-dismissal.test.ts |
| J-T35 | ⑪ | 정산서 통지·이의·확정(2026-11-23, F-07-5… | ⑪이의를 커밋하고 CS 건을 연 뒤 `case_requested_at` 쓰기가 실패해도 이의 응답은 202이고 정산서는 `DISPUTED`이며, 다음 점검에서… | 자동 시험 | A | 시험: services/payment-svc/test/settlement-notify-dispute.test.ts |
| J-T36 | ① | 정산서 수기 조정의 2인 승인(2026-11-23, F-07-5… | ① `cs_lead`가 조정을 요청하면 202이고 승인 업무(`SETTLEMENT_ADJUSTMENT`, 대상 = 정산서 ID, 금액·사유 코드)와… | 자동 시험 | A | 시험: services/ops-svc/test-int/settlement-adjustment-approval.int.test.ts… |
| J-T36 | ② | 정산서 수기 조정의 2인 승인(2026-11-23, F-07-5… | ② 사유 코드 8종 밖은 400이다. 이의 코드 다섯은 그 정산서에 같은 코드의 열린 이의가 있을 때만 받고, 이의가 없거나 코드가 다르면 422다… | 자동 시험 | A | 시험: services/ops-svc/test-int/settlement-adjustment-approval.int.test.ts… |
| J-T36 | ③ | 정산서 수기 조정의 2인 승인(2026-11-23, F-07-5… | ③ `SCHEDULED`·`PAID`·`FAILED`·`CARRIED_OVER`·`SUPERSEDED`·`HELD` 정산서는 요청도 적용도 409… | 자동 시험 | A | 시험: services/ops-svc/test/settlement-adjustment-approval.test.ts, services/payment-svc/test-int/settlement-flow.int.test… |
| J-T36 | ④ | 정산서 수기 조정의 2인 승인(2026-11-23, F-07-5… | ④ 요청자 본인·`cs_lead`·재인증 없는 commander의 승인은 403이고, 다른 commander가 `act=APPROVAL` 재인증 뒤 승인해야… | 자동 시험 | A | 시험: services/ops-svc/test-int/settlement-adjustment-approval.int.test.ts… |
| J-T36 | ⑤ | 정산서 수기 조정의 2인 승인(2026-11-23, F-07-5… | ⑤ 적용하면 한 트랜잭션에 조정 행 `APPLIED`, 정산서 조정 합계·지급액(계산 칸은 그대로), 감사, `STATEMENT_NOTIFIED`가 남는다… | 자동 시험 | A | 시험: services/ops-svc/test/settlement-adjustment-approval.test.ts, services/payment-svc/test-int/settlement-flow.int.test… |
| J-T36 | ⑥ | 정산서 수기 조정의 2인 승인(2026-11-23, F-07-5… | ⑥ 조정 적용과 지급 묶음 만들기를 같은 `CONFIRMED` 정산서에 겹쳐 부르면 하나만 이긴다. 묶음이 먼저면 정산서가 그 묶음에 붙어… | 자동 시험 | A | 시험: services/payment-svc/test-int/settlement-flow.int.test.ts |
| J-T36 | ⑦ | 정산서 수기 조정의 2인 승인(2026-11-23, F-07-5… | ⑦ J-T12처럼 지급액이 0 아래가 된 정산서는 1영업일 뒤 자동 확정 때 `CARRIED_OVER`·`STATEMENT_CARRIED_OVER`가 되고… | 자동 시험 | A | 시험: services/payment-svc/test-int/settlement-flow.int.test.ts, services/payment-svc/test/settlement-adjustment.test.ts |
| J-T36 | ⑧ | 정산서 수기 조정의 2인 승인(2026-11-23, F-07-5… | ⑧ 조정을 적용한 정산서의 지급액은 계산 때 지급액 + 조정 합계와 같다. 지급을 늘리는 조정(+)은 미수금을 만들지 않는다(리뷰 RV-02). | 자동 시험 | A | 시험: services/payment-svc/test-int/settlement-flow.int.test.ts, services/payment-svc/test/settlement-adjustment.test.ts |
| J-T36 | ⑨ | 정산서 수기 조정의 2인 승인(2026-11-23, F-07-5… | ⑨ payment가 적용을 커밋한 뒤 ops가 응답을 받지 못해 승인 업무가 `FAILED`이면, 그 승인을 반려해도 `REJECTED`가 되지 않고… | 자동 시험 | A | 시험: services/ops-svc/test-int/settlement-adjustment-approval.int.test.ts… |
| J-T37 | ① | 토스 지급대행 전송과 셀러 등록(2026-11-23, F-07-6… | ① 지급 요청·셀러 등록 본문은 JWE compact(`alg=dir`, `enc=A256GCM`, 사용자 머리 `iat`·`nonce`)이고 그 상점 보안… | 자동 시험 | A | 시험: services/payment-svc/test/settlement-toss-transport.test.ts |
| J-T37 | ② | 토스 지급대행 전송과 셀러 등록(2026-11-23, F-07-6… | ② 셀러 등록은 일반·에스크로 두 상점에 한 번씩 나가고 상점마다 `toss_seller` 한 행이 남는다. 계좌번호 원문은 DB·로그·응답에 0건이고 응답은… | 자동 시험 | A | 시험: services/payment-svc/test-int/settlement-toss-payout.int.test.ts, services/payment-svc/test/settlement-toss-seller.t… |
| J-T37 | ③ | 토스 지급대행 전송과 셀러 등록(2026-11-23, F-07-6… | ③ 셀러 상태는 단건 조회 결과로만 바뀐다. 웹훅 본문이 `APPROVED`여도 조회가 `KYC_REQUIRED`면 `KYC_REQUIRED`다. | 자동 시험 | A | 시험: services/payment-svc/test/settlement-toss-seller.test.ts |
| J-T37 | ④ | 토스 지급대행 전송과 셀러 등록(2026-11-23, F-07-6… | ④ 토스 정산서는 그 상점 셀러가 없거나 `APPROVAL_REQUIRED`·`PENDING`·`REJECTED`·`KYC_REQUIRED`면 지급 묶음에서… | 자동 시험 | A | 시험: services/payment-svc/test/settlement-toss-execute.test.ts, services/payment-svc/test/settlement-toss-seller.test.ts |
| J-T37 | ⑤ | 토스 지급대행 전송과 셀러 등록(2026-11-23, F-07-6… | ⑤ 한 상점의 시크릿 키나 보안 키 하나만 있거나 보안 키가 64자 hex가 아니면 시작하지 않는다. 두 상점 모두 설정이 없으면 지급 실행·셀러 등록은 503… | 자동 시험 | A | 시험: services/payment-svc/test/settlement-toss-assembly.test.ts |
| J-T37 | ⑥ | 토스 지급대행 전송과 셀러 등록(2026-11-23, F-07-6… | ⑥ 설정이 있으면 `start.ts` 조립이 실제 전송·지급 어댑터·잔액 원천·웹훅 수신기를 쓴다(시험 조립과 따로 띄워 본다). | 자동 시험 | A | 시험: services/payment-svc/test-int/settlement-toss-start.int.test.ts, services/payment-svc/test/settlement-toss-assembly… |
| J-T37 | ⑦ | 토스 지급대행 전송과 셀러 등록(2026-11-23, F-07-6… | ⑦ 공개 안내 모양으로 만든 대역 서버에 대해 경로, Basic 인증, `Idempotency-Key`, `Content-Type: text/plain`… | 자동 시험 | A | 시험: services/payment-svc/test/settlement-toss-transport.test.ts |
| J-T38 | ① | 토스 지급 묶음 자동 만들기, 실행 결과와 지급… | ① 실행이 접수되면 지급 건마다 결제사 지급 ID가 저장되고, 조각이 모두 접수된 정산서만 `SCHEDULED`와 `PAYOUT_SCHEDULED`(금액 =… | 자동 시험 | A | 시험: services/payment-svc/test-int/settlement-toss-payout.int.test.ts, services/payment-svc/test/settlement-toss-execute… |
| J-T38 | ② | 토스 지급 묶음 자동 만들기, 실행 결과와 지급… | ② 25억 원 정산서의 조각 3건 가운데 2건만 `COMPLETED`면 정산서는 `SCHEDULED` 그대로이고, 3건이 모두 끝나면 `PAID`와… | 자동 시험 | A | 시험: services/payment-svc/test-int/settlement-toss-payout.int.test.ts, services/payment-svc/test/settlement-toss-execute… |
| J-T38 | ③ | 토스 지급 묶음 자동 만들기, 실행 결과와 지급… | ③ 오류 응답이면 CS 처리함 `PAYOUT_ERROR` 한 건이 생기고 묶음은 `APPROVED`이며, 같은 묶음을 다시 실행하면 같은 키다. 예약 날짜… | 자동 시험 | A | 시험: services/payment-svc/test/settlement-toss-execute.test.ts |
| J-T38 | ④ | 토스 지급 묶음 자동 만들기, 실행 결과와 지급… | ④ 요청 직전에 지급 가능 잔액에서 이 묶음 밖의 끝나지 않은 토스 예약지급 합을 뺀 값이 보낼 금액보다 1원 적으면 보내지 않고 `PAYOUT_DELAYED`… | 자동 시험 | A | 시험: services/payment-svc/test/settlement-toss-execute.test.ts |
| J-T38 | ⑤ | 토스 지급 묶음 자동 만들기, 실행 결과와 지급… | ⑤ 묶음 때 보류된 정산서마다 `PAYOUT_HELD`, 상계로 남은 금액이 0이 된 미수금마다 `RECEIVABLE_CLOSED`가 그 트랜잭션에 남는다. | 자동 시험 | A | 시험: services/payment-svc/test-int/settlement-toss-payout.int.test.ts, services/payment-svc/test/settlement-toss-execute… |
| J-T38 | ⑥ | 토스 지급 묶음 자동 만들기, 실행 결과와 지급… | ⑥ CS 건 요청은 원인이 된 쓰기와 같은 트랜잭션의 `settlement_case_request`에 남는다. ops-svc가 503이어도 다음 30분 점검이… | 자동 시험 | A | 시험: services/ops-svc/test/cases.test.ts, services/ops-svc/test/cs-case-payout-kinds.test.ts 외 2곳 |
| J-T38 | ⑦ | 토스 지급 묶음 자동 만들기, 실행 결과와 지급… | ⑦ `settlement_payout_failed_total{pg,reason}`·`settlement_webhook_signature_invalid_total`… | 자동 시험 | A | 시험: services/payment-svc/test/settlement-toss-execute.test.ts |
| J-T38 | ⑧ | 토스 지급 묶음 자동 만들기, 실행 결과와 지급… | ⑧ 지급일 다음 영업일 12:00 KST가 되도록 끝나지 않은 토스 지급 건은 단건 조회로 확인해 반영하고(11:59:59.999에는 조회하지 않는다), 조회… | 자동 시험 | A | 시험: services/payment-svc/test/settlement-toss-execute.test.ts |
| J-T38 | ⑨ | 토스 지급 묶음 자동 만들기, 실행 결과와 지급… | ⑨ 지급일 전 영업일 09:00 KST에 정산 일꾼이 다음 은행 영업일 지급분 토스 확정 정산서를 결제 상점마다 `PREPARED` 묶음 하나로… | 자동 시험 | A | 시험: services/payment-svc/test-int/settlement-toss-payout.int.test.ts, services/payment-svc/test/settlement-toss-execute… |

## docs/security/asvs/settlement.md

| 항목 | 세부 | 제목 | 판정 기준 앞부분 | 상태 | 등급 | 근거 |
| --- | --- | --- | --- | --- | --- | --- |
| v5.0.0-1.1.1 | — | L2 | 입력은 그 형식으로 인코딩된 데이터가 기대될 때만 정규 형식으로 한 번만 디코딩(이스케이프 해제 포함)하고, 검증·정화 같은 다음 처리보다 먼저 한다. | 자동 시험 | B | 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/core-svc/test/fan-notify-http.test.ts 외 3곳 |
| v5.0.0-1.1.2 | — | L2 | 출력 인코딩·이스케이프는 그 값을 쓰는 해석기 바로 앞의 마지막 단계에서 하거나 해석기가 직접 한다. | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/model/golden.test.mjs, tools/web-checks/rich-text/seatmap-editor.spec.mj… |
| v5.0.0-1.2.1 | — | L1 | HTTP 응답·HTML·XML 출력은 문맥(HTML 요소·속성·주석, CSS, HTTP 헤더)에 맞게 인코딩해 메시지·문서 구조가 바뀌지 않게 한다. | 자동 시험 | B | 시험: apps/partner/src/_pages/seatmap-editor/model/import-check.test.mjs |
| v5.0.0-1.2.2 | — | L1 | URL을 동적으로 만들 때 신뢰하지 않는 값을 문맥에 맞게 인코딩하고 안전한 프로토콜만 허용한다(`javascript:`·`data:` 금지). | ID만 | B | 다른 곳 시험: apps/web/queue-room/test/preload.test.mjs, packages/api-client/test/policy.test.ts (영역: services/core-svc… |
| v5.0.0-1.2.3 | — | L1 | JavaScript·JSON을 동적으로 만들 때 인코딩·이스케이프해 구조가 바뀌지 않게 한다. | 자동 시험 | B | 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/ops-svc/test/ops-live.test.ts |
| v5.0.0-1.2.4 | — | L1 | 데이터 조회·DB 쿼리는 파라미터 쿼리, ORM 등으로 SQL 등 DB 주입을 막는다(저장 프로시저 포함). | 자동 시험 | B | 시험: services/ops-svc/test/ops-cases-http.test.ts |
| v5.0.0-1.2.5 | — | L1 | OS 명령 주입을 막고 OS 호출은 파라미터화하거나 명령줄 인코딩을 쓴다. | 해당 없음 | B | 해당 없음(OS 명령을 부르지 않는다. PDF는 라이브러리로 만든다) |
| v5.0.0-1.2.6 | — | L2 | LDAP 주입을 막는다. | 해당 없음 | B | 해당 없음(LDAP을 쓰지 않는다) |
| v5.0.0-1.2.7 | — | L2 | XPath 주입을 쿼리 파라미터화·사전 컴파일로 막는다. | 해당 없음 | B | 해당 없음(XPath를 쓰지 않는다) |
| v5.0.0-1.2.8 | — | L2 | LaTeX 처리기를 안전하게 설정하고(`--shell-escape` 금지) 명령 허용 목록을 쓴다. | 해당 없음 | B | 해당 없음(LaTeX을 쓰지 않는다) |
| v5.0.0-1.2.9 | — | L2 | 정규식의 특수 문자를 이스케이프해 메타 문자로 해석되지 않게 한다. | 해당 없음 | B | 해당 없음(사용자 값을 정규식에 넣지 않는다. 예금주 비교는 정해 둔 법인 표기 목록과 문자열 비교로 한다, settlement §3) |
| v5.0.0-1.3.1 | — | L1 | WYSIWYG 편집기 등에서 오는 신뢰하지 않는 HTML 입력은 모두 잘 알려진 안전한 HTML 정화 라이브러리나 프레임워크 기능으로 정화한다. | 해당 없음 | B | 해당 없음(이의 설명·조정 근거는 HTML을 받지 않는 평문이다) |
| v5.0.0-1.3.2 | — | L1 | `eval()` 같은 동적 코드 실행을 피하고, 불가피하면 사용자 입력을 실행 전에 정화한다. | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/security.test.mjs (영역: services/core-svc, services/ops-svc… |
| v5.0.0-1.3.3 | — | L2 | 위험할 수 있는 문맥에 넘기는 데이터는 그 문맥에 안전한 문자만 허용하고 너무 긴 입력을 자르는 등 미리 정화한다. | 자동 시험 | B | 시험: services/core-svc/test/review.test.ts, services/core-svc/test/search.http.test.ts 외 1곳 |
| v5.0.0-1.3.4 | — | L2 | 사용자가 준 SVG는 애플리케이션에 안전한 태그·속성만 담도록 검증하거나 정화한다(`script`·`foreignObject` 제외). | 해당 없음 | B | 해당 없음(SVG나 파일을 받지 않는다) |
| v5.0.0-1.3.5 | — | L2 | 사용자가 넣은 Markdown·CSS·XSL·BBCode 같은 스크립트·표현식 템플릿 내용을 정화하거나 끈다. | 해당 없음 | B | 해당 없음(이의 설명·조정 근거를 Markdown 같은 형식으로 해석하지 않고 평문으로만 보인다) |
| v5.0.0-1.3.6 | — | L2 | 다른 서비스를 부르는 데 쓰기 전에 신뢰하지 않는 값을 프로토콜·도메인·경로·포트 허용 목록과 대조하고 위험할 수 있는 문자를 정화해 SSRF를 막는다. | 자동 시험 | B | 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test-int/seatmap-import.int.test.ts 외 1곳 |
| v5.0.0-1.3.7 | — | L2 | 신뢰하지 않는 입력으로 템플릿을 만들지 않아 템플릿 주입을 막고, 불가피하면 템플릿에 넣는 신뢰하지 않는 입력을 정화하거나 엄격히 검증한다. | ID만 | B | 다른 곳 시험: services/realtime-gw/test-int/stream.int.test.ts, services/realtime-gw/test/hub.test.ts (영역:… |
| v5.0.0-1.3.8 | — | L2 | JNDI 조회에 넣기 전에 입력을 정화하고 JNDI를 안전하게 설정한다. | 해당 없음 | B | 해당 없음(JNDI를 쓰지 않는다) |
| v5.0.0-1.3.9 | — | L2 | memcache로 보내기 전에 내용을 정화한다. | 해당 없음 | B | 해당 없음(memcache를 쓰지 않는다) |
| v5.0.0-1.3.10 | — | L2 | 예상과 다르거나 악의적으로 해석될 수 있는 형식 문자열은 처리 전에 정화한다. | ID만 | B | 다른 곳 시험: apps/web/src/shared/i18n/catalog.test.mjs (영역: services/core-svc, services/ops-svc, services/payment-svc) |
| v5.0.0-1.3.11 | — | L2 | 메일 시스템에 넘기기 전에 사용자 입력을 정화해 SMTP·IMAP 주입을 막는다. | 빈칸 | B | 영역: services/core-svc |
| v5.0.0-1.4.1 | — | L2 | 메모리 안전한 문자열·메모리 복사·포인터 연산으로 스택·버퍼·힙 오버플로를 찾아내거나 막는다. | 해당 없음 | B | 해당 없음(애플리케이션 코드는 메모리 관리 언어(TypeScript)다) |
| v5.0.0-1.4.2 | — | L2 | 부호·범위·입력 검증으로 정수 오버플로를 막는다. | 자동 시험 | B | 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test/media-rules.test.ts 외 1곳 |
| v5.0.0-1.4.3 | — | L2 | 할당한 메모리와 자원을 해제하고 해제된 참조를 지워 use-after-free를 막는다. | 해당 없음 | B | 해당 없음(메모리 관리 언어만 쓴다) |
| v5.0.0-1.5.1 | — | L1 | XML 파서를 제한적으로 설정하고 외부 엔터티 해석 같은 위험 기능을 꺼 XXE를 막는다. | 해당 없음 | B | 해당 없음(XML을 파싱하지 않는다. XLSX는 만들기만 한다) |
| v5.0.0-1.5.2 | — | L2 | 신뢰하지 않는 데이터의 역직렬화는 허용 객체 타입 목록 등으로 안전하게 처리하고, 안전하지 않다고 알려진 방식은 쓰지 않는다. | 자동 시험 | B | 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/core-svc/test/sale-policy.http.test.ts 외 2곳 |
| v5.0.0-2.1.1 | — | L1 | 데이터 항목이 기대 구조에 맞는지 확인하는 입력 검증 규칙을 문서에 정의한다. | 자동 시험 | B | 시험: services/core-svc/test/sale-eligibility.http.test.ts, services/core-svc/test/sale-policy.http.test.ts 외 1곳 |
| v5.0.0-2.1.2 | — | L2 | 여러 데이터 항목을 함께 볼 때의 논리적·문맥적 일관성을 검증하는 방법을 문서에 정의한다. | 자동 시험 | B | 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test-int/sale-policy.int.test.ts 외 4곳 |
| v5.0.0-2.1.3 | — | L2 | 사용자별·시스템 전체의 업무 로직 한도와 검증 기대값을 문서화한다. | 자동 시험 | B | 시험: services/core-svc/test/fan-notify-http.test.ts, services/core-svc/test/search.http.test.ts |
| v5.0.0-2.2.1 | — | L1 | 입력이 업무·기능 기대를 만족하는지 허용 목록(값·패턴·범위)이나 미리 정한 규칙의 기대 구조·논리 한도로 검증하고, L1은 업무·보안 결정에 쓰는 입력에… | 자동 시험 | B | 시험: services/payment-svc/test-int/payment-checkout.int.test.ts, services/payment-svc/test-int/payment-deposit.int.test.t… |
| v5.0.0-2.2.2 | — | L1 | 입력 검증을 신뢰할 수 있는 서비스 계층에서 강제하고 클라이언트 검증에 의존하지 않는다. | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/model/save-answer.test.mjs… |
| v5.0.0-2.2.3 | — | L2 | 관련 데이터 항목의 조합이 미리 정한 규칙에 맞는지 확인한다. | 자동 시험 | B | 시험: services/core-svc/test-int/catalog.int.test.ts, services/core-svc/test-int/production-image.int.test.ts 외 27곳 |
| v5.0.0-2.3.1 | — | L1 | 같은 사용자의 업무 흐름을 정해진 순서대로만 처리하고 단계를 건너뛰지 못하게 한다. | 자동 시험 | B | 시험: services/core-svc/test/shop-order.http.test.ts, services/ops-svc/test/command-lifecycle-http.test.ts 외 5곳 |
| v5.0.0-2.3.2 | — | L2 | 문서화된 업무 로직 한도를 구현해 악용을 막는다. | 자동 시험 | B | 시험: services/payment-svc/test-int/payment-call-guard.int.test.ts, services/payment-svc/test-int/payment-entry-pause-judg… |
| v5.0.0-2.3.3 | — | L2 | 업무 로직 수준의 트랜잭션으로 작업이 전부 성공하거나 이전의 올바른 상태로 되돌아가게 한다. | 자동 시험 | B | 시험: services/core-svc/test-int/promoter-contract.int.test.ts, services/core-svc/test-int/shop-expiry.int.test.ts 외 30곳 |
| v5.0.0-2.3.4 | — | L2 | 한정 수량 자원이 로직 조작으로 이중 예약되지 않도록 업무 수준 잠금을 쓴다. | 자동 시험 | B | 시험: services/core-svc/test-int/promoter-contract.int.test.ts, services/core-svc/test-int/shop-expiry.int.test.ts 외 31곳 |
| v5.0.0-2.4.1 | — | L2 | 데이터 유출, 쓰레기 데이터, 할당량 소진, 레이트 리밋 위반, 서비스 거부, 비싼 자원 남용으로 이어지는 과도한 호출을 막는 자동화 방지 통제를 둔다. | 자동 시험 | B | 시험: services/core-svc/test-int/search-read-model.int.test.ts, services/core-svc/test/review.http.test.ts 외 14곳 |
| v5.0.0-3.2.1 | — | L1 | API 응답·사용자가 올린 파일 등이 잘못된 문맥(HTML 등)으로 그려지지 않게 한다(`Sec-Fetch-*`, CSP sandbox… | 자동 시험 | B | 시험: services/ops-svc/test/bot-review-http.test.ts |
| v5.0.0-3.2.2 | — | L1 | HTML이 아니라 글로 보일 내용은 `textContent` 같은 안전한 렌더링 함수로 다룬다. | 자동 시험 | B | 시험: apps/console-host/src/pages/bot-review/ui/wiring.test.mjs, apps/console-host/src/pages/cancellation/model/live.test… |
| v5.0.0-3.3.1 | — | L1 | 쿠키에 `Secure`를 두고, `__Host-`를 쓰지 않으면 이름에 `__Secure-` 접두사를 붙인다. | ID만 | B | 다른 곳 시험: apps/web/src/features/social-login/server/login-routes.test.mjs… |
| v5.0.0-3.3.2 | — | L2 | 쿠키마다 목적에 맞는 `SameSite`를 둬 CSRF 같은 공격 노출을 줄인다. | ID만 | B | 다른 곳 시험: apps/web/src/features/staff-approval/flow.test.mjs, apps/web/src/features/staff-invitation/flow.test.mjs 외 1곳… |
| v5.0.0-3.3.3 | — | L2 | 다른 호스트와 공유하도록 설계한 쿠키가 아니면 이름에 `__Host-` 접두사를 쓴다. | ID만 | B | 다른 곳 시험: apps/web/src/features/social-login/server/login-routes.test.mjs… |
| v5.0.0-3.3.4 | — | L2 | 스크립트가 읽을 필요 없는 쿠키(세션 토큰 등)는 `HttpOnly`이고 그 값은 `Set-Cookie`로만 보낸다. | ID만 | B | 다른 곳 시험: apps/web/src/features/social-login/server/login-routes.test.mjs, services/identity-svc/test/http.test.ts 외 2곳… |
| v5.0.0-3.4.1 | — | L1 | 모든 응답에 HSTS를 둔다(최대 기간 1년 이상, L2부터 하위 도메인 포함). | ID만 | B | 다른 곳 시험: deploy/gateways/test/gateways.test.mjs, services/v0-monolith/test/gateway-http-rules.test.ts 외 3곳 (영역:… |
| v5.0.0-3.4.2 | — | L1 | CORS `Access-Control-Allow-Origin`은 고정 값으로 두거나 요청의 `Origin`을 신뢰 출처 허용 목록과 대조해 정하고, `*`을… | ID만 | B | 다른 곳 시험: deploy/gateways/test/gateways.test.mjs, services/queue-svc/test/state-http.test.ts 외 1곳 (영역:… |
| v5.0.0-3.4.3 | — | L2 | HTTP 응답에 CSP를 둬 브라우저가 신뢰한 콘텐츠·자원만 싣고 실행하게 하고, 최소한 `object-src 'none'`·`base-uri 'none'`과… | 자동 시험 | B | 시험: apps/console-host/test/console-csp.test.mjs, apps/partner/src/_pages/seatmap-editor/security.test.mjs |
| v5.0.0-3.4.4 | — | L2 | 모든 응답에 `X-Content-Type-Options: nosniff`를 둔다. | ID만 | B | 다른 곳 시험: deploy/gateways/test/gateways.test.mjs, services/v0-monolith/test-int/seat.int.test.ts 외 4곳 (영역:… |
| v5.0.0-3.4.5 | — | L2 | 리퍼러 정책을 둬 URL 경로·쿼리 같은 기술적 민감 데이터가 `Referer` 헤더로 제3자 서비스에 새지 않게 한다. | ID만 | B | 다른 곳 시험: apps/web/src/shared/lib/staff-fragment.test.mjs, apps/web/src/widgets/app-shell/model/search-quality.test.mjs… |
| v5.0.0-3.4.6 | — | L2 | 모든 HTTP 응답에 CSP `frame-ancestors`를 둬 기본적으로 끼워 넣을 수 없게 하고, 필요한 자원만 끼워 넣기를… | ID만 | B | 다른 곳 시험: apps/web/src/_app/security/page-headers.test.mjs, deploy/gateways/test/gateways.test.mjs 외 5곳 (영역:… |
| v5.0.0-3.5.1 | — | L1 | CORS 사전 요청에 기대지 않는다면 민감 기능 요청이 애플리케이션에서 왔는지 확인한다(위조 방지 토큰, safelisted가 아닌 헤더 요구 등). | 자동 시험 | B | 시험: services/core-svc/test-int/production-image.int.test.ts |
| v5.0.0-3.5.2 | — | L1 | CORS 사전 요청에 기댄다면 사전 요청을 일으키지 않는 요청으로 그 기능을 부를 수 없게 한다(`Origin`·`Content-Type` 확인 등). | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/model/golden.test.mjs, apps/partner/src/_pages/seatmap-editor/model/save… |
| v5.0.0-3.5.3 | — | L1 | 민감 기능은 GET·HEAD·OPTIONS 같은 안전 메서드가 아닌 POST·PUT·PATCH·DELETE 같은 메서드로 부르거나, `Sec-Fetch-*`… | 자동 시험 | B | 시험: services/core-svc/test/seatmap-templates.http.test.ts, services/ops-svc/test/bot-review-http.test.ts |
| v5.0.0-3.5.4 | — | L2 | 서로 다른 애플리케이션을 다른 호스트 이름에 둬 동일 출처 정책의 제한을 쓴다. | ID만 | B | 다른 곳 시험: apps/web/src/features/wallet-device-key/pwa-config.test.mjs, apps/web/src/features/wallet-device-key/sw-rules.t… |
| v5.0.0-3.5.5 | — | L2 | `postMessage`로 받은 메시지는 출처를 믿을 수 없거나 형식이 틀리면 버린다. | 해당 없음 | B | 해당 없음: 정산 화면은 창 메시지(`postMessage`)를 받지 않는다. 토스페이먼츠 상점관리자와 포트원 콘솔은 운영자가 따로 연다 |
| v5.0.0-3.7.1 | — | L2 | 지원이 끝났거나 안전하지 않은 클라이언트 기술(플러그인, Flash 등)을 쓰지 않는다. | ID만 | B | 다른 곳 시험: tools/web-checks/console-csp/console.spec.mjs, tools/web-checks/console-csp/partner.spec.mjs (영역:… |
| v5.0.0-3.7.2 | — | L2 | 애플리케이션이 통제하지 않는 다른 호스트로 자동 이동시킬 때는 허용 목록에 있는 곳으로만 보낸다. | 자동 시험 | B | 시험: services/payment-svc/test-int/payment-checkout.int.test.ts, services/payment-svc/test-int/payment-merch-grpc.int.tes… |
| v5.0.0-4.1.1 | — | L1 | 본문이 있는 모든 HTTP 응답에 실제 내용과 맞는 `Content-Type`을 두고, 텍스트·XML처럼 IANA 미디어 타입이 정하는 경우 안전한 문자… | ID만 | B | 다른 곳 시험: services/purchase-svc/test/http.test.ts, services/v0-monolith/test-int/queue.int.test.ts (영역:… |
| v5.0.0-4.1.2 | — | L2 | 브라우저로 직접 여는 사용자 화면만 HTTP에서 HTTPS로 자동 리디렉션하고, 그 밖의 서비스·엔드포인트는 리디렉션하지 않는다. | 빈칸 | B | 영역: services/core-svc, services/ops-svc, services/payment-svc |
| v5.0.0-4.1.3 | — | L2 | 로드밸런서·프록시·BFF 같은 중간 계층이 넣어 애플리케이션이 쓰는 헤더(`X-Real-IP`·`X-Forwarded-*`·`X-User-ID` 등)는 최종… | ID만 | B | 다른 곳 시험: services/realtime-gw/test-int/stream.int.test.ts, services/v0-monolith/test/gateway-config.test.ts 외 5곳 (영역:… |
| v5.0.0-4.2.1 | — | L2 | 로드밸런서·방화벽 등 모든 구성요소가 HTTP 버전에 맞게 메시지 경계를 정해 요청 밀반입을 막는다(HTTP/1.x는 `Transfer-Encoding`이… | 빈칸 | B | 영역: services/core-svc, services/ops-svc, services/payment-svc |
| v5.0.0-4.3.1 | — | L2 | 허용 쿼리 목록, 깊이·개수 제한, 쿼리 비용 분석 가운데 하나 이상으로 비싼 중첩 쿼리에 의한 GraphQL·데이터 계층 표현식 서비스 거부를 막는다. | 해당 없음 | B | 해당 없음: 정산 지급 조회는 GraphQL이 아니라 REST다(관제 콘솔은 GraphQL을 쓰지 않는다, 2026-10-28 ADR-0100) |
| v5.0.0-4.3.2 | — | L2 | GraphQL을 외부에 공개하는 경우가 아니면 운영 환경에서 인트로스펙션을 끈다. | 해당 없음 | B | 해당 없음(GraphQL 미사용, ADR-0100) |
| v5.0.0-4.4.1 | — | L1 | 모든 WebSocket 연결에 WSS를 쓴다. | 해당 없음 | B | 해당 없음(정산 지급 기능은 연결을 열어 둔 채 서버와 브라우저가 주고받는 통신 방식인 WebSocket을 쓰지 않는다) |
| v5.0.0-4.4.2 | — | L2 | WebSocket 첫 HTTP 핸드셰이크에서 `Origin`을 허용 출처 목록과 대조한다. | 해당 없음 | B | 해당 없음(WebSocket 미사용) |
| v5.0.0-4.4.3 | — | L2 | 표준 세션 관리를 쓸 수 없으면 세션 관리 요구사항을 따르는 전용 토큰을 쓴다. | 해당 없음 | B | 해당 없음(WebSocket 미사용) |
| v5.0.0-4.4.4 | — | L2 | 전용 WebSocket 세션 토큰은 인증된 HTTPS 세션으로 처음 받거나 검증한다. | 해당 없음 | B | 해당 없음(WebSocket 미사용) |
| v5.0.0-8.1.1 | — | L1 | 인가 문서에 호출자 권한과 자원 속성에 따라 기능 수준·데이터 수준 접근을 제한하는 규칙을 정한다. | 자동 시험 | B | 시험: services/core-svc/test-int/search-read-model.int.test.ts, services/core-svc/test/event-summary.http.test.ts 외 2곳 |
| v5.0.0-8.1.2 | — | L2 | 인가 문서에 호출자 권한과 자원 속성(상태 등)에 따라 필드 수준 읽기·쓰기 접근을 제한하는 규칙을 정한다. | ID만 | B | 다른 곳 시험: services/realtime-gw/test-int/stream.int.test.ts, services/realtime-gw/test/hub.test.ts (영역:… |
| v5.0.0-8.2.1 | — | L1 | 기능 접근을 명시적 권한이 있는 호출자로 제한한다. | 자동 시험 | B | 시험: services/ops-svc/test-int/admin-accounts.int.test.ts, services/ops-svc/test/admin-accounts-authz.test.ts 외 6곳 |
| v5.0.0-8.2.2 | — | L1 | 데이터 접근을 그 데이터 항목에 명시적 권한이 있는 호출자로 제한해 IDOR·BOLA를 막는다. | 자동 시험 | B | 시험: services/core-svc/test-int/idempotency-rls.int.test.ts, services/core-svc/test-int/production-image.int.test.ts 외… |
| v5.0.0-8.2.3 | — | L2 | 필드 수준 접근을 그 필드에 명시적 권한이 있는 호출자로 제한해 BOPLA를 막는다. | 자동 시험 | B | 시험: services/core-svc/test-int/notify-role.int.test.ts, services/core-svc/test-int/rls.int.test.ts 외 7곳 |
| v5.0.0-8.3.1 | — | L1 | 인가 규칙을 신뢰할 수 있는 서비스 계층에서 강제하고 클라이언트 쪽 제어에 기대지 않는다. | 자동 시험 | B | 시험: services/core-svc/test/partner-bulkhead-auth.test.ts, services/ops-svc/test/command-lifecycle-http.test.ts |
| v5.0.0-8.4.1 | — | L2 | 다중 테넌트 애플리케이션은 테넌트 사이 통제로 호출자의 작업이 상호작용 권한이 없는 테넌트에 영향을 주지 않게 한다. | 자동 시험 | B | 시험: services/core-svc/test-int/export-audit.int.test.ts, services/core-svc/test-int/idempotency-migration.int.test.ts 외… |
| v5.0.0-11.1.1 | — | L2 | NIST SP 800-57 같은 키 관리 표준을 따르는 키 관리 정책과 키 수명 주기를 문서로 두고, 키를 필요 이상의 주체와 공유하지 않는다(공유 비밀은 두… | ID만 | B | 다른 곳 시험: services/ticket-svc/test-int/transfer.int.test.ts (영역: services/core-svc, services/ops-svc… |
| v5.0.0-11.1.2 | — | L2 | 애플리케이션이 쓰는 모든 암호 키·알고리즘·인증서의 암호 목록을 만들어 정기적으로 갱신하고, 키마다 쓸 수 있는 곳과 없는 곳, 보호할 수 있는 데이터와 없는… | 빈칸 | B | 영역: services/core-svc, services/ops-svc, services/payment-svc |
| v5.0.0-11.2.1 | — | L2 | 업계에서 검증된 암호 구현(라이브러리, 하드웨어 가속 구현)을 쓴다. | 자동 시험 | B | 시험: services/payment-svc/test/payment-method-ref.test.ts, services/payment-svc/test/settlement-toss-transport.test.ts |
| v5.0.0-11.2.2 | — | L2 | 난수·인증 암호화·MAC·해시 알고리즘, 키 길이, 라운드, 암호와 운용 모드를 언제든 바꿀 수 있고 키·비밀번호 교체와 데이터 재암호화도 할 수 있게… | 자동 시험 | B | 시험: services/ops-svc/test/audit-mac.test.ts |
| v5.0.0-11.2.3 | — | L2 | 모든 암호 기본 요소가 최소 128비트 보안 강도를 갖는다. | 자동 시험 | B | 시험: services/ops-svc/test/audit-checkpoint-bytes.test.ts, services/payment-svc/test/portone-gateway.test.ts |
| v5.0.0-11.3.1 | — | L1 | ECB 같은 안전하지 않은 블록 모드와 PKCS#1 v1.5 같은 약한 패딩을 쓰지 않는다. | 자동 시험 | B | 시험: services/payment-svc/test/settlement-toss-transport.test.ts, services/payment-svc/test/virtual-account-deposit.test… |
| v5.0.0-11.3.2 | — | L1 | AES-GCM처럼 승인된 암호와 운용 모드만 쓴다. | 자동 시험 | B | 시험: services/payment-svc/test-int/payment-deposit.int.test.ts, services/payment-svc/test/virtual-account-deposit.test.ts |
| v5.0.0-11.3.3 | — | L2 | 암호화한 데이터를 인증 암호화(또는 승인된 암호와 MAC의 조합)로 무단 변경에서 보호한다. | 자동 시험 | B | 시험: services/ops-svc/test-int/audit-chain-mac.int.test.ts, services/payment-svc/test-int/payment-deposit.int.test.ts 외… |
| v5.0.0-11.4.1 | — | L1 | 서명·HMAC·KDF·난수 생성 등 일반 암호 용도에는 승인된 해시 함수만 쓰고 MD5 같은 금지 함수는 쓰지 않는다. | 자동 시험 | B | 시험: services/ops-svc/test/audit-mac.test.ts, services/payment-svc/test/payout-adapters.test.ts 외 1곳 |
| v5.0.0-11.4.2 | — | L2 | 비밀번호는 현재 권고 파라미터를 적용한 승인된 비밀번호 해시 함수로 저장한다. | 해당 없음 | B | 해당 없음(이 기능은 비밀번호를 저장하지 않는다. 관리자 비밀번호는 계정·인증 추적 표에서 다룬다) |
| v5.0.0-11.4.3 | — | L2 | 서명·데이터 인증·무결성에 쓰는 해시는 충돌 저항성과 알맞은 출력 길이를 갖추고, 출력은 충돌 저항이 필요하면 256비트 이상, 제2 역상 저항만 필요하면… | 자동 시험 | B | 시험: services/ops-svc/test/audit-checkpoint-bytes.test.ts |
| v5.0.0-11.4.4 | — | L2 | 비밀번호에서 비밀 키를 만들 때 키 스트레칭 파라미터가 있는 승인된 KDF를 쓰고, 그 파라미터는 무차별 대입으로 키가 뚫리지 않게 보안과 성능을 맞춰 정한다. | 해당 없음 | B | 해당 없음(비밀번호에서 키를 파생하지 않는다. 보안 키는 결제사가 발급한 무작위 키다) |
| v5.0.0-11.5.1 | — | L2 | 추측되면 안 되는 모든 난수와 문자열은 CSPRNG로 만들고 128비트 이상의 엔트로피를 갖는다(UUID는 이 조건을 만족하지 않는다). | 자동 시험 | B | 시험: services/ops-svc/test-int/audit-chain-mac.int.test.ts, services/payment-svc/test/pg-selection.test.ts 외 2곳 |
| v5.0.0-11.6.1 | — | L2 | 키 생성·시드 생성과 디지털 서명 생성·검증에는 승인된 알고리즘과 운용 모드만 쓰고, 알려진 공격에 약한 키(페르마 인수분해에 약한 RSA 키 등)를 만들지… | 해당 없음 | B | 해당 없음(이 기능은 비대칭 키 생성이나 디지털 서명을 하지 않는다. TLS는 이 표의 V12(보안 통신) 절에서 다룬다) |
| v5.0.0-12.1.1 | — | L1 | TLS 1.2와 1.3처럼 권장되는 최신 버전만 켜고 가장 최신 버전을 우선한다. | ID만 | B | 다른 곳 시험: deploy/gateways/test/gateways.test.mjs, services/v0-monolith/test/gateway-server.test.ts (영역:… |
| v5.0.0-12.1.2 | — | L2 | 권장 암호 스위트만 켜고 가장 강한 스위트를 우선하며, L3는 순방향 비밀성을 주는 스위트만 지원한다. | 빈칸 | B | 영역: services/core-svc, services/ops-svc, services/payment-svc |
| v5.0.0-12.1.3 | — | L2 | mTLS 클라이언트 인증서가 신뢰된 것인지 확인한 뒤에만 그 신원으로 인증·인가한다. | 빈칸 | B | 영역: services/ops-svc, services/payment-svc |
| v5.0.0-12.2.1 | — | L1 | 클라이언트와 외부에 노출된 HTTP 서비스 사이의 모든 연결에 TLS를 쓰고, 안전하지 않거나 암호화되지 않은 통신으로 돌아가지 않는다. | ID만 | B | 다른 곳 시험: services/v0-monolith/test/gateway-config.test.ts, services/v0-monolith/test/gateway-server.test.ts 외 1곳 (영역:… |
| v5.0.0-12.2.2 | — | L1 | 외부에 노출된 서비스는 공인 TLS 인증서를 쓴다. | 빈칸 | B | 영역: services/core-svc, services/ops-svc, services/payment-svc |
| v5.0.0-12.3.1 | — | L2 | 애플리케이션에 들어오고 나가는 모든 연결(모니터링·관리 도구, 원격 접속, 미들웨어, DB, 파트너 시스템, 외부 API 등)에 TLS 같은 암호화 프로토콜을… | 자동 시험 | B | 시험: services/payment-svc/test/portone-config.test.ts, services/payment-svc/test/toss-config.test.ts |
| v5.0.0-12.3.2 | — | L2 | TLS 클라이언트가 서버 인증서를 검증한 뒤 통신한다. | ID만 | B | 다른 곳 시험: services/realtime-gw/test/config.test.ts (영역: services/core-svc, services/ops-svc, services/payment-svc) |
| v5.0.0-12.3.3 | — | L2 | 애플리케이션 안 내부 HTTP 서비스 사이의 모든 연결에 TLS 같은 전송 암호화를 쓰고, 안전하지 않거나 암호화되지 않은 통신으로 돌아가지 않는다. | 빈칸 | B | 영역: services/core-svc, services/ops-svc, services/payment-svc |
| v5.0.0-12.3.4 | — | L2 | 내부 서비스 사이 TLS는 신뢰한 인증서를 쓰고, 내부 발급·자체 서명 인증서를 쓰면 받는 서비스가 지정한 내부 CA와 지정한 자체 서명 인증서만 신뢰하게 한다. | 빈칸 | B | 영역: services/core-svc, services/ops-svc, services/payment-svc |
| v5.0.0-13.1.1 | — | L2 | 애플리케이션의 통신 필요(의존하는 외부 서비스, 사용자가 외부 위치를 줄 수 있는 경우 포함)를 모두 문서화한다. | ID만 | B | 다른 곳 시험: services/purchase-svc/test/consumers.test.ts (영역: services/core-svc, services/ops-svc, services/payment-svc) |
| v5.0.0-13.2.1 | — | L2 | 표준 사용자 세션을 쓰지 않는 백엔드 구성 요소 사이 통신을 개별 서비스 계정·단기 토큰·인증서로 인증하고, 바뀌지 않는 비밀번호·API 키를 쓰지 않는다. | 자동 시험 | B | 시험: services/core-svc/test/push-crypto.test.ts, services/payment-svc/test-int/portone-gateway.int.test.ts 외 3곳 |
| v5.0.0-13.2.2 | — | L2 | 백엔드 통신을 최소 권한 계정으로 한다. | 자동 시험 | B | 시험: services/payment-svc/test/portone-gateway.test.ts, services/payment-svc/test/toss-gateway.test.ts |
| v5.0.0-13.2.3 | — | L2 | 서비스 인증에 기본 자격 증명을 쓰지 않는다. | 자동 시험 | B | 시험: services/payment-svc/test/portone-config.test.ts, services/payment-svc/test/toss-config.test.ts |
| v5.0.0-13.2.4 | — | L2 | 애플리케이션이 통신할 수 있는 외부 자원의 허용 목록을 정의한다. | 자동 시험 | B | 시험: services/payment-svc/test/portone-config.test.ts, services/payment-svc/test/toss-config.test.ts |
| v5.0.0-13.2.5 | — | L2 | 서버가 요청을 보내거나 자원을 불러올 수 있는 대상의 허용 목록을 설정한다. | 자동 시험 | B | 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/payment-svc/test/portone-config.test.ts 외 1곳 |
| v5.0.0-13.3.1 | — | L2 | 키 보관소 같은 비밀 관리 도구로 백엔드 비밀을 안전하게 만들고 저장·접근 통제·폐기하며, 소스 코드와 빌드 산출물에 비밀을 넣지 않고, L3는 HSM 같은… | 자동 시험 | B | 시험: services/payment-svc/test/payment-method-ref.test.ts, services/payment-svc/test/portone-official-schema.test.ts 외 1곳 |
| v5.0.0-13.3.2 | — | L2 | 비밀 자산 접근은 최소 권한 원칙을 따른다. | ID만 | B | 다른 곳 시험: services/admission-ctrl/test/kms-seed-opener.test.ts, services/admission-ctrl/test/seed-reveal.test.ts 외 6곳… |
| v5.0.0-13.4.1 | — | L1 | 배포물에 `.git`·`.svn` 같은 소스 관리 메타데이터가 없거나, 있어도 외부와 애플리케이션 모두 접근할 수 없다. | ID만 | B | 다른 곳 시험: apps/web/server/standalone.test.mjs, apps/web/test-int/standalone-scm.build.test.mjs 외 2곳 (영역:… |
| v5.0.0-13.4.2 | — | L2 | 운영 환경의 모든 구성요소에서 디버그 모드를 끈다. | ID만 | B | 다른 곳 시험: packages/platform/test/problem.test.ts, services/pg-simulator/test/simulator.test.ts (영역: services/core-svc… |
| v5.0.0-13.4.3 | — | L2 | 의도한 경우가 아니면 웹 서버가 디렉터리 목록을 보여 주지 않는다. | ID만 | B | 다른 곳 시험: services/realtime-gw/test-int/stream.int.test.ts (영역: services/core-svc, services/ops-svc… |
| v5.0.0-13.4.4 | — | L2 | 운영 환경에서 HTTP TRACE 메서드를 지원하지 않는다. | ID만 | B | 다른 곳 시험: deploy/gateways/test/gateways.test.mjs, services/realtime-gw/test-int/stream.int.test.ts 외 1곳 (영역:… |
| v5.0.0-13.4.5 | — | L2 | 내부 API 문서와 모니터링 엔드포인트는 의도한 경우가 아니면 노출하지 않는다. | ID만 | B | 다른 곳 시험: deploy/workloads/test/worker-chart.test.mjs, packages/platform/test/metrics.test.ts 외 4곳 (영역:… |
| v5.0.0-14.1.1 | — | L2 | 애플리케이션이 만들고 처리하는 민감 데이터를 Base64·JWT 본문처럼 인코딩만 된 것까지 모두 찾아, 따라야 할 데이터 보호·개인정보 법규와 표준을 반영한… | 자동 시험 | B | 시험: services/core-svc/test-int/sale-eligibility.int.test.ts |
| v5.0.0-14.1.2 | — | L2 | 보호 등급마다 암호화, 무결성 검증, 보존, 로그 기록 방식과 로그 속 민감 데이터 접근 통제, DB 수준 암호화, 개인정보 보호 기술 같은 보호 요구사항을… | 자동 시험 | B | 시험: services/core-svc/test-int/sale-eligibility.int.test.ts |
| v5.0.0-14.2.1 | — | L1 | 민감 데이터는 HTTP 본문이나 헤더로만 서버에 보내고 URL·쿼리 문자열에 넣지 않는다. | 자동 시험 | B | 시험: services/core-svc/test/fan-notify-http.test.ts, services/core-svc/test/notify-worker.test.ts 외 1곳 |
| v5.0.0-14.2.2 | — | L2 | 민감 데이터가 로드밸런서·애플리케이션 캐시 같은 서버 구성요소에 캐시되지 않게 하거나 사용 뒤 안전하게 지운다. | 자동 시험 | B | 시험: services/core-svc/test-int/seatmap-save.int.test.ts, services/core-svc/test/seatmap-layout.test.ts |
| v5.0.0-14.2.3 | — | L2 | 정의된 민감 데이터를 신뢰하지 않는 제3자(사용자 추적 도구 등)에게 보내지 않는다. | 자동 시험 | B | 시험: services/core-svc/test/search.http.test.ts, services/payment-svc/test/portone-gateway.test.ts 외 1곳 |
| v5.0.0-14.2.4 | — | L2 | 보호 등급 문서에 정한 대로 암호화, 무결성 검증, 보존, 로그 기록 방식과 로그 속 민감 데이터 접근 통제, 개인정보 보호 기술을 구현한다. | 자동 시험 | B | 시험: services/core-svc/test-int/sale-eligibility.int.test.ts, services/core-svc/test/search-log.test.ts 외 5곳 |
| v5.0.0-14.3.1 | — | L1 | 클라이언트나 세션이 끝나면 브라우저 DOM 같은 클라이언트 저장소에서 인증 뒤 받은 데이터를 지우고, 서버에 연결되지 않을 때도 클라이언트가 스스로 지울 수… | ID만 | B | 다른 곳 시험: apps/web/queue-room/test/logout.test.mjs, apps/web/src/features/session-cleanup/routine.test.mjs 외 2곳 (영역:… |
| v5.0.0-14.3.2 | — | L2 | 민감 데이터가 브라우저에 캐시되지 않게 `Cache-Control: no-store` 등 캐시 방지 헤더를 둔다. | 자동 시험 | B | 시험: services/core-svc/test/fan-notify-http.test.ts |
| v5.0.0-14.3.3 | — | L2 | 브라우저 저장소(localStorage, sessionStorage, IndexedDB, 쿠키)에 세션 토큰 말고는 민감 데이터를 두지 않는다. | ID만 | B | 다른 곳 시험: apps/web/queue-room/test/autoassign.test.mjs, apps/web/src/_pages/seats/model/storage.test.mjs 외 2곳 (영역:… |
| v5.0.0-15.1.1 | — | L1 | 취약한 서드파티 구성요소와 라이브러리 갱신의 위험 기반 조치 기한을 문서에 정한다. | ID만 | B | 다른 곳 시험: tools/ci/vuln-deadline.test.mjs (영역: services/core-svc, services/ops-svc, services/payment-svc) |
| v5.0.0-15.1.2 | — | L2 | 모든 서드파티 라이브러리의 목록(SBOM)을 유지하고, 미리 정한 믿을 수 있고 계속 관리되는 저장소에서 오는지 확인한다. | ID만 | B | 다른 곳 시험: tools/ci/sbom-find.test.mjs, tools/web-checks/static/assets.test.mjs (영역: services/core-svc, services/ops-svc… |
| v5.0.0-15.1.3 | — | L2 | 시간이 오래 걸리거나 자원을 많이 쓰는 기능을 문서에 밝히고, 그 남용으로 가용성을 잃지 않는 방법과 응답 만들기가 호출자의 시간 초과보다 길어지지 않게 하는… | 자동 시험 | B | 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/ops-svc/test-int/f021-review-deadline.int.test.ts 외… |
| v5.0.0-15.2.1 | — | L1 | 문서에 정한 갱신·조치 기한을 넘긴 구성요소가 없다. | ID만 | B | 다른 곳 시험: tools/ci/min-versions.test.mjs (영역: services/core-svc, services/ops-svc, services/payment-svc) |
| v5.0.0-15.2.2 | — | L2 | 시간이 오래 걸리거나 자원을 많이 쓰는 기능에 문서대로 가용성 방어를 구현한다. | 자동 시험 | B | 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/core-svc/test/media-rules.test.ts 외 2곳 |
| v5.0.0-15.2.3 | — | L2 | 운영 환경에는 필요한 기능만 두고 시험 코드·예제·개발 기능을 노출하지 않는다. | 빈칸 | B | 영역: services/core-svc, services/ops-svc, services/payment-svc |
| v5.0.0-15.3.1 | — | L1 | 데이터 객체에서 필요한 필드만 돌려준다. | 자동 시험 | B | 시험: services/payment-svc/test-int/payment-new-pause.int.test.ts, services/payment-svc/test/payment-grpc.test.ts |
| v5.0.0-15.3.2 | — | L2 | 백엔드가 외부 URL을 부를 때 의도하지 않은 리디렉션을 따라가지 않는다. | 자동 시험 | B | 시험: services/payment-svc/test/portone-gateway.test.ts, services/payment-svc/test/toss-gateway.test.ts |
| v5.0.0-15.3.3 | — | L2 | 컨트롤러·액션마다 허용 필드를 제한해 대량 할당 공격을 막는다. | 자동 시험 | B | 시험: services/core-svc/test-int/seatmap-save.int.test.ts |
| v5.0.0-15.3.4 | — | L2 | 모든 프록시·미들웨어가 사용자의 원래 IP를 최종 사용자가 조작할 수 없는 신뢰 필드로 넘기고, 애플리케이션·웹 서버는 그 값을 로그와 레이트 리밋 같은 보안… | ID만 | B | 다른 곳 시험: deploy/gateways/test/gateways.test.mjs, tools/local/e2e/gateways.e2e.mjs (영역: services/core-svc… |
| v5.0.0-15.3.5 | — | L2 | 변수 타입을 확인하고 엄격한 동등·비교 연산을 써서 타입 혼동을 막는다. | ID만 | B | 다른 곳 시험: services/admission-ctrl/test-int/f021-leader-control.int.test.ts… |
| v5.0.0-15.3.6 | — | L2 | 프로토타입 오염을 막도록 JavaScript를 작성한다(객체 리터럴 대신 `Set`·`Map` 등). | ID만 | B | 다른 곳 시험: packages/api-client/test/policy.test.ts, packages/config/eslint/js-security.test.mjs 외 7곳 (영역: function… |
| v5.0.0-15.3.7 | — | L2 | HTTP 파라미터 오염 공격을 막는다. | ID만 | B | 다른 곳 시험: packages/platform/test/request-checks.test.ts, services/purchase-svc/test/read-seat-snapshot.test.ts 외 1곳 (영역:… |
| v5.0.0-16.1.1 | — | L2 | 기술 스택의 계층마다 어떤 이벤트를 어떤 형식으로 기록하는지, 로그를 어디에 두고 어디에 쓰는지, 접근을 어떻게 통제하는지, 얼마나 보관하는지를 적은 로그… | 자동 시험 | B | 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/core-svc/test/search-removal.test.ts 외 1곳 |
| v5.0.0-16.2.1 | — | L2 | 로그 항목에 언제, 어디서, 누가, 무엇을 같은 조사용 메타데이터를 넣는다. | 자동 시험 | B | 시험: services/core-svc/test-int/production-image.int.test.ts, services/ops-svc/test-int/command-lifecycle.int.test.ts 외… |
| v5.0.0-16.2.2 | — | L2 | 로그 구성요소의 시각을 동기화하고 UTC 또는 시간대 오프셋을 쓴다. | ID만 | B | 다른 곳 시험: packages/platform/test/request-log.test.ts, services/realtime-gw/test-int/stream.int.test.ts (영역:… |
| v5.0.0-16.2.3 | — | L2 | 로그 목록에 적힌 파일과 서비스로만 로그를 저장·전송한다. | ID만 | B | 다른 곳 시험: services/realtime-gw/test-int/stream.int.test.ts (영역: services/core-svc, services/ops-svc… |
| v5.0.0-16.2.4 | — | L2 | 쓰고 있는 로그 처리기가 로그를 읽고 서로 연관 지을 수 있게 하고, 되도록 공통 로그 형식을 쓴다. | 자동 시험 | B | 시험: services/ops-svc/test/ops-event-log.test.ts |
| v5.0.0-16.2.5 | — | L2 | 민감 데이터는 보호 등급에 따라 로그에 남긴다(자격 증명·결제 정보는 남기지 않고, 일부는 해시·마스킹). | 자동 시험 | B | 시험: services/core-svc/test-int/sale-eligibility.int.test.ts, services/core-svc/test-int/shop-refund-account.int.test.ts… |
| v5.0.0-16.3.1 | — | L2 | 성공·실패를 포함한 모든 인증 작업을 기록하고, 인증 방식이나 쓴 인증 요소 같은 메타데이터도 남긴다. | ID만 | B | 다른 곳 시험: services/payment-svc/test-int/payment-webhook.int.test.ts, services/payment-svc/test/payment-webhook.test.ts 외… |
| v5.0.0-16.3.2 | — | L2 | 실패한 인가 시도를 기록하고, L3는 민감 데이터 접근을 포함한 모든 인가 결정을 그 데이터는 빼고 기록한다. | 자동 시험 | B | 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test-int/sale-eligibility.int.test.ts 외… |
| v5.0.0-16.3.3 | — | L2 | 문서화한 보안 이벤트와 보안 통제를 우회하려는 시도를 기록한다. | 자동 시험 | B | 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test-int/sale-eligibility.int.test.ts 외… |
| v5.0.0-16.3.4 | — | L2 | 예상하지 못한 오류와 보안 통제 실패를 기록한다. | 자동 시험 | B | 시험: services/ops-svc/test/bot-review-judgement.test.ts, services/payment-svc/test-int/payment-call-guard.int.test.ts 외… |
| v5.0.0-16.4.1 | — | L2 | 모든 로그 구성요소가 로그 주입을 막도록 데이터를 인코딩한다. | 자동 시험 | B | 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/core-svc/test/seatmap-recheck.test.ts |
| v5.0.0-16.4.2 | — | L2 | 로그를 권한 없는 접근과 수정에서 보호한다. | 자동 시험 | B | 시험: services/ops-svc/test-int/audit-chain-mac.int.test.ts |
| v5.0.0-16.4.3 | — | L2 | 로그를 분석·탐지·경보용으로 논리적으로 분리된 시스템에 안전하게 보낸다. | 빈칸 | B | 영역: services/core-svc, services/ops-svc, services/payment-svc |
| v5.0.0-16.5.1 | — | L2 | 예상하지 못한 오류나 보안상 민감한 오류에는 일반 메시지를 돌려주고 내부 정보를 드러내지 않는다. | ID만 | B | 다른 곳 시험: deploy/gateways/test/limits-errors.test.mjs, packages/platform/test/problem.test.ts 외 2곳 (영역:… |
| v5.0.0-16.5.2 | — | L2 | 외부 자원 접근이 실패해도 안전하게 동작한다. | 자동 시험 | B | 시험: services/core-svc/test/search.http.test.ts, services/ops-svc/test-int/f022-pg-switch-e2e.int.test.ts 외 30곳 |
| v5.0.0-16.5.3 | — | L2 | 예외가 나도 안전하게 실패하고, 검증 오류가 있는데도 거래를 처리하는 fail-open을 막는다. | ID만 | B | 다른 곳 시험: packages/platform/test/circuit-breaker.test.ts, services/core-svc/test-int/production-image.int.test.ts 외 71곳… |
| v5.0.0-2.3.5 | — | L3 | 고가치 업무 흐름에는 여러 사람의 승인을 요구한다. | 자동 시험 | B | 시험: services/ops-svc/test/command-lifecycle-http.test.ts |
| v5.0.0-11.2.4 | — | L3 | 모든 암호 연산을 상수 시간으로 하고 비교·계산·반환에서 조기 종료하지 않아 정보가 새지 않게 한다. | 자동 시험 | B | 시험: services/core-svc/test/internal-sale-config-token-boot.test.ts |
| v5.0.0-13.1.4 | — | L3 | 보안에 핵심인 비밀과 그 교체 일정을 위협 모델에 따라 문서로 정한다. | ID만 | B | 다른 곳 시험: deploy/workloads/test/workloads.test.mjs, tools/ci/alert-rules.test.mjs 외 1곳 (영역: services/core-svc… |
| v5.0.0-14.2.6 | — | L3 | 기능에 필요한 최소한의 민감 데이터만 돌려주고, 전체가 필요하면 사용자가 일부러 볼 때가 아니면 화면에서 가린다. | ID만 | B | 다른 곳 시험: apps/console-host/src/entities/fraud-case/model.test.mjs, services/invariant-checker/test-int/invariants.int.te… |
| v5.0.0-1.2.10 | — | L3 | CSV·수식 삽입을 막는다. CSV를 내보낼 때 RFC 4180 §2.6·§2.7의 이스케이프 규칙을 따르고, CSV·XLSX 같은 스프레드시트 형식에서는 칸… | 빈칸 | B | 영역: apps/partner, services/payment-svc |
