// 추가 검증의 대기열 Redis Lua(docs/data.md §3 verify·q:appeal·q:appealcase·q:vsub, §5 경합 ①②③, ADR-0259).
// 문자열만 두고 아무것도 가져오지 않는다. 회차 Lua는 서버 시각(TIME)을 쓴다(입장 확정이 유예를 같은 시계로 센다).
// 사람 키(q:vsub·q:appeal, pid 해시 태그)와 회차 키(verify, {event:E} 태그)·색인 키(q:appealid·q:appealcase)는 슬롯이 달라 한 Lua로 묶지 않는다.

// 회차 슬롯: 칸이 VERIFYING일 때만 {목표}:{서버 시각}:{사유}로 바꾼다(제출 통과·이의 인정은 PASSED, 이의 기각은 BLOCKED). 빠진 번호 비트는 건드리지 않는다.
// KEYS: 1 verify, 2 serving   ARGV: 1 필드(대기표·참가 토큰 해시), 2 목표(PASSED·BLOCKED)
// 돌려주는 값: {'APPLIED', 새 값, serving} {'CURRENT', 지금 값, serving}(VERIFYING이 아니라 그대로 둠) {'GONE', '', serving}(칸 없음)
export const SETTLE_VERIFY_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local serving = redis.call('GET', KEYS[2]) or '0'
local v = redis.call('HGET', KEYS[1], ARGV[1])
if not v then return {'GONE', '', serving} end
local st, why = string.match(v, '^(%u+):%d+:?(.*)$')
if st == 'VERIFYING' then
  local nv = ARGV[2] .. ':' .. string.format('%d', now) .. ':' .. (why or '')
  redis.call('HSET', KEYS[1], ARGV[1], nv)
  return {'APPLIED', nv, serving}
end
return {'CURRENT', v, serving}
`;

// 회차 슬롯(읽기만): serving과, 번호의 차례가 왔으면 그 차례 시각(serving_log에서 번호 이상인 첫 칸의 초 × 1000). 입장 확정 확인 Lua와 같은 읽기다.
// KEYS: 1 serving, 2 serving_log   ARGV: 1 번호   돌려주는 값: {serving, 차례 시각(없으면 -1)}
export const TURN_OF_LUA = `
local serving = tonumber(redis.call('GET', KEYS[1]) or '0')
local turnAt = -1
if tonumber(ARGV[1]) <= serving then
  local first = redis.call('ZRANGE', KEYS[2], ARGV[1], '+inf', 'BYSCORE', 'LIMIT', 0, 1)
  if first[1] then turnAt = tonumber(first[1]) * 1000 end
end
return {serving, turnAt}
`;

// 사람 슬롯: challengeToken 제출 하나를 센다. 첫 제출이 창 수명으로 키를 만들고 뒤 제출은 수명을 늘리지 않는다.
// 수명은 키에 수명이 없을 때(새로 만든 키)만 건다: 되돌리기로 0이 된 키 뒤의 INCR이 1이어도 첫 제출에 정한 마감을 그대로 둔다(메모리 저장소와 같다)
// KEYS: 1 q:vsub   ARGV: 1 창(ms)   돌려주는 값: {이번까지의 수, 남은 수명(ms)}
export const COUNT_SUBMIT_LUA = `
local n = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {n, ttl}
`;

// 사람 슬롯: 센 제출 하나를 되돌린다(trust-svc를 부르지 못한 503, ADR-0259 결정 12). 0 아래로 내리지 않고 수명은 그대로 둔다
// KEYS: 1 q:vsub
export const UNCOUNT_SUBMIT_LUA = `
local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n > 0 then redis.call('DECR', KEYS[1]) end
return n
`;

/**
 * q:appeal 칸 이름(docs/data.md §3): 이의 ID, 계정, 대기표 해시, 사유 범주, 글, eventKey, 접수 시각, 수명, 보낸 표시, 반영한 건·판·결과,
 * verify 칸을 실제로 바꾼 결과(ap, 상태 읽기의 passedVia), 진행 표지(pc·pv·po: 건·판·결과)
 */
export const APPEAL_FIELDS = ['id', 'acc', 'th', 'cat', 'txt', 'ek', 'at', 'exp', 'sent', 'cid', 'cv', 'res', 'ap'] as const;

// 사람 슬롯: 이의를 처음 것만 둔다(HSETNX, 경합 ②). 같은 대기 참여(대기표 해시)의 이의가 있으면 그대로 두고 그 값을 준다.
// 다른 대기 참여의 이의(취소 뒤 다시 줄 선 사람의 지난 이의)면 새 대기 참여의 이의로 바꾼다(한 대기 참여에 한 번, 키는 사람·회차 하나라서).
// KEYS: 1 q:appeal   ARGV: 1 이의 ID, 2 계정, 3 대기표 해시, 4 사유 범주, 5 글, 6 eventKey, 7 접수 시각, 8 수명(PXAT)
// 돌려주는 값: {'NEW' 또는 'EXISTING', APPEAL_FIELDS 차례의 값들}
export const OPEN_APPEAL_LUA = `
local th = redis.call('HGET', KEYS[1], 'th')
if th and th ~= ARGV[3] then redis.call('DEL', KEYS[1]) end
local kind = 'EXISTING'
if redis.call('HSETNX', KEYS[1], 'id', ARGV[1]) == 1 then
  redis.call('HSET', KEYS[1], 'acc', ARGV[2], 'th', ARGV[3], 'cat', ARGV[4], 'txt', ARGV[5], 'ek', ARGV[6], 'at', ARGV[7], 'exp', ARGV[8])
  redis.call('PEXPIREAT', KEYS[1], ARGV[8])
  kind = 'NEW'
