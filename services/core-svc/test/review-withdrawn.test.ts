// I-T83 ①③(W8-audit2a, 소유자 결정 2026-11-16 OPEN[42], ADR-0278)·COV2-06(W7-audit): 탈퇴 사건(identity.accounts-withdrawn)을 받으면 core가 그 계정 후기를 파기한다.
// 정본: docs/features/identity.md §8 '후기 파기'·§12 I-T83, docs/data.md §2 '후기 파기'(비우는 칸), docs/streaming.md §2.6 'core-svc 소비자',
// asyncapi consumeAccountWithdrawn, docs/security/data-classification.md '탈퇴 사건의 pid 사본'(core는 eventKey·accountId·withdrawnAt만 읽는다).
// W7-audit의 '익명화'(계정·주문 참조만 끊고 본문·별점을 남김) 단언은 파기 단언으로 바꿨다(옛 COV2-06 ①②⑨). 단언 값은 정본에서 적고 코드 상수를 가져오지 않는다.
import 'reflect-metadata';
import { type ConsumedMessage, createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCatalogRepository } from '../src/modules/catalog/index.js';
import { MemoryReviewEventDirectory } from '../src/modules/review/adapters/memory-review-event-directory.js';
import {
  contentFingerprint,
  MemoryFanProfile,
  MemoryReviewCaseSink,
  MemoryReviewEligibility,
  MemoryReviewNotifier,
  MemoryReviewStore,
  type ReviewRecord,
  ReviewAccountWithdrawnHandler,
  Reviews,
  type TakedownRecord,
} from '../src/modules/review/index.js';
import { FakeIdentity, quiet } from './support.js';

const TOPIC = 'identity.accounts-withdrawn';
const T0 = Date.parse('2026-11-16T03:00:00.000Z');
const DAY = 86_400_000;
const A = '0190f3a1-7c2e-7a00-8000-00000000a001';
const B = '0190f3a1-7c2e-7a00-8000-00000000b001';
const EVENT_KEY = '0190f3a1-7c2e-7a00-8000-0000000e0001';
const PID = 'pidAAAAcurrent_0123';
const OLD_PID = 'pidAAAAprevious_456';

const review = (o: Partial<ReviewRecord> & Pick<ReviewRecord, 'reviewId' | 'accountId'>): ReviewRecord => ({
  eventId: randomUUID(),
  productionId: randomUUID(),
  basisOrderId: randomUUID(),
  rating: 4,
  body: '좋은 공연이었습니다. 다음에도 보러 오겠습니다.',
  status: 'VISIBLE',
  contentFingerprint: contentFingerprint('좋은 공연이었습니다. 다음에도 보러 오겠습니다.'),
  authorDisplay: '김**',
  createdAtMs: T0 - DAY,
  updatedAtMs: T0 - DAY,
  edited: false,
  ...o,
});

/**
 * docs/data.md §2 '후기 파기'의 칸대로 비운 모양(정본 값을 시험이 따로 적는다).
 * 남는 칸은 후기 ID·회차·상태·고침 여부·만든 시각·갱신 시각·지운 시각이다. 통보 가림 칸(notice·noticeUntilMs)은 없다
 */
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

/** 계약 전체 모양의 탈퇴 사건(pid·purgeBy 포함) */
const withdrawn = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  eventKey: EVENT_KEY,
  accountId: A,
  pids: [PID, OLD_PID],
  withdrawnAt: '2026-11-16T02:00:00.000Z',
  purgeBy: '2026-11-21T02:00:00.000Z',
  ...o,
});

const message = (value: unknown, o: Partial<ConsumedMessage> = {}): ConsumedMessage => ({
  topic: TOPIC,
  partition: 0,
  offset: 7n,
  key: A,
  value: value === null ? null : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8'),
  headers: {},
  timestamp: T0,
  ...o,
});

