// 다시 만들기(RB-06)·세대 올리기 Lua의 계약(BUILD_ORDER PRF-143, docs/features/seat-hold.md §6 '다시 만들기(RB-06)의 첫 구현', docs/data.md §3 좌석 키 표).
// 규칙은 hold-lua.ts와 같다(`#!lua`, 키는 모두 KEYS로 회차 해시 태그 하나의 슬롯, TIME 한 번, 큰 정수는 string.format('%.0f'), 검사 뒤 쓰기, 형이 틀린 키는 'ERR PEAKET_CORRUPT_KEY {키}').
// 메모리 구현(memory-seat-store.ts)이 같은 계약을 따른다.
//
// 시도마다(코드 리뷰로 고침): BEGIN_REBUILD_LUA(gen) → REBUILD_SEATS_LUA(gen)들 → REBUILD_QUOTAS_LUA(gen)들(200계정씩) → FINISH_REBUILD_LUA(gen).
// 시작이 rebuild 키 s:{event:E}:rebuild에 판 번호 gen을 쓰고, 뒤의 Lua는 저장된 값 = 내 gen일 때만 쓴다(아니면 {'STALE'}): 앞 시도·임대가 지난 늦은 파드의 잔여 쓰기를 막는다.
// 세대 키가 이미 있으면 어느 Lua든 {'READY', 세대 키의 gen 칸(없으면 '1')}이다(STALE보다 앞). gen 칸이 앞 0 없는 양의 10진 정수(15자리 이하)가 아니면 PEAKET_CORRUPT_KEY.
// rebuild 키가 string이 아니거나 값이 앞 0 없는 양의 10진 정수(15자리 이하)가 아니면 'ERR PEAKET_CORRUPT_KEY {rebuild 키}'.
//
// BEGIN_REBUILD_LUA: 시도 열기
// KEYS: 1 bitmap  2 expiry  3 epoch  4 rebuild   ARGV: 1 gen  2 keepUntil ms
// 검사: 세대 키 → {'READY', gen}, 저장된 rebuild 판 번호 > gen → {'STALE'}, TIME 한 번 뒤 keepUntil ≤ now → PEAKET_KEEP_UNTIL_PAST
// 쓰기: DEL bitmap expiry(앞 시도가 쓴 비트·만료 인덱스), SET rebuild gen PXAT keepUntil → {'OK'}
// - 인자 수가 맞지 않거나(#KEYS ≠ 4 또는 #ARGV ≠ 2) gen이 앞 0 없는 양의 10진 정수(15자리 이하)가 아니면 'ERR PEAKET_BEGIN_ARGS …'.
// - 같은 gen으로 다시 불러도 OK(다시 지운다). 홀드 Hash·보유 수는 지우지 않는다(비트 0인 좌석의 남은 Hash는 홀드·묶기가 DEL 뒤 다시 쓴다.
//   보유 수 키는 계정을 몰라 지우지 못해 앞 시도의 계정 보유 수가 남을 수 있다: 많게 세는 쪽이라 안전, 알려진 한계).
//
// REBUILD_SEATS_LUA: 좌석들을 쓴다(REBUILD_BATCH석 이하)
// KEYS: 1 bitmap  2 expiry  3 epoch  4 rebuild  5.. hold:{좌석 색인}(ARGV 좌석 차례)
// ARGV: 1 keepUntil ms  2 gen, 그다음 좌석마다 10칸: 좌석 색인, 방식(S = 판매 묶음, H = 되살린 홀드), holdId, owner, psid, fence(토큰 글), heldAt ms, exp ms,
//       kind(FAN·PRIORITY, S는 'FAN'), 예비 칸 ''(10칸 고정). S의 fence·heldAt·exp는 대조한 원장 행의 값이거나 셋 다 ''(원장 행 없음)이다
// 검사: 세대 키 → {'READY', gen}, rebuild 키 ≠ gen → {'STALE'}(아무것도 쓰지 않는다)
// 쓰기: 좌석마다 BITFIELD SET u1 1, DEL 뒤 HSET hold(holdId·owner·psid·fence·heldAt·exp·kind·ext '0', S는 pin '1'), PEXPIREAT keepUntil.
//       S의 '' 칸은 fence = TIME µs, heldAt = exp = 지금 ms로 채운다(실패 해제의 RELEASED 토큰이 1 이상이게).
//       H만 ZADD expiry exp 색인. bitmap·expiry의 수명은 더 늦은 쪽으로 keepUntil → {'OK', 쓴 수}
//
// 구현에서 정한 세부(PRF-143)
// - 인자 수가 맞지 않으면(n < 1 또는 #ARGV ≠ 2 + 10n) 'ERR PEAKET_REBUILD_ARGS …'. gen 모양이 틀리거나 방식 칸이 S·H가 아니거나 S의 fence·heldAt·exp가
//   셋 다 ''도 셋 다 10진 숫자도 아니어도 같다(쓰기 전에 본다).
// - epoch가 hash가 아니면(키가 없으면 통과) 'ERR PEAKET_CORRUPT_KEY {epoch 키}'(READY 판정보다 앞). READY·STALE이 아니면 TIME을 한 번 읽어 keepUntil ≤ now면
//   'ERR PEAKET_KEEP_UNTIL_PAST …', bitmap string·expiry zset·hold:{색인} hash가 아니면(키가 없으면 통과) 'ERR PEAKET_CORRUPT_KEY {키}'.
// - S 좌석은 ZREM expiry 그 색인도 한다(앞서 H로 썼던 좌석이 판매로 바뀌었으면 만료 인덱스에 남지 않게).
// - 명령 묶기: BITFIELD 한 번, DEL 한 번, ZADD·ZREM 한 번씩(unpack 인자는 많아야 4 × 200 = 800개).
// - 펜싱 카운터·보유 수·Stream·구역 일련번호·샤드 Pub/Sub·회차 목록은 쓰지 않는다(보유 수는 REBUILD_QUOTAS_LUA, 펜싱 카운터·세대 키는 FINISH_REBUILD_LUA, 회차 목록은 앱).
//
// REBUILD_QUOTAS_LUA: 보유 수(세대 키 전에 200계정씩)
// KEYS: 1 epoch  2 rebuild  3.. quota:{계정}(ARGV 계정 차례)   ARGV: 1 gen  2 keepUntil ms, 그다음 계정마다 보유 수(10진 글, 1 이상)
// 검사: 세대 키 → {'READY', gen}, rebuild 키 ≠ gen → {'STALE'}. 쓰기: 계정마다 SET quota 수 PXAT keepUntil(옛 값에 더하지 않고 그 값으로) → {'OK', 쓴 수}
// - 인자 수가 맞지 않거나(m < 1 또는 #ARGV ≠ 2 + m) gen·보유 수 모양이 틀리면 'ERR PEAKET_QUOTAS_ARGS …'. TIME 한 번 뒤 keepUntil ≤ now면 PEAKET_KEEP_UNTIL_PAST,
//   quota:{계정}이 string이 아니면 PEAKET_CORRUPT_KEY.
//
// FINISH_REBUILD_LUA: 펜싱 카운터와 세대 키(마지막)
// KEYS: 1 epoch  2 rebuild  3 fence   ARGV: 1 gen  2 node  3 keepUntil ms  4 되살린 토큰 최댓값(표준 10진 글, 없으면 '0')
// 검사: 세대 키 → {'READY', gen}, rebuild 키 ≠ gen → {'STALE'}
// 쓰기: fence = max(fence, 최댓값)(SET … KEEPTTL, 수명은 더 늦은 쪽으로 keepUntil), 마지막에 HSET epoch epoch = TIME 초 · node · gen, PEXPIREAT keepUntil → {'OK', epoch}
//
// 구현에서 정한 세부(PRF-143)
// - 인자 수가 맞지 않거나(#KEYS ≠ 3 또는 #ARGV ≠ 4) gen이 앞 0 없는 양의 10진 정수(15자리 이하)가 아니거나 최댓값이 표준 10진 정수가 아니면 'ERR PEAKET_FINISH_ARGS …'.
// - epoch가 hash가 아니면 PEAKET_CORRUPT_KEY(READY 판정보다 앞). TIME 한 번 뒤 keepUntil ≤ now면 PEAKET_KEEP_UNTIL_PAST, fence가 string이 아니거나 값이 ^%d+$가 아니면
//   PEAKET_CORRUPT_KEY(hold-lua.ts와 같은 글). rebuild 키는 지우지 않는다(수명 keepUntil, 세대 키가 선 뒤에는 READY가 먼저다).
// - 회차 목록 s:ctl:events는 다른 슬롯이라 앱(RedisSeatStore.finish)이 이 Lua들 앞에 SADD한다(여러 번 해도 같다).
//
// BUMP_EPOCH_LUA: 장애 조치 뒤 세대 올리기(ADR-0121 결정 5)
// KEYS: 1 epoch   ARGV: 1 node(지금 주 노드 표지)
// epoch 칸이 없으면 {'NOT_READY'}, node가 같으면 {'SAME', epoch}, 다르면 epoch = max(epoch + 1, TIME 초)와 node를 쓰고 {'BUMPED', epoch}(gen은 그대로)
//
// 구현에서 정한 세부(PRF-143)
// - 인자 수가 맞지 않으면(#KEYS ≠ 1 또는 #ARGV ≠ 1) 'ERR PEAKET_BUMP_ARGS …'. epoch가 hash가 아니거나 epoch 칸이 표준 10진 정수가 아니면 PEAKET_CORRUPT_KEY.
// - TIME은 node가 다를 때만 한 번 읽는다. 키 수명은 바꾸지 않는다(HSET은 수명을 두고 칸만 바꾼다).

