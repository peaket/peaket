// COV2-06(W7-audit): 탈퇴 사건(identity.accounts-withdrawn)을 받으면 core가 그 계정 후기의 계정·주문 참조를 후기 ID로 바꾼다.
// 정본: docs/features/identity.md §8 '후기 익명화', docs/streaming.md §2.6 'core-svc 소비자', asyncapi consumeAccountWithdrawn,
// docs/security/data-classification.md '탈퇴 사건의 pid 사본'(core는 eventKey·accountId·withdrawnAt만 읽는다).
// 본문·별점을 남길지 지울지는 계획 파일 W7-audit §5 OPEN 후보 1이 정한다. 그 결정 전에는 '계정·주문 참조를 끊는다'와 본문·별점이 지금 그대로인지만 본다.
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
} from '../src/modules/review/index.js';
import { FakeIdentity, quiet } from './support.js';

const TOPIC = 'identity.accounts-withdrawn';
const T0 = Date.parse('2026-11-16T03:00:00.000Z');
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
  createdAtMs: T0 - 86_400_000,
  updatedAtMs: T0 - 86_400_000,
  edited: false,
  ...o,
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
  const results: { anonymized: number }[] = [];
  const counted = {
    anonymizeAccount: async (accountId: string) => {
      const r = await reviews.anonymizeAccount(accountId);
      results.push(r);
      return r;
    },
  };
  const logs: unknown[] = [];
  const handler = new ReviewAccountWithdrawnHandler(counted, undefined, { logger: { info: (o, msg) => void logs.push([o, msg]) } });
  return { clock, store, handler, results, logs };
}

/** 플랫폼 소비자처럼 decode → handle 차례로 부른다 */
async function deliver(handler: ReviewAccountWithdrawnHandler, m: ConsumedMessage): Promise<void> {
  const e = await handler.decode(m);
  await handler.handle(e);
}

describe('COV2-06 탈퇴 사건으로 후기 익명화', () => {
  test('COV2-06 ① 탈퇴 사건을 받으면 그 계정 후기의 계정·주문 참조를 후기 ID로 바꾼다', async () => {
    const { clock, store, handler, results, logs } = setup();
    const a1 = review({ reviewId: randomUUID(), accountId: A });
    const a2 = review({ reviewId: randomUUID(), accountId: A, status: 'DELETED', rating: 2, body: '지운 후기도 계정 참조를 끊어야 합니다.' });
    const b1 = review({ reviewId: randomUUID(), accountId: B });
    for (const r of [a1, a2, b1]) await store.insertReview(r);

    clock.advance(60_000);
    await deliver(handler, message(withdrawn()));

    expect(results).toEqual([{ anonymized: 2 }]);
    for (const before of [a1, a2]) {
      const after = (await store.findReview(before.reviewId))!;
      expect(after.accountId).toBe(before.reviewId);
      expect(after.basisOrderId).toBe(before.reviewId);
      expect(after.authorDisplay).toBe('탈퇴한 사용자');
      expect(after.updatedAtMs).toBe(T0 + 60_000);
      // OPEN 후보 1(익명화 대 파기) 결정 전: 본문·별점·상태는 지금 그대로다
      expect(after).toMatchObject({ body: before.body, rating: before.rating, status: before.status, eventId: before.eventId });
    }
    expect(await store.findReview(b1.reviewId)).toEqual(b1);
    // 로그에는 계정 ID·pid가 없다
    expect(logs.length).toBeGreaterThan(0);
    const logText = JSON.stringify(logs);
    expect(logText).toContain(EVENT_KEY);
    expect(logText).not.toContain(A);
    expect(logText).not.toContain(PID);
  });

  test('COV2-06 ② 같은 사건을 다시 받아도 결과가 같다', async () => {
    const { clock, store, handler, results } = setup();
    const a1 = review({ reviewId: randomUUID(), accountId: A });
    const a2 = review({ reviewId: randomUUID(), accountId: A });
    for (const r of [a1, a2]) await store.insertReview(r);

    await deliver(handler, message(withdrawn()));
    const once = [...store.reviews.values()].map((r) => ({ ...r }));
    clock.advance(5 * 60_000);
    await deliver(handler, message(withdrawn(), { offset: 8n }));

    expect(results).toEqual([{ anonymized: 2 }, { anonymized: 0 }]);
    expect([...store.reviews.values()]).toEqual(once);
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

describe('COV2-06 내부 익명화 경로', () => {
  const TOKEN = 'review-anonymize-internal-token-1';
  const store = new MemoryReviewStore();
  let svc: Awaited<ReturnType<typeof createService>>;
  let previous: string | undefined;

  beforeAll(async () => {
    previous = process.env.PEAKET_INTERNAL_TOKEN;
    process.env.PEAKET_INTERNAL_TOKEN = TOKEN;
    for (const id of [randomUUID(), randomUUID()]) await store.insertReview(review({ reviewId: id, accountId: A }));
    await store.insertReview(review({ reviewId: randomUUID(), accountId: B }));
    svc = await createService({
      name: 'core-svc',
      module: AppModule.register({
        memory: true,
        review: { store, eligibility: new MemoryReviewEligibility(), fanProfile: new MemoryFanProfile(), notifier: new MemoryReviewNotifier(), cases: new MemoryReviewCaseSink() },
      }),
      env: { PEAKET_ENV: 'ci' },
      clock: fakeClock({ now: T0 }),
      logDestination: quiet(),
      adminAuthz: new FakeIdentity(),
    });
  });
  afterAll(async () => {
    await svc?.close();
    if (previous === undefined) delete process.env.PEAKET_INTERNAL_TOKEN;
    else process.env.PEAKET_INTERNAL_TOKEN = previous;
  });

  const anonymize = (accountId: string, token?: string) =>
    svc.http.inject({ method: 'POST', url: `/internal/v1/reviews/accounts/${accountId}/anonymize`, ...(token === undefined ? {} : { headers: { 'x-peaket-internal-token': token } }) });

  test('COV2-06 ⑨ 내부 익명화 경로는 토큰이 없거나 틀리면 403이고 맞으면 바꾼 건수를 준다', async () => {
    expect((await anonymize(A)).statusCode).toBe(403);
    expect((await anonymize(A, `${TOKEN.slice(0, -1)}x`)).statusCode).toBe(403);
    expect([...store.reviews.values()].filter((r) => r.accountId === A)).toHaveLength(2);
    expect((await anonymize('not-a-uuid', TOKEN)).statusCode).toBe(400);

    const ok = await anonymize(A, TOKEN);
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.payload)).toEqual({ anonymized: 2 });
    expect([...store.reviews.values()].filter((r) => r.accountId === A)).toHaveLength(0);
    expect([...store.reviews.values()].filter((r) => r.accountId === B)).toHaveLength(1);

    const again = await anonymize(A, TOKEN);
    expect(again.statusCode).toBe(200);
    expect(JSON.parse(again.payload)).toEqual({ anonymized: 0 });
  });
});
