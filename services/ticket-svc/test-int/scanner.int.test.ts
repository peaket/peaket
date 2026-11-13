// ticket-svc 스캐너 기기 원장 실제 PostgreSQL·Valkey 통합 시험(BUILD_ORDER GAT-170, R-537).
// 0001_scanner_device.sql 적용·재적용, Drizzle 원장, 등록 코드 GETDEL, DPoP jti SET NX PX,
// 공개 기기 등록(DPoP jkt), 관제 기기 경로, platform ScannerGuard + identity CheckScannerSession을 한 번에 본다.
import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import {
  athOf,
  createDatabase,
  createHotRedis,
  createService,
  CurrentPrincipal,
  fakeClock,
  Roles,
  ScannerAuth,
  type AdminAuthzPort,
  type Database,
  type HotRedis,
  type Principal,
  type ScannerSessionCheck,
} from '@peaket/platform';
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
import { RedisDpopReplayStore } from '../src/modules/scanner/adapters/redis-dpop-replay-store.js';
import { RedisEnrollmentCodeStore } from '../src/modules/scanner/adapters/redis-enrollment-code-store.js';
import { ScannerDevices } from '../src/modules/scanner/application/scanner-devices.js';
import { enrollmentCodeHash, normalizeEnrollmentCode, ScannerDeviceKeyConflict } from '../src/modules/scanner/domain/scanner-device.js';
import { startPostgres, type PostgresContainer } from './postgres.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const NOW = Date.parse('2026-11-13T03:00:00.000Z');
const IAT = Math.floor(NOW / 1000);
const PROMOTER = '0190f3a1-7c2e-7a00-8000-000000000001';
const ADMIN = '0190f3a1-7c2e-7a00-8000-000000000002';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000003';
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000004';
const TOKEN = 'staff-access-token';
const ATH = athOf(TOKEN);

const quiet = () => new Writable({ write: (_c, _e, cb) => cb() });
const opsHeaders = { 'x-user-id': ADMIN, 'x-session-id': randomUUID(), 'x-user-aud': 'ops', 'x-user-scope': '' };

@Controller('v1/scanner-test')
class ScannerProbeController {
  @Get('shift')
  @Roles(['gate_staff', 'gate_lead'])
  @ScannerAuth()
  shift(@CurrentPrincipal() p: Principal) {
    return { role: p.role, deviceId: p.deviceId, tenantId: p.tenantId };
  }

  @Get('lead')
  @Roles(['gate_lead'])
  @ScannerAuth()
  lead() {
    return { ok: true };
  }
}

@Module({ controllers: [ScannerProbeController] })
class ScannerProbeModule {}

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
  return new SignJWT({
    jti: o.jti ?? randomUUID(),
    htm: o.htm ?? 'GET',
    htu: o.htu,
    iat: o.iat ?? IAT,
    ...(o.ath !== undefined ? { ath: o.ath } : {}),
  })
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
let codes: RedisEnrollmentCodeStore;
let replay: RedisDpopReplayStore;
let devices: ScannerDevices;
let checkSession: CheckScannerSession;
let ticketSvc: Awaited<ReturnType<typeof createService>>;
let probeSvc: Awaited<ReturnType<typeof createService>>;
let clock: ReturnType<typeof fakeClock>;

