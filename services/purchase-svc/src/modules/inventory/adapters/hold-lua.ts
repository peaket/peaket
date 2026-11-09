// 운영 홀드 Lua의 계약(docs/features/seat-hold.md §3 '운영 홀드 Lua의 키·입력·검사 차례'·§5, docs/data.md §3 좌석 키 표, ADR-0086·0103·0121·0161).
// 키·칸 이름의 정본은 docs/data.md §3이다. 문자열만 두고 아무것도 가져오지 않는다(시험: test/hold-cases.ts, test-int/seat-store.int.test.ts).
// 메모리 구현(memory-seat-store.ts)이 같은 계약을 따른다.
//
// 규칙
// - 원문 첫 줄은 `#!lua`(ADR-0086). 쓰거나 읽는 키는 모두 KEYS로 받는다. 키는 모두 회차 해시 태그 {event:E} 하나의 슬롯이다.
// - 서버 시각은 Redis TIME을 맨 앞에서 한 번만 읽는다: µs = 초 × 1,000,000 + 마이크로초, now = heldAt = floor(µs / 1000)(ms). 검사 1의 세대 확인(초),
//   검사 5의 비교와 쓰기에 같은 값을 쓴다.
// - 큰 정수(토큰 약 1.7e15)는 string.format('%.0f', x)로 글로 바꿔 쓰고 돌려준다(Lua 5.1 tostring은 유효 숫자 14자리). 2^53 아래라 double로 정확하다.
//   앱(RedisSeatStore)은 돌려받은 토큰 글을 Number로 바꾸고, 안전한 정수가 아니면 Error를 던진다.
// - 검사를 모두 마친 뒤에만 쓴다(Valkey는 이미 한 쓰기를 되돌리지 않으므로 '검사 뒤 쓰기'로 전부 되거나 전부 안 되게 한다).
//   하나만 예외다: 세대 확인(ENSURE_EPOCH의 ensureEpoch)은 거절 결과(2~6)를 돌려주기 직전에도 한 번 돌아 세대 키의 epoch·node·chk·bumps를 쓸 수 있다
//   (장애 조치 뒤 그 자리 올리기, ADR-0210 결정 1. 올리기는 안전하고 한 번만 오르므로 거절로 끝나는 호출도 올린다). 오류로 끝나는 검사(멱등 응답 모양,
//   쓰기 전 지킴, 토큰 넘침)는 모두 그 앞이라 오류면 세대 키도 바꾸지 않는다(리뷰 고침 결함 1). 쓰기(7)의 Stream HELD·델타의 seatEpoch는 도우미가 돌려준 세대다.
// - PoC loadtest/poc/bench/lua/hold.lua의 한도 먼저 검사, INCR 토큰, 멱등 60초 글, XADD MAXLEN, 세대 키 GET은 따르지 않는다.
//
// KEYS(차례 고정, 모두 s:{event:E}: 아래). 좌석 수 n = #KEYS − 10
//   1 bitmap                 비트맵(색인 = 좌석 색인)
//   2 expiry                 만료 인덱스 ZSET(멤버 = 좌석 색인 10진 글, 점수 = exp ms)
//   3 quota:{account}        보유 수(10진 정수 글)
//   4 stream                 사건 Stream
//   5 idem:{account}:{key}   멱등 기록 Hash: fp(지문), resp('{holdId}:{heldAt}:{exp}:{fencingToken}')
//   6 epoch                  세대 키 Hash: epoch(세대 seatEpoch), node(주 노드 표지), chk(설정 세대까지 견준 초), bumps(올린 누적 수). epoch 칸이 없으면 NOT_READY
//   7 ctl                    판매 정지 사본 Hash: paused·suspended(회차 범위)·allPaused(전체 범위) 가운데 하나라도 '1'이면 정지. 키·칸이 없으면 정지 아님
//                            (rev·cmd·suspRef·allRev·allCmd는 쓰는 쪽의 판 번호 칸이라 이 Lua는 보지 않는다)
//   8 rel:{account}          방금 놓은 좌석 ZSET(멤버 = 좌석 색인, 점수 = 다시 잡을 수 있는 시각 ms)
//   9 secver                 구역별 일련번호 Hash(칸 = 구역 색인 10진 글)
//  10 fence                  회차의 마지막 펜싱 토큰(10진 글, 없으면 0)
//  11.. hold:{좌석 색인}    좌석마다 하나, ARGV 9부터의 좌석과 같은 차례(좌석 ID 오름차순)
//
// ARGV
//   1 소유 계정 ID  2 구매 세션 ID  3 holdId  4 요청 지문(hex 64)  5 1인 한도  6 홀드 TTL ms(420000. 멱등 기록 수명도 이 값, IDEM_TTL_MS = HOLD_TTL_MS)
//   7 키 만료 시각 epoch ms(keepUntil = 판매 종료 + 1일)  8 구역 채널 이름 앞머리('s:{event:E}:sec:')
//   9 + 6(i − 1) .. 14 + 6(i − 1): 좌석 i(1부터)의 좌석 색인, 구역 색인, 구역 안 거리(seatOffset), 좌석 ID, 등급 ID, 구역 ID
//
// 검사 차례(앞이 걸리면 뒤는 보지 않는다)
//   1 세대 키 readEpoch(epoch): epoch 칸이 없음 → {'NOT_READY'}(아무것도 쓰지 않는다). epoch 칸이 u32가 아니거나 bumps 칸이 망가짐 → 'PEAKET_CORRUPT_KEY {세대 키}'.
//     세대 확인 ensureEpoch(TIME 초)는 2~6의 거절을 돌려주기 직전과 7의 쓰기 앞에서 한 번 돈다: 지금 노드 표지와 견줘 다르면 그 자리에서 올린다
//     (ENSURE_EPOCH, ADR-0210. 거절이어도 올린 것은 남는다. 2의 멱등 응답 모양 오류와 쓰기 전 지킴·토큰 넘침 오류에는 돌지 않는다)
//   2 idem이 있음: fp가 같으면                      → {'IDEM_REPLAY', holdId, heldAt, exp, 토큰 글}(resp를 풀어서)
//                  fp가 다르면                      → {'IDEM_REUSED'}   (좌석을 보지 않는다)
//   3 ctl paused·allPaused·suspended 가운데 '1'      → {'PAUSED'}
//   4 좌석 차례로 비트 = 1인 첫 좌석                 → {'CONFLICT', 좌석 색인}(BITFIELD_RO … GET u1 색인 한 번)
//   5 rel 점수 > now인 좌석이 있음                   → {'REHOLD_WAIT', 가장 늦은 점수, 좌석 색인 …}(좌석 차례, ZMSCORE 한 번)
//     쓰기 전 지킴(추천 적용 2026-11-04, 걸리면 아무것도 쓰지 않고 스크립트 오류):
//       keepUntil ≤ now                              → 'ERR PEAKET_KEEP_UNTIL_PAST …'
//       보유 수 값이 있는데 표준 10진 정수가 아님(canon: '0' 또는 첫 자리 1~9에 18자리 이하, INCRBY가 받는 값. A1) → 'ERR PEAKET_CORRUPT_KEY {quota 키}'
//         ('007'·20자리·'-1'·'1e3'·' 5'·'0x10'·'1.5'·'' 모두 거절. 18자리 끝값은 지나 한도 검사까지 간다)
//       fence 값이 있는데 ^%d+$가 아님(SET만 하는 값이라 앞 0은 받는다. A1이 fence까지 번지지 않는다) → 'ERR PEAKET_CORRUPT_KEY {fence 키}'
//       expiry가 zset·stream이 stream·secver와 hold:{색인}이 hash가 아님(키가 없으면 통과) → 'ERR PEAKET_CORRUPT_KEY {키}'
//       (PRF-130 리뷰 낮음 3, BUILD_ORDER PRF-135)
//       secver의 바뀔 구역(요청 좌석의 구역 색인, ARGV 좌석 ②) 칸 값이 있는데 표준 10진 정수가 아님(칸이 없으면 통과. HINCRBY가 받는 값, A1)
//         → 'ERR PEAKET_CORRUPT_KEY {secver 키}'(형 검사 뒤에 HMGET secver 바뀔 구역들 한 번으로 본다. 바뀌지 않을 구역의 칸은 보지 않는다)
//       구역 일련번호 글은 int()로 쓴다(표준 10진 정수 끝값 18자리를 HINCRBY한 큰 수도 지수 표기 없이 글로 싣는다)
//   6 보유 수 + n > 한도                             → {'QUOTA_EXCEEDED'}
//   7 쓰기                                           → {'OK', 토큰 글, heldAt, exp}
//
// 쓰기(7)
//   - exp = heldAt + TTL. 토큰 = max((GET fence 또는 0) + 1, µs). SET fence 토큰 글.
//   - 비트 켜기는 BITFIELD bitmap SET u1 색인 1 … 한 번, hold 키는 DEL 한 번에 지운 뒤 좌석마다 HSET hold = holdId·owner·psid·fence(토큰 글)·heldAt·exp·
//     kind 'FAN'·ext '0', 만료 인덱스는 ZADD expiry exp 색인 exp 색인 … 한 번.
//   - INCRBY quota n. HSET idem fp 지문 resp '{holdId}:{heldAt}:{exp}:{토큰 글}', PEXPIRE idem TTL.
//   - 바뀐 구역마다(좌석 차례로 처음 나온 차례) HINCRBY secver 구역 색인 1.
//   - 좌석마다 XADD stream *(길이 상한 없음) type HELD seatIdx 좌석 색인 seatId tierId sectionId holdId holdKind FAN purchaseSessionId accountId
//     fencingToken 토큰 글 sectionVersion 그 구역의 새 번호 seatEpoch 세대 occurredAtMs heldAt expiresAtMs exp.
//   - 바뀐 구역마다 SPUBLISH (ARGV 8 .. 구역 색인) '1 {seatEpoch} {구역 색인} {구역 번호} {heldAt} {seatOffset}:1 …'(그 구역 좌석을 좌석 차례로, 상태 1 = 다른 분 선택).
//   - bitmap·quota·fence·expiry·stream·secver·epoch: PEXPIRETIME < keepUntil(만료 없음 −1 포함)이면 PEXPIREAT keepUntil.
//     hold(좌석마다)는 방금 지우고 새로 쓴 키라 수명이 없으므로 PEXPIRETIME을 보지 않고 PEXPIREAT keepUntil만 건다(동작 같음).
//     fence는 SET … KEEPTTL로 써서 걸려 있던 수명을 지우지 않는다.
//   - 명령 묶기(추천 적용 2026-11-04 M3, 동작 같음): 위 BITFIELD_RO·ZMSCORE·secver HMGET·BITFIELD·DEL·ZADD 한 번씩. unpack 인자는 많아야 4 × 10 = 40개다.

