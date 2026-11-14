// ticket-svc 버전 벡터·동기화 신선도 실제 PostgreSQL 18 통합 시험(BUILD_ORDER GAT-160, R-573).
// 0004 적용·재적용, 종류별 seq·issuedAt·maxOfflineMs, STALE_VERSION CHECK, 회차·모양 검증, resyncRequired·staleIds를 본다.
import { createDatabase, fakeClock, type Database } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateTicket } from '../scripts/migrate.mjs';
import { DrizzleScannerGateStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-gate-store.js';
import { ScannerGate } from '../src/modules/scanner/application/scanner-gate.js';
import type { ScannerVersionVector } from '../src/modules/scanner/domain/scanner-gate.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const NOW = Date.parse('2026-11-14T03:00:00.000Z');
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000001';
const OTHER = '0190f3a1-7c2e-7a00-8000-000000000002';
const TICKET = '0190f3a1-7c2e-7a00-8000-000000000011';
const SEAT = '0190f3a1-7c2e-7a00-8000-000000000021';
const DEVICE = '0190f3a1-7c2e-7a00-8000-000000000031';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000041';
const SESSION = '0190f3a1-7c2e-7a00-8000-000000000051';
const MAX = 24 * 60 * 60_000;

let pg: PostgresContainer;
let database: Database;
let store: DrizzleScannerGateStore;
let clock: ReturnType<typeof fakeClock>;
let gate: ScannerGate;

const vector = (over: Partial<ScannerVersionVector> = {}): ScannerVersionVector => ({
  eventId: EVENT,
  seq: 0,
  ticketSeq: 0,
  keySeq: 0,
  policySeq: 0,
  placementSeq: 0,
  flagSeq: 0,
  issuedAt: new Date(NOW).toISOString(),
  maxOfflineMs: MAX,
  ...over,
});

const scan = (over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  eventId: EVENT,
  ticketId: TICKET,
  scannerSessionId: SESSION,
  direction: 'IN',
  method: 'QR',
  result: 'PASS',
  gateZone: '동문',
  scannedAtDevice: new Date(NOW).toISOString(),
  knownSeq: 0,
  deviceSeq: 1,
  ...over,
});

beforeAll(async () => {
  pg = await startPostgres();
  await migrateTicket(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'ticket-gat160-int', max: 4 });
  store = new DrizzleScannerGateStore(database);
  clock = fakeClock({ now: NOW });
  gate = new ScannerGate({ store, clock, maxOfflineMs: MAX });
  await database.pool.query(
    `insert into ticket (id, account_id, payer_account_id, order_id, event_id, seat_id, gate_zone, status, issue_generation, qr_payload, key_hash, created_at)
     values ($1, $2, $2, $3, $4, $5, '동문', 'ACTIVE', 0, $6, 'hash', now())`,
    [TICKET, ACCOUNT, '0190f3a1-7c2e-7a00-8000-000000000061', EVENT, SEAT, `PEAKET1:${TICKET}`],
  );
  for (const [kind, payload] of [
    ['TICKET_STATUS', { v: 1, ticketId: TICKET, status: 'ACTIVE' }],
    ['KEY_REGISTERED', { v: 1, ticketId: TICKET, keyId: 'AAAAAAAAAAA' }],
    ['KEY_REVOKED', { v: 1, ticketId: TICKET, keyId: 'BBBBBBBBBBB' }],
    ['POLICY', { v: 1, reentryAllowed: false }],
    ['PLACEMENT', { v: 1, gateZone: '동문' }],
    ['FLAG', { v: 1, flagId: randomUUID() }],
  ] as const) {
    await database.transaction((tx) => store.append(tx, EVENT, kind, payload));
  }
});

afterAll(async () => {
  await database?.close().catch(() => {});
  pg?.stop();
});

describe('버전 벡터 PostgreSQL [GAT-160]', () => {
  test('0004를 적용·재적용해도 같고 인덱스·STALE_VERSION CHECK가 있다', async () => {
    expect(await migrateTicket(pg.url)).toEqual([]);
    const idx = await database.pool.query("select indexname from pg_indexes where schemaname='public' and tablename='scanner_change' and indexname='scanner_change_event_kind_seq_idx'");
    expect(idx.rows).toEqual([{ indexname: 'scanner_change_event_kind_seq_idx' }]);
    const checks = await database.pool.query("select conname, pg_get_constraintdef(oid) as def from pg_constraint where conname in ('scan_event_flag_check','gate_flag_kind_check')");
    expect(checks.rows.map((r) => r.def).join('\n')).toContain('STALE_VERSION');
    expect((await database.pool.query("insert into gate_flag (id, event_id, ticket_id, kind, awareness, status, created_at) values ($1, $2, $3, 'STALE_VERSION', 'KNOWN', 'OPEN', now()) returning id", [randomUUID(), EVENT, TICKET])).rows).toHaveLength(1);
    await expect(database.pool.query("insert into gate_flag (id, event_id, ticket_id, kind, awareness, status, created_at) values ($1, $2, $3, 'NOPE', 'KNOWN', 'OPEN', now())", [randomUUID(), EVENT, TICKET])).rejects.toThrow(/gate_flag_kind_check/);
  });

  test('package·changes가 종류별 마지막 seq와 issuedAt·maxOfflineMs를 준다', async () => {
    const p = await gate.package(EVENT, EVENT);
    expect(p.versionVector).toMatchObject({
      eventId: EVENT,
      seq: 6,
      ticketSeq: 1,
      keySeq: 3,
      policySeq: 4,
      placementSeq: 5,
      flagSeq: 6,
      issuedAt: new Date(NOW).toISOString(),
      maxOfflineMs: MAX,
    });
    const c = await gate.changes(EVENT, 0, 10, EVENT);
    expect(c.versionVector).toMatchObject({ eventId: EVENT, seq: 6, ticketSeq: 1, keySeq: 3, policySeq: 4, placementSeq: 5, flagSeq: 6 });
  });

  test('스캔 업로드의 낡은 벡터는 STALE_VERSION·resyncRequired·staleIds로 남고, 신선한 벡터는 통과한다', async () => {
    const stale = scan({ versionVector: vector({ issuedAt: new Date(NOW - MAX - 1).toISOString() }) });
    const r = await gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, body: [stale] });
    expect(r).toMatchObject({ resyncRequired: true, staleIds: [stale.id] });
    expect(r.flags).toEqual([expect.objectContaining({ kind: 'STALE_VERSION' })]);

    const fresh = scan({ direction: 'OUT', versionVector: vector() });
    const r2 = await gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, body: [fresh] });
    expect(r2).toMatchObject({ resyncRequired: false, staleIds: [] });
    expect(r2.flags).toEqual([]);
  });

  test('다른 회차 벡터·모양이 틀린 벡터는 400으로 거절한다', async () => {
    const wrongEvent = scan({ versionVector: vector({ eventId: OTHER }) });
    await expect(gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, body: [wrongEvent] })).rejects.toThrow();
    const bad = scan({ versionVector: { ...vector(), seq: -1 } });
    await expect(gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, body: [bad] })).rejects.toThrow();
  });
});
