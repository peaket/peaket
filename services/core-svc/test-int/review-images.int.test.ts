// review_image 실제 PostgreSQL 통합 시험(F-07-10 구현 리뷰 IR-01·IR-02·IR-09).
// 메모리 저장소만 보던 시험이 놓친 부분 유일 인덱스(교체·순서 바꾸기), 탈퇴 다시 정리·이전 판 고치기의 사진 행,
// 100행을 넘는 정리를 운영과 같은 DB 역할(core_app·core_maintenance)로 확인한다.
import 'reflect-metadata';
import { createDatabase, fakeClock, type Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import type { ReviewImageRecord } from '../src/modules/review/domain/review-image.js';
import { DrizzleReviewStore, reviewMaintenanceTasks, type ReviewRecord } from '../src/modules/review/index.js';
import { startPostgres, type PostgresContainer } from './postgres.js';
import { loginFor } from './roles.js';

const NOW = Date.parse('2026-11-26T05:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

let pg: PostgresContainer;
let admin: Database;
let app: Database;
let maintenance: Database;
let appStore: DrizzleReviewStore;
let maintenanceStore: DrizzleReviewStore;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-review-images-int-admin', max: 4 });
  app = await loginFor(admin, pg, 'core_app_review_images_int', 'core_app', 4);
  maintenance = await loginFor(admin, pg, 'core_maintenance_review_images_int', 'core_maintenance', 4);
  appStore = new DrizzleReviewStore(app);
  maintenanceStore = new DrizzleReviewStore(maintenance);
});
afterAll(async () => {
  await app?.close();
  await maintenance?.close();
  await admin?.close();
  pg?.stop();
});

function reviewOf(accountId: string, o: Partial<ReviewRecord> = {}): ReviewRecord {
  const reviewId = o.reviewId ?? randomUUID();
  return {
    reviewId,
    eventId: randomUUID(),
    productionId: '',
    accountId,
    basisOrderId: randomUUID(),
    rating: 5,
    body: `실제 DB 후기 사진 시험용 본문 ${reviewId.slice(-4)}`,
    status: 'VISIBLE',
    contentFingerprint: `fp-${reviewId}`,
    authorDisplay: '김**',
    createdAtMs: NOW,
    updatedAtMs: NOW,
    edited: false,
    ...o,
  };
}

function imageOf(accountId: string, o: Partial<ReviewImageRecord> = {}): ReviewImageRecord {
  const imageId = o.imageId ?? randomUUID();
  return {
    imageId,
    reviewId: null,
    accountId,
    status: 'READY',
    altText: '',
    width: 800,
    height: 600,
    sort: 0,
    thumbKey: `review/${imageId}/240.webp`,
    viewKey: `review/${imageId}/1280.webp`,
    createdAtMs: NOW,
    ...o,
  };
}

const keysOf = (imageId: string): string[] => [`review/${imageId}/240.webp`, `review/${imageId}/1280.webp`];

