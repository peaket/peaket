// 좌석 묶기·결제 실패 해제 Lua의 계약(BUILD_ORDER PRF-142, docs/features/seat-hold.md §6 '좌석 묶기와 실패 해제의 첫 구현', docs/data.md §3 좌석 키 표·§4 '좌석 묶기·실패 해제·판 번호').
// 규칙은 hold-lua.ts와 같다: 원문 첫 줄 `#!lua`, 키는 모두 KEYS(회차 해시 태그 하나의 슬롯), Redis TIME 한 번, 큰 정수는 string.format('%.0f'),
// 검사를 모두 마친 뒤에만 쓴다(세대 확인의 그 자리 올리기는 거절 결과 직전에도 돈다, ADR-0210. 오류로 끝나는 검사는 모두 그 앞이다),
// 형이 틀린 키·값이면 쓰지 않고 'ERR PEAKET_CORRUPT_KEY {키}' 스크립트 오류. 메모리 구현(memory-seat-store.ts)이 같은 계약을 따른다.
//
// PIN_LUA
// KEYS(좌석 수 n = #KEYS − 8): 1 bitmap  2 expiry  3 quota:{account}  4 stream  5 epoch  6 secver  7 fence  8.. hold:{좌석 색인}(ARGV 좌석 차례)  끝 failed:{holdId}
// ARGV: 1 계정  2 구매 세션 ID  3 holdId  4 1인 한도  5 orderGen  6 홀드 TTL ms(420000)  7 keepUntil ms  8 구역 채널 앞머리('s:{event:E}:sec:')
//       9 + 6(i − 1) ..: 좌석 i의 좌석 색인, 구역 색인, 구역 안 거리, 좌석 ID, 등급 ID, 구역 ID(hold-lua.ts와 같다)
// 검사 차례
//   1 세대 키 readEpoch(epoch): epoch 칸이 없음    → {'NOT_READY'}(아무것도 쓰지 않는다). epoch 칸이 u32가 아니거나 bumps 칸이 망가짐 → 'PEAKET_CORRUPT_KEY {세대 키}'
//     세대 확인 ensureEpoch(TIME 초)는 1′~4의 거절을 돌려주기 직전과 5의 쓰기 앞에서 한 번 돈다: 지금 노드 표지와 견줘 다르면 그 자리에서 올린다
//     (hold-lua.ts ENSURE_EPOCH, ADR-0210 결정 1. 거절이어도 올린 것은 남는다. 오류로 끝나는 검사(gen 모양, 홀드 키 형, 쓰기 전 지킴, 토큰 넘침)에는 돌지 않아
//     세대 키도 바꾸지 않는다, 리뷰 고침 결함 1. 다시 잡은 좌석의 HELD·델타는 도우미가 돌려준 세대를 싣는다)
//   1′ EXISTS failed:{holdId}(실패 표시, PRF-165)              → {'FAILED_HOLD'}(아무것도 쓰지 않는다. 표시의 수명도 늘리지 않는다)
//   2 좌석마다 비트·홀드 Hash(holdId·owner): 내 홀드(둘 다 같음, 비트 1) · 빈 좌석(비트 0) · 남의 좌석(그 밖)
//     남의 좌석이 있음                                        → {'TAKEN', 첫 남의 좌석 색인}
//   3 빈 좌석이 있고 orderGen ≠ gen(HGET epoch 'gen', 없으면 '1') → {'STALE_GEN', gen}
//   4 보유 수 + 빈 좌석 수 > 한도                              → {'QUOTA_EXCEEDED'}
//   5 쓰기                                                    → {'OK', gen, 다시 잡은 수, 토큰 글(다시 잡았으면, 아니면 '')}
// 쓰기: 모든 좌석의 홀드 Hash에 pin '1', ZREM expiry 모든 좌석 색인. 빈 좌석이 있으면 토큰 = max(fence + 1, µs), SET fence, BITFIELD SET u1 1,
//       빈 좌석마다 DEL 뒤 HSET hold(holdId·owner·psid·fence·heldAt=now·exp=now+TTL·kind 'FAN'·ext '0'·pin '1')와 키 수명(hold-lua.ts와 같은 규칙),
//       INCRBY quota 빈 좌석 수, 바뀐 구역마다 HINCRBY secver, 빈 좌석마다 XADD stream HELD(hold-lua.ts와 같은 칸), 바뀐 구역마다 SPUBLISH(상태 1).
//
// 구현에서 정한 세부(PRF-142)
// - 인자 수가 맞지 않으면(n < 1 또는 #ARGV ≠ 8 + 6n) 'ERR PEAKET_PIN_ARGS …'.
// - 세대는 ensureEpoch가 돌려준 값, 판 번호는 readEpoch 뒤 HGET epoch 'gen'이다. gen 칸 값이 있는데 앞 0 없는 양의 10진 정수(15자리 이하)가 아니면
//   'ERR PEAKET_CORRUPT_KEY {epoch 키}'(1 바로 뒤, 세대 확인 앞).
// - 2의 앞에서 hold:{색인}이 hash가 아니면(키가 없으면 통과) 'ERR PEAKET_CORRUPT_KEY {키}'. 비트는 BITFIELD_RO … GET u1 한 번, Hash는 비트가 1인 좌석만 HMGET holdId owner.
// - TIME은 맨 앞에서 한 번 읽는다(1의 세대 확인이 초를 쓴다). 쓰기 전 지킴(3 뒤 4 앞, hold-lua.ts와 같은 글): expiry가 zset이 아님(모든 묶기).
//   빈 좌석이 있을 때만 keepUntil ≤ now(PEAKET_KEEP_UNTIL_PAST),
//   보유 수가 표준 10진 정수가 아님·fence가 ^%d+$가 아님·stream이 stream이 아님·secver가 hash가 아님·바뀔 구역의 secver 칸이 표준 10진 정수가 아님(PEAKET_CORRUPT_KEY),
//   토큰 > 2^53 − 1(PEAKET_FENCE_OVERFLOW). 모두 내 홀드인 묶기는 keepUntil·보유 수·fence·Stream·secver를 보지 않는다.
// - 키 수명: 빈 좌석이 있을 때만 bitmap·quota·stream·epoch·secver·fence에 extend(keepUntil), 새로 쓴 hold에 PEXPIREAT keepUntil. expiry는 빼기만 하므로 늘리지 않는다.
//   모두 내 홀드인 묶기는 수명을 바꾸지 않는다(HSET pin과 ZREM만).
// - 판매 정지 사본(ctl)과 방금 놓은 좌석(rel)은 보지 않는다(접수된 결제는 끝까지 처리한다).
//
// 실패 표시의 계약(추천 적용 2026-11-05, BUILD_ORDER PRF-165, docs/data.md §3 s:{event:E}:failed:{holdId}, docs/features/seat-hold.md §6 '실패 표시').
// - 키: s:{event:E}:failed:{holdId}(회차 해시 태그 슬롯, 글 '1', 수명 FAILED_HOLD_MARK_TTL_MS 10분 [가정]). 두 Lua의 KEYS 끝에 하나를 더한다.
//   수명은 Lua 원문에 박는다(ARGV 차례는 그대로 둔다. 값은 domain/pin.ts의 상수에서 가져온다).
// - RELEASE_FAILED_LUA: 세대 키가 있을 때(NOT_READY가 아닐 때) 푼 좌석 수와 상관없이 같은 Lua 안에서 SET failed '1' PX 10분을 남긴다(0석이어도 남긴다:
//   묶기가 아직 오지 않은 늦은 묶기를 막는 것이 목적이다). 쓰기 전 지킴을 모두 지난 뒤에 쓴다(지킴에 걸리면 표시도 남기지 않는다).
// - PIN_LUA: 검사 1(세대 키) 바로 뒤에 EXISTS failed이면 아무것도 쓰지 않고 {'FAILED_HOLD'}. 그래서 실패 해제 뒤 늦게 실행된 묶기가 풀린 좌석을 다시 잡지 않는다.
// - 메모리 구현(memory-seat-store.ts)과 좌석 모델 시험 하네스(test-int/seat-model/system.ts)가 같은 계약을 따른다.
import { FAILED_HOLD_MARK_TTL_MS } from '../domain/pin.js';
// 세대 확인과 그 자리 올리기는 홀드 Lua와 같은 글을 쓴다(ADR-0210 결정 4)
import { ENSURE_EPOCH } from './hold-lua.js';

