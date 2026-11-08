// 입장 확정의 대기열 Redis Lua(docs/features/queue-admission.md §6 '입장 확정의 첫 구현', docs/data.md §3, ADR-0056·0104·0122·0181·0183).
// 문자열만 두고 아무것도 가져오지 않는다. 회차 Lua는 서버 시각(TIME)을 쓴다(리더 ADVANCE와 같은 시계). 이름은 명세 specs/queue.qnt의 admit을 나눈 것이다.

const EXTEND = `
local function extend(key, at)
  if redis.call('PEXPIRETIME', key) < tonumber(at) then redis.call('PEXPIREAT', key, at) end
end
`;
const NOW = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
`;

// ① 회차 슬롯 확인(읽기만): 판매 상태 → 빠진 번호(추가 검증 중이면 VERIFYING) → 건너뛴 구간 세대 → 차례 전 → 차례 시각과 15분(곧 입장 대기열에 있으면 세지 않음).
// 15분이 지났어도 이 대기표의 자리가 살아 있으면 만료가 아니다(입장한 뒤 응답을 잃은 재시도, 입장 Lua가 같은 jti를 다시 준다)
// KEYS: 1 serving, 2 serving_log, 3 removed, 4 skipped, 5 verify, 6 notice, 7 soon, 8 slot_of, 9 slots
// ARGV: 1 번호, 2 세대, 3 대기표 해시, 4 유예(ms), 5·6 NOT_YET 남은 시간의 하한·상한(ms), 7 속도 창(초)
// 돌려주는 값: {'SOLD_OUT'} {'ENDED'} {'VERIFYING', 사유} {'REMOVED'} {'NOT_YET', serving, 남은 ms} {'EXPIRED', 차례 시각} {'OK', serving, 차례 시각(없으면 -1), 곧 입장 1/0, 건너뛴 구간 1/0}
export const PRECHECK_LUA = `${NOW}
local seq = tonumber(ARGV[1])
local gen = tonumber(ARGV[2])
local ns = redis.call('HMGET', KEYS[6], 'saleState', 'soldOutLastSeq')
if ns[1] == 'SOLD_OUT' then return {'SOLD_OUT'} end
if ns[1] == 'ENDED' then return {'ENDED'} end
-- 매진이 풀린 뒤에도 매진 때의 마지막 발급 번호까지의 대기는 매진으로 끝났다(ADR-0122)
local sold = tonumber(ns[2])
if sold and seq <= sold then return {'SOLD_OUT'} end
if redis.call('GETBIT', KEYS[3], seq) == 1 then
  local v = redis.call('HGET', KEYS[5], ARGV[3])
  if v then
    local st, at, why = string.match(v, '^(%u+):(%d+):?(.*)$')
    if st == 'VERIFYING' then return {'VERIFYING', why or ''} end
  end
  return {'REMOVED'}
end
-- 건너뛴 구간 안이면 대기표 세대가 그 줄의 세대 이하일 때만 받는다(장애 전에 받은 진짜 대기자, ADR-0181)
local skipped = 0
for _, line in ipairs(redis.call('LRANGE', KEYS[4], 0, -1)) do
  local a, b, g = string.match(line, '^(%d+):(%d+):(%d+)$')
  if a and seq >= tonumber(a) and seq <= tonumber(b) then
    if gen > tonumber(g) then return {'REMOVED'} end
    skipped = 1
  end
end
local serving = tonumber(redis.call('GET', KEYS[1]) or '0')
if seq > serving then
  -- 최근 창의 serving 속도: 끝 11칸에서 창 앞(또는 그보다 앞)의 마지막 칸과 지금 serving. 11칸이 모두 창 안이면 가장 오래된 칸
  local nowS = math.floor(now / 1000)
  local log = redis.call('ZRANGE', KEYS[2], -11, -1, 'WITHSCORES')
  local baseS, baseV
  for i = #log - 1, 1, -2 do
    local s = tonumber(log[i])
    if s and s <= nowS - tonumber(ARGV[7]) then
      baseS = s
      baseV = tonumber(log[i + 1])
      break
    end
  end
  if not baseS and #log >= 2 then
    baseS = tonumber(log[1])
    baseV = tonumber(log[2])
  end
  local ms = tonumber(ARGV[6])
  if baseS and nowS > baseS and serving > baseV then
    ms = math.ceil((seq - serving) / ((serving - baseV) / (nowS - baseS)) * 1000)
  end
  ms = math.max(tonumber(ARGV[5]), math.min(tonumber(ARGV[6]), ms))
  return {'NOT_YET', serving, ms}
