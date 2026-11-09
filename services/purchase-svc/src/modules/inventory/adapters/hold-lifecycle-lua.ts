// 홀드 다시 읽기·해제·연장·주문 표시와 결제 정지 옮기기·되돌리기 Lua의 계약(docs/features/seat-hold.md §5 '해제·연장·다시 읽기와 결제 정지 멈춤의 첫 구현', docs/data.md §3, ADR-0254, BUILD_ORDER HOT-070).
// 규칙은 hold-lua.ts와 같다: 첫 줄 `#!lua`, 키는 모두 KEYS(회차 해시 태그 하나의 슬롯), Redis TIME 한 번, 큰 정수는 string.format('%.0f'), 검사를 모두 마친 뒤에만 쓴다.
// 세대 확인 ensureEpoch는 쓰기 앞에서 돈다(ADR-0210). 형이 틀린 키는 쓰지 않고 'ERR PEAKET_CORRUPT_KEY {키}'다.
//
// HOLD_READ_LUA(no-writes): KEYS 1 epoch, 2.. hold:{좌석}. ARGV 1 holdId 2 owner 3 psid → {'OK', 만료 글, '1'|'0'(연장했나), 토큰 글} | {'NOT_FOUND'} | {'NOT_READY'}
//   좌석마다 holdId·owner·psid·kind(FAN)가 같아야 한다. pin이면 시각을 보지 않는다. rem이 있으면(멈춤) 만료 = 지금 + rem, 아니면 exp이고 지났으면 NOT_FOUND. 만료는 좌석 가운데 가장 이른 값이다.
//
// HOLD_RELEASE_LUA: KEYS 1 bitmap 2 expiry 3 quota:{account} 4 stream 5 epoch 6 secver 7 rel:{account} 8 ordered 9 paused 10.. hold:{좌석}
//   ARGV 1 account 2 holdId 3 psid 4 다시 잡기 대기 ms 5 keepUntil ms 6 구역 채널 앞머리 7 + 6(i − 1) ..: 좌석 i의 6칸(hold-lua.ts와 같다)
//   → {'OK', 푼 수} | {'NOT_FOUND'} | {'PINNED'} | {'NOT_READY'}. 시간이 지났어도 Hash가 있으면 푼다.
//
// HOLD_EXTEND_LUA: KEYS 1 expiry 2 epoch 3.. hold:{좌석}. ARGV 1 account 2 holdId 3 psid 4 연장 ms
//   → {'OK', 새 만료 글, 토큰 글} | {'NOT_FOUND'} | {'ALREADY'} | {'PINNED'} | {'NOT_READY'}
//
// HOLD_MARK_ORDERED_LUA: KEYS 1 ordered 2 epoch 3.. hold:{좌석}. ARGV 1 account 2 holdId 3 psid 4 maxStay ms 5 keepUntil ms 6.. 좌석 색인
//   → {'OK', 넣은 수} | {'NOT_FOUND'} | {'NOT_READY'}. 소유가 하나라도 다르면 아무것도 쓰지 않는다. pin이면 넣지 않는다.
//
// HOLD_FREEZE_LUA: KEYS 1 ordered 2 expiry 3 paused 4 epoch 5.. hold:{좌석}. ARGV 1 정지 시작 ms 2 keepUntil ms 3.. 좌석 색인
//   → {'OK', 옮긴 수, 뺀 수, 망가진 수} | {'NOT_READY'}. 좌석마다 Hash·ordAt·maxStay·exp를 보고 옮기거나 ordered에서만 뺀다(큰 집합을 훑지 않는다).
//
// HOLD_THAW_LUA: KEYS 1 paused 2 expiry 3 ordered 4 epoch 5.. hold:{좌석}. ARGV 1 keepUntil ms 2.. 좌석 색인
//   → {'OK', 되돌린 수, 뺀 수, 망가진 수} | {'NOT_READY'}
import { ENSURE_EPOCH } from './hold-lua.js';

