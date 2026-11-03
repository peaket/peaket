// admission-ctrl 리더의 대기열 Redis Lua(docs/features/queue-admission.md §3·§5, docs/data.md §3, ADR-0056·0058·0104·0181·0182). 문자열만 두고 아무것도 가져오지 않는다.
// 이름은 명세 specs/queue.qnt의 동작 이름이다.
//
// EXTEND·NODE_ID·RB05_LUA는 queue-svc services/queue-svc/src/modules/entry/adapters/entry-lua.ts와 같은 글이어야 한다(RB-05는 진입 파드와 리더 어느 쪽이 돌아도 같아야 한다).
// test/leader-lua.test.ts가 두 원문을 견준다. 고칠 때는 둘을 함께 고친다.

const EXTEND = `
local function extend(key, at)
  if redis.call('PEXPIRETIME', key) < tonumber(at) then redis.call('PEXPIREAT', key, at) end
end
`;
const NODE_ID = `
local function myId()
  local id = redis.pcall('CLUSTER', 'MYID')
  if type(id) == 'table' and id.err then
    if string.find(id.err, 'cluster support disabled', 1, true) then return 'standalone' end
    error('PEAKET_NODE_ID ' .. id.err)
  end
  return id
end
-- CLUSTER INFO는 슬롯 16,384개를 세므로 진입 ②는 회차마다 1초에 한 번만 부른다(세대 키의 chk = 마지막으로 설정 세대까지 견준 초)
local function valueOf(id)
  if id == 'standalone' then return id end
  return id .. ':' .. (string.match(redis.call('CLUSTER', 'INFO'), 'cluster_my_epoch:(%d+)') or '0')
end
local function nodeId()
  return valueOf(myId())
end
local function epochOf(v)
  if not v then return nil end
  return tonumber(string.match(v, ':(%d+)$'))
end
`;

export const RB05_LUA = `${EXTEND}${NODE_ID}
local node = nodeId()
local held = redis.call('HGET', KEYS[3], 'node')
if held == node then return {'DONE'} end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if now < tonumber(ARGV[4]) and redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('HSET', KEYS[3], 'node', node)
  extend(KEYS[3], ARGV[1])
  return {'DONE'}
end
local was, cur = epochOf(held), epochOf(node)
local times = 1
if was and cur and cur - was > 1 then times = math.min(cur - was, 3) end
local k = tonumber(ARGV[3]) * times
if ARGV[6] == '1' and redis.call('HEXISTS', KEYS[4], 'lobby') == 0 then k = k + redis.call('SCARD', KEYS[6]) end
if ARGV[7] == '1' and now >= tonumber(ARGV[5]) and redis.call('HEXISTS', KEYS[4], '1') == 0 then k = k + redis.call('SCARD', KEYS[5]) end
local seq = tonumber(redis.call('GET', KEYS[1]) or '0')
local gen = redis.call('LLEN', KEYS[2]) + 1
redis.call('RPUSH', KEYS[2], (seq + 1) .. ':' .. (seq + k) .. ':' .. gen)
redis.call('INCRBY', KEYS[1], k)
redis.call('HSET', KEYS[3], 'node', node)
extend(KEYS[1], ARGV[1])
extend(KEYS[2], ARGV[2])
extend(KEYS[3], ARGV[1])
return {'SKIPPED', seq + 1, seq + k, gen + 1}
`;

// 리더 세대 확인(펜싱, ADR-0056 결정 2): 내 세대 < 저장 세대면 FENCED, 아니면 저장 세대를 내 세대로 올린다. 아래 Lua 모두의 맨 앞에 둔다(KEYS[1] = leader, ARGV[1] = 세대)
const FENCE = `
local lg = tonumber(redis.call('GET', KEYS[1]) or '0')
local mygen = tonumber(ARGV[1])
if mygen < lg then return {'FENCED'} end
if mygen > lg then redis.call('SET', KEYS[1], mygen) end
`;

// 명세 acquire의 BUMP: 리더가 되면 진행 중인 회차마다 세대부터 올린다. KEYS: 1 leader. ARGV: 1 세대, 2 회차 키 수명
export const BUMP_LUA = `${EXTEND}${FENCE}
extend(KEYS[1], ARGV[2])
return {'OK'}
`;

