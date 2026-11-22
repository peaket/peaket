-- BAT-455 GAT-250: 팬 알림 신청·웹 푸시 구독·낱건 발송 원장(0046, docs/data.md §2 ⑥, notify §2.2·§4.1).
-- 파티션 표(notification_delivery)라 drizzle-kit 생성기를 쓰지 않고 손으로 쓴다(ADR-0083·ADR-0114).
-- 첫 파티션은 날짜를 박지 않고 정비 함수 ensureMonthlyPartitions가 마이그레이션 직후와 매일 만든다.
CREATE TABLE "notification_subscription" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"night_push" boolean DEFAULT false NOT NULL,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"end_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "notification_subscription_kind_check" CHECK ("notification_subscription"."kind" in ('OPEN', 'CANCELLATION')),
	CONSTRAINT "notification_subscription_status_check" CHECK ("notification_subscription"."status" in ('ACTIVE', 'ENDED')),
	CONSTRAINT "notification_subscription_end_reason_check" CHECK ("notification_subscription"."end_reason" is null or "notification_subscription"."end_reason" in ('SENT_MAX', 'BOOKED', 'SALE_ENDED')),
	CONSTRAINT "notification_subscription_sent_count_check" CHECK ("notification_subscription"."sent_count" >= 0),
	CONSTRAINT "notification_subscription_account_event_kind_uq" UNIQUE("account_id","event_id","kind")
);
--> statement-breakpoint
CREATE TABLE "push_subscription" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"endpoint_hash" text NOT NULL,
	"service" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"expires_at" timestamp with time zone,
	"bound_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "push_subscription_service_check" CHECK ("push_subscription"."service" in ('FCM', 'MOZILLA', 'APPLE', 'WNS')),
	CONSTRAINT "push_subscription_endpoint_uq" UNIQUE("endpoint"),
	CONSTRAINT "push_subscription_endpoint_hash_uq" UNIQUE("endpoint_hash")
);
--> statement-breakpoint
CREATE TABLE "notification_dedup" (
	"dedup_key" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_job" (
	"dedup_key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"target_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"vars" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"lease_until" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "notification_job_status_check" CHECK ("notification_job"."status" in ('PENDING', 'RETRYING', 'DEAD')),
	CONSTRAINT "notification_job_channel_check" CHECK ("notification_job"."channel" in ('EMAIL', 'WEB_PUSH', 'ALIMTALK', 'SMS')),
	CONSTRAINT "notification_job_attempts_check" CHECK ("notification_job"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "notification_delivery" (
	"dedup_key" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"target_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"provider_message_id" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "notification_delivery_status_check" CHECK ("notification_delivery"."status" in ('PENDING', 'SENT', 'FAILED', 'DEAD', 'EXPIRED')),
	CONSTRAINT "notification_delivery_dedup_key_sent_at_pk" PRIMARY KEY("dedup_key","sent_at")
) PARTITION BY RANGE ("sent_at");
--> statement-breakpoint
ALTER TABLE "notification_job" ADD CONSTRAINT "notification_job_dedup_key_notification_dedup_dedup_key_fk" FOREIGN KEY ("dedup_key") REFERENCES "public"."notification_dedup"("dedup_key") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "notification_subscription_event_kind_id_idx" ON "notification_subscription" USING btree ("event_id","kind","id");
--> statement-breakpoint
CREATE INDEX "notification_subscription_account_created_idx" ON "notification_subscription" USING btree ("account_id","created_at");
--> statement-breakpoint
CREATE INDEX "push_subscription_account_bound_idx" ON "push_subscription" USING btree ("account_id","bound_at");
--> statement-breakpoint
CREATE INDEX "notification_job_due_idx" ON "notification_job" USING btree ("next_attempt_at") WHERE "notification_job"."status" in ('PENDING', 'RETRYING');
--> statement-breakpoint
-- 팬 경로(core_app): 신청·구독·원장을 읽고 쓴다. 계정 ID로만 거르고 테넌트 행 보안은 걸지 않는다(찜과 같은 팬 표).
GRANT SELECT, INSERT, UPDATE, DELETE ON "notification_subscription", "push_subscription", "notification_dedup", "notification_job", "notification_delivery" TO core_app;
--> statement-breakpoint
-- 발송기(core_notify, ADR-0351): 코드가 쓰는 만큼만 준다.
-- 신청은 읽고 보낸 횟수·상태·밤 설정만 고친다. 구독은 읽고 만료된 행만 지운다. 원장은 적고 집은 행의 결과 칸만 고친다.
GRANT SELECT ON "notification_subscription" TO core_notify;
--> statement-breakpoint
GRANT UPDATE ("night_push", "sent_count", "status", "end_reason", "updated_at") ON "notification_subscription" TO core_notify;
--> statement-breakpoint
GRANT SELECT, DELETE ON "push_subscription" TO core_notify;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "notification_dedup" TO core_notify;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "notification_job" TO core_notify;
--> statement-breakpoint
GRANT UPDATE ("status", "attempts", "next_attempt_at", "lease_until") ON "notification_job" TO core_notify;
--> statement-breakpoint
GRANT SELECT, INSERT ON "notification_delivery" TO core_notify;

--> statement-breakpoint
-- 정비(core_maintenance): 지난 신청·중복 키 지우기와 발송 기록 파티션 정리(7일·90일, docs/data.md §2 ⑥).
-- 발송 기록의 DETACH는 정비 연결이 한다(플랫폼 dropMonthlyPartitions, 기존 월 파티션 표와 같은 길).
GRANT SELECT, DELETE ON "notification_subscription", "notification_dedup" TO core_maintenance;
--> statement-breakpoint
GRANT SELECT ("id", "ends_at") ON "event" TO core_maintenance;
