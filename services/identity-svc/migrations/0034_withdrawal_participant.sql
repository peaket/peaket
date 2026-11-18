-- 탈퇴 참여자와 탈퇴 미룸(docs/features/identity.md §8 '탈퇴 참여자와 탈퇴 미룸의 첫 구현', ADR-0284, BUILD_ORDER PRF-169, docs/data.md account·§5.1 '탈퇴 미룸 다시 하기 고리').
-- 표 정의는 src/modules/session/adapters/db/schema.ts다. 0031~0033처럼 손으로 적었다(스냅샷은 0030까지라 db:generate 결과가 앞선 손 마이그레이션까지 섞는다).
-- ① 정리 사유 CHECK에 WITHDRAWAL(탈퇴 요청을 참여자가 끝낼 때까지 미룸, 202)을 더한다. 값을 넓히기만 하므로 지금 행은 모두 맞는다.
-- ② closure_next_check_at: 미룬 탈퇴의 다음 참여자 확인 시각(미룰 때와 고리가 잡을 때 지금 + 60초 [가정]).
-- ③ 부분 인덱스 account_withdrawal_retry_idx: 고리의 잡기 문장(status·closure_reason·이 칸)만 쓴다. 미룬 계정만 담겨 작다.
-- 운영에 나가기 전이라 트랜잭션 안에서 만든다(docs/devops.md §7.2).
ALTER TABLE "account" DROP CONSTRAINT "account_closure_reason_check";--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_closure_reason_check" CHECK ("account"."closure_reason" is null or "account"."closure_reason" in ('UNDER_14', 'WITHDRAWAL'));--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "closure_next_check_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "account_withdrawal_retry_idx" ON "account" USING btree ("closure_next_check_at") WHERE "account"."status" = 'WITHDRAWAL_PENDING' AND "account"."closure_reason" = 'WITHDRAWAL';
