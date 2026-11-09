# entities — 핵심 목업(골격·화면 담당이 만든 것)

퍼블리싱 단계의 합성 데이터(고정 값)다. 이름·주소·연락처는 모두 지어낸 것이고, 금액은 원 단위 정수, 시각은 KST 표기다.
다른 담당은 이 폴더를 **읽기만** 하고, 새 목업은 자기 페이지 폴더의 `model/`이나 브리프가 허락한 새 entities 폴더에 둔다.
FSD 규칙상 entities 조각끼리는 서로 가져오지 않는다. 공연·회차·공연장을 합치는 일은 페이지(`_pages`)나 위젯에서 한다.

- `production` — 공연(`PRODUCTIONS`, 포스터 그림 부품 `ProductionPoster`, `getProduction(id)`, `productionHref(p)`, `formatWon(n)`, `SORT_MODE_LABEL`, `SEAT_MODE_LABEL`). E-1 `prd-lumen`(LUMEN 콘서트 2026 서울, HYBRID·PICK), E-2 `prd-fest`(가을 야외 페스티벌, FIFO·AUTO), E-3 `prd-musical`(소극장 뮤지컬, 매진·회차 3개), E-4 `prd-fanmeet`(팬미팅, PREQUEUE_SHUFFLE)와 홈을 채우는 공연 7개.
- `performance` — 회차(`PERFORMANCES`, `getPerformance(id)`, `listPerformances(productionId)`, `eventHref(id)`, `DEMO_EVENT_ID` = `evt-lumen-1025`). `/events/[id]`·`/booking/[eventId]/…`·`/queue/[eventId]`의 id가 회차 id다.
- `venue` — 공연장(`VENUES`, `getVenue(id)`). 피켓 아레나 `ven-peaket-arena` 등 6곳, 주소는 가상.
- `artist` — 아티스트(`ARTISTS`, `getArtist(id)`). LUMEN 등.
- `seller` — 판매자 신원정보 7항목(`SELLERS`, `getSeller(id)`). (주)스텔라엔터테인먼트 `sel-stella`, 값은 '예시'.
- `me` — 로그인한 팬 요약 목업(`ME` = 지민·카카오·본인확인 완료, `ME_HANEUL` = 하늘·현장 책임자, `GUEST` = null). 찜·오픈 알림 신청 공연 id를 가진다. 실제 로그인·본인확인 상태는 `useFanSession()`(GET /v1/identity/me를 페이지마다 한 번, `refreshFanSession()`)과 화면 값 함수 `shellUserOf`·`personalCta`(ADR-0202, HOT-321)다. 셸 머리는 이것을 쓰고, 목업 `ME`는 아직 데이터에 잇지 않은 화면의 내용만 그린다.
- `ticket` — 티켓 요약(`TICKETS`, `getTicket(id)`, `DEMO_TICKET_ID` = `tkt-lumen-r1-0312`). 상태는 d5 §10.3 표본 여덟 가지.
- `order` — 주문 요약(`ORDERS`, `getOrder(id)`, `DEMO_ORDER_ID` = `ord-20261014-0001`). 상태는 d5 §10.3 표본 일곱 가지.
- `account` — 계정 공용 목업(`BANKS` 은행 9곳 — 환불·배상 계좌 폼이 함께 씀, `SAMPLE_BANK_INPUT`, `maskedAccount(bank, account)`)과 SCR-055 예매·주문 내역(`ORDER_HISTORY` 19건, `getOrderHistory(id)`, `GOODS_READY_BADGE`, `ORDER_HISTORY_DEMO` = 예매 확인서 `ord-20261014-0001`·주문 확인서 `ord-20261018-0010`·입금 오류 `ord-20261020-0008`). 계좌는 끝 4자리만 보인다.
- `appeal` — 소명 건(`APPEALS` 2건: `apl-0001` 예매 제한·`apl-0002` 양도 회수, `getAppeal(id)`, `findAppealByKind(kind)`, `APPEAL_MAX_LENGTH` = 2000, `DEMO_APPEAL_ID` = `apl-0001`).
- `cart` — 장바구니(`CART_GROUPS` 판매자·수령 방식별 묶음 2개: 티셔츠 L 택배·응원봉 수령 시간대, `STOCK_HOLD_UNTIL_TEXT` = '20:22', `groupSubtotal`·`groupTotal`·`cartLineCount`·`cartQuantities`·`lineMeta`·`won`)와 UI 조각 `CartDrawer`·`CartGroups`·`CartEmpty`·`QuantityStepper`·`useShopToast`.
- `compensation` — 배상 건(`COMPENSATIONS` 1건: 주최 측 취소 LUMEN `evt-lumen-1026` R석 1매, `getCompensation(id)`, `compensationAmount(paidAmount)`, `COMPENSATION_RATE_PERCENT` = 10, `DEMO_COMPENSATION_ID` = `cmp-0001`).
- `hold` — 좌석 홀드(`HOLD_RULES` 홀드 7분·연장 3분 1회·구매 세션 45분, `DEMO_HOLD` R1구역 12열 7·8번 R석 2매 ₩308,000, 자동 배정 결과 `DEMO_AUTO_ASSIGN`).
- `inquiry` — 고객 문의(`INQUIRIES` 4건, `getInquiry(id)`, `inquiryHref(id)` = `/help/inquiries/<id>`, `INQUIRY_TYPES` 11가지·`inquiryTypeShort`, `INQUIRY_ORDER_OPTIONS`, `ANSWER_DUE_TEXT`, 배지 `InquiryStatusBadge`, `DEMO_INQUIRY_ID` = `inq-0001`(답변 완료), `DEMO_DISPUTE_INQUIRY_ID` = `inq-0002`(판매자 분쟁·처리 중)).
- `like` — 찜·알림 신청 기록(`ALERT_SUBSCRIPTIONS` 4건·`ENDED_ALERT_SUBSCRIPTIONS` 4건, `ALERT_KIND_LABEL`·`ALERT_KIND_ICON`·`ALERT_CHANNEL_TEXT`·`ALERT_END_TEXT`, 지난 공연 `PAST_PRODUCTIONS`(`prd-jazz-0926`)·`LIKED_PAST_PRODUCTION_IDS`·`PENDING_LIKE_PRODUCTION_IDS`, `canResubscribe`). 공연 이름·회차 시각은 production·performance가 정본.
- `payment` — 결제(`CHECKOUT_DEMO` R석 2매 ₩308,000·토스, `PORTONE_METHODS`, 취소 수수료 줄 `CANCEL_FEE_ROWS`, 결제 결과 `RESULT_DEMO`(예매번호 2026101400123), 가상계좌 `VBANK_DEMO`, `thirdPartyRows(sellerName)`, `holdTimeText(seconds)`)와 결제 복귀 카드 `PaymentReturnCard`.
- `policy-doc` — 약관·정책 문서 7가지(`POLICY_DOCS`, `getPolicyDoc(slug)`, `policyHref(slug)` = `/policy/<slug>`: terms·privacy·dispute·sale-terms·community·business·security-notice), 분쟁 해결 기준 공제표 `CANCEL_FEE_ROWS`(payment의 같은 이름과 모양이 다르다), 통신판매중개자 고지 `BROKER_NOTICE_FOOTER`. 조항 본문은 자리 표시.
- `product` — 굿즈·티켓 연동 부가 상품(`PRODUCTS` 8개: 굿즈 4·부가 상품 4, `PRODUCT_CATEGORIES`, `TICKET_PICKUP_SLOT`, `getProduct(id)`, `listAddonsForPerformance(performanceId)`, `productHref(id)` = `/shop/<id>`, `displayPrice`, `productBrokerNotice`, `won`, `DEMO_PRODUCT_ID` = `gds-lumen-lightstick`)와 `ProductGrid`·`ProductCard`.
- `provider` — 소셜 로그인 수단(`LOGIN_PROVIDERS` 카카오·네이버·구글, `PROVIDER_NAME`·`PROVIDER_LOGIN_LABEL`, 연결된 수단 `LINKED_PROVIDERS`, 계정 연결 제안 `LINK_PROPOSAL`, 계정 합치기 `MERGE_PROPOSAL`·`MERGE_CHECK_TITLES`, 세션이 끝난 사유 글 `SESSION_END_TEXT`). 이메일·닉네임은 가린 값.
- `refund` — 지연 환급 건(`DELAYED_REFUNDS` 1건: 주문 `ord-20261012-0004` 소극장 뮤지컬 1매 가상계좌, 90% 공제, `getDelayedRefund(id)`, `refundBreakdown(paidAmount, deductionPercent)`, `DEMO_REFUND_ID` = `rfd-0001`).
- `review` — 후기(`REVIEW_ITEMS` 7건, `REVIEW_SUMMARY` 평균 4.6·128개, `getReview(id)`, `sortReviewItems`·`REVIEW_SORT_LABEL`, 신고 모달의 가린 이메일 `MY_MASKED_EMAIL`, 금칙어 `BANNED_PHRASES`). 작성자는 닉네임 첫 글자 + '**'.
- `seat` — 좌석맵(`SEAT_TIERS` R석 ₩154,000·S석 ₩132,000·A석 ₩110,000, `GRADE_FILL`, `STAGE_BOX`, 구역 6개 `SEAT_ZONES`, `SEAT_ROWS`×`SEAT_COLS` = 20×30, `seatClassAt`·`seatXY`·`openSeatCount`·`listSeats`). 좌표는 1000×600 배치도 좌표계.
- `shuffle-proof` — 셔플 검증 정보(`getShuffleProof(eventId, fifo)`, `OPEN_TEXT` = '10/14(수) 20:00', `SHUFFLE_SPEC_URL`). 해시·라운드·주소는 합성 값.
- `staff-assignment` — 현장 스태프 배정(`STAFF_ASSIGNMENTS` 3건: LUMEN 10/25 진행 중·10/26 곧 시작·지난 배정, `getStaffAssignment(id)`, `STAFF_ROLE_LABEL`(현장 책임자·현장 스태프)·`STAFF_PHASE_LABEL`·`STAFF_PHASE_BADGE`, 유효 기간 글 `staffValidText` 등, `DEMO_STAFF_ASSIGNMENT_ID` = `sta-lumen-1025`).
- `transfer` — 양도 요청(`TRANSFER_OFFERS` 1건: 티켓 `tkt-lumen-r1-0312`의 수락 대기 요청, `getTransferOffer(id)`, `findOfferByTicket(ticketId)`, `transferOfferHref(id)` = `/my/transfers/<id>`, `DEMO_OFFER_ID` = `ofr-0001`). 받는 분에게 결제 금액·연락처를 주지 않는다.
