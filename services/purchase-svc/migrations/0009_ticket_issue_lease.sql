-- 발권 재시도 큐의 임대와 한 번 내는 신호 시각(docs/data.md §4 열 번째 마이그레이션, ADR-0106 결정 2, BUILD_ORDER PRF-170).
-- drizzle-kit이 만든 SQL 그대로다(표 정의는 src/modules/booking/adapters/db/schema.ts).
-- lease_until: 발권 실행기가 짧은 트랜잭션에서 FOR UPDATE SKIP LOCKED로 골라 쓰는 임대 끝 시각(order_saga_job.lease_until과 같은 꼴, 잡지 않았으면 비움).
-- delayed_at: trade.orders ISSUE_DELAYED를 낸 시각(주문마다 한 번). overdue_at: 발권 기한 넘김 신호(SEV1)를 낸 시각(주문마다 한 번).
-- 셋 다 널 허용이다. 큐 행은 승인 뒤 발권까지만 남아 적으므로 새 인덱스는 두지 않는다(쓸기 색인은 0007의 next_attempt_at 그대로).
ALTER TABLE "ticket_issue_job" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ticket_issue_job" ADD COLUMN "delayed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ticket_issue_job" ADD COLUMN "overdue_at" timestamp with time zone;
