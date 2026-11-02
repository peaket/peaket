CREATE TABLE "account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"merged_into_account_id" uuid,
	"nickname" text,
	"email" text,
	"phone" text,
	"member_code" text,
	"saved_booker_name" text,
	"saved_booker_phone" text,
	"age_verified" boolean DEFAULT false NOT NULL,
	"locale" text DEFAULT 'ko' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "account_member_code_unique" UNIQUE("member_code"),
	CONSTRAINT "account_status_check" CHECK ("account"."status" in ('ACTIVE', 'WITHDRAWAL_PENDING', 'MERGED', 'DELETED')),
	CONSTRAINT "account_locale_check" CHECK ("account"."locale" in ('ko', 'en', 'ja', 'zh')),
	CONSTRAINT "account_merged_check" CHECK (("account"."status" = 'MERGED') = ("account"."merged_into_account_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "account_provider" (
	"account_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"linked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "account_provider_pkey" PRIMARY KEY("provider","provider_user_id"),
	CONSTRAINT "account_provider_provider_check" CHECK ("account_provider"."provider" in ('kakao', 'naver', 'google'))
);
--> statement-breakpoint
CREATE TABLE "device" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"device_ref" text NOT NULL,
	"device_ref_prev" text,
	"bound_at" timestamp with time zone NOT NULL,
	CONSTRAINT "device_account_ref_key" UNIQUE("account_id","device_ref")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"device_id" uuid,
	"refresh_hash" "bytea" NOT NULL,
	"refresh_family" uuid NOT NULL,
	"prev_refresh_hash" "bytea",
	"rotated_at" timestamp with time zone,
	"refresh_used" boolean DEFAULT false NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"terminated_at" timestamp with time zone,
	"login_verdict" text NOT NULL,
	"login_verdict_reason" text,
	"login_verdict_at" timestamp with time zone,
	CONSTRAINT "session_login_verdict_check" CHECK ("session"."login_verdict" in ('ALLOW', 'CHALLENGE', 'UNKNOWN'))
);
--> statement-breakpoint
CREATE TABLE "session_create_key" (
	"key" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"new_account" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_provider" ADD CONSTRAINT "account_provider_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device" ADD CONSTRAINT "device_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_create_key" ADD CONSTRAINT "session_create_key_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_provider_account_idx" ON "account_provider" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "session_account_active_idx" ON "session" USING btree ("account_id") WHERE "session"."terminated_at" is null;--> statement-breakpoint
CREATE INDEX "session_create_key_created_idx" ON "session_create_key" USING btree ("created_at");