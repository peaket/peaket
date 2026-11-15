// 우선 구매 보류 만료의 **경합**과 경계(GAT-135 S-T37 ⑦, docs/features/seat-hold.md §5, ADR-0210).
// 만료 반복은 1단계(prio에서 지난 색인·기대 권리 읽기)와 2단계(만료 Lua) 사이에 다른 실행이 그 좌석을 풀고 다시 잡을 수 있다.
// 2단계는 1단계에서 읽은 권리·fence·소유자가 그대로일 때만 풀어야 한다(아니면 남의 새 보류를 지운다).
// 여기서는 MemorySeatStore의 쌍둥이로 그 차례를 고정하고, 운영 Lua의 같은 계약은 priority-lua-contract.test.ts가 본다.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemorySeatStore, type MemorySeatEvent } from '../src/modules/inventory/index.js';

const NOW = Date.parse('2026-11-14T08:00:00.000Z');
const DAY = 86_400_000;
const EVENT = '01900000-0000-7000-8000-000000000001';
const ACCOUNT = '01900000-0000-7000-8000-000000000002';
const OTHER = '01900000-0000-7000-8000-000000000003';
const GRANT_A = '01900000-0000-7000-8000-0000000000a1';
const GRANT_B = '01900000-0000-7000-8000-0000000000b1';
const KEEP = NOW + 10 * DAY;
const SEATS = [
  { seatId: 'A01', index: 0, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: 0, tierId: 'R' },
  { seatId: 'A02', index: 1, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: 1, tierId: 'R' },
] as const;

const fixture = async () => {
  const clock = fakeClock({ now: NOW });
  const store = new MemorySeatStore(clock);
  await store.openSale({ eventId: EVENT, seatCount: SEATS.length, keepUntilMs: KEEP });
  const ev = (): MemorySeatEvent => store.db.event(EVENT);
  return { clock, store, ev };
};

describe('우선 구매 만료 경합', () => {
  test('1단계 뒤 다른 권리가 그 좌석을 다시 잡았으면 2단계는 건너뛰고 새 보류를 지우지 않는다', async () => {
    const f = await fixture();
    expect(await f.store.holdPriority({ eventId: EVENT, accountId: ACCOUNT, grantId: GRANT_A, seat: SEATS[0], expiresAtMs: NOW + 1_000, keepUntilMs: KEEP })).toMatchObject({ kind: 'OK' });
    f.clock.advance(1_000);
    const due = await f.store.duePriorityExpiries({ eventId: EVENT, nowMs: f.clock.now(), limit: 100 });
    expect(due).toMatchObject([{ index: 0, hold: { grantId: GRANT_A, owner: ACCOUNT } }]);

    // 그 사이 A가 풀리고 B가 같은 좌석을 새로 잡았다(만료 반복과 회수·재판매가 겹치는 차례)
    expect(await f.store.releasePriority({ eventId: EVENT, accountId: ACCOUNT, grantId: GRANT_A, seat: SEATS[0], keepUntilMs: KEEP })).toEqual({ kind: 'OK' });
    expect(await f.store.holdPriority({ eventId: EVENT, accountId: OTHER, grantId: GRANT_B, seat: SEATS[0], expiresAtMs: NOW + 5 * DAY, keepUntilMs: KEEP })).toMatchObject({ kind: 'OK' });

    const out = await f.store.expirePriority({ eventId: EVENT, keepUntilMs: KEEP, seats: due.map((d) => ({ index: d.index, expected: d.hold, seat: SEATS[0] })) });
    expect(out).toMatchObject({ kind: 'OK', released: 0, skipped: 1, orphans: 0, corrupt: 0, expired: [] });
    expect(f.ev().bits.has(0)).toBe(true);
    expect(f.ev().holds.get(0)).toMatchObject({ holdId: GRANT_B, owner: OTHER, kind: 'PRIORITY', priorityGrantId: GRANT_B });
    expect(f.ev().prio.get(0)).toBe(NOW + 5 * DAY);
  });

  test.each<[string, (hold: { grantId: string; fencingToken: string; owner: string }) => { grantId: string; fencingToken: string; owner: string }]>([
    ['fence', (hold) => ({ ...hold, fencingToken: String(Number(hold.fencingToken) + 1) })],
    ['owner', (hold) => ({ ...hold, owner: OTHER })],
    ['grantId', (hold) => ({ ...hold, grantId: GRANT_B })],
  ])('기대한 %s가 다르면 건너뛰고 비트·hold를 그대로 둔다', async (_label, change) => {
    const f = await fixture();
    expect(await f.store.holdPriority({ eventId: EVENT, accountId: ACCOUNT, grantId: GRANT_A, seat: SEATS[0], expiresAtMs: NOW + 1_000, keepUntilMs: KEEP })).toMatchObject({ kind: 'OK' });
    f.clock.advance(1_000);
    const due = await f.store.duePriorityExpiries({ eventId: EVENT, nowMs: f.clock.now(), limit: 100 });
    const expected = change(due[0]!.hold!);
    const out = await f.store.expirePriority({ eventId: EVENT, keepUntilMs: KEEP, seats: [{ index: 0, expected, seat: SEATS[0] }] });
    expect(out).toMatchObject({ kind: 'OK', released: 0, skipped: 1, corrupt: 0 });
    expect(f.ev().bits.has(0)).toBe(true);
    expect(f.ev().holds.get(0)).toMatchObject({ holdId: GRANT_A, owner: ACCOUNT, priorityGrantId: GRANT_A });
  });

  test('만료 시각과 지금이 정확히 같으면 푼다(<=). 1ms 이르면 건너뛴다', async () => {
    const f = await fixture();
    expect(await f.store.holdPriority({ eventId: EVENT, accountId: ACCOUNT, grantId: GRANT_A, seat: SEATS[0], expiresAtMs: NOW + 1_000, keepUntilMs: KEEP })).toMatchObject({ kind: 'OK' });
    f.clock.advance(999);
    const early = await f.store.expirePriority({ eventId: EVENT, keepUntilMs: KEEP, seats: [{ index: 0, expected: null, seat: SEATS[0] }] });
    expect(early).toMatchObject({ released: 0, skipped: 1 });
    f.clock.advance(1);
    const due = await f.store.duePriorityExpiries({ eventId: EVENT, nowMs: f.clock.now(), limit: 100 });
    const at = await f.store.expirePriority({ eventId: EVENT, keepUntilMs: KEEP, seats: due.map((d) => ({ index: d.index, expected: d.hold, seat: SEATS[0] })) });
    expect(at).toMatchObject({ kind: 'OK', released: 1, expired: [{ index: 0, grantId: GRANT_A }] });
    expect(f.ev().bits.has(0)).toBe(false);
  });

  test('prio에만 남은 고아는 인덱스에서 지우고 비트는 건드리지 않는다', async () => {
    const f = await fixture();
    f.ev().prio.set(1, NOW - 1);
    const out = await f.store.expirePriority({ eventId: EVENT, keepUntilMs: KEEP, seats: [{ index: 1, expected: null }] });
    expect(out).toMatchObject({ kind: 'OK', released: 0, skipped: 0, orphans: 1, corrupt: 0 });
    expect(f.ev().prio.has(1)).toBe(false);
    expect(f.ev().bits.has(1)).toBe(false);
  });

  test('kind가 PRIORITY가 아닌 망가진 hold는 corrupt로 세고 풀지 않는다', async () => {
    const f = await fixture();
    expect(await f.store.holdPriority({ eventId: EVENT, accountId: ACCOUNT, grantId: GRANT_A, seat: SEATS[0], expiresAtMs: NOW + 1_000, keepUntilMs: KEEP })).toMatchObject({ kind: 'OK' });
    const hold = f.ev().holds.get(0)!;
    (hold as { kind: string }).kind = 'AUTO';
    f.clock.advance(1_000);
    const out = await f.store.expirePriority({ eventId: EVENT, keepUntilMs: KEEP, seats: [{ index: 0, expected: { grantId: GRANT_A, fencingToken: hold.fence, owner: ACCOUNT }, seat: SEATS[0] }] });
    expect(out).toMatchObject({ kind: 'OK', released: 0, skipped: 0, corrupt: 1 });
    expect(f.ev().bits.has(0)).toBe(true);
    expect(f.ev().holds.get(0)).toBe(hold);
  });

  test('세대 키가 없으면 NOT_READY이고 아무것도 쓰지 않는다', async () => {
    const f = await fixture();
    expect(await f.store.holdPriority({ eventId: EVENT, accountId: ACCOUNT, grantId: GRANT_A, seat: SEATS[0], expiresAtMs: NOW + 1_000, keepUntilMs: KEEP })).toMatchObject({ kind: 'OK' });
    f.ev().epoch = undefined;
    expect(await f.store.expirePriority({ eventId: EVENT, keepUntilMs: KEEP, seats: [{ index: 0, expected: null, seat: SEATS[0] }] })).toEqual({ kind: 'NOT_READY' });
    expect(f.ev().bits.has(0)).toBe(true);
    expect(f.ev().holds.has(0)).toBe(true);
  });

  test('keepUntil이 지났으면 PEAKET_KEEP_UNTIL_PAST로 거절한다', async () => {
    const f = await fixture();
    f.clock.advance(1);
    await expect(f.store.expirePriority({ eventId: EVENT, keepUntilMs: NOW, seats: [{ index: 0, expected: null }] })).rejects.toThrow(/PEAKET_KEEP_UNTIL_PAST/);
  });
});

