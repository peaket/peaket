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
- **R-785로 고침(2026-11-23 FIX-invariant-m3 단계 ①: payment 0028이 표를 정본 이름 `receivable_movement`로 바꾸고 옛 이름 뷰를 둠, 검사기가 실제 payment DB에서 M3를 셈)** (2026-11-23 FIX-payment-int 리뷰 RV-02, 중간) 불변식 검사기가 미수금 이동 표를 `receivable_movement`로 찾는다(`services/invariant-checker/src/tables.ts` 35줄, `src/invariants.ts` 45줄 M3). 실제 표는 0016부터 `receivable_move`라 실제 DB에서 M3(미수금 남은 금액 = 금액 − 이동 합)가 건너뜀으로 끝나고, 검사기 시험은 손으로 만든 `receivable_movement` 표를 써 못 본다. 아래 ERD 줄과 함께 고친다.
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

## FIX-problem-types(2026-11-23, R-784)

- 리뷰 RV-03(정보): ops `settlement-dependency-unavailable`·`payout-dependency-unavailable` 503에 `Retry-After`가 없다(guidelines §2 필수 경우는 아님). FIX-problem-ctor에서 함께 본다.
- 검증: `packages/platform/turbo.json` 입력 표본(S5·S6)은 상시 시험이 없어 `turbo --dry=json` 열쇠를 손으로 견줘야만 잡힌다.
- 남은 폴더: `D:/l5ptpre`(실패 확인용, worktree 등록은 지움, 설치 찌꺼기가 남음 — 지우기 명령이 막혀 소유자 몫).

## FIX-invariant-m3(2026-11-23, R-785)

- **출시 태그 기다림 ②**: payment-svc 저장소를 새 이름 `receivable_movement`로 바꾸고 `receivable-move-compat.ts`를 지우며 시험의 날 SQL을 바꾼다(마이그레이션 없음). 조건: 0028이 든 출시 태그가 나온 뒤, 그다음 출시에 넣는다. 그 출시 때 미수금 표를 만지는 기능이 있으면 그 안에서, 없으면 FIX로(감독 결정 2026-11-23).
- **출시 태그 기다림 ③**: `DROP VIEW "receivable_move"`와 NOT NULL 제약 이름 여섯(`receivable_move_*_not_null`, PostgreSQL 18은 표 이름을 바꿔도 따라 바꾸지 않음) `RENAME CONSTRAINT`, 그때 PRF180 M3 ⑦의 `contype <> 'n'` 조건을 지운다. 조건: ②가 든 출시가 나가고 7일 [가정] 뒤(devops §7.1 N+2).
- 리뷰 RV-03(낮음): 뷰는 `security_invoker`라 앱 역할에 뷰와 표 둘 다의 권한이 필요하다. 표마다 GRANT 목록을 쓰는 단계(BAS-060 등)가 뷰를 빠뜨리지 않게 한다.
- 칸 차이: ERD `receivable_movement`의 `created_at`·`reverses_id`·`statement_id` 널 허용과 0016·0026의 `moved_at`·`reverses_id` 없음·`statement_id NOT NULL`이 다르다. 되돌림(`REVERSAL`)을 처음 쓰는 단계 전에 맞춘다.
- v0 실행 도구(리뷰 RV-02): `loadtest/run.mjs` `runInvariants`는 기대 SKIPPED 목록을 대조하지 않고, `v0_check`에 정산 표가 없어 v0 실행마다 M1~M5 '원본에 표 없음' 경고가 난다. v0 기대 목록을 두고 기대한 표 없음은 경고에서 빼는 일.
- purchase·ticket 원본 표도 서비스 마이그레이션을 적용한 DB로 시험하는 일(지금은 손으로 만든 표).
- CLAUDE.md 상대 경로 가져오기 목록: invariant-checker 통합 시험이 `services/payment-svc/scripts/migrate.mjs`를 읽는다(소유자 몫).
- 흔들림 후보: payment `payment-confirm-runner.int.test.ts` P-T40 리뷰 고침 H1(부하 중 `payment_event` Seq Scan), 단위 `drizzle-payment-store` P-T54 M4(249ms < 250ms 시간 단언), `payment-checkout.int.test.ts` P-T26(전체 실행 때 한 번).

## F-07-6(2026-11-23, R-796)

