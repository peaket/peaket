// 티켓 발권·취소·월렛 목록 유스케이스 시험(BUILD_ORDER HOT-160, BAT-050, P-T15).
// 주문 단위 멱등 발권(같은 주문 두 번 → 티켓 0장 더), 취소표·키 폐기, 월렛 커서를 본다.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemoryTicketStore } from '../src/modules/ticket/adapters/memory-ticket-store.js';
import { TicketService } from '../src/modules/ticket/application/ticket-service.js';
import { TicketConflictError } from '../src/modules/ticket/domain/ticket.js';

const NOW = Date.parse('2026-11-13T03:00:00.000Z');
const ORDER = '0190f3a1-7c2e-7a00-8000-000000000001';
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000002';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000003';
const OTHER = '0190f3a1-7c2e-7a00-8000-000000000004';
const SEAT_A = '0190f3a1-7c2e-7a00-8000-000000000005';
const SEAT_B = '0190f3a1-7c2e-7a00-8000-000000000006';
const CANCEL = '0190f3a1-7c2e-7a00-8000-000000000007';
const CANCEL_2 = '0190f3a1-7c2e-7a00-8000-000000000008';

function world() {
  const clock = fakeClock({ now: NOW });
  const store = new MemoryTicketStore();
  return { clock, store, service: new TicketService({ store, clock }) };
}

const issue = (over: Partial<Parameters<TicketService['issue']>[0]> = {}) => ({ orderId: ORDER, eventId: EVENT, payerAccountId: ACCOUNT, seatIds: [SEAT_A, SEAT_B], issueGeneration: 0, ...over });
const cancel = (over: Partial<Parameters<TicketService['cancel']>[0]> = {}) => ({ orderId: ORDER, ticketIds: [], requestedByAccountId: ACCOUNT, cancellationId: CANCEL, nowMs: NOW, ...over });

