// F-06-3 예외 환불 실행의 purchase-svc 내부 HTTP 시험(시험 담당, 2026-11-26).
// 정본: docs/features/transfer-refund.md §3.2·§7.2·§11 R-T26, POL-038 ①②⑧, docs/data.md approval_refund·order_cancellation,
// docs/api/openapi.yaml ApprovalRequest.kind. 값은 정본에서 가져오고 코드 상수와 같게 고르지 않는다.
import 'reflect-metadata';
import { createService } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryPurchaseSessions } from '../src/modules/inventory/index.js';
import {
  type CancellationOrderView,
  type CancellationRecord,
  type CancellationWrites,
  type PaymentCancelOutcome,
  type TicketCancelAnswer,
  type TicketCancellations,
  type PaymentCancellations,
  WeekendBusinessCalendar,
} from '../src/modules/refund/index.js';

const NOW = Date.parse('2026-11-26T10:00:00+09:00');
const TOKEN = 'internal-http-token-f063';
let wall = NOW;
const clock = { now: () => wall, monotonicMs: () => wall, advance: (ms: number) => { wall += ms; } };
const PAYER = randomUUID();
const ORDER = randomUUID();
const TICKET = randomUUID();
const PRICE = 33_333;
const APPROVAL = randomUUID();

type OrderStore = {
  findByTicket(ticketId: string): Promise<CancellationOrderView | undefined>;
  findCancellation(cancellationId: string): Promise<CancellationRecord | undefined>;
  byOrder(orderId: string): Promise<CancellationOrderView[]>;
};
const viewOf = (o: { orderId?: string; ticketId?: string; price?: number; status?: string; entryOpensAtMs?: number; entryRecorded?: boolean } = {}): CancellationOrderView => ({
  orderId: o.orderId ?? ORDER,
  eventId: randomUUID(),
  ticketId: o.ticketId ?? TICKET,
  seatId: randomUUID(),
  payerAccountId: PAYER,
  ticketPrice: o.price ?? PRICE,
  bookedAtMs: Date.parse('2026-11-01T10:00:00+09:00'),
  saleEndsAtMs: Date.parse('2026-11-30T19:00:00+09:00'),
  entryOpensAtMs: o.entryOpensAtMs ?? Date.parse('2026-12-01T18:00:00+09:00'),
  orderStatus: o.status ?? 'CONFIRMED',
});

const state = {
  views: new Map<string, CancellationOrderView>(),
  entryRecorded: false,
  ticketCalls: [] as unknown[],
  paymentCalls: [] as { cancellationId: string; amount: number; reason: string }[],
  created: [] as Record<string, unknown>[],
  records: new Map<string, CancellationRecord>(),
  ticketAnswer: 'REFUND_NOW' as TicketCancelAnswer,
  paymentAnswer: 'CANCELLED' as PaymentCancelOutcome,
};

const orders: OrderStore = {
  async findByTicket(ticketId) {
    const v = state.views.get(TICKET);
    return v && v.ticketId === ticketId ? v : undefined;
  },
  async findCancellation(cancellationId) {
    return state.records.get(cancellationId);
  },
  async byOrder(orderId) {
    return [...state.views.values()].filter((v) => v.orderId === orderId);
  },
};
const writes: CancellationWrites = {
  create: async (q) => {
    state.created.push({ ...q });
    state.records.set(q.cancellationId, { cancellationId: q.cancellationId, orderId: q.orderId, ticketId: q.ticketId, refundAmount: q.refundAmount, state: q.status, refundAttempts: 0 });
    return { status: 'CREATED' };
  },
  updateStatus: async (q) => {
    const r = state.records.get(q.cancellationId);
    if (r) state.records.set(q.cancellationId, { ...r, state: q.status });
  },
  scheduleRefundRetry: async () => {},
  markRefundFailed: async () => {},
  markRefundAccountRequired: async () => {},
  dueRefunds: async () => [],
};
const tickets: TicketCancellations = {
  async cancel(q) {
    state.ticketCalls.push({ ...q });
    return state.ticketAnswer;
  },
};
const payments: PaymentCancellations = {
  async cancel(q) {
    state.paymentCalls.push({ cancellationId: q.cancellationId, amount: q.amount, reason: q.reason });
    return state.paymentAnswer;
  },
};
const entryRecords = {
  async hasEntry(ticketId: string) {
    return state.entryRecorded && ticketId === TICKET;
  },
};

