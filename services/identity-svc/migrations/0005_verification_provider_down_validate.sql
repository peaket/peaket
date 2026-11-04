-- 0004에서 NOT VALID로 더한 상태 CHECK를 검증한다(따로 트랜잭션, SHARE UPDATE EXCLUSIVE 잠금이라 읽기·쓰기를 막지 않는다. docs/devops.md §7.2).
-- 새 조건은 옛 조건을 넓힌 것이라 이미 있는 행은 모두 맞는다.
ALTER TABLE "verification_attempt" VALIDATE CONSTRAINT "verification_attempt_status_check";
