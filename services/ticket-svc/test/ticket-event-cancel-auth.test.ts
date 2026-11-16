// BAT-420 리뷰 D4(시험 담당, 구현 전에 씀, 계획 §11 보충 3): 회차 취소 표 끝내기 EventCancelTickets와 입장 기록 대조 GetEntryRecords의 호출자 검사.
// 둘 다 purchase-svc 일괄 환불 실행기·마감 뒤 환급 실행기만 부른다. 내부 토큰을 둔 조립은 토큰과 호출자 머리 purchase-svc를 요구하고,
// 틀리면(토큰 없음·틀린 토큰·다른 호출자·머리 없음) PERMISSION_DENIED이며 저장소를 부르지 않는다(OperatorCancelTickets와 같은 규칙).
// 정본: docs/features/transfer-refund.md §3.1 ①·§5 ⑴, ticket.proto 두 RPC 주석, ASVS v5.0.0-8.2.1. 메모리 저장소 + 실제 grpc-js 서버(Docker 없음).
import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { fakeClock, INTERNAL_GRPC_CALLER_HEADER, INTERNAL_GRPC_TOKEN_HEADER } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startGrpcServer } from '../src/grpc-server.js';
import { MemoryTicketStore } from '../src/modules/ticket/adapters/memory-ticket-store.js';
import { TicketService } from '../src/modules/ticket/application/ticket-service.js';
import { ticketPackage, ticketServiceHandlers } from '../src/modules/ticket/inbound/ticket.grpc.js';

const NOW = Date.parse('2026-11-20T10:00:00.000Z');
const TOKEN = 'internal-grpc-token-ticket-d4';
const PAYER = randomUUID();
const EVENT = randomUUID();

type Reply = Record<string, unknown>;
type Method = 'EventCancelTickets' | 'GetEntryRecords';
type Client = grpc.Client & Record<Method, (req: Reply, md: grpc.Metadata, cb: (err: grpc.ServiceError | null, res: Reply) => void) => void>;
const call = (c: Client, method: Method, req: Reply, md = new grpc.Metadata()): Promise<Reply> => new Promise((resolve, reject) => c[method](req, md, (err, r) => (err ? reject(err) : resolve(r))));
const md = (o: { token?: string; caller?: string }): grpc.Metadata => {
  const m = new grpc.Metadata();
  if (o.token !== undefined) m.set(INTERNAL_GRPC_TOKEN_HEADER, o.token);
  if (o.caller !== undefined) m.set(INTERNAL_GRPC_CALLER_HEADER, o.caller);
  return m;
};

const store = new MemoryTicketStore();
const storeCalls = { eventCancel: 0, entryRecords: 0 };
const realEventCancel = store.eventCancel.bind(store);
const realEntryRecords = store.entryRecords.bind(store);
store.eventCancel = async (i) => (storeCalls.eventCancel++, realEventCancel(i));
store.entryRecords = async (ids) => (storeCalls.entryRecords++, realEntryRecords(ids));
const ticket = new TicketService({ store, clock: fakeClock({ now: NOW - 86_400_000 }) });
let open: Awaited<ReturnType<typeof startGrpcServer>>;
let guarded: Awaited<ReturnType<typeof startGrpcServer>>;
let openClient: Client;
let guardedClient: Client;

beforeAll(async () => {
  open = await startGrpcServer({ host: '127.0.0.1', port: 0, services: [{ definition: ticketPackage().TicketService.service, handlers: ticketServiceHandlers({ ticket, nowMs: () => NOW }, () => {}) }] });
  guarded = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [{ definition: ticketPackage().TicketService.service, handlers: ticketServiceHandlers({ ticket, nowMs: () => NOW }, () => {}, { internalToken: TOKEN }) }],
  });
  openClient = new (ticketPackage().TicketService)(`127.0.0.1:${open.port}`, grpc.credentials.createInsecure()) as unknown as Client;
  guardedClient = new (ticketPackage().TicketService)(`127.0.0.1:${guarded.port}`, grpc.credentials.createInsecure()) as unknown as Client;
});
afterAll(async () => {
  openClient?.close();
  guardedClient?.close();
  await open?.close();
  await guarded?.close();
});

