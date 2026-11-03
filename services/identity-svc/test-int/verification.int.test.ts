// 본인확인 PostgreSQL 저장소 통합 시험(실제 PostgreSQL 18): 1인 1계정(ci_hmac UNIQUE), 토큰에 실을 값(docs/features/identity.md §5, I-T6).
import { createDatabase, type Database, ensureOutboxPartitions, systemClock } from '@peaket/platform';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleSessionStore } from '../src/modules/session/adapters/db/drizzle-session-store.js';
import { DrizzleVerificationStore } from '../src/modules/verification/adapters/db/drizzle-verification-store.js';
import { HmacIdentityHashers } from '../src/modules/verification/adapters/hmac-identity-hashers.js';
import { TestVerificationProvider } from '../src/modules/verification/adapters/test-verification-provider.js';
import { VerificationClaims } from '../src/modules/verification/adapters/verification-claims.js';
import { ConfirmVerification } from '../src/modules/verification/application/confirm-verification.js';
import { StartVerification } from '../src/modules/verification/application/start-verification.js';
import { kit, newKey } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let pg: PostgresContainer;
let database: Database;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-verification-test', max: 8 });
  await ensureOutboxPartitions(database, systemClock);
});

afterAll(async () => {
  await database?.close();
  pg?.stop();
});

async function setup() {
  const verifications = new DrizzleVerificationStore(database);
  const k = await kit(new DrizzleSessionStore(database, systemClock), { claims: new VerificationClaims(verifications) });
  const provider = new TestVerificationProvider(Buffer.alloc(32, 3), 'https://www.peaket.test');
  const hashers = new HmacIdentityHashers(Buffer.alloc(32, 4), Buffer.alloc(32, 5));
  return { k, start: new StartVerification(verifications, provider, k.clock), confirm: new ConfirmVerification(verifications, provider, hashers, k.clock) };
}

test('FR002_PostgreSQL에서도_본인확인뒤갱신토큰에ticket:buy와pid가실린다', async () => {
  const t = await setup();
  const s = await t.k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: `pv-${newKey().slice(0, 8)}`, email: null, deviceId: null });
  const st = await t.start.run({ accountId: s.accountId, purpose: 'FIRST', next: '/' });
  expect((await t.confirm.run({ accountId: s.accountId, verificationId: st.verificationId, providerResult: { testPerson: `pg-${s.accountId}` } })).status).toBe('VERIFIED');
  const r = await t.k.refresh.run({ refreshToken: s.refreshToken });
  if (r.result !== 'OK') throw new Error(r.result);
  expect(decodeJwt(r.accessToken)).toMatchObject({ scope: 'ticket:buy', pid: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
});

test('I-T6_같은사람이두계정에서동시에확정해도_한계정만본인확인된다', async () => {
  const t = await setup();
  const person = `race-${newKey().slice(0, 8)}`;
  const accounts = await Promise.all([1, 2].map(() => t.k.create.run({ idempotencyKey: newKey(), provider: 'naver', providerUserId: `pr-${newKey().slice(0, 8)}`, email: null, deviceId: null })));
  const attempts = await Promise.all(accounts.map((a) => t.start.run({ accountId: a.accountId, purpose: 'FIRST', next: '/' })));
  const results = await Promise.allSettled(accounts.map((a, i) => t.confirm.run({ accountId: a.accountId, verificationId: attempts[i]!.verificationId, providerResult: { testPerson: person } })));
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  // 늦은 쪽은 UNIQUE에 걸려도 500이 아니라 DUPLICATE_ACCOUNT(409)다
  expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.code)).toEqual(['DUPLICATE_ACCOUNT']);
  const n = (await database.db.execute(`select count(*)::int as n from identity_verification where account_id in ('${accounts[0]!.accountId}', '${accounts[1]!.accountId}')`)).rows[0] as { n: number };
  expect(n.n).toBe(1);
});

test('FR002_PostgreSQL에서UUID가아닌건ID는_500이아니라찾을수없음이다(새맥락리뷰)', async () => {
  const t = await setup();
  const { GetVerificationResult } = await import('../src/modules/verification/application/get-verification-result.js');
  const get = new GetVerificationResult(new DrizzleVerificationStore(database), t.k.clock);
  await expect(get.run({ accountId: '0190f3a1-7c2e-7a00-8000-000000000001', verificationId: 'abc' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(t.confirm.run({ accountId: '0190f3a1-7c2e-7a00-8000-000000000001', verificationId: 'abc', providerResult: {} })).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

test('FR002_한계정의건둘을동시에확정해도_500없이둘다같은사람으로확정된다(새맥락리뷰)', async () => {
  const t = await setup();
  const s = await t.k.create.run({ idempotencyKey: newKey(), provider: 'google', providerUserId: `pd-${newKey().slice(0, 8)}`, email: null, deviceId: null });
  const [a, b] = await Promise.all([t.start.run({ accountId: s.accountId, purpose: 'FIRST', next: '/' }), t.start.run({ accountId: s.accountId, purpose: 'FIRST', next: '/' })]);
  const person = `same-${newKey().slice(0, 8)}`;
  const rs = await Promise.all([a, b].map((x) => t.confirm.run({ accountId: s.accountId, verificationId: x.verificationId, providerResult: { testPerson: person } })));
  expect(rs.map((r) => r.status)).toEqual(['VERIFIED', 'VERIFIED']);
});

