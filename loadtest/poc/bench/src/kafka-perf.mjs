// Kafka 기본 클라이언트 PoC(docs/architecture.md §9.4 'Kafka 클라이언트 런타임', 기술 검토 낮음-152, ADR-0142 결정 3).
// 브로커는 Kafka 3.9.2 셋(KRaft, 복제 3, min.insync.replicas 2). 생산자 설정은 플랫폼 공용 설정 함수(packages/platform kafka-config.ts)와
// 같은 값을 그대로 쓴다(acks=all, 멱등, 동시 5, murmur2_random, 전달 상한).
// --case mixed: 텔레메트리 피크 초당 5,600건 [추정](docs/streaming.md §5)과 거래 토픽 초당 300건(NFR-005 결제 접수 피크)을 함께 넣어
//               메시지마다 보내기 지연(보내기로 한 시각 → 브로커 확인)을 잰다.
// --case max: 텔레메트리 생산자 하나의 최대 처리량(묶음 100건씩, 닫힌 모델)
// --case batch: eachMessage 소비 처리량을 js.consumer.max.batch.size 값마다 잰다
// --case admin: 소비자가 도는 같은 프로세스에서 관리 연결 fetchOffsets를 0.25초마다 30초 부른다(Windows에서 프로세스가 죽었다, ST-T18)
import ck from '@confluentinc/kafka-javascript';
import { closedLoop, hostDelta, hostSample, now, openLoop, parseArgs, procCpu, sleep, writeResult } from './lib.mjs';

const { KafkaJS } = ck;
const a = parseArgs();
const brokers = (a.brokers ?? 'kafka-1:9092,kafka-2:9092,kafka-3:9092').split(',');
const durationS = Number(a.duration ?? 60);
const warmupS = Number(a.warmup ?? 15);
const kafka = new KafkaJS.Kafka({});
const REQUIRED = { acks: 'all', 'enable.idempotence': true, 'max.in.flight.requests.per.connection': 5, partitioner: 'murmur2_random' };
const producer = (clientId, timeoutMs, extra = {}) => kafka.producer({ kafkaJS: { brokers, clientId }, ...REQUIRED, 'message.timeout.ms': timeoutMs, ...extra });
const consumer = (clientId, groupId, extra = {}) =>
  kafka.consumer({ kafkaJS: { brokers, clientId }, 'group.id': groupId, 'group.protocol': 'classic', 'enable.auto.commit': false, 'partition.assignment.strategy': 'cooperative-sticky', 'session.timeout.ms': 45_000, 'auto.offset.reset': 'earliest', ...extra });

async function ensureTopics(topics) {
  const admin = kafka.admin({ kafkaJS: { brokers, clientId: 'poc-admin' } });
  await admin.connect();
  const have = new Set(await admin.listTopics());
  const want = topics.filter((t) => !have.has(t.topic));
  if (want.length) await admin.createTopics({ topics: want.map((t) => ({ topic: t.topic, numPartitions: t.partitions, replicationFactor: 3, configEntries: [{ name: 'min.insync.replicas', value: '2' }] })) });
  await admin.disconnect();
}
const payload = (n) => Buffer.alloc(n, 120);

const out = { test: 'kafka-client', case: a.case, client: '@confluentinc/kafka-javascript 1.11.0', brokers };
const host0 = hostSample();
const cpu = procCpu();

