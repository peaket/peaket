-- W12-core-rls2 AZ-T18: 웹훅 끝점·굿즈 주문·상품 수수료율의 앱 역할 쓰기 권한을 칸과 상태로 좁힌다(ADR-0338, ADR-0241 결정 1·3·4·5, docs/security/authz-matrix.md §5.3).
-- 까닭: 0016이 팬 경로 역할 core_app에 webhook_endpoint 표 단위 고치기와 조건 없는 정책을 줘, 팬 경로 쿼리 하나로 모든 파트너 끝점의 주소·비밀·판매자를 바꿀 수 있었다.
-- 0016이 core_partner에 굿즈 주문 두 표의 표 단위 넣기·고치기를, 0014가 상품 표 단위 고치기를 줘, 파트너 경로 쿼리 하나로 자기 테넌트의 정산 값(단가·수수료율·상태)과 상품 수수료율을 바꿀 수 있었다.
-- 1) 웹훅 끝점, core_app(발송기 몫, 결정 1): 고치기는 status·disabled_reason·version 세 칸, 켜진 끝점을 사유 FAILING으로 끄는 것만. 읽기 몫(0004 기본 권한·webhook_endpoint_app_read)은 그대로다.
--    읽기 정책을 켜진 끝점으로 좁히면 WHERE가 칸을 읽는 끄기 문장의 고친 행이 읽기 정책에 걸려 오류가 난다(PostgreSQL 18 CREATE POLICY '명령별 적용 정책').
-- 2) 웹훅 끝점, core_partner(결정 2): 고치기는 코드가 SET하는 아홉 칸만. 끝점 ID·판매자 칸은 고치지 못한다. 테넌트 정책·읽기·넣기는 그대로다.
-- 3) 굿즈 주문·주문 항목, core_partner(결정 3): 넣기·고치기를 거두고 칸 권한도 주지 않는다(파트너 코드가 두 표를 쓰지 않는다). FOR ALL 정책을 읽기 정책으로 바꾼다.
-- 4) 상품, core_partner(결정 4): 고치기는 상품 ID·판매자를 뺀 스무 칸. 수수료율 칸 권한은 이전 판 코드가 SET하므로 이번에는 남기고(두 번에 나눔, devops.md §7.1),
--    트리거 product_commission_from_contract가 파트너 역할이 넣거나 고친 행의 수수료율을 게시 때의 계약 값으로 정하고 그 뒤 바꾸지 않는다.
-- 표 단위 REVOKE는 같은 종류의 칸 권한도 거두므로 거두기를 먼저 하고 칸 권한을 준다. 차례를 바꾸지 않는다.
-- FORCE는 걸지 않는다(결정 6). 쿼리는 바꾸지 않아 배포 창 동안 이전 판 코드도 그대로 돈다(결정 7). 다시 돌려도 같게 정책·트리거는 지우고 만든다(결정 8).
REVOKE UPDATE ON "webhook_endpoint" FROM core_app;
--> statement-breakpoint
GRANT UPDATE ("status", "disabled_reason", "version") ON "webhook_endpoint" TO core_app;
--> statement-breakpoint
DROP POLICY IF EXISTS "webhook_endpoint_app_write" ON "webhook_endpoint";
--> statement-breakpoint
-- USING은 고칠 행을 거르기만 한다(꺼진 끝점은 0행, 오류 없음). WITH CHECK에 어긋나는 새 행은 거절(42501)이다
DROP POLICY IF EXISTS "webhook_endpoint_app_disable" ON "webhook_endpoint";
--> statement-breakpoint
CREATE POLICY "webhook_endpoint_app_disable" ON "webhook_endpoint" FOR UPDATE TO core_app
  USING ("status" = 'ACTIVE')
  WITH CHECK ("status" = 'DISABLED' AND "disabled_reason" = 'FAILING');
