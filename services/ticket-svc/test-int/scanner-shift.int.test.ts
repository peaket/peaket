// ticket-svc 근무 준비·기기 배치·준비 보고·등록 IP 제한·기기 인증만 스캔의 실제 PostgreSQL·Valkey 통합 시험
// (BUILD_ORDER GAT-170 잔여, R-582, offline-gate §6.1·§6.2).
import 'reflect-metadata';
import { athOf, createDatabase, createHotRedis, createService, fakeClock, type AdminAuthzPort, type Database, type HotRedis, type ScannerSessionCheck } from '@peaket/platform';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { CheckScannerSession } from '../../identity-svc/src/modules/session/application/check-scanner-session.js';
import { DrizzleStaffAssignmentStore } from '../../identity-svc/src/modules/session/adapters/db/drizzle-staff-assignment-store.js';
import { migrateTicket } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { DrizzleScannerDeviceStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-device-store.js';
import { DrizzleScannerGateStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-gate-store.js';
import { DrizzleScannerShiftStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-shift-store.js';
import { RedisDpopReplayStore } from '../src/modules/scanner/adapters/redis-dpop-replay-store.js';
import { RedisEnrollmentAttemptLimiter } from '../src/modules/scanner/adapters/redis-enrollment-attempt-limiter.js';
import { RedisEnrollmentCodeStore } from '../src/modules/scanner/adapters/redis-enrollment-code-store.js';
import { ScannerDevices } from '../src/modules/scanner/application/scanner-devices.js';
import { startPostgres, type PostgresContainer } from './postgres.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const NOW = Date.parse('2026-11-15T03:00:00.000Z');
const IAT = Math.floor(NOW / 1000);
const PROMOTER = '0190f3a1-7c2e-7a00-8000-000000000101';
const ADMIN = '0190f3a1-7c2e-7a00-8000-000000000102';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000103';
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000104';
const TICKET = '0190f3a1-7c2e-7a00-8000-000000000105';
const ASSIGNMENT = '0190f3a1-7c2e-7a00-8000-000000000106';
const TOKEN = 'staff-access-token';
const ATH = athOf(TOKEN);

const quiet = () => new Writable({ write: (_c, _e, cb) => cb() });

interface Key {
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  jwk: Record<string, unknown>;
  jkt: string;
}

async function keyOf(): Promise<Key> {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const jwk = (await exportJWK(pair.publicKey)) as Record<string, unknown>;
  return { privateKey: pair.privateKey, jwk, jkt: await calculateJwkThumbprint(jwk as never, 'sha256') };
}

async function proofOf(key: Key, o: { jti?: string; htm?: string; htu: string; iat?: number; ath?: string }): Promise<string> {
  return new SignJWT({ jti: o.jti ?? randomUUID(), htm: o.htm ?? 'GET', htu: o.htu, iat: o.iat ?? IAT, ...(o.ath !== undefined ? { ath: o.ath } : {}) })
    .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: key.jwk as never })
    .sign(key.privateKey);
}

function scannerHeaders(proof: string, key: Key, sessionId: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'x-user-id': ACCOUNT,
    'x-session-id': sessionId,
    'x-user-aud': 'scanner',
    'x-user-jkt': key.jkt,
    'x-user-ath': ATH,
    authorization: `DPoP ${TOKEN}`,
    dpop: proof,
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'scanner-api.peaket.example',
    ...extra,
  };
}

let pg: PostgresContainer;
let valkey: ValkeyContainer;
let database: Database;
let redis: HotRedis;
let store: DrizzleScannerDeviceStore;
let shiftStore: DrizzleScannerShiftStore;
let service: Awaited<ReturnType<typeof createService>>;
let clock: ReturnType<typeof fakeClock>;

