-- 회차 취소 요청 중 보류 취소의 환급 미룸(BUILD_ORDER GAT-090·GAT-110, BAT-420 몫 D, OPEN[45] 소유자 결정, docs/data.md event_refund_hold,
-- docs/features/transfer-refund.md §5 '회차 취소 요청 중 보류 취소의 환급 미룸', refund.proto SetEventRefundHold). 회차 하나에 한 줄이다.
-- 풀리지 않았고(released_at 빔) 기한 안(expires_at > 지금)이면 그 회차의 마감 뒤 환급(REQUESTED)을 집지 않는다. 기한은 건 시각보다 늦어야 한다.
CREATE TABLE "event_refund_hold" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"cancellation_request_id" uuid NOT NULL,
	"held_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "event_refund_hold_expires_check" CHECK ("event_refund_hold"."expires_at" > "event_refund_hold"."held_at")
);
