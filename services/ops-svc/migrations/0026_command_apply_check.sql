-- F-02-5 OPS-300(ADR-0365 결정 14): 설정형 명령(5·8·9·12)의 적용 확인 행.
-- 사건 단계(ACKED·REVERTED·AUTO_EXPIRED)·판마다 한 행이고, Outbox 행이 나갔는지(sent_at)와
-- Prometheus가 센 파드별 판(pods)을 적는다. due 색인은 정비 바퀴(5초)가 다음에 볼 행을 빠르게 고른다.
CREATE TABLE IF NOT EXISTS command_apply_check (
  command_id uuid NOT NULL REFERENCES ops_command (id),
  stage text NOT NULL,
  version bigint NOT NULL,
  message_key text NOT NULL,
  outbox_id uuid NOT NULL,
  service text,
  status text NOT NULL,
  written_at timestamptz NOT NULL,
  sent_at timestamptz,
  target_count int NOT NULL DEFAULT 0,
  acked_count int NOT NULL DEFAULT 0,
  pods jsonb NOT NULL DEFAULT '[]'::jsonb,
  alert_open boolean NOT NULL DEFAULT false,
  reason text,
  next_check_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT command_apply_check_pkey PRIMARY KEY (command_id, stage, version),
  CONSTRAINT command_apply_check_stage_check CHECK (stage IN ('ACKED', 'REVERTED', 'AUTO_EXPIRED')),
  CONSTRAINT command_apply_check_status_check CHECK (status IN ('OUTBOX_WAITING', 'CHECKING', 'CONFIRMED', 'UNCONFIRMED', 'UNKNOWN')),
  CONSTRAINT command_apply_check_version_check CHECK (version > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS command_apply_check_due_idx ON command_apply_check (next_check_at)
  WHERE status IN ('OUTBOX_WAITING', 'CHECKING', 'UNCONFIRMED', 'UNKNOWN');
--> statement-breakpoint
-- 적용 확인은 ops_app이 쓰고 읽는다(지우기는 주지 않는다). Outbox 행의 sent_at을 보려면 outbox 읽기가 필요하다
GRANT SELECT, INSERT, UPDATE ON command_apply_check TO ops_app;
--> statement-breakpoint
GRANT SELECT ON outbox TO ops_app;
