// 관리 계정 관리 gRPC의 통합 시험(실제 PostgreSQL 18, docs/features/identity.md §6 '관리 계정 관리 gRPC의 첫 구현', BUILD_ORDER BOT-150).
// 마이그레이션 0022(admin_account_request, 알림 종류 INVITATION), 마지막 partner_admin 판정의 행 잠금, 멱등 기록, 삭제의 지우기와 세션 종료 사건(Outbox), 초대 토큰·만료 정비, 목록 커서를 본다.
import { createHash } from 'node:crypto';
import { createDatabase, type Database, ensureOutboxPartitions, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleAdminAccountStore } from '../src/modules/admin/adapters/db/drizzle-admin-account-store.js';
import { MemoryAdminMailer } from '../src/modules/admin/adapters/memory-admin-mailer.js';
import { DispatchAdminNotices } from '../src/modules/admin/application/dispatch-admin-notices.js';
import { ManageAdminAccounts } from '../src/modules/admin/application/manage-admin-accounts.js';
import { DEFAULT_ADMIN_AUTH_CONFIG } from '../src/modules/admin/domain/auth-config.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let pg: PostgresContainer;
let database: Database;
const clock = fakeClock({ now: Date.parse('2026-11-05T13:00:00.000Z') });
const H = 60 * 60_000;
const OPR = '0190f3a1-7c2e-7a00-8000-00000000c001';
const CMD = '0190f3a1-7c2e-7a00-8000-00000000c002';
const PROMOTER = '0190f3a1-7c2e-7a00-8000-0000000000c1';

beforeAll(async () => {
  pg = await startPostgres();
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-admin-manage-test', max: 6 });
  await ensureOutboxPartitions(database, clock);
  const store = new DrizzleAdminAccountStore(database, clock);
  await store.create({ id: OPR, role: 'operator', email: 'opr.int@peaket.example', status: 'ACTIVE', now: clock.now() });
  await store.create({ id: CMD, role: 'commander', email: 'cmd.int@peaket.example', status: 'ACTIVE', now: clock.now() });
}, 120_000);

afterAll(async () => {
  await database?.close();
  pg?.stop();
});

const q = async <R>(sql: string, params: unknown[] = []): Promise<R[]> => (await database.pool.query(sql, params)).rows as R[];

test('PostgreSQL에서_두partner_admin을동시에낮춰도한사람은남는다(행잠금, I-T44)', async () => {
  const store = new DrizzleAdminAccountStore(database, clock);
  const a = '0190f3a1-7c2e-7a00-8000-00000000c010';
  const b = '0190f3a1-7c2e-7a00-8000-00000000c011';
  for (const [id, email] of [[a, 'pa1@stella.example'], [b, 'pa2@stella.example']] as const) await store.create({ id, role: 'partner_admin', email, status: 'ACTIVE', promoterId: PROMOTER, now: clock.now() });
  const manage = new ManageAdminAccounts(store, clock);
  const both = await Promise.all([
    manage.changeRole({ requestId: 'c-1', actedBy: OPR, accountId: a, role: 'partner_member', expectedVersion: 1 }),
    manage.changeRole({ requestId: 'c-2', actedBy: OPR, accountId: b, role: 'partner_member', expectedVersion: 1 }),
  ]);
  expect(both.map((r) => r.result).sort()).toEqual(['LAST_PARTNER_ADMIN', 'OK']);
  expect(await q("select id from admin_account where promoter_id = $1 and role = 'partner_admin'", [PROMOTER])).toHaveLength(1);
  // 같은 request_id는 적은 결과를 준다
  const again = await manage.changeRole({ requestId: 'c-1', actedBy: OPR, accountId: a, role: 'partner_member', expectedVersion: 1 });
  expect(again).toMatchObject({ result: both[0]!.result, alreadyDone: true });
  expect(await q('select result from admin_account_request where request_id in ($1, $2) order by request_id', ['c-1', 'c-2'])).toHaveLength(2);
});

