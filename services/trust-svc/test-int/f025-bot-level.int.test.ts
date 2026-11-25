// 명령 5 강도의 trust-svc 받기를 실제 Kafka로 본다(BUILD_ORDER F-02-5 OPS-300, ADR-0365 결정 19, ADR-0103 결정 2, docs/features/bot-defense.md §4.4 '설정 읽기', 계획 B26·14절 8).
// 시작 파일(main.ts)과 같은 순서로 조립한다: 규칙 다시 읽기 시작 작업(trust-rules) + 제어 설정 읽기(startServiceControlSync(..., { sessions: false })) + bindBotLevelSetting.
// - 정본 값: 설정을 처음부터 읽기 전에는 준비 아님, Kafka에 닿지 못하면 정한 시간 뒤 BASE로 준비·control_sync_lagging{kind="settings"}=1,
//   받은 뒤 control_settings_applied_version{service="trust-svc", key="PLATFORM:BOT_LEVEL:"}가 그 판(occurredAt 밀리초).
// - 준비 시간 한도는 정본 30초 [가정]를 시험에서 1,700ms로 줄인다(코드 기본값과 다르게). 규칙 다시 읽기 간격(5초)은 주입한 타이머로 50ms에 돈다.
// - 판은 자릿수가 넘어가는 두 값(9,999,999,999,999 → 10,000,000,000,000)으로 글 비교 결함을 잡는다.
import 'reflect-metadata';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { Module } from '@nestjs/common';
import { CONTROL_TOPICS, createService, type PlatformService } from '@peaket/platform';
import { createKafkaProducer, startServiceControlSync, type KafkaProducer, type ServiceControlSync } from '@peaket/platform/stream-worker';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { bindBotLevelSetting, RuleBook, startRuleRefresh } from '../src/modules/scoring/index.js';
import { SYNTHETIC_RULES_JSON } from '../test/support.js';
import { startKafka, until, type KafkaContainer } from './kafka.js';

const SERVICE = 'trust-svc';
const KEY = 'PLATFORM:BOT_LEVEL:';
const DEGRADE_MS = 1_700;
const RULES_TASK = 'trust-rules';
const ACTOR = '3b0c8f5e-2d41-4a7e-9f10-6c2e1d4b8a77';
/** 자릿수가 넘어가는 두 판(앞 13자리, 뒤 14자리) */
const V13 = 9_999_999_999_999;
const V14 = 10_000_000_000_000;

@Module({})
class EmptyModule {}

let kafka: KafkaContainer;
let producer: KafkaProducer;

beforeAll(async () => {
  kafka = await startKafka();
  await kafka.createTopic(CONTROL_TOPICS.settings, 3);
  producer = createKafkaProducer({ brokers: kafka.brokers, clientId: 'it-f025-trust-ops', kind: 'outbox-relay' });
  await producer.connect();
}, 180_000);

afterAll(async () => {
  await producer?.disconnect().catch(() => {});
  kafka?.stop();
});

async function publish(value: unknown, occurredAt: number): Promise<void> {
  const body = { commandId: `cmd-${occurredAt}`, key: 'BOT_LEVEL', scope: 'PLATFORM', value, actor: ACTOR, occurredAt: new Date(occurredAt).toISOString(), eventKey: `00000000-0000-4000-8000-${String(occurredAt % 1e12).padStart(12, '0')}` };
  await producer.send({ topic: CONTROL_TOPICS.settings, messages: [{ key: KEY, value: Buffer.from(JSON.stringify(body), 'utf8') }] });
}

interface Pod {
  svc: PlatformService;
  sync: ServiceControlSync;
  book: RuleBook;
  rulesFile: string;
  ready(): Promise<{ statusCode: number; pending: string[] }>;
  metrics(): Promise<string>;
  stop(): void;
}

const pods: Pod[] = [];
afterEach(async () => {
  while (pods.length) {
    const p = pods.pop()!;
    p.stop();
    await p.svc.close().catch(() => {});
    await p.sync.close();
  }
});

/** 시작 파일과 같은 순서의 trust-svc 한 파드. rules: false면 규칙 파일이 아직 없다(규칙 시작 작업이 끝나지 않는다) */
async function pod(name: string, o: { rules?: boolean; degradeAfterMs?: number } = {}): Promise<Pod> {
  const dir = mkdtempSync(join(tmpdir(), 'trust-f025-int-'));
  const rulesFile = join(dir, 'rules.json');
  if (o.rules !== false) writeFileSync(rulesFile, SYNTHETIC_RULES_JSON);
  const svc = await createService({ name: SERVICE, module: EmptyModule, env: { PEAKET_ENV: 'ci', PEAKET_LOG_LEVEL: 'fatal' }, logDestination: new Writable({ write: (_c, _e, cb) => cb() }) });
  const book = new RuleBook(rulesFile);
  const loop = startRuleRefresh({ rules: book, readiness: svc.readiness, task: RULES_TASK, setTimer: (fn) => setTimeout(fn, 50) });
  const sync = startServiceControlSync(svc, { PEAKET_ENV: 'ci', PEAKET_KAFKA_BROKERS: kafka.brokers.join(','), PEAKET_POD: name }, { sessions: false, ...(o.degradeAfterMs !== undefined ? { degradeAfterMs: o.degradeAfterMs, retryMs: 300 } : {}) });
  if (!sync) throw new Error('브로커 주소를 줬는데 제어 소비가 켜지지 않았다');
  const unbind = bindBotLevelSetting(sync.sync.settings, book);
  const p: Pod = {
    svc,
    sync,
    book,
    rulesFile,
    ready: async () => {
      const r = await svc.management.inject({ method: 'GET', url: '/ready' });
      const body = JSON.parse(r.payload) as { pending?: string[] };
      return { statusCode: r.statusCode, pending: [...(body.pending ?? [])].sort() };
    },
    metrics: async () => (await svc.management.inject({ method: 'GET', url: '/metrics' })).payload,
    stop: () => {
      unbind();
      loop.stop();
    },
  };
  pods.push(p);
  return p;
}

