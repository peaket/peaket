// F-05-12 O-T28 ① 실제 PostgreSQL 부스 본인확인 대조(TR-05·TR-07). 정본: docs/features/offline-gate.md §9.1,
// docs/features/identity.md §6.1, docs/data.md booth_reverification, docs/review/plans/F-05-12.md §3 결정 1·10.
//
// 0039를 실제 PostgreSQL에 적용하고, 본인확인 시작·결과 확정·부스 대조 저장·토큰 확인을 실제 저장소로 잇는다.
// 토큰 원문·연계정보 원문이 행에 남지 않는지, ci_matched=false 행이 남는지, purpose BOOTH·ticketId가 건에 남는지 본다.
import { createHash } from 'node:crypto';
import { createDatabase, type Database, ensureOutboxPartitions, fakeClock, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleSessionStore } from '../src/modules/session/adapters/db/drizzle-session-store.js';
import { DrizzleVerificationStore } from '../src/modules/verification/adapters/db/drizzle-verification-store.js';
import { HmacIdentityHashers } from '../src/modules/verification/adapters/hmac-identity-hashers.js';
import { VerificationClaims } from '../src/modules/verification/adapters/verification-claims.js';
import { ConfirmVerification } from '../src/modules/verification/application/confirm-verification.js';
import { StartVerification } from '../src/modules/verification/application/start-verification.js';
import { agencyResult, kit, newKey, noClosure, testAgency } from '../test/support.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const TICKET = '0190f3a1-7c2e-7a00-8000-000000001001';
const OTHER_TICKET = '0190f3a1-7c2e-7a00-8000-000000001002';
const TOKEN_MS = 5 * 60_000;

let pg: PostgresContainer;
let database: Database;

async function loadBooth() {
  const startPath = new URL('../src/modules/verification/application/start-booth-reverification.ts', import.meta.url).href;
  const verifyPath = new URL('../src/modules/verification/application/verify-booth-reverification.ts', import.meta.url).href;
  const startMod = (await import(/* @vite-ignore */ startPath)) as unknown as {
    StartBoothReverification: new (d: { store: unknown; booth: unknown; provider: unknown; closure: unknown; clock: unknown }) => { run(i: { accountId: string; sessionId?: string | null; ticketId: string; consent: boolean; next: string }): Promise<{ verificationId: string; expiresAt: number }> };
  };
  const verifyMod = (await import(/* @vite-ignore */ verifyPath)) as unknown as {
    VerifyBoothReverification: new (d: { booth: unknown; clock: unknown }) => { run(i: { token: string; accountId: string; ticketId: string }): Promise<boolean> };
  };
  return startMod.StartBoothReverification && verifyMod.VerifyBoothReverification ? { StartBoothReverification: startMod.StartBoothReverification, VerifyBoothReverification: verifyMod.VerifyBoothReverification } : undefined;
}

beforeAll(async () => {
  pg = await startPostgres();
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-f0512-booth-int', max: 8 });
  await ensureOutboxPartitions(database, systemClock);
});
afterAll(async () => {
  await database?.close();
  pg?.stop();
});

async function setup() {
  const clock = fakeClock({ now: Date.parse('2026-11-26T03:00:00.000Z') });
  const store = new DrizzleVerificationStore(database);
  const k = await kit(new DrizzleSessionStore(database, systemClock), { claims: new VerificationClaims(store), clock });
  const provider = testAgency(clock);
  const hashers = HmacIdentityHashers.single(Buffer.alloc(32, 4), Buffer.alloc(32, 5));
  const classes = await loadBooth();
  return {
    clock,
    store,
    k,
    provider,
    hashers,
    start: new StartVerification(store, provider, noClosure, clock),
    confirm: new ConfirmVerification(store, provider, hashers, noClosure, clock),
    classes,
  };
}