//
// 덧붙인 지킴(추천 적용 2026-11-04): 쓰기 직전에 토큰이 2^53 − 1(안전한 정수)을 넘으면 아무것도 쓰지 않고 스크립트 오류(PEAKET_FENCE_OVERFLOW)를 낸다.
// 앱은 그것을 일시 장애가 아닌 Error로 던진다(받는 쪽이 JSON 정수로 토큰을 정확히 읽지 못하는 값을 내지 않는다).

/** 큰 정수를 지수 표기 없이 10진 글로(Lua 5.1 tostring은 유효 숫자 14자리) */
const INT_TEXT = `
local function int(x)
  return string.format('%.0f', x)
end
`;

// 키 수명은 더 늦은 쪽으로만 늘린다. 수명이 없는 키(-1)와 이번에 새로 생긴 키에도 건다
const EXTEND = `
local function extend(key, ms)
  if redis.call('PEXPIRETIME', key) < ms then redis.call('PEXPIREAT', key, int(ms)) end
end
`;

// 지금 노드 표지(ADR-0181, 대기열 q:{event:E}:epoch의 node와 같은 모양): 클러스터 모드는 '{CLUSTER MYID}:{설정 세대 cluster_my_epoch}',
// 단일 노드('cluster support disabled')만 'standalone'. 다른 오류(권한 등)는 조용히 넘어가지 않게 'PEAKET_NODE_ID {오류 글}' 스크립트 오류로 끝낸다
// (CLUSTER MYID·CLUSTER INFO 둘 다. 앱의 지표 갈래는 NODE_ID, domain/lua-errors.ts. 리뷰 고침 중간 2).
// 세대 키 node를 쓰는 Lua(판매 열기, rebuild-lua.ts의 끝내기·세대 올리기, 좌석을 쓰는 Lua의 ENSURE_EPOCH)가 모두 이 도우미 하나를 쓴다
// (같은 표지여야 장애 조치가 없을 때 세대가 오르지 않는다, BUILD_ORDER PRF-168, ADR-0210 결정 4). 부르는 Lua는 첫 쓰기 앞에서 부른다(실패하면 아무것도 쓰지 않는다).
// myId()는 노드 ID만(CLUSTER MYID, O(1)), valueOf(id)는 설정 세대까지 붙인 전체 표지(CLUSTER INFO는 슬롯 16,384개를 세므로 쓰는 Lua는 회차마다 1초에 한 번만 부른다, ENSURE_EPOCH).
// 이 파일은 아무것도 가져오지 않아야 해서(loadtest/poc/seat-lua.mjs가 형 지우기만으로 읽는다) 여기 두고 내보낸다
export const NODE_ID = `
local function myId()
  local id = redis.pcall('CLUSTER', 'MYID')
  if type(id) == 'table' and id.err then
    if string.find(id.err, 'cluster support disabled', 1, true) then return 'standalone' end
    error('PEAKET_NODE_ID ' .. id.err)
  end
  return id
end
local function valueOf(id)
  if id == 'standalone' then return id end
  local info = redis.pcall('CLUSTER', 'INFO')
  if type(info) == 'table' and info.err then error('PEAKET_NODE_ID ' .. info.err) end
  return id .. ':' .. (string.match(info, 'cluster_my_epoch:(%d+)') or '0')
end
local function nodeId()
  return valueOf(myId())
end
`;