if (a.case === 'mixed') {
  await ensureTopics([{ topic: 'poc.telemetry', partitions: 12 }, { topic: 'poc.trade', partitions: 6 }]);
  // 텔레메트리 생산자는 묶음 지연을 조금 준다(linger 5ms [가정]), 거래 생산자(Outbox 릴레이)는 기본값
  const tel = producer('poc-telemetry', 5_000, { 'linger.ms': 5 });
  const trade = producer('poc-trade', 10_000);
  await Promise.all([tel.connect(), trade.connect()]);
  const telRate = Number(a['tel-rate'] ?? 5600);
  const tradeRate = Number(a['trade-rate'] ?? 300);
  const tv = payload(300);
  const xv = payload(500);
  const [t, x] = await Promise.all([
    openLoop({ rate: telRate, durationS: warmupS + durationS, warmupS, maxInflight: 50_000, op: (i) => tel.send({ topic: 'poc.telemetry', messages: [{ key: `k${i % 5000}`, value: tv }] }) }),
    openLoop({ rate: tradeRate, durationS: warmupS + durationS, warmupS, maxInflight: 10_000, op: (i) => trade.send({ topic: 'poc.trade', messages: [{ key: `order-${i % 997}`, value: xv }] }) }),
  ]);
  out.telemetry = t;
  out.trade = x;
  await Promise.all([tel.disconnect(), trade.disconnect()]);
  out.bench = { p99_ms: x.latency.p99_ms, error_rate: (t.errors + x.errors) / Math.max(1, t.measured + x.measured), requests: t.measured + x.measured, dropped: t.dropped + x.dropped };
} else if (a.case === 'max') {
  await ensureTopics([{ topic: 'poc.telemetry', partitions: 12 }]);
  const tel = producer('poc-telemetry-max', 5_000, { 'linger.ms': 5 });
  await tel.connect();
  const tv = payload(300);
  const batch = Array.from({ length: 100 }, (_, i) => ({ key: `k${i}`, value: tv }));
  const r = await closedLoop({ conc: Number(a.conc ?? 64), durationS, warmupS, op: () => tel.send({ topic: 'poc.telemetry', messages: batch }) });
  out.max = { ...r, messages_per_s: r.throughput_per_s * 100 };
  await tel.disconnect();
  out.bench = { p99_ms: r.latency.p99_ms, error_rate: r.errors / Math.max(1, r.completed + r.errors), requests: r.completed * 100, dropped: 0, throughput_per_s: out.max.messages_per_s };
} else if (a.case === 'batch') {
  const topic = 'poc.consume';
  const n = Number(a.messages ?? 200_000);
  await ensureTopics([{ topic, partitions: 6 }]);
  const p = producer('poc-fill', 30_000, { 'linger.ms': 20 });
  await p.connect();
  const v = payload(300);
  for (let i = 0; i < n; i += 1000) await p.send({ topic, messages: Array.from({ length: 1000 }, (_, j) => ({ key: `k${(i + j) % 10_000}`, value: v })) });
  await p.disconnect();
  out.batch = [];
  // serial: 사건마다 처리를 기다린다. keyed: 키 단위 소비자처럼 파티션마다 32개 [가정]까지 함께 처리한다(packages/platform keyed-consumer.ts)
  const mode = a.mode ?? 'keyed';
  out.mode = mode;
  for (const size of (a.sizes ?? '32,1,128,-1').split(',').map(Number)) {
    const c = consumer(`poc-batch-${size}`, `poc-batch-${size}-${Date.now()}`, { 'js.consumer.max.batch.size': size });
    await c.connect();
    await c.subscribe({ topics: [topic] });
    let got = 0;
    let first = 0;
    const done = new Promise((resolve) => {
      const slots = new Map();
      const finish = () => {
        got += 1;
        if (got === n) resolve();
      };
      void c.run({
        partitionsConsumedConcurrently: 4,
        eachMessage: async ({ partition }) => {
          if (first === 0) first = now();
          // 처리기 하나의 일(저장소 왕복을 흉내 낸 1ms [가정])
          if (mode === 'serial') {
            await sleep(1);
            finish();
            return;
          }
          const s = slots.get(partition) ?? { n: 0, wait: [] };
          slots.set(partition, s);
          while (s.n >= 32) await new Promise((r) => s.wait.push(r));
          s.n += 1;
          void sleep(1).then(() => {
            s.n -= 1;
            s.wait.shift()?.();
            finish();
          });
        },
      });
    });
    const t0 = now();
    await Promise.race([done, sleep(600_000)]);
    const secs = (now() - (first || t0)) / 1e9;
    out.batch.push({ size, consumed: got, seconds: Math.round(secs * 10) / 10, messages_per_s: Math.round(got / secs) });
    await c.disconnect();
  }
  out.bench = { p99_ms: null, error_rate: 0, requests: n * out.batch.length, dropped: 0 };
} else if (a.case === 'admin') {
  const topic = 'poc.admin';
  await ensureTopics([{ topic, partitions: 4 }]);
  const p = producer('poc-admin-fill', 10_000);
  await p.connect();
  const c = consumer('poc-admin-c', 'poc-admin-g');
  await c.connect();
  await c.subscribe({ topics: [topic] });
  let got = 0;
  void c.run({ partitionsConsumedConcurrently: 4, eachMessage: async () => void (got += 1) });
  const admin = kafka.admin({ kafkaJS: { brokers, clientId: 'poc-admin-poll' } });
  await admin.connect();
  let calls = 0;
  const end = now() + 30e9;
  while (now() < end) {
    await p.send({ topic, messages: Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, value: payload(50) })) });
    await admin.fetchOffsets({ groupId: 'poc-admin-g', topics: [topic] }).catch(() => {});
    calls += 1;
    await sleep(250);
  }
  out.admin = { fetch_offsets_calls: calls, consumed: got, crashed: false };
  await admin.disconnect();
  await c.disconnect();
  await p.disconnect();
  out.bench = { p99_ms: null, error_rate: 0, requests: calls, dropped: 0 };
}

out.generator_cpu_pct = cpu();
out.host = hostDelta(host0, hostSample());
writeResult(a.out, out);
process.exit(0);
