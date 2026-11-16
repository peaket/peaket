-- BAT-420 GAT-110: 회차 취소 요청의 두 길(파트너·commander), 판정 미리보기, 판정 전 반려 사유(docs/data.md ops ERD event_cancellation_request,
-- docs/features/transfer-refund.md §5 '요청 두 길'·'판정·미리보기·확정의 차례'). 기존 행은 commander가 낸 요청이므로 requested_via가 COMMANDER로 채워진다.
ALTER TABLE event_cancellation_request ADD COLUMN IF NOT EXISTS requested_via text NOT NULL DEFAULT 'COMMANDER';
ALTER TABLE event_cancellation_request ADD COLUMN IF NOT EXISTS promoter_id uuid;
ALTER TABLE event_cancellation_request ADD COLUMN IF NOT EXISTS fault_opinion text;
ALTER TABLE event_cancellation_request ADD COLUMN IF NOT EXISTS evidence_ref text;
ALTER TABLE event_cancellation_request ADD COLUMN IF NOT EXISTS new_starts_at timestamptz;
ALTER TABLE event_cancellation_request ADD COLUMN IF NOT EXISTS dry_run jsonb;
ALTER TABLE event_cancellation_request ADD COLUMN IF NOT EXISTS rejection_reason text;

ALTER TABLE event_cancellation_request DROP CONSTRAINT IF EXISTS event_cancellation_request_requested_via_check;
ALTER TABLE event_cancellation_request ADD CONSTRAINT event_cancellation_request_requested_via_check CHECK (requested_via IN ('PARTNER', 'COMMANDER'));
ALTER TABLE event_cancellation_request DROP CONSTRAINT IF EXISTS event_cancellation_request_fault_opinion_check;
ALTER TABLE event_cancellation_request ADD CONSTRAINT event_cancellation_request_fault_opinion_check CHECK (fault_opinion IS NULL OR fault_opinion IN ('ORGANIZER', 'FORCE_MAJEURE', 'CONTENT_CHANGE'));
-- 증빙은 참조 글 1~200자 [가정]이고 파일은 받지 않는다
ALTER TABLE event_cancellation_request DROP CONSTRAINT IF EXISTS event_cancellation_request_evidence_ref_check;
ALTER TABLE event_cancellation_request ADD CONSTRAINT event_cancellation_request_evidence_ref_check CHECK (evidence_ref IS NULL OR char_length(evidence_ref) BETWEEN 1 AND 200);
-- 연기(POSTPONE)만 바뀐 공연 시작을 갖는다
ALTER TABLE event_cancellation_request DROP CONSTRAINT IF EXISTS event_cancellation_request_postpone_check;
ALTER TABLE event_cancellation_request ADD CONSTRAINT event_cancellation_request_postpone_check CHECK ((kind = 'POSTPONE') = (new_starts_at IS NOT NULL));
-- 파트너가 낸 요청만 그 파트너 테넌트를 갖는다
ALTER TABLE event_cancellation_request DROP CONSTRAINT IF EXISTS event_cancellation_request_promoter_check;
ALTER TABLE event_cancellation_request ADD CONSTRAINT event_cancellation_request_promoter_check CHECK ((requested_via = 'PARTNER') = (promoter_id IS NOT NULL));
