CREATE TABLE "identity_verification" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"ci_hmac" "bytea" NOT NULL,
	"ci_hmac_key_version" integer NOT NULL,
	"pid" "bytea" NOT NULL,
	"pid_key_version" integer NOT NULL,
	"pid_prev" "bytea",
	"verified_at" timestamp with time zone NOT NULL,
	"source_record" text NOT NULL,
	CONSTRAINT "identity_verification_ci_hmac_unique" UNIQUE("ci_hmac")
);
--> statement-breakpoint
CREATE TABLE "verification_attempt" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"next" text NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "verification_attempt_purpose_check" CHECK ("verification_attempt"."purpose" in ('FIRST', 'REVERIFY', 'MINOR_CONTRACT')),
	CONSTRAINT "verification_attempt_status_check" CHECK ("verification_attempt"."status" in ('PENDING', 'VERIFIED', 'CANCELLED', 'FAILED', 'DUPLICATE_ACCOUNT'))
);
--> statement-breakpoint
CREATE INDEX "verification_attempt_account_idx" ON "verification_attempt" USING btree ("account_id");--> statement-breakpoint
-- account 외래키(docs/data.md account_id FK). 다른 컨텍스트(session)의 표라 Drizzle 표 정의에 두지 않고 손으로 건다
ALTER TABLE "identity_verification" ADD CONSTRAINT "identity_verification_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_attempt" ADD CONSTRAINT "verification_attempt_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;
