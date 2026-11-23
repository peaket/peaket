-- 받는 사람 조회 기록과 돌려주기 멱등 기록(F-05-2, ASVS 2.4.1·11.1.1, docs/data.md·docs/features/transfer-refund.md §4).
-- - transfer_recipient_lookup: 조회 시도마다 한 행. 회원 코드·휴대폰 번호 원문·찾은 계정 ID는 남기지 않는다.
--   result는 FOUND·NOT_FOUND·LIMITED·UNAVAILABLE이고, 한도(계정당 미끄러지는 60분 10회 [가정])를 셀 때 LIMITED는 뺀다.
--   보존 90일 [가정]은 읽기에서 지나간 행을 세지 않는 것으로 지키고, 실제 지우기는 데이터 보존 정비(구간 5)로 넘긴다.
-- - ticket_return: (account_id, idempotency_key)가 멱등 키다. 같은 키·같은 표는 처음 200을 재생하고, 같은 키·다른 표는 422다.
--   표와 같은 보존을 따른다. 응답 본문은 ticket_id로 다시 만들 수 있어 결과를 따로 저장하지 않는다.

CREATE TABLE IF NOT EXISTS transfer_recipient_lookup (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  looked_up_at timestamptz NOT NULL,
  result text NOT NULL,
  CONSTRAINT transfer_recipient_lookup_result_check CHECK (result IN ('FOUND', 'NOT_FOUND', 'LIMITED', 'UNAVAILABLE'))
);

CREATE INDEX IF NOT EXISTS transfer_recipient_lookup_account_idx ON transfer_recipient_lookup (account_id, looked_up_at DESC);

CREATE TABLE IF NOT EXISTS ticket_return (
  idempotency_key uuid NOT NULL,
  account_id uuid NOT NULL,
  ticket_id uuid NOT NULL REFERENCES ticket(id),
  returned_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, idempotency_key)
);

-- 기기 키를 등록한 계정(F-05-2 연결 시험이 key 등록자를 확인한다). 양도 뒤에는 보유자와 다를 수 있어 등록 시점 값을 남긴다.
-- 옛 행은 지금 보유자로 채운다(등록 시점 값을 알 수 없다). nullable이라 옛 코드·옛 행과도 맞는다.
ALTER TABLE device_key ADD COLUMN IF NOT EXISTS account_id uuid;
UPDATE device_key dk SET account_id = t.account_id FROM ticket t WHERE dk.ticket_id = t.id AND dk.account_id IS NULL;
