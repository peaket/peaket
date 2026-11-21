-- W12-core-idem AZ-T17: 멱등 기록 표(idempotency_record)를 역할·작업마다 행 보안으로 나눈다(ADR-0337 결정 1~5, ADR-0241 결정 1·3·4, docs/security/authz-matrix.md §5.3).
-- 까닭: 0004·0027·0033이 core_partner·core_app·core_ops에 이 표의 표 단위 읽기·넣기·고치기(core_ops는 지우기까지)를 주면서 행 보안을 걸지 않았다.
-- 그래서 어느 경로의 쿼리 하나에서 조건이 빠져도 다른 역할 작업의 기록(팬 결제창 값, 다른 파트너 등록 결과, 관제 계약 변경 응답)을 읽고 바꾸고 지울 수 있었다.
-- 1) 파트너 기록의 테넌트 칸 tenant_id를 더한다. 기본값은 파트너 트랜잭션이 첫 문장에서 거는 app.tenant_id다(앱은 이 칸을 적지 않는다).
--    current_setting은 STABLE이라 표를 다시 쓰지 않고 있던 행은 NULL이다.
-- 2) 이미 있는 파트너 기록을 결과 참조로 채운다(결정 2): 공연 등록은 productionId의 공연 판매자, 회차 더하기는 eventId의 회차 판매자,
--    회차 행이 아직 없는 변경분 회차는 그 eventId를 pending_revision.addedEvents에 가진 공연의 판매자다.
--    SQL의 AND는 계산 차례를 보장하지 않아 JSON 변환은 CASE 안에서만 하고, ID는 글로 견준다(JSON이 아니거나 UUID 꼴이 아닌 참조가 변환 오류로 배포를 멈추지 않게).
--    못 채운 행은 비어 있는 채로 어느 파트너에게도 보이지 않다가 보관 기간이 지나면 정비가 지운다(ADR-0337 '남는 한계').
-- 3) 세 역할의 표 단위 넣기·고치기를 거두고 칸 단위로 다시 준다(결정 4). 차례를 바꾸지 않는다(표 단위 REVOKE는 같은 종류의 칸 권한도 거둔다).
--    넣기는 플랫폼 IdempotencyStore가 적는 여섯 칸, 고치기는 보관 기간이 지난 키를 다시 잡을 때와 결과를 채울 때 고치는 세 칸이다.
--    범위 칸(account_ref·operation·idempotency_key)과 tenant_id는 고치지 못하고 tenant_id는 적어 넣지도 못한다. 읽기와 core_ops 지우기는 그대로다.
-- 4) 행 보안을 켠다. FORCE는 걸지 않는다. 마이그레이션·백필과 정비 연결은 표 소유자로 돌고, 앱 역할은 표 소유자가 아니다(결정 3, ADR-0241 결정 1·6).
-- 5) 정책 열 개(결정 3). 역할·명령마다 나눠 정책이 없는 명령은 거부된다. 작업 목록은 결정 1의 그 역할 줄이고 셋을 합치면 작업 CHECK 목록과 같다.
--    파트너 식은 0004 production_partner_tenant와 같은 테넌트 식이다(promoter_id 자리에 tenant_id). 팬·관제 기록은 계정이 범위라 테넌트를 보지 않는다.
--    새 작업을 더하는 마이그레이션은 CHECK 목록과 함께 그 역할 정책의 작업 목록도 고친다(빠뜨리면 그 작업의 첫 요청이 42501).
--    core_maintenance·core_search는 이 표의 권한이 없어 정책을 두지 않는다.
-- 쿼리와 칸 이름은 바꾸지 않는다. 그래서 배포 창 동안 이전 판 코드도 같은 플랫폼 문장(여섯 칸 넣기, 세 칸 고치기)으로 그대로 돈다(결정 5).
-- 다시 돌려도 같은 결과가 나오게 칸은 IF NOT EXISTS로 더하고 정책은 지우고 만든다.
ALTER TABLE "idempotency_record" ADD COLUMN IF NOT EXISTS "tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid;
--> statement-breakpoint
UPDATE "idempotency_record" r
SET "tenant_id" = p."promoter_id"
FROM "production" p
WHERE r."operation" = 'CREATE_PRODUCTION'
  AND r."tenant_id" IS NULL
  AND p."id"::text = (CASE WHEN pg_input_is_valid(r."result_ref", 'jsonb') THEN r."result_ref"::jsonb END) ->> 'productionId';
