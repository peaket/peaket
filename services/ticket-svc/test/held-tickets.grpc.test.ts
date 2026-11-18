// ListHeldTickets gRPC 처리기 시험(BAT-600, V-T35 ①, ADR-0301 결정 1). 메모리 저장소를 실제 grpc-js 서버에 올린다(Docker 없음).
// 정본: 그 계정이 지금 가진 그 회차의 ISSUED·ACTIVE 티켓의 ID·상태만, 소문자 UUID가 아니면 INVALID_ARGUMENT, 읽기만 한다.
import * as grpc from '@grpc/grpc-js';
import { fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MemoryTicketStore } from '../src/modules/ticket/adapters/memory-ticket-store.js';
import { TicketService } from '../src/modules/ticket/application/ticket-service.js';
import { startGrpcServer } from '../src/grpc-server.js';
import { ticketPackage, ticketServiceHandlers } from '../src/modules/ticket/inbound/ticket.grpc.js';

const NOW = Date.parse('2026-11-18T03:00:00.000Z');
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000000a1';
const EVENT = '0190f3a1-7c2e-7a00-8000-0000000000e1';
const OTHER_EVENT = '0190f3a1-7c2e-7a00-8000-0000000000e2';

let server: Awaited<ReturnType<typeof startGrpcServer>>;
let client: { ListHeldTickets(req: Record<string, unknown>, cb: (err: grpc.ServiceError | null, res: any) => void): void; close(): void };
let service: TicketService;
const errors: string[] = [];
const call = (req: Record<string, unknown>): Promise<{ tickets: Array<Record<string, unknown>> }> =>
  new Promise((res, rej) => client.ListHeldTickets(req, (err, r) => (err ? rej(err) : res(r))));

beforeAll(async () => {
  service = new TicketService({ store: new MemoryTicketStore(), clock: fakeClock({ now: NOW }) });
  server = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [{ definition: ticketPackage().TicketService.service, handlers: ticketServiceHandlers({ ticket: service, nowMs: () => NOW }, (m, e) => errors.push(`${m}:${String(e)}`)) }],
  });
  client = new (ticketPackage().TicketService)(`127.0.0.1:${server.port}`, grpc.credentials.createInsecure()) as unknown as typeof client;
});

afterAll(async () => {
  client?.close();
  await server?.close();
});

describe('ListHeldTickets gRPC [V-T35]', () => {
  test('V-T35 ① 발권한 티켓을 그 계정·그 회차로 읽고 다른 회차 티켓은 싣지 않는다', async () => {
    const issued = await service.issue({ orderId: randomUUID(), eventId: EVENT, payerAccountId: ACCOUNT, seatIds: [randomUUID(), randomUUID()], issueGeneration: 0 });
    await service.issue({ orderId: randomUUID(), eventId: OTHER_EVENT, payerAccountId: ACCOUNT, seatIds: [randomUUID()], issueGeneration: 0 });
    const r = await call({ account_id: ACCOUNT, event_id: EVENT });
    expect(r.tickets).toEqual(
      issued.tickets
        .map((t) => ({ ticket_id: t.ticketId, status: 'TICKET_STATUS_ISSUED' }))
        .sort((a, b) => a.ticket_id.localeCompare(b.ticket_id)),
    );
    expect((await call({ account_id: randomUUID(), event_id: EVENT })).tickets).toEqual([]);
  });

  test('V-T35 ① 대문자 UUID(계정·회차 각각)는 INVALID_ARGUMENT다', async () => {
    await expect(call({ account_id: ACCOUNT.toUpperCase(), event_id: EVENT })).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
    await expect(call({ account_id: ACCOUNT, event_id: EVENT.toUpperCase() })).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
  });
});
