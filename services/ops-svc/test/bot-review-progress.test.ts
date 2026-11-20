// 봇 표본 검토 진행·중간 결과(BAT-197 BOT-080, FR-049, d5 §7.15, 계획 G4·G5).
// 중간 결과는 UNDECIDED를 뺀 BOT ÷ (HUMAN + BOT)의 Wilson 95% 구간이고, 0건이면 null이다.
// 기한은 배치에 저장한 오픈+30일(행동 신호 삭제)·오픈+7일(R2)이며, 정확히 30일인 순간은 아직 열려 있고 1ms 뒤부터 410이다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { GetBotReview } from '../src/modules/bot-review/application/get-review.js';
import { ListBotReviewSamples } from '../src/modules/bot-review/application/list-samples.js';
import { MemoryBotReviewStore } from '../src/modules/bot-review/adapters/memory-bot-review-store.js';
import { FixtureBotReviewSource } from '../src/modules/bot-review/adapters/fixture-bot-review-source.js';
import {
  deadlinesFrom,
  DEFAULT_REVIEW_KIND,
  HUMAN_BASELINE_TARGET,
  interimOf,
  PASSED_SAMPLE_TARGET,
  parseReviewKind,
  progressView,
  remainingCount,
  REVIEW_R2_DUE_MS,
  REVIEW_RETENTION_MS,
  targetOf,
  wilsonInterval,
  type BotReviewBatch,
  type BotReviewSample,
} from '../src/modules/bot-review/domain/bot-review.js';

const NOW = Date.parse('2026-11-21T04:00:00.000Z');
const DAY = 86_400_000;
const EVENT = '0194b197-0000-7000-8000-0000000000a1';

describe('FR-049 중간 결과(Wilson 95%)', () => {
  test('FR-049 중간 결과는 UNDECIDED를 뺀 BOT 비율의 Wilson 95% 구간이고 0건이면 null이다', () => {
    // 4/10의 Wilson 95% 구간(정본 식을 시험이 따로 계산한 값)
    const ten = wilsonInterval(4, 10);
    expect(ten.low).toBeCloseTo(0.16818032970623614, 12);
    expect(ten.high).toBeCloseTo(0.6873262302663417, 12);
    expect(wilsonInterval(5, 10).low).toBeCloseTo(0.236593090512564, 12);
    expect(wilsonInterval(5, 10).high).toBeCloseTo(0.7634069094874361, 12);
    expect(wilsonInterval(0, 10).low).toBe(0);
    expect(wilsonInterval(0, 10).high).toBeCloseTo(0.2775327998628892, 12);
    expect(wilsonInterval(10, 10).low).toBeCloseTo(0.7224672001371107, 12);
    expect(wilsonInterval(10, 10).high).toBeCloseTo(1, 12);

    // UNDECIDED 5건은 분모에서 빠진다: 4 ÷ (6 + 4)
    const interim = interimOf({ human: 6, bot: 4, undecided: 5 });
    expect(interim?.missedBotRate).toBe(0.4);
    expect(interim?.ci95Low).toBeCloseTo(ten.low, 12);
    expect(interim?.ci95High).toBeCloseTo(ten.high, 12);
    // 판정이 0건이거나 UNDECIDED만 있으면 null이다(0%로 작게 보이지 않는다)
    expect(interimOf({ human: 0, bot: 0, undecided: 0 })).toBeNull();
    expect(interimOf({ human: 0, bot: 0, undecided: 7 })).toBeNull();
    // 모두 BOT·모두 HUMAN 경계
    expect(interimOf({ human: 0, bot: 10, undecided: 2 })).toMatchObject({ missedBotRate: 1 });
    expect(interimOf({ human: 10, bot: 0, undecided: 2 })).toMatchObject({ missedBotRate: 0 });
    // 창 밖 값은 부르지 않는다
    for (const [s, n] of [[-1, 10], [11, 10], [1.5, 10], [1, 0], [1, 2.5]] as const) expect(() => wilsonInterval(s, n), `${s}/${n}`).toThrow(RangeError);
  });
});