// 명세 plan·applyWrite의 ADVANCE(정본 §5 식, ADR-0104·0182 결정 4·5): 지난 자리와 낡은 곧 입장 항목을 정리하고, 빈자리로 전진 폭을 정해
// serving을 유효 번호(빠진 번호 비트 0, 건너뛴 구간 밖) 기준으로 올린다. 발급된 번호와 첫 전진 문을 넘지 않는다. 같은 Lua에서 차례 시각 기록과 전진 기록을 남기고 오래된 전진 기록을 지운다.
// KEYS: 1 leader, 2 serving, 3 seq, 4 removed, 5 skipped, 6 serving_log, 7 calls, 8 call_req, 9 slots, 10 soon, 11 soon_at, 12 batch_done
// ARGV: 1 세대, 2 목표, 3 p, 4 오는 중 창 W(ms), 5 최대 전진, 6 회차 키 수명, 7 로비 셔플, 8 묶음, 9 묶음 구간 끝(ms), 10 곧 입장 낡음(ms), 11 전진 기록 보관(ms),
//       12 분산 창(ms), 13 늦은 게시의 분산 창(ms), 14 공개 예정 = 구간 끝 + 이 값(ms), 15 한 번에 훑는 번호 상한, 16 전진 기록 수명(판매 종료)
// 돌려주는 값: {'FENCED'} 또는 {'OK', serving, 유효 전진 수, 쓰는 자리, 곧 입장, 오는 중, 뺀 곧 입장, 로비 표시, 묶음 표시, 묶음 게시, 다시 쓰기 표시}
export const TICK_LUA = `${EXTEND}${FENCE}
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local keep = ARGV[6]
-- 지난 자리(점수 = 만료 시각)
redis.call('ZREMRANGEBYSCORE', KEYS[9], '-inf', now)
local slots = redis.call('ZCARD', KEYS[9])
-- 낡은 곧 입장 항목(점수 = 마지막 시도 시각)
local stale = redis.call('ZRANGEBYSCORE', KEYS[11], '-inf', now - tonumber(ARGV[10]))
for i = 1, #stale, 500 do
  local part = {}
  for j = i, math.min(i + 499, #stale) do part[#part + 1] = stale[j] end
  redis.call('ZREM', KEYS[11], unpack(part))
  redis.call('ZREM', KEYS[10], unpack(part))
end
local soon = redis.call('ZCARD', KEYS[10])
-- 오는 중: 최근 W초 전진의 max(0, 유효 번호 수 × p - 요청 수). 보관 시간이 지난 기록은 지운다
local p = tonumber(ARGV[3])
local W = tonumber(ARGV[4])
local inflight = 0
for _, m in ipairs(redis.call('ZRANGE', KEYS[7], 0, -1)) do
  local at, valid = string.match(m, '^(%d+):(%d+)$')
  at = tonumber(at)
  if at and now - at > tonumber(ARGV[11]) then
    redis.call('ZREM', KEYS[7], m)
    redis.call('HDEL', KEYS[8], m)
  elseif at and now - at <= W then
    local req = tonumber(redis.call('HGET', KEYS[8], m) or '0')
    inflight = inflight + math.max(0, tonumber(valid) * p - req)
  end
end
inflight = math.floor(inflight)
local free = tonumber(ARGV[2]) - slots - soon - inflight
local adv = math.floor(free / p)
if adv < 0 then adv = 0 end
if adv > tonumber(ARGV[5]) then adv = tonumber(ARGV[5]) end
-- 첫 전진 문(ADR-0058 결정 4): 표시가 있는데 게시 + 분산 창이 지나지 않았으면 그 구간의 첫 번호 - 1을 넘지 않는다
local cap = tonumber(redis.call('GET', KEYS[3]) or '0')
local bd = redis.call('HMGET', KEYS[12], 'lobby', 'pub:lobby', '1', 'pub:1', 'repair:1')
local function gate(marker, pub, late)
  if not marker then return end
  local first = tonumber(string.match(marker, '^(%d+):'))
  local wait = tonumber(ARGV[12])
  if pub and late then wait = tonumber(ARGV[13]) end
  if not pub or now < tonumber(pub) + wait then cap = math.min(cap, first - 1) end
end
if ARGV[7] == '1' then gate(bd[1], bd[2], false) end
if ARGV[8] == '1' then
  local resultAt = tonumber(ARGV[9]) + tonumber(ARGV[14])
  gate(bd[3], bd[4], bd[4] and tonumber(bd[4]) > resultAt)
end
-- 전진: 유효 번호를 adv개 지날 때까지. 건너뛴 구간은 구간째 뛴다
local skips = {}
for _, line in ipairs(redis.call('LRANGE', KEYS[5], 0, -1)) do
  local a, b = string.match(line, '^(%d+):(%d+):')
  if a then skips[#skips + 1] = {tonumber(a), tonumber(b)} end
end
local s = tonumber(redis.call('GET', KEYS[2]) or '0')
local n = s
local valid = 0
local budget = tonumber(ARGV[15])
while valid < adv and n < cap and budget > 0 do
  n = n + 1
  budget = budget - 1
  local jumped = false
  for _, r in ipairs(skips) do
    if n >= r[1] and n <= r[2] then
      n = math.min(r[2], cap)
      jumped = true
      break
    end
  end
  if not jumped and redis.call('GETBIT', KEYS[4], n) == 0 then valid = valid + 1 end
end
if n > s then
  redis.call('SET', KEYS[2], n)
  redis.call('ZADD', KEYS[6], n, tostring(math.floor(now / 1000)))
  if valid > 0 then redis.call('ZADD', KEYS[7], n, now .. ':' .. valid) end
  extend(KEYS[2], keep)
  extend(KEYS[6], keep)
  extend(KEYS[7], ARGV[16])
end
extend(KEYS[1], keep)
local function has(v) if v then return 1 end return 0 end
return {'OK', n, valid, slots, soon, inflight, #stale, has(bd[1]), has(bd[3]), has(bd[4]), has(bd[5])}
`;

