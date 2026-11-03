// 진입 3단계와 묶음의 Lua 원문(docs/features/queue-admission.md §3·'묶음의 첫 구현', docs/data.md §3). 문자열만 두고 아무것도 가져오지 않는다.
// 운영 어댑터(redis-entry-store.ts)와 성능 측정 도구(loadtest/poc/run.mjs가 이 파일을 읽어 측정 이미지의 lua/ 폴더에 쓴다)가 같은 원문을 쓰게 하려는 것이다.
// 이름은 명세 specs/queue.qnt의 동작 이름이다.

// 회차 키의 수명은 부를 때마다 더 늦은 쪽으로만 늘린다(회차 연기로 판매 종료가 늦춰져도 옛 일정에 사라지지 않게. 당기지는 않는다).
// 수명이 없는 키(-1, 예: RB-05의 INCRBY로 먼저 생긴 카운터)에도 건다. 없는 키(-2)는 PEXPIREAT이 아무 일도 하지 않는다
const EXTEND = `
local function extend(key, at)
  if redis.call('PEXPIRETIME', key) < tonumber(at) then redis.call('PEXPIREAT', key, at) end
end
`;
// 지금 노드 표지(ADR-0181): 클러스터 모드는 '{CLUSTER MYID}:{설정 세대 cluster_my_epoch}'. 설정 세대는 승격마다 클러스터 전체에서 더 큰 값으로 바뀌므로
// 옛 주 노드가 다시 주 노드가 돼도 표지가 다르다. 단일 노드(로컬·CI, 'cluster support disabled')만 'standalone'이고, 다른 오류(권한 등)는
// 보호가 조용히 꺼지지 않게 스크립트를 실패시킨다. epochOf는 표지의 설정 세대(없으면 nil)다
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
// 사람 슬롯 값 읽기: 번호 기록 {번호}:{세대}:{요청 ID}:{jny}:{vr}, 묶음 기록 BATCH:1:{토큰 해시}:{요청 ID}:{jny}:{vr}
const RECORDED = `'^(%d+):(%d+):([^:]+):([^:]*):([^:]*)$'`;
const BATCHED = `'^BATCH:1:([0-9a-f]+):([^:]+):([^:]*):([^:]*)$'`;

// ① enterPreempt: 입장 키가 있으면 거절, 없으면 PENDING:{요청 ID}로 선점(같은 요청은 이어서, 기록이 끝났으면 그 기록)
export const PREEMPT_LUA = `
if redis.call('EXISTS', KEYS[2]) == 1 then return {'ADMITTED'} end
local v = redis.call('GET', KEYS[1])
if not v then
  redis.call('SET', KEYS[1], 'PENDING:' .. ARGV[1], 'PX', ARGV[2])
  return {'PROCEED'}
end
if v == 'PENDING:' .. ARGV[1] then return {'PROCEED'} end
local bh, brq, bjny, bvr = string.match(v, ${BATCHED})
if bh then
  if brq == ARGV[1] then return {'BATCH', bh, bjny, bvr} end
  return {'BUSY'}
end
local s, g, rq, jny, vr = string.match(v, ${RECORDED})
if s and rq == ARGV[1] then return {'RECORDED', s, g, jny, vr} end
return {'BUSY'}
`;