const INT_TEXT = `
local function int(x)
  return string.format('%.0f', x)
end
`;
const EXTEND = `
local function extend(key, ms)
  if redis.call('PEXPIRETIME', key) < ms then redis.call('PEXPIREAT', key, int(ms)) end
end
`;
const GUARDS = `
local function corrupt(key)
  return redis.error_reply('ERR PEAKET_CORRUPT_KEY ' .. key)
end
local function typed(key, want)
  local ty = redis.call('TYPE', key).ok
  return ty == 'none' or ty == want
end
local function canon(v)
  return v == '0' or (#v <= 18 and string.match(v, '^[1-9]%d*$') ~= nil)
end
local function msOf(v)
  if not v or #v > 16 or not string.match(v, '^[0-9]+$') or (#v > 1 and string.sub(v, 1, 1) == '0') then return nil end
  return tonumber(v)
end
`;

/** 홀드 다시 읽기 Lua(위 계약). 첫 줄이 `#!lua flags=no-writes`다 */
export const HOLD_READ_LUA = `#!lua flags=no-writes
${INT_TEXT}${GUARDS}
if #KEYS < 2 then return redis.error_reply('ERR PEAKET_BAD_INPUT hold-read seats') end
if not redis.call('HGET', KEYS[1], 'epoch') then return {'NOT_READY'} end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local earliest = nil
local extended = '0'
local fence = nil
for i = 2, #KEYS do
  if not typed(KEYS[i], 'hash') then return corrupt(KEYS[i]) end
  local h = redis.call('HMGET', KEYS[i], 'holdId', 'owner', 'psid', 'exp', 'ext', 'fence', 'pin', 'rem', 'kind')
  if not h[1] or h[1] ~= ARGV[1] or h[2] ~= ARGV[2] or h[3] ~= ARGV[3] or h[9] ~= 'FAN' then return {'NOT_FOUND'} end
  local exp = msOf(h[4])
  if not exp or not h[6] or not string.match(h[6], '^[1-9]%d*$') then return corrupt(KEYS[i]) end
  local at = exp
  if h[8] then
    local rem = msOf(h[8])
    if not rem then return corrupt(KEYS[i]) end
    at = now + rem
  elseif h[7] ~= '1' and exp <= now then
    return {'NOT_FOUND'}
  end
  if earliest == nil or at < earliest then earliest = at end
  if h[5] and h[5] ~= '0' then extended = '1' end
  fence = h[6]
end
return {'OK', int(earliest), extended, fence}
`;

