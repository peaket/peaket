// gRPC 계약 시험(BUILD_ORDER HOT-160, BAT-050): TicketService의 IssueTickets·CancelTickets·ListTickets를
// 실제 grpc-js 서버에 올려 요청/응답 이름과 값이 proto와 같은지 본다(Docker 없이 localhost).
import * as grpc from '@grpc/grpc-js';
import { fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MemoryTicketStore } from '../src/modules/ticket/adapters/memory-ticket-store.js';
import { TicketService } from '../src/modules/ticket/application/ticket-service.js';
import { startGrpcServer } from '../src/grpc-server.js';
import { ticketPackage, ticketServiceHandlers } from '../src/modules/ticket/inbound/ticket.grpc.js';

const NOW = Date.parse('2026-11-13T03:00:00.000Z');
const ORDER = '0190f3a1-7c2e-7a00-8000-000000000001';
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000002';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000003';
const SEAT_A = '0190f3a1-7c2e-7a00-8000-000000000005';
const SEAT_B = '0190f3a1-7c2e-7a00-8000-000000000006';
const CANCEL = '0190f3a1-7c2e-7a00-8000-000000000007';

interface Client {
  IssueTickets(req: Record<string, unknown>, cb: (err: grpc.ServiceError | null, res: any) => void): void;
  CancelTickets(req: Record<string, unknown>, cb: (err: grpc.ServiceError | null, res: any) => void): void;
  ListTickets(req: Record<string, unknown>, cb: (err: grpc.ServiceError | null, res: any) => void): void;
}

let server: Awaited<ReturnType<typeof startGrpcServer>>;
let client: Client;
const errors: string[] = [];

beforeAll(async () => {
  const ticket = new TicketService({ store: new MemoryTicketStore(), clock: fakeClock({ now: NOW }) });
  server = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [{ definition: ticketPackage().TicketService.service, handlers: ticketServiceHandlers({ ticket, nowMs: () => NOW }, (method, err) => errors.push(`${method}:${String(err)}`)) }],
  });
  client = new (ticketPackage().TicketService)(`127.0.0.1:${server.port}`, grpc.credentials.createInsecure()) as unknown as Client;
});

afterAll(async () => {
  await server?.close();
});

const call = <T>(fn: (cb: (err: grpc.ServiceError | null, res: any) => void) => void): Promise<T> => new Promise((res, rej) => fn((err, r) => (err ? rej(err) : res(r as T))));

describe('TicketService gRPC [HOT-160] [P-T15]', () => {
  test('IssueTickets는 주문 단위로 멱등하고 첫 응답에만 ticket_key·qr_payload를 싣는다 [P-T15]', async () => {
    const req = { order_id: ORDER, event_id: EVENT, payer_account_id: ACCOUNT, seat_ids: [SEAT_A, SEAT_B], issue_generation: 0 };
    const first = await call<{ tickets: Array<Record<string, unknown>> }>((cb) => client.IssueTickets(req, cb));
    expect(first.tickets).toHaveLength(2);
    expect(first.tickets[0]).toMatchObject({ order_id: ORDER, event_id: EVENT, status: 'TICKET_STATUS_ISSUED' });
    expect(String(first.tickets[0]!.qr_payload)).toMatch(/^PEAKET1:/);
    expect(String(first.tickets[0]!.ticket_key)).not.toBe('');
    const second = await call<{ tickets: Array<Record<string, unknown>> }>((cb) => client.IssueTickets({ ...req, seat_ids: [SEAT_B, SEAT_A] }, cb));
    expect(second.tickets.map((t) => t.ticket_id)).toEqual(first.tickets.map((t) => t.ticket_id));
    expect(second.tickets.every((t) => t.ticket_key === '')).toBe(true);
  });

  test('ListTickets는 월렛 목록을 커서로 주고, CancelTickets는 취소표 결과를 돌려준다', async () => {
    const list = await call<{ tickets: Array<Record<string, unknown>>; next_cursor: string }>((cb) => client.ListTickets({ account_id: ACCOUNT, limit: 10 }, cb));
    expect(list.tickets).toHaveLength(2);
    expect(list.tickets[0]!.status).toBe('TICKET_STATUS_ISSUED');
    const ticketId = String(list.tickets[0]!.ticket_id);
    const out = await call<{ outcomes: Array<Record<string, unknown>> }>((cb) => client.CancelTickets({ order_id: ORDER, ticket_ids: [ticketId], requested_by_account_id: ACCOUNT, cancellation_id: CANCEL }, cb));
    expect(out.outcomes).toEqual([{ ticket_id: ticketId, result: 'CANCEL_TICKET_RESULT_REFUND_NOW' }]);
  });

  test('잘못된 UUID는 INVALID_ARGUMENT로 답하고, 처리기 오류 로그를 남긴다', async () => {
    await expect(call((cb) => client.ListTickets({ account_id: 'nope', limit: 10 }, cb))).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
    expect(errors.some((e) => e.startsWith('ListTickets:'))).toBe(true);
  });
});
