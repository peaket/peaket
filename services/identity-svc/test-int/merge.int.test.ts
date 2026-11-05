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
import type { MergeProposals, SessionStore, SessionTx } from '../src/modules/session/domain/ports.js';
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

test('BOT-042넘김_PostgreSQL에서_account_merge·account_hold는account를가리키는검증된외래키가있고_없는계정이면SetAccountHold는NOT_FOUND이며병합이력은넣지못한다', async () => {
  const t = await setup();
  const fks = await q<{ conname: string; convalidated: boolean; confdeltype: string }>(
    "select conname, convalidated, confdeltype from pg_constraint where contype = 'f' and conrelid in ('account_merge'::regclass, 'account_hold'::regclass) and confrelid = 'account'::regclass order by conname",
  );
  // 계정 행은 지우지 않으므로(탈퇴도 DELETED로 남긴다, docs/data.md §6) ON DELETE는 기본(NO ACTION, 'a')이다
  expect(fks).toEqual([
    { conname: 'account_hold_account_id_account_id_fk', convalidated: true, confdeltype: 'a' },
    { conname: 'account_merge_merged_account_id_account_id_fk', convalidated: true, confdeltype: 'a' },
    { conname: 'account_merge_primary_account_id_account_id_fk', convalidated: true, confdeltype: 'a' },
  ]);
  const ghost = '0190f3a1-7c2e-7a00-8000-0000000000f9';
  expect(await t.holds.run({ sourceRef: '0190f3a1-7c2e-7a00-8000-0000000000c9', accountId: ghost, kind: 'APPEAL', state: 'OPEN', sourceVersion: 1 })).toBe('NOT_FOUND');
  expect(await q('select 1 from account_hold where account_id = $1', [ghost])).toHaveLength(0);
  const a = await t.k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'pg-fk-k', email: null, deviceId: null });
  await expect(
    q("insert into account_merge (id, primary_account_id, merged_account_id, merged_provider, moved_summary, requested_at, confirmed_at) values ('0190f3a1-7c2e-7a00-8000-0000000000e9', $1, $2, 'naver', '{}', now(), now())", [a.accountId, ghost]),
  ).rejects.toMatchObject({ code: '23503' });
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

/** 끝을 밖에서 정하는 약속 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** 트랜잭션마다 tx 호출 앞뒤에 끼어드는 저장소(로그인·확정이 잠그는 차례를 시험이 정한다). n은 그 트랜잭션 안에서 그 메서드를 부른 차례(1부터) */
function gated(store: SessionStore, hook: { before?: (k: string, n: number, args: unknown[]) => Promise<void> | void; after?: (k: string, n: number, args: unknown[]) => Promise<void> | void }): SessionStore {
  return new Proxy(store, {
    get(target, key, recv) {
      if (key !== 'transaction') return Reflect.get(target, key, recv);
      return <T>(fn: (tx: SessionTx) => Promise<T>) =>
        target.transaction((tx) => {
          const seen = new Map<string, number>();
          return fn(
            new Proxy(tx, {
              get(t, k, r) {
                const v = Reflect.get(t, k, r);
                if (typeof v !== 'function' || typeof k !== 'string') return v;
                return async (...args: unknown[]) => {
                  const n = (seen.get(k) ?? 0) + 1;
                  seen.set(k, n);
                  await hook.before?.(k, n, args);
                  const out: unknown = await (v as (...a: unknown[]) => Promise<unknown>).apply(t, args);
                  await hook.after?.(k, n, args);
                  return out;
                };
              },
            }),
          );
        });
    },
  });
}

/** 오류의 PostgreSQL 코드(drizzle이 감싼 원인까지) */
const pgCode = (e: unknown): string | undefined => {
  for (let x = e as { code?: unknown; cause?: unknown } | undefined; x; x = x.cause as typeof x) if (typeof x.code === 'string' && /^[0-9A-Z]{5}$/.test(x.code)) return x.code;
  return undefined;
};

/** 다른 연결이 행 잠금을 기다릴 때까지(5초까지) */
async function untilLockWait(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [r] = await q<{ n: number }>("select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'");
    if (r!.n > 0) return;
    await new Promise((x) => setTimeout(x, 20));
  }
}

test('BOT-042넘김_PostgreSQL에서_같은제안을같은재인증토큰으로동시에두번확정하면_한쪽만병합하고다른쪽은404이며교착없이끝난다', async () => {
  const t = await setup();
  for (let n = 0; n < 4; n++) {
    const a = await t.k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: `pg-cc-k${n}`, email: null, deviceId: null });
    const b = await t.k.create.run({ idempotencyKey: newKey(), provider: 'google', providerUserId: `pg-cc-g${n}`, email: null, deviceId: null });
    const r = await t.add.add({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.token(a), provider: 'google', providerUserId: `pg-cc-g${n}` });
    const token = await t.token(a);
    const got = await Promise.allSettled([0, 1].map(() => t.confirm.run({ accountId: a.accountId, sessionId: a.sessionId, proposalId: r.mergeProposalId!, reauthToken: token })));
    expect(got.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const lost = got.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(pgCode(lost.reason)).toBeUndefined();
    expect((lost.reason as { code?: string }).code).toBe('NOT_FOUND');
    expect(await q('select 1 from account_merge where merged_account_id = $1', [b.accountId])).toHaveLength(1);
    expect(await q<{ n: number }>("select count(*)::int as n from outbox where topic = 'identity.accounts-merged' and msg_key = $1", [b.accountId])).toEqual([{ n: 1 }]);
  }
});

