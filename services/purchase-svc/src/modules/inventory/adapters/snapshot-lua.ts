// 스냅샷 읽기 Lua 계약(BUILD_ORDER PRF-137, docs/features/seat-hold.md §2 '스냅샷 읽기 Lua', docs/data.md §3 s:{event:E}:bitmap·epoch·secver).
// 첫 줄이 `#!lua flags=no-writes`다: 쓰기가 없어 좌석 Redis가 메모리 부족이어도 거절되지 않는다.
// KEYS: 1 비트맵 s:{event:E}:bitmap, 2 세대 키 s:{event:E}:epoch, 3 구역 일련번호 s:{event:E}:secver (같은 슬롯)
// ARGV: 1 읽을 첫 바이트, 2 읽을 끝 바이트(포함), 3부터 읽을 구역 색인들(10진 글)
// 돌려주는 값(배열의 글): ['NOT_READY'] 또는 ['OK', 세대, 비트맵 바이트들(첫 바이트 ~ 끝 바이트, 모자란 곳은 0으로 채운 이진 글), 구역 일련번호 …(ARGV 3부터와 같은 차례, 칸이 없으면 '0')]
// 세대 키의 epoch 칸이 없으면 NOT_READY(아무것도 읽지 않는다). 세대·구역 일련번호가 0 ~ 2^32 − 1의 표준 10진 정수 글이 아니면 오류 PEAKET_CORRUPT_KEY {키}를 돌려준다.
// 키의 형이 틀리면 WRONGTYPE이 그대로 나간다.

/** 스냅샷 읽기 Lua 원문(위 계약). 첫 줄이 `#!lua flags=no-writes`다 */
export const SNAPSHOT_LUA = `#!lua flags=no-writes
local epoch = redis.call('HGET', KEYS[2], 'epoch')
if not epoch then return {'NOT_READY'} end
-- 0 ~ 2^32 - 1의 표준 10진 정수 글인가(앞 0 없음)
local function u32(v)
  if #v > 10 or not string.match(v, '^[0-9]+$') then return false end
  if #v > 1 and string.sub(v, 1, 1) == '0' then return false end
  return tonumber(v) <= 4294967295
end
if not u32(epoch) then return redis.error_reply('ERR PEAKET_CORRUPT_KEY ' .. KEYS[2]) end
local out = {'OK', epoch, redis.call('GETRANGE', KEYS[1], tonumber(ARGV[1]), tonumber(ARGV[2]))}
local i = 3
while i <= #ARGV do
  local j = math.min(i + 999, #ARGV)
  local vs = redis.call('HMGET', KEYS[3], unpack(ARGV, i, j))
  for k = 1, #vs do
    local v = vs[k]
    if not v then
      out[#out + 1] = '0'
    elseif u32(v) then
      out[#out + 1] = v
    else
      return redis.error_reply('ERR PEAKET_CORRUPT_KEY ' .. KEYS[3])
    end
  end
  i = j + 1
end
return out
`;
