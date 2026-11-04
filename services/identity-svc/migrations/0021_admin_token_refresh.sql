-- 관리 계정 토큰 갱신(docs/data.md admin_session의 prev_refresh_hash·rotated_at·refresh_used와 admin_refresh_token_hash, docs/features/identity.md §6 '관리 계정 토큰 갱신과 로그아웃의 첫 구현', BUILD_ORDER BOT-130).
-- 이미 열린 관리 세션의 지금 리프레시 토큰 해시도 발급 해시 기록에 넣어, 회전 뒤 예전 토큰이 다시 오면 재사용으로 본다.
CREATE TABLE "admin_refresh_token_hash" (
	"hash" "bytea" PRIMARY KEY NOT NULL,
	"admin_session_id" uuid NOT NULL,
	"refresh_family" uuid NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_session" ADD COLUMN "prev_refresh_hash" "bytea";--> statement-breakpoint
ALTER TABLE "admin_session" ADD COLUMN "rotated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_session" ADD COLUMN "refresh_used" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_refresh_token_hash" ADD CONSTRAINT "admin_refresh_token_hash_admin_session_id_admin_session_id_fk" FOREIGN KEY ("admin_session_id") REFERENCES "public"."admin_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_refresh_token_hash_expires_idx" ON "admin_refresh_token_hash" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "admin_refresh_token_hash_session_idx" ON "admin_refresh_token_hash" USING btree ("admin_session_id");--> statement-breakpoint
CREATE INDEX "admin_session_prev_refresh_idx" ON "admin_session" USING btree ("prev_refresh_hash") WHERE "admin_session"."prev_refresh_hash" is not null;--> statement-breakpoint
CREATE INDEX "admin_session_family_idx" ON "admin_session" USING btree ("refresh_family");--> statement-breakpoint
INSERT INTO "admin_refresh_token_hash" ("hash", "admin_session_id", "refresh_family", "issued_at", "expires_at") SELECT "refresh_hash", "id", "refresh_family", "created_at", "absolute_expires_at" FROM "admin_session" WHERE "terminated_at" IS NULL ON CONFLICT DO NOTHING;
