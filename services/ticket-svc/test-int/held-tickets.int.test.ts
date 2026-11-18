// ticket-svc ListHeldTickets 실제 PostgreSQL·실제 gRPC 서버 시험(BAT-600, V-T35 ①, ADR-0301 결정 1).
// 단언 값은 정본에서: 돌려주는 상태는 ISSUED·ACTIVE뿐, 입력은 둘 다 소문자 UUID(아니면 INVALID_ARGUMENT), 티켓 ID와 상태만 싣고 티켓 키·좌석은 싣지 않는다.
// 지금 보유자(양도 뒤 바뀐 account_id) 기준이다. 맨 아래에서 core-svc shop의 GrpcHeldTickets(부르는 쪽)가 이 서버를 실제 gRPC로 부르는 계약도 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { createDatabase, fakeClock, type Database } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateTicket } from '../scripts/migrate.mjs';
import { startGrpcServer } from '../src/grpc-server.js';
import { DrizzleTicketStore } from '../src/modules/ticket/adapters/db/drizzle-ticket-store.js';
import { TicketService } from '../src/modules/ticket/application/ticket-service.js';
import { ticketPackage, ticketServiceHandlers } from '../src/modules/ticket/inbound/ticket.grpc.js';
import { GrpcHeldTickets } from '../../core-svc/src/modules/shop/adapters/grpc-held-tickets.js';
import { HeldTicketsUnavailable } from '../../core-svc/src/modules/shop/domain/merch-ports.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const NOW = Date.parse('2026-11-18T03:00:00.000Z');
// 정본 ticket_status_check(0000_ticket.sql)의 값 가운데 ISSUED·ACTIVE를 뺀 나머지 전부(목록 밖 값마다 거절)
const NOT_HELD = ['TRANSFER_PENDING', 'CANCEL_REQUESTED', 'REFUNDED', 'FLAGGED', 'VOIDED'] as const;

let pg: PostgresContainer;
let database: Database;
let service: TicketService;
let server: Awaited<ReturnType<typeof startGrpcServer>>;
let client: { ListHeldTickets(req: Record<string, unknown>, cb: (err: grpc.ServiceError | null, res: any) => void): void; close(): void };
const errors: string[] = [];

const call = (req: Record<string, unknown>): Promise<{ tickets: Array<Record<string, unknown>> }> =>
  new Promise((res, rej) => client.ListHeldTickets(req, (err, r) => (err ? rej(err) : res(r))));

const issue = async (accountId: string, eventId: string, seats: number): Promise<string[]> => {
  const r = await service.issue({ orderId: randomUUID(), eventId, payerAccountId: accountId, seatIds: Array.from({ length: seats }, () => randomUUID()), issueGeneration: 0 });
  return r.tickets.map((t) => t.ticketId);
};
const setStatus = (ticketId: string, status: string) => database.pool.query('update ticket set status = $2 where id = $1', [ticketId, status]);

beforeAll(async () => {
  pg = await startPostgres();
  database = createDatabase({ url: pg.url, applicationName: 'ticket-svc-held-int', max: 8 });
  await migrateTicket(pg.url);
  const clock = fakeClock({ now: NOW });
  service = new TicketService({ store: new DrizzleTicketStore({ database }), clock });
  server = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [{ definition: ticketPackage().TicketService.service, handlers: ticketServiceHandlers({ ticket: service, nowMs: () => clock.now() }, (m, e) => errors.push(`${m}:${String(e)}`)) }],
  });
  client = new (ticketPackage().TicketService)(`127.0.0.1:${server.port}`, grpc.credentials.createInsecure()) as unknown as typeof client;
});

afterAll(async () => {
  client?.close();
  await server?.close();
  await database?.close();
  pg?.stop();
});