- 시험 리뷰 TR-18(낮음): 늦게 도착한 옛 셀러 사실(`checkedAt`이 더 이른 것)을 쓰지 않는 차례 규칙이 정본에 없다.
- 시험 리뷰 남은 것 2: 잔액 대사의 수수료 조회가 앞 대사 날짜부터 양끝을 포함해, 그날 날짜의 정산 행을 두 번 셀 수 있다(C-03 [가정]).
- 시험 리뷰 TR-14 일부: 토스 전송 시간 한도 시험 없음.
- E-02 [가정]으로 남은 셋: `iat` 꼴 다른 꼴 허용 여부, 공개 셀러 상태 넷과 PEAKET `PENDING`·`REJECTED`, HMAC 키 인코딩(문서에 없음).
- 흔들림 후보(부하 중 단위·통합 시간 초과, 단독 통과): payment `settlement-business-calendar`·`settlement-notify-dispute`·`settlement-toss-seller`·`tenant-rate-limit-wiring`·`payment-checkout` P-T26·`payment-sub-provider` P-T46 ④·`payment-entry-pause-judge` P-T43·`payment-grpc` P-T53, ops `cs-inbox-screen-link` R-T51 ①·J-T35 ⑦.
- 작업 폴더의 `apps/web/.next/types` 옛 빌드 산출물이 typecheck를 한 번 깨뜨렸다(gitignore된 것, 지우면 통과).

## FIX-ops-adjust-race(2026-11-23)

- 시험 리뷰 낮음: TR-01 `[200,409]` 길(approval-conflict·approval-not-pending)을 차례 고정한 시험이 없다. TR-02 갈고리 안 expect 실패가 5xx로 바뀌어 실패 까닭이 흐려진다. TR-03 `expectSettledOnce`의 approver_id 비교는 같은 행 값이라 늘 참(requester_id만 실제로 봄). TR-04 같은 EXECUTING 겹침을 결정 시험은 J-T36 ④, 단위는 J-T36 ⑨ ②로 부른다 — 정본 §13 J-T36 ⑨에 한 줄 더하고 번호를 맞춘다. TR-05 실패 확인 기록 없음(구현이 이미 RV-04대로).
- 같은 꼴 `[200,409]` 단언이 있는 다른 모듈(ops approval-request·payout-approval·command-lifecycle·event-cancellations)은 까닭이 달라 그대로 두었다.

## F-07-7(2026-11-23, R-803)

- C-08 [가정]: 포트원 이체 원장 `balance`의 뜻·콘솔 출금 `withdrawalType`·포트원 수수료 셈법(잔액 대사 수수료 0 [가정])은 공개 명세를 읽은 [가정] — 시험 환경에서 먼저 확인. U-03 포트원 수기 정산건이 PEAKET이 정한 `id`를 받는지(실행 멱등이 기댐) 계약 전 첫 확인 항목.
- C-11(낮음): 은행 대응표가 `packages/validation`과 `portone-platform-shapes.ts` 두 곳에 있다 — 한 파일로.
- C-12(낮음): core가 사업자 형태를 사업자등록번호 가운데 두 자리로 추정 [가정] — 계약 때 맞춤.
- 시험 리뷰 낮음: TR-13~15·TR-20~22, 거절 지표 이름표 `target` 값 미정, TO-01 반대쪽(앞날) 한 줄, TO-10 보류 끝 정각(10:00:00.000) 경계 한 줄.
- 내부 경로 셋의 모양 틀림 422 `invalid-query`가 문제 목록의 400과 다르다(기존 payment 내부 경로 꼴).
- 환경 몫: core-svc 환경별 값은 로컬 데모 파일 하나에만 `PEAKET_PAYMENT_HTTP_URL`이 있다(다른 환경 파일 없음).
- ops 통합 `f021-e2e-control`이 `PEAKET_SCHEMA_IDS_FILE` 없음(PlatformConfigError, purchase-svc 시작 조립)으로 떠지 않는다 — F-07-7과 무관, develop에서도 같은지 확인 필요.
- 흔들림 후보: core `fill-search-guard`·`internal-notify(-ticket)`·`tenant-rate-limit`·`shop-expiry`·`registration`·`search-bat166·167`·`seatmap-editor`·`sale-eligibility`·`seatmap-import`(부하 중 준비 시간 초과, 단독 통과), payment P-T46 ④.
- payment 마이그레이션 0031은 갈래 3 몫으로 비어 있다(F-07-7이 0030 다음 0032). 갈래 3이 0031을 쓰지 않으면 번호가 빈 채 남는다.
## F-07-8(2026-11-23, R-804)

