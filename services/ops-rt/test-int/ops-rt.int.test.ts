// ops-rt 작업자를 실제 Kafka(컨테이너 한 대가 거래·텔레메트리 두 클러스터 자리를 함께 맡는다)·실제 ClickHouse·시험 레지스트리 HTTP 서버로
// 돌려 관제 실시간 표의 누적·1초 칸·신선도가 정본 규칙대로 나오는지 본다(docs/streaming.md §4·§10, F-04-1 빠른 길).
// 작업자는 빌드한 dist/main.js를 자식 프로세스로 띄운다(강제 종료 ST-T1). 단언 값은 정본에서 적는다.
import { execSync, fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import avsc from 'avsc';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { encodeConfluent } from '../../../packages/platform/src/avro.js';
import { createKafkaProducer, type KafkaProducer } from '../../../packages/platform/src/stream-worker.js';
import { registryState } from '../../../packages/platform/test/schema-registry-fake.js';
import { startKafka, type KafkaContainer } from '../../../packages/platform/test-int/containers.js';
import { startRegistryServer, type RegistryServer } from '../../../packages/platform/test-int/registry-server.js';
import { PULSE_TOPICS, PulseEmitter, pulseEncoder, pulseSubject } from '../../rt-pulse/src/pulse.js';
import { migrateRt } from '../src/migrate.js';
import { CH_PASSWORD, CH_USER, startClickHouse, type ClickHouseContainer } from './clickhouse.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const OPS_RT = fileURLToPath(new URL('..', import.meta.url));
const avscOf = (n: string) => JSON.parse(readFileSync(`${ROOT}docs/api/avro/peaket/${n}.avsc`, 'utf8')) as avsc.Schema & { fields: { name: string; type: unknown }[] };

const SCHEMAS = {
  1: avscOf('trade/SeatEvent'),
  2: avscOf('trade/OrderEvent'),
  3: avscOf('trade/PaymentEvent'),
  4: avscOf('trade/TicketEvent'),
  5: avscOf('telemetry/QueueAggregate'),
  6: avscOf('telemetry/HoldAttempt'),
  7: avscOf('telemetry/TrustVerdict'),
  8: avscOf('telemetry/PipelinePulse'),
} as const;
type SchemaId = keyof typeof SCHEMAS;
const TYPES = Object.fromEntries(Object.entries(SCHEMAS).map(([id, s]) => [id, avsc.Type.forSchema(s)])) as Record<string, avsc.Type>;

/** 계약의 필수 칸을 빈 값으로 채운다(시험이 주는 칸만 뜻이 있다) */
function fill(schema: { fields: { name: string; type: unknown }[] }, v: Record<string, unknown>): Record<string, unknown> {
  const blank = (t: unknown): unknown => {
    if (Array.isArray(t)) return t.includes('null') ? null : blank(t[0]);
    if (typeof t === 'string') return { string: '', long: 0, int: 0, boolean: false }[t] ?? null;
    const o = t as { type: string; symbols?: string[]; logicalType?: string; fields?: { name: string; type: unknown }[] };
    if (o.type === 'enum') return o.symbols!.find((s) => s !== 'UNRECOGNIZED');
    if (o.type === 'array') return [];
    if (o.type === 'record') return fill(o as never, {});
    if (o.logicalType === 'uuid') return randomUUID();
    return blank(o.type);
  };
  return Object.fromEntries(schema.fields.map((f) => [f.name, f.name in v ? v[f.name] : blank(f.type)]));
}
const encode = (id: SchemaId, v: Record<string, unknown>) => encodeConfluent(id, TYPES[id]!.toBuffer(fill(SCHEMAS[id], v)));

const TOPICS: Record<string, number> = {
  'trade.orders': 1,
  'trade.payments': 1,
  'trade.seats': 1,
  'trade.tickets': 1,
  'telemetry.queue': 3,
  'telemetry.purchase': 2,
  'telemetry.trust-verdicts': 1,
};
const EVENT = randomUUID();

let kafka: KafkaContainer;
let ch: ClickHouseContainer;
let registry: RegistryServer;
let producer: KafkaProducer;
const children: ChildProcess[] = [];
let pulse: PulseEmitter | undefined;

const workerEnv = (pod: string) => ({
  ...process.env,
  PEAKET_ENV: 'ci',
  PEAKET_POD: pod,
  PEAKET_KAFKA_BROKERS: kafka.brokers.join(','),
  PEAKET_TELEMETRY_KAFKA_BROKERS: kafka.brokers.join(','),
  PEAKET_SCHEMA_REGISTRY_URL: registry.url,
  PEAKET_RT_CLICKHOUSE_URL: ch.url,
  PEAKET_RT_CLICKHOUSE_USER: CH_USER,
  PEAKET_RT_CLICKHOUSE_PASSWORD: CH_PASSWORD,
  PEAKET_RT_CLICKHOUSE_TOPOLOGY: 'single',
  PEAKET_ADMIN_PORT: '0',
  PEAKET_PROBE_EVENT_IDS: '',
});
const startWorker = (pod: string, args: string[] = []) => {
  const c = fork(`${OPS_RT}dist/main.js`, args, { env: workerEnv(pod), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  children.push(c);
  return c;
};
const kill = async (c: ChildProcess) => {
  if (c.exitCode !== null) return;
  const gone = new Promise((r) => c.once('exit', r));
  c.kill('SIGKILL');
  await gone;
};

const until = async (cond: () => Promise<boolean>, what: string, ms = 90_000) => {
  const end = Date.now() + ms;
  while (!(await cond().catch(() => false))) {
    if (Date.now() > end) throw new Error(`기다린 ${what}이(가) ${ms}ms 안에 오지 않았다`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

async function cumulative(eventId = EVENT): Promise<Record<string, number>> {
  const rows = await ch.rows<{ metric: string; dim: string; value: string }>('SELECT metric, dim, value FROM rt.v_cumulative(event_id = {event_id:String})', { event_id: eventId });
  return Object.fromEntries(rows.map((r) => [r.dim ? `${r.metric}:${r.dim}` : r.metric, Number(r.value)]));
}
const send = async (topic: string, messages: { key?: string; value: Buffer; partition?: number }[]) => {
  for (let i = 0; i < messages.length; i += 500) await producer.send({ topic, messages: messages.slice(i, i + 500) });
};

beforeAll(async () => {
  execSync('npx --no-install tsc -p tsconfig.build.json', { cwd: OPS_RT, stdio: 'ignore' });
  [kafka, ch] = await Promise.all([startKafka(), startClickHouse()]);
  for (const [t, n] of Object.entries(TOPICS)) await kafka.createTopic(t, n);
  registry = await startRegistryServer(registryState(SCHEMAS as unknown as Record<number, unknown>));
  await migrateRt((sql) => ch.query(sql), `${ROOT}data/clickhouse/rt`, 'single');
  producer = createKafkaProducer({ brokers: kafka.brokers, clientId: 'f041-producer', kind: 'default' });
  await producer.connect();
}, 300_000);

afterAll(async () => {
  pulse?.stop();
  for (const c of children) c.kill('SIGKILL');
  await producer?.disconnect().catch(() => {});
  await registry?.close();
  kafka?.stop();
  ch?.stop();
}, 120_000);

const seat = (seatId: string, type: string, eventKey = randomUUID(), occurredAt = Date.now()) =>
  ({ key: EVENT, value: encode(1, { eventId: EVENT, seatId, tierId: 'R', sectionId: 'A', type, occurredAt, eventKey }), eventKey }) as const;

test('F-04-1 ST-T10 좌석 하나 PENDING → SOLD → PENDING(입금 되돌림) → SOLD → RETURNED와 중복·다시 보낸 옛 사건', async () => {
  const w = startWorker('st-t10');
  const steps: [string, number][] = [
    ['PENDING', 0],
    ['SOLD', 1],
    ['PENDING', 0],
    ['SOLD', 1],
    ['RETURNED', 0],
  ];
  const seen: number[] = [];
  let soldKey = '';
  for (const [type, want] of steps) {
    const m = seat('s-t10', type);
    if (type === 'SOLD' && !soldKey) soldKey = m.eventKey;
    // 같은 사건을 두 번(eventKey 같음) 보낸다
    await send('trade.seats', [m, m]);
    await until(async () => (await cumulative())['sold_seats'] === want && (await ch.rows(`SELECT count() c FROM rt.sale_event WHERE seat_id = 's-t10'`))[0] !== undefined, `판매 좌석 ${want}`);
    // 행이 실릴 때까지(중복 포함 두 줄씩) 기다린 뒤 값을 읽는다
    await until(async () => Number((await ch.rows<{ c: string }>(`SELECT count() c FROM rt.sale_event WHERE seat_id = 's-t10'`))[0]!.c) >= (seen.length + 1) * 2, '두 줄 적재');
    seen.push((await cumulative())['sold_seats']!);
  }
  expect(seen).toEqual([0, 1, 0, 1, 0]);
  // 다시 보낸 옛 사건(첫 SOLD의 eventKey 그대로, 지금은 RETURNED 뒤)
  await send('trade.seats', [{ key: EVENT, value: encode(1, { eventId: EVENT, seatId: 's-t10', tierId: 'R', sectionId: 'A', type: 'SOLD', occurredAt: Date.now(), eventKey: soldKey }) }]);
  await until(async () => Number((await ch.rows<{ c: string }>(`SELECT count() c FROM rt.sale_event WHERE seat_id = 's-t10'`))[0]!.c) === 11, '옛 사건 적재');
  expect((await cumulative())['sold_seats']).toBe(0);
  await kill(w);
}, 180_000);

test('F-04-1 ST-T1 같은 거래 사건을 두 번 보내고 처리 중에 작업자를 강제로 종료해도 판매 좌석·금액이 정답과 같다', async () => {
  const N = 3_000;
  const payKeys = Array.from({ length: N }, () => randomUUID());
  const seatMsgs = Array.from({ length: N }, (_, i) => seat(`s-t1-${i}`, 'SOLD'));
  const pays = payKeys.map((eventKey) => ({ key: EVENT, value: encode(3, { eventId: EVENT, orderId: 'o', type: 'APPROVED', amount: 1_000, orderKind: 'TICKET', occurredAt: Date.now(), eventKey }) }));
  const before = (await cumulative())['sold_seats'] ?? 0;
  const a = startWorker('st-t1-a');
  // 앞 절반을 두 번씩 보낸다
  await send('trade.payments', [...pays.slice(0, N / 2), ...pays.slice(0, N / 2)]);
  await send('trade.seats', [...seatMsgs.slice(0, N / 2), ...seatMsgs.slice(0, N / 2)]);
  await until(async () => Number((await ch.rows<{ c: string }>(`SELECT count() c FROM rt.sale_event WHERE source = 'PAYMENT'`))[0]!.c) > 0, '처리 시작');
  // 처리 중에 강제 종료(커밋 전 묶음은 다시 받는다)
  await kill(a);
  await send('trade.payments', [...pays.slice(N / 2), ...pays.slice(N / 2, N / 2 + 200)]);
  await send('trade.seats', seatMsgs.slice(N / 2));
  const b = startWorker('st-t1-b');
  await until(async () => (await cumulative())['sales_amount'] === N * 1_000 && (await cumulative())['sold_seats'] === before + N, '정답 누적', 120_000);
  const raw = Number((await ch.rows<{ c: string }>(`SELECT count() c FROM rt.sale_event WHERE source = 'PAYMENT'`))[0]!.c);
  const c = await cumulative();
  expect(c['sales_amount']).toBe(3_000_000);
  expect(c['sold_seats']).toBe(before + N);
  expect(raw).toBeGreaterThanOrEqual(N + N / 2 + 200);
  console.log(`[F-04-1 ST-T1] 결제 원시 행 ${raw}건(정답 ${N}건), sales_amount=${c['sales_amount']}, sold_seats=${c['sold_seats']}`);
  await kill(b);
}, 240_000);

test('F-04-1 ST-T3·ST-T4 늦은 사건은 제 1초 칸에 들어가고, ClickHouse를 30초 멈춰도 누락이 0이다', async () => {
  const w = startWorker('st-t3');
  const now = Date.now();
  const lates = [5_000, 15_000, 600_000].map((ago) => ({ ago, at: Math.floor((now - ago) / 1000) * 1000 + 300 }));
  await send(
    'telemetry.purchase',
    lates.map((l, i) => ({ key: EVENT, partition: i % 2, value: encode(6, { eventId: EVENT, purchaseSessionId: 'ps', result: 'CONFLICT', tierId: 'R', firstHeldInSession: false, occurredAt: l.at, eventKey: randomUUID() }) })),
  );
  const from = new Date(now - 700_000).toISOString().replace('T', ' ').replace('Z', '');
  const buckets = async () => ch.rows<{ metric: string; dim: string; second: string; value: string }>("SELECT metric, dim, second, value FROM rt.v_bucket(event_id = {event_id:String}, from_ts = {from_ts:DateTime64(3)}) WHERE metric = 'hold_result' ORDER BY second", { event_id: EVENT, from_ts: from });
  await until(async () => (await buckets()).length === 3, '늦은 칸 셋');
  const got = (await buckets()).map((r) => [r.dim, new Date(`${r.second.replace(' ', 'T')}Z`).getTime(), Number(r.value)]);
  expect(got).toEqual(lates.map((l) => ['CONFLICT', Math.floor(l.at / 1000) * 1000, 1]).reverse().sort((x, y) => (x[1] as number) - (y[1] as number)));

  // ST-T4: 멈춘 동안 보낸 사건이 되살린 뒤 모두 실린다
  ch.pause();
  const t4 = Array.from({ length: 500 }, (_, i) => ({ key: EVENT, partition: i % 2, value: encode(6, { eventId: EVENT, purchaseSessionId: 'ps', result: 'HELD', tierId: 'S', firstHeldInSession: true, occurredAt: Date.now(), eventKey: randomUUID() }) }));
  await send('telemetry.purchase', t4);
  await new Promise((r) => setTimeout(r, 30_000));
  ch.unpause();
  await until(async () => (await cumulative())['funnel_first_hold'] === 500, '멈춘 동안 보낸 500건', 120_000);
  expect((await cumulative())['funnel_first_hold_tier:S']).toBe(500);
  await kill(w);
}, 300_000);

test('F-04-1 ST-T7 원시 표를 비운 뒤 다시 채우기(버리는 그룹으로 Kafka 다시 읽기)를 두 번 돌려도 누적이 정답과 같다', async () => {
  const answer = await cumulative();
  expect(answer['sales_amount']).toBe(3_000_000);
  for (const t of ['sale_event', 'queue_aggregate', 'hold_attempt', 'verdict', 'pulse']) await ch.query(`TRUNCATE TABLE rt.${t}`);
  expect((await cumulative())['sold_seats']).toBe(0);
  for (const tag of ['t7-a', 't7-b']) {
    const w = startWorker(`st-t7-${tag}`, ['backfill', tag]);
    await until(async () => {
      const c = await cumulative();
      return c['sales_amount'] === answer['sales_amount'] && c['sold_seats'] === answer['sold_seats'] && c['funnel_first_hold'] === answer['funnel_first_hold'];
    }, `다시 채우기 ${tag}`, 120_000);
    await kill(w);
  }
  const after = await cumulative();
  for (const k of ['sold_seats', 'sales_amount', 'funnel_first_hold', 'sold_seats_tier:R', 'sold_seats_section:A']) expect(after[k]).toBe(answer[k]);
  const raw = Number((await ch.rows<{ c: string }>(`SELECT count() c FROM rt.sale_event WHERE source = 'PAYMENT'`))[0]!.c);
  console.log(`[F-04-1 ST-T7] 두 번 다시 채운 결제 원시 행 ${raw}건, sales_amount=${after['sales_amount']}, sold_seats=${after['sold_seats']}`);
}, 300_000);

test('F-04-1 ST-T2 심장 박동: 켜면 모든 파티션이 신선하고, 한 파티션을 끄면 그 파티션 때문에 신선도가 나빠진다', async () => {
  const w = startWorker('st-t2');
  const ids = Object.fromEntries(PULSE_TOPICS.map((t) => [pulseSubject(t), 8]));
  let skip: { topic: string; partition: number } | undefined;
  pulse = new PulseEmitter({
    encode: pulseEncoder(SCHEMAS[8], ids),
    transport: {
      partitions: async (t) => Array.from({ length: TOPICS[t]! }, (_, i) => i),
      send: async (ms) => {
        for (const t of PULSE_TOPICS) {
          const mine = ms.filter((m) => m.topic === t && !(skip && skip.topic === t && skip.partition === m.partition));
          if (mine.length) await producer.send({ topic: t, messages: mine.map((m) => ({ partition: m.partition, value: m.value })) });
        }
      },
    },
  });
  pulse.start();
  const fresh = async () => {
    const rows = await ch.rows<{ topic: string; kafka_partition: number; last_produced_at: string }>('SELECT topic, kafka_partition, last_produced_at FROM rt.v_freshness');
    const nowMs = Date.now();
    return new Map(rows.map((r) => [`${r.topic}#${r.kafka_partition}`, nowMs - new Date(`${r.last_produced_at.replace(' ', 'T')}Z`).getTime()]));
  };
  // 이 회차의 사건은 텔레메트리 한 파티션에만 온다(나머지는 비어 있다)
  await send('telemetry.queue', [{ key: `${EVENT}:pod-a`, partition: 0, value: encode(5, { eventId: EVENT, second: Math.floor(Date.now() / 1000) * 1000, entries: 7, removed: 0, admissions: 2, eventKey: randomUUID() }) }]);
  await until(async () => (await fresh()).size === 6 && [...(await fresh()).values()].every((ms) => ms < 3_000), '켬: 여섯 파티션 신선');
  const on = await fresh();
  const onWorst = Math.max(...on.values());
  skip = { topic: 'telemetry.queue', partition: 2 };
  await new Promise((r) => setTimeout(r, 7_000));
  const off = await fresh();
  const others = [...off].filter(([k]) => k !== 'telemetry.queue#2').map(([, v]) => v);
  console.log(`[F-04-1 ST-T2] 켬: 가장 늦은 파티션 ${onWorst}ms / 끔: telemetry.queue#2 ${off.get('telemetry.queue#2')}ms, 나머지 최대 ${Math.max(...others)}ms`);
  expect(onWorst).toBeLessThan(3_000);
  expect(off.get('telemetry.queue#2')!).toBeGreaterThan(5_000);
  expect(Math.max(...others)).toBeLessThan(3_000);
  // 1초 칸은 그대로 나온다
  const q = await cumulative();
  expect(q['queue_entries']).toBe(7);
  pulse.stop();
  await kill(w);
}, 180_000);
