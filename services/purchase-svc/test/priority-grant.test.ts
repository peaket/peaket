// 우선 구매 권리 발급·회수(GAT-135, S-T37의 보류 부분) 단위 시험.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemorySeatMap } from '../src/modules/inventory/adapters/memory-seat-map.js';
import { MemorySeatStore } from '../src/modules/inventory/adapters/memory-seat-store.js';
import { GrantPriorityPurchase, MemoryPriorityGrantStore, priorityGrantUsable, SeatMapPriorityCandidates, WithdrawPriorityGrant, type PriorityGrant } from '../src/modules/priority/index.js';

const NOW = Date.parse('2026-11-14T08:00:00.000Z');
const DAY = 86_400_000;
const EVENT = '01900000-0000-7000-8000-000000000001';
const ACCOUNT = '01900000-0000-7000-8000-000000000002';
const CASE = '01900000-0000-7000-8000-000000000003';
const TICKET = '01900000-0000-7000-8000-000000000004';
const TIER = 'R';
const SEATS = [
  { seatId: 'A01', index: 0, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: 0, tierId: TIER },
  { seatId: 'A02', index: 1, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: 1, tierId: TIER },
  { seatId: 'A03', index: 2, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: 2, tierId: TIER },
  { seatId: 'B01', index: 3, sectionId: 'SEC-B', sectionIndex: 1, seatOffset: 0, tierId: 'S' },
] as const;

const fixture = (ticketOver: { entryStartsAtMs?: number } = {}, soldSeats: readonly string[] = []) => {
  const clock = fakeClock({ now: NOW });
  const store = new MemorySeatStore(clock);
  const map = new MemorySeatMap();
  map.put({ eventId: EVENT, layoutVersion: 'v1', seatCount: SEATS.length, perAccountLimit: 4, saleEndsAtMs: NOW + 7 * DAY, tierPrices: { R: 110_000, S: 88_000 } }, [...SEATS]);
  const grants = new MemoryPriorityGrantStore();
  const cancelled = {
    find: async (id: string, fraudCaseId: string) =>
      id === TICKET && fraudCaseId === CASE ? { eventId: EVENT, accountId: ACCOUNT, orderId: '01900000-0000-7000-8000-000000000005', seatId: 'A01', tierId: TIER, price: 110_000, ...ticketOver } : undefined,
  };
  const sold = new Set(soldSeats);
  const sales = { active: async (_eventId: string, seatIds: readonly string[]) => new Set(seatIds.filter((id) => sold.has(id))) };
  const grant = new GrantPriorityPurchase({ grants, cancelled, seats: store, candidates: new SeatMapPriorityCandidates(map), seatMap: map, sales, clock });
  const withdraw = new WithdrawPriorityGrant(grants, () => NOW + 1, { seats: store, seatMap: map });
  return { clock, store, map, grants, grant, withdraw, sold };
};

const input = (over: Record<string, unknown> = {}) => ({ fraudCaseId: CASE, eventId: EVENT, accountId: ACCOUNT, cancelledTicketId: TICKET, actedBy: 'commander-1', ...over });

