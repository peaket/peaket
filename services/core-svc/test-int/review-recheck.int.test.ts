// I-T83 ④⑤⑦(W8-audit2a, 소유자 결정 2026-11-16 OPEN[44], ADR-0278): 탈퇴 후기 다시 정리 예약(review_withdrawal_recheck)을 실제 PostgreSQL 18에서
// 운영과 같은 DB 역할(core_app)로 본다. ④ 파기와 예약은 한 트랜잭션이고 같은 계정은 늦은 예약을 남긴다. ⑤ 때가 된 예약을 SKIP LOCKED로 잠가 다시 파기하고 지운다
// (두 반복이 겹쳐도 한 예약은 한 번만). ⑦ 예약 표 권한은 core_app의 읽기·넣기·지우기·예약 시각 고치기뿐이다(docs/data.md §2 '후기 표의 DB 권한').
// 정본: docs/features/identity.md §8 '다시 정리', docs/data.md §2 '다시 정리 예약'·§5.1 '탈퇴 파기', docs/streaming.md §2.6 'core-svc 소비자'.
// 예약 시각·처리 시각은 시험이 nowMs로 넘긴다(DB 시계와 견주지 않는다). 시험 자료 넣기와 확인은 관리자(슈퍼유저) 연결로 한다.
import 'reflect-metadata';
import { createDatabase, type Database } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { review } from '../src/modules/review/adapters/db/schema.js';
import { DrizzleReviewStore } from '../src/modules/review/index.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

let pg: PostgresContainer;
let admin: Database;
let app: Database;
let app2: Database;
let partner: Database;
let maint: Database;
let ops: Database;
const MIN = 60_000;
const NOW = Date.parse('2026-11-16T03:19:00.000Z');

/** 그 연결로 SQL 하나를 돌려 PostgreSQL 오류 코드를 돌려준다(성공이면 'OK') */
const codeOf = async (db: Database, text: string, params: unknown[] = []): Promise<string> => {
  try {
    await db.pool.query(text, params);
    return 'OK';
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
};
/** 던진 오류의 PostgreSQL 코드(Drizzle이 감싸면 cause에서) */
const pgCode = (err: unknown): string | undefined => {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | undefined;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === 'string' ? code : undefined;
};

async function seedReview(accountId: string): Promise<string> {
  const id = randomUUID();
  const at = new Date('2026-11-15T10:00:00Z');
  await admin.db.insert(review).values({
    id,
    eventId: randomUUID(),
    accountId,
    basisOrderId: randomUUID(),
    rating: 5,
    body: '다시 정리 통합 시험용 후기 본문입니다.',
    status: 'VISIBLE',
    contentFingerprint: `fp-${id}`,
    authorDisplay: '김**',
    createdAt: at,
    updatedAt: at,
  });
  return id;
}
const statusOf = async (id: string): Promise<{ status: string; rating: number | null; account_id: string }> =>
  (await admin.pool.query('select status, rating, account_id from review where id = $1', [id])).rows[0];
const rechecks = async (): Promise<{ account_id: string; due_at: Date }[]> =>
  (await admin.pool.query('select account_id, due_at from review_withdrawal_recheck order by due_at, account_id')).rows;
/** 예약을 바로 넣는다(시험 자료) */
const seedRecheck = (accountId: string, dueMs: number) =>
  admin.pool.query('insert into review_withdrawal_recheck (account_id, due_at, created_at) values ($1, $2, $3)', [accountId, new Date(dueMs), new Date(dueMs - 16 * MIN)]);

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-review-recheck-admin', max: 4 });
  app = await loginFor(admin, pg, 'core_app_review_recheck', 'core_app', 2);
  app2 = await loginFor(admin, pg, 'core_app_review_recheck_2', 'core_app', 2);
  partner = await loginFor(admin, pg, 'core_partner_review_recheck', 'core_partner', 1);
  maint = await loginFor(admin, pg, 'core_maintenance_review_recheck', 'core_maintenance', 1);
  ops = await loginFor(admin, pg, 'core_ops_review_recheck', 'core_ops', 1);
});
afterAll(async () => {
  for (const db of [ops, maint, partner, app2, app]) await db?.close();
  await admin?.close();
  pg?.stop();
});
beforeEach(async () => {
  // 시험마다 예약 표를 비운다(표가 없으면 이 줄에서 실패한다: 0026 전)
  await admin.pool.query('delete from review_withdrawal_recheck');
});