- C-01(낮음): 결제사별 토큰 버킷이 프로세스마다 따로라 API 파드와 릴레이 리더가 겹치면 잠깐 두 배까지 나간다. 결제사 한도가 정해지면 Redis 공용 버킷을 볼지 정한다.
- C-03(낮음): 미수금이 생길 때의 사건이 asyncapi에 없다. 파트너 알림·SCR-027 상계 내역과 함께 본다.
- C-04(낮음): 계산 뒤 환급 훑기는 결제 취소의 끝난 시각으로 읽는다. 끝난 시각이 늦게 채워지는 결제사 결과(웹훅 지연)는 다음 tick이 잡지만, `read_through`를 지금 −30분 [가정]으로 둔 겹침 폭이 맞는지 운영에서 본다.
- C-05(낮음): 가짜 송금 어댑터의 결과 규칙(끝 4자리 `0000`)은 시험·데모용이다. 실제 어댑터가 오면 지운다.
- 시험 리뷰 낮음: TR-12(포트원 쪽), TR-16(409 `recalculation-conflict`의 오류 이름), TR-17(나)(계좌 원문 로그 확인).
- 흔들림 후보: purchase 단위 전체 실행에서 `grpc-payment-checkout.test.ts` PT26·PT27이 부하 때 실패하고 단독 56/56 통과(이 기능과 무관).
- 운영 전: 실제 은행 이체 어댑터(계약 단계), 결제사 취소 한도가 승인 한도와 같은지(토큰 버킷 값, ADR-0069 결정 10 끝 줄).

## F-07-9(2026-11-26, 시험 리뷰)

리뷰 지적 번호는 `docs/review/plans/F-07-9.md` '시험 리뷰' 절의 것이다.

- TR-08(중간): 파트너 20경로 목록이 `partner-pages.test.mjs`·`partner-mobile.spec.mjs`·`rules.mjs` 세 곳에 복사돼 있고, `/login`·`/invite`·`/unlock`(SCR-020)이 빠져 '전 화면'이 아니다. 목록은 라우트나 정본 한 곳에서 만들고, AC-01의 '설정 네 화면'과 목록 다섯 개도 맞춘다.
- TR-09(중간): `REFLOW_PAGES`에 새 19경로를 더해 PR reflow가 3엔진×320/640으로 약 171개를 더 돈다(전체 20경로, 계획 20×2). FE-T31 정본은 PR 주요 흐름·출시 후보 전 화면이라 범위를 나누고, `docs/frontend.md`에 이 범위 변경을 적는다. 767·1279·1280 경계, 터치 목표 44px, 768에서 판매 정책·상품 폼·주문 표가 남는지도 시험하지 않는다.
- TR-10(낮음): `live-product-mobile.test.mjs`는 `ProductFormLive`만 보고 `ProductEditLive`의 로딩·오류·고치기와 768 폼 보임을 보지 않는다. `seller-notice.test.mjs`는 `'0.00%'`·1/100자 상호·줄바꿈/`<`/`&`를 보지 않고, `productSellerNotice`는 이 기능에서 쓰는 화면이 없다.
- TR-11(낮음): 계획 §실패 확인의 '실행 16·11 실패'는 `seller-notice.test.mjs`가 모듈 없음으로 파일째 1건이 된 수다. 구현 뒤 전체는 261개(257 − 파일째 1 + 5)가 되므로 수를 정정한다.
- TR-12(낮음): d5 §6.1 판매자 정보에는 새 '중개자 지위와 정산' 구획이 없다. `settlementDisclosure` ④⑤는 정본 인용이 아니라 요약이고, 빈 상호에서 `performanceSellerNotice`는 '판매자:'를 뺀다. d5/§2.2에 구획을 더하거나 요약임을 표시하고 빈 값은 '확인 필요'로 채운다.

### F-07-9 구현 리뷰(2026-11-26)

구현 리뷰 지적 가운데 중간·낮음이다. 자세한 내용과 정본 근거는 `docs/review/plans/F-07-9.md` '구현 리뷰' 절에 있다.

