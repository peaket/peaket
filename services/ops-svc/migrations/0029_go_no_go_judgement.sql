-- F-03-3 OPS-380(ADR-0371): Go/No-Go 판정 기록 표 ops_go_no_go_judgement와 경보 알림 트리거 함수 바꿈(docs/data.md ops_go_no_go_judgement·ops_push_event).
-- ① 판정 기록 표. 판정·재판정마다 한 행이고 같은 회차 안에서 sequence가 1씩 는다. 같은 트랜잭션에서 감사 체인 GO_NO_GO_JUDGED에도 남긴다(readiness 모듈).
--    판정자는 로그 가명(judged_by_ref, HMAC 앞 16바이트)만 두고 계정 ID·이름은 두지 않는다. 행은 고치거나 지우지 않는다(감사 체인과 같은 보관).
-- ② 경보 알림 트리거 함수(F-03-1 0028)를 바꾼다: 경보 기록 detail의 정한 글 칸(journey·foldedUnder·runbookUrl·dashboardUrl·exploreUrl·dependency)을 경보 본문으로 옮기고,
--    시각을 UTC 밀리초 ISO('…T…Z')로 낸다. 경보 목록 REST(GET /v1/ops/alerts)가 같은 규칙으로 본문을 만들어 두 본문이 같은 경보에서 같은 값이다(ADR-0371 결정 9).
--    detail의 그 밖의 칸은 본문으로 가지 않는다. journey는 여정 일곱 값일 때만 옮긴다(asyncapi OpsAlert.journey).

CREATE TABLE IF NOT EXISTS ops_go_no_go_judgement (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  verdict text NOT NULL CHECK (verdict IN ('go', 'no-go')),
  failed_required jsonb NOT NULL,
  failed_recommended jsonb NOT NULL,
  recommended_reasons jsonb NOT NULL,
  items jsonb NOT NULL,
  judged_by_ref text NOT NULL,
  judged_at timestamptz NOT NULL,
  CONSTRAINT ops_go_no_go_judgement_event_sequence_key UNIQUE (event_id, sequence)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ops_push_alert_event() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_event uuid;
  v_detail jsonb := COALESCE(NEW.detail, '{}'::jsonb);
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
      'startsAt', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'endsAt', to_char(NEW.resolved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'severity', NEW.severity,
      'title', NEW.reason,
      'kind', CASE WHEN NEW.kind IN ('slo', 'cause', 'invariant', 'control', 'hygiene', 'legal', 'field', 'change', 'security', 'flow') THEN NEW.kind ELSE 'hygiene' END,
      'sourceKind', NEW.kind,
      'eventId', v_event,
      'journey', CASE WHEN jsonb_typeof(v_detail -> 'journey') = 'string'
                       AND v_detail ->> 'journey' IN ('detail', 'queue_entry', 'queue_state', 'hold', 'seat_status', 'payment_accept', 'payment_confirm')
                      THEN v_detail ->> 'journey' END,
      'foldedUnder', CASE WHEN jsonb_typeof(v_detail -> 'foldedUnder') = 'string' THEN v_detail ->> 'foldedUnder' END,
      'runbookUrl', CASE WHEN jsonb_typeof(v_detail -> 'runbookUrl') = 'string' THEN v_detail ->> 'runbookUrl' END,
      'dashboardUrl', CASE WHEN jsonb_typeof(v_detail -> 'dashboardUrl') = 'string' THEN v_detail ->> 'dashboardUrl' END,
      'exploreUrl', CASE WHEN jsonb_typeof(v_detail -> 'exploreUrl') = 'string' THEN v_detail ->> 'exploreUrl' END,
      'dependency', CASE WHEN jsonb_typeof(v_detail -> 'dependency') = 'string' THEN v_detail ->> 'dependency' END
    ))
  );
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION ops_push_alert_event() FROM PUBLIC;
--> statement-breakpoint
-- ③ 권한. 서비스 역할(ops_app)은 판정 기록을 읽고 더하기만 한다(고치기·지우기 없음). 파트너 역할(ops_partner)은 읽지도 쓰지도 못한다
REVOKE ALL ON ops_go_no_go_judgement FROM ops_app;
GRANT SELECT, INSERT ON ops_go_no_go_judgement TO ops_app;
REVOKE ALL ON ops_go_no_go_judgement FROM ops_partner;
