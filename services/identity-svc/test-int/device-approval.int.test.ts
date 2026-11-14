// identity-svc 기기 승인 로그인 실제 PostgreSQL 18·Valkey 8.1 통합 시험(BUILD_ORDER GAT-220, R-566).
// 0032 적용·재적용, 기기 코드 TTL·1회용, 승인·교대·만료·폐기, 세션 last_seen_at, 계정/기기 rate limit을 본다.
import { createDatabase, createHotRedis, ensureOutboxPartitions, fakeClock, type Database, type HotRedis } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleStaffAssignmentStore } from '../src/modules/session/adapters/db/drizzle-staff-assignment-store.js';
import { RedisDeviceAuthorizations, RedisDeviceApprovalLimits } from '../src/modules/session/adapters/redis-device-authorizations.js';
import { RedisScannerDpopReplayStore } from '../src/modules/session/adapters/redis-scanner-dpop-replay.js';
import { CheckScannerSession } from '../src/modules/session/application/check-scanner-session.js';
import { TerminateScannerSessions } from '../src/modules/session/application/terminate-scanner-sessions.js';
import { DeviceApprovals } from '../src/modules/session/application/device-approvals.js';
import { PollScannerToken } from '../src/modules/session/application/poll-scanner-token.js';
import { StartDeviceAuthorization } from '../src/modules/session/application/start-device-authorization.js';
import { hashDeviceCode } from '../src/modules/session/domain/device-approval.js';
import type { ScannerDeviceLookupAnswer, ScannerDeviceRegistry, TokenSigner } from '../src/modules/session/domain/ports.js';
import { startPostgres, type PostgresContainer } from './postgres.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const NOW = Date.now();
const HOUR = 3_600_000;
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000001';
const EVENT2 = '0190f3a1-7c2e-7a00-8000-000000000002';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000003';
const OTHER = '0190f3a1-7c2e-7a00-8000-000000000004';
const ADMIN = '0190f3a1-7c2e-7a00-8000-000000000005';
const DEVICE = '0190f3a1-7c2e-7a00-8000-000000000006';
const P1 = '0190f3a1-7c2e-7a00-8000-000000000007';
const P2 = '0190f3a1-7c2e-7a00-8000-000000000008';
const ASSIGN = '0190f3a1-7c2e-7a00-8000-000000000011';
const ASSIGN2 = '0190f3a1-7c2e-7a00-8000-000000000012';
const JKT = 'A'.repeat(43);
const FAN_SESSION = '0190f3a1-7c2e-7a00-8000-000000000021';
const FAN_SESSION2 = '0190f3a1-7c2e-7a00-8000-000000000022';

class FakeRegistry implements ScannerDeviceRegistry {
  answer: ScannerDeviceLookupAnswer = { found: true, deviceId: DEVICE, status: 'ACTIVE', name: '동문-03', promoterId: P1 };
  async byThumbprint(): Promise<ScannerDeviceLookupAnswer> {
    return this.answer;
  }
}

class FakeSigner implements TokenSigner {
  readonly issuer = 'https://identity.peaket.test';
  async access(): Promise<{ token: string; expiresAt: number }> {
    throw new Error('not used');
  }
  async reauth(): Promise<{ token: string; expiresAt: number }> {
    throw new Error('not used');
  }
  async staff(c: { expiresAtMs: number }): Promise<{ token: string; expiresAt: number }> {
    return { token: `staff-${c.expiresAtMs}`, expiresAt: c.expiresAtMs };
  }
}

let pg: PostgresContainer;
let valkey: ValkeyContainer;
let database: Database;
let redis: HotRedis;
let clock: ReturnType<typeof fakeClock>;
let store: DrizzleStaffAssignmentStore;
let auths: RedisDeviceAuthorizations;
let start: StartDeviceAuthorization;
let approvals: DeviceApprovals;
let poll: PollScannerToken;
let check: CheckScannerSession;
let registry: FakeRegistry;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateIdentity(pg.url);
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
  database = createDatabase({ url: pg.url, applicationName: 'identity-device-approval-test', max: 8 });
  clock = fakeClock({ now: NOW });
  await ensureOutboxPartitions(database, clock);
  store = new DrizzleStaffAssignmentStore(database, clock);
  registry = new FakeRegistry();
  auths = new RedisDeviceAuthorizations(redis, () => clock.now());
  const limits = new RedisDeviceApprovalLimits(redis);
  start = new StartDeviceAuthorization(registry, auths, limits, clock);
  approvals = new DeviceApprovals(auths, store, limits, clock, randomUUID);
  poll = new PollScannerToken(auths, registry, new FakeSigner(), clock);
  check = new CheckScannerSession(store, clock);
  await database.pool.query("insert into account (id, status, email, email_verified, created_at) values ($1, 'ACTIVE', 'staff@example.com', true, now()) on conflict (id) do nothing", [ACCOUNT]);
  await database.pool.query("insert into account (id, status, email, email_verified, created_at) values ($1, 'ACTIVE', 'other@example.com', true, now()) on conflict (id) do nothing", [OTHER]);
  await database.pool.query(
    `insert into staff_assignment (id, account_id, event_id, promoter_id, role, invite_expires_at, invited_by, valid_from, valid_until, status)
     values ($1, $2, $3, $4, 'gate_staff', $5, $6, $7, $8, 'ASSIGNED')`,
    [ASSIGN, ACCOUNT, EVENT, P1, new Date(NOW + HOUR), ADMIN, new Date(NOW - HOUR), new Date(NOW + 24 * HOUR)],
  );
  await database.pool.query(
    `insert into staff_assignment (id, account_id, event_id, promoter_id, role, invite_expires_at, invited_by, valid_from, valid_until, status)
     values ($1, $2, $3, $4, 'gate_lead', $5, $6, $7, $8, 'ASSIGNED')`,
    [ASSIGN2, ACCOUNT, EVENT2, P1, new Date(NOW + HOUR), ADMIN, new Date(NOW - HOUR), new Date(NOW + 24 * HOUR)],
  );
});

