-- 0006에서 NOT VALID로 더한 CHECK 둘을 검증한다(따로 트랜잭션이면 SHARE UPDATE EXCLUSIVE 잠금이라 읽기·쓰기를 막지 않는다. docs/devops.md §7.2).
-- 새 조건은 옛 조건을 넓힌 것이거나(상태) 새 칸(사유, 모두 NULL)이라 이미 있는 행은 모두 맞는다.
ALTER TABLE "verification_attempt" VALIDATE CONSTRAINT "verification_attempt_status_check";--> statement-breakpoint
ALTER TABLE "account" VALIDATE CONSTRAINT "account_closure_reason_check";
