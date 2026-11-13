// 운영 자동 배정 Lua의 계약(docs/features/seat-hold.md §3 '자동 좌석 배정 모드', docs/data.md §3 s:{event:E}:auto_cur, BUILD_ORDER HOT-080, POL-035, ADR-0043).
// 키·칸 이름의 정본은 docs/data.md §3이다. 문자열만 두고 아무것도 가져오지 않는다(시험: test/auto-assign.test.ts, test-int/seat-store.int.test.ts).
// 메모리 구현(memory-seat-store.ts의 holdAuto)이 같은 계약을 따른다.
//
// 규칙
// - 원문 첫 줄은 `#!lua`. 쓰거나 읽는 키는 모두 KEYS로 받는다. 키는 모두 회차 해시 태그 {event:E} 하나의 슬롯이다.
// - 서버 시각은 Redis TIME을 맨 앞에서 한 번만 읽는다: µs = 초 × 1,000,000 + 마이크로초, now = heldAt = floor(µs / 1000)(ms).
// - 큰 정수는 string.format('%.0f', x)로 글로 바꾼다(Lua 5.1 tostring은 유효 숫자 14자리).
// - 검사를 모두 마친 뒤에만 쓴다. 하나만 예외다: 세대 확인(ENSURE_EPOCH의 ensureEpoch)은 거절 결과(2~6)를 돌려주기 직전과
//   NEXT를 쓰기 직전·7의 쓰기 앞에서 한 번 돈다(장애 조치 뒤 그 자리 올리기, ADR-0210 결정 1).
//
// KEYS(차례 고정, 모두 s:{event:E}: 아래). n = 이번 페이지의 좌석 수(모든 후보 묶음의 좌석 합)
//   1 bitmap                 비트맵(색인 = 좌석 색인)
//   2 expiry                 만료 인덱스 ZSET(멤버 = 좌석 색인 10진 글, 점수 = exp ms)
//   3 quota:{account}        보유 수(10진 정수 글)
//   4 stream                 사건 Stream
//   5 idem:{account}:{key}   멱등 기록 Hash: fp(지문), resp('{holdId}:{heldAt}:{exp}:{fencingToken}'), seats(색인 쉼표 글), assign(결과 유형)
//   6 epoch                  세대 키 Hash: epoch(세대 seatEpoch), node(주 노드 표지), chk(설정 세대까지 견준 초), bumps(올린 누적 수). epoch 칸이 없으면 NOT_READY
//   7 ctl                    판매 정지 사본 Hash: paused·suspended(회차 범위)·allPaused(전체 범위) 가운데 하나라도 '1'이면 정지
//   8 rel:{account}          방금 놓은 좌석 ZSET(멤버 = 좌석 색인, 점수 = 다시 잡을 수 있는 시각 ms)
//   9 secver                 구역별 일련번호 Hash(칸 = 구역 색인 10진 글)
//  10 fence                  회차의 마지막 펜싱 토큰(10진 글, 없으면 0)
//  11 auto_cur               자동 배정 커서 Hash(칸 = 조건 글, 값 = 다음 후보 묶음 차례 10진 글)
//  12.. hold:{좌석 색인}     페이지의 좌석마다 하나, ARGV 13부터의 좌석과 같은 차례
//
// ARGV
//   1 소유 계정 ID  2 구매 세션 ID  3 holdId  4 요청 지문(hex 64)  5 1인 한도  6 홀드 TTL ms(420000)  7 키 만료 시각 epoch ms(keepUntil)
//   8 구역 채널 이름 앞머리('s:{event:E}:sec:')  9 auto_cur 칸 이름  10 이번 페이지의 첫 후보 묶음 차례(0부터)  11 후보 묶음 수
//   12 희망 매수(분리 후보에서 고를 수)
//   13.. 후보 묶음마다: ① 결과 유형('FIRST'·'FIRST_SPLIT'·'SECOND'·'SECOND_SPLIT') ② split('0'·'1') ③ 좌석 수
//     그다음 좌석마다 6칸: ④ 좌석 색인 ⑤ 구역 색인 ⑥ 구역 안 거리(seatOffset) ⑦ 좌석 ID ⑧ 등급 ID ⑨ 구역 ID
//
// 검사 차례(앞이 걸리면 뒤는 보지 않는다)
//   1 세대 키 readEpoch(epoch): epoch 칸이 없음 → {'NOT_READY'}. epoch 칸이 u32가 아니거나 bumps 칸이 망가짐 → 'PEAKET_CORRUPT_KEY {세대 키}'.
//   2 idem이 있음: fp가 같으면 → {'IDEM_REPLAY', holdId, heldAt, exp, 토큰 글, seats 글, assign 글}
//                  fp가 다르면 → {'IDEM_REUSED'}(좌석을 보지 않는다)
//   3 ctl paused·allPaused·suspended 가운데 '1' → {'PAUSED'}
//   4 보유 수 + 희망 매수 > 한도 → {'QUOTA_EXCEEDED'}
//   5 후보 묶음을 차례로 본다(비트·rel). 맞는 묶음이 없으면 → {'NEXT', 다음 커서}(auto_cur를 다음 커서로 쓴다)
//   6 쓰기 → {'OK', 토큰 글, heldAt, exp, seats 글, assign 글, 다음 커서}
//
// 후보 묶음 고르기
//   - split '0': 그 묶음의 모든 좌석 비트가 0이고 rel 점수가 지금 이하이면 고른다.
//   - split '1': 묶음 좌석을 차례로 보며 비트가 0이고 rel 점수가 지금 이하인 좌석을 희망 매수만큼 고른다. 모자라면 다음 묶음으로 간다.
//   - rel 점수가 지금보다 큰 좌석은 그 계정에게만 찬 것으로 본다(같은 계정이 방금 놓은 좌석을 30초 안에 다시 배정하지 않는다, §5).
//
// 쓰기(6)
//   - exp = heldAt + TTL. 토큰 = max((GET fence 또는 0) + 1, µs). SET fence 토큰 글.
//   - 고른 좌석을 색인 오름차순으로 정렬해 비트 켜기(BITFIELD 한 번), hold Hash DEL 뒤 HSET(holdId·owner·psid·fence·heldAt·exp·kind 'FAN'·ext '0'·lim),
//     만료 인덱스 ZADD, 보유 수 INCRBY(고른 수), idem HSET(fp·resp·seats·assign), 바뀐 구역마다 HINCRBY secver 1,
//     좌석마다 Stream HELD 한 건, 구역마다 SPUBLISH 델타 한 건(좌석 색인 오름차순).
//   - auto_cur HSET(칸 = 다음 커서), PEXPIREAT keepUntil. 비트맵·expiry·quota·stream·epoch·secver·fence·auto_cur의 수명도 keepUntil까지 늘린다.
//   - 토큰이 2^53 − 1을 넘으면 아무것도 쓰지 않고 'PEAKET_FENCE_OVERFLOW' 오류다.
import { ENSURE_EPOCH } from './hold-lua.js';

