-- ops-svc 소비자의 보류 표(held_event, ADR-0142 결정 2, docs/data.md §4의 15번). 서비스 뼈대의 표와 같다.
-- 2026-11-14 R-584: ops.command-events 소비자가 처리 못 한 명령 사건을 여기로 옮긴다.
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
