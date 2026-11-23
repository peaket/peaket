{{ config(order_by='(event_id, run_id, metric, dim)', partition_by='toYYYYMM(open_date)', ttl='open_date + INTERVAL 2 YEAR') }}
-- 지표 값(analytics §6.3, F-04-5): 이번 판(run_id)의 골드 사실 표로 회차 × 지표 × 칸(결제사·결과·경로 등)의 값을 낸다.
-- 지표 정의는 metrics.yml(이 모델의 meta.metrics)이고, 원천이 없는 지표(source: none)는 값 NULL·source_ok 0 줄로 낸다.
-- 지표 뷰 mtr_event_metric은 이 표의 현재 판만 읽고, 규칙 판정 fct_rule_check는 이번 판을 읽는다
{%- set metrics = config.get('meta', {}).get('metrics', []) %}
with ev as (
    select event_id, open_at, starts_at, seat_count, open_date from {{ ref('dim_event') }} where {{ this_run() }}
),
f1 as (
    select event_id, sum(entries) as e, sum(admissions) as a, sum(turns) as t, sum(no_confirms) as nc, sum(bot_blocked) as bb, sum(challenged) as ch
    from {{ ref('fct_onsale_minute') }} where {{ this_run() }} group by event_id
),
f2 as (
    select event_id, sumIf(sold_seats, open_minute <= 60) as sold60, sum(sales_amount) as amt, sum(held_seats) as held, sum(expired_seats) as expired
    from {{ ref('fct_sales_minute') }} where {{ this_run() }} group by event_id
),
f3 as (
    select event_id, sum(admitted) as adm, sum(first_hold) as fh, sum(payment_accepted) as pa, sum(approved) as ap, sum(issued) as iss
    from {{ ref('fct_funnel_cohort') }} where {{ this_run() }} group by event_id
),
f4 as (
    select event_id, assignment, sum(attempts) as att, sumIf(attempts, result = 'CONFLICT') as conflict,
           sum(first_attempts) as first_att, sumIf(first_attempts, result = 'CONFLICT') as first_conflict
    from {{ ref('fct_hold_attempt') }} where {{ this_run() }} group by event_id, assignment
),
f5 as (
    select event_id, pg, result, failure_category, sum(attempts) as att,
           sum(latency_le_500) as le500, sum(latency_le_1000) as le1000, sum(latency_le_2000) as le2000, sum(latency_le_5000) as le5000
    from {{ ref('fct_payment_attempt') }} where {{ this_run() }} group by event_id, pg, result, failure_category
),
f7 as (
    select event_id, sum(people) as n,
           sumIf(people, ratio_bucket = '<0.5') as b1, sumIf(people, ratio_bucket = '0.5-1') as b2,
           sumIf(people, ratio_bucket = '1-1.5') as b3, sumIf(people, ratio_bucket = '1.5-2') as b4
    from {{ ref('fct_wait_accuracy') }} where {{ this_run() }} group by event_id
),
f10 as (
    select event_id, sum(entries) as entered from {{ ref('fct_entry_10min') }} where {{ this_run() }} group by event_id
),
f11 as (
    select event_id, sold_out_at, sold_out_releases, sold_seats, sales_amount, tickets_issued, slo_good, slo_total, invariant_violations
    from {{ ref('fct_event_summary') }} where {{ this_run() }}
),
f15 as (
    select s.event_id as event_id,
           sum(s.sales_amount) - sum(s.reversed_amount) as amt,
           sumIf(toInt64(s.sold_seats) - toInt64(s.reversed_seats) - toInt64(s.returned_seats), s.day < toDate(ev.starts_at)) as sold_eve
    from {{ ref('fct_sales_daily') }} as s left join ev on ev.event_id = s.event_id
    where {{ this_run('s') }} group by event_id
),
f8 as (
    select event_id, route, sum(refunds) as n, sum(refund_amount) as amt from {{ ref('fct_refund_daily') }} where {{ this_run() }} group by event_id, route
),
tiers as ({{ tier_sold_out(this_run()) }}),
tier_cum as (
    select event_id, tier_id, open_minute, sum(sold) over (partition by event_id, tier_id order by open_minute rows between unbounded preceding and current row) as cum
    from (select event_id, tier_id, open_minute, sum(sold_seats) as sold from {{ ref('fct_sales_minute') }} where {{ this_run() }} group by event_id, tier_id, open_minute)
),
gap as (
    -- 등급별 매진 시각 차이(규칙 '등급별 매진 시각 차이'): 최상위 등급이 매진된 분에 아래 등급들의 미판매 비율 가운데 가장 큰 값.
    -- 짝이 없는 줄(판매가 없는 등급)은 cum = 0이다(ClickHouse 왼쪽 결합 기본값)
    select event_id, max(1 - least(sold_at_top, cap) / cap) as unsold from (
        select lo.event_id as event_id, lo.tier_id as tier_id, any(lo.cap) as cap, maxIf(c.cum, c.open_minute <= lo.m) as sold_at_top
        from (
            select l.event_id as event_id, l.tier_id as tier_id, l.seat_count as cap, assumeNotNull(t.sold_out_minute) as m
            from tiers as l
            inner join (select event_id, sold_out_minute from tiers where tier_rank = 1 and sold_out_minute is not null) as t on t.event_id = l.event_id
            where l.tier_rank > 1 and l.seat_count > 0
        ) as lo
        left join tier_cum as c on c.event_id = lo.event_id and c.tier_id = lo.tier_id
        group by event_id, tier_id
    ) group by event_id
),
metric_rows as (
    -- 1·2 진입·입장 인원(F1). 1번의 '가명 중복 빼기'는 대기 기록(QueueEntryRecord)이 들어온 뒤 F1 진입 칸으로 센다
    select event_id, {{ mrow('entries', 'e', sample='e') }} from f1
    union all select event_id, {{ mrow('admissions', 'a', sample='a') }} from f1
    -- 3 입장 → 구매 전환율, 4 단계별 전환(F3)
    union all select event_id, {{ mrow('admission_to_purchase_rate', ratio('ap', 'adm'), 'ap', 'adm', 'adm') }} from f3
    union all select event_id, {{ mrow('stage_conversion', ratio('fh', 'adm'), 'fh', 'adm', 'adm', "'first_hold'") }} from f3
    union all select event_id, {{ mrow('stage_conversion', ratio('pa', 'fh'), 'pa', 'fh', 'fh', "'payment_accepted'") }} from f3
    union all select event_id, {{ mrow('stage_conversion', ratio('ap', 'pa'), 'ap', 'pa', 'pa', "'approved'") }} from f3
    union all select event_id, {{ mrow('stage_conversion', ratio('iss', 'ap'), 'iss', 'ap', 'ap', "'issued'") }} from f3
    -- 퍼널 단계 누적(기본 누적, 실시간 표와 같은 이름)
    union all select event_id, {{ mrow('funnel', 'adm', sample='adm', dim="'admitted'") }} from f3
    union all select event_id, {{ mrow('funnel', 'fh', sample='fh', dim="'first_hold'") }} from f3
    union all select event_id, {{ mrow('funnel', 'pa', sample='pa', dim="'payment_accepted'") }} from f3
    union all select event_id, {{ mrow('funnel', 'ap', sample='ap', dim="'approved'") }} from f3
    union all select event_id, {{ mrow('funnel', 'iss', sample='iss', dim="'issued'") }} from f3
    -- 5 매진 소요 시간(분)과 매진 풀림 횟수(F11·dim_event)
    union all select f11.event_id, {{ mrow('sold_out_minutes', "if(f11.sold_out_at is null or toYear(ev.open_at) < 2000, NULL, dateDiff('second', ev.open_at, assumeNotNull(f11.sold_out_at)) / 60)", sample='1') }}
        from f11 left join ev on ev.event_id = f11.event_id
    union all select event_id, {{ mrow('sold_out_releases', 'sold_out_releases', sample='1') }} from f11
    -- 6 등급별 매진 시각 차이(규칙 값). 등급마다의 시각은 mtr_tier_sold_out
    union all select event_id, {{ mrow('tier_sold_out_gap', 'unsold', sample='1') }} from gap
    -- 7 비매진 회차 판매율: 오픈 60분 뒤(F2), 공연 전날(F15 판매 − 되돌림 − 반환)
    union all select f2.event_id, {{ mrow('sale_rate_60m', ratio('f2.sold60', 'ev.seat_count'), 'f2.sold60', 'ev.seat_count', 'ev.seat_count') }} from f2 left join ev on ev.event_id = f2.event_id
    union all select f15.event_id, {{ mrow('sale_rate_eve', ratio('greatest(f15.sold_eve, 0)', 'ev.seat_count'), 'greatest(f15.sold_eve, 0)', 'ev.seat_count', 'ev.seat_count') }} from f15 left join ev on ev.event_id = f15.event_id
    -- 8 홀드 경합 패배율(전체·세션 첫 시도·직접 선택만)(F4)
    union all select event_id, {{ mrow('hold_conflict_rate', ratio('sum(conflict)', 'sum(att)'), 'sum(conflict)', 'sum(att)', 'sum(att)') }} from f4 group by event_id
    union all select event_id, {{ mrow('hold_conflict_rate', ratio('sum(first_conflict)', 'sum(first_att)'), 'sum(first_conflict)', 'sum(first_att)', 'sum(first_att)', "'first'") }} from f4 group by event_id
    union all select event_id, {{ mrow('hold_conflict_rate', ratio('conflict', 'att'), 'conflict', 'att', 'att', "'PICK'") }} from f4 where assignment = 'PICK'
    -- 10 홀드 만료율(F2 좌석 단위: 만료 좌석 ÷ 홀드 성공 좌석)
    union all select event_id, {{ mrow('hold_expiry_rate', ratio('expired', 'held'), 'expired', 'held', 'held') }} from f2
    -- 11 결제 실패 사유 분포, 12 결제사별 승인율·응답 p99(F5)
    union all select f.event_id, {{ mrow('payment_failure_share', ratio('f.n', 't.n'), 'f.n', 't.n', 't.n', 'f.failure_category') }}
        from (select event_id, failure_category, sum(att) as n from f5 where result = 'FAILED' group by event_id, failure_category) as f
        inner join (select event_id, sum(att) as n from f5 where result = 'FAILED' group by event_id) as t on t.event_id = f.event_id
    union all select event_id, {{ mrow('payment_failures', "sumIf(att, result = 'FAILED')", sample="sumIf(att, result = 'FAILED')") }} from f5 group by event_id
    union all select event_id, {{ mrow('orders', "sumIf(att, result = 'APPROVED')", sample="sumIf(att, result = 'APPROVED')") }} from f5 group by event_id
    union all select event_id, {{ mrow('pg_approval_rate', ratio("sumIf(att, result = 'APPROVED')", "sumIf(att, result in ('APPROVED', 'FAILED', 'UNKNOWN'))"), "sumIf(att, result = 'APPROVED')", "sumIf(att, result in ('APPROVED', 'FAILED', 'UNKNOWN'))", "sumIf(att, result in ('APPROVED', 'FAILED', 'UNKNOWN'))", 'pg') }}
        from f5 where pg != '' group by event_id, pg
    -- 응답 p99는 버킷 위 끝(ms). 5초 버킷을 넘으면 NULL(버킷 밖)
    union all select event_id, {{ mrow('pg_latency_p99_ms', "multiIf(sum(att) = 0, NULL, sum(le500) >= 0.99 * sum(att), 500, sum(le1000) >= 0.99 * sum(att), 1000, sum(le2000) >= 0.99 * sum(att), 2000, sum(le5000) >= 0.99 * sum(att), 5000, NULL)", sample='sum(att)', dim='pg') }}
        from f5 where pg != '' group by event_id, pg
    -- 14 봇 트래픽 비율: 차단 + 추가 검증 ÷ 진입 시도(진입 + 차단)(F1)
    union all select event_id, {{ mrow('bot_traffic_rate', ratio('bb + ch', 'e + bb'), 'bb + ch', 'e + bb', 'e + bb') }} from f1
    -- 18 예상 대기 오차 p90(F7): p90이 든 구간의 위 끝, 마지막 구간(2배 이상)은 아래 끝 2
    union all select event_id, {{ mrow('wait_error_p90', 'multiIf(n = 0, NULL, b1 >= 0.9 * n, 0.5, b1 + b2 >= 0.9 * n, 1.0, b1 + b2 + b3 >= 0.9 * n, 1.5, b1 + b2 + b3 + b4 >= 0.9 * n, 2.0, 2.0)', sample='n') }} from f7
    -- 19 차례 뒤 미입장 비율(F1), 대기열 누적
    union all select event_id, {{ mrow('turn_no_confirm_rate', ratio('nc', 't'), 'nc', 't', 't') }} from f1
    union all select event_id, {{ mrow('queue', 'e', sample='e', dim="'entries'") }} from f1
    union all select event_id, {{ mrow('queue', 'a', sample='a', dim="'admissions'") }} from f1
    -- 22 여정 SLO, 23 불변식 위반(F11, 원천 파일이 들어오기 전에는 NULL)
    union all select event_id, {{ mrow('slo_good_rate', ratio('slo_good', 'slo_total'), 'slo_good', 'slo_total', 'ifNull(slo_total, 0)', ok='slo_total is not null') }} from f11
    union all select event_id, {{ mrow('invariant_violations', 'invariant_violations', sample='1', ok='invariant_violations is not null') }} from f11
    -- 26 판매 금액: R3는 F15(판매 − 되돌림), 그 전은 F11(승인 − 입금 되돌림, F2 판매 곡선과 같은 시점)
    {%- if stage_var() == 'R3' %}
    union all select event_id, {{ mrow('sales_amount', 'amt', sample='1') }} from f15
    {%- else %}
    union all select event_id, {{ mrow('sales_amount', 'sales_amount', sample='1') }} from f11
    {%- endif %}
    -- 기본 누적: 판매 좌석·발권 티켓(F11)
    union all select event_id, {{ mrow('sold_seats', 'sold_seats', sample='1') }} from f11
    union all select event_id, {{ mrow('tickets_issued', 'tickets_issued', sample='1') }} from f11
    -- 27 환불·취소: 경로별 금액(값)과 건수(표본)(F8)
    union all select event_id, {{ mrow('refunds', 'amt', 'n', sample='n', dim='route') }} from f8
    -- 30 현장 입장률(F10 ÷ F11 발권)
    union all select f11.event_id, {{ mrow('onsite_entry_rate', ratio('ifNull(f10.entered, 0)', 'f11.tickets_issued'), 'ifNull(f10.entered, 0)', 'f11.tickets_issued', 'greatest(f11.tickets_issued, 0)') }}
        from f11 left join f10 on f10.event_id = f11.event_id
    -- 원천이 없는 지표(metrics.yml source: none): 값 NULL
    {%- for m in metrics if m.get('source') == 'none' %}
    union all select event_id, {{ mrow(m['name'], 'NULL', ok='0') }} from ev
    {%- endfor %}
)
select r.event_id as event_id, r.metric as metric, r.dim as dim, r.value as value, r.numerator as numerator, r.denominator as denominator,
       r.sample as sample, r.source_ok as source_ok,
       if(ev.event_id = '', today(), ev.open_date) as open_date,
       {{ gold_cols() }}
from metric_rows as r left join ev on ev.event_id = r.event_id
