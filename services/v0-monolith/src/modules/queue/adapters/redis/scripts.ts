// 대기열 v0 Lua(docs/features/queue-admission.md §13). 키는 모두 같은 회차 해시 태그 {event:E} 아래라 한 슬롯이다.
// 숫자는 Lua 5.1의 tostring이 지수 표기를 내지 않게 string.format('%d')로 쓴다(밀리초 시각은 13자리).
// 값 'seq:at'은 순번과 시각(밀리초)을 ':'로 이은 문자열이다.

/** 회차 설정을 한 번에 쓴다. KEYS meta / ARGV admitPerSecond, saleEndsAtMs(빈 문자열이면 끝나지 않음) */
export const OPEN_LUA = `
redis.call('HSET', KEYS[1], 'admitPerSecond', ARGV[1])
if ARGV[2] == '' then redis.call('HDEL', KEYS[1], 'saleEndsAtMs') else redis.call('HSET', KEYS[1], 'saleEndsAtMs', ARGV[2]) end
return 1
`;

/** KEYS meta, seq, waiting, called, admitted / ARGV pid, nowMs, graceMs */
export const ENTER_LUA = `
local meta = redis.call('HMGET', KEYS[1], 'admitPerSecond', 'saleEndsAtMs')
if not meta[1] then return {'queue-not-found'} end
local now = tonumber(ARGV[2])
if meta[2] and now >= tonumber(meta[2]) then return {'sale-ended'} end
if redis.call('HEXISTS', KEYS[5], ARGV[1]) == 1 then return {'already-admitted'} end
if redis.call('ZSCORE', KEYS[3], ARGV[1]) then return {'already-in-queue'} end
local c = redis.call('HGET', KEYS[4], ARGV[1])
if c then
  local at = tonumber(string.match(c, ':(%d+)$'))
  if now - at <= tonumber(ARGV[3]) then return {'already-in-queue'} end
  redis.call('HDEL', KEYS[4], ARGV[1])
end
local seq = redis.call('INCR', KEYS[2])
redis.call('ZADD', KEYS[3], seq, ARGV[1])
return {'entered', string.format('%d', seq)}
`;

/** 조회만 한다. KEYS meta, waiting, called, admitted, serving, rate / ARGV pid */
export const READ_LUA = `
local meta = redis.call('HMGET', KEYS[1], 'admitPerSecond', 'saleEndsAtMs')
if not meta[1] then return {'queue-not-found'} end
local serving = redis.call('GET', KEYS[5]) or '0'
local rate = redis.call('GET', KEYS[6]) or '0'
local ends = meta[2] or ''
local r = redis.call('ZRANK', KEYS[2], ARGV[1], 'WITHSCORE')
if r then return {'waiting', serving, rate, ends, r[2], string.format('%d', r[1])} end
local c = redis.call('HGET', KEYS[3], ARGV[1])
if c then return {'called', serving, rate, ends, c} end
local a = redis.call('HGET', KEYS[4], ARGV[1])
if a then return {'admitted', serving, rate, ends, a} end
return {'none', serving, rate, ends}
`;

/** KEYS waiting, called / ARGV pid */
export const CANCEL_LUA = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
return 1
`;

/** KEYS meta, waiting, called, admitted / ARGV pid, nowMs, graceMs */
export const ADMIT_LUA = `
local meta = redis.call('HMGET', KEYS[1], 'admitPerSecond', 'saleEndsAtMs')
if not meta[1] then return {'queue-not-found'} end
local now = tonumber(ARGV[2])
if meta[2] and now >= tonumber(meta[2]) then return {'sale-ended'} end
local a = redis.call('HGET', KEYS[4], ARGV[1])
if a then return {'admitted', a} end
local c = redis.call('HGET', KEYS[3], ARGV[1])
if c then
  redis.call('HDEL', KEYS[3], ARGV[1])
  local seq = string.match(c, '^(%d+):')
  local at = tonumber(string.match(c, ':(%d+)$'))
  if now - at > tonumber(ARGV[3]) then return {'expired', c} end
  local v = seq .. ':' .. string.format('%d', now)
  redis.call('HSET', KEYS[4], ARGV[1], v)
  return {'admitted', v}
end
local s = redis.call('ZSCORE', KEYS[2], ARGV[1])
if s then return {'not-yet', s} end
return {'not-in-queue'}
`;

/**
 * 입장 루프 1초 칸. KEYS meta, waiting, called, serving, rate, last_tick, serving_log
 * ARGV nowMs, 속도 창(칸 수), serving_log 최대 길이
 */
export const TICK_LUA = `
local meta = redis.call('HMGET', KEYS[1], 'admitPerSecond', 'saleEndsAtMs')
local serving = tonumber(redis.call('GET', KEYS[4]) or '0')
if not meta[1] then return {0, 0, string.format('%d', serving)} end
local now = tonumber(ARGV[1])
if meta[2] and now >= tonumber(meta[2]) then return {0, 0, string.format('%d', serving)} end
local sec = math.floor(now / 1000)
local last = redis.call('GET', KEYS[6])
if last and sec <= tonumber(last) then return {0, 0, string.format('%d', serving)} end
redis.call('SET', KEYS[6], string.format('%d', sec))
local popped = redis.call('ZPOPMIN', KEYS[2], meta[1])
local n = #popped / 2
local nowText = string.format('%d', now)
for i = 1, #popped, 2 do
  local seq = tonumber(popped[i + 1])
  redis.call('HSET', KEYS[3], popped[i], string.format('%d', seq) .. ':' .. nowText)
  if seq > serving then serving = seq end
end
local servingText = string.format('%d', serving)
redis.call('SET', KEYS[4], servingText)
redis.call('XADD', KEYS[7], 'MAXLEN', '~', ARGV[3], '*', 'serving', servingText, 'called', string.format('%d', n), 'atMs', nowText)
local entries = redis.call('XREVRANGE', KEYS[7], '+', '-', 'COUNT', ARGV[2])
local sum, oldest = 0, now
for _, e in ipairs(entries) do
  local f = e[2]
  local called, at = 0, now
  for j = 1, #f, 2 do
    if f[j] == 'called' then called = tonumber(f[j + 1]) elseif f[j] == 'atMs' then at = tonumber(f[j + 1]) end
  end
  sum = sum + called
  if at < oldest then oldest = at end
end
-- 칸(유닉스 초) 수로 나눈다. 칸 안의 호출 위치(밀리초)에 따라 나누는 값이 달라지지 않게(새 맥락 리뷰)
local span = sec - math.floor(oldest / 1000) + 1
redis.call('SET', KEYS[5], string.format('%.3f', sum / span))
return {1, n, servingText}
`;
