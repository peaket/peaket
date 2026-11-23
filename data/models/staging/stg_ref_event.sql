-- 회차 기준 자료(analytics §3.2 brz_ref_event, 싣기는 마감 실행기 F-04-6). 회차마다 마지막으로 실은 행
select * except (rn) from (
    select *, row_number() over (partition by event_id order by loaded_at desc) as rn
    from {{ source('bronze', 'brz_ref_event') }}
    where {{ event_filter() }}
) where rn = 1