describe('TicketService [HOT-160] [P-T15]', () => {
  test('같은 주문·세대를 두 번 발권하면 티켓은 한 번만 만들고, 재요청에는 키를 다시 싣지 않는다 [P-T15]', async () => {
    const w = world();
    const first = await w.service.issue(issue());
    expect(first.replayed).toBe(false);
    expect(first.tickets).toHaveLength(2);
    expect(first.tickets.every((t) => t.status === 'ISSUED' && t.qrPayload.startsWith('PEAKET1:') && t.ticketKey)).toBe(true);
    const second = await w.service.issue(issue({ seatIds: [SEAT_B, SEAT_A] }));
    expect(second.replayed).toBe(true);
    expect(second.tickets.map((t) => t.ticketId)).toEqual(first.tickets.map((t) => t.ticketId));
    expect(second.tickets.every((t) => t.ticketKey === undefined)).toBe(true);
    expect(w.store.tickets.size).toBe(2);
  });

  test('같은 주문·세대에 다른 좌석을 보내면 FAILED_PRECONDITION으로 거절하고 새 티켓을 만들지 않는다', async () => {
    const w = world();
    await w.service.issue(issue());
    await expect(w.service.issue(issue({ seatIds: [SEAT_A] }))).rejects.toBeInstanceOf(TicketConflictError);
    expect(w.store.tickets.size).toBe(2);
  });

  test('같은 주문이라도 발권 세대가 다르면 새 티켓을 만든다(입금 오류 뒤 재발권 자리)', async () => {
    const w = world();
    const first = await w.service.issue(issue());
    const second = await w.service.issue(issue({ issueGeneration: 1 }));
    expect(second.replayed).toBe(false);
    expect(second.tickets.map((t) => t.ticketId)).not.toEqual(first.tickets.map((t) => t.ticketId));
    expect(w.store.tickets.size).toBe(4);
  });

  test('결제자=보유자가 입장 전에 취소하면 REFUND_NOW·키 폐기·취소표를 남기고, 같은 cancellation_id는 같은 결과다', async () => {
    const w = world();
    const { tickets } = await w.service.issue(issue());
    const id = tickets[0]!.ticketId;
    const out = await w.service.cancel(cancel({ ticketIds: [id] }));
    expect(out).toEqual([{ ticketId: id, result: 'REFUND_NOW' }]);
    expect(w.store.tickets.get(id)).toMatchObject({ status: 'REFUNDED', keyRevokedAtMs: NOW, version: 1 });
    expect(w.store.cancellations.size).toBe(1);
    expect(await w.service.cancel(cancel({ ticketIds: [id] }))).toEqual([{ ticketId: id, result: 'REFUND_NOW' }]);
    expect(await w.service.cancel(cancel({ ticketIds: [id], cancellationId: CANCEL_2 }))).toEqual([{ ticketId: id, result: 'ALREADY_CANCELLED' }]);
  });

  test('요청자가 결제자·보유자가 아니면 NOT_PAYER_HOLDER이고, 양도 요청이 있으면 TRANSFER_PENDING이다', async () => {
    const w = world();
    const { tickets } = await w.service.issue(issue());
    const id = tickets[0]!.ticketId;
    expect(await w.service.cancel(cancel({ ticketIds: [id], requestedByAccountId: OTHER }))).toEqual([{ ticketId: id, result: 'NOT_PAYER_HOLDER' }]);
    w.store.tickets.set(id, { ...w.store.tickets.get(id)!, transferPending: true });
    expect(await w.service.cancel(cancel({ ticketIds: [id], cancellationId: CANCEL_2 }))).toEqual([{ ticketId: id, result: 'TRANSFER_PENDING' }]);
    expect(w.store.tickets.get(id)!.status).toBe('ISSUED');
  });

  test('티켓 상태가 TRANSFER_PENDING이어도 취소를 거절한다(양도 모듈이 상태를 먼저 바꾼 경우)', async () => {
    const w = world();
    const { tickets } = await w.service.issue(issue());
    const id = tickets[0]!.ticketId;
    w.store.tickets.set(id, { ...w.store.tickets.get(id)!, status: 'TRANSFER_PENDING' });
    expect(await w.service.cancel(cancel({ ticketIds: [id] }))).toEqual([{ ticketId: id, result: 'TRANSFER_PENDING' }]);
  });

  test('입장이 시작된 뒤 취소하면 REFUND_AFTER_CLOSE·VOIDED로 두고, 다른 주문의 티켓은 건드리지 않는다', async () => {
    const w = world();
    const { tickets } = await w.service.issue(issue({ eventStartsAtMs: NOW - 1 }));
    const id = tickets[0]!.ticketId;
    expect(await w.service.cancel(cancel({ ticketIds: [id] }))).toEqual([{ ticketId: id, result: 'REFUND_AFTER_CLOSE' }]);
    expect(w.store.tickets.get(id)!.status).toBe('VOIDED');
    expect(await w.service.cancel(cancel({ orderId: '0190f3a1-7c2e-7a00-8000-000000000099', ticketIds: [tickets[1]!.ticketId] }))).toEqual([{ ticketId: tickets[1]!.ticketId, result: 'NOT_PAYER_HOLDER' }]);
  });

  test('월렛 목록은 그 계정 티켓만 최신순으로 주고 커서로 나눈다', async () => {
    const w = world();
    const first = await w.service.issue(issue({ seatIds: [SEAT_A] }));
    w.clock.advance(1000);
    const second = await w.service.issue(issue({ orderId: '0190f3a1-7c2e-7a00-8000-000000000010', seatIds: [SEAT_B] }));
    await w.service.issue(issue({ orderId: '0190f3a1-7c2e-7a00-8000-000000000011', payerAccountId: OTHER, seatIds: [SEAT_A] }));
    const page1 = await w.service.list({ accountId: ACCOUNT, limit: 1 });
    expect(page1.tickets.map((t) => t.ticketId)).toEqual([second.tickets[0]!.ticketId]);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await w.service.list({ accountId: ACCOUNT, limit: 1, cursor: page1.nextCursor });
    expect(page2.tickets.map((t) => t.ticketId)).toEqual([first.tickets[0]!.ticketId]);
    expect(page2.nextCursor).toBeUndefined();
    expect((await w.service.list({ accountId: ACCOUNT, limit: 10 })).tickets).toHaveLength(2);
  });
});
