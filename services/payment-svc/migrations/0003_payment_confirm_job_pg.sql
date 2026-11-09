-- 승인 명령 행에 결제사 채널을 더하고 잡기 색인을 채널별로 바꾼다(docs/data.md §2 payment_confirm_job·§4 '결제 표 마이그레이션'·§5.1 '승인 명령 잡기', docs/features/payment.md §2 '결제사 호출 보호의 첫 구현', BUILD_ORDER PRF-183 코드 리뷰).
-- 잡기가 payment를 조인해 결제사를 고르면 다른 채널의 쌓인 행을 지나가야 해 한 채널의 밀림이 다른 채널의 잡기를 늦춘다.
-- payment_confirm_job 표는 아직 배포된 적이 없어 행이 없다. 그래서 NOT NULL 칸을 기본값 없이 더하고 기존 행을 채우는 문장이 없다.
DROP INDEX "payment_confirm_job_next_idx";--> statement-breakpoint
ALTER TABLE "payment_confirm_job" ADD COLUMN "pg" text NOT NULL;--> statement-breakpoint
CREATE INDEX "payment_confirm_job_claim_idx" ON "payment_confirm_job" USING btree ("pg","next_attempt_at","payment_id");--> statement-breakpoint
ALTER TABLE "payment_confirm_job" ADD CONSTRAINT "payment_confirm_job_pg_check" CHECK ("payment_confirm_job"."pg" IN ('TOSS', 'PORTONE', 'SIMULATOR'));