let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  const sessions = new MemoryPurchaseSessions();
  svc = await createService({
    name: 'purchase-svc',
    module: AppModule.register({
      memory: true,
      sessions,
      refund: { orders, writes, tickets, payments, calendar: new WeekendBusinessCalendar(), entryRecords } as never,
    }),
    purchaseSessions: sessions,
    env: { PEAKET_ENV: 'ci', PEAKET_INTERNAL_TOKEN: TOKEN },
    clock,
    logDestination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
});
afterAll(async () => {
  await svc?.close();
});
beforeEach(() => {
  state.views.clear();
  state.views.set(TICKET, viewOf());
  state.entryRecorded = false;
  state.ticketCalls.length = 0;
  state.paymentCalls.length = 0;
  state.created.length = 0;
  state.records.clear();
  state.ticketAnswer = 'REFUND_NOW';
  state.paymentAnswer = 'CANCELLED';
  wall = NOW;
});

const post = (body: Record<string, unknown>, approvalId = APPROVAL, headers: Record<string, string> = {}) =>
  svc.http.inject({
    method: 'POST',
    url: `/internal/v1/approval-refunds/${approvalId}`,
    headers: { 'content-type': 'application/json', 'x-peaket-internal-token': TOKEN, 'x-peaket-caller': 'ops-svc', ...headers },
    payload: JSON.stringify(body),
  });
const full = (kind: string, extra: Record<string, unknown> = {}) => ({ kind, orderId: ORDER, amount: PRICE, reasonText: '승인된 예외 환불', ...extra });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;

