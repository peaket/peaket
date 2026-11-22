// 우선 구매 보류가 남은 회차를 메모리 저장소도 목록에서 빼지 않는지(GAT-135 S-T37 ⑨, docs/features/seat-hold.md §6 '회차 목록에서 빼기').
// 운영 저장소(RedisSeatStore)는 실제 Valkey 시험 test-int/seat-retire.int.test.ts가 보고, 이 파일은 같은 차례를 메모리 저장소에서 고정한다.
import { randomUUID } from 'node:crypto';
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemorySeatStore, RETIRE_AFTER_SALE_END_MS, type SeatRef } from '../src/modules/inventory/index.js';

const NOW = Date.parse('2026-11-22T00:00:00.000Z');
const DAY = 86_400_000;
const HOUR = 3_600_000;

const seat: SeatRef = { seatId: 'S1', index: 0, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: 0, tierId: 'R' };

describe('S-T37 ⑨ 메모리 저장소의 회차 목록 빼기', () => {
  test('S-T37 ⑨ 메모리 저장소도 s:{event:E}:prio에 우선 구매 보류가 남아 있으면 EXPIRY_PENDING이고, prio를 비우면 RETIRED다', async () => {
    const clock = fakeClock({ now: NOW });
    const store = new MemorySeatStore(clock);
    const eventId = randomUUID();
    await store.openSale({ eventId, seatCount: 10, keepUntilMs: NOW + DAY });
    const held = await store.holdPriority({ eventId, accountId: randomUUID(), grantId: randomUUID(), seat, expiresAtMs: NOW + 48 * HOUR, keepUntilMs: NOW + DAY });
    expect(held.kind).toBe('OK');

    // 릴레이가 Stream을 비운 뒤에도 보류는 남아 있다(만료 반복이 풀 때까지 회차를 빼면 안 된다)
    const ev = store.db.peek(eventId)!;
    ev.stream.length = 0;
    const saleEndMs = NOW - RETIRE_AFTER_SALE_END_MS - 1;
    expect(await store.retireEvent({ eventId, saleEndMs })).toBe('EXPIRY_PENDING');

    ev.prio.clear();
    expect(await store.retireEvent({ eventId, saleEndMs })).toBe('RETIRED');
  });

  test('S-T37 ⑨ 메모리 저장소도 결제 중(pin)인 홀드가 남아 있으면 EXPIRY_PENDING이다(Redis의 paused와 같은 뜻). pin을 지우면 RETIRED다', async () => {
    const clock = fakeClock({ now: NOW });
    const store = new MemorySeatStore(clock);
    const eventId = randomUUID();
    await store.openSale({ eventId, seatCount: 10, keepUntilMs: NOW + DAY });
    const accountId = randomUUID();
    const held = await store.hold({
      eventId,
      accountId,
      purchaseSessionId: 'ps-1',
      holdId: randomUUID(),
      idempotencyKey: randomUUID(),
      fingerprint: 'a'.repeat(64),
      seats: [seat],
      limit: 2,
      keepUntilMs: NOW + DAY,
    });
    expect(held.kind).toBe('OK');
    if (held.kind !== 'OK') return;
    expect((await store.pin({ eventId, accountId, purchaseSessionId: 'ps-1', holdId: held.holdId, seats: [seat], limit: 2, orderGen: 1, keepUntilMs: NOW + DAY })).kind).toBe('OK');

    const ev = store.db.peek(eventId)!;
    ev.stream.length = 0;
    const saleEndMs = NOW - RETIRE_AFTER_SALE_END_MS - 1;
    expect(await store.retireEvent({ eventId, saleEndMs })).toBe('EXPIRY_PENDING');

    delete ev.holds.get(seat.index)!.pin;
    expect(await store.retireEvent({ eventId, saleEndMs })).toBe('RETIRED');
  });
});
