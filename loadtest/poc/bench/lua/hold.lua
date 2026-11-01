-- PoC 홀드 Lua(S-T27·V-T33, docs/features/seat-hold.md §3 '실행 계약'). 운영 스크립트가 아니라 같은 키를 같은 횟수로 만지는 대역이다.
-- KEYS: 1 세대 epoch 2 판매 정지 사본 ctl 3 비트맵 4 만료 인덱스 5 계정 보유 수 quota 6 멱등 idem 7 사건 stream 8 펜싱·연산 순번 fence
--       9 구역 일련번호 secver 10.. 좌석 홀드 Hash
-- ARGV: 1 1인 한도 2 TTL(ms) 3 holdId 4 지문 5 계정 6 구역 7.. 좌석 색인
if not redis.call('GET', KEYS[1]) then return {'NOT_READY'} end
local ctl = redis.call('HMGET', KEYS[2], 'paused', 'suspended')
if ctl[1] == '1' or ctl[2] == '1' then return {'PAUSED'} end
local idem = redis.call('GET', KEYS[6])
if idem then
  if idem == ARGV[4] then return {'IDEM_REPLAY'} end
  return {'IDEM_REUSED'}
end
local n = #ARGV - 6
local held = tonumber(redis.call('GET', KEYS[5]) or '0')
if held + n > tonumber(ARGV[1]) then return {'QUOTA_EXCEEDED'} end
for i = 1, n do
  if redis.call('GETBIT', KEYS[3], ARGV[6 + i]) == 1 then return {'CONFLICT', ARGV[6 + i]} end
end
local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local exp = nowMs + tonumber(ARGV[2])
local fence = redis.call('INCR', KEYS[8])
for i = 1, n do
  local seat = ARGV[6 + i]
  redis.call('SETBIT', KEYS[3], seat, 1)
  redis.call('HSET', KEYS[9 + i], 'holdId', ARGV[3], 'owner', ARGV[5], 'fence', fence, 'exp', exp)
  redis.call('ZADD', KEYS[4], exp, seat)
end
redis.call('INCRBY', KEYS[5], n)
redis.call('SET', KEYS[6], ARGV[4], 'PX', 60000)
redis.call('HINCRBY', KEYS[9], ARGV[6], 1)
redis.call('XADD', KEYS[7], 'MAXLEN', '~', 100000, '*', 't', 'HELD', 'h', ARGV[3], 'f', fence)
return {'OK', fence, exp}
