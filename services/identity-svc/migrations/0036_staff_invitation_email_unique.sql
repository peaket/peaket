-- BAT-450B: 같은 회차·같은 이메일의 INVITED 중복을 DB에서도 막는다(identity §6.1, ADR-0353).
-- 초대 생성 경로가 없던 때의 시드·가져오기 데이터에 중복이 있으면 인덱스 생성이 실패하므로,
-- 만료가 늦은 행 하나만 남기고 나머지를 EXPIRED로 바꾸며 초대 이메일·토큰을 지운 뒤 인덱스를 만든다(리뷰 RV-01).
UPDATE "staff_assignment" a
SET "status" = 'EXPIRED', "invite_email" = NULL, "invite_token_hash" = NULL
WHERE a."status" = 'INVITED' AND a."invite_email" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "staff_assignment" b
    WHERE b."status" = 'INVITED'
      AND b."event_id" = a."event_id"
      AND lower(b."invite_email") = lower(a."invite_email")
      AND (b."invite_expires_at" > a."invite_expires_at"
        OR (b."invite_expires_at" = a."invite_expires_at" AND b."id" > a."id"))
  );

CREATE UNIQUE INDEX IF NOT EXISTS "staff_assignment_event_invite_email_key"
  ON "staff_assignment" USING btree ("event_id", lower("invite_email"))
  WHERE "status" = 'INVITED' AND "invite_email" IS NOT NULL;
