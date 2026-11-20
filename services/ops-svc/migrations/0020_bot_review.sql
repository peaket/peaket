-- BAT-197 BOT-080: 봇 판정 표본 검토(FR-049, SCR-067, ADR-0174).
-- 표 셋은 회차·종류의 배치 하나, 그 배치의 세션 카드, 카드마다 한 번의 판정이다.
-- 카드 표에는 pid·IP·기기 가명·계정 ID·점수 원값·가중치를 두지 않는다(POL-006).
-- review_batch·applied_verdict는 ApplyLabel에 실을 값이라 표본에 보관하되 API 응답에는 싣지 않는다(HUMAN_BASELINE 가림, d5 §7.15).
CREATE TABLE IF NOT EXISTS bot_review_batch (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL,
  review_kind text NOT NULL,
  seed text NOT NULL,
  target_count integer NOT NULL,
  population_count integer NOT NULL,
  retention_until timestamp with time zone NOT NULL,
  r2_due_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL,
  CONSTRAINT bot_review_batch_review_kind_check CHECK (review_kind IN ('PASSED_SAMPLE', 'HUMAN_BASELINE')),
  CONSTRAINT bot_review_batch_target_check CHECK (target_count >= 0 AND population_count >= 0)
);
--> statement-breakpoint
-- 한 회차·종류에 배치 하나. 같은 회차에 두 번 배정해도 카드가 겹치지 않는다
CREATE UNIQUE INDEX IF NOT EXISTS bot_review_batch_event_kind_uq ON bot_review_batch (event_id, review_kind);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS bot_review_batch_event_idx ON bot_review_batch (event_id, created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS bot_review_sample (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES bot_review_batch (id) ON DELETE CASCADE,
  sample_ref text NOT NULL,
  verdict_event_key uuid NOT NULL,
  status text NOT NULL,
  risk_band text,
  behavior_summary_band text,
  timeline jsonb NOT NULL,
  evidence_available text[] NOT NULL,
  ordinal integer NOT NULL,
  review_batch text NOT NULL,
  applied_verdict text NOT NULL,
  created_at timestamp with time zone NOT NULL,
  CONSTRAINT bot_review_sample_status_check CHECK (status IN ('PENDING', 'RECORDED')),
  CONSTRAINT bot_review_sample_review_batch_check CHECK (review_batch IN ('PASSED', 'SHADOW_CHALLENGED')),
  CONSTRAINT bot_review_sample_applied_verdict_check CHECK (applied_verdict IN ('ALLOW', 'CHALLENGE')),
  CONSTRAINT bot_review_sample_ordinal_check CHECK (ordinal >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS bot_review_sample_batch_ref_uq ON bot_review_sample (batch_id, sample_ref);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS bot_review_sample_batch_event_key_uq ON bot_review_sample (batch_id, verdict_event_key);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS bot_review_sample_batch_ordinal_uq ON bot_review_sample (batch_id, ordinal);
--> statement-breakpoint
-- 목록 기본 질의(아직 기록하지 않은 카드만, 서버가 섞은 순서)가 이 색인을 탄다
CREATE INDEX IF NOT EXISTS bot_review_sample_batch_status_ordinal_idx ON bot_review_sample (batch_id, status, ordinal);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS bot_review_judgement (
  sample_id uuid PRIMARY KEY REFERENCES bot_review_sample (id) ON DELETE CASCADE,
  verdict text NOT NULL,
  evidence_kinds text[] NOT NULL,
  label_result text NOT NULL,
  recorded_at timestamp with time zone NOT NULL,
  CONSTRAINT bot_review_judgement_verdict_check CHECK (verdict IN ('HUMAN', 'BOT', 'UNDECIDED')),
  CONSTRAINT bot_review_judgement_label_result_check CHECK (label_result IN ('APPLIED', 'UNCHANGED', 'DEVICE_NOT_FOUND', 'SKIPPED'))
);
--> statement-breakpoint
-- 판정 멱등 기록은 공용 idempotency_record를 쓴다(0014). 작업 이름을 목록에 더한다
ALTER TABLE idempotency_record DROP CONSTRAINT IF EXISTS idempotency_record_operation_check;
--> statement-breakpoint
ALTER TABLE idempotency_record ADD CONSTRAINT idempotency_record_operation_check CHECK (operation IN ('CREATE_EVENT_CANCELLATION', 'CREATE_PARTNER_EVENT_CANCELLATION', 'CREATE_BOT_REVIEW_JUDGEMENT'));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON bot_review_batch, bot_review_sample, bot_review_judgement TO ops_app;