function setup() {
  const clock = fakeClock({ now: T0 });
  const store = new MemoryReviewStore();
  const reviews = new Reviews({
    store,
    events: new MemoryReviewEventDirectory(new MemoryCatalogRepository()),
    eligibility: new MemoryReviewEligibility(),
    fanProfile: new MemoryFanProfile(),
    notifier: new MemoryReviewNotifier(),
    cases: new MemoryReviewCaseSink(),
    clock,
  });
  const results: { purged: number }[] = [];
  const counted = {
    purgeWithdrawn: async (e: { accountId: string; withdrawnAt: string }) => {
      const r = await reviews.purgeWithdrawn(e);
      results.push(r);
      return r;
    },
  };
  const logs: [object, string | undefined][] = [];
  const handler = new ReviewAccountWithdrawnHandler(counted, undefined, { logger: { info: (o, msg) => void logs.push([o, msg]) } });
  return { clock, store, handler, results, logs };
}

/** 플랫폼 소비자처럼 decode → handle 차례로 부른다 */
async function deliver(handler: ReviewAccountWithdrawnHandler, m: ConsumedMessage): Promise<void> {
  const e = await handler.decode(m);
  await handler.handle(e);
}

describe('I-T83 탈퇴 사건으로 후기 파기', () => {
  test('I-T83 ① 탈퇴 사건을 받으면 그 계정 후기를 모두 파기 칸대로 비운다 (COV2-06 ①)', async () => {
    const { clock, store, handler, results, logs } = setup();
    const DELETED_AT = T0 - 2 * 3_600_000;
    const hiddenBody = '권리 침해 임시조치로 가린 후기 본문입니다.';
    // 살아 있는 후기의 지문(문자열)을 따로 둔다: 조치 증적·차단 목록의 지문 칸은 NOT NULL이다(시험 이의 1)
    const a2Fingerprint = contentFingerprint(hiddenBody);
    const a1 = review({ reviewId: randomUUID(), accountId: A, rating: 5, edited: true });
    const a1Fingerprint = contentFingerprint(a1.body);
    const a2 = review({ reviewId: randomUUID(), accountId: A, status: 'HIDDEN', notice: 'RIGHTS_TEMP', noticeUntilMs: T0 + 7 * DAY, rating: 2, body: hiddenBody, contentFingerprint: a2Fingerprint });
    // 2026-11-16 전의 작성자 지우기(Drizzle)는 본문·작성자 표시만 비우고 별점·지문·계정을 남겼다. 이미 지운 행도 파기 대상이다
    const a3 = review({ reviewId: randomUUID(), accountId: A, status: 'DELETED', body: '', rating: 3, authorDisplay: '***', updatedAtMs: DELETED_AT, deletedAtMs: DELETED_AT });
    const b1 = review({ reviewId: randomUUID(), accountId: B, eventId: a1.eventId, productionId: a1.productionId });
    for (const r of [a1, a2, a3, b1]) await store.insertReview(r);
    // 법정 조치 증적(takedown_action)과 같은 내용 차단 목록(review_hidden_fingerprint)은 후기와 따로 남는다
    const takedown: TakedownRecord = { takedownId: randomUUID(), reviewId: a2.reviewId, reason: 'RIGHTS_TEMP', contentFingerprint: a2Fingerprint, hiddenAtMs: T0 - DAY, endsAtMs: T0 + 7 * DAY };
    await store.insertTakedown(takedown);
    await store.addHiddenFingerprint(a1Fingerprint, undefined, T0 - DAY);

    // 처리 시각을 사건의 탈퇴 시각(02:00)·시험 시작(03:00)과 다르게 둔다
    clock.advance(3 * 60_000);
    const NOW = T0 + 3 * 60_000;
    await deliver(handler, message(withdrawn()));

    expect(results).toEqual([{ purged: 3 }]);
    expect(await store.findReview(a1.reviewId)).toEqual(purgedOf(a1, { nowMs: NOW, deletedAtMs: NOW }));
    expect(await store.findReview(a2.reviewId)).toEqual(purgedOf(a2, { nowMs: NOW, deletedAtMs: NOW }));
    // 이미 지운 행의 지운 시각은 처음 값 그대로다
    expect(await store.findReview(a3.reviewId)).toEqual(purgedOf(a3, { nowMs: NOW, deletedAtMs: DELETED_AT }));
    for (const id of [a1.reviewId, a2.reviewId, a3.reviewId]) {
      const after = (await store.findReview(id))!;
      // toEqual이 넘기는 undefined 칸까지 하나씩: 별점·지문은 null, 통보 가림 정보는 없다
      expect(after.rating, id).toBeNull();
      expect(after.contentFingerprint, id).toBeNull();
      expect(after.notice, id).toBeUndefined();
      expect(after.noticeUntilMs, id).toBeUndefined();
    }
    // 다른 계정 행은 모든 칸 그대로
    expect(await store.findReview(b1.reviewId)).toEqual(b1);
    expect([...store.reviews.values()].filter((r) => r.accountId === A)).toEqual([]);
    expect(await store.findReviewByEventAccount(a1.eventId, A)).toBeUndefined();
    expect(await store.takedownsByReview(a2.reviewId)).toEqual([takedown]);
    expect(await store.hasHiddenFingerprint(a1Fingerprint)).toBe(true);

    // 로그에는 eventKey와 파기 수만 있고 계정 ID·pid가 없다
    expect(logs).toHaveLength(1);
    expect(logs[0]![0]).toMatchObject({ eventKey: EVENT_KEY, purged: 3 });
    const logText = JSON.stringify(logs);
    for (const secret of [A, A.toUpperCase(), PID, OLD_PID]) expect(logText).not.toContain(secret);
  });

  test('I-T83 ③ 같은 사건을 다시 받아도 0건이고 행이 그대로다 (COV2-06 ②)', async () => {
    const { clock, store, handler, results } = setup();
    const a1 = review({ reviewId: randomUUID(), accountId: A });
    const a2 = review({ reviewId: randomUUID(), accountId: A });
    const b1 = review({ reviewId: randomUUID(), accountId: B });
    for (const r of [a1, a2, b1]) await store.insertReview(r);

    await deliver(handler, message(withdrawn()));
    const once = [...store.reviews.values()].map((r) => ({ ...r }));
    clock.advance(5 * 60_000);
    await deliver(handler, message(withdrawn(), { offset: 8n }));

    expect(results).toEqual([{ purged: 2 }, { purged: 0 }]);
    // 갱신 시각까지 첫 처리 뒤와 같다
    expect([...store.reviews.values()]).toEqual(once);
    // 예약은 min(탈퇴 02:00, 처리 03:00) + 16분 = 02:16 그대로다(둘째 처리 03:05에서도 같은 시각)
    expect(store.rechecks.get(A)?.dueAtMs).toBe(Date.parse('2026-11-16T02:16:00.000Z'));
    expect(store.rechecks.size).toBe(1);
  });

  test('COV2-06 ③ decode는 eventKey·accountId·withdrawnAt만 읽고 pid 없이도 읽는다', async () => {
    const { handler } = setup();
    const expected = { eventKey: EVENT_KEY, accountId: A, withdrawnAt: '2026-11-16T02:00:00.000Z' };
    expect(await handler.decode(message(withdrawn()))).toStrictEqual(expected);
    // 보류 뒤 다시 처리하는 값에는 pid·purgeBy가 없다
    expect(await handler.decode(message(expected))).toStrictEqual(expected);
    const decoded = await handler.decode(message(withdrawn()));
    expect(Object.keys(decoded).sort()).toEqual(['accountId', 'eventKey', 'withdrawnAt']);
    // 대문자 계정 ID는 소문자가 된다
    expect((await handler.decode(message(withdrawn({ accountId: A.toUpperCase() })))).accountId).toBe(A);
  });

  test('COV2-06 ④ 값이 없거나 모양이 틀리면 decode가 실패한다', async () => {
    const { handler } = setup();
    // 맞는 값은 읽힌다(대조군: 무엇이든 던지는 처리기는 이 시험을 통과하지 못한다)
    expect(await handler.decode(message(withdrawn()))).toMatchObject({ accountId: A });
    const { eventKey: _drop, ...noEventKey } = withdrawn();
    const bad: [string, unknown][] = [
      ['값 없음', null],
      ['UUID 아닌 accountId', withdrawn({ accountId: 'not-a-uuid' })],
      ['eventKey 없음', noEventKey],
      ['날짜 아닌 withdrawnAt', withdrawn({ withdrawnAt: '어제' })],
    ];
    for (const [what, value] of bad) {
      expect(() => handler.decode(message(value)), what).toThrow();
    }
  });

  test('COV2-06 ⑤ keyOf는 계정 ID, eventKeyOf는 eventKey다', async () => {
    const { handler } = setup();
    const e = { eventKey: EVENT_KEY, accountId: A, withdrawnAt: '2026-11-16T02:00:00.000Z' };
    expect(handler.keyOf(e)).toBe(A);
    expect(handler.eventKeyOf(e)).toBe(EVENT_KEY);
  });
});