describe('I-T83 다시 정리 예약(실제 DB)', () => {
  test('I-T83 ④ 파기와 예약은 한 트랜잭션이다', async () => {
    const A = randomUUID();
    const r1 = await seedReview(A);
    const store = new DrizzleReviewStore(app);
    const recheckAtMs = Date.parse('2026-11-16T03:16:00.000Z');
    const nowMs = Date.parse('2026-11-16T03:03:00.000Z');

    // 예약 넣기만 실패하게 한다: 관리자 연결로 core_app의 예약 표 INSERT를 잠시 거둔다
    await admin.pool.query('revoke insert on review_withdrawal_recheck from core_app');
    const rejected: unknown[] = [];
    try {
      await store.purgeWithdrawnAccount(A, { nowMs, recheckAtMs }).catch((err: unknown) => void rejected.push(err));
    } finally {
      await admin.pool.query('grant insert on review_withdrawal_recheck to core_app');
    }
    // 끊긴 사례가 실제로 있었다(거절 1건, 권한 오류)
    expect(rejected).toHaveLength(1);
    expect(pgCode(rejected[0])).toBe('42501');
    // 예약이 실패했으니 파기도 없다
    expect(await statusOf(r1)).toEqual({ status: 'VISIBLE', rating: 5, account_id: A });
    expect(await rechecks()).toEqual([]);

    // 권한을 돌린 뒤 다시 하면 파기와 예약이 둘 다 있다
    expect(await store.purgeWithdrawnAccount(A, { nowMs, recheckAtMs })).toBe(1);
    expect(await statusOf(r1)).toEqual({ status: 'DELETED', rating: null, account_id: r1 });
    expect(await rechecks()).toEqual([{ account_id: A, due_at: new Date(recheckAtMs) }]);
    const created = (await admin.pool.query('select created_at from review_withdrawal_recheck where account_id = $1', [A])).rows[0].created_at as Date;
    expect(created).toEqual(new Date(nowMs));
  });

  test('I-T83 ④ 파기가 실패하면 다시 정리 예약도 남지 않는다', async () => {
    // 리뷰 A3: 구현은 '예약 upsert → 파기' 차례다. 위 시험(예약 넣기를 막음)의 반대쪽으로, 둘째 문장(파기)만 실패하게 해 첫 문장(예약)도 되돌려지는지 본다.
    // 두 문장을 따로 자동 커밋하는 틀린 구현(예약 먼저)은 예약 행이 남아 여기서 잡힌다. 기준 시각은 DB 서버 시각에서 잡는다
    const A = randomUUID();
    const r1 = await seedReview(A);
    const store = new DrizzleReviewStore(app);
    const nowMs = Math.floor(Number((await admin.pool.query('select (extract(epoch from now()) * 1000)::float8 as ms')).rows[0].ms));
    const recheckAtMs = nowMs + 13 * MIN;

    // 파기만 실패하게 한다: 관리자 연결로 core_app의 review.rating 고치기를 잠시 거둔다(예약 표 권한은 그대로)
    await admin.pool.query('revoke update (rating) on review from core_app');
    const rejected: unknown[] = [];
    try {
      await store.purgeWithdrawnAccount(A, { nowMs, recheckAtMs }).catch((err: unknown) => void rejected.push(err));
    } finally {
      await admin.pool.query('grant update (rating) on review to core_app');
    }
    // 끊긴 사례가 실제로 있었다(거절 1건, 권한 오류)
    expect(rejected).toHaveLength(1);
    expect(pgCode(rejected[0])).toBe('42501');
    // 파기가 실패했으니 예약도 없고 후기는 그대로다
    expect(await rechecks()).toEqual([]);
    expect(await statusOf(r1)).toEqual({ status: 'VISIBLE', rating: 5, account_id: A });

    // 권한을 돌린 뒤 다시 하면 파기와 예약이 둘 다 있다
    expect(await store.purgeWithdrawnAccount(A, { nowMs, recheckAtMs })).toBe(1);
    expect(await statusOf(r1)).toEqual({ status: 'DELETED', rating: null, account_id: r1 });
    expect(await rechecks()).toEqual([{ account_id: A, due_at: new Date(recheckAtMs) }]);
  });

  test('I-T83 ④ 같은 계정 예약은 늦은 쪽을 남긴다', async () => {
    const A = randomUUID();
    const store = new DrizzleReviewStore(app);
    const t = (iso: string) => Date.parse(iso);
    expect(await store.purgeWithdrawnAccount(A, { nowMs: t('2026-11-16T03:05:00.000Z'), recheckAtMs: t('2026-11-16T03:19:00.000Z') })).toBe(0);
    // 이른 시각이 와도 그대로
    await store.purgeWithdrawnAccount(A, { nowMs: t('2026-11-16T03:06:00.000Z'), recheckAtMs: t('2026-11-16T03:06:00.000Z') });
    expect(await rechecks()).toEqual([{ account_id: A, due_at: new Date(t('2026-11-16T03:19:00.000Z')) }]);
    // 늦은 시각이 오면 옮긴다
    await store.purgeWithdrawnAccount(A, { nowMs: t('2026-11-16T03:10:00.000Z'), recheckAtMs: t('2026-11-16T03:21:00.000Z') });
    expect(await rechecks()).toEqual([{ account_id: A, due_at: new Date(t('2026-11-16T03:21:00.000Z')) }]);
  });

  test('I-T83 ⑤ 다른 연결이 잠근 예약은 건너뛰고 기다리지 않는다', async () => {
    const [X, Y, Z] = [randomUUID(), randomUUID(), randomUUID()];
    const reviewsOf = { [X]: await seedReview(X), [Y]: await seedReview(Y), [Z]: await seedReview(Z) };
    for (const [i, id] of [X, Y, Z].entries()) await seedRecheck(id, NOW - (3 - i) * MIN);
    const store = new DrizzleReviewStore(app);

    // 다른 반복이 X 예약을 잡고 있는 것처럼 관리자 연결로 잠가 둔다
    const holder = await admin.pool.connect();
    try {
      await holder.query('begin');
      await holder.query('select account_id from review_withdrawal_recheck where account_id = $1 for update', [X]);
      const run = store.runDueRechecks(NOW, 3);
      const timeout = new Promise<'기다림'>((r) => setTimeout(() => r('기다림'), 3_000));
      // SKIP LOCKED: 잠긴 X를 건너뛰고 Y·Z만 곧바로 처리한다(기다리지 않는다)
      expect(await Promise.race([run, timeout])).toEqual({ accounts: 2, purged: 2 });
      expect((await statusOf(reviewsOf[X]!)).status).toBe('VISIBLE');
      expect((await statusOf(reviewsOf[Y]!)).status).toBe('DELETED');
      expect((await statusOf(reviewsOf[Z]!)).status).toBe('DELETED');
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
    // 잠금이 풀리면 X를 처리한다
    expect(await store.runDueRechecks(NOW, 3)).toEqual({ accounts: 1, purged: 1 });
    expect((await statusOf(reviewsOf[X]!)).status).toBe('DELETED');
    expect(await rechecks()).toEqual([]);
  });

  test('I-T83 ⑤ 두 반복이 겹쳐도 한 예약은 한 번만 잡고 처리한 예약은 지운다', async () => {
    const due = [randomUUID(), randomUUID(), randomUUID()];
    const notYet = randomUUID();
    const reviewIds = new Map<string, string>();
    for (const id of [...due, notYet]) reviewIds.set(id, await seedReview(id));
    // 예약 시각: 둘은 지났고 하나는 정각(<=라 때가 됐다), 하나는 1ms 뒤(아직)
    await seedRecheck(due[0]!, NOW - 2 * MIN);
    await seedRecheck(due[1]!, NOW - MIN);
    await seedRecheck(due[2]!, NOW);
    await seedRecheck(notYet, NOW + 1);

    // 서로 다른 연결 풀 둘에서 한 번에 둘씩 동시에
    const [r1, r2] = await Promise.all([new DrizzleReviewStore(app).runDueRechecks(NOW, 2), new DrizzleReviewStore(app2).runDueRechecks(NOW, 2)]);
    expect(r1.accounts + r2.accounts).toBe(3);
    expect(r1.purged + r2.purged).toBe(3);
    for (const id of due) expect((await statusOf(reviewIds.get(id)!)).status, id).toBe('DELETED');
    expect((await statusOf(reviewIds.get(notYet)!)).status).toBe('VISIBLE');
    // 남은 예약은 때가 안 된 하나뿐이다(처리한 예약의 계정 ID가 남지 않는다)
    expect(await rechecks()).toEqual([{ account_id: notYet, due_at: new Date(NOW + 1) }]);
    // 다시 불러도 0
    expect(await new DrizzleReviewStore(app).runDueRechecks(NOW, 2)).toEqual({ accounts: 0, purged: 0 });
  });

  test('I-T83 ⑤ 가장 오래 밀린 예약의 지난 시간을 ms로 준다', async () => {
    const store = new DrizzleReviewStore(app);
    expect(await store.oldestOverdueRecheckMs(NOW)).toBe(0);
    await seedRecheck(randomUUID(), NOW + 5 * MIN);
    expect(await store.oldestOverdueRecheckMs(NOW)).toBe(0);
    await seedRecheck(randomUUID(), NOW);
    expect(await store.oldestOverdueRecheckMs(NOW)).toBe(0);
    await seedRecheck(randomUUID(), NOW - 7 * MIN - 250);
    await seedRecheck(randomUUID(), NOW - 2 * MIN);
    expect(await store.oldestOverdueRecheckMs(NOW)).toBe(7 * MIN + 250);
  });

  test('I-T83 ⑦ 예약 표 권한은 core_app의 읽기·넣기·지우기·예약 시각 고치기뿐이다', async () => {
    const A = randomUUID();
    await seedRecheck(A, NOW);
    // 대조군(허용 쪽): core_app은 읽고, 넣고, 예약 시각을 고치고, 지운다
    const B = randomUUID();
    expect(await codeOf(app, 'select account_id, due_at, created_at from review_withdrawal_recheck where account_id = $1', [A])).toBe('OK');
    expect(await codeOf(app, 'insert into review_withdrawal_recheck (account_id, due_at, created_at) values ($1, $2, $2)', [B, new Date(NOW)])).toBe('OK');
    expect(await codeOf(app, 'update review_withdrawal_recheck set due_at = $1 where account_id = $2', [new Date(NOW + MIN), B])).toBe('OK');
    expect(await codeOf(app, 'delete from review_withdrawal_recheck where account_id = $1', [B])).toBe('OK');

    // 거부 쪽: core_app의 다른 칸 고치기·비우기, 다른 역할의 읽기·넣기
    const denied: [string, Database, string, unknown[]][] = [
      ['core_app account_id 고치기', app, 'update review_withdrawal_recheck set account_id = $1 where account_id = $2', [randomUUID(), A]],
      ['core_app created_at 고치기', app, 'update review_withdrawal_recheck set created_at = $1 where account_id = $2', [new Date(NOW), A]],
      ['core_app 비우기', app, 'truncate review_withdrawal_recheck', []],
      ['core_partner 읽기', partner, 'select account_id from review_withdrawal_recheck', []],
      ['core_partner 넣기', partner, 'insert into review_withdrawal_recheck (account_id, due_at, created_at) values ($1, $2, $2)', [randomUUID(), new Date(NOW)]],
      ['core_maintenance 읽기', maint, 'select account_id from review_withdrawal_recheck', []],
      ['core_maintenance 지우기', maint, 'delete from review_withdrawal_recheck', []],
      ['core_ops 읽기', ops, 'select account_id from review_withdrawal_recheck', []],
    ];
    for (const [what, db, text, params] of denied) expect(await codeOf(db, text, params), what).toBe('42501');
    expect(await rechecks()).toEqual([{ account_id: A, due_at: new Date(NOW) }]);
  });
});
