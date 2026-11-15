// 예매 제한 사본 쓰기(queue.proto BookingRestrictionService, q:rst:{account}, GAT-310).
// 판 번호가 저장한 판보다 클 때만 st·until·rid·ver를 한 번에 바꾼다. 같은 판은 TTL만 다시 세우고 changed false,
// 옛 판은 TTL도 건드리지 않고 changed false다(10분마다 같은 판을 다시 보내는 작업과 docs/data.md `q:rst`).
// 수명: ACTIVE면 until + 1일(끝이 없으면 30일), LIFTED면 30일. until + 1일이 이미 지났으면 PEXPIREAT가 키를 지운다.
// ARGV: 1 상태, 2 제한 ID, 3 until(없으면 빈 글), 4 판 번호, 5 지금(ms)
export const SET_BOOKING_RESTRICTION_LUA = `
local current = redis.call('HGET', KEYS[1], 'ver')
local day = 86400000
local function expireAt(st, untilText, nowMs)
  local untilMs = tonumber(untilText)
  if st == 'ACTIVE' and untilMs then return untilMs + day end
  return nowMs + 30 * day
end
if current then
  local cur = tonumber(current)
  local nextVer = tonumber(ARGV[4])
  if cur > nextVer then return 0 end
  if cur == nextVer then
    -- 같은 판 재전송: 저장한 상태·끝 시각으로 수명만 다시 세운다(받은 값으로 칸을 바꾸지 않는다)
    local st = redis.call('HGET', KEYS[1], 'st')
    local untilText = redis.call('HGET', KEYS[1], 'until') or ''
    redis.call('PEXPIREAT', KEYS[1], expireAt(st, untilText, tonumber(ARGV[5])))
    return 0
  end
end
redis.call('HSET', KEYS[1], 'st', ARGV[1], 'rid', ARGV[2], 'ver', ARGV[4])
if ARGV[3] == '' then
  redis.call('HDEL', KEYS[1], 'until')
else
  redis.call('HSET', KEYS[1], 'until', ARGV[3])
end
redis.call('PEXPIREAT', KEYS[1], expireAt(ARGV[1], ARGV[3], tonumber(ARGV[5])))
return 1
`;
