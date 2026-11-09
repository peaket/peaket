// 판매 상태 셈 읽기 Lua 계약(docs/features/seat-hold.md §4 '판정의 첫 구현', ADR-0122 결정 3, BUILD_ORDER PRF-144).
// 첫 줄이 `#!lua flags=no-writes`다: 이 Lua 자체는 쓰기가 없어 메모리 부족에 거절되지 않는다(스냅샷 읽기 Lua와 같다). 다만 판정 틱은 앞 단계 임대 Lua가 쓰기(no-writes가 아니다)라
// 좌석 Redis가 메모리 부족이면 그 틱은 임대에서 실패해 여기까지 오지 않는다(지표 tick_failures_total{stage="lease"}, 리뷰 고침 L10).
// KEYS: 1 비트맵 s:{event:E}:bitmap, 2 만료 인덱스 s:{event:E}:expiry, 3 세대 키 s:{event:E}:epoch, 4 멈춘 홀드 s:{event:E}:paused (같은 슬롯, 홀드 수는 2와 4의 합, BUILD_ORDER HOT-070)
// ARGV: 없음
// 돌려주는 값: ['NOT_READY'] 또는 ['OK', 비트맵 바이트(키가 없으면 빈 글), 만료 인덱스의 ZCARD]
// 세대 키의 epoch 칸이 없으면 NOT_READY(다시 만들기 중의 빈 비트맵으로 거짓 풀림이 나지 않게 아무것도 읽지 않는다). 응답은 CallOptions.binary로 받는다.
// 키의 형이 틀리면 WRONGTYPE이 그대로 나간다.

// HOLD_PAGE_LUA: 만료 인덱스 뒤에 멈춘 홀드를 이은 순위 쪽을 한 번에 읽는다(두 집합을 따로 읽으면 옮기기 사이에 좌석이 빠지거나 겹친다, BUILD_ORDER HOT-070).
// KEYS: 1 expiry, 2 paused. ARGV: 1 시작 순위, 2 수. 돌려주는 값: 멤버 글 목록
export const HOLD_PAGE_LUA = `#!lua flags=no-writes
local start, count = tonumber(ARGV[1]), tonumber(ARGV[2])
local n = redis.call('ZCARD', KEYS[1])
local out = {}
if start < n then out = redis.call('ZRANGE', KEYS[1], start, start + count - 1) end
if #out < count then
  local from = math.max(0, start - n)
  for _, m in ipairs(redis.call('ZRANGE', KEYS[2], from, from + count - #out - 1)) do out[#out + 1] = m end
end
return out
`;

/** 판매 상태 셈 읽기 Lua 원문(위 계약). 첫 줄이 `#!lua flags=no-writes`다 */
export const SALE_COUNT_LUA = `#!lua flags=no-writes
if redis.call('HEXISTS', KEYS[3], 'epoch') == 0 then return {'NOT_READY'} end
return {'OK', redis.call('GET', KEYS[1]) or '', redis.call('ZCARD', KEYS[2]) + redis.call('ZCARD', KEYS[4])}
`;
