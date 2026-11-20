// 표본 판정 기록(BAT-197 BOT-080, FR-049, B15, ASVS 16.3.3·16.3.4).
// HUMAN·BOT만 trust-svc ApplyLabel을 부르고 UNDECIDED는 부르지 않는다. ApplyLabel이 실패하면 판정 행을 쓰지 않고 503이다.
// 표본마다 한 번이고 같은 Idempotency-Key 재시도는 같은 판정을 돌려준다. 처리자는 본문이 아니라 넘긴 관리 계정 ID만 쓴다.
import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { trustV1Trust } from '@peaket/contracts/proto';
import { internalGrpcActorProof, INTERNAL_GRPC_ACTOR_HEADER, INTERNAL_GRPC_ACTOR_PROOF_HEADER, INTERNAL_GRPC_CALLER_HEADER, INTERNAL_GRPC_TOKEN_HEADER, startGrpcServer } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { MemoryBotReviewStore } from '../src/modules/bot-review/adapters/memory-bot-review-store.js';
import { FixtureBotReviewSource } from '../src/modules/bot-review/adapters/fixture-bot-review-source.js';
import { GrpcTrustLabels } from '../src/modules/bot-review/adapters/grpc-trust-labels.js';
import { RecordBotReviewJudgement } from '../src/modules/bot-review/application/record-judgement.js';
import {
  BotReviewLabelFailure,
  BotReviewProblem,
  type BotReviewBatch,
  type BotReviewSample,
} from '../src/modules/bot-review/domain/bot-review.js';
import type { ApplySampleLabelInput, AppliedSampleLabel, BotReviewLog, BotReviewSignals, BotReviewSource, TrustLabels } from '../src/modules/bot-review/domain/ports.js';

const NOW = Date.parse('2026-11-21T05:00:00.000Z');
const DAY = 86_400_000;
const EVENT = '0194b197-0000-7000-8000-0000000000b1';
const OPERATION = 'CREATE_BOT_REVIEW_JUDGEMENT';
const ACTOR = '0194b045-0000-7000-8000-0000000000a1';
const PSEUDONYM = 'acct-ref-7f3a';

