// COV2-06 ⑮⑯(W7-audit 보충): 후기 표·보류 표의 운영 역할 권한을 실제 PostgreSQL 18에서 본다(docs/data.md §2 '후기 표의 DB 권한'·§4의 15 'DB 권한',
// ADR-0241 결정 4: 코드가 쓰는 만큼만). core_app(팬·관제 경로)은 쓰는 칸만 고치고 후기·신고·조치 행을 지우지 못한다.
// core_maintenance(relay의 정비 연결)는 임시조치 끝내기와 보류 표 정리만 하고 후기를 새로 쓰지 못한다.
// I-T83 ⑥(W8-audit2a, ADR-0278): 0026 뒤 core_app은 파기 칸(docs/data.md §2 '후기 파기', 별점·지문 NULL 포함)을 한 문장으로 비울 수 있다(0022 칸 목록이 덮는다).
// 시험 자료 넣기와 확인은 관리자(슈퍼유저) 연결로 한다.
import 'reflect-metadata';
import { createDatabase, fakeClock, platformMaintenanceTasks, type Database } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { contentReport, review, takedownAction } from '../src/modules/review/adapters/db/schema.js';
import { DrizzleReviewStore, reviewMaintenanceTasks } from '../src/modules/review/index.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

let pg: PostgresContainer;
let admin: Database;
let app: Database;
let maint: Database;
const NOW = Date.parse('2026-11-16T03:00:00.000Z');
const DAY = 86_400_000;

/** 그 연결로 SQL 하나를 돌려 PostgreSQL 오류 코드를 돌려준다(성공이면 'OK') */
const codeOf = async (db: Database, text: string, params: unknown[] = []): Promise<string> => {
  try {
    await db.pool.query(text, params);
    return 'OK';
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
};

async function seedReview(o: { status?: string; notice?: string | null; noticeUntil?: Date | null } = {}): Promise<string> {
  const id = randomUUID();
  const at = new Date(NOW - 10 * DAY);
  await admin.db.insert(review).values({
    id,
    eventId: randomUUID(),
    accountId: randomUUID(),
    basisOrderId: randomUUID(),
    rating: 4,
    body: '권한 시험용 후기 본문입니다.',
    status: o.status ?? 'VISIBLE',
    notice: o.notice ?? null,
    noticeUntil: o.noticeUntil ?? null,
    contentFingerprint: `fp-${id}`,
    authorDisplay: '김**',
    createdAt: at,
    updatedAt: at,
  });
  return id;
}

async function seedTakedown(reviewId: string, endsAt: Date): Promise<string> {
  const id = randomUUID();
  await admin.db.insert(takedownAction).values({ id, reviewId, reason: 'RIGHTS_TEMP', contentFingerprint: `fp-${reviewId}`, hiddenAt: new Date(NOW - 5 * DAY), endsAt });
  return id;
}

async function seedHeld(reprocessedAt: Date | null): Promise<string> {
  const id = randomUUID();
  await admin.pool.query(
    `insert into held_event (id, topic, partition, kafka_offset, event_key, business_key, error, msg_key, record_at, value, headers, held_at, reprocessed_at)
     values ($1, 'identity.accounts-withdrawn', 0, $2, null, $3, 'Error: 시험', null, $4, null, '{}'::jsonb, $4, $5)`,
    [id, Math.floor(Math.random() * 1e9), randomUUID(), new Date(NOW - 20 * DAY), reprocessedAt],
  );
  return id;
}

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-review-grants-admin', max: 2 });
  app = await loginFor(admin, pg, 'core_app_review_grants', 'core_app', 2);
  maint = await loginFor(admin, pg, 'core_maintenance_review_grants', 'core_maintenance', 2);
});
afterAll(async () => {
  await maint?.close();
  await app?.close();
  await admin?.close();
  pg?.stop();
});

