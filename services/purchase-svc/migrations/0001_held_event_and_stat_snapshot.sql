-- 서비스 뼈대(packages/platform/template/migrations/0003_held_event_and_stat_snapshot.sql)를 그대로 옮겼다(purchase-svc 홀드 원장 적재의 보류 표, BUILD_ORDER PRF-141).
-- 보류 표와 통계 스냅샷 표(openspec 변경 add-maintenance-control-and-consumers 결정 6·12).
-- held_event: 서비스 소비자가 처리 못 한 사건(ADR-0142 결정 2, docs/data.md §4의 15번). 사건 값이 그대로 들어가 서비스 DB와 같은 보호 등급이다.
--   같은 위치·같은 eventKey는 두 번 넣지 않고, 보류 중인 키는 부분 인덱스로 찾는다. 다시 처리한 행은 7일 [가정] 뒤 정비 잡이 지운다.
--   Kafka 키(msg_key)와 레코드 시각(record_at)은 다시 처리 때 그대로 넘긴다.
-- stat_snapshot: 정비 잡이 매일 남기는 pg_stat_user_tables·pg_stat_user_indexes(ADR-0086 결정 7). 90일 [가정] 뒤 지운다. 개인정보 없음.
-- @peaket/platform의 heldEventTable()·statSnapshotTable()과 같다(template.int.test.ts가 맞춰 본다).
CREATE TABLE "held_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"partition" integer NOT NULL,
	"kafka_offset" bigint NOT NULL,
	"event_key" text,
	"business_key" text NOT NULL,
	"error" text NOT NULL,
	"msg_key" text,
	"record_at" timestamp with time zone NOT NULL,
	"value" bytea,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"held_at" timestamp with time zone NOT NULL,
	"reprocessed_at" timestamp with time zone
);
CREATE UNIQUE INDEX "held_event_position_key" ON "held_event" ("topic", "partition", "kafka_offset");
CREATE UNIQUE INDEX "held_event_event_key" ON "held_event" ("topic", "event_key") WHERE event_key IS NOT NULL;
CREATE INDEX "held_event_pending_idx" ON "held_event" ("topic", "business_key", "partition", "kafka_offset") WHERE reprocessed_at IS NULL;
CREATE TABLE "stat_snapshot" (
	"taken_at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"relname" text NOT NULL,
	"indexrelname" text DEFAULT '' NOT NULL,
	"seq_scan" bigint,
	"seq_tup_read" bigint,
	"idx_scan" bigint,
	"n_live_tup" bigint,
	"n_dead_tup" bigint,
	"n_tup_upd" bigint,
	"n_tup_hot_upd" bigint,
	"total_bytes" bigint,
	CONSTRAINT "stat_snapshot_pkey" PRIMARY KEY ("taken_at", "kind", "relname", "indexrelname")
);
