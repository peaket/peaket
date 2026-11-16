// I-T83 ④⑤(W8-audit2a, 소유자 결정 2026-11-16 OPEN[44], ADR-0278): 탈퇴 사건 처리는 파기와 함께 '다시 정리 예약'(탈퇴 시각 + 16분)을 쓰고,
// 소비자 파드의 반복이 때가 된 예약을 다시 파기한다. 탈퇴 전 토큰(최대 15분)으로 사건 처리 뒤에 쓴 후기를 지우려는 것이다.
// 정본: docs/features/identity.md §8 '다시 정리'·§12 I-T83, docs/streaming.md §2.6 'core-svc 소비자', docs/data.md §2 '다시 정리 예약'.
// 단언 값은 정본에서 적는다(16분 = 15분 + 여유 1분 [가정], 간격 60초 [가정], 한 번에 100개 [가정]). 코드 상수를 가져오지 않는다.
// 시간 값은 상수와 다르게 고른다: 탈퇴 시각과 처리 시각을 3분 어긋나게, 예약 경계는 −1ms·0ms.
// 리뷰 A1(W8-audit2a §8.1, docs/observability.md 운영 확인 '탈퇴 후기 다시 정리' 행): 반복이 실패해도 밀린 시간 지표를 새 값으로 고치고, 실패 수를 세며,
// 마지막 성공 시각은 성공한 한 번에서만 고친다. 경보 기준(밀린 시간 5일 [가정] 넘음, 마지막 성공 30분 [가정] 넘게 없음)의 경계 직전·직후를 가짜 시계로 만든다.
import { type ConsumedMessage, fakeClock, PlatformMetrics, type Registry } from '@peaket/platform';
import { DrizzleQueryError } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { startReviewRecheckLoop } from '../src/consumers/review-recheck.js';
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
  withdrawalRecheckAt,
} from '../src/modules/review/index.js';

const at = (iso: string): number => Date.parse(iso);
const MIN = 60_000;
/** 정본 값: 액세스 토큰 최대 15분 + 여유 1분 [가정] */
const RECHECK_DELAY = 16 * MIN;
const A = '0190f3a1-7c2e-7a00-8000-00000000a004';
const B = '0190f3a1-7c2e-7a00-8000-00000000b004';
const C = '0190f3a1-7c2e-7a00-8000-00000000c004';
const PID = 'pidRECHECKcurrent_4242';

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

const review = (accountId: string, createdAtMs: number, o: Partial<ReviewRecord> = {}): ReviewRecord => {
  const body = `다시 정리 시험용 후기 본문 ${randomUUID().slice(0, 8)}`;
  return {
    reviewId: randomUUID(),
    eventId: randomUUID(),
    productionId: randomUUID(),
    accountId,
    basisOrderId: randomUUID(),
    rating: 5,
    body,
    status: 'VISIBLE',
    contentFingerprint: contentFingerprint(body),
    authorDisplay: '김**',
    createdAtMs,
    updatedAtMs: createdAtMs,
    edited: false,
    ...o,
  };
};

function setup(nowIso: string) {
  const clock = fakeClock({ now: at(nowIso) });
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
  const handler = new ReviewAccountWithdrawnHandler(reviews);
  /** 플랫폼 소비자처럼 decode → handle(계약 전체 모양의 JSON 사건) */
  const deliver = async (accountId: string, withdrawnAt: string): Promise<void> => {
    const value = Buffer.from(JSON.stringify({ eventKey: randomUUID(), accountId, pids: [PID], withdrawnAt, purgeBy: '2026-11-21T03:00:00.000Z' }), 'utf8');
    const m: ConsumedMessage = { topic: 'identity.accounts-withdrawn', partition: 0, offset: 1n, key: accountId, value, headers: {}, timestamp: clock.now() };
    await handler.handle(handler.decode(m));
  };
  return { clock, store, reviews, deliver };
}

