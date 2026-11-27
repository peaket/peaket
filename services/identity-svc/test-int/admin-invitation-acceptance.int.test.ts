// 관리 계정 초대 수락의 PostgreSQL 경로(F-09-6 BOT-152, identity 0039). 메모리 저장소 대신 실제 PostgreSQL 18에
// 마이그레이션을 적용하고 DrizzleAdminAccountStore의 초대 수락·TOTP 대기·패스키·완료·기기 세션을 확인한다.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createDatabase, type Database, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleAdminAccountStore } from '../src/modules/admin/adapters/db/drizzle-admin-account-store.js';
import type { AdminPasskeyRow } from '../src/modules/admin/domain/ports.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const H = 60 * 60_000;
const clock = fakeClock({ now: Date.parse('2026-11-27T04:00:00.000Z') });
const A = '0190f3a1-7c2e-7a00-8000-00000000f0a1';
const B = '0190f3a1-7c2e-7a00-8000-00000000f0a2';
const PROMOTER = '0190f3a1-7c2e-7a00-8000-0000000000f1';
const sha = (b: Buffer) => createHash('sha256').update(b).digest();

let pg: PostgresContainer;
let database: Database;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-invitation-acceptance-test', max: 6 });
}, 120_000);

afterAll(async () => {
  await database?.close();
  pg?.stop();
});

const q = async <R>(sql: string, params: unknown[] = []): Promise<R[]> => (await database.pool.query(sql, params)).rows as R[];

const seedInvite = async (store: DrizzleAdminAccountStore, id: string, email: string, role: 'partner_admin' | 'viewer', now: number): Promise<{ tokenHash: Buffer; stepHash: Buffer }> => {
  await store.create({ id, role, email, status: 'INVITED', ...(role === 'partner_admin' ? { promoterId: PROMOTER } : {}), displayName: '초대 담당', now });
  const tokenHash = sha(randomBytes(32));
  await q('update admin_account set invite_token_hash = $2, invite_expires_at = $3 where id = $1', [id, tokenHash, new Date(now + 24 * H)]);
  const stepHash = sha(randomBytes(32));
  return { tokenHash, stepHash };
};

