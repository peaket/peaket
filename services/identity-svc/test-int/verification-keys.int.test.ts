// 키 판·만 14세·다른 계정 시도·재통과의 PostgreSQL 저장소 통합 시험(실제 PostgreSQL 18, docs/features/identity.md §5 '키 판·만 14세…', BUILD_ORDER BOT-020,
// I-T42·I-T55 ④·I-T65, ADR-0050 결정 5). 마이그레이션 0006·0007(새 표·칸, NOT VALID 뒤 검증)도 함께 본다.
import { createDatabase, type Database, ensureOutboxPartitions, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleSessionStore } from '../src/modules/session/adapters/db/drizzle-session-store.js';
import { CloseAccount } from '../src/modules/session/application/close-account.js';
import { DrizzleVerificationStore } from '../src/modules/verification/adapters/db/drizzle-verification-store.js';
import { HmacIdentityHashers } from '../src/modules/verification/adapters/hmac-identity-hashers.js';
import { VerificationClaims } from '../src/modules/verification/adapters/verification-claims.js';
import { ConfirmVerification } from '../src/modules/verification/application/confirm-verification.js';
import { StartVerification } from '../src/modules/verification/application/start-verification.js';
import { agencyResult, kit, newKey, testAgency } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let pg: PostgresContainer;
let database: Database;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-verification-keys-test', max: 8 });
  await ensureOutboxPartitions(database, systemClock);
});

afterAll(async () => {
  await database?.close();
  pg?.stop();
});

const mk = (v: Record<number, number>) =>
  new HmacIdentityHashers({ ciKeys: new Map(Object.entries(v).map(([n, b]) => [Number(n), Buffer.alloc(32, b)])), pidKey: Buffer.alloc(32, 5), pidVersion: 1 });

async function setup(versions: Record<number, number> = { 1: 4 }) {
  const verifications = new DrizzleVerificationStore(database);
  const sessions = new DrizzleSessionStore(database, systemClock);
  const claims = new VerificationClaims(verifications);
  const k = await kit(sessions, { claims, reverifications: claims });
  const provider = testAgency(k.clock);
  let hashers = mk(versions);
  const closure = new CloseAccount(sessions, k.clock);
  return {
    k,
    verifications,
    setVersions: (v: Record<number, number>) => {
      hashers = mk(v);
    },
    start: new StartVerification(verifications, provider, closure, k.clock),
    confirm: (i: Parameters<ConfirmVerification['run']>[0]) => new ConfirmVerification(verifications, provider, hashers, closure, k.clock).run(i),
  };
}

type T = Awaited<ReturnType<typeof setup>>;
const login = (t: T, p: 'kakao' | 'naver' = 'kakao') => t.k.create.run({ idempotencyKey: newKey(), provider: p, providerUserId: `k2-${newKey().slice(0, 10)}`, email: null, deviceId: null });
const q = async <R>(sql: string, params: unknown[] = []): Promise<R[]> => (await database.pool.query(sql, params)).rows as R[];

test('I-T65_PostgreSQL에서_다른계정시도가시도마다한줄남고_연계정보없이_1년뒤지운다', async () => {
  const t = await setup();
  const a = await login(t);
  const b = await login(t, 'naver');
  const person = `dup-${newKey().slice(0, 8)}`;
  const sa = await t.start.run({ accountId: a.accountId, purpose: 'FIRST', next: '/' });
  await t.confirm({ accountId: a.accountId, verificationId: sa.verificationId, providerResult: agencyResult(t.k.clock, sa.verificationId, { person }) });
  for (let i = 0; i < 2; i++) {
    const sb = await t.start.run({ accountId: b.accountId, purpose: 'FIRST', next: '/' });
    await expect(t.confirm({ accountId: b.accountId, verificationId: sb.verificationId, providerResult: agencyResult(t.k.clock, sb.verificationId, { person }) })).rejects.toMatchObject({ code: 'DUPLICATE_ACCOUNT' });
  }
  const rows = await q<Record<string, unknown>>('select * from identity_conflict_attempt where attempted_account_id = $1', [b.accountId]);
  expect(rows).toHaveLength(2);
  expect(Object.keys(rows[0]!).sort()).toEqual(['attempted_account_id', 'attempted_at', 'existing_account_id', 'id']);
  expect(rows.every((r) => r.existing_account_id === a.accountId)).toBe(true);
  expect(await t.verifications.purgeConflictAttempts(t.k.clock.now() - 365 * 24 * 3_600_000)).toBe(0);
  expect(await t.verifications.purgeConflictAttempts(t.k.clock.now() + 1)).toBeGreaterThanOrEqual(2);
  expect(await q('select 1 from identity_conflict_attempt where attempted_account_id = $1', [b.accountId])).toHaveLength(0);
});

