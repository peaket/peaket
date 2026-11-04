-- PoC 스냅샷 읽기(S-T27, docs/features/seat-hold.md §2·§7): 세대·비트맵·구역 일련번호를 같은 샤드에서 한 번에 읽는다.
-- 운영 스냅샷 API는 아직 없다(BUILD_ORDER PRF-136). 세대 키는 운영 판매 열기 Lua가 만드는 Hash(epoch 칸)라 HGET으로 읽는다(2026-11-04 고침, 예전은 GET)
-- KEYS: 1 세대 epoch 2 비트맵 3 구역 일련번호 secver
local ep = redis.call('HGET', KEYS[1], 'epoch')
if not ep then return {'NOT_READY'} end
return {ep, redis.call('GET', KEYS[2]) or '', redis.call('HLEN', KEYS[3])}
