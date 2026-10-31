-- 예시 컨텍스트의 표(drizzle-kit generate가 만든 모양을 검토해 커밋한다, ADR-0037 결정 6)
CREATE TABLE "example_note" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_account_id" text NOT NULL,
	"title" text NOT NULL
);