afterAll(async () => {
  await database?.close().catch(() => {});
  await redis?.close().catch(() => {});
  valkey?.stop();
  pg?.stop();
});

beforeEach(async () => {
  await redis.command(['DEL', `id:devrate:issue:${DEVICE}`], { key: `id:devrate:issue:${DEVICE}` });
  await redis.command(['DEL', `id:devrate:approve:${ACCOUNT}`], { key: `id:devrate:approve:${ACCOUNT}` });
});

async function started() {
  const r = await start.run({ jkt: JKT });
  const rec = await auths.findByUserCode(r.userCode);
  expect(rec).toBeTruthy();
  return r;
}

describe('기기 승인 PostgreSQL·Valkey [GAT-220]', () => {
  test('0032를 적용·재적용해도 같고 promoter_id와 활성 세션 유일 인덱스가 있다', async () => {
    await migrateIdentity(pg.url);
    const col = await database.pool.query("select column_name from information_schema.columns where table_schema='public' and table_name='staff_assignment' and column_name='promoter_id'");
    expect(col.rows).toEqual([{ column_name: 'promoter_id' }]);
    const idx = await database.pool.query("select indexname from pg_indexes where schemaname='public' and tablename='scanner_session' order by indexname");
    expect(idx.rows.map((r) => r.indexname)).toContain('scanner_session_device_active_key');
  });

  test('기기 코드는 5분·1회용이고 기기당 시간당 10회로 제한한다', async () => {
    const r = await started();
    expect(r.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    const rec = await auths.findByUserCode(r.userCode);
    expect(rec).toMatchObject({ deviceId: DEVICE, promoterId: P1, status: 'PENDING' });
    expect(rec!.expiresAtMs - NOW).toBe(5 * 60_000);

    // 앞 시험에서 1회 썼으므로 9회 더 발급하면 11번째는 429다.
    for (let i = 0; i < 9; i++) await start.run({ jkt: JKT });
    await expect(start.run({ jkt: JKT })).rejects.toMatchObject({ code: 'RATE_LIMITED' });

    clock.advance(5 * 60_000 + 1);
    expect(await auths.findByUserCode(r.userCode)).toBeNull();
  });

  test('승인하면 세션을 만들고 같은 기기·계정의 이전 세션을 끝내며 last_seen_at을 남긴다', async () => {
    clock.advance(HOUR);
    const r = await started();
    await approvals.decide({ userCode: r.userCode, accountId: ACCOUNT, sessionId: FAN_SESSION, decision: 'APPROVE', assignmentId: ASSIGN });
    const rows = await database.pool.query('select id, scanner_device_id, role, proxy, terminated_at, expires_at from scanner_session order by approved_at');
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ scanner_device_id: DEVICE, role: 'gate_staff', proxy: false, terminated_at: null });
    const sessionId = rows.rows[0].id as string;
    const answer = await check.run({ scannerSessionId: sessionId, deviceId: DEVICE });
    expect(answer).toMatchObject({ valid: true, role: 'gate_staff', eventId: EVENT });
    const seen = await database.pool.query('select last_seen_at from scanner_session where id = $1', [sessionId]);
    expect(seen.rows[0].last_seen_at).not.toBeNull();

    const token = await poll.run({ deviceCode: r.deviceCode, jkt: JKT });
    expect(token).toMatchObject({ token_type: 'DPoP', access_token: `staff-${NOW + 24 * HOUR}` });

    const second = await started();
    await approvals.decide({ userCode: second.userCode, accountId: ACCOUNT, sessionId: FAN_SESSION2, decision: 'APPROVE', assignmentId: ASSIGN });
    const after = await database.pool.query('select id, terminated_at from scanner_session order by approved_at');
    expect(after.rows).toHaveLength(2);
    expect(after.rows[0].terminated_at).not.toBeNull();
    expect(after.rows[1].terminated_at).toBeNull();
  });

  test('대리 승인은 gate_lead만 되고 세션 역할은 gate_staff로 낮춘다', async () => {
    clock.advance(HOUR);
    const r = await started();
    await approvals.decide({ userCode: r.userCode, accountId: ACCOUNT, sessionId: FAN_SESSION, decision: 'APPROVE', assignmentId: ASSIGN2, proxy: true });
    const row = (await database.pool.query('select role, proxy from scanner_session order by approved_at desc limit 1')).rows[0];
    expect(row).toMatchObject({ role: 'gate_staff', proxy: true });

    const r2 = await started();
    await expect(approvals.decide({ userCode: r2.userCode, accountId: ACCOUNT, sessionId: FAN_SESSION, decision: 'APPROVE', assignmentId: ASSIGN, proxy: true })).rejects.toMatchObject({
      code: 'PROXY_NOT_ALLOWED',
    });
  });

  test('파트너가 다른 기기·근무 시간 밖 배정은 403이고, 폐기 기기는 토큰을 주지 않는다', async () => {
    clock.advance(HOUR);
    registry.answer = { ...registry.answer, promoterId: P2 };
    const r = await started();
    await expect(approvals.lookup({ userCode: r.userCode, accountId: ACCOUNT })).rejects.toMatchObject({ code: 'OTHER_PARTNER_DEVICE' });
    registry.answer = { ...registry.answer, promoterId: P1 };
    const r2 = await started();
    await database.pool.query('update staff_assignment set valid_until = $1 where id in ($2, $3)', [new Date(clock.now() - 1), ASSIGN, ASSIGN2]);
    await expect(approvals.lookup({ userCode: r2.userCode, accountId: ACCOUNT })).rejects.toMatchObject({ code: 'OUTSIDE_STAFF_HOURS' });

    await database.pool.query('update staff_assignment set valid_until = $1 where id in ($2, $3)', [new Date(clock.now() + 24 * HOUR), ASSIGN, ASSIGN2]);
    const r3 = await started();
    await approvals.decide({ userCode: r3.userCode, accountId: ACCOUNT, sessionId: FAN_SESSION, decision: 'APPROVE', assignmentId: ASSIGN });
    registry.answer = { ...registry.answer, status: 'REVOKED' };
    await expect(poll.run({ deviceCode: r3.deviceCode, jkt: JKT })).rejects.toMatchObject({ code: 'device_revoked' });
    registry.answer = { ...registry.answer, status: 'ACTIVE' };
  });

  test('승인 시도는 계정당 10분 5회로 제한하고 거부·만료·slow_down을 구분한다', async () => {
    clock.advance(HOUR);
    const r = await started();
    await expect(poll.run({ deviceCode: r.deviceCode, jkt: JKT })).rejects.toMatchObject({ code: 'authorization_pending' });
    await expect(poll.run({ deviceCode: r.deviceCode, jkt: JKT })).rejects.toMatchObject({ code: 'slow_down' });
    await approvals.decide({ userCode: r.userCode, accountId: ACCOUNT, sessionId: FAN_SESSION, decision: 'DENY' });
    await expect(poll.run({ deviceCode: r.deviceCode, jkt: JKT })).rejects.toMatchObject({ code: 'access_denied' });

    const expired = await started();

    for (let i = 0; i < 4; i++) await approvals.decide({ userCode: r.userCode, accountId: ACCOUNT, sessionId: FAN_SESSION, decision: 'DENY' }).catch(() => undefined);
    await expect(approvals.decide({ userCode: r.userCode, accountId: ACCOUNT, sessionId: FAN_SESSION, decision: 'DENY' })).rejects.toMatchObject({ code: 'RATE_LIMITED' });

    clock.advance(5 * 60_000 + 1);
    await expect(poll.run({ deviceCode: expired.deviceCode, jkt: JKT })).rejects.toMatchObject({ code: 'expired_token' });
  });

  test('기기 폐기 세션 종료는 scanner_session을 끝내고 DEVICE_REVOKED Outbox를 남긴다', async () => {
    const device = randomUUID();
    const session = randomUUID();
    await database.pool.query(
      `insert into scanner_session (id, staff_assignment_id, scanner_device_id, role, proxy, approved_at, expires_at)
       values ($1, $2, $3, 'gate_staff', false, $4, $5)`,
      [session, ASSIGN, device, new Date(clock.now()), new Date(clock.now() + HOUR)],
    );
    const terminate = new TerminateScannerSessions(store, clock);
    await expect(terminate.run({ deviceId: device, reason: 'DEVICE_REVOKED' })).resolves.toEqual({ terminated: 1 });
    const ended = await database.pool.query('select terminated_at from scanner_session where id = $1', [session]);
    expect(ended.rows[0].terminated_at).not.toBeNull();
    const outbox = await database.pool.query("select topic, payload from outbox where topic = 'control.sessions-terminated' order by id desc limit 1");
    expect(outbox.rows[0].topic).toBe('control.sessions-terminated');
    expect(JSON.parse(Buffer.from(outbox.rows[0].payload).toString('utf8'))).toMatchObject({ accountId: ACCOUNT, sessionId: session, reason: 'DEVICE_REVOKED' });
    await expect(terminate.run({ deviceId: device, reason: 'DEVICE_REVOKED' })).resolves.toEqual({ terminated: 0 });
  });
});