/** 조건이 맞을 때까지 기다린다(실제 시간 2초까지) */
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > end) throw new Error(`기다리다 끝남: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** maintenance_retention_overdue_seconds{service="core-svc",table="review_withdrawal_recheck"} 값. 없으면 undefined */
async function overdueSeconds(registry: Registry): Promise<number | undefined> {
  let text: string;
  try {
    text = await registry.getSingleMetricAsString('maintenance_retention_overdue_seconds');
  } catch {
    return undefined;
  }
  const line = text
    .split('\n')
    .find((l) => l.startsWith('maintenance_retention_overdue_seconds{') && l.includes('service="core-svc"') && l.includes('table="review_withdrawal_recheck"'));
  return line === undefined ? undefined : Number(line.slice(line.lastIndexOf(' ') + 1));
}

/** 가짜 sleep: 부른 간격을 적고, 시험이 wake()를 부르거나 멈춤 신호가 오면 풀린다(platform realSleep처럼 멈춤에는 resolve) */
function fakeSleep() {
  const sleeps: number[] = [];
  let pending: (() => void) | undefined;
  const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve) => {
      sleeps.push(ms);
      if (signal.aborted) return resolve();
      pending = resolve;
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  return {
    sleep,
    sleeps,
    /** 0보다 긴 쉼만(곧바로 다시 도는 자리의 sleep(0)은 세지 않는다) */
    waits: () => sleeps.filter((ms) => ms > 0),
    wake: () => {
      const p = pending;
      pending = undefined;
      p?.();
    },
  };
}

describe('I-T83 다시 정리 예약', () => {
  test('I-T83 ④ 예약 시각은 min(탈퇴 시각, 처리 시각) + 16분이고 탈퇴 시각을 읽지 못하면 실패한다', () => {
    const NOW = at('2026-11-16T03:03:00.000Z');
    // 탈퇴 03:00, 처리 03:03 → 03:16(처리 시각 + 16분인 03:19도, 15분인 03:15도 아니다)
    expect(withdrawalRecheckAt('2026-11-16T03:00:00.000Z', NOW)).toBe(at('2026-11-16T03:16:00.000Z'));
    // 탈퇴 시각이 미래(시계 어긋남)면 처리 시각 + 16분을 넘지 않는다
    expect(withdrawalRecheckAt('2026-11-16T09:00:00.000Z', NOW)).toBe(at('2026-11-16T03:19:00.000Z'));
    // 경계: 탈퇴 시각이 처리 시각보다 1ms 앞·같음·1ms 뒤
    expect(withdrawalRecheckAt(new Date(NOW - 1).toISOString(), NOW)).toBe(NOW - 1 + RECHECK_DELAY);
    expect(withdrawalRecheckAt(new Date(NOW).toISOString(), NOW)).toBe(NOW + RECHECK_DELAY);
    expect(withdrawalRecheckAt(new Date(NOW + 1).toISOString(), NOW)).toBe(NOW + RECHECK_DELAY);
    // 시간대 표기가 달라도 같은 순간이다
    expect(withdrawalRecheckAt('2026-11-16T12:00:00.000+09:00', NOW)).toBe(at('2026-11-16T03:16:00.000Z'));
    for (const bad of ['어제', '', '2026-13-45T99:00:00Z']) expect(() => withdrawalRecheckAt(bad, NOW), bad).toThrow(Error);
  });

  test('I-T83 ④ 탈퇴 사건 처리는 파기와 탈퇴 시각 + 16분 예약을 함께 쓴다', async () => {
    const { clock, store, deliver } = setup('2026-11-16T03:03:00.000Z');
    const a1 = review(A, at('2026-11-15T10:00:00.000Z'));
    const c1 = review(C, at('2026-11-15T11:00:00.000Z'));
    const b1 = review(B, at('2026-11-15T12:00:00.000Z'));
    for (const r of [a1, c1, b1]) await store.insertReview(r);

    await deliver(A, '2026-11-16T03:00:00.000Z');
    // 파기와 예약이 함께 있다. 예약 시각은 처리 시각(03:03) + 16분이 아니라 탈퇴 시각(03:00) + 16분이다
    expect((await store.findReview(a1.reviewId))?.status).toBe('DELETED');
    expect(store.rechecks.get(A)).toEqual({ dueAtMs: at('2026-11-16T03:16:00.000Z'), createdAtMs: at('2026-11-16T03:03:00.000Z') });

    // 탈퇴 시각이 미래면 처리 시각 + 16분
    await deliver(C, '2026-11-16T09:00:00.000Z');
    expect(store.rechecks.get(C)?.dueAtMs).toBe(at('2026-11-16T03:19:00.000Z'));
    // 같은 계정 사건을 다시 받아 더 이른 시각(02:50 + 16분 = 03:06)이 와도 예약은 늦은 쪽 그대로다
    await deliver(C, '2026-11-16T02:50:00.000Z');
    expect(store.rechecks.get(C)?.dueAtMs).toBe(at('2026-11-16T03:19:00.000Z'));
    // 더 늦은 시각이 오면 늦은 쪽으로 옮긴다(처리 03:10, 탈퇴 03:05 → 03:21)
    clock.advance(7 * MIN);
    await deliver(A, '2026-11-16T03:05:00.000Z');
    expect(store.rechecks.get(A)?.dueAtMs).toBe(at('2026-11-16T03:21:00.000Z'));

    // 사건이 없는 계정에는 예약이 없고, 그 후기는 그대로다
    expect(store.rechecks.has(B)).toBe(false);
    expect(store.rechecks.size).toBe(2);
    expect(await store.findReview(b1.reviewId)).toEqual(b1);
  });

  test('I-T83 ④ 예약 시각 전에는 다시 정리하지 않고 그 시각에 파기한다', async () => {
    const { clock, store, reviews, deliver } = setup('2026-11-16T03:03:00.000Z');
    await store.insertReview(review(A, at('2026-11-15T10:00:00.000Z')));
    await deliver(A, '2026-11-16T03:00:00.000Z');
    const DUE = at('2026-11-16T03:16:00.000Z');

    // 탈퇴 전에 받은 토큰으로 사건 처리 뒤에 새 후기를 쓴다(흉내: 저장소에 바로 넣는다)
    clock.advance(2 * MIN);
    const late = review(A, clock.now());
    await store.insertReview(late);
    // 다른 계정 C는 03:05 처리, 탈퇴 03:03 → 예약 03:19(A 예약 시각에는 아직 때가 아니다)
    await deliver(C, '2026-11-16T03:03:00.000Z');
    clock.advance(MIN);
    const lateC = review(C, clock.now());
    await store.insertReview(lateC);

    // 예약 시각 − 1ms
    clock.advance(DUE - 1 - clock.now());
    expect(await reviews.runWithdrawalRechecks()).toEqual({ accounts: 0, purged: 0 });
    expect(await store.findReview(late.reviewId)).toEqual(late);
    expect(store.rechecks.get(A)?.dueAtMs).toBe(DUE);

    // 예약 시각 정각
    clock.advance(1);
    expect(await reviews.runWithdrawalRechecks()).toEqual({ accounts: 1, purged: 1 });
    expect(await store.findReview(late.reviewId)).toEqual(purgedOf(late, { nowMs: DUE, deletedAtMs: DUE }));
    // 처리한 예약은 지운다(계정 ID가 남지 않는다). 때가 안 된 C 예약과 그 후기는 그대로다
    expect(store.rechecks.has(A)).toBe(false);
    expect(store.rechecks.get(C)?.dueAtMs).toBe(at('2026-11-16T03:19:00.000Z'));
    expect(await store.findReview(lateC.reviewId)).toEqual(lateC);
    // 다시 불러도 0건
    expect(await reviews.runWithdrawalRechecks()).toEqual({ accounts: 0, purged: 0 });

    clock.advance(at('2026-11-16T03:19:00.000Z') - clock.now());
    expect(await reviews.runWithdrawalRechecks()).toEqual({ accounts: 1, purged: 1 });
    expect(store.rechecks.size).toBe(0);
  });

  test('I-T83 ④ 탈퇴 시각을 읽지 못하거나 계정 ID가 틀리면 파기도 예약도 하지 않는다', async () => {
    const { store, reviews } = setup('2026-11-16T03:03:00.000Z');
    const a1 = review(A, at('2026-11-15T10:00:00.000Z'));
    await store.insertReview(a1);
    const bad = [
      { accountId: 'not-a-uuid', withdrawnAt: '2026-11-16T03:00:00.000Z' },
      { accountId: A, withdrawnAt: '어제' },
      { accountId: A, withdrawnAt: '' },
    ];
    for (const e of bad) await expect(reviews.purgeWithdrawn(e), JSON.stringify(e)).rejects.toThrow();
    expect(await store.findReview(a1.reviewId)).toEqual(a1);
    expect(store.rechecks.size).toBe(0);

    // 대조군: 맞는 사건은 파기와 예약을 함께 쓴다
    expect(await reviews.purgeWithdrawn({ accountId: A, withdrawnAt: '2026-11-16T03:00:00.000Z' })).toEqual({ purged: 1 });
    expect(store.rechecks.get(A)?.dueAtMs).toBe(at('2026-11-16T03:16:00.000Z'));
  });

  test('I-T83 ④ 처리기는 탈퇴 시각을 그대로 넘기고 저장소가 실패하면 함께 실패한다', async () => {
    const e = { eventKey: randomUUID(), accountId: A, withdrawnAt: '2026-11-16T02:47:00.000Z' };
    const got: unknown[] = [];
    const logs: unknown[] = [];
    const ok = new ReviewAccountWithdrawnHandler(
      {
        purgeWithdrawn: async (x) => {
          got.push(x);
          return { purged: 12 };
        },
      },
      undefined,
      { logger: { info: (o, msg) => void logs.push([o, msg]) } },
    );
    await ok.handle(e);
    // 처리 시각이 아니라 사건의 탈퇴 시각을 넘긴다
    expect(got).toEqual([{ accountId: A, withdrawnAt: '2026-11-16T02:47:00.000Z' }]);
    expect(logs).toHaveLength(1);
    expect((logs[0] as [object, string])[0]).toMatchObject({ eventKey: e.eventKey, purged: 12 });
    expect(JSON.stringify(logs)).not.toContain(A);

    // 저장소 일시 장애는 그대로 던진다(조용히 넘기면 플랫폼이 사건을 처리한 것으로 커밋한다)
    const failing = new ReviewAccountWithdrawnHandler({
      purgeWithdrawn: async () => {
        throw new Error('connection terminated unexpectedly');
      },
    });
    await expect(failing.handle(e)).rejects.toThrow('connection terminated unexpectedly');
  });

  test('I-T83 ⑤ 다시 정리 한 번은 기본 100개씩 예약 시각 차례로 처리하고 가장 오래 밀린 시간을 ms로 준다', async () => {
    const { clock, store, reviews } = setup('2026-11-16T03:03:00.000Z');
    // 101개 계정: i번째 탈퇴 시각 = 02:00 + i초 → 예약 02:16:00 + i초(모두 때가 지났다)
    const accounts = Array.from({ length: 101 }, () => randomUUID());
    for (const [i, id] of accounts.entries()) await reviews.purgeWithdrawn({ accountId: id, withdrawnAt: new Date(at('2026-11-16T02:00:00.000Z') + i * 1000).toISOString() });
    expect(store.rechecks.size).toBe(101);
    // 사건 처리 뒤에 쓴 후기: 앞 12개 계정과 맨 끝 계정
    for (const id of [...accounts.slice(0, 12), accounts[100]!]) await store.insertReview(review(id, clock.now()));

    // 가장 오래 밀린 예약: 03:03 − 02:16 = 47분
    expect(await reviews.oldestOverdueRecheckMs()).toBe(47 * MIN);
    // 기본 100개: 예약 시각이 이른 100개를 먼저 한다(맨 끝 계정이 남는다)
    expect(await reviews.runWithdrawalRechecks()).toEqual({ accounts: 100, purged: 12 });
    expect([...store.rechecks.keys()]).toEqual([accounts[100]]);
    expect(await reviews.oldestOverdueRecheckMs()).toBe(47 * MIN - 100 * 1000);
    expect(await reviews.runWithdrawalRechecks()).toEqual({ accounts: 1, purged: 1 });
    expect(store.rechecks.size).toBe(0);
    expect(await reviews.oldestOverdueRecheckMs()).toBe(0);

    // 묶음 크기를 주면 그만큼만
    for (const id of accounts.slice(0, 9)) await reviews.purgeWithdrawn({ accountId: id, withdrawnAt: '2026-11-16T02:30:00.000Z' });
    expect(await reviews.runWithdrawalRechecks(7)).toEqual({ accounts: 7, purged: 0 });
    expect(await reviews.runWithdrawalRechecks(7)).toEqual({ accounts: 2, purged: 0 });
  });

  test('I-T83 ⑤ 밀린 시간은 예약 시각 정각에 0이고 1ms 뒤부터 센다', async () => {
    const { clock, reviews } = setup('2026-11-16T03:03:00.000Z');
    expect(await reviews.oldestOverdueRecheckMs()).toBe(0);
    // 03:03 처리, 탈퇴 03:00 → 예약 03:16(아직 때가 아니다)
    await reviews.purgeWithdrawn({ accountId: A, withdrawnAt: '2026-11-16T03:00:00.000Z' });
    expect(await reviews.oldestOverdueRecheckMs()).toBe(0);
    clock.advance(at('2026-11-16T03:16:00.000Z') - clock.now());
    expect(await reviews.oldestOverdueRecheckMs()).toBe(0);
    clock.advance(1);
    expect(await reviews.oldestOverdueRecheckMs()).toBe(1);
  });
});

describe('I-T83 다시 정리 반복', () => {
  test('I-T83 ⑤ 반복은 밀린 것을 비울 때까지 돌고 실패해도 멈추지 않으며 밀린 시간을 낸다', async () => {
    const calls: (number | undefined)[] = [];
    const answers: (() => Promise<{ accounts: number; purged: number }>)[] = [
      async () => ({ accounts: 100, purged: 140 }),
      async () => ({ accounts: 37, purged: 41 }),
      async () => {
        // Drizzle 쿼리 오류는 메시지에 매개변수 값(계정 ID)을 싣는다. 경고에 실리면 안 된다
        throw new DrizzleQueryError(
          'select account_id from review_withdrawal_recheck where due_at <= $1 order by due_at limit $2 for update skip locked',
          [A, 100],
          Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }),
        );
      },
    ];
    const reviews = {
      runWithdrawalRechecks: async (limit?: number) => {
        calls.push(limit);
        const next = answers[calls.length - 1];
        return next ? next() : { accounts: 0, purged: 0 };
      },
      oldestOverdueRecheckMs: async () => 90_500,
    };
    const s = fakeSleep();
    const warns: [object, string | undefined][] = [];
    const registry = new PlatformMetrics('core-svc').registry;
    const loop = startReviewRecheckLoop({ reviews, registry, logger: { warn: (o, msg) => void warns.push([o, msg]) }, sleep: s.sleep });
    try {
      // 첫 번은 100개(기본 묶음 크기)를 채워 쉬지 않고 곧바로 다시, 둘째는 37개라 다음 간격(60초)을 쉰다
      await until(() => calls.length === 2 && s.waits().length === 1, '두 번 돌고 한 번 쉼');
      expect(calls).toEqual([100, 100]);
      expect(s.waits()).toEqual([60_000]);
      expect(warns).toEqual([]);
      // 밀린 시간 지표 = 90,500ms / 1000 = 90.5초
      await until(async () => (await overdueSeconds(registry)) === 90.5, '밀린 시간 지표 90.5');

      // 셋째가 실패하면 경고 한 줄 뒤 다음 간격에 다시 한다
      s.wake();
      await until(() => calls.length === 3 && s.waits().length === 2, '실패 뒤 쉼');
      expect(warns).toHaveLength(1);
      for (const secret of [A, A.toUpperCase()]) expect(JSON.stringify(warns)).not.toContain(secret);
      expect(s.waits()).toEqual([60_000, 60_000]);
      s.wake();
      await until(() => calls.length === 4 && s.waits().length === 3, '실패 뒤 다시 돎');
      expect(warns).toHaveLength(1);
    } finally {
      await loop.stop();
    }
    // stop() 뒤에는 더 부르지 않는다
    const n = calls.length;
    s.wake();
    await pause(30);
    expect(calls.length).toBe(n);
  });

  test('I-T83 ⑤ 반복은 받은 간격·묶음 크기를 쓰고 stop은 돌던 한 번이 끝난 뒤에 풀린다', async () => {
    const calls: (number | undefined)[] = [];
    const gate: { release?: () => void } = {};
    const answers: (() => Promise<{ accounts: number; purged: number }>)[] = [
      async () => ({ accounts: 7, purged: 9 }),
      async () => ({ accounts: 6, purged: 6 }),
      () =>
        new Promise((resolve) => {
          gate.release = () => resolve({ accounts: 0, purged: 0 });
        }),
    ];
    const reviews = {
      runWithdrawalRechecks: async (limit?: number) => {
        calls.push(limit);
        const next = answers[calls.length - 1];
        return next ? next() : { accounts: 0, purged: 0 };
      },
      oldestOverdueRecheckMs: async () => 0,
    };
    const s = fakeSleep();
    const loop = startReviewRecheckLoop({ reviews, everyMs: 1_234, limit: 7, sleep: s.sleep, logger: { warn: () => undefined } });
    const state = { stopped: false };
    try {
      await until(() => calls.length === 2 && s.waits().length === 1, '두 번 돌고 한 번 쉼');
      expect(calls).toEqual([7, 7]);
      expect(s.waits()).toEqual([1_234]);
      // 셋째 한 번이 도는 동안 stop을 부른다
      s.wake();
      await until(() => calls.length === 3 && gate.release !== undefined, '셋째 시작');
      const stopping = loop.stop().then(() => {
        state.stopped = true;
      });
      await pause(30);
      expect(state.stopped).toBe(false);
      gate.release?.();
      await stopping;
      expect(state.stopped).toBe(true);
    } finally {
      gate.release?.();
      if (!state.stopped) await loop.stop();
    }
    await pause(30);
    expect(calls).toHaveLength(3);
  });
});

/** 지표 한 줄의 값(이름과 칸이 모두 맞는 줄). 지표나 줄이 없으면 undefined */
async function metricValue(registry: Registry, name: string, labels: Record<string, string>): Promise<number | undefined> {
  let text: string;
  try {
    text = await registry.getSingleMetricAsString(name);
  } catch {
    return undefined;
  }
  const line = text
    .split('\n')
    .find((l) => (l.startsWith(`${name}{`) || l.startsWith(`${name} `)) && Object.entries(labels).every(([k, v]) => l.includes(`${k}="${v}"`)));
  return line === undefined ? undefined : Number(line.slice(line.lastIndexOf(' ') + 1));
}

describe('I-T83 다시 정리 반복의 실패 지표(리뷰 A1)', () => {
  /** 정본 값: 밀린 시간 경보 5일 [가정], 마지막 성공 경보 30분 [가정](docs/observability.md 운영 확인 '탈퇴 후기 다시 정리' 행) */
  const FIVE_DAYS_MS = 5 * 86_400_000;
  const THIRTY_MIN_MS = 30 * MIN;
  const FAILURES = 'review_withdrawal_recheck_failures_total';
  const LAST_SUCCESS = 'review_withdrawal_recheck_last_success_timestamp_seconds';
  const OVERDUE = 'maintenance_retention_overdue_seconds';
  const UUID_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  test('I-T83 ⑤ 반복이 실패해도 밀린 시간 지표를 새 값으로 고치고 실패 수를 센다', async () => {
    const T = 1_794_000_000_000;
    const clock = fakeClock({ now: T });
    let runs = 0;
    // 한 번마다: 성공 → 실패(밀린 시간 정확히 5일) → 실패(5일 + 1ms) → 실패(밀린 시간 읽기도 실패) → 성공(밀린 시간 0)
    const reviews = {
      runWithdrawalRechecks: async () => {
        runs += 1;
        if (runs === 1) return { accounts: 3, purged: 4 };
        if (runs === 2) throw new DrizzleQueryError('select account_id from review_withdrawal_recheck where due_at <= $1 order by due_at limit $2 for update skip locked', [A, 7], Object.assign(new Error('permission denied for table review_withdrawal_recheck'), { code: '42501' }));
        if (runs === 3) throw new Error('canceling statement due to statement timeout');
        if (runs === 4) throw new Error('Connection terminated unexpectedly');
        return { accounts: 0, purged: 0 };
      },
      oldestOverdueRecheckMs: async () => {
        if (runs === 2) return FIVE_DAYS_MS;
        if (runs === 3) return FIVE_DAYS_MS + 1;
        if (runs === 4) throw new Error('Connection terminated unexpectedly');
        return 0;
      },
    };
    const s = fakeSleep();
    const warns: [object, string | undefined][] = [];
    const registry = new PlatformMetrics('core-svc').registry;
    const overdue = () => metricValue(registry, OVERDUE, { service: 'core-svc', table: 'review_withdrawal_recheck' });
    const failures = async () => (await metricValue(registry, FAILURES, { service: 'core-svc' })) ?? 0;
    const lastSuccess = () => metricValue(registry, LAST_SUCCESS, { service: 'core-svc' });
    // 간격·묶음 크기는 상수(60초·100개)와 다르게
    const loop = startReviewRecheckLoop({ reviews, registry, clock, everyMs: 1_234, limit: 7, sleep: s.sleep, logger: { warn: (o, msg) => void warns.push([o, msg]) } });
    try {
      // 1번째(성공): 밀린 시간 0, 마지막 성공 = 가짜 시계(초), 실패 0
      await until(() => runs === 1 && s.waits().length === 1, '첫 번째 돎');
      expect(await overdue()).toBe(0);
      expect(await lastSuccess()).toBe(1_794_000_000);
      expect(await failures()).toBe(0);
      expect(warns).toEqual([]);

      // 2번째(실패): 마지막 성공에서 30분 − 1ms 뒤(경보 경계 직전). 밀린 시간은 실패해도 새 값(정확히 5일 = 432,000초)
      clock.advance(THIRTY_MIN_MS - 1);
      s.wake();
      await until(() => runs === 2 && s.waits().length === 2, '두 번째 돎');
      expect(await overdue()).toBe(FIVE_DAYS_MS / 1000);
      expect(await failures()).toBe(1);
      expect(await lastSuccess()).toBe(1_794_000_000);

      // 3번째(실패): 30분 + 1ms 뒤(경보 경계 직후). 밀린 시간 5일 + 1ms(경보 경계 직후), 마지막 성공은 그대로
      clock.advance(2);
      s.wake();
      await until(() => runs === 3 && s.waits().length === 3, '세 번째 돎');
      expect(await overdue()).toBe((FIVE_DAYS_MS + 1) / 1000);
      expect(await failures()).toBe(2);
      expect(await lastSuccess()).toBe(1_794_000_000);

      // 4번째(실패, 밀린 시간 읽기도 실패): 밀린 시간은 그대로, 실패 수는 는다. 반복은 멈추지 않는다
      s.wake();
      await until(() => runs === 4 && s.waits().length === 4, '네 번째 돎');
      expect(await overdue()).toBe((FIVE_DAYS_MS + 1) / 1000);
      expect(await failures()).toBe(3);
      expect(await lastSuccess()).toBe(1_794_000_000);

      // 5번째(성공): 시작에서 31분 뒤. 밀린 시간 0, 마지막 성공을 그때로 고치고 실패 수는 그대로
      clock.advance(T + 31 * MIN - clock.now());
      s.wake();
      await until(() => runs === 5 && s.waits().length === 5, '다섯 번째 돎');
      expect(await overdue()).toBe(0);
      expect(await lastSuccess()).toBe(1_794_001_860);
      expect(await failures()).toBe(3);

      // 실패한 한 번마다 경고 한 줄, 글에 계정 ID 모양(UUID) 글자가 없다
      expect(warns).toHaveLength(3);
      expect(JSON.stringify(warns)).not.toMatch(UUID_LIKE);
    } finally {
      await loop.stop();
    }
  });

  test('I-T83 ⑤ 같은 등록부에 반복을 두 번 켜도 지표를 새로 만들다 실패하지 않는다', async () => {
    const registry = new PlatformMetrics('core-svc').registry;
    const reviews = { runWithdrawalRechecks: async () => ({ accounts: 0, purged: 0 }), oldestOverdueRecheckMs: async () => 0 };
    const s1 = fakeSleep();
    const s2 = fakeSleep();
    const loops: { stop(): Promise<void> }[] = [];
    try {
      loops.push(startReviewRecheckLoop({ reviews, registry, clock: fakeClock({ now: 1_794_000_000_000 }), sleep: s1.sleep, logger: { warn: () => undefined } }));
      loops.push(startReviewRecheckLoop({ reviews, registry, clock: fakeClock({ now: 1_794_000_000_000 }), sleep: s2.sleep, logger: { warn: () => undefined } }));
      await until(() => s1.waits().length === 1 && s2.waits().length === 1, '두 반복이 한 번씩 돎');
      const names = (await registry.getMetricsAsJSON()).map((m) => m.name);
      for (const name of [OVERDUE, FAILURES, LAST_SUCCESS]) expect(names.filter((n) => n === name), name).toHaveLength(1);
    } finally {
      for (const l of loops) await l.stop();
    }
  });
});
