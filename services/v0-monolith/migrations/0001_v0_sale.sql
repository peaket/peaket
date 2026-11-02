-- 주문·결제·발권 v0 표와 좌석 판매 칸(docs/features/payment.md §13, docs/features/offline-gate.md §13, docs/features/seat-hold.md §14 동작 9).
-- drizzle-kit generate가 만든 모양을 검토해 커밋한다(ADR-0037 결정 6)
CREATE TABLE "v0_order" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"account_id" text NOT NULL,
	"hold_id" uuid NOT NULL,
	"seat_ids" text[] NOT NULL,
	"amount" integer NOT NULL,
	"order_name" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "v0_order_hold_id_unique" UNIQUE("hold_id"),
	CONSTRAINT "v0_order_status_check" CHECK ("v0_order"."status" in ('CREATED', 'PAYING', 'APPROVED', 'CONFIRMED', 'FAILED')),
	CONSTRAINT "v0_order_amount_check" CHECK ("v0_order"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "v0_order_event" (
	"order_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"to_status" text NOT NULL,
	"reason" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "v0_order_event_order_id_seq_pk" PRIMARY KEY("order_id","seq")
);
--> statement-breakpoint
CREATE TABLE "v0_order_item" (
	"order_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"seat_id" text NOT NULL,
	"grade" text NOT NULL,
	"price" integer NOT NULL,
	"ticket_id" uuid,
	CONSTRAINT "v0_order_item_order_id_line_no_pk" PRIMARY KEY("order_id","line_no")
);
--> statement-breakpoint
CREATE TABLE "v0_price" (
	"event_id" text NOT NULL,
	"grade" text NOT NULL,
	"price" integer NOT NULL,
	CONSTRAINT "v0_price_event_id_grade_pk" PRIMARY KEY("event_id","grade"),
	CONSTRAINT "v0_price_price_check" CHECK ("v0_price"."price" between 1 and 100000000)
);
--> statement-breakpoint
CREATE TABLE "v0_payment" (
	"payment_id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"pg" text NOT NULL,
	"payment_key" text NOT NULL,
	"amount" integer NOT NULL,
	"status" text NOT NULL,
	"failure" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "v0_payment_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "v0_payment_status_check" CHECK ("v0_payment"."status" in ('CONFIRMING', 'APPROVED', 'FAILED')),
	CONSTRAINT "v0_payment_amount_check" CHECK ("v0_payment"."amount" > 0),
	CONSTRAINT "v0_payment_approved_check" CHECK (("v0_payment"."status" = 'APPROVED') = ("v0_payment"."approved_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "v0_gate_staff" (
	"event_id" text NOT NULL,
	"account_id" text NOT NULL,
	CONSTRAINT "v0_gate_staff_event_id_account_id_pk" PRIMARY KEY("event_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "v0_ticket" (
	"ticket_id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"seat_id" text NOT NULL,
	"account_id" text NOT NULL,
	"code" text NOT NULL,
	"status" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"entered_at" timestamp with time zone,
	"entered_by" text,
	CONSTRAINT "v0_ticket_code_unique" UNIQUE("code"),
	CONSTRAINT "v0_ticket_order_seat_unique" UNIQUE("order_id","seat_id"),
	CONSTRAINT "v0_ticket_status_check" CHECK ("v0_ticket"."status" in ('ISSUED')),
	CONSTRAINT "v0_ticket_entered_check" CHECK (("v0_ticket"."entered_at" is null) = ("v0_ticket"."entered_by" is null))
);
--> statement-breakpoint
ALTER TABLE "v0_hold" DROP CONSTRAINT "v0_hold_status_check";--> statement-breakpoint
ALTER TABLE "v0_quota" ADD COLUMN "sold" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "v0_seat" ADD COLUMN "order_id" uuid;--> statement-breakpoint
ALTER TABLE "v0_hold" ADD CONSTRAINT "v0_hold_status_check" CHECK ("v0_hold"."status" in ('HELD', 'RELEASED', 'EXPIRED', 'SOLD'));--> statement-breakpoint
ALTER TABLE "v0_quota" ADD CONSTRAINT "v0_quota_sold_check" CHECK ("v0_quota"."sold" >= 0);--> statement-breakpoint
ALTER TABLE "v0_seat" ADD CONSTRAINT "v0_seat_order_check" CHECK (("v0_seat"."status" = 'SOLD') = ("v0_seat"."order_id" is not null));