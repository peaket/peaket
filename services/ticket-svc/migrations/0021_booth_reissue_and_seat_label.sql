-- F-05-12 O-T28·O-T2 ②: 부스 재발급 허용과 좌석 이름 스냅샷(ticket).
-- ticket.seat_label: 발권할 때 좌석맵 판에서 읽은 사람이 읽는 이름. 옛 행은 NULL이고 읽을 때 seat_id로 물러난다.
-- booth_authorization: 관객이 만든 부스 코드(8자, 10분)와 책임자의 허용(찍은 때부터 10분), BOOTH 등록 사용 표시.
--   코드 해시는 SHA-256 hex만 둔다. used_at은 기기 키 저장과 같은 트랜잭션에서 한 번만 적는다.
ALTER TABLE "ticket" ADD COLUMN IF NOT EXISTS "seat_label" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "booth_authorization" (
  "id" uuid PRIMARY KEY,
  "ticket_id" uuid NOT NULL REFERENCES "ticket" ("id"),
  "event_id" uuid NOT NULL,
  "booth_code_hash" text NOT NULL,
  "reverification_id" uuid,
  "status" text NOT NULL,
  "day_key" text NOT NULL,
  "requested_at" timestamptz NOT NULL,
  "code_expires_at" timestamptz NOT NULL,
  "allowed_by" uuid,
  "allowed_at" timestamptz,
  "expires_at" timestamptz,
  "used_at" timestamptz,
  CONSTRAINT "booth_authorization_status_check" CHECK ("status" IN ('PENDING', 'ALLOWED', 'USED', 'EXPIRED'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "booth_authorization_ticket_day_idx" ON "booth_authorization" ("ticket_id", "day_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "booth_authorization_event_code_idx" ON "booth_authorization" ("event_id", "booth_code_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "booth_authorization_event_status_idx" ON "booth_authorization" ("event_id", "status");
