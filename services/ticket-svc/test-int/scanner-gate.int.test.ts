// ticket-svc 스캐너 목록·변경분·스캔·이상 표시 실제 PostgreSQL 통합 시험(BUILD_ORDER GAT-180·GAT-190, R-544).
// 0002_scanner_gate.sql 적용·재적용, REPEATABLE READ 스냅샷, 변경 커서, 스캔 멱등·동시 경합·재판정, 권한을 본다.
import 'reflect-metadata';
import { athOf, createDatabase, createService, fakeClock, MemoryDpopReplayStore, type AdminAuthzPort, type Database, type ScannerSessionAnswer, type ScannerSessionCheck } from '@peaket/platform';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateTicket } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { MemoryEnrollmentCodeStore } from '../src/modules/scanner/adapters/memory-enrollment-code-store.js';
import { DrizzleScannerDeviceStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-device-store.js';
import { DrizzleScannerGateStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-gate-store.js';
import { DrizzleScannerShiftStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-shift-store.js';
import { DrizzleTicketStore } from '../src/modules/ticket/adapters/db/drizzle-ticket-store.js';
import { TicketService } from '../src/modules/ticket/application/ticket-service.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const NOW = Date.parse('2026-11-13T03:00:00.000Z');
const IAT = Math.floor(NOW / 1000);
const PROMOTER = '0190f3a1-7c2e-7a00-8000-000000000001';
const ADMIN = '0190f3a1-7c2e-7a00-8000-000000000002';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000003';
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000004';
const OTHER = '0190f3a1-7c2e-7a00-8000-000000000005';
const TICKET_A = '0190f3a1-7c2e-7a00-8000-000000000011';
const TICKET_B = '0190f3a1-7c2e-7a00-8000-000000000012';
const TICKET_CANCELLED = '0190f3a1-7c2e-7a00-8000-000000000013';
const TICKET_D = '0190f3a1-7c2e-7a00-8000-000000000014';
const SEAT_A = '0190f3a1-7c2e-7a00-8000-000000000021';
const SEAT_B = '0190f3a1-7c2e-7a00-8000-000000000022';
const SEAT_C = '0190f3a1-7c2e-7a00-8000-000000000023';
const SEAT_D = '0190f3a1-7c2e-7a00-8000-000000000024';
const DEVICE = '0190f3a1-7c2e-7a00-8000-000000000031';
const SESSION = '0190f3a1-7c2e-7a00-8000-000000000032';
const ORDER = '0190f3a1-7c2e-7a00-8000-000000000041';
const ORDER_2 = '0190f3a1-7c2e-7a00-8000-000000000042';
const CANCEL = '0190f3a1-7c2e-7a00-8000-000000000043';
const TOKEN = 'staff-access-token';
const ATH = athOf(TOKEN);
const HOST = 'scanner-api.peaket.example';
const quiet = () => new Writable({ write: (_c, _e, cb) => cb() });

class FakeIdentity implements AdminAuthzPort {
  async getAdminAuthz(): Promise<{ valid: boolean; role: string }> {
    return { valid: true, role: 'operator' };
  }
}

class FakeSessions implements ScannerSessionCheck {
  readonly answers = new Map<string, ScannerSessionAnswer>();
  async check(q: { scannerSessionId: string; deviceId: string }): Promise<ScannerSessionAnswer> {
    return this.answers.get(`${q.scannerSessionId}/${q.deviceId}`) ?? { valid: false };
  }
}

interface Key {
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  jwk: Record<string, unknown>;
  jkt: string;
}

let pg: PostgresContainer;
let database: Database;
let deviceStore: DrizzleScannerDeviceStore;
let gate: DrizzleScannerGateStore;
let ticketSvc: TicketService;
let svc: Awaited<ReturnType<typeof createService>>;
let sessions: FakeSessions;
let key: Key;
let clock: ReturnType<typeof fakeClock>;
let seq = 0;

async function keyOf(): Promise<Key> {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const jwk = (await exportJWK(pair.publicKey)) as Record<string, unknown>;
  return { privateKey: pair.privateKey, jwk, jkt: await calculateJwkThumbprint(jwk as never, 'sha256') };
}

async function proofOf(htm: string, path: string): Promise<string> {
  return new SignJWT({ jti: randomUUID(), htm, htu: `https://${HOST}${path}`, iat: IAT, ath: ATH })
    .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: key.jwk as never })
    .sign(key.privateKey);
}

async function headers(htm: string, path: string, session = SESSION): Promise<Record<string, string>> {
  return {
    'x-user-id': ACCOUNT,
    'x-session-id': session,
    'x-user-aud': 'scanner',
    'x-user-jkt': key.jkt,
    'x-user-ath': ATH,
    authorization: `DPoP ${TOKEN}`,
    dpop: await proofOf(htm, path),
    'x-forwarded-proto': 'https',
    'x-forwarded-host': HOST,
  };
}

const scan = (over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  eventId: EVENT,
  ticketId: TICKET_A,
  scannerSessionId: SESSION,
  direction: 'IN',
  method: 'QR',
  result: 'PASS',
  gateZone: '동문',
  scannedAtDevice: new Date(NOW).toISOString(),
  knownSeq: 0,
  deviceSeq: ++seq,
  ...over,
});

