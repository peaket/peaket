// 계정 병합의 통합 시험(실제 PostgreSQL 18·Valkey 8.1, docs/features/identity.md §2.1 '계정 병합의 첫 구현', BUILD_ORDER BOT-042, I-T32·I-T34).
// 마이그레이션 0013(account_hold·account_merge), 확정 트랜잭션의 실제 SQL(로그인 수단 이전·MERGED·사슬·이력·세션 종료·Outbox), Redis id:merge를 돈다.
import { createDatabase, createHotRedis, type Database, ensureOutboxPartitions, fakeClock, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleSessionStore } from '../src/modules/session/adapters/db/drizzle-session-store.js';
import { noBlockChecker } from '../src/modules/session/adapters/grpc-merge-checkers.js';
import { JoseReauthVerifier } from '../src/modules/session/adapters/jose-reauth-verifier.js';
import { mergeKey, RedisMergeProposals } from '../src/modules/session/adapters/redis-merge-proposals.js';
import { AddProvider } from '../src/modules/session/application/add-provider.js';
import { ConfirmMerge } from '../src/modules/session/application/confirm-merge.js';
import { MergePlanner } from '../src/modules/session/application/plan-merge.js';
import { SetAccountHold } from '../src/modules/session/application/set-account-hold.js';
import { MERGE_PROPOSAL_TTL_MS } from '../src/modules/session/domain/merge.js';
import { ISSUER, kit, newKey } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

let pg: PostgresContainer;
let vk: ValkeyContainer;
let database: Database;
let redis: HotRedis;
const clock = fakeClock({ now: Date.now() });

beforeAll(async () => {
  [pg, vk] = await Promise.all([startPostgres(), startValkey()]);
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-merge-test', max: 8 });
  await ensureOutboxPartitions(database, clock);
  redis = await createHotRedis({ url: vk.url });
});

afterAll(async () => {
  await redis?.close();
  await database?.close();
  pg?.stop();
  vk?.stop();
});

const q = async <R>(sql: string, params: unknown[] = []): Promise<R[]> => (await database.pool.query(sql, params)).rows as R[];

async function setup() {
  const sessions = new DrizzleSessionStore(database, clock);
  const k = await kit(sessions, { clock });
  const reauth = new JoseReauthVerifier(k.keys, ISSUER, clock);
  const proposals = new RedisMergeProposals(redis, () => clock.now());
  const planner = new MergePlanner(sessions, { pidsOf: async () => [] }, (['purchase', 'ticket', 'core'] as const).map(noBlockChecker), proposals, clock);
  const add = new AddProvider(sessions, reauth, clock, planner);
  const confirm = new ConfirmMerge(sessions, reauth, planner, proposals, clock);
  const token = async (s: { accountId: string; sessionId: string }) =>
    (await k.signer.reauth({ accountId: s.accountId, sessionId: s.sessionId, provider: 'kakao', strength: 'verified', purpose: 'sensitive' }, clock.now())).token;
  return { sessions, k, add, confirm, token, proposals, holds: new SetAccountHold(sessions, clock) };
}

