// F-04-13 ticket-svc 실제 PostgreSQL 잠금 경합 시험(동결 로컬, LCH-270·LCH-280, FX-T15).
// 0022의 부분 인덱스와, 잠금·양도 수락이 실제 행 잠금에서 겹쳐도 잠금 커밋 뒤 소유권이 바뀌지 않는지 본다.
// [ASVS v5.0.0-15.4.2] 확인 시점과 사용 시점의 경합 금지.
import { randomUUID } from 'node:crypto';
import { createDatabase, fakeClock, type Database } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateTicket } from '../scripts/migrate.mjs';
import { DrizzleDeviceKeyStore } from '../src/modules/ticket/adapters/db/drizzle-device-key-store.js';
import { DrizzleScannerGateStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-gate-store.js';
import { DrizzleTicketStore } from '../src/modules/ticket/adapters/db/drizzle-ticket-store.js';
import { DrizzleTransferStore } from '../src/modules/ticket/adapters/db/drizzle-transfer-store.js';
import { TicketService } from '../src/modules/ticket/application/ticket-service.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CASE = '0193f2c0-0000-7000-8000-0000000000aa';
const FRIEND = '0193f2c0-0000-7000-8000-0000000000b2';

let pg: PostgresContainer;
let database: Database;
let tickets: DrizzleTicketStore;
let transfers: DrizzleTransferStore;
let service: TicketService;

beforeAll(async () => {
  pg = await startPostgres();
  database = createDatabase({ url: pg.url, applicationName: 'ticket-svc-fraud-race', max: 8 });
  await migrateTicket(pg.url);
  const changes = new DrizzleScannerGateStore(database);
  const deviceKeys = new DrizzleDeviceKeyStore({ database, changes });
  tickets = new DrizzleTicketStore({ database, changes, deviceKeys });
  transfers = new DrizzleTransferStore({ database, deviceKeys });
  service = new TicketService({ store: tickets, clock: fakeClock({ now: NOW }) });
});

afterAll(async () => {
  await database?.close();
  pg?.stop();
});

describe('F-04-13 ticket-svc 실제 잠금 경합', () => {
  test('FX-T15 ㉑ [ASVS v5.0.0-15.4.2] 실제 PostgreSQL에서 잠금과 수락이 겹쳐도 100번 모두 소유권이 잠금을 뚫지 않는다', async () => {
    const count = 100;
    let locks = 0;
    let rejected = 0;
    let changed = 0;
    for (let i = 0; i < count; i++) {
      const payer = randomUUID();
      const eventId = randomUUID();
      const issued = await service.issue({ orderId: randomUUID(), eventId, payerAccountId: payer, seatIds: [randomUUID()], issueGeneration: 0, eventStartsAtMs: NOW + 72 * HOUR });
      const ticketId = issued.tickets[0]!.ticketId;
      const offer = { offerId: randomUUID(), ticketId, fromAccountId: payer, toAccountId: FRIEND, status: 'OFFERED' as const, expiresAtMs: NOW + 48 * HOUR, createdAtMs: NOW };
      expect((await transfers.createOffer(offer, NOW)).kind).toBe('CREATED');
      const [lock, accept] = await Promise.all([
        transfers.setTransferLock({ caseId: CASE, version: i + 1, locked: true, eventId, accountIds: [payer], expiresAtMs: NOW + 14 * DAY, nowMs: NOW }),
        transfers.accept({ offerId: offer.offerId, accountId: FRIEND, nowMs: NOW }),
      ]);
      if (lock[0]?.result === 'LOCKED') locks += 1;
      if (accept.kind === 'REJECTED') rejected += 1;
      const row = await database.pool.query('select account_id, fraud_lock_case_id from ticket where id=$1', [ticketId]);
      // 잠금이 먼저 커밋됐으면 수락은 거절되고 소유자는 결제자 그대로여야 한다. 수락이 먼저면 잠금이 새 보유자 표에 걸린다
      if (accept.kind === 'REJECTED' && (row.rows[0].account_id !== payer || row.rows[0].fraud_lock_case_id !== CASE)) changed += 1;
    }
    expect(locks).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
    expect(changed).toBe(0);
  }, 120_000);

  test('FX-T15 ㉓ DrizzleTransferStore.expireFraudLocks가 실제 DB의 표·잠금 행을 정리한다', async () => {
    const payer = randomUUID();
    const eventId = randomUUID();
    const issued = await service.issue({ orderId: randomUUID(), eventId, payerAccountId: payer, seatIds: [randomUUID()], issueGeneration: 0, eventStartsAtMs: NOW + HOUR });
    const ticketId = issued.tickets[0]!.ticketId;
    await transfers.setTransferLock({ caseId: CASE, version: 1, locked: true, eventId, accountIds: [payer], expiresAtMs: NOW + 14 * DAY, nowMs: NOW });
    const before = await database.pool.query('select fraud_lock_case_id, fraud_lock_version from ticket where id=$1', [ticketId]);
    expect(before.rows[0].fraud_lock_case_id).toBe(CASE);
    const expire = (transfers as unknown as { expireFraudLocks(nowMs: number): Promise<number> }).expireFraudLocks;
    expect(expire).toBeTypeOf('function');
    await expire.call(transfers, NOW + 2 * HOUR);
    const after = await database.pool.query('select fraud_lock_case_id, fraud_lock_version from ticket where id=$1', [ticketId]);
    expect(after.rows[0].fraud_lock_case_id).toBeNull();
    expect(Number(after.rows[0].fraud_lock_version)).toBeGreaterThan(Number(before.rows[0].fraud_lock_version));
    const lock = await database.pool.query('select locked from fraud_transfer_lock where case_id=$1 and event_id=$2 and account_id=$3', [CASE, eventId, payer]);
    expect(lock.rows[0].locked).toBe(false);
  });

  test('FX-T15 ㉒ 마이그레이션 0022의 잠금 만료 정비 인덱스가 실제 DB에 있다', async () => {
    const rows = await database.pool.query("select indexname from pg_indexes where tablename in ('fraud_transfer_lock','ticket')");
    const names = rows.rows.map((r) => r.indexname);
    expect(names).toContain('fraud_transfer_lock_expires_idx');
    expect(names).toContain('ticket_fraud_lock_idx');
  });
});
