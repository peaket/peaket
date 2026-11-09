-- 주문을 만든 홀드와 구매 세션(docs/data.md §2 purchase_order·§4 '주문 표 마이그레이션'·§5 '주문 생성', docs/features/payment.md §2 '주문 생성의 첫 구현', BUILD_ORDER PRF-161).
-- drizzle-kit이 만든 SQL 그대로다(표 정의는 src/modules/booking/adapters/db/schema.ts). 주문 표가 비어 있는 단계라 기본값 없이 NOT NULL로 더한다.
-- hold_id 유일 인덱스가 '한 홀드에 주문 하나'를 정한다: 같은 홀드로 다른 멱등 키의 주문이 겹치면 뒤 쪽은 23505로 끝나 409 hold-already-ordered다.
ALTER TABLE "purchase_order" ADD COLUMN "hold_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD COLUMN "purchase_session_id" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_hold_key" ON "purchase_order" USING btree ("hold_id");
