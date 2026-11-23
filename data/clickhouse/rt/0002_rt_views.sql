-- 관제 실시간 표의 매개변수 뷰 셋(docs/streaming.md §4.3, OPS-160, F-04-1). ops-svc의 an_rt_reader가 회차마다 0.5초에 한 번 읽는다.
-- 모든 뷰는 eventKey마다 한 줄만 남겨(다시 보낸 사건·다시 읽은 행을 지움) 센다. 판매 좌석은 좌석마다 가장 이른 Kafka 위치로 줄 세운
-- 마지막 판매 상태가 SOLD인 좌석 수다(회차 하나의 좌석 사건은 한 파티션이라 오프셋 차례가 사건 차례다).
-- 지표 이름은 §4.1 표의 코드다. 정본에 없는 줄(추천 적용 2026-11-23, F-04-1 계획): 등급·구역별 줄은 sold_seats_tier·sold_seats_section·
-- funnel_first_hold_tier로 이름을 나누고, 거래 사건 끊김 표시(C-T37)를 위해 last_trade_loaded_ms(그 회차 거래 원시 행의 마지막 적재 시각,
-- 유닉스 밀리초)를 함께 낸다.

CREATE OR REPLACE VIEW rt.v_cumulative ON CLUSTER '{cluster}' AS
WITH
sale AS (
    SELECT event_key,
           any(source) AS source, any(type) AS type, any(seat_id) AS seat_id,
           any(tier_id) AS tier_id, any(section_id) AS section_id, any(amount) AS amount,
           any(first_in_stage) AS first_in_stage,
           min(kafka_offset) AS first_offset
    FROM rt.sale_event
    WHERE event_id = {event_id:String}
    GROUP BY event_key
),
seat AS (
    SELECT seat_id, any(tier_id) AS tier_id, any(section_id) AS section_id,
           argMax(type, first_offset) AS last_type
    FROM sale
    WHERE source = 'SEAT'
    GROUP BY seat_id
),
queue AS (
    SELECT event_key, any(entries) AS entries, any(admissions) AS admissions, any(removed) AS removed
    FROM rt.queue_aggregate
    WHERE event_id = {event_id:String}
    GROUP BY event_key
)
SELECT 'sold_seats' AS metric, '' AS dim, toInt64(countIf(last_type = 'SOLD')) AS value FROM seat
UNION ALL
SELECT 'sold_seats_tier', tier_id, toInt64(countIf(last_type = 'SOLD')) FROM seat GROUP BY tier_id
UNION ALL
SELECT 'sold_seats_section', section_id, toInt64(countIf(last_type = 'SOLD')) FROM seat GROUP BY section_id
UNION ALL
SELECT 'sales_amount', '', toInt64(sumIf(amount, type = 'APPROVED') - sumIf(amount, type = 'DEPOSIT_REVERSED')) FROM sale WHERE source = 'PAYMENT'
UNION ALL
SELECT 'orders_confirmed', '', toInt64(countIf(type = 'CONFIRMED')) - toInt64(countIf(type = 'DEPOSIT_REVERSED')) FROM sale WHERE source = 'ORDER'
UNION ALL
SELECT 'tickets_issued', '', toInt64(countIf(type = 'ISSUED')) - toInt64(countIf(type = 'VOIDED')) FROM sale WHERE source = 'TICKET'
UNION ALL
SELECT 'funnel_payment_accepted', '', toInt64(uniqExactIf(event_key, type = 'ACCEPTED' AND first_in_stage)) FROM sale WHERE source = 'ORDER'
UNION ALL
SELECT 'funnel_approved', '', toInt64(uniqExactIf(event_key, type = 'APPROVED' AND first_in_stage)) FROM sale WHERE source = 'ORDER'
UNION ALL
SELECT 'funnel_issued', '', toInt64(uniqExactIf(event_key, type = 'CONFIRMED' AND first_in_stage)) FROM sale WHERE source = 'ORDER'
UNION ALL
SELECT 'funnel_first_hold', '', toInt64(uniqExactIf(event_key, result = 'HELD' AND first_held_in_session))
FROM rt.hold_attempt WHERE event_id = {event_id:String}
UNION ALL
SELECT 'funnel_first_hold_tier', tier_id, toInt64(uniqExactIf(event_key, result = 'HELD' AND first_held_in_session))
FROM rt.hold_attempt WHERE event_id = {event_id:String} GROUP BY tier_id
UNION ALL
SELECT 'queue_entries', '', toInt64(sum(entries)) FROM queue
UNION ALL
SELECT 'queue_admissions', '', toInt64(sum(admissions)) FROM queue
UNION ALL
SELECT 'queue_removed', '', toInt64(sum(removed)) FROM queue
UNION ALL
SELECT 'funnel_admitted', '', toInt64(sum(admissions)) FROM queue
UNION ALL
SELECT 'last_trade_loaded_ms', '', toInt64(if(count() = 0, 0, toUnixTimestamp64Milli(max(loaded_at))))
FROM rt.sale_event WHERE event_id = {event_id:String};