// 세대 확인과 그 자리 올리기(ADR-0210 결정 1·2, docs/features/seat-hold.md §6 '쓰는 Lua가 그 자리에서 올린다', docs/data.md §3 s:{event:E}:epoch의 node·chk·bumps).
// 좌석을 쓰는 Lua(홀드·만료·묶기·실패 해제)와 세대 올리기 Lua(rebuild-lua.ts BUMP_EPOCH_LUA)가 쓴다. NODE_ID를 함께 싣는다. 두 걸음이다:
// readEpoch(세대 키) → 세대 키 칸 묶음 ep 또는 nil. 맨 앞(세대 키를 읽는 곳)에서 부른다. 쓰지 않고 CLUSTER 명령을 부르지 않는다
//   - epoch 칸이 없으면 nil(부른 쪽이 NOT_READY)
//   - HMGET 바로 뒤에 epoch 칸이 u32(앞 0 없는 0 ~ 4294967295, 스냅샷 Lua의 u32와 같은 규칙)가 아니거나 bumps 칸이 있는데 표준 10진 정수
//     ('0' 또는 첫 자리 1~9에 18자리 이하)가 아니면 'PEAKET_CORRUPT_KEY {세대 키}' 스크립트 오류(올리든 아니든 모든 갈래, 리뷰 고침 낮음 a)
//   - ep = { key, epoch(글), node(없으면 ''), chk(수, 없거나 수가 아니면 0), bumps(글, 없으면 '0') }
// ensureEpoch(ep, 지금 TIME 초) → 지금 세대 글, 올렸는지, 올린 누적 수 글. 부른 Lua의 첫 쓰기다(리뷰 고침 결함 1, 2026-11-05):
//   오류로 끝나는 검사(키 형·값 모양 CORRUPT_KEY, 인자, 지난 keepUntil, 멱등 응답 모양, 토큰 넘침)를 모두 지난 뒤, 업무 판정(거절 결과)을 돌려주기 전에 한 번 부른다.
//   그래서 오류로 끝나는 호출은 세대 키를 하나도 바꾸지 않고, 거절로 끝나 쓰지 않는 호출도 올리기는 한다(올리기는 안전하고 한 번만 오른다)
//   - 노드 ID(CLUSTER MYID)는 매번 구해 저장된 node의 ':' 앞과 견준다. 같고 chk = 지금 초면 이번 초에 이미 설정 세대까지 견줬다: 아무것도 쓰지 않고 저장된 세대.
//     chk가 지금 초보다 크면(시계가 뒤로 가 남은 미래의 chk) 같은 초로 보지 않는다(리뷰 고침 낮음 d)
//   - 그 밖이면 전체 표지(클러스터는 CLUSTER INFO의 cluster_my_epoch까지)를 구해 저장된 node와 견준다. 같으면 chk = 지금 초만 쓰고 저장된 세대,
//     다르면 epoch = max(epoch + 1, 지금 초)·node = 전체 표지·chk = 지금 초를 쓰고 bumps를 1 더한 뒤(HINCRBY) 새 세대(장애 조치로 복제본이 승격됨.
//     여러 곳이 불러도 한 번만 오른다. bumps는 감시 반복이 차이로 seat_epoch_bumps_total을 낸다, 리뷰 고침 중간 1)
//   - 표지를 구하지 못하면(권한 등) 쓰기 전에 'PEAKET_NODE_ID …' 스크립트 오류. 키 수명은 바꾸지 않는다(HSET·HINCRBY는 칸만 바꾼다)
// 큰 정수 글은 string.format('%.0f')로 쓴다(부르는 Lua의 int 도우미에 기대지 않는다)
export const ENSURE_EPOCH = `${NODE_ID}
local function readEpoch(key)
  local ep = redis.call('HMGET', key, 'epoch', 'node', 'chk', 'bumps')
  local v = ep[1]
  if not v then return nil end
  local u32 = #v <= 10 and string.match(v, '^%d+$') ~= nil and (#v == 1 or string.sub(v, 1, 1) ~= '0') and tonumber(v) <= 4294967295
  local b = ep[4]
  if not u32 or (b and not (b == '0' or (#b <= 18 and string.match(b, '^[1-9]%d*$')))) then error('PEAKET_CORRUPT_KEY ' .. key) end
  return { key = key, epoch = v, node = ep[2] or '', chk = tonumber(ep[3]) or 0, bumps = b or '0' }
end
local function ensureEpoch(ep, sec)
  local id = myId()
  local held = ep.node
  local cut = string.find(held, ':', 1, true)
  local heldId = held
  if cut then heldId = string.sub(held, 1, cut - 1) end
  if heldId == id and ep.chk == sec then return ep.epoch, false, ep.bumps end
  local node = valueOf(id)
  local secText = string.format('%.0f', sec)
  if node == held then
    redis.call('HSET', ep.key, 'chk', secText)
    return ep.epoch, false, ep.bumps
  end
  local nextText = string.format('%.0f', math.max(tonumber(ep.epoch) + 1, sec))
  redis.call('HSET', ep.key, 'epoch', nextText, 'node', node, 'chk', secText)
  return nextText, true, string.format('%.0f', redis.call('HINCRBY', ep.key, 'bumps', 1))
end
`;

