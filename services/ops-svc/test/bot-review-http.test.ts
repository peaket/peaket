// 봇 판정 표본 검토 REST(BAT-197 BOT-080, FR-049, SCR-067, ADR-0174).
// 두 GET(진행·목록)과 판정 POST를 실제 createService로 불러 권한·기본 reviewKind·커서·PENDING·가림·기한·오류를 본다.
// 판정은 표본마다 한 번이고 Idempotency-Key 재시도는 같은 200, 같은 표본에 다른 본문은 409/422다.
// 진행·목록·판정 응답은 Cache-Control: no-store이고 판정은 POST만 받는다(ASVS 3.2.1·3.5.5).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { BOT_REVIEW_STORE } from '../src/modules/bot-review/bot-review.module.js';
import type { BotReviewBatch, BotReviewSample, BotReviewStore, ReviewKind } from '../src/modules/bot-review/index.js';
import { FixtureBotReviewSource, UnavailableBotReviewSource } from '../src/modules/bot-review/index.js';
import type { ApplySampleLabelInput, TrustLabels } from '../src/modules/bot-review/index.js';
import type { AppliedSampleLabel } from '../src/modules/bot-review/domain/ports.js';
import type { BotReviewCandidate } from '../src/modules/bot-review/index.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-21T03:00:00.000Z');
const DAY = 86_400_000;
const EVENT = '0194b197-0000-7000-8000-000000000001';
const OTHER_EVENT = '0194b197-0000-7000-8000-000000000002';
/** 권한 시험은 이 회차를 따로 쓴다(다른 시험의 진행 수를 흔들지 않는다) */
const ROLE_EVENT = '0194b197-0000-7000-8000-000000000003';

