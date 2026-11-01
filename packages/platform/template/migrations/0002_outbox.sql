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
