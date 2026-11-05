// 다시 만들기·세대 올리기 Lua 계약(adapters/rebuild-lua.ts REBUILD_SEATS_LUA·FINISH_REBUILD_LUA·BUMP_EPOCH_LUA)의 메모리 쌍둥이(MemorySeatStore, BUILD_ORDER PRF-143,
// docs/features/seat-hold.md §6 '다시 만들기(RB-06)의 첫 구현', docs/data.md §3 좌석 키 표, ADR-0121 결정 5·6, 명세 specs/seat.qnt rebuild).
// 다시 만든 뒤의 홀드·묶기·만료가 되살린 키를 바르게 읽는지도 본다. 시각은 주입한 가짜 시계다(Lua는 Redis TIME).
// 세대 키 node(BUILD_ORDER PRF-168, docs/features/seat-hold.md §6 '세대 올리기 감시의 첫 구현'): 판매 열기·끝내기·세대 올리기가 모두 저장소의 주 노드 표지
// (생성자 nodeId, 기본 'standalone', Lua의 nodeId() 대신)를 쓴다. 장애 조치(복제본 승격)는 setNodeId로 표지를 바꿔 흉내 낸다(클러스터 승격은 S-T26 측정의 몫).
import { type FakeClock, fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { type MemoryHoldHash, MemorySeatStore, type PinInput, type RebuildSeat, type SeatRef, seatKeys } from '../src/modules/inventory/index.js';
import { ACCOUNT_A, ACCOUNT_B, DAY, holdInput, newEvent, ref, SEAT_COUNT } from './hold-cases.js';

const NOW = Date.parse('2026-11-04T03:00:00.000Z');
const NOW_SEC = Math.floor(NOW / 1000);
const KEEP = NOW + 2 * DAY;
const TTL = 420_000;
/** 기본 주 노드 표지(단일 노드) */
const STANDALONE = 'standalone';
/** 승격된 복제본의 표지(클러스터 모양 '{CLUSTER MYID}:{cluster_my_epoch}' 흉내) */
const PROMOTED = '9f3c0e7a1b2d4c5e6f708192a3b4c5d6e7f80912:7';
const HELD_AT = NOW - 60_000;
const EXP = HELD_AT + TTL;
const T_A3 = HELD_AT * 1000 + 3;
const T_B5 = HELD_AT * 1000 + 5;

const sold = (seatId: string, accountId: string, holdId: string, purchaseSessionId: string): RebuildSeat => ({ mode: 'SOLD', seat: ref(seatId), accountId, holdId, purchaseSessionId });
const held = (seatId: string, accountId: string, holdId: string, purchaseSessionId: string, fencingToken: number, kind: 'FAN' | 'PRIORITY' = 'FAN'): RebuildSeat => ({
  mode: 'HELD',
  seat: ref(seatId),
  accountId,
  holdId,
  purchaseSessionId,
  fencingToken,
  heldAtMs: HELD_AT,
  expiresAtMs: EXP,
  kind,
});
/** 원장 행이 없는 판매 좌석의 홀드 Hash(묶음, 토큰 = 저장소 시각 µs, 잡은 시각 = 만료 시각 = 지금, 코드 리뷰로 고침) */
const soldHash = (owner: string, holdId: string, psid: string): MemoryHoldHash => ({ holdId, owner, psid, fence: String(NOW * 1000), heldAt: NOW, exp: NOW, kind: 'FAN', ext: '0', pin: '1' });
const OK = { result: 'OK' };

/** 다시 만들기 시험 회차: A01·A02 = A의 판매(h-a1), A03 = A의 되살린 홀드(h-a3), A05 = B의 되살린 홀드(h-b5) */
const SEATS: RebuildSeat[] = [sold('A01', ACCOUNT_A, '0190f3a1-7c2e-7a00-8000-0000000000a1', '0190f3a1-7c2e-7a00-8000-0000000001a1'), sold('A02', ACCOUNT_A, '0190f3a1-7c2e-7a00-8000-0000000000a1', '0190f3a1-7c2e-7a00-8000-0000000001a1'), held('A03', ACCOUNT_A, '0190f3a1-7c2e-7a00-8000-0000000000a3', '0190f3a1-7c2e-7a00-8000-0000000001a3', T_A3), held('A05', ACCOUNT_B, '0190f3a1-7c2e-7a00-8000-0000000000b5', '0190f3a1-7c2e-7a00-8000-0000000001b5', T_B5)];
const QUOTAS = new Map([
  [ACCOUNT_A, 3],
  [ACCOUNT_B, 1],
]);

function setup(clock: FakeClock = fakeClock({ now: NOW }), nodeId?: string) {
  const store = new MemorySeatStore(clock, undefined, nodeId === undefined ? {} : { nodeId });
  const eventId = newEvent();
  // 시작(begin, gen 2)을 마친 것과 같다(빈 회차라 지울 것이 없다). 시작 Lua 자체는 아래 begin 시험이 본다
  store.db.event(eventId).rebuildGen = 2;
  return { clock, store, eventId, ev: () => store.db.event(eventId) };
}

/** SEATS를 쓰고 끝낸(gen 2) 회차 */
async function rebuilt() {
  const s = setup();
  expect(await s.store.writeSeats(s.eventId, SEATS, KEEP, 2)).toEqual(OK);
  expect(await s.store.finish(s.eventId, { quotas: QUOTAS, gen: 2, keepUntilMs: KEEP })).toEqual(OK);
  return s;
}

/** 회차 키의 모양 전부(아무것도 쓰지 않았는지 견준다) */
function stateOf(store: MemorySeatStore, eventId: string) {
  const ev = store.db.event(eventId);
  return JSON.stringify({
    epoch: ev.epoch,
    bits: [...ev.bits].sort(),
    holds: [...ev.holds],
    expiry: [...ev.expiry],
    quota: [...ev.quota],
    fence: ev.fence,
    stream: ev.stream,
    secver: [...ev.secver],
    published: ev.published,
    expireAt: [...ev.expireAt].sort(),
    listed: store.db.ctlEvents.has(eventId),
  });
}

describe('isReady·writeSeats(REBUILD_SEATS_LUA의 쌍둥이)', () => {
  test('ST26_ isReady는 세대 키가 있을 때만 참이다: 처음 보는 회차·좌석만 쓴 회차는 거짓, finish·판매 열기 뒤는 참 [S-T26]', async () => {
    const s = setup();
    expect(await s.store.isReady(s.eventId)).toBe(false);
    await s.store.writeSeats(s.eventId, SEATS, KEEP, 2);
    expect(await s.store.isReady(s.eventId)).toBe(false);
    await s.store.finish(s.eventId, { quotas: QUOTAS, gen: 2, keepUntilMs: KEEP });
    expect(await s.store.isReady(s.eventId)).toBe(true);
    const o = setup();
    await o.store.openSale({ eventId: o.eventId, seatCount: SEAT_COUNT, keepUntilMs: KEEP });
    expect(await o.store.isReady(o.eventId)).toBe(true);
  });

  test('ST26_ writeSeats: 판매 좌석은 비트 1·홀드 Hash 묶음(holdId·owner·psid, 원장 행이 없으면 fence = 저장소 시각 µs·heldAt = exp = 지금·kind FAN·ext 0·pin 1), 되살린 홀드는 비트 1·원장 값 그대로(ext 0, pin 없음)·만료 인덱스(점수 exp)다. 결과 OK [S-T26]', async () => {
    const s = setup();
    expect(await s.store.writeSeats(s.eventId, SEATS, KEEP, 2)).toEqual(OK);
    const ev = s.ev();
    expect(ev.bits).toEqual(new Set([0, 1, 2, 4]));
    expect(Object.fromEntries(ev.holds)).toEqual({
      0: soldHash(ACCOUNT_A, '0190f3a1-7c2e-7a00-8000-0000000000a1', '0190f3a1-7c2e-7a00-8000-0000000001a1'),
      1: soldHash(ACCOUNT_A, '0190f3a1-7c2e-7a00-8000-0000000000a1', '0190f3a1-7c2e-7a00-8000-0000000001a1'),
      2: { holdId: '0190f3a1-7c2e-7a00-8000-0000000000a3', owner: ACCOUNT_A, psid: '0190f3a1-7c2e-7a00-8000-0000000001a3', fence: String(T_A3), heldAt: HELD_AT, exp: EXP, kind: 'FAN', ext: '0' },
      4: { holdId: '0190f3a1-7c2e-7a00-8000-0000000000b5', owner: ACCOUNT_B, psid: '0190f3a1-7c2e-7a00-8000-0000000001b5', fence: String(T_B5), heldAt: HELD_AT, exp: EXP, kind: 'FAN', ext: '0' },
    });
    expect('pin' in ev.holds.get(2)!).toBe(false);
    // 만료 인덱스에는 되살린 홀드만(판매 좌석은 만료되지 않는다)
    expect(Object.fromEntries(ev.expiry)).toEqual({ 2: EXP, 4: EXP });
  });

  test('ST26_ writeSeats는 보유 수·세대 키·펜싱 카운터·Stream·구역 일련번호·샤드 Pub/Sub을 쓰지 않는다(보유 수와 세대 키는 finish, 토큰은 TIME µs로도 커진다) [S-T26] [S-T5]', async () => {
    const s = setup();
    await s.store.writeSeats(s.eventId, SEATS, KEEP, 2);
    const ev = s.ev();
    expect(ev.quota.size).toBe(0);
    expect(ev.epoch).toBeUndefined();
    expect(ev.fence).toBeUndefined();
    expect(ev.stream).toEqual([]);
    expect(ev.secver.size).toBe(0);
    expect(ev.published).toEqual([]);
  });

  test('ST26_ PRIORITY 홀드는 kind PRIORITY로 되살린다 [S-T26]', async () => {
    const s = setup();
    await s.store.writeSeats(s.eventId, [held('A09', ACCOUNT_B, 'h-p', '', T_B5, 'PRIORITY')], KEEP, 2);
    expect(s.ev().holds.get(8)).toEqual({ holdId: 'h-p', owner: ACCOUNT_B, psid: '', fence: String(T_B5), heldAt: HELD_AT, exp: EXP, kind: 'PRIORITY', ext: '0' });
  });

  test('ST26_ writeSeats 키 수명: 홀드 Hash는 DEL 뒤 PEXPIREAT keepUntil(전에 더 늦었어도 keepUntil), 비트맵·만료 인덱스는 더 늦은 쪽(이르면 keepUntil로 늘리고 더 늦으면 둔다) [S-T26]', async () => {
    const s = setup();
    const e = s.eventId;
    const ev = s.ev();
    ev.expireAt.set(seatKeys.hold(e, 2), KEEP + 5_000);
    ev.expireAt.set(seatKeys.bitmap(e), KEEP + 9_000);
    ev.expireAt.set(seatKeys.expiry(e), KEEP - 9_000);
    await s.store.writeSeats(e, SEATS, KEEP, 2);
    for (const i of [0, 1, 2, 4]) expect(ev.expireAt.get(seatKeys.hold(e, i)), `hold:${i}`).toBe(KEEP);
    expect(ev.expireAt.get(seatKeys.bitmap(e))).toBe(KEEP + 9_000);
    expect(ev.expireAt.get(seatKeys.expiry(e))).toBe(KEEP);
  });

  test('ST26_ writeSeats는 그 색인의 옛 Hash 칸을 지우고 새로 쓴다(DEL 뒤 HSET): 옛 pin·ext·psid가 남지 않는다. 같은 좌석을 두 번 써도 결과가 같다(도중 실패 뒤 처음부터 다시) [S-T26]', async () => {
    const s = setup();
    const ev = s.ev();
    ev.holds.set(2, { holdId: 'old', owner: ACCOUNT_B, psid: 'old-ps', fence: '1', heldAt: 1, exp: 2, kind: 'PRIORITY', ext: '1', pin: '1' });
    await s.store.writeSeats(s.eventId, SEATS, KEEP, 2);
    expect(ev.holds.get(2)).toEqual({ holdId: '0190f3a1-7c2e-7a00-8000-0000000000a3', owner: ACCOUNT_A, psid: '0190f3a1-7c2e-7a00-8000-0000000001a3', fence: String(T_A3), heldAt: HELD_AT, exp: EXP, kind: 'FAN', ext: '0' });
    const once = stateOf(s.store, s.eventId);
    expect(await s.store.writeSeats(s.eventId, SEATS, KEEP, 2)).toEqual(OK);
    expect(stateOf(s.store, s.eventId)).toBe(once);
  });

  test('ST26_ writeSeats: 세대 키가 이미 있으면 READY이고 아무것도 쓰지 않는다(비트·Hash·만료 인덱스·키 수명 그대로) [S-T26]', async () => {
    const s = setup();
    await s.store.openSale({ eventId: s.eventId, seatCount: SEAT_COUNT, keepUntilMs: KEEP });
    const before = stateOf(s.store, s.eventId);
    expect(await s.store.writeSeats(s.eventId, SEATS, KEEP + DAY, 2)).toEqual({ result: 'READY', gen: 1 });
    expect(stateOf(s.store, s.eventId)).toBe(before);
    // 좌석만 쓰다 만 회차에 다른 곳이 세대 키를 쓴 뒤도 같다
    const r = await rebuilt();
    const after = stateOf(r.store, r.eventId);
    expect(await r.store.writeSeats(r.eventId, [sold('A10', ACCOUNT_B, 'o-x', '')], KEEP, 2)).toEqual({ result: 'READY', gen: 2 });
    expect(stateOf(r.store, r.eventId)).toBe(after);
  });
});

describe('finish(FINISH_REBUILD_LUA의 쌍둥이)', () => {
  test('ST26_ finish: 계정마다 보유 수를 그 값으로 쓰고(옛 값에 더하지 않는다) 수명 keepUntil, 세대 키(epoch = 저장소 시각의 초, node = 저장소 표지 standalone, gen)를 쓰고 수명 keepUntil, 회차 목록에 넣는다 → OK [S-T26]', async () => {
    const s = setup();
    const e = s.eventId;
    s.ev().quota.set(ACCOUNT_A, 9);
    s.ev().rebuildGen = 5;
    s.clock.advance(2_500);
    expect(await s.store.finish(e, { quotas: QUOTAS, gen: 5, keepUntilMs: KEEP })).toEqual(OK);
    const ev = s.ev();
    expect(Object.fromEntries(ev.quota)).toEqual({ [ACCOUNT_A]: 3, [ACCOUNT_B]: 1 });
    expect(ev.expireAt.get(seatKeys.quota(e, ACCOUNT_A))).toBe(KEEP);
    expect(ev.expireAt.get(seatKeys.quota(e, ACCOUNT_B))).toBe(KEEP);
    // chk = 표지를 견준 초(끝내기가 세대와 같은 초로 둔다, ADR-0210)
    expect(ev.epoch).toEqual({ epoch: Math.floor((NOW + 2_500) / 1000), node: STANDALONE, gen: 5, chk: Math.floor((NOW + 2_500) / 1000) });
    expect(ev.expireAt.get(seatKeys.epoch(e))).toBe(KEEP);
    expect(s.store.db.ctlEvents.has(e)).toBe(true);
    expect(await s.store.saleEvents()).toContain(e);
  });

  test('ST26_ finish: 세대 키가 이미 있으면 READY(세대 키의 gen)이고 보유 수·세대 키(node·gen)를 바꾸지 않는다. 회차 목록에는 넣는다(코드 리뷰로 고침) [S-T26]', async () => {
    const s = setup();
    const ev = s.ev();
    // 회차 목록에 없는 채로 세대 키만 있는 회차(다른 곳이 먼저 끝냄)
    ev.epoch = { epoch: NOW_SEC - 50, node: 'pod-other', gen: 3 };
    ev.quota.set(ACCOUNT_A, 1);
    const before = stateOf(s.store, s.eventId).replace('"listed":false', '"listed":true');
    expect(await s.store.finish(s.eventId, { quotas: QUOTAS, gen: 4, keepUntilMs: KEEP })).toEqual({ result: 'READY', gen: 3 });
    expect(stateOf(s.store, s.eventId)).toBe(before);
    expect(s.store.db.ctlEvents.has(s.eventId)).toBe(true);
  });
});

describe('주 노드 표지(MemorySeatStore nodeId, BUILD_ORDER PRF-168)', () => {
  test('ST26_ 표지를 주지 않으면 standalone이다: 판매 열기와 끝내기가 세대 키 node에 같은 표지를 적는다(다시 만들기가 파드 이름을 적던 뜻 차이를 없앤다) [S-T26]', async () => {
    const o = setup();
    await o.store.openSale({ eventId: o.eventId, seatCount: SEAT_COUNT, keepUntilMs: KEEP });
    const r = await rebuilt();
    expect(o.ev().epoch?.node).toBe(STANDALONE);
    expect(r.ev().epoch?.node).toBe(STANDALONE);
  });

  test('ST26_ 생성자 nodeId를 주면 판매 열기·끝내기·세대 올리기가 모두 그 표지를 쓴다: 그 표지로 연 회차에 세대 올리기는 SAME이다 [S-T26]', async () => {
    const s = setup(fakeClock({ now: NOW }), PROMOTED);
    const opened = newEvent();
    await s.store.openSale({ eventId: opened, seatCount: SEAT_COUNT, keepUntilMs: KEEP });
    expect(s.store.db.event(opened).epoch).toEqual({ epoch: NOW_SEC, node: PROMOTED, gen: 1, chk: NOW_SEC });
    await expect(s.store.bumpEpoch(opened)).resolves.toEqual({ result: 'SAME', epoch: NOW_SEC, bumps: 0 });
    expect(await s.store.finish(s.eventId, { quotas: QUOTAS, gen: 2, keepUntilMs: KEEP })).toEqual(OK);
    expect(s.ev().epoch).toEqual({ epoch: NOW_SEC, node: PROMOTED, gen: 2, chk: NOW_SEC });
    await expect(s.store.bumpEpoch(s.eventId)).resolves.toEqual({ result: 'SAME', epoch: NOW_SEC, bumps: 0 });
  });

  test('ST26_ 표지가 빈 글이면 RangeError다(생성자 nodeId·setNodeId) [S-T26]', () => {
    expect(() => new MemorySeatStore(fakeClock({ now: NOW }), undefined, { nodeId: '' })).toThrow(RangeError);
    expect(() => setup().store.setNodeId('')).toThrow(RangeError);
  });
});

describe('bumpEpoch(BUMP_EPOCH_LUA의 쌍둥이, ADR-0121 결정 5, BUILD_ORDER PRF-168)', () => {
  test('ST26_ 세대 키가 없으면 NOT_READY이고 세대 키를 만들지 않는다 [S-T26]', async () => {
    const s = setup();
    await expect(s.store.bumpEpoch(s.eventId)).resolves.toEqual({ result: 'NOT_READY' });
    expect(s.ev().epoch).toBeUndefined();
  });

  test('ST26_ 세대 키 node가 저장소 표지와 같으면 SAME과 그 epoch이고 견준 초 chk 말고는 아무것도 바꾸지 않는다(장애 조치가 없으면 오르지 않는다, ADR-0210) [S-T26]', async () => {
    const s = await rebuilt();
    expect(s.ev().epoch?.node).toBe(STANDALONE);
    s.clock.advance(30_000);
    const before = JSON.parse(stateOf(s.store, s.eventId)) as { epoch: Record<string, unknown> };
    await expect(s.store.bumpEpoch(s.eventId)).resolves.toEqual({ result: 'SAME', epoch: NOW_SEC, bumps: 0 });
    await expect(s.store.bumpEpoch(s.eventId)).resolves.toEqual({ result: 'SAME', epoch: NOW_SEC, bumps: 0 });
    expect(JSON.parse(stateOf(s.store, s.eventId))).toEqual({ ...before, epoch: { ...before.epoch, chk: NOW_SEC + 30 } });
  });

  test('ST26_ 승격 흉내(setNodeId) 뒤 BUMPED 한 번: epoch = max(epoch + 1, 지금 초), node = 새 표지, gen·수명 그대로. 다시 부르면 SAME이다 [S-T26]', async () => {
    const s = await rebuilt();
    const ev = s.ev();
    const keepBefore = ev.expireAt.get(seatKeys.epoch(s.eventId));
    // 같은 초 안의 장애 조치: epoch + 1
    s.store.setNodeId(PROMOTED);
    // 표지만 바꾸고 세대 키는 바꾸지 않는다(세대 올리기 전)
    expect(ev.epoch).toEqual({ epoch: NOW_SEC, node: STANDALONE, gen: 2, chk: NOW_SEC });
    await expect(s.store.bumpEpoch(s.eventId)).resolves.toEqual({ result: 'BUMPED', epoch: NOW_SEC + 1, bumps: 1 });
    expect(ev.epoch).toEqual({ epoch: NOW_SEC + 1, node: PROMOTED, gen: 2, chk: NOW_SEC, bumps: 1 });
    expect(ev.expireAt.get(seatKeys.epoch(s.eventId))).toBe(keepBefore);
    await expect(s.store.bumpEpoch(s.eventId)).resolves.toEqual({ result: 'SAME', epoch: NOW_SEC + 1, bumps: 1 });
    // 10초 뒤의 두 번째 장애 조치: 지금 초가 더 크다
    s.clock.advance(10_000);
    s.store.setNodeId('0a1b2c3d4e5f60718293a4b5c6d7e8f901234567:8');
    await expect(s.store.bumpEpoch(s.eventId)).resolves.toEqual({ result: 'BUMPED', epoch: NOW_SEC + 10, bumps: 2 });
    expect(ev.epoch).toEqual({ epoch: NOW_SEC + 10, node: '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567:8', gen: 2, chk: NOW_SEC + 10, bumps: 2 });
    // 세대가 지금보다 앞서 있으면(시계가 뒤로 감) epoch + 1(되돌아가지 않는다)
    ev.epoch = { epoch: NOW_SEC + 500, node: 'old-primary:6', gen: 2 };
    await expect(s.store.bumpEpoch(s.eventId)).resolves.toEqual({ result: 'BUMPED', epoch: NOW_SEC + 501, bumps: 1 });
  });

  test('ST26_ 승격 뒤 여러 곳이 함께 불러도 세대는 한 번만 오른다(BUMPED 하나, 나머지 SAME과 같은 epoch) [S-T26] [ASVS v5.0.0-15.4.2]', async () => {
    const s = await rebuilt();
    s.store.setNodeId(PROMOTED);
    const rs = await Promise.all(Array.from({ length: 5 }, () => s.store.bumpEpoch(s.eventId)));
    expect(rs.filter((r) => r.result === 'BUMPED')).toHaveLength(1);
    expect(rs.filter((r) => r.result === 'SAME')).toHaveLength(4);
    expect(new Set(rs.map((r) => (r as { epoch: number }).epoch))).toEqual(new Set([NOW_SEC + 1]));
  });

  test('ST26_ 판매 열기의 세대 키(gen 1)를 올려도 gen은 1 그대로다 [S-T26]', async () => {
    const s = setup();
    await s.store.openSale({ eventId: s.eventId, seatCount: SEAT_COUNT, keepUntilMs: KEEP });
    s.store.setNodeId(PROMOTED);
    await s.store.bumpEpoch(s.eventId);
    expect(s.ev().epoch).toEqual({ epoch: NOW_SEC + 1, node: PROMOTED, gen: 1, chk: NOW_SEC, bumps: 1 });
  });

  test('ST26_ eventId가 키 조각 모양이 아니면 RangeError다 [S-T26]', async () => {
    await expect(setup().store.bumpEpoch('bad}{id')).rejects.toThrow(RangeError);
  });
});

describe('다시 만든 뒤의 홀드·묶기·만료', () => {
  const hold = (e: string, seatIds: string[], accountId: string) => holdInput(e, seatIds, { keepUntilMs: KEEP, accountId, limit: 4 });

  test('ST26_inv_noOversell_ 다시 만든 뒤 홀드: 판매 좌석·되살린 남의 홀드 좌석은 CONFLICT, 빈 좌석은 OK이고 새 토큰은 되살린 토큰보다 크다(펜싱 카운터를 다시 쓰지 않아도) [S-T26] [S-T5]', async () => {
    const s = await rebuilt();
    const e = s.eventId;
    await expect(s.store.hold(hold(e, ['A01'], ACCOUNT_B))).resolves.toEqual({ kind: 'CONFLICT', seatId: 'A01' });
    await expect(s.store.hold(hold(e, ['A02'], ACCOUNT_A))).resolves.toEqual({ kind: 'CONFLICT', seatId: 'A02' });
    await expect(s.store.hold(hold(e, ['A05'], ACCOUNT_A))).resolves.toEqual({ kind: 'CONFLICT', seatId: 'A05' });
    await expect(s.store.hold(hold(e, ['A03'], ACCOUNT_B))).resolves.toEqual({ kind: 'CONFLICT', seatId: 'A03' });
    const r = await s.store.hold(hold(e, ['A06'], ACCOUNT_B));
    expect(r.kind).toBe('OK');
    if (r.kind !== 'OK') return;
    expect(r.fencingToken).toBeGreaterThan(Math.max(T_A3, T_B5));
    expect(r.heldAtMs).toBe(NOW);
  });

  test('ST26_inv_quota_ 다시 만든 뒤 홀드는 되살린 보유 수로 1인 한도를 본다: A(판매 2 + 홀드 1)는 한도 4에서 2석이면 QUOTA_EXCEEDED, 1석이면 OK [S-T26]', async () => {
    const s = await rebuilt();
    await expect(s.store.hold(hold(s.eventId, ['A07', 'A08'], ACCOUNT_A))).resolves.toEqual({ kind: 'QUOTA_EXCEEDED' });
    expect((await s.store.hold(hold(s.eventId, ['A07'], ACCOUNT_A))).kind).toBe('OK');
    expect(s.ev().quota.get(ACCOUNT_A)).toBe(4);
  });

  test('ST26_ 다시 만든 뒤 묶기: 되살린 내 홀드만이면 orderGen 1(옛 판 번호)이어도 OK(빈 좌석이 없어 판 번호를 보지 않는다), 빈 좌석이 있는데 orderGen 1이면 STALE_GEN(gen 2)이고 아무것도 쓰지 않으며, 새 gen이면 다시 잡는다 [S-T26] [S-T5]', async () => {
    const s = await rebuilt();
    const e = s.eventId;
    const pin = (seats: SeatRef[], orderGen: number): PinInput => ({ eventId: e, accountId: ACCOUNT_A, purchaseSessionId: '0190f3a1-7c2e-7a00-8000-0000000001a3', holdId: '0190f3a1-7c2e-7a00-8000-0000000000a3', seats, limit: 4, orderGen, keepUntilMs: KEEP });
    await expect(s.store.pin(pin([ref('A03')], 1))).resolves.toEqual({ kind: 'OK', gen: 2, regrabbed: 0 });
    const before = stateOf(s.store, e);
    await expect(s.store.pin(pin([ref('A03'), ref('A04')], 1))).resolves.toEqual({ kind: 'STALE_GEN', gen: 2 });
    expect(stateOf(s.store, e)).toBe(before);
    const r = await s.store.pin(pin([ref('A03'), ref('A04')], 2));
    expect(r).toMatchObject({ kind: 'OK', gen: 2, regrabbed: 1 });
    expect(s.ev().bits.has(3)).toBe(true);
    expect(s.ev().holds.get(3)).toMatchObject({ holdId: '0190f3a1-7c2e-7a00-8000-0000000000a3', owner: ACCOUNT_A, pin: '1' });
  });

  test('ST26_ST7_ 다시 만든 판매 좌석은 판매 계정·그 holdId로 묶으면 내 홀드라 OK(regrabbed 0)이고, 다른 holdId·다른 계정이면 TAKEN이다(되살린 남의 홀드 좌석도 TAKEN) [S-T26] [S-T7]', async () => {
    const s = await rebuilt();
    const e = s.eventId;
    const base = { eventId: e, purchaseSessionId: '0190f3a1-7c2e-7a00-8000-0000000001a1', limit: 4, orderGen: 2, keepUntilMs: KEEP };
    await expect(s.store.pin({ ...base, accountId: ACCOUNT_A, holdId: '0190f3a1-7c2e-7a00-8000-0000000000a1', seats: [ref('A01'), ref('A02')] })).resolves.toEqual({ kind: 'OK', gen: 2, regrabbed: 0 });
    await expect(s.store.pin({ ...base, accountId: ACCOUNT_A, holdId: '0190f3a1-7c2e-7a00-8000-0000000000ff', seats: [ref('A01')] })).resolves.toEqual({ kind: 'TAKEN', seatIndex: 0 });
    await expect(s.store.pin({ ...base, accountId: ACCOUNT_B, holdId: '0190f3a1-7c2e-7a00-8000-0000000000a1', seats: [ref('A02')] })).resolves.toEqual({ kind: 'TAKEN', seatIndex: 1 });
    await expect(s.store.pin({ ...base, accountId: ACCOUNT_B, holdId: '0190f3a1-7c2e-7a00-8000-0000000000b5', seats: [ref('A03')] })).resolves.toEqual({ kind: 'TAKEN', seatIndex: 2 });
  });

  test('ST26_ST6_ 다시 만든 뒤 만료: 되살린 홀드는 원장 만료 시각에 만료 인덱스 앞줄로 읽히고(holdId·토큰·owner 그대로), 판매 좌석은 읽히지 않는다 [S-T26] [S-T5]', async () => {
    const s = await rebuilt();
    expect(await s.store.dueExpiries({ eventId: s.eventId, nowMs: EXP - 1, limit: 10 })).toEqual([]);
    expect(await s.store.dueExpiries({ eventId: s.eventId, nowMs: EXP, limit: 10 })).toEqual([
      { index: 2, expiresAtMs: EXP, hold: { holdId: '0190f3a1-7c2e-7a00-8000-0000000000a3', fencingToken: String(T_A3), owner: ACCOUNT_A } },
      { index: 4, expiresAtMs: EXP, hold: { holdId: '0190f3a1-7c2e-7a00-8000-0000000000b5', fencingToken: String(T_B5), owner: ACCOUNT_B } },
    ]);
  });
});

describe('코드 리뷰 재현(PRF-143)', () => {
  test('코드 리뷰_ finish는 결과와 관계없이 회차 목록에 회차를 넣는다(READY여도. Redis는 Lua 앞의 SADD라 Lua 뒤 SADD가 실패해 목록에서 빠진 회차가 READY로 굳지 않는다) [S-T26]', async () => {
    const s = setup();
    s.ev().epoch = { epoch: NOW_SEC - 50, node: 'pod-other', gen: 3 };
    await s.store.finish(s.eventId, { quotas: QUOTAS, gen: 4, keepUntilMs: KEEP });
    expect(s.store.db.ctlEvents.has(s.eventId)).toBe(true);
    expect(s.ev().epoch).toEqual({ epoch: NOW_SEC - 50, node: 'pod-other', gen: 3 });
  });
});