/** 큰 정수를 지수 표기 없이 10진 글로(hold-lua.ts와 같은 도우미) */
const INT_TEXT = `
local function int(x)
  return string.format('%.0f', x)
end
`;

// 키 수명은 더 늦은 쪽으로만 늘린다(hold-lua.ts와 같은 도우미). 키가 없으면(-2) PEXPIREAT가 아무것도 하지 않는다
const EXTEND = `
local function extend(key, ms)
  if redis.call('PEXPIRETIME', key) < ms then redis.call('PEXPIREAT', key, int(ms)) end
end
`;

// 형·값 지킴 도우미(pin-lua.ts와 같은 규칙)
const GUARDS = `
local function corrupt(key)
  return redis.error_reply('ERR PEAKET_CORRUPT_KEY ' .. key)
end
local function typed(key, want)
  local ty = redis.call('TYPE', key).ok
  return ty == 'none' or ty == want
end
-- 표준 10진 정수(A1): '0'이거나 첫 자리 1~9에 18자리 이하
local function canon(v)
  return v == '0' or (#v <= 18 and string.match(v, '^[1-9]%d*$') ~= nil)
end
-- 서버 시각(ms, 초 글, µs)
local function nowMs()
  local t = redis.call('TIME')
  return tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000), t[1], tonumber(t[1]) * 1000000 + tonumber(t[2])
end
`;