// ②가 번호를 주지 않았으면(서버 시각으로 오픈 전, 묶음 구간의 오픈 뒤 발급 토큰) 내 선점을 푼다. 남기면 새 요청 ID로 다시 온 같은 사람이 선점 수명 동안 409를 받는다
export const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == 'PENDING:' .. ARGV[1] then redis.call('DEL', KEYS[1]) return 1 end
return 0
`;

// ② enterNumber(파드별 묶음, ADR-0179): 서버 시각(TIME)으로 구간을 보고, 로비 표시 → 묶음(구간 안이면 요청마다 묶음 대상은 SADD, 오픈 뒤 발급 토큰은 WAIT)
// → 닫힘 표시 → 번호를 받을 요청 수만큼 INCRBY해 묶음 안 순서대로 나눠 준다. 표시 값은 {첫 번호}:{크기}:{세대}이고 HSETNX라 리더와 겹쳐도
// 몫마다 한 번만 전진한다(중간-028). 참가자 목록(토큰 해시)은 판매 종료까지만 둔다.
// 맨 앞에서 세대 키(KEYS[6])의 주 노드 ID를 지금 노드 ID와 견준다. 없으면 쓰고, 다르면 장애 전환 뒤 RB-05 전이라 아무것도 쓰지 않는다(ADR-0181).
// ARGV: 1 회차 키 수명, 2 오픈 시각, 3 묶음 구간 끝, 4 로비 셔플, 5 묶음, 6 참가자 목록 수명, 7 요청 수 n, 그 뒤 요청마다 (묶음 대상 여부, 토큰 해시).
// 돌려주는 값: 장애 전환 뒤 RB-05 전이면 {'RB05'}, 서버 시각으로 오픈 전이면 {'EARLY'}, 아니면 {'OK', 세대, 요청마다 (종류, 값)}. 종류 N = 번호(값), B = 묶음에 넣음, W = 기다림(값 = Retry-After 초)
export const NUMBER_BATCH_LUA = `${EXTEND}${NODE_ID}
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local sec = tostring(math.floor(now / 1000))
local id = myId()
local ep = redis.call('HMGET', KEYS[6], 'node', 'chk')
local held = ep[1]
if not held then
  redis.call('HSET', KEYS[6], 'node', valueOf(id), 'chk', sec)
  extend(KEYS[6], ARGV[1])