describe('COV2-06 보충 후기·보류 표 운영 역할 권한(실제 DB)', () => {
  test('COV2-06 ⑮ core_app은 후기의 id·event_id·created_at을 고치지 못하고 후기·신고·조치 행을 지우지 못한다', async () => {
    const reviewId = await seedReview();
    const reportId = randomUUID();
    await admin.db.insert(contentReport).values({ id: reportId, targetId: reviewId, reporterAccountId: randomUUID(), category: 'SPAM', createdAt: new Date(NOW), purgeAt: new Date(NOW + 365 * DAY) });
    const takedownId = await seedTakedown(reviewId, new Date(NOW + DAY));
    const heldId = await seedHeld(null);

    // 대조군(경계의 허용 쪽): 코드가 쓰는 칸은 고치고, 지문 해제는 지운다
    expect(await codeOf(app, 'update review set updated_at = $1 where id = $2', [new Date(NOW), reviewId])).toBe('OK');
    expect(await codeOf(app, 'delete from review_hidden_fingerprint where fingerprint = $1', ['없는-지문'])).toBe('OK');

    // 거부 쪽: 고정 칸 고치기, 행 지우기, 보류 행 다시 처리 표시
    const denied: [string, string, unknown[]][] = [
      ['review.event_id 고치기', 'update review set event_id = $1 where id = $2', [randomUUID(), reviewId]],
      ['review.id 고치기', 'update review set id = $1 where id = $2', [randomUUID(), reviewId]],
      ['review.created_at 고치기', 'update review set created_at = $1 where id = $2', [new Date(NOW), reviewId]],
      ['review 지우기', 'delete from review where id = $1', [reviewId]],
      ['content_report 지우기', 'delete from content_report where id = $1', [reportId]],
      ['takedown_action 지우기', 'delete from takedown_action where id = $1', [takedownId]],
      ['held_event 다시 처리 표시', 'update held_event set reprocessed_at = now() where id = $1', [heldId]],
    ];
    for (const [what, text, params] of denied) expect(await codeOf(app, text, params), what).toBe('42501');

    const left = await admin.pool.query('select (select count(*)::int from review where id = $1) as r, (select count(*)::int from content_report where id = $2) as c, (select count(*)::int from takedown_action where id = $3) as t', [reviewId, reportId, takedownId]);
    expect(left.rows[0]).toEqual({ r: 1, c: 1, t: 1 });
  });

  test('I-T83 ⑥ core_app은 파기 칸(별점·지문 NULL 포함)을 한 문장으로 비울 수 있다', async () => {
    const reviewId = await seedReview({ status: 'HIDDEN', notice: 'RIGHTS_TEMP', noticeUntil: new Date(NOW + DAY) });
    // 파기 문장(계획 §1 Drizzle softDeleteReview·purgeByAccount와 같은 칸). 0026 전에는 별점·지문 NOT NULL(23502)로 실패한다
    expect(
      await codeOf(
        app,
        `update review set status = 'DELETED', body = '', rating = null, content_fingerprint = null, author_display = '', notice = null, notice_until = null,
           account_id = id, basis_order_id = id, deleted_at = coalesce(deleted_at, $2), updated_at = $2
         where id = $1`,
        [reviewId, new Date(NOW)],
      ),
    ).toBe('OK');
    const row = (await admin.pool.query('select status, body, rating, content_fingerprint, author_display, notice, notice_until, account_id, basis_order_id, deleted_at from review where id = $1', [reviewId])).rows[0];
    expect(row).toEqual({ status: 'DELETED', body: '', rating: null, content_fingerprint: null, author_display: '', notice: null, notice_until: null, account_id: reviewId, basis_order_id: reviewId, deleted_at: new Date(NOW) });
  });

  test('COV2-06 ⑯ 정비 역할로 임시조치 끝내기와 보류 표 정리가 되고, 후기를 새로 쓰지는 못한다', async () => {
    const clock = fakeClock({ now: NOW });
    // 끝 시각이 막 지난 것과 막 안 지난 것(경계 양쪽 1ms)
    const due = await seedReview({ status: 'HIDDEN', notice: 'RIGHTS_TEMP', noticeUntil: new Date(NOW - 1) });
    const notYet = await seedReview({ status: 'HIDDEN', notice: 'RIGHTS_TEMP', noticeUntil: new Date(NOW + 1) });
    const dueAction = await seedTakedown(due, new Date(NOW - 1));
    const notYetAction = await seedTakedown(notYet, new Date(NOW + 1));

    const expire = reviewMaintenanceTasks(new DrizzleReviewStore(maint), clock).find((t) => t.name === 'review-temp-block-expire');
    expect(expire).toBeDefined();
    await expire!.run(new AbortController().signal);

    const reviews = (await admin.pool.query('select id, status, notice from review where id = any($1::uuid[])', [[due, notYet]])).rows as { id: string; status: string; notice: string | null }[];
    expect(reviews.find((r) => r.id === due)).toMatchObject({ status: 'VISIBLE', notice: null });
    expect(reviews.find((r) => r.id === notYet)).toMatchObject({ status: 'HIDDEN', notice: 'RIGHTS_TEMP' });
    const actions = (await admin.pool.query('select id, restored_at from takedown_action where id = any($1::uuid[])', [[dueAction, notYetAction]])).rows as { id: string; restored_at: Date | null }[];
    expect(actions.find((a) => a.id === dueAction)?.restored_at).toEqual(new Date(NOW));
    expect(actions.find((a) => a.id === notYetAction)?.restored_at).toBeNull();

    // 보류 표 정리: 다시 처리한 지 8일 된 행만 지우고 6일 된 행·다시 처리 안 한 행은 남긴다(보관 7일)
    const old = await seedHeld(new Date(NOW - 8 * DAY));
    const recent = await seedHeld(new Date(NOW - 6 * DAY));
    const pending = await seedHeld(null);
    const cleanup = platformMaintenanceTasks(maint, clock).find((t) => t.name === 'held-events-delete');
    expect(cleanup).toBeDefined();
    await cleanup!.run(new AbortController().signal);
    const held = (await admin.pool.query('select id from held_event where id = any($1::uuid[])', [[old, recent, pending]])).rows.map((r: { id: string }) => r.id);
    expect(held.sort()).toEqual([recent, pending].sort());

    // 후기를 새로 쓰지는 못한다
    expect(
      await codeOf(
        maint,
        `insert into review (id, event_id, account_id, basis_order_id, rating, body, status, content_fingerprint, author_display, edited, created_at, updated_at)
         values ($1, $2, $3, $4, 5, '정비 역할이 쓰려는 후기입니다.', 'VISIBLE', 'fp-maint', '***', false, $5, $5)`,
        [randomUUID(), randomUUID(), randomUUID(), randomUUID(), new Date(NOW)],
      ),
    ).toBe('42501');
  });
});