/** 큰 정수를 지수 표기 없이 10진 글로(hold-lua.ts와 같은 도우미) */
const INT_TEXT = `
local function int(x)
  return string.format('%.0f', x)
end
`;

// 키 수명은 더 늦은 쪽으로만 늘린다(hold-lua.ts와 같은 도우미)
const EXTEND = `
local function extend(key, ms)
  if redis.call('PEXPIRETIME', key) < ms then redis.call('PEXPIREAT', key, int(ms)) end
end
`;

// 형·값 지킴 도우미(hold-lua.ts·expire-lua.ts와 같은 규칙)
const GUARDS = `
local function corrupt(key)
  return redis.error_reply('ERR PEAKET_CORRUPT_KEY ' .. key)
end
local function typed(key, want)
  local ty = redis.call('TYPE', key).ok
  return ty == 'none' or ty == want
end
-- 표준 10진 정수(A1): '0'이거나 첫 자리 1~9에 18자리 이하. INCRBY·HINCRBY가 받는 값이다
local function canon(v)
  return v == '0' or (#v <= 18 and string.match(v, '^[1-9]%d*$') ~= nil)
end
`;

/** 안전한 정수의 끝(2^53 − 1). 토큰이 이보다 크면 쓰지 않는다 */
const MAX_SAFE = '9007199254740991';

