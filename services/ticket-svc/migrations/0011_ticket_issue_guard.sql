-- 주문 단위 발권 막기(BAT-011, HOT-161·PRF-173, ADR-0354 결정 2, docs/data.md §2 ticket_issue_guard).
-- migrations/0011: develop의 0010_transfer_lock(BAT-410) 뒤에 온다. migrateTicket이 파일 이름 순으로 적용한다(RV-06).
-- IssueTickets와 BlockTicketIssuance가 같은 주문에서 겹칠 때 한 줄 잠금으로 차례를 정한다.
-- 행은 두 갈래의 잠금 자리다. blocked_at이 비어 있으면 아직 막지 않은 잠금 자리이고(발권이 먼저 만든다),
-- 값이 있으면 막힌 주문이라 뒤에 오는 IssueTickets가 FAILED_PRECONDITION이다.
-- reason은 막은 사유(감사·로그용)라 비어 있을 수 있다. 행은 주문 기록과 함께 보존한다(정리 작업 없음).
CREATE TABLE IF NOT EXISTS "ticket_issue_guard" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"blocked_at" timestamp with time zone,
	"reason" text
);