// 판 번호 대조 도우미(시작·좌석·보유 수·끝내기 Lua가 같이 쓴다, 코드 리뷰 PRF-143)
const GEN_FENCE = `
-- 판 번호 모양: 앞 0 없는 양의 10진 정수(15자리 이하)
local function genOk(v)
  return v ~= nil and #v <= 15 and string.match(v, '^[1-9]%d*$') ~= nil
end
-- 세대 키가 있으면 {'READY', gen}(형·gen 칸이 틀리면 오류 답), 없으면 nil
local function ready(epochKey)
  if not typed(epochKey, 'hash') then return corrupt(epochKey) end
  local ep = redis.call('HMGET', epochKey, 'epoch', 'gen')
  if not ep[1] then return nil end
  local g = ep[2] or '1'
  if not genOk(g) then return corrupt(epochKey) end
  return {'READY', g}
end
-- 저장된 rebuild 판 번호(없으면 nil). 형·값이 틀리면 false
local function storedGen(key)
  if not typed(key, 'string') then return false end
  local v = redis.call('GET', key)
  if not v then return nil end
  if not genOk(v) then return false end
  return tonumber(v)
end
-- 세대 키 → READY, rebuild 키 ≠ gen → STALE, 둘 다 아니면 nil
local function fenced(epochKey, rebuildKey, genText)
  local r = ready(epochKey)
  if r then return r end
  local g = storedGen(rebuildKey)
  if g == false then return corrupt(rebuildKey) end
  if g == nil or g ~= tonumber(genText) then return {'STALE'} end
  return nil
end
`;

