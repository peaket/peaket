-- F-06-3 구현 재리뷰 IR-21: 같은 승인 ID의 다른 kind 재요청을 DB에서도 막는다.
ALTER TABLE "order_cancellation" ADD COLUMN IF NOT EXISTS "approval_kind" text;
