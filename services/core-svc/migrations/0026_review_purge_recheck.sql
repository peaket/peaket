-- W8-audit2a: 탈퇴 계정 후기 파기와 탈퇴 + 16분 뒤 다시 정리(소유자 결정 2026-11-16 OPEN[42]·[44], ADR-0278, docs/data.md §2 '후기 파기'·'다시 정리 예약'·'후기 표의 DB 권한',
-- docs/features/identity.md §8 '후기 파기'·'다시 정리'). 감독 배정 번호 0026(스냅숏 0026).
-- 이번 출시는 넓히기만 한다(docs/devops.md §7.1 원칙 2·3): 파기한 행이 별점·내용 지문을 비울 수 있게 NOT NULL을 풀고, 살아 있는 행에는 별점·지문을 강제하는 CHECK를
-- NOT VALID로 더한다(기존 행은 검사하지 않고 새로 쓰는 행만 본다. 이전 판 코드도 살아 있는 행에는 늘 둘을 쓴다).
-- 파기한 행의 모양을 강제하는 CHECK와 두 CHECK의 VALIDATE CONSTRAINT는 다음 출시 마이그레이션 몫이다(이전 판의 작성자 지우기가 별점을 남겨 배포 창 동안 실패한다).
-- review의 권한은 바꾸지 않는다: 0022가 core_app에 준 UPDATE 칸 목록이 파기 칸을 모두 덮는다.
ALTER TABLE "review" ALTER COLUMN "rating" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "review" ALTER COLUMN "content_fingerprint" DROP NOT NULL;
--> statement-breakpoint
-- 살아 있는 행(VISIBLE·HIDDEN)은 별점·지문이 있다
ALTER TABLE "review" ADD CONSTRAINT "review_live_complete_check" CHECK ("review"."status" = 'DELETED' or ("review"."rating" is not null and "review"."content_fingerprint" is not null)) NOT VALID;
--> statement-breakpoint
-- 다시 정리 예약: 계정 ID·예약 시각·만든 시각만(pid·후기 내용 없음). 탈퇴 사건 처리 트랜잭션이 파기와 함께 넣고, 소비자 파드의 반복이 예약 시각에 다시 파기하며 지운다
CREATE TABLE "review_withdrawal_recheck" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
-- 때가 된 예약 찾기(due_at <= 지금 ORDER BY due_at … FOR UPDATE SKIP LOCKED, docs/data.md §5.1 '탈퇴 파기'). 새 표라 트랜잭션 안에서 만든다
CREATE INDEX "review_withdrawal_recheck_due_idx" ON "review_withdrawal_recheck" USING btree ("due_at");
--> statement-breakpoint
-- 최소 권한(ADR-0241 결정 4): core_app(소비자 풀)만 읽기·넣기·지우기와 예약 시각 고치기(같은 계정 예약의 늦은 쪽 남기기). account_id·created_at 고치기와 비우기는 주지 않는다.
-- core_partner·core_maintenance·core_ops에는 주지 않는다. 읽기는 0004의 기본 권한과 같은 것을 다시 적는다
GRANT SELECT, INSERT, DELETE, UPDATE ("due_at") ON "review_withdrawal_recheck" TO core_app;
