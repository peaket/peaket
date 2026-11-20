// 표본 판정 → trust-svc ApplyLabel의 실제 gRPC·Valkey 통합 시험(BAT-197 BOT-080, FR-049, B15, B-T27).
// 실제 PostgreSQL의 표본·판정 행, trust-svc의 실제 TrustLabelService(gRPC)와 실제 Valkey의 차단 키·라벨 기록을 함께 본다.
// 표본 검토 BOT은 판정 근거의 기기에 차단 키를 올리고, HUMAN은 지운다. UNDECIDED는 gRPC를 부르지 않는다.
// ApplyLabel이 거절하면 판정 행을 쓰지 않고 503 bot-review-label-unavailable이다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createDatabase, createService, fakeClock, type Database } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { DrizzleBotReviewStore } from '../src/modules/bot-review/adapters/db/drizzle-bot-review-store.js';
import { FixtureBotReviewSource } from '../src/modules/bot-review/adapters/fixture-bot-review-source.js';
import { GrpcTrustLabels } from '../src/modules/bot-review/adapters/grpc-trust-labels.js';
import type { BotReviewBatch, BotReviewCandidate, BotReviewSample, BotReviewSignals } from '../src/modules/bot-review/index.js';
import { dev, devicesV1, labelWorld, type LabelWorld } from '../../trust-svc/test-int/label-world.js';
import { keys } from '../../trust-svc/src/modules/scoring/adapters/redis-feature-store.js';
import { startValkey, type ValkeyContainer } from '../../queue-svc/test-int/valkey.js';
import { FakeIdentity, quiet } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = Date.parse('2026-11-21T08:00:00.000Z');
const DAY = 86_400_000;
const EVENT = '0194b197-0000-7000-8000-0000000000e1';
const id = (n: number) => `0194b197-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const ref = (name: string) => devicesV1.ref(dev(name))!;

class RecordingSignals implements BotReviewSignals {
  readonly judgements: { verdict: string; label: string }[] = [];
  readonly failures: string[] = [];
  judgement(verdict: string, label: string): void {
    this.judgements.push({ verdict, label });
  }
  labelFailure(reason: string): void {
    this.failures.push(reason);
  }
}

const identity = new FakeIdentity();
const clock = fakeClock({ now: NOW });
const signals = new RecordingSignals();
let container: PostgresContainer | undefined;
let valkey: ValkeyContainer | undefined;
let db: Database;
let adminDb: pg.Client;
let svc: Awaited<ReturnType<typeof createService>>;
let w: LabelWorld;
let store: DrizzleBotReviewStore;
let trustLabels: GrpcTrustLabels | undefined;
let samples: BotReviewSample[];
let keysOf: { k1: string; k2: string };
const candidates: BotReviewCandidate[] = [];

const batchOf = (o: Partial<BotReviewBatch> = {}): BotReviewBatch => ({
  batchId: id(1),
  eventId: EVENT,
  reviewKind: 'HUMAN_BASELINE',
  seed: 'seed-label',
  targetCount: 4,
  populationCount: 4,
  retentionUntilMs: NOW + 30 * DAY,
  r2DueAtMs: NOW + 7 * DAY,
  createdAtMs: NOW,
  ...o,
});

const sampleOf = (batch: BotReviewBatch, ordinal: number, pid: string, eventKey: string, o: Partial<BotReviewSample> = {}): BotReviewSample => ({
  sampleId: id(0xe01 + ordinal),
  batchId: batch.batchId,
  sessionRef: `sess-${ordinal}`,
  verdictEventKey: eventKey,
  status: 'PENDING',
  riskBand: null,
  behaviorSummaryBand: null,
  timeline: [],
  evidenceAvailable: ['CONFIRMED_SIGNAL'],
  ordinal,
  createdAtMs: NOW,
  reviewBatch: 'SHADOW_CHALLENGED',
  appliedVerdict: 'CHALLENGE',
  ...o,
});

beforeAll(async () => {
  container = await startPostgres();
  await migrateOps(container.url);
  valkey = await startValkey();
  db = createDatabase({ url: container.url, applicationName: 'ops-svc-bot-review-label-it' });
  adminDb = new pg.Client({ connectionString: container.url });
  await adminDb.connect();
  store = new DrizzleBotReviewStore(db, clock);

  w = await labelWorld(valkey.url);
  // 판정 근거 키를 실제 ScoreRisk로 만든다: 사람 확인 실패 → CHALLENGE
  w.human.set('FAILED');
  const a = await w.scoreRisk({ pid: 'pid-a', device_id: dev('a'), event_id: EVENT });
  const c = await w.scoreRisk({ pid: 'pid-c', device_id: dev('a'), event_id: EVENT });
  w.human.set('PASSED');
  expect(a.eventKey).toMatch(/^[0-9a-f-]{36}$/);
  expect(c.eventKey).toMatch(/^[0-9a-f-]{36}$/);
  keysOf = { k1: a.eventKey, k2: c.eventKey };

  const batch = batchOf({ targetCount: 5 });
  samples = [
    sampleOf(batch, 0, 'pid-a', keysOf.k1),
    sampleOf(batch, 1, 'pid-c', keysOf.k2),
    sampleOf(batch, 2, 'pid-u', id(0xee1)),
    sampleOf(batch, 3, 'pid-bad', id(0xee2), { reviewBatch: 'PASSED', appliedVerdict: 'CHALLENGE' }),
    sampleOf(batch, 4, 'pid-r', id(0xee3), { reviewBatch: 'PASSED', appliedVerdict: 'ALLOW' }),
  ];
  await store.insertBatch(batch, samples);
  const pids = ['pid-a', 'pid-c', 'pid-u', 'pid-bad', 'pid-r'];
  for (const s of samples) {
    candidates.push({
      sessionRef: s.sessionRef,
      verdictEventKey: s.verdictEventKey,
      pid: pids[s.ordinal]!,
      reviewBatch: s.reviewBatch,
      appliedVerdict: s.appliedVerdict,
      riskBand: s.riskBand,
      behaviorSummaryBand: s.behaviorSummaryBand,
      timeline: s.timeline,
      evidenceAvailable: s.evidenceAvailable,
      occurredAtMs: NOW,
      openAtMs: NOW - 3_600_000,
    });
  }
  trustLabels = new GrpcTrustLabels({ address: w.target });
  svc = await createService({
    name: 'ops-svc-bot-review-label-it',
    module: AppModule.register({
      database: db,
      botReview: {
        source: new FixtureBotReviewSource(candidates),
        labels: trustLabels,
        signals,
      },
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close().catch(() => undefined);
  trustLabels?.close();
  await w?.close().catch(() => undefined);
  await adminDb?.end().catch(() => undefined);
  await db?.close().catch(() => undefined);
  valkey?.stop();
  container?.stop();
});

const AGENT = identity.ops('cs_agent');
const post = (sampleId: string, body: unknown, key = randomUUID()) =>
  svc.http.inject({ method: 'POST', url: `/v1/ops/bot-review-samples/${sampleId}/judgement`, headers: { ...AGENT, 'idempotency-key': key, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
const labelEvents = () => w.offered.filter((o) => String(o.value.category).startsWith('LABELED_'));
const blockOf = async (name: string) => {
  const raw = await w.cmd(['GET', keys.block(ref(name))]);
  return raw === null ? null : (JSON.parse(String(raw)) as Record<string, unknown>);
};
const judgementOf = async (sampleId: string) =>
  ((await adminDb.query('select verdict, label_result from bot_review_judgement where sample_id = $1', [sampleId])).rows as { verdict: string; label_result: string }[])[0];

describe('FR-049 표본 판정 → trust ApplyLabel(실제 gRPC·Valkey)', () => {
  test('FR-049 HUMAN·BOT은 SAMPLE_REVIEW·판 1·묶음·적용 판정·판정 사건 키로 ApplyLabel을 부른다', async () => {
    const before = labelEvents().length;
    const r = await post(samples[0]!.sampleId, { verdict: 'BOT', evidenceKinds: ['CONFIRMED_SIGNAL'] });
    expect(r.statusCode, r.payload).toBe(200);
    // 응답은 표본 ID·판정·기록 시각만 싣는다(차단 목록 변화·처리자·pid 없음)
    expect(json(r)).toEqual({ sampleId: samples[0]!.sampleId, verdict: 'BOT', recordedAt: new Date(NOW).toISOString() });
    // 실제 Valkey의 차단 키가 생기고 값에 표본 검토 출처·건 ID가 있다
    const block = await blockOf('a');
    expect(block).toEqual({ reason: 'SAMPLE_REVIEW', source: 'SAMPLE_REVIEW', caseId: samples[0]!.sampleId, listedAtMs: expect.any(Number) });
    const ttl = Number(await w.cmd(['PTTL', keys.block(ref('a'))]));
    expect(ttl).toBeGreaterThan(89 * DAY);
    expect(ttl).toBeLessThanOrEqual(90 * DAY);
    // 라벨 판정 기록은 SAMPLE_REVIEW·둘째 묶음·적용 판 CHALLENGE다
    const added = labelEvents().slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]!.value).toMatchObject({ category: 'LABELED_BOT', source: 'SAMPLE_REVIEW', reviewBatch: 'SHADOW_CHALLENGED', appliedVerdict: 'CHALLENGE', eventId: EVENT });
    expect(await judgementOf(samples[0]!.sampleId)).toEqual({ verdict: 'BOT', label_result: 'APPLIED' });
    expect(signals.judgements.at(-1)).toEqual({ verdict: 'BOT', label: 'APPLIED' });

    // HUMAN은 같은 기기(다른 사람·판정 사건)의 차단 키를 지운다
    const h = await post(samples[1]!.sampleId, { verdict: 'HUMAN' });
    expect(h.statusCode, h.payload).toBe(200);
    expect(await blockOf('a')).toBeNull();
    const humanLabels = labelEvents().slice(before + 1);
    expect(humanLabels[0]!.value).toMatchObject({ category: 'LABELED_HUMAN', source: 'SAMPLE_REVIEW', reviewBatch: 'SHADOW_CHALLENGED', appliedVerdict: 'CHALLENGE' });
    expect(await judgementOf(samples[1]!.sampleId)).toEqual({ verdict: 'HUMAN', label_result: 'APPLIED' });
  });

  test('FR-049 같은 Idempotency-Key 재시도는 같은 200이고 ApplyLabel을 다시 부르지 않는다', async () => {
    const key = randomUUID();
    const first = await post(samples[4]!.sampleId, { verdict: 'HUMAN' }, key);
    expect(first.statusCode, first.payload).toBe(200);
    const events = labelEvents().length;
    const again = await post(samples[4]!.sampleId, { verdict: 'HUMAN' }, key);
    expect(again.statusCode, again.payload).toBe(200);
    expect(json(again)).toEqual(json(first));
    expect(labelEvents().length).toBe(events);
  });

  test('FR-049 UNDECIDED는 ApplyLabel을 부르지 않아 차단 목록이 바뀌지 않는다', async () => {
    const blockBefore = await blockOf('a');
    const events = labelEvents().length;
    const r = await post(samples[2]!.sampleId, { verdict: 'UNDECIDED' });
    expect(r.statusCode, r.payload).toBe(200);
    expect(labelEvents().length).toBe(events);
    expect(await blockOf('a')).toEqual(blockBefore);
    expect(await judgementOf(samples[2]!.sampleId)).toEqual({ verdict: 'UNDECIDED', label_result: 'SKIPPED' });
  });

  test('FR-049 ApplyLabel이 실패하면 503이고 판정 행을 쓰지 않는다', async () => {
    // 첫째 묶음(PASSED)인데 적용 판이 CHALLENGE라 trust가 INVALID_ARGUMENT를 준다(계약 위반 표본)
    const events = labelEvents().length;
    const r = await post(samples[3]!.sampleId, { verdict: 'HUMAN' });
    expect(r.statusCode, r.payload).toBe(503);
    expect(String(json(r).type)).toMatch(/bot-review-label-unavailable/);
    expect(r.headers['retry-after']).toBe('1');
    expect(await judgementOf(samples[3]!.sampleId)).toBeUndefined();
    expect((await adminDb.query('select status from bot_review_sample where id = $1', [samples[3]!.sampleId])).rows).toEqual([{ status: 'PENDING' }]);
    expect(labelEvents().length).toBe(events);
    expect(signals.failures.at(-1)).toBe('invalid-argument');
  });
});