/** 다시 만들기 시작 Lua 원문(위 계약). 첫 줄이 #!lua다 */
export const BEGIN_REBUILD_LUA = `#!lua
${INT_TEXT}${GUARDS}${GEN_FENCE}
if #KEYS ~= 4 or #ARGV ~= 2 then
  return redis.error_reply('ERR PEAKET_BEGIN_ARGS KEYS ' .. #KEYS .. ' ARGV ' .. #ARGV)
end
local genText = ARGV[1]
if not genOk(genText) then return redis.error_reply('ERR PEAKET_BEGIN_ARGS gen ' .. tostring(genText)) end

-- 1 세대 키(있으면 다른 곳이 이미 다시 만들었다)와 더 새 시도
local r = ready(KEYS[3])
if r then return r end
local g = storedGen(KEYS[4])
if g == false then return corrupt(KEYS[4]) end
if g ~= nil and g > tonumber(genText) then return {'STALE'} end

-- 2 앞 시도가 쓴 비트·만료 인덱스를 지우고 내 판 번호를 적는다
local now = nowMs()
local keep = tonumber(ARGV[2])
if not keep or keep <= now then return redis.error_reply('ERR PEAKET_KEEP_UNTIL_PAST keepUntil ' .. ARGV[2] .. ' now ' .. int(now)) end
redis.call('DEL', KEYS[1], KEYS[2])
redis.call('SET', KEYS[4], genText, 'PXAT', int(keep))
return {'OK'}
`;

