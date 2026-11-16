// I-T83 ⑧(W8-audit2a 리뷰 A2, 계획 §8.2): 정비 일 review-purge-legacy가 이전 판이 남긴 두 꼴만 파기 칸으로 고친다.
// ① 작성자가 지웠는데 별점·지문·계정 ID가 남은 행(status = 'DELETED' AND (rating IS NOT NULL OR content_fingerprint IS NOT NULL OR account_id <> id))
// ② 옛 익명화로 참조만 끊긴 살아 있는 후기(status <> 'DELETED' AND account_id = id).
// 정본: docs/data.md §2 '후기 파기'의 '이전 판이 남긴 행 고치기'(id 순 커서, 1,000행 [가정] 묶음, 묶음마다 커밋, 멈춤 신호는 묶음 사이, 정비 시간 일),
// docs/features/identity.md §8 '이전 판이 남긴 행'·§12 I-T83 ⑧. 단언 값은 정본에서 적고 코드 상수를 가져오지 않는다.
import { fakeClock, type Database, type MaintenanceTask } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { CORE_MAINTENANCE_TASK_NAMES, coreMaintenanceTasks } from '../src/maintenance-tasks.js';
import { contentFingerprint, MemoryReviewStore, type ReviewRecord, type ReviewStore, reviewMaintenanceTasks } from '../src/modules/review/index.js';

const T0 = Date.parse('2026-11-17T04:10:00.000Z');
const DAY = 86_400_000;
const A = '0190f3a1-7c2e-7a00-8000-00000000a008';
const B = '0190f3a1-7c2e-7a00-8000-00000000b008';
const PRODUCTION = '0190f3a1-7c2e-7a00-8000-0000000d0008';
/** 정본 값: 한 묶음 1,000행 [가정] */
const DEFAULT_BATCH = 1_000;

/** id 차례를 시험이 정한다(마지막 두 자리가 차례) */
const id = (n: number): string => `0190f3a1-7c2e-7a00-8000-0000000f00${String(n).padStart(2, '0')}`;

const live = (reviewId: string, o: Partial<ReviewRecord> = {}): ReviewRecord => {
  const body = `정비 일 시험용 후기 본문 ${reviewId.slice(-4)}`;
  return {
    reviewId,
    eventId: '0190f3a1-7c2e-7a00-8000-0000000e0008',
    productionId: PRODUCTION,
    accountId: A,
    basisOrderId: '0190f3a1-7c2e-7a00-8000-0000000c0008',
    rating: 4,
    body,
    status: 'VISIBLE',
    contentFingerprint: contentFingerprint(body),
    authorDisplay: '김**',
    createdAtMs: T0 - 10 * DAY,
    updatedAtMs: T0 - 10 * DAY,
    edited: false,
    ...o,
  };
};

const purgedOf = (before: ReviewRecord, o: { nowMs: number; deletedAtMs: number }): Record<string, unknown> => ({
  reviewId: before.reviewId,
  eventId: before.eventId,
  productionId: before.productionId,
  accountId: before.reviewId,
  basisOrderId: before.reviewId,
  rating: null,
  body: '',
  status: 'DELETED',
  contentFingerprint: null,
  authorDisplay: '',
  createdAtMs: before.createdAtMs,
  updatedAtMs: o.nowMs,
  edited: before.edited,
  deletedAtMs: o.deletedAtMs,
});

const legacyTask = (store: ReviewStore, clock: ReturnType<typeof fakeClock>, o?: { batch?: number }): MaintenanceTask => {
  const task = reviewMaintenanceTasks(store, clock, o).find((t) => t.name === 'review-purge-legacy');
  expect(task, '정비 일 review-purge-legacy').toBeDefined();
  return task!;
};

