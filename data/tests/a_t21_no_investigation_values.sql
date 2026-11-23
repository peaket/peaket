-- A-T21: 브론즈 값(payload)에 조사 칸 이름이 실려 있으면 실패한다(적재가 버렸어야 한다, F-04-3)
select 'brz_order_event' as t, count() as n from {{ source('bronze', 'brz_order_event') }} where match(payload, '"(journeyId|contactRef)"') having n > 0
union all
select 'brz_payment_event', count() from {{ source('bronze', 'brz_payment_event') }} where match(payload, '"(paymentMethodRef|cardBin)"') having count() > 0
union all
select 'brz_hold_attempt', count() from {{ source('bronze', 'brz_hold_attempt') }} where match(payload, '"journeyId"') having count() > 0
union all
select 'brz_trust_verdict', count() from {{ source('bronze', 'brz_trust_verdict') }} where match(payload, '"(journeyId|deviceRef)"') having count() > 0
union all
select 'brz_queue_entry', count() from {{ source('bronze', 'brz_queue_entry') }} where match(payload, '"journeyId"') having count() > 0
union all
select 'brz_purchase_session', count() from {{ source('bronze', 'brz_purchase_session') }} where match(payload, '"journeyId"') having count() > 0
union all
select 'brz_seat_event', count() from {{ source('bronze', 'brz_seat_event') }} where match(payload, '"(holdKind|priorityGrantId)"') having count() > 0
