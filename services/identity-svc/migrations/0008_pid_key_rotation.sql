-- pid 키 전환 기록(docs/features/identity.md §5 'pid 키 전환의 첫 구현', docs/data.md pid_key_rotation, BUILD_ORDER BOT-025).
-- 새 표라 인덱스를 바로 만든다. 닫지 않은 전환 줄은 하나만 둔다(부분 고유 인덱스).
CREATE TABLE "pid_key_rotation" (
	"to_version" integer PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"transition_ends_at" timestamp with time zone NOT NULL,
	"moved_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pid_key_rotation_open_idx" ON "pid_key_rotation" USING btree ((true)) WHERE finished_at is null;