-- 0004에서 NOT VALID로 더한 상태 CHECK를 검증한다(SHARE UPDATE EXCLUSIVE 잠금이라 읽기·쓰기를 막지 않는다. docs/devops.md §7.2).
-- 운영 실행기(BAS-060)는 이 파일을 0004와 따로 트랜잭션으로 돌린다. 로컬·CI의 Drizzle 실행기는 0004·0005를 한 트랜잭션으로 돌리지만, 그때는 표가 작아 잠금이 길지 않다(BOT-010이 넘긴 것).
-- 새 조건은 옛 조건을 넓힌 것이라 이미 있는 행은 모두 맞는다.
ALTER TABLE "verification_attempt" VALIDATE CONSTRAINT "verification_attempt_status_check";
