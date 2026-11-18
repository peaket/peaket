# ADR-0284: 탈퇴 참여자는 identity-svc가 묻고, 미룬 탈퇴는 identity-svc의 다시 하기 고리가 끝낸다(2026-11-18)

- **상태**: 채택(추천 적용, 2026-11-18, BAT-010 계획). 묶음 BAT-010(PRF-169)의 계획 담당이 정본 빈칸을 구현 전에 정했다(docs/architecture.md §8.6 4의 2). [ADR-0062](0062-open-items-delegated-decisions.md)(탈퇴 때 티켓·주문 처리 표)·[ADR-0073](0073-third-consistency-audit-delegated-decisions.md) 결정 5(탈퇴 유예 `WITHDRAWAL_PENDING`)를 구현할 길을 정하고, 정책은 바꾸지 않는다.
- **관련**: [docs/features/identity.md](../features/identity.md) §8 '탈퇴 참여자와 탈퇴 미룸의 첫 구현', [docs/features/payment.md](../features/payment.md) §2 '주문 생성의 첫 구현'의 '탈퇴 미룸 409'와 §4.1 '탈퇴 참여자의 첫 구현', [docs/planning/03-policies-glossary.md](../planning/03-policies-glossary.md) §1.5 ⑤⑧, `docs/api/proto/peaket/purchase/v1/account.proto` `WithdrawalParticipantService`, `docs/api/proto/peaket/identity/v1/identity.proto` `GetVerificationStatusResponse.withdrawal_pending`
- **관련 ID**: I-T84, P-T55, FR-017, POL-033

## 맥락

- 정본은 '다른 서비스의 정리는 탈퇴 참여자에 묻고 실행한다', '결제 결과를 기다리는 주문이 있으면 202로 미루고 그동안 `WITHDRAWAL_PENDING`', '미루는 동안 새 주문은 409', '입금 대기 주문은 취소한다'까지 정했다(identity §8, planning/03 §1.5 ⑤⑧). 그러나 참여자 계약의 모양, 누가 언제 다시 묻는지, 참여자가 답하지 못할 때의 상태, purchase-svc가 409를 낼 근거는 정본에 없었다.
- 주문 생성은 이미 identity-svc의 본인확인 재확인(`GetVerificationStatus`)을 부르고, 탈퇴 유예 계정은 그 답이 verified 거짓이라 403으로 끝났다. payment.md §2는 '재확인 응답에 사유를 더하는 일은 PRF-169'라고 넘겼다.
- 입금 전 취소(`CancelPayment`의 입금 대기 갈래)는 HOT-152가 만들었고 같은 취소 ID로 다시 불러도 결과가 같다. 결제사 호출은 되돌릴 수 없다.

## 결정

1. **참여자 계약**: 참여자는 받는 서비스마다 gRPC 하나다. purchase-svc는 `WithdrawalParticipantService.ProcessAccountWithdrawal(account_id)`를 연다. 한 번 부르면 그 계정의 정리를 할 수 있는 만큼 하고(입금 대기 주문 취소), 남은 것이 없으면 `DONE`, 있으면 `PENDING`과 이유를 돌려준다. 읽기와 멱등 취소만 하므로 다시 불러도 된다. 뒤에 붙을 참여자(ticket-svc·core-svc)도 같은 모양으로 둔다.
2. **차례**: identity-svc는 재인증 토큰을 쓰는 트랜잭션에서 계정을 먼저 `WITHDRAWAL_PENDING`(정리 사유 `WITHDRAWAL`)으로 둔 뒤 트랜잭션 밖에서 참여자를 부른다. 되돌릴 수 없는 결제사 취소가 탈퇴 의사가 기록되기 전에 나가지 않게 하려는 것이다. 모든 참여자가 `DONE`이면 그 요청 안에서 지금의 끝내기(`DELETED`, 세션 끝내기, 탈퇴 사건)를 하고 204, 아니면 202다.
3. **모르면 미룬다**: 참여자가 답하지 않거나, 기한을 넘기거나, 모르는 값을 주면 `DONE`으로 접지 않고 202로 미룬다. 계정은 `WITHDRAWAL_PENDING` 그대로다.
4. **미룬 탈퇴의 끝내기**: identity-svc API 파드의 다시 하기 고리가 다음 확인 시각이 된 미룬 계정을 행 잠금으로 나눠 잡아 참여자를 다시 묻고, 모두 `DONE`이면 끝낸다. 팬이 다시 요청하지 않아도 끝난다. purchase-svc가 주문이 끝날 때 알리는 사건 길은 두지 않는다(새 토픽과 소비자가 필요하고, 1분 간격의 다시 묻기로 '보통 10분 안'을 지킨다).
5. **409의 근거**: purchase-svc는 탈퇴 상태를 따로 저장하지 않는다. 주문 생성의 재확인 답에 `withdrawal_pending`을 더해, 참이면 403 대신 409 `withdrawal-pending`으로 답한다(payment.md §2가 넘긴 길).
6. **결제 결과를 기다리는 주문**: 결제 결과가 아직 정해지지 않은 주문 상태(CREATED·AUTHENTICATED·ACCEPTED·RESERVED·UNKNOWN)를 모두 센다. CREATED는 결제 접수 전이지만, 탈퇴 전에 받은 액세스 토큰(최대 15분)으로 결제를 시작할 수 있어 끝날 때(만료나 결과)까지 기다린다.

세부 값(간격·기한·상한)은 identity §8과 payment §4.1의 그 절이 정본이다.

## 결과

- 탈퇴 요청 하나가 참여자 기한(identity §8)만큼 길어질 수 있다. 그 안에 결제사 취소가 끝나지 않으면 202이고 고리가 같은 취소 ID로 마친다.
- 미룬 동안 팬은 로그인하고 세션을 쓴다. 토큰에는 지금처럼 `ticket:buy`가 없다(identity §8).
- identity DB `account`에 다음 확인 시각 칸이 생기고, purchase DB `purchase_order`에 계정 인덱스가 생긴다(docs/data.md).

## 되돌릴 조건

- 다시 묻기가 purchase DB나 결제사 호출에 눈에 띄는 부하(미룬 계정이 늘 100개 [가정]를 넘음)를 만들면 purchase-svc가 주문이 끝날 때 사건을 내는 길로 바꾼다.
- 참여자가 셋 이상이 되어 차례(티켓 취소 뒤 입금 대기 취소 등)가 필요해지면 참여자 계약에 단계를 더하는 새 ADR을 쓴다.

## 확인

- I-T84(identity 쪽)와 P-T55(purchase 쪽)가 정본의 판정 기준대로 돈다.
- `python -I -X utf8 tools/doc-check/check_all.py`에 이 변경이 만든 오류가 없다.