test('ADR0050_PostgreSQL에서_옛판기록으로중복을찾고_다시본인확인하면새판값으로바꾸며pid는그대로다', async () => {
  const t = await setup({ 1: 6 });
  const a = await login(t);
  const person = `ver-${newKey().slice(0, 8)}`;
  const s1 = await t.start.run({ accountId: a.accountId, purpose: 'FIRST', next: '/' });
  await t.confirm({ accountId: a.accountId, verificationId: s1.verificationId, providerResult: agencyResult(t.k.clock, s1.verificationId, { person }) });
  type Rec = { ci_hmac_key_version: number; pid: Buffer; ci_hmac: Buffer };
  const [before] = await q<Rec>('select ci_hmac_key_version, pid, ci_hmac from identity_verification where account_id = $1', [a.accountId]);
  t.setVersions({ 1: 6, 2: 7 });
  const b = await login(t, 'naver');
  const sb = await t.start.run({ accountId: b.accountId, purpose: 'FIRST', next: '/' });
  await expect(t.confirm({ accountId: b.accountId, verificationId: sb.verificationId, providerResult: agencyResult(t.k.clock, sb.verificationId, { person }) })).rejects.toMatchObject({ code: 'DUPLICATE_ACCOUNT' });
  const s2 = await t.start.run({ accountId: a.accountId, purpose: 'REVERIFY', next: '/' });
  expect((await t.confirm({ accountId: a.accountId, verificationId: s2.verificationId, providerResult: agencyResult(t.k.clock, s2.verificationId, { person }) })).status).toBe('VERIFIED');
  const [after] = await q<Rec>('select ci_hmac_key_version, pid, ci_hmac from identity_verification where account_id = $1', [a.accountId]);
  expect(before!.ci_hmac_key_version).toBe(1);
  expect(after!.ci_hmac_key_version).toBe(2);
  expect(after!.pid.equals(before!.pid)).toBe(true);
  expect(after!.ci_hmac.equals(before!.ci_hmac)).toBe(false);
  // 시작할 때 견주는 '기록이 쓰는 판'(새 맥락 리뷰 중간 3)
  expect(await t.verifications.ciKeyVersionsInUse()).toContain(2);
});

test('I-T42_PostgreSQL에서_만14세미만은UNDER_14로남고_계정은정리중이며_생년월일은DB에없다', async () => {
  const t = await setup();
  const s = await login(t);
  const st = await t.start.run({ accountId: s.accountId, sessionId: s.sessionId, purpose: 'FIRST', next: '/' });
  const birth = '2013-07-19';
  await expect(t.confirm({ accountId: s.accountId, verificationId: st.verificationId, providerResult: agencyResult(t.k.clock, st.verificationId, { person: `kid-${newKey().slice(0, 6)}`, birth }) })).rejects.toMatchObject({
    code: 'UNDER_14',
  });
  expect(await q('select status, session_id from verification_attempt where id = $1', [st.verificationId])).toEqual([{ status: 'UNDER_14', session_id: s.sessionId }]);
  expect(await q('select status, closure_reason from account where id = $1', [s.accountId])).toEqual([{ status: 'WITHDRAWAL_PENDING', closure_reason: 'UNDER_14' }]);
  expect(await q('select 1 from identity_verification where account_id = $1', [s.accountId])).toHaveLength(0);
  // 정리 중인 계정은 다시 시작하지 못한다(새 맥락 리뷰 중간 2)
  await expect(t.start.run({ accountId: s.accountId, purpose: 'FIRST', next: '/' })).rejects.toMatchObject({ code: 'UNDER_14' });
  // 세션은 탈퇴 절차(BOT-030)가 끝낼 때 끝낸다. 그래서 화면이 '만 14세 미만' 대화상자를 보일 수 있다
  expect(await q('select 1 from session where account_id = $1 and terminated_at is null', [s.accountId])).toHaveLength(1);
  // 생년월일은 어느 표에도 없다
  for (const table of ['verification_attempt', 'identity_verification', 'account', 'identity_conflict_attempt']) {
    expect(await q(`select 1 from ${table} where ${table}::text like $1`, [`%${birth}%`])).toHaveLength(0);
  }
  expect(await q("select 1 from outbox where convert_from(payload, 'UTF8') like $1", [`%${birth}%`])).toHaveLength(0);
});

test('I-T55_④PostgreSQL에서_같은세션의REVERIFY확정만_재통과로찾는다', async () => {
  const t = await setup();
  const s = await login(t);
  const person = `rv-${newKey().slice(0, 8)}`;
  const first = await t.start.run({ accountId: s.accountId, sessionId: s.sessionId, purpose: 'FIRST', next: '/' });
  await t.confirm({ accountId: s.accountId, verificationId: first.verificationId, providerResult: agencyResult(t.k.clock, first.verificationId, { person }) });
  const since = () => t.k.clock.now() - 600_000;
  expect(await t.verifications.recentlyReverified(s.accountId, s.sessionId, since())).toBe(false);
  const re = await t.start.run({ accountId: s.accountId, sessionId: s.sessionId, purpose: 'REVERIFY', next: '/' });
  await t.confirm({ accountId: s.accountId, verificationId: re.verificationId, providerResult: agencyResult(t.k.clock, re.verificationId, { person }) });
  expect(await t.verifications.recentlyReverified(s.accountId, s.sessionId, since())).toBe(true);
  expect(await t.verifications.recentlyReverified(s.accountId, '0190f3a1-7c2e-7a00-8000-000000000009', since())).toBe(false);
  t.k.clock.advance(600_001);
  expect(await t.verifications.recentlyReverified(s.accountId, s.sessionId, since())).toBe(false);
  const r = await t.k.reauth.run({ sessionId: s.sessionId, accountId: s.accountId, provider: 'kakao', providerUserId: 'x', strength: 'requested', purpose: 'high-risk' });
  expect(r.result).not.toBe('ISSUED');
});