test('I-T32·I-T34_PostgreSQL에서_확정은로그인수단을옮기고MERGED·이메일지우기·병합사슬·이력을남기며_흡수계정세션을MERGED로끝내고병합사건을Outbox에적는다', async () => {
  const t = await setup();
  const a = await t.k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'pg-m-k', email: 'pa@peaket.test', deviceId: null });
  const b = await t.k.create.run({ idempotencyKey: newKey(), provider: 'google', providerUserId: 'pg-m-g', email: 'pb@peaket.test', deviceId: null });
  // b를 가리키던 오래된 흡수 계정(병합 사슬)
  const old = await t.k.create.run({ idempotencyKey: newKey(), provider: 'naver', providerUserId: 'pg-m-n', email: null, deviceId: null });
  await q("update account set status = 'MERGED', merged_into_account_id = $1 where id = $2", [b.accountId, old.accountId]);
  await q('delete from account_provider where account_id = $1', [old.accountId]);
  // b가 old를 흡수했던 이력(사슬 앞단). a가 b를 흡수한 뒤 a가 탈퇴하면 이 행도 지운다(다시 검토 낮음 1)
  await q(
    "insert into account_merge (id, primary_account_id, merged_account_id, merged_provider, moved_summary, requested_at, confirmed_at) values ('0190f3a1-7c2e-7a00-8000-0000000000e1', $1, $2, 'naver', '{}', now(), now())",
    [b.accountId, old.accountId],
  );
  // 흡수 계정의 프로필(합성 값): 병합하면 모두 지운다(POL-034 '흡수 계정의 프로필은 병합 즉시 파기', 새 맥락 리뷰 중간 2)
  await q("update account set nickname = '시험', phone = '01000000000', saved_booker_name = '시험', saved_booker_phone = '01000000000', member_code = 'PGM0001' where id = $1", [b.accountId]);
  const r = await t.add.add({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.token(a), provider: 'google', providerUserId: 'pg-m-g' });
  expect(r.result).toBe('OTHER_ACCOUNT');
  // Redis id:merge는 만든 시각 + 10분의 절대 시각에 사라진다
  expect(Number(await redis.command(['PEXPIRETIME', mergeKey(r.mergeProposalId!)], { key: mergeKey(r.mergeProposalId!) }))).toBe(clock.now() + MERGE_PROPOSAL_TTL_MS);
  await t.confirm.run({ accountId: a.accountId, sessionId: a.sessionId, proposalId: r.mergeProposalId!, reauthToken: await t.token(a) });
  expect(await q('select status, merged_into_account_id, email, email_verified, nickname, phone, saved_booker_name, saved_booker_phone, member_code from account where id = $1', [b.accountId])).toEqual([
    { status: 'MERGED', merged_into_account_id: a.accountId, email: null, email_verified: false, nickname: null, phone: null, saved_booker_name: null, saved_booker_phone: null, member_code: null },
  ]);
  expect(await q('select merged_into_account_id from account where id = $1', [old.accountId])).toEqual([{ merged_into_account_id: a.accountId }]);
  expect(await q("select account_id from account_provider where provider = 'google' and provider_user_id = 'pg-m-g'")).toEqual([{ account_id: a.accountId }]);
  expect(await q('select 1 from session where account_id = $1 and terminated_at is null', [b.accountId])).toHaveLength(0);
  const merges = await q<{ id: string; merged_provider: string; moved_summary: Record<string, number> }>('select id, merged_provider, moved_summary from account_merge where merged_account_id = $1', [b.accountId]);
  expect(merges).toHaveLength(1);
  expect(merges[0]).toMatchObject({ merged_provider: 'google', moved_summary: expect.objectContaining({ providers: 1 }) });
  const ended = await q<{ payload: Buffer }>("select payload from outbox where topic = 'control.sessions-terminated' and msg_key = $1", [b.accountId]);
  expect(ended.map((e) => JSON.parse(e.payload.toString()).reason)).toEqual(['MERGED']);
  const merged = await q<{ payload: Buffer }>("select payload from outbox where topic = 'identity.accounts-merged' and msg_key = $1", [b.accountId]);
  expect(merged.map((e) => JSON.parse(e.payload.toString()))).toEqual([{ mergeId: merges[0]!.id, primaryAccountId: a.accountId, mergedAccountId: b.accountId, confirmedAt: new Date(clock.now()).toISOString() }]);
  // 확정 뒤 제안은 지워진다
  expect(await t.proposals.get(r.mergeProposalId!)).toBeNull();
  // 대표 계정이 탈퇴해 계정을 지우면 병합 이력도 지운다(data-classification '대표 계정이 탈퇴하면 계정 원장과 함께 최종 파기', 새 맥락 리뷰 중간 6)
  await t.sessions.transaction((tx) => tx.eraseAccount(a.accountId, clock.now()));
  expect(await q('select 1 from account_merge where primary_account_id = any($1::uuid[])', [[a.accountId, b.accountId]])).toHaveLength(0);
});

test('새맥락리뷰높음1_PostgreSQL에서_제안뒤흡수계정만본인확인을마쳤으면확정트랜잭션이대표가바뀐것을보고NOT_FOUND이며병합하지않는다', async () => {
  const t = await setup();
  const a = await t.k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'pg-v-k', email: null, deviceId: null });
  const b = await t.k.create.run({ idempotencyKey: newKey(), provider: 'google', providerUserId: 'pg-v-g', email: null, deviceId: null });
  const r = await t.add.add({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.token(a), provider: 'google', providerUserId: 'pg-v-g' });
  // 확정 앞의 확인(pidsOf 대역은 늘 본인확인 전)은 지나가고, 트랜잭션 안에서 본인확인 기록을 읽는다
  await q(
    "insert into identity_verification (account_id, ci_hmac, ci_hmac_key_version, pid, pid_key_version, verified_at, source_record) values ($1, $2, 1, $3, 1, now(), 'test')",
    [b.accountId, Buffer.alloc(32, 7), Buffer.alloc(16, 8)],
  );
  const used = async () => (await q<{ n: string }>('select count(*) as n from reauth_token_use where account_id = $1', [a.accountId]))[0]!.n;
  const before = await used();
  const e = await t.confirm.run({ accountId: a.accountId, sessionId: a.sessionId, proposalId: r.mergeProposalId!, reauthToken: await t.token(a) }).catch((x: unknown) => x);
  expect((e as { code?: string }).code).toBe('NOT_FOUND');
  expect(await q('select status from account where id = $1', [b.accountId])).toEqual([{ status: 'ACTIVE' }]);
  // 트랜잭션을 되돌려 재인증 토큰은 쓰지 않은 것이 되고, 병합할 수 없게 된 제안은 지운다(다시 검토 낮음 3)
  expect(await used()).toBe(before);
  expect(await t.proposals.get(r.mergeProposalId!)).toBeNull();
});