describe('I-T83 내부 파기 경로', () => {
  const TOKEN = 'review-purge-internal-token-1';
  const store = new MemoryReviewStore();
  const clock = fakeClock({ now: T0 });
  const a1 = review({ reviewId: randomUUID(), accountId: A });
  const a2 = review({ reviewId: randomUUID(), accountId: A, status: 'HIDDEN', notice: 'POLICY' });
  const b1 = review({ reviewId: randomUUID(), accountId: B });
  let svc: Awaited<ReturnType<typeof createService>>;
  let previous: string | undefined;

  beforeAll(async () => {
    previous = process.env.PEAKET_INTERNAL_TOKEN;
    process.env.PEAKET_INTERNAL_TOKEN = TOKEN;
    for (const r of [a1, a2, b1]) await store.insertReview(r);
    svc = await createService({
      name: 'core-svc',
      module: AppModule.register({
        memory: true,
        review: { store, eligibility: new MemoryReviewEligibility(), fanProfile: new MemoryFanProfile(), notifier: new MemoryReviewNotifier(), cases: new MemoryReviewCaseSink() },
      }),
      env: { PEAKET_ENV: 'ci' },
      clock,
      logDestination: quiet(),
      adminAuthz: new FakeIdentity(),
    });
  });
  afterAll(async () => {
    await svc?.close();
    if (previous === undefined) delete process.env.PEAKET_INTERNAL_TOKEN;
    else process.env.PEAKET_INTERNAL_TOKEN = previous;
  });

  const call = (accountId: string, token?: string, action = 'purge') =>
    svc.http.inject({ method: 'POST', url: `/internal/v1/reviews/accounts/${accountId}/${action}`, ...(token === undefined ? {} : { headers: { 'x-peaket-internal-token': token } }) });
  const ofA = () => [...store.reviews.values()].filter((r) => r.accountId === A);

  test('I-T83 ③ 내부 파기 경로는 토큰이 없거나 틀리면 403이고 맞으면 파기한 건수를 주며 다시 불러도 0건이다 (COV2-06 ⑨)', async () => {
    expect((await call(A)).statusCode).toBe(403);
    expect((await call(A, `${TOKEN.slice(0, -1)}x`)).statusCode).toBe(403);
    expect(ofA()).toHaveLength(2);
    expect((await call('not-a-uuid', TOKEN)).statusCode).toBe(400);
    // 옛 경로 /anonymize는 없앴다: 토큰이 맞아도 404이고 아무것도 바꾸지 않는다
    expect((await call(A, TOKEN, 'anonymize')).statusCode).toBe(404);
    expect(ofA()).toHaveLength(2);

    clock.advance(60_000);
    const NOW = T0 + 60_000;
    const ok = await call(A, TOKEN);
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.payload)).toEqual({ purged: 2 });
    for (const before of [a1, a2]) expect(await store.findReview(before.reviewId)).toEqual(purgedOf(before, { nowMs: NOW, deletedAtMs: NOW }));
    expect(await store.findReview(b1.reviewId)).toEqual(b1);
    // 내부 경로는 다시 정리 예약을 만들지 않는다(docs/features/identity.md §8 '다시 정리')
    expect(store.rechecks.size).toBe(0);

    const once = [...store.reviews.values()].map((r) => ({ ...r }));
    clock.advance(60_000);
    const again = await call(A, TOKEN);
    expect(again.statusCode).toBe(200);
    expect(JSON.parse(again.payload)).toEqual({ purged: 0 });
    expect([...store.reviews.values()]).toEqual(once);
    expect(store.rechecks.size).toBe(0);
  });
});
