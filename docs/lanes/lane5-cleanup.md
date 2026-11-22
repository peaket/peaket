# 갈래 5 — 구간 끝 정리 목록

- **독자와 용도**: 갈래 5가 묶음 중에 찾았지만 그 묶음에서 고치지 않은 중간·낮은 지적과 남은 일을 모은다. 구간 마무리 때 한 번에 고치고, 고친 줄은 지운다(ADR-0190 결정 2, ADR-0283 결정 6). 공용 턴 규칙은 [docs/PROGRESS.md](../PROGRESS.md)다.

## BAT-600(LCH-010·020, 2026-11-19)

리뷰 지적 번호는 `docs/review/plans/BAT-600.md` '리뷰' 절의 것이다.

- RV-03(중간): 같은 계정의 앞 주문이 새 주문을 만드는 도중에 결제 접수되면 계정당 한도를 넘을 수 있다. 결제 접수 때 한도를 다시 보지 않는다.
- RV-05(낮음): 결제 시도 응답에 `holdExpiresAt`을 싣는데 openapi는 싣지 않는다고 적혀 있다. 계약과 응답을 맞춘다.
- RV-06(낮음): 굿즈 결제 시도에서 `VIRTUAL_ACCOUNT`를 400으로 거절하는 것이 openapi 설명에 없다.
- RV-07(낮음): 재고 Redis 장애 때 만료 작업이 한 주문에서 멈춰, 그 바퀴의 남은 주문이 다음 바퀴로 밀린다.
- RV-08(낮음): 결제 상태 롱 폴링이 화면 연결이 끊겨도 25초 동안 DB를 읽는다.
- RV-10(낮음): 미수령 대상을 1,000건으로 자르는 방식 때문에 환급이 다음 영업일로 밀리거나, 한 주문의 환급이 두 건으로 나뉠 수 있다(금액 합은 맞다).
- RV-11(낮음): 같은 `Idempotency-Key`로 거의 같은 때 두 번 보내면 앞 주문을 만료시키고 그 만료된 주문을 201로 돌려준다(과금은 없다).
- RV-12(낮음, 다시 리뷰): 택배 주문 503 `pg-unavailable`에 기본값 `Retry-After: 2`가 붙는다. BAT-605 전까지는 다시 보내도 풀리지 않는 503이라 헛된 다시 보내기를 부른다.
- 검증의 얕은 단언 둘: P-T58 ③ '결제사 취소 1건'은 가짜 결제 포트의 같은 취소 ID로만 보고, P-T58 ① '카운터 그대로'는 e2e만 본다.
- 단계가 없는 일 둘(전체 감독이 묶음을 정할 것): 파트너가 수령 시간대를 만드는 API·화면(계약에 없어 시험은 시험 데이터로 넣었다), 인기 MD 대기열.
- 흔들린 시험(묶음과 무관, 따로 다시 돌리면 통과): core-svc `test/fill-search-guard.test.ts`(5초 시간 초과, 몰릴 때), `test/internal-notify.test.ts`, purchase-svc `grpc-new-payment-pause`·`cancel-ticket-event-cancelled`(전체로 돌릴 때만). `tools/ci/roles-check.test.mjs`는 묶음 실행에서 15분 제한에 걸렸다(따로 23분, 84개 통과).
- ticket-svc에는 (account_id, event_id) 인덱스가 없어 `ListHeldTickets`가 계정 인덱스 안에서 회차를 거른다.
- 다시 올리기: 자기 작업 가지의 `--force-with-lease` 푸시가 세션 권한 판정에 막혀, 다시 올릴 때마다 새 가지·새 초안 PR을 열었다(`feature/lane5-BAT-600-r2`·`-r3`). 시험 담당의 포크 다섯이 Docker 잠금을 따로 잡은 일(2026-11-18 23:20~23:40)은 근거에서 빼고 다시 돌렸다.
- (2026-11-23 FIX-payment-int 리뷰 RV-02, 중간) 불변식 검사기가 미수금 이동 표를 `receivable_movement`로 찾는다(`services/invariant-checker/src/tables.ts` 35줄, `src/invariants.ts` 45줄 M3). 실제 표는 0016부터 `receivable_move`라 실제 DB에서 M3(미수금 남은 금액 = 금액 − 이동 합)가 건너뜀으로 끝나고, 검사기 시험은 손으로 만든 `receivable_movement` 표를 써 못 본다. 아래 ERD 줄과 함께 고친다.
- (2026-11-23 FIX-payment-int 계획) `docs/data.md` §2 ERD에 payment 0025·0026 표 셋(`payout_batch_audit`·`guarantee_collection`·`settlement_webhook_receipt`)과 `seller_kyc.toss_seller_id`·`toss_seller_status`가 없고, ERD의 `receivable_movement`와 실제 `receivable_move` 이름이 다르다(BAT-625·630이 data.md를 함께 고치지 않음).