describe('ListHeldTickets [PostgreSQL·gRPC]', () => {
  test('V-T35 ① 그 계정·그 회차의 ISSUED·ACTIVE 티켓만 티켓 ID 차례로 ID와 상태만 돌려준다', async () => {
    const account = randomUUID();
    const event = randomUUID();
    const [issued, active, ...rest] = await issue(account, event, 2 + NOT_HELD.length);
    await setStatus(active!, 'ACTIVE');
    for (const [i, s] of NOT_HELD.entries()) await setStatus(rest[i]!, s);
    const r = await call({ account_id: account, event_id: event });
    const expected = [
      { ticket_id: issued!, status: 'TICKET_STATUS_ISSUED' },
      { ticket_id: active!, status: 'TICKET_STATUS_ACTIVE' },
    ].sort((a, b) => a.ticket_id.localeCompare(b.ticket_id));
    expect(r.tickets).toEqual(expected);
    // 티켓 키·좌석·QR은 싣지 않는다(HeldTicket 메시지는 ticket_id·status 둘뿐)
    for (const t of r.tickets) expect(Object.keys(t).sort()).toEqual(['status', 'ticket_id']);
  });

  test.each(NOT_HELD)('V-T35 ① 상태가 %s인 티켓만 가진 계정은 빈 목록이다', async (status) => {
    const account = randomUUID();
    const event = randomUUID();
    const [id] = await issue(account, event, 1);
    await setStatus(id!, status);
    expect((await call({ account_id: account, event_id: event })).tickets).toEqual([]);
  });

  test('V-T35 ① 다른 계정·다른 회차의 유효한 티켓은 0건이다', async () => {
    const account = randomUUID();
    const event = randomUUID();
    await issue(account, event, 1);
    const otherAccount = randomUUID();
    const otherEvent = randomUUID();
    await issue(otherAccount, otherEvent, 1);
    await issue(account, otherEvent, 1);
    await issue(otherAccount, event, 1);
    expect((await call({ account_id: account, event_id: event })).tickets).toHaveLength(1);
    expect((await call({ account_id: randomUUID(), event_id: event })).tickets).toEqual([]);
    expect((await call({ account_id: account, event_id: randomUUID() })).tickets).toEqual([]);
  });

  test('V-T35 ① 양도로 보유자가 바뀌면 새 보유자에게만 보이고 결제자(옛 보유자)에게는 0건이다', async () => {
    const payer = randomUUID();
    const holder = randomUUID();
    const event = randomUUID();
    const [id] = await issue(payer, event, 1);
    await database.pool.query('update ticket set account_id = $2 where id = $1', [id, holder]);
    expect((await call({ account_id: payer, event_id: event })).tickets).toEqual([]);
    expect((await call({ account_id: holder, event_id: event })).tickets).toEqual([{ ticket_id: id, status: 'TICKET_STATUS_ISSUED' }]);
  });

  test('V-T35 ① 계정·회차가 대문자 UUID이거나 비었거나 UUID가 아니면 INVALID_ARGUMENT다', async () => {
    const account = randomUUID();
    const event = randomUUID();
    await issue(account, event, 1);
    const bad = [
      { account_id: account.toUpperCase(), event_id: event },
      { account_id: account, event_id: event.toUpperCase() },
      { account_id: '', event_id: event },
      { account_id: account, event_id: '' },
      { account_id: 'not-a-uuid', event_id: event },
    ];
    for (const req of bad) {
      await expect(call(req)).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
    }
  });

  test('V-T35 ① core-svc GrpcHeldTickets가 실제 gRPC로 불러 유효한 티켓 ID만 받고, 서버가 멈추면 확인 못 함(HeldTicketsUnavailable)이다', async () => {
    const account = randomUUID();
    const event = randomUUID();
    const [a, b] = await issue(account, event, 2);
    await setStatus(b!, 'REFUNDED');
    const shop = new GrpcHeldTickets(`127.0.0.1:${server.port}`);
    try {
      expect(await shop.held(account, event)).toEqual([a]);
      expect(await shop.held(randomUUID(), event)).toEqual([]);
    } finally {
      shop.close();
    }
    // 멈춘 서버(아무도 듣지 않는 포트) → 없음([])이 아니라 확인 못 함
    const stopped = await startGrpcServer({ host: '127.0.0.1', port: 0, services: [{ definition: ticketPackage().TicketService.service, handlers: ticketServiceHandlers({ ticket: service, nowMs: () => NOW }, () => {}) }] });
    const port = stopped.port;
    await stopped.close();
    const down = new GrpcHeldTickets(`127.0.0.1:${port}`);
    try {
      await expect(down.held(account, event)).rejects.toBeInstanceOf(HeldTicketsUnavailable);
    } finally {
      down.close();
    }
  });
});
