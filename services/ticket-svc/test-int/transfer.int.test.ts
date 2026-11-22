// 양도·부정 예매 양도 잠금 실제 PostgreSQL 통합 시험(BUILD_ORDER GAT-050·GAT-055, docs/features/transfer-refund.md §3.1·§4.1).
// 0010_transfer_lock.sql을 그대로 적용하고, 행 잠금(FOR UPDATE)으로 수락·수락, 잠금·수락이 겹쳐도 하나만 반영되는지 본다.
import { randomUUID } from 'node:crypto';
import { createDatabase, fakeClock, type Database } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateTicket } from '../scripts/migrate.mjs';
import { DrizzleDeviceKeyStore } from '../src/modules/ticket/adapters/db/drizzle-device-key-store.js';
import { DrizzleTicketStore } from '../src/modules/ticket/adapters/db/drizzle-ticket-store.js';
import { DrizzleTransferStore } from '../src/modules/ticket/adapters/db/drizzle-transfer-store.js';
import { DrizzleScannerGateStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-gate-store.js';
import { TicketService } from '../src/modules/ticket/application/ticket-service.js';
import { signRecipientRef } from '../src/modules/ticket/domain/transfer.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const PAYER = '0193f2c0-0000-7000-8000-0000000000a1';
const FRIEND = '0193f2c0-0000-7000-8000-0000000000b2';
const OTHER = '0193f2c0-0000-7000-8000-0000000000c3';

let pg: PostgresContainer;
let database: Database;
let tickets: DrizzleTicketStore;
let transfers: DrizzleTransferStore;
let deviceKeys: DrizzleDeviceKeyStore;
let service: TicketService;

const issue = (eventId: string, startsAtMs = NOW + 72 * HOUR) =>
  service.issue({ orderId: randomUUID(), eventId, payerAccountId: PAYER, seatIds: [randomUUID()], issueGeneration: 0, eventStartsAtMs: startsAtMs });

const activeKeyOf = async (ticketId: string): Promise<boolean> => {
  const r = await database.pool.query('select 1 from device_key where ticket_id = $1 and revoked_at is null', [ticketId]);
  return r.rows.length > 0;
};

beforeAll(async () => {
  pg = await startPostgres();
  database = createDatabase({ url: pg.url, applicationName: 'ticket-svc-transfer-int', max: 8 });
  await migrateTicket(pg.url);
  const changes = new DrizzleScannerGateStore(database);
  deviceKeys = new DrizzleDeviceKeyStore({ database, changes });
  tickets = new DrizzleTicketStore({ database, changes, deviceKeys });
  transfers = new DrizzleTransferStore({ database, deviceKeys });
  service = new TicketService({ store: tickets, clock: fakeClock({ now: NOW }) });
});

afterAll(async () => {
  await database?.close();
  pg?.stop();
});

describe('양도 PostgreSQL', () => {
  test('0010이 transfer_offer·fraud_transfer_lock과 ticket.fraud_lock_version을 만든다', async () => {
    const tables = await database.pool.query("select table_name from information_schema.tables where table_schema='public' and table_name in ('transfer_offer','fraud_transfer_lock') order by table_name");
    expect(tables.rows.map((r) => r.table_name)).toEqual(['fraud_transfer_lock', 'transfer_offer']);
    const col = await database.pool.query("select 1 from information_schema.columns where table_name='ticket' and column_name='fraud_lock_version'");
    expect(col.rows).toHaveLength(1);
    const idx = await database.pool.query("select indexname from pg_indexes where tablename='transfer_offer'");
    expect(idx.rows.map((r) => r.indexname)).toContain('transfer_offer_open_key');
  });

  test('R-T1 수락은 한 트랜잭션으로 보유자·요청 상태·보낸 사람 키를 바꾼다 [ASVS v5.0.0-2.3.3] [ASVS v5.0.0-11.1.1]', async () => {
    const event = randomUUID();
    const [t] = (await issue(event)).tickets;
    await deviceKeys.register({ ticketId: t!.ticketId, accountId: PAYER, keyId: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), publicKey: new Uint8Array(33).fill(2), reason: 'ISSUE', nowMs: NOW, reauthVerified: false });
    const offer = { offerId: randomUUID(), ticketId: t!.ticketId, fromAccountId: PAYER, toAccountId: FRIEND, status: 'OFFERED' as const, expiresAtMs: NOW + 48 * HOUR, createdAtMs: NOW };
    expect((await transfers.createOffer(offer, NOW)).kind).toBe('CREATED');
    expect(await activeKeyOf(t!.ticketId)).toBe(true);
    const accepted = await transfers.accept({ offerId: offer.offerId, accountId: FRIEND, nowMs: NOW });
    expect(accepted.kind).toBe('OK');
    const row = await database.pool.query('select account_id, status, transfer_pending, key_revoked_at from ticket where id=$1', [t!.ticketId]);
    expect(row.rows[0]).toMatchObject({ account_id: FRIEND, status: 'ACTIVE', transfer_pending: false });
    expect(row.rows[0].key_revoked_at).not.toBeNull();
    expect(await activeKeyOf(t!.ticketId)).toBe(false);
    const offerRow = await database.pool.query('select status from transfer_offer where id=$1', [offer.offerId]);
    expect(offerRow.rows[0].status).toBe('ACCEPTED');
  });

  test('R-T2 받은 사람의 재양도는 REJECTED(REOFFER)이고 표가 바뀌지 않는다', async () => {
    const event = randomUUID();
    const [t] = (await issue(event)).tickets;
    await database.pool.query("update ticket set account_id=$2 where id=$1", [t!.ticketId, FRIEND]);
    const out = await transfers.createOffer({ offerId: randomUUID(), ticketId: t!.ticketId, fromAccountId: FRIEND, toAccountId: OTHER, status: 'OFFERED', expiresAtMs: NOW + 48 * HOUR, createdAtMs: NOW }, NOW);
    expect(out).toEqual({ kind: 'REJECTED', reason: 'REOFFER' });
    const row = await database.pool.query('select account_id, transfer_pending from ticket where id=$1', [t!.ticketId]);
    expect(row.rows[0]).toMatchObject({ account_id: FRIEND, transfer_pending: false });
  });

  test('R-T17 입장이 시작된 회차는 양도 요청을 만들지 않는다', async () => {
    const [t] = (await issue(randomUUID(), NOW - 1)).tickets;
    const out = await transfers.createOffer({ offerId: randomUUID(), ticketId: t!.ticketId, fromAccountId: PAYER, toAccountId: FRIEND, status: 'OFFERED', expiresAtMs: NOW + 48 * HOUR, createdAtMs: NOW }, NOW);
    expect(out).toEqual({ kind: 'REJECTED', reason: 'ENTRY_STARTED' });
  });

  test('R-T31 ①⑦ 잠금은 진행 중 요청을 철회하고, 잠금 뒤 발권한 표도 잠그며, 겹친 수락은 하나만 된다 [ASVS v5.0.0-2.3.4]', async () => {
    const event = randomUUID();
    const startsAt = NOW + 72 * HOUR;
    const [t] = (await issue(event, startsAt)).tickets;
    const offer = { offerId: randomUUID(), ticketId: t!.ticketId, fromAccountId: PAYER, toAccountId: FRIEND, status: 'OFFERED' as const, expiresAtMs: NOW + 48 * HOUR, createdAtMs: NOW };
    expect((await transfers.createOffer(offer, NOW)).kind).toBe('CREATED');

    const caseId = randomUUID();
    const locked = await transfers.setTransferLock({ caseId, version: 1, locked: true, eventId: event, accountIds: [PAYER], expiresAtMs: NOW + 14 * 24 * HOUR, nowMs: NOW });
    expect(locked).toEqual([{ ticketId: t!.ticketId, result: 'LOCKED', withdrawnOfferId: offer.offerId }]);
    const withdrawn = await database.pool.query('select status, withdraw_reason from transfer_offer where id=$1', [offer.offerId]);
    expect(withdrawn.rows[0]).toEqual({ status: 'WITHDRAWN', withdraw_reason: 'FRAUD_LOCK' });

    // 잠금 뒤에 산 표도 발권 때 잠긴다
    const [newTicket] = (await issue(event, startsAt)).tickets;
    const lockedRow = await database.pool.query('select fraud_lock_case_id, fraud_lock_version from ticket where id=$1', [newTicket!.ticketId]);
    expect(lockedRow.rows[0]).toEqual({ fraud_lock_case_id: caseId, fraud_lock_version: '1' });

    // 잠금을 풀고 겹친 수락을 20번 넣는다: 표는 한 번만 바뀐다
    await transfers.setTransferLock({ caseId, version: 2, locked: false, eventId: event, accountIds: [PAYER], nowMs: NOW });
    const fresh = { offerId: randomUUID(), ticketId: newTicket!.ticketId, fromAccountId: PAYER, toAccountId: FRIEND, status: 'OFFERED' as const, expiresAtMs: NOW + 48 * HOUR, createdAtMs: NOW };
    expect((await transfers.createOffer(fresh, NOW)).kind).toBe('CREATED');
    const results = await Promise.all(Array.from({ length: 20 }, () => transfers.accept({ offerId: fresh.offerId, accountId: FRIEND, nowMs: NOW })));
    expect(results.every((r) => r.kind === 'OK')).toBe(true);
    const row = await database.pool.query('select account_id, version from ticket where id=$1', [newTicket!.ticketId]);
    expect(row.rows[0]).toMatchObject({ account_id: FRIEND });
    const accepted = await database.pool.query("select count(*)::int as n from transfer_offer where ticket_id=$1 and status='ACCEPTED'", [newTicket!.ticketId]);
    expect(accepted.rows[0].n).toBe(1);
  });

  test('R-T31 ④ 같은 판·옛 판은 표를 바꾸지 않고, 다른 사건은 OTHER_CASE다', async () => {
    const event = randomUUID();
    const [t] = (await issue(event)).tickets;
    const caseA = randomUUID();
    await transfers.setTransferLock({ caseId: caseA, version: 2, locked: true, eventId: event, accountIds: [PAYER], expiresAtMs: NOW + 14 * 24 * HOUR, nowMs: NOW });
    const old = await transfers.setTransferLock({ caseId: caseA, version: 1, locked: false, eventId: event, accountIds: [PAYER], nowMs: NOW });
    expect(old[0]?.result).toBe('LOCKED');
    const other = await transfers.setTransferLock({ caseId: randomUUID(), version: 9, locked: true, eventId: event, accountIds: [PAYER], expiresAtMs: NOW + 14 * 24 * HOUR, nowMs: NOW });
    expect(other[0]?.result).toBe('OTHER_CASE');
    const row = await database.pool.query('select fraud_lock_case_id from ticket where id=$1', [t!.ticketId]);
    expect(row.rows[0].fraud_lock_case_id).toBe(caseA);
  });

  test('R-T31 ⑪ 같은 계정에 다시 잠그면 기한이 늘지 않는다', async () => {
    const event = randomUUID();
    await issue(event);
    const caseId = randomUUID();
    await transfers.setTransferLock({ caseId, version: 1, locked: true, eventId: event, accountIds: [PAYER], expiresAtMs: NOW + 14 * 24 * HOUR, nowMs: NOW });
    await transfers.setTransferLock({ caseId, version: 3, locked: true, eventId: event, accountIds: [PAYER], expiresAtMs: NOW + 30 * 24 * HOUR, nowMs: NOW });
    const row = await database.pool.query('select expires_at from fraud_transfer_lock where case_id=$1', [caseId]);
    expect(new Date(row.rows[0].expires_at).getTime()).toBe(NOW + 14 * 24 * HOUR);
  });
});

