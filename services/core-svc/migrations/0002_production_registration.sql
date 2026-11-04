-- 공연 등록·회차 더하기·찜(ADR-0198, BUILD_ORDER HOT-171): 등록 칸과 새 공연장·아티스트 요청 칸, 변경분, 배치본·공연장 칸 비우기, 찜·멱등 기록 표,
-- 오픈 간격 판정 인덱스. 판매 중지도 승인 이력이 있어야 한다는 제약으로 바로잡는다(ADR-0198 결정 7). 표가 비어 있는 단계라 잠금 대기 걱정 없이 바로 건다.
CREATE TABLE "idempotency_record" (
	"account_ref" text NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_hash" "bytea" NOT NULL,
	"result_ref" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_record_account_ref_operation_idempotency_key_pk" PRIMARY KEY("account_ref","operation","idempotency_key"),
	CONSTRAINT "idempotency_record_operation_check" CHECK ("idempotency_record"."operation" in ('CREATE_PRODUCTION', 'CREATE_PRODUCTION_EVENT'))
);
--> statement-breakpoint
CREATE TABLE "wish" (
	"account_id" uuid NOT NULL,
	"production_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "wish_account_id_production_id_pk" PRIMARY KEY("account_id","production_id")
);
--> statement-breakpoint
ALTER TABLE "production" DROP CONSTRAINT "production_sale_approved_check";--> statement-breakpoint
ALTER TABLE "event" ALTER COLUMN "venue_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "production" ALTER COLUMN "place_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "event" ADD COLUMN "reentry_allowed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "event" ADD COLUMN "lobby_minutes" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "event" ADD COLUMN "lobby_shuffle" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "event" ADD COLUMN "open_batch" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "event" ADD COLUMN "seat_assignment" text DEFAULT 'PICK' NOT NULL;--> statement-breakpoint
ALTER TABLE "event" ADD COLUMN "per_person_limit" integer DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE "event" ADD COLUMN "sale_policy" jsonb;--> statement-breakpoint
ALTER TABLE "production" ADD COLUMN "kopis_fields" jsonb;--> statement-breakpoint
ALTER TABLE "production" ADD COLUMN "pending_revision" jsonb;--> statement-breakpoint
ALTER TABLE "production" ADD COLUMN "requested_place" jsonb;--> statement-breakpoint
ALTER TABLE "production" ADD COLUMN "requested_artists" jsonb;--> statement-breakpoint
ALTER TABLE "wish" ADD CONSTRAINT "wish_production_id_production_id_fk" FOREIGN KEY ("production_id") REFERENCES "public"."production"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idempotency_record_created_at_idx" ON "idempotency_record" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "wish_account_created_idx" ON "wish" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "event_open_at_idx" ON "event" USING btree ("open_at");--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_lobby_minutes_check" CHECK ("event"."lobby_minutes" between 0 and 60);--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_queue_order_check" CHECK ("event"."lobby_shuffle" or "event"."open_batch");--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_seat_assignment_check" CHECK ("event"."seat_assignment" in ('PICK', 'AUTO'));--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_per_person_limit_check" CHECK ("event"."per_person_limit" between 1 and 10);--> statement-breakpoint
ALTER TABLE "production" ADD CONSTRAINT "production_place_check" CHECK (("production"."place_id" is null) <> ("production"."requested_place" is null));--> statement-breakpoint
ALTER TABLE "production" ADD CONSTRAINT "production_approved_place_check" CHECK ("production"."sale_approved_at" is null or "production"."place_id" is not null);--> statement-breakpoint
ALTER TABLE "production" ADD CONSTRAINT "production_sale_approved_check" CHECK (("production"."sale_review" <> 'DRAFT' or "production"."sale_approved_at" is null) and ("production"."sale_review" not in ('APPROVED', 'SUSPENDED') or "production"."sale_approved_at" is not null));