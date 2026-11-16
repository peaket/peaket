// I-T83 ⑧(W8-audit2a 리뷰 A2, 계획 §8.2): 정비 일 review-purge-legacy를 실제 PostgreSQL 18에서 운영과 같은 정비 역할(core_maintenance)로 돌린다.
// 관리자 연결로 0026 전 이전 판이 남긴 두 꼴(작성자가 지웠는데 별점·지문·계정이 남은 행, 옛 익명화로 account_id = id인 살아 있는 후기)을 넣고,
// 정비 일이 그 행만 docs/data.md §2 '후기 파기'의 칸으로 고치는지, 잠긴 행은 건너뛰는지(SKIP LOCKED), 다시 돌리면 0행인지,
// 그 뒤 다음 출시의 파기 행 CHECK(docs/data.md §2 '마이그레이션 나눔'의 글)를 VALIDATE할 수 있는지 본다(정비 일 전에는 23514로 실패한다).
// 기준 시각은 DB 서버 시각에서 잡는다. 시험 자료 넣기와 확인·CHECK 시험은 관리자(슈퍼유저) 연결로 하고 CHECK는 되돌린다.
import 'reflect-metadata';
import { createDatabase, fakeClock, type Database, type MaintenanceTask } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { DrizzleReviewStore, reviewMaintenanceTasks } from '../src/modules/review/index.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

let pg: PostgresContainer;
let admin: Database;
let maint: Database;
/** DB 서버 시각(beforeAll) */
let NOW: number;
const DAY = 86_400_000;

/** 다음 출시가 더할 파기 행 CHECK(정본 docs/data.md §2 '후기 파기'의 '마이그레이션 나눔' 글) */
const PURGED_SHAPE_CHECK = `status <> 'DELETED' OR (body = '' AND rating IS NULL AND content_fingerprint IS NULL AND account_id = id AND basis_order_id = id)`;

interface Row {
  id: string;
  event_id: string;
  account_id: string;
  basis_order_id: string;
  rating: number | null;
  body: string;
  status: string;
  notice: string | null;
  notice_until: Date | null;
  content_fingerprint: string | null;
  author_display: string;
  edited: boolean;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}
const rowOf = async (id: string): Promise<Row> =>
  (
    await admin.pool.query<Row>(
      'select id, event_id, account_id, basis_order_id, rating, body, status, notice, notice_until, content_fingerprint, author_display, edited, created_at, updated_at, deleted_at from review where id = $1',
      [id],
    )
  ).rows[0]!;

/** 관리자 연결로 한 행을 그대로 넣는다(0026 전 이전 판 모양도 넣을 수 있게 직접 SQL) */
async function seed(o: {
  status: string;
  accountId?: string;
  basisOrderId?: string;
  rating: number | null;
  fingerprint: string | null;
  body: string;
  authorDisplay: string;
  notice?: string | null;
  deletedAt?: Date | null;
}): Promise<string> {
  const id = randomUUID();
  const at = new Date(NOW - 10 * DAY);
  await admin.pool.query(
    `insert into review (id, event_id, account_id, basis_order_id, rating, body, status, notice, content_fingerprint, author_display, edited, created_at, updated_at, deleted_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, $11, $12, $13)`,
    [
      id,
      randomUUID(),
      o.accountId === 'SELF' ? id : (o.accountId ?? randomUUID()),
      o.basisOrderId === 'SELF' ? id : (o.basisOrderId ?? randomUUID()),
      o.rating,
      o.body,
      o.status,
      o.notice ?? null,
      o.fingerprint,
      o.authorDisplay,
      at,
      o.deletedAt ?? at,
      o.deletedAt ?? null,
    ],
  );
  return id;
}

/** 관리자 트랜잭션에서 파기 행 CHECK를 더하고 두 CHECK를 VALIDATE한 뒤 되돌린다. 성공이면 'OK', 아니면 오류 코드 */
async function validateNextRelease(): Promise<string> {
  const client = await admin.pool.connect();
  try {
    await client.query('begin');
    await client.query(`alter table review add constraint review_purged_shape_check check (${PURGED_SHAPE_CHECK}) not valid`);
    await client.query('alter table review validate constraint review_purged_shape_check');
    await client.query('alter table review validate constraint review_live_complete_check');
    return 'OK';
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }
}

const legacyTask = (nowMs: number, batch?: number): MaintenanceTask => {
  const task = reviewMaintenanceTasks(new DrizzleReviewStore(maint), fakeClock({ now: nowMs }), batch === undefined ? {} : { batch }).find((t) => t.name === 'review-purge-legacy');
  expect(task, '정비 일 review-purge-legacy').toBeDefined();
  return task!;
};

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-review-purge-legacy-admin', max: 3 });
  maint = await loginFor(admin, pg, 'core_maintenance_review_legacy', 'core_maintenance', 2);
  NOW = Math.floor(Number((await admin.pool.query('select (extract(epoch from now()) * 1000)::float8 as ms')).rows[0].ms));
});
afterAll(async () => {
  await maint?.close();
  await admin?.close();
  pg?.stop();
});

