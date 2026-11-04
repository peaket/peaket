// 구매 세션 Lua 계약(BUILD_ORDER PRF-136, docs/features/seat-hold.md §2 '구매 세션 열기와 확인의 첫 구현', docs/data.md §3 s:jti·s:session·s:{event:E}:stream).
// 세 스크립트 모두 첫 줄이 `#!lua`이고 allow-oom 표시가 없다(메모리 부족이면 시작 전에 거절되고 앱이 SeatStoreUnavailable reason 'oom'으로 바꾼다).
// 시각은 모두 Redis TIME을 한 번 읽은 값(밀리초)이다. 10진 글로 쓸 때는 string.format('%.0f')를 쓴다(Lua 5.1 tostring은 1.7e+12꼴로 바꾼다).
//
// ── 열기 Lua(OPEN_SESSION_LUA) ───────────────────────────────────────────────────────────────────────────────────
// KEYS: 1 재사용 차단 표지 s:jti:{jti}, 2 세션 상태 s:session:{jti} (해시 태그가 같아 한 슬롯. sessionKeys)
// ARGV: 1 계정, 2 로그인 세션, 3 회차, 4 여정 ID, 5 클라이언트 임시 공개키 글, 6 최대 체류 ms(이 토큰의 exp), 7 첫 사용 기한 ms, 8 유휴 ms, 9 수명 여유 ms, 10 우선 구매 권리 ID(없으면 빈 글),
//       11 같은 jti로 다시 받을 수 있는 가장 늦은 입장 토큰의 exp ms(이 토큰의 exp 이상), 12 시작 사건 더하기 유예 ms(SESSION_STARTED_GRACE_MS)
// 돌려주는 값(배열의 글): ['TOKEN_EXPIRED'] · ['ENDED'] · ['MISMATCH'] · ['REPLAY', 처음 연 시각, 세션에 적힌 처음 최대 체류, '1' 또는 '0'(시작 사건을 더해야 하나: 표시 sev가 없고 연 지 ARGV 12 ms가 지났다)] · ['FIRST_USE_EXPIRED'] · ['CREATED', 지금]
// 차례(OpenSessionResult의 설명과 같다):
//   1. 지금 ≥ 이 토큰의 최대 체류 → TOKEN_EXPIRED (표지 유무와 관계없이 먼저, 아무것도 쓰지 않는다)
//   2. 표지가 있으면: 세션 상태의 acct·login·event·cpk 칸이 없으면 ENDED, ARGV 1·2·3·5와 모두 같으면 REPLAY, 하나라도 다르면 MISMATCH.
//      REPLAY는 세션에 적힌 max 칸(양의 10진 정수 16자리 이하가 아니면 PEAKET_CORRUPT_KEY)이 지났으면 TOKEN_EXPIRED(다시 받은 토큰의 exp가 남아 있어도 세션은 처음 최대 체류에 끝난다),
//      이 토큰의 최대 체류가 세션의 max보다 늦으면(같은 jti로 다시 받은 토큰) 표지 수명이 ARGV 11 + 여유보다 이르면 그 시각으로 늘린다(줄이지 않는다). 세션 상태는 바꾸지 않는다
//   3. 지금 > 첫 사용 기한 → FIRST_USE_EXPIRED (아무것도 쓰지 않아 jti는 쓰이지 않은 채다)
//   4. 세션 HSET(acct·login·event·jny·cpk·seq '0'·idle 지금 + 유휴·started 지금·max, 우선 구매면 prio) + PEXPIREAT 최대 체류 + 여유, 그다음 표지 SET(값 = 지금)
//      PXAT max(ARGV 11, 최대 체류) + 여유 → CREATED. 오류가 날 수 있는 세션 쓰기(키 형이 해시가 아니면 WRONGTYPE)를 먼저 해서, 오류가 나면 표지가 남지 않는다
//      (Lua는 오류가 나도 앞서 쓴 것을 되돌리지 않는다).
// 세션 키의 형이 해시가 아니면 WRONGTYPE 오류가 그대로 나간다(일시 장애로 숨기지 않는다).
//
// ── 일련번호 올리기 Lua(ADVANCE_SESSION_LUA) ────────────────────────────────────────────────────────────────────
// KEYS: 1 세션 상태 s:session:{jti}. ARGV: 1 새 일련번호(앞 0 없는 양의 10진 정수, 16자리 이하), 2 유휴 ms
// 돌려주는 값: 1(올렸다) 또는 0. 0은 세션 없음, 지금 ≥ 최대 체류, 새 번호가 마지막 번호 이하다(아무것도 쓰지 않는다).
// seq 칸이 앞 0 없는 10진 정수(16자리 이하)가 아니거나 max 칸이 양의 10진 정수(16자리 이하)가 아니면 오류 PEAKET_CORRUPT_KEY {키}를 돌려준다(아무것도 쓰지 않는다).
// 올릴 때: HSET seq 새 번호, idle 지금 + 유휴.
//
// ── 시작 사건 기록 표시 Lua(MARK_SESSION_STARTED_LUA) ───────────────────────────────────────────────────────────
// KEYS: 1 세션 상태 s:session:{jti}. 돌려주는 값: 1(세션이 있어 sev 칸을 '1'로 썼다) 또는 0(세션이 없다, 아무것도 만들지 않는다). 수명·다른 칸은 그대로다.
//
// ── 시작 사건 더하기 Lua(APPEND_SESSION_STARTED_LUA) ───────────────────────────────────────────────────────────
// KEYS: 1 회차 Stream s:{event:E}:stream. ARGV: 1 keepUntil ms(최대 체류 + 1일), 2부터 XADD의 이름·값 쌍(sessionStartedFields)
// XADD key * … (MAXLEN 없음) 한 번 뒤, 스트림 수명이 keepUntil보다 이르면(수명이 없으면 −1) PEXPIREAT keepUntil. 돌려주는 값 1.
// 홀드·만료 Lua와 같은 수명 규칙이다(더 늦은 수명은 둔다).

