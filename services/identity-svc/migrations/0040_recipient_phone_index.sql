-- F-05-11 양도 받는 사람 찾기(docs/features/transfer-refund.md §4, docs/features/identity.md §6.2).
-- ACTIVE 계정의 phone을 숫자만 남긴 식으로 찾는다. 리졸버(DrizzleMemberCodeResolver.resolvePhone)의 식과 같아야 인덱스를 쓴다.
CREATE INDEX IF NOT EXISTS "account_phone_digits_active_idx"
  ON "account" (regexp_replace("phone", '[^0-9]', '', 'g'))
  WHERE "status" = 'ACTIVE';