/** 홀드 해제 Lua(위 계약) */
export const HOLD_RELEASE_LUA = `#!lua
${INT_TEXT}${EXTEND}${GUARDS}${ENSURE_EPOCH}
local n = #KEYS - 9
if n < 1 or #ARGV ~= 6 + 6 * n then
  return redis.error_reply('ERR PEAKET_RELEASE_ARGS KEYS ' .. #KEYS .. ' ARGV ' .. #ARGV)
end
local function at(i, k)
  return ARGV[6 + 6 * (i - 1) + k]
end
local t = redis.call('TIME')
local nowSec = tonumber(t[1])
local now = nowSec * 1000 + math.floor(tonumber(t[2]) / 1000)
local ep = readEpoch(KEYS[5])
if not ep then return {'NOT_READY'} end
local keep = tonumber(ARGV[5])
if not keep or keep <= now then return redis.error_reply('ERR PEAKET_KEEP_UNTIL_PAST keepUntil ' .. ARGV[5] .. ' now ' .. int(now)) end
for _, kt in ipairs({{KEYS[1], 'string'}, {KEYS[2], 'zset'}, {KEYS[4], 'stream'}, {KEYS[6], 'hash'}, {KEYS[7], 'zset'}, {KEYS[8], 'zset'}, {KEYS[9], 'zset'}}) do
  if not typed(kt[1], kt[2]) then return corrupt(kt[1]) end
end
for i = 1, n do
  if not typed(KEYS[9 + i], 'hash') then return corrupt(KEYS[9 + i]) end
end
local idx = {}
local probe = {}
for i = 1, n do
  idx[i] = at(i, 1)
  probe[#probe + 1] = 'GET'
  probe[#probe + 1] = 'u1'
  probe[#probe + 1] = idx[i]
end
local bits = redis.call('BITFIELD_RO', KEYS[1], unpack(probe))
local freed = {}
local hashes = {}
local pinned = false
for i = 1, n do
  if bits[i] == 1 then
    local h = redis.call('HMGET', KEYS[9 + i], 'holdId', 'owner', 'psid', 'fence', 'exp', 'kind', 'pin')
    if h[1] == ARGV[2] and h[2] == ARGV[1] and h[3] == ARGV[3] and h[6] == 'FAN' then
      if h[7] == '1' then pinned = true end
      freed[#freed + 1] = i
      hashes[i] = h
    end
  end
end
local function decided(r)
  ensureEpoch(ep, nowSec)
  return r
end
if pinned then return decided({'PINNED'}) end
local k = #freed
if k == 0 then return decided({'NOT_FOUND'}) end
local heldText = redis.call('GET', KEYS[3]) or '0'
if not canon(heldText) then return corrupt(KEYS[3]) end
local sections = {}
local seen = {}
for _, i in ipairs(freed) do
  local sec = at(i, 2)
  if not seen[sec] then
    seen[sec] = true
    sections[#sections + 1] = sec
  end
end
local secNow = redis.call('HMGET', KEYS[6], unpack(sections))
for j = 1, #sections do
  if secNow[j] and not canon(secNow[j]) then return corrupt(KEYS[6]) end
end
local seatEpoch = ensureEpoch(ep, nowSec)
local clear = {}
local dels = {}
local members = {}
for _, i in ipairs(freed) do
  clear[#clear + 1] = 'SET'
  clear[#clear + 1] = 'u1'
  clear[#clear + 1] = idx[i]
  clear[#clear + 1] = '0'
  dels[#dels + 1] = KEYS[9 + i]
  members[#members + 1] = idx[i]
end
redis.call('BITFIELD', KEYS[1], unpack(clear))
redis.call('DEL', unpack(dels))
redis.call('ZREM', KEYS[2], unpack(members))
redis.call('ZREM', KEYS[8], unpack(members))
redis.call('ZREM', KEYS[9], unpack(members))
local left = tonumber(heldText) - k
if left <= 0 then
  redis.call('DEL', KEYS[3])
else
  redis.call('SET', KEYS[3], int(left), 'KEEPTTL')
end
-- 방금 놓은 좌석(지난 점수 지우기 → 지금 + 대기 → 수명 = 대기)
local relScore = int(now + tonumber(ARGV[4]))
redis.call('ZREMRANGEBYSCORE', KEYS[7], '-inf', int(now))
local z = {}
for _, i in ipairs(freed) do
  z[#z + 1] = relScore
  z[#z + 1] = idx[i]
end
redis.call('ZADD', KEYS[7], unpack(z))
redis.call('PEXPIRE', KEYS[7], ARGV[4])
local version = {}
local deltas = {}
for _, sec in ipairs(sections) do
  version[sec] = redis.call('HINCRBY', KEYS[6], sec, 1)
  deltas[sec] = {}
end
for _, i in ipairs(freed) do
  local d = deltas[at(i, 2)]
  d[#d + 1] = at(i, 3) .. ':0'
end
local nowText = int(now)
for _, i in ipairs(freed) do
  local h = hashes[i]
  redis.call('XADD', KEYS[4], '*',
    'type', 'RELEASED', 'seatIdx', idx[i], 'seatId', at(i, 4), 'tierId', at(i, 5), 'sectionId', at(i, 6),
    'holdId', h[1], 'holdKind', h[6], 'purchaseSessionId', h[3] or '', 'accountId', h[2],
    'fencingToken', h[4] or '', 'sectionVersion', int(version[at(i, 2)]), 'seatEpoch', seatEpoch,
    'occurredAtMs', nowText, 'expiresAtMs', h[5] or '')
end
for _, sec in ipairs(sections) do
  redis.call('SPUBLISH', ARGV[6] .. sec, '1 ' .. seatEpoch .. ' ' .. sec .. ' ' .. int(version[sec]) .. ' ' .. nowText .. ' ' .. table.concat(deltas[sec], ' '))
end
extend(KEYS[4], keep)
extend(KEYS[6], keep)
return {'OK', k}
`;

