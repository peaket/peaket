// I-T83 ①⑥(W8-audit2a, 소유자 결정 2026-11-16 OPEN[42], ADR-0278)·COV2-06 ⑪(W7-audit): 탈퇴 계정 후기 파기(DrizzleReviewStore.purgeWithdrawnAccount의 파기 몫. 손 처리 purgeByAccount는 웨이브 끝 리뷰 S1로 없어질 수 있어 사건 처리 길로 부른다)를
// 실제 PostgreSQL 18에서 운영과 같은 DB 역할(core_app)로 본다. 그 계정의 모든 행(보이는 것, 통보로 가린 것, 작성자가 이미 지운 것)을 docs/data.md §2 '후기 파기'의
// 칸대로 비우고, 다른 계정 행·법정 조치 증적(takedown_action)·같은 내용 차단 목록(review_hidden_fingerprint)은 그대로 두며, 다시 해도 0건이다.
// 확인은 저장소를 거치지 않고 관리자 풀의 직접 SQL로 읽는다. W7-audit의 익명화(계정·주문 참조만 끊음) 단언은 파기 단언으로 바꿨다.
import 'reflect-metadata';
import { createDatabase, type Database } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { review, reviewHiddenFingerprint, takedownAction } from '../src/modules/review/adapters/db/schema.js';
import { DrizzleReviewStore } from '../src/modules/review/index.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

let pg: PostgresContainer;
let admin: Database;
let app: Database;
const A = randomUUID();
const B = randomUUID();
const DAY = 86_400_000;
const CREATED = new Date('2026-11-10T00:00:00Z');
const NOW = Date.parse('2026-11-16T03:00:00.000Z');
/** 2026-11-16 전 작성자 지우기의 지운 시각(파기가 바꾸지 않는다) */
const DELETED_AT = new Date('2026-11-14T08:30:00.000Z');

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
const rowsOf = async (ids: string[]): Promise<Row[]> =>
  (
    await admin.pool.query<Row>(
      'select id, event_id, account_id, basis_order_id, rating, body, status, notice, notice_until, content_fingerprint, author_display, edited, created_at, updated_at, deleted_at from review where id = any($1::uuid[]) order by id',
      [ids],
    )
  ).rows;