describe('review_image 실제 DB [F-07-10 구현 리뷰]', () => {
  test('IR-01 사진 붙이기·순서 바꾸기·교체·빼기가 실제 DB의 부분 유일 인덱스와 부딪히지 않는다', async () => {
    const account = randomUUID();
    const review = reviewOf(account);
    const a = imageOf(account);
    const b = imageOf(account);
    const c = imageOf(account);
    for (const image of [a, b, c]) await appStore.insertReviewImage(image);
    await appStore.insertReview(review, [{ imageId: a.imageId }, { imageId: b.imageId }, { imageId: c.imageId }]);
    let rows = (await appStore.imagesByReviews([review.reviewId])).get(review.reviewId)!;
    expect(rows.map((r) => [r.imageId, r.sort, r.status])).toEqual([
      [a.imageId, 0, 'READY'],
      [b.imageId, 1, 'READY'],
      [c.imageId, 2, 'READY'],
    ]);

    // 살아 있는 두 사진의 순서를 맞바꾼다(한 행씩 고치면 (review_id, sort) 유일 인덱스와 부딪힌다)
    const swapped = await appStore.updateReview(review.reviewId, { rating: 4, body: '사진 순서를 바꾼 후기 본문입니다.', updatedAtMs: NOW + 1, edited: true }, [{ imageId: b.imageId }, { imageId: a.imageId }]);
    expect(swapped).toEqual(expect.arrayContaining(keysOf(c.imageId)));
    rows = (await appStore.imagesByReviews([review.reviewId])).get(review.reviewId)!;
    expect(rows.filter((r) => r.status === 'READY').map((r) => [r.imageId, r.sort])).toEqual([
      [b.imageId, 0],
      [a.imageId, 1],
    ]);
    expect((await appStore.imageRowsByAccount(account)).find((r) => r.imageId === c.imageId)?.status).toBe('DELETED');

    // 남은 사진을 모두 새 사진 하나로 바꾼다(빠진 행의 sort 0을 새 행이 다시 쓴다)
    const d = imageOf(account);
    await appStore.insertReviewImage(d);
    const replaced = await appStore.updateReview(review.reviewId, { rating: 5, body: '사진을 모두 바꾼 후기 본문입니다.', updatedAtMs: NOW + 2, edited: true }, [{ imageId: d.imageId }]);
    expect(replaced).toEqual(expect.arrayContaining([...keysOf(a.imageId), ...keysOf(b.imageId)]));
    rows = (await appStore.imagesByReviews([review.reviewId])).get(review.reviewId)!;
    expect(rows.filter((r) => r.status === 'READY').map((r) => [r.imageId, r.sort])).toEqual([[d.imageId, 0]]);
    expect((await appStore.imageRowsByAccount(account)).filter((r) => r.status === 'DELETED')).toHaveLength(3);

    // 사진을 모두 뺀다
    const cleared = await appStore.updateReview(review.reviewId, { rating: 5, body: '사진을 모두 뺀 후기 본문입니다.', updatedAtMs: NOW + 3, edited: true }, []);
    expect(cleared).toEqual(expect.arrayContaining(keysOf(d.imageId)));
    expect((await appStore.imageRowsByAccount(account)).every((r) => r.status === 'DELETED')).toBe(true);
  });

  test('IR-01 부분 유일 인덱스는 지운 사진 행을 빼서 같은 순서로 새 사진을 붙일 수 있다', async () => {
    const account = randomUUID();
    const reviewId = randomUUID();
    const deleted = imageOf(account, { reviewId, attachedAtMs: NOW, status: 'DELETED', deletedAtMs: NOW });
    const fresh = imageOf(account, { reviewId, attachedAtMs: NOW, sort: 0 });
    await appStore.insertReviewImage(deleted);
    await appStore.insertReviewImage(fresh);
    const rows = (await appStore.imagesByReviews([reviewId])).get(reviewId)!;
    expect(rows.map((r) => [r.imageId, r.status])).toEqual(
      expect.arrayContaining([
        [deleted.imageId, 'DELETED'],
        [fresh.imageId, 'READY'],
      ]),
    );
  });

  test('IR-01 작성자 지우기가 사진 행을 DELETED로 바꾸고 공개 키를 돌려준다', async () => {
    const account = randomUUID();
    const review = reviewOf(account);
    const image = imageOf(account);
    await appStore.insertReviewImage(image);
    await appStore.insertReview(review, [{ imageId: image.imageId }]);
    const removed = await appStore.softDeleteReview(review.reviewId, NOW + 10);
    expect(removed).toEqual(expect.arrayContaining(keysOf(image.imageId)));
    const rows = await appStore.imageRowsByAccount(account);
    expect(rows.map((r) => [r.imageId, r.status])).toEqual([[image.imageId, 'DELETED']]);
    expect((await appStore.findReview(review.reviewId))?.status).toBe('DELETED');
  });

  test('IR-02 탈퇴 다시 정리와 이전 판 고치기가 사진 행을 DELETED로 바꾼다', async () => {
    // 탈퇴 뒤 늦게 쓴 후기를 다시 정리(runDueRechecks)한다
    const account = randomUUID();
    const review = reviewOf(account);
    const image = imageOf(account);
    await appStore.insertReviewImage(image);
    await appStore.insertReview(review, [{ imageId: image.imageId }]);
    await admin.db.execute(sql`
      insert into review_withdrawal_recheck (account_id, due_at, created_at)
      values (${account}::uuid, ${new Date(NOW)}::timestamptz, ${new Date(NOW)}::timestamptz)`);
    expect(await appStore.runDueRechecks(NOW, 10)).toMatchObject({ accounts: 1, purged: 1 });
    let rows = await appStore.imageRowsByAccount(account);
    expect(rows.map((r) => [r.imageId, r.status])).toEqual([[image.imageId, 'DELETED']]);

    // 이전 판이 남긴 행 고치기(purgeLegacyRows)도 정비 역할(core_maintenance)로 사진 행을 DELETED로 바꾼다
    const legacyAccount = randomUUID();
    const legacy = reviewOf(legacyAccount, { status: 'DELETED', rating: 4, body: '', authorDisplay: '***', deletedAtMs: NOW - 1_000 });
    const legacyImage = imageOf(legacyAccount);
    await appStore.insertReviewImage(legacyImage);
    await appStore.insertReview(legacy, [{ imageId: legacyImage.imageId }]);
    expect(await maintenanceStore.purgeLegacyRows({ nowMs: NOW + 1_000, limit: 10 })).toMatchObject({ purged: 1 });
    rows = await appStore.imageRowsByAccount(legacyAccount);
    expect(rows.map((r) => [r.imageId, r.status])).toEqual([[legacyImage.imageId, 'DELETED']]);
  });

  test('IR-08 정리 작업이 100행을 넘는 지난 사진을 한 번에 지우고 공개 파생본도 지운다', async () => {
    const account = randomUUID();
    const old = NOW - DAY - 1;
    const ids: string[] = [];
    for (let i = 0; i < 150; i += 1) {
      const image = imageOf(account, { createdAtMs: old });
      ids.push(image.imageId);
      await appStore.insertReviewImage(image);
    }
    const deleted: string[] = [];
    const objects = {
      async deletePublic(key: string): Promise<void> {
        deleted.push(key);
      },
    };
    const clock = fakeClock({ now: NOW });
    const task = reviewMaintenanceTasks(maintenanceStore, clock, { images: { objects } }).find((t) => t.name === 'review-image-cleanup');
    expect(task, 'review-image-cleanup').toBeDefined();
    const result = (await task!.run()) as { removed: number };
    expect(result.removed).toBeGreaterThanOrEqual(150);
    expect(await appStore.imageRowsByAccount(account)).toEqual([]);
    for (const imageId of ids) expect(deleted).toEqual(expect.arrayContaining(keysOf(imageId)));
  });
});