/** 홀드 1회 연장 Lua(위 계약) */
export const HOLD_EXTEND_LUA = `#!lua
${INT_TEXT}${GUARDS}${ENSURE_EPOCH}
local n = #KEYS - 2
if n < 1 or #ARGV ~= 4 then return redis.error_reply('ERR PEAKET_EXTEND_ARGS') end
local t = redis.call('TIME')
local nowSec = tonumber(t[1])
local now = nowSec * 1000 + math.floor(tonumber(t[2]) / 1000)
local ep = readEpoch(KEYS[2])
if not ep then return {'NOT_READY'} end
if not typed(KEYS[1], 'zset') then return corrupt(KEYS[1]) end
local add = tonumber(ARGV[4])
local earliest = nil
local fence = nil
local frozen = false
local pinned = false
local used = false
local members = {}
local rems = {}
for i = 1, n do
  local hk = KEYS[2 + i]
  if not typed(hk, 'hash') then return corrupt(hk) end
  local h = redis.call('HMGET', hk, 'holdId', 'owner', 'psid', 'exp', 'ext', 'fence', 'pin', 'rem', 'kind')
  if not h[1] or h[1] ~= ARGV[2] or h[2] ~= ARGV[1] or h[3] ~= ARGV[3] or h[9] ~= 'FAN' then return {'NOT_FOUND'} end
  local exp = msOf(h[4])
  if not exp then return corrupt(hk) end
  if h[7] == '1' then pinned = true end
  if h[5] and h[5] ~= '0' then used = true end
  if h[8] then
    local rem = msOf(h[8])
    if not rem then return corrupt(hk) end
    frozen = true
    rems[i] = rem
  elseif exp <= now and h[7] ~= '1' then
    return {'NOT_FOUND'}
  end
  if earliest == nil or exp < earliest then earliest = exp end
  fence = h[6]
  members[i] = string.match(hk, '(%d+)$')
end
local function decided(r)
  ensureEpoch(ep, nowSec)
  return r
end
if pinned then return decided({'PINNED'}) end
if used then return decided({'ALREADY'}) end
ensureEpoch(ep, nowSec)
if frozen then
  local least = nil
  for i = 1, n do
    local v = rems[i] or 0
    redis.call('HSET', KEYS[2 + i], 'rem', int(v + add), 'ext', '1')
    if least == nil or v < least then least = v end
  end
  return {'OK', int(now + least + add), fence}
end
local nextExp = earliest + add
local nextText = int(nextExp)
local pairs_ = {}
for i = 1, n do
  redis.call('HSET', KEYS[2 + i], 'exp', nextText, 'ext', '1')
  pairs_[#pairs_ + 1] = nextText
  pairs_[#pairs_ + 1] = members[i]
end
redis.call('ZADD', KEYS[1], 'XX', unpack(pairs_))
return {'OK', nextText, fence}
`;

/** 주문 표시 Lua(위 계약) */
export const HOLD_MARK_ORDERED_LUA = `#!lua
${INT_TEXT}${EXTEND}${GUARDS}
local n = #KEYS - 2
if n < 1 or #ARGV ~= 5 + n then return redis.error_reply('ERR PEAKET_MARK_ARGS') end
if not redis.call('HGET', KEYS[2], 'epoch') then return {'NOT_READY'} end
if not typed(KEYS[1], 'zset') then return corrupt(KEYS[1]) end
local t = redis.call('TIME')
local now = int(tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000))
local pinned = false
for i = 1, n do
  if not typed(KEYS[2 + i], 'hash') then return corrupt(KEYS[2 + i]) end
  local h = redis.call('HMGET', KEYS[2 + i], 'holdId', 'owner', 'psid', 'pin')
  if h[1] ~= ARGV[2] or h[2] ~= ARGV[1] or h[3] ~= ARGV[3] then return {'NOT_FOUND'} end
  if h[4] == '1' then pinned = true end
end
if pinned then return {'OK', 0} end
local added = 0
for i = 1, n do
  redis.call('HSETNX', KEYS[2 + i], 'ordAt', now)
  redis.call('HSETNX', KEYS[2 + i], 'maxStay', ARGV[4])
  added = added + redis.call('ZADD', KEYS[1], 'NX', redis.call('HGET', KEYS[2 + i], 'ordAt'), ARGV[5 + i])
end
extend(KEYS[1], tonumber(ARGV[5]))
return {'OK', added}
`;