const id = (n: number) => `0194b197-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const BOT_SAMPLE = id(0xb01);
const HUMAN_SAMPLE = id(0xb02);
const UNDECIDED_SAMPLE = id(0xb03);
const REPLAY_SAMPLE = id(0xb04);
const FAIL_SAMPLE = id(0xb05);

let store: MemoryBotReviewStore;
let batch: BotReviewBatch;
let samples: BotReviewSample[];
let source: FixtureBotReviewSource;
let labels: FakeLabels;
let signals: RecordingSignals;
let log: RecordingLog;
let app: RecordBotReviewJudgement;

class FakeLabels implements TrustLabels {
  readonly calls: ApplySampleLabelInput[] = [];
  answer: AppliedSampleLabel | Error = { changed: true, blockList: 'ADDED' };
  async apply(input: ApplySampleLabelInput): Promise<AppliedSampleLabel> {
    this.calls.push(input);
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}

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

class RecordingLog implements BotReviewLog {
  readonly judgements: Parameters<BotReviewLog['judgement']>[0][] = [];
  readonly failures: Parameters<BotReviewLog['labelFailure']>[0][] = [];
  judgement(e: Parameters<BotReviewLog['judgement']>[0]): void {
    this.judgements.push(e);
  }
  labelFailure(e: Parameters<BotReviewLog['labelFailure']>[0]): void {
    this.failures.push(e);
  }
}

const batchOf = (o: Partial<BotReviewBatch> = {}): BotReviewBatch => ({
  batchId: id(0x1),
  eventId: EVENT,
  reviewKind: 'HUMAN_BASELINE',
  seed: 'seed',
  targetCount: 4,
  populationCount: 4,
  retentionUntilMs: NOW + 30 * DAY,
  r2DueAtMs: NOW + 7 * DAY,
  createdAtMs: NOW,
  ...o,
});

const sampleOf = (ordinal: number, o: Partial<BotReviewSample> = {}): BotReviewSample => ({
  sampleId: id(0xb01 + ordinal),
  batchId: batch.batchId,
  sessionRef: `sess-${ordinal}`,
  verdictEventKey: id(0x901 + ordinal),
  status: 'PENDING',
  riskBand: null,
  behaviorSummaryBand: null,
  timeline: [],
  evidenceAvailable: [],
  ordinal,
  createdAtMs: NOW,
  reviewBatch: 'SHADOW_CHALLENGED',
  appliedVerdict: 'CHALLENGE',
  ...o,
});

const hashOf = (body: unknown) => new Uint8Array(createHash('sha256').update(JSON.stringify(body), 'utf8').digest());
const idem = (key: string, body: unknown) => ({ accountRef: ACTOR, operation: OPERATION, key, requestHash: hashOf(body) });

async function run(o: { sample?: string; verdict: string; evidenceKinds?: string[]; key?: string; actedBy?: string } = { verdict: 'HUMAN' }) {
  const sample = o.sample ?? HUMAN_SAMPLE;
  const evidenceKinds = o.evidenceKinds ?? [];
  const body = { sampleId: sample, verdict: o.verdict, evidenceKinds };
  return app.run({
    sampleId: sample,
    verdict: o.verdict,
    evidenceKinds,
    actedBy: o.actedBy ?? ACTOR,
    idem: idem(o.key ?? randomUUID(), body),
  });
}

async function rejectionOf(p: Promise<unknown>): Promise<BotReviewProblem> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BotReviewProblem);
    return e as BotReviewProblem;
  }
  throw new Error('거절을 기대했는데 성공했다');
}

beforeAll(() => {
  batch = batchOf();
  samples = [
    sampleOf(0, { sampleId: BOT_SAMPLE }),
    sampleOf(1, { sampleId: HUMAN_SAMPLE }),
    sampleOf(2, { sampleId: UNDECIDED_SAMPLE }),
    sampleOf(3, { sampleId: REPLAY_SAMPLE }),
    sampleOf(4, { sampleId: FAIL_SAMPLE }),
  ];
  source = new FixtureBotReviewSource(
    samples.map((s) => ({
      sessionRef: s.sessionRef,
      verdictEventKey: s.verdictEventKey,
      pid: `pid-${s.sampleId.slice(-3)}`,
      reviewBatch: s.reviewBatch,
      appliedVerdict: s.appliedVerdict,
      riskBand: s.riskBand,
      behaviorSummaryBand: s.behaviorSummaryBand,
      timeline: s.timeline,
      evidenceAvailable: s.evidenceAvailable,
      occurredAtMs: NOW,
      openAtMs: NOW - 3_600_000,
    })),
  );
});

beforeEach(async () => {
  store = new MemoryBotReviewStore();
  await store.insertBatch(batch, samples);
  labels = new FakeLabels();
  signals = new RecordingSignals();
  log = new RecordingLog();
  app = new RecordBotReviewJudgement({
    store,
    source,
    labels,
    now: () => NOW,
    signals,
    log,
    accountRef: (accountId) => (accountId === ACTOR ? PSEUDONYM : undefined),
  });
});

describe('FR-049 표본 판정 기록', () => {
  test('FR-049 HUMAN·BOT은 SAMPLE_REVIEW·판 1·묶음·적용 판정·판정 사건 키로 ApplyLabel을 부른다', async () => {
    const human = await run({ sample: HUMAN_SAMPLE, verdict: 'HUMAN' });
    expect(human).toMatchObject({ sampleId: HUMAN_SAMPLE, verdict: 'HUMAN', recordedAtMs: NOW });
    expect(labels.calls).toHaveLength(1);
    const humanCall = labels.calls[0]!;
    expect(humanCall).toEqual({
      sampleId: HUMAN_SAMPLE,
      label: 'HUMAN',
      eventId: EVENT,
      pid: `pid-${HUMAN_SAMPLE.slice(-3)}`,
      reviewBatch: 'SHADOW_CHALLENGED',
      appliedVerdict: 'CHALLENGE',
      verdictEventKey: samples[1]!.verdictEventKey,
      actedBy: ACTOR, // 본문이 아니라 넘긴 관리 계정 ID다
    });
    // 처리자를 바꿔 넘겨도 그 값이 그대로 감사·라벨에 간다(본문 위조 경로는 HTTP 시험)
    await run({ sample: BOT_SAMPLE, verdict: 'BOT', evidenceKinds: ['CONFIRMED_SIGNAL'], actedBy: '0194b045-0000-7000-8000-0000000000a2' });
    expect(labels.calls[1]).toMatchObject({ sampleId: BOT_SAMPLE, label: 'BOT', actedBy: '0194b045-0000-7000-8000-0000000000a2' });
    expect(await store.findJudgement(BOT_SAMPLE)).toMatchObject({ verdict: 'BOT', evidenceKinds: ['CONFIRMED_SIGNAL'], labelResult: 'APPLIED' });
    // 같은 표본에 두 번째 판정은 409이고 라벨을 다시 부르지 않는다
    const calls = labels.calls.length;
    const again = await rejectionOf(run({ sample: BOT_SAMPLE, verdict: 'BOT', evidenceKinds: ['CONFIRMED_SIGNAL'] }));
    expect(again.status).toBe(409);
    expect(again.type).toBe('bot-review-already-recorded');
    expect(labels.calls.length).toBe(calls);
  });

  test('FR-049 ApplyLabel은 gRPC에서 source SAMPLE_REVIEW·source_version 1·묶음·적용 판정·사건 키와 처리자 증명을 싣는다', async () => {
    const calls: { req: Record<string, unknown>; md: grpc.Metadata }[] = [];
    const pkg = grpc.loadPackageDefinition(
      protoLoader.fromJSON(trustV1Trust as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true }),
    ) as unknown as { peaket: { trust: { v1: { TrustLabelService: grpc.ServiceClientConstructor } } } };
    const server = await startGrpcServer({
      host: '127.0.0.1',
      port: 0,
      profile: 'service',
      services: [
        {
          definition: pkg.peaket.trust.v1.TrustLabelService.service,
          handlers: {
            ApplyLabel: (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
              calls.push({ req: call.request, md: call.metadata });
              cb(null, { changed: true, block_list: 'BLOCK_LIST_CHANGE_ADDED' });
            },
          },
        },
      ],
    });
    const client = new GrpcTrustLabels({ address: `127.0.0.1:${server.port}`, token: 'test-token' });
    try {
      const answer = await client.apply({
        sampleId: BOT_SAMPLE,
        label: 'BOT',
        eventId: EVENT,
        pid: 'pid-1',
        reviewBatch: 'SHADOW_CHALLENGED',
        appliedVerdict: 'CHALLENGE',
        verdictEventKey: samples[0]!.verdictEventKey,
        actedBy: ACTOR,
      });
      expect(answer).toEqual({ changed: true, blockList: 'ADDED' });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.req).toMatchObject({
        source_ref: BOT_SAMPLE,
        source_version: 1,
        source: 'LABEL_SOURCE_SAMPLE_REVIEW',
        label: 'LABEL_BOT',
        event_id: EVENT,
        pid: 'pid-1',
        acted_by: ACTOR,
        review_batch: 'REVIEW_BATCH_SHADOW_CHALLENGED',
        applied_verdict: 'VERDICT_CHALLENGE',
        verdict_event_key: samples[0]!.verdictEventKey,
      });
      expect(calls[0]!.md.get(INTERNAL_GRPC_TOKEN_HEADER)).toEqual(['test-token']);
      expect(calls[0]!.md.get(INTERNAL_GRPC_CALLER_HEADER)).toEqual(['ops-svc']);
      expect(calls[0]!.md.get(INTERNAL_GRPC_ACTOR_HEADER)).toEqual([ACTOR]);
      expect(calls[0]!.md.get(INTERNAL_GRPC_ACTOR_PROOF_HEADER)).toEqual([internalGrpcActorProof('test-token', ACTOR)]);
      // HUMAN은 LABEL_HUMAN이고 응답의 DEVICE_NOT_FOUND를 판정 행에 그대로 남긴다
      await client.apply({
        sampleId: HUMAN_SAMPLE,
        label: 'HUMAN',
        eventId: EVENT,
        pid: 'pid-2',
        reviewBatch: 'PASSED',
        appliedVerdict: 'ALLOW',
        verdictEventKey: samples[1]!.verdictEventKey,
        actedBy: ACTOR,
      });
      expect(calls[1]!.req).toMatchObject({ label: 'LABEL_HUMAN', review_batch: 'REVIEW_BATCH_PASSED', applied_verdict: 'VERDICT_ALLOW' });
    } finally {
      client.close();
      await server.close();
    }
  });

  test('FR-049 UNDECIDED는 ApplyLabel을 부르지 않고 판정 행에만 남는다', async () => {
    const calls = labels.calls.length;
    const out = await run({ sample: UNDECIDED_SAMPLE, verdict: 'UNDECIDED' });
    expect(out).toMatchObject({ sampleId: UNDECIDED_SAMPLE, verdict: 'UNDECIDED' });
    expect(labels.calls.length).toBe(calls);
    const judgement = await store.findJudgement(UNDECIDED_SAMPLE);
    expect(judgement).toMatchObject({ verdict: 'UNDECIDED', evidenceKinds: [], labelResult: 'SKIPPED' });
    expect((await store.findSample(UNDECIDED_SAMPLE))?.sample.status).toBe('RECORDED');
    expect(signals.judgements).toEqual([{ verdict: 'UNDECIDED', label: 'SKIPPED' }]);
    expect(log.judgements).toHaveLength(1);
    expect(log.judgements[0]).toMatchObject({ sampleId: UNDECIDED_SAMPLE, verdict: 'UNDECIDED', reviewBatch: 'SHADOW_CHALLENGED', label: 'SKIPPED' });
  });

  test('FR-049 ApplyLabel이 실패하면 503이고 판정 행을 쓰지 않으며 같은 키로 다시 시도한다', async () => {
    const key = randomUUID();
    labels.answer = new BotReviewLabelFailure('invalid-argument');
    const failed = await rejectionOf(run({ sample: FAIL_SAMPLE, verdict: 'HUMAN', key }));
    expect(failed).toMatchObject({ status: 503, type: 'bot-review-label-unavailable', retryAfterSeconds: 1 });
    expect(await store.findJudgement(FAIL_SAMPLE)).toBeUndefined();
    expect((await store.findSample(FAIL_SAMPLE))?.sample.status).toBe('PENDING');
    expect(signals.failures).toEqual(['invalid-argument']);
    expect(signals.judgements).toEqual([]);
    expect(log.failures).toEqual([{ sampleId: FAIL_SAMPLE, reason: 'invalid-argument', atMs: NOW }]);
    // trust가 회복되면 같은 키·같은 본문으로 다시 보내 기록한다
    labels.answer = { changed: false, blockList: 'NONE' };
    const retried = await run({ sample: FAIL_SAMPLE, verdict: 'HUMAN', key });
    expect(retried).toMatchObject({ sampleId: FAIL_SAMPLE, verdict: 'HUMAN' });
    expect(await store.findJudgement(FAIL_SAMPLE)).toMatchObject({ verdict: 'HUMAN', labelResult: 'UNCHANGED' });
    expect(labels.calls).toHaveLength(2);

    // 원장이 pid를 주지 못하는 것도 503 label-unavailable이고 판정 행을 쓰지 않는다
    const unknownPid = new RecordBotReviewJudgement({
      store,
      source: new FixtureBotReviewSource([]),
      labels,
      now: () => NOW,
      signals,
      log,
    });
    const missingPid = await rejectionOf(
      unknownPid.run({ sampleId: REPLAY_SAMPLE, verdict: 'HUMAN', evidenceKinds: [], actedBy: ACTOR, idem: idem(randomUUID(), { sample: REPLAY_SAMPLE }) }),
    );
    expect(missingPid).toMatchObject({ status: 503, type: 'bot-review-label-unavailable' });
    expect(await store.findJudgement(REPLAY_SAMPLE)).toBeUndefined();
    // 원장이 던지는 것도 같다
    const brokenSource: BotReviewSource = { population: async () => 0, candidates: async () => [], pidOf: async () => { throw new Error('down'); } };
    const broken = new RecordBotReviewJudgement({ store, source: brokenSource, labels, now: () => NOW, signals, log });
    expect((await rejectionOf(broken.run({ sampleId: REPLAY_SAMPLE, verdict: 'HUMAN', evidenceKinds: [], actedBy: ACTOR, idem: idem(randomUUID(), { sample: REPLAY_SAMPLE }) }))).status).toBe(503);
  });

  test('FR-049 첫 라벨 응답을 잃은 재시도는 changed false면 blockList가 ADDED·REMOVED여도 UNCHANGED다', async () => {
    // trust는 성공한 판 1을 다시 부를 때 DONE(changed false)과 처음 결과(ADDED/REMOVED)를 함께 준다.
    // 계획 B15·§7.3은 그때 판정 행을 UNCHANGED로 남기라고 정한다(지표도 APPLIED로 세지 않는다)
    labels.answer = { changed: false, blockList: 'ADDED' };
    await run({ sample: HUMAN_SAMPLE, verdict: 'HUMAN' });
    expect(await store.findJudgement(HUMAN_SAMPLE)).toMatchObject({ verdict: 'HUMAN', labelResult: 'UNCHANGED' });
    expect(signals.judgements.at(-1)).toEqual({ verdict: 'HUMAN', label: 'UNCHANGED' });

    labels.answer = { changed: false, blockList: 'REMOVED' };
    await run({ sample: BOT_SAMPLE, verdict: 'BOT', evidenceKinds: ['CONFIRMED_SIGNAL'] });
    expect(await store.findJudgement(BOT_SAMPLE)).toMatchObject({ verdict: 'BOT', labelResult: 'UNCHANGED' });

    // changed true는 blockList대로 APPLIED·DEVICE_NOT_FOUND다
    labels.answer = { changed: true, blockList: 'NONE' };
    await run({ sample: REPLAY_SAMPLE, verdict: 'HUMAN' });
    expect(await store.findJudgement(REPLAY_SAMPLE)).toMatchObject({ verdict: 'HUMAN', labelResult: 'APPLIED' });

    labels.answer = { changed: true, blockList: 'DEVICE_NOT_FOUND' };
    await run({ sample: FAIL_SAMPLE, verdict: 'HUMAN' });
    expect(await store.findJudgement(FAIL_SAMPLE)).toMatchObject({ verdict: 'HUMAN', labelResult: 'DEVICE_NOT_FOUND' });
  });

  test('FR-049 같은 표본에 두 검토자가 동시에 오면 한 요청만 ApplyLabel을 부르고 다른 요청은 409다', async () => {
    let started!: () => void;
    const startedAt = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 첫 호출만 붙잡아 두 번째 요청이 그 사이에 들어오게 한다
    let held = false;
    const gated: TrustLabels = {
      apply: async (input) => {
        labels.calls.push(input);
        if (!held) {
          held = true;
          started();
          await gate;
        }
        return { changed: true, blockList: 'ADDED' };
      },
    };
    const app2 = new RecordBotReviewJudgement({ store, source, labels: gated, now: () => NOW, signals, log });
    const first = app2.run({ sampleId: HUMAN_SAMPLE, verdict: 'HUMAN', evidenceKinds: [], actedBy: ACTOR, idem: idem(randomUUID(), { sampleId: HUMAN_SAMPLE }) });
    await startedAt;
    let secondError: BotReviewProblem | undefined;
    let secondOutcome: unknown;
    try {
      secondOutcome = await app2.run({
        sampleId: HUMAN_SAMPLE,
        verdict: 'BOT',
        evidenceKinds: ['CONFIRMED_SIGNAL'],
        actedBy: ACTOR,
        idem: idem(randomUUID(), { sampleId: HUMAN_SAMPLE, verdict: 'BOT' }),
      });
    } catch (e) {
      secondError = e as BotReviewProblem;
    }
    release();
    const firstOutcome = await first.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    // 두 요청의 라벨은 한 번뿐이고, 하나만 200이고 다른 하나는 409다(판정 행도 하나)
    expect(labels.calls).toHaveLength(1);
    expect(secondOutcome).toBeUndefined();
    expect(secondError).toBeInstanceOf(BotReviewProblem);
    expect(secondError).toMatchObject({ status: 409 });
    expect(['bot-review-claim-in-progress', 'bot-review-already-recorded']).toContain(secondError?.type);
    expect(firstOutcome.ok, `첫 요청이 200이어야 한다: ${JSON.stringify(firstOutcome)}`).toBe(true);
    if (firstOutcome.ok) expect(firstOutcome.value).toMatchObject({ sampleId: HUMAN_SAMPLE, verdict: 'HUMAN' });
    expect(await store.findJudgement(HUMAN_SAMPLE)).toMatchObject({ verdict: 'HUMAN', labelResult: 'APPLIED' });
  });

  test('FR-049 같은 Idempotency-Key 재시도는 같은 판정이고 라벨을 다시 부르지 않는다', async () => {
    const key = randomUUID();
    const body = { sampleId: REPLAY_SAMPLE, verdict: 'HUMAN', evidenceKinds: [] };
    const first = await app.run({ sampleId: REPLAY_SAMPLE, verdict: 'HUMAN', evidenceKinds: [], actedBy: ACTOR, idem: idem(key, body) });
    const calls = labels.calls.length;
    const same = await app.run({ sampleId: REPLAY_SAMPLE, verdict: 'HUMAN', evidenceKinds: [], actedBy: ACTOR, idem: idem(key, body) });
    expect(same).toEqual(first);
    expect(labels.calls.length).toBe(calls);
    expect(signals.judgements).toHaveLength(1);
  });

  test('[ASVS v5.0.0-16.3.3] 판정과 라벨 반영 결과를 보안 로그 줄로 남기고 pid·기기 가명은 싣지 않는다', async () => {
    await run({ sample: HUMAN_SAMPLE, verdict: 'HUMAN' });
    expect(log.judgements).toEqual([
      { sampleId: HUMAN_SAMPLE, verdict: 'HUMAN', reviewBatch: 'SHADOW_CHALLENGED', label: 'APPLIED', atMs: NOW, accountRef: PSEUDONYM },
    ]);
    const line = JSON.stringify(log.judgements);
    for (const value of ['pid-', 'sess-', 'device', ACTOR]) expect(line).not.toContain(value);
    // 처리자를 넘기지 않으면 로그 가명도 싣지 않는다
    const noRef = new RecordBotReviewJudgement({ store, source, labels, now: () => NOW, signals, log });
    await noRef.run({ sampleId: BOT_SAMPLE, verdict: 'BOT', evidenceKinds: ['CONFIRMED_SIGNAL'], actedBy: ACTOR, idem: idem(randomUUID(), { sample: BOT_SAMPLE }) });
    expect(log.judgements[1]).not.toHaveProperty('accountRef');
  });

  test('[ASVS v5.0.0-16.3.4] 라벨 실패와 원천 실패를 지표·경고 줄로 남긴다', async () => {
    for (const reason of ['unavailable', 'invalid-argument', 'already-exists', 'device-not-found'] as const) {
      labels.answer = new BotReviewLabelFailure(reason);
      expect((await rejectionOf(run({ sample: FAIL_SAMPLE, verdict: 'HUMAN' }))).status).toBe(503);
      expect(signals.failures.at(-1)).toBe(reason);
      expect(log.failures.at(-1)).toMatchObject({ sampleId: FAIL_SAMPLE, reason });
    }
    // 라벨 클라이언트가 아예 없어도 실패를 남긴다
    const noLabels = new RecordBotReviewJudgement({ store, source, now: () => NOW, signals, log });
    expect((await rejectionOf(noLabels.run({ sampleId: REPLAY_SAMPLE, verdict: 'HUMAN', evidenceKinds: [], actedBy: ACTOR, idem: idem(randomUUID(), { sample: REPLAY_SAMPLE }) }))).status).toBe(503);
    expect(signals.failures.at(-1)).toBe('unavailable');
    expect(log.failures.at(-1)).toMatchObject({ reason: 'unavailable' });
    // 성공한 판정은 지표에 verdict·label로 남고 실패 줄은 남기지 않는다
    labels.answer = { changed: true, blockList: 'ADDED' };
    signals.judgements.length = 0;
    log.judgements.length = 0;
    const failures = log.failures.length;
    await run({ sample: REPLAY_SAMPLE, verdict: 'HUMAN' });
    expect(signals.judgements).toEqual([{ verdict: 'HUMAN', label: 'APPLIED' }]);
    expect(log.failures.length).toBe(failures);
  });
});

afterAll(() => undefined);