describe('R-T26 ① 시스템 잘못이 확인된 환불', () => {
  test('R-T26 ① SYSTEM_FAULT_REFUND는 [ASVS v5.0.0-2.3.3] EXCEPTION 사유·공제 0원으로 티켓을 취소하고 전액 환급한다', async () => {
    const r = await post(full('SYSTEM_FAULT_REFUND'));
    expect(r.statusCode).toBe(200);
    expect(json(r)).toMatchObject({ status: 'REFUNDED', refundAmount: PRICE });
    expect(state.ticketCalls).toHaveLength(1);
    expect(state.ticketCalls[0]).toMatchObject({ orderId: ORDER, ticketIds: [TICKET], reason: 'EXCEPTION' });
    expect(state.created).toHaveLength(1);
    expect(state.created[0]).toMatchObject({ orderId: ORDER, ticketId: TICKET, reason: 'EXCEPTION', deductionAmount: 0, refundAmount: PRICE, approvalId: APPROVAL });
  });

  test('R-T26 ① 같은 승인 ID로 [ASVS v5.0.0-2.3.4] 다시 보내면 같은 취소 ID·결과를 주고 티켓을 다시 부르지 않는다', async () => {
    const a = json(await post(full('SYSTEM_FAULT_REFUND')));
    const b = await post(full('SYSTEM_FAULT_REFUND'));
    expect(b.statusCode).toBe(200);
    expect(json(b)).toEqual(a);
    expect(state.ticketCalls).toHaveLength(1);
    expect(state.created).toHaveLength(1);
  });

  test('같은 승인 ID에 다른 본문이 오면 [ASVS v5.0.0-2.3.4] 409 approval-refund-conflict이고 쓰기가 0이다', async () => {
    await post(full('SYSTEM_FAULT_REFUND'));
    const r = await post(full('SYSTEM_FAULT_REFUND', { amount: PRICE - 1 }));
    expect(r.statusCode).toBe(409);
    expect(json(r)).toMatchObject({ type: expect.stringContaining('approval-refund-conflict') });
    expect(state.ticketCalls).toHaveLength(1);
    expect(state.created).toHaveLength(1);
  });

  test('승인 금액이 권면 전액과 다르면 [ASVS v5.0.0-2.2.1] 422 approval-refund-amount-mismatch이고 쓰기가 0이다', async () => {
    const r = await post(full('SYSTEM_FAULT_REFUND', { amount: PRICE - 1 }));
    expect(r.statusCode).toBe(422);
    expect(json(r)).toMatchObject({ type: expect.stringContaining('approval-refund-amount-mismatch') });
    expect(state.ticketCalls).toHaveLength(0);
    expect(state.created).toHaveLength(0);
  });

  test('주문을 찾을 수 없으면 404 not-found이고 쓰기가 0이다', async () => {
    const r = await post(full('SYSTEM_FAULT_REFUND', { orderId: randomUUID() }));
    expect(r.statusCode).toBe(404);
    expect(json(r)).toMatchObject({ type: expect.stringContaining('not-found') });
    expect(state.ticketCalls).toHaveLength(0);
    expect(state.created).toHaveLength(0);
  });

  test('이미 환급된 주문은 409이고 쓰기가 0이다', async () => {
    state.views.set(TICKET, viewOf({ status: 'REFUNDED' }));
    const r = await post(full('SYSTEM_FAULT_REFUND'));
    expect(r.statusCode).toBe(409);
    expect(state.ticketCalls).toHaveLength(0);
    expect(state.created).toHaveLength(0);
  });

  test('내부 토큰이 없거나 틀리면 [ASVS v5.0.0-8.3.1] 403이고, 호출자가 ops-svc가 아니면 403이며 쓰기가 0이다', async () => {
    const noToken = await svc.http.inject({ method: 'POST', url: `/internal/v1/approval-refunds/${APPROVAL}`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(full('SYSTEM_FAULT_REFUND')) });
    expect(noToken.statusCode).toBe(403);
    const wrongCaller = await post(full('SYSTEM_FAULT_REFUND'), APPROVAL, { 'x-peaket-caller': 'purchase-svc' });
    expect(wrongCaller.statusCode).toBe(403);
    expect(state.ticketCalls).toHaveLength(0);
    expect(state.created).toHaveLength(0);
  });

  test('IR-21 orderIds로 여러 주문을 한 승인에서 환급한다', async () => {
    const OTHER_ORDER = randomUUID();
    const OTHER_TICKET = randomUUID();
    state.views.set(OTHER_TICKET, viewOf({ orderId: OTHER_ORDER, ticketId: OTHER_TICKET, price: 12_000 }));
    const r = await post(full('SYSTEM_FAULT_REFUND', { orderIds: [OTHER_ORDER], amount: PRICE + 12_000 }));
    expect(r.statusCode).toBe(200);
    expect(json(r)).toMatchObject({ status: 'REFUNDED', refundAmount: PRICE + 12_000 });
    expect(state.ticketCalls.map((c) => (c as { orderId: string }).orderId)).toEqual([ORDER, OTHER_ORDER]);
    expect(state.paymentCalls.map((c) => c.amount)).toEqual([PRICE, 12_000]);
    expect(state.created.map((c) => c['orderId'])).toEqual([ORDER, OTHER_ORDER]);
  });

  test('IR-30 취소 행 무효 경로는 ops-svc만 부르고 행을 VOIDED로 끝낸다', async () => {
    const CANCELLATION = randomUUID();
    state.records.set(CANCELLATION, { cancellationId: CANCELLATION, orderId: ORDER, ticketId: TICKET, refundAmount: PRICE, state: 'REQUESTED', refundAttempts: 0 });
    const r = await svc.http.inject({
      method: 'POST',
      url: `/internal/v1/cancellations/${CANCELLATION}/void`,
      headers: { 'content-type': 'application/json', 'x-peaket-internal-token': TOKEN, 'x-peaket-caller': 'ops-svc' },
      payload: JSON.stringify({}),
    });
    expect(r.statusCode).toBe(200);
    expect(json(r)).toEqual({ voided: true });
    expect(state.records.get(CANCELLATION)?.state).toBe('VOIDED');
    const wrong = await svc.http.inject({
      method: 'POST',
      url: `/internal/v1/cancellations/${CANCELLATION}/void`,
      headers: { 'content-type': 'application/json', 'x-peaket-internal-token': TOKEN, 'x-peaket-caller': 'purchase-svc' },
      payload: JSON.stringify({}),
    });
    expect(wrong.statusCode).toBe(403);
  });
});