const issued = async () => (await ticket.issue({ orderId: randomUUID(), eventId: EVENT, payerAccountId: PAYER, seatIds: [randomUUID()], issueGeneration: 0 })).tickets[0]!;
const cancelReq = (ticketId: string) => ({ cancellation_request_id: randomUUID(), event_id: EVENT, targets: [{ ticket_id: ticketId, cancellation_id: randomUUID() }] });
const BAD: [string, grpc.Metadata][] = [
  ['토큰 없음', md({ caller: 'purchase-svc' })],
  ['틀린 토큰', md({ token: 'wrong-token', caller: 'purchase-svc' })],
  ['호출자 ops-svc', md({ token: TOKEN, caller: 'ops-svc' })],
  ['호출자 머리 없음', md({ token: TOKEN })],
  ['머리 둘 다 없음', new grpc.Metadata()],
];

describe('GAT-110 R4 회차 취소·입장 기록 호출자 검사 [BAT-420 리뷰 D4]', () => {
  test('GAT-110 R4 [ASVS v5.0.0-8.2.1] EventCancelTickets는 호출자가 purchase-svc가 아니면 PERMISSION_DENIED이고 표·저장소를 건드리지 않는다', async () => {
    const t = await issued();
    const before = { ...store.tickets.get(t.ticketId)! };
    const calls = storeCalls.eventCancel;
    for (const [name, meta] of BAD) {
      await expect(call(guardedClient, 'EventCancelTickets', cancelReq(t.ticketId), meta), name).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });
    }
    expect(storeCalls.eventCancel).toBe(calls);
    expect(store.tickets.get(t.ticketId)).toEqual(before);
    // 맞는 토큰·호출자면 받는다
    const ok = await call(guardedClient, 'EventCancelTickets', cancelReq(t.ticketId), md({ token: TOKEN, caller: 'purchase-svc' }));
    expect((ok.outcomes as Reply[])[0]).toMatchObject({ ticket_id: t.ticketId, result: 'EVENT_CANCEL_RESULT_CANCELED' });
    expect(storeCalls.eventCancel).toBe(calls + 1);
    expect(store.tickets.get(t.ticketId)!.status).toBe('REFUNDED');
  });

  test('GAT-110 R4 [ASVS v5.0.0-8.2.1] GetEntryRecords는 호출자가 purchase-svc가 아니면 PERMISSION_DENIED이고 저장소를 부르지 않는다', async () => {
    const t = await issued();
    const calls = storeCalls.entryRecords;
    for (const [name, meta] of BAD) {
      await expect(call(guardedClient, 'GetEntryRecords', { ticket_ids: [t.ticketId] }, meta), name).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });
    }
    expect(storeCalls.entryRecords).toBe(calls);
    const ok = await call(guardedClient, 'GetEntryRecords', { ticket_ids: [t.ticketId] }, md({ token: TOKEN, caller: 'purchase-svc' }));
    expect((ok.records as Reply[])[0]).toMatchObject({ ticket_id: t.ticketId, found: true, entered: false });
    expect(storeCalls.entryRecords).toBe(calls + 1);
  });

  test('GAT-110 R4 토큰을 두지 않은 조립(local·ci)은 두 호출을 머리 없이 받는다', async () => {
    const t = await issued();
    expect(((await call(openClient, 'GetEntryRecords', { ticket_ids: [t.ticketId] })).records as Reply[])[0]).toMatchObject({ found: true });
    expect(((await call(openClient, 'EventCancelTickets', cancelReq(t.ticketId))).outcomes as Reply[])[0]).toMatchObject({ result: 'EVENT_CANCEL_RESULT_CANCELED' });
  });
});
