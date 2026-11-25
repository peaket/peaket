-- F-05-12 O-T28 ①: 부스 재발급 본인확인 대조(identity).
-- - booth_reverification: 대조 결과 한 건. 연계정보 원문·토큰 원문은 두지 않고 토큰 SHA-256 해시만 둔다.
-- - verification_attempt.ticket_id: 부스 대조 건이 어느 티켓을 보는지 남긴다(ticket 논리 DB라 외래키 없음).
-- - purpose CHECK에 BOOTH를 더한다(전용 시작 경로만 만들고 일반 시작 경로는 받지 않는다).
CREATE TABLE IF NOT EXISTS "booth_reverification" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "ticket_id" uuid NOT NULL,
  "verification_id" uuid NOT NULL UNIQUE,
  "ci_matched" boolean NOT NULL,
  "token_hash" bytea,
  "created_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "booth_reverification_token_idx" ON "booth_reverification" ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "booth_reverification_ticket_idx" ON "booth_reverification" ("ticket_id");--> statement-breakpoint
ALTER TABLE "verification_attempt" ADD COLUMN IF NOT EXISTS "ticket_id" uuid;--> statement-breakpoint
ALTER TABLE "verification_attempt" DROP CONSTRAINT IF EXISTS "verification_attempt_purpose_check";--> statement-breakpoint
ALTER TABLE "verification_attempt" ADD CONSTRAINT "verification_attempt_purpose_check" CHECK ("purpose" in ('FIRST', 'REVERIFY', 'MINOR_CONTRACT', 'BOOTH'));
