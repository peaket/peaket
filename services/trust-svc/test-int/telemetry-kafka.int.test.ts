// 통합 시험: 실제 Kafka(KRaft 한 대)로 판정 기록·행동 신호를 보내고 읽는다(docs/features/bot-defense.md §4.1 ⑤, ADR-0249 결정 4, B-T17).
// 브로커가 멈춰도 판정은 끝나고, 보내지 못한 기록은 버리고 센다(§18, NFR-001). 값은 asyncapi 모양의 JSON 바이트다(Avro는 BAS-030).
import { BehaviorSignal, TrustVerdict } from '@peaket/contracts/asyncapi';
import { fakeClock, kafkaTelemetrySend, TelemetrySink } from '@peaket/platform';
import { createKafkaProducer } from '@peaket/platform/stream-worker';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { JsonTelemetryRecorder } from '../src/modules/scoring/adapters/json-telemetry-recorder.js';
import { MemoryFeatureStore } from '../src/modules/scoring/adapters/memory-feature-store.js';
import { ScoreRisk } from '../src/modules/scoring/application/score-risk.js';
import { EVENT, JOURNEY, recordingHuman, recordingSignals, request, SYNTHETIC_RULES } from '../test/support.js';
import { collectTopics, type KafkaContainer, startKafka, type TopicCollector } from './kafka.js';

const VERDICTS = 'telemetry.trust-verdicts';
const BEHAVIOR = 'telemetry.behavior';

let kafka: KafkaContainer;
let collector: TopicCollector;

beforeAll(async () => {
  kafka = await startKafka();
  await kafka.createTopic(VERDICTS, 1);
  await kafka.createTopic(BEHAVIOR, 1);
  collector = await collectTopics(kafka.brokers, [VERDICTS, BEHAVIOR], 'it-telemetry-reader');
}, 180_000);

afterAll(async () => {
  await collector?.close().catch(() => undefined);
  kafka?.stop();
});

let producers = 0;
function assemble(dropped: string[] = [], o: Parameters<typeof kafkaTelemetrySend>[1] = {}) {
  const send = kafkaTelemetrySend(() => createKafkaProducer({ kind: 'default', brokers: kafka.brokers, clientId: `it-telemetry-${++producers}` }), o);
  const sink = new TelemetrySink({ send, lingerMs: 5, onDropped: (record, n) => dropped.push(`${record}:${n}`) });
  const telemetry = new JsonTelemetryRecorder({ offer: (record, topic, m) => sink.offer(record, topic, m) });
  const score = new ScoreRisk({
    rules: { current: () => SYNTHETIC_RULES, intensity: () => 'BASE' },
    human: recordingHuman(),
    features: new MemoryFeatureStore(),
    devices: { ref: () => 'k1.ref' },
    asn: { classify: () => 'OTHER' },
    recorder: { record: (r) => telemetry.record(r) },
    behaviors: { behavior: (r) => telemetry.behavior(r) },
    signals: recordingSignals(),
    clock: fakeClock({ now: Date.UTC(2026, 10, 9, 1, 0, 0) }),
    after: () => undefined,
  });
  return { score, sink, close: () => sink.close(5_000).then(() => send.disconnect(2_000)) };
}

describe('판정 기록·행동 신호를 실제 Kafka로 보낸다', () => {
  test('[B-T17] 사전검증과로비입장의판정기록·행동신호는_여정ID를싣고_계약모양으로읽힌다', async () => {
    const a = assemble();
    await a.score.run(request());
    await a.score.run(request({ context: 'LOBBY_ENTRY', behavior: undefined }));
    await a.sink.flush();
    await a.close();

    const verdicts = await collector.waitFor((r) => r.topic === VERDICTS, 2);
    const signals = await collector.waitFor((r) => r.topic === BEHAVIOR, 2);
    for (const r of verdicts) {
      const v = TrustVerdict.parse(JSON.parse(r.value!));
      expect(v).toMatchObject({ eventId: EVENT, journeyId: JOURNEY, source: 'REALTIME', shadow: false });
      expect(r.key).toBeNull();
    }
    const screens = signals.map((r) => BehaviorSignal.parse(JSON.parse(r.value!)));
    expect(screens.map((s) => s.screen).sort()).toEqual(['EVENT_DETAIL', 'LOBBY']);
    for (const s of screens) expect(s).toMatchObject({ journeyId: JOURNEY, netClass: 'OTHER', deviceRef: 'k1.ref' });
    for (const r of signals) expect(r.key).not.toBeNull();
  });

  test('[B-T17] [ASVS v5.0.0-16.3.4] 브로커가멈춰도_판정은끝나고_보내지못한기록은버리고센다', async () => {
    const dropped: string[] = [];
    const a = assemble(dropped);
    kafka.pause();
    try {
      await expect(a.score.run(request({ journeyId: JOURNEY }))).resolves.toEqual({ verdict: 'ALLOW', degraded: false });
      await a.close();
      expect(dropped.reduce((n, x) => n + Number(x.split(':')[1]), 0)).toBeGreaterThan(0);
    } finally {
      await kafka.resume();
    }
  }, 60_000);

  test('[B-T17] 브로커가없는동안연결에실패해도_되살아나면새생산자로다시보낸다', async () => {
    const dropped: string[] = [];
    const a = assemble(dropped, { connectTimeoutMs: 1_000, retryAfterMs: 0 });
    kafka.pause();
    try {
      const t0 = Date.now();
      await a.score.run(request());
      await a.sink.flush();
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(dropped.length).toBeGreaterThan(0);
    } finally {
      await kafka.resume();
    }
    const before = collector.records.filter((r) => r.topic === VERDICTS).length;
    await a.score.run(request());
    await a.sink.flush();
    await collector.waitFor((r) => r.topic === VERDICTS, before + 1, 20_000);
    await a.close();
  }, 120_000);
});
