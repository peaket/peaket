-- 구매 세션으로 주문을 찾는 인덱스(ADR-0107 결정 2, docs/features/payment.md §2 '결제하지 않은 주문 만료의 첫 구현', docs/data.md §5.1 '만료 고리의 열린 주문 찾기', BUILD_ORDER PRF-172).
-- 표 정의는 src/modules/booking/adapters/db/schema.ts다. drizzle-kit generate가 내는 모양으로 손으로 적었고,
-- 스냅샷(meta/0011_snapshot.json)과 표 정의가 맞는지는 db:generate가 '바뀐 것 없음'으로 확인한다.
-- 구매 세션이 끝나면 그 세션의 열린 주문(CREATED·AUTHENTICATED)의 만료 조건을 다시 본다. 쓰기가 많은 주문 표에 인덱스를 두지 않는 원칙(data.md §5.1)의 예외다: 구매 세션으로 주문을 찾을 길이 달리 없다.
-- 조건 없는 인덱스로 둔다: status를 조건에 넣은 부분 인덱스는 주문의 상태를 바꾸는 UPDATE를 모두 HOT 갱신(인덱스를 고치지 않는 갱신)에서 빼므로 쓰기 비용이 더 크다.
--   purchase_session_id는 바뀌지 않아 주문을 넣을 때 항목이 하나 늘 뿐이다.
-- 운영에 나가기 전이라 트랜잭션 안에서 만든다. 운영 뒤 큰 표의 인덱스는 CONCURRENTLY 파일(-- peaket:no-transaction)로 따로 만든다(docs/devops.md §7.2, 실행기 BUILD_ORDER BAS-060).
CREATE INDEX "purchase_order_session_idx" ON "purchase_order" USING btree ("purchase_session_id");
