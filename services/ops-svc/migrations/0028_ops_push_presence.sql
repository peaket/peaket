-- F-03-1 OPS-340(ADR-0360): 관제 SSE 알림 표 ops_push_event·접속 중 운영자 표 ops_presence와 알림 행을 쓰는 트리거(docs/data.md ops_push_event·ops_presence, ADR-0100 결정 4).
-- 알림 행은 원래 기록과 같은 트랜잭션에 써야 한다. 명령·경보 모듈을 고치지 않고 그 약속을 지키려고 DB 트리거로 쓴다(ADR-0360 결정 1):
--   ops_command 행이 생기거나 state가 바뀌면 command 한 줄, 그 상태가 승인 대기(PENDING_APPROVAL·REVERT_PENDING)면 approval 한 줄을 더 쓴다.
--   ops_alert 행이 생기거나(발생) resolved_at이 바뀌면(풀림·다시 열림) alert 한 줄을 쓴다.
-- 트리거 본문은 참조값과 상태만 싣는다. 역할별 화면 모양(명령 목록 한 줄, canApprove)은 흐름을 내는 파드가 명령 저장소로 다시 읽어 만든다.
-- 트랜잭션을 되돌리면 알림 행도 함께 없어진다(F-03-1 T9). 1시간 [가정] 지난 행은 ops-svc live 모듈의 정비 반복이 지운다.

-- ① 알림 표. seq는 늘어나기만 하는 순번이고 SSE id·Last-Event-ID의 기준이다. 시퀀스 값은 되돌린 트랜잭션에도 쓰여 빈 번호가 생길 수 있다(읽는 쪽이 잠깐 기다린다)
CREATE SEQUENCE IF NOT EXISTS ops_push_event_seq AS bigint;
CREATE TABLE IF NOT EXISTS ops_push_event (
  seq bigint PRIMARY KEY DEFAULT nextval('ops_push_event_seq'),
  kind text NOT NULL,
  event_id uuid,
  roles text NOT NULL,
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ops_push_event_kind_check CHECK (kind IN ('command', 'approval', 'alert', 'autoAction'))
);
ALTER SEQUENCE ops_push_event_seq OWNED BY ops_push_event.seq;
CREATE INDEX IF NOT EXISTS ops_push_event_created_idx ON ops_push_event (created_at);
--> statement-breakpoint
-- ② 접속 중 운영자 표. 흐름을 든 파드가 연결마다 15초 [가정]마다 last_seen_at을 고쳐 쓰고, 45초 [가정] 안의 행만 접속 중이다.
-- account_ref는 관리 계정 ID(명령 목록의 requestedBy.adminAccountId와 같은 참조)이고 이름·전화번호 같은 개인정보는 두지 않는다
CREATE TABLE IF NOT EXISTS ops_presence (
  account_ref uuid NOT NULL,
  event_id uuid NOT NULL,
  role text NOT NULL,
  screen text NOT NULL,
  last_seen_at timestamptz NOT NULL,
  PRIMARY KEY (account_ref, event_id)
);
CREATE INDEX IF NOT EXISTS ops_presence_event_seen_idx ON ops_presence (event_id, last_seen_at);
--> statement-breakpoint
-- ③ 명령 상태 트리거. 받을 역할은 명령 목록 REST와 같은 viewer·operator·commander이고, 승인 대기는 operator·commander 가운데 그 명령을 승인할 수 있는 사람만 받는다(파드가 canApprove로 거른다)
CREATE OR REPLACE FUNCTION ops_push_command_event() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_body jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.state IS NOT DISTINCT FROM NEW.state THEN
    RETURN NULL;
  END IF;
  v_body := jsonb_strip_nulls(jsonb_build_object(
    'commandId', NEW.id,
    'type', NEW.type,
    'state', NEW.state,
    'eventId', NEW.event_id,
    'approvalExpiresAt', NEW.approval_expires_at
  ));
  INSERT INTO public.ops_push_event (kind, event_id, roles, body) VALUES ('command', NEW.event_id, 'viewer,operator,commander', v_body);
  IF NEW.state IN ('PENDING_APPROVAL', 'REVERT_PENDING') THEN
    INSERT INTO public.ops_push_event (kind, event_id, roles, body) VALUES ('approval', NEW.event_id, 'operator,commander', v_body);
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION ops_push_command_event() FROM PUBLIC;
DROP TRIGGER IF EXISTS ops_command_push_event ON ops_command;
CREATE TRIGGER ops_command_push_event AFTER INSERT OR UPDATE OF state ON ops_command FOR EACH ROW EXECUTE FUNCTION ops_push_command_event();
--> statement-breakpoint
-- ④ 경보 트리거. 본문은 asyncapi OpsAlert 모양이다(kind는 계약 열거에 없는 내부 종류면 hygiene, 내부 종류는 sourceKind)
CREATE OR REPLACE FUNCTION ops_push_alert_event() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_event uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.resolved_at IS NOT DISTINCT FROM NEW.resolved_at THEN
    RETURN NULL;
  END IF;
  IF NEW.event_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_event := NEW.event_key::uuid;
  END IF;
  INSERT INTO public.ops_push_event (kind, event_id, roles, body) VALUES (
    'alert',
    v_event,
    'viewer,operator,commander',
    jsonb_strip_nulls(jsonb_build_object(
      'alertId', NEW.id,
      'status', CASE WHEN NEW.resolved_at IS NULL THEN 'firing' ELSE 'resolved' END,
      'startsAt', NEW.created_at,
      'endsAt', NEW.resolved_at,
      'severity', NEW.severity,
      'title', NEW.reason,
      'kind', CASE WHEN NEW.kind IN ('slo', 'cause', 'invariant', 'control', 'hygiene', 'legal', 'field', 'change', 'security', 'flow') THEN NEW.kind ELSE 'hygiene' END,
      'sourceKind', NEW.kind,
      'eventId', v_event
    ))
  );
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION ops_push_alert_event() FROM PUBLIC;
DROP TRIGGER IF EXISTS ops_alert_push_event ON ops_alert;
CREATE TRIGGER ops_alert_push_event AFTER INSERT OR UPDATE OF resolved_at ON ops_alert FOR EACH ROW EXECUTE FUNCTION ops_push_alert_event();
--> statement-breakpoint
-- ⑤ 권한. 서비스 역할(ops_app)은 알림 표를 읽고 지우며(정비) 접속자 표를 읽고 쓴다. 표 권한은 0015의 기본 권한이 주고, 시퀀스 값 읽기(다시 붙기 판정)는 따로 준다.
-- 파트너 역할(ops_partner)은 두 표를 읽지도 쓰지도 못한다
GRANT USAGE, SELECT ON SEQUENCE ops_push_event_seq TO ops_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ops_push_event, ops_presence TO ops_app;
REVOKE ALL ON ops_push_event, ops_presence FROM ops_partner;
