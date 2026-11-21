-- BAT-360 OPS-290(ADR-0349): 설정 사건 Outbox·사후 검토·운영 사건·명령 4 만료와 만료 차단 정리 작업의 보기·역할.
-- 절마다 맡은 몫이 다르다: ① Outbox 부모 표·릴레이 역할(설정 사건 일반 내기, ADR-0349 결정 5), ② 아래 절들(사후 검토·만료 차단 정리, 결정 7·9·10).

-- ① Outbox 부모 표·릴레이 역할(B1)
-- 서비스 뼈대(packages/platform/template/migrations/0002_outbox.sql)를 그대로 옮겼다(운영 설정 사건 control.settings, ADR-0143 결정 3·ADR-0349 결정 5).
-- Outbox 부모 표(docs/data.md §2 '파티션 표 규칙'·§4의 7번, ADR-0083·0116). Drizzle 0.45에는 파티션 선언이 없어 손으로 쓴 SQL이다.
-- ID(UUIDv7, 주입한 시계) 범위로 한국 시각 하루씩 나눈다. 기본(DEFAULT) 파티션은 두지 않는다.
-- 파티션은 @peaket/platform의 ensureOutboxPartitions가 만든다(첫 파티션 포함, 7일 [가정] 앞까지). 날짜를 박은 첫 파티션은 배포 날짜와 어긋나 첫 쓰기가 실패한다.
-- seq는 보내는 순서, sent_at은 릴레이가 보낸 뒤 적는다. 보내지 않은 행은 부분 인덱스로 찾는다(sent_at을 적으면 빠진다).
CREATE SEQUENCE "outbox_seq" AS bigint;
CREATE TABLE "outbox" (
	"id" uuid NOT NULL,
	"seq" bigint NOT NULL DEFAULT nextval('outbox_seq'),
	"topic" text NOT NULL,
	"msg_key" text NOT NULL,
	"payload" bytea NOT NULL,
	"headers" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"sent_at" timestamp with time zone,
	CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
) PARTITION BY RANGE ("id");
ALTER SEQUENCE "outbox_seq" OWNED BY "outbox"."seq";
CREATE INDEX "outbox_unsent_idx" ON "outbox" ("seq") WHERE "sent_at" IS NULL;
--> statement-breakpoint
-- 릴레이 역할 ops_outbox_relay(docs/data.md §4의 7번 '<서비스>_outbox_relay': Outbox 읽기와 sent_at 고치기만). 로그인 사용자는 비밀 관리가 만들어 이 역할에 넣는다.
-- 부모 표로 읽고 고치므로 권한은 부모 표에만 준다(파티션을 거쳐 읽을 때는 부모 표 권한만 본다). 업무 표·감사 체인은 읽지도 쓰지도 못한다
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_outbox_relay') THEN
    CREATE ROLE ops_outbox_relay NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_outbox_relay' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'ops_outbox_relay 역할은 SUPERUSER·BYPASSRLS가 없어야 한다';
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO ops_outbox_relay;
--> statement-breakpoint
GRANT SELECT, UPDATE ("sent_at") ON "outbox" TO ops_outbox_relay;
--> statement-breakpoint
-- 서비스 역할(ops_app)은 설정형 명령과 같은 트랜잭션에서 Outbox 행을 넣는다. 표 권한은 0015의 기본 권한이 주고, 시퀀스(seq 기본값)는 따로 준다
GRANT USAGE, SELECT ON SEQUENCE "outbox_seq" TO ops_app;
--> statement-breakpoint
-- ② command_post_review(B2): 명령 3·11 사후 검토 보고서(명령마다 한 행, docs/data.md command_post_review, ADR-0349 결정 7).
-- 처음 DISPATCHED와 같은 트랜잭션에서 행을 넣고(due_at = 처음 DISPATCHED + 48시간), 제출·검토·경보 표시는 명령 행을 잠근 트랜잭션의 조건부 갱신이다
-- (submitted_at IS NULL, submitted_at IS NOT NULL AND confirmed_at IS NULL, due_alerted_at·confirm_alerted_at IS NULL, docs/data.md §5 '사후 검토 보고서 제출·검토가 겹침').
-- 사람 칸은 가명 참조(command_actor로 푼다)이고 관리 계정 ID·이름을 적지 않는다
CREATE TABLE IF NOT EXISTS command_post_review (
  command_id uuid PRIMARY KEY REFERENCES ops_command (id),
  executor_ref text NOT NULL,
  due_at timestamptz NOT NULL,
  submitted_at timestamptz,
  report jsonb,
  confirm_due_at timestamptz,
  confirmed_at timestamptz,
  reviewer_ref text,
  assessment text,
  solo_self_review boolean NOT NULL DEFAULT false,
  late boolean NOT NULL DEFAULT false,
  due_alerted_at timestamptz,
  confirm_alerted_at timestamptz,
  CONSTRAINT command_post_review_assessment_check CHECK (assessment IS NULL OR assessment IN ('APPROPRIATE', 'INAPPROPRIATE', 'INCONCLUSIVE')),
  CONSTRAINT command_post_review_submitted_check CHECK ((submitted_at IS NULL) = (report IS NULL) AND (submitted_at IS NULL) = (confirm_due_at IS NULL)),
  CONSTRAINT command_post_review_confirmed_check CHECK (confirmed_at IS NULL OR (submitted_at IS NOT NULL AND reviewer_ref IS NOT NULL AND assessment IS NOT NULL)),
  CONSTRAINT command_post_review_solo_check CHECK (NOT solo_self_review OR confirmed_at IS NOT NULL)
);
--> statement-breakpoint
-- 정비가 고르는 기한 넘김(경보를 아직 내지 않은 것)
CREATE INDEX IF NOT EXISTS command_post_review_due_idx ON command_post_review (due_at) WHERE submitted_at IS NULL AND due_alerted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS command_post_review_confirm_due_idx ON command_post_review (confirm_due_at) WHERE submitted_at IS NOT NULL AND confirmed_at IS NULL AND confirm_alerted_at IS NULL;
--> statement-breakpoint
-- 할 일 열기를 놓친 명령 3·11을 정비가 찾는다
CREATE INDEX IF NOT EXISTS ops_command_post_review_types_idx ON ops_command (created_at) WHERE type IN ('KILL_SWITCH', 'AUTOMATION_STOP');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON command_post_review TO ops_app;
--> statement-breakpoint
-- ③ 명령 사건 종류(B2): POST_REVIEW_OPENED·POST_REVIEW_SUBMITTED·POST_REVIEW_CONFIRMED는 같은 command_id의 command_event 행이다(docs/data.md §4 6번).
-- command_event.type에는 CHECK가 없어(0000부터 사건 이름은 글자) 표를 바꾸지 않는다. 사건 이름의 정본은 ADR-0349 결정 7이다.
--> statement-breakpoint
-- ④ 명령 4 expires_at(B2): 0021의 칸에 명령 4의 만료(params.expiresAt)를 받을 때 적는다(ADR-0349 결정 10). 0024 이전에 받은 ACKED 명령 4는 params에서 채운다.
-- 꼴이 틀린 옛 값은 비운 채 둔다(정비·정리 작업이 보지 않는다)
CREATE OR REPLACE FUNCTION ops_try_timestamptz(v text) RETURNS timestamptz LANGUAGE plpgsql STABLE STRICT AS $$
BEGIN
  RETURN v::timestamptz;
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$$;
--> statement-breakpoint
UPDATE ops_command SET expires_at = ops_try_timestamptz(params ->> 'expiresAt')
 WHERE type = 'BLOCK_ASN_IP' AND expires_at IS NULL AND params ->> 'expiresAt' IS NOT NULL;
