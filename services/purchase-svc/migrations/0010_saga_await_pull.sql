-- 결제 결과 당기기의 대상과 점검 시각(ADR-0140 결정 1, docs/features/payment.md §2, docs/data.md order_saga_job·§5.1, BUILD_ORDER PRF-171 설계 1·3).
-- 표 정의는 src/modules/booking/adapters/db/schema.ts다. drizzle-kit generate가 내는 차례(제약 지우기 → 칸 더하기 → 제약 더하기)로 손으로 적었고,
-- 스냅샷(meta/0010_snapshot.json)과 표 정의가 맞는지는 db:generate가 '바뀐 것 없음'으로 확인한다.
-- order_saga_job.step에 AWAIT(승인 명령이 접수돼 결과를 기다림)를 더한다: 접수 뒤 작업 행을 지우지 않고 AWAIT로 남겨, 결과를 아직 반영하지 못한 주문을
--   주문 표에 색인을 더하지 않고 작은 작업 표에서 찾는다(data.md §5.1). 지금 있는 행은 모두 RESERVE·CONFIRM·RELEASE라 제약을 바꿔도 어긋나는 행이 없다.
-- order_saga_job.pull_next_at: 다음 당기기 점검 시각(널 허용, 비었으면 아직 한 번도 묻지 않았다). 당기기가 잡을 때 지금 + 5초 [가정]을 쓴다.
--   작업 표는 진행 중 주문만 남아 작으므로 새 인덱스는 두지 않는다.
ALTER TABLE "order_saga_job" DROP CONSTRAINT "order_saga_job_step_check";--> statement-breakpoint
ALTER TABLE "order_saga_job" ADD COLUMN "pull_next_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_saga_job" ADD CONSTRAINT "order_saga_job_step_check" CHECK ("order_saga_job"."step" in ('RESERVE', 'CONFIRM', 'RELEASE', 'AWAIT'));