/** 열기 Lua 원문(위 계약). 첫 줄이 #!lua다 */
export const OPEN_SESSION_LUA = `#!lua
local function int(x)
  return string.format('%.0f', x)
end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local max = tonumber(ARGV[6])
if now >= max then return {'TOKEN_EXPIRED'} end
if redis.call('EXISTS', KEYS[1]) == 1 then
  local h = redis.call('HMGET', KEYS[2], 'acct', 'login', 'event', 'cpk', 'started', 'max', 'sev')
  if not h[1] or not h[2] or not h[3] or not h[4] then return {'ENDED'} end
  if h[1] == ARGV[1] and h[2] == ARGV[2] and h[3] == ARGV[3] and h[4] == ARGV[5] then
    local stored = h[6] and #h[6] <= 16 and string.match(h[6], '^[1-9][0-9]*$') and tonumber(h[6])
    if not stored then return redis.error_reply('ERR PEAKET_CORRUPT_KEY ' .. KEYS[2]) end
    if now >= stored then return {'TOKEN_EXPIRED'} end
    if max > stored then
      local want = tonumber(ARGV[11]) + tonumber(ARGV[9])
      if redis.call('PEXPIRETIME', KEYS[1]) < want then redis.call('PEXPIREAT', KEYS[1], int(want)) end
    end
    local needs = h[7] ~= '1' and now - tonumber(h[5] or '0') >= tonumber(ARGV[12])
    return {'REPLAY', h[5] or '0', h[6], needs and '1' or '0'}
  end
  return {'MISMATCH'}
end
if now > tonumber(ARGV[7]) then return {'FIRST_USE_EXPIRED'} end
local keep = int(max + tonumber(ARGV[9]))
local markerKeep = int(math.max(tonumber(ARGV[11]), max) + tonumber(ARGV[9]))
redis.call('HSET', KEYS[2], 'acct', ARGV[1], 'login', ARGV[2], 'event', ARGV[3], 'jny', ARGV[4], 'cpk', ARGV[5], 'seq', '0', 'idle', int(now + tonumber(ARGV[8])), 'started', int(now), 'max', ARGV[6])
if ARGV[10] ~= '' then redis.call('HSET', KEYS[2], 'prio', ARGV[10]) end
redis.call('PEXPIREAT', KEYS[2], keep)
redis.call('SET', KEYS[1], int(now), 'PXAT', markerKeep)
return {'CREATED', int(now)}
`;

/** 일련번호 올리기 Lua 원문(위 계약). 첫 줄이 #!lua다 */
export const ADVANCE_SESSION_LUA = `#!lua
local function int(x)
  return string.format('%.0f', x)
end
local h = redis.call('HMGET', KEYS[1], 'seq', 'max')
local cur = h[1]
if not cur then return 0 end
local max = h[2]
if #cur > 16 or not string.match(cur, '^[0-9]+$') or (#cur > 1 and string.sub(cur, 1, 1) == '0') then
  return redis.error_reply('ERR PEAKET_CORRUPT_KEY ' .. KEYS[1])
end
if not max or #max > 16 or not string.match(max, '^[1-9][0-9]*$') then
  return redis.error_reply('ERR PEAKET_CORRUPT_KEY ' .. KEYS[1])
end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if now >= tonumber(max) then return 0 end
if not (tonumber(ARGV[1]) > tonumber(cur)) then return 0 end
redis.call('HSET', KEYS[1], 'seq', ARGV[1], 'idle', int(now + tonumber(ARGV[2])))
return 1
`;

/** 시작 사건 더하기 Lua 원문(위 계약). 첫 줄이 #!lua다 */
export const APPEND_SESSION_STARTED_LUA = `#!lua
local fields = {}
for i = 2, #ARGV do fields[#fields + 1] = ARGV[i] end
redis.call('XADD', KEYS[1], '*', unpack(fields))
if redis.call('PEXPIRETIME', KEYS[1]) < tonumber(ARGV[1]) then
  redis.call('PEXPIREAT', KEYS[1], ARGV[1])
end
return 1
`;

/** 시작 사건 기록 표시 Lua 원문(위 계약). 첫 줄이 #!lua다 */
export const MARK_SESSION_STARTED_LUA = `#!lua
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'sev', '1')
return 1
`;
