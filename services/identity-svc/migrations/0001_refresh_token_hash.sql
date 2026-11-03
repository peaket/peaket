CREATE TABLE "refresh_token_hash" (
	"hash" "bytea" PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"refresh_family" uuid NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "refresh_token_hash" ADD CONSTRAINT "refresh_token_hash_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refresh_token_hash_expires_idx" ON "refresh_token_hash" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "refresh_token_hash_session_idx" ON "refresh_token_hash" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_refresh_hash_key" ON "session" USING btree ("refresh_hash");--> statement-breakpoint
CREATE INDEX "session_prev_refresh_hash_idx" ON "session" USING btree ("prev_refresh_hash") WHERE "session"."prev_refresh_hash" is not null;--> statement-breakpoint
CREATE INDEX "session_refresh_family_idx" ON "session" USING btree ("refresh_family");