test('다시검토낮음3_PostgreSQL에서_제안뒤두계정모두본인확인을마쳤으면확정트랜잭션이BLOCKED_BOTH_VERIFIED이고제안은남긴다', async () => {
  const t = await setup();
  const a = await t.k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'pg-w-k', email: null, deviceId: null });
  const b = await t.k.create.run({ idempotencyKey: newKey(), provider: 'google', providerUserId: 'pg-w-g', email: null, deviceId: null });
  const r = await t.add.add({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.token(a), provider: 'google', providerUserId: 'pg-w-g' });
  for (const [id, n] of [[a.accountId, 9], [b.accountId, 10]] as const) {
    await q(
      "insert into identity_verification (account_id, ci_hmac, ci_hmac_key_version, pid, pid_key_version, verified_at, source_record) values ($1, $2, 1, $3, 1, now(), 'test')",
      [id, Buffer.alloc(32, n), Buffer.alloc(16, n)],
    );
  }
  const e = await t.confirm.run({ accountId: a.accountId, sessionId: a.sessionId, proposalId: r.mergeProposalId!, reauthToken: await t.token(a) }).catch((x: unknown) => x);
  expect(e).toMatchObject({ code: 'BLOCKED', blockers: ['BOTH_VERIFIED'] });
  expect(await q('select status from account where id = $1', [b.accountId])).toEqual([{ status: 'ACTIVE' }]);
  expect(await t.proposals.get(r.mergeProposalId!)).not.toBeNull();
});

test('PostgreSQL에서_account_hold는판번호가클때만반영하고_열린행이있으면흡수계정의병합을APPEAL_PENDING으로막는다', async () => {
  const t = await setup();
  const a = await t.k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'pg-h-k', email: null, deviceId: null });
  const b = await t.k.create.run({ idempotencyKey: newKey(), provider: 'google', providerUserId: 'pg-h-g', email: null, deviceId: null });
  const ref = '0190f3a1-7c2e-7a00-8000-0000000000c1';
  expect(await t.holds.run({ sourceRef: ref, accountId: b.accountId, kind: 'DISPUTE', state: 'OPEN', sourceVersion: 5 })).toBe('APPLIED');
  expect(await t.holds.run({ sourceRef: ref, accountId: b.accountId, kind: 'DISPUTE', state: 'CLOSED', sourceVersion: 4 })).toBe('STALE');
  expect(await t.holds.run({ sourceRef: ref, accountId: a.accountId, kind: 'DISPUTE', state: 'CLOSED', sourceVersion: 6 })).toBe('CONFLICT');
  const r = await t.add.add({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.token(a), provider: 'google', providerUserId: 'pg-h-g' });
  expect(await t.proposals.get(r.mergeProposalId!)).toMatchObject({ status: 'BLOCKED', blockers: ['APPEAL_PENDING'] });
});

test('새맥락리뷰낮음11_PostgreSQL에서_같은건의처음쓰기가두계정으로겹치면한쪽만APPLIED이고다른쪽은CONFLICT다', async () => {
  const t = await setup();
  const a = await t.k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'pg-r-k', email: null, deviceId: null });
  const b = await t.k.create.run({ idempotencyKey: newKey(), provider: 'google', providerUserId: 'pg-r-g', email: null, deviceId: null });
  for (let n = 0; n < 5; n++) {
    const ref = `0190f3a1-7c2e-7a00-8000-0000000001${String(n).padStart(2, '0')}`;
    const got = await Promise.all([
      t.holds.run({ sourceRef: ref, accountId: a.accountId, kind: 'DISPUTE', state: 'OPEN', sourceVersion: 1 }),
      t.holds.run({ sourceRef: ref, accountId: b.accountId, kind: 'DISPUTE', state: 'OPEN', sourceVersion: 2 }),
    ]);
    expect(got.slice().sort()).toEqual(['APPLIED', 'CONFLICT']);
  }
});
