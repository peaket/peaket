// 우선 구매 주문의 결제 실패 복귀(GAT-135 S-T37 ⑤, docs/features/payment.md §2 단계 RESERVE, ADR-0171).
// 복귀는 **그 권리의 PRIORITY 보류**에서 주문 표시만 지운다. 다른 권리·다른 계정·일반 홀드는 건드리지 않는다.
// 여기서는 MemorySeatStore의 쌍둥이로 그 차례를 고정하고, 운영 Lua의 같은 계약은 priority-lua-contract.test.ts가 본다.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemorySeatStore } from '../src/modules/inventory/index.js';
import { holdInput } from './hold-cases.js';

const NOW = Date.parse('2026-11-14T08:00:00.000Z');
const DAY = 86_400_000;
const EVENT = '01900000-0000-7000-8000-000000000001';
const ACCOUNT = '01900000-0000-7000-8000-000000000002';
const OTHER = '01900000-0000-7000-8000-000000000003';
const GRANT = '01900000-0000-7000-8000-0000000000c1';
const KEEP = NOW + 10 * DAY;
const SEAT = { seatId: 'A01', index: 0, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: 0, tierId: 'R' } as const;

const fixture = async () => {
  const clock = fakeClock({ now: NOW });
  const store = new MemorySeatStore(clock);
  await store.openSale({ eventId: EVENT, seatCount: 4, keepUntilMs: KEEP });
  const ev = () => store.db.event(EVENT);
  return { clock, store, ev };
};

/** 우선 보류 하나를 잡고 주문 표시(pin)까지 붙인 상태 */
const pinned = async () => {
  const f = await fixture();
  expect(await f.store.holdPriority({ eventId: EVENT, accountId: ACCOUNT, grantId: GRANT, seat: SEAT, expiresAtMs: NOW + DAY, keepUntilMs: KEEP })).toMatchObject({ kind: 'OK' });
  expect(await f.store.pin({ eventId: EVENT, accountId: ACCOUNT, purchaseSessionId: 'ps-priority-1', holdId: GRANT, seats: [SEAT], limit: 4, orderGen: 1, keepUntilMs: KEEP })).toMatchObject({ kind: 'OK' });
  expect(f.ev().holds.get(0)?.pin).toBe('1');
  return f;
};

describe('restorePriority: 그 권리의 PRIORITY 보류만 되돌린다', () => {
  test('다른 권리 ID로는 되돌리지 않고 주문 표시·비트·prio를 그대로 둔다', async () => {
    const f = await pinned();
    const out = await f.store.restorePriority({ eventId: EVENT, accountId: ACCOUNT, grantId: '01900000-0000-7000-8000-0000000000c2', seats: [SEAT], keepUntilMs: KEEP });
    expect(out).toEqual({ kind: 'OK', restored: 0 });
    expect(f.ev().holds.get(0)).toMatchObject({ holdId: GRANT, owner: ACCOUNT, kind: 'PRIORITY', priorityGrantId: GRANT, pin: '1' });
    expect(f.ev().bits.has(0)).toBe(true);
    expect(f.ev().prio.get(0)).toBe(NOW + DAY);
  });

  test('다른 계정으로는 되돌리지 않는다', async () => {
    const f = await pinned();
    expect(await f.store.restorePriority({ eventId: EVENT, accountId: OTHER, grantId: GRANT, seats: [SEAT], keepUntilMs: KEEP })).toEqual({ kind: 'OK', restored: 0 });
    expect(f.ev().holds.get(0)?.pin).toBe('1');
  });

  test('같은 ID라도 kind가 PRIORITY가 아니면(일반 홀드) 되돌리지 않는다', async () => {
    const f = await fixture();
    expect(
      await f.store.hold(holdInput(EVENT, ['A01'], { accountId: ACCOUNT, holdId: GRANT, purchaseSessionId: 'ps-normal-1', keepUntilMs: KEEP })),
    ).toMatchObject({ kind: 'OK' });
    expect(await f.store.restorePriority({ eventId: EVENT, accountId: ACCOUNT, grantId: GRANT, seats: [SEAT], keepUntilMs: KEEP })).toEqual({ kind: 'OK', restored: 0 });
    expect(f.ev().holds.get(0)).toMatchObject({ holdId: GRANT, owner: ACCOUNT });
    expect(f.ev().bits.has(0)).toBe(true);
  });

  test('세대 키가 없으면 NOT_READY이고 주문 표시를 지우지 않는다', async () => {
    const f = await pinned();
    f.ev().epoch = undefined;
    expect(await f.store.restorePriority({ eventId: EVENT, accountId: ACCOUNT, grantId: GRANT, seats: [SEAT], keepUntilMs: KEEP })).toEqual({ kind: 'NOT_READY' });
    expect(f.ev().holds.get(0)?.pin).toBe('1');
  });

  test('keepUntil이 지났으면 PEAKET_KEEP_UNTIL_PAST로 거절한다', async () => {
    const f = await pinned();
    f.clock.advance(1);
    await expect(f.store.restorePriority({ eventId: EVENT, accountId: ACCOUNT, grantId: GRANT, seats: [SEAT], keepUntilMs: NOW })).rejects.toThrow(/PEAKET_KEEP_UNTIL_PAST/);
  });
});
