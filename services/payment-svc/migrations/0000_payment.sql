CREATE TABLE "payment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"pg" text NOT NULL,
	"pg_payment_ref" text NOT NULL,
	"pg_confirm_token" text,
	"deposit_secret_hash" "bytea",
	"amount" integer NOT NULL,
	"status" text NOT NULL,
	"deposit_due_at" timestamp with time zone,
	"virtual_account_no" text,
	"virtual_account_bank" text,
	"idempotency_key" text NOT NULL,
	"payment_method_ref" text,
	"card_bin" text,
	"authenticated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"status_changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payment_status_check" CHECK ("payment"."status" IN ('ACCEPTED', 'AWAITING_DEPOSIT', 'APPROVED', 'UNKNOWN', 'FAILED', 'PARTIAL_CANCELED', 'CANCELED')),
	CONSTRAINT "payment_pg_check" CHECK ("payment"."pg" IN ('TOSS', 'PORTONE', 'SIMULATOR')),
	CONSTRAINT "payment_amount_check" CHECK ("payment"."amount" > 0),
	CONSTRAINT "payment_attempt_no_check" CHECK ("payment"."attempt_no" >= 1),
	CONSTRAINT "payment_method_ref_card_bin_check" CHECK (("payment"."payment_method_ref" IS NULL) = ("payment"."card_bin" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "payment_confirm_job" (
	"payment_id" uuid PRIMARY KEY NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_confirm_job_attempts_check" CHECK ("payment_confirm_job"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payment_event" (
	"payment_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"event_key" uuid NOT NULL,
	"type" text NOT NULL,
	"exported" boolean NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payment_event_payment_id_seq_pk" PRIMARY KEY("payment_id","seq"),
	CONSTRAINT "payment_event_seq_check" CHECK ("payment_event"."seq" >= 1)
);
--> statement-breakpoint
ALTER TABLE "payment_confirm_job" ADD CONSTRAINT "payment_confirm_job_payment_id_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_event" ADD CONSTRAINT "payment_event_payment_id_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_order_id_key" ON "payment" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payment_confirm_job_next_idx" ON "payment_confirm_job" USING btree ("next_attempt_at");
--> statement-breakpoint
-- Outbox 부모 표(서비스 뼈대 packages/platform/template/migrations/0002_outbox.sql을 그대로 옮겼다, BUILD_ORDER PRF-180). Drizzle 0.45에는 파티션 선언이 없어 손으로 덧붙였다.
-- Outbox 부모 표(docs/data.md §2 '파티션 표 규칙'·§4의 7번, ADR-0083·0116). Drizzle 0.45에는 파티션 선언이 없어 손으로 쓴 SQL이다.
-- ID(UUIDv7, 주입한 시계) 범위로 한국 시각 하루씩 나눈다. 기본(DEFAULT) 파티션은 두지 않는다.
-- 파티션은 @peaket/platform의 ensureOutboxPartitions가 만든다(첫 파티션 포함, 7일 [가정] 앞까지). 날짜를 박은 첫 파티션은 배포 날짜와 어긋나 첫 쓰기가 실패한다.
-- seq는 보내는 순서, sent_at은 릴레이가 보낸 뒤 적는다. 보내지 않은 행은 부분 인덱스로 찾는다(sent_at을 적으면 빠진다).
CREATE SEQUENCE "outbox_seq" AS bigint;
CREATE TABLE "outbox" (
	"id" uuid NOT NULL,
	"seq" bigint NOT NULL DEFAULT nextval('outbox_seq'),
	"topic" text NOT NULL,
	"msg_key" text NOT NULL,
	"payload" bytea NOT NULL,
	"headers" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"sent_at" timestamp with time zone,
	CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
) PARTITION BY RANGE ("id");
ALTER SEQUENCE "outbox_seq" OWNED BY "outbox"."seq";
CREATE INDEX "outbox_unsent_idx" ON "outbox" ("seq") WHERE "sent_at" IS NULL;
