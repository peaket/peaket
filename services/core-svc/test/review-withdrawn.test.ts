// I-T83 ①③⑨(W8-audit2a, 소유자 결정 2026-11-16 OPEN[42], ADR-0278)·COV2-06(W7-audit): 탈퇴 사건(identity.accounts-withdrawn)을 받으면 core가 그 계정 후기를 파기한다.
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
import { FakeIdentity, logSinkUnit } from './support.js';

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

describe('I-T83 손으로 하는 파기(보류된 탈퇴 사건이 있을 때만)', () => {
  // 웨이브 끝 보안 리뷰 S1(계획 §9.1, 정본 docs/features/identity.md §8 '손으로 처리'): 내부 경로는 그 계정의 처리 안 한 탈퇴 보류 사건이 있을 때만 파기하고,
  // 요청자·사유를 받아 운영 줄에 남긴다(계정 ID 없음). 같은 트랜잭션에서 다시 정리 예약(지금 + 16분)을 쓰고 보류 행을 다시 처리로 표시한다.
  // 다시 보기 N1(계획 §10.5): 응답 heldEvents·heldEventIds와 운영 줄 held는 처리한 보류 행 전부(eventKey가 없는 행 포함)를 보류 행 ID 차례로 싣는다.
  // 해독하지 못한 사건(값이 없거나 깨진 사건)은 eventKey 없이 보류된다(docs/data.md §4의 15). 그런 행은 eventKey: null로 넣는다
  const TOKEN = 'review-purge-internal-token-1';
  const TOPIC_W = 'identity.accounts-withdrawn';
  const C = '0190f3a1-7c2e-7a00-8000-00000000c001';
  const D = '0190f3a1-7c2e-7a00-8000-00000000d001';
  const E = '0190f3a1-7c2e-7a00-8000-00000000e001';
  const store = new MemoryReviewStore();
  const clock = fakeClock({ now: T0 });
  const sink = logSinkUnit();
  const a1 = review({ reviewId: randomUUID(), accountId: A });
  const a2 = review({ reviewId: randomUUID(), accountId: A, status: 'HIDDEN', notice: 'POLICY' });
  const b1 = review({ reviewId: randomUUID(), accountId: B });
  const c1 = review({ reviewId: randomUUID(), accountId: C });
  const d1 = review({ reviewId: randomUUID(), accountId: D });
  const e1 = review({ reviewId: randomUUID(), accountId: E });
  // G: 해독하지 못한 사건의 보류 행(eventKey 없음) 하나뿐인 계정(리뷰 N1의 꼴)
  const G = '0190f3a1-7c2e-7a00-8000-000000009001';
  const g1 = review({ reviewId: randomUUID(), accountId: G });
  const KEY_A1 = '0190f3a1-7c2e-7a00-8000-0000000e0a01';
  // 보류 행 ID(held_event.id). 차례가 정해진 고정 글자이고 eventKey·계정 ID와 다른 값이다
  const HELD_A1 = '0190f3a1-7c2e-7a00-8000-0000000d0a01';
  const HELD_A2 = '0190f3a1-7c2e-7a00-8000-0000000d0a02';
  const HELD_A3 = '0190f3a1-7c2e-7a00-8000-0000000d0a03';
  const HELD_C = '0190f3a1-7c2e-7a00-8000-0000000d0c01';
  const HELD_D = '0190f3a1-7c2e-7a00-8000-0000000d0d01';
  const HELD_F = '0190f3a1-7c2e-7a00-8000-0000000d0f01';
  const HELD_G = '0190f3a1-7c2e-7a00-8000-0000000d9001';
  let svc: Awaited<ReturnType<typeof createService>>;
  let previous: string | undefined;

  beforeAll(async () => {
    previous = process.env.PEAKET_INTERNAL_TOKEN;
    process.env.PEAKET_INTERNAL_TOKEN = TOKEN;
    for (const r of [a1, a2, b1, c1, d1, e1, g1]) await store.insertReview(r);
    store.heldEvents.push(
      // A: 업무 키가 그 계정인 보류 하나와, 값을 읽지 못해 eventKey 없이 Kafka 키(대문자)만 그 계정인 보류 둘. 넣는 차례(a03, a01, a02)는 ID 차례와 다르다
      { id: HELD_A3, topic: TOPIC_W, eventKey: null, businessKey: 'unreadable-2', msgKey: A.toUpperCase() },
      { id: HELD_A1, topic: TOPIC_W, eventKey: KEY_A1, businessKey: A, msgKey: A },
      { id: HELD_A2, topic: TOPIC_W, eventKey: null, businessKey: 'unreadable-0', msgKey: A.toUpperCase() },
      // C: 이미 다시 처리한 보류뿐, D: 다른 토픽의 보류뿐, E: 보류가 없고 다른 계정(F)의 보류만 있다. B는 보류가 아예 없다
      { id: HELD_C, topic: TOPIC_W, eventKey: '0190f3a1-7c2e-7a00-8000-0000000e0c01', businessKey: C, msgKey: C, reprocessedAtMs: T0 - DAY },
      { id: HELD_D, topic: 'trade.orders', eventKey: '0190f3a1-7c2e-7a00-8000-0000000e0d01', businessKey: D, msgKey: D },
      { id: HELD_F, topic: TOPIC_W, eventKey: '0190f3a1-7c2e-7a00-8000-0000000e0f01', businessKey: '0190f3a1-7c2e-7a00-8000-00000000f001', msgKey: null },
      // G: 해독하지 못한 사건의 보류 하나(eventKey 없음, 업무 키는 읽지 못한 값, Kafka 키는 대문자 G)
      { id: HELD_G, topic: TOPIC_W, eventKey: null, businessKey: 'unreadable-1', msgKey: G.toUpperCase() },
    );
    svc = await createService({
      name: 'core-svc',
      module: AppModule.register({
        memory: true,
        review: { store, eligibility: new MemoryReviewEligibility(), fanProfile: new MemoryFanProfile(), notifier: new MemoryReviewNotifier(), cases: new MemoryReviewCaseSink() },
      }),
      env: { PEAKET_ENV: 'ci' },
      clock,
      logDestination: sink.stream,
      adminAuthz: new FakeIdentity(),
    });
  });
  afterAll(async () => {
    await svc?.close();
    if (previous === undefined) delete process.env.PEAKET_INTERNAL_TOKEN;
    else process.env.PEAKET_INTERNAL_TOKEN = previous;
  });

  const BODY = { reason: '보류된 탈퇴 사건을 손으로 처리한다(CS-1234)', requestedBy: 'ops-kim' };
  const call = (accountId: string, o: { token?: string | null; body?: unknown; action?: string } = {}) => {
    const token = o.token === undefined ? TOKEN : o.token;
    const body = 'body' in o ? o.body : BODY;
    return svc.http.inject({
      method: 'POST',
      url: `/internal/v1/reviews/accounts/${accountId}/${o.action ?? 'purge'}`,
      headers: { ...(token === null ? {} : { 'x-peaket-internal-token': token }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  };
  const snapshot = () => ({ reviews: [...store.reviews.values()].map((r) => ({ ...r })), held: store.heldEvents.map((h) => ({ ...h })), rechecks: [...store.rechecks] });
  /** 보류 행 ID → 다시 처리 시각(없으면 '없음') */
  const reprocessed = () => Object.fromEntries(store.heldEvents.map((h) => [h.id, h.reprocessedAtMs ?? '없음']));

  test('I-T83 ⑨ 보류된 탈퇴 사건이 없는 계정은 손으로 파기할 수 없다', async () => {
    const before = snapshot();
    // B: 보류 없음(탈퇴하지 않은 팬), C: 이미 다시 처리한 보류뿐, D: 다른 토픽의 보류뿐, E: 다른 계정의 보류만 있다
    for (const who of [B, C, D, E]) {
      const r = await call(who);
      expect(r.statusCode, who).toBe(409);
      expect(JSON.parse(r.payload), who).toMatchObject({ type: expect.stringMatching(/withdrawal-not-held$/) });
    }
    // 유스케이스도 같다(계정 ID가 UUID가 아니면 422)
    const reviews = svc.app.get(Reviews);
    await expect(reviews.purgeHeldWithdrawal(B, BODY)).rejects.toMatchObject({ status: 409 });
    await expect(reviews.purgeHeldWithdrawal('not-a-uuid', BODY)).rejects.toMatchObject({ status: 422 });
    // 아무것도 바뀌지 않았다(후기·보류 행·예약 없음)
    expect(snapshot()).toEqual(before);
    expect(store.rechecks.size).toBe(0);
  });

  test('I-T83 ⑨ 사유·요청자 없이는 부를 수 없고 처리하면 운영 줄에 남는다', async () => {
    const before = snapshot();
    // 토큰 없음·틀림 403
    expect((await call(A, { token: null })).statusCode).toBe(403);
    expect((await call(A, { token: `${TOKEN.slice(0, -1)}x` })).statusCode).toBe(403);
    // 빠진 칸·경계 밖은 400: 본문 없음, 사유 9자·501자, 요청자 ''·65자, 모르는 칸, 칸 빠짐
    const bad: [string, unknown][] = [
      ['본문 없음', undefined],
      ['사유 9자', { reason: '가'.repeat(9), requestedBy: 'ops-kim' }],
      ['사유 501자', { reason: '가'.repeat(501), requestedBy: 'ops-kim' }],
      ['요청자 빈 글자', { reason: BODY.reason, requestedBy: '' }],
      ['요청자 65자', { reason: BODY.reason, requestedBy: 'o'.repeat(65) }],
      ['모르는 칸', { ...BODY, accountId: A }],
      ['사유 빠짐', { requestedBy: 'ops-kim' }],
      ['요청자 빠짐', { reason: BODY.reason }],
    ];
    for (const [what, body] of bad) expect((await call(A, { body })).statusCode, what).toBe(400);
    // 옛 경로 /anonymize는 404, UUID 아닌 계정은 400
    expect((await call(A, { action: 'anonymize' })).statusCode).toBe(404);
    expect((await call('not-a-uuid')).statusCode).toBe(400);
    expect(snapshot()).toEqual(before);
  });

  test('I-T83 ⑨ 키 있는 행과 없는 행이 섞인 계정은 모두 세고 ID 차례로 싣는다', async () => {
    // 경계 안쪽 끝 값(사유 10자, 요청자 64자)으로 부른다. 대문자 계정 ID로 불러도 같은 계정이다
    // 리뷰 N1: 전에는 값 없는 행에도 eventKey를 넣어(KEY_A2) 키 없는 행이 수와 운영 줄에서 빠지는 결함을 덮었다
    clock.advance(3 * 60_000);
    const NOW = T0 + 3 * 60_000;
    const body = { reason: '가'.repeat(10), requestedBy: 'r'.repeat(64) };
    const before = sink.lines().length;
    const ok = await call(A.toUpperCase(), { body });
    expect(ok.statusCode).toBe(200);
    // 처리한 보류 행 셋을 모두 센다(eventKey가 있든 없든). ID는 보류 행 ID 차례다
    expect(JSON.parse(ok.payload)).toEqual({ purged: 2, heldEvents: 3, heldEventIds: [HELD_A1, HELD_A2, HELD_A3] });
    for (const r of [a1, a2]) expect(await store.findReview(r.reviewId)).toEqual(purgedOf(r, { nowMs: NOW, deletedAtMs: NOW }));
    for (const r of [b1, c1, d1, e1, g1]) expect(await store.findReview(r.reviewId)).toEqual(r);
    // A의 세 보류 행은 다시 처리(지금), 다른 보류 행은 그대로
    expect(reprocessed()).toEqual({ [HELD_A1]: NOW, [HELD_A2]: NOW, [HELD_A3]: NOW, [HELD_C]: T0 - DAY, [HELD_D]: '없음', [HELD_F]: '없음', [HELD_G]: '없음' });
    // 다시 정리 예약 = 지금 + 16분(처리 시각 기준)
    expect(store.rechecks.get(A)?.dueAtMs).toBe(NOW + 16 * 60_000);
    expect(store.rechecks.size).toBe(1);

    // 운영 줄 하나: 누가·왜·몇 건·어느 보류 행(응답과 같은 차례, 키 없는 행은 eventKey: null). 옛 칸 heldEventKeys와 계정 ID는 없다
    const manual = sink.lines().slice(before).filter((l) => l.kind === 'review-purge-manual');
    expect(manual).toHaveLength(1);
    expect(manual[0]).toMatchObject({ requestedBy: body.requestedBy, reason: body.reason, purged: 2, heldEvents: 3 });
    expect(manual[0]!.held).toEqual([
      { id: HELD_A1, eventKey: KEY_A1 },
      { id: HELD_A2, eventKey: null },
      { id: HELD_A3, eventKey: null },
    ]);
    expect(manual[0]).not.toHaveProperty('heldEventKeys');
    const text = JSON.stringify(manual[0]);
    for (const secret of [A, A.toUpperCase()]) expect(text).not.toContain(secret);

    // 다시 부르면 처리할 보류가 없어 409이고 바뀌는 것이 없다
    const once = snapshot();
    clock.advance(60_000);
    const again = await call(A, { body });
    expect(again.statusCode).toBe(409);
    expect(snapshot()).toEqual(once);
  });

  test('I-T83 ⑨ 키 없는 보류 행만 있는 계정도 처리한 보류 행 수와 ID를 돌려주고 운영 줄에 남긴다', async () => {
    // 리뷰 N1의 꼴 그대로: 이 경로가 있는 까닭인 '값 없이 Kafka 키만 그 계정인 보류 행' 하나뿐인 계정
    clock.advance(2 * 60_000);
    const NOW = clock.now();
    const before = sink.lines().length;
    const ok = await call(G);
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.payload)).toEqual({ purged: 1, heldEvents: 1, heldEventIds: [HELD_G] });
    expect(await store.findReview(g1.reviewId)).toEqual(purgedOf(g1, { nowMs: NOW, deletedAtMs: NOW }));
    expect(store.heldEvents.find((h) => h.id === HELD_G)?.reprocessedAtMs).toBe(NOW);
    expect(store.rechecks.get(G)?.dueAtMs).toBe(NOW + 16 * 60_000);
    // 다른 계정의 처리 안 한 보류 행은 그대로다
    expect(reprocessed()).toMatchObject({ [HELD_D]: '없음', [HELD_F]: '없음' });

    // 운영 줄은 정확히 하나: 처리한 보류 행 하나의 ID와 eventKey: null. 줄 글에 계정 ID(대문자로 쓴 Kafka 키 포함)가 없다
    const manual = sink.lines().slice(before).filter((l) => l.kind === 'review-purge-manual');
    expect(manual).toHaveLength(1);
    expect(manual[0]).toMatchObject({ requestedBy: BODY.requestedBy, reason: BODY.reason, purged: 1, heldEvents: 1 });
    expect(manual[0]!.held).toEqual([{ id: HELD_G, eventKey: null }]);
    expect(manual[0]).not.toHaveProperty('heldEventKeys');
    const text = JSON.stringify(manual[0]);
    for (const secret of [G, G.toUpperCase()]) expect(text).not.toContain(secret);

    // 다시 부르면 409
    expect((await call(G)).statusCode).toBe(409);
  });
});
