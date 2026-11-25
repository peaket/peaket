// F-04-13 조사 표 나열 gRPC·제품 필터 시험(동결 로컬, LCH-270·LCH-280, FX-T12).
// ticket.proto TicketService.ListFraudTickets: ops-svc만 회차·결제자로 표를 나열하고 보유자·입장 기록을 싣는다.
import { INTERNAL_GRPC_CALLER_HEADER, INTERNAL_GRPC_TOKEN_HEADER, fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemoryTicketStore } from '../src/modules/ticket/adapters/memory-ticket-store.js';
import { TicketService } from '../src/modules/ticket/application/ticket-service.js';
import { ticketServiceHandlers } from '../src/modules/ticket/inbound/ticket.grpc.js';
import type { TicketRecord } from '../src/modules/ticket/domain/ticket.js';

const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const EVENT_A = '0193f2c0-0000-7000-8000-0000000000e1';
const EVENT_B = '0193f2c0-0000-7000-8000-0000000000e2';
const PAYER = '0193f2c0-0000-7000-8000-0000000000a1';
const OTHER = '0193f2c0-0000-7000-8000-0000000000a2';
const HOLDER = '0193f2c0-0000-7000-8000-0000000000b2';
const TOKEN = 'f0413-grpc-token';

const ticket = (n: number, o: Partial<TicketRecord> = {}): TicketRecord => ({
  ticketId: `0193f2c0-0000-7000-8000-${String(n).padStart(12, '0')}`,
  accountId: PAYER,
  payerAccountId: PAYER,
  orderId: `0193f2c0-0000-7001-8000-${String(n).padStart(12, '0')}`,
  eventId: EVENT_A,
  seatId: `0193f2c0-0000-7002-8000-${String(n).padStart(12, '0')}`,
  gateZone: '',
  status: 'ACTIVE',
  issueGeneration: 0,
  qrPayload: `PEAKET1:${n}`,
  keyHash: 'a'.repeat(64),
  transferPending: false,
  version: 0,
  issuedAtMs: NOW - HOUR,
  eventStartsAtMs: NOW + 72 * HOUR,
  ...o,
});

const setup = () => {
  const store = new MemoryTicketStore();
  const t1 = ticket(1);
  const t2 = ticket(2, { accountId: HOLDER });
  const t3 = ticket(3, { payerAccountId: OTHER });
  const t4 = ticket(4, { eventId: EVENT_B });
  for (const t of [t1, t2, t3, t4]) store.tickets.set(t.ticketId, t);
  store.entries.add(t2.ticketId);
  const service = new TicketService({ store, clock: fakeClock({ now: NOW }) });
  return { store, service, t1, t2, t3, t4 };
};

const md = (o: { token?: string; caller?: string }) => {
  const values = new Map<string, string>();
  if (o.token !== undefined) values.set(INTERNAL_GRPC_TOKEN_HEADER, o.token);
  if (o.caller !== undefined) values.set(INTERNAL_GRPC_CALLER_HEADER, o.caller);
  return { get: (k: string) => (values.has(k) ? [values.get(k)!] : []) };
};

const call = (handlers: Record<string, any>, request: Record<string, unknown>, metadata: any = md({})) =>
  new Promise<{ error: any; response?: any }>((resolve) => {
    const handler = handlers.ListFraudTickets;
    if (typeof handler !== 'function') {
      resolve({ error: new Error('ListFraudTickets 없음') });
      return;
    }
    handler({ request, metadata }, (error: unknown, response?: any) => resolve({ error, response }));
  });

describe('F-04-13 ListFraudTickets', () => {
  test('FX-T12 74 [ASVS v5.0.0-2.1.3] 실제 TicketService는 회차·결제자로 거르고 보유자·입장 기록을 싣는다', async () => {
    const { service, t1, t2 } = setup();
    const list = (service as unknown as { listFraudTickets(i: any): Promise<any[]> }).listFraudTickets;
    expect(list).toBeTypeOf('function');
    const rows = await list.call(service, { eventId: EVENT_A, payerAccountIds: [PAYER] });
    expect(rows).toEqual([
      { ticketId: t1.ticketId, payerAccountId: PAYER, holderAccountId: PAYER, status: 'ACTIVE', entryRecorded: false },
      { ticketId: t2.ticketId, payerAccountId: PAYER, holderAccountId: HOLDER, status: 'ACTIVE', entryRecorded: true },
    ]);
  });

  test('FX-T12 75 [ASVS v5.0.0-8.2.1] ListFraudTickets gRPC는 ops-svc 내부 토큰·호출자만 받는다', async () => {
    const { service } = setup();
    const handlers = ticketServiceHandlers({ ticket: service } as any, () => undefined, { internalToken: TOKEN }) as unknown as Record<string, any>;
    const req = { event_id: EVENT_A, payer_account_ids: [PAYER] };
    for (const metadata of [md({}), md({ token: 'wrong', caller: 'ops-svc' }), md({ token: TOKEN, caller: 'purchase-svc' })]) {
      const out = await call(handlers, req, metadata);
      expect((out.error as { code?: number }).code).toBe(7);
    }
    const ok = await call(handlers, req, md({ token: TOKEN, caller: 'ops-svc' }));
    expect(ok.error).toBeNull();
    expect(ok.response.tickets).toHaveLength(2);
  });

  test('FX-T12 76 ListFraudTickets는 회차나 결제자가 없으면 INVALID_ARGUMENT다', async () => {
    const { service } = setup();
    const handlers = ticketServiceHandlers({ ticket: service } as any, () => undefined) as unknown as Record<string, any>;
    const out = await call(handlers, { event_id: '', payer_account_ids: [] });
    expect((out.error as { code?: number }).code).toBe(3);
  });
});
