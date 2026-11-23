-- A-T21(analytics §3.3 '조사 칸은 싣지 않는다', ADR-0171 결정 2): 브론즈·실버 표 정의에 조사 칸 열이 생기면 실패한다
select database, table, name
from system.columns
where database in ('bronze', 'staging', 'silver')
  and name in ('journey_id', 'journeyId', 'device_ref', 'deviceRef', 'contact_ref', 'contactRef', 'payment_method_ref', 'paymentMethodRef', 'card_bin', 'cardBin', 'hold_kind', 'priority_grant_id')
