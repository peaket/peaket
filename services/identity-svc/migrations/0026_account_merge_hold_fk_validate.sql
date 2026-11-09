-- 0025에서 NOT VALID로 더한 account_hold·account_merge의 외래키 셋을 검증한다(docs/devops.md §7.2, BUILD_ORDER BOT-042가 넘긴 것). 따로 트랜잭션이면 검증은 SHARE UPDATE EXCLUSIVE 잠금이라 읽기·쓰기를 막지 않는다.
-- 운영 실행기(BAS-060)는 이 파일을 0025와 따로 트랜잭션으로 돌린다. 로컬·CI의 Drizzle 실행기는 0025·0026을 한 트랜잭션으로 돌려 0025의 잠금을 쥔 채 검증하지만, 그때는 표가 작아 잠금이 길지 않다.
-- 0025 앞에는 SetAccountHold가 없는 계정의 건도 받았으므로, 그런 행(병합에 쓰일 일이 없다)을 먼저 지운다. account_merge는 확정 트랜잭션이 있는 두 계정으로만 썼다.
DELETE FROM "account_hold" WHERE NOT EXISTS (SELECT 1 FROM "account" WHERE "account"."id" = "account_hold"."account_id");--> statement-breakpoint
ALTER TABLE "account_hold" VALIDATE CONSTRAINT "account_hold_account_id_account_id_fk";--> statement-breakpoint
ALTER TABLE "account_merge" VALIDATE CONSTRAINT "account_merge_primary_account_id_account_id_fk";--> statement-breakpoint
ALTER TABLE "account_merge" VALIDATE CONSTRAINT "account_merge_merged_account_id_account_id_fk";