export const AUTO_HOLD_LUA = `#!lua
local function int(x)
  return string.format('%.0f', x)
end
local function extend(key, ms)
  if redis.call('PEXPIRETIME', key) < ms then redis.call('PEXPIREAT', key, int(ms)) end
end
${ENSURE_EPOCH}
local groupCount = tonumber(ARGV[11])
local want = tonumber(ARGV[12])
if not groupCount or groupCount < 1 or groupCount > 32 or not want or want < 1 or want > 10 then
  return redis.error_reply('ERR PEAKET_AUTO_ARGS groups ' .. tostring(ARGV[11]) .. ' want ' .. tostring(ARGV[12]))
end
local p = 13
local groups = {}
local flat = {}
for g = 1, groupCount do
  local result = ARGV[p]
  local split = ARGV[p + 1] == '1'
  local sc = tonumber(ARGV[p + 2])
  if not result or (result ~= 'FIRST' and result ~= 'FIRST_SPLIT' and result ~= 'SECOND' and result ~= 'SECOND_SPLIT') or not sc or sc < 1 then
    return redis.error_reply('ERR PEAKET_AUTO_ARGS group ' .. g)
  end
  p = p + 3
  local seats = {}
  for k = 1, sc do
    local s = {
      index = ARGV[p],
      sectionIndex = ARGV[p + 1],
      seatOffset = ARGV[p + 2],
      seatId = ARGV[p + 3],
      tierId = ARGV[p + 4],
      sectionId = ARGV[p + 5],
      keyPos = 11 + #flat + 1,
    }
    seats[k] = s
    flat[#flat + 1] = s
    p = p + 6
  end
  groups[g] = { result = result, split = split, seats = seats }
end
if #KEYS ~= 11 + #flat or #ARGV ~= p - 1 then
  return redis.error_reply('ERR PEAKET_AUTO_ARGS KEYS ' .. #KEYS .. ' ARGV ' .. #ARGV .. ' seats ' .. #flat)
end

-- 서버 시각은 여기서 한 번만 읽는다(세대 확인의 초, rel 비교와 쓰기에 같은 값)
local t = redis.call('TIME')
local nowSec = tonumber(t[1])
local us = nowSec * 1000000 + tonumber(t[2])
local now = nowSec * 1000 + math.floor(tonumber(t[2]) / 1000)
local keep = tonumber(ARGV[7])
if not keep or keep <= now then return redis.error_reply('ERR PEAKET_KEEP_UNTIL_PAST keepUntil ' .. ARGV[7] .. ' now ' .. int(now)) end

-- 1 세대 키(읽기만. 망가진 세대 칸은 여기서 오류)
local ep = readEpoch(KEYS[6])
if not ep then return {'NOT_READY'} end
local function decided(r)
  ensureEpoch(ep, nowSec)
  return r
end

-- 2 멱등 기록(좌석을 보지 않는다)
local idem = redis.call('HMGET', KEYS[5], 'fp', 'resp', 'seats', 'assign')
if idem[1] then
  if idem[1] ~= ARGV[4] then return decided({'IDEM_REUSED'}) end
  local holdId, heldAt, exp, tok = string.match(idem[2] or '', '^(.+):(%d+):(%d+):(%d+)$')
  if not holdId or not idem[3] or not idem[4] then return redis.error_reply('ERR PEAKET_IDEM_AUTO ' .. tostring(idem[2])) end
  return decided({'IDEM_REPLAY', holdId, heldAt, exp, tok, idem[3], idem[4]})
end

-- 3 판매 정지 사본
local ctl = redis.call('HMGET', KEYS[7], 'paused', 'allPaused', 'suspended')
if ctl[1] == '1' or ctl[2] == '1' or ctl[3] == '1' then return decided({'PAUSED'}) end

-- 4 보유 수(쓰기 전 지킴: 표준 10진 정수가 아니면 아무것도 쓰지 않고 오류)
local heldText = redis.call('GET', KEYS[3])
if heldText then
  local canon = heldText == '0' or (#heldText <= 18 and string.match(heldText, '^[1-9]%d*$') ~= nil)
  if not canon then return redis.error_reply('ERR PEAKET_CORRUPT_KEY ' .. KEYS[3]) end
else
  heldText = '0'
end
if tonumber(heldText) + want > tonumber(ARGV[5]) then return decided({'QUOTA_EXCEEDED'}) end

-- 5 후보 묶음: 비트와 rel을 한 번에 읽는다
local idx = {}
for i = 1, #flat do idx[i] = flat[i].index end
local probe = {}
for i = 1, #flat do
  probe[#probe + 1] = 'GET'
  probe[#probe + 1] = 'u1'
  probe[#probe + 1] = idx[i]
end
local bits = redis.call('BITFIELD_RO', KEYS[1], unpack(probe))
local relScores = redis.call('ZMSCORE', KEYS[8], unpack(idx))
local function free(i)
  local s = relScores[i]
  return bits[i] == 0 and not (s and tonumber(s) > now)
end
local chosen = nil
local chosenResult = nil
local chosenGroup = nil
for g = 1, groupCount do
  local grp = groups[g]
  if grp.split then
    local picked = {}
    for k = 1, #grp.seats do
      if #picked < want and free(grp.seats[k].keyPos - 11) then picked[#picked + 1] = grp.seats[k] end
    end
    if #picked == want then
      chosen = picked
      chosenResult = grp.result
      chosenGroup = g
      break
    end
  else
    local ok = true
    for k = 1, #grp.seats do
      if not free(grp.seats[k].keyPos - 11) then ok = false; break end
    end
    if ok then
      chosen = grp.seats
      chosenResult = grp.result
      chosenGroup = g
      break
    end
  end
end

-- 맞는 묶음이 없으면 이번 요청 안에서만 다음 페이지로 이어 간다. 공유 커서가 이미 더 앞서 있으면
-- 그 커서로 따라가, 늦게 시작한 요청이 낡은 페이지에서 빈 블록을 놓치지 않게 한다(공유 커서는 성공한 묶음 다음으로만 옮긴다).
if not chosen then
  local pageEnd = int(tonumber(ARGV[10]) + groupCount)
  local curCursor = tonumber(redis.call('HGET', KEYS[11], ARGV[9]) or '0')
  local nextCursor = pageEnd
  if curCursor and curCursor > tonumber(pageEnd) then nextCursor = int(curCursor) end
  ensureEpoch(ep, nowSec)
  return {'NEXT', nextCursor}
end

-- 6 쓰기(여기까지 아무것도 쓰지 않았다). 고른 좌석을 색인 오름차순으로 정렬한다(응답·Stream·델타 차례)
table.sort(chosen, function(a, b) return tonumber(a.index) < tonumber(b.index) end)
local tok = math.max(tonumber(redis.call('GET', KEYS[10]) or '0') + 1, us)
if tok > 9007199254740991 then return redis.error_reply('ERR PEAKET_FENCE_OVERFLOW ' .. int(tok)) end
local seatEpoch = ensureEpoch(ep, nowSec)
local tokText = int(tok)
local nowText = int(now)
local expText = int(now + tonumber(ARGV[6]))
local keepText = int(keep)
redis.call('SET', KEYS[10], tokText, 'KEEPTTL')

local setBits = {}
local holdKeys = {}
local expiryPairs = {}
for i = 1, #chosen do
  local s = chosen[i]
  setBits[#setBits + 1] = 'SET'
  setBits[#setBits + 1] = 'u1'
  setBits[#setBits + 1] = s.index
  setBits[#setBits + 1] = '1'
  holdKeys[i] = KEYS[s.keyPos]
  expiryPairs[#expiryPairs + 1] = expText
  expiryPairs[#expiryPairs + 1] = s.index
end
redis.call('BITFIELD', KEYS[1], unpack(setBits))
redis.call('DEL', unpack(holdKeys))
for i = 1, #chosen do
  local s = chosen[i]
  local hk = KEYS[s.keyPos]
  redis.call('HSET', hk, 'holdId', ARGV[3], 'owner', ARGV[1], 'psid', ARGV[2], 'fence', tokText, 'heldAt', nowText, 'exp', expText, 'kind', 'FAN', 'ext', '0', 'lim', ARGV[5])
  redis.call('PEXPIREAT', hk, keepText)
end
redis.call('ZADD', KEYS[2], unpack(expiryPairs))
redis.call('INCRBY', KEYS[3], int(#chosen))
local seatList = {}
for i = 1, #chosen do seatList[i] = chosen[i].index end
redis.call('HSET', KEYS[5], 'fp', ARGV[4], 'resp', ARGV[3] .. ':' .. nowText .. ':' .. expText .. ':' .. tokText, 'seats', table.concat(seatList, ','), 'assign', chosenResult)
redis.call('PEXPIRE', KEYS[5], ARGV[6])

-- 바뀐 구역마다 일련번호 +1(처음 나온 차례), 그 구역 좌석의 델타 글
local sections = {}
local seenSec = {}
local version = {}
local deltas = {}
for i = 1, #chosen do
  local s = chosen[i]
  if not seenSec[s.sectionIndex] then
    seenSec[s.sectionIndex] = true
    sections[#sections + 1] = s.sectionIndex
    version[s.sectionIndex] = redis.call('HINCRBY', KEYS[9], s.sectionIndex, 1)
    deltas[s.sectionIndex] = {}
  end
  local d = deltas[s.sectionIndex]
  d[#d + 1] = s.seatOffset .. ':1'
end

-- 좌석마다 HELD 한 건
for i = 1, #chosen do
  local s = chosen[i]
  redis.call('XADD', KEYS[4], '*',
    'type', 'HELD', 'seatIdx', s.index, 'seatId', s.seatId, 'tierId', s.tierId, 'sectionId', s.sectionId,
    'holdId', ARGV[3], 'holdKind', 'FAN', 'purchaseSessionId', ARGV[2], 'accountId', ARGV[1],
    'fencingToken', tokText, 'sectionVersion', int(version[s.sectionIndex]), 'seatEpoch', seatEpoch,
    'occurredAtMs', nowText, 'expiresAtMs', expText)
end

-- 구역마다 샤드 Pub/Sub 한 건: '1 {seatEpoch} {구역 색인} {구역 번호} {바꾼 시각} {seatOffset}:1 …'
for _, sec in ipairs(sections) do
  redis.call('SPUBLISH', ARGV[8] .. sec, '1 ' .. seatEpoch .. ' ' .. sec .. ' ' .. int(version[sec]) .. ' ' .. nowText .. ' ' .. table.concat(deltas[sec], ' '))
end

-- 다음 커서: 고른 묶음 다음부터(페이지 끝을 넘으면 부르는 쪽이 0으로 되돌린다)
local nextCursor = int(tonumber(ARGV[10]) + chosenGroup)
-- 공유 커서는 앞으로만 간다(늦게 끝난 요청이 낮은 커서를 덮어써 다음 요청이 빈 블록을 건너뛰지 않게)
local curCursor = tonumber(redis.call('HGET', KEYS[11], ARGV[9]) or '0')
if tonumber(nextCursor) > curCursor then redis.call('HSET', KEYS[11], ARGV[9], nextCursor) end
for _, k in ipairs({KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[6], KEYS[9], KEYS[10], KEYS[11]}) do extend(k, keep) end
return {'OK', tokText, nowText, expText, table.concat(seatList, ','), chosenResult, nextCursor}
`;
