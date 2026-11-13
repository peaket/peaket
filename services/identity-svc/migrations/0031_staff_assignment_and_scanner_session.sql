-- 현장 스태프 배정과 스캐너 세션(docs/data.md staff_assignment·scanner_session, docs/features/identity.md §6.1, docs/features/offline-gate.md §6.1, BUILD_ORDER GAT-210·GAT-170).
-- 배정의 초대 메일 주소·토큰 해시는 수락·만료·거절 때 지운다. 기기 원장(scanner_device)은 ticket 데이터라 외래키 없이 기기 ID만 둔다.
CREATE TABLE "staff_assignment" (
  "id" uuid PRIMARY KEY NOT NULL,
  "account_id" uuid,
  "event_id" uuid NOT NULL,
  "role" text NOT NULL,
  "invite_email" text,
  "invite_token_hash" bytea,
  "invite_expires_at" timestamp with time zone NOT NULL,
  "invited_by" uuid NOT NULL,
  "valid_from" timestamp with time zone NOT NULL,
  "valid_until" timestamp with time zone NOT NULL,
  "status" text NOT NULL,
  "accepted_at" timestamp with time zone,
  "consent_version" text,
  CONSTRAINT "staff_assignment_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "account"("id"),
  CONSTRAINT "staff_assignment_role_check" CHECK ("staff_assignment"."role" in ('gate_staff', 'gate_lead')),
  CONSTRAINT "staff_assignment_status_check" CHECK ("staff_assignment"."status" in ('INVITED', 'ASSIGNED', 'REVOKED', 'ENDED', 'EXPIRED')),
  CONSTRAINT "staff_assignment_window_check" CHECK ("staff_assignment"."valid_from" <= "staff_assignment"."valid_until"),
  CONSTRAINT "staff_assignment_consent_version_check" CHECK ("staff_assignment"."consent_version" is null or char_length("staff_assignment"."consent_version") between 1 and 32)
);--> statement-breakpoint
CREATE UNIQUE INDEX "staff_assignment_event_account_key" ON "staff_assignment" USING btree ("event_id","account_id");--> statement-breakpoint
CREATE INDEX "staff_assignment_account_status_idx" ON "staff_assignment" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "staff_assignment_event_status_idx" ON "staff_assignment" USING btree ("event_id","status");--> statement-breakpoint
CREATE INDEX "staff_assignment_invite_token_idx" ON "staff_assignment" USING btree ("invite_token_hash") WHERE "staff_assignment"."invite_token_hash" is not null;--> statement-breakpoint
CREATE TABLE "scanner_session" (
  "id" uuid PRIMARY KEY NOT NULL,
  "staff_assignment_id" uuid NOT NULL,
  "scanner_device_id" uuid NOT NULL,
  "approved_by_session" uuid,
  "role" text NOT NULL,
  "proxy" boolean DEFAULT false NOT NULL,
  "approved_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "last_seen_at" timestamp with time zone,
  "terminated_at" timestamp with time zone,
  CONSTRAINT "scanner_session_staff_assignment_id_staff_assignment_id_fk" FOREIGN KEY ("staff_assignment_id") REFERENCES "staff_assignment"("id"),
  CONSTRAINT "scanner_session_role_check" CHECK ("scanner_session"."role" in ('gate_staff', 'gate_lead')),
  CONSTRAINT "scanner_session_proxy_role_check" CHECK (not "scanner_session"."proxy" or "scanner_session"."role" = 'gate_staff')
);--> statement-breakpoint
CREATE INDEX "scanner_session_assignment_idx" ON "scanner_session" USING btree ("staff_assignment_id");--> statement-breakpoint
CREATE INDEX "scanner_session_device_active_idx" ON "scanner_session" USING btree ("scanner_device_id") WHERE "scanner_session"."terminated_at" is null;
