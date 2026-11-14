// 예매 제한 사본 쓰기(queue.proto BookingRestrictionService, q:rst:{account}, GAT-310).
// 판 번호가 저장한 판보다 클 때만 st·until·rid·ver를 한 번에 바꾼다. 옛 판은 changed false다.
export const SET_BOOKING_RESTRICTION_LUA = `
local current = redis.call('HGET', KEYS[1], 'ver')
if current and tonumber(current) >= tonumber(ARGV[4]) then return 0 end
redis.call('HSET', KEYS[1], 'st', ARGV[1], 'rid', ARGV[2], 'ver', ARGV[4])
if ARGV[3] == '' then
  redis.call('HDEL', KEYS[1], 'until')
else
  redis.call('HSET', KEYS[1], 'until', ARGV[3])
end
return 1
`;
