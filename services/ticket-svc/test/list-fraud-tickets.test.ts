// F-04-13 조사 표 나열 gRPC 시험(동결 로컬, LCH-270·LCH-280, FX-T12).
// ticket.proto TicketService.ListFraudTickets: ops-svc만 회차·결제자로 표를 나열하고 보유자·입장 기록을 싣는다.
import { describe, expect, test } from 'vitest';
import { ticketServiceHandlers } from '../src/modules/ticket/inbound/ticket.grpc.js';

const EVENT = '0193f2c0-0000-7000-8000-0000000000e1';
const PAYER = '0193f2c0-0000-7000-8000-0000000000a1';
const HOLDER = '0193f2c0-0000-7000-8000-0000000000b2';
const TICKET = '0193f2c0-0000-7000-8000-000000000001';

const call = (handlers: Record<string, any>, request: Record<string, unknown>) =>
  new Promise<{ error: unknown; response?: any }>((resolve) => {
    const handler = handlers.ListFraudTickets;
    if (typeof handler !== 'function') {
      resolve({ error: new Error('ListFraudTickets 없음') });
      return;
    }
    handler({ request }, (error: unknown, response?: any) => resolve({ error, response }));
  });

describe('F-04-13 ListFraudTickets gRPC', () => {
  test('FX-T12 74 [ASVS v5.0.0-2.1.3] ListFraudTickets는 회차·결제자 표를 보유자·입장 기록과 함께 준다', async () => {
    const calls: any[] = [];
    const handlers = ticketServiceHandlers(
      {
        ticket: {
          listFraudTickets: async (i: any) => {
            calls.push(i);
            return [{ ticketId: TICKET, payerAccountId: PAYER, holderAccountId: HOLDER, status: 'ISSUED', entryRecorded: false }];
          },
        },
      } as any,
      () => undefined,
    ) as unknown as Record<string, any>;
    const out = await call(handlers, { event_id: EVENT, payer_account_ids: [PAYER] });
    expect(out.error).toBeNull();
    expect(calls[0]).toEqual({ eventId: EVENT, payerAccountIds: [PAYER] });
    expect(out.response.tickets).toEqual([{ ticket_id: TICKET, payer_account_id: PAYER, holder_account_id: HOLDER, status: 'TICKET_STATUS_ISSUED', entry_recorded: false }]);
  });

  test('FX-T12 75 ListFraudTickets는 회차나 결제자가 없으면 INVALID_ARGUMENT다', async () => {
    const handlers = ticketServiceHandlers({ ticket: {} } as any, () => undefined) as unknown as Record<string, any>;
    const out = await call(handlers, { event_id: '', payer_account_ids: [] });
    expect((out.error as { code?: number }).code).toBe(3);
  });
});
