// pid 키 전환의 PostgreSQL 저장소 통합 시험(실제 PostgreSQL 18, docs/features/identity.md §5 'pid 키 전환의 첫 구현', BUILD_ORDER BOT-025, I-T49).
// 마이그레이션 0008(전환 기록 표와 닫지 않은 줄 하나 제약)도 함께 본다.
import { createDatabase, type Database, ensureOutboxPartitions, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleSessionStore } from '../src/modules/session/adapters/db/drizzle-session-store.js';
import { GetVerificationStatus } from '../src/modules/session/application/get-verification-status.js';
import { DrizzleVerificationStore } from '../src/modules/verification/adapters/db/drizzle-verification-store.js';
import { HmacIdentityHashers } from '../src/modules/verification/adapters/hmac-identity-hashers.js';
import { VerificationClaims } from '../src/modules/verification/adapters/verification-claims.js';
import { ConfirmVerification } from '../src/modules/verification/application/confirm-verification.js';
import { PidRotation, PidRotationError } from '../src/modules/verification/application/pid-rotation.js';
import { StartVerification } from '../src/modules/verification/application/start-verification.js';
import type { IdentityHashers } from '../src/modules/verification/domain/ports.js';
import { KeyServiceUnavailable } from '../src/modules/verification/domain/verification.js';
import { agencyResult, kit, newKey, noClosure, testAgency } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let pg: PostgresContainer;
let database: Database;
const clock = fakeClock({ now: Date.parse('2026-11-04T03:00:00.000Z') });
const DAY = 86_400_000;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-pid-rotation-test', max: 8 });
  await ensureOutboxPartitions(database, clock);
});

afterAll(async () => {
  await database?.close();
  pg?.stop();
});

const hashers = (pidVersion: number) => new HmacIdentityHashers({ ciKeys: new Map([[1, Buffer.alloc(32, 4)]]), pidKey: Buffer.alloc(32, 40 + pidVersion), pidVersion });
const q = async <R>(sql: string, params: unknown[] = []): Promise<R[]> => (await database.pool.query(sql, params)).rows as R[];
const payload = (jwt: string): Record<string, unknown> => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;

/** failAfter번째 pid 계산부터 KMS 장애 */
const flaky = (h: IdentityHashers, failAfter: number): IdentityHashers => {
  let n = 0;
  return { ciAll: (c) => h.ciAll(c), pid: async (x) => (++n > failAfter ? Promise.reject(new KeyServiceUnavailable('pid')) : h.pid(x)), versions: () => h.versions(), pidVersion: () => h.pidVersion() };
};

test('I-T49_PostgreSQL에서_전환은묶음마다이어하고_KMS장애뒤다시돌리면남은줄부터하며_토큰·GetVerificationStatus에옛pid가실리고_끝나면pid_prev가지워진다', async () => {
  const verifications = new DrizzleVerificationStore(database);
  const sessions = new DrizzleSessionStore(database, clock);
  const claims = new VerificationClaims(verifications);
  const k = await kit(sessions, { claims, clock });
  const provider = testAgency(clock);
  const people = [];
  for (let i = 0; i < 5; i++) {
    const s = await k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: `rot-${i}`, email: null, deviceId: null });
    const st = await new StartVerification(verifications, provider, noClosure, clock).run({ accountId: s.accountId, sessionId: null, purpose: 'FIRST', next: '/' });
    await new ConfirmVerification(verifications, provider, hashers(1), noClosure, clock).run({ accountId: s.accountId, verificationId: st.verificationId, providerResult: agencyResult(clock, st.verificationId, { person: `rot-person-${i}` }) });
    people.push(s);
  }
  const old = new Map((await q<{ account_id: string; pid: Buffer }>('select account_id, pid from identity_verification')).map((r) => [r.account_id, r.pid]));
  const until = clock.now() + 2 * DAY;
  const e = await new PidRotation(verifications, flaky(hashers(2), 3), clock, { batch: 2 }).start({ until }).then(
    () => null,
    (x: unknown) => x as PidRotationError,
  );
  expect(e).toBeInstanceOf(PidRotationError);
  expect(e).toMatchObject({ code: 'KEY_SERVICE_DOWN', moved: 3, remaining: 2 });
  const rot = new PidRotation(verifications, hashers(2), clock, { batch: 2 });
  expect(await rot.start({})).toMatchObject({ toVersion: 2, moved: 2, remaining: 0, transitionEndsAt: until, movedAt: clock.now() });
  const rows = await q<{ account_id: string; pid: Buffer; pid_prev: Buffer; pid_key_version: number }>('select account_id, pid, pid_prev, pid_key_version from identity_verification');
  expect(rows).toHaveLength(5);
  for (const r of rows) {
    expect(r.pid_prev.equals(old.get(r.account_id)!)).toBe(true);
    expect(r.pid.equals(old.get(r.account_id)!)).toBe(false);
    expect(r.pid_key_version).toBe(2);
  }
  const s0 = people[0]!;
  const tok = payload((await k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'rot-0', email: null, deviceId: null })).accessToken);
  expect(tok.pid_prev).toBe(old.get(s0.accountId)!.toString('base64url'));
  const status = new GetVerificationStatus(sessions, claims, clock);
  expect(await status.run({ accountId: s0.accountId, sessionId: s0.sessionId })).toMatchObject({ verified: true, previousPid: old.get(s0.accountId)!.toString('base64url') });
  // 닫지 않은 전환 줄은 하나뿐이다(DB 제약)
  await expect(q('insert into pid_key_rotation (to_version, started_at, transition_ends_at) values (3, now(), now())')).rejects.toThrow(/pid_key_rotation_open_idx/);
  expect((await rot.finish().catch((x: unknown) => x as PidRotationError)) as PidRotationError).toMatchObject({ code: 'TRANSITION_NOT_OVER' });
  clock.advance(until - clock.now());
  expect(await rot.finish()).toEqual({ toVersion: 2, cleared: 5 });
  expect(await q('select 1 from identity_verification where pid_prev is not null')).toHaveLength(0);
  expect(await q<{ finished_at: Date }>('select finished_at from pid_key_rotation where to_version = 2')).toEqual([{ finished_at: new Date(clock.now()) }]);
  expect(await status.run({ accountId: s0.accountId, sessionId: s0.sessionId })).toMatchObject({ verified: true, previousPid: '' });
  expect((await rot.status()).open).toBeNull();
});

test('I-T49_GetVerificationStatus는읽기만하므로_다른트랜잭션이세션줄을잠그고있어도기다리지않고답한다(BOT-025가넘긴것)', async () => {
  const verifications = new DrizzleVerificationStore(database);
  const sessions = new DrizzleSessionStore(database, clock);
  const claims = new VerificationClaims(verifications);
  const k = await kit(sessions, { claims, clock });
  const s = await k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'lock-read', email: null, deviceId: null });
  const holder = await database.pool.connect();
  try {
    await holder.query('begin');
    await holder.query('select 1 from session where id = $1 for update', [s.sessionId]);
    const status = new GetVerificationStatus(sessions, claims, clock);
    const answer = status.run({ accountId: s.accountId, sessionId: s.sessionId });
    const late = new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), 2_000));
    expect(await Promise.race([answer, late])).toMatchObject({ verified: false });
  } finally {
    await holder.query('rollback');
    holder.release();
  }
});
