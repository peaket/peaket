// R-622 독립 계약 시험: 입장 시작 경계의 REFUND_AFTER_CLOSE(ticket-svc).
// offline-gate §7.3·payment.md의 취소 계약은 "입장 시작 전이면 REFUND_NOW, 시작 뒤면 REFUND_AFTER_CLOSE·VOIDED"다.
// 이 동작은 M5/C1 수정 전부터 있었으므로 수정 전 커밋 실패 대상은 아니고, 회귀 고정용이다.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemoryTicketStore } from '../src/modules/ticket/adapters/memory-ticket-store.js';
import { TicketService } from '../src/modules/ticket/application/ticket-service.js';

const NOW = Date.parse('2026-11-15T03:00:00.000Z');
const ORDER = '0190f3a1-7c2e-7a00-8000-000000000001';
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000002';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000003';
const SEAT = '0190f3a1-7c2e-7a00-8000-000000000005';
const CANCEL = '0190f3a1-7c2e-7a00-8000-000000000007';

function world() {
  const clock = fakeClock({ now: NOW });
  const store = new MemoryTicketStore();
  return { clock, store, service: new TicketService({ store, clock }) };
}

const issue = (eventStartsAtMs: number) => ({
  orderId: ORDER,
  eventId: EVENT,
  payerAccountId: ACCOUNT,
  seatIds: [SEAT],
  issueGeneration: 0,
  eventStartsAtMs,
});
const cancel = (ticketId: string) => ({ orderId: ORDER, ticketIds: [ticketId], requestedByAccountId: ACCOUNT, cancellationId: CANCEL, nowMs: NOW });

describe('R-622 REFUND_AFTER_CLOSE 경계', () => {
  test('입장 시작 1ms 전은 REFUND_NOW·REFUNDED, 정확히 시작 시각과 그 뒤는 REFUND_AFTER_CLOSE·VOIDED다', async () => {
    const before = world();
    const b = await before.service.issue(issue(NOW + 1));
    expect(await before.service.cancel(cancel(b.tickets[0]!.ticketId))).toEqual([{ ticketId: b.tickets[0]!.ticketId, result: 'REFUND_NOW' }]);
    expect(before.store.tickets.get(b.tickets[0]!.ticketId)).toMatchObject({ status: 'REFUNDED', keyRevokedAtMs: NOW });

    const at = world();
    const a = await at.service.issue(issue(NOW));
    expect(await at.service.cancel(cancel(a.tickets[0]!.ticketId))).toEqual([{ ticketId: a.tickets[0]!.ticketId, result: 'REFUND_AFTER_CLOSE' }]);
    expect(at.store.tickets.get(a.tickets[0]!.ticketId)).toMatchObject({ status: 'VOIDED', keyRevokedAtMs: NOW });

    const after = world();
    const c = await after.service.issue(issue(NOW - 1));
    expect(await after.service.cancel(cancel(c.tickets[0]!.ticketId))).toEqual([{ ticketId: c.tickets[0]!.ticketId, result: 'REFUND_AFTER_CLOSE' }]);
    expect(after.store.tickets.get(c.tickets[0]!.ticketId)!.status).toBe('VOIDED');
  });

  test('같은 cancellation_id 재시도는 같은 결과를 주고 취소표를 늘리지 않는다', async () => {
    const w = world();
    const r = await w.service.issue(issue(NOW - 1));
    const id = r.tickets[0]!.ticketId;
    expect(await w.service.cancel(cancel(id))).toEqual([{ ticketId: id, result: 'REFUND_AFTER_CLOSE' }]);
    expect(await w.service.cancel(cancel(id))).toEqual([{ ticketId: id, result: 'REFUND_AFTER_CLOSE' }]);
    expect(w.store.cancellations.size).toBe(1);
    expect(w.store.tickets.get(id)).toMatchObject({ status: 'VOIDED', version: 1 });
  });
});
