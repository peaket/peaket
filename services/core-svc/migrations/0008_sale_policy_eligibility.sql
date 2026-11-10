-- 판매 정책 규칙(공연 단위)·회차 고치기 판·판매 자격 명단과 사본 판·지운 기록·올리기 기록(docs/data.md production·event·sale_eligibility_*, ADR-0261 결정 1·4·6~9·13, BUILD_ORDER HOT-250).
-- 표·칸·제약·순번은 drizzle-kit generate가 만들었고(칸 이름 바꾸기 묻기를 피하려 두 번에 나눠 만든 뒤 하나로 합쳤다), 역할·권한·행 보안·트리거(ADR-0241과 같은 방식)는 손으로 더했다.
-- event.sale_policy는 값을 쓴 코드가 없어 지운다(규칙은 공연의 sale_policy, ADR-0261 결정 1).
CREATE SEQUENCE "public"."sale_eligibility_copy_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "sale_eligibility_drop" (
	"production_id" uuid NOT NULL,
	"promoter_id" uuid NOT NULL,
	"list_key" text NOT NULL,
	"copy_seq" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sale_eligibility_drop_production_id_list_key_copy_seq_pk" PRIMARY KEY("production_id","list_key","copy_seq")
);
--> statement-breakpoint
CREATE TABLE "sale_eligibility_list" (
	"id" uuid PRIMARY KEY NOT NULL,
	"production_id" uuid NOT NULL,
	"promoter_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"member_count" integer NOT NULL,
	"file_sha256" "bytea" NOT NULL,
	"version" integer NOT NULL,
	"copy_seq" bigint DEFAULT nextval('sale_eligibility_copy_seq') NOT NULL,
	"copied_seq" bigint,
	"uploaded_at" timestamp with time zone NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"locked_at" timestamp with time zone,
	"destroy_due_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sale_eligibility_list_key_uq" UNIQUE("production_id","key"),
	CONSTRAINT "sale_eligibility_list_id_promoter_uq" UNIQUE("id","promoter_id"),
	CONSTRAINT "sale_eligibility_list_key_check" CHECK ("sale_eligibility_list"."key" ~ '^[a-z0-9-]{3,32}$'),
	CONSTRAINT "sale_eligibility_list_name_check" CHECK (char_length("sale_eligibility_list"."name") between 1 and 40),
	CONSTRAINT "sale_eligibility_list_count_check" CHECK ("sale_eligibility_list"."member_count" between 0 and 500000),
	CONSTRAINT "sale_eligibility_list_sha_check" CHECK (octet_length("sale_eligibility_list"."file_sha256") = 32),
	CONSTRAINT "sale_eligibility_list_version_check" CHECK ("sale_eligibility_list"."version" >= 1 and ("sale_eligibility_list"."copied_seq" is null or "sale_eligibility_list"."copied_seq" <= "sale_eligibility_list"."copy_seq"))
);
--> statement-breakpoint
CREATE TABLE "sale_eligibility_member" (
	"list_id" uuid NOT NULL,
	"promoter_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	CONSTRAINT "sale_eligibility_member_list_id_account_id_pk" PRIMARY KEY("list_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "sale_eligibility_upload" (
	"id" uuid PRIMARY KEY NOT NULL,
	"production_id" uuid NOT NULL,
	"promoter_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "production" ADD COLUMN "sale_policy" jsonb;--> statement-breakpoint
ALTER TABLE "production" ADD COLUMN "sale_policy_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_eligibility_drop" ADD CONSTRAINT "sale_eligibility_drop_production_promoter_fk" FOREIGN KEY ("production_id","promoter_id") REFERENCES "public"."production"("id","promoter_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_eligibility_list" ADD CONSTRAINT "sale_eligibility_list_production_promoter_fk" FOREIGN KEY ("production_id","promoter_id") REFERENCES "public"."production"("id","promoter_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_eligibility_member" ADD CONSTRAINT "sale_eligibility_member_list_promoter_fk" FOREIGN KEY ("list_id","promoter_id") REFERENCES "public"."sale_eligibility_list"("id","promoter_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_eligibility_upload" ADD CONSTRAINT "sale_eligibility_upload_production_promoter_fk" FOREIGN KEY ("production_id","promoter_id") REFERENCES "public"."production"("id","promoter_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sale_eligibility_drop_created_idx" ON "sale_eligibility_drop" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sale_eligibility_list_destroy_idx" ON "sale_eligibility_list" USING btree ("destroy_due_at");--> statement-breakpoint
CREATE INDEX "sale_eligibility_upload_production_at_idx" ON "sale_eligibility_upload" USING btree ("production_id","at");--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_version_check" CHECK ("event"."version" >= 1);--> statement-breakpoint
ALTER TABLE "production" ADD CONSTRAINT "production_sale_policy_version_check" CHECK ("production"."sale_policy_version" >= 1);--> statement-breakpoint
ALTER TABLE "event" DROP COLUMN "sale_policy";
--> statement-breakpoint
-- 정비 역할(리뷰 S7): relay 정비 리더의 판매 자격 명단 파기·사본 다시 넘기기가 쓰는 묶음 역할이다. 정비 역할 주소(PEAKET_MAINTENANCE_DATABASE_URL)의 로그인 사용자를
-- 이 역할에 넣는다(공용 정비 일의 권한은 BUILD_ORDER BAS-060이 정한다). 모든 테넌트의 명단을 다루므로 아래 정책이 이 역할에만 테넌트 조건 없이 연다
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'core_maintenance') THEN
    CREATE ROLE core_maintenance NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'core_maintenance' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'core_maintenance 역할은 SUPERUSER·BYPASSRLS가 없어야 한다';
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO core_maintenance;
--> statement-breakpoint
-- 팬 경로는 팬별 판매 자격(GET /v1/events/{eventId}/sale-eligibility)에 쓰는 칸만 읽는다. 0004의 기본 권한이 새 표에 준 읽기를 거둔다
REVOKE ALL ON sale_eligibility_list, sale_eligibility_member, sale_eligibility_drop, sale_eligibility_upload FROM core_app;
--> statement-breakpoint
GRANT SELECT (id, production_id, promoter_id, key, name, destroy_due_at) ON sale_eligibility_list TO core_app;
--> statement-breakpoint
GRANT SELECT (list_id, account_id) ON sale_eligibility_member TO core_app;
--> statement-breakpoint
-- 파트너 경로: 규칙 저장(판매 정책 칸·판), 회차 고치기(일정·정렬·배정·1인 한도·판), 명단 올리기·지우기·잠금·파기 시각·사본 판, 지운 기록·올리기 기록이다.
-- 판매자·공연·명단 키는 이 권한으로 바꾸지 못한다(sale_review는 0004가 준 칸이다). 승인 이력이 있는 공연의 공개본 칸은 아래 트리거가 막는다
GRANT UPDATE (sale_policy, sale_policy_version) ON production TO core_partner;
--> statement-breakpoint
GRANT UPDATE (open_at, lobby_minutes, entry_opens_at, starts_at, ends_at, lobby_shuffle, open_batch, seat_assignment, per_person_limit, version) ON event TO core_partner;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON sale_eligibility_list, sale_eligibility_member TO core_partner;
--> statement-breakpoint
GRANT UPDATE (name, member_count, file_sha256, version, copy_seq, copied_seq, uploaded_at, uploaded_by, locked_at, destroy_due_at) ON sale_eligibility_list TO core_partner;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON sale_eligibility_drop TO core_partner;
--> statement-breakpoint
GRANT SELECT, INSERT ON sale_eligibility_upload TO core_partner;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE sale_eligibility_copy_seq TO core_partner, core_maintenance;
--> statement-breakpoint
-- 정비 경로: 파기(구성원·명단 지우기, 지운 기록 넣기), 사본 다시 넘기기(넘긴 판 적기), 지운 기록 지우기, 지난 올리기 기록 지우기에 쓰는 칸만이다.
-- 명단 행의 FOR UPDATE 잠금은 그 표의 UPDATE 권한이 있어야 한다(copied_seq)
GRANT SELECT (id, sale_policy) ON production TO core_maintenance;
--> statement-breakpoint
GRANT SELECT (id, production_id, starts_at, open_at, status) ON event TO core_maintenance;
--> statement-breakpoint
GRANT SELECT, DELETE ON sale_eligibility_list, sale_eligibility_member, sale_eligibility_drop TO core_maintenance;
--> statement-breakpoint
GRANT UPDATE (copied_seq) ON sale_eligibility_list TO core_maintenance;
--> statement-breakpoint
GRANT INSERT ON sale_eligibility_drop TO core_maintenance;
--> statement-breakpoint
GRANT SELECT (id, at), DELETE ON sale_eligibility_upload TO core_maintenance;
--> statement-breakpoint
ALTER TABLE sale_eligibility_list ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sale_eligibility_member ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sale_eligibility_drop ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sale_eligibility_upload ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY sale_eligibility_list_partner_tenant ON sale_eligibility_list FOR ALL TO core_partner
  USING (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY sale_eligibility_member_partner_tenant ON sale_eligibility_member FOR ALL TO core_partner
  USING (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY sale_eligibility_drop_partner_tenant ON sale_eligibility_drop FOR ALL TO core_partner
  USING (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY sale_eligibility_upload_partner_tenant ON sale_eligibility_upload FOR ALL TO core_partner
  USING (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY sale_eligibility_list_app_read ON sale_eligibility_list FOR SELECT TO core_app USING (true);
--> statement-breakpoint
CREATE POLICY sale_eligibility_member_app_read ON sale_eligibility_member FOR SELECT TO core_app USING (true);
--> statement-breakpoint
CREATE POLICY production_maintenance_read ON production FOR SELECT TO core_maintenance USING (true);
--> statement-breakpoint
CREATE POLICY event_maintenance_read ON event FOR SELECT TO core_maintenance USING (true);
--> statement-breakpoint
CREATE POLICY sale_eligibility_list_maintenance ON sale_eligibility_list FOR ALL TO core_maintenance USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY sale_eligibility_member_maintenance ON sale_eligibility_member FOR ALL TO core_maintenance USING (true);
--> statement-breakpoint
CREATE POLICY sale_eligibility_drop_maintenance ON sale_eligibility_drop FOR ALL TO core_maintenance USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY sale_eligibility_upload_maintenance ON sale_eligibility_upload FOR ALL TO core_maintenance USING (true);
--> statement-breakpoint
-- 2차 방어(리뷰 S6): 파트너 경로(core_partner)는 승인 이력이 있는 공연의 공개본 판매 정책과 회차 일정·판매 설정을 바로 고치지 못한다.
-- 승인 뒤 고치기는 변경분(pending_revision)과 판(sale_policy_version·event.version)으로만 하고 공개본은 판매 승인(LCH-080)이 옮긴다(ADR-0198 결정 3, ADR-0261 결정 1·4).
-- 슈퍼유저(시험·운영 관리)와 다른 역할은 막지 않는다. 함수는 부른 사용자 권한으로 돌아 행 보안을 따른다
CREATE FUNCTION partner_approved_sale_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  approved boolean;
BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) OR NOT pg_has_role(current_user, 'core_partner', 'MEMBER') THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'production' THEN
    approved := OLD.sale_approved_at IS NOT NULL;
    IF approved AND NEW.sale_policy IS DISTINCT FROM OLD.sale_policy THEN
      RAISE EXCEPTION '승인 이력이 있는 공연의 판매 정책은 변경분에만 둔다' USING ERRCODE = '42501';
    END IF;
  ELSE
    SELECT p.sale_approved_at IS NOT NULL INTO approved FROM public.production p WHERE p.id = OLD.production_id;
    IF approved AND (NEW.open_at, NEW.lobby_minutes, NEW.entry_opens_at, NEW.starts_at, NEW.ends_at, NEW.lobby_shuffle, NEW.open_batch, NEW.seat_assignment, NEW.per_person_limit)
      IS DISTINCT FROM (OLD.open_at, OLD.lobby_minutes, OLD.entry_opens_at, OLD.starts_at, OLD.ends_at, OLD.lobby_shuffle, OLD.open_batch, OLD.seat_assignment, OLD.per_person_limit) THEN
      RAISE EXCEPTION '승인 이력이 있는 공연의 회차는 변경분에만 고친다' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER production_partner_approved_guard BEFORE UPDATE OF sale_policy ON production FOR EACH ROW EXECUTE FUNCTION partner_approved_sale_guard();
--> statement-breakpoint
CREATE TRIGGER event_partner_approved_guard BEFORE UPDATE OF open_at, lobby_minutes, entry_opens_at, starts_at, ends_at, lobby_shuffle, open_batch, seat_assignment, per_person_limit ON event FOR EACH ROW EXECUTE FUNCTION partner_approved_sale_guard();
