// 판매 상태 셈 읽기 Lua 계약(docs/features/seat-hold.md §4 '판정의 첫 구현', ADR-0122 결정 3, BUILD_ORDER PRF-144).
// 첫 줄이 `#!lua flags=no-writes`다: 이 Lua 자체는 쓰기가 없어 메모리 부족에 거절되지 않는다(스냅샷 읽기 Lua와 같다). 다만 판정 틱은 앞 단계 임대 Lua가 쓰기(no-writes가 아니다)라
// 좌석 Redis가 메모리 부족이면 그 틱은 임대에서 실패해 여기까지 오지 않는다(지표 tick_failures_total{stage="lease"}, 리뷰 고침 L10).
// KEYS: 1 비트맵 s:{event:E}:bitmap, 2 만료 인덱스 s:{event:E}:expiry, 3 세대 키 s:{event:E}:epoch (같은 슬롯)
// ARGV: 없음
// 돌려주는 값: ['NOT_READY'] 또는 ['OK', 비트맵 바이트(키가 없으면 빈 글), 만료 인덱스의 ZCARD]
// 세대 키의 epoch 칸이 없으면 NOT_READY(다시 만들기 중의 빈 비트맵으로 거짓 풀림이 나지 않게 아무것도 읽지 않는다). 응답은 CallOptions.binary로 받는다.
// 키의 형이 틀리면 WRONGTYPE이 그대로 나간다.

/** 판매 상태 셈 읽기 Lua 원문(위 계약). 첫 줄이 `#!lua flags=no-writes`다 */
export const SALE_COUNT_LUA = `#!lua flags=no-writes
if redis.call('HEXISTS', KEYS[3], 'epoch') == 0 then return {'NOT_READY'} end
return {'OK', redis.call('GET', KEYS[1]) or '', redis.call('ZCARD', KEYS[2])}
`;
