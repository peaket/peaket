// 우선 구매 권리 사본 쓰기(queue.proto PriorityGrantService, docs/data.md `q:prio`, ADR-0171).
// KEYS 1 q:prio:{account}:E. ARGV 1 grantId 2 state 3 expiresAtMs 4 version.
// 판 번호가 저장한 판보다 클 때만 바꾸고, 만료가 지났으면 키를 지운다. 바꿨으면 1, 그대로면 0, 지웠으면 1/0(DEL 결과)이다.
// 값은 Hash 칸 id·exp·state·ver이고 수명은 권리 만료(PEXPIREAT)다.
export const SET_PRIORITY_GRANT_LUA = `#!lua
local key = KEYS[1]
local exp = tonumber(ARGV[3])
local ver = tonumber(ARGV[4])
if not exp or not ver or exp <= 0 or ver < 0 then
  return redis.error_reply('ERR PEAKET_BAD_INPUT priority-grant')
end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if exp <= now then
  return redis.call('DEL', key)
end
local cur = redis.call('HGET', key, 'ver')
if cur then
  local n = tonumber(cur)
  if not n then return redis.error_reply('ERR PEAKET_CORRUPT_KEY ' .. key) end
  if n >= ver then return 0 end
end
redis.call('HSET', key, 'id', ARGV[1], 'exp', ARGV[3], 'state', ARGV[2], 'ver', ARGV[4])
redis.call('PEXPIREAT', key, ARGV[3])
return 1
`;
