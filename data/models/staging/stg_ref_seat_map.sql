-- 회차 좌석 배치(analytics §3.2 brz_ref_seat_map). 회차마다 마지막 layout_version 판만
select m.*
from {{ source('bronze', 'brz_ref_seat_map') }} as m
inner join (
    select event_id, max(layout_version) as v from {{ source('bronze', 'brz_ref_seat_map') }} where {{ event_filter() }} group by event_id
) as last on m.event_id = last.event_id and m.layout_version = last.v
where {{ event_filter('m.event_id') }}
