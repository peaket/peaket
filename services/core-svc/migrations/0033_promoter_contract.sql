-- BAT-615 LCH-070: 파트너 계약 조건·기간 이력·변경 승인 대기 표시와 판매 승인 때 고정할 수수료율(ADR-0320, settlement §4.1·§10).
-- 1) promoter에 지금 계약 수수료율과 승인 대기 업무 ID를 더한다.
-- 2) promoter_contract에 수수료율·보증 비율·보증 종류·유효 기간(tstzrange)을 남긴다. 기간은 겹치지 않는다(PG 18 WITHOUT OVERLAPS).
-- 3) 기존 promoter 행에는 1000bp·1000bp·DEPOSIT [가정]의 첫 계약을 채운다(계약 없는 회차를 만들지 않는다, A1-H10).
-- 4) event.commission_rate_bp는 판매 승인 때 그 파트너의 지금 계약에서 복사한다.
-- 5) 관제(core_ops)·파트너(core_partner) 역할 권한과 행 보안. core_app은 계약 표를 읽지 못한다(ADR-0320 결정 8).
-- 6) 0033 이전에 판매 승인된 회차의 event.commission_rate_bp를 그 파트너의 지금 계약 수수료율로 한 번 채운다(RV-02).
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "promoter" ADD COLUMN IF NOT EXISTS "commission_rate_bp" integer DEFAULT 1000;
--> statement-breakpoint
ALTER TABLE "promoter" ADD COLUMN IF NOT EXISTS "pending_contract_approval_id" uuid;
--> statement-breakpoint
UPDATE "promoter" SET "commission_rate_bp" = 1000 WHERE "commission_rate_bp" IS NULL;
--> statement-breakpoint
ALTER TABLE "promoter" ALTER COLUMN "commission_rate_bp" SET NOT NULL;
--> statement-breakpoint
-- 칸을 빼고 넣는 기존 시드·도구가 23502로 죽지 않게 스키마(schema.ts default(1000))와 같은 기본값을 둔다
ALTER TABLE "promoter" ALTER COLUMN "commission_rate_bp" SET DEFAULT 1000;
--> statement-breakpoint
ALTER TABLE "promoter" DROP CONSTRAINT IF EXISTS "promoter_commission_rate_check";
--> statement-breakpoint
ALTER TABLE "promoter" ADD CONSTRAINT "promoter_commission_rate_check" CHECK ("commission_rate_bp" between 0 and 10000);
--> statement-breakpoint
ALTER TABLE "event" ADD COLUMN IF NOT EXISTS "commission_rate_bp" integer;
--> statement-breakpoint
ALTER TABLE "event" DROP CONSTRAINT IF EXISTS "event_commission_rate_check";
--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_commission_rate_check" CHECK ("commission_rate_bp" is null or "commission_rate_bp" between 0 and 10000);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "promoter_contract" (
  "id" uuid PRIMARY KEY,
  "promoter_id" uuid NOT NULL,
  "commission_rate_bp" integer NOT NULL,
  "guarantee_rate_bp" integer NOT NULL,
  "guarantee_kind" text NOT NULL,
  "valid_during" tstzrange NOT NULL,
  "approval_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_by" uuid,
  CONSTRAINT "promoter_contract_promoter_fk" FOREIGN KEY ("promoter_id") REFERENCES "promoter"("id"),
  CONSTRAINT "promoter_contract_rate_check" CHECK ("commission_rate_bp" between 0 and 10000 and "guarantee_rate_bp" between 0 and 10000),
  CONSTRAINT "promoter_contract_kind_check" CHECK ("guarantee_kind" in ('DEPOSIT', 'PERFORMANCE_BOND')),
  CONSTRAINT "promoter_contract_period_check" CHECK (not isempty("valid_during")),
  CONSTRAINT "promoter_contract_promoter_period_uq" UNIQUE ("promoter_id", "valid_during" WITHOUT OVERLAPS)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promoter_contract_promoter_idx" ON "promoter_contract" ("promoter_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promoter_contract_approval_idx" ON "promoter_contract" ("approval_id");