end
-- 차례 시각: 내 번호 이상인 첫 칸(1초). 기록이 없으면 만료를 세지 않는다
local first = redis.call('ZRANGE', KEYS[2], seq, '+inf', 'BYSCORE', 'LIMIT', 0, 1)
local turnAt = -1
if first[1] then turnAt = tonumber(first[1]) * 1000 end
local inSoon = 0
if redis.call('ZSCORE', KEYS[7], ARGV[3]) then inSoon = 1 end
if inSoon == 0 and turnAt >= 0 and now - turnAt > tonumber(ARGV[4]) then
  local j = redis.call('HGET', KEYS[8], ARGV[3])
  local sc = j and tonumber(redis.call('ZSCORE', KEYS[9], j) or '')
  if not (sc and sc > now) then return {'EXPIRED', turnAt} end
end
return {'OK', serving, turnAt, inSoon, skipped}
`;

// ② 사람 슬롯 q:adm(값 {대기표 해시}:{요청 표지}): 비었으면 채움(NEW), 같은 대기표면 SAME, 다른 대기표면 DUP(ADR-0056 결정 5, ADR-0183 결정 2·3).
// 요청 표지는 SOON 되돌리기가 같은 대기표의 다른 요청이 다시 쓴 값을 지우지 않게 가리는 값이다. 입장 토큰 jti는 회차 슬롯 slot_of에 둔다
// KEYS: 1 q:adm   ARGV: 1 해시, 2 요청 표지, 3 만료 시각(판매 종료)
export const CLAIM_LUA = `
local v = redis.call('GET', KEYS[1])
if not v then
  redis.call('SET', KEYS[1], ARGV[1] .. ':' .. ARGV[2], 'PXAT', ARGV[3])
  return 'NEW'
end
-- 해시만 적힌 값(PRF-110 앞의 모양)도 같은 대기표다
if string.match(v, '^([0-9a-f]+)') == ARGV[1] then return 'SAME' end
return 'DUP'
`;

// ③ 회차 슬롯 입장: serving·빠진 번호를 다시 보고, 이 대기표의 살아 있는 자리(slot_of → slots)가 있으면 같은 jti를 다시 주며 첫 사용 기한을 지금부터로 올린다.
// 처음 요청이면(번호 비트맵 req가 0) 그 번호를 부른 전진에 센다. 빈자리(지금 목표 − 만료 전 자리) > 곧 입장 대기열에서 내 앞 번호 수면 자리를 잡고,
// 아니면 곧 입장 대기열에 넣는다(ADR-0104 결정 5). 한 대기표의 요청이 동시에 와도 이 Lua 하나가 가르므로 자리는 하나다(ADR-0183 결정 2)
// KEYS: 1 serving, 2 removed, 3 slots, 4 soon, 5 soon_at, 6 soon_first, 7 admitted, 8 calls, 9 call_req, 10 ctl, 11 admits, 12 slot_of, 13 req
// ARGV: 1 번호, 2 해시, 3 새 jti, 4 차례 시각(없으면 -1), 5 건너뛴 구간 1/0, 6 첫 사용 기한(ms), 7 지금 목표가 없을 때의 목표,
//       8 회차 키 수명, 9 곧 입장 키·처음 요청 키 수명(판매 종료), 10·11 다시 시도 하한·상한(초), 12 속도 창(초), 13 최대 체류(ms)
// 자리를 처음 잡을 때 그 시각을 slot_of의 '<해시>:at' 칸에 둔다. 같은 jti를 다시 줄 때 그 시각을 돌려줘 입장 토큰의 만료(exp)를 첫 발급과 같게 한다(HOT-010 리뷰).
// 돌려주는 값: {'ADMITTED', jti, 다시 줌 1/0, serving, 도착 지연(없으면 -1), 곧 입장 대기(없으면 -1), 이 대기표의 첫 자리 1/0, 첫 발급 시각(ms, 모르면 -1)}
//             {'SOON', 다시 시도 초, 도착 지연} {'REMOVED'} {'NOT_YET'}
//             {'EXPIRED'}: 같은 jti를 다시 줄 자리지만 첫 발급 + 최대 체류가 지났다(exp < iat 토큰을 내지 않는다, HOT-010 리뷰)
export const ADMIT_LUA = `${EXTEND}${NOW}
local seq = tonumber(ARGV[1])
local serving = tonumber(redis.call('GET', KEYS[1]) or '0')
if seq > serving then return {'NOT_YET'} end
if redis.call('GETBIT', KEYS[2], seq) == 1 then return {'REMOVED'} end
-- 같은 대기표의 살아 있는 자리(응답을 잃은 재시도·동시 요청): 같은 jti, 첫 사용 기한을 지금부터로 올리고 아무것도 다시 세지 않는다
local prev = redis.call('HGET', KEYS[12], ARGV[2])
if prev then
  local sc = tonumber(redis.call('ZSCORE', KEYS[3], prev) or '')
  if sc and sc > now then
    local at = tonumber(redis.call('HGET', KEYS[12], ARGV[2] .. ':at') or '')
    if at and now >= at + tonumber(ARGV[13]) then return {'EXPIRED'} end
    redis.call('ZADD', KEYS[3], 'XX', 'GT', now + tonumber(ARGV[6]), prev)
    return {'ADMITTED', prev, 1, serving, -1, -1, 0, tonumber(redis.call('HGET', KEYS[12], ARGV[2] .. ':at') or '-1')}
  end
