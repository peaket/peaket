// 우선 구매 보류 만료 Lua의 계약(GAT-135, docs/features/seat-hold.md §5 '우선 구매 보류').
// s:{event:E}:prio(점수 = 권리 만료)에서 지난 보류를 풀고 EXPIRED 사건을 남긴다. 권리 상태는 스위퍼가 purchase DB에서 EXPIRED로 바꾼다.
// 첫 줄이 #!lua다. 키·칸 이름의 정본은 docs/data.md §3이다.
//
// KEYS(차례 고정): 1 bitmap 2 prio 3 stream 4 epoch 5 secver 6.. hold:{색인}
// ARGV: 1 구역 채널 앞머리 2 keepUntil ms 3 n 4 + 9(i-1).. 좌석 i의 9칸
//   ① 색인 ② 기대 grantId ③ 기대 펜싱 글 ④ 계정(고아면 '') ⑤ 구역 색인 ⑥ 구역 안 거리 ⑦ 좌석 ID ⑧ 등급 ID ⑨ 구역 ID
// 돌려주기: {'OK', nowUs, 푼 수, 건너뛴 수, 고아 수, 색인₁, grantId₁, …}
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

/** 우선 구매 보류 만료 Lua 원문(위 계약). 첫 줄이 #!lua다 */
export const PRIORITY_EXPIRE_LUA = `#!lua
${INT_TEXT}${EXTEND}${ENSURE_EPOCH}
local n = tonumber(ARGV[3])
if not n or n < 1 or n ~= math.floor(n) or #KEYS ~= 5 + n or #ARGV ~= 3 + 9 * n then
  return redis.error_reply('ERR PEAKET_PRIORITY_EXPIRE_ARGS KEYS ' .. #KEYS .. ' ARGV ' .. #ARGV)
end
local function at(i, k)
  return ARGV[3 + 9 * (i - 1) + k]
end
local t = redis.call('TIME')
local us = tonumber(t[1]) * 1000000 + tonumber(t[2])
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local ep = readEpoch(KEYS[4])
if not ep then return {'NOT_READY'} end
local keep = tonumber(ARGV[2])
if not keep or keep <= now then return redis.error_reply('ERR PEAKET_KEEP_UNTIL_PAST keepUntil ' .. ARGV[2] .. ' now ' .. int(now)) end
local function corrupt(key)
  return redis.error_reply('ERR PEAKET_CORRUPT_KEY ' .. key)
end
for _, kt in ipairs({{KEYS[1], 'string'}, {KEYS[2], 'zset'}, {KEYS[3], 'stream'}, {KEYS[5], 'hash'}}) do
  local ty = redis.call('TYPE', kt[1]).ok
  if ty ~= 'none' and ty ~= kt[2] then return corrupt(kt[1]) end
end
for i = 1, n do
  local ty = redis.call('TYPE', KEYS[5 + i]).ok
  if ty ~= 'none' and ty ~= 'hash' then return corrupt(KEYS[5 + i]) end
end
local members = {}
for i = 1, n do members[i] = at(i, 1) end
local scores = redis.call('ZMSCORE', KEYS[2], unpack(members))
local kinds = {}
local hashes = {}
local released, skipped, orphans = 0, 0, 0
for i = 1, n do
  local hk = KEYS[5 + i]
  local ty = redis.call('TYPE', hk).ok
  local kind = 's'
  if ty == 'none' then
    if scores[i] then kind = 'o' end
  else
    local h = redis.call('HMGET', hk, 'holdId', 'owner', 'fence', 'exp', 'kind', 'priorityGrantId', 'pin')
    if not h[1] or not h[2] or not h[3] or not h[4] or h[5] ~= 'PRIORITY' or not h[6] or not string.match(h[4], '^%d+$') then
      kind = 'c'
    elseif h[7] == '1' then
      -- 결제 중(pin)에는 만료가 좌석을 풀지 않는다(B1-01). 결제가 끝나면 USED, 실패하면 복귀가 푼다
      kind = 's'
    elseif scores[i] and h[1] == at(i, 2) and h[3] == at(i, 3) and h[2] == at(i, 4) and h[6] == h[1] and tonumber(h[4]) <= now then
      kind = 'r'
      hashes[i] = h
    end
  end
  kinds[i] = kind
  if kind == 'r' then released = released + 1
  elseif kind == 'o' then orphans = orphans + 1
  elseif kind == 's' then skipped = skipped + 1 end
end
local gone = {}
for i = 1, n do
  if kinds[i] == 'o' or kinds[i] == 'r' then gone[#gone + 1] = at(i, 1) end
end
if #gone > 0 then redis.call('ZREM', KEYS[2], unpack(gone)) end
local out = {'OK', int(us), released, skipped, orphans}
if released > 0 then
  local bits = {}
  local dels = {}
  for i = 1, n do
    if kinds[i] == 'r' then
      bits[#bits + 1] = 'SET'
      bits[#bits + 1] = 'u1'
      bits[#bits + 1] = at(i, 1)
      bits[#bits + 1] = '0'
      dels[#dels + 1] = KEYS[5 + i]
    end
  end
  redis.call('BITFIELD', KEYS[1], unpack(bits))
  redis.call('DEL', unpack(dels))
  local sections = {}
  local version = {}
  local deltas = {}
  for i = 1, n do
    local sec = at(i, 5)
    if kinds[i] == 'r' and sec ~= '' then
      if not version[sec] then
        sections[#sections + 1] = sec
        version[sec] = redis.call('HINCRBY', KEYS[5], sec, 1)
        deltas[sec] = {}
      end
      local d = deltas[sec]
      d[#d + 1] = at(i, 6) .. ':0'
    end
  end
  local seatEpoch = ensureEpoch(ep, tonumber(t[1]))
  local nowText = int(now)
  for i = 1, n do
    if kinds[i] == 'r' then
      local h = hashes[i]
      local sec = at(i, 5)
      local sv = ''
      if sec ~= '' then sv = int(version[sec]) end
      redis.call('XADD', KEYS[3], '*',
        'type', 'EXPIRED', 'seatIdx', at(i, 1), 'seatId', at(i, 7), 'tierId', at(i, 8), 'sectionId', at(i, 9),
        'holdId', h[1], 'holdKind', 'PRIORITY', 'priorityGrantId', h[6], 'purchaseSessionId', '', 'accountId', h[2],
        'fencingToken', h[3], 'sectionVersion', sv, 'seatEpoch', seatEpoch,
        'occurredAtMs', nowText, 'expiresAtMs', h[4])
      out[#out + 1] = at(i, 1)
      out[#out + 1] = h[6]
    end
  end
  for _, sec in ipairs(sections) do
    redis.call('SPUBLISH', ARGV[1] .. sec, '1 ' .. seatEpoch .. ' ' .. sec .. ' ' .. int(version[sec]) .. ' ' .. nowText .. ' ' .. table.concat(deltas[sec], ' '))
  end
  extend(KEYS[3], keep)
  extend(KEYS[5], keep)
  extend(KEYS[2], keep)
end
return out
`;