--> statement-breakpoint
-- 기존 파트너에게 첫 계약을 채운다. 마이그레이션 시각부터 상한 없는 기간 하나다(이미 있는 계약은 건드리지 않는다)
INSERT INTO "promoter_contract" ("id", "promoter_id", "commission_rate_bp", "guarantee_rate_bp", "guarantee_kind", "valid_during", "approval_id", "created_at")
SELECT gen_random_uuid(), p."id", 1000, 1000, 'DEPOSIT', tstzrange(now(), NULL, '[)'), NULL, now()
FROM "promoter" p
WHERE NOT EXISTS (SELECT 1 FROM "promoter_contract" c WHERE c."promoter_id" = p."id");
--> statement-breakpoint
-- 0033 이전에 이미 판매 승인된 회차를 그 파트너의 지금 계약 수수료율로 한 번 채운다(RV-02, settlement §4.1·A1-H10).
-- 재승인은 기존 회차 값을 바꾸지 않으므로 여기서 채우지 않으면 옛 회차의 설정 사본이 계속 수수료율 없이 남아 payment-svc 정산이 503으로 닫힌다.
-- 계약이 없으면 마이그레이션 기본값 1000bp를 쓴다(위 백필 뒤에는 모든 파트너에 계약이 있다).
UPDATE "event" e
SET "commission_rate_bp" = coalesce(c."commission_rate_bp", 1000)
FROM "production" p
LEFT JOIN "promoter_contract" c ON c."promoter_id" = p."promoter_id" AND upper_inf(c."valid_during")
WHERE e."production_id" = p."id"
  AND e."promoter_id" = p."promoter_id"
  AND e."commission_rate_bp" IS NULL
  AND p."sale_review" = 'APPROVED'
  AND p."sale_approved_at" IS NOT NULL;
--> statement-breakpoint
-- 파트너사 등록(POST /v1/ops/promoters)·계약 변경 요청(POST /v1/ops/promoters/{promoterId}/contract-term-changes)의 멱등 키 작업을 더한다
ALTER TABLE "idempotency_record" DROP CONSTRAINT IF EXISTS "idempotency_record_operation_check";
--> statement-breakpoint
ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_record_operation_check" CHECK ("operation" in ('CREATE_PRODUCTION', 'CREATE_PRODUCTION_EVENT', 'CREATE_MERCH_ORDER', 'START_MERCH_PAYMENT', 'ACCEPT_MERCH_PAYMENT', 'CREATE_TICKET_ADDON', 'CANCEL_MERCH_ORDER', 'RETURN_MERCH_ORDER', 'CREATE_OPS_PROMOTER', 'CREATE_OPS_PROMOTER_CONTRACT_CHANGE'));
--> statement-breakpoint
-- 관제 경로(core_ops): 파트너사·계약을 읽고 쓰며, 판매 승인 때 event 수수료율을 쓴다
GRANT SELECT, INSERT ON "promoter" TO core_ops;
--> statement-breakpoint
GRANT UPDATE ("commission_rate_bp", "pending_contract_approval_id") ON "promoter" TO core_ops;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "promoter_contract" TO core_ops;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "idempotency_record" TO core_ops;
--> statement-breakpoint
GRANT UPDATE ("commission_rate_bp") ON "event" TO core_ops;
--> statement-breakpoint
-- 파트너 경로(core_partner): 자기 계약만 읽는다(상품 게시 때 수수료율 원천). promoter 표는 파트너에게 열지 않는다
GRANT SELECT ON "promoter_contract" TO core_partner;
--> statement-breakpoint
-- 팬·앱 경로(core_app)는 계약 표를 읽지 않는다(ADR-0320 결정 8). 기본 권한으로 생길 수 있는 SELECT를 회수한다
REVOKE SELECT ON "promoter_contract" FROM core_app;
--> statement-breakpoint
ALTER TABLE "promoter_contract" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "promoter_contract_ops" ON "promoter_contract";
--> statement-breakpoint
CREATE POLICY "promoter_contract_ops" ON "promoter_contract" FOR ALL TO core_ops USING (true) WITH CHECK (true);
--> statement-breakpoint
DROP POLICY IF EXISTS "promoter_contract_partner_read" ON "promoter_contract";
--> statement-breakpoint
CREATE POLICY "promoter_contract_partner_read" ON "promoter_contract" FOR SELECT TO core_partner
  USING ("promoter_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