describe('FR-049 진행과 기한', () => {
  const batch = (o: Partial<BotReviewBatch> = {}): BotReviewBatch => ({
    batchId: randomUUID(),
    eventId: EVENT,
    reviewKind: 'PASSED_SAMPLE',
    seed: 'seed',
    targetCount: PASSED_SAMPLE_TARGET,
    populationCount: 240,
    retentionUntilMs: NOW + 30 * DAY,
    r2DueAtMs: NOW + 7 * DAY,
    createdAtMs: NOW,
    ...o,
  });

  test('FR-049 기한은 오픈+30일·R2 오픈+7일이고 진행 수는 판정 셋을 모두 센다', () => {
    const open = Date.parse('2026-10-22T09:00:00.000Z');
    const d = deadlinesFrom(open);
    expect(d.retentionUntilMs - open).toBe(30 * DAY);
    expect(d.r2DueAtMs - open).toBe(7 * DAY);
    expect(REVIEW_RETENTION_MS).toBe(30 * DAY);
    expect(REVIEW_R2_DUE_MS).toBe(7 * DAY);
    expect(() => deadlinesFrom(0)).toThrow(RangeError);

    const view = progressView(batch(), { human: 6, bot: 4, undecided: 5 });
    expect(view).toMatchObject({ eventId: EVENT, reviewKind: 'PASSED_SAMPLE', reviewedCount: 15, targetCount: 200 });
    expect(view.deadlineAt).toBe(new Date(NOW + 30 * DAY).toISOString());
    expect(view.r2DueAt).toBe(new Date(NOW + 7 * DAY).toISOString());
    expect(view.interim).toMatchObject({ missedBotRate: 0.4 });
    expect(remainingCount(view)).toBe(185);
    // 목표를 넘겨도 남은 수는 음수가 아니다
    expect(remainingCount(progressView(batch({ targetCount: 3 }), { human: 3, bot: 3, undecided: 3 }))).toBe(0);
  });

  test('FR-049 HUMAN_BASELINE은 두 묶음 합 400건만 보이고 중간 결과(interim)는 null이다', () => {
    const human = progressView(batch({ reviewKind: 'HUMAN_BASELINE', targetCount: HUMAN_BASELINE_TARGET }), { human: 30, bot: 10, undecided: 2 });
    expect(human).toMatchObject({ reviewKind: 'HUMAN_BASELINE', reviewedCount: 42, targetCount: 400, interim: null });
    expect(human).not.toHaveProperty('passedCount');
    expect(targetOf('PASSED_SAMPLE')).toBe(200);
    expect(targetOf('HUMAN_BASELINE')).toBe(400);
  });

  test('FR-049 reviewKind는 없으면 기본 PASSED_SAMPLE이고 모르는 값은 400이다', () => {
    expect(parseReviewKind(undefined)).toBe(DEFAULT_REVIEW_KIND);
    expect(parseReviewKind(null)).toBe(DEFAULT_REVIEW_KIND);
    expect(parseReviewKind('')).toBe(DEFAULT_REVIEW_KIND);
    expect(parseReviewKind('PASSED_SAMPLE')).toBe('PASSED_SAMPLE');
    expect(parseReviewKind('HUMAN_BASELINE')).toBe('HUMAN_BASELINE');
    for (const bad of ['human_baseline', 'PASSED', 'ALL', ' HUMAN_BASELINE']) {
      expect(() => parseReviewKind(bad), bad).toThrow(/reviewKind/);
    }
  });

  test('FR-049 30일 경계 당일은 200이고 1ms 뒤는 진행·목록이 410이다', async () => {
    const run = async (now: number) => {
      const store = new MemoryBotReviewStore();
      const b = batch({ batchId: randomUUID(), retentionUntilMs: NOW + 30 * DAY });
      const sample: BotReviewSample = {
        sampleId: randomUUID(),
        batchId: b.batchId,
        sessionRef: 'sess-1',
        verdictEventKey: randomUUID(),
        status: 'PENDING',
        riskBand: 'HIGH',
        behaviorSummaryBand: 'ENTRY_FAST',
        timeline: [],
        evidenceAvailable: [],
        ordinal: 0,
        createdAtMs: NOW,
        reviewBatch: 'PASSED',
        appliedVerdict: 'ALLOW',
      };
      await store.insertBatch(b, [sample]);
      const source = new FixtureBotReviewSource([]);
      const getReview = new GetBotReview(store, source, () => now);
      const list = new ListBotReviewSamples(store, () => now);
      return {
        progress: await getReview.run({ eventId: EVENT, reviewKind: 'PASSED_SAMPLE' }).then(
          (v) => ({ ok: true as const, v }),
          (e: { status?: number }) => ({ ok: false as const, status: e.status }),
        ),
        samples: await list.run({ eventId: EVENT, reviewKind: 'PASSED_SAMPLE' }).then(
          (v) => ({ ok: true as const, v }),
          (e: { status?: number }) => ({ ok: false as const, status: e.status }),
        ),
      };
    };
    const exact = await run(NOW + 30 * DAY);
    expect(exact.progress.ok).toBe(true);
    expect(exact.samples.ok).toBe(true);
    const late = await run(NOW + 30 * DAY + 1);
    expect(late.progress).toEqual({ ok: false, status: 410 });
    expect(late.samples).toEqual({ ok: false, status: 410 });
    // fakeClock은 앞으로만 가므로 경계 밖 값은 위처럼 시계를 따로 만든다
    const tick = fakeClock({ now: NOW + 30 * DAY });
    expect(tick.now()).toBe(NOW + 30 * DAY);
  });
});