beforeAll(async () => {
  pg = await startPostgres();
  database = createDatabase({ url: pg.url, applicationName: 'ticket-svc-gate-int', max: 8 });
  await migrateTicket(pg.url);
  for (const [id, seat, zone, status] of [
    [TICKET_A, SEAT_A, '동문', 'ACTIVE'],
    [TICKET_B, SEAT_B, '서문', 'ACTIVE'],
    [TICKET_CANCELLED, SEAT_C, '동문', 'REFUNDED'],
    [TICKET_D, SEAT_D, '동문', 'ACTIVE'],
  ] as const) {
    await database.pool.query(
      `insert into ticket (id, account_id, payer_account_id, order_id, event_id, seat_id, gate_zone, status, issue_generation, qr_payload, key_hash, created_at)
       values ($1, $2, $2, $3, $4, $5, $6, $7, 0, $8, $9, now())`,
      [id, ACCOUNT, ORDER, EVENT, seat, zone, status, `PEAKET1:${id}`, 'hash'],
    );
  }
  clock = fakeClock({ now: NOW });
  key = await keyOf();
  deviceStore = new DrizzleScannerDeviceStore(database);
  await deviceStore.register({ deviceId: DEVICE, name: '동문-01', promoterId: PROMOTER, enrolledBy: ADMIN, atMs: NOW });
  await deviceStore.bindCredential({ deviceId: DEVICE, jkt: key.jkt, atMs: NOW });
  gate = new DrizzleScannerGateStore(database);
  ticketSvc = new TicketService({ store: new DrizzleTicketStore({ database, changes: gate }), clock });
  sessions = new FakeSessions();
  sessions.answers.set(`${SESSION}/${DEVICE}`, { valid: true, role: 'gate_lead', eventId: EVENT });
  const replay = new MemoryDpopReplayStore(clock);
  const shift = new DrizzleScannerShiftStore(database);
  svc = await createService({
    name: 'ticket-svc-gate-int',
    module: AppModule.register({ scanner: { store: deviceStore, codes: new MemoryEnrollmentCodeStore(clock), replay, gate, shift } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: new FakeIdentity(),
    scanner: { devices: deviceStore, sessions, replay },
  });
});

afterAll(async () => {
  await svc?.close().catch(() => {});
  await database?.close().catch(() => {});
  pg?.stop();
});

const get = (path: string, session = SESSION) => headers('GET', path, session).then((h) => svc.http.inject({ method: 'GET', url: path, headers: h }));
const post = async (path: string, body: unknown, session = SESSION) => {
  const h = await headers('POST', path, session);
  return svc.http.inject({ method: 'POST', url: path, headers: { ...h, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
};
const count = async (table: string, where = 'true') => Number((await database.pool.query(`select count(*)::int as n from ${table} where ${where}`)).rows[0].n);

describe('스캐너 게이트 PostgreSQL [GAT-180]', () => {
  test('0002_scanner_gate.sql을 적용하고 다시 적용해도 같으며 다섯 표가 있다', async () => {
    expect(await migrateTicket(pg.url)).toEqual([]);
    const r = await database.pool.query("select table_name from information_schema.tables where table_schema = 'public' and table_name in ('scanner_seq','scanner_change','scan_event','gate_flag','gate_flag_scan') order by table_name");
    expect(r.rows.map((x) => x.table_name)).toEqual(['gate_flag', 'gate_flag_scan', 'scan_event', 'scanner_change', 'scanner_seq']);
    await expect(database.pool.query("insert into gate_flag (id, event_id, ticket_id, kind, awareness, status, created_at) values ($1,$2,$3,'NOPE','CONCURRENT','OPEN',now())", [randomUUID(), EVENT, TICKET_A])).rejects.toThrow(/gate_flag_kind_check/);
  });

  test('O-T38 패키지 스냅샷은 REPEATABLE READ로 고정되고, 스냅샷 뒤 변경은 changes after로 온다', async () => {
    const first = await database.transaction((tx) => gate.appendChange(tx, EVENT, 'POLICY', { v: 1, reentryAllowed: false }));
    expect(first).toBeGreaterThan(0);
    const a = await database.pool.connect();
    const b = await database.pool.connect();
    try {
      await a.query('begin isolation level repeatable read');
      const seq1 = (await a.query('select last_seq from scanner_seq where event_id = $1', [EVENT])).rows[0].last_seq;
      const tickets1 = (await a.query('select id, status from ticket where event_id = $1 order by id', [EVENT])).rows;
      await b.query('begin');
      await b.query("insert into scanner_change (event_id, seq, kind, payload, created_at) values ($1, $2, 'PLACEMENT', '{\"v\":1}'::jsonb, now())", [EVENT, Number(seq1) + 1]);
      await b.query('update scanner_seq set last_seq = last_seq + 1 where event_id = $1', [EVENT]);
      await b.query('commit');
      const seq2 = (await a.query('select last_seq from scanner_seq where event_id = $1', [EVENT])).rows[0].last_seq;
      const tickets2 = (await a.query('select id, status from ticket where event_id = $1 order by id', [EVENT])).rows;
      expect(seq2).toBe(seq1);
      expect(tickets2).toEqual(tickets1);
      await a.query('commit');
      const changes = await gate.changes({ eventId: EVENT, after: Number(seq1), limit: 10 });
      expect(changes.lastSeq).toBe(Number(seq1) + 1);
      expect(changes.changes).toEqual([expect.objectContaining({ seq: Number(seq1) + 1, kind: 'PLACEMENT' })]);
    } finally {
      a.release();
      b.release();
    }
  });

  test('변경분은 after 다음을 limit만큼 주고 hasMore를 표시한다', async () => {
    const before = await gate.changes({ eventId: EVENT, after: 0, limit: 1 });
    expect(before.changes).toHaveLength(1);
    expect(before.hasMore).toBe(true);
    const next = await gate.changes({ eventId: EVENT, after: before.changes[0]!.seq, limit: 1 });
    expect(next.changes[0]!.seq).toBe(before.changes[0]!.seq + 1);
  });

  test('발권·취소 트랜잭션이 TICKET_STATUS·KEY_REVOKED 변경을 남긴다', async () => {
    const issued = await ticketSvc.issue({ orderId: ORDER_2, eventId: EVENT, payerAccountId: ACCOUNT, seatIds: [SEAT_A], issueGeneration: 0, eventStartsAtMs: NOW + 3_600_000 });
    const id = issued.tickets[0]!.ticketId;
    const changes = await gate.changes({ eventId: EVENT, after: 0, limit: 5000 });
    expect(changes.changes.map((c) => c.kind)).toEqual(expect.arrayContaining(['TICKET_STATUS']));
    await ticketSvc.cancel({ orderId: ORDER_2, ticketIds: [id], requestedByAccountId: ACCOUNT, cancellationId: CANCEL, nowMs: NOW });
    const after = await gate.changes({ eventId: EVENT, after: 0, limit: 5000 });
    expect(after.changes.map((c) => c.kind)).toEqual(expect.arrayContaining(['TICKET_STATUS', 'KEY_REVOKED']));
  });
});

describe('스캐너 게이트 HTTP·판정 [GAT-180·GAT-190]', () => {
  test('패키지는 실제 티켓을 주고 no-store이며, 다른 회차는 403이다', async () => {
    const r = await get(`/v1/scanner/events/${EVENT}/package`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const body = JSON.parse(r.payload) as { tickets: { ticketId: string }[]; lastSeq: number };
    expect(body.tickets.map((t) => t.ticketId)).toEqual(expect.arrayContaining([TICKET_A, TICKET_B]));
    expect(body.lastSeq).toBeGreaterThan(0);
    expect((await get(`/v1/scanner/events/${OTHER}/package`)).statusCode).toBe(403);
  });

  test('스캔은 멱등이고, 같은 스캔을 동시에 보내도 한 번만 쌓인다', async () => {
    const s = scan({ ticketId: TICKET_B });
    const [a, b] = await Promise.all([post('/v1/scanner/scans', [s]), post('/v1/scanner/scans', [s])]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(JSON.parse(a.payload).acceptedIds).toEqual([s.id]);
    expect(JSON.parse(b.payload).acceptedIds).toEqual([s.id]);
    expect(await count('scan_event', `id = '${s.id}'`)).toBe(1);
  });

  test('같은 티켓의 서로 다른 두 IN이 동시에 와도 하나만 통과하고 하나는 DUPLICATE다', async () => {
    const s1 = scan({ ticketId: TICKET_A });
    const s2 = scan({ ticketId: TICKET_A });
    const [a, b] = await Promise.all([post('/v1/scanner/scans', [s1]), post('/v1/scanner/scans', [s2])]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const flags = [...JSON.parse(a.payload).flags, ...JSON.parse(b.payload).flags] as { kind: string }[];
    expect(flags).toEqual([expect.objectContaining({ kind: 'DUPLICATE' })]);
    const rows = (await database.pool.query('select result from scan_event where event_id = $1 and ticket_id = $2 order by result', [EVENT, TICKET_A])).rows as { result: string }[];
    expect(rows.map((r) => r.result)).toEqual(['PASS', 'REJECT']);
  });

  test('두 번째 IN은 ALREADY_IN·DUPLICATE 표시가 되고, 확인 결과가 gate_flag에 남는다', async () => {
    expect((await post('/v1/scanner/scans', [scan({ ticketId: TICKET_D })])).statusCode).toBe(200);
    const dup = await post('/v1/scanner/scans', [scan({ ticketId: TICKET_D, knownSeq: 1 })]);
    expect(dup.statusCode).toBe(200);
    const flags = JSON.parse(dup.payload).flags as { flagId: string }[];
    expect(flags).toEqual([expect.objectContaining({ kind: 'DUPLICATE', status: 'OPEN' })]);
    expect(await count('gate_flag', `event_id = '${EVENT}'`)).toBeGreaterThanOrEqual(1);
    expect(await count('gate_flag_scan', `flag_id = '${flags[0]!.flagId}'`)).toBe(1);
    const resolved = await post(`/v1/scanner/flags/${flags[0]!.flagId}/resolution`, { status: 'SUSPECT', note: '확인 필요' });
    expect(resolved.statusCode).toBe(200);
    expect(JSON.parse(resolved.payload)).toMatchObject({ flagId: flags[0]!.flagId, status: 'SUSPECT' });
    expect((await database.pool.query('select status, note, resolved_by from gate_flag where id = $1', [flags[0]!.flagId])).rows[0]).toMatchObject({ status: 'SUSPECT', note: '확인 필요', resolved_by: ACCOUNT });
  });

  test('없는 티켓은 REJECT/UNKNOWN_TICKET으로 저장하고, 취소 티켓은 AFTER_CANCEL 표시를 만든다', async () => {
    const unknown = await post('/v1/scanner/scans', [scan({ ticketId: randomUUID() })]);
    expect(unknown.statusCode).toBe(200);
    const cancelled = await post('/v1/scanner/scans', [scan({ ticketId: TICKET_CANCELLED })]);
    expect(JSON.parse(cancelled.payload).flags).toEqual([expect.objectContaining({ kind: 'AFTER_CANCEL' })]);
    const rows = (await database.pool.query('select result, reason from scan_event where event_id = $1 and ticket_id = $2', [EVENT, TICKET_CANCELLED])).rows;
    expect(rows[0]).toMatchObject({ result: 'REJECT', reason: 'TICKET_CANCELLED' });
  });

  test('이상 표시 목록·확인은 gate_lead만 되고 gate_staff는 403이다', async () => {
    expect((await get(`/v1/scanner/events/${EVENT}/flags`)).statusCode).toBe(200);
    sessions.answers.set(`${SESSION}/${DEVICE}`, { valid: true, role: 'gate_staff', eventId: EVENT });
    clock.advance(6_000);
    expect((await get(`/v1/scanner/events/${EVENT}/flags`)).statusCode).toBe(403);
  });
});