end
local inSoon = redis.call('ZSCORE', KEYS[4], ARGV[2])
-- 처음 요청: 번호마다 한 번(req 비트). 그 번호를 부른 전진(차례 시각과 같은 초)에만 센다. 건너뛴 구간의 옛 세대 번호는 세지 않는다
local delay = -1
local turnAt = tonumber(ARGV[4])
if ARGV[5] ~= '1' and redis.call('SETBIT', KEYS[13], seq, 1) == 0 then
  extend(KEYS[13], ARGV[9])
  if turnAt >= 0 then
    local c = redis.call('ZRANGE', KEYS[8], seq, '+inf', 'BYSCORE', 'LIMIT', 0, 1)
    if c[1] then
      local at = tonumber(string.match(c[1], '^(%d+):'))
      if at and math.floor(at / 1000) == math.floor(turnAt / 1000) then
        redis.call('HINCRBY', KEYS[9], c[1], 1)
        extend(KEYS[9], ARGV[9])
        delay = now - at
      end
    end
  end
end
local target = tonumber(redis.call('HGET', KEYS[10], 'targetNow') or '') or tonumber(ARGV[7])
local free = target - redis.call('ZCOUNT', KEYS[3], '(' .. now, '+inf')
local ahead = redis.call('ZCOUNT', KEYS[4], '-inf', '(' .. seq)
local sec = math.floor(now / 1000)
if free > ahead then
  redis.call('ZADD', KEYS[3], now + tonumber(ARGV[6]), ARGV[3])
  redis.call('HSET', KEYS[12], ARGV[2], ARGV[3], ARGV[2] .. ':at', now)
  redis.call('INCR', KEYS[7])
  -- 최근 입장 속도: 1초 칸 16개를 돌려 쓴다(값 {초}:{수})
  local f = tostring(sec % 16)
  local cs, cn = string.match(redis.call('HGET', KEYS[11], f) or '', '^(%d+):(%d+)$')
  local n = 1
  if cs and tonumber(cs) == sec then n = tonumber(cn) + 1 end
  redis.call('HSET', KEYS[11], f, sec .. ':' .. n)
  local wait = -1
  if inSoon then
    local fs = tonumber(redis.call('HGET', KEYS[6], ARGV[2]) or '')
    if fs then wait = now - fs end
    redis.call('ZREM', KEYS[4], ARGV[2])
    redis.call('ZREM', KEYS[5], ARGV[2])
    redis.call('HDEL', KEYS[6], ARGV[2])
  end
  extend(KEYS[3], ARGV[8])
  extend(KEYS[7], ARGV[8])
  extend(KEYS[11], ARGV[8])
  extend(KEYS[12], ARGV[8])
  local firstSlot = 1
  if prev then firstSlot = 0 end
  return {'ADMITTED', ARGV[3], 0, serving, delay, wait, firstSlot, now}
