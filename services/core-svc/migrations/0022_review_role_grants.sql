-- W7-audit COV2-06 보충: 운영 역할의 후기 표·보류 표 권한(docs/data.md §2 '후기 표의 DB 권한'·§4의 15 'DB 권한', ADR-0241 결정 4 '권한은 코드가 쓰는 만큼만').
-- 0013(review·content_report·takedown_action·review_hidden_fingerprint)이 표만 만들고 쓰기 권한을 주지 않아, 운영 역할로는 후기를 쓰지도 고치지도 못했고
-- 탈퇴 익명화·Kafka 보류 넣기·정비 일(임시조치 끝내기, 보류 표 정리)이 모두 권한 오류(42501)였다. 권한만 바꾸므로 표 정의·스냅숏은 그대로다(0012·0013처럼).
-- 여기 없는 권한(표 전체 UPDATE, review·content_report·takedown_action의 DELETE, TRUNCATE, held_event의 reprocessed_at 고치기)은 주지 않는다.
-- 팬·관제 경로(core_app): 읽기는 0004의 기본 권한과 같은 것을 다시 적는다(이미 있는 권한이 사라지지 않게, 0006 production_image와 같은 방식).
-- review의 id·event_id·created_at은 고치지 못한다. account_id·basis_order_id 고치기는 탈퇴 익명화다. 통보 가림의 SELECT … FOR UPDATE는 아래 칸 UPDATE 권한으로 된다
GRANT SELECT, INSERT, UPDATE (rating, body, status, notice, notice_until, content_fingerprint, author_display, edited, updated_at, deleted_at, account_id, basis_order_id) ON review TO core_app;
--> statement-breakpoint
-- 신고 넣기와 처리 완료
GRANT SELECT, INSERT, UPDATE (status, outcome, resolved_at) ON content_report TO core_app;
--> statement-breakpoint
-- 가림 조치 기록과 해제
GRANT SELECT, INSERT, UPDATE (restored_at) ON takedown_action TO core_app;
--> statement-breakpoint
-- 같은 내용 지문 등록(ON CONFLICT DO NOTHING)과 해제
GRANT SELECT, INSERT, DELETE ON review_hidden_fingerprint TO core_app;
--> statement-breakpoint
-- Kafka 소비자의 보류(확인과 넣기). 다시 처리(RB-11)의 reprocessed_at 고치기는 주지 않는다
GRANT SELECT, INSERT ON held_event TO core_app;
--> statement-breakpoint
-- 정비 경로(core_maintenance): 임시조치 끝내기(review-temp-block-expire)가 읽고 고치는 칸만이다
GRANT SELECT (id, status, notice, notice_until), UPDATE (status, notice, notice_until, updated_at) ON review TO core_maintenance;
--> statement-breakpoint
GRANT SELECT (reason, restored_at, ends_at), UPDATE (restored_at) ON takedown_action TO core_maintenance;
--> statement-breakpoint
-- 보류 표 정리(held-events-delete): 다시 처리한 지 오래된 행 지우기
GRANT SELECT (reprocessed_at), DELETE ON held_event TO core_maintenance;
