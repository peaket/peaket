-- F-07-11(LCH-160): ?�고 기록 보�? ?�리?� 법정 ?�보 조회 ?�인.
-- content_report??처리(RESOLVED) ??1?�이 지???�을 ?�비 ?�업 review-report-retention??지?�다.
-- PostgreSQL DELETE??WHERE?�서 ?�는 칸의 SELECT�??�구?��?�?core_maintenance??purge_at·status�?준?????�체 SELECT·UPDATE·INSERT ?�음).
CREATE INDEX IF NOT EXISTS "content_report_purge_idx" ON "content_report" USING btree ("purge_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "takedown_action_notice_fingerprint_idx" ON "takedown_action" USING btree ("notice_id","content_fingerprint");
--> statement-breakpoint
GRANT SELECT ("purge_at", "status"), DELETE ON "content_report" TO core_maintenance;
