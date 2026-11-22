-- BAT-450C: 배정 만료 정비(INVITED→EXPIRED, ASSIGNED→ENDED)가 훑는 열의 부분 인덱스(identity §6.1, C2-11).
-- 정비는 하루 한 번 두 상태의 시각 열을 훑는다. 상태별 부분 인덱스로 살아 있는 행만 본다.
CREATE INDEX IF NOT EXISTS "staff_assignment_invite_expiry_idx" ON "staff_assignment" USING btree ("invite_expires_at") WHERE "status" = 'INVITED';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_assignment_assigned_valid_until_idx" ON "staff_assignment" USING btree ("valid_until") WHERE "status" = 'ASSIGNED';