/** 결제 정지 옮기기 Lua(위 계약) */
export const HOLD_FREEZE_LUA = `#!lua
${INT_TEXT}${EXTEND}${GUARDS}
local n = #KEYS - 4
if n < 1 or #ARGV ~= 2 + n then return redis.error_reply('ERR PEAKET_FREEZE_ARGS') end
if not redis.call('HGET', KEYS[4], 'epoch') then return {'NOT_READY'} end
for _, kt in ipairs({{KEYS[1], 'zset'}, {KEYS[2], 'zset'}, {KEYS[3], 'zset'}}) do
  if not typed(kt[1], kt[2]) then return corrupt(kt[1]) end
end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local since = tonumber(ARGV[1])
local moved, dropped, bad = 0, 0, 0
for i = 1, n do
  local m = ARGV[2 + i]
  local hk = KEYS[4 + i]
  local ty = redis.call('TYPE', hk).ok
  if ty == 'none' then
    redis.call('ZREM', KEYS[1], m)
    dropped = dropped + 1
  elseif ty ~= 'hash' then
    redis.call('ZREM', KEYS[1], m)
    bad = bad + 1
  else
    local h = redis.call('HMGET', hk, 'exp', 'ordAt', 'maxStay', 'pin', 'rem')
    local exp, ordAt, maxStay = msOf(h[1]), msOf(h[2]), msOf(h[3])
    if not exp or not ordAt or not maxStay then
      redis.call('ZREM', KEYS[1], m)
      bad = bad + 1
    elseif h[4] == '1' or h[5] or maxStay <= now or not redis.call('ZSCORE', KEYS[2], m) then
      redis.call('ZREM', KEYS[1], m)
      dropped = dropped + 1
    else
      local rem = exp - math.max(since, ordAt)
      if rem <= 0 then
        redis.call('ZREM', KEYS[1], m)
        dropped = dropped + 1
      else
        redis.call('ZREM', KEYS[1], m)
        redis.call('ZREM', KEYS[2], m)
        redis.call('ZADD', KEYS[3], int(maxStay), m)
        redis.call('HSET', hk, 'rem', int(rem))
        moved = moved + 1
      end
    end
  end
end
if moved > 0 then extend(KEYS[3], tonumber(ARGV[2])) end
return {'OK', moved, dropped, bad}
`;

/** 결제 정지 되돌리기 Lua(위 계약). 최대 체류에 닿은 홀드의 회수에도 쓴다 */
export const HOLD_THAW_LUA = `#!lua
${INT_TEXT}${EXTEND}${GUARDS}
local n = #KEYS - 4
if n < 1 or #ARGV ~= 1 + n then return redis.error_reply('ERR PEAKET_THAW_ARGS') end
if not redis.call('HGET', KEYS[4], 'epoch') then return {'NOT_READY'} end
for _, kt in ipairs({{KEYS[1], 'zset'}, {KEYS[2], 'zset'}, {KEYS[3], 'zset'}}) do
  if not typed(kt[1], kt[2]) then return corrupt(kt[1]) end
end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local moved, dropped, bad = 0, 0, 0
local keep = tonumber(ARGV[1])
local reordered = false
for i = 1, n do
  local m = ARGV[1 + i]
  local hk = KEYS[4 + i]
  local ty = redis.call('TYPE', hk).ok
  redis.call('ZREM', KEYS[1], m)
  if ty == 'none' then
    dropped = dropped + 1
  elseif ty ~= 'hash' then
    bad = bad + 1
  else
    local h = redis.call('HMGET', hk, 'rem', 'maxStay', 'ordAt', 'pin')
    if h[4] == '1' then
      redis.call('HDEL', hk, 'rem')
      dropped = dropped + 1
    else
      local rem = msOf(h[1])
      local maxStay = msOf(h[2])
      local nextExp = now
      if rem then
        nextExp = now + rem
      else
        bad = bad + 1
      end
      if maxStay and maxStay < nextExp then nextExp = maxStay end
      local text = int(nextExp)
      redis.call('HSET', hk, 'exp', text)
      redis.call('HDEL', hk, 'rem')
      redis.call('ZADD', KEYS[2], text, m)
      if rem then moved = moved + 1 end
      if nextExp > now and h[3] then
        redis.call('ZADD', KEYS[3], 'NX', h[3], m)
        reordered = true
      end
    end
  end
end
if reordered then extend(KEYS[3], keep) end
return {'OK', moved, dropped, bad}
`;