/** 묶기 Lua 원문(위 계약). 첫 줄이 #!lua다 */
export const PIN_LUA = `#!lua
${INT_TEXT}${EXTEND}${GUARDS}${ENSURE_EPOCH}
local n = #KEYS - 8
if n < 1 or #ARGV ~= 8 + 6 * n then
  return redis.error_reply('ERR PEAKET_PIN_ARGS KEYS ' .. #KEYS .. ' ARGV ' .. #ARGV)
end
local function at(i, k)
  return ARGV[8 + 6 * (i - 1) + k]
end

-- 서버 시각은 여기서 한 번만 읽는다(세대 확인과 빈 좌석 쓰기에 같은 값)
local t = redis.call('TIME')
local nowSec = tonumber(t[1])

-- 1 세대 키(읽기만. 망가진 세대 칸은 여기서 오류). gen 칸이 없으면 판 번호 1
local ep = readEpoch(KEYS[5])
if not ep then return {'NOT_READY'} end
local genText = redis.call('HGET', KEYS[5], 'gen') or '1'
if #genText > 15 or not string.match(genText, '^[1-9]%d*$') then return corrupt(KEYS[5]) end
-- 거절 결과를 돌려주기 직전의 세대 확인(장애 조치 뒤면 그 자리에서 올린다, ADR-0210. 오류로 끝나는 검사는 이것을 부르지 않는다)
local function decided(r)
  ensureEpoch(ep, nowSec)
  return r
end

-- 1′ 실패 표시(KEYS 끝): 실패 해제가 먼저 돌았다. 늦은 묶기는 아무것도 쓰지 않는다(세대 확인만)
if redis.call('EXISTS', KEYS[#KEYS]) == 1 then return decided({'FAILED_HOLD'}) end

-- 2 좌석마다 내 홀드(비트 1, holdId·owner 같음) · 빈 좌석(비트 0) · 남의 좌석(그 밖). 좌석 차례로 첫 남의 좌석이면 TAKEN
for i = 1, n do
  if not typed(KEYS[7 + i], 'hash') then return corrupt(KEYS[7 + i]) end
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
local empty = {}
local mine = {}
for i = 1, n do
  if bits[i] == 1 then
    local h = redis.call('HMGET', KEYS[7 + i], 'holdId', 'owner')
    if h[1] ~= ARGV[3] or h[2] ~= ARGV[1] then return decided({'TAKEN', idx[i]}) end
    mine[#mine + 1] = i
  else
    empty[#empty + 1] = i
  end
end
local k = #empty

-- 3 낡은 판 번호(빈 좌석이 있을 때만 본다)
if k > 0 and tonumber(ARGV[5]) ~= tonumber(genText) then return decided({'STALE_GEN', genText}) end

-- 쓰기 전 지킴(여기까지 아무것도 쓰지 않았다)
if not typed(KEYS[2], 'zset') then return corrupt(KEYS[2]) end
local tokText = ''
local nowText, expText, keep, sections
if k > 0 then
  -- 서버 시각은 맨 앞에서 읽은 값이다
  local us = tonumber(t[1]) * 1000000 + tonumber(t[2])
  local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
  keep = tonumber(ARGV[7])
  if not keep or keep <= now then return redis.error_reply('ERR PEAKET_KEEP_UNTIL_PAST keepUntil ' .. ARGV[7] .. ' now ' .. int(now)) end
  local heldText = redis.call('GET', KEYS[3]) or '0'
  if not canon(heldText) then return corrupt(KEYS[3]) end
  local fenceText = redis.call('GET', KEYS[7]) or '0'
  if not string.match(fenceText, '^%d+$') then return corrupt(KEYS[7]) end
  for _, kt in ipairs({{KEYS[4], 'stream'}, {KEYS[6], 'hash'}}) do
    if not typed(kt[1], kt[2]) then return corrupt(kt[1]) end
  end
  -- 바뀔 구역(빈 좌석의 구역 색인, 처음 나온 차례)의 secver 칸: HMGET 한 번
  sections = {}
  local seen = {}
  for _, i in ipairs(empty) do
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

  -- 4 1인 한도(빈 좌석이 있을 때만. 내 홀드 좌석은 이미 보유 수에 있다)
  if tonumber(heldText) + k > tonumber(ARGV[4]) then return decided({'QUOTA_EXCEEDED'}) end

  local tok = math.max(tonumber(fenceText) + 1, us)
  if tok > ${MAX_SAFE} then return redis.error_reply('ERR PEAKET_FENCE_OVERFLOW ' .. int(tok)) end
  tokText = int(tok)
  nowText = int(now)
  expText = int(now + tonumber(ARGV[6]))
end

-- 첫 쓰기: 세대 확인(장애 조치 뒤면 그 자리에서 올린다. 아래 HELD·델타는 이 세대를 싣는다)
local seatEpoch = ensureEpoch(ep, nowSec)

-- 5 쓰기
if k > 0 then
  local keepText = int(keep)
  -- fence는 수명을 지우지 않게 KEEPTTL로 쓴다
  redis.call('SET', KEYS[7], tokText, 'KEEPTTL')
  local setBits = {}
  local holdKeys = {}
  for _, i in ipairs(empty) do
    setBits[#setBits + 1] = 'SET'
    setBits[#setBits + 1] = 'u1'
    setBits[#setBits + 1] = idx[i]
    setBits[#setBits + 1] = '1'
    holdKeys[#holdKeys + 1] = KEYS[7 + i]
  end
  redis.call('BITFIELD', KEYS[1], unpack(setBits))
  -- 남은 옛 Hash 칸을 지우고 새로 쓴다(방금 지우고 새로 쓴 키라 수명이 없어 PEXPIREAT만 건다)
  redis.call('DEL', unpack(holdKeys))
  for _, i in ipairs(empty) do
    local hk = KEYS[7 + i]
    redis.call('HSET', hk, 'holdId', ARGV[3], 'owner', ARGV[1], 'psid', ARGV[2], 'fence', tokText, 'heldAt', nowText, 'exp', expText, 'kind', 'FAN', 'ext', '0', 'pin', '1')
    redis.call('PEXPIREAT', hk, keepText)
  end
end
-- 내 홀드는 pin 칸만 더한다(exp·토큰은 그대로)
for _, i in ipairs(mine) do
  redis.call('HSET', KEYS[7 + i], 'pin', '1')
end
-- 모든 좌석을 만료 인덱스에서 뺀다(만료 Lua는 인덱스에 있는 좌석만 푼다)
redis.call('ZREM', KEYS[2], unpack(idx))

if k > 0 then
  redis.call('INCRBY', KEYS[3], int(k))
  -- 바뀐 구역마다 일련번호 +1(처음 나온 차례), 그 구역 빈 좌석의 델타 글
  local version = {}
  local deltas = {}
  for _, sec in ipairs(sections) do
    version[sec] = redis.call('HINCRBY', KEYS[6], sec, 1)
    deltas[sec] = {}
  end
  for _, i in ipairs(empty) do
    local d = deltas[at(i, 2)]
    d[#d + 1] = at(i, 3) .. ':1'
  end
  -- 다시 잡은 좌석마다 HELD 한 건(hold-lua.ts와 같은 칸, 길이 상한 없음)
  for _, i in ipairs(empty) do
    redis.call('XADD', KEYS[4], '*',
      'type', 'HELD', 'seatIdx', idx[i], 'seatId', at(i, 4), 'tierId', at(i, 5), 'sectionId', at(i, 6),
      'holdId', ARGV[3], 'holdKind', 'FAN', 'purchaseSessionId', ARGV[2], 'accountId', ARGV[1],
      'fencingToken', tokText, 'sectionVersion', int(version[at(i, 2)]), 'seatEpoch', seatEpoch,
      'occurredAtMs', nowText, 'expiresAtMs', expText)
  end
  -- 구역마다 샤드 Pub/Sub 한 건(상태 1 = 다른 분 선택)
  for _, sec in ipairs(sections) do
    redis.call('SPUBLISH', ARGV[8] .. sec, '1 ' .. seatEpoch .. ' ' .. sec .. ' ' .. int(version[sec]) .. ' ' .. nowText .. ' ' .. table.concat(deltas[sec], ' '))
  end
  for _, key in ipairs({KEYS[1], KEYS[3], KEYS[4], KEYS[5], KEYS[6], KEYS[7]}) do extend(key, keep) end
end
return {'OK', genText, k, tokText}
`;