test('BOT-042넘김_PostgreSQL에서_흡수될쪽이확정을동시에두번보내면_한쪽만병합하고다른쪽은세션이끝났어도404다', async () => {
  const t = await setup();
  const a = await t.k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'pg-ca-k', email: null, deviceId: null });
  const b = await t.k.create.run({ idempotencyKey: newKey(), provider: 'google', providerUserId: 'pg-ca-g', email: null, deviceId: null });
  // b만 본인확인을 마쳐 대표가 b이고, 지금 계정 a가 흡수된다
  await q(
    "insert into identity_verification (account_id, ci_hmac, ci_hmac_key_version, pid, pid_key_version, verified_at, source_record) values ($1, $2, 1, $3, 1, now(), 'test')",
    [b.accountId, Buffer.alloc(32, 21), Buffer.alloc(16, 21)],
  );
  const planner = new MergePlanner(t.sessions, { pidsOf: async (id) => (id === b.accountId ? ['pid'] : []) }, (['purchase', 'ticket', 'core'] as const).map(noBlockChecker), t.proposals, clock);
  const reauth = new JoseReauthVerifier(t.k.keys, ISSUER, clock);
  const add = new AddProvider(t.sessions, reauth, clock, planner);
  const confirm = new ConfirmMerge(t.sessions, reauth, planner, t.proposals, clock);
  const r = await add.add({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.token(a), provider: 'google', providerUserId: 'pg-ca-g' });
  expect(await t.proposals.get(r.mergeProposalId!)).toMatchObject({ primaryAccountId: b.accountId, absorbedAccountId: a.accountId });
  const token = await t.token(a);
  const got = await Promise.allSettled([0, 1].map(() => confirm.run({ accountId: a.accountId, sessionId: a.sessionId, proposalId: r.mergeProposalId!, reauthToken: token })));
  expect(got.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  const lost = got.find((x) => x.status === 'rejected') as PromiseRejectedResult;
  expect((lost.reason as { code?: string }).code).toBe('NOT_FOUND');
  expect(await q('select status from account where id = $1', [a.accountId])).toEqual([{ status: 'MERGED' }]);
});

test('BOT-042넘김_PostgreSQL에서_병합도중로그인이흡수계정X를잠근뒤대표P로옮겨진것을보고_같은쌍의두번째확정이P를잡고X를기다려도교착(40P01)없이끝난다', async () => {
  const t = await setup();
  // 두 계정 가운데 ID가 작은 쪽을 대표 P(제안한 계정)로 한다: 확정은 P → X, 옮겨진 것을 본 로그인은 X → P 차례로 잠근다
  const one = await t.k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'pg-dl-1', email: null, deviceId: null });
  const two = await t.k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'pg-dl-2', email: null, deviceId: null });
  const [p, x] = one.accountId < two.accountId ? [one, two] : [two, one];
  // X에는 카카오를 지우고 구글(추가할 수단)과 네이버(로그인할 수단)를 둔다
  await q('delete from account_provider where account_id = $1', [x.accountId]);
  await t.sessions.transaction(async (tx) => {
    await tx.linkProvider(x.accountId, 'google', 'pg-dl-g', clock.now());
    await tx.linkProvider(x.accountId, 'naver', 'pg-dl-n', clock.now());
  });
  const r = await t.add.add({ accountId: p.accountId, sessionId: p.sessionId, reauthToken: await t.token(p), provider: 'google', providerUserId: 'pg-dl-g' });
  expect(await t.proposals.get(r.mergeProposalId!)).toMatchObject({ primaryAccountId: p.accountId, absorbedAccountId: x.accountId });
  // 두 번째 확정은 첫 확정이 제안을 지우기 전에 제안을 읽었다
  const snap = (await t.proposals.get(r.mergeProposalId!))!;
  const stale = { save: t.proposals.save.bind(t.proposals), get: async () => snap, remove: async () => {} } as unknown as MergeProposals;
  const lFound = deferred();
  const aDone = deferred();
  const lHoldsX = deferred();
  let lFirst = true;
  // 로그인 L(X의 네이버): 계정을 찾은 뒤 첫 확정이 끝날 때까지 멈추고, X를 잠근 뒤 옮겨진 P를 잠그기 전에는 두 번째 확정이 X를 기다릴 때까지 멈춘다
  const lStore = gated(t.sessions, {
    after: async (k, n) => {
      if (k === 'findAccountByProvider' && n === 1 && lFirst) {
        lFirst = false;
        lFound.resolve();
        await aDone.promise;
      }
      if (k === 'lockAccount' && n === 1) lHoldsX.resolve();
    },
    before: async (k, n) => {
      if (k === 'lockAccount' && n === 2) await untilLockWait();
    },
  });
  const lKit = await kit(lStore, { clock });
  const login = lKit.create.run({ idempotencyKey: newKey(), provider: 'naver', providerUserId: 'pg-dl-n', email: null, deviceId: null });
  await lFound.promise;
  await t.confirm.run({ accountId: p.accountId, sessionId: p.sessionId, proposalId: r.mergeProposalId!, reauthToken: await t.token(p) });
  // 두 번째 확정 B: P를 잡은 뒤 L이 X를 잡을 때까지 기다렸다가 X를 잠근다
  const bStore = gated(t.sessions, {
    before: async (k, _n, args) => {
      if (k === 'lockAccount' && args[0] === x.accountId) await lHoldsX.promise;
    },
  });
  const bReauth = new JoseReauthVerifier(t.k.keys, ISSUER, clock);
  const bPlanner = new MergePlanner(bStore, { pidsOf: async () => [] }, (['purchase', 'ticket', 'core'] as const).map(noBlockChecker), stale, clock);
  const second = new ConfirmMerge(bStore, bReauth, bPlanner, stale, clock).run({ accountId: p.accountId, sessionId: p.sessionId, proposalId: r.mergeProposalId!, reauthToken: await t.token(p) });
  aDone.resolve();
  const [l, b] = await Promise.allSettled([login, second]);
  for (const o of [l, b]) if (o.status === 'rejected') expect(pgCode(o.reason)).not.toBe('40P01');
  expect(l).toMatchObject({ status: 'fulfilled', value: { accountId: p.accountId } });
  expect(b.status).toBe('rejected');
  expect(((b as PromiseRejectedResult).reason as { code?: string }).code).toBe('NOT_FOUND');
  expect(await q('select 1 from session where account_id = $1 and terminated_at is null', [x.accountId])).toHaveLength(0);
});

