-- W12-core-notify AZ-T19: 웹훅 발송기 전용 DB 역할 core_notify와 발송 원장 권한(ADR-0350 결정 1·3, ADR-0338 '결과', ADR-0241 결정 1·4·7).
-- 까닭: 발송기가 팬 경로 역할 core_app으로 붙어 ① 아무 발송 행을 넣으면 그 파트너 비밀로 서명해 보내고 ② 원장 상태를 고쳐 진짜 사건을 DEAD로 만들거나 되돌리고
-- ③ 모든 끝점의 비밀을 읽고 켜진 끝점을 끌 수 있었다. 발송기가 실제로 쓰는 표·명령·칸만 가진 역할로 옮긴다.
-- 이 마이그레이션은 새 역할·권한만 준다. core_app의 옛 권한·정책은 거두지 않는다(두 번 나눔: N-1 파드의 발송기가 core_app을 쓴다, devops.md §7.1, ADR-0350 결정 5).
-- 다음 배포의 첫 core-svc 마이그레이션이 core_app의 두 표 권한과 정책 넷(webhook_endpoint_app_read·webhook_endpoint_app_disable·webhook_delivery_app_read·webhook_delivery_app_all)을 거둔다.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'core_notify') THEN
    CREATE ROLE core_notify NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  -- 역할이 이미 있어도(다른 환경에서 만든 값) 행 보안을 건너뛰는 속성이면 멈춘다
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'core_notify' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'core_notify 역할은 SUPERUSER·BYPASSRLS가 없어야 한다';
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO core_notify;
--> statement-breakpoint
-- 끝점: 발송기는 모든 칸을 읽고(주소·지금 비밀·옛 비밀로 서명한다), 켜진 끝점을 사유 FAILING으로 끄는 세 칸만 고친다.
-- 넣기·지우기·TRUNCATE는 주지 않는다. 표 단위 고치기를 먼저 거두고 칸을 준다(같은 종류의 칸 권한도 함께 거두기 때문, 0042와 같은 차례).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "webhook_endpoint" FROM core_notify;
--> statement-breakpoint
GRANT SELECT ON "webhook_endpoint" TO core_notify;
--> statement-breakpoint
GRANT UPDATE ("status", "disabled_reason", "version") ON "webhook_endpoint" TO core_notify;
--> statement-breakpoint
DROP POLICY IF EXISTS "webhook_endpoint_notify_read" ON "webhook_endpoint";
--> statement-breakpoint
CREATE POLICY "webhook_endpoint_notify_read" ON "webhook_endpoint" FOR SELECT TO core_notify
  USING (true);
--> statement-breakpoint
DROP POLICY IF EXISTS "webhook_endpoint_notify_disable" ON "webhook_endpoint";
--> statement-breakpoint
-- USING은 고칠 행을 거르기만 한다(꺼진 끝점은 0행). WITH CHECK에 어긋나는 새 행은 거절(42501)이다
CREATE POLICY "webhook_endpoint_notify_disable" ON "webhook_endpoint" FOR UPDATE TO core_notify
  USING ("status" = 'ACTIVE')
  WITH CHECK ("status" = 'DISABLED' AND "disabled_reason" = 'FAILING');
--> statement-breakpoint
-- 발송 원장: 발송기는 행을 만들고(표 객체의 칸), 집은 행의 모든 칸을 돌려받고, 지금 도는 행의 결과 칸만 고친다.
-- 본문·끝점·사건 키·사건 종류·만든 시각은 고치지 못한다(사칭·원장 조작을 막는다). 지우기·TRUNCATE는 주지 않는다.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "webhook_delivery" FROM core_notify;
--> statement-breakpoint
GRANT SELECT, INSERT ON "webhook_delivery" TO core_notify;
--> statement-breakpoint
GRANT UPDATE ("status", "attempt_count", "last_http_status", "last_error", "next_attempt_at", "finished_at", "lease_until") ON "webhook_delivery" TO core_notify;
--> statement-breakpoint
DROP POLICY IF EXISTS "webhook_delivery_notify_read" ON "webhook_delivery";
--> statement-breakpoint
CREATE POLICY "webhook_delivery_notify_read" ON "webhook_delivery" FOR SELECT TO core_notify
  USING (true);
--> statement-breakpoint
DROP POLICY IF EXISTS "webhook_delivery_notify_insert" ON "webhook_delivery";
--> statement-breakpoint
CREATE POLICY "webhook_delivery_notify_insert" ON "webhook_delivery" FOR INSERT TO core_notify
  WITH CHECK (true);
--> statement-breakpoint
DROP POLICY IF EXISTS "webhook_delivery_notify_update" ON "webhook_delivery";
--> statement-breakpoint
-- USING: 지금 도는 행만 고친다. WITH CHECK: 결과는 네 상태 가운데 하나다(끝난 행으로 끝내는 것은 된다).
-- 끝난 행(SUCCEEDED·DEAD)을 PENDING·RETRYING으로 되돌리는 것은 USING 밖이라 0행이다.
CREATE POLICY "webhook_delivery_notify_update" ON "webhook_delivery" FOR UPDATE TO core_notify
  USING ("status" IN ('PENDING', 'RETRYING'))
  WITH CHECK ("status" IN ('PENDING', 'RETRYING', 'SUCCEEDED', 'DEAD'));