function sample(text: string, name: string, labels: Record<string, string>): number | undefined {
  for (const line of text.split('\n')) {
    const m = /^([^{\s]+)(?:\{(.*)\})?\s+(\S+)$/.exec(line);
    if (!m || m[1] !== name) continue;
    const got = Object.fromEntries([...(m[2] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map((x) => [x[1], x[2]]));
    if (Object.entries(labels).every(([k, v]) => got[k] === v)) return Number(m[3]);
  }
  return undefined;
}

describe('F025-TRUST ③ trust-svc 설정 읽기와 준비(ADR-0365 결정 19)', () => {
  test('F025-TRUST ③ 압축 토픽의 BOT_LEVEL 사건을 처음부터 읽고 준비하며, 판 지표는 자릿수가 넘어간 뒤 판이고 강도는 뒤 사건의 것이다', async () => {
    await publish({ level: 'AGGRESSIVE', reassessMode: 'SHADOW' }, V13);
    await publish({ level: 'RELAXED', reassessMode: 'OFF' }, V14);
    const p = await pod('trust-pod-read');
    await until(async () => (await p.ready()).statusCode === 200, '설정·규칙 읽은 뒤 준비', 60_000);
    const m = await p.metrics();
    expect(sample(m, 'control_settings_applied_version', { service: SERVICE, key: KEY })).toBe(V14);
    expect(sample(m, 'control_sync_lagging', { service: SERVICE, kind: 'settings' })).toBe(0);
    expect(p.book.intensity()).toBe('RELAXED');
    // 준비 뒤에 온 사건도 바로 따라간다(STANDARD → BASE)
    await publish({ level: 'STANDARD', reassessMode: 'SHADOW' }, V14 + 1);
    await until(() => p.book.intensity() === 'BASE', 'STANDARD 사건 반영', 15_000);
    await publish({ level: 'AGGRESSIVE', reassessMode: 'SHADOW' }, V14 + 2);
    await until(() => p.book.intensity() === 'STRICT', 'AGGRESSIVE 사건 반영', 15_000);
  }, 120_000);

  test('F025-TRUST ③ 규칙 파일을 읽기 전에는 설정을 다 읽어도 준비가 아니고, 규칙을 읽으면 준비다(두 시작 작업이 다 끝나야 준비)', async () => {
    const p = await pod('trust-pod-norules', { rules: false });
    // 설정 읽기는 끝났다(따라잡음 게이지 0)
    await until(async () => sample(await p.metrics(), 'control_sync_lagging', { service: SERVICE, kind: 'settings' }) === 0 && !(await p.ready()).pending.includes('settings'), '설정 시작 작업 끝', 60_000);
    expect(await p.ready()).toEqual({ statusCode: 503, pending: [RULES_TASK] });
    writeFileSync(p.rulesFile, SYNTHETIC_RULES_JSON);
    await until(async () => (await p.ready()).statusCode === 200, '규칙 읽은 뒤 준비', 15_000);
  }, 120_000);

  test(`F025-TRUST ③ Kafka를 막은 채 띄우면 ${DEGRADE_MS}ms 전에는 준비 아님, 뒤에는 BASE로 준비·control_sync_lagging{kind="settings"}=1이다`, async () => {
    // 앞 시험이 마지막으로 낸 값은 AGGRESSIVE(STRICT)다. 막힌 파드는 그것을 읽지 못해 기본 BASE여야 한다(값 없음 → BASE)
    kafka.pause();
    try {
      const started = Date.now();
      const p = await pod('trust-pod-blocked', { degradeAfterMs: DEGRADE_MS });
      const first = await p.ready();
      expect(first.statusCode).toBe(503);
      expect(first.pending).toContain('settings');
      await until(async () => (await p.ready()).statusCode === 200, '정한 시간 뒤 준비', DEGRADE_MS + 15_000);
      expect(Date.now() - started).toBeGreaterThanOrEqual(DEGRADE_MS - 50);
      const m = await p.metrics();
      expect(sample(m, 'control_sync_lagging', { service: SERVICE, kind: 'settings' })).toBe(1);
      // 막힘이 실제로 있었다: 판 지표가 없다
      expect(sample(m, 'control_settings_applied_version', { service: SERVICE, key: KEY })).toBeUndefined();
      expect(p.book.intensity()).toBe('BASE');
    } finally {
      await kafka.resume();
    }
  }, 120_000);
});