-- 1초 칸(§4.1 '1초 칸' 줄). from_ts 뒤(포함)의 칸을 칸마다 eventKey 서로 다른 개수로 센다. 칸은 사건 시각으로 나눈다.
-- 대기열 칸은 1초 집계 메시지의 second 열이 칸이고, eventKey로 중복을 지운 합이다.
CREATE OR REPLACE VIEW rt.v_bucket ON CLUSTER '{cluster}' AS
WITH
queue AS (
    -- 별칭을 열 이름 second와 다르게 둔다: 같으면 WHERE의 second가 집계 별칭으로 읽혀 ILLEGAL_AGGREGATION이 난다
    SELECT event_key, any(second) AS bucket_second, any(entries) AS entries, any(admissions) AS admissions, any(removed) AS removed
    FROM rt.queue_aggregate
    WHERE event_id = {event_id:String} AND second >= toDateTime({from_ts:DateTime64(3)})
    GROUP BY event_key
)
SELECT 'queue_entries' AS metric, '' AS dim, bucket_second AS second, toInt64(sum(entries)) AS value FROM queue GROUP BY bucket_second
UNION ALL
SELECT 'queue_admissions', '', bucket_second, toInt64(sum(admissions)) FROM queue GROUP BY bucket_second
UNION ALL
SELECT 'queue_removed', '', bucket_second, toInt64(sum(removed)) FROM queue GROUP BY bucket_second
UNION ALL
SELECT 'hold_result', result, toDateTime(toStartOfSecond(occurred_at)) AS second, toInt64(uniqExact(event_key))
FROM rt.hold_attempt
WHERE event_id = {event_id:String} AND occurred_at >= {from_ts:DateTime64(3)}
GROUP BY result, second
UNION ALL
SELECT 'verdict', category, toDateTime(toStartOfSecond(occurred_at)) AS second, toInt64(uniqExact(event_key))
FROM rt.verdict
WHERE event_id = {event_id:String} AND occurred_at >= {from_ts:DateTime64(3)}
GROUP BY category, second;

-- 신선도(§4.5): 텔레메트리 셋의 파티션마다 마지막 심장 박동 발행 시각. 최근 1시간 [가정]만 본다(정렬 키 앞 두 열과 시각으로 고른다).
-- 기대 파티션 목록은 ops-svc 설정이 갖는다. 목록에 있는데 여기 없는 파티션은 신선도가 무한이다(ST-T2 '끔').
CREATE OR REPLACE VIEW rt.v_freshness ON CLUSTER '{cluster}' AS
SELECT topic,
       kafka_partition,
       max(produced_at) AS last_produced_at,
       toInt64(countIf(produced_at >= now64(3) - INTERVAL 2 SECOND)) AS pulses_2s
FROM rt.pulse
WHERE topic IN ('telemetry.queue', 'telemetry.purchase', 'telemetry.trust-verdicts')
  AND produced_at >= now64(3) - INTERVAL 1 HOUR
GROUP BY topic, kafka_partition;