/** 다시 만들기 좌석 쓰기 Lua 원문(위 계약). 첫 줄이 #!lua다 */
export const REBUILD_SEATS_LUA = `#!lua
${INT_TEXT}${EXTEND}${GUARDS}${GEN_FENCE}
local n = #KEYS - 4
if n < 1 or #ARGV ~= 2 + 10 * n then
  return redis.error_reply('ERR PEAKET_REBUILD_ARGS KEYS ' .. #KEYS .. ' ARGV ' .. #ARGV)
end
local function at(i, k)
  return ARGV[2 + 10 * (i - 1) + k]
end
if not genOk(ARGV[2]) then return redis.error_reply('ERR PEAKET_REBUILD_ARGS gen ' .. tostring(ARGV[2])) end
for i = 1, n do
  local m = at(i, 2)
  if m ~= 'S' and m ~= 'H' then return redis.error_reply('ERR PEAKET_REBUILD_ARGS mode ' .. tostring(m)) end
  if m == 'S' then
    local blank = at(i, 6) == '' and at(i, 7) == '' and at(i, 8) == ''
    local digits = string.match(at(i, 6), '^%d+$') and string.match(at(i, 7), '^%d+$') and string.match(at(i, 8), '^%d+$')
    if not blank and not digits then return redis.error_reply('ERR PEAKET_REBUILD_ARGS sold ' .. at(i, 1)) end
  end
end

-- 1 세대 키(있으면 다른 곳이 이미 다시 만들었다)와 판 번호(내 시도가 아니면 STALE)
local stop = fenced(KEYS[3], KEYS[4], ARGV[2])
if stop then return stop end

-- 쓰기 전 지킴(여기까지 아무것도 쓰지 않았다). 서버 시각은 여기서 한 번만 읽는다
local now, _, us = nowMs()
local keep = tonumber(ARGV[1])
if not keep or keep <= now then return redis.error_reply('ERR PEAKET_KEEP_UNTIL_PAST keepUntil ' .. ARGV[1] .. ' now ' .. int(now)) end
for _, kt in ipairs({{KEYS[1], 'string'}, {KEYS[2], 'zset'}}) do
  if not typed(kt[1], kt[2]) then return corrupt(kt[1]) end
end
for i = 1, n do
  if not typed(KEYS[4 + i], 'hash') then return corrupt(KEYS[4 + i]) end
end

-- 2 쓰기
local setBits = {}
local holdKeys = {}
local zadd = {}
local zrem = {}
for i = 1, n do
  local idx = at(i, 1)
  setBits[#setBits + 1] = 'SET'
  setBits[#setBits + 1] = 'u1'
  setBits[#setBits + 1] = idx
  setBits[#setBits + 1] = '1'
  holdKeys[#holdKeys + 1] = KEYS[4 + i]
  if at(i, 2) == 'H' then
    zadd[#zadd + 1] = at(i, 8)
    zadd[#zadd + 1] = idx
  else
    zrem[#zrem + 1] = idx
  end
end
redis.call('BITFIELD', KEYS[1], unpack(setBits))
-- 옛 Hash 칸(pin·ext 등)을 지우고 새로 쓴다(방금 지우고 새로 쓴 키라 수명이 없어 PEXPIREAT만 건다)
redis.call('DEL', unpack(holdKeys))
local keepText = int(keep)
local usText = int(us)
local nowText = int(now)
for i = 1, n do
  local hk = KEYS[4 + i]
  if at(i, 2) == 'S' then
    -- 대조한 원장 행이 없는 판매 좌석은 토큰 = TIME µs, 잡은 시각 = 만료 시각 = 지금
    local fence, heldAt, exp = at(i, 6), at(i, 7), at(i, 8)
    if fence == '' then fence, heldAt, exp = usText, nowText, nowText end
    redis.call('HSET', hk, 'holdId', at(i, 3), 'owner', at(i, 4), 'psid', at(i, 5), 'fence', fence, 'heldAt', heldAt, 'exp', exp, 'kind', at(i, 9), 'ext', '0', 'pin', '1')
  else
    redis.call('HSET', hk, 'holdId', at(i, 3), 'owner', at(i, 4), 'psid', at(i, 5), 'fence', at(i, 6), 'heldAt', at(i, 7), 'exp', at(i, 8), 'kind', at(i, 9), 'ext', '0')
  end
  redis.call('PEXPIREAT', hk, keepText)
end
if #zadd > 0 then redis.call('ZADD', KEYS[2], unpack(zadd)) end
if #zrem > 0 then redis.call('ZREM', KEYS[2], unpack(zrem)) end
extend(KEYS[1], keep)
extend(KEYS[2], keep)
return {'OK', n}
`;

/** 다시 만들기 보유 수 Lua 원문(위 계약). 첫 줄이 #!lua다 */
export const REBUILD_QUOTAS_LUA = `#!lua
${INT_TEXT}${GUARDS}${GEN_FENCE}
local m = #KEYS - 2
if m < 1 or #ARGV ~= 2 + m then
  return redis.error_reply('ERR PEAKET_QUOTAS_ARGS KEYS ' .. #KEYS .. ' ARGV ' .. #ARGV)
end
if not genOk(ARGV[1]) then return redis.error_reply('ERR PEAKET_QUOTAS_ARGS gen ' .. tostring(ARGV[1])) end
for j = 1, m do
  local c = ARGV[2 + j]
  if c == '0' or not canon(c) then return redis.error_reply('ERR PEAKET_QUOTAS_ARGS quota ' .. c) end
end

-- 1 세대 키와 판 번호
local stop = fenced(KEYS[1], KEYS[2], ARGV[1])
if stop then return stop end

-- 쓰기 전 지킴. 서버 시각은 여기서 한 번만 읽는다
local now = nowMs()
local keep = tonumber(ARGV[2])
if not keep or keep <= now then return redis.error_reply('ERR PEAKET_KEEP_UNTIL_PAST keepUntil ' .. ARGV[2] .. ' now ' .. int(now)) end
for j = 1, m do
  if not typed(KEYS[2 + j], 'string') then return corrupt(KEYS[2 + j]) end
end

-- 2 쓰기: 보유 수(그 값으로, 수명 keepUntil)
local keepText = int(keep)
for j = 1, m do
  redis.call('SET', KEYS[2 + j], ARGV[2 + j], 'PXAT', keepText)
end
return {'OK', m}
`;