end
local out = {kind}
for i, v in ipairs(redis.call('HMGET', KEYS[1], ${APPEAL_FIELDS.map((f) => `'${f}'`).join(', ')})) do out[i + 1] = v or '' end
return out
`;

// 사람 슬롯: 건 요청 발행이 확인됐다. 이의 ID가 같을 때만 쓴다. 처음 표시했으면 1
// KEYS: 1 q:appeal   ARGV: 1 이의 ID
export const MARK_SENT_LUA = `
if redis.call('HGET', KEYS[1], 'id') ~= ARGV[1] then return 0 end
return redis.call('HSETNX', KEYS[1], 'sent', '1')
`;

// 건 ID 색인(SET NX): 비었으면 이의 ID를 두고, 있으면 그대로 둔다. 그 건에 묶인 이의 ID를 준다
// KEYS: 1 q:appealcase   ARGV: 1 이의 ID, 2 수명(PXAT)
export const CLAIM_CASE_LUA = `
local v = redis.call('GET', KEYS[1])
if v then return v end
redis.call('SET', KEYS[1], ARGV[1], 'PXAT', ARGV[2])
return ARGV[1]
`;

// 사람 슬롯: 결과 반영 시작. 판이 저장한 판보다 클 때만 진행 표지(건·판·결과)를 남기고 PROCEED다. 같은 표지가 이미 있으면 끊긴 호출의 다시 부름(retry 1)이다.
// 판 번호는 숫자로 견준다(9 → 10). 다른 건이 이미 반영했으면 OTHER_CASE
// KEYS: 1 q:appeal   ARGV: 1 이의 ID, 2 건 ID, 3 판, 4 결과(ACCEPTED·REJECTED)
// 돌려주는 값: {'NOT_FOUND'} {'OTHER_CASE'} {'UNCHANGED'} {'PROCEED', retry 1/0}
export const BEGIN_RESOLVE_LUA = `
local a = redis.call('HMGET', KEYS[1], 'id', 'cid', 'cv', 'pc', 'pv', 'po')
if a[1] ~= ARGV[1] then return {'NOT_FOUND'} end
if a[2] and a[2] ~= ARGV[2] then return {'OTHER_CASE'} end
if tonumber(ARGV[3]) <= tonumber(a[3] or '0') then return {'UNCHANGED'} end
local retry = 0
if a[4] == ARGV[2] and a[5] == ARGV[3] and a[6] == ARGV[4] then retry = 1 end
redis.call('HSET', KEYS[1], 'pc', ARGV[2], 'pv', ARGV[3], 'po', ARGV[4])
return {'PROCEED', retry}
`;

// 사람 슬롯: 결과 반영 끝. 회차 쓰기 뒤에 판 번호·결과를 올리고 진행 표지를 지운다(판이 저장한 판보다 클 때만).
// verify 칸을 이번에 바꿨으면(APPLIED) 그 결과(ACCEPTED·REJECTED)를 ap에 남긴다(한 이의에서 한 번뿐이다)
// KEYS: 1 q:appeal   ARGV: 1 이의 ID, 2 건 ID, 3 판, 4 결과(APPLIED·NOT_ISOLATED), 5 이의 결과(ACCEPTED·REJECTED)
export const COMMIT_RESOLVE_LUA = `
local a = redis.call('HMGET', KEYS[1], 'id', 'cv')
if a[1] ~= ARGV[1] then return 0 end
if tonumber(ARGV[3]) <= tonumber(a[2] or '0') then return 0 end
redis.call('HSET', KEYS[1], 'cid', ARGV[2], 'cv', ARGV[3], 'res', ARGV[4])
if ARGV[4] == 'APPLIED' then redis.call('HSET', KEYS[1], 'ap', ARGV[5]) end
redis.call('HDEL', KEYS[1], 'pc', 'pv', 'po')
return 1
`;