// RELEASE_FAILED_LUA
// KEYS(좌석 수 n = #KEYS − 7): 1 bitmap  2 expiry  3 quota:{account}  4 stream  5 epoch  6 secver  7.. hold:{좌석 색인}  끝 failed:{holdId}
// ARGV: 1 계정  2 holdId  3 keepUntil ms  4 구역 채널 앞머리  5 + 6(i − 1) ..: 좌석 i의 6칸(PIN_LUA와 같다)
// 검사: 1 세대 키(PIN_LUA와 같은 readEpoch. epoch 없음 → {'NOT_READY'}, 표시를 남기지 않는다. 망가진 세대 칸 → PEAKET_CORRUPT_KEY).
//       그다음 좌석마다 홀드 Hash의 holdId·owner가 ARGV와 같은 좌석만 푼다 → {'OK', 푼 수}. 세대 확인(ensureEpoch, 장애 조치 뒤면 그 자리에서 올린다)은
//       쓰기 전 지킴을 모두 지난 뒤의 첫 쓰기다(지킴에 걸리면 세대 키도 바꾸지 않는다, 리뷰 고침 결함 1). RELEASED·델타는 도우미가 돌려준 세대를 싣는다
// 쓰기(늘): SET failed:{holdId} '1' PX FAILED_HOLD_MARK_TTL_MS(푼 좌석이 0이어도. 같은 호출을 다시 하면 수명이 다시 10분이 된다)
// 쓰기(푼 좌석마다): BITFIELD SET u1 0, DEL hold, ZREM expiry, 보유 수 DECRBY(0 밑으로 내리지 않음), 바뀐 구역마다 HINCRBY secver,
//       XADD stream RELEASED(만료 Lua의 EXPIRED와 같은 칸: holdKind = Hash kind, purchaseSessionId = Hash psid, fencingToken = Hash fence,
//       expiresAtMs = Hash exp, occurredAtMs = now), 바뀐 구역마다 SPUBLISH(상태 0). rel(방금 놓은 좌석)에는 넣지 않는다.
//
// 구현에서 정한 세부(PRF-142)
// - 인자 수가 맞지 않으면(n < 1 또는 #ARGV ≠ 4 + 6n) 'ERR PEAKET_RELEASE_ARGS …'.
// - 푸는 좌석은 '그 주문의 홀드' = PIN_LUA의 '내 홀드'와 같다: 비트 1이고 홀드 Hash의 holdId·owner가 ARGV와 같다(비트가 0인데 옛 Hash만 남은 좌석은 보유 수에
//   들어 있지 않아 풀지 않는다. 보유 수를 덜 세어 한도를 넘기지 않게).
// - TIME은 1 바로 앞에서 한 번 읽는다(expire-lua.ts와 같다). 쓰기 전 지킴: keepUntil ≤ now(PEAKET_KEEP_UNTIL_PAST, 푼 좌석이 없어도), bitmap string·expiry zset·
//   stream stream·secver hash·hold:{색인} hash가 아님(키가 없으면 통과, PEAKET_CORRUPT_KEY). 푼 좌석이 있을 때만 보유 수(표준 10진 정수)와 바뀔 구역의 secver 칸을 본다.
// - 보유 수: 새 값 = 보유 수 − 푼 수가 0 이하면 DEL, 아니면 SET 새 값 KEEPTTL(만료 Lua와 같다. 0 밑으로 내리지 않는다).
// - 키 수명: 푼 좌석이 있을 때만 stream·secver에 extend(keepUntil)(만료 Lua와 같다).