--> statement-breakpoint
REVOKE UPDATE ON "webhook_endpoint" FROM core_partner;
--> statement-breakpoint
GRANT UPDATE ("url", "event_types", "status", "disabled_reason", "secret", "previous_secret", "secret_issued_at", "previous_secret_valid_until", "version") ON "webhook_endpoint" TO core_partner;
--> statement-breakpoint
REVOKE INSERT, UPDATE ON "merch_order", "merch_order_item" FROM core_partner;
--> statement-breakpoint
-- 식은 0004 production_partner_tenant와 같다. 값을 걸지 않으면 NULL, 앞 트랜잭션이 걸었던 연결이면 빈 문자열이라 nullif로 NULL로 바꾼다(둘 다 0건)
DROP POLICY IF EXISTS "merch_order_partner_tenant" ON "merch_order";
--> statement-breakpoint
DROP POLICY IF EXISTS "merch_order_partner_read" ON "merch_order";
--> statement-breakpoint
CREATE POLICY "merch_order_partner_read" ON "merch_order" FOR SELECT TO core_partner
  USING ("promoter_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
DROP POLICY IF EXISTS "merch_order_item_partner_tenant" ON "merch_order_item";
--> statement-breakpoint
DROP POLICY IF EXISTS "merch_order_item_partner_read" ON "merch_order_item";
--> statement-breakpoint
CREATE POLICY "merch_order_item_partner_read" ON "merch_order_item" FOR SELECT TO core_partner
  USING ("promoter_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
REVOKE UPDATE ON "product" FROM core_partner;
--> statement-breakpoint
-- commission_rate_bp 칸 고치기는 이 묶음 코드가 배포된 뒤 첫 core-svc 마이그레이션이 거둔다(ADR-0338 결정 4 '두 번에 나눔')
GRANT UPDATE ("type", "schema_version", "name", "status", "price", "shipping_fee", "return_shipping_fee", "return_address", "limited_qty", "transferable", "ticket_linked", "linked_event_id", "fulfillments", "sale_starts_at", "sale_ends_at", "commission_rate_bp", "attributes", "version", "published_at", "updated_at") ON "product" TO core_partner;
--> statement-breakpoint
-- 호출자 권한 함수라 파트너 트랜잭션에서는 자기 테넌트 계약만 읽는다(0033 promoter_contract_partner_read). search_path를 고정하고 표 이름에 스키마를 붙인다(ADR-0241 결정 5).
-- 파트너 역할의 권한을 물려받는 호출자에게만 돈다(USAGE). MEMBER는 PostgreSQL 16부터 CREATEROLE 비슈퍼유저가 역할을 만들 때 저절로 받는
-- ADMIN 자격(INHERIT·SET 없음)도 세어 그런 관리 계정의 상품 쓰기에도 돌기 때문이다. SET ROLE core_partner는 current_user가 core_partner라 USAGE 참이다.
-- 슈퍼유저는 빼고 그대로 둔다: pg_has_role(…, 'USAGE')도 슈퍼유저를 모든 역할의 권한을 가진 것으로 보고(PostgreSQL 18 has_privs_of_role),
-- 슈퍼유저는 앱 경로가 아니며 원래 행 보안·권한을 넘는다(앱 연결은 assertDatabaseRole이 슈퍼유저를 막는다). 조건 꼴은 0008 partner_approved_sale_guard와 같고 판정만 USAGE다
CREATE OR REPLACE FUNCTION product_commission_from_contract() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) OR NOT pg_catalog.pg_has_role(current_user, 'core_partner', 'USAGE') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.commission_rate_bp IS NOT NULL THEN
    -- 처음 게시 때 정한 값은 바꾸지 않는다(ADR-0320 결정 6)
    NEW.commission_rate_bp := OLD.commission_rate_bp;
  ELSIF NEW.status = 'PUBLISHED' THEN
    NEW.commission_rate_bp := (SELECT c.commission_rate_bp FROM public.promoter_contract c
                               WHERE c.promoter_id = NEW.promoter_id AND upper_inf(c.valid_during));
    IF NEW.commission_rate_bp IS NULL THEN
      RAISE EXCEPTION '계약 조건이 없어 상품 수수료율을 정할 수 없다' USING ERRCODE = '23514';
    END IF;
  ELSE
    NEW.commission_rate_bp := NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "product_commission_from_contract" ON "product";
--> statement-breakpoint
CREATE TRIGGER "product_commission_from_contract" BEFORE INSERT OR UPDATE ON "product"
  FOR EACH ROW EXECUTE FUNCTION product_commission_from_contract();
