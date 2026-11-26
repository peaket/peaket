// ticket-svc 실제 PostgreSQL 통합 시험(BUILD_ORDER HOT-160, BAT-050, P-T15).
// 0000_ticket.sql을 그대로 적용하고 DrizzleTicketStore로 발권 멱등·취소표·키 폐기·FOR UPDATE 경합을 본다.
// 마지막에 payment-svc TicketGrpcIssuer가 실제 gRPC로 ticket-svc를 부르는 계약도 확인한다.
// BAT-415 몫 F: 부정 예매 운영자 취소(OperatorCancelTickets, 0008 ticket_operator_cancellation)를 맨 아래 묶음에서 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createDatabase, fakeClock, type Database } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateTicket } from '../scripts/migrate.mjs';
import { startGrpcServer } from '../src/grpc-server.js';
import { DrizzleTicketStore } from '../src/modules/ticket/adapters/db/drizzle-ticket-store.js';
import { TicketService } from '../src/modules/ticket/application/ticket-service.js';
import { DrizzleScannerGateStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-gate-store.js';
import { TicketConflictError, TicketInputError, ticketKeyHash } from '../src/modules/ticket/domain/ticket.js';
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
    expect(await service.cancel(cancel({ orderId, ticketIds: [id], reason: 'USER' }))).toEqual([{ ticketId: id, result: 'REFUND_NOW' }]);
    const row = (await database.pool.query('select status, key_revoked_at, version from ticket where id = $1', [id])).rows[0];
    expect(row.status).toBe('REFUNDED');
    expect(row.key_revoked_at).not.toBeNull();
    expect(row.version).toBe(1);
    expect(await count('ticket_cancellation')).toBeGreaterThanOrEqual(1);
    expect(await service.cancel(cancel({ orderId, ticketIds: [id] }))).toEqual([{ ticketId: id, result: 'REFUND_NOW' }]);
    // 다른 취소 ID는 ALREADY_CANCELLED이고, 먼저 취소한 팬 취소(첫 취소 ID·결과·키 폐기 시각)를 함께 준다(리뷰 B2, docs/features/payment.md §4.1 '앞 시도가 티켓 단계만 마친 팬 취소 잇기')
    expect(await service.cancel(cancel({ orderId, ticketIds: [id], cancellationId: CANCEL_2 }))).toEqual([{ ticketId: id, result: 'ALREADY_CANCELLED', first: { cancellationId: CANCEL, result: 'REFUND_NOW', cancelledAtMs: NOW } }]);
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

  test('CheckReviewEligibility는 실제 DB의 결제자·유효 티켓·종료 시각으로 자격과 근거 주문을 준다 [ASVS v5.0.0-2.2.3]', async () => {
    const eventId = '0190f3a1-7c2e-7a00-8000-000000000031';
    const orderId = '0190f3a1-7c2e-7a00-8000-000000000032';
    await service.issue(issue({ eventId, orderId, payerAccountId: ACCOUNT, seatIds: [SEAT_A] }));
    const notEnded = await service.reviewEligibility({ accountId: ACCOUNT, eventId, nowMs: NOW, eventEndsAtMs: NOW + 3_600_000 });
    expect(notEnded).toMatchObject({ eligible: false, reason: 'NOT_ENDED' });
    const eligible = await service.reviewEligibility({ accountId: ACCOUNT, eventId, nowMs: NOW, eventEndsAtMs: NOW - 3_600_000 });
    expect(eligible).toMatchObject({ eligible: true, basisOrderId: orderId });
    const notPayer = await service.reviewEligibility({ accountId: OTHER, eventId, nowMs: NOW, eventEndsAtMs: NOW - 3_600_000 });
    expect(notPayer).toMatchObject({ eligible: false, reason: 'NOT_PAYER' });

    const ticketId = (await database.pool.query('select id from ticket where order_id = $1', [orderId])).rows[0].id as string;
    await database.pool.query('update ticket set account_id = $1 where id = $2', [OTHER, ticketId]);
    const holder = await service.reviewEligibility({ accountId: OTHER, eventId, nowMs: NOW, eventEndsAtMs: NOW - 3_600_000 });
    expect(holder).toMatchObject({ eligible: false, reason: 'NOT_PAYER' });
    await database.pool.query('update ticket set account_id = $1 where id = $2', [ACCOUNT, ticketId]);

    await service.cancel(cancel({ orderId, ticketIds: [ticketId], cancellationId: CANCEL }));
    const noValid = await service.reviewEligibility({ accountId: ACCOUNT, eventId, nowMs: NOW, eventEndsAtMs: NOW - 3_600_000 });
    expect(noValid).toMatchObject({ eligible: false, reason: 'NO_VALID_TICKET' });
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

// ---- 부정 예매 운영자 취소(BUILD_ORDER GAT-080, BAT-415 몫 F, docs/features/transfer-refund.md §7.4 'purchase-svc·ticket-svc 쪽 세부') ----
// 0008 ticket_operator_cancellation, 입장 기록(scan_event IN·PASS)의 경계, (승인, 표) 멱등, 팬 취소와의 행 잠금 경합, 트랜잭션째 되돌림, 스캐너 변경분을 실제 DB로 본다.
// 이 묶음은 스캐너 변경 기록기를 꽂은 저장소를 따로 만든다(발권도 TICKET_STATUS를 남기므로 취소 뒤의 변경분만 센다).
describe('GAT-080 몫 F 운영자 취소 [PostgreSQL]', () => {
  let opStore: DrizzleTicketStore;
  let opService: TicketService;
  let deviceSeq = 0;
  const RECIPIENT = '0190f3a1-7c2e-7a00-8000-0000000000f1';

  beforeAll(() => {
    opStore = new DrizzleTicketStore({ database, changes: new DrizzleScannerGateStore(database) });
    opService = new TicketService({ store: opStore, clock });
  });

  const fresh = async (n = 1, eventId = randomUUID()) => {
    const orderId = randomUUID();
    const r = await opService.issue({ orderId, eventId, payerAccountId: ACCOUNT, seatIds: Array.from({ length: n }, () => randomUUID()), issueGeneration: 0 });
    return { eventId, orderId, tickets: r.tickets.map((t) => t.ticketId) };
  };
  const op = (eventId: string, targets: { ticketId: string; expectedHolderAccountId: string }[], approvalId = randomUUID()) =>
    opService.operatorCancel({ approvalId, fraudCaseId: randomUUID(), eventId, targets, nowMs: NOW });
  const scan = (eventId: string, ticketId: string, direction: 'IN' | 'OUT', result: 'PASS' | 'REJECT' | 'CHECK') =>
    database.pool.query(
      `insert into scan_event (id, event_id, ticket_id, scanner_device_id, direction, method, result, scanned_at_device, known_seq, device_seq, received_at)
       values ($1, $2, $3, $4, $5, 'QR', $6, now(), 0, $7, now())`,
      [randomUUID(), eventId, ticketId, randomUUID(), direction, result, ++deviceSeq],
    );
  const row = async (ticketId: string) =>
    (await database.pool.query('select status, account_id, transfer_pending, key_revoked_at, version from ticket where id = $1', [ticketId])).rows[0] as {
      status: string;
      account_id: string;
      transfer_pending: boolean;
      key_revoked_at: Date | null;
      version: number;
    };
  const lastSeq = async (eventId: string): Promise<number> => Number((await database.pool.query('select coalesce(max(seq), 0) as n from scanner_change where event_id = $1', [eventId])).rows[0].n);
  const changesAfter = async (eventId: string, seq: number) =>
    (await database.pool.query<{ kind: string; ticket_id: string }>("select kind, payload->>'ticketId' as ticket_id from scanner_change where event_id = $1 and seq > $2 order by seq", [eventId, seq])).rows;

  test('GAT-080 F3 들어감·통과(IN, PASS) 스캔이 있으면 SKIPPED_ENTRY_RECORDED이고, 거절(IN, REJECT)·확인(IN, CHECK)·나감(OUT, PASS)만 있으면 취소한다', async () => {
    const w = await fresh(4);
    const [entered, rejected, checked, exited] = w.tickets as [string, string, string, string];
    await scan(w.eventId, entered, 'IN', 'PASS');
    await scan(w.eventId, rejected, 'IN', 'REJECT');
    await scan(w.eventId, checked, 'IN', 'CHECK');
    await scan(w.eventId, exited, 'OUT', 'PASS');
    const out = await op(
      w.eventId,
      w.tickets.map((ticketId) => ({ ticketId, expectedHolderAccountId: ACCOUNT })),
    );
    expect(out).toEqual([
      { ticketId: entered, result: 'SKIPPED_ENTRY_RECORDED', orderId: w.orderId },
      { ticketId: rejected, result: 'CANCELED', orderId: w.orderId },
      { ticketId: checked, result: 'CANCELED', orderId: w.orderId },
      { ticketId: exited, result: 'CANCELED', orderId: w.orderId },
    ]);
    expect(await row(entered)).toMatchObject({ status: 'ISSUED', key_revoked_at: null, version: 0 });
    for (const id of [rejected, checked, exited]) expect(await row(id)).toMatchObject({ status: 'REFUNDED', transfer_pending: false, key_revoked_at: new Date(NOW), version: 1 });
  });

  test('GAT-080 F1 실제 DB에서도 받은 사람이 가진 표·양도 진행 중인 표를 기대 보유자대로 취소하고 양도 표시를 끈다', async () => {
    const w = await fresh(2);
    const [held, transferring] = w.tickets as [string, string];
    await database.pool.query('update ticket set account_id = $2 where id = $1', [held, RECIPIENT]);
    await database.pool.query('update ticket set transfer_pending = true where id = $1', [transferring]);
    const out = await op(w.eventId, [
      { ticketId: held, expectedHolderAccountId: RECIPIENT },
      { ticketId: transferring, expectedHolderAccountId: ACCOUNT },
    ]);
    expect(out.map((o) => o.result)).toEqual(['CANCELED', 'CANCELED']);
    expect(await row(held)).toMatchObject({ status: 'REFUNDED', account_id: RECIPIENT, version: 1 });
    expect(await row(transferring)).toMatchObject({ status: 'REFUNDED', transfer_pending: false, version: 1 });
  });

  test('GAT-080 F4 같은 승인으로 다시 부르면 처음 결과를 주고 버전·스캐너 변경분·키 폐기 시각을 다시 바꾸지 않으며, 다른 승인으로 같은 표는 SKIPPED_ALREADY_ENDED다', async () => {
    const w = await fresh(2);
    const [cancelMe, moved] = w.tickets as [string, string];
    await database.pool.query('update ticket set account_id = $2 where id = $1', [moved, RECIPIENT]);
    const approvalId = randomUUID();
    const fraudCaseId = randomUUID();
    const req = { approvalId, fraudCaseId, eventId: w.eventId, targets: [cancelMe, moved].map((ticketId) => ({ ticketId, expectedHolderAccountId: ACCOUNT })), nowMs: NOW };
    const first = await opService.operatorCancel(req);
    expect(first.map((o) => o.result)).toEqual(['CANCELED', 'SKIPPED_HOLDER_CHANGED']);
    const seq = await lastSeq(w.eventId);
    const rows = [await row(cancelMe), await row(moved)];

    const second = await opService.operatorCancel({ ...req, nowMs: NOW + 60_000 });
    expect(second).toEqual(first);
    expect([await row(cancelMe), await row(moved)]).toEqual(rows);
    expect(await lastSeq(w.eventId)).toBe(seq);
    const recorded = await database.pool.query<{ ticket_id: string; result: string; order_id: string; fraud_case_id: string; n: number }>(
      'select ticket_id, result, order_id, fraud_case_id, count(*) over (partition by ticket_id)::int as n from ticket_operator_cancellation where approval_id = $1 order by result',
      [approvalId],
    );
    expect(recorded.rows).toEqual([
      { ticket_id: cancelMe, result: 'CANCELED', order_id: w.orderId, fraud_case_id: fraudCaseId, n: 1 },
      { ticket_id: moved, result: 'SKIPPED_HOLDER_CHANGED', order_id: w.orderId, fraud_case_id: fraudCaseId, n: 1 },
    ]);

    expect(await op(w.eventId, [{ ticketId: cancelMe, expectedHolderAccountId: ACCOUNT }])).toEqual([{ ticketId: cancelMe, result: 'SKIPPED_ALREADY_ENDED', orderId: w.orderId }]);
  });

  test('GAT-080 F4 0008 ticket_operator_cancellation은 (승인, 표) 기본 키와 결과 목록 검사·표 외래키를 건다', async () => {
    const w = await fresh(1);
    const [ticketId] = w.tickets as [string];
    const put = (approvalId: string, t: string, result: string) =>
      database.pool.query('insert into ticket_operator_cancellation (approval_id, ticket_id, order_id, fraud_case_id, result, cancelled_at) values ($1, $2, $3, $4, $5, now())', [
        approvalId,
        t,
        w.orderId,
        randomUUID(),
        result,
      ]);
    const approvalId = randomUUID();
    await put(approvalId, ticketId, 'SKIPPED_ALREADY_ENDED');
    await expect(put(approvalId, ticketId, 'CANCELED')).rejects.toMatchObject({ code: '23505' });
    await expect(put(randomUUID(), ticketId, 'NOPE')).rejects.toMatchObject({ code: '23514' });
    await expect(put(randomUUID(), randomUUID(), 'CANCELED')).rejects.toMatchObject({ code: '23503' });
    for (const result of ['CANCELED', 'SKIPPED_ENTRY_RECORDED', 'SKIPPED_HOLDER_CHANGED']) await put(randomUUID(), ticketId, result);
  });

  test('GAT-080 F5 팬 취소와 운영자 취소가 같은 표를 동시에 노리면(50회) 매번 하나만 키를 폐기하고 두 차례가 모두 나온다', async () => {
    let fanFirst = 0;
    let operatorFirst = 0;
    for (let i = 0; i < 50; i++) {
      const w = await fresh(1);
      const [ticketId] = w.tickets as [string];
      const fan = () => opService.cancel({ orderId: w.orderId, ticketIds: [ticketId], requestedByAccountId: ACCOUNT, cancellationId: randomUUID(), nowMs: NOW });
      const oper = () => op(w.eventId, [{ ticketId, expectedHolderAccountId: ACCOUNT }]);
      // 시작 차례를 번갈아 바꾼다(한쪽만 이기는 경합이 되지 않게)
      const [fanOut, opOut] =
        i % 2 === 0
          ? await Promise.all([fan(), oper()])
          : await (async () => {
              const o = oper();
              const f = fan();
              const [ro, rf] = await Promise.all([o, f]);
              return [rf, ro] as const;
            })();
      const fanResult = fanOut[0]!.result;
      const opResult = opOut[0]!.result;
      if (fanResult === 'REFUND_NOW') {
        expect(opResult, `회차 ${i}`).toBe('SKIPPED_ALREADY_ENDED');
        fanFirst++;
      } else {
        expect(fanResult, `회차 ${i}`).toBe('ALREADY_CANCELLED');
        expect(opResult, `회차 ${i}`).toBe('CANCELED');
        operatorFirst++;
      }
      expect(await row(ticketId), `회차 ${i}`).toMatchObject({ status: 'REFUNDED', version: 1 });
    }
    expect(fanFirst, '팬 취소가 먼저 잡은 경우').toBeGreaterThan(0);
    expect(operatorFirst, '운영자 취소가 먼저 잡은 경우').toBeGreaterThan(0);
  });

  test('GAT-080 F6 없는 표·다른 회차 표가 섞이면 INVALID(TicketInputError)이고 앞 표의 변경까지 트랜잭션째 되돌린다', async () => {
    const w = await fresh(1);
    const other = await fresh(1);
    const [ok] = w.tickets as [string];
    const seq = await lastSeq(w.eventId);
    for (const bad of [randomUUID(), other.tickets[0]!]) {
      const approvalId = randomUUID();
      await expect(
        op(
          w.eventId,
          [
            { ticketId: ok, expectedHolderAccountId: ACCOUNT },
            { ticketId: bad, expectedHolderAccountId: ACCOUNT },
          ],
          approvalId,
        ),
      ).rejects.toBeInstanceOf(TicketInputError);
      expect(await row(ok)).toMatchObject({ status: 'ISSUED', key_revoked_at: null, version: 0 });
      expect((await database.pool.query('select count(*)::int as n from ticket_operator_cancellation where approval_id = $1', [approvalId])).rows[0].n).toBe(0);
    }
    expect(await lastSeq(w.eventId)).toBe(seq);
    expect(await row(other.tickets[0]!)).toMatchObject({ status: 'ISSUED', version: 0 });
  });

  test('GAT-080 F7 취소한 표는 스캐너 변경분 TICKET_STATUS와 KEY_REVOKED를 한 번씩 남기고 건너뛴 표는 남기지 않는다', async () => {
    const w = await fresh(2);
    const [cancelMe, moved] = w.tickets as [string, string];
    await database.pool.query('update ticket set account_id = $2 where id = $1', [moved, RECIPIENT]);
    const seq = await lastSeq(w.eventId);
    await op(w.eventId, [cancelMe, moved].map((ticketId) => ({ ticketId, expectedHolderAccountId: ACCOUNT })));
    const changes = await changesAfter(w.eventId, seq);
    expect(changes.map((c) => c.kind).sort()).toEqual(['KEY_REVOKED', 'TICKET_STATUS']);
    expect(changes.every((c) => c.ticket_id === cancelMe)).toBe(true);
  });
});

// ---- BAT-415 리뷰 반영 B2(계획 §11 S3): CancelTickets의 첫 팬 취소 칸을 실제 DB(ticket_cancellation)로 본다 ----
describe('GAT-080 S3 첫 팬 취소 칸 [PostgreSQL]', () => {
  const fresh = async () => {
    const orderId = randomUUID();
    const r = await service.issue({ orderId, eventId: randomUUID(), payerAccountId: ACCOUNT, seatIds: [randomUUID()], issueGeneration: 0 });
    return { orderId, eventId: r.tickets[0]!.eventId, ticketId: r.tickets[0]!.ticketId };
  };
  const fan = (t: { orderId: string; ticketId: string }, cancellationId: string, nowMs: number) =>
    service.cancel({ orderId: t.orderId, ticketIds: [t.ticketId], requestedByAccountId: ACCOUNT, cancellationId, nowMs, reason: 'USER' });

  test('GAT-080 S3 K1 REFUND_NOW 뒤 K2는 ALREADY_CANCELLED와 첫 취소(K1·REFUND_NOW·K1 시각)를 받고, K3도 K1을 받는다', async () => {
    const t = await fresh();
    const [k1, k2, k3] = [randomUUID(), randomUUID(), randomUUID()];
    expect(await fan(t, k1, NOW)).toEqual([{ ticketId: t.ticketId, result: 'REFUND_NOW' }]);
    expect(await fan(t, k2, NOW + 60_000)).toEqual([{ ticketId: t.ticketId, result: 'ALREADY_CANCELLED', first: { cancellationId: k1, result: 'REFUND_NOW', cancelledAtMs: NOW } }]);
    expect(await fan(t, k3, NOW + 120_000)).toEqual([{ ticketId: t.ticketId, result: 'ALREADY_CANCELLED', first: { cancellationId: k1, result: 'REFUND_NOW', cancelledAtMs: NOW } }]);
    // K2·K3의 ALREADY_CANCELLED 기록은 첫 취소가 아니다. 같은 K1을 다시 부르면 처음 결과(첫 칸 없음)
    expect(await fan(t, k1, NOW + 180_000)).toEqual([{ ticketId: t.ticketId, result: 'REFUND_NOW' }]);
  });

  test('GAT-080 S3 gRPC 답은 first_cancellation_id·first_result·first_cancelled_at을 싣는다', async () => {
    const server = await startGrpcServer({
      host: '127.0.0.1',
      port: 0,
      services: [{ definition: ticketPackage().TicketService.service, handlers: ticketServiceHandlers({ ticket: service, nowMs: () => NOW + 30_000 }, () => {}) }],
    });
    const client = new (ticketPackage().TicketService)(`127.0.0.1:${server.port}`, (await import('@grpc/grpc-js')).credentials.createInsecure()) as unknown as {
      CancelTickets(req: object, cb: (e: Error | null, v: { outcomes: Record<string, unknown>[] }) => void): void;
      close(): void;
    };
    try {
      const t = await fresh();
      const k1 = randomUUID();
      await fan(t, k1, NOW);
      const reply = await new Promise<{ outcomes: Record<string, unknown>[] }>((resolve, reject) =>
        client.CancelTickets({ order_id: t.orderId, ticket_ids: [t.ticketId], requested_by_account_id: ACCOUNT, cancellation_id: randomUUID() }, (e, v) => (e ? reject(e) : resolve(v))),
      );
      expect(reply.outcomes[0]).toMatchObject({
        ticket_id: t.ticketId,
        result: 'CANCEL_TICKET_RESULT_ALREADY_CANCELLED',
        first_cancellation_id: k1,
        first_result: 'CANCEL_TICKET_RESULT_REFUND_NOW',
        first_cancelled_at: { seconds: Math.floor(NOW / 1000), nanos: (NOW % 1000) * 1_000_000 },
      });
    } finally {
      client.close();
      await server.close();
    }
  });

  test('GAT-080 S3 운영자 취소한 표·무효(VOIDED, 팬 취소 기록 없음)로 끝난 표에 K2가 오면 첫 칸이 없다', async () => {
    const byOperator = await fresh();
    await service.operatorCancel({ approvalId: randomUUID(), fraudCaseId: randomUUID(), eventId: byOperator.eventId, targets: [{ ticketId: byOperator.ticketId, expectedHolderAccountId: ACCOUNT }], nowMs: NOW });
    const voided = await fresh();
    await database.pool.query("update ticket set status = 'VOIDED', key_revoked_at = now(), version = version + 1 where id = $1", [voided.ticketId]);
    for (const t of [byOperator, voided]) {
      expect(await fan(t, randomUUID(), NOW + 60_000)).toEqual([{ ticketId: t.ticketId, result: 'ALREADY_CANCELLED' }]);
    }
  });
});

// ---- BAT-420(시험 담당, 구현 전에 씀): 입장 기록 대조 GetEntryRecords(GAT-090 A5)와 회차 취소 EventCancelTickets(GAT-110 E2·E3·E4) ----
// 입장 시각은 scan_event.scanned_at_device(기기가 찍은 시각)이고, 받은 시각(received_at)은 1초 늦게 둔다(둘을 섞으면 드러나게).
describe('BAT-420 입장 기록 대조·회차 취소 [PostgreSQL]', () => {
  let ecStore: DrizzleTicketStore;
  let ecService: TicketService;
  let deviceSeq = 1_000_000;
  const RECIPIENT = '0190f3a1-7c2e-7a00-8000-0000000000f2';

  beforeAll(() => {
    ecStore = new DrizzleTicketStore({ database, changes: new DrizzleScannerGateStore(database) });
    ecService = new TicketService({ store: ecStore, clock });
  });

  const fresh = async (n = 1, eventId = randomUUID()) => {
    const orderId = randomUUID();
    const r = await ecService.issue({ orderId, eventId, payerAccountId: ACCOUNT, seatIds: Array.from({ length: n }, () => randomUUID()), issueGeneration: 0 });
    return { eventId, orderId, tickets: r.tickets.map((t) => t.ticketId) };
  };
  const scanAt = (eventId: string, ticketId: string, direction: 'IN' | 'OUT', result: 'PASS' | 'REJECT' | 'CHECK', atMs: number) =>
    database.pool.query(
      `insert into scan_event (id, event_id, ticket_id, scanner_device_id, direction, method, result, scanned_at_device, known_seq, device_seq, received_at)
       values ($1, $2, $3, $4, $5, 'QR', $6, $7, 0, $8, $9)`,
      [randomUUID(), eventId, ticketId, randomUUID(), direction, result, new Date(atMs), ++deviceSeq, new Date(atMs + 1_000)],
    );
  const row = async (ticketId: string) =>
    (await database.pool.query('select status, account_id, transfer_pending, key_revoked_at, version from ticket where id = $1', [ticketId])).rows[0] as {
      status: string;
      account_id: string;
      transfer_pending: boolean;
      key_revoked_at: Date | null;
      version: number;
    };
  const lastSeq = async (eventId: string): Promise<number> => Number((await database.pool.query('select coalesce(max(seq), 0) as n from scanner_change where event_id = $1', [eventId])).rows[0].n);
  const changesAfter = async (eventId: string, seq: number) =>
    (await database.pool.query<{ kind: string; ticket_id: string }>("select kind, payload->>'ticketId' as ticket_id from scanner_change where event_id = $1 and seq > $2 order by seq", [eventId, seq])).rows;
  const ec = (eventId: string, targets: { ticketId: string; cancellationId: string }[], nowMs = NOW) => ecService.eventCancel({ cancellationRequestId: randomUUID(), eventId, targets, nowMs });
  const t = (ticketId: string, cancellationId: string = randomUUID()) => ({ ticketId, cancellationId });

  test('GAT-090 A5 GetEntryRecords는 실제 scan_event에서 들어감·통과만 입장으로 세고 가장 이른 기기 시각을 준다', async () => {
    const w = await fresh(5);
    const [twice, rejected, checked, exited, none] = w.tickets as [string, string, string, string, string];
    const at1001 = NOW + 60_000;
    const at1005 = NOW + 5 * 60_000;
    await scanAt(w.eventId, twice, 'IN', 'PASS', at1005);
    await scanAt(w.eventId, twice, 'IN', 'PASS', at1001);
    await scanAt(w.eventId, twice, 'IN', 'REJECT', at1001 - 60_000);
    await scanAt(w.eventId, rejected, 'IN', 'REJECT', at1001);
    await scanAt(w.eventId, checked, 'IN', 'CHECK', at1001);
    await scanAt(w.eventId, exited, 'OUT', 'PASS', at1001);
    const unknown = randomUUID();
    expect(await ecService.entryRecords([none, unknown, twice, rejected, checked, exited])).toEqual([
      { ticketId: none, found: true, entered: false },
      { ticketId: unknown, found: false, entered: false },
      { ticketId: twice, found: true, entered: true, firstEnteredAtMs: at1001 },
      { ticketId: rejected, found: true, entered: false },
      { ticketId: checked, found: true, entered: false },
      { ticketId: exited, found: true, entered: false },
    ]);
  });

  test('GAT-110 E2 실제 DB에서 끝낼 상태 다섯은 CANCELED·키 폐기·환급·판 번호 + 1·양도 표시 끔과 스캐너 변경분 둘씩, 끝난 상태 둘은 그대로다', async () => {
    const w = await fresh(7);
    const statuses = ['ISSUED', 'ACTIVE', 'TRANSFER_PENDING', 'CANCEL_REQUESTED', 'FLAGGED', 'REFUNDED', 'VOIDED'] as const;
    for (const [i, status] of statuses.entries()) await database.pool.query('update ticket set status = $2, version = 9 where id = $1', [w.tickets[i], status]);
    await database.pool.query('update ticket set account_id = $2, transfer_pending = true where id = $1', [w.tickets[0], RECIPIENT]);
    const before = await Promise.all(w.tickets.slice(5).map(row));
    const seq = await lastSeq(w.eventId);
    const out = await ec(w.eventId, w.tickets.map((id) => t(id)));
    expect(out.map((o) => [o.result, o.transferWithdrawn])).toEqual([
      ['CANCELED', true],
      ['CANCELED', false],
      ['CANCELED', true],
      ['CANCELED', false],
      ['CANCELED', false],
      ['ALREADY_ENDED', false],
      ['ALREADY_ENDED', false],
    ]);
    expect(out[0]).toMatchObject({ holderAccountId: RECIPIENT, orderId: w.orderId });
    for (const id of w.tickets.slice(0, 5)) expect(await row(id)).toMatchObject({ status: 'REFUNDED', transfer_pending: false, key_revoked_at: new Date(NOW), version: 10 });
    expect(await Promise.all(w.tickets.slice(5).map(row))).toEqual(before);
    const changes = await changesAfter(w.eventId, seq);
    for (const id of w.tickets.slice(0, 5)) expect(changes.filter((c) => c.ticket_id === id).map((c) => c.kind).sort(), id).toEqual(['KEY_REVOKED', 'TICKET_STATUS']);
    expect(changes.filter((c) => w.tickets.slice(5).includes(c.ticket_id))).toEqual([]);
    const recorded = await database.pool.query<{ ticket_id: string; result: string }>('select ticket_id, result from ticket_cancellation where ticket_id = any($1::uuid[])', [w.tickets]);
    expect(recorded.rows.map((r) => r.result).sort()).toEqual(Array(5).fill('EVENT_CANCELED'));
  });

  test('GAT-110 E3 같은 취소 ID로 다시 부르면 CANCELED이고 판 번호·스캐너 변경분이 그대로이며, 틀린 요청은 앞 표까지 되돌린다', async () => {
    const w = await fresh(1);
    const [id] = w.tickets as [string];
    const cancellationId = randomUUID();
    expect((await ec(w.eventId, [t(id, cancellationId)]))[0]!.result).toBe('CANCELED');
    const after = await row(id);
    const seq = await lastSeq(w.eventId);
    expect((await ec(w.eventId, [t(id, cancellationId)], NOW + 60_000))[0]!.result).toBe('CANCELED');
    expect(await row(id)).toEqual(after);
    expect(await lastSeq(w.eventId)).toBe(seq);
    expect(Number((await database.pool.query('select count(*)::int as n from ticket_cancellation where cancellation_id = $1', [cancellationId])).rows[0].n)).toBe(1);

    const fresh2 = await fresh(1);
    const other = await fresh(1);
    const [ok] = fresh2.tickets as [string];
    for (const bad of [randomUUID(), other.tickets[0]!]) {
      await expect(ec(fresh2.eventId, [t(ok), t(bad)])).rejects.toBeInstanceOf(TicketInputError);
      expect(await row(ok)).toMatchObject({ status: 'ISSUED', key_revoked_at: null, version: 0 });
    }
    // 상한 200장(EVENT_CANCEL_MAX_TARGETS): 발권은 한 번에 10좌석(MAX_TICKETS_PER_ISSUE)까지라 같은 회차에 주문 스물로 만든다
    const manyEvent = randomUUID();
    const many: string[] = [];
    for (let i = 0; i < 20; i++) many.push(...(await fresh(10, manyEvent)).tickets);
    expect(many).toHaveLength(200);
    const all = await ec(manyEvent, many.map((x) => t(x)));
    expect(all).toHaveLength(200);
    expect(all.every((o) => o.result === 'CANCELED')).toBe(true);
  });

  test('GAT-110 E4 팬 취소와 회차 취소가 같은 표를 동시에 노리면(50회) 매번 하나만 키를 폐기하고 두 차례가 모두 나온다(잠금 줄로 먼저 닿는 쪽을 번갈아 정한다)', async () => {
    // 그냥 함께 부르면 회차 취소가 먼저 행을 잠그는 일이 거의 늘 이겨 팬 취소가 먼저인 차례가 안 나온다(팬 취소는 잠그기 전에 취소 기록을 한 번 더 읽는다).
    // 그래서 셋째 연결이 표 행을 잠근 채로 먼저 보낼 쪽이 잠금을 기다리는 것을 보고 나서 다른 쪽을 보내고, 둘 다 기다릴 때 잠금을 푼다.
    // 둘은 실제로 같은 행을 두고 함께 기다리고, PostgreSQL 행 잠금 줄은 먼저 온 쪽부터 준다
    const waiting = async (n: number) => {
      for (let tries = 0; tries < 1_000; tries++) {
        const r = await database.pool.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'");
        if (r.rows[0]!.n >= n) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`잠금을 기다리는 연결이 ${n}개가 되지 않았다`);
    };
    let fanFirst = 0;
    let eventFirst = 0;
    for (let i = 0; i < 50; i++) {
      const w = await fresh(1);
      const [ticketId] = w.tickets as [string];
      const fan = () => ecService.cancel({ orderId: w.orderId, ticketIds: [ticketId], requestedByAccountId: ACCOUNT, cancellationId: randomUUID(), nowMs: NOW });
      const evt = () => ec(w.eventId, [t(ticketId)]);
      const fanGoesFirst = i % 2 === 0;
      const locker = await database.pool.connect();
      let fanP: ReturnType<typeof fan> | undefined;
      let evtP: ReturnType<typeof evt> | undefined;
      try {
        await locker.query('begin');
        await locker.query('select id from ticket where id = $1 for update', [ticketId]);
        if (fanGoesFirst) fanP = fan();
        else evtP = evt();
        await waiting(1);
        if (fanGoesFirst) evtP = evt();
        else fanP = fan();
        await waiting(2);
      } finally {
        await locker.query('commit').catch(() => undefined);
        locker.release();
      }
      const [fanOut, evtOut] = await Promise.all([fanP!, evtP!]);
      if (fanOut[0]!.result === 'REFUND_NOW') {
        expect(evtOut[0]!.result, `회차 ${i}`).toBe('ALREADY_ENDED');
        fanFirst++;
      } else {
        expect(fanOut[0]!.result, `회차 ${i}`).toBe('ALREADY_CANCELLED');
        expect(evtOut[0]!.result, `회차 ${i}`).toBe('CANCELED');
        eventFirst++;
      }
      // 먼저 잠금에 닿은 쪽이 이긴다
      expect(fanOut[0]!.result === 'REFUND_NOW', `회차 ${i} 먼저 보낸 쪽`).toBe(fanGoesFirst);
      expect(await row(ticketId), `회차 ${i}`).toMatchObject({ status: 'REFUNDED', version: 1 });
      const ended = await database.pool.query<{ result: string }>('select result from ticket_cancellation where ticket_id = $1', [ticketId]);
      expect(ended.rows.map((r) => r.result), `회차 ${i}`).toEqual([fanGoesFirst ? 'REFUND_NOW' : 'EVENT_CANCELED']);
    }
    expect(fanFirst, '팬 취소가 먼저 잡은 경우').toBe(25);
    expect(eventFirst, '회차 취소가 먼저 잡은 경우').toBe(25);
  });
});

// ---- 다시 보기 R1(계획 §11 보충 3, 78d8dbd8): ticket_cancellation.reason(0009)과 첫 칸은 USER 기록만 ----
describe('GAT-080 S3 첫 칸은 사유 USER 기록만 [PostgreSQL]', () => {
  const fresh = async () => {
    const orderId = randomUUID();
    const r = await service.issue({ orderId, eventId: randomUUID(), payerAccountId: ACCOUNT, seatIds: [randomUUID()], issueGeneration: 0 });
    return { orderId, ticketId: r.tickets[0]!.ticketId };
  };
  const cancelWith = (t: { orderId: string; ticketId: string }, cancellationId: string, o: { reason?: string; replayOnly?: boolean; nowMs?: number } = {}) =>
    service.cancel({ orderId: t.orderId, ticketIds: [t.ticketId], requestedByAccountId: ACCOUNT, cancellationId, nowMs: o.nowMs ?? NOW, ...(o.reason === undefined ? {} : { reason: o.reason }), ...(o.replayOnly ? { replayOnly: true } : {}) });
  const reasonOf = async (cancellationId: string, ticketId: string) =>
    (await database.pool.query('select reason from ticket_cancellation where cancellation_id = $1 and ticket_id = $2', [cancellationId, ticketId])).rows[0]?.reason as string | null | undefined;

  test('GAT-080 S3 첫 칸은 사유가 USER인 취소 기록만 싣고 ticket_cancellation.reason에 요청 사유가 남는다(EVENT_POSTPONED·사유 없음은 비움, replay_only도 같다)', async () => {
    const postponed = await fresh();
    const kp = randomUUID();
    await cancelWith(postponed, kp, { reason: 'EVENT_POSTPONED' });
    expect(await reasonOf(kp, postponed.ticketId)).toBe('EVENT_POSTPONED');
    expect(await cancelWith(postponed, randomUUID(), { reason: 'USER', nowMs: NOW + 1_000 })).toEqual([{ ticketId: postponed.ticketId, result: 'ALREADY_CANCELLED' }]);
    expect(await cancelWith(postponed, randomUUID(), { reason: 'USER', replayOnly: true, nowMs: NOW + 2_000 })).toEqual([{ ticketId: postponed.ticketId, result: 'ALREADY_CANCELLED' }]);

    const none = await fresh();
    const kn = randomUUID();
    await cancelWith(none, kn);
    expect(await reasonOf(kn, none.ticketId)).toBeNull();
    expect(await cancelWith(none, randomUUID(), { reason: 'USER', nowMs: NOW + 1_000 })).toEqual([{ ticketId: none.ticketId, result: 'ALREADY_CANCELLED' }]);

    const fan = await fresh();
    const kf = randomUUID();
    await cancelWith(fan, kf, { reason: 'USER' });
    expect(await reasonOf(kf, fan.ticketId)).toBe('USER');
    const first = { cancellationId: kf, result: 'REFUND_NOW', cancelledAtMs: NOW };
    expect(await cancelWith(fan, randomUUID(), { reason: 'USER', nowMs: NOW + 1_000 })).toEqual([{ ticketId: fan.ticketId, result: 'ALREADY_CANCELLED', first }]);
    expect(await cancelWith(fan, randomUUID(), { reason: 'USER', replayOnly: true, nowMs: NOW + 2_000 })).toEqual([{ ticketId: fan.ticketId, result: 'ALREADY_CANCELLED', first }]);
  });

  test('GAT-080 S3 목록 밖 사유(REFUND)는 TicketInputError이고 행·취소 기록이 그대로다', async () => {
    const t = await fresh();
    const k = randomUUID();
    await expect(cancelWith(t, k, { reason: 'REFUND' })).rejects.toBeInstanceOf(TicketInputError);
    expect((await database.pool.query('select status, version from ticket where id = $1', [t.ticketId])).rows[0]).toMatchObject({ status: 'ISSUED', version: 0 });
    expect((await database.pool.query('select count(*)::int as n from ticket_cancellation where ticket_id = $1', [t.ticketId])).rows[0].n).toBe(0);
  });

  test('GAT-080 S3 0009는 ticket_cancellation에 사유 칸 하나(널 허용)와 목록 CHECK만 더한다', async () => {
    const cols = await database.pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
      "select column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'ticket_cancellation' and column_name = 'reason'",
    );
    expect(cols.rows).toEqual([{ column_name: 'reason', data_type: 'text', is_nullable: 'YES' }]);
    const t = await fresh();
    const put = (reason: string | null) =>
      database.pool.query("insert into ticket_cancellation (cancellation_id, ticket_id, order_id, result, cancelled_at, reason) values ($1, $2, $3, 'REFUND_NOW', now(), $4)", [randomUUID(), t.ticketId, t.orderId, reason]);
    for (const reason of ['USER', 'EVENT_CANCELLED', 'EVENT_POSTPONED', 'ACCOUNT_WITHDRAWAL', 'EXCEPTION', 'MINOR_CONTRACT_CANCEL', null]) await put(reason);
    await expect(put('REFUND')).rejects.toMatchObject({ code: '23514' });
  });
});

// ---- BAT-415 검증 2단계 살아남음(계획 '검증' 8): D17·M2-R1d-mig ----
describe('BAT-415 검증 2단계: 첫 칸 조회의 결과 조건과 0009 사유 목록 [PostgreSQL]', () => {
  const fresh = async () => {
    const orderId = randomUUID();
    const r = await service.issue({ orderId, eventId: randomUUID(), payerAccountId: ACCOUNT, seatIds: [randomUUID()], issueGeneration: 0 });
    return { orderId, ticketId: r.tickets[0]!.ticketId };
  };

  test('GAT-080 S3 첫 칸은 결과가 REFUND_NOW·REFUND_AFTER_CLOSE인 사유 USER 기록이다: 더 이른 USER 거절 기록이 있어도 그것이 아니다', async () => {
    const t = await fresh();
    // 더 이른 사유 USER 기록이지만 결과가 표를 끝내지 않은 기록을 SQL로 넣는다(결과 조건이 빠지면 이것이 첫 칸으로 나온다)
    await database.pool.query("insert into ticket_cancellation (cancellation_id, ticket_id, order_id, result, cancelled_at, reason) values ($1, $2, $3, 'TRANSFER_PENDING', $4, 'USER')", [
      randomUUID(),
      t.ticketId,
      t.orderId,
      new Date(NOW - 60_000),
    ]);
    const k1 = randomUUID();
    expect(await service.cancel({ orderId: t.orderId, ticketIds: [t.ticketId], requestedByAccountId: ACCOUNT, cancellationId: k1, nowMs: NOW, reason: 'USER' })).toEqual([{ ticketId: t.ticketId, result: 'REFUND_NOW' }]);
    expect(await service.cancel({ orderId: t.orderId, ticketIds: [t.ticketId], requestedByAccountId: ACCOUNT, cancellationId: randomUUID(), nowMs: NOW + 60_000, reason: 'USER' })).toEqual([
      { ticketId: t.ticketId, result: 'ALREADY_CANCELLED', first: { cancellationId: k1, result: 'REFUND_NOW', cancelledAtMs: NOW } },
    ]);
  });

  test('GAT-080 S3 사유 FRAUD로 CancelTickets를 부르면 받고 ticket_cancellation.reason이 FRAUD다(0009 DB CHECK에 FRAUD)', async () => {
    const t = await fresh();
    const k = randomUUID();
    expect(await service.cancel({ orderId: t.orderId, ticketIds: [t.ticketId], requestedByAccountId: ACCOUNT, cancellationId: k, nowMs: NOW, reason: 'FRAUD' })).toEqual([{ ticketId: t.ticketId, result: 'REFUND_NOW' }]);
    expect((await database.pool.query('select reason from ticket_cancellation where cancellation_id = $1 and ticket_id = $2', [k, t.ticketId])).rows).toEqual([{ reason: 'FRAUD' }]);
  });
});

describe('F-06-3 IR-30 취소 무효의 DB 경계', () => {
  let deviceSeq = 0;
  const scan = (eventId: string, ticketId: string) =>
    database.pool.query(
      `insert into scan_event (id, event_id, ticket_id, scanner_device_id, direction, method, result, scanned_at_device, known_seq, device_seq, received_at)
       values ($1, $2, $3, $4, 'IN', 'QR', 'PASS', now(), 0, $5, now())`,
      [randomUUID(), eventId, ticketId, randomUUID(), ++deviceSeq],
    );
  const statusOf = async (ticketId: string) => (await database.pool.query('select status from ticket where id = $1', [ticketId])).rows[0] as { status: string };

  test('요청한 발권 세대 이하만 VOIDED로 바꾸고 REFUNDED는 덮지 않는다', async () => {
    const orderId = randomUUID();
    const eventId = randomUUID();
    const gen1 = await service.issue({ orderId, eventId, payerAccountId: ACCOUNT, seatIds: [randomUUID()], issueGeneration: 1 });
    const gen2 = await service.issue({ orderId, eventId, payerAccountId: ACCOUNT, seatIds: [randomUUID()], issueGeneration: 2 });
    await scan(eventId, gen1.tickets[0]!.ticketId);
    expect(await service.voidOrderTickets({ orderId, eventId, issueGeneration: 2 })).toEqual({ voided: 2, alreadyEntered: 1 });
    expect((await statusOf(gen1.tickets[0]!.ticketId)).status).toBe('VOIDED');
    expect((await statusOf(gen2.tickets[0]!.ticketId)).status).toBe('VOIDED');

    const refundedOrder = randomUUID();
    const refundedEvent = randomUUID();
    const refunded = await service.issue({ orderId: refundedOrder, eventId: refundedEvent, payerAccountId: ACCOUNT, seatIds: [randomUUID()], issueGeneration: 1 });
    const refundedTicket = refunded.tickets[0]!.ticketId;
    await database.pool.query("update ticket set status = 'REFUNDED' where id = $1", [refundedTicket]);
    await scan(refundedEvent, refundedTicket);
    expect(await service.voidOrderTickets({ orderId: refundedOrder, eventId: refundedEvent, issueGeneration: 1 })).toEqual({ voided: 0, alreadyEntered: 1 });
    expect((await statusOf(refundedTicket)).status).toBe('REFUNDED');
  });
});