- IR-01(중간): 소비자 웹 POL-037 고지가 `apps/web/src/_pages/booking-result/ui/ResultLive.tsx:147`·`apps/web/src/_pages/event-detail/model/content.ts:26`·`apps/web/src/_pages/order-detail/ui/DetailParts.tsx:16`에 아직 복사돼 있다. `ResultLive`는 "예매 취소와 환불은 PEAKET이 처리합니다"가 빠졌고, event-detail·order-detail은 빈 상호에서 `판매자: .`가 된다. 공용 함수 하나로 모으고 예매 확인서에 전체 문장을 쓴다. 이번 변경 밖의 기존 결함이라 이 기능의 판정을 막지는 않는다.
- IR-02(중간): `apps/partner/src/_pages/sale-policy/ui/LiveSalePolicy.tsx:190` 모바일 규칙 카드의 규칙 이름이 `pickRule`을 부르는 버튼인데, 편집 구역이 `max-md:hidden`이라 휴대폰에서는 눌러도 보이는 변화가 없다. `link-more`가 19px이라 24px 터치 목표에도 못 미치고, 40자 규칙 이름은 `nowrap`으로 잘린다. 카드에서는 글자로만 두거나 24px 이상으로 만든다.
- IR-03(낮음): `apps/partner/src/shared/lib/seller-notice.ts:17`의 `productSellerNotice`는 화면에서 쓰지 않는 시험 전용 함수다. 상품 화면을 실제 API로 이을 때 쓰거나 지운다(TR-10).
- IR-04(낮음): `apps/partner/src/shared/lib/seller-notice.ts:37` ⑤ "부정판매는 처벌·과징금 대상입니다"는 POL-024 라목 원문이 아닌 요약이다. 요약임을 표시하거나 원문을 쓴다(TR-12).
- IR-05(낮음): 계획 I-07이 정한 `docs/lanes/lane5.md` F-07-9 진행 로그가 없다. 동결 로컬 범위 기록에서 채운다.
- IR-06(중간): 계획·시험·구현·기록 커밋이 `lane5-freeze-F-07-9-opencode` 한 세션을 함께 써 `roles-check --base 1d10d6da3 --head HEAD`가 exit 1이다(세션 겹침 3건). 커밋 꼬리말은 고쳐 쓸 수 없으므로 이 동결 가지는 합치지 않고, 기록 커밋에 예외를 남기거나 다음 묶음부터 역할마다 새 세션을 쓴다. 같은 출력의 '시험 리뷰가 구현보다 먼저'·'verify 없음'은 도구가 ADR-0372·0381을 아직 모르는 탓이다.

## F-07-10(2026-11-26, 시험 리뷰)

리뷰 지적 번호는 `docs/review/plans/F-07-10.md` '시험 리뷰' 절의 것이다. 높음·보안·통과 기준 13건(TR-01~13)은 시험 담당이 고치고, 아래 낮은 지적과 남은 위험은 정리 목록에 둔다.

- TR-14(낮음): 계획 §6의 시험 ID 자리표시(`OPS-05~07`·`WEB-01~04`)가 실제(`OPS-05~09`·`WEB-01~05`)와 다르고, 계획 I-07은 `reviewDetailOf`가 폭·높이를 남긴다고 하지만 `OPS-05`는 버린다. `review-photo-upload.test.mjs`는 `out.imageId`·`e.status`·`photo.id`처럼 생성 변수 이름을 고정하고, `review-images.http.test.ts:337`은 `reviewMaintenanceTasks(..., { images } as never)`로 타입을 지운다. `review-panel.test.mjs:85`는 cs_lead의 후기 조치를 허용하지만 openapi `POST /v1/ops/reviews/{reviewId}/moderation`의 `x-peaket-roles`는 cs_agent뿐이다(d5 §7.6 `:3312`는 cs_agent·cs_lead 처리). 계획 §6의 수치와 실제 시험 수를 맞추고, 변수 이름 대신 행동을, 역할은 계약과 d5 가운데 하나로 맞춘다.
- `review_image`의 실제 SQL(제약·색인·GRANT)과 같은 사진을 두 후기에 동시에 붙이는 경합은 시험 리뷰 때 Docker를 쓰지 않아 `test-int`로 미뤘다. 2026-11-26 구현 리뷰가 Docker `lane5-F-07-10`로 실제 SQL을 확인해 사진 교체·순서 바꾸기의 `23505` 결함(IR-01)을 찾았다. 아래 구현 리뷰와 계획 '구현 리뷰'를 본다.
- SCR-016 사진 업로드·관제 후기 패널의 실제 Chromium 누름은 F-08-7(웨이브 끝 브라우저 확인)로 미뤘다. 이 시험은 소스·모델·HTTP 대역까지다.
- `image-worker`가 이 저장소에 없어 실제 디코딩·재인코딩·메타데이터 제거는 대역으로만 본다. 개발·운영 업로드는 `image-worker` 배포가 생겨야 끝까지 돈다(계획 §남은 위험).