--> statement-breakpoint
UPDATE "idempotency_record" r
SET "tenant_id" = e."promoter_id"
FROM "event" e
WHERE r."operation" = 'CREATE_PRODUCTION_EVENT'
  AND r."tenant_id" IS NULL
  AND e."id"::text = (CASE WHEN pg_input_is_valid(r."result_ref", 'jsonb') THEN r."result_ref"::jsonb END) ->> 'eventId';
--> statement-breakpoint
-- 변경분 회차: 담기 비교(@>)는 addedEvents가 배열이 아니거나 비어 있어도 오류 없이 거짓이다
UPDATE "idempotency_record" r
SET "tenant_id" = p."promoter_id"
FROM "production" p
WHERE r."operation" = 'CREATE_PRODUCTION_EVENT'
  AND r."tenant_id" IS NULL
  AND p."pending_revision" -> 'addedEvents' @> jsonb_build_array(jsonb_build_object('eventId', (CASE WHEN pg_input_is_valid(r."result_ref", 'jsonb') THEN r."result_ref"::jsonb END) ->> 'eventId'));
--> statement-breakpoint
REVOKE INSERT, UPDATE ON "idempotency_record" FROM core_partner, core_app, core_ops;
--> statement-breakpoint
GRANT INSERT ("account_ref", "operation", "idempotency_key", "request_hash", "result_ref", "created_at") ON "idempotency_record" TO core_partner, core_app, core_ops;
--> statement-breakpoint
GRANT UPDATE ("request_hash", "result_ref", "created_at") ON "idempotency_record" TO core_partner, core_app, core_ops;
--> statement-breakpoint
ALTER TABLE "idempotency_record" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- 파트너(core_partner): 공연 등록·회차 더하기. 값을 걸지 않으면 NULL, 앞 트랜잭션이 걸었던 연결이면 빈 문자열이라 nullif로 NULL로 바꾼다(둘 다 0건)
DROP POLICY IF EXISTS "idempotency_record_partner_read" ON "idempotency_record";
--> statement-breakpoint
CREATE POLICY "idempotency_record_partner_read" ON "idempotency_record" FOR SELECT TO core_partner
  USING ("operation" IN ('CREATE_PRODUCTION', 'CREATE_PRODUCTION_EVENT') AND "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
DROP POLICY IF EXISTS "idempotency_record_partner_insert" ON "idempotency_record";
--> statement-breakpoint
CREATE POLICY "idempotency_record_partner_insert" ON "idempotency_record" FOR INSERT TO core_partner
  WITH CHECK ("operation" IN ('CREATE_PRODUCTION', 'CREATE_PRODUCTION_EVENT') AND "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
DROP POLICY IF EXISTS "idempotency_record_partner_update" ON "idempotency_record";
--> statement-breakpoint
CREATE POLICY "idempotency_record_partner_update" ON "idempotency_record" FOR UPDATE TO core_partner
  USING ("operation" IN ('CREATE_PRODUCTION', 'CREATE_PRODUCTION_EVENT') AND "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("operation" IN ('CREATE_PRODUCTION', 'CREATE_PRODUCTION_EVENT') AND "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- 팬 경로(core_app): 굿즈 주문·결제 시도·결제 접수·부가 상품 주문·취소·반품·환급 계좌 다시 받기. 같은 역할 안의 계정은 앱의 재생 대조가 본다(결정 6)
DROP POLICY IF EXISTS "idempotency_record_app_read" ON "idempotency_record";
--> statement-breakpoint
CREATE POLICY "idempotency_record_app_read" ON "idempotency_record" FOR SELECT TO core_app
  USING ("operation" IN ('CREATE_MERCH_ORDER', 'START_MERCH_PAYMENT', 'ACCEPT_MERCH_PAYMENT', 'CREATE_TICKET_ADDON', 'CANCEL_MERCH_ORDER', 'RETURN_MERCH_ORDER', 'SHOP_CANCEL_REFUND_ACCOUNT'));
--> statement-breakpoint
DROP POLICY IF EXISTS "idempotency_record_app_insert" ON "idempotency_record";
--> statement-breakpoint
CREATE POLICY "idempotency_record_app_insert" ON "idempotency_record" FOR INSERT TO core_app
  WITH CHECK ("operation" IN ('CREATE_MERCH_ORDER', 'START_MERCH_PAYMENT', 'ACCEPT_MERCH_PAYMENT', 'CREATE_TICKET_ADDON', 'CANCEL_MERCH_ORDER', 'RETURN_MERCH_ORDER', 'SHOP_CANCEL_REFUND_ACCOUNT'));
--> statement-breakpoint
DROP POLICY IF EXISTS "idempotency_record_app_update" ON "idempotency_record";
--> statement-breakpoint
CREATE POLICY "idempotency_record_app_update" ON "idempotency_record" FOR UPDATE TO core_app
  USING ("operation" IN ('CREATE_MERCH_ORDER', 'START_MERCH_PAYMENT', 'ACCEPT_MERCH_PAYMENT', 'CREATE_TICKET_ADDON', 'CANCEL_MERCH_ORDER', 'RETURN_MERCH_ORDER', 'SHOP_CANCEL_REFUND_ACCOUNT'))
  WITH CHECK ("operation" IN ('CREATE_MERCH_ORDER', 'START_MERCH_PAYMENT', 'ACCEPT_MERCH_PAYMENT', 'CREATE_TICKET_ADDON', 'CANCEL_MERCH_ORDER', 'RETURN_MERCH_ORDER', 'SHOP_CANCEL_REFUND_ACCOUNT'));
--> statement-breakpoint
-- 관제 경로(core_ops): 파트너사 등록·계약 조건 변경 요청. 지우기는 계약 변경 요청을 풀 때 그 기록을 지우는 데 쓴다
DROP POLICY IF EXISTS "idempotency_record_ops_read" ON "idempotency_record";
--> statement-breakpoint
CREATE POLICY "idempotency_record_ops_read" ON "idempotency_record" FOR SELECT TO core_ops
  USING ("operation" IN ('CREATE_OPS_PROMOTER', 'CREATE_OPS_PROMOTER_CONTRACT_CHANGE'));
--> statement-breakpoint
DROP POLICY IF EXISTS "idempotency_record_ops_insert" ON "idempotency_record";
--> statement-breakpoint
CREATE POLICY "idempotency_record_ops_insert" ON "idempotency_record" FOR INSERT TO core_ops
  WITH CHECK ("operation" IN ('CREATE_OPS_PROMOTER', 'CREATE_OPS_PROMOTER_CONTRACT_CHANGE'));
--> statement-breakpoint
DROP POLICY IF EXISTS "idempotency_record_ops_update" ON "idempotency_record";
--> statement-breakpoint
CREATE POLICY "idempotency_record_ops_update" ON "idempotency_record" FOR UPDATE TO core_ops
  USING ("operation" IN ('CREATE_OPS_PROMOTER', 'CREATE_OPS_PROMOTER_CONTRACT_CHANGE'))
  WITH CHECK ("operation" IN ('CREATE_OPS_PROMOTER', 'CREATE_OPS_PROMOTER_CONTRACT_CHANGE'));
--> statement-breakpoint
DROP POLICY IF EXISTS "idempotency_record_ops_delete" ON "idempotency_record";
--> statement-breakpoint
CREATE POLICY "idempotency_record_ops_delete" ON "idempotency_record" FOR DELETE TO core_ops
  USING ("operation" IN ('CREATE_OPS_PROMOTER', 'CREATE_OPS_PROMOTER_CONTRACT_CHANGE'));