end
redis.call('ZADD', KEYS[4], seq, ARGV[2])
redis.call('ZADD', KEYS[5], now, ARGV[2])
redis.call('HSETNX', KEYS[6], ARGV[2], now)
extend(KEYS[4], ARGV[9])
extend(KEYS[5], ARGV[9])
extend(KEYS[6], ARGV[9])
-- 다시 시도 = (앞 수 + 1 − 빈자리) ÷ 최근 창의 입장 속도, 올림, 하한·상한으로 자름. 속도가 0이면 상한
local window = tonumber(ARGV[12])
local sum = 0
local all = redis.call('HGETALL', KEYS[11])
for i = 1, #all, 2 do
  local s, c = string.match(all[i + 1], '^(%d+):(%d+)$')
  if s and tonumber(s) <= sec and sec - tonumber(s) < window then sum = sum + tonumber(c) end
end
local retry = tonumber(ARGV[11])
if sum > 0 then retry = math.ceil((ahead + 1 - free) / (sum / window)) end
retry = math.max(tonumber(ARGV[10]), math.min(tonumber(ARGV[11]), retry))
return {'SOON', retry, delay}
`;

// ④ 사람 슬롯 마무리. ADMITTED: 값이 없거나 같은 대기표면 이 요청의 표지로 다시 쓰고(같은 대기표의 다른 요청이 SOON 되돌리기로 지웠어도 되살린다.
// 그 되돌리기가 늦게 와도 표지가 달라 지우지 못한다) q:dup을 지운다. RELEASE: 값이 이 요청이 채운 그대로일 때만 지운다
// KEYS: 1 q:adm, 2 q:dup   ARGV: 1 ADMITTED·RELEASE, 2 해시, 3 요청 표지, 4 만료 시각(판매 종료)
export const SETTLE_LUA = `
local v = redis.call('GET', KEYS[1])
local mine = ARGV[2] .. ':' .. ARGV[3]
if ARGV[1] == 'ADMITTED' then
  if not v then
    redis.call('SET', KEYS[1], mine, 'PXAT', ARGV[4])
  elseif string.match(v, '^([0-9a-f]+)') == ARGV[2] and v ~= mine then
    redis.call('SET', KEYS[1], mine, 'KEEPTTL')
  end
  redis.call('DEL', KEYS[2])
  return 1
end
if v == mine then redis.call('DEL', KEYS[1]) end
return 1
`;

// 15분 만료: q:dup 값이 이 대기표의 {번호}:{세대}:로 시작하면 지운다. 이 회차에 입장한 적이 있는지(q:adm)를 돌려준다(ADR-0062)
// KEYS: 1 q:dup, 2 q:adm   ARGV: 1 '{번호}:{세대}:'
// 로비 셔플 결과 키가 없을 때(ADR-0231 결정 10): 게시 전이면 PENDING, 참가자가 아니면 GONE, 참가자인데 결과 키가 없으면 repair:lobby를 비어 있을 때만 쓴다.
// KEYS: 1 batch_done, 2 lobby_members. ARGV: 1 토큰 해시, 2 지금(ms)
export const LOBBY_STATE_LUA = `
if redis.call('HEXISTS', KEYS[1], 'pub:lobby') == 0 then return 'PENDING' end
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 0 then return 'GONE' end
redis.call('HSETNX', KEYS[1], 'repair:lobby', ARGV[2])
return 'REPAIRING'
`;
export const EXPIRE_LUA = `
local v = redis.call('GET', KEYS[1])
if v and string.sub(v, 1, #ARGV[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
return redis.call('EXISTS', KEYS[2])
`;

// 1인 1순번 위반으로 거절한 번호를 빠진 번호로 켠다(진입의 MARK_REMOVED와 같은 글)
export const MARK_REMOVED_LUA = `${EXTEND}
redis.call('SETBIT', KEYS[1], ARGV[1], 1)
extend(KEYS[1], ARGV[2])
return 1
`;