test('PostgreSQL에서_초대는INVITATION알림을같은트랜잭션에적고_발송고리가토큰해시·24시간만료를적으며_만료정비와재초대가토큰을바꾼다', async () => {
  const store = new DrizzleAdminAccountStore(database, clock);
  const manage = new ManageAdminAccounts(store, clock);
  const mailer = new MemoryAdminMailer();
  const dispatch = new DispatchAdminNotices(store, mailer, { partner: 'https://partner.peaket.example', ops: 'https://console.peaket.example' }, DEFAULT_ADMIN_AUTH_CONFIG, clock);
  const inv = await manage.invite({ requestId: 'i-1', actedBy: CMD, email: 'New.Viewer@Peaket.Example', role: 'viewer', displayName: '새 관제' });
  expect(inv).toMatchObject({ result: 'OK', account: { status: 'INVITED', emailMasked: 'ne***@peaket.example' } });
  const id = inv.account!.adminAccountId;
  expect(await q("select kind from admin_security_notice where admin_account_id = $1 and kind = 'INVITATION'", [id])).toHaveLength(1);
  await dispatch.run();
  const token = /#token=([A-Za-z0-9_-]{43})$/.exec(mailer.sent.find((m) => m.kind === 'INVITATION')!.link!)![1]!;
  const [row] = await q<{ invite_token_hash: Buffer; invite_expires_at: Date; email: string }>('select invite_token_hash, invite_expires_at, email from admin_account where id = $1', [id]);
  expect(Buffer.from(row!.invite_token_hash).equals(createHash('sha256').update(token).digest())).toBe(true);
  expect(row!.invite_expires_at.getTime()).toBe(clock.now() + 24 * H);
  expect(row!.email).toBe('new.viewer@peaket.example');
  clock.advance(25 * H);
  expect(await store.expireInvites(clock.now())).toBe(1);
  const [exp] = await q<{ status: string; invite_token_hash: Buffer | null }>('select status, invite_token_hash from admin_account where id = $1', [id]);
  expect(exp).toEqual({ status: 'INVITE_EXPIRED', invite_token_hash: null });
  expect((await manage.reinvite({ requestId: 'i-2', actedBy: CMD, accountId: id, reason: 'RESEND' })).result).toBe('OK');
  await dispatch.run();
  expect(mailer.sent.filter((m) => m.kind === 'INVITATION')).toHaveLength(2);
  // 정비: 30일 지난 멱등 기록
  expect(await store.purgeRequests(clock.now() + 31 * 24 * H)).toBeGreaterThanOrEqual(2);
});

test('PostgreSQL에서_삭제는이메일·표시이름·인증수단·익숙한출발지를지우고모든세션을끝내며DELETE사건을같은트랜잭션에적는다_목록커서는마지막접속순이다', async () => {
  const store = new DrizzleAdminAccountStore(database, clock);
  const manage = new ManageAdminAccounts(store, clock);
  const v = '0190f3a1-7c2e-7a00-8000-00000000c020';
  await store.create({ id: v, role: 'viewer', email: 'gone@peaket.example', status: 'ACTIVE', displayName: '사라질 계정', now: clock.now() });
  await store.setPassword({ id: v, phc: '$pbkdf2-sha256$i=1000,k=1$AA$AA', breachCheckedAt: clock.now(), now: clock.now() });
  await store.touchKnownSource(v, 'f'.repeat(32), clock.now());
  const sid = '0190f3a1-7c2e-7a00-8000-00000000c0a1';
  await store.createSession({ id: sid, accountId: v, aud: 'ops', refreshHash: Buffer.alloc(32, 7), refreshFamily: sid, pairRef: 'f'.repeat(32), createdAt: clock.now(), absoluteExpiresAt: clock.now() + 24 * H, idleExpiresAt: clock.now() + H }, 2);
  const r = await manage.remove({ requestId: 'r-1', actedBy: CMD, accountId: v });
  expect(r).toMatchObject({ result: 'OK', account: { status: 'REMOVED', emailMasked: '', displayName: null } });
  const [row] = await q<Record<string, unknown>>('select email, display_name, password_phc, totp_seed_enc, invite_token_hash, removed_at, version from admin_account where id = $1', [v]);
  expect(row).toMatchObject({ email: null, display_name: null, password_phc: null, totp_seed_enc: null, invite_token_hash: null, version: '2' });
  expect(await q('select 1 from admin_known_source where admin_account_id = $1', [v])).toHaveLength(0);
  const [s] = await q<{ termination_reason: string }>('select termination_reason from admin_session where id = $1', [sid]);
  expect(s!.termination_reason).toBe('DELETE');
  const events = await q<{ payload: Buffer }>("select payload from outbox where topic = 'control.sessions-terminated' and msg_key = $1", [v]);
  expect(events.map((e) => JSON.parse(e.payload.toString('utf8')))).toContainEqual(expect.objectContaining({ sessionId: sid, reason: 'DELETE' }));
  // 지운 이메일로 다시 초대할 수 있다
  expect((await manage.invite({ requestId: 'r-2', actedBy: CMD, email: 'gone@peaket.example', role: 'viewer', displayName: '다시' })).result).toBe('OK');
  // 목록: 마지막 접속이 늦은 순, 접속하지 않은 계정은 뒤, 커서가 이어진다
  await store.recordLoginSuccess(OPR, clock.now() - H);
  await store.recordLoginSuccess(CMD, clock.now());
  const seen: string[] = [];
  let token: string | undefined;
  for (;;) {
    const page = await manage.list({ group: 'OPS', pageSize: 2, ...(token ? { pageToken: token } : {}) });
    seen.push(...page.accounts.map((a) => a.adminAccountId));
    if (!page.nextPageToken) break;
    token = page.nextPageToken;
  }
  expect(seen.slice(0, 2)).toEqual([CMD, OPR]);
  expect(new Set(seen).size).toBe(seen.length);
  expect(seen).toContain(v);
});

test('PostgreSQL에서_같은이메일을동시에초대해도하나만OK이고나머지는EMAIL_IN_USE다(오류로끝나지않는다)', async () => {
  const store = new DrizzleAdminAccountStore(database, clock);
  const manage = new ManageAdminAccounts(store, clock);
  const out = await Promise.all(Array.from({ length: 6 }, (_, k) => manage.invite({ requestId: `dup-${k}`, actedBy: CMD, email: 'race@peaket.example', role: 'viewer', displayName: '경합' })));
  expect(out.map((r) => r.result).sort()).toEqual(['EMAIL_IN_USE', 'EMAIL_IN_USE', 'EMAIL_IN_USE', 'EMAIL_IN_USE', 'EMAIL_IN_USE', 'OK']);
  expect(await q("select result from admin_account_request where request_id like 'dup-%'")).toHaveLength(6);
});

test('PostgreSQL에서_지운계정은마지막접속·유출대조·잠금·셈을지우고해제링크·로그인단계행도지운다', async () => {
  const store = new DrizzleAdminAccountStore(database, clock);
  const manage = new ManageAdminAccounts(store, clock);
  const v = '0190f3a1-7c2e-7a00-8000-00000000c030';
  await store.create({ id: v, role: 'cs_agent', email: 'wipe@peaket.example', status: 'ACTIVE', now: clock.now() });
  await store.recordLoginSuccess(v, clock.now());
  await store.markBreachChecked(v, clock.now(), false);
  await store.updateLoginState(v, clock.now(), (cur) => ({ next: { ...cur, lockKind: 'TIMED', lockReason: 'FAILED_ATTEMPTS', lockedUntil: clock.now() + 60_000, failedAttempts: 5, recentLockAt: [clock.now()], lockedAt: clock.now() }, notices: [] }));
  await store.createUnlockLink({ id: '0190f3a1-7c2e-7a00-8000-00000000c0b1', accountId: v, tokenHash: Buffer.alloc(32, 9), createdAt: clock.now(), expiresAt: clock.now() + 30 * 60_000 });
  await store.createLoginStep({ id: '0190f3a1-7c2e-7a00-8000-00000000c0b2', accountId: v, tokenHash: Buffer.alloc(32, 8), aud: 'ops', pairRef: 'e'.repeat(32), createdAt: clock.now(), expiresAt: clock.now() + 5 * 60_000, knownSource: false });
  expect((await manage.remove({ requestId: 'w-1', actedBy: CMD, accountId: v })).result).toBe('OK');
  const [row] = await q<Record<string, unknown>>('select last_login_at, breach_checked_at, lock_kind, lock_reason, locked_until, locked_at, recent_lock_at, failed_attempts, second_factor_failures, password_failure_total, password_change_required from admin_account where id = $1', [v]);
  expect(row).toEqual({ last_login_at: null, breach_checked_at: null, lock_kind: 'NONE', lock_reason: null, locked_until: null, locked_at: null, recent_lock_at: [], failed_attempts: 0, second_factor_failures: 0, password_failure_total: 0, password_change_required: false });
  expect(await q('select 1 from admin_unlock_link where admin_account_id = $1', [v])).toHaveLength(0);
  expect(await q('select 1 from admin_login_step where admin_account_id = $1', [v])).toHaveLength(0);
});