### F-07-10 구현 리뷰(2026-11-26)

구현 리뷰 지적 가운데 낮음이다. 자세한 내용과 정본 근거는 `docs/review/plans/F-07-10.md` '구현 리뷰' 절에 있다. 높음·보안·통과 기준(IR-01~09)은 freeze 가지에서 고치고, 아래는 구간 끝 정리로 넘긴다.

- IR-10(낮음): `review-image.ts:68-72`가 처리 작업의 비정상 폭·높이(NaN·0)를 `TOO_LARGE`로 바꿔 `review-images.ts:83-87`이 422(사용자 잘못)로 닫는다. 작업자 잘못은 503으로 분류해 재시도·모니터링이 맞게 한다.
- IR-11(낮음): 정리 24시간 경계가 Drizzle `lt`(`drizzle-review-store.ts:276`)와 메모리 `<=`(`memory-review-store.ts:351`)로 다르다. 딱 24시간인 행이 DB에서만 다음 날로 밀린다.
- IR-12(낮음): `ReviewImages.cleanupDue`(`review-images.ts:132-146`)는 아무도 부르지 않는 죽은 코드이고, 정비 일(`review-maintenance.ts:48`)이 같은 로직을 다시 쓰며 묶음 100을 숫자로 박았다. 한 곳으로 모으고 `REVIEW_IMAGE_CLEANUP_BATCH`를 쓴다.
- IR-13(낮음): `review-images.ts:165-166`이 422 확장을 `{ reason, extensions: { reason } }`로 겹쳐 `extensions.extensions.reason`을 함께 내보낸다. 계약에 없는 칸을 지운다.
- IR-14(낮음): `review-images.ts:93-108`의 파생본 게시·격리/준비 삭제가 try/catch 밖이라, 두 번째 `putPublic` 실패 때 첫 파생본이 공개된 채 500이 나고 행도 없다. 실패 단계에서 남긴 객체를 지우고 503으로 닫는다.
- IR-15(낮음): `ConnectedPage.tsx:121-142`가 역할과 무관하게 후기 상세를 불러 operator·commander에게 403 오류 문구를 보이고(openapi GET은 cs_agent·cs_lead만, d5 `:3312`는 operator·commander 조회 허용), 건을 바꿔도 이전 후기 상태를 지우지 않는다. 역할별 호출·상태 초기화를 맞춘다.
- IR-16(낮음): 계획의 구현 리뷰 범위 `b19fc1416`·설명 길이 부등호는 이번 리뷰 커밋에서 바로잡았다(계획 `:449`·`:475`). `docs/lanes/lane5.md` 진행 로그와 BUILD_ORDER F-07-10 비고는 기록 커밋 몫으로 남는다.
- **2026-11-26 구현 리뷰가 Docker로 확인한 것**: 잠금 `lane5-F-07-10`로 기존 후기 통합 5파일 20/20을 다시 통과했고, 임시 PostgreSQL에 0052를 적용해 `DrizzleReviewStore`의 사진 교체·순서 바꾸기가 부분 유일 `(review_id, sort)` 때문에 `23505`로 실패하는 것을 재현했다. 아래 계획 §검증 `남은 위험`의 "새 사진 통합 시험 없음"은 이 재현을 `test-int/review-images.int.test.ts`로 남기는 일로 바뀐다(IR-09).
- **남은 위험(기록)**: 가린 후기의 사진은 API 응답에서만 빠지고 공개 CDN 객체 주소는 남는다. 불법 촬영물 가림처럼 객체 회수가 필요한 경우 F-07-11 전에 공개 객체 삭제·비공개 이동 가운데 하나를 정한다. `review-image-cleanup`은 `PEAKET_IMAGE_STORE_DIR`가 있을 때만 등록되고 차트의 릴레이 파드 값·볼륨은 아직 없어, HOT-200(S3) 뒤에 실제 저장소로 바꿔야 한다.