describe('O-T28 ① 실제 PostgreSQL 부스 대조', () => {
  test('O-T28 ① 대조가 맞으면 resultToken이 나오고 행에는 토큰 해시만·ci_matched=true·purpose BOOTH·ticketId가 남는다', async () => {
    const t = await setup();
    expect(t.classes, '구현 전: StartBoothReverification·VerifyBoothReverification이 없다').toBeDefined();
    const s = await t.k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: `booth-ok-${newKey().slice(0, 8)}`, email: null, deviceId: null });
    const first = await t.start.run({ accountId: s.accountId, sessionId: s.sessionId, purpose: 'FIRST', next: '/' });
    await t.confirm.run({ accountId: s.accountId, verificationId: first.verificationId, providerResult: agencyResult(t.clock, first.verificationId, { person: 'booth-holder' }) });

    const booth = new t.classes!.StartBoothReverification({ store: t.store, booth: t.store, provider: t.provider, closure: noClosure, clock: t.clock });
    const st = await booth.run({ accountId: s.accountId, sessionId: s.sessionId, ticketId: TICKET, consent: true, next: '/' });
    expect(st.expiresAt - t.clock.now()).toBe(300_000);
    const res = (await t.confirm.run({ accountId: s.accountId, verificationId: st.verificationId, providerResult: agencyResult(t.clock, st.verificationId, { person: 'booth-holder' }) })) as unknown as { status: string; resultToken?: string };
    expect(res.status).toBe('VERIFIED');
    expect(res.resultToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const token = res.resultToken!;

    const verify = new t.classes!.VerifyBoothReverification({ booth: t.store, clock: t.clock });
    expect(await verify.run({ token, accountId: s.accountId, ticketId: TICKET })).toBe(true);
    expect(await verify.run({ token, accountId: s.accountId, ticketId: OTHER_TICKET })).toBe(false);
    expect(await verify.run({ token, accountId: '0190f3a1-7c2e-7a00-8000-000000001099', ticketId: TICKET })).toBe(false);
    t.clock.advance(TOKEN_MS - 1);
    expect(await verify.run({ token, accountId: s.accountId, ticketId: TICKET })).toBe(true);
    t.clock.advance(1);
    expect(await verify.run({ token, accountId: s.accountId, ticketId: TICKET })).toBe(false);

    const cols = await database.pool.query<{ table_name: string; column_name: string }>(`select table_name, column_name from information_schema.columns where table_name in ('booth_reverification', 'verification_attempt') and column_name in ('ticket_id', 'token_hash', 'ci_matched', 'reverification_id') order by table_name, column_name`);
    expect(cols.rows).toEqual(expect.arrayContaining([{ table_name: 'booth_reverification', column_name: 'ci_matched' }, { table_name: 'booth_reverification', column_name: 'token_hash' }, { table_name: 'verification_attempt', column_name: 'ticket_id' }]));
    const check = await database.pool.query<{ def: string }>(`select pg_get_constraintdef(c.oid) def from pg_constraint c join pg_class t on t.oid = c.conrelid where t.relname = 'verification_attempt' and c.contype = 'c'`);
    expect(check.rows.map((r) => r.def).join('\n')).toContain("'BOOTH'");

    const row = await database.pool.query<{ account_id: string; ticket_id: string; ci_matched: boolean; token_hash: Buffer; expires_at: Date; verification_id: string }>('select account_id, ticket_id, ci_matched, token_hash, expires_at, verification_id from booth_reverification where ticket_id = $1', [TICKET]);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({ account_id: s.accountId, ticket_id: TICKET, ci_matched: true, verification_id: st.verificationId });
    expect(Buffer.from(row.rows[0]!.token_hash)).toEqual(createHash('sha256').update(token).digest());
    expect(Buffer.from(row.rows[0]!.token_hash).toString('utf8')).not.toContain(token);
    const attempt = await database.pool.query<{ purpose: string; ticket_id: string | null }>('select purpose, ticket_id from verification_attempt where id = $1', [st.verificationId]);
    expect(attempt.rows[0]).toMatchObject({ purpose: 'BOOTH', ticket_id: TICKET });
    const allText = await database.pool.query<{ blob: string }>(`select coalesce(string_agg(v::text, ' '), '') blob from (select row_to_json(b)::text v from booth_reverification b) x`);
    expect(allText.rows[0]!.blob).not.toContain(token);
  });

  test('O-T28 ① 대조가 다르면 409 booth-mismatch이고 토큰이 없으며 ci_matched=false 행만 남고 연계정보 원문은 남지 않는다', async () => {
    const t = await setup();
    expect(t.classes, '구현 전: StartBoothReverification이 없다').toBeDefined();
    const s = await t.k.create.run({ idempotencyKey: newKey(), provider: 'naver', providerUserId: `booth-bad-${newKey().slice(0, 8)}`, email: null, deviceId: null });
    const first = await t.start.run({ accountId: s.accountId, sessionId: s.sessionId, purpose: 'FIRST', next: '/' });
    await t.confirm.run({ accountId: s.accountId, verificationId: first.verificationId, providerResult: agencyResult(t.clock, first.verificationId, { person: 'booth-holder-2' }) });
    const booth = new t.classes!.StartBoothReverification({ store: t.store, booth: t.store, provider: t.provider, closure: noClosure, clock: t.clock });
    const st = await booth.run({ accountId: s.accountId, sessionId: s.sessionId, ticketId: OTHER_TICKET, consent: true, next: '/' });
    await expect(t.confirm.run({ accountId: s.accountId, verificationId: st.verificationId, providerResult: agencyResult(t.clock, st.verificationId, { person: 'other-person' }) })).rejects.toMatchObject({ code: 'BOOTH_MISMATCH' });
    const row = await database.pool.query<{ ci_matched: boolean; token_hash: Buffer | null }>('select ci_matched, token_hash from booth_reverification where ticket_id = $1', [OTHER_TICKET]);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]!.ci_matched).toBe(false);
    expect(row.rows[0]!.token_hash).toBeNull();
    const raw = await database.pool.query<{ n: number }>(`select count(*)::int n from (select row_to_json(b)::text v from booth_reverification b union all select row_to_json(a)::text from verification_attempt a where a.id = $1) x where v like '%other-person%'`, [st.verificationId]);
    expect(raw.rows[0]!.n).toBe(0);
  });
});
