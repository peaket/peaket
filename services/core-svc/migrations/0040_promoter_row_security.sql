-- W12-core-rls AZ-T5: 판매자 표(promoter)에 행 보안을 건다(ADR-0327 결정 13, ADR-0241 결정 1·3, docs/security/authz-matrix.md §3.3·§5.3).
-- 까닭: 0034가 판매 승인 요청(ADR-0327 결정 1·11)을 위해 core_partner에게 promoter 표 전체 읽기를 주면서 행 보안을 걸지 않았다.
-- 그래서 파트너 DB 역할이 다른 파트너의 판매자 행(상호·연락처·사업자등록번호)까지 읽고 고칠 수 있었다(CI 실행 44919441525).
-- 1) core_partner의 표 단위 읽기를 거두고 id와 판매자 정보 8칸만 칸 단위로 다시 준다. 차례를 바꾸지 않는다.
--    표 단위 REVOKE는 같은 종류(SELECT)의 칸 권한까지 거둔다. 0034의 칸 고치기(UPDATE 8칸)는 다른 종류라 그대로 남고 넓히지 않는다.
--    verified_at·commission_rate_bp·pending_contract_approval_id는 자기 행이라도 읽지 않는다(계약 값은 promoter_contract로, ADR-0320 결정 8).
-- 2) 행 보안을 켠다. FORCE는 걸지 않는다. 마이그레이션·부트스트랩 시드는 표 소유자로 돌고, 앱 역할은 표 소유자가 아니다(ADR-0241 결정 1).
-- 3) 정책 넷. 파트너는 자기 행(id = 테넌트)만 읽기·고치기 둘로 나눠 두고 넣기·지우기 정책은 두지 않는다(정책이 없는 명령은 거부된다).
--    관제(core_ops)는 조건 없는 정책, 팬(core_app)은 읽기만 전체다(회차 상세가 판매자 신원정보를 싣는다, ADR-0200).
--    core_maintenance·core_search는 이 표의 권한이 없어 정책을 두지 않는다.
-- 쿼리는 바꾸지 않는다. 그래서 배포 창 동안 0034 코드(N-1)도 이 스키마에서 그대로 돈다. 다시 돌려도 같은 결과가 나오게 정책은 지우고 만든다.
REVOKE SELECT ON "promoter" FROM core_partner;
--> statement-breakpoint
GRANT SELECT ("id", "legal_name", "representative", "address", "phone", "email", "business_reg_no", "mail_order_report_no", "exemption_basis") ON "promoter" TO core_partner;
--> statement-breakpoint
ALTER TABLE "promoter" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- 값을 걸지 않으면 NULL, 앞 트랜잭션이 걸었던 연결이면 빈 문자열이라 nullif로 NULL로 바꾼다(둘 다 0건, authz-matrix §5.3).
-- 식은 0004 production_partner_tenant와 같고 promoter_id 자리에 id가 온다(이 표의 테넌트 값은 행의 id 자체다, authz-matrix §3.3)
DROP POLICY IF EXISTS "promoter_partner_self_read" ON "promoter";
--> statement-breakpoint
CREATE POLICY "promoter_partner_self_read" ON "promoter" FOR SELECT TO core_partner
  USING ("id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- 고친 뒤에도 자기 행이어야 한다. 지금은 id 칸 고치기 권한이 없어 WITH CHECK 없이도 같지만, 권한이 넓어질 때를 막는다(ADR-0327 결정 13)
DROP POLICY IF EXISTS "promoter_partner_self_update" ON "promoter";
--> statement-breakpoint
CREATE POLICY "promoter_partner_self_update" ON "promoter" FOR UPDATE TO core_partner
  USING ("id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- 관제 경로: 파트너사 목록·상세·등록·계약 변경(SELECT … FOR UPDATE 포함)과 판매 승인 목록·상세가 모든 판매자 행을 다룬다(ADR-0320 결정 8)
DROP POLICY IF EXISTS "promoter_ops" ON "promoter";
--> statement-breakpoint
CREATE POLICY "promoter_ops" ON "promoter" FOR ALL TO core_ops USING (true) WITH CHECK (true);
--> statement-breakpoint
-- 팬 경로: 회차 상세가 회차·공연·판매자를 내부 결합한다. 이 정책이 없으면 결합이 0행이라 회차 상세가 404가 된다
DROP POLICY IF EXISTS "promoter_app_read" ON "promoter";
--> statement-breakpoint
CREATE POLICY "promoter_app_read" ON "promoter" FOR SELECT TO core_app USING (true);