elseif not (id ~= 'standalone' and ep[2] == sec and string.sub(held, 1, #id + 1) == id .. ':') then
  -- 이번 초에 아직 설정 세대까지 견주지 않았거나 노드 ID가 다르다
  if held ~= valueOf(id) then return {'RB05'} end
  if id ~= 'standalone' then redis.call('HSET', KEYS[6], 'chk', sec) end
end
if now < tonumber(ARGV[2]) then return {'EARLY'} end
local gen = redis.call('LLEN', KEYS[2]) + 1
local n = tonumber(ARGV[7])
local out = {'OK', gen}
if ARGV[4] == '1' and redis.call('HEXISTS', KEYS[3], 'lobby') == 0 then
  local size = redis.call('SCARD', KEYS[5])
  local first = tonumber(redis.call('GET', KEYS[1]) or '0') + 1
  redis.call('HSETNX', KEYS[3], 'lobby', first .. ':' .. size .. ':' .. gen)
  if size > 0 then redis.call('INCRBY', KEYS[1], size) end
end
if ARGV[5] == '1' then
  local closeAt = tonumber(ARGV[3])
  local closed = redis.call('HEXISTS', KEYS[3], '1') == 1
  if not closed and now < closeAt then
    local added = false
    for i = 1, n do
      if ARGV[6 + 2 * i] == '1' then
        redis.call('SADD', KEYS[4], ARGV[7 + 2 * i])
        added = true
        out[#out + 1] = 'B'
        out[#out + 1] = 0
      else
        out[#out + 1] = 'W'
        out[#out + 1] = math.ceil((closeAt - now) / 1000)
      end
    end
    if added then
      extend(KEYS[4], ARGV[6])
      extend(KEYS[3], ARGV[1])
    end
    return out
  end
  if not closed then
    local size = redis.call('SCARD', KEYS[4])
    local first = tonumber(redis.call('GET', KEYS[1]) or '0') + 1
    redis.call('HSETNX', KEYS[3], '1', first .. ':' .. size .. ':' .. gen)
    if size > 0 then redis.call('INCRBY', KEYS[1], size) end
  end
end
local last = redis.call('INCRBY', KEYS[1], n)
for i = 1, n do
  out[#out + 1] = 'N'
  out[#out + 1] = last - n + i
end
extend(KEYS[1], ARGV[1])
extend(KEYS[3], ARGV[1])
return out
`;

// RB-05(docs/infra.md, ADR-0181): 세대 키가 지금 노드 표지와 같으면(다른 파드가 먼저 했다) 아무것도 하지 않는다. 다르면 서버 시각으로 오픈 전이고
// 카운터가 없으면 세대 키만 바꾸고(번호가 나간 적이 없다), 아니면 K만큼 INCRBY하고 {시작}:{끝}:{그때까지의 세대} 한 줄을 skipped에 더한 뒤 세대 키를 바꾼다.
// K = 바탕 값 × 설정 세대가 오른 수(1~3 [가정]. 사이에 올라섰다 사라진 주 노드의 RB-05와 그 뒤 번호를 잃었을 수 있다. 설정 세대는 다른 샤드의 장애 전환으로도
//   쌓여 클러스터 수명만큼 커질 수 있으므로, 사이에 사라진 주 노드 둘까지 덮는 3에서 자른다)
//   + (오픈이 지났는데 로비 표시가 없으면 로비 인원) + (구간 끝이 지났는데 묶음 표시가 없으면 묶음 인원). 잃은 표시의 몫까지 덮는다.
// KEYS: 1 seq, 2 skipped, 3 epoch, 4 batch_done, 5 batch_members:1, 6 lobby_members
// ARGV: 1 회차 키 수명, 2 skipped 수명, 3 바탕 값, 4 오픈 시각, 5 묶음 구간 끝, 6 로비 셔플, 7 묶음
// 돌려주는 값: {'DONE'} 또는 {'SKIPPED', 시작, 끝, 새 세대}
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

// 회차 일정 사본 읽기(redis-event-schedules.ts, ADR-0181): HGETALL과 함께 세대 키를 맞춘다. 사본이 있으면 세대 키가 없을 때 지금 노드 ID를 쓰고,
// 서버 시각으로 오픈 전이고 카운터가 없는데 다르면 그 자리에서 바꾼다(번호가 나간 적이 없다. 오픈 시각이 오픈 뒤에 늦춰진 회차는 카운터가 있어 바꾸지 않는다).
// 그 밖에 다른 것은 진입 ②와 RB-05가 맡는다. 세대 키 수명은 순번 카운터와 같은 판매 종료 + 1일 = 공연 시작 시각이다. KEYS: 1 cfg, 2 epoch, 3 seq
export const SCHEDULE_LUA = `${EXTEND}${NODE_ID}
local cfg = redis.call('HGETALL', KEYS[1])
if #cfg == 0 then return cfg end
local opens, starts
for i = 1, #cfg, 2 do
  if cfg[i] == 'opensAtMs' then opens = tonumber(cfg[i + 1]) elseif cfg[i] == 'startsAtMs' then starts = tonumber(cfg[i + 1]) end
end
if opens and starts then
  local node = nodeId()
  local held = redis.call('HGET', KEYS[2], 'node')
  local t = redis.call('TIME')
  local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
  if not held or (held ~= node and now < opens and redis.call('EXISTS', KEYS[3]) == 0) then redis.call('HSET', KEYS[2], 'node', node) end
  extend(KEYS[2], starts)
end
return cfg
`;

// ③ enterRecord: 입장 키가 있으면 거절(FND-130이 넘긴 것). 값이 내 PENDING이거나 비었을 때만 {번호}:{세대}:{요청 ID}:{jny}:{vr}로 기록, 수명은 판매 종료.
// 같은 요청의 다른 기록이 있으면(같은 요청이 동시에 두 번) 먼저 기록된 값을, 같은 요청이 구간 안에서 먼저 묶음에 들었으면 그 토큰 해시를 돌려준다
export const RECORD_LUA = `
if redis.call('EXISTS', KEYS[2]) == 1 then return {'ADMITTED'} end
local v = redis.call('GET', KEYS[1])
if v and v ~= 'PENDING:' .. ARGV[1] then
  local s, g, rq, jny, vr = string.match(v, ${RECORDED})
  if s and rq == ARGV[1] then return {'SAME', s, g, jny, vr} end
  local bh, brq = string.match(v, ${BATCHED})
  if bh and brq == ARGV[1] then return {'BATCH', bh} end
  return {'TAKEN'}
end
redis.call('SET', KEYS[1], ARGV[2] .. ':' .. ARGV[3] .. ':' .. ARGV[1] .. ':' .. ARGV[5] .. ':' .. ARGV[6], 'PXAT', ARGV[4])
return {'RECORDED'}
`;

// ③ enterBatchRecord(OPEN[14]): 선점 값을 판매 종료까지 남는 묶음 기록으로 바꾼다. 입장 키도 본다. 기록된 토큰 해시를 돌려준다
// (같은 요청이 다른 토큰으로 먼저 기록했으면 그 해시라, 202의 결과 파일 경로가 사람 슬롯의 기록과 같다). 같은 요청이 구간 끝을 걸쳐
// 와서 먼저 번호를 기록했으면 그 기록을 돌려준다(SAME)
export const BATCH_RECORD_LUA = `
if redis.call('EXISTS', KEYS[2]) == 1 then return {'ADMITTED'} end
local v = redis.call('GET', KEYS[1])
if v and v ~= 'PENDING:' .. ARGV[1] then
  local bh, brq = string.match(v, ${BATCHED})
  if bh and brq == ARGV[1] then return {'BATCHED', bh} end
  local s, g, rq, jny, vr = string.match(v, ${RECORDED})
  if s and rq == ARGV[1] then return {'SAME', s, g, jny, vr} end
  return {'TAKEN'}
end
redis.call('SET', KEYS[1], 'BATCH:1:' .. ARGV[2] .. ':' .. ARGV[1] .. ':' .. ARGV[3] .. ':' .. ARGV[4], 'PXAT', ARGV[5])
return {'BATCHED', ARGV[2]}
`;

// 결과 키가 없을 때 회차 슬롯에서 본다: 게시 전(PENDING), 참가자(MEMBER, 결과 키를 잃음), 참가자 목록에 없음(MISSING, SADD를 잃음)
export const BATCH_STATE_LUA = `
if redis.call('HEXISTS', KEYS[1], 'pub:1') == 0 then return 'PENDING' end
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then return 'MEMBER' end
return 'MISSING'
`;

// 다시 쓰기 청하기: admission-ctrl이 같은 입력으로 결과를 다시 쓰고 지운다. 값은 처음 청한 서버 시각이다
export const REQUEST_REPAIR_LUA = `
local t = redis.call('TIME')
redis.call('HSETNX', KEYS[1], 'repair:1', tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000))
return 1
`;

// 게시 뒤 같은 요청의 묶음 기록을 번호 기록으로 바꾼다. 이미 바뀌었으면(같은 요청의 동시 재시도) 그 기록을 돌려준다
export const CONVERT_LUA = `
local v = redis.call('GET', KEYS[1])
if not v then return {'GONE'} end
local bh, brq, bjny, bvr = string.match(v, ${BATCHED})
if bh and brq == ARGV[1] and bh == ARGV[2] then
  redis.call('SET', KEYS[1], ARGV[3] .. ':' .. ARGV[4] .. ':' .. ARGV[1] .. ':' .. bjny .. ':' .. bvr, 'PXAT', ARGV[5])
  return {'RECORDED', ARGV[3], ARGV[4], bjny, bvr}
end
local s, g, rq, jny, vr = string.match(v, ${RECORDED})
if s and rq == ARGV[1] then return {'RECORDED', s, g, jny, vr} end
return {'GONE'}
`;

// batchMissing: 결과에 없는 같은 요청의 묶음 기록을 지운다
export const DROP_BATCH_LUA = `
local v = redis.call('GET', KEYS[1])
if not v then return 0 end
local bh, brq = string.match(v, ${BATCHED})
if bh and brq == ARGV[1] and bh == ARGV[2] then redis.call('DEL', KEYS[1]) return 1 end
return 0
`;

export const MARK_REMOVED_LUA = `${EXTEND}
redis.call('SETBIT', KEYS[1], ARGV[1], 1)
extend(KEYS[1], ARGV[2])
return 1
`;

// 빠진 번호 비트맵은 회차 일정 사본처럼(판매 종료 + 1일), q:{event:E}:verify는 q:dup처럼(판매 종료) 지운다(docs/data.md §3)
export const MARK_VERIFYING_LUA = `${EXTEND}
redis.call('SETBIT', KEYS[1], ARGV[1], 1)
redis.call('HSETNX', KEYS[2], ARGV[2], ARGV[3])
extend(KEYS[1], ARGV[4])
extend(KEYS[2], ARGV[5])
return 1
`;
