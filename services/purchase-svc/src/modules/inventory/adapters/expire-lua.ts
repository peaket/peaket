// 운영 만료 Lua와 만료 임대 Lua의 계약(docs/features/seat-hold.md §5 '운영 만료 Lua와 1초 반복'·'방금 놓은 좌석', docs/data.md §3 좌석 키 표(stream의 EXPIRED 칸),
// BUILD_ORDER PRF-135, ADR-0086 결정 9·0109·0121·0161·0176 결정 3). 키·칸 이름의 정본은 docs/data.md §3이다. 문자열만 두고 아무것도 가져오지 않는다
// (측정 도구 loadtest/poc/seat-lua.mjs가 형 지우기만으로 읽는다. 그래서 홀드 Lua의 작은 도우미 int·extend를 여기에도 둔다).
// 메모리 구현(memory-seat-store.ts의 expire, memory-sweep-leases.ts)이 같은 계약을 따른다. 결과의 뜻은 domain/ports.ts SeatExpiries.expire·SweepLeases.acquire.
//
// ── 만료 Lua(EXPIRE_LUA) ───────────────────────────────────────────────────────────────────────────────────────
// 규칙
// - 원문 첫 줄은 `#!lua`(ADR-0086). 쓰거나 읽는 키는 모두 KEYS로 받는다. 키는 모두 회차 해시 태그 {event:E} 하나의 슬롯이다.
// - 서버 시각은 Redis TIME을 한 번만 읽는다: µs = 초 × 1,000,000 + 마이크로초, now = floor(µs / 1000)(ms). keepUntil 비교·펜싱 확인의 exp 비교·rel 점수·사건 시각에
//   같은 값을 쓴다.
// - 검사를 모두 마친 뒤에만 쓴다(홀드 Lua와 같은 '검사 뒤 쓰기'). 큰 정수는 string.format('%.0f', x)로 글로 바꾼다.
// - XADD에 길이 상한을 두지 않는다(지우기는 릴레이의 XTRIM … MINID). 메모리가 차도 돌게 하는 표시를 쓰지 않는다(메모리 부족이면 시작 전에 거절되고 RB-06을 따른다).
// - 구매 세션의 홀드 목록(s:session)·fence·멱등 기록·ordered·paused는 건드리지 않는다.
// - 한 번에 좌석 n ≤ 100(EXPIRY_BATCH_SIZE)이라 SLOWLOG에 남지 않게 한다(S-T27, ASVS 15.4.4).
// - 명령 묶기(추천 적용 2026-11-04 M4, 동작 같음): 만료 인덱스 점수는 ZMSCORE 한 번, 비트 끄기는 BITFIELD … SET u1 i 0 한 번, 홀드 Hash 지우기는 DEL 한 번,
//   만료 인덱스 빼기는 ZREM 한 번(고아 포함), rel은 계정마다 ZADD 한 번, 보유 수는 MGET 한 번, 바뀔 구역의 secver 칸은 HMGET 한 번이다.
//   홀드 Hash가 있는지는 3의 TYPE 결과('none')로 본다(EXISTS를 따로 부르지 않는다). 가르기 반복에서 계정별 푼 좌석 목록을 만들어 계정 × 좌석 이중 반복이 없다.
//   unpack으로 넘기는 인자는 많아야 BITFIELD의 4 × 100 = 400개라 Lua C 스택 한도(LUAI_MAXCSTACK 8000) 안이다. 묶음 상한(100석)을 크게 올리면 다시 본다.
//
// KEYS(차례 고정, 모두 s:{event:E}: 아래). n = 좌석 수, m = 계정 수(n개 좌석의 expected.owner를 처음 나온 차례로 겹침 없이. 고아는 계정이 없다)
//   1 bitmap  2 expiry  3 stream  4 epoch  5 secver
//   6 .. 5 + n                hold:{좌석 색인}(ARGV 좌석과 같은 차례)
//   6 + n .. 5 + n + m        quota:{계정 j}(j = 1..m)
//   6 + n + m .. 5 + n + 2m   rel:{계정 j}(j = 1..m, quota와 같은 계정 차례)
//   그래서 #KEYS = 5 + n + 2m.
//
// ARGV
//   1 다시 잡기 대기 ms(REHOLD_WAIT_MS 30000)  2 구역 채널 이름 앞머리('s:{event:E}:sec:')  3 키 만료 시각 epoch ms(keepUntil, 홀드 Lua ARGV 7과 같은 값)  4 m
//   5 .. 4 + m: 계정 ID(KEYS의 quota·rel과 같은 차례)
//   5 + m + 9(i − 1) .. 13 + m + 9(i − 1): 좌석 i(1부터)의 9칸
//     ① 좌석 색인 ② 기대 holdId ③ 기대 펜싱 토큰 글 ④ 계정 번호(1..m) ⑤ 구역 색인 ⑥ 구역 안 거리(seatOffset) ⑦ 좌석 ID ⑧ 등급 ID ⑨ 구역 ID
//     고아(1단계에서 Hash가 없던 좌석, expected null)는 ②·③ = ''·④ = '0'이다. seat가 없으면(고아, 좌석맵 판에 없는 색인) ⑤~⑨ = ''다.
//     좌석맵 판에 없는 색인(추천 적용 2026-11-04)도 기대값이 맞으면 그대로 푼다: EXPIRED의 seatId·tierId·sectionId·sectionVersion이 빈 글이고,
//     그 좌석 몫의 secver 올리기·샤드 Pub/Sub는 없다.
//   그래서 #ARGV = 4 + m + 9n. 어긋나면 'ERR PEAKET_EXPIRE_ARGS …'.
//   구역 일련번호 글은 int()로 쓴다(표준 10진 정수 끝값 18자리를 HINCRBY한 큰 수도 지수 표기 없이 글로 싣는다, A1).
//   알려진 한계(seat-hold.md §5): Lua의 수는 64비트 실수라 보유 수가 18자리 끝값이면 −k 뒤 값이 반올림되어 19자리가 되고 다음 홀드가 CORRUPT_KEY로 거절된다
//   (정상 운영의 보유 수는 한도 이하라 망가진 값에서만 생긴다. 고치지 않는다).
//
// 차례(seat-hold.md §5 '검사' 1~4, 망가진 키 격리는 추천 적용 2026-11-04 M2)
//   1 HGET epoch 'epoch'이 없음                                  → {'NOT_READY'}(아무것도 쓰지 않는다)
//   2 TIME 한 번(now, µs)
//   3a 묶음 전체 오류(걸리면 고아 ZREM을 포함해 아무것도 쓰지 않고 스크립트 오류)
//       keepUntil ≤ now                                           → 'ERR PEAKET_KEEP_UNTIL_PAST keepUntil … now …'
//       키 형: bitmap string(L1) · expiry zset · stream stream · secver hash(키가 없으면 통과)  → 'ERR PEAKET_CORRUPT_KEY {키}'
//   3b 좌석·계정 몫의 망가짐(그 좌석만 망가짐 c로 두고 건드리지 않는다)
//       계정 j: quota가 string이 아니거나 값이 표준 10진 정수가 아님(canon: '0' 또는 첫 자리 1~9에 18자리 이하, A1), rel이 zset이 아님(없으면 통과)
//                                                                                                      → expected 계정이 j인 좌석
//       구역: secver의 바뀔 구역(⑤가 빈 글이 아닌 좌석의 구역) 칸 값이 있는데 표준 10진 정수가 아님(A1) → 그 구역의 좌석
//       좌석: hold:{i}가 hash·none이 아님, 또는 hash인데 holdId·owner·fence·exp 가운데 하나라도 없거나 exp가 ^%d+$가 아님,
//             또는 fence가 앞 0 없는 양의 10진 정수가 아니거나 2^53 − 1(9007199254740991)을 넘음(safeFence, A2. 15자리 이하는 통과, 16자리는 글 비교).
//             앱의 fencingTokenOf가 안전한 정수만 받으므로 모양만 보고 풀면 푼 뒤에 앱이 던진다
//       홀드 Hash가 없는(none) 좌석은 계정·구역 몫과 관계없이 4로 간다(고아 ZREM은 망가진 계정·구역 키를 건드리지 않는다)
//   4 망가지지 않은 좌석마다 펜싱 확인으로 가르기(쓰지 않는다): ZMSCORE expiry 색인…(한 번), HMGET hold:{i} holdId owner psid fence exp kind
//       Hash 있음 · holdId = ② · fence = ③ · owner = 계정 ④ · exp ≤ now · 점수 있음 → 푼다(r)
//       Hash 없음(TYPE none) · 점수 있음                                       → 고아(o, ZREM만)
//       그 밖                                                                   → 건너뜀(s)
//   5 쓰기
//       ZREM expiry (고아 + 푼 좌석의 색인)… 한 번
//       푼 좌석이 있으면: BITFIELD bitmap SET u1 색인 0 … 한 번, DEL hold:{i}… 한 번
//       계정마다(푼 좌석 k > 0개) 새 값 = quota − k: 0 이하면 DEL quota, 아니면 SET quota 새 값 KEEPTTL
//       계정마다(푼 좌석 k > 0개) ZREMRANGEBYSCORE rel -inf now → ZADD rel (now + ARGV 1) 색인 … 한 번 → PEXPIRE rel ARGV 1
//       바뀐 구역마다(⑤가 빈 글이 아닌 푼 좌석 차례로 처음 나온 차례) HINCRBY secver 구역 색인 1
//       푼 좌석마다 XADD stream *(길이 상한 없음) type EXPIRED seatIdx ① seatId ⑦ tierId ⑧ sectionId ⑨ holdId (Hash holdId) holdKind (Hash kind)
//         purchaseSessionId (Hash psid) accountId (Hash owner) fencingToken (Hash fence, 새 토큰을 내지 않는다) sectionVersion 그 구역의 새 번호(⑤가 빈 글이면 빈 글)
//         seatEpoch 세대 occurredAtMs now expiresAtMs (Hash exp)  (data.md §3 stream의 EXPIRED 칸)
//       바뀐 구역마다 SPUBLISH (ARGV 2 .. 구역 색인) '1 {seatEpoch} {구역 색인} {구역 번호} {now} {seatOffset}:0 …'(그 구역의 푼 좌석을 좌석 차례로, 상태 0 = 가능)
//       푼 좌석이 있으면 stream·secver: PEXPIRETIME < keepUntil(만료 없음 −1 포함)이면 PEXPIREAT keepUntil(홀드 Lua의 extend와 같다)
//   6 돌려주기 {'OK', µs 글, 푼 수, 건너뛴 수, 고아 수, 색인₁, 토큰₁, 색인₂, 토큰₂, …}(푼 좌석만 좌석 차례로, 토큰은 Hash fence 글).
//     망가진 좌석 수는 싣지 않는다(답 꼴 그대로. 앱이 n − (푼 + 건너뛴 + 고아)로 센다)
//
// 앱(RedisSeatStore.expire)은 µs·수를 Number로, 토큰 글을 안전한 정수로 바꾼다(아니면 Error). 결과의 색인이 입력에 없거나 길이가 푼 수와 맞지 않으면 Error.
//
// ── 만료 임대 Lua(SWEEP_LEASE_LUA, 추천 적용 2026-11-04 L2) ─────────────────────────────────────────────────────────
// KEYS: 1 sweep(s:{event:E}:sweep). ARGV: 1 파드 ID, 2 수명 ms. 첫 줄 `#!lua`, 한 번에 끝난다(읽은 뒤 다른 파드가 끼어들 틈이 없다).
//   GET sweep = ARGV 1   → PEXPIRE sweep ARGV 2, 돌려주기 1
//   GET sweep 없음       → SET sweep ARGV 1 NX PX ARGV 2, 돌려주기 1
//   그 밖(다른 파드 값)  → 아무것도 하지 않고 0
// allow-oom 표시가 없어 메모리 부족이면 시작 전에 거절된다(앱이 SeatStoreUnavailable reason 'oom'으로 바꾼다).

