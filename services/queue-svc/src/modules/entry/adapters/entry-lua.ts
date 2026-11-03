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

// ② enterNumber: 서버 시각(TIME)으로 구간을 보고, 로비 표시 → 묶음(구간 안이면 SADD, 오픈 뒤 발급 토큰은 WAIT) → 닫힘 표시 → INCR.
// 표시 값은 {첫 번호}:{크기}:{세대}이고 HSETNX라 리더와 겹쳐도 몫마다 한 번만 전진한다(중간-028). 참가자 목록(토큰 해시)은 판매 종료까지만 둔다
export const NUMBER_LUA = `${EXTEND}
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if now < tonumber(ARGV[2]) then return {'EARLY'} end
local gen = redis.call('LLEN', KEYS[2]) + 1
if ARGV[4] == '1' and redis.call('HEXISTS', KEYS[3], 'lobby') == 0 then
  local n = redis.call('SCARD', KEYS[5])
  local first = tonumber(redis.call('GET', KEYS[1]) or '0') + 1
  redis.call('HSETNX', KEYS[3], 'lobby', first .. ':' .. n .. ':' .. gen)
  if n > 0 then redis.call('INCRBY', KEYS[1], n) end
end
if ARGV[5] == '1' then
  local closeAt = tonumber(ARGV[3])
  local closed = redis.call('HEXISTS', KEYS[3], '1') == 1
  if not closed and now < closeAt then
    if ARGV[6] ~= '1' then return {'WAIT', math.ceil((closeAt - now) / 1000)} end
    redis.call('SADD', KEYS[4], ARGV[7])
    extend(KEYS[4], ARGV[8])
    extend(KEYS[3], ARGV[1])
    return {'BATCHING'}
  end
  if not closed then
    local size = redis.call('SCARD', KEYS[4])
    local first = tonumber(redis.call('GET', KEYS[1]) or '0') + 1
    redis.call('HSETNX', KEYS[3], '1', first .. ':' .. size .. ':' .. gen)
    if size > 0 then redis.call('INCRBY', KEYS[1], size) end
  end
end
local seq = redis.call('INCR', KEYS[1])
extend(KEYS[1], ARGV[1])
extend(KEYS[3], ARGV[1])
return {'NUMBERED', seq, gen}
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