/** 표본 ID는 사전순과 ordinal 차례가 다르게 둔다(서버가 섞은 순서를 시험이 확인한다) */
const id = (n: number) => `0194b197-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const HUMAN = id(0x30);
const BOT = id(0x21);
const UNDECIDED = id(0x12);
const HUMAN_BASE_BOT = id(0x201);
const ROLE_SAMPLE = id(0x301);

class FakeLabels implements TrustLabels {
  readonly calls: ApplySampleLabelInput[] = [];
  async apply(input: ApplySampleLabelInput): Promise<AppliedSampleLabel> {
    this.calls.push(input);
    return { changed: true, blockList: 'ADDED' };
  }
}

const identity = new FakeIdentity();
const labels = new FakeLabels();
const clock = fakeClock({ now: NOW });
/** 후보 원장 대역. 판정할 때 pid를 읽는 자리라 표본마다 한 줄 둔다 */
const candidates: BotReviewCandidate[] = [];
const source = new FixtureBotReviewSource(candidates);
let svc: Awaited<ReturnType<typeof createService>>;
let unconfigured: Awaited<ReturnType<typeof createService>>;
let store: BotReviewStore;

const batchOf = (o: Partial<BotReviewBatch> = {}): BotReviewBatch => ({
  batchId: randomUUID(),
  eventId: EVENT,
  reviewKind: 'PASSED_SAMPLE',
  seed: 'seed-1',
  targetCount: 200,
  populationCount: 250,
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
  timeline: [
    { step: 'ENTRY', atMs: NOW - 2_000 },
    { step: 'PAYMENT', atMs: NOW - 1_000 },
  ],
  evidenceAvailable: ['CONFIRMED_SIGNAL'],
  ordinal,
  createdAtMs: NOW,
  reviewBatch: 'PASSED',
  appliedVerdict: 'ALLOW',
  ...o,
});

/** 같은 회차에 두 종류 배치를 둔다. 표본 ID 사전순과 ordinal 차례를 다르게 두어 다시 정렬하지 않는지 본다 */
async function seed() {
  const passed = batchOf({ batchId: id(1), targetCount: 200, populationCount: 250 });
  const human = batchOf({ batchId: id(2), reviewKind: 'HUMAN_BASELINE', targetCount: 400, populationCount: 450 });
  const role = batchOf({ batchId: id(3), eventId: ROLE_EVENT, targetCount: 1, populationCount: 1 });
  const passedSamples = [
    sampleOf(passed, 2, { sampleId: UNDECIDED }),
    sampleOf(passed, 0, { sampleId: HUMAN }),
    sampleOf(passed, 1, { sampleId: BOT }),
  ];
  const humanSamples = [
    sampleOf(human, 1, { sampleId: HUMAN_BASE_BOT, riskBand: 'HIGH', behaviorSummaryBand: 'ENTRY_FAST', reviewBatch: 'SHADOW_CHALLENGED', appliedVerdict: 'CHALLENGE' }),
    sampleOf(human, 0, { sampleId: id(0x202), riskBand: 'LOW', behaviorSummaryBand: 'SLOW' }),
  ];
  const roleSamples = [sampleOf(role, 0, { sampleId: ROLE_SAMPLE })];
  await store.insertBatch(passed, passedSamples);
  await store.insertBatch(human, humanSamples);
  await store.insertBatch(role, roleSamples);
  for (const s of [...passedSamples, ...humanSamples, ...roleSamples]) {
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
}

beforeAll(async () => {
  svc = await createService({
    name: 'ops-svc-bot-review-http',
    module: AppModule.register({ memory: true, botReview: { source, labels } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
  store = svc.app.get<BotReviewStore>(BOT_REVIEW_STORE);
  await seed();
  unconfigured = await createService({
    name: 'ops-svc-bot-review-http-unconfigured',
    module: AppModule.register({ memory: true, botReview: { source: new UnavailableBotReviewSource() } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
  await unconfigured?.close();
});

const cs = () => AGENT;
const lead = () => LEAD;
/** 같은 계정·세션을 쓴다. Idempotency-Key 범위가 계정 × 작업이라 매 호출 새 계정이면 재시도가 409가 된다 */
const AGENT = identity.ops('cs_agent');
const LEAD = identity.ops('cs_lead');
const get = (url: string, who: Record<string, string> = cs()) => svc.http.inject({ method: 'GET', url, headers: who });
const json = (r: { payload: string }) => (r.payload === '' ? {} : (JSON.parse(r.payload) as Record<string, unknown>));
const post = (sampleId: string, body: unknown, o: { who?: Record<string, string>; key?: string | undefined; contentType?: string } = {}) =>
  svc.http.inject({
    method: 'POST',
    url: `/v1/ops/bot-review-samples/${sampleId}/judgement`,
    headers: {
      ...(o.who ?? cs()),
      ...(o.key === undefined || o.key === 'auto' ? { 'idempotency-key': randomUUID() } : o.key === '' ? {} : { 'idempotency-key': o.key }),
      'content-type': o.contentType ?? 'application/json',
    },
    payload: JSON.stringify(body),
  });

describe('FR-049 표본 검토 REST', () => {
  test('FR-049 표본 검토는 cs_agent·cs_lead만 부르고 viewer·operator·commander는 403이다', async () => {
    const paths = [
      `/v1/ops/events/${ROLE_EVENT}/bot-review`,
      `/v1/ops/events/${ROLE_EVENT}/bot-review-samples`,
    ];
    const before = labels.calls.length;
    for (const role of ['viewer', 'operator', 'commander'] as const) {
      const who = identity.ops(role);
      for (const path of paths) {
        const r = await get(path, who);
        expect(r.statusCode, `${role} ${path}`).toBe(403);
      }
      const judged = await post(ROLE_SAMPLE, { verdict: 'HUMAN' }, { who });
      expect(judged.statusCode, `${role} 판정`).toBe(403);
      expect(labels.calls.length, `${role}는 라벨을 부르지 않는다`).toBe(before);
    }
    for (const who of [cs(), lead()]) {
      for (const path of paths) expect((await get(path, who)).statusCode, path).toBe(200);
    }
    expect((await post(ROLE_SAMPLE, { verdict: 'HUMAN' }, { who: lead() })).statusCode).toBe(200);
  });

  test('FR-049 표본 카드에는 pid·계정 ID·IP·기기 가명·점수 원값·가중치가 없다', async () => {
    const r = await get(`/v1/ops/events/${EVENT}/bot-review-samples?status=PENDING&limit=100`);
    expect(r.statusCode, r.payload).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const page = json(r) as { items: Record<string, unknown>[]; nextCursor: string | null };
    expect(page.items.length).toBeGreaterThanOrEqual(3);
    const forbidden = ['pid', 'accountId', 'accountRef', 'deviceRef', 'device_ref', 'ip', 'sessionId', 'score', 'riskScore', 'weight', 'weights', 'criteria', 'memo'];
    for (const item of page.items) {
      for (const key of forbidden) expect(item, `${key} 칸이 있다`).not.toHaveProperty(key);
      // 허용한 칸만 있다: sampleId·sessionRef·status·riskBand·behaviorSummaryBand·timeline·evidenceAvailable
      expect(Object.keys(item).sort()).toEqual(['behaviorSummaryBand', 'evidenceAvailable', 'riskBand', 'sampleId', 'sessionRef', 'status', 'timeline']);
    }
    const text = JSON.stringify(page);
    for (const value of ['pid-1', '198.51.100.7', 'device-ref-1', '0.87', 'weighted']) expect(text).not.toContain(value);
    // 세션 가명·범주·타임라인은 값으로 온다(글자 노드로 그리는 것은 화면 시험)
    expect(page.items[0]?.sessionRef).toMatch(/^sess-/);
    expect(page.items[0]?.timeline).toEqual([
      { step: 'ENTRY', at: new Date(NOW - 2_000).toISOString() },
      { step: 'PAYMENT', at: new Date(NOW - 1_000).toISOString() },
    ]);
  });

  test('FR-049 HUMAN_BASELINE 카드는 위험 점수 범주·행동 요약 범주·묶음·적용 판정을 싣지 않는다', async () => {
    const r = await get(`/v1/ops/events/${EVENT}/bot-review-samples?reviewKind=HUMAN_BASELINE`);
    expect(r.statusCode, r.payload).toBe(200);
    const page = json(r) as { items: Record<string, unknown>[] };
    expect(page.items).toHaveLength(2);
    for (const item of page.items) {
      expect(item.riskBand).toBeNull();
      expect(item.behaviorSummaryBand).toBeNull();
      for (const key of ['reviewBatch', 'appliedVerdict', 'verdictEventKey', 'batchId']) expect(item, key).not.toHaveProperty(key);
    }
    const progress = await get(`/v1/ops/events/${EVENT}/bot-review?reviewKind=HUMAN_BASELINE`);
    expect(progress.statusCode, progress.payload).toBe(200);
    const view = json(progress);
    expect(view.reviewKind).toBe('HUMAN_BASELINE');
    expect(view.interim).toBeNull();
    for (const key of ['reviewBatch', 'passedCount', 'shadowCount', 'batchId', 'seed']) expect(view, key).not.toHaveProperty(key);
  });

  test('FR-049 두 묶음을 섞은 서버 순서를 그대로 주고 sampleId로 다시 정렬하지 않는다', async () => {
    const r = await get(`/v1/ops/events/${EVENT}/bot-review-samples?status=PENDING&limit=3`);
    expect(r.statusCode, r.payload).toBe(200);
    const ids = (json(r) as { items: { sampleId: string }[] }).items.map((s) => s.sampleId);
    // ordinal 0·1·2 차례다. sampleId 사전순(id(12)·id(21)·id(30))과도, seed 순서와도 다르다
    expect(ids).toEqual([HUMAN, BOT, UNDECIDED]);
    expect(ids).not.toEqual([...ids].sort());
    const human = await get(`/v1/ops/events/${EVENT}/bot-review-samples?reviewKind=HUMAN_BASELINE`);
    const humanIds = (json(human) as { items: { sampleId: string }[] }).items.map((s) => s.sampleId);
    expect(humanIds).toEqual([id(0x202), HUMAN_BASE_BOT]);
  });

  test('FR-049 PASSED_SAMPLE 진행은 200건 기준이고 HUMAN_BASELINE은 두 묶음 합 400건만 보인다', async () => {
    // 기본값은 PASSED_SAMPLE
    const byDefault = await get(`/v1/ops/events/${EVENT}/bot-review`);
    expect(byDefault.statusCode, byDefault.payload).toBe(200);
    expect(byDefault.headers['cache-control']).toBe('no-store');
    expect(json(byDefault)).toMatchObject({ eventId: EVENT, reviewKind: 'PASSED_SAMPLE', targetCount: 200, reviewedCount: 0, interim: null });
    // reviewKind를 바꾸면 두 묶음 합 400건만 보이고 interim은 null이다
    const human = await get(`/v1/ops/events/${EVENT}/bot-review?reviewKind=HUMAN_BASELINE`);
    expect(json(human)).toMatchObject({ eventId: EVENT, reviewKind: 'HUMAN_BASELINE', targetCount: 400, reviewedCount: 0, interim: null });
    expect(json(human)).not.toHaveProperty('passedCount');
  });

  test('FR-049 기한은 오픈+30일·R2 오픈+7일이고 30일 경계를 넘으면 410이다', async () => {
    const r = await get(`/v1/ops/events/${EVENT}/bot-review`);
    const view = json(r) as { deadlineAt: string; r2DueAt: string };
    expect(Date.parse(view.deadlineAt)).toBe(NOW + 30 * DAY);
    expect(Date.parse(view.r2DueAt)).toBe(NOW + 7 * DAY);

    // 경계 당일(정확히 30일)은 아직 검토할 수 있고, 1ms 뒤부터 410이다.
    // 시계를 공유하면 뒤 시험이 410이 되므로 경계 회차를 따로 띄운다
    const exact = fakeClock({ now: NOW + 30 * DAY });
    const boundary = await createService({
      name: 'ops-svc-bot-review-boundary',
      module: AppModule.register({ memory: true, botReview: { source: new FixtureBotReviewSource([candidates[0]!]), labels } }),
      env: { PEAKET_ENV: 'ci' },
      clock: exact,
      logDestination: quiet(),
      adminAuthz: identity,
    });
    try {
      const boundaryStore = boundary.app.get<BotReviewStore>(BOT_REVIEW_STORE);
      const open = batchOf({ batchId: id(4), eventId: OTHER_EVENT, retentionUntilMs: NOW + 30 * DAY, r2DueAtMs: NOW + 7 * DAY });
      const late = batchOf({ batchId: id(5), eventId: ROLE_EVENT, retentionUntilMs: NOW + 30 * DAY - 1 });
      const openSample = sampleOf(open, 0);
      const lateSample = sampleOf(late, 0);
      await boundaryStore.insertBatch(open, [openSample]);
      await boundaryStore.insertBatch(late, [lateSample]);
      const atBoundary = await boundary.http.inject({ method: 'GET', url: `/v1/ops/events/${OTHER_EVENT}/bot-review`, headers: cs() });
      expect(atBoundary.statusCode, atBoundary.payload).toBe(200);
      expect((await boundary.http.inject({ method: 'GET', url: `/v1/ops/events/${OTHER_EVENT}/bot-review-samples`, headers: cs() })).statusCode).toBe(200);
      const expired = await boundary.http.inject({ method: 'GET', url: `/v1/ops/events/${ROLE_EVENT}/bot-review`, headers: cs() });
      expect(expired.statusCode).toBe(410);
      expect(String(json(expired).type)).toMatch(/retention-ended/);
      expect((await boundary.http.inject({ method: 'GET', url: `/v1/ops/events/${ROLE_EVENT}/bot-review-samples`, headers: cs() })).statusCode).toBe(410);
      const judged = await boundary.http.inject({
        method: 'POST',
        url: `/v1/ops/bot-review-samples/${lateSample.sampleId}/judgement`,
        headers: { ...cs(), 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
        payload: JSON.stringify({ verdict: 'HUMAN' }),
      });
      expect(judged.statusCode).toBe(410);
    } finally {
      await boundary.close();
    }
  });

  test('FR-049 판정은 HUMAN·BOT·UNDECIDED만 받고 모르는 칸·값은 400이다', async () => {
    const before = labels.calls.length;
    for (const body of [
      { verdict: 'MAYBE' },
      { verdict: 'HUMAN', memo: '메모는 받지 않는다' },
      { verdict: 'HUMAN', evidenceKinds: ['CONFIRMED_SIGNAL', 'CONFIRMED_SIGNAL'] },
      { verdict: 'HUMAN', evidenceKinds: ['NOT_A_KIND'] },
      { verdict: 'HUMAN', evidenceKinds: ['CONFIRMED_SIGNAL', 'SHARED_DEVICE_OR_PAYMENT', 'POST_LABEL', 'VERIFICATION_FAILED', 'OTHER', 'OTHER'] },
    ]) {
      const r = await post(BOT, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
    }
    // 표본이 없어도 본문 검사가 먼저다(400). 모르는 표본은 404다
    expect((await post('0194b197-0000-7000-8000-0000000000ff', { verdict: 'HUMAN' })).statusCode).toBe(404);
    expect((await post('not-a-uuid', { verdict: 'HUMAN' })).statusCode).toBe(404);
    expect(labels.calls.length).toBe(before);
  });

  test('FR-049 HUMAN_BASELINE의 BOT은 근거 종류가 하나 이상일 때만 200이고 없으면 422다', async () => {
    const before = labels.calls.length;
    const missing = await post(HUMAN_BASE_BOT, { verdict: 'BOT' });
    expect(missing.statusCode).toBe(422);
    expect(String(json(missing).type)).toMatch(/bot-review-evidence-required/);
    expect(labels.calls.length).toBe(before);
    const ok = await post(HUMAN_BASE_BOT, { verdict: 'BOT', evidenceKinds: ['CONFIRMED_SIGNAL'] });
    expect(ok.statusCode, ok.payload).toBe(200);
    expect(json(ok)).toMatchObject({ sampleId: HUMAN_BASE_BOT, verdict: 'BOT', recordedAt: new Date(NOW).toISOString() });
    expect(labels.calls.length).toBe(before + 1);
    expect(labels.calls.at(-1)).toMatchObject({ sampleId: HUMAN_BASE_BOT, label: 'BOT', reviewBatch: 'SHADOW_CHALLENGED', appliedVerdict: 'CHALLENGE' });
  });

  test('FR-049 같은 표본에 두 번째 판정은 409이고 같은 Idempotency-Key 재시도는 같은 200이다', async () => {
    const key = randomUUID();
    const calls = labels.calls.length;
    const first = await post(UNDECIDED, { verdict: 'UNDECIDED' }, { key });
    expect(first.statusCode, first.payload).toBe(200);
    expect(labels.calls.length).toBe(calls);
    const same = await post(UNDECIDED, { verdict: 'UNDECIDED' }, { key });
    expect(same.statusCode, same.payload).toBe(200);
    expect(json(same)).toEqual(json(first));
    // 같은 표본에 새 키·같은 본문도 이미 기록한 표본이라 409다
    const otherKey = await post(UNDECIDED, { verdict: 'UNDECIDED' });
    expect(otherKey.statusCode).toBe(409);
    expect(String(json(otherKey).type)).toMatch(/bot-review-already-recorded/);
    // 같은 키에 본문을 바꾸면 422 idempotency-key-reused다(guidelines §4)
    const changed = await post(UNDECIDED, { verdict: 'HUMAN' }, { key });
    expect(changed.statusCode).toBe(422);
    expect(String(json(changed).type)).toMatch(/idempotency-key-reused/);
    // 목록에서 사라지고 status=RECORDED에 나타난다
    const pending = await get(`/v1/ops/events/${EVENT}/bot-review-samples?status=PENDING`);
    expect((json(pending) as { items: { sampleId: string }[] }).items.map((s) => s.sampleId)).not.toContain(UNDECIDED);
    const recorded = await get(`/v1/ops/events/${EVENT}/bot-review-samples?status=RECORDED`);
    expect((json(recorded) as { items: { sampleId: string }[] }).items.map((s) => s.sampleId)).toContain(UNDECIDED);
  });

  test('FR-049 목록은 커서·limit·status를 지키고 잘못된 질의는 400이다', async () => {
    const first = await get(`/v1/ops/events/${EVENT}/bot-review-samples?status=PENDING&limit=1`);
    expect(first.statusCode, first.payload).toBe(200);
    const page = json(first) as { items: { sampleId: string }[]; nextCursor: string | null };
    expect(page.items.map((s) => s.sampleId)).toEqual([HUMAN]);
    expect(page.nextCursor).toEqual(expect.any(String));
    const second = await get(`/v1/ops/events/${EVENT}/bot-review-samples?status=PENDING&limit=1&cursor=${encodeURIComponent(page.nextCursor!)}`);
    expect((json(second) as { items: { sampleId: string }[] }).items.map((s) => s.sampleId)).toEqual([BOT]);
    expect((json(second) as { nextCursor: string | null }).nextCursor).toBeNull();
    for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'status=DONE', 'cursor=not-a-cursor', 'reviewKind=OTHER']) {
      const r = await get(`/v1/ops/events/${EVENT}/bot-review-samples?${query}`);
      expect(r.statusCode, query).toBe(400);
    }
  });

  test('FR-049 후보 원장이 없거나 질의가 실패하면 503 source-unavailable이고 404와 구분한다', async () => {
    // 원장이 답하는데 배치·후보가 없으면 404(표본 없음)다
    const notFound = await get(`/v1/ops/events/${OTHER_EVENT}/bot-review`);
    expect(notFound.statusCode).toBe(404);
    expect(String(json(notFound).type)).toMatch(/not-found/);
    // 목록은 배치가 없으면 빈 페이지다(진행 GET이 404로 알린다)
    const empty = await get(`/v1/ops/events/${OTHER_EVENT}/bot-review-samples`);
    expect(empty.statusCode).toBe(200);
    expect(json(empty)).toEqual({ items: [], nextCursor: null });
    // 원장에 닿지 못하면 503 source-unavailable이고 404와 구분한다
    const down = await unconfigured.http.inject({ method: 'GET', url: `/v1/ops/events/${OTHER_EVENT}/bot-review`, headers: cs() });
    expect(down.statusCode).toBe(503);
    expect(String(json(down).type)).toMatch(/bot-review-source-unavailable/);
    expect(down.headers['retry-after']).toBe('1');
  });

  test('[ASVS v5.0.0-3.2.1] 표본 검토 응답은 JSON뿐이고 다른 형식은 415·400이다', async () => {
    for (const url of [`/v1/ops/events/${EVENT}/bot-review`, `/v1/ops/events/${EVENT}/bot-review-samples`]) {
      const r = await svc.http.inject({ method: 'GET', url, headers: { ...cs(), accept: 'application/xml' } });
      expect(r.statusCode, url).toBe(200);
      expect(String(r.headers['content-type'])).toMatch(/^application\/(?:problem\+)?json/);
      expect(() => JSON.parse(r.payload)).not.toThrow();
    }
    const text = await post(BOT, { verdict: 'HUMAN' }, { contentType: 'text/plain' });
    expect(text.statusCode).toBe(415);
    const missingBody = await svc.http.inject({ method: 'POST', url: `/v1/ops/bot-review-samples/${BOT}/judgement`, headers: { ...cs(), 'idempotency-key': randomUUID() } });
    expect(missingBody.statusCode).toBe(400);
    const noKey = await post(BOT, { verdict: 'HUMAN' }, { key: '' });
    expect(noKey.statusCode).toBe(400);
    expect(String(json(noKey).type)).toMatch(/idempotency-key-invalid/);
  });

  test('[ASVS v5.0.0-3.5.3] 판정은 POST만 받고 GET·HEAD로는 바꿀 수 없다', async () => {
    const before = json(await get(`/v1/ops/events/${EVENT}/bot-review`)).reviewedCount;
    const calls = labels.calls.length;
    for (const method of ['GET', 'HEAD'] as const) {
      const r = await svc.http.inject({ method, url: `/v1/ops/bot-review-samples/${HUMAN}/judgement`, headers: cs() });
      expect([404, 405], method).toContain(r.statusCode);
    }
    const after = json(await get(`/v1/ops/events/${EVENT}/bot-review`)).reviewedCount;
    expect(after).toBe(before);
    expect(labels.calls.length).toBe(calls);
  });
});