describe('우선 구매 만료 1단계(duePriorityExpiries)', () => {
  test('만료가 지난 것만 exp·색인 오름차순으로 주고 미래는 주지 않는다', async () => {
    const f = await fixture();
    expect(await f.store.holdPriority({ eventId: EVENT, accountId: ACCOUNT, grantId: GRANT_A, seat: SEATS[0], expiresAtMs: NOW + 5_000, keepUntilMs: KEEP })).toMatchObject({ kind: 'OK' });
    expect(await f.store.holdPriority({ eventId: EVENT, accountId: ACCOUNT, grantId: GRANT_B, seat: SEATS[1], expiresAtMs: NOW + 1_000, keepUntilMs: KEEP })).toMatchObject({ kind: 'OK' });
    const due = await f.store.duePriorityExpiries({ eventId: EVENT, nowMs: NOW + 1_000, limit: 100 });
    expect(due).toMatchObject([{ index: 1, expiresAtMs: NOW + 1_000, hold: { grantId: GRANT_B, owner: ACCOUNT } }]);
    expect(await f.store.duePriorityExpiries({ eventId: EVENT, nowMs: NOW + 1_000, limit: 100, offset: 1 })).toEqual([]);
  });

  test('hold의 kind·priorityGrantId가 어긋나면 corrupt로 표시하고 기대값을 주지 않는다', async () => {
    const f = await fixture();
    expect(await f.store.holdPriority({ eventId: EVENT, accountId: ACCOUNT, grantId: GRANT_A, seat: SEATS[0], expiresAtMs: NOW + 1_000, keepUntilMs: KEEP })).toMatchObject({ kind: 'OK' });
    f.ev().holds.get(0)!.priorityGrantId = GRANT_B;
    const due = await f.store.duePriorityExpiries({ eventId: EVENT, nowMs: NOW + 1_000, limit: 100 });
    expect(due).toMatchObject([{ index: 0, hold: null, corrupt: true }]);
  });
});