describe('GrantPriorityPurchase', () => {
  test('S-T37 ①_같은_좌석이_비어_있으면_SAME_SEAT로_우선_보류를_잡는다', async () => {
    const f = fixture();
    await f.store.openSale({ eventId: EVENT, seatCount: SEATS.length, keepUntilMs: NOW + 10 * DAY });
    const r = await f.grant.run(input());
    expect(r.result).toBe('SAME_SEAT');
    expect(r.grant).toMatchObject({ grantKind: 'SAME_SEAT', seatId: 'A01', tierId: TIER, price: 110_000, status: 'OFFERED', version: 1, expiresAtMs: NOW + 2 * DAY });
    const ev = f.store.db.event(EVENT);
    expect(ev.bits.has(0)).toBe(true);
    expect(ev.holds.get(0)).toMatchObject({ holdId: r.grant!.grantId, owner: ACCOUNT, kind: 'PRIORITY', priorityGrantId: r.grant!.grantId, psid: '' });
    expect(ev.prio.get(0)).toBe(r.grant!.expiresAtMs);
    expect(ev.expiry.has(0)).toBe(false);
    expect(ev.quota.size).toBe(0);
  });

  test('S-T37 ②_같은_좌석이_팔렸으면_같은_등급의_남은_좌석으로_SAME_TIER다', async () => {
    const f = fixture();
    await f.store.openSale({ eventId: EVENT, seatCount: SEATS.length, keepUntilMs: NOW + 10 * DAY });
    // 다른 권리가 같은 좌석을 먼저 잡았다.
    const other = await f.store.holdPriority({ eventId: EVENT, accountId: ACCOUNT, grantId: '01900000-0000-7000-8000-000000000099', seat: SEATS[0], expiresAtMs: NOW + DAY, keepUntilMs: NOW + DAY });
    expect(other.kind).toBe('OK');
    const r = await f.grant.run(input());
    expect(r.result).toBe('SAME_TIER');
    expect(r.grant?.seatId).not.toBe('A01');
    expect(r.grant?.tierId).toBe(TIER);
  });

  test('S-T37 ③_같은_등급에도_좌석이_없으면_NO_SEAT다', async () => {
    const f = fixture();
    await f.store.openSale({ eventId: EVENT, seatCount: SEATS.length, keepUntilMs: NOW + 10 * DAY });
    for (const s of SEATS.filter((x) => x.tierId === TIER)) {
      const r = await f.store.holdPriority({ eventId: EVENT, accountId: ACCOUNT, grantId: '01900000-0000-7000-8000-000000000098', seat: s, expiresAtMs: NOW + DAY, keepUntilMs: NOW + DAY });
      expect(r.kind).toBe('OK');
    }
    const r = await f.grant.run(input());
    expect(r.result).toBe('NO_SEAT');
    expect(r.grant).toBeUndefined();
  });

  test('GAT135_다른_부정_예매_사건의_취소표는_권리를_만들지_않는다', async () => {
    const f = fixture();
    await f.store.openSale({ eventId: EVENT, seatCount: SEATS.length, keepUntilMs: NOW + 10 * DAY });
    await expect(f.grant.run(input({ fraudCaseId: '01900000-0000-7000-8000-000000000099' }))).rejects.toMatchObject({ name: 'PriorityGrantNotFound' });
    expect(f.store.db.event(EVENT).bits.size).toBe(0);
  });

  test('GAT135_입장이_시작됐으면_ENTRY_STARTED다', async () => {
    const f = fixture({ entryStartsAtMs: NOW - 1 });
    await f.store.openSale({ eventId: EVENT, seatCount: SEATS.length, keepUntilMs: NOW + 10 * DAY });
    const r = await f.grant.run(input());
    expect(r.result).toBe('ENTRY_STARTED');
    expect(r.grant).toBeUndefined();
  });

  test('GAT135_같은_취소_표로_다시_오면_처음_권리를_돌려준다', async () => {
    const f = fixture();
    await f.store.openSale({ eventId: EVENT, seatCount: SEATS.length, keepUntilMs: NOW + 10 * DAY });
    const a = await f.grant.run(input());
    const b = await f.grant.run(input());
    expect(b.result).toBe(a.result);
    expect(b.grant?.grantId).toBe(a.grant?.grantId);
    expect(f.grants.grants.size).toBe(1);
  });

  test('GAT135_회수는_OFFERED를_WITHDRAWN으로_바꾸고_판을_올리며_좌석을_바로_돌려준다', async () => {
    const f = fixture();
    await f.store.openSale({ eventId: EVENT, seatCount: SEATS.length, keepUntilMs: NOW + 10 * DAY });
    const r = await f.grant.run(input());
    const w = await f.withdraw.run(r.grant!.grantId, 'commander-1');
    expect(w).toMatchObject({ status: 'WITHDRAWN', version: 2 });
    const ev = f.store.db.event(EVENT);
    expect(ev.bits.has(0)).toBe(false);
    expect(ev.holds.has(0)).toBe(false);
    expect(ev.prio.has(0)).toBe(false);
    expect(await f.withdraw.run(r.grant!.grantId, 'commander-1')).toMatchObject({ status: 'WITHDRAWN', version: 2 });
  });

  test('S-T37_⑦_권리_만료_회수는_좌석을_풀고_권리를_EXPIRED로_끝낸다', async () => {
    const f = fixture();
    await f.store.openSale({ eventId: EVENT, seatCount: SEATS.length, keepUntilMs: NOW + 10 * DAY });
    const r = await f.grant.run(input());
    f.clock.advance(2 * DAY + 1);
    const due = await f.store.duePriorityExpiries({ eventId: EVENT, nowMs: f.clock.now(), limit: 100 });
    expect(due).toHaveLength(1);
    const out = await f.store.expirePriority({ eventId: EVENT, keepUntilMs: NOW + 10 * DAY, seats: due.map((d) => ({ index: d.index, expected: d.hold, seat: SEATS[0] })) });
    expect(out).toMatchObject({ kind: 'OK', released: 1, expired: [{ index: 0, grantId: r.grant!.grantId }] });
    const ev = f.store.db.event(EVENT);
    expect(ev.bits.has(0)).toBe(false);
    expect(ev.prio.has(0)).toBe(false);
    await f.grants.expire(r.grant!.grantId, f.clock.now());
    expect(await f.grants.find(r.grant!.grantId)).toMatchObject({ status: 'EXPIRED', version: 2 });
  });

  test('GAT135_팔린_좌석은_다시_잡지_않고_같은_등급의_남은_좌석으로_간다', async () => {
    const f = fixture({}, ['A01']);
    await f.store.openSale({ eventId: EVENT, seatCount: SEATS.length, keepUntilMs: NOW + 10 * DAY });
    const r = await f.grant.run(input());
    expect(r.result).toBe('SAME_TIER');
    expect(r.grant?.seatId).not.toBe('A01');
  });

  test('GAT135_같은_취소_표로_동시에_두_번_와도_권리_하나만_남고_여분_보류는_푼다', async () => {
    const f = fixture();
    await f.store.openSale({ eventId: EVENT, seatCount: SEATS.length, keepUntilMs: NOW + 10 * DAY });
    const [a, b] = await Promise.all([f.grant.run(input()), f.grant.run(input())]);
    expect(a.grant?.grantId).toBe(b.grant?.grantId);
    expect(f.grants.grants.size).toBe(1);
    const ev = f.store.db.event(EVENT);
    expect(ev.bits.size).toBe(1);
    expect(ev.prio.size).toBe(1);
  });

  test('GAT135_이미_사용한_권리는_회수하지_못한다', async () => {
    const f = fixture();
    await f.store.openSale({ eventId: EVENT, seatCount: SEATS.length, keepUntilMs: NOW + 10 * DAY });
    const r = await f.grant.run(input());
    await f.grants.markUsed(r.grant!.grantId, '01900000-0000-7000-8000-0000000000aa', NOW + 1);
    await expect(f.withdraw.run(r.grant!.grantId, 'commander-1')).rejects.toMatchObject({ status: 409, type: expect.stringContaining('priority-grant-already-used') });
  });

  test('S-T37_입장_시작이_권리_TTL보다_이르면_만료를_입장_시작으로_당긴다', async () => {
    const entryStartsAtMs = NOW + DAY;
    const f = fixture({ entryStartsAtMs });
    await f.store.openSale({ eventId: EVENT, seatCount: SEATS.length, keepUntilMs: NOW + 10 * DAY });
    const r = await f.grant.run(input());
    expect(r.result).toBe('SAME_SEAT');
    expect(r.grant).toMatchObject({ status: 'OFFERED', expiresAtMs: entryStartsAtMs });
    const ev = f.store.db.event(EVENT);
    expect(ev.prio.get(0)).toBe(entryStartsAtMs);
    // 보류 Hash의 만료도 입장 시작으로 당긴다
    expect(ev.holds.get(0)?.exp).toBe(entryStartsAtMs);
  });

  test('S-T37_만료_시각과_지금이_같으면_만료_반복이_권리를_풀고_EXPIRED로_끝낸다', async () => {
    const f = fixture();
    await f.store.openSale({ eventId: EVENT, seatCount: SEATS.length, keepUntilMs: NOW + 10 * DAY });
    const grantId = '01900000-0000-7000-8000-000000000077';
    expect(await f.store.holdPriority({ eventId: EVENT, accountId: ACCOUNT, grantId, seat: SEATS[0], expiresAtMs: NOW + 1, keepUntilMs: NOW + 10 * DAY })).toMatchObject({ kind: 'OK' });
    f.clock.advance(1);
    const due = await f.store.duePriorityExpiries({ eventId: EVENT, nowMs: f.clock.now(), limit: 100 });
    expect(due).toMatchObject([{ index: 0, expiresAtMs: NOW + 1, hold: { grantId, owner: ACCOUNT } }]);
    const out = await f.store.expirePriority({ eventId: EVENT, keepUntilMs: NOW + 10 * DAY, seats: due.map((d) => ({ index: d.index, expected: d.hold, seat: SEATS[0] })) });
    expect(out).toMatchObject({ kind: 'OK', released: 1, expired: [{ index: 0, grantId }] });
    expect(f.store.db.event(EVENT).bits.has(0)).toBe(false);
  });

  test('GAT135_다른_계정이나_다른_권리로는_PRIORITY_보류를_풀지_못한다', async () => {
    const f = fixture();
    await f.store.openSale({ eventId: EVENT, seatCount: SEATS.length, keepUntilMs: NOW + 10 * DAY });
    const r = await f.grant.run(input());
    const grantId = r.grant!.grantId;
    const otherAccount = '01900000-0000-7000-8000-000000000088';
    expect(await f.store.releasePriority({ eventId: EVENT, accountId: otherAccount, grantId, seat: SEATS[0], keepUntilMs: NOW + 10 * DAY })).toEqual({ kind: 'NOT_FOUND' });
    expect(await f.store.releasePriority({ eventId: EVENT, accountId: ACCOUNT, grantId: '01900000-0000-7000-8000-000000000099', seat: SEATS[0], keepUntilMs: NOW + 10 * DAY })).toEqual({ kind: 'NOT_FOUND' });
    const ev = f.store.db.event(EVENT);
    expect(ev.bits.has(0)).toBe(true);
    expect(ev.holds.get(0)?.holdId).toBe(grantId);
    expect(await f.store.releasePriority({ eventId: EVENT, accountId: ACCOUNT, grantId, seat: SEATS[0], keepUntilMs: NOW + 10 * DAY })).toEqual({ kind: 'OK' });
    expect(ev.bits.has(0)).toBe(false);
  });

  test('GAT135_결제_실패_복귀는_PRIORITY_보류의_주문_표시만_지우고_좌석은_남긴다', async () => {
    const f = fixture();
    await f.store.openSale({ eventId: EVENT, seatCount: SEATS.length, keepUntilMs: NOW + 10 * DAY });
    const r = await f.grant.run(input());
    const grantId = r.grant!.grantId;
    const keepUntilMs = NOW + 10 * DAY;
    expect(await f.store.pin({ eventId: EVENT, accountId: ACCOUNT, purchaseSessionId: 'ps-priority-1', holdId: grantId, seats: [SEATS[0]], limit: 4, orderGen: 1, keepUntilMs })).toMatchObject({ kind: 'OK' });
    const pinned = f.store.db.event(EVENT).holds.get(0)!;
    expect(pinned.pin).toBe('1');
    expect(await f.store.restorePriority({ eventId: EVENT, accountId: ACCOUNT, grantId, seats: [SEATS[0]], keepUntilMs })).toEqual({ kind: 'OK', restored: 1 });
    const restored = f.store.db.event(EVENT).holds.get(0)!;
    expect(restored).toMatchObject({ holdId: grantId, owner: ACCOUNT, kind: 'PRIORITY', priorityGrantId: grantId });
    expect(restored.pin).toBeUndefined();
    expect(f.store.db.event(EVENT).bits.has(0)).toBe(true);
    expect(f.store.db.event(EVENT).prio.has(0)).toBe(true);
  });

  test('B1-01_결제_중_권리는_만료되지_않고_결제가_끝나면_USED가_된다', async () => {
    const f = fixture();
    await f.store.openSale({ eventId: EVENT, seatCount: SEATS.length, keepUntilMs: NOW + 10 * DAY });
    const r = await f.grant.run(input());
    const grantId = r.grant!.grantId;
    const orderId = '01900000-0000-7000-8000-0000000000bb';
    expect(await f.grants.beginOrder(grantId, orderId, NOW)).toBe(true);
    f.clock.advance(3 * DAY);
    expect(await f.grants.expire(grantId, f.clock.now())).toMatchObject({ status: 'OFFERED', activeOrderId: orderId });
    expect(f.store.db.event(EVENT).bits.has(0)).toBe(true);
    expect(await f.grants.markUsed(grantId, orderId, f.clock.now())).toMatchObject({ status: 'USED', usedOrderId: orderId });
    expect((await f.grants.find(grantId))?.activeOrderId).toBeUndefined();
  });

  test('B1-02_결제_중_권리는_회수하지_않고_좌석도_풀지_않는다', async () => {
    const f = fixture();
    await f.store.openSale({ eventId: EVENT, seatCount: SEATS.length, keepUntilMs: NOW + 10 * DAY });
    const r = await f.grant.run(input());
    const grantId = r.grant!.grantId;
    const orderId = '01900000-0000-7000-8000-0000000000cc';
    expect(await f.grants.beginOrder(grantId, orderId, NOW)).toBe(true);
    await expect(f.withdraw.run(grantId, 'commander-1')).rejects.toMatchObject({ status: 409, type: expect.stringContaining('priority-grant-in-use') });
    expect(f.store.db.event(EVENT).bits.has(0)).toBe(true);
    expect((await f.grants.find(grantId))?.status).toBe('OFFERED');
  });

  test('B1-02_묶인_PRIORITY_보류는_회수가_IN_USE로_거절하고_좌석을_남긴다', async () => {
    const f = fixture();
    await f.store.openSale({ eventId: EVENT, seatCount: SEATS.length, keepUntilMs: NOW + 10 * DAY });
    const r = await f.grant.run(input());
    const grantId = r.grant!.grantId;
    expect(await f.store.pin({ eventId: EVENT, accountId: ACCOUNT, purchaseSessionId: 'ps-in-use', holdId: grantId, seats: [SEATS[0]], limit: 4, orderGen: 1, keepUntilMs: NOW + 10 * DAY })).toMatchObject({ kind: 'OK' });
    expect(await f.store.releasePriority({ eventId: EVENT, accountId: ACCOUNT, grantId, seat: SEATS[0], keepUntilMs: NOW + 10 * DAY })).toEqual({ kind: 'IN_USE' });
    expect(f.store.db.event(EVENT).bits.has(0)).toBe(true);
  });

  test('B1-03_발급과_회수의_행위자를_권리에_남긴다', async () => {
    const f = fixture();
    await f.store.openSale({ eventId: EVENT, seatCount: SEATS.length, keepUntilMs: NOW + 10 * DAY });
    const r = await f.grant.run(input({ actedBy: 'commander-7' }));
    expect(r.grant?.actedBy).toBe('commander-7');
    const w = await f.withdraw.run(r.grant!.grantId, 'operator-9');
    expect(w).toMatchObject({ status: 'WITHDRAWN', withdrawnBy: 'operator-9', actedBy: 'commander-7' });
  });

  test('B1-06_권리_DB_쓰기가_실패하면_잡은_PRIORITY_보류를_푼다', async () => {
    const f = fixture();
    await f.store.openSale({ eventId: EVENT, seatCount: SEATS.length, keepUntilMs: NOW + 10 * DAY });
    const failing = new MemoryPriorityGrantStore();
    failing.create = async () => {
      throw new Error('db down');
    };
    const grant = new GrantPriorityPurchase({ grants: failing, cancelled: { find: async () => ({ eventId: EVENT, accountId: ACCOUNT, orderId: '01900000-0000-7000-8000-000000000005', seatId: 'A01', tierId: TIER, price: 110_000 }) }, seats: f.store, candidates: new SeatMapPriorityCandidates(f.map), seatMap: f.map, clock: f.clock });
    await expect(grant.run(input())).rejects.toThrow('db down');
    expect(f.store.db.event(EVENT).bits.has(0)).toBe(false);
    expect(f.store.db.event(EVENT).prio.has(0)).toBe(false);
  });

  test('B1-06_보류를_풀지_못하면_재시도_표시를_남긴다', async () => {
    const f = fixture();
    await f.store.openSale({ eventId: EVENT, seatCount: SEATS.length, keepUntilMs: NOW + 10 * DAY });
    const failing = new MemoryPriorityGrantStore();
    failing.create = async () => {
      throw new Error('db down');
    };
    const failed: string[] = [];
    const seats = {
      holdPriority: (i: Parameters<MemorySeatStore['holdPriority']>[0]) => f.store.holdPriority(i),
      releasePriority: async () => {
        throw new Error('redis down');
      },
    };
    const grant = new GrantPriorityPurchase({ grants: failing, cancelled: { find: async () => ({ eventId: EVENT, accountId: ACCOUNT, orderId: '01900000-0000-7000-8000-000000000005', seatId: 'A01', tierId: TIER, price: 110_000 }) }, seats, candidates: new SeatMapPriorityCandidates(f.map), seatMap: f.map, clock: f.clock, logger: { grantFailed: (i) => void failed.push(i.reason) } });
    await expect(grant.run(input())).rejects.toThrow('db down');
    expect(failed).toEqual(['release-failed:Error']);
  });
});

