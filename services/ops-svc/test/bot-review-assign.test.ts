// 표본 배정(BAT-197 BOT-080, FR-049, bot-defense §13 424, 계획 G2).
// 후보 원장에서 PASSED_SAMPLE은 통과 200건, HUMAN_BASELINE은 통과 200 + 그림자 추가 검증 200을 뽑아 한 줄로 섞는다.
// 묶음 전체가 200건 이하면 전수하고, 같은 회차·종류에 두 번 돌려도 배치 하나다. 씨앗값·모집단 수·기한을 배치에 남긴다.
import { describe, expect, test } from 'vitest';
import { MemoryBotReviewStore } from '../src/modules/bot-review/adapters/memory-bot-review-store.js';
import { FixtureBotReviewSource } from '../src/modules/bot-review/adapters/fixture-bot-review-source.js';
import { AssignBotReviewSamples } from '../src/modules/bot-review/application/assign-samples.js';
import { seededShuffle, type ReviewBatch } from '../src/modules/bot-review/domain/bot-review.js';
import type { BotReviewCandidate } from '../src/modules/bot-review/domain/ports.js';

const NOW = Date.parse('2026-11-21T06:00:00.000Z');
const DAY = 86_400_000;
const EVENT = '0194b197-0000-7000-8000-0000000000c1';
const id = (n: number) => `0194b197-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const candidate = (n: number, bundle: ReviewBatch, openAtMs = NOW): BotReviewCandidate => ({
  sessionRef: `sess-${bundle}-${n}`,
  verdictEventKey: id(0x1000 + n + (bundle === 'PASSED' ? 0 : 0x2000)),
  pid: `pid-${n}`,
  reviewBatch: bundle,
  appliedVerdict: bundle === 'PASSED' ? 'ALLOW' : 'CHALLENGE',
  riskBand: 'HIGH',
  behaviorSummaryBand: bundle === 'PASSED' ? 'ENTRY_FAST' : null,
  timeline: [{ step: 'ENTRY', atMs: openAtMs }],
  evidenceAvailable: [],
  occurredAtMs: openAtMs,
  openAtMs,
});

const rows = (passed: number, shadow: number, openAtMs = NOW): BotReviewCandidate[] => [
  ...Array.from({ length: passed }, (_, i) => candidate(i, 'PASSED', openAtMs)),
  ...Array.from({ length: shadow }, (_, i) => candidate(i, 'SHADOW_CHALLENGED', openAtMs)),
];

function assigner(sourceRows: BotReviewCandidate[], seed = 'seed-assign') {
  const store = new MemoryBotReviewStore();
  const source = new FixtureBotReviewSource(sourceRows);
  const assign = new AssignBotReviewSamples({ store, source, now: () => NOW, newSeed: () => seed });
  return { store, assign };
}

describe('FR-049 표본 배정', () => {
  test('FR-049 한 회차·종류에 200+200을 뽑아 섞고 전체가 작으면 전수하며 두 번 돌려도 하나다', async () => {
    const { store, assign } = assigner(rows(250, 250));
    const human = await assign.run({ eventId: EVENT, reviewKind: 'HUMAN_BASELINE' });
    expect(human).toMatchObject({ created: true, sampleCount: 400, populationCount: 500 });
    const batch = await store.findBatch(EVENT, 'HUMAN_BASELINE');
    expect(batch).toMatchObject({ seed: 'seed-assign', targetCount: 400, populationCount: 500 });
    const page = await store.listSamples({ batchId: human.batchId!, limit: 400 });
    expect(page.items).toHaveLength(400);
    expect(new Set(page.items.map((s) => s.ordinal)).size).toBe(400);
    expect([...page.items.map((s) => s.ordinal)].sort((a, b) => a - b)).toEqual(Array.from({ length: 400 }, (_, i) => i));
    // 두 묶음이 앞뒤로 붙지 않고 한 줄로 섞인다: 앞 반쪽에 두 묶음이 다 있고, 뒤 반쪽에도 다 있다
    const front = new Set(page.items.slice(0, 200).map((s) => s.reviewBatch));
    const back = new Set(page.items.slice(200).map((s) => s.reviewBatch));
    expect(front).toEqual(new Set(['PASSED', 'SHADOW_CHALLENGED']));
    expect(back).toEqual(new Set(['PASSED', 'SHADOW_CHALLENGED']));
    // 같은 회차·종류에 두 번 돌려도 배치 하나이고 카드도 늘지 않는다
    const again = await assign.run({ eventId: EVENT, reviewKind: 'HUMAN_BASELINE' });
    expect(again).toEqual({ batchId: human.batchId, created: false, sampleCount: 400, populationCount: 500 });
    expect((await store.listSamples({ batchId: human.batchId!, limit: 500 })).items).toHaveLength(400);
    // 통과 세션 표본은 통과 묶음만, 200건 상한이다
    const passed = assigner(rows(250, 50));
    expect(await passed.assign.run({ eventId: EVENT, reviewKind: 'PASSED_SAMPLE' })).toMatchObject({ created: true, sampleCount: 200, populationCount: 250 });
    const passedPage = await passed.store.listSamples({ batchId: (await passed.store.findBatch(EVENT, 'PASSED_SAMPLE'))!.batchId, limit: 300 });
    expect(passedPage.items).toHaveLength(200);
    expect(new Set(passedPage.items.map((s) => s.reviewBatch))).toEqual(new Set(['PASSED']));
    expect(new Set(passedPage.items.map((s) => s.appliedVerdict))).toEqual(new Set(['ALLOW']));
  });

  test('FR-049 묶음 전체가 200건 이하면 전수하고 후보가 없으면 배치를 만들지 않는다', async () => {
    const small = assigner(rows(120, 80));
    expect(await small.assign.run({ eventId: EVENT, reviewKind: 'PASSED_SAMPLE' })).toMatchObject({ created: true, sampleCount: 120, populationCount: 120 });
    const human = assigner(rows(199, 1));
    expect(await human.assign.run({ eventId: EVENT, reviewKind: 'HUMAN_BASELINE' })).toMatchObject({ created: true, sampleCount: 200, populationCount: 200 });
    const exact = assigner(rows(200, 0));
    expect(await exact.assign.run({ eventId: EVENT, reviewKind: 'PASSED_SAMPLE' })).toMatchObject({ created: true, sampleCount: 200 });
    const none = assigner([]);
    expect(await none.assign.run({ eventId: EVENT, reviewKind: 'PASSED_SAMPLE' })).toEqual({ batchId: null, created: false, sampleCount: 0, populationCount: 0 });
    expect(await none.store.findBatch(EVENT, 'PASSED_SAMPLE')).toBeUndefined();
    // HUMAN_BASELINE은 두 묶음 가운데 하나만 있어도 그 묶음만 전수한다
    const onlyShadow = assigner(rows(0, 3));
    expect(await onlyShadow.assign.run({ eventId: EVENT, reviewKind: 'HUMAN_BASELINE' })).toMatchObject({ created: true, sampleCount: 3, populationCount: 3 });
  });

  test('FR-049 배치는 가장 이른 오픈 시각에서 30일·7일을 만들고 씨앗값으로 순서를 남긴다', async () => {
    const open = NOW - 3 * DAY;
    const { store, assign } = assigner([candidate(1, 'PASSED', open), candidate(2, 'PASSED', NOW + DAY)], 'seed-deadline');
    const out = await assign.run({ eventId: EVENT, reviewKind: 'PASSED_SAMPLE' });
    const batch = await store.findBatch(EVENT, 'PASSED_SAMPLE');
    expect(batch).toMatchObject({ retentionUntilMs: open + 30 * DAY, r2DueAtMs: open + 7 * DAY, populationCount: 2, targetCount: 2, seed: 'seed-deadline' });
    expect(out.batchId).toBe(batch!.batchId);
    // 다른 씨앗이면 순서가 달라지고, 같은 씨앗이면 같다
    const same = seededShuffle(Array.from({ length: 20 }, (_, i) => i), 'a');
    expect(seededShuffle(Array.from({ length: 20 }, (_, i) => i), 'a')).toEqual(same);
    expect(seededShuffle(Array.from({ length: 20 }, (_, i) => i), 'b')).not.toEqual(same);
    expect([...same].sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    const input = [1, 2, 3];
    seededShuffle(input, 'x');
    expect(input).toEqual([1, 2, 3]);
  });

  test('FR-049 배정 두 요청이 겹쳐도 배치 하나이고 나머지는 그 배치를 돌려준다', async () => {
    const { store, assign } = assigner(rows(5, 0));
    const [a, b] = await Promise.all([
      assign.run({ eventId: EVENT, reviewKind: 'PASSED_SAMPLE' }),
      assign.run({ eventId: EVENT, reviewKind: 'PASSED_SAMPLE' }),
    ]);
    expect(a.batchId).toEqual(expect.any(String));
    expect(b.batchId).toBe(a.batchId);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect((await store.listSamples({ batchId: a.batchId!, limit: 10 })).items).toHaveLength(5);
    // 회차 ID가 UUID가 아니면 404다
    await expect(assign.run({ eventId: 'ev-1', reviewKind: 'PASSED_SAMPLE' })).rejects.toMatchObject({ status: 404 });
  });
});