describe('R-T26 ② 재량 면제분만 추가 환급', () => {
  test('R-T26 ② DISCRETIONARY_WAIVER는 티켓을 취소하지 않고 면제분만 결제사 부분 취소로 환급한다', async () => {
    const r = await post({ kind: 'DISCRETIONARY_WAIVER', orderId: ORDER, amount: 30_000, reasonText: '진단서 확인' });
    expect(r.statusCode).toBe(200);
    expect(json(r)).toMatchObject({ status: 'REFUNDED', refundAmount: 30_000 });
    expect(state.ticketCalls).toHaveLength(0);
    expect(state.paymentCalls).toHaveLength(1);
    expect(state.paymentCalls[0]).toMatchObject({ amount: 30_000, reason: 'EXCEPTION' });
    expect(state.created).toHaveLength(1);
    expect(state.created[0]).toMatchObject({ kind: 'DISCRETIONARY_WAIVER', deductionAmount: 0, refundAmount: 30_000 });
  });

  test('R-T26 ② 면제분이 권면 전액을 넘으면 422이고 결제사를 부르지 않는다', async () => {
    const r = await post({ kind: 'DISCRETIONARY_WAIVER', orderId: ORDER, amount: PRICE + 1, reasonText: '너무 큼' });
    expect(r.statusCode).toBe(422);
    expect(state.paymentCalls).toHaveLength(0);
  });

  test('R-T26 ② 결제사가 결과를 모르면 REFUND_PENDING이고 같은 승인 재호출은 payment를 다시 부르지 않는다', async () => {
    state.paymentAnswer = 'UNKNOWN';
    const a = await post({ kind: 'DISCRETIONARY_WAIVER', orderId: ORDER, amount: 30_000, reasonText: '진단서 확인' });
    expect(a.statusCode).toBe(200);
    expect(json(a)).toMatchObject({ status: 'REFUND_PENDING' });
    expect(state.paymentCalls).toHaveLength(1);
    const b = await post({ kind: 'DISCRETIONARY_WAIVER', orderId: ORDER, amount: 30_000, reasonText: '진단서 확인' });
    expect(b.statusCode).toBe(200);
    expect(json(b)).toMatchObject({ status: 'REFUND_PENDING' });
    expect(state.paymentCalls).toHaveLength(1);
  });
});

describe('R-T26 ③ 미성년자 계약 취소', () => {
  test('R-T26 ③ MINOR_CONTRACT_CANCEL은 MINOR_CONTRACT_CANCEL 사유·공제 0원으로 전액 환급하고 좌석을 돌린다', async () => {
    const r = await post(full('MINOR_CONTRACT_CANCEL'));
    expect(r.statusCode).toBe(200);
    expect(json(r)).toMatchObject({ status: 'REFUNDED', refundAmount: PRICE });
    expect(state.ticketCalls).toHaveLength(1);
    expect(state.ticketCalls[0]).toMatchObject({ reason: 'MINOR_CONTRACT_CANCEL' });
    expect(state.created[0]).toMatchObject({ reason: 'MINOR_CONTRACT_CANCEL', deductionAmount: 0, refundAmount: PRICE });
  });

  test('R-T26 ③ 입장 시작·입장 기록이 있으면 409 minor-contract-entry-started이고 쓰기가 0이다', async () => {
    state.entryRecorded = true;
    const r = await post(full('MINOR_CONTRACT_CANCEL'));
    expect(r.statusCode).toBe(409);
    expect(json(r)).toMatchObject({ type: expect.stringContaining('minor-contract-entry-started') });
    expect(state.ticketCalls).toHaveLength(0);
    expect(state.created).toHaveLength(0);
  });

  test('R-T26 ③ 응답에 생년월일·연계정보·계좌 원문이 없다 [ASVS v5.0.0-16.3.2]', async () => {
    const r = await post(full('MINOR_CONTRACT_CANCEL'));
    expect(r.statusCode).toBe(200);
    expect(r.payload).not.toMatch(/birth|resident|accountNumber|CI|연계정보|생년월일/);
  });

  test('R-T26 ③ 입장 시작 시각이 지났으면 409 minor-contract-entry-started이고 쓰기가 0이다 [ASVS v5.0.0-8.2.2]', async () => {
    state.views.set(TICKET, viewOf({ entryOpensAtMs: NOW - 1 }));
    const r = await post(full('MINOR_CONTRACT_CANCEL'));
    expect(r.statusCode).toBe(409);
    expect(json(r)).toMatchObject({ type: expect.stringContaining('minor-contract-entry-started') });
    expect(state.ticketCalls).toHaveLength(0);
    expect(state.created).toHaveLength(0);
  });

  test('R-T26 ① 시스템 잘못 환불이 입장 시작 뒤면 지금 환급하지 않고 REQUESTED로 두어 마감 뒤 실행기가 맡는다 [ASVS v5.0.0-2.3.3]', async () => {
    state.views.set(TICKET, viewOf({ entryOpensAtMs: NOW - 1 }));
    const r = await post(full('SYSTEM_FAULT_REFUND'));
    expect(r.statusCode).toBe(200);
    expect(json(r)).toMatchObject({ status: 'REQUESTED' });
    expect(state.paymentCalls).toHaveLength(0);
    expect(state.created[0]).toMatchObject({ reason: 'EXCEPTION', status: 'REQUESTED', deductionAmount: 0, refundAmount: PRICE });
  });
});
