// 주문 단위 발권 막기의 실제 PostgreSQL 통합 시험(BUILD_ORDER BAT-011, HOT-161, P-T15·P-T39 ③).
// 정본: docs/api/proto/peaket/ticket/v1/ticket.proto `BlockTicketIssuance`, docs/features/payment.md §3 '승인 뒤 발권',
// specs/payment.qnt `compFence`, ADR-0354 결정 2, docs/data.md `ticket_issue_guard`(0010_ticket_issue_guard.sql).
// 실제 PostgreSQL 18과 DrizzleTicketStore·grpc-js 서버로 본다: guard 행, VOIDED·key_revoked_at, already_entered, FAILED_PRECONDITION 매핑.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { createDatabase, fakeClock, type Database } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrateTicket } from '../scripts/migrate.mjs';
import { startGrpcServer } from '../src/grpc-server.js';
import { DrizzleTicketStore, TicketService } from '../src/modules/ticket/index.js';
import { ticketPackage, ticketServiceHandlers } from '../src/modules/ticket/inbound/ticket.grpc.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = Date.parse('2026-11-22T09:00:00.000Z');
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000202';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000203';
const SEAT_A = '0190f3a1-7c2e-7a00-8000-000000000204';
const SEAT_B = '0190f3a1-7c2e-7a00-8000-000000000205';

interface Client {
  IssueTickets(req: Record<string, unknown>, cb: (err: grpc.ServiceError | null, res: any) => void): void;
  BlockTicketIssuance(req: Record<string, unknown>, cb: (err: grpc.ServiceError | null, res: any) => void): void;
}

let pg: PostgresContainer;
let database: Database;
let store: DrizzleTicketStore;
let server: Awaited<ReturnType<typeof startGrpcServer>>;
let client: Client;
const errors: string[] = [];

beforeAll(async () => {
  pg = await startPostgres();
  database = createDatabase({ url: pg.url, applicationName: 'ticket-block-int', max: 8 });
  await migrateTicket(pg.url);
  store = new DrizzleTicketStore({ database });
  const ticket = new TicketService({ store, clock: fakeClock({ now: NOW }) });
  server = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [{ definition: ticketPackage().TicketService.service, handlers: ticketServiceHandlers({ ticket, nowMs: () => NOW }, (method, err) => errors.push(`${method}:${String(err)}`)) }],
  });
  client = new (ticketPackage().TicketService)(`127.0.0.1:${server.port}`, grpc.credentials.createInsecure()) as unknown as Client;
}, 180_000);

afterAll(async () => {
  await server?.close();
  await database?.close();
  pg?.stop();
});

const call = <T>(fn: (cb: (err: grpc.ServiceError | null, res: any) => void) => void): Promise<T> => new Promise((res, rej) => fn((err, r) => (err ? rej(err) : res(r as T))));
const issue = (orderId: string) =>
  call<{ tickets: Array<{ ticket_id: string; status: string }> }>((cb) =>
    client.IssueTickets({ order_id: orderId, event_id: EVENT, payer_account_id: ACCOUNT, seat_ids: [SEAT_A, SEAT_B], issue_generation: 0 }, cb),
  );
const block = (orderId: string, reason = 'EVENT_CANCELLED') => call<{ already_entered: number }>((cb) => client.BlockTicketIssuance({ order_id: orderId, reason }, cb));
const guardOf = async (orderId: string) =>
  (await database.pool.query('select order_id, blocked_at, reason from ticket_issue_guard where order_id = $1', [orderId])).rows[0] as
    | { order_id: string; blocked_at: Date | string; reason: string }
    | undefined;

test('P-T15_같은_주문의_BlockTicketIssuance는_멱등이고_막은_뒤_IssueTickets는_FAILED_PRECONDITION이다', async () => {
  const orderId = randomUUID();
  expect(await block(orderId)).toMatchObject({ already_entered: 0 });
  const guard = await guardOf(orderId);
  expect(guard?.order_id).toBe(orderId);
  expect(new Date(guard!.blocked_at).getTime()).toBe(NOW);
  expect(guard?.reason).toBe('EVENT_CANCELLED');

  await expect(issue(orderId)).rejects.toMatchObject({ code: grpc.status.FAILED_PRECONDITION });
  expect((await database.pool.query('select 1 from ticket where order_id = $1', [orderId])).rows).toEqual([]);
  expect((await database.pool.query('select 1 from ticket_issue where order_id = $1', [orderId])).rows).toEqual([]);

  // 주문 ID로 멱등하다: 다시 막아도 guard 행은 하나이고 같은 답이다
  expect(await block(orderId)).toMatchObject({ already_entered: 0 });
  expect((await database.pool.query('select count(*)::int as n from ticket_issue_guard where order_id = $1', [orderId])).rows[0].n).toBe(1);
});

test('P-T39 ③_발권이_끝난_주문을_막으면_티켓이_VOIDED가_되고_키를_폐기하며_입장_기록_수를_센다', async () => {
  const orderId = randomUUID();
  const issued = await issue(orderId);
  expect(issued.tickets).toHaveLength(2);
  // 들어감(IN)·통과(PASS) 한 건만 입장 기록이다. 다른 한 장은 기록이 없다
  await database.pool.query(
    `insert into scan_event (id, event_id, ticket_id, scanner_device_id, direction, method, result, scanned_at_device, known_seq, device_seq, received_at)
     values ($1, $2, $3, $4, 'IN', 'QR', 'PASS', $5, 0, 1, $5)`,
    [randomUUID(), EVENT, issued.tickets[0]!.ticket_id, randomUUID(), new Date(NOW - 60_000)],
  );

  expect(await block(orderId)).toMatchObject({ already_entered: 1 });
  const rows = await database.pool.query('select status, key_revoked_at from ticket where order_id = $1 order by seat_id', [orderId]);
  expect(rows.rows.map((r) => r.status)).toEqual(['VOIDED', 'VOIDED']);
  expect(rows.rows.every((r) => r.key_revoked_at !== null && new Date(r.key_revoked_at).getTime() === NOW)).toBe(true);

  // 다시 불러도 같은 입장 기록 수이고, 이미 만든 티켓을 다시 세지 않는다
  expect(await block(orderId)).toMatchObject({ already_entered: 1 });
  await expect(issue(orderId)).rejects.toMatchObject({ code: grpc.status.FAILED_PRECONDITION });
});

test('P-T39 ③_발권과_막기가_동시에_와도_한_트랜잭션만_이기고_막은_뒤_유효한_티켓이_남지_않는다', async () => {
  const orderId = randomUUID();
  const [issued, blocked] = await Promise.allSettled([issue(orderId), block(orderId)]);
  expect(blocked.status).toBe('fulfilled');
  if (issued.status === 'rejected') expect(issued.reason).toMatchObject({ code: grpc.status.FAILED_PRECONDITION });

  // 막기가 이겼으면 티켓이 없고, 발권이 먼저 커밋됐으면 그 티켓이 폐기됐다. 어느 쪽이든 유효한 티켓은 0장이다
  const rows = await database.pool.query("select status from ticket where order_id = $1 and status in ('ISSUED', 'ACTIVE')", [orderId]);
  expect(rows.rows).toEqual([]);
  expect(await guardOf(orderId)).toBeDefined();
  await expect(issue(orderId)).rejects.toMatchObject({ code: grpc.status.FAILED_PRECONDITION });
  expect(errors.some((e) => e.startsWith('IssueTickets:')) || issued.status === 'fulfilled').toBe(true);
});
