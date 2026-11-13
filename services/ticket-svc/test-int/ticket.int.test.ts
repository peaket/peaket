// ticket-svc 실제 PostgreSQL 통합 시험(BUILD_ORDER HOT-160, BAT-050, P-T15).
// 0000_ticket.sql을 그대로 적용하고 DrizzleTicketStore로 발권 멱등·취소표·키 폐기·FOR UPDATE 경합을 본다.
// 마지막에 payment-svc TicketGrpcIssuer가 실제 gRPC로 ticket-svc를 부르는 계약도 확인한다.
import 'reflect-metadata';
import { createDatabase, fakeClock, type Database } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateTicket } from '../scripts/migrate.mjs';
import { startGrpcServer } from '../src/grpc-server.js';
import { DrizzleTicketStore } from '../src/modules/ticket/adapters/db/drizzle-ticket-store.js';
import { TicketService } from '../src/modules/ticket/application/ticket-service.js';
import { TicketConflictError, ticketKeyHash } from '../src/modules/ticket/domain/ticket.js';
import { ticketPackage, ticketServiceHandlers } from '../src/modules/ticket/inbound/ticket.grpc.js';
import { TicketGrpcIssuer } from '../../payment-svc/src/modules/payment/adapters/ticket-grpc-issuer.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const NOW = Date.parse('2026-11-13T03:00:00.000Z');
const ORDER = '0190f3a1-7c2e-7a00-8000-000000000001';
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000002';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000003';
const OTHER = '0190f3a1-7c2e-7a00-8000-000000000004';
const SEAT_A = '0190f3a1-7c2e-7a00-8000-000000000005';
const SEAT_B = '0190f3a1-7c2e-7a00-8000-000000000006';
const CANCEL = '0190f3a1-7c2e-7a00-8000-000000000007';
const CANCEL_2 = '0190f3a1-7c2e-7a00-8000-000000000008';

let pg: PostgresContainer;
let database: Database;
let store: DrizzleTicketStore;
let service: TicketService;
let clock: ReturnType<typeof fakeClock>;

const issue = (over: Partial<Parameters<TicketService['issue']>[0]> = {}) => ({ orderId: ORDER, eventId: EVENT, payerAccountId: ACCOUNT, seatIds: [SEAT_A, SEAT_B], issueGeneration: 0, ...over });
const cancel = (over: Partial<Parameters<TicketService['cancel']>[0]> = {}) => ({ orderId: ORDER, ticketIds: [], requestedByAccountId: ACCOUNT, cancellationId: CANCEL, nowMs: NOW, ...over });
const count = async (table: string): Promise<number> => Number((await database.pool.query(`select count(*)::int as n from ${table}`)).rows[0].n);

beforeAll(async () => {
  pg = await startPostgres();
  database = createDatabase({ url: pg.url, applicationName: 'ticket-svc-test-int', max: 8 });
  await migrateTicket(pg.url);
  store = new DrizzleTicketStore({ database });
  clock = fakeClock({ now: NOW });
  service = new TicketService({ store, clock });
});

afterAll(async () => {
  await database?.close();
  pg?.stop();
});