test('BOT-042넘김_PostgreSQL에서_마이그레이션0026은없는계정의account_hold행만지우고_있는계정의행과병합이력은남긴뒤외래키를검증한다', async () => {
  const t = await setup();
  const a = await t.k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'pg-or-k', email: null, deviceId: null });
  const b = await t.k.create.run({ idempotencyKey: newKey(), provider: 'google', providerUserId: 'pg-or-g', email: null, deviceId: null });
  const ghost = '0190f3a1-7c2e-7a00-8000-0000000000f8';
  const { readFileSync } = await import('node:fs');
  const statements = (n: string) =>
    readFileSync(new URL(`../migrations/${n}.sql`, import.meta.url), 'utf8')
      .split('--> statement-breakpoint')
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
  const fks = ['account_hold_account_id_account_id_fk', 'account_merge_primary_account_id_account_id_fk', 'account_merge_merged_account_id_account_id_fk'];
  // 0025 앞의 상태로 돌린다(외래키 없음): 없는 계정의 건(SetAccountHold가 그때는 받았다)과 있는 계정의 건·병합 이력을 둔다
  for (const fk of fks) await q(`alter table ${fk.startsWith('account_hold') ? 'account_hold' : 'account_merge'} drop constraint ${fk}`);
  await q("insert into account_hold (source_ref, account_id, kind, state, source_version, updated_at) values ('0190f3a1-7c2e-7a00-8000-0000000000c8', $1, 'DISPUTE', 'OPEN', 1, now())", [ghost]);
  await q("insert into account_hold (source_ref, account_id, kind, state, source_version, updated_at) values ('0190f3a1-7c2e-7a00-8000-0000000000c7', $1, 'APPEAL', 'OPEN', 1, now())", [a.accountId]);
  await q(
    "insert into account_merge (id, primary_account_id, merged_account_id, merged_provider, moved_summary, requested_at, confirmed_at) values ('0190f3a1-7c2e-7a00-8000-0000000000e8', $1, $2, 'google', '{}', now(), now())",
    [a.accountId, b.accountId],
  );
  // 마이그레이션 파일의 문장을 그대로 다시 돌린다(0025: NOT VALID로 더함, 0026: 고아 지우기와 검증)
  for (const x of [...statements('0025_account_merge_hold_fk'), ...statements('0026_account_merge_hold_fk_validate')]) await q(x);
  expect(await q('select account_id from account_hold where source_ref = $1', ['0190f3a1-7c2e-7a00-8000-0000000000c8'])).toEqual([]);
  expect(await q('select account_id from account_hold where source_ref = $1', ['0190f3a1-7c2e-7a00-8000-0000000000c7'])).toEqual([{ account_id: a.accountId }]);
  expect(await q('select merged_account_id from account_merge where id = $1', ['0190f3a1-7c2e-7a00-8000-0000000000e8'])).toEqual([{ merged_account_id: b.accountId }]);
  expect(await q<{ conname: string; convalidated: boolean }>('select conname, convalidated from pg_constraint where conname = any($1::text[]) order by conname', [fks])).toEqual(
    [...fks].sort().map((conname) => ({ conname, convalidated: true })),
  );
});