async function seedReview(
  accountId: string,
  eventId: string,
  o: { status?: string; notice?: string; noticeUntil?: Date; body?: string; rating?: number; authorDisplay?: string; deletedAt?: Date; edited?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await admin.db.insert(review).values({
    id,
    eventId,
    accountId,
    basisOrderId: randomUUID(),
    rating: o.rating ?? 5,
    body: o.body ?? '파기 통합 시험용 후기 본문입니다.',
    status: o.status ?? 'VISIBLE',
    notice: o.notice ?? null,
    noticeUntil: o.noticeUntil ?? null,
    contentFingerprint: `fp-${id}`,
    authorDisplay: o.authorDisplay ?? '김**',
    edited: o.edited ?? false,
    createdAt: CREATED,
    updatedAt: o.deletedAt ?? CREATED,
    deletedAt: o.deletedAt ?? null,
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

describe('I-T83 후기 파기(실제 DB)', () => {
  test('I-T83 ①⑥ Drizzle 파기는 그 계정 행만 바꾸고 다시 해도 0건이다 (COV2-06 ⑪)', async () => {
    const e1 = randomUUID();
    const e2 = randomUUID();
    const a1 = await seedReview(A, e1, { edited: true });
    const a2 = await seedReview(A, e2, { status: 'HIDDEN', notice: 'RIGHTS_TEMP', noticeUntil: new Date(NOW + 7 * DAY), rating: 2 });
    // 2026-11-16 전 작성자 지우기: 본문·작성자 표시만 비우고 별점·지문·계정을 남겼다(이미 지운 행도 파기 대상)
    const a3 = await seedReview(A, e1, { status: 'DELETED', body: '', rating: 3, authorDisplay: '***', deletedAt: DELETED_AT });
    const b1 = await seedReview(B, e1);
    // 통보 가림 조치 증적과 같은 내용 차단 목록(후기와 따로 남는다)
    const takedownId = randomUUID();
    await admin.db.insert(takedownAction).values({ id: takedownId, reviewId: a2, reason: 'RIGHTS_TEMP', contentFingerprint: `fp-${a2}`, hiddenAt: new Date(NOW - DAY), endsAt: new Date(NOW + 7 * DAY) });
    await admin.db.insert(reviewHiddenFingerprint).values({ fingerprint: `fp-${a1}`, noticeId: null, createdAt: new Date(NOW - DAY) });
    const evidence = async () => ({
      takedown: (await admin.pool.query('select * from takedown_action where id = $1', [takedownId])).rows,
      fingerprint: (await admin.pool.query('select * from review_hidden_fingerprint where fingerprint = $1', [`fp-${a1}`])).rows,
    });
    const evidenceBefore = await evidence();
    const seeded = await rowsOf([a1, a2, a3]);
    const bBefore = await rowsOf([b1]);

    const store = new DrizzleReviewStore(app);
    expect(await store.purgeWithdrawnAccount(A, { nowMs: NOW, recheckAtMs: NOW + 16 * 60_000 })).toBe(3);

    const after = await rowsOf([a1, a2, a3]);
    expect(after).toHaveLength(3);
    for (const r of after) {
      const before = seeded.find((x) => x.id === r.id)!;
      expect(r, r.id).toEqual({
        id: before.id,
        event_id: before.event_id,
        account_id: before.id,
        basis_order_id: before.id,
        rating: null,
        body: '',
        status: 'DELETED',
        notice: null,
        notice_until: null,
        content_fingerprint: null,
        author_display: '',
        edited: before.edited,
        created_at: before.created_at,
        updated_at: new Date(NOW),
        // 처음 지운 시각: 이미 있으면 그대로
        deleted_at: r.id === a3 ? DELETED_AT : new Date(NOW),
      });
    }
    expect(await rowsOf([b1])).toEqual(bBefore);
    expect(await evidence()).toEqual(evidenceBefore);
    const left = await admin.pool.query('select count(*)::int as n from review where account_id = $1', [A]);
    expect(left.rows[0].n).toBe(0);

    // 다시 해도 0건이고 행이 그대로다
    const once = await rowsOf([a1, a2, a3, b1]);
    expect(await store.purgeWithdrawnAccount(A, { nowMs: NOW + 60_000, recheckAtMs: NOW + 17 * 60_000 })).toBe(0);
    expect(await rowsOf([a1, a2, a3, b1])).toEqual(once);

    // 회차·계정 부분 유일 색인: 같은 회차에 새 후기를 넣을 수 있다(파기한 행은 그 계정으로 더 세지 않는다)
    await expect(seedReview(A, e1)).resolves.toEqual(expect.any(String));
  });

  test('I-T83 ① 탈퇴 파기는 review_account_idx로 찾는다 (COV2-06 K2)', async () => {
    // 웨이브 끝 리뷰 K2: 파기 문장(계획 §1 Drizzle purgeByAccount와 같은 꼴)이 계정 색인을 쓰는지 실행 계획으로 본다(docs/data.md §5.1 '탈퇴 파기' 행)
    for (let i = 0; i < 5; i += 1) await seedReview(randomUUID(), randomUUID());
    const client = await admin.pool.connect();
    try {
      await client.query('set enable_seqscan = off');
      const plan = await client.query(
        `explain (format json) update review set status = 'DELETED', body = '', rating = null, content_fingerprint = null, author_display = '', notice = null, notice_until = null,
           account_id = id, basis_order_id = id, deleted_at = coalesce(deleted_at, $2::timestamptz), updated_at = $2::timestamptz
         where account_id = $1::uuid returning id`,
        [randomUUID(), new Date(NOW)],
      );
      expect(JSON.stringify(plan.rows[0])).toContain('"Index Name":"review_account_idx"');
    } finally {
      await client.query('reset enable_seqscan').catch(() => undefined);
      client.release();
    }
  });
});
