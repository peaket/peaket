-- 팬 취소·일괄 환불의 티켓 단계 기록에 취소 사유를 남긴다(BUILD_ORDER GAT-080 다시 보기 R1, docs/data.md ticket_cancellation.reason,
-- docs/features/payment.md §4.1 '이어 갈 수 있는 앞 기록은 팬 취소뿐이다', ticket.proto CancelTicketsRequest.reason).
-- 다른 취소 ID의 ALREADY_CANCELLED에 첫 팬 취소로 싣는 것은 사유가 USER인 기록뿐이다. 널 허용(사유를 싣지 않은 호출·옛 기록은 잇지 않는다).

ALTER TABLE ticket_cancellation ADD COLUMN IF NOT EXISTS reason text;
ALTER TABLE ticket_cancellation DROP CONSTRAINT IF EXISTS ticket_cancellation_reason_check;
ALTER TABLE ticket_cancellation ADD CONSTRAINT ticket_cancellation_reason_check CHECK (reason IS NULL OR reason IN ('USER', 'EVENT_CANCELLED', 'EVENT_POSTPONED', 'ACCOUNT_WITHDRAWAL', 'EXCEPTION', 'MINOR_CONTRACT_CANCEL', 'FRAUD'));