## F-07-5(2026-11-23, R-781)

- C-01(중간): `trade.settlements` 소비자(core notify → 파트너 웹훅 `statement.notified`·이메일)가 없어 파트너는 목록으로만 통지를 본다(GAT-270 운영 전 몫).
- C-02(낮음): 운영 Kafka 토픽 `trade.settlements` 준비(인프라). 로컬·CI 객체 목록에만 더했다.
- C-03(낮음): 정산 일꾼 한 tick의 자동 확정 100건 상한 — 큰 회차 수에서 30분씩 밀린다.
- C-04(낮음): 지급일은 아직 주말만 뺀 날짜(은행 영업일 달력 출처 확인 필요, settlement §5.1). 배포 환경 값에 `PEAKET_HOLIDAY_CALENDAR_FILE`이 없어 이의 기한도 주말만 뺀다(리뷰 RV-16).
- C-05(낮음): 조정 근거 메모 원문은 payment에만 있고 ops 승인 업무에는 앞 200자 [가정]만 보인다(SCR-046 때 정함).
- 리뷰 낮음·중간: RV-06(주 첫 영업일 06시 한 시간 안 실패면 그 주 상품 정산서를 다시 계산하지 않음, 중간), RV-10(인가 실패 로그 `accountId`가 가려짐 → 가명 참조), RV-11(파트너 이의 `Idempotency-Key` 받고 안 씀), RV-12(UUID 아닌 정산서 ID 500 가능), RV-13(조정 요청 멱등 대조가 이의 ID 안 봄), RV-14(NOTIFIED 조정 적용 뒤 이의 기한 짧아짐), RV-15(계약 `SettlementStatement`에 조정 합계 칸 없음), RV-17(ops-svc `openapi:emit` 없음 — D-T38 대상 밖), RV-19(옛 DISPUTED 중 이의가 모두 닫힌 행을 풀 길 없음), RV-20(`demo-objects.mjs` 토픽 수 주석), RV-21(상품 항목 환급 ≤ 판매 대금 보장 없음·수수료율 9,091bp 넘으면 계산 지급액 음수), RV-22(EXECUTING 반려 허용이 정본·시험에 없음).
- 시험: E-02 ops-svc 통합 시험이 CI `ci-node.yml` 통합 잡에 없다(TA-V15). 검증 2가 놓친 통합 표본 D-1a·b(조건부 갱신의 묶음 없음·조정 합계 조건, 지금은 다른 조건이 막음 — LCH-110이 묶음을 따로 바꾸면 시험 필요)·D-2d(`resolution_note` 1~2,000자 DB 제약을 보는 통합 시험 없음).
- 상품 정산서: core 원천이 지금 항목 상태로 거르므로, 정산 기준일 뒤·그 주 계산 전 전액 환급 항목이 판매·환급 양쪽에서 빠진다(지급액·수수료는 같고 두 칸 합계만 정본 §4.5와 다름).
- 흔들림 후보(2026-11-23 FIX-payment-int 합치기 때): BAT-215·220 뒤 트리의 payment 통합 전체에서 `payment-process` PRF180 설정 시험·`purchase-path-e2e` V4 ③·P-T25 둘이 부하 중 실패, 두 파일만 다시 돌리면 28 통과.
- 남은 폴더: `D:/ticketpass-lane5-F-07-5-pre`(실패 확인용 작업 폴더, worktree 등록은 지웠으나 긴 경로로 폴더가 남음. 지우기 명령이 막혀 소유자 몫).
