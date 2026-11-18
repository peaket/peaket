-- 탈퇴 참여자가 계정으로 주문을 찾는 인덱스(ADR-0284, docs/features/payment.md §4.1 '탈퇴 참여자의 첫 구현', docs/data.md §5.1 '탈퇴 참여자의 계정 주문 찾기', BUILD_ORDER PRF-169).
-- 표 정의는 src/modules/booking/adapters/db/schema.ts이고 db:generate로 만들었다(스냅샷 meta/0028_snapshot.json).
-- 쓰기가 많은 주문 표에 인덱스를 두지 않는 원칙(data.md §5.1)의 0011 다음 예외다: 계정으로 주문을 찾을 길이 달리 없다.
-- 0011과 같은 까닭으로 조건을 두지 않는다(account_id·id는 바뀌지 않아 HOT 갱신을 막지 않고, 주문을 넣을 때 항목이 하나 는다).
-- 운영에 나가기 전이라 트랜잭션 안에서 만든다. 운영 뒤 큰 표의 인덱스는 CONCURRENTLY 파일(-- peaket:no-transaction)로 따로 만든다(docs/devops.md §7.2).
CREATE INDEX "purchase_order_account_idx" ON "purchase_order" USING btree ("account_id","id");