--> statement-breakpoint
-- ⑤ waf_block_expiry_v·waf_block_expirer(B2): 만료 차단 정리 작업이 읽는 유일한 보기(docs/data.md §4 6번, ADR-0349 결정 9, ADR-0162).
-- 명령 4의 대역 하나마다 한 행(명령 ID, 정규화한 CIDR, 만료 시각, 상태)이고 사유·요청자·params의 다른 칸은 보이지 않는다.
-- CIDR은 PostgreSQL cidr로 정규화하고, 읽지 못하는 옛 값은 빼낸다(접수 검사가 호스트 비트·꼴을 이미 거른다, ADR-0339 결정 2).
CREATE OR REPLACE FUNCTION ops_try_cidr(v text) RETURNS cidr LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
  RETURN v::cidr;
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE VIEW waf_block_expiry_v WITH (security_barrier = true) AS
SELECT b.command_id, b.cidr, b.expires_at, b.state
FROM (
  SELECT c.id AS command_id, ops_try_cidr(e.value) AS cidr, c.expires_at, c.state
  FROM ops_command c
  CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(c.params -> 'cidrs') = 'array' THEN c.params -> 'cidrs' ELSE '[]'::jsonb END) AS e(value)
  WHERE c.type = 'BLOCK_ASN_IP' AND c.expires_at IS NOT NULL
) b
WHERE b.cidr IS NOT NULL;
--> statement-breakpoint
-- 작업 역할 waf_block_expirer: 이 보기의 SELECT만 가진다(명령 상태 표·command_event·감사 체인의 읽기·쓰기 없음, docs/data.md §4 6번).
-- 로그인 사용자는 비밀 관리가 만들어 이 역할에 넣는다(구간 5). 보기는 소유자 권한으로 ops_command를 읽으므로 역할에 표 권한을 주지 않는다
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'waf_block_expirer') THEN
    CREATE ROLE waf_block_expirer NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'waf_block_expirer' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'waf_block_expirer 역할은 SUPERUSER·BYPASSRLS가 없어야 한다';
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO waf_block_expirer;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM waf_block_expirer;
--> statement-breakpoint
GRANT SELECT ON waf_block_expiry_v TO waf_block_expirer;
