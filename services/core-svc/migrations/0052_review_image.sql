-- 후기 사진(F-07-10, POL-042 ⑥, ADR-0066, docs/data.md §2 review_image).
-- 원본 키는 두지 않는다. image-worker가 다시 인코딩한 파생본 두 개(240·1280 WebP)의 키만 둔다.
-- 번호 0052: F-10-2가 0050_image_job, F-10-1이 0051부터를 쓴다(감독 조정 2026-11-26).
CREATE TABLE "review_image" (
	"id" uuid PRIMARY KEY,
	"review_id" uuid,
	"account_id" uuid NOT NULL,
	"status" text NOT NULL,
	"reject_reason" text,
	"alt_text" text DEFAULT '' NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"sort" smallint DEFAULT 0 NOT NULL,
	"thumb_key" text NOT NULL,
	"view_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"attached_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "review_image_status_check" CHECK ("review_image"."status" in ('UPLOADED', 'SCANNING', 'READY', 'REJECTED', 'DELETED')),
	CONSTRAINT "review_image_reject_check" CHECK ("review_image"."reject_reason" is null or "review_image"."reject_reason" in ('UNSUPPORTED_TYPE', 'TOO_LARGE', 'TOO_SMALL', 'MALWARE')),
	CONSTRAINT "review_image_alt_check" CHECK (char_length("review_image"."alt_text") <= 100),
	CONSTRAINT "review_image_sort_check" CHECK ("review_image"."sort" between 0 and 2),
	CONSTRAINT "review_image_attach_check" CHECK (("review_image"."review_id" is null) = ("review_image"."attached_at" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "review_image_review_sort_uq" ON "review_image" USING btree ("review_id", "sort") WHERE "review_image"."review_id" is not null and "review_image"."status" <> 'DELETED';
--> statement-breakpoint
CREATE INDEX "review_image_account_created_idx" ON "review_image" USING btree ("account_id", "created_at");
--> statement-breakpoint
CREATE INDEX "review_image_review_idx" ON "review_image" USING btree ("review_id");
--> statement-breakpoint
CREATE INDEX "review_image_status_created_idx" ON "review_image" USING btree ("status", "created_at");
--> statement-breakpoint
-- 올리기 한도는 성공 행이 아니라 시도를 센다(구현 리뷰 IR-04): 거절·실패한 시도도 image-worker를 부르므로 같은 창에서 센다
CREATE TABLE "review_image_upload_attempt" (
	"id" uuid PRIMARY KEY,
	"account_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "review_image_upload_attempt_account_created_idx" ON "review_image_upload_attempt" USING btree ("account_id", "created_at");
--> statement-breakpoint
CREATE INDEX "review_image_upload_attempt_created_idx" ON "review_image_upload_attempt" USING btree ("created_at");
--> statement-breakpoint
GRANT SELECT ON "review_image" TO "core_app";
--> statement-breakpoint
GRANT INSERT ON "review_image" TO "core_app";
--> statement-breakpoint
GRANT UPDATE ("review_id", "alt_text", "sort", "attached_at", "status", "deleted_at") ON "review_image" TO "core_app";
--> statement-breakpoint
GRANT SELECT ON "review_image" TO "core_maintenance";
--> statement-breakpoint
GRANT UPDATE ("status", "deleted_at") ON "review_image" TO "core_maintenance";
--> statement-breakpoint
GRANT DELETE ON "review_image" TO "core_maintenance";
--> statement-breakpoint
GRANT SELECT ON "review_image_upload_attempt" TO "core_app";
--> statement-breakpoint
GRANT INSERT ON "review_image_upload_attempt" TO "core_app";
--> statement-breakpoint
GRANT SELECT ON "review_image_upload_attempt" TO "core_maintenance";
--> statement-breakpoint
GRANT DELETE ON "review_image_upload_attempt" TO "core_maintenance";
