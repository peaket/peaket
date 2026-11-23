-- F-07-8 J-T23 ③(ADR-0380 결정 7): 대사 풀린 결제마다 CS '조정 제안' 건(SETTLEMENT_ADJUSTMENT_SUGGESTED)을 연다.
-- 같은 정산서라도 결제가 다르면 다른 건이므로, 이 종류는 (종류, 대상) 열린 건 유일 인덱스에서 뺀다.
-- 중복은 cs_case_request.event_key(사건 키: reconciliation-resolved:{정산서}:{결제})가 막는다.
DROP INDEX IF EXISTS cs_case_open_key;
CREATE UNIQUE INDEX IF NOT EXISTS cs_case_open_key ON cs_case (kind, target_ref)
  WHERE status <> 'RESOLVED' AND kind <> 'SETTLEMENT_ADJUSTMENT_SUGGESTED';
