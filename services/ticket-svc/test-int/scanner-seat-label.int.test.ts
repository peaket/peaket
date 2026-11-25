// F-05-12 O-T2 ② 실제 PostgreSQL·gRPC 좌석 이름: 발권 요청의 seat_labels를 ticket.seat_label에 저장하고
// 스캐너 회차 목록·이상 표시가 coalesce(seat_label, seat_id)를 준다. 이름 없는 옛 행은 seatId로 물러난다.
// 정본: docs/features/offline-gate.md §9.1 '좌석 이름', docs/data.md ticket.seat_label, docs/api/proto ticket.proto IssueTicketsRequest.seat_labels,
//       openapi ScannerPackageTicket·GateFlag, docs/review/plans/F-05-12.md §3 결정 5.
import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { createDatabase, fakeClock, type Database } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateTicket } from '../scripts/migrate.mjs';
import { startGrpcServer } from '../src/grpc-server.js';
import { DrizzleScannerGateStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-gate-store.js';
import { DrizzleTicketStore } from '../src/modules/ticket/adapters/db/drizzle-ticket-store.js';
import { TicketService } from '../src/modules/ticket/application/ticket-service.js';
import { ticketPackage, ticketServiceHandlers } from '../src/modules/ticket/inbound/ticket.grpc.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const NOW = Date.parse('2026-11-26T03:00:00.000Z');
const EVENT = '0190f3a1-7c2e-7a00-8000-00000000f001';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-00000000f002';
const SEAT_A = '0190f3a1-7c2e-7a00-8000-00000000f003';
const SEAT_B = '0190f3a1-7c2e-7a00-8000-00000000f004';
const LABEL_A = 'R구역 12열 7번';

interface Client {
  IssueTickets(req: Record<string, unknown>, cb: (err: grpc.ServiceError | null, res: { tickets: { ticket_id: string; seat_id: string }[] }) => void): void;
}
let pg: PostgresContainer;
let database: Database;
let server: Awaited<ReturnType<typeof startGrpcServer>>;
let client: Client;
let gate: DrizzleScannerGateStore;

const call = <T>(fn: (cb: (err: grpc.ServiceError | null, res: T) => void) => void): Promise<T> => new Promise((res, rej) => fn((err, r) => (err ? rej(err) : res(r))));

beforeAll(async () => {
  pg = await startPostgres();
  await migrateTicket(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'ticket-svc-f0512-seat-int', max: 6 });
  gate = new DrizzleScannerGateStore(database);
  const ticket = new TicketService({ store: new DrizzleTicketStore({ database, changes: gate }), clock: fakeClock({ now: NOW }) });
  server = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [{ definition: ticketPackage().TicketService.service, handlers: ticketServiceHandlers({ ticket, nowMs: () => NOW }, () => undefined) }],
  });
  client = new (ticketPackage().TicketService)(`127.0.0.1:${server.port}`, grpc.credentials.createInsecure()) as unknown as Client;
}, 120_000);
afterAll(async () => {
  await server?.close().catch(() => {});
  await database?.close().catch(() => {});
  pg?.stop();
});

describe('O-T2 ② 실제 PostgreSQL 좌석 이름 스냅샷', () => {
  test('O-T2 ② IssueTickets의 seat_labels를 ticket.seat_label에 저장하고 package·flags가 그 이름을 주며, 없으면 seat_id로 물러난다', async () => {
    const orderA = randomUUID();
    const first = await call<{ tickets: { ticket_id: string; seat_id: string }[] }>((cb) =>
      client.IssueTickets({ order_id: orderA, event_id: EVENT, payer_account_id: ACCOUNT, seat_ids: [SEAT_A], seat_labels: [LABEL_A], issue_generation: 0 }, cb),
    );
    expect(first.tickets).toHaveLength(1);
    const ticketA = first.tickets[0]!.ticket_id;
    const rowA = await database.pool.query<{ seat_label: string | null }>('select seat_label from ticket where id = $1', [ticketA]);
    expect(rowA.rows[0]!.seat_label).toBe(LABEL_A);

    // 이름을 주지 않은 발권(옛 클라이언트·좌석맵 읽기 실패)은 NULL로 두고 읽을 때 seat_id로 물러난다
    const second = await call<{ tickets: { ticket_id: string; seat_id: string }[] }>((cb) =>
      client.IssueTickets({ order_id: randomUUID(), event_id: EVENT, payer_account_id: ACCOUNT, seat_ids: [SEAT_B], issue_generation: 0 }, cb),
    );
    const ticketB = second.tickets[0]!.ticket_id;
    const rowB = await database.pool.query<{ seat_label: string | null }>('select seat_label from ticket where id = $1', [ticketB]);
    expect(rowB.rows[0]!.seat_label).toBeNull();

    const pkg = await gate.package({ eventId: EVENT, nowMs: NOW });
    const labels = Object.fromEntries(pkg.tickets.map((t) => [t.ticketId, t.seatLabel]));
    expect(labels[ticketA]).toBe(LABEL_A);
    expect(labels[ticketB]).toBe(SEAT_B);

    // 이상 표시도 같은 이름을 준다(seat_id를 seatLabel 자리에 넣지 않는다, TR-10)
    const flagId = randomUUID();
    await database.pool.query(
      `insert into gate_flag (id, event_id, ticket_id, kind, awareness, status, created_at) values ($1, $2, $3, 'DUPLICATE', 'CONCURRENT', 'OPEN', $4)`,
      [flagId, EVENT, ticketA, new Date(NOW)],
    );
    const flags = await gate.listFlags({ eventId: EVENT, limit: 50 });
    expect(flags.items.find((f) => f.flagId === flagId)?.seatLabel).toBe(LABEL_A);
  });
});
