-- 미수금 이동 기록 표 이름을 정본(docs/data.md ERD receivable_movement)에 맞춘다(FIX-invariant-m3).
-- 확장 단계(docs/devops.md §7.1, docs/data.md §4 '미수금 이동 기록 표 이름 맞추기'): 이름만 바꾸고 옛 이름은 자동 갱신 뷰로 남긴다.
ALTER TABLE "receivable_move" RENAME TO "receivable_movement";--> statement-breakpoint
ALTER INDEX "receivable_move_pkey" RENAME TO "receivable_movement_pkey";--> statement-breakpoint
ALTER INDEX "receivable_move_receivable_idx" RENAME TO "receivable_movement_receivable_idx";--> statement-breakpoint
ALTER TABLE "receivable_movement" RENAME CONSTRAINT "receivable_move_amount_check" TO "receivable_movement_amount_check";--> statement-breakpoint
ALTER TABLE "receivable_movement" RENAME CONSTRAINT "receivable_move_kind_check" TO "receivable_movement_kind_check";--> statement-breakpoint
ALTER TABLE "receivable_movement" RENAME CONSTRAINT "receivable_move_receivable_id_partner_receivable_id_fk" TO "receivable_movement_receivable_id_partner_receivable_id_fk";--> statement-breakpoint
ALTER TABLE "receivable_movement" RENAME CONSTRAINT "receivable_move_statement_id_settlement_statement_id_fk" TO "receivable_movement_statement_id_settlement_statement_id_fk";--> statement-breakpoint
CREATE VIEW "receivable_move" WITH (security_invoker = true) AS SELECT "id", "receivable_id", "statement_id", "amount", "kind", "moved_at" FROM "receivable_movement";