describe('F-05-3 회수·만료 뒤 권리 상태 [GAT-135, S-T37]', () => {
  test('S-T37 ⑬ 회수 DB 실패와 다시 보내기', async () => {
    const f = fixture();
    await f.store.openSale({ eventId: EVENT, seatCount: SEATS.length, keepUntilMs: NOW + 10 * DAY });
    const r = await f.grant.run(input());
    const grantId = r.grant!.grantId;
    // 첫 회수는 보류를 푼 뒤 DB 쓰기에서 실패한다(권리는 OFFERED 그대로)
    const real = f.grants.withdraw.bind(f.grants);
    let fail = true;
    f.grants.withdraw = async (id, actedBy, nowMs) => {
      if (fail) {
        fail = false;
        throw new Error('db down');
      }
      return real(id, actedBy, nowMs);
    };
    await expect(f.withdraw.run(grantId, 'operator-9')).rejects.toThrow('db down');
    expect((await f.grants.find(grantId))?.status).toBe('OFFERED');

    // 다시 보내면 이미 풀린 PRIORITY 보류는 NOT_FOUND로 건너뛰고 DB를 WITHDRAWN으로 바꾼다
    const w = await f.withdraw.run(grantId, 'operator-9');
    expect(w).toMatchObject({ status: 'WITHDRAWN', withdrawnBy: 'operator-9' });
  });

  test('S-T37 ⑭ USED 권리와 기한이 지난 OFFERED 권리는 주문에 쓸 수 없다', () => {
    const base: PriorityGrant = {
      grantId: '01900000-0000-7000-8000-0000000000a1',
      eventId: EVENT,
      accountId: ACCOUNT,
      fraudCaseId: CASE,
      cancelledTicketId: TICKET,
      grantKind: 'SAME_SEAT',
      seatId: SEATS[0].seatId,
      tierId: TIER,
      price: 110_000,
      status: 'OFFERED',
      expiresAtMs: NOW + DAY,
      version: 2,
      createdAtMs: NOW - DAY,
      updatedAtMs: NOW,
    };
    expect(priorityGrantUsable({ ...base, status: 'USED' }, NOW)).toBe(false);
    expect(priorityGrantUsable({ ...base, status: 'OFFERED', expiresAtMs: NOW }, NOW)).toBe(false);
    expect(priorityGrantUsable({ ...base, status: 'OFFERED', expiresAtMs: NOW + 1, activeOrderId: undefined }, NOW)).toBe(true);
  });
});
