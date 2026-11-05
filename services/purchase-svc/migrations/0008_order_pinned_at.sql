-- 주문의 묶은 시각(docs/data.md §4 아홉 번째 마이그레이션, docs/features/seat-hold.md §6 '주문 기준 되살리기', BUILD_ORDER PRF-167).
-- drizzle-kit이 만든 SQL 그대로다(표 정의는 src/modules/booking/adapters/db/schema.ts).
-- purchase_order.pinned_at은 Saga 묶기가 OK인 뒤 적는 시각이다(널 허용. 묶기 전이면 비어 있다). 다시 만들기가 결제를 접수했고(ACCEPTED) 묶인 주문의
-- 좌석을 원장 만료 시각과 상관없이 되살리는 근거로 쓴다(K1). 쓰기가 많은 표라 인덱스는 두지 않는다(data.md §5.1).
ALTER TABLE "purchase_order" ADD COLUMN "pinned_at" timestamp with time zone;