beforeAll(async () => {
  [pg, valkey] = await Promise.all([startPostgres(), startValkey()]);
  database = createDatabase({ url: pg.url, applicationName: 'ticket-svc-scanner-int', max: 8 });
  await migrateTicket(pg.url);
  await database.pool.query('CREATE TABLE IF NOT EXISTS account (id uuid PRIMARY KEY)');
  const identityMigration = readFileSync(new URL('../../identity-svc/migrations/0031_staff_assignment_and_scanner_session.sql', import.meta.url), 'utf8');
  await database.pool.query(identityMigration);
  redis = await createHotRedis({ url: valkey.url });
  store = new DrizzleScannerDeviceStore(database);
  codes = new RedisEnrollmentCodeStore(redis);
  replay = new RedisDpopReplayStore(redis);
  clock = fakeClock({ now: NOW });
  devices = new ScannerDevices({ store, codes, clock });
  checkSession = new CheckScannerSession(new DrizzleStaffAssignmentStore(database), clock);
  const sessions: ScannerSessionCheck = { check: (q) => checkSession.run(q) };
  const adminAuthz: AdminAuthzPort = { getAdminAuthz: async () => ({ valid: true, role: 'operator' }) };
  ticketSvc = await createService({
    name: 'ticket-svc-scanner-int',
    module: AppModule.register({ scanner: { store, codes, replay, gate: new DrizzleScannerGateStore(database) } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz,
    scanner: { devices: store, sessions, replay },
  });
  probeSvc = await createService({
    name: 'scanner-probe-int',
    module: ScannerProbeModule,
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    scanner: { devices: store, sessions, replay },
  });
});

afterAll(async () => {
  await probeSvc?.close().catch(() => {});
  await ticketSvc?.close().catch(() => {});
  await redis?.close().catch(() => {});
  await database?.close().catch(() => {});
  valkey?.stop();
  pg?.stop();
});

const postOps = (url: string, body: unknown) => ticketSvc.http.inject({ method: 'POST', url, headers: { ...opsHeaders, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const getOps = (url: string) => ticketSvc.http.inject({ method: 'GET', url, headers: opsHeaders });
const pttl = async (key: string) => Number(await redis.command(['PTTL', key], { key }));

describe('스캐너 기기 원장 PostgreSQL·Valkey [GAT-170]', () => {
  test('0001_scanner_device.sql을 적용하고 다시 적용해도 같으며, 상태 CHECK와 지문 유일 인덱스가 있다', async () => {
    expect(await migrateTicket(pg.url)).toEqual([]);
    const tables = await database.pool.query("select table_name from information_schema.tables where table_schema = 'public' and table_name = 'scanner_device'");
    expect(tables.rows.map((r) => r.table_name)).toEqual(['scanner_device']);
    const indexes = await database.pool.query("select indexname from pg_indexes where schemaname = 'public' and tablename = 'scanner_device' order by indexname");
    expect(indexes.rows.map((r) => r.indexname)).toEqual(expect.arrayContaining(['scanner_device_credential_key', 'scanner_device_promoter_status_idx']));
    await expect(
      database.pool.query(
        "insert into scanner_device (id, promoter_id, name, status, credential_type, enrolled_by, enrolled_at) values ($1, $2, 'x', 'NOPE', 'DEVICE_KEY', $3, now())",
        [randomUUID(), PROMOTER, ADMIN],
      ),
    ).rejects.toThrow(/scanner_device_status_check/);
  });

  test('Drizzle 원장은 등록·커서 목록·ACTIVE 지문 묶기·폐기를 하고, 같은 지문을 두 기기에 묶지 못한다', async () => {
    const idA = '0190f3a1-7c2e-7a00-8000-000000000011';
    const idB = '0190f3a1-7c2e-7a00-8000-000000000012';
    const a = await store.register({ deviceId: idA, name: '동문-03', promoterId: PROMOTER, enrolledBy: ADMIN, atMs: NOW });
    const b = await store.register({ deviceId: idB, name: '동문-04', promoterId: PROMOTER, enrolledBy: ADMIN, atMs: NOW });
    expect(a.status).toBe('ACTIVE');
    const first = await store.list({ limit: 1 });
    expect(first.devices).toHaveLength(1);
    expect(first.nextCursor).toBe(idA);
    const rest = await store.list({ cursor: first.nextCursor, limit: 10 });
    expect(rest.devices.map((d) => d.deviceId)).toContain(b.deviceId);

    const key = await keyOf();
    expect(await store.bindCredential({ deviceId: a.deviceId, jkt: key.jkt, atMs: NOW })).toMatchObject({ deviceId: a.deviceId, status: 'ACTIVE' });
    expect(await store.byThumbprint(key.jkt)).toMatchObject({ deviceId: a.deviceId, status: 'ACTIVE', promoterId: PROMOTER });
    await expect(store.bindCredential({ deviceId: b.deviceId, jkt: key.jkt, atMs: NOW })).rejects.toBeInstanceOf(ScannerDeviceKeyConflict);

    expect(await store.revoke({ deviceId: a.deviceId, reason: '분실', atMs: NOW + 1 })).toMatchObject({ status: 'REVOKED', revokeReason: '분실' });
    expect(await store.byThumbprint(key.jkt)).toMatchObject({ status: 'REVOKED' });
    expect(await store.revoke({ deviceId: a.deviceId, reason: '다시', atMs: NOW + 2 })).toBeUndefined();
    expect(await store.bindCredential({ deviceId: a.deviceId, jkt: key.jkt, atMs: NOW + 3 })).toBeUndefined();
  });

  test('등록 코드는 SHA-256 키에만 기기 ID를 두고 GETDEL로 한 번만 꺼내며 TTL이 10분이다', async () => {
    const r = await devices.register({ name: '동문-05', promoterId: PROMOTER, enrolledBy: ADMIN });
    const code = r.enrollmentCode;
    const compact = normalizeEnrollmentCode(code)!.replace(/-/g, '');
    const hash = enrollmentCodeHash(code);
    const key = `scanner:enroll:${hash}`;
    expect(key).not.toContain(compact);
    expect(await redis.command(['GET', key], { key })).toBe(r.device.deviceId);
    const ttl = await pttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600_000);
    expect(await codes.take(hash)).toBe(r.device.deviceId);
    expect(await codes.take(hash)).toBeUndefined();
    expect(await pttl(key)).toBe(-2);
  });

  test('DPoP jti는 SET NX PX로 처음만 통과하고 10분 TTL을 둔다', async () => {
    const jti = `jti-${randomUUID()}`;
    const key = `scanner:dpop:${jti}`;
    expect(await replay.claim(jti, 600_000)).toBe(true);
    expect(await redis.command(['GET', key], { key })).toBe('1');
    expect(await replay.claim(jti, 600_000)).toBe(false);
    const ttl = await pttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600_000);
  });

  test('관제 등록 → 공개 DPoP 등록 → 목록 → 폐기 흐름이 실제 DB·Redis에 남고, 쓴 코드와 폐기 기기는 410이다', async () => {
    const created = await postOps('/v1/ops/scanner-devices', { name: '동문-06', promoterId: PROMOTER });
    expect(created.statusCode).toBe(201);
    const body = JSON.parse(created.payload) as { deviceId: string; status: string; enrollmentCode: string; enrollmentCodeExpiresAt: string };
    expect(body).toMatchObject({ status: 'ACTIVE', credentialType: 'DEVICE_KEY' });
    expect(Date.parse(body.enrollmentCodeExpiresAt) - NOW).toBe(600_000);

    const key = await keyOf();
    const enroll = await ticketSvc.http.inject({
      method: 'POST',
      url: '/v1/scanner/device-enrollments',
      headers: { 'content-type': 'application/json', dpop: await proofOf(key, { htm: 'POST', htu: 'https://scanner.peaket.example/v1/scanner/device-enrollments' }), 'x-forwarded-proto': 'https', 'x-forwarded-host': 'scanner.peaket.example' },
      payload: JSON.stringify({ code: body.enrollmentCode.toLowerCase().replace(/-/g, ' ') }),
    });
    expect(enroll.statusCode).toBe(201);
    expect(JSON.parse(enroll.payload)).toEqual({ deviceId: body.deviceId });
    const row = (await database.pool.query('select credential_thumbprint, status from scanner_device where id = $1', [body.deviceId])).rows[0];
    expect(Buffer.from(row.credential_thumbprint).toString('base64url')).toBe(key.jkt);
    expect(row.status).toBe('ACTIVE');

    const list = await getOps('/v1/ops/scanner-devices?limit=100');
    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.payload).items).toEqual(expect.arrayContaining([expect.objectContaining({ deviceId: body.deviceId, status: 'ACTIVE' })]));

    const againKey = await keyOf();
    const again = await ticketSvc.http.inject({
      method: 'POST',
      url: '/v1/scanner/device-enrollments',
      headers: { 'content-type': 'application/json', dpop: await proofOf(againKey, { htm: 'POST', htu: 'https://scanner.peaket.example/v1/scanner/device-enrollments' }), 'x-forwarded-proto': 'https', 'x-forwarded-host': 'scanner.peaket.example' },
      payload: JSON.stringify({ code: body.enrollmentCode }),
    });
    expect(again.statusCode).toBe(410);

    const revoked = await postOps(`/v1/ops/scanner-devices/${body.deviceId}/revocation`, { reason: '분실' });
    expect(revoked.statusCode).toBe(200);
    expect(JSON.parse(revoked.payload)).toMatchObject({ deviceId: body.deviceId, status: 'REVOKED' });

    const created2 = await postOps('/v1/ops/scanner-devices', { name: '동문-07', promoterId: PROMOTER });
    const body2 = JSON.parse(created2.payload) as { deviceId: string; enrollmentCode: string };
    await postOps(`/v1/ops/scanner-devices/${body2.deviceId}/revocation`, { reason: '수리' });
    const thirdKey = await keyOf();
    const revokedEnroll = await ticketSvc.http.inject({
      method: 'POST',
      url: '/v1/scanner/device-enrollments',
      headers: { 'content-type': 'application/json', dpop: await proofOf(thirdKey, { htm: 'POST', htu: 'https://scanner.peaket.example/v1/scanner/device-enrollments' }), 'x-forwarded-proto': 'https', 'x-forwarded-host': 'scanner.peaket.example' },
      payload: JSON.stringify({ code: body2.enrollmentCode }),
    });
    expect(revokedEnroll.statusCode).toBe(410);
  });

  test('platform ScannerGuard는 실제 원장의 ACTIVE와 identity CheckScannerSession을 보고, 폐기·무효 세션·재사용 jti를 막는다', async () => {
    const key = await keyOf();
    const device = await devices.register({ name: '동문-08', promoterId: PROMOTER, enrolledBy: ADMIN });
    await store.bindCredential({ deviceId: device.device.deviceId, jkt: key.jkt, atMs: NOW });
    const assignment = randomUUID();
    const session = randomUUID();
    await database.pool.query('insert into account (id) values ($1) on conflict do nothing', [ACCOUNT]);
    await database.pool.query(
      `insert into staff_assignment (id, account_id, event_id, role, invite_expires_at, invited_by, valid_from, valid_until, status, accepted_at, consent_version)
       values ($1, $2, $3, 'gate_staff', $4, $5, $6, $7, 'ASSIGNED', $8, 'v1')`,
      [assignment, ACCOUNT, EVENT, new Date(NOW + 86_400_000), ADMIN, new Date(NOW - 3_600_000), new Date(NOW + 3_600_000), new Date(NOW)],
    );
    await database.pool.query(
      `insert into scanner_session (id, staff_assignment_id, scanner_device_id, role, proxy, approved_at, expires_at)
       values ($1, $2, $3, 'gate_staff', false, $4, $5)`,
      [session, assignment, device.device.deviceId, new Date(NOW), new Date(NOW + 3_600_000)],
    );

    const htu = 'https://scanner-api.peaket.example/v1/scanner-test/shift';
    const jti = randomUUID();
    const headers = scannerHeaders(await proofOf(key, { jti, htu, ath: ATH }), key, session);
    const ok = await probeSvc.http.inject({ method: 'GET', url: '/v1/scanner-test/shift', headers });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.payload)).toEqual({ role: 'gate_staff', deviceId: device.device.deviceId, tenantId: PROMOTER });
    expect(await pttl(`scanner:dpop:${jti}`)).toBeGreaterThan(0);

    const replay = await probeSvc.http.inject({ method: 'GET', url: '/v1/scanner-test/shift', headers });
    expect(replay.statusCode).toBe(401);
    expect(replay.headers['www-authenticate']).toBe('DPoP error="invalid_dpop_proof"');

    const lead = await probeSvc.http.inject({
      method: 'GET',
      url: '/v1/scanner-test/lead',
      headers: scannerHeaders(await proofOf(key, { htu: 'https://scanner-api.peaket.example/v1/scanner-test/lead', ath: ATH }), key, session),
    });
    expect(lead.statusCode).toBe(403);

    await database.pool.query('update scanner_session set terminated_at = now() where id = $1', [session]);
    clock.advance(6_000);
    const ended = await probeSvc.http.inject({
      method: 'GET',
      url: '/v1/scanner-test/shift',
      headers: scannerHeaders(await proofOf(key, { htu, ath: ATH }), key, session),
    });
    expect(ended.statusCode).toBe(401);

    await store.revoke({ deviceId: device.device.deviceId, reason: '분실', atMs: NOW + 10_000 });
    const revoked = await probeSvc.http.inject({
      method: 'GET',
      url: '/v1/scanner-test/shift',
      headers: scannerHeaders(await proofOf(key, { htu, ath: ATH }), key, session),
    });
    expect(revoked.statusCode).toBe(403);
    expect(JSON.parse(revoked.payload)).toMatchObject({ type: 'https://peaket.example/problems/device-revoked' });
  });
});
