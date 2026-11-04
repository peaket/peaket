// admission-ctrl 리더의 대기열 Redis Lua(docs/features/queue-admission.md §3·§5, docs/data.md §3, ADR-0056·0058·0104·0181·0182). 문자열만 두고 아무것도 가져오지 않는다.
// 이름은 명세 specs/queue.qnt의 동작 이름이다.
//
// EXTEND·NODE_ID·RB05_LUA·RB05_MARK_LUA·RB05_CLEAR_LUA는 queue-svc services/queue-svc/src/modules/entry/adapters/entry-lua.ts와 같은 글이어야 한다(RB-05는 진입 파드와 리더 어느 쪽이 돌아도 같아야 한다).
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
`;

export const RB05_LUA = `${EXTEND}${NODE_ID}
local node = nodeId()
local ep = redis.call('HMGET', KEYS[3], 'node', 'pend')
local held = ep[1]
if held == node then
  -- 다른 파드가 먼저 건너뛰었다. 그 건너뛰기를 붙은 복제본이 받았는지 아직 확인하지 않았으면 PENDING(부른 쪽이 확인한다)
  if ep[2] then return {'PENDING'} end
  return {'DONE'}
end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if now < tonumber(ARGV[4]) and redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('HSET', KEYS[3], 'node', node)
  extend(KEYS[3], ARGV[1])
  return {'DONE'}
end
local k = tonumber(ARGV[3])
if ARGV[6] == '1' and redis.call('HEXISTS', KEYS[4], 'lobby') == 0 then k = k + redis.call('SCARD', KEYS[6]) end
if ARGV[7] == '1' and now >= tonumber(ARGV[5]) and redis.call('HEXISTS', KEYS[4], '1') == 0 then k = k + redis.call('SCARD', KEYS[5]) end
local seq = tonumber(redis.call('GET', KEYS[1]) or '0')
local gen = redis.call('LLEN', KEYS[2]) + 1
redis.call('RPUSH', KEYS[2], (seq + 1) .. ':' .. (seq + k) .. ':' .. gen)
redis.call('INCRBY', KEYS[1], k)
redis.call('HSET', KEYS[3], 'node', node, 'pend', '1')
extend(KEYS[1], ARGV[1])
extend(KEYS[2], ARGV[2])
extend(KEYS[3], ARGV[1])
return {'SKIPPED', seq + 1, seq + k, gen + 1}
`;

// RB-05 복제 확인(ADR-0186): 부른 쪽이 연결 표지(CLIENT INFO) → 표시 Lua → INFO replication(붙은 온라인 복제본 수 n) → 같은 연결로 WAIT n
// → 연결 표지를 다시 견줌 → 지우기 Lua 순서로 돈다. 표시 Lua는 세대 키가 지금 노드 표지이고 pend가 있을 때만 wait에 서버 시각을 써, 이 연결의
// 쓰기가 그 노드의 복제 흐름에서 RB-05 쓰기 뒤에 오게 한다(WAIT는 이 연결이 쓴 것까지만 센다). 지우기 Lua는 표시한 그 노드에서, 세대 키가 아직
// 그 노드 표지일 때만 pend·wait을 지운다(사이에 다른 노드로 바뀌었으면 그 노드의 RB-05는 확인하지 않았다). KEYS: 1 epoch, 지우기 ARGV: 1 표시가 돌려준 노드 표지
// 돌려주는 값: 표시는 노드 표지(확인할 것이 있음)·0, 지우기는 지운 칸 수
export const RB05_MARK_LUA = `${NODE_ID}
local me = nodeId()
if redis.call('HGET', KEYS[1], 'node') ~= me or not redis.call('HGET', KEYS[1], 'pend') then return 0 end
local t = redis.call('TIME')
redis.call('HSET', KEYS[1], 'wait', tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000))
return me
`;
export const RB05_CLEAR_LUA = `${NODE_ID}
local me = nodeId()
if me ~= ARGV[1] or redis.call('HGET', KEYS[1], 'node') ~= me then return 0 end
return redis.call('HDEL', KEYS[1], 'pend', 'wait')
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
// 입장 비율(PRF-100, ADR-0104 결정 3): 불린 지 창(ARGV 17~18) 안인 전진의 처음 요청 수(전진마다 유효 수에서 자름) ÷ 유효 수, 표본이 없으면 1, p = max(비율, 하한).
// 판매 상태(ADR-0122): notice의 saleState(없으면 ARGV 19)가 ON_SALE이 아니면 전진 0. ON_SALE인데 soldOutLastSeq가 serving보다 크면 먼저 그리로 옮긴다(전진 기록에는 남기지 않는다).
// 지금 목표(ARGV 2)는 ctl의 targetNow에 남겨 입장 확정이 빈자리를 셀 때 읽는다(PRF-110, ADR-0183 결정 4). 낡은 곧 입장 항목은 soon_first에서도 지운다(결정 9).
// KEYS: 1 leader, 2 serving, 3 seq, 4 removed, 5 skipped, 6 serving_log, 7 calls, 8 call_req, 9 slots, 10 soon, 11 soon_at, 12 batch_done, 13 notice, 14 ctl, 15 soon_first
// ARGV: 1 세대, 2 목표, 3 비율 하한, 4 오는 중 창 W(ms), 5 최대 전진, 6 회차 키 수명, 7 로비 셔플, 8 묶음, 9 묶음 구간 끝(ms), 10 곧 입장 낡음(ms), 11 전진 기록 보관(ms),
//       12 분산 창(ms), 13 늦은 게시의 분산 창(ms), 14 공개 예정 = 구간 끝 + 이 값(ms), 15 한 번에 훑는 번호 상한, 16 전진 기록 수명(판매 종료),
//       17·18 입장 비율 창의 처음·끝(불린 뒤 ms), 19 판매 상태를 모를 때의 값
// 돌려주는 값: {'FENCED'} 또는 {'OK', serving, 유효 전진 수, 쓰는 자리, 곧 입장, 오는 중, 뺀 곧 입장, 로비 표시, 묶음 표시, 묶음 게시, 다시 쓰기 표시, 비율(천분율), 판매 상태}
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
  redis.call('HDEL', KEYS[15], unpack(part))
