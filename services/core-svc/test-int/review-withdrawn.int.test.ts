// COV2-06 ⑪(W7-audit): 탈퇴 계정 후기 익명화(DrizzleReviewStore.anonymizeByAccount)를 실제 PostgreSQL 18에서 운영과 같은 DB 역할(core_app)로 본다.
// 그 계정의 행만 계정·주문 참조를 후기 ID로 바꾸고(docs/features/identity.md §8 '후기 익명화'), 다시 해도 0건이며, 회차·계정 부분 유일 인덱스를 어기지 않는다.
// 확인은 저장소를 거치지 않고 관리자 풀의 직접 SQL로 읽는다.
import 'reflect-metadata';
import { createDatabase, type Database } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { review } from '../src/modules/review/adapters/db/schema.js';
import { DrizzleReviewStore } from '../src/modules/review/index.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

let pg: PostgresContainer;
let admin: Database;
let app: Database;
const A = randomUUID();
const B = randomUUID();
const CREATED = new Date('2026-11-10T00:00:00Z');
const NOW = Date.parse('2026-11-16T03:00:00.000Z');

interface Row {
  id: string;
  event_id: string;
  account_id: string;
  basis_order_id: string;
  rating: number;
  body: string;
  status: string;
  author_display: string;
  updated_at: Date;
}
const rowsOf = async (ids: string[]): Promise<Row[]> =>
  (await admin.pool.query<Row>('select id, event_id, account_id, basis_order_id, rating, body, status, author_display, updated_at from review where id = any($1::uuid[]) order by id', [ids])).rows;

async function seedReview(accountId: string, eventId: string): Promise<string> {
  const id = randomUUID();
  await admin.db.insert(review).values({
    id,
    eventId,
    accountId,
    basisOrderId: randomUUID(),
    rating: 5,
    body: '익명화 통합 시험용 후기 본문입니다.',
    status: 'VISIBLE',
    contentFingerprint: `fp-${id}`,
    authorDisplay: '김**',
    createdAt: CREATED,
    updatedAt: CREATED,
  });
  return id;
}

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-review-withdrawn-admin', max: 2 });
  app = await loginFor(admin, pg, 'core_app_review_withdrawn', 'core_app', 2);
});
afterAll(async () => {
  await app?.close();
  await admin?.close();
  pg?.stop();
});

describe('COV2-06 후기 익명화(실제 DB)', () => {
  test('COV2-06 ⑪ Drizzle 익명화는 그 계정 행만 바꾸고 다시 해도 0건이다', async () => {
    const e1 = randomUUID();
    const e2 = randomUUID();
    const a1 = await seedReview(A, e1);
    const a2 = await seedReview(A, e2);
    const b1 = await seedReview(B, e1);
    const before = await rowsOf([b1]);

    const store = new DrizzleReviewStore(app);
    expect(await store.anonymizeByAccount(A, NOW)).toBe(2);

    for (const r of await rowsOf([a1, a2])) {
      expect(r.account_id).toBe(r.id);
      expect(r.basis_order_id).toBe(r.id);
      expect(r.author_display).toBe('탈퇴한 사용자');
      expect(r.updated_at).toEqual(new Date(NOW));
      // OPEN 후보 1(익명화 대 파기) 결정 전: 본문·별점·상태는 지금 그대로다
      expect(r).toMatchObject({ rating: 5, body: '익명화 통합 시험용 후기 본문입니다.', status: 'VISIBLE' });
    }
    expect(await rowsOf([b1])).toEqual(before);
    const left = await admin.pool.query('select count(*)::int as n from review where account_id = $1', [A]);
    expect(left.rows[0].n).toBe(0);

    // 다시 해도 0건이고 행이 그대로다
    const once = await rowsOf([a1, a2, b1]);
    expect(await store.anonymizeByAccount(A, NOW + 60_000)).toBe(0);
    expect(await rowsOf([a1, a2, b1])).toEqual(once);
  });

  test('COV2-06 K2 탈퇴 익명화는 review_account_idx로 찾는다', async () => {
    // 웨이브 끝 리뷰 K2: 익명화 문장(drizzle-review-store.ts anonymizeByAccount와 같은 꼴)이 계정 색인을 쓰는지 실행 계획으로 본다(docs/devops.md §7.3 실행 계획 검사의 작은 꼴)
    for (let i = 0; i < 5; i += 1) await seedReview(randomUUID(), randomUUID());
    const client = await admin.pool.connect();
    try {
      await client.query('set enable_seqscan = off');
      const plan = await client.query(
        `explain (format json) update review set account_id = id, basis_order_id = id, author_display = '탈퇴한 사용자', updated_at = $2::timestamptz where account_id = $1::uuid returning id`,
        [randomUUID(), new Date(NOW)],
      );
      expect(JSON.stringify(plan.rows[0])).toContain('"Index Name":"review_account_idx"');
    } finally {
      await client.query('reset enable_seqscan').catch(() => undefined);
      client.release();
    }
  });
});
