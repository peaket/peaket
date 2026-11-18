-- BAT-420-rest 리뷰 반영 RV-03(BUILD_ORDER GAT-090, docs/features/payment.md §6 '구현에서 정한 것' ④, docs/data.md payment_cancel, P-T73 ③).
-- payment_cancel.fail_reason: FAILED 행의 개인정보 없는 까닭. 계좌 거절(은행·계좌번호·예금주 확인 실패)이면 REFUND_ACCOUNT_INVALID이고 그 밖 업무 거절은 비운다.
-- 같은 취소 ID를 다시 부르면 이 칸으로 첫 답(REFUND_ACCOUNT_REQUIRED·REJECTED)을 그대로 준다. 계좌는 저장하지 않는다. 빈 값 허용이고 옛 행은 채우지 않는다.
-- 번호는 갈래 3 몫(0023~0024, docs/lanes/coord.md). 0022는 갈래 5 몫이라 비워 둔다.
ALTER TABLE "payment_cancel" ADD COLUMN "fail_reason" text;--> statement-breakpoint
ALTER TABLE "payment_cancel" ADD CONSTRAINT "payment_cancel_fail_reason_check" CHECK ("payment_cancel"."fail_reason" IS NULL OR ("payment_cancel"."status" = 'FAILED' AND "payment_cancel"."fail_reason" = 'REFUND_ACCOUNT_INVALID'));