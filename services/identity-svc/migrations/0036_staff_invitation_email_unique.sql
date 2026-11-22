-- BAT-450B: 같은 회차·같은 이메일의 INVITED 중복을 DB에서도 막는다(identity §6.1, ADR-0353).
-- 초대를 여러 번 보내면 재발송 경로를 쓰고, 아직 수락하지 않은 같은 이메일 행은 하나만 둔다.
CREATE UNIQUE INDEX IF NOT EXISTS "staff_assignment_event_invite_email_key"
  ON "staff_assignment" USING btree ("event_id", lower("invite_email"))
  WHERE "status" = 'INVITED' AND "invite_email" IS NOT NULL;
