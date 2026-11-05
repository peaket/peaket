-- 팬의 로그인한 기기: 세션의 화면용 기기 이름과 마지막 활동, 기기 이름 지우기 정비의 부분 인덱스(docs/data.md session.device_label·last_active_at, docs/features/identity.md §8 '로그인한 기기와 다른 세션 끝내기의 첫 구현', BUILD_ORDER BOT-044, ADR-0209).
-- 기본값 없는 null 허용 칸 둘이라 표를 다시 쓰지 않는다. 이 칸 전의 세션은 마지막 활동이 비어 있어 읽는 쪽이 rotated_at·login_verdict_at으로 대신한다.
-- 부분 인덱스는 기기 이름이 있는 세션만 담는다(새 칸이라 지금은 비어 있다). CHECK도 새 칸이 모두 null이라 바로 검사한다.
-- 운영에 나가기 전이라 트랜잭션 안에서 만든다. 운영 뒤 session처럼 큰 표의 인덱스는 CONCURRENTLY 파일(-- peaket:no-transaction)로 따로 만든다(docs/devops.md §7.2, 실행기 BUILD_ORDER BAS-060).
ALTER TABLE "session" ADD COLUMN "device_label" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "last_active_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "session_device_label_expiry_idx" ON "session" USING btree ("absolute_expires_at") WHERE "session"."device_label" is not null;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_device_label_length_check" CHECK ("session"."device_label" is null or char_length("session"."device_label") between 1 and 40);