// 명세 plan·applyWrite의 CLOSE(ADR-0182 결정 6): 서버 시각으로 오픈이 지나면 로비 표시를, 구간 끝이 지나면 묶음 표시를 진입 Lua와 같은 뜻으로 쓴다
// (HSETNX, {첫 번호}:{크기}:{대기표 세대}, 인원만큼 INCRBY). 진입 Lua처럼 맨 앞에서 세대 키를 견주고, 다르면 쓰지 않고 RB05를 돌려준다.
// KEYS: 1 leader, 2 seq, 3 skipped, 4 batch_done, 5 batch_members:1, 6 lobby_members, 7 epoch
// ARGV: 1 세대, 2 회차 키 수명, 3 오픈 시각, 4 구간 끝, 5 로비 셔플, 6 묶음
// 돌려주는 값: {'FENCED'}, {'RB05'}, {'EARLY'}, {'OK'}(하나라도 썼다), {'NONE'}
export const CLOSE_LUA = `${EXTEND}${NODE_ID}${FENCE}
-- FENCE의 SET이 리더 키 수명을 지우므로 일찍 돌아가기 전에 건다
extend(KEYS[1], ARGV[2])
local node = nodeId()
local held = redis.call('HGET', KEYS[7], 'node')
if not held then
  redis.call('HSET', KEYS[7], 'node', node)
  extend(KEYS[7], ARGV[2])
elseif held ~= node then
  return {'RB05'}
end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if now < tonumber(ARGV[3]) then return {'EARLY'} end
local gen = redis.call('LLEN', KEYS[3]) + 1
local did = false
if ARGV[5] == '1' and redis.call('HEXISTS', KEYS[4], 'lobby') == 0 then
  local size = redis.call('SCARD', KEYS[6])
  local first = tonumber(redis.call('GET', KEYS[2]) or '0') + 1
  redis.call('HSETNX', KEYS[4], 'lobby', first .. ':' .. size .. ':' .. gen)
  if size > 0 then redis.call('INCRBY', KEYS[2], size) end
  did = true
end
if ARGV[6] == '1' and now >= tonumber(ARGV[4]) and redis.call('HEXISTS', KEYS[4], '1') == 0 then
  local size = redis.call('SCARD', KEYS[5])
  local first = tonumber(redis.call('GET', KEYS[2]) or '0') + 1
  redis.call('HSETNX', KEYS[4], '1', first .. ':' .. size .. ':' .. gen)
  if size > 0 then redis.call('INCRBY', KEYS[2], size) end
  did = true
end
if not did then return {'NONE'} end
extend(KEYS[2], ARGV[2])
extend(KEYS[4], ARGV[2])
extend(KEYS[1], ARGV[2])
return {'OK'}
`;