/** purgeLegacyRows 호출을 적고, n번째 호출 뒤에 할 일을 끼우는 저장소 감싸기 */
function recording(store: MemoryReviewStore, after?: (n: number) => void) {
  const calls: { nowMs: number; limit: number; after?: string }[] = [];
  const wrapped = new Proxy(store, {
    get(target, p, receiver) {
      if (p === 'purgeLegacyRows') {
        return async (o: { nowMs: number; limit: number; after?: string }) => {
          calls.push({ ...o });
          const r = await target.purgeLegacyRows(o);
          after?.(calls.length);
          return r;
        };
      }
      const v = Reflect.get(target, p, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { store: wrapped as ReviewStore, calls };
}

describe('I-T83 이전 판이 남긴 행 고치기(리뷰 A2)', () => {
  test('I-T83 ⑧ 정비 일은 이전 판이 남긴 두 꼴만 파기 칸으로 고친다', async () => {
    const clock = fakeClock({ now: T0 });
    const store = new MemoryReviewStore();
    const OLD_DELETED = T0 - 3 * DAY;
    const PURGED_AT = T0 - 2 * DAY;
    // ⓐ 옛 작성자 지우기: DELETED인데 별점·지문·계정이 남음
    const a = live(id(1), { status: 'DELETED', body: '', authorDisplay: '***', rating: 4, updatedAtMs: OLD_DELETED, deletedAtMs: OLD_DELETED });
    // ⓑ 옛 익명화: 보이는 후기의 계정·주문 자리에 후기 ID, '탈퇴한 사용자'
    const b = live(id(2), { accountId: id(2), basisOrderId: id(2), authorDisplay: '탈퇴한 사용자' });
    // ⓒ 옛 익명화: 통보로 가린 후기
    const c = live(id(3), { accountId: id(3), basisOrderId: id(3), authorDisplay: '탈퇴한 사용자', status: 'HIDDEN', notice: 'POLICY' });
    // ⓓ 제대로 파기된 행(그대로여야 한다)
    const d = live(id(4), { status: 'DELETED', body: '', rating: null, contentFingerprint: null, authorDisplay: '', accountId: id(4), basisOrderId: id(4), updatedAtMs: PURGED_AT, deletedAtMs: PURGED_AT });
    // ⓔ 다른 계정의 살아 있는 후기(그대로)
    const e = live(id(5), { accountId: B });
    // ⓕ 별점은 비었는데 지문이 남은 DELETED, ⓖ 별점·지문은 비었는데 계정 ID가 남은 DELETED(별점만 보면 놓친다)
    const f = live(id(6), { status: 'DELETED', body: '', authorDisplay: '', rating: null, updatedAtMs: OLD_DELETED, deletedAtMs: OLD_DELETED });
    const g = live(id(7), { status: 'DELETED', body: '', authorDisplay: '', rating: null, contentFingerprint: null, basisOrderId: id(7), updatedAtMs: OLD_DELETED, deletedAtMs: OLD_DELETED });
    for (const r of [e, c, g, a, d, f, b]) await store.insertReview(r);
    expect((await store.listVisibleByProduction(PRODUCTION)).map((r) => r.reviewId).sort()).toEqual([b.reviewId, e.reviewId].sort());

    expect(await legacyTask(store, clock).run(new AbortController().signal)).toEqual({ purged: 5 });

    // 고친 행: ①의 칸. 이미 지운 행의 지운 시각은 처음 값 그대로
    expect(await store.findReview(a.reviewId)).toEqual(purgedOf(a, { nowMs: T0, deletedAtMs: OLD_DELETED }));
    expect(await store.findReview(b.reviewId)).toEqual(purgedOf(b, { nowMs: T0, deletedAtMs: T0 }));
    expect(await store.findReview(c.reviewId)).toEqual(purgedOf(c, { nowMs: T0, deletedAtMs: T0 }));
    expect(await store.findReview(f.reviewId)).toEqual(purgedOf(f, { nowMs: T0, deletedAtMs: OLD_DELETED }));
    expect(await store.findReview(g.reviewId)).toEqual(purgedOf(g, { nowMs: T0, deletedAtMs: OLD_DELETED }));
    expect((await store.findReview(c.reviewId))?.notice).toBeUndefined();
    // 제대로 파기된 행과 다른 살아 있는 후기는 갱신 시각까지 그대로
    expect(await store.findReview(d.reviewId)).toEqual(d);
    expect(await store.findReview(e.reviewId)).toEqual(e);
    // 집계: 옛 익명화 후기 ⓑ가 요약에서 빠진다
    expect((await store.listVisibleByProduction(PRODUCTION)).map((r) => r.reviewId)).toEqual([e.reviewId]);
  });

  test('I-T83 ⑧ 정비 일을 다시 돌리면 0행이고 묶음 경계에서 빠지는 행이 없다', async () => {
    const clock = fakeClock({ now: T0 });
    const store = new MemoryReviewStore();
    // 이전 판 행 다섯(넣는 차례를 id 차례와 섞는다)과 살아 있는 후기 둘(id 사이사이)
    const legacy = [id(9), id(2), id(14), id(5), id(11)].map((rid, i) =>
      i % 2 === 0 ? live(rid, { status: 'DELETED', body: '', rating: 3, authorDisplay: '***', deletedAtMs: T0 - DAY, updatedAtMs: T0 - DAY }) : live(rid, { accountId: rid, basisOrderId: rid, authorDisplay: '탈퇴한 사용자' }),
    );
    const others = [live(id(7), { accountId: B }), live(id(12), { accountId: A })];
    for (const r of [...legacy, ...others]) await store.insertReview(r);

    // 묶음 2: 저장소 호출은 [2, 2, 1, 0]건, 커서는 앞 묶음의 마지막 id
    const rec = recording(store);
    expect(await legacyTask(rec.store, clock, { batch: 2 }).run(new AbortController().signal)).toEqual({ purged: 5 });
    expect(rec.calls.map((c) => c.limit)).toEqual([2, 2, 2, 2]);
    const sorted = legacy.map((r) => r.reviewId).sort();
    expect(rec.calls.map((c) => c.after)).toEqual([undefined, sorted[1], sorted[3], sorted[4]]);
    for (const r of legacy) expect((await store.findReview(r.reviewId))?.status, r.reviewId).toBe('DELETED');
    for (const r of others) expect(await store.findReview(r.reviewId)).toEqual(r);

    // 다시 돌리면 0행이고 행이 그대로다
    const once = [...store.reviews.values()].map((r) => ({ ...r }));
    clock.advance(DAY);
    expect(await legacyTask(store, clock, { batch: 2 }).run(new AbortController().signal)).toEqual({ purged: 0 });
    expect([...store.reviews.values()]).toEqual(once);
  });

  test('I-T83 ⑧ 정비 일은 묶음 사이에 멈춤 신호를 보고 다음 실행이 나머지를 고친다', async () => {
    const clock = fakeClock({ now: T0 });
    const store = new MemoryReviewStore();
    const legacy = [id(21), id(23), id(25), id(27), id(29)].map((rid) => live(rid, { status: 'DELETED', body: '', rating: 5, authorDisplay: '***', deletedAtMs: T0 - DAY, updatedAtMs: T0 - DAY }));
    for (const r of legacy) await store.insertReview(r);

    // 첫 묶음 뒤에 멈춤 신호를 끊는다
    const ac = new AbortController();
    const rec = recording(store, (n) => {
      if (n === 1) ac.abort();
    });
    expect(await legacyTask(rec.store, clock, { batch: 2 }).run(ac.signal)).toEqual({ purged: 2 });
    expect(rec.calls).toHaveLength(1);
    expect(legacy.filter((r) => store.reviews.get(r.reviewId)?.rating !== null).map((r) => r.reviewId)).toEqual([id(25), id(27), id(29)]);

    // 다음 실행(다음 정비 시간)이 나머지 셋을 고친다
    clock.advance(DAY);
    expect(await legacyTask(store, clock, { batch: 2 }).run(new AbortController().signal)).toEqual({ purged: 3 });
    for (const r of legacy) expect((await store.findReview(r.reviewId))?.rating, r.reviewId).toBeNull();
  });

  test('I-T83 ⑧ 정비 일은 정비 시간 일이고 정비 일 목록에 있으며 한 묶음은 기본 1,000행이다', async () => {
    const clock = fakeClock({ now: T0 });
    const rec = recording(new MemoryReviewStore());
    const task = legacyTask(rec.store, clock);
    // 정비 시간(04:00~06:00 KST) 안에서 하루 한 번. 매일 일이 아니다(큰 표를 정비 시간 밖에 훑지 않는다)
    expect(task.when).toBe('window');
    expect(await task.run(new AbortController().signal)).toEqual({ purged: 0 });
    expect(rec.calls).toEqual([{ nowMs: T0, limit: DEFAULT_BATCH }]);

    // relay 정비 일 목록과 조립
    expect(CORE_MAINTENANCE_TASK_NAMES).toContain('review-purge-legacy');
    const fakeDb = { db: { execute: async () => ({ rows: [] }) }, transaction: async () => undefined } as unknown as Database;
    const { tasks } = coreMaintenanceTasks(fakeDb, clock, { PEAKET_ENV: 'local' });
    expect(tasks.filter((t) => t.name === 'review-purge-legacy').map((t) => t.when)).toEqual(['window']);
  });
});
