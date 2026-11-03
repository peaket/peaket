-- PoC 스냅샷 읽기(S-T27, docs/features/seat-hold.md §2·§7): 세대·비트맵·구역 일련번호를 같은 샤드에서 한 번에 읽는다
-- KEYS: 1 세대 epoch 2 비트맵 3 구역 일련번호 secver
local ep = redis.call('GET', KEYS[1])
if not ep then return {'NOT_READY'} end
return {ep, redis.call('GET', KEYS[2]) or '', redis.call('HLEN', KEYS[3])}