describe('ticket-svc PostgreSQL [HOT-160] [P-T15]', () => {
  test('0000_ticket.sql이 세 표·CHECK·유일 인덱스를 만든다', async () => {
    const again = await migrateTicket(pg.url);
    expect(again).toEqual([]);
    const r = await database.pool.query("select table_name from information_schema.tables where table_schema = 'public' and table_name in ('ticket_issue','ticket','ticket_cancellation') order by table_name");
    expect(r.rows.map((x) => x.table_name)).toEqual(['ticket', 'ticket_cancellation', 'ticket_issue']);
    const idx = await database.pool.query("select indexname from pg_indexes where schemaname = 'public' and tablename = 'ticket' order by indexname");
    expect(idx.rows.map((x) => x.indexname)).toContain('ticket_order_generation_seat_key');
    await expect(database.pool.query("insert into ticket (id, account_id, payer_account_id, order_id, event_id, seat_id, status, issue_generation, qr_payload, key_hash, created_at) values ('0190f3a1-7c2e-7a00-8000-000000000099','0190f3a1-7c2e-7a00-8000-000000000003','0190f3a1-7c2e-7a00-8000-000000000003','0190f3a1-7c2e-7a00-8000-000000000001','0190f3a1-7c2e-7a00-8000-000000000002','0190f3a1-7c2e-7a00-8000-000000000005','NOPE',0,'x','y',now())")).rejects.toThrow(/ticket_status_check/);
  });

  test('같은 주문·세대를 두 번·동시에 발권해도 티켓은 한 번만 만들고 키 원문은 다시 싣지 않는다', async () => {
    const first = await service.issue(issue({ orderId: '0190f3a1-7c2e-7a00-8000-000000000010' }));
    expect(first.replayed).toBe(false);
    expect(first.tickets).toHaveLength(2);
    const second = await service.issue(issue({ orderId: '0190f3a1-7c2e-7a00-8000-000000000010', seatIds: [SEAT_B, SEAT_A] }));
    expect(second.replayed).toBe(true);
    expect(second.tickets.map((t) => t.ticketId)).toEqual(first.tickets.map((t) => t.ticketId));
    expect(second.tickets.every((t) => t.ticketKey === undefined)).toBe(true);
    const concurrent = await Promise.all([service.issue(issue({ orderId: '0190f3a1-7c2e-7a00-8000-000000000011' })), service.issue(issue({ orderId: '0190f3a1-7c2e-7a00-8000-000000000011' }))]);
    expect(concurrent[0].tickets.map((t) => t.ticketId)).toEqual(concurrent[1].tickets.map((t) => t.ticketId));
    expect(await count('ticket_issue')).toBeGreaterThanOrEqual(2);
    expect(await count('ticket')).toBeGreaterThanOrEqual(4);
    const row = (await database.pool.query('select key_hash, qr_payload from ticket where id = $1', [first.tickets[0]!.ticketId])).rows[0];
    expect(row.key_hash).toBe(ticketKeyHash(first.tickets[0]!.ticketKey!));
    expect(row.qr_payload).toBe(`PEAKET1:${first.tickets[0]!.ticketId}`);
  });

  test('같은 세대에 다른 내용이면 FAILED_PRECONDITION에 해당하는 충돌이고 새 티켓을 만들지 않는다', async () => {
    const orderId = '0190f3a1-7c2e-7a00-8000-000000000012';
    await service.issue(issue({ orderId }));
    const before = await count('ticket');
    await expect(service.issue(issue({ orderId, seatIds: [SEAT_A] }))).rejects.toBeInstanceOf(TicketConflictError);
    expect(await count('ticket')).toBe(before);
  });

  test('취소는 취소표·키 폐기·상태를 남기고, 같은 cancellation_id는 같은 결과이며 다른 취소는 ALREADY_CANCELLED다', async () => {
    const orderId = '0190f3a1-7c2e-7a00-8000-000000000013';
    const { tickets } = await service.issue(issue({ orderId }));
    const id = tickets[0]!.ticketId;
    expect(await service.cancel(cancel({ orderId, ticketIds: [id] }))).toEqual([{ ticketId: id, result: 'REFUND_NOW' }]);
    const row = (await database.pool.query('select status, key_revoked_at, version from ticket where id = $1', [id])).rows[0];
    expect(row.status).toBe('REFUNDED');
    expect(row.key_revoked_at).not.toBeNull();
    expect(row.version).toBe(1);
    expect(await count('ticket_cancellation')).toBeGreaterThanOrEqual(1);
    expect(await service.cancel(cancel({ orderId, ticketIds: [id] }))).toEqual([{ ticketId: id, result: 'REFUND_NOW' }]);
    expect(await service.cancel(cancel({ orderId, ticketIds: [id], cancellationId: CANCEL_2 }))).toEqual([{ ticketId: id, result: 'ALREADY_CANCELLED' }]);
  });

  test('요청자가 결제자·보유자가 아니면 거절하고, 양도 요청·입장 시작을 행 잠금 안에서 가른다', async () => {
    const orderId = '0190f3a1-7c2e-7a00-8000-000000000014';
    const { tickets } = await service.issue(issue({ orderId }));
    const id = tickets[0]!.ticketId;
    expect(await service.cancel(cancel({ orderId, ticketIds: [id], requestedByAccountId: OTHER }))).toEqual([{ ticketId: id, result: 'NOT_PAYER_HOLDER' }]);
    await database.pool.query('update ticket set transfer_pending = true where id = $1', [id]);
    expect(await service.cancel(cancel({ orderId, ticketIds: [id], cancellationId: CANCEL_2 }))).toEqual([{ ticketId: id, result: 'TRANSFER_PENDING' }]);
    const started = await service.issue(issue({ orderId: '0190f3a1-7c2e-7a00-8000-000000000015', eventStartsAtMs: NOW - 1 }));
    expect(await service.cancel(cancel({ orderId: '0190f3a1-7c2e-7a00-8000-000000000015', ticketIds: [started.tickets[0]!.ticketId] }))).toEqual([{ ticketId: started.tickets[0]!.ticketId, result: 'REFUND_AFTER_CLOSE' }]);
    expect((await database.pool.query('select status from ticket where id = $1', [started.tickets[0]!.ticketId])).rows[0].status).toBe('VOIDED');
  });

  test('같은 티켓을 동시에 두 취소가 노리면 FOR UPDATE가 하나만 REFUND_NOW로 통과시킨다', async () => {
    const orderId = '0190f3a1-7c2e-7a00-8000-000000000016';
    const { tickets } = await service.issue(issue({ orderId, seatIds: [SEAT_A] }));
    const id = tickets[0]!.ticketId;
    const out = await Promise.all([service.cancel(cancel({ orderId, ticketIds: [id], cancellationId: CANCEL })), service.cancel(cancel({ orderId, ticketIds: [id], cancellationId: CANCEL_2 }))]);
    expect(out.flat().map((o) => o.result).sort()).toEqual(['ALREADY_CANCELLED', 'REFUND_NOW']);
    expect((await database.pool.query('select status, version from ticket where id = $1', [id])).rows[0]).toMatchObject({ status: 'REFUNDED', version: 1 });
  });

  test('같은 cancellation_id가 동시에 와도 둘 다 REFUND_NOW이고 취소표는 한 장이다', async () => {
    const orderId = '0190f3a1-7c2e-7a00-8000-000000000018';
    const { tickets } = await service.issue(issue({ orderId, seatIds: [SEAT_A] }));
    const id = tickets[0]!.ticketId;
    const out = await Promise.all([service.cancel(cancel({ orderId, ticketIds: [id] })), service.cancel(cancel({ orderId, ticketIds: [id] }))]);
    expect(out.flat().map((o) => o.result)).toEqual(['REFUND_NOW', 'REFUND_NOW']);
    const rows = await database.pool.query('select count(*)::int as n from ticket_cancellation where cancellation_id = $1 and ticket_id = $2', [CANCEL, id]);
    expect(rows.rows[0].n).toBe(1);
  });

  test('월렛 목록은 그 계정 티켓만 최신순으로 주고 커서로 나눈다', async () => {
    const account = '0190f3a1-7c2e-7a00-8000-000000000017';
    const order = (n: number) => `0190f3a1-7c2e-7a00-8000-00000000002${n}`;
    await service.issue(issue({ orderId: order(0), payerAccountId: account, seatIds: [SEAT_A] }));
    clock.advance(1000);
    await service.issue(issue({ orderId: order(1), payerAccountId: account, seatIds: [SEAT_B] }));
    await service.issue(issue({ orderId: order(2), payerAccountId: OTHER, seatIds: [SEAT_A] }));
    const page1 = await service.list({ accountId: account, limit: 1 });
    expect(page1.tickets).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await service.list({ accountId: account, limit: 1, cursor: page1.nextCursor });
    expect(page2.tickets).toHaveLength(1);
    expect(page2.tickets[0]!.ticketId).not.toBe(page1.tickets[0]!.ticketId);
    expect(page2.nextCursor).toBeUndefined();
  });

  test('payment-svc TicketGrpcIssuer가 실제 gRPC로 ticket-svc를 불러 발권하고 재요청은 같은 티켓이다', async () => {
    const server = await startGrpcServer({
      host: '127.0.0.1',
      port: 0,
      services: [{ definition: ticketPackage().TicketService.service, handlers: ticketServiceHandlers({ ticket: service, nowMs: () => clock.now() }, () => {}) }],
    });
    try {
      const issuer = new TicketGrpcIssuer({ address: `127.0.0.1:${server.port}` });
      const orderId = '0190f3a1-7c2e-7a00-8000-000000000030';
      const first = await issuer.issue({ orderId, eventId: EVENT, payerAccountId: ACCOUNT, seatIds: [SEAT_A], issueGeneration: 0, eventStartsAtMs: NOW + 86_400_000 });
      expect(first.kind).toBe('issued');
      if (first.kind !== 'issued') return;
      expect(first.tickets).toHaveLength(1);
      const second = await issuer.issue({ orderId, eventId: EVENT, payerAccountId: ACCOUNT, seatIds: [SEAT_A], issueGeneration: 0, eventStartsAtMs: NOW + 86_400_000 });
      expect(second).toMatchObject({ kind: 'issued', tickets: [{ ticketId: first.tickets[0]!.ticketId }] });
    } finally {
      await server.close();
    }
  });
});
