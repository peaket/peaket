-- F-06-3 구현 리뷰 IR-08: 양도 회수 승인 시점의 보유자를 저장해 실행기에 기대 값으로 넘긴다.
ALTER TABLE "approval_request" ADD COLUMN IF NOT EXISTS "expected_holder_account_id" uuid;