/** 안전한 정수의 끝(2^53 − 1). 토큰이 이보다 크면 쓰지 않는다 */
const MAX_SAFE = '9007199254740991';

/** 홀드 Lua 원문(위 계약). 첫 줄이 #!lua다 */
export const HOLD_LUA = `#!lua
${INT_TEXT}${EXTEND}${ENSURE_EPOCH}
local n = #KEYS - 10
if n < 1 or #ARGV ~= 8 + 6 * n then
  return redis.error_reply('ERR PEAKET_HOLD_ARGS KEYS ' .. #KEYS .. ' ARGV ' .. #ARGV)
end
local function at(i, k)
  return ARGV[8 + 6 * (i - 1) + k]
end

-- 서버 시각은 여기서 한 번만 읽는다(세대 확인의 초, 5의 비교와 7의 쓰기에 같은 값)
local t = redis.call('TIME')
local nowSec = tonumber(t[1])
local us = nowSec * 1000000 + tonumber(t[2])
local now = nowSec * 1000 + math.floor(tonumber(t[2]) / 1000)

-- 1 세대 키(읽기만. 망가진 세대 칸은 여기서 오류)
local ep = readEpoch(KEYS[6])
if not ep then return {'NOT_READY'} end
-- 거절 결과를 돌려주기 직전의 세대 확인(장애 조치 뒤면 그 자리에서 올린다, ADR-0210. 오류로 끝나는 검사는 이것을 부르지 않는다)
local function decided(r)
  ensureEpoch(ep, nowSec)
  return r
end

-- 2 멱등 기록(좌석을 보지 않는다)
local idem = redis.call('HMGET', KEYS[5], 'fp', 'resp')
if idem[1] then
  if idem[1] ~= ARGV[4] then return decided({'IDEM_REUSED'}) end
  local holdId, heldAt, exp, tok = string.match(idem[2] or '', '^(.+):(%d+):(%d+):(%d+)$')
  if not holdId then return redis.error_reply('ERR PEAKET_IDEM_RESP ' .. tostring(idem[2])) end
  return decided({'IDEM_REPLAY', holdId, heldAt, exp, tok})
end

-- 3 판매 정지 사본
local ctl = redis.call('HMGET', KEYS[7], 'paused', 'allPaused', 'suspended')
if ctl[1] == '1' or ctl[2] == '1' or ctl[3] == '1' then return decided({'PAUSED'}) end

-- 좌석 색인들(BITFIELD·ZMSCORE·ZADD에 함께 넘긴다)
local idx = {}
for i = 1, n do idx[i] = at(i, 1) end

-- 4 경합(좌석 차례의 첫 충돌): BITFIELD_RO … GET u1 색인 한 번
local probe = {}
for i = 1, n do
  probe[#probe + 1] = 'GET'
  probe[#probe + 1] = 'u1'
  probe[#probe + 1] = idx[i]
end
local bits = redis.call('BITFIELD_RO', KEYS[1], unpack(probe))
for i = 1, n do
  if bits[i] == 1 then return decided({'CONFLICT', idx[i]}) end
end

-- 5 방금 놓은 좌석(점수가 지금보다 큰 것만): ZMSCORE rel 색인 … 한 번
local relScores = redis.call('ZMSCORE', KEYS[8], unpack(idx))
local waits = {}
local latest = 0
for i = 1, n do
  local s = relScores[i]
  if s then
    local v = tonumber(s)
    if v > now then
      waits[#waits + 1] = idx[i]
      if v > latest then latest = v end
    end
  end
end
if #waits > 0 then
  local r = {'REHOLD_WAIT', int(latest)}
  for _, x in ipairs(waits) do r[#r + 1] = x end
  return decided(r)
end

-- 쓰기 전 지킴(추천 적용 2026-11-04): 지난 keepUntil, 표준 10진 정수가 아닌 보유 수·10진 정수 글이 아닌 fence, 형이 틀린 키, 바뀔 구역의 망가진 secver 칸은 아무것도 쓰지 않고 오류다
local keep = tonumber(ARGV[7])
if not keep or keep <= now then return redis.error_reply('ERR PEAKET_KEEP_UNTIL_PAST keepUntil ' .. ARGV[7] .. ' now ' .. int(now)) end
-- 표준 10진 정수(추천 적용 2026-11-04 A1): '0'이거나 첫 자리 1~9에 18자리 이하. INCRBY·HINCRBY가 받는 값이다(앞 0·소수·빈 글·int64 밖은 받지 않는다)
local function canon(v)
  return v == '0' or (#v <= 18 and string.match(v, '^[1-9]%d*$') ~= nil)
end
-- 보유 수는 INCRBY가 건드리므로 표준 10진 정수여야 하고, fence는 SET만 하는 값이라 ^%d+$면 된다(A1이 fence까지 번지지 않는다)
local function digits(key, standard)
  local v = redis.call('GET', key)
  if not v then return '0' end
  if standard then
    if not canon(v) then return nil end
  elseif not string.match(v, '^%d+$') then
    return nil
  end
  return v
end
local heldText = digits(KEYS[3], true)
if not heldText then return redis.error_reply('ERR PEAKET_CORRUPT_KEY ' .. KEYS[3]) end
local fenceText = digits(KEYS[10], false)
if not fenceText then return redis.error_reply('ERR PEAKET_CORRUPT_KEY ' .. KEYS[10]) end
local function typed(key, want)
  local ty = redis.call('TYPE', key).ok
  if ty ~= 'none' and ty ~= want then return false end
  return true
end
for _, kt in ipairs({{KEYS[2], 'zset'}, {KEYS[4], 'stream'}, {KEYS[9], 'hash'}}) do
  if not typed(kt[1], kt[2]) then return redis.error_reply('ERR PEAKET_CORRUPT_KEY ' .. kt[1]) end
end
for i = 1, n do
  if not typed(KEYS[10 + i], 'hash') then return redis.error_reply('ERR PEAKET_CORRUPT_KEY ' .. KEYS[10 + i]) end
end
-- 바뀔 구역(요청 좌석의 구역 색인)의 secver 칸: HMGET 한 번(칸이 없으면 통과. 바뀌지 않을 구역은 보지 않는다)
local sections = {}
local seenSec = {}
for i = 1, n do
  local sec = at(i, 2)
  if not seenSec[sec] then
    seenSec[sec] = true
    sections[#sections + 1] = sec
  end
end
local secNow = redis.call('HMGET', KEYS[9], unpack(sections))
for k = 1, #sections do
  if secNow[k] and not canon(secNow[k]) then return redis.error_reply('ERR PEAKET_CORRUPT_KEY ' .. KEYS[9]) end
end

-- 6 1인 한도
if tonumber(heldText) + n > tonumber(ARGV[5]) then return decided({'QUOTA_EXCEEDED'}) end

-- 7 쓰기(여기까지 아무것도 쓰지 않았다). 토큰 넘침도 오류라 세대 확인보다 앞에서 본다
local tok = math.max(tonumber(fenceText) + 1, us)
if tok > ${MAX_SAFE} then return redis.error_reply('ERR PEAKET_FENCE_OVERFLOW ' .. int(tok)) end
-- 첫 쓰기: 세대 확인(장애 조치 뒤면 그 자리에서 올린다. 아래 Stream·델타는 이 세대를 싣는다)
local seatEpoch = ensureEpoch(ep, nowSec)
local tokText = int(tok)
local nowText = int(now)
local expText = int(now + tonumber(ARGV[6]))
local keepText = int(keep)

-- fence는 수명을 지우지 않게 KEEPTTL로 쓴다(수명은 아래 extend가 늘린다)
redis.call('SET', KEYS[10], tokText, 'KEEPTTL')
-- 비트 켜기는 BITFIELD … SET u1 색인 1 한 번, 홀드 Hash는 한꺼번에 지운 뒤 새로 쓰고, 만료 인덱스는 ZADD 한 번(여러 쌍)
local setBits = {}
local holdKeys = {}
local expiryPairs = {}
for i = 1, n do
  setBits[#setBits + 1] = 'SET'
  setBits[#setBits + 1] = 'u1'
  setBits[#setBits + 1] = idx[i]
  setBits[#setBits + 1] = '1'
  holdKeys[i] = KEYS[10 + i]
  expiryPairs[#expiryPairs + 1] = expText
  expiryPairs[#expiryPairs + 1] = idx[i]
end
redis.call('BITFIELD', KEYS[1], unpack(setBits))
redis.call('DEL', unpack(holdKeys))
for i = 1, n do
  local hk = KEYS[10 + i]
  redis.call('HSET', hk, 'holdId', ARGV[3], 'owner', ARGV[1], 'psid', ARGV[2], 'fence', tokText, 'heldAt', nowText, 'exp', expText, 'kind', 'FAN', 'ext', '0')
  -- 방금 지우고 새로 쓴 키라 수명이 없다(PEXPIRETIME을 보지 않고 건다)
  redis.call('PEXPIREAT', hk, keepText)
end
redis.call('ZADD', KEYS[2], unpack(expiryPairs))
redis.call('INCRBY', KEYS[3], int(n))
redis.call('HSET', KEYS[5], 'fp', ARGV[4], 'resp', ARGV[3] .. ':' .. nowText .. ':' .. expText .. ':' .. tokText)
redis.call('PEXPIRE', KEYS[5], ARGV[6])

-- 바뀐 구역마다 일련번호 +1(처음 나온 차례), 그 구역 좌석의 델타 글
local version = {}
local deltas = {}
for _, sec in ipairs(sections) do
  version[sec] = redis.call('HINCRBY', KEYS[9], sec, 1)
  deltas[sec] = {}
end
for i = 1, n do
  local d = deltas[at(i, 2)]
  d[#d + 1] = at(i, 3) .. ':1'
end

-- 좌석마다 HELD 한 건(길이 상한을 걸지 않는다. 지우기는 릴레이의 XTRIM … MINID)
for i = 1, n do
  redis.call('XADD', KEYS[4], '*',
    'type', 'HELD', 'seatIdx', idx[i], 'seatId', at(i, 4), 'tierId', at(i, 5), 'sectionId', at(i, 6),
    'holdId', ARGV[3], 'holdKind', 'FAN', 'purchaseSessionId', ARGV[2], 'accountId', ARGV[1],
    'fencingToken', tokText, 'sectionVersion', int(version[at(i, 2)]), 'seatEpoch', seatEpoch,
    'occurredAtMs', nowText, 'expiresAtMs', expText)
end

-- 구역마다 샤드 Pub/Sub 한 건: '1 {seatEpoch} {구역 색인} {구역 번호} {바꾼 시각} {seatOffset}:{상태} …'
for _, sec in ipairs(sections) do
  redis.call('SPUBLISH', ARGV[8] .. sec, '1 ' .. seatEpoch .. ' ' .. sec .. ' ' .. int(version[sec]) .. ' ' .. nowText .. ' ' .. table.concat(deltas[sec], ' '))
end

-- 세대 키(KEYS[6])도 같은 규칙으로 늘린다(비트맵보다 먼저 지워져 산 회차가 NOT_READY가 되지 않게)
for _, k in ipairs({KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[6], KEYS[9], KEYS[10]}) do extend(k, keep) end
return {'OK', tokText, nowText, expText}
`;

