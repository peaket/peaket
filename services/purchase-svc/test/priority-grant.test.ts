// 우선 구매 권리 발급·회수(GAT-135, S-T37의 보류 부분) 단위 시험.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemorySeatMap } from '../src/modules/inventory/adapters/memory-seat-map.js';
import { MemorySeatStore } from '../src/modules/inventory/adapters/memory-seat-store.js';
import { GrantPriorityPurchase, MemoryPriorityGrantStore, SeatMapPriorityCandidates, WithdrawPriorityGrant } from '../src/modules/priority/index.js';

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

const fixture = (ticketOver: { entryStartsAtMs?: number } = {}) => {
  const clock = fakeClock({ now: NOW });
  const store = new MemorySeatStore(clock);
  const map = new MemorySeatMap();
  map.put({ eventId: EVENT, layoutVersion: 'v1', seatCount: SEATS.length, perAccountLimit: 4, saleEndsAtMs: NOW + 7 * DAY, tierPrices: { R: 110_000, S: 88_000 } }, [...SEATS]);
  const grants = new MemoryPriorityGrantStore();
  const cancelled = {
    find: async (id: string, fraudCaseId: string) =>
      id === TICKET && fraudCaseId === CASE ? { eventId: EVENT, accountId: ACCOUNT, orderId: '01900000-0000-7000-8000-000000000005', seatId: 'A01', tierId: TIER, price: 110_000, ...ticketOver } : undefined,
  };
  const grant = new GrantPriorityPurchase({ grants, cancelled, seats: store, candidates: new SeatMapPriorityCandidates(map), seatMap: map, clock });
  const withdraw = new WithdrawPriorityGrant(grants, () => NOW + 1);
  return { clock, store, map, grants, grant, withdraw };
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

  test('GAT135_회수는_OFFERED를_WITHDRAWN으로_바꾸고_판을_올린다', async () => {
    const f = fixture();
    await f.store.openSale({ eventId: EVENT, seatCount: SEATS.length, keepUntilMs: NOW + 10 * DAY });
    const r = await f.grant.run(input());
    const w = await f.withdraw.run(r.grant!.grantId);
    expect(w).toMatchObject({ status: 'WITHDRAWN', version: 2 });
    expect(await f.withdraw.run(r.grant!.grantId)).toMatchObject({ status: 'WITHDRAWN', version: 2 });
  });

  test('GAT135_이미_사용한_권리는_회수하지_못한다', async () => {
    const f = fixture();
    await f.store.openSale({ eventId: EVENT, seatCount: SEATS.length, keepUntilMs: NOW + 10 * DAY });
    const r = await f.grant.run(input());
    await f.grants.markUsed(r.grant!.grantId, '01900000-0000-7000-8000-0000000000aa', NOW + 1);
    await expect(f.withdraw.run(r.grant!.grantId)).rejects.toMatchObject({ status: 409, type: expect.stringContaining('priority-grant-already-used') });
  });
});