/** 만료 Lua 원문(위 계약). 첫 줄이 #!lua다 */
export const EXPIRE_LUA = `#!lua
local function int(x)
  return string.format('%.0f', x)
end
local function extend(key, ms)
  if redis.call('PEXPIRETIME', key) < ms then redis.call('PEXPIREAT', key, int(ms)) end
end

local m = tonumber(ARGV[4])
local n = m and (#ARGV - 4 - m) / 9 or 0
if not m or m < 0 or n < 1 or n ~= math.floor(n) or #KEYS ~= 5 + n + 2 * m then
  return redis.error_reply('ERR PEAKET_EXPIRE_ARGS KEYS ' .. #KEYS .. ' ARGV ' .. #ARGV)
end
local function at(i, k)
  return ARGV[4 + m + 9 * (i - 1) + k]
end
local function quotaKey(j)
  return KEYS[5 + n + j]
end
local function relKey(j)
  return KEYS[5 + n + m + j]
end
local function corrupt(key)
  return redis.error_reply('ERR PEAKET_CORRUPT_KEY ' .. key)
end
local function typeOf(key)
  return redis.call('TYPE', key).ok
end
-- 표준 10진 정수(추천 적용 2026-11-04 A1): '0'이거나 첫 자리 1~9에 18자리 이하. INCRBY·HINCRBY가 받는 값이다(앞 0·소수·빈 글·int64 밖은 받지 않는다)
local function canon(v)
  return v == '0' or (#v <= 18 and string.match(v, '^[1-9]%d*$') ~= nil)
end
-- 홀드 Hash의 fence 칸(추천 적용 2026-11-04 A2): 앞 0 없는 양의 10진 정수이고 2^53 − 1(9007199254740991) 이하. 앱의 fencingTokenOf가 안전한 정수만 받는다
local function safeFence(v)
  if not string.match(v, '^[1-9]%d*$') then return false end
  return #v < 16 or (#v == 16 and v <= '9007199254740991')
end

-- 1 세대 키
local seatEpoch = redis.call('HGET', KEYS[4], 'epoch')
if not seatEpoch then return {'NOT_READY'} end

-- 2 서버 시각은 여기서 한 번만 읽는다
local t = redis.call('TIME')
local us = tonumber(t[1]) * 1000000 + tonumber(t[2])
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

-- 3a 묶음 전체 오류: 지난 keepUntil, 키 전체의 형(여기까지 아무것도 쓰지 않았다)
local keep = tonumber(ARGV[3])
if not keep or keep <= now then return redis.error_reply('ERR PEAKET_KEEP_UNTIL_PAST keepUntil ' .. ARGV[3] .. ' now ' .. int(now)) end
for _, kt in ipairs({{KEYS[1], 'string'}, {KEYS[2], 'zset'}, {KEYS[3], 'stream'}, {KEYS[5], 'hash'}}) do
  local ty = typeOf(kt[1])
  if ty ~= 'none' and ty ~= kt[2] then return corrupt(kt[1]) end
end

-- 3b 계정 몫: 보유 수는 MGET 한 번(문자열이 아닌 키는 nil이라 그 계정만 TYPE으로 없음·형 틀림을 가른다), rel은 TYPE
local held = {}
local badAccount = {}
if m > 0 then
  local qkeys = {}
  for j = 1, m do qkeys[j] = quotaKey(j) end
  local q = redis.call('MGET', unpack(qkeys))
  for j = 1, m do
    local v = q[j]
    if v then
      if canon(v) then held[j] = tonumber(v) else badAccount[j] = true end
    elseif typeOf(quotaKey(j)) == 'none' then
      held[j] = 0
    else
      badAccount[j] = true
    end
    local rt = typeOf(relKey(j))
    if rt ~= 'none' and rt ~= 'zset' then badAccount[j] = true end
  end
end
-- 3b 구역 몫: 바뀔 구역의 secver 칸을 HMGET 한 번
local secList = {}
local secSeen = {}
for i = 1, n do
  local sec = at(i, 5)
  if sec ~= '' and not secSeen[sec] then
    secSeen[sec] = true
    secList[#secList + 1] = sec
  end
end
local badSec = {}
if #secList > 0 then
  local v = redis.call('HMGET', KEYS[5], unpack(secList))
  for k, sec in ipairs(secList) do
    if v[k] and not canon(v[k]) then badSec[sec] = true end
  end
end

-- 3b 좌석 몫과 4 펜싱 확인: r 푼다, o 고아, s 건너뜀, c 망가짐(아직 쓰지 않는다)
local members = {}
for i = 1, n do members[i] = at(i, 1) end
local scores = redis.call('ZMSCORE', KEYS[2], unpack(members))
local kinds = {}
local hashes = {}
local freedOf = {}
local released, skipped, orphans = 0, 0, 0
for i = 1, n do
  local hk = KEYS[5 + i]
  local ty = typeOf(hk)
  local kind = 's'
  if ty == 'none' then
    if scores[i] then kind = 'o' end
  elseif ty ~= 'hash' then
    kind = 'c'
  else
    local j = tonumber(at(i, 4))
    local sec = at(i, 5)
    if (j and badAccount[j]) or (sec ~= '' and badSec[sec]) then
      kind = 'c'
    else
      local h = redis.call('HMGET', hk, 'holdId', 'owner', 'psid', 'fence', 'exp', 'kind')
      if not h[1] or not h[2] or not h[4] or not h[5] or not string.match(h[5], '^%d+$') or not safeFence(h[4]) then
        kind = 'c'
      elseif j and j >= 1 and j <= m and scores[i] and h[1] == at(i, 2) and h[4] == at(i, 3) and h[2] == ARGV[4 + j] and tonumber(h[5]) <= now then
        kind = 'r'
        hashes[i] = h
        local list = freedOf[j]
        if not list then
          list = {}
          freedOf[j] = list
        end
        list[#list + 1] = i
      end
    end
  end
  kinds[i] = kind
  if kind == 'r' then
    released = released + 1
  elseif kind == 'o' then
    orphans = orphans + 1
  elseif kind == 's' then
    skipped = skipped + 1
  end
end

-- 5 쓰기(고아와 푼 좌석의 만료 인덱스 멤버를 한 번에 뺀다)
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
  -- 보유 수 −k(0 이하면 지우고, 아니면 걸린 수명을 지우지 않게 KEEPTTL), 방금 놓은 좌석(지난 점수 지우기 → 지금 + 30초 → 수명 30초)
  local relScore = int(now + tonumber(ARGV[1]))
  for j = 1, m do
    local list = freedOf[j]
    if list then
      local left = held[j] - #list
      if left <= 0 then
        redis.call('DEL', quotaKey(j))
      else
        redis.call('SET', quotaKey(j), int(left), 'KEEPTTL')
      end
      redis.call('ZREMRANGEBYSCORE', relKey(j), '-inf', int(now))
      local z = {}
      for _, i in ipairs(list) do
        z[#z + 1] = relScore
        z[#z + 1] = at(i, 1)
      end
      redis.call('ZADD', relKey(j), unpack(z))
      redis.call('PEXPIRE', relKey(j), ARGV[1])
    end
  end
  -- 바뀐 구역마다 일련번호 +1(푼 좌석 차례로 처음 나온 차례)과 그 구역의 델타 글. 좌석맵 판에 없는 색인(구역 칸이 빈 글)은 구역이 없다
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
  local nowText = int(now)
  -- 좌석마다 EXPIRED 한 건(길이 상한 없음). 토큰은 그 홀드의 것이다(새 토큰을 내지 않는다)
  for i = 1, n do
    if kinds[i] == 'r' then
      local h = hashes[i]
      local sec = at(i, 5)
      local sv = ''
      if sec ~= '' then sv = int(version[sec]) end
      redis.call('XADD', KEYS[3], '*',
        'type', 'EXPIRED', 'seatIdx', at(i, 1), 'seatId', at(i, 7), 'tierId', at(i, 8), 'sectionId', at(i, 9),
        'holdId', h[1], 'holdKind', h[6] or '', 'purchaseSessionId', h[3] or '', 'accountId', h[2],
        'fencingToken', h[4], 'sectionVersion', sv, 'seatEpoch', seatEpoch,
        'occurredAtMs', nowText, 'expiresAtMs', h[5])
      out[#out + 1] = at(i, 1)
      out[#out + 1] = h[4]
    end
  end
  -- 구역마다 샤드 Pub/Sub 한 건: '1 {seatEpoch} {구역 색인} {구역 번호} {바꾼 시각} {seatOffset}:0 …'
  for _, sec in ipairs(sections) do
    redis.call('SPUBLISH', ARGV[2] .. sec, '1 ' .. seatEpoch .. ' ' .. sec .. ' ' .. int(version[sec]) .. ' ' .. nowText .. ' ' .. table.concat(deltas[sec], ' '))
  end
  extend(KEYS[3], keep)
  extend(KEYS[5], keep)
end
return out
`;

/** 만료 임대 Lua 원문(위 계약, L2). 첫 줄이 #!lua다 */
export const SWEEP_LEASE_LUA = `#!lua
local cur = redis.call('GET', KEYS[1])
if cur == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
if not cur then
  redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2])
  return 1
end
return 0
`;
