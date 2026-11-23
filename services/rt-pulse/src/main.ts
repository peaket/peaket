// rt-pulse 시작 파일(docs/streaming.md §1, OPS-160, F-04-1). 복제 1개 [가정] Deployment. HTTP 없음(멈추면 신선도가 나빠져 보인다).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTopicsConfigured, createPlatformLogger, kafkaAuthFromEnv, onSigterm, parseSchemaIds, systemClock } from '@peaket/platform';
import { createKafkaAdmin, createKafkaProducer } from '@peaket/platform/stream-worker';
import { PULSE_TOPICS, PulseEmitter, pulseEncoder, pulseSubject } from './pulse.js';

const WORKER = 'rt-pulse';

async function main(env: Record<string, string | undefined>): Promise<void> {
  const missing = ['PEAKET_ENV', 'PEAKET_TELEMETRY_KAFKA_BROKERS', 'PEAKET_SCHEMA_IDS'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`rt-pulse 설정이 비었다: ${missing.join(', ')}`);
  const envName = env.PEAKET_ENV!;
  const pod = env.PEAKET_POD || 'rt-pulse-0';
  const logger = createPlatformLogger({ service: WORKER, env: envName, version: env.PEAKET_VERSION ?? '0.0.0', pod, clock: systemClock, level: 'info' });
  const ids = parseSchemaIds(env.PEAKET_SCHEMA_IDS!);
  assertTopicsConfigured(PULSE_TOPICS.map(pulseSubject), ids);
  const avroDir = env.PEAKET_AVRO_DIR || fileURLToPath(new URL('../../../docs/api/avro', import.meta.url));
  const schema = JSON.parse(readFileSync(join(avroDir, 'peaket', 'telemetry', 'PipelinePulse.avsc'), 'utf8')) as unknown;
  const brokers = env.PEAKET_TELEMETRY_KAFKA_BROKERS!.split(',').map((s) => s.trim()).filter(Boolean);
  const auth = kafkaAuthFromEnv(WORKER, env);
  const clientId = `${WORKER}-${envName}-${pod}`;
  const producer = createKafkaProducer({ brokers, clientId, kind: 'default', ...(auth ? { auth } : {}) });
  const admin = createKafkaAdmin({ brokers, clientId, ...(auth ? { auth } : {}) });
  await Promise.all([producer.connect(), admin.connect()]);
  const emitter = new PulseEmitter({
    encode: pulseEncoder(schema, ids),
    transport: {
      async partitions(topic) {
        const meta = await admin.fetchTopicMetadata({ topics: [topic] });
        return (meta[0]?.partitions ?? []).map((p) => p.partitionId).sort((a, b) => a - b);
      },
      async send(messages) {
        const byTopic = new Map<string, { partition: number; value: Buffer }[]>();
        for (const m of messages) byTopic.set(m.topic, [...(byTopic.get(m.topic) ?? []), { partition: m.partition, value: m.value }]);
        await Promise.all([...byTopic].map(([topic, msgs]) => producer.send({ topic, messages: msgs })));
      },
    },
    onError: (err) => logger.warn({ kind: 'rt-pulse-send-failed', err: err instanceof Error ? err.message : String(err) }, '심장 박동을 보내지 못했다'),
  });
  emitter.start();
  logger.info({ kind: 'rt-pulse-started', topics: PULSE_TOPICS }, 'rt-pulse 시작');
  onSigterm(async () => {
    emitter.stop();
    await producer.disconnect();
    await admin.disconnect();
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.env).catch((err: unknown) => {
    process.stderr.write(`rt-pulse 시작 실패: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