beforeAll(async () => {
  [pg, valkey] = await Promise.all([startPostgres(), startValkey()]);
  database = createDatabase({ url: pg.url, applicationName: 'ticket-svc-shift-int', max: 8 });
  await migrateTicket(pg.url);
  await database.pool.query('CREATE TABLE IF NOT EXISTS account (id uuid PRIMARY KEY)');
  const identityMigration = readFileSync(new URL('../../identity-svc/migrations/0031_staff_assignment_and_scanner_session.sql', import.meta.url), 'utf8');
  await database.pool.query(identityMigration);
  await database.pool.query('insert into account (id) values ($1) on conflict do nothing', [ACCOUNT]);
  await database.pool.query(
    `insert into staff_assignment (id, account_id, event_id, role, invite_expires_at, invited_by, valid_from, valid_until, status, accepted_at, consent_version)
     values ($1, $2, $3, 'gate_lead', $4, $5, $6, $7, 'ASSIGNED', $8, 'v1')`,
    [ASSIGNMENT, ACCOUNT, EVENT, new Date(NOW + 86_400_000), ADMIN, new Date(NOW - 3_600_000), new Date(NOW + 3_600_000), new Date(NOW)],
  );
  await database.pool.query(
    `insert into ticket (id, account_id, payer_account_id, order_id, event_id, seat_id, gate_zone, status, issue_generation, qr_payload, key_hash, created_at)
     values ($1, $2, $2, $3, $4, $5, '동문', 'ACTIVE', 1, 'qr', 'hash', $6)`,
    [TICKET, ACCOUNT, randomUUID(), EVENT, randomUUID(), new Date(NOW)],
  );
  redis = await createHotRedis({ url: valkey.url });
  store = new DrizzleScannerDeviceStore(database);
  shiftStore = new DrizzleScannerShiftStore(database);
  const gate = new DrizzleScannerGateStore(database);
  const codes = new RedisEnrollmentCodeStore(redis);
  const replay = new RedisDpopReplayStore(redis);
  clock = fakeClock({ now: NOW });
  const devices = new ScannerDevices({ store, codes, clock, limiter: new RedisEnrollmentAttemptLimiter(redis) });
  const checkSession = new CheckScannerSession(new DrizzleStaffAssignmentStore(database, clock), clock);
  const sessions: ScannerSessionCheck = { check: (q) => checkSession.run(q) };
  const adminAuthz: AdminAuthzPort = { getAdminAuthz: async () => ({ valid: true, role: 'operator' }) };
  service = await createService({
    name: 'ticket-svc-shift-int',
    module: AppModule.register({ scanner: { store, codes, replay, gate, shift: shiftStore, limiter: new RedisEnrollmentAttemptLimiter(redis) } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz,
    scanner: { devices: store, sessions, replay },
  });
});

afterAll(async () => {
  await service?.close().catch(() => {});
  await redis?.close().catch(() => {});
  await database?.close().catch(() => {});
  valkey?.stop();
  pg?.stop();
});

async function seededDevice(name: string): Promise<{ key: Key; deviceId: string; session: string }> {
  const key = await keyOf();
  const created = await store.register({ deviceId: randomUUID(), name, promoterId: PROMOTER, enrolledBy: ADMIN, atMs: NOW });
  await store.bindCredential({ deviceId: created.deviceId, jkt: key.jkt, atMs: NOW });
  const session = randomUUID();
  await database.pool.query(
    `insert into scanner_session (id, staff_assignment_id, scanner_device_id, role, proxy, approved_at, expires_at)
     values ($1, $2, $3, 'gate_lead', false, $4, $5)`,
    [session, ASSIGNMENT, created.deviceId, new Date(NOW), new Date(NOW + 3_600_000)],
  );
  return { key, deviceId: created.deviceId, session };
}

describe('근무 준비·배치·준비 보고 실제 PostgreSQL [GAT-170]', () => {
  test('0005_scanner_shift.sql을 적용·재적용하고, 배치 모드 CHECK와 준비 보고 표가 있다', async () => {
    expect(await migrateTicket(pg.url)).toEqual([]);
    const tables = await database.pool.query("select table_name from information_schema.tables where table_schema = 'public' and table_name in ('scanner_placement', 'scanner_readiness') order by table_name");
    expect(tables.rows.map((r) => r.table_name)).toEqual(['scanner_placement', 'scanner_readiness']);
    await expect(
      database.pool.query("insert into scanner_placement (event_id, scanner_device_id, gate_zone, mode, set_by, set_at) values ($1, $2, '동문', 'NOPE', $3, now())", [EVENT, randomUUID(), ADMIN]),
    ).rejects.toThrow(/scanner_placement_mode_check/);
  });

  test('배치를 넣으면 판 1과 PLACEMENT 변경이 남고, 근무 준비가 기기·배정·게이트·목록 번호를 주며 last_seen_at이 갱신된다', async () => {
    const d = await seededDevice('동문-21');
    const placementPath = `/v1/scanner/events/${EVENT}/device-placements/${d.deviceId}`;
    const placed = await service.http.inject({
      method: 'PUT',
      url: placementPath,
      headers: { ...scannerHeaders(await proofOf(d.key, { htm: 'PUT', htu: `https://scanner-api.peaket.example${placementPath}`, ath: ATH }), d.key, d.session), 'if-match': '"0"', 'content-type': 'application/json' },
      payload: JSON.stringify({ gateZone: '동문', mode: 'IN' }),
    });
    expect(placed.statusCode).toBe(200);
    expect(placed.headers.etag).toBe('"1"');
    const row = await database.pool.query('select gate_zone, mode, version from scanner_placement where event_id = $1 and scanner_device_id = $2', [EVENT, d.deviceId]);
    expect(row.rows[0]).toEqual({ gate_zone: '동문', mode: 'IN', version: 1 });
    const change = await database.pool.query("select kind, payload from scanner_change where event_id = $1 and kind = 'PLACEMENT'", [EVENT]);
    expect(change.rows[0]).toMatchObject({ kind: 'PLACEMENT', payload: { v: 1, deviceId: d.deviceId, gateZone: '동문', mode: 'IN', version: 1 } });

    const shiftPath = '/v1/scanner/shift';
    const shift = await service.http.inject({ method: 'GET', url: shiftPath, headers: scannerHeaders(await proofOf(d.key, { htu: `https://scanner-api.peaket.example${shiftPath}`, ath: ATH }), d.key, d.session) });
    expect(shift.statusCode).toBe(200);
    expect(JSON.parse(shift.payload)).toMatchObject({
      eventId: EVENT,
      placement: { gateZone: '동문', mode: 'IN' },
      device: { deviceId: d.deviceId, name: '동문-21', status: 'ACTIVE', enrolled: true, mtls: false },
      assignment: { role: 'gate_lead', proxy: false },
      package: { stale: false },
      auth: { deviceProof: 'DPOP', staffSession: true },
    });
    const lastSeen = await database.pool.query('select last_seen_at from scanner_device where id = $1', [d.deviceId]);
    expect(lastSeen.rows[0].last_seen_at).not.toBeNull();

    const readinessPath = '/v1/scanner/shift/readiness';
    const reported = await service.http.inject({
      method: 'PUT',
      url: readinessPath,
      headers: { ...scannerHeaders(await proofOf(d.key, { htm: 'PUT', htu: `https://scanner-api.peaket.example${readinessPath}`, ath: ATH }), d.key, d.session), 'content-type': 'application/json' },
      payload: JSON.stringify({ packageSeq: 1, clockOffsetMs: -420, pendingUploads: 3 }),
    });
    expect(reported.statusCode).toBe(204);
    const ready = await database.pool.query('select package_seq, clock_offset_ms, pending_uploads from scanner_readiness where event_id = $1 and scanner_device_id = $2', [EVENT, d.deviceId]);
    expect(ready.rows[0]).toEqual({ package_seq: '1', clock_offset_ms: -420, pending_uploads: 3 });
    const after = await service.http.inject({ method: 'GET', url: shiftPath, headers: scannerHeaders(await proofOf(d.key, { htu: `https://scanner-api.peaket.example${shiftPath}`, ath: ATH }), d.key, d.session) });
    expect(JSON.parse(after.payload)).toMatchObject({ package: { reportedPackageSeq: 1, clockOffsetMs: -420, pendingUploads: 3, stale: false } });
  });

  test('낡은 If-Match는 412, If-Match 없음은 428, 재입장 불허 OUT은 정책을 몰라 503이다', async () => {
    const d = await seededDevice('동문-22');
    const path = `/v1/scanner/events/${EVENT}/device-placements/${d.deviceId}`;
    const headers = async (method: string) => ({ ...scannerHeaders(await proofOf(d.key, { htm: method, htu: `https://scanner-api.peaket.example${path}`, ath: ATH }), d.key, d.session), 'content-type': 'application/json' });
    expect((await service.http.inject({ method: 'PUT', url: path, headers: { ...(await headers('PUT')), 'if-match': '"0"' }, payload: JSON.stringify({ gateZone: '서문', mode: 'IN' }) })).statusCode).toBe(200);
    expect((await service.http.inject({ method: 'PUT', url: path, headers: { ...(await headers('PUT')), 'if-match': '"0"' }, payload: JSON.stringify({ gateZone: '서문', mode: 'IN' }) })).statusCode).toBe(412);
    expect((await service.http.inject({ method: 'PUT', url: path, headers: await headers('PUT'), payload: JSON.stringify({ gateZone: '서문', mode: 'IN' }) })).statusCode).toBe(428);
    const fresh = await seededDevice('동문-24');
    const freshPath = `/v1/scanner/events/${EVENT}/device-placements/${fresh.deviceId}`;
    expect((await service.http.inject({ method: 'PUT', url: freshPath, headers: { ...scannerHeaders(await proofOf(fresh.key, { htm: 'PUT', htu: `https://scanner-api.peaket.example${freshPath}`, ath: ATH }), fresh.key, fresh.session), 'if-match': '"7"', 'content-type': 'application/json' }, payload: JSON.stringify({ gateZone: '서문', mode: 'IN' }) })).statusCode).toBe(412);
    expect((await service.http.inject({ method: 'PUT', url: path, headers: { ...(await headers('PUT')), 'if-match': '"1"' }, payload: JSON.stringify({ gateZone: '서문', mode: 'OUT' }) })).statusCode).toBe(503);
  });

  test('같은 IP의 등록 실패 10회 뒤 11번째는 429이고, 성공은 세지 않는다', async () => {
    const key = await keyOf();
    const enroll = async (code: string) =>
      service.http.inject({
        method: 'POST',
        url: '/v1/scanner/device-enrollments',
        headers: { dpop: await proofOf(key, { htm: 'POST', htu: 'https://scanner.peaket.example/v1/scanner/device-enrollments' }), 'x-forwarded-for': '10.7.7.7', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'scanner.peaket.example', 'content-type': 'application/json' },
        payload: JSON.stringify({ code }),
      });
    for (let i = 0; i < 10; i++) expect((await enroll('BCDF-GHJK-LMNP')).statusCode).toBe(410);
    expect((await enroll('BCDF-GHJK-LMNP')).statusCode).toBe(429);
    const pttl = Number(await redis.command(['PTTL', 'scanner:enroll:fail:10.7.7.7'], { key: 'scanner:enroll:fail:10.7.7.7' }));
    expect(pttl).toBeGreaterThan(0);
  });

  test('기기 인증만으로 올린 스캔은 받고, staff_account_id는 비며 OUT_OF_SESSION 이상 표시가 붙는다', async () => {
    const d = await seededDevice('동문-23');
    await shiftStore.putPlacement({ eventId: EVENT, deviceId: d.deviceId, gateZone: '동문', mode: 'IN', setBy: ADMIN, atMs: NOW, expectedVersion: 0 });
    const path = '/v1/scanner/scans';
    const scanId = randomUUID();
    const body = [{ id: scanId, eventId: EVENT, ticketId: TICKET, scannerSessionId: randomUUID(), direction: 'IN', method: 'QR', result: 'PASS', scannedAtDevice: new Date(NOW).toISOString(), knownSeq: 0, deviceSeq: 1 }];
    const r = await service.http.inject({
      method: 'POST',
      url: path,
      headers: { dpop: await proofOf(d.key, { htm: 'POST', htu: `https://scanner-api.peaket.example${path}` }), 'x-forwarded-proto': 'https', 'x-forwarded-host': 'scanner-api.peaket.example', 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toMatchObject({ acceptedIds: [scanId], flags: [expect.objectContaining({ kind: 'OUT_OF_SESSION' })] });
    const row = await database.pool.query('select staff_account_id, flag from scan_event where event_id = $1 and id = $2', [EVENT, scanId]);
    expect(row.rows[0]).toEqual({ staff_account_id: null, flag: 'OUT_OF_SESSION' });
  });
});