test('BOT-152 PostgreSQL: 0039를 적용한 Drizzle 저장소가 초대 토큰·단계·TOTP 대기·패스키·완료·기기 세션을 트랜잭션으로 처리한다', async () => {
  const store = new DrizzleAdminAccountStore(database, clock);
  const now = clock.now();
  const { tokenHash, stepHash } = await seedInvite(store, A, 'invite.int@stella.example', 'partner_admin', now);

  // 초대 토큰 해시로 INVITED 계정을 찾고, 다른 해시는 null이다
  const invited = await store.findByInvitationTokenHash(tokenHash);
  expect(invited).toMatchObject({ accountId: A, role: 'partner_admin', email: 'invite.int@stella.example', status: 'INVITED', stepStage: null });
  expect(invited!.inviteExpiresAt).toBe(now + 24 * H);
  expect(await store.findByInvitationTokenHash(sha(randomBytes(32)))).toBeNull();

  // 수락 시작: 30분 단계 토큰과 PASSWORD 단계, 앞서 넣은 값 초기화
  expect(await store.resetInvitationAcceptance({ accountId: A, stepHash, expiresAt: now + 30 * 60_000, now })).toBe(true);
  const step = await store.findInvitationStep(stepHash);
  expect(step).toMatchObject({ accountId: A, stepStage: 'PASSWORD', stepCodeFailures: 0 });
  expect(step!.stepExpiresAt).toBe(now + 30 * 60_000);

  // 비밀번호 뒤 TOTP 대기: 암호문을 넣고 읽으며, 틀린 시드로는 확정되지 않는다
  expect(await store.advanceInvitationStage({ accountId: A, from: 'PASSWORD', to: 'TOTP', now })).toBe(true);
  expect(await store.advanceInvitationStage({ accountId: A, from: 'PASSWORD', to: 'TOTP', now })).toBe(false);
  const seedEnc = randomBytes(32);
  expect(await store.setTotpPending(A, seedEnc, now)).toBe(true);
  const totp = await store.getTotp(A);
  expect(totp?.pendingEnc && Buffer.from(totp.pendingEnc).equals(seedEnc)).toBe(true);
  expect(totp?.seedEnc).toBeNull();
  expect(await store.confirmInvitationTotp({ accountId: A, seedEnc: randomBytes(32), step: 10, recoveryPhcs: ['x'], now })).toBe(false);
  expect(await store.confirmInvitationTotp({ accountId: A, seedEnc, step: 10, recoveryPhcs: Array.from({ length: 10 }, (_, i) => `phc-${i}`), now })).toBe(true);
  expect(await store.listRecoveryCodes(A)).toHaveLength(10);
  expect((await store.findInvitationStep(stepHash))?.stepStage).toBe('PASSKEY');

  // 패스키: INVITED·PASSKEY 단계에서만 추가되고 같은 자격 ID는 EXISTS다
  const passkey = (id: string, credentialId: Buffer): AdminPasskeyRow => ({
    id,
    accountId: A,
    credentialId,
    publicKey: Buffer.from('public-key'),
    signCount: 0,
    transports: ['internal'],
    deviceType: 'singleDevice',
    backedUp: false,
    aaguid: '00000000-0000-0000-0000-000000000000',
    name: '업무 노트북',
    createdAt: now,
    lastUsedAt: null,
  });
  const credentialId = randomBytes(32);
  expect(await store.addInvitationPasskey(passkey(randomUUID(), credentialId), 10, now)).toBe('ADDED');
  expect(await store.addInvitationPasskey(passkey(randomUUID(), credentialId), 10, now)).toBe('EXISTS');
  expect(await store.listPasskeys(A)).toHaveLength(1);

  // 완료: ACTIVE, 초대·단계 토큰 해시 null, 세션은 0
  expect(await store.completeInvitation({ accountId: A, displayName: '초대 담당자', now })).toBe(true);
  expect(await store.get(A)).toMatchObject({ status: 'ACTIVE', displayName: '초대 담당자' });
  expect(await store.findByInvitationTokenHash(tokenHash)).toBeNull();
  expect(await store.findInvitationStep(stepHash)).toBeNull();
  const [row] = await q<{ status: string; invite_token_hash: Buffer | null; invite_step_hash: Buffer | null; invite_step_stage: string | null; version: string }>(
    'select status, invite_token_hash, invite_step_hash, invite_step_stage, version from admin_account where id = $1',
    [A],
  );
  expect(row).toMatchObject({ status: 'ACTIVE', invite_token_hash: null, invite_step_hash: null, invite_step_stage: null, version: '2' });
  expect(await q('select id from admin_session where admin_account_id = $1', [A])).toHaveLength(0);

  // 완료한 계정의 기기 세션: Drizzle createSession이 세션·갱신 해시를 함께 남긴다
  const sid = randomUUID();
  const refreshHash = sha(randomBytes(32));
  expect(await store.createSession({ id: sid, accountId: A, aud: 'partner', refreshHash, refreshFamily: randomUUID(), pairRef: 'pair-invite', createdAt: now, absoluteExpiresAt: now + 30 * 24 * H, idleExpiresAt: now + 8 * H }, 3)).toEqual({ evicted: [] });
  expect(await q('select id from admin_session where admin_account_id = $1', [A])).toEqual([{ id: sid }]);
  expect(await q('select 1 from admin_refresh_token_hash where admin_session_id = $1', [sid])).toHaveLength(1);
});

test('BOT-152 PostgreSQL: TOTP 코드 5회 실패는 단계를 무효화하고, 다시 시작하면 PASSWORD 단계로 돌아간다', async () => {
  const store = new DrizzleAdminAccountStore(database, clock);
  const now = clock.now();
  const { stepHash } = await seedInvite(store, B, 'invite.fail@peaket.example', 'viewer', now);
  expect(await store.resetInvitationAcceptance({ accountId: B, stepHash, expiresAt: now + 30 * 60_000, now })).toBe(true);
  expect(await store.advanceInvitationStage({ accountId: B, from: 'PASSWORD', to: 'TOTP', now })).toBe(true);

  for (let i = 1; i <= 4; i += 1) expect(await store.recordInvitationCodeFailure(B, now)).toEqual({ failures: i, invalidated: false });
  expect(await store.recordInvitationCodeFailure(B, now)).toEqual({ failures: 5, invalidated: true });
  expect(await store.findInvitationStep(stepHash)).toBeNull();
  const [row] = await q<{ second_factor_failures: number; lock_kind: string }>('select second_factor_failures, lock_kind from admin_account where id = $1', [B]);
  expect(row).toEqual({ second_factor_failures: 0, lock_kind: 'NONE' });

  // 같은 초대에서 다시 시작하면 비밀번호 단계부터 새 단계 토큰을 준다
  const retryHash = sha(randomBytes(32));
  expect(await store.resetInvitationAcceptance({ accountId: B, stepHash: retryHash, expiresAt: now + 30 * 60_000, now })).toBe(true);
  expect((await store.findInvitationStep(retryHash))?.stepStage).toBe('PASSWORD');
});
