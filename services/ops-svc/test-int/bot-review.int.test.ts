// 봇 표본 검토 표·REST의 PostgreSQL 18 통합 시험(BAT-197 BOT-080, FR-049, 계획 §8).
// 마이그레이션 0020의 표 셋에 실제로 쓰고, 카드·판정 행에 pid·기기 가명·IP·점수 원값·메모 칸이 없는지 정보 스키마까지 본다.
// 같은 표본 두 판정·같은 Idempotency-Key 재시도·HUMAN_BASELINE 근거 422·기한 지남 410을 실제 표와 실제 멱등 기록으로 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createDatabase, createService, fakeClock, type Database } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { DrizzleBotReviewStore } from '../src/modules/bot-review/adapters/db/drizzle-bot-review-store.js';
import { FixtureBotReviewSource } from '../src/modules/bot-review/adapters/fixture-bot-review-source.js';
import type { BotReviewBatch, BotReviewCandidate, BotReviewSample, ApplySampleLabelInput, TrustLabels } from '../src/modules/bot-review/index.js';
import type { AppliedSampleLabel } from '../src/modules/bot-review/domain/ports.js';
import { FakeIdentity, quiet } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = Date.parse('2026-11-21T07:00:00.000Z');
const DAY = 86_400_000;
const EVENT = '0194b197-0000-7000-8000-0000000000d1';
const EXPIRED_EVENT = '0194b197-0000-7000-8000-0000000000d2';
const id = (n: number) => `0194b197-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

class FakeLabels implements TrustLabels {
  readonly calls: ApplySampleLabelInput[] = [];
  async apply(input: ApplySampleLabelInput): Promise<AppliedSampleLabel> {
    this.calls.push(input);
    return { changed: true, blockList: 'ADDED' };
  }
}

const identity = new FakeIdentity();
const clock = fakeClock({ now: NOW });
const labels = new FakeLabels();
let container: PostgresContainer | undefined;
let db: Database;
let adminDb: pg.Client;
let svc: Awaited<ReturnType<typeof createService>>;
let store: DrizzleBotReviewStore;
const candidates: BotReviewCandidate[] = [];

const batchOf = (o: Partial<BotReviewBatch> = {}): BotReviewBatch => ({
  batchId: randomUUID(),
  eventId: EVENT,
  reviewKind: 'PASSED_SAMPLE',
  seed: 'seed-int',
  targetCount: 200,
  populationCount: 3,
  retentionUntilMs: NOW + 30 * DAY,
  r2DueAtMs: NOW + 7 * DAY,
  createdAtMs: NOW,
  ...o,
});

const sampleOf = (batch: BotReviewBatch, ordinal: number, o: Partial<BotReviewSample> = {}): BotReviewSample => ({
  sampleId: randomUUID(),
  batchId: batch.batchId,
  sessionRef: `sess-${ordinal}`,
  verdictEventKey: randomUUID(),
  status: 'PENDING',
  riskBand: 'HIGH',
  behaviorSummaryBand: 'ENTRY_FAST',
  timeline: [{ step: 'ENTRY', atMs: NOW - 2_000 }],
  evidenceAvailable: ['CONFIRMED_SIGNAL'],
  ordinal,
  createdAtMs: NOW,
  reviewBatch: 'PASSED',
  appliedVerdict: 'ALLOW',
  ...o,
});

let passedSamples: BotReviewSample[];
let humanSamples: BotReviewSample[];
let expiredSample: BotReviewSample;

beforeAll(async () => {
  container = await startPostgres();
  await migrateOps(container.url);
  db = createDatabase({ url: container.url, applicationName: 'ops-svc-bot-review-it' });
  adminDb = new pg.Client({ connectionString: container.url });
  await adminDb.connect();
  store = new DrizzleBotReviewStore(db, clock);
  const passed = batchOf({ batchId: id(1), targetCount: 200 });
  const human = batchOf({ batchId: id(2), reviewKind: 'HUMAN_BASELINE', targetCount: 400 });
  const expired = batchOf({ batchId: id(3), eventId: EXPIRED_EVENT, retentionUntilMs: NOW - 1, r2DueAtMs: NOW - 20 * DAY });
  passedSamples = [sampleOf(passed, 0), sampleOf(passed, 1), sampleOf(passed, 2)];
  humanSamples = [
    sampleOf(human, 0, { riskBand: 'HIGH', behaviorSummaryBand: 'ENTRY_FAST', reviewBatch: 'SHADOW_CHALLENGED', appliedVerdict: 'CHALLENGE' }),
    sampleOf(human, 1, { riskBand: 'LOW', behaviorSummaryBand: 'SLOW' }),
  ];
  expiredSample = sampleOf(expired, 0);
  await store.insertBatch(passed, passedSamples);
  await store.insertBatch(human, humanSamples);
  await store.insertBatch(expired, [expiredSample]);
  for (const s of [...passedSamples, ...humanSamples, expiredSample]) {
    candidates.push({
      sessionRef: s.sessionRef,
      verdictEventKey: s.verdictEventKey,
      pid: `pid-${s.sampleId.slice(-4)}`,
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
  svc = await createService({
    name: 'ops-svc-bot-review-it',
    module: AppModule.register({ database: db, botReview: { source: new FixtureBotReviewSource(candidates), labels } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close().catch(() => undefined);
  await adminDb?.end().catch(() => undefined);
  await db?.close().catch(() => undefined);
  container?.stop();
});

const AGENT = identity.ops('cs_agent');
const get = (url: string) => svc.http.inject({ method: 'GET', url, headers: AGENT });
const post = (sampleId: string, body: unknown, key = randomUUID()) =>
  svc.http.inject({ method: 'POST', url: `/v1/ops/bot-review-samples/${sampleId}/judgement`, headers: { ...AGENT, 'idempotency-key': key, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;

describe('FR-049 표본 검토(PostgreSQL)', () => {
  test('FR-049 표본 카드에는 pid·계정 ID·IP·기기 가명·점수 원값·가중치가 없다', async () => {
    const r = await get(`/v1/ops/events/${EVENT}/bot-review-samples?limit=100`);
    expect(r.statusCode, r.payload).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const items = (json(r) as { items: Record<string, unknown>[] }).items;
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(['behaviorSummaryBand', 'evidenceAvailable', 'riskBand', 'sampleId', 'sessionRef', 'status', 'timeline']);
    }
    // 표에도 그런 칸이 아예 없다(앱이 안 싣는 것과 저장하지 않는 것을 함께 본다)
    const { rows } = (await adminDb.query(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public' and table_name in ('bot_review_batch', 'bot_review_sample', 'bot_review_judgement')
       order by table_name, ordinal_position`,
    )) as { rows: { table_name: string; column_name: string }[] };
    const columns = rows.map((x) => `${x.table_name}.${x.column_name}`);
    for (const forbidden of ['pid', 'device_ref', 'ip', 'account_id', 'account_ref', 'memo', 'note', 'risk_score', 'score', 'weight', 'weights', 'criteria']) {
      expect(columns.some((c) => c.endsWith(`.${forbidden}`)), `${forbidden} 칸`).toBe(false);
    }
    // 카드 표는 가명 세션·판정 사건 키·범주·타임라인만 둔다
    expect(columns).toEqual(
      expect.arrayContaining([
        'bot_review_sample.sample_ref',
        'bot_review_sample.verdict_event_key',
        'bot_review_sample.risk_band',
        'bot_review_sample.behavior_summary_band',
        'bot_review_sample.timeline',
        'bot_review_sample.evidence_available',
      ]),
    );
  });

  test('FR-049 HUMAN_BASELINE 카드는 위험 점수 범주·행동 요약 범주·묶음·적용 판정을 싣지 않는다', async () => {
    const r = await get(`/v1/ops/events/${EVENT}/bot-review-samples?reviewKind=HUMAN_BASELINE`);
    expect(r.statusCode, r.payload).toBe(200);
    const items = (json(r) as { items: Record<string, unknown>[] }).items;
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.riskBand).toBeNull();
      expect(item.behaviorSummaryBand).toBeNull();
      expect(item).not.toHaveProperty('reviewBatch');
      expect(item).not.toHaveProperty('appliedVerdict');
    }
    // 표에는 ApplyLabel에 실을 묶음·적용 판정이 남아 있지만(사람 기준 표본도 섞여 있어 필요하다) API로는 나가지 않는다
    expect((await adminDb.query('select review_batch, applied_verdict from bot_review_sample where batch_id = $1 order by ordinal', [id(2)])).rows).toEqual([
      { review_batch: 'SHADOW_CHALLENGED', applied_verdict: 'CHALLENGE' },
      { review_batch: 'PASSED', applied_verdict: 'ALLOW' },
    ]);
    const progress = await get(`/v1/ops/events/${EVENT}/bot-review?reviewKind=HUMAN_BASELINE`);
    expect(json(progress)).toMatchObject({ reviewKind: 'HUMAN_BASELINE', targetCount: 400, interim: null });
  });

  test('FR-049 판정 기록에는 세션 가명·판정·근거 종류만 남고 pid·기기 가명·메모가 없다', async () => {
    const r = await post(humanSamples[0]!.sampleId, { verdict: 'BOT', evidenceKinds: ['CONFIRMED_SIGNAL', 'OTHER'] });
    expect(r.statusCode, r.payload).toBe(200);
    expect(json(r)).toEqual({ sampleId: humanSamples[0]!.sampleId, verdict: 'BOT', recordedAt: new Date(NOW).toISOString() });
    const { rows } = (await adminDb.query('select sample_id, verdict, evidence_kinds, label_result from bot_review_judgement where sample_id = $1', [humanSamples[0]!.sampleId])) as {
      rows: { sample_id: string; verdict: string; evidence_kinds: string[]; label_result: string }[];
    };
    expect(rows).toEqual([{ sample_id: humanSamples[0]!.sampleId, verdict: 'BOT', evidence_kinds: ['CONFIRMED_SIGNAL', 'OTHER'], label_result: 'APPLIED' }]);
    const { rows: status } = (await adminDb.query('select status from bot_review_sample where id = $1', [humanSamples[0]!.sampleId])) as { rows: { status: string }[] };
    expect(status).toEqual([{ status: 'RECORDED' }]);
    // 멱등 기록은 공용 표에 작업 이름으로 남는다
    const { rows: idem } = (await adminDb.query("select operation from idempotency_record where operation = 'CREATE_BOT_REVIEW_JUDGEMENT'")) as { rows: { operation: string }[] };
    expect(idem.length).toBeGreaterThanOrEqual(1);
  });

  test('FR-049 같은 표본에 두 번째 판정은 409이고 같은 Idempotency-Key 재시도는 같은 200이다', async () => {
    const key = randomUUID();
    const a = await post(passedSamples[0]!.sampleId, { verdict: 'HUMAN' }, key);
    expect(a.statusCode, a.payload).toBe(200);
    const replay = await post(passedSamples[0]!.sampleId, { verdict: 'HUMAN' }, key);
    expect(replay.statusCode, replay.payload).toBe(200);
    expect(json(replay)).toEqual(json(a));
    const otherKey = await post(passedSamples[0]!.sampleId, { verdict: 'HUMAN' });
    expect(otherKey.statusCode).toBe(409);
    expect(String(json(otherKey).type)).toMatch(/bot-review-already-recorded/);
    // 같은 키·다른 본문은 422다
    const reused = await post(passedSamples[0]!.sampleId, { verdict: 'BOT' }, key);
    expect(reused.statusCode).toBe(422);
    expect(String(json(reused).type)).toMatch(/idempotency-key-reused/);
    const { rows } = (await adminDb.query('select count(*)::int as n from bot_review_judgement where sample_id = $1', [passedSamples[0]!.sampleId])) as { rows: { n: number }[] };
    expect(rows).toEqual([{ n: 1 }]);
  });

  test('FR-049 HUMAN_BASELINE의 BOT은 근거 종류가 하나 이상일 때만 200이고 없으면 422다', async () => {
    const bad = await post(humanSamples[1]!.sampleId, { verdict: 'BOT' });
    expect(bad.statusCode).toBe(422);
    const { rows } = (await adminDb.query('select count(*)::int as n from bot_review_judgement where sample_id = $1', [humanSamples[1]!.sampleId])) as { rows: { n: number }[] };
    expect(rows).toEqual([{ n: 0 }]);
    expect((await post(humanSamples[1]!.sampleId, { verdict: 'BOT', evidenceKinds: ['VERIFICATION_FAILED'] })).statusCode).toBe(200);
  });

  test('FR-049 기한이 지난 배치는 진행·목록·판정이 410이고 열린 배치는 200이다', async () => {
    expect((await get(`/v1/ops/events/${EVENT}/bot-review`)).statusCode).toBe(200);
    for (const path of [`/v1/ops/events/${EXPIRED_EVENT}/bot-review`, `/v1/ops/events/${EXPIRED_EVENT}/bot-review-samples`]) {
      const r = await get(path);
      expect(r.statusCode, path).toBe(410);
      expect(String(json(r).type)).toMatch(/retention-ended/);
    }
    expect((await post(expiredSample.sampleId, { verdict: 'HUMAN' })).statusCode).toBe(410);
    expect(labels.calls.some((c) => c.sampleId === expiredSample.sampleId)).toBe(false);
  });

  test('FR-049 진행은 실제 판정 행을 세고 UNDECIDED를 분모에서 뺀 잠정 중간 결과를 준다', async () => {
    // 지금까지: HUMAN_BASELINE BOT 2(HUMAN_BASELINE), PASSED HUMAN 1
    expect((await post(passedSamples[1]!.sampleId, { verdict: 'BOT' })).statusCode).toBe(200);
    expect((await post(passedSamples[2]!.sampleId, { verdict: 'UNDECIDED' })).statusCode).toBe(200);
    const view = json(await get(`/v1/ops/events/${EVENT}/bot-review`));
    expect(view).toMatchObject({ reviewKind: 'PASSED_SAMPLE', reviewedCount: 3, targetCount: 200 });
    expect(view.interim).toMatchObject({ missedBotRate: 0.5 });
    expect((view.interim as { ci95Low: number }).ci95Low).toBeCloseTo(0.09453120573423068, 10);
    const pending = json(await get(`/v1/ops/events/${EVENT}/bot-review-samples?status=PENDING`)) as { items: unknown[] };
    expect(pending.items).toEqual([]);
    const recorded = json(await get(`/v1/ops/events/${EVENT}/bot-review-samples?status=RECORDED`)) as { items: { sampleId: string }[] };
    expect(recorded.items.map((x) => x.sampleId).sort()).toEqual([passedSamples[0]!.sampleId, passedSamples[1]!.sampleId, passedSamples[2]!.sampleId].sort());
  });
});