end
local soon = redis.call('ZCARD', KEYS[10])
redis.call('HSET', KEYS[14], 'targetNow', ARGV[2])
extend(KEYS[14], keep)
-- 전진 기록을 한 번 훑어: 보관 시간이 지난 기록은 지우고, 입장 비율 창 안 기록으로 비율을, 최근 W초 기록으로 오는 중을 센다
local W = tonumber(ARGV[4])
local wmin = tonumber(ARGV[17])
local wmax = tonumber(ARGV[18])
local recent = {}
local sumValid, sumReq = 0, 0
-- 처음 요청 수는 한 번에 읽는다(전진 기록은 60초 분량, 많아야 약 300개)
local reqs = {}
local rq = redis.call('HGETALL', KEYS[8])
for i = 1, #rq, 2 do reqs[rq[i]] = tonumber(rq[i + 1]) end
for _, m in ipairs(redis.call('ZRANGE', KEYS[7], 0, -1)) do
  local at, valid = string.match(m, '^(%d+):(%d+)$')
  at = tonumber(at)
  valid = tonumber(valid)
  if at and now - at > tonumber(ARGV[11]) then
    redis.call('ZREM', KEYS[7], m)
    redis.call('HDEL', KEYS[8], m)
  elseif at then
    local req = reqs[m] or 0
    local age = now - at
    if age <= W then recent[#recent + 1] = {valid, req} end
    if age >= wmin and age <= wmax then
      sumValid = sumValid + valid
      sumReq = sumReq + math.min(req, valid)
    end
  end
end
local ratio = 1
if sumValid > 0 then ratio = sumReq / sumValid end
local p = math.max(ratio, tonumber(ARGV[3]))
-- 오는 중: 최근 W초 전진의 max(0, 유효 번호 수 × p - 요청 수)
local inflight = 0
for _, r in ipairs(recent) do inflight = inflight + math.max(0, r[1] * p - r[2]) end
inflight = math.floor(inflight + 1e-9)
local free = tonumber(ARGV[2]) - slots - soon - inflight
-- 나눗셈의 부동소수 오차(80 ÷ 0.8 = 99.99…)로 하나 덜 부르지 않게 아주 작은 값을 더한다
local adv = math.floor(free / p + 1e-9)
if adv < 0 then adv = 0 end
if adv > tonumber(ARGV[5]) then adv = tonumber(ARGV[5]) end
-- 판매 상태: ON_SALE이 아니면(일시 매진·매진·판매 종료) 부르지 않는다
local ns = redis.call('HMGET', KEYS[13], 'saleState', 'soldOutLastSeq')
local state = ns[1] or ARGV[19]
if state ~= 'ON_SALE' then adv = 0 end
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
-- 매진이 풀렸으면 serving을 매진 때의 마지막 발급 번호로 옮긴다(그 번호까지의 대기는 매진으로 끝났다). 부른 것이 아니라 유효 수에 넣지 않는다.
-- 입장 일시정지(최대 전진 0) 중에는 순번을 그대로 두고, 숫자가 아닌 값은 없는 것으로 본다
local sold = tonumber(ns[2])
if state == 'ON_SALE' and sold and tonumber(ARGV[5]) > 0 then
  sold = math.min(sold, cap)
  if sold > n then n = sold end
end
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
return {'OK', n, valid, slots, soon, inflight, #stale, has(bd[1]), has(bd[3]), has(bd[4]), has(bd[5]), math.floor(ratio * 1000 + 0.5), state}
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
local ep = redis.call('HMGET', KEYS[7], 'node', 'pend')
local held = ep[1]
if not held then
  redis.call('HSET', KEYS[7], 'node', node)
  extend(KEYS[7], ARGV[2])
elseif held ~= node or ep[2] then
  -- 장애 전환 뒤 RB-05 전이거나, RB-05가 건너뛰었지만 복제 확인 전이다(ADR-0186)
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