describe('I-T83 이전 판 행 고치기(실제 DB, 리뷰 A2)', () => {
  test('I-T83 ⑧ 정비 역할로 이전 판 행을 고치고 그 뒤 파기 행 CHECK를 VALIDATE할 수 있다', async () => {
    const OLD_DELETED = new Date(NOW - 3 * DAY);
    const A = randomUUID();
    // ⓐ 옛 작성자 지우기(별점·지문·계정이 남음) ⓑ 옛 익명화(보이는 후기) ⓒ 옛 익명화(통보로 가린 후기) ⓕ 지문만 남은 DELETED ⓖ 계정만 남은 DELETED
    const a = await seed({ status: 'DELETED', accountId: A, rating: 4, fingerprint: 'fp-legacy-a', body: '', authorDisplay: '***', deletedAt: OLD_DELETED });
    const b = await seed({ status: 'VISIBLE', accountId: 'SELF', basisOrderId: 'SELF', rating: 5, fingerprint: 'fp-legacy-b', body: '옛 익명화로 남은 보이는 후기 본문입니다.', authorDisplay: '탈퇴한 사용자' });
    const c = await seed({ status: 'HIDDEN', accountId: 'SELF', basisOrderId: 'SELF', rating: 2, fingerprint: 'fp-legacy-c', body: '옛 익명화로 남은 가린 후기 본문입니다.', authorDisplay: '탈퇴한 사용자', notice: 'POLICY' });
    const f = await seed({ status: 'DELETED', accountId: A, rating: null, fingerprint: 'fp-legacy-f', body: '', authorDisplay: '', deletedAt: OLD_DELETED });
    const g = await seed({ status: 'DELETED', accountId: A, basisOrderId: 'SELF', rating: null, fingerprint: null, body: '', authorDisplay: '', deletedAt: OLD_DELETED });
    // ⓓ 제대로 파기된 행 ⓔ 다른 계정의 살아 있는 후기(둘 다 그대로여야 한다)
    const d = await seed({ status: 'DELETED', accountId: 'SELF', basisOrderId: 'SELF', rating: null, fingerprint: null, body: '', authorDisplay: '', deletedAt: new Date(NOW - 2 * DAY) });
    const e = await seed({ status: 'VISIBLE', rating: 3, fingerprint: 'fp-live-e', body: '다른 계정의 살아 있는 후기 본문입니다.', authorDisplay: '김**' });
    const legacy = [a, b, c, f, g];
    const before = new Map<string, Row>();
    for (const id of [...legacy, d, e]) before.set(id, await rowOf(id));

    // 정비 일 전에는 다음 출시의 VALIDATE가 실패한다(대조군: 이 시험이 실제로 이전 판 행을 만들었다)
    expect(await validateNextRelease()).toBe('23514');

    // 묶음 2(경계가 여러 번 생기게)로 정비 역할 연결에서 돌린다
    expect(await legacyTask(NOW, 2).run(new AbortController().signal)).toEqual({ purged: 5 });
    for (const id of legacy) {
      const was = before.get(id)!;
      expect(await rowOf(id), id).toEqual({
        ...was,
        account_id: id,
        basis_order_id: id,
        rating: null,
        body: '',
        status: 'DELETED',
        notice: null,
        notice_until: null,
        content_fingerprint: null,
        author_display: '',
        updated_at: new Date(NOW),
        // 처음 지운 시각: 이미 있으면 그대로
        deleted_at: was.deleted_at ?? new Date(NOW),
      });
    }
    // 제대로 파기된 행과 다른 살아 있는 후기는 갱신 시각까지 그대로
    expect(await rowOf(d)).toEqual(before.get(d));
    expect(await rowOf(e)).toEqual(before.get(e));

    // 다시 돌리면 0행이고 행이 그대로다
    const once = new Map<string, Row>();
    for (const id of [...legacy, d, e]) once.set(id, await rowOf(id));
    expect(await legacyTask(NOW + DAY).run(new AbortController().signal)).toEqual({ purged: 0 });
    for (const id of [...legacy, d, e]) expect(await rowOf(id), id).toEqual(once.get(id));

    // 다음 출시의 전제: 파기 행 CHECK와 두 VALIDATE가 성공한다(되돌린다)
    expect(await validateNextRelease()).toBe('OK');
  });

  test('I-T83 ⑧ 정비 일은 잠긴 행을 건너뛰고 기다리지 않으며 다음 실행이 고친다', async () => {
    const ids = [] as string[];
    for (let i = 0; i < 3; i += 1) ids.push(await seed({ status: 'DELETED', rating: 4, fingerprint: `fp-locked-${i}`, body: '', authorDisplay: '***', deletedAt: new Date(NOW - DAY) }));
    const [locked, ...rest] = ids as [string, ...string[]];
    // 다른 트랜잭션(작성자 지우기 같은 쓰기)이 한 행을 쥐고 있는 것처럼 관리자 연결로 잠가 둔다
    const holder = await admin.pool.connect();
    try {
      await holder.query('begin');
      await holder.query('select id from review where id = $1 for update', [locked]);
      const run = legacyTask(NOW).run(new AbortController().signal);
      const timeout = new Promise<'기다림'>((r) => setTimeout(() => r('기다림'), 3_000));
      // SKIP LOCKED: 잠긴 행을 건너뛰고 나머지만 곧바로 고친다(잠금 대기 한도 2초 [가정]로 실패하지도 않는다)
      expect(await Promise.race([run, timeout])).toEqual({ purged: rest.length });
      expect((await rowOf(locked)).rating).toBe(4);
      for (const id of rest) expect((await rowOf(id)).rating, id).toBeNull();
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
    // 잠금이 풀린 다음 실행이 고친다
    expect(await legacyTask(NOW + DAY).run(new AbortController().signal)).toEqual({ purged: 1 });
    expect((await rowOf(locked)).rating).toBeNull();
  });
});