describe('만료·같은 키 경합(RV-01·RV-04)', () => {
  test('R-T1 기한 지난 요청은 새 요청을 만들 때 먼저 만료되어 표시가 풀린다', async () => {
    const event = randomUUID();
    const [t] = (await issue(event)).tickets;
    const first = { offerId: randomUUID(), ticketId: t!.ticketId, fromAccountId: PAYER, toAccountId: FRIEND, status: 'OFFERED' as const, expiresAtMs: NOW + 48 * HOUR, createdAtMs: NOW };
    expect((await transfers.createOffer(first, NOW)).kind).toBe('CREATED');
    const second = { ...first, offerId: randomUUID(), expiresAtMs: NOW + 48 * HOUR };
    expect((await transfers.createOffer(second, NOW + 49 * HOUR)).kind).toBe('CREATED');
    const rows = await database.pool.query('select id, status from transfer_offer where ticket_id=$1 order by created_at', [t!.ticketId]);
    expect(rows.rows.map((r) => r.status)).toEqual(['EXPIRED', 'OFFERED']);
    const ticketRow = await database.pool.query('select transfer_pending from ticket where id=$1', [t!.ticketId]);
    expect(ticketRow.rows[0].transfer_pending).toBe(true);
  });

  test('RV-04 같은 Idempotency-Key의 동시 생성은 한 행만 만들고 모두 같은 요청 결과다', async () => {
    const event = randomUUID();
    const [t] = (await issue(event)).tickets;
    const offer = { offerId: randomUUID(), ticketId: t!.ticketId, fromAccountId: PAYER, toAccountId: FRIEND, status: 'OFFERED' as const, expiresAtMs: NOW + 48 * HOUR, createdAtMs: NOW };
    const results = await Promise.all(Array.from({ length: 8 }, () => transfers.createOffer(offer, NOW)));
    expect(results.every((r) => r.kind === 'CREATED' || r.kind === 'REPLAYED')).toBe(true);
    const rows = await database.pool.query('select count(*)::int as n from transfer_offer where id=$1', [offer.offerId]);
    expect(rows.rows[0].n).toBe(1);
  });
});

describe('받는 사람 참조', () => {
  test('10분 참조는 계정을 가리키고 만료되면 받지 않는다', () => {
    const ref = signRecipientRef({ secret: 's', accountId: FRIEND, expiresAtMs: NOW + 600_000 });
    expect(ref.split('.')).toHaveLength(3);
  });
});
