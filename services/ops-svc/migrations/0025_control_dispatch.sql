-- F-02-1 OPS-300(ADR-0365 결정 1·4): 제어 gRPC 판 번호 원장, 받는 파드마다의 ack, 명령 기록의 판 칸.
-- control_version: (범위, 제어 종류)마다 마지막 판. 명령이 처음 DISPATCHED가 될 때 같은 트랜잭션에서 새 판 = max(마지막 판 + 1, 지금 밀리초)를 매긴다.
--   범위는 회차 ID 또는 PLATFORM, 종류는 proto ControlKind 이름이다. 매기기 전에 판 0인 행을 먼저 넣고 잠근다(같은 범위의 두 명령이 같은 판을 얻지 않게).
-- command_delivery: (명령, 판, 서비스, 범위, 부른 주소)마다 한 줄. 판 이상을 답하면 파드 이름·적용한 판·ack 시각을 적는다(openapi CommandState.delivery).
-- ops_command.control_version·control_sent_at: 지금 보내는 판과 그 판을 보내기 시작한 시각(ack 시한 10초의 기준, ADR-0073 결정 17).
CREATE TABLE IF NOT EXISTS control_version (
  scope text NOT NULL,
  kind text NOT NULL,
  last_version bigint NOT NULL,
  command_id uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT control_version_pkey PRIMARY KEY (scope, kind),
  CONSTRAINT control_version_last_check CHECK (last_version >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS command_delivery (
  command_id uuid NOT NULL REFERENCES ops_command (id),
  version bigint NOT NULL,
  service text NOT NULL,
  scope text NOT NULL,
  target text NOT NULL,
  pod_name text,
  applied_version bigint,
  acked_at timestamptz,
  updated_at timestamptz NOT NULL,
  CONSTRAINT command_delivery_pkey PRIMARY KEY (command_id, version, service, scope, target),
  CONSTRAINT command_delivery_version_check CHECK (version > 0)
);
--> statement-breakpoint
ALTER TABLE ops_command ADD COLUMN IF NOT EXISTS control_version bigint;
--> statement-breakpoint
ALTER TABLE ops_command ADD COLUMN IF NOT EXISTS control_sent_at timestamptz;
--> statement-breakpoint
-- 정비 바퀴가 DISPATCHED로 남은 제어 명령을 찾는다(이어 보내기)
CREATE INDEX IF NOT EXISTS ops_command_dispatched_control_idx ON ops_command (updated_at) WHERE state = 'DISPATCHED' AND control_version IS NOT NULL;
--> statement-breakpoint
-- 서비스 역할(ops_app): 원장·ack 기록은 읽고 쓰기만 한다(지우지 않는다). 0015의 기본 권한 위에 좁혀 둔다
REVOKE DELETE ON control_version FROM ops_app;
--> statement-breakpoint
REVOKE DELETE ON command_delivery FROM ops_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON control_version TO ops_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON command_delivery TO ops_app;
