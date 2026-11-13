// 주문 생성의 홀드 확인 Lua 계약(docs/features/payment.md §2 '주문 생성의 첫 구현' 홀드 확인, docs/data.md §3 좌석 키 표, BUILD_ORDER PRF-161).
// 키·칸 이름의 정본은 docs/data.md §3이다. 문자열만 두고 아무것도 가져오지 않는다(운영 RedisOrderHolds가 부르고, MemoryOrderHolds가 같은 계약을 따른다).
//
// 규칙
// - 첫 줄은 `#!lua flags=no-writes`다(읽기만 한다. 쓰기가 없어 좌석 Redis가 메모리 부족이어도 거절되지 않는다, snapshot-lua.ts와 같다).
// - 키는 모두 회차 해시 태그 {event:E} 하나의 슬롯이다. 구매 세션의 홀드 목록(s:session:{jti}의 h:{holdId})은 jti 슬롯이라 이 Lua 앞에서 앱이 따로 읽는다.
// - 서버 시각은 Redis TIME을 한 번만 읽는다: now = floor((초 × 1,000,000 + 마이크로초) / 1000)(ms).
//
// KEYS(차례 고정, 모두 s:{event:E}: 아래). 좌석 수 n = #KEYS − 1(1 ~ 10)
//   1 epoch              세대 키 Hash(epoch 칸이 없으면 NOT_READY)
//   2.. hold:{좌석 색인}  좌석마다 하나, 구매 세션의 h:{holdId}에 적힌 좌석 차례
//
// ARGV
//   1 holdId  2 소유 계정 ID(owner)  3 구매 세션 ID(psid)
//
// 검사 차례(앞이 걸리면 뒤는 보지 않는다)
//   1 HGET epoch 'epoch'이 없음                                   → {'NOT_READY'}
//   2 좌석 차례로 HMGET hold holdId owner psid heldAt exp kind:
//     칸이 하나라도 없음(Hash 없음 포함), holdId·owner·psid가 ARGV와 다름, kind가 FAN이 아님(우선 구매 PRIORITY 홀드의 주문은 GAT-135, 리뷰 고침 L4), exp ≤ now → {'NOT_FOUND'}
//     heldAt·exp가 앞 0 없는 0 이상 10진 정수 글이 아님                 → 'ERR PEAKET_CORRUPT_KEY {그 hold 키}'(오류, 망가진 키)
//     좌석마다 heldAt이 같지 않음(한 홀드는 한 번에 잡혀 같아야 한다)        → {'NOT_FOUND'}
//   3                                                              → {'OK', heldAt 글} 또는 {'OK', heldAt 글, lim 글}
// lim은 홀드 때 쓴 1인 한도(BAT-051, 판매 정책 규칙 결과)다. 칸이 없으면 두 칸으로 답한다(옛 홀드·다시 만든 홀드).
// 아무것도 쓰지 않는다. 키의 형이 틀리면 WRONGTYPE이 그대로 나간다(앱은 일시 장애가 아닌 Error로 던진다).

// 정한 것(정본에 없음): 검사 2의 좌석 하나 안의 차례는 칸 없음 → holdId·owner·psid·kind 다름 → heldAt·exp 형식 → exp ≤ now → heldAt 다름이다.
// 형식이 틀린 값은 견주지 않는다('-5'도 지난 시각이 아니라 망가진 값). 좌석 키가 하나도 없으면(#KEYS < 2) 'ERR PEAKET_BAD_INPUT'이다(앱이 막아 오지 않는다).

// 주문 만료의 '홀드 남음' Lua 계약(docs/features/payment.md §2 '결제하지 않은 주문 만료의 첫 구현' 조건 ②, BUILD_ORDER PRF-172).
// 첫 줄은 `#!lua flags=no-writes`다. KEYS는 모두 회차 해시 태그 {event:E} 하나의 슬롯이다.
//   KEYS 1.. hold:{좌석 색인}(주문 항목의 좌석마다, 하나 이상)   ARGV 1 주문의 holdId
// 좌석마다 홀드 Hash의 holdId 칸을 읽어 ARGV[1]과 같은 좌석 수(0 이상 정수)를 돌려준다. 구매 세션의 홀드 목록(jti 슬롯)은 보지 않는다(세션을 끝내면 목록이 지워져도 홀드는 살아 있다).
// 구현에서 정한 것(정본에 없다): 시각은 보지 않는다(exp가 지났어도 만료 Lua가 풀기 전이면 남은 것이다. 풀 때 고리가 다시 부른다). 세대 키도 보지 않는다(홀드 Hash만이 근거다. 회차 키의 수명이 끝난 뒤 주문이 영영 '아직'으로 남지 않게).
// 홀드 키가 hash가 아니면(키가 없으면 통과) 쓰는 Lua와 같은 'ERR PEAKET_CORRUPT_KEY {키}' 오류다. 좌석 키가 하나도 없으면 'ERR PEAKET_BAD_INPUT'이다(앱이 막아 오지 않는다).

/** 주문 좌석의 홀드 남음 Lua 원문(위 계약). 첫 줄이 `#!lua flags=no-writes`다 */
export const ORDER_HOLD_LEFT_LUA = `#!lua flags=no-writes
if #KEYS < 1 then return redis.error_reply('ERR PEAKET_BAD_INPUT hold-left seats') end
local left = 0
for i = 1, #KEYS do
  local ty = redis.call('TYPE', KEYS[i]).ok
  if ty ~= 'none' and ty ~= 'hash' then return redis.error_reply('ERR PEAKET_CORRUPT_KEY ' .. KEYS[i]) end
  if redis.call('HGET', KEYS[i], 'holdId') == ARGV[1] then left = left + 1 end
end
return left
`;

