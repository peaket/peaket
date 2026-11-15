// 예매 제한 사본 쓰기(queue.proto BookingRestrictionService, q:rst:{account}, GAT-310).
// 판 번호가 저장한 판보다 클 때만 st·until·rid·ver를 한 번에 바꾼다. 옛 판은 changed false다.
// 수명(docs/data.md `q:rst`): ACTIVE면 until + 1일(끝이 없으면 30일), LIFTED면 30일. until + 1일이 이미 지났으면 PEXPIREAT가 키를 지운다.
// ARGV: 1 상태, 2 제한 ID, 3 until(없으면 빈 글), 4 판 번호, 5 지금(ms)
export const SET_BOOKING_RESTRICTION_LUA = `
local current = redis.call('HGET', KEYS[1], 'ver')
if current and tonumber(current) >= tonumber(ARGV[4]) then return 0 end
redis.call('HSET', KEYS[1], 'st', ARGV[1], 'rid', ARGV[2], 'ver', ARGV[4])
if ARGV[3] == '' then
  redis.call('HDEL', KEYS[1], 'until')
else
  redis.call('HSET', KEYS[1], 'until', ARGV[3])
end
local day = 86400000
local untilMs = tonumber(ARGV[3])
local expireAt
if ARGV[1] == 'ACTIVE' and untilMs then
  expireAt = untilMs + day
else
  expireAt = tonumber(ARGV[5]) + 30 * day
end
redis.call('PEXPIREAT', KEYS[1], expireAt)
return 1
`;
