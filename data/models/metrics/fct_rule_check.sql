{{ config(order_by='(event_id, run_id, rule_id)', partition_by='toYYYYMM(open_date)', ttl='open_date + INTERVAL 2 YEAR') }}
-- F12 규칙 판정(analytics §5.2·§6.4, F-04-5): 이번 판의 회차 × 규칙(rules.yml = 이 모델의 meta.rules) × 마감 단계.
-- 판정 차례: 미확정(NOT_FINAL) → 데이터 품질 실패(QUALITY_FAILED: 원천 없음, quality_check FAIL의 affects, 값 없음) → 표본 부족(SAMPLE_SHORT: 적용 조건 미달)
-- → 기준선 없음(NO_BASELINE) → 걸림(HIT)·경계(BORDER)·안 걸림(CLEAR). 비율 규칙(wilson_95)은 95% Wilson 구간 전체가 기준 밖이면 걸림, 기준을 품으면 경계다.
-- 규칙은 표(rules)로 만들어 회차와 한 번 결합하고, 적용 조건만 규칙별 식(multiIf)으로 고른다
-- 연결된 결정 기록 ID는 결정 기록(F-04-7 리포트 뒤)이 생기기 전이라 비운다
{%- set rules = config.get('meta', {}).get('rules', []) %}
{%- set stages = ['R0', 'R1', 'R2', 'R3'] %}
{%- set si = stages.index(stage_var()) %}
with mv as (
    select event_id, metric, dim, value, numerator, denominator, sample, source_ok from {{ ref('metric_value') }} where {{ this_run() }}
),
tier_out as ({{ tier_sold_out(this_run()) }}),
qa as (
    select event_id, groupUniqArrayArray(affects) as failed from {{ ref('quality_check') }} where {{ this_run() }} and status = 'FAIL' group by event_id
),
band as ({{ baseline_band("select m.event_id as event_id, m.metric as metric, m.dim as dim, e.size_grade as size_grade, e.open_date as open_date from " ~ ref('metric_value') ~ " as m inner join (select event_id, size_grade, open_date from " ~ ref('dim_event') ~ " where " ~ this_run() ~ ") as e on e.event_id = m.event_id where " ~ this_run('m')) }}),
ctx as (
    -- 규칙 적용 조건(rules.yml applies_when)이 읽는 회차 맥락. 원천이 없는 칸(이의 제기·수수료 구조·비교 하이브리드 회차)은 0
    select m.event_id as event_id,
           toUInt8(isNotNull(maxIf(m.value, m.metric = 'sold_out_minutes'))) as sold_out,
           ifNull(maxIf(m.denominator, m.metric = 'admission_to_purchase_rate'), 0) as admitted,
           ifNull(maxIf(m.value, m.metric = 'orders'), 0) as orders,
           ifNull(maxIf(m.denominator, m.metric = 'hold_conflict_rate' and m.dim = 'PICK'), 0) as pick_attempts,
           ifNull(maxIf(m.value, m.metric = 'payment_failures'), 0) as pay_failures,
           ifNull(maxIf(m.value, m.metric = 'entries'), 0) as entries,
           ifNull(maxIf(m.denominator, m.metric = 'turn_no_confirm_rate'), 0) as turns,
           ifNull(maxIf(m.denominator, m.metric = 'hold_expiry_rate'), 0) as held,
           0 as appeals, 0 as fee_defined, 0 as hybrid_peers
    from mv as m group by event_id
),
ctx2 as (
    select c.*, ifNull(t.tiers, 0) as tiers, ifNull(t.top_sold_out, 0) as top_sold_out, q.failed as quality_failed
    from ctx as c
    left join (select event_id, toUInt64(count()) as tiers, toUInt8(countIf(tier_rank = 1 and sold_out_minute is not null) > 0) as top_sold_out from tier_out group by event_id) as t on t.event_id = c.event_id
    left join qa as q on q.event_id = c.event_id
),
rules as (
    -- rules.yml을 표 하나로(규칙마다 줄). close_idx·prov_idx는 R0~R3의 차례(잠정 단계가 없으면 -1)
    select * from values('rule_id String, metric String, dim String, judge String, op String, threshold Float64, close_idx Int8, prov_idx Int8',
    {%- for r in rules %}
        ('{{ r["id"] }}', '{{ r["metric"] }}', '{{ r.get("dim", "") }}', '{{ r["judge"] }}', '{{ r["op"] }}', {{ r["threshold"] | float }}, {{ stages.index(r["close_stage"]) }}, {{ stages.index(r["provisional_stage"]) if r.get("provisional_stage") else -1 }}){{ ',' if not loop.last }}
    {%- endfor %}
    )
),
base as (
    -- 회차 × 규칙 한 번의 결합(규칙마다 따로 묶지 않는다: 같은 부분 질의를 규칙 수만큼 다시 계산하면 메모리를 크게 쓴다)
    select c.event_id as event_id, r.rule_id as rule_id, r.metric as metric, r.dim as dim, r.judge as judge, r.op as op, r.threshold as threshold,
           toUInt8({{ si }} < r.close_idx and (r.prov_idx < 0 or {{ si }} < r.prov_idx)) as not_final,
           toUInt8({{ si }} < r.close_idx and r.prov_idx >= 0 and {{ si }} >= r.prov_idx) as provisional,
           multiIf(
           {%- for r in rules %}
               r.rule_id = '{{ r["id"] }}', toUInt8({{ r['applies_when'] }}),
           {%- endfor %}
               toUInt8(0)) as applies,
           has(c.quality_failed, r.metric) as quality_hit,
           m.value as value, m.numerator as numerator, m.denominator as denominator, m.sample as sample, m.source_ok as source_ok,
           ifNull(b.baseline_n, 0) as baseline_n, if(b.baseline_shape = '', 'NONE', b.baseline_shape) as baseline_shape, b.baseline_strength as baseline_strength,
           b.baseline_min as baseline_min, b.baseline_max as baseline_max, b.baseline_median as baseline_median, b.baseline_q1 as baseline_q1, b.baseline_q3 as baseline_q3
    from ctx2 as c
    cross join rules as r
    left join mv as m on m.event_id = c.event_id and m.metric = r.metric and m.dim = r.dim
    left join band as b on b.event_id = c.event_id and b.metric = r.metric and b.dim = r.dim
),
judged as (
    select *,
           if(judge = 'wilson_95', CAST({{ wilson('ifNull(numerator, 0)', 'ifNull(denominator, 0)', 'low') }} AS Nullable(Float64)), NULL) as ci_low,
           if(judge = 'wilson_95', CAST({{ wilson('ifNull(numerator, 0)', 'ifNull(denominator, 0)', 'high') }} AS Nullable(Float64)), NULL) as ci_high,
           multiIf(not_final = 1, 'NOT_FINAL',
                   source_ok = 0 or value is null or quality_hit, 'QUALITY_FAILED',
                   applies = 0, 'SAMPLE_SHORT',
                   judge = 'baseline_median' and baseline_n < 3, 'NO_BASELINE',
                   judge = 'baseline_q3' and baseline_n < 10, 'NO_BASELINE',
                   judge = 'peer', 'NO_BASELINE',
                   '') as hold_reason
    from base
)
select j.event_id as event_id, rule_id, '{{ stage_var() }}' as close_stage, metric, dim, value, numerator, denominator, sample, ci_low, ci_high,
       concat(op, ' ', toString(threshold), multiIf(judge = 'baseline_median', ' × 같은 규모 중앙값', judge = 'baseline_q3', ' (같은 규모 3사분위)', '')) as threshold_text,
       if(hold_reason != '', 'HOLD', multiIf(
           judge = 'wilson_95' and op = '<', multiIf(ci_high < threshold, 'HIT', ci_low >= threshold, 'CLEAR', 'BORDER'),
           judge = 'wilson_95' and op = '<=', multiIf(ci_high <= threshold, 'HIT', ci_low > threshold, 'CLEAR', 'BORDER'),
           judge = 'wilson_95' and op = '>', multiIf(ci_low > threshold, 'HIT', ci_high <= threshold, 'CLEAR', 'BORDER'),
           judge = 'wilson_95' and op = '>=', multiIf(ci_low >= threshold, 'HIT', ci_high < threshold, 'CLEAR', 'BORDER'),
           judge = 'baseline_median', if(value > threshold * baseline_median, 'HIT', 'CLEAR'),
           judge = 'baseline_q3', if(value > baseline_q3, 'HIT', 'CLEAR'),
           op = '<', if(value < threshold, 'HIT', 'CLEAR'),
           op = '<=', if(value <= threshold, 'HIT', 'CLEAR'),
           op = '>', if(value > threshold, 'HIT', 'CLEAR'),
           op = '>=', if(value >= threshold, 'HIT', 'CLEAR'),
           'CLEAR')) as verdict,
       hold_reason, provisional,
       baseline_n, baseline_shape, baseline_strength, baseline_min, baseline_max, baseline_median, baseline_q1, baseline_q3,
       CAST(NULL AS Nullable(String)) as decision_record_id,
       if(e.ev_id = '', today(), e.ev_open_date) as open_date,
       {{ gold_cols() }}
from judged as j
left join (select event_id as ev_id, open_date as ev_open_date from {{ ref('dim_event') }} where {{ this_run() }}) as e on e.ev_id = j.event_id