/** 결제 실패 해제 Lua 원문(위 계약). 첫 줄이 #!lua다 */
export const RELEASE_FAILED_LUA = `#!lua
${INT_TEXT}${EXTEND}${GUARDS}${ENSURE_EPOCH}
local n = #KEYS - 7
if n < 1 or #ARGV ~= 4 + 6 * n then
  return redis.error_reply('ERR PEAKET_RELEASE_ARGS KEYS ' .. #KEYS .. ' ARGV ' .. #ARGV)
end
-- 실패 표시(KEYS 끝): 늦은 묶기가 이 홀드의 좌석을 다시 잡지 않게 남긴다(PRF-165)
local function markFailed()
  redis.call('SET', KEYS[#KEYS], '1', 'PX', '${FAILED_HOLD_MARK_TTL_MS}')
end
local function at(i, k)
  return ARGV[4 + 6 * (i - 1) + k]
end

-- 서버 시각은 여기서 한 번만 읽는다(세대 확인에도 같은 값)
local t = redis.call('TIME')
local nowSec = tonumber(t[1])
local now = nowSec * 1000 + math.floor(tonumber(t[2]) / 1000)

-- 1 세대 키(읽기만. 망가진 세대 칸은 여기서 오류)
local ep = readEpoch(KEYS[5])
if not ep then return {'NOT_READY'} end

-- 쓰기 전 지킴(여기까지 아무것도 쓰지 않았다)
local keep = tonumber(ARGV[3])
if not keep or keep <= now then return redis.error_reply('ERR PEAKET_KEEP_UNTIL_PAST keepUntil ' .. ARGV[3] .. ' now ' .. int(now)) end
for _, kt in ipairs({{KEYS[1], 'string'}, {KEYS[2], 'zset'}, {KEYS[4], 'stream'}, {KEYS[6], 'hash'}}) do
  if not typed(kt[1], kt[2]) then return corrupt(kt[1]) end
end
for i = 1, n do
  if not typed(KEYS[6 + i], 'hash') then return corrupt(KEYS[6 + i]) end
end

-- 그 주문의 홀드(비트 1, holdId·owner 같음)만 고른다
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
for i = 1, n do
  if bits[i] == 1 then
    local h = redis.call('HMGET', KEYS[6 + i], 'holdId', 'owner', 'psid', 'fence', 'exp', 'kind')
    if h[1] == ARGV[2] and h[2] == ARGV[1] then
      freed[#freed + 1] = i
      hashes[i] = h
    end
  end
end
local k = #freed
if k == 0 then
  -- 첫 쓰기: 세대 확인(장애 조치 뒤면 그 자리에서 올린다, ADR-0210), 그다음 실패 표시
  ensureEpoch(ep, nowSec)
  markFailed()
  return {'OK', 0}
end

-- 보유 수(표준 10진 정수)와 바뀔 구역(푼 좌석의 구역 색인, 처음 나온 차례)의 secver 칸
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

-- 첫 쓰기: 세대 확인(장애 조치 뒤면 그 자리에서 올린다. 아래 RELEASED·델타는 이 세대를 싣는다)
local seatEpoch = ensureEpoch(ep, nowSec)

-- 쓰기
markFailed()
local clear = {}
local dels = {}
local members = {}
for _, i in ipairs(freed) do
  clear[#clear + 1] = 'SET'
  clear[#clear + 1] = 'u1'
  clear[#clear + 1] = idx[i]
  clear[#clear + 1] = '0'
  dels[#dels + 1] = KEYS[6 + i]
  members[#members + 1] = idx[i]
end
redis.call('BITFIELD', KEYS[1], unpack(clear))
redis.call('DEL', unpack(dels))
redis.call('ZREM', KEYS[2], unpack(members))
local left = tonumber(heldText) - k
if left <= 0 then
  redis.call('DEL', KEYS[3])
else
  redis.call('SET', KEYS[3], int(left), 'KEEPTTL')
end
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
-- 푼 좌석마다 RELEASED 한 건(만료 Lua의 EXPIRED와 같은 칸. 토큰은 그 홀드의 것이다)
for _, i in ipairs(freed) do
  local h = hashes[i]
  redis.call('XADD', KEYS[4], '*',
    'type', 'RELEASED', 'seatIdx', idx[i], 'seatId', at(i, 4), 'tierId', at(i, 5), 'sectionId', at(i, 6),
    'holdId', h[1], 'holdKind', h[6] or '', 'purchaseSessionId', h[3] or '', 'accountId', h[2],
    'fencingToken', h[4] or '', 'sectionVersion', int(version[at(i, 2)]), 'seatEpoch', seatEpoch,
    'occurredAtMs', nowText, 'expiresAtMs', h[5] or '')
end
-- 구역마다 샤드 Pub/Sub 한 건(상태 0 = 가능)
for _, sec in ipairs(sections) do
  redis.call('SPUBLISH', ARGV[4] .. sec, '1 ' .. seatEpoch .. ' ' .. sec .. ' ' .. int(version[sec]) .. ' ' .. nowText .. ' ' .. table.concat(deltas[sec], ' '))
end
extend(KEYS[4], keep)
extend(KEYS[6], keep)
return {'OK', k}
`;
