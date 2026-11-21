-- BAT-355 OPS-260: 운영 명령 수명주기(ADR-0340, docs/data.md ops_command·command_event·command_approval·command_actor).
-- ① ops_command: 만료 있는 명령 2·8의 만료 시각(expires_at), 실행 뒤 비교 때(compare_due_at), 되돌리기 회차(round)와 정비 작업이 고르는 부분 색인.
-- ② command_event: 사건마다 다른 값(detail: 연장의 새 만료, 실행 뒤 비교의 예측·실제).
-- ③ command_approval: 요청자 가명 참조(requester_ref)와 회차(round, 0은 명령·되돌리기 요청마다 1씩 오름).
-- ④ command_actor: 사람 칸의 가명 참조를 관리 계정으로 잇는 대응 표(ADR-0149). 같은 사람 두 번·요청자 본인 승인은 회차별 부분 유일 색인이 막는다.
--    옛 행(0021 이전)은 같은 값 대응(actor_ref = 옛 계정 ID)을 넣는다. local·ci 자료뿐이라 그 행은 가명이 아니다(BAT-355 계획 '정할 것' 4).
--    같은 계정이 여러 명령을 냈으면 처음 행만 남는다(기본 키가 actor_ref라). 가명 참조로 찾으므로 풀이는 같다.
-- ⑤ idempotency_record: 접수 작업 CREATE_OPS_COMMAND(범위는 부른 계정 × 작업 × 키, ADR-0340 결정 7). 0020까지의 작업 이름은 그대로 둔다.
-- 상태 제약은 0002에 SUCCEEDED까지 있다.
ALTER TABLE ops_command ADD COLUMN IF NOT EXISTS expires_at timestamptz;
--> statement-breakpoint
ALTER TABLE ops_command ADD COLUMN IF NOT EXISTS compare_due_at timestamptz;
--> statement-breakpoint
ALTER TABLE ops_command ADD COLUMN IF NOT EXISTS round smallint NOT NULL DEFAULT 0;
--> statement-breakpoint
-- 자동 만료(명령 2·8, ACKED)와 실행 뒤 비교를 고르는 정비 작업의 부분 색인
CREATE INDEX IF NOT EXISTS ops_command_expires_due_idx ON ops_command (expires_at) WHERE state = 'ACKED' AND expires_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ops_command_compare_due_idx ON ops_command (compare_due_at) WHERE compare_due_at IS NOT NULL;
--> statement-breakpoint
ALTER TABLE command_event ADD COLUMN IF NOT EXISTS detail jsonb;
--> statement-breakpoint
ALTER TABLE command_approval ADD COLUMN IF NOT EXISTS requester_ref text;
--> statement-breakpoint
ALTER TABLE command_approval ADD COLUMN IF NOT EXISTS round smallint NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS command_actor (
  actor_ref uuid PRIMARY KEY,
  command_id uuid NOT NULL REFERENCES ops_command (id),
  round smallint NOT NULL DEFAULT 0,
  side text NOT NULL,
  admin_account_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL,
  delete_hold_ref uuid,
  CONSTRAINT command_actor_side_check CHECK (side IN ('REQUESTER', 'APPROVER', 'ACTOR')),
  CONSTRAINT command_actor_round_check CHECK (round >= 0)
);
--> statement-breakpoint
-- 2인 분리의 마지막 안전망: 같은 회차의 요청·승인에 같은 관리 계정은 한 번만(ADR-0340 결정 8)
CREATE UNIQUE INDEX IF NOT EXISTS command_actor_person_key ON command_actor (command_id, round, admin_account_id) WHERE side IN ('REQUESTER', 'APPROVER');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS command_actor_command_idx ON command_actor (command_id, round, side);
--> statement-breakpoint
-- 3년 [가정] 지난 대응 행을 하루 한 번 지운다(삭제 보류 행은 남긴다)
CREATE INDEX IF NOT EXISTS command_actor_recorded_idx ON command_actor (recorded_at) WHERE delete_hold_ref IS NULL;
--> statement-breakpoint
INSERT INTO command_actor (actor_ref, command_id, round, side, admin_account_id, recorded_at)
SELECT c.requested_by::uuid, c.id, 0, 'REQUESTER', c.requested_by::uuid, c.created_at
FROM ops_command c
WHERE c.requested_by ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO command_actor (actor_ref, command_id, round, side, admin_account_id, recorded_at)
SELECT a.approver_ref::uuid, a.command_id, 0, 'APPROVER', a.approver_ref::uuid, a.decided_at
FROM command_approval a
WHERE a.approver_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE idempotency_record DROP CONSTRAINT IF EXISTS idempotency_record_operation_check;
--> statement-breakpoint
ALTER TABLE idempotency_record ADD CONSTRAINT idempotency_record_operation_check CHECK (operation IN ('CREATE_EVENT_CANCELLATION', 'CREATE_PARTNER_EVENT_CANCELLATION', 'CREATE_BOT_REVIEW_JUDGEMENT', 'CREATE_OPS_COMMAND'));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON command_actor TO ops_app;