/**
 * 판매 열기 Lua 원문(SeatStore.openSale). KEYS: 1 bitmap, 2 epoch. ARGV: 1 좌석 수, 2 키 만료 시각 ms.
 * 세대 키의 epoch 칸이 있으면 아무것도 바꾸지 않고 {0, 세대}. 없으면 비트맵을 좌석 수만큼(이미 있으면 모자랄 때만, 있는 비트는 그대로) 만들고
 * 마지막에 세대 키(epoch = TIME 초, node, 다시 만들기 판 번호 gen = '1', 표지를 견준 초 chk = TIME 초)를 써서 {1, 세대}. 두 키의 수명은 keepUntil로 건다.
 * 표지(nodeId())는 비트맵을 쓰기 전에 구한다(구하지 못하면 아무것도 쓰지 않고 'PEAKET_NODE_ID …', 리뷰 고침 낮음 b). bumps 칸은 쓰지 않는다(없으면 0).
 * s:ctl:events SADD는 앱이 먼저 한다(다른 슬롯).
 * gen 칸은 세대 키를 처음 쓸 때만 둔다(이미 열린 회차·gen 칸이 없는 옛 세대 키는 바꾸지 않는다. 칸이 없으면 1로 본다, BUILD_ORDER PRF-142)
 */
export const OPEN_SALE_LUA = `#!lua
${INT_TEXT}${EXTEND}${NODE_ID}
local have = redis.call('HGET', KEYS[2], 'epoch')
if have then return {0, have} end
-- 표지를 먼저 구한다(CLUSTER 명령이 막히면 비트맵도 쓰지 않고 끝난다)
local node = nodeId()
local count = tonumber(ARGV[1])
-- 길이가 모자랄 때만 마지막 비트를 0으로 써서 늘린다(늘어난 자리는 원래 0이라 있던 홀드 비트를 건드리지 않는다)
if redis.call('STRLEN', KEYS[1]) * 8 < count then redis.call('SETBIT', KEYS[1], int(count - 1), 0) end
local sec = redis.call('TIME')[1]
-- chk = 표지를 견준 초(이 초에는 쓰는 Lua가 설정 세대까지 다시 견주지 않는다, ADR-0210 결정 2)
redis.call('HSET', KEYS[2], 'epoch', sec, 'node', node, 'gen', '1', 'chk', sec)
local keep = tonumber(ARGV[2])
extend(KEYS[1], keep)
extend(KEYS[2], keep)
return {1, sec}
`;