/** 다시 만들기 끝내기 Lua 원문(위 계약). 첫 줄이 #!lua다 */
export const FINISH_REBUILD_LUA = `#!lua
${INT_TEXT}${EXTEND}${GUARDS}${GEN_FENCE}
if #KEYS ~= 3 or #ARGV ~= 4 then
  return redis.error_reply('ERR PEAKET_FINISH_ARGS KEYS ' .. #KEYS .. ' ARGV ' .. #ARGV)
end
local genText = ARGV[1]
if not genOk(genText) then return redis.error_reply('ERR PEAKET_FINISH_ARGS gen ' .. tostring(genText)) end
if not canon(ARGV[4]) then return redis.error_reply('ERR PEAKET_FINISH_ARGS maxToken ' .. ARGV[4]) end

-- 1 세대 키(있으면 다른 곳이 이미 끝냈다)와 판 번호
local stop = fenced(KEYS[1], KEYS[2], genText)
if stop then return stop end

-- 쓰기 전 지킴. 서버 시각은 여기서 한 번만 읽는다
local now, sec = nowMs()
local keep = tonumber(ARGV[3])
if not keep or keep <= now then return redis.error_reply('ERR PEAKET_KEEP_UNTIL_PAST keepUntil ' .. ARGV[3] .. ' now ' .. int(now)) end
if not typed(KEYS[3], 'string') then return corrupt(KEYS[3]) end
local cur = redis.call('GET', KEYS[3])
if cur and not string.match(cur, '^%d+$') then return corrupt(KEYS[3]) end

-- 2 쓰기: 펜싱 카운터 되살리기(더 클 때만, 걸린 수명은 두고) → 세대 키(마지막)
local maxTok = tonumber(ARGV[4])
if maxTok > 0 and (not cur or tonumber(cur) < maxTok) then redis.call('SET', KEYS[3], ARGV[4], 'KEEPTTL') end
extend(KEYS[3], keep)
local keepText = int(keep)
redis.call('HSET', KEYS[1], 'epoch', sec, 'node', ARGV[2], 'gen', genText)
redis.call('PEXPIREAT', KEYS[1], keepText)
return {'OK', sec}
`;

/** 세대 올리기 Lua 원문(위 계약). 첫 줄이 #!lua다 */
export const BUMP_EPOCH_LUA = `#!lua
${INT_TEXT}${GUARDS}
if #KEYS ~= 1 or #ARGV ~= 1 then
  return redis.error_reply('ERR PEAKET_BUMP_ARGS KEYS ' .. #KEYS .. ' ARGV ' .. #ARGV)
end
if not typed(KEYS[1], 'hash') then return corrupt(KEYS[1]) end
local ep = redis.call('HMGET', KEYS[1], 'epoch', 'node')
if not ep[1] then return {'NOT_READY'} end
if not canon(ep[1]) then return corrupt(KEYS[1]) end
if ep[2] == ARGV[1] then return {'SAME', ep[1]} end
local _, sec = nowMs()
local nextEpoch = math.max(tonumber(ep[1]) + 1, tonumber(sec))
local text = int(nextEpoch)
redis.call('HSET', KEYS[1], 'epoch', text, 'node', ARGV[1])
return {'BUMPED', text}
`;