// 결제 시도의 홀드 만료 시각 Lua 계약(docs/features/payment.md §2 '결제 시도 시작의 첫 구현' 응답, BUILD_ORDER PRF-191).
// 첫 줄은 `#!lua flags=no-writes`다. KEYS는 모두 회차 해시 태그 {event:E} 하나의 슬롯이다.
//   KEYS 1.. hold:{좌석 색인}(주문 항목의 좌석마다, 하나 이상)   ARGV 1 주문의 holdId
// holdId가 같은 좌석의 exp 가운데 가장 이른 값을 글로 돌려주고, 그런 좌석이 없으면 nil이다. 시각은 보지 않는다(풀리기 전이면 남은 것이다).
// 홀드 키가 hash가 아니거나 exp가 앞 0 없는 0 이상 10진 정수 글(16자리까지)이 아니면 'ERR PEAKET_CORRUPT_KEY {키}'다. 좌석 키가 하나도 없으면 'ERR PEAKET_BAD_INPUT'이다.

/** 주문 좌석의 홀드 만료 Lua 원문(위 계약). 첫 줄이 `#!lua flags=no-writes`다 */
export const ORDER_HOLD_EXPIRY_LUA = `#!lua flags=no-writes
if #KEYS < 1 then return redis.error_reply('ERR PEAKET_BAD_INPUT hold-expiry seats') end
local earliest = nil
for i = 1, #KEYS do
  local ty = redis.call('TYPE', KEYS[i]).ok
  if ty ~= 'none' and ty ~= 'hash' then return redis.error_reply('ERR PEAKET_CORRUPT_KEY ' .. KEYS[i]) end
  local h = redis.call('HMGET', KEYS[i], 'holdId', 'exp', 'rem')
  if h[1] == ARGV[1] then
    local v = h[2]
    if not v or #v > 16 or not string.match(v, '^[0-9]+$') or (#v > 1 and string.sub(v, 1, 1) == '0') then
      return redis.error_reply('ERR PEAKET_CORRUPT_KEY ' .. KEYS[i])
    end
    local n = tonumber(v)
    -- 멈춘 좌석은 지금 + 남은 시간이다(HOT-070, 시간이 흐르지 않아 0까지 줄면 안 된다)
    if h[3] then
      if #h[3] > 16 or not string.match(h[3], '^[0-9]+$') then return redis.error_reply('ERR PEAKET_CORRUPT_KEY ' .. KEYS[i]) end
      local t = redis.call('TIME')
      n = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000) + tonumber(h[3])
    end
    if earliest == nil or n < earliest then earliest = n end
  end
end
if earliest == nil then return false end
return string.format('%.0f', earliest)
`;

/** 홀드 확인 Lua 원문(위 계약). 첫 줄이 `#!lua flags=no-writes`다 */
export const ORDER_HOLD_LUA = `#!lua flags=no-writes
if #KEYS < 2 then return redis.error_reply('ERR PEAKET_BAD_INPUT order-hold seats') end
if not redis.call('HGET', KEYS[1], 'epoch') then return {'NOT_READY'} end
local t = redis.call('TIME')
local now = math.floor((tonumber(t[1]) * 1000000 + tonumber(t[2])) / 1000)
-- 앞 0 없는 0 이상 10진 정수 글(16자리까지: 밀리초 시각이 Lua 수로 정확히 견줘지는 범위)
local function ms(v)
  if #v > 16 or not string.match(v, '^[0-9]+$') then return false end
  return #v == 1 or string.sub(v, 1, 1) ~= '0'
end
local heldAt = nil
local limit = nil
for i = 2, #KEYS do
  local h = redis.call('HMGET', KEYS[i], 'holdId', 'owner', 'psid', 'heldAt', 'exp', 'kind', 'rem', 'lim')
  if not h[1] or not h[2] or not h[3] or not h[4] or not h[5] or not h[6] then return {'NOT_FOUND'} end
  if h[1] ~= ARGV[1] or h[2] ~= ARGV[2] or h[3] ~= ARGV[3] or h[6] ~= 'FAN' then return {'NOT_FOUND'} end
  if not ms(h[4]) or not ms(h[5]) then return redis.error_reply('ERR PEAKET_CORRUPT_KEY ' .. KEYS[i]) end
  -- 멈춘 좌석(rem)은 시간이 흐르지 않으니 살아 있다(HOT-070)
  if not h[7] and tonumber(h[5]) <= now then return {'NOT_FOUND'} end
  if heldAt == nil then
    heldAt = h[4]
  elseif heldAt ~= h[4] then
    return {'NOT_FOUND'}
  end
  -- 홀드 때 쓴 1인 한도(판매 정책 규칙 결과, BAT-051). 없으면 회차 설정 한도로 본다
  if h[8] ~= nil then
    if not ms(h[8]) or tonumber(h[8]) < 1 then return redis.error_reply('ERR PEAKET_CORRUPT_KEY ' .. KEYS[i]) end
    if limit == nil then limit = h[8] elseif limit ~= h[8] then return {'NOT_FOUND'} end
  end
end
if limit then return {'OK', heldAt, limit} end
return {'OK', heldAt}
`;
