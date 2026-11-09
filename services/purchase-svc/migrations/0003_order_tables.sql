-- purchase DB의 주문 저장소 표(docs/data.md §2 ERD·§4 '주문 표 마이그레이션', docs/features/payment.md §3 '주문 저장소의 첫 구현', BUILD_ORDER PRF-160, ADR-0113·0114).
-- purchase_order·order_item·order_event·order_idempotency·payment_attempt는 drizzle-kit이 만든 SQL 그대로다(표 정의는 src/modules/booking/adapters/db/schema.ts).
-- 끝의 셋은 손으로 더했다: order_event의 occurred_at BRIN 인덱스(매일 상태·이력 검사가 '전날 이력'을 찾는다, data.md §5.1),
-- 상태 이력 지연 제약 트리거 order_status_has_event(ADR-0113 결정 2의 DB 장치), Outbox 부모 표(packages/platform/template/migrations/0002_outbox.sql을
-- 그대로 옮기고 문 사이에 구분 표시만 넣었다). Outbox 일 파티션은 scripts/migrate.mjs가 만든다.
-- 주문 표는 나누지 않는다(ADR-0114). 두 자식 표(order_item·order_event)와 payment_attempt는 주문에 외래 키를 건다(보존 삭제는 자식부터).
CREATE TABLE "order_event" (
	"order_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"cause" text NOT NULL,
	"actor" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "order_event_pkey" PRIMARY KEY("order_id","seq"),
	CONSTRAINT "order_event_seq_check" CHECK ("order_event"."seq" >= 1),
	CONSTRAINT "order_event_from_status_check" CHECK ("order_event"."from_status" in ('CREATED', 'AUTHENTICATED', 'ACCEPTED', 'RESERVED', 'AWAITING_DEPOSIT', 'APPROVED', 'UNKNOWN', 'CONFIRMED', 'FAILED', 'COMPENSATED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'EXPIRED')),
	CONSTRAINT "order_event_to_status_check" CHECK ("order_event"."to_status" in ('CREATED', 'AUTHENTICATED', 'ACCEPTED', 'RESERVED', 'AWAITING_DEPOSIT', 'APPROVED', 'UNKNOWN', 'CONFIRMED', 'FAILED', 'COMPENSATED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'EXPIRED'))
);
--> statement-breakpoint
CREATE TABLE "order_idempotency" (
	"account_ref" text NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_hash" "bytea" NOT NULL,
	"result_ref" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "order_idempotency_account_ref_operation_idempotency_key_pk" PRIMARY KEY("account_ref","operation","idempotency_key"),
	CONSTRAINT "order_idempotency_operation_check" CHECK ("order_idempotency"."operation" in ('CREATE_ORDER', 'START_PAYMENT', 'ACCEPT_PAYMENT'))
);
--> statement-breakpoint
CREATE TABLE "order_item" (
	"order_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"seat_id" uuid NOT NULL,
	"tier" text NOT NULL,
	"section_id" text NOT NULL,
	"unit_price" integer NOT NULL,
	"ticket_id" uuid,
	CONSTRAINT "order_item_pkey" PRIMARY KEY("order_id","line_no"),
	CONSTRAINT "order_item_unit_price_check" CHECK ("order_item"."unit_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payment_attempt" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"pg" text NOT NULL,
	"pg_order_ref" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payment_attempt_pg_check" CHECK ("payment_attempt"."pg" in ('TOSS', 'PORTONE', 'SIMULATOR')),
	CONSTRAINT "payment_attempt_status_check" CHECK ("payment_attempt"."status" in ('READY', 'ACCEPTED', 'SUPERSEDED', 'EXPIRED'))
);
--> statement-breakpoint
CREATE TABLE "purchase_order" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"status" text NOT NULL,
	"amount" integer NOT NULL,
	"event_seq" integer NOT NULL,
	"payment_event_seq" bigint DEFAULT 0 NOT NULL,
	"buyer_name" text,
	"buyer_phone" text,
	"idempotency_key" text NOT NULL,
	"consent_version" text NOT NULL,
	"seat_assignment" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "purchase_order_status_check" CHECK ("purchase_order"."status" in ('CREATED', 'AUTHENTICATED', 'ACCEPTED', 'RESERVED', 'AWAITING_DEPOSIT', 'APPROVED', 'UNKNOWN', 'CONFIRMED', 'FAILED', 'COMPENSATED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'EXPIRED')),
	CONSTRAINT "purchase_order_amount_check" CHECK ("purchase_order"."amount" >= 0),
	CONSTRAINT "purchase_order_event_seq_check" CHECK ("purchase_order"."event_seq" >= 1),
	CONSTRAINT "purchase_order_payment_event_seq_check" CHECK ("purchase_order"."payment_event_seq" >= 0),
	CONSTRAINT "purchase_order_seat_assignment_check" CHECK ("purchase_order"."seat_assignment" in ('PICK', 'AUTO'))
);
--> statement-breakpoint
ALTER TABLE "order_event" ADD CONSTRAINT "order_event_order_id_purchase_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."purchase_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_order_id_purchase_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."purchase_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_order_id_purchase_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."purchase_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_idempotency_created_at_idx" ON "order_idempotency" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_item_seat_key" ON "order_item" USING btree ("order_id","seat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempt_active_key" ON "payment_attempt" USING btree ("order_id") WHERE "payment_attempt"."status" in ('READY', 'ACCEPTED');--> statement-breakpoint
CREATE INDEX "payment_attempt_order_id_idx" ON "payment_attempt" USING btree ("order_id");--> statement-breakpoint
-- 손으로 더함: 덧붙이기만 하는 표라 시각 순으로 쌓여 작은 BRIN으로 전날 이력을 찾는다(data.md §5.1 '매일 주문 상태·이력 검사').
-- autosummarize: 새로 찬 블록 범위를 autovacuum이 저절로 요약해, 요약되지 않은 끝 범위를 검사 때마다 다 훑지 않게 한다
CREATE INDEX "order_event_occurred_at_brin" ON "order_event" USING brin ("occurred_at") WITH (autosummarize = on);--> statement-breakpoint
-- 손으로 더함: 상태 이력 지연 제약(ADR-0113 결정 2의 DB 장치, 리뷰 2026-11-05). 주문 행을 넣거나 status·event_seq를 바꾼 트랜잭션은 커밋 때
-- 그 주문의 이력 행(번호 = event_seq, 도착 = status)이 있어야 한다. 없으면 23514(제약 이름 order_status_has_event)로 커밋이 실패한다.
-- 전이 함수 밖의 상태 쓰기를 소스 검사(test/order-status-sql.test.ts)가 놓쳐도 DB가 막는다. 오류 글에는 주문 ID만 싣는다.
-- 지연(INITIALLY DEFERRED)이라 같은 트랜잭션에서 주문 행을 먼저 쓰고 이력을 뒤에 써도 된다(주문 만들기·전이 함수의 차례).
CREATE FUNCTION "order_status_has_event"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM "order_event" WHERE "order_id" = NEW."id" AND "seq" = NEW."event_seq" AND "to_status" = NEW."status") THEN
		RAISE EXCEPTION '주문 상태에 맞는 이력 행이 없다: %', NEW."id" USING ERRCODE = '23514', TABLE = 'purchase_order', CONSTRAINT = 'order_status_has_event';
	END IF;
	RETURN NULL;
END
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "order_status_has_event" AFTER INSERT OR UPDATE OF "status", "event_seq" ON "purchase_order" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "order_status_has_event"();--> statement-breakpoint
-- 손으로 더함: 아래는 packages/platform/template/migrations/0002_outbox.sql과 같다.
-- Outbox 부모 표(docs/data.md §2 '파티션 표 규칙'·§4의 7번, ADR-0083·0116). Drizzle 0.45에는 파티션 선언이 없어 손으로 쓴 SQL이다.
-- ID(UUIDv7, 주입한 시계) 범위로 한국 시각 하루씩 나눈다. 기본(DEFAULT) 파티션은 두지 않는다.
-- 파티션은 @peaket/platform의 ensureOutboxPartitions가 만든다(첫 파티션 포함, 7일 [가정] 앞까지). 날짜를 박은 첫 파티션은 배포 날짜와 어긋나 첫 쓰기가 실패한다.
-- seq는 보내는 순서, sent_at은 릴레이가 보낸 뒤 적는다. 보내지 않은 행은 부분 인덱스로 찾는다(sent_at을 적으면 빠진다).
CREATE SEQUENCE "outbox_seq" AS bigint;--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid NOT NULL,
	"seq" bigint NOT NULL DEFAULT nextval('outbox_seq'),
	"topic" text NOT NULL,
	"msg_key" text NOT NULL,
	"payload" bytea NOT NULL,
	"headers" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"sent_at" timestamp with time zone,
	CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
) PARTITION BY RANGE ("id");--> statement-breakpoint
ALTER SEQUENCE "outbox_seq" OWNED BY "outbox"."seq";--> statement-breakpoint
CREATE INDEX "outbox_unsent_idx" ON "outbox" ("seq") WHERE "sent_at" IS NULL;