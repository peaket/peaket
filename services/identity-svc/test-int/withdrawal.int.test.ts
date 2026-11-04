// 탈퇴의 PostgreSQL 통합 시험(실제 PostgreSQL 18, docs/features/identity.md §8 '탈퇴의 첫 구현', BUILD_ORDER BOT-030, I-T16·I-T27).
// 마이그레이션 0009(정리 시작 시각, 재인증 토큰 사용 기록, 보존 전용 스키마)와 정비 일(identityMaintenanceTasks)을 실제 SQL로 돈다.
import { createDatabase, type Database, ensureOutboxPartitions, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { identityMaintenanceTasks } from '../src/maintenance-tasks.js';
import { DrizzleSessionStore } from '../src/modules/session/adapters/db/drizzle-session-store.js';
import { JoseReauthVerifier } from '../src/modules/session/adapters/jose-reauth-verifier.js';
import { CloseAccount } from '../src/modules/session/application/close-account.js';
import { FinishWithdrawals } from '../src/modules/session/application/finish-withdrawals.js';
import { completeWithdrawal, WithdrawAccount } from '../src/modules/session/application/withdraw-account.js';
import { DrizzleVerificationStore } from '../src/modules/verification/adapters/db/drizzle-verification-store.js';
import { HmacIdentityHashers } from '../src/modules/verification/adapters/hmac-identity-hashers.js';
import { VerificationClaims } from '../src/modules/verification/adapters/verification-claims.js';
import { VerificationEraser } from '../src/modules/verification/adapters/verification-eraser.js';
import { ConfirmVerification } from '../src/modules/verification/application/confirm-verification.js';
import { StartVerification } from '../src/modules/verification/application/start-verification.js';
import { agencyResult, ISSUER, kit, newKey, testAgency } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let pg: PostgresContainer;
let database: Database;
const clock = fakeClock({ now: Date.parse('2026-11-04T03:00:00.000Z') });

beforeAll(async () => {
  pg = await startPostgres();
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-withdrawal-test', max: 8 });
  await ensureOutboxPartitions(database, clock);
});

afterAll(async () => {
  await database?.close();
  pg?.stop();
});

const q = async <R>(sql: string, params: unknown[] = []): Promise<R[]> => (await database.pool.query(sql, params)).rows as R[];

async function setup() {
  const sessions = new DrizzleSessionStore(database, clock);
  const verifications = new DrizzleVerificationStore(database);
  const closure = new CloseAccount(sessions, clock);
  const claims = new VerificationClaims(verifications, closure);
  const k = await kit(sessions, { claims, clock, reverifications: claims });
  const provider = testAgency(clock);
  const hashers = HmacIdentityHashers.single(Buffer.alloc(32, 4), Buffer.alloc(32, 5));
  const eraser = new VerificationEraser(verifications);
  const withdraw = new WithdrawAccount(sessions, new JoseReauthVerifier(k.keys, ISSUER, clock), eraser, clock);
  const login = (id: string) => k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: id, email: `${id}@kakao.test`, deviceId: 'dev-1' });
  const verify = async (accountId: string, person: string, birth = '2000-01-01') => {
    const st = await new StartVerification(verifications, provider, closure, clock).run({ accountId, sessionId: null, purpose: 'FIRST', next: '/' });
    return new ConfirmVerification(verifications, provider, hashers, closure, clock)
      .run({ accountId, verificationId: st.verificationId, providerResult: agencyResult(clock, st.verificationId, { person, birth }) })
      .catch((e: unknown) => e);
  };
  const reauth = async (s: { accountId: string; sessionId: string }) => (await k.signer.reauth({ accountId: s.accountId, sessionId: s.sessionId, provider: 'kakao', strength: 'verified', purpose: 'sensitive' }, clock.now())).token;
  return { sessions, verifications, k, withdraw, login, verify, reauth, finish: new FinishWithdrawals(sessions, eraser, clock) };
}

test('I-T16_PostgreSQL에서_탈퇴는계정·로그인수단·기기를지우고세션을DELETE사건과함께끝내며_리프레시토큰해시·연계정보HMAC을지우고처리기록만보존스키마로옮긴다', async () => {
  const t = await setup();
  const a = await t.login('pg-w-1');
  await t.login('pg-w-1');
  await t.verify(a.accountId, 'pg-withdraw-person');
  // 로그인 수단 목록(연결한 순서, BOT-036)
  expect(await t.sessions.transaction((tx) => tx.providersOf(a.accountId))).toMatchObject([{ provider: 'kakao' }]);
  const token = await t.reauth(a);
  await t.withdraw.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: token, body: {} });
  expect(await q('select status, email, member_code, deleted_at from account where id = $1', [a.accountId])).toEqual([{ status: 'DELETED', email: null, member_code: null, deleted_at: new Date(clock.now()) }]);
  expect(await q('select 1 from account_provider where account_id = $1', [a.accountId])).toHaveLength(0);
  expect(await q('select 1 from device where account_id = $1', [a.accountId])).toHaveLength(0);
  expect(await q('select 1 from session where account_id = $1 and terminated_at is null', [a.accountId])).toHaveLength(0);
  expect(await q('select 1 from refresh_token_hash h join session s on s.id = h.session_id where s.account_id = $1', [a.accountId])).toHaveLength(0);
  const events = await q<{ payload: Buffer }>("select payload from outbox where topic = 'control.sessions-terminated' and msg_key = $1", [a.accountId]);
  expect(events.map((e) => JSON.parse(e.payload.toString()).reason)).toEqual(['DELETE', 'DELETE']);
  expect(await q('select 1 from identity_verification where account_id = $1', [a.accountId])).toHaveLength(0);
  const kept = await q<Record<string, unknown>>('select * from retention.verification_record where account_id = $1', [a.accountId]);
  expect(kept).toHaveLength(1);
  expect(Object.keys(kept[0]!).sort()).toEqual(['account_id', 'delete_at', 'moved_at', 'source_record', 'verified_at']);
  expect(await q('select 1 from verification_attempt where account_id = $1', [a.accountId])).toHaveLength(0);
  // 한 번 쓴 재인증 토큰은 다시 쓰지 못한다(기본 키)
  expect(await q('select 1 from reauth_token_use where account_id = $1', [a.accountId])).toHaveLength(1);
  // 같은 소셜 계정으로 다시 로그인하면 새 계정이고, 같은 사람이 다시 본인확인할 수 있다(I-T27)
  const b = await t.login('pg-w-1');
  expect(b.accountId).not.toBe(a.accountId);
  expect(await t.verify(b.accountId, 'pg-withdraw-person')).toMatchObject({ status: 'VERIFIED' });
});

test('BOT-020넘김_PostgreSQL에서_만14세미만정리는정리시작시각을적고_10분뒤정비가끝내며_정비일은남은행을지운다', async () => {
  const t = await setup();
  const a = await t.login('pg-u14-1');
  await t.verify(a.accountId, 'pg-kid', '2013-01-01');
  expect(await q('select status, closure_reason, closure_started_at from account where id = $1', [a.accountId])).toEqual([{ status: 'WITHDRAWAL_PENDING', closure_reason: 'UNDER_14', closure_started_at: new Date(clock.now()) }]);
  expect(await t.finish.run()).toMatchObject({ closed: 0 });
  clock.advance(10 * 60_000);
  expect(await t.finish.run()).toMatchObject({ closed: 1 });
  expect(await q('select status from account where id = $1', [a.accountId])).toEqual([{ status: 'DELETED' }]);
  expect(await q<{ status: string }>('select status from verification_attempt where account_id = $1', [a.accountId])).toEqual([{ status: 'UNDER_14' }]);
  // 정비 일: 끝난 세션의 해시는 이미 없고, 쓴 재인증 토큰 기록과 보존 기한이 지난 처리 기록을 지운다
  const tasks = identityMaintenanceTasks(database, clock);
  expect(tasks.map((x) => x.name)).toEqual(['withdrawal-finish', 'refresh-hash-expired', 'reauth-use-expired', 'conflict-attempt-purge', 'verification-record-purge', 'restricted-hold-expired', 'admin-known-source-expired', 'admin-refresh-hash-expired', 'admin-invite-expired', 'admin-account-request-expired', 'account-hold-closed']);
  clock.advance(366 * 86_400_000);
  for (const task of tasks) await task.run();
  expect(await q('select 1 from reauth_token_use')).toHaveLength(0);
  expect(await q('select 1 from retention.verification_record')).toHaveLength(0);
  expect(await q('select 1 from refresh_token_hash h join session s on s.id = h.session_id where s.absolute_expires_at <= $1', [new Date(clock.now())])).toHaveLength(0);
});

test('I-T27_M2_PostgreSQL에서_본인확인확정의계정공유잠금이_탈퇴의쓰기잠금과순서를맞춘다(확정이먼저면탈퇴가기다리고_탈퇴가먼저면DELETED를본다)', async () => {
  // 앞 시험이 시계를 밀었다: 지금 날짜의 Outbox 파티션을 만든다
  await ensureOutboxPartitions(database, clock);
  const t = await setup();
  const a = await t.login('pg-lock-1');
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const order: string[] = [];
  // 확정 트랜잭션이 계정 행을 공유 잠금으로 쥐고 있는 동안
  const confirm = t.verifications.transaction(async (tx) => {
    expect(await tx.lockAccountForShare(a.accountId)).toBe('ACTIVE');
    await held;
    order.push('confirm-commit');
  });
  await new Promise((r) => setTimeout(r, 100));
  const withdraw = t.sessions.transaction((tx) => completeWithdrawal(tx, a.accountId, clock.now())).then(() => order.push('withdraw-commit'));
  await new Promise((r) => setTimeout(r, 300));
  expect(order).toEqual([]);
  release();
  await Promise.all([confirm, withdraw]);
  expect(order).toEqual(['confirm-commit', 'withdraw-commit']);
  // 탈퇴가 끝난 뒤의 확정은 DELETED를 본다
  expect(await t.verifications.transaction((tx) => tx.lockAccountForShare(a.accountId))).toBe('DELETED');
});

test('I-T27_PostgreSQL에서_탈퇴트랜잭션이_pid와옛pid를실은탈퇴사건을Outbox에적고_본인확인기록파기가실패해도withdrawnAt은account.deleted_at이다', async () => {
  const t = await setup();
  const a = await t.login('pg-q-1');
  await t.verify(a.accountId, 'pg-queue-person');
  // pid 키 전환 기간처럼 옛 pid를 둔다
  await q("update identity_verification set pid_prev = decode(repeat('ab', 32), 'hex') where account_id = $1", [a.accountId]);
  const [row] = await q<{ pid: Buffer; pid_prev: Buffer }>('select pid, pid_prev from identity_verification where account_id = $1', [a.accountId]);
  const token = await t.reauth(a);
  // 본인확인 기록 파기(둘째 트랜잭션)가 실패하게 한다. 사건은 첫 트랜잭션이 이미 적었다
  const real = new VerificationEraser(t.verifications);
  const failing = { erase: async () => { throw new Error('주입한 DB 장애'); }, pidsOf: (id: string) => real.pidsOf(id) };
  await new WithdrawAccount(t.sessions, new JoseReauthVerifier(t.k.keys, ISSUER, clock), failing, clock).run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: token, body: {} });
  const [{ deleted_at: deletedAt }] = (await q<{ deleted_at: Date }>('select deleted_at from account where id = $1', [a.accountId])) as [{ deleted_at: Date }];
  const events = await q<{ payload: Buffer }>("select payload from outbox where topic = 'identity.accounts-withdrawn' and msg_key = $1", [a.accountId]);
  expect(events).toHaveLength(1);
  expect(JSON.parse(events[0]!.payload.toString())).toEqual({
    eventKey: expect.any(String),
    accountId: a.accountId,
    pids: [row!.pid.toString('base64url'), row!.pid_prev.toString('base64url')],
    withdrawnAt: deletedAt.toISOString(),
    purgeBy: new Date(deletedAt.getTime() + 5 * 86_400_000).toISOString(),
  });
  expect(await q('select 1 from identity_verification where account_id = $1', [a.accountId])).toHaveLength(1);
  // 정비가 남은 기록을 지워도 사건을 다시 적지 않는다
  clock.advance(60_000);
  await t.finish.run();
  expect(await q('select 1 from identity_verification where account_id = $1', [a.accountId])).toHaveLength(0);
  expect(await q("select 1 from outbox where topic = 'identity.accounts-withdrawn' and msg_key = $1", [a.accountId])).toHaveLength(1);
});
