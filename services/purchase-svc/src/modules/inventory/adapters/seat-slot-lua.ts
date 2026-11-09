// 결제 접수의 회차 슬롯 읽기 Lua 계약(docs/features/payment.md §2 '결제 접수의 첫 구현' 검사 차례, docs/data.md §3 좌석 키 표, BUILD_ORDER PRF-162).
// 키·칸 이름의 정본은 docs/data.md §3이다(s:{event:E}:epoch의 epoch·gen, s:{event:E}:ctl의 paused·allPaused·suspended).
// 문자열만 두고 아무것도 가져오지 않는다(운영 RedisSeatSlots가 부르고, MemorySeatSlots가 같은 계약을 따른다).
//
// 규칙
// - 첫 줄은 `#!lua flags=no-writes`다(읽기만 한다. 좌석 Redis가 메모리 부족이어도 거절되지 않는다, order-hold-lua.ts와 같다).
// - 키는 모두 회차 해시 태그 {event:E} 하나의 슬롯이다. ARGV는 없다.
//
// KEYS(차례 고정)
//   1 epoch   세대 키 Hash(epoch 칸이 없으면 준비되지 않음, gen 칸 = 다시 만들기 판 번호)
//   2 ctl     판매 정지 사본 Hash(키·칸이 없으면 정지 아님)
//
// 검사 차례(앞이 걸리면 뒤는 보지 않는다)
//   1 HMGET epoch 'epoch' 'gen': epoch 칸이 없음                                 → {'NOT_READY'}
//   2 gen 칸이 있는데 앞 0 없는 양의 10진 정수가 아니거나 2147483647(int4 위 끝)을 넘음 → 'ERR PEAKET_CORRUPT_KEY {epoch 키}'
//     (오류. 판 번호는 purchase_order.seat_gen int4에 들어가야 한다, 리뷰 고침 L5 2026-11-05. pin-lua.ts의 15자리 규칙보다 좁다)
//   3 HMGET ctl 'paused' 'allPaused' 'suspended' 가운데 하나라도 '1'              → {'PAUSED'}
//   4                                                                            → {'OK', gen 글(칸이 없으면 '1')}
// 아무것도 쓰지 않는다. 키의 형이 틀리면 WRONGTYPE이 그대로 나간다(앱은 일시 장애가 아닌 Error로 던진다).
// 키가 둘이 아니면 'ERR PEAKET_BAD_INPUT seat-slot keys'다(앱이 막아 오지 않는다).
//
// 정한 것(정본에 없음): 판 번호 검사(2)를 정지 검사(3)보다 먼저 둔다(망가진 세대 키를 정지 답으로 숨기지 않는다).
// epoch 칸 값 자체의 형식은 보지 않는다(이 읽기는 세대를 쓰지 않는다).

/** 회차 슬롯 읽기 Lua 원문(위 계약). 첫 줄이 `#!lua flags=no-writes`다 */
export const SEAT_SLOT_READ_LUA = `#!lua flags=no-writes
if #KEYS ~= 2 then return redis.error_reply('ERR PEAKET_BAD_INPUT seat-slot keys') end
-- 1 세대 키(epoch 칸이 없으면 준비되지 않음)
local ep = redis.call('HMGET', KEYS[1], 'epoch', 'gen')
if not ep[1] then return {'NOT_READY'} end
-- 2 판 번호(gen 칸이 없으면 1). 앞 0 없는 양의 10진 정수이고 int4 위 끝(2147483647) 이하가 아니면 망가진 키
local gen = ep[2] or '1'
if #gen > 10 or not string.match(gen, '^[1-9][0-9]*$') or tonumber(gen) > 2147483647 then return redis.error_reply('ERR PEAKET_CORRUPT_KEY ' .. KEYS[1]) end
-- 3 판매 정지 사본(칸이 정확히 '1'일 때만 정지)
local c = redis.call('HMGET', KEYS[2], 'paused', 'allPaused', 'suspended')
if c[1] == '1' or c[2] == '1' or c[3] == '1' then return {'PAUSED'} end
return {'OK', gen}
`;
