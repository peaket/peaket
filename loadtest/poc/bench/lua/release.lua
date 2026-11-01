-- PoC 만료 작업 Lua(S-T27, docs/features/seat-hold.md §5 '만료 인덱스 관리'): 지난 홀드를 한 번에 최대 ARGV[1]개 푼다.
-- KEYS: 1 비트맵 2 만료 인덱스 3 사건 stream 4 펜싱·연산 순번 fence 5 구역 일련번호 secver
-- ARGV: 1 한도 2 홀드 Hash 키 앞머리 3 보유 수 키 앞머리
-- 좌석 홀드 Hash와 계정 보유 수 키는 같은 회차 슬롯이라 이름을 만들어 쓴다(운영 스크립트는 KEYS로 넘긴다, seat-hold §5)
local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local due = redis.call('ZRANGE', KEYS[2], '-inf', nowMs, 'BYSCORE', 'LIMIT', 0, tonumber(ARGV[1]))
local out = {}
for _, seat in ipairs(due) do
  local hk = ARGV[2] .. seat
  local h = redis.call('HMGET', hk, 'owner', 'fence')
  redis.call('SETBIT', KEYS[1], seat, 0)
  redis.call('DEL', hk)
  redis.call('ZREM', KEYS[2], seat)
  if h[1] then
    local q = ARGV[3] .. h[1]
    if tonumber(redis.call('DECR', q)) <= 0 then redis.call('DEL', q) end
  end
  local f = redis.call('INCR', KEYS[4])
  out[#out + 1] = seat
  out[#out + 1] = f
  out[#out + 1] = h[2] or ''
end
if #due > 0 then
  redis.call('HINCRBY', KEYS[5], 'released', #due)
  redis.call('XADD', KEYS[3], 'MAXLEN', '~', 100000, '*', 't', 'RELEASED', 'n', #due)
end
return out
