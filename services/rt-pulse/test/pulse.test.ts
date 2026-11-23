// rt-pulse 심장 박동(docs/streaming.md §3 2, F-04-1 ST-T2).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import avsc from 'avsc';
import { decodeConfluent } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { PULSE_TOPICS, PulseEmitter, pulseEncoder, pulseSubject, type PulseMessage } from '../src/pulse.js';

const schema = JSON.parse(readFileSync(fileURLToPath(new URL('../../../docs/api/avro/peaket/telemetry/PipelinePulse.avsc', import.meta.url)), 'utf8')) as avsc.Schema;
const ids = Object.fromEntries(PULSE_TOPICS.map((t, i) => [pulseSubject(t), 40 + i]));

describe('F-04-1 ST-T2 rt-pulse', () => {
  test('박동 한 번이 토픽 셋의 모든 파티션에 하나씩 PipelinePulse를 Confluent 형식으로 넣는다', async () => {
    const sent: PulseMessage[] = [];
    const parts: Record<string, number[]> = { 'telemetry.queue': [0, 1, 2], 'telemetry.purchase': [0, 1], 'telemetry.trust-verdicts': [0] };
    const e = new PulseEmitter({ encode: pulseEncoder(schema, ids), now: () => 1_700_000_000_123, transport: { partitions: async (t) => parts[t]!, send: async (m) => void sent.push(...m) } });
    expect(await e.beat()).toBe(6);
    expect(sent.map((m) => `${m.topic}#${m.partition}`)).toEqual(['telemetry.queue#0', 'telemetry.queue#1', 'telemetry.queue#2', 'telemetry.purchase#0', 'telemetry.purchase#1', 'telemetry.trust-verdicts#0']);
    const first = decodeConfluent(sent[1]!.value);
    expect(first.schemaId).toBe(40);
    expect(avsc.Type.forSchema(schema).fromBuffer(first.payload)).toEqual({ kind: 'PULSE', topic: 'telemetry.queue', partition: 1, producedAt: 1_700_000_000_123 });
  });

  test('주제 설정에 없는 토픽은 보내지 않고 던진다(배포 순서 오류)', () => {
    expect(() => pulseEncoder(schema, {})('telemetry.queue', 0, 1)).toThrow(/telemetry.queue-peaket.telemetry.PipelinePulse/);
  });

  test('파티션 수는 30초마다 다시 묻는다', async () => {
    let now = 0;
    let asked = 0;
    const e = new PulseEmitter({ encode: () => Buffer.alloc(1), now: () => now, topics: ['telemetry.queue'], transport: { partitions: async () => (asked++, [0]), send: async () => {} } });
    await e.beat();
    now = 29_999;
    await e.beat();
    now = 30_000;
    await e.beat();
    expect(asked).toBe(2);
  });
});
