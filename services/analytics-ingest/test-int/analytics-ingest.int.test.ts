// analytics-ingest를 실제 Kafka(컨테이너 한 대가 두 클러스터 자리)·실제 ClickHouse로 돌린다(F-04-3 빠른 길, docs/streaming.md §6).
// 레지스트리 없이 고정 스키마 ID(@peaket/contracts/avro localSchemaIds)로 내고 읽는다(local·ci 무대와 같다, ADR-0357 결정 4).
// 작업자는 빌드한 dist/main.js를 자식 프로세스로 띄우고(강제 종료), fail-closed만 회차 키 원천을 바꿔 끼우려고 몸 안에서 띄운다.
import { execSync, fork, type ChildProcess } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import avsc from 'avsc';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { avroSchemas, localSchemaIds } from '../../../packages/contracts/src/gen/avro/index.js';
import { encodeConfluent } from '../../../packages/platform/src/avro.js';
import { createKafkaProducer, type KafkaProducer } from '../../../packages/platform/src/stream-worker.js';
import { startKafka, type KafkaContainer } from '../../../packages/platform/test-int/containers.js';
import { ClickHouseHttp } from '../src/clickhouse.js';
import { migrateRt } from '../src/migrate.js';
import { EventPseudonymizer, LocalEventKeySource, PSEUDONYM_DOMAIN, type EventKeySource } from '../src/pseudonym.js';
import { localSchemaSource, startAnalyticsIngest } from '../src/worker.js';
import { CH_PASSWORD, CH_USER, startClickHouse, type ClickHouseContainer } from './clickhouse.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SVC = fileURLToPath(new URL('..', import.meta.url));
const KEY = Buffer.alloc(32, 11);

const TOPICS: Record<string, number> = {
  'trade.orders': 2,
  'trade.payments': 1,
  'trade.seats': 1,
  'trade.purchase-sessions': 1,
  'trade.tickets': 1,
  'trade.settlements': 1,
  'control.settings': 1,
  'telemetry.queue': 2,
  'telemetry.purchase': 1,
  'telemetry.trust-verdicts': 1,
  'investigation.requests': 1,
};

const types = new Map<string, avsc.Type>();
const typeOf = (full: string) => {
  let t = types.get(full);
  if (!t) types.set(full, (t = avsc.Type.forSchema(avroSchemas[full] as avsc.Schema)));
  return t;
};
/** 계약의 필수 칸을 빈 값으로 채운다(시험이 주는 칸만 뜻이 있다) */
function fill(fields: { name: string; type: unknown }[], v: Record<string, unknown>): Record<string, unknown> {
  const blank = (t: unknown): unknown => {
    if (Array.isArray(t)) return t.includes('null') ? null : blank(t[0]);
    if (typeof t === 'string') return { string: '', long: 0, int: 0, boolean: false, double: 0 }[t] ?? null;
    const o = t as { type: string; symbols?: string[]; logicalType?: string; fields?: { name: string; type: unknown }[] };
    if (o.type === 'enum') return o.symbols!.find((s) => s !== 'UNRECOGNIZED');
    if (o.type === 'array') return [];
    if (o.type === 'record') return fill(o.fields!, {});
    if (o.logicalType === 'uuid') return randomUUID();
    return blank(o.type);
  };
  return Object.fromEntries(fields.map((f) => [f.name, f.name in v ? v[f.name] : blank(f.type)]));
}
const encode = (topic: string, full: string, v: Record<string, unknown>) => {
  const id = localSchemaIds[`${topic}-${full}`];
  if (!id) throw new Error(`고정 ID 없음 ${topic}-${full}`);
  const fields = (avroSchemas[full] as { fields: { name: string; type: unknown }[] }).fields;
  return encodeConfluent(id, typeOf(full).toBuffer(fill(fields, v)));
};
const ref = (eventId: string, value: string) => createHmac('sha256', createHmac('sha256', KEY).update(`${PSEUDONYM_DOMAIN}${eventId}`, 'utf8').digest()).update(value, 'utf8').digest('hex');

let kafka: KafkaContainer;
let ch: ClickHouseContainer;
let producer: KafkaProducer;
const children: ChildProcess[] = [];

const env = (pod: string) => ({
  ...process.env,
  PEAKET_ENV: 'ci',
  PEAKET_POD: pod,
  PEAKET_KAFKA_BROKERS: kafka.brokers.join(','),
  PEAKET_TELEMETRY_KAFKA_BROKERS: kafka.brokers.join(','),
  PEAKET_SCHEMA_REGISTRY_URL: '',
  PEAKET_ANALYTICS_CLICKHOUSE_URL: ch.url,
  PEAKET_ANALYTICS_CLICKHOUSE_USER: CH_USER,
  PEAKET_ANALYTICS_CLICKHOUSE_PASSWORD: CH_PASSWORD,
  PEAKET_ANALYTICS_CLICKHOUSE_TOPOLOGY: 'single',
  PEAKET_ANALYTICS_PSEUDONYM_KEY: KEY.toString('base64'),
  PEAKET_ADMIN_PORT: '0',
});
const startWorker = (pod: string, args: string[] = []) => {
  // 시험 실행기의 실행 인자(개발 조건 등)를 물려받지 않게 빈 execArgv로 띄운다: 빌드한 dist가 계약 패키지도 dist로 읽어야 한다
  const c = fork(`${SVC}dist/main.js`, args, { env: env(pod), execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
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
    await new Promise((r) => setTimeout(r, 250));
  }
};
const n = async (sql: string) => Number((await ch.rows<{ c: string }>(sql))[0]!.c);
const send = async (topic: string, messages: { key?: string; value: Buffer; partition?: number }[]) => {
  for (let i = 0; i < messages.length; i += 500) await producer.send({ topic, messages: messages.slice(i, i + 500) });
};
/** 파티션마다 높은 물표(끝 오프셋 + 1) */
async function highWater(topic: string): Promise<Map<number, number>> {
  const { createKafkaAdmin } = await import('../../../packages/platform/src/stream-worker.js');
  const admin = createKafkaAdmin({ brokers: kafka.brokers, clientId: 'f043-admin' });
  await admin.connect();
  try {
    const rows = await admin.fetchTopicOffsets(topic);
    return new Map(rows.map((r) => [r.partition, Number(r.high)]));
  } finally {
    await admin.disconnect();
  }
}
/** 모든 토픽·파티션의 [0, 높은 물표 − 1]이 커버리지 표에 빠짐없이 있다(조사 토픽은 하나도 없다) */
async function coverageGaps(): Promise<string[]> {
  const gaps: string[] = [];
  for (const topic of Object.keys(TOPICS)) {
    if (topic === 'investigation.requests' || topic === 'control.settings') continue;
    for (const [partition, high] of await highWater(topic)) {
      if (high === 0) continue;
      const present = await n(`SELECT uniqExact(offset) c FROM bronze.brz_offset WHERE topic = '${topic}' AND partition = ${partition} AND offset < ${high}`);
      if (present !== high) gaps.push(`${topic}#${partition}: ${present}/${high}`);
    }
  }
  return gaps;
}

beforeAll(async () => {
  execSync('npx --no-install tsc -p tsconfig.build.json', { cwd: SVC, stdio: 'ignore' });
  [kafka, ch] = await Promise.all([startKafka(), startClickHouse()]);
  for (const [t, p] of Object.entries(TOPICS)) await kafka.createTopic(t, p);
  await migrateRt((sql) => ch.query(sql), `${ROOT}data/clickhouse/bronze`, 'single');
  producer = createKafkaProducer({ brokers: kafka.brokers, clientId: 'f043-producer', kind: 'default' });
  await producer.connect();
}, 300_000);

afterAll(async () => {
  for (const c of children) c.kill('SIGKILL');
  await producer?.disconnect().catch(() => {});
  kafka?.stop();
  ch?.stop();
}, 120_000);

const E1 = randomUUID();
const E2 = randomUUID();
const inv = { journeyId: '11111111-1111-4111-8111-111111111111', deviceRef: 'dev-SAME', contactRef: 'contact-SAME', paymentMethodRef: 'pm-SAME', cardBin: '987654' };

test('F-04-3 A-T21 조사 칸이 모두 찬 사건 여섯을 두 회차로 보내면 브론즈에 조사 값이 0건이고 두 회차를 잇는 값이 없다', async () => {
  const w = startWorker('a-t21');
  const now = Date.now();
  for (const ev of [E1, E2]) {
    await send('telemetry.queue', [{ key: ev, value: encode('telemetry.queue', 'peaket.telemetry.QueueEntryRecord', { eventId: ev, queueEntryId: 'qe-1', pid: 'pid-SAME', journeyId: inv.journeyId, enteredAt: now, eventKey: randomUUID() }) }]);
    await send('trade.purchase-sessions', [{ key: ev, value: encode('trade.purchase-sessions', 'peaket.trade.PurchaseSessionStarted', { eventId: ev, purchaseSessionId: 'ps-1', admissionJti: 'jti-1', journeyId: inv.journeyId, startedAt: now, maxStayUntil: now + 1, eventKey: randomUUID() }) }]);
    await send('telemetry.purchase', [{ key: ev, value: encode('telemetry.purchase', 'peaket.telemetry.HoldAttempt', { eventId: ev, purchaseSessionId: 'ps-1', journeyId: inv.journeyId, tierId: 'R', seatIds: ['A-1-1'], result: 'HELD', heldAt: now, firstHeldInSession: true, occurredAt: now, eventKey: randomUUID() }) }]);
    await send('trade.orders', [{ key: ev, value: encode('trade.orders', 'peaket.trade.OrderEvent', { eventId: ev, orderId: 'ord-1', accountId: 'acc-SAME', type: 'CREATED', amount: 10_000, purchaseSessionId: 'ps-1', journeyId: inv.journeyId, contactRef: inv.contactRef, occurredAt: now, eventKey: randomUUID() }) }]);
    await send('trade.payments', [{ key: ev, value: encode('trade.payments', 'peaket.trade.PaymentEvent', { eventId: ev, orderId: 'ord-1', type: 'APPROVED', amount: 10_000, paymentMethodRef: inv.paymentMethodRef, cardBin: inv.cardBin, occurredAt: now, eventSeq: 1, eventKey: randomUUID() }) }]);
    await send('telemetry.trust-verdicts', [{ key: ev, value: encode('telemetry.trust-verdicts', 'peaket.telemetry.TrustVerdict', { eventId: ev, queueEntryId: 'qe-1', pid: 'pid-SAME', journeyId: inv.journeyId, deviceRef: inv.deviceRef, category: 'PASS', occurredAt: now, eventKey: randomUUID() }) }]);
  }
  // 조사 토픽에도 하나(읽지 않아야 한다)
  await send('investigation.requests', [{ value: Buffer.from('{"ip":"203.0.113.9","ja4":"t13d"}') }]);
  const tables = ['brz_queue_entry', 'brz_purchase_session', 'brz_hold_attempt', 'brz_order_event', 'brz_payment_event', 'brz_trust_verdict'];
  await until(async () => (await Promise.all(tables.map((t) => n(`SELECT count() c FROM bronze.${t}`)))).every((c) => c === 2), '여섯 표 두 회차');
  const payloads = (await ch.rows<{ t: string; event_id: string; payload: string }>(`SELECT 'x' t, event_id, payload FROM merge('bronze', '^brz_(queue_entry|purchase_session|hold_attempt|order_event|payment_event|trust_verdict)$')`)).map((r) => r);
  const all = payloads.map((r) => r.payload).join('\n');
  for (const v of [...Object.values(inv), 'pid-SAME', 'acc-SAME', 'ord-1', 'ps-1', 'jti-1', 'qe-1']) expect(all, `원문 ${v}`).not.toContain(v);
  for (const k of ['journeyId', 'deviceRef', 'contactRef', 'paymentMethodRef', 'cardBin']) expect(all).not.toContain(`"${k}"`);
  const order = payloads.filter((r) => r.payload.includes('"type":"CREATED"'));
  const acc = new Map(order.map((r) => [r.event_id, (JSON.parse(r.payload) as { accountId: string }).accountId]));
  expect(acc.get(E1)).toBe(ref(E1, 'acc-SAME'));
  expect(acc.get(E2)).toBe(ref(E2, 'acc-SAME'));
  expect(acc.get(E1)).not.toBe(acc.get(E2));
  const hold = (await ch.rows<{ payload: string }>(`SELECT payload FROM bronze.brz_hold_attempt WHERE event_id = '${E1}'`))[0]!;
  expect(JSON.parse(hold.payload)).toMatchObject({ seatIds: ['A-1-1'], heldAt: now });
  expect(await n(`SELECT count() c FROM bronze.brz_offset WHERE topic = 'investigation.requests'`)).toBe(0);
  console.log(`[F-04-3 A-T21] 브론즈 여섯 표 × 두 회차 = ${payloads.length}행, 조사 값 0건, 회차별 계정 가명 ${acc.get(E1)!.slice(0, 12)}… ≠ ${acc.get(E2)!.slice(0, 12)}…`);
  await kill(w);
}, 180_000);

test('F-04-3 쓰기 뒤 커밋: 사건 2,000건과 심장 박동·1초 집계·읽지 못하는 값을 섞어 보내는 중에 강제 종료해도 커버리지에 빈 곳이 없다', async () => {
  const N = 2_000;
  const orders = Array.from({ length: N }, (_, i) => ({ key: i % 2 ? E1 : E2, value: encode('trade.orders', 'peaket.trade.OrderEvent', { eventId: i % 2 ? E1 : E2, orderId: `o-${i}`, accountId: `a-${i}`, type: 'CONFIRMED', amount: 1, occurredAt: Date.now(), eventKey: randomUUID() }) }));
  const a = startWorker('commit-a');
  await send('trade.orders', orders.slice(0, N / 2));
  await send('telemetry.queue', [
    { partition: 0, value: encode('telemetry.queue', 'peaket.telemetry.PipelinePulse', { kind: 'PULSE', topic: 'telemetry.queue', partition: 0, producedAt: Date.now() }) },
    { partition: 1, value: encode('telemetry.queue', 'peaket.telemetry.QueueAggregate', { eventId: E1, second: Date.now(), entries: 3, removed: 0, admissions: 1, soonResponses: 0, eventKey: randomUUID() }) },
    { partition: 1, value: Buffer.from('not avro') },
  ]);
  await until(async () => (await n(`SELECT count() c FROM bronze.brz_order_event WHERE record = 'OrderEvent' AND payload LIKE '%CONFIRMED%'`)) > 0, '처리 시작');
  await kill(a);
  await send('trade.orders', orders.slice(N / 2));
  const b = startWorker('commit-b');
  await until(async () => (await n(`SELECT uniqExact(event_key) c FROM bronze.brz_order_event WHERE payload LIKE '%CONFIRMED%'`)) === N, `확정 주문 ${N}건`, 120_000);
  await until(async () => (await coverageGaps()).length === 0, '커버리지 빈 곳 없음', 60_000);
  const raw = await n(`SELECT count() c FROM bronze.brz_order_event WHERE payload LIKE '%CONFIRMED%'`);
  const rejected = await ch.rows<{ error_class: string }>(`SELECT error_class FROM bronze.brz_rejected`);
  expect(rejected.map((r) => r.error_class)).toEqual(['DESERIALIZE']);
  expect(await n(`SELECT count() c FROM bronze.brz_offset WHERE outcome = 'SKIPPED' AND reason IN ('PipelinePulse','QueueAggregate')`)).toBeGreaterThanOrEqual(2);
  console.log(`[F-04-3 커밋] 확정 주문 고유 ${N}건(원시 ${raw}행), 거절 ${rejected.length}건(DESERIALIZE), 커버리지 빈 곳 0`);
  await kill(b);
}, 240_000);

test('F-04-3 ST-T22 회차 키를 얻지 못하는 동안 아무 행도 쓰지 않고 그 파티션을 멈췄다가, 키가 돌아오면 가명으로 싣는다(원문 0건)', async () => {
  const E3 = randomUUID();
  let down = true;
  let calls = 0;
  const local = new LocalEventKeySource(KEY, 'local-v1');
  const src: EventKeySource = { version: 'local-v1', eventKey: async (e) => (calls++, down ? Promise.reject(new Error('kms down')) : local.eventKey(e)) };
  const run = startAnalyticsIngest({
    env: 'ci',
    pod: 'st-t22',
    tradeBrokers: kafka.brokers,
    telemetryBrokers: kafka.brokers,
    schemas: localSchemaSource(),
    clickhouse: new ClickHouseHttp({ baseUrl: ch.url, user: CH_USER, password: CH_PASSWORD }),
    pseudonyms: new EventPseudonymizer(src),
    probeEvents: new Set(),
    backfillTag: 'st-t22',
    maxWaitMs: 200,
  });
  await run.started;
  await send('trade.tickets', [{ key: E3, value: encode('trade.tickets', 'peaket.trade.TicketEvent', { ticketId: 'tk-RAW', eventId: E3, orderId: 'ord-RAW', accountId: 'acc-RAW', type: 'ISSUED', occurredAt: Date.now(), eventKey: randomUUID() }) }]);
  await until(async () => calls >= 2, '키 다시 시도');
  await new Promise((r) => setTimeout(r, 2_000));
  expect(await n(`SELECT count() c FROM bronze.brz_ticket_event WHERE event_id = '${E3}'`)).toBe(0);
  const triedWhileDown = calls;
  down = false;
  await until(async () => (await n(`SELECT count() c FROM bronze.brz_ticket_event WHERE event_id = '${E3}'`)) === 1, '키가 돌아온 뒤 적재');
  const payload = (await ch.rows<{ payload: string }>(`SELECT payload FROM bronze.brz_ticket_event WHERE event_id = '${E3}'`))[0]!.payload;
  expect(payload).not.toMatch(/tk-RAW|ord-RAW|acc-RAW/);
  expect(JSON.parse(payload).ticketId).toBe(ref(E3, 'tk-RAW'));
  console.log(`[F-04-3 ST-T22] 키 실패 동안 다시 시도 ${triedWhileDown}번·적재 0행, 돌아온 뒤 1행(가명만)`);
  await run.stop();
}, 180_000);

test('F-04-3 다시 적재: 브론즈를 비우고 버리는 그룹으로 다시 읽으면 같은 고유 사건 수와 빈 곳 없는 커버리지로 돌아온다', async () => {
  const before = await n(`SELECT uniqExact(event_key) c FROM bronze.brz_order_event`);
  for (const t of ['brz_order_event', 'brz_payment_event', 'brz_queue_entry', 'brz_purchase_session', 'brz_hold_attempt', 'brz_trust_verdict', 'brz_ticket_event', 'brz_offset', 'brz_rejected']) await ch.query(`TRUNCATE TABLE bronze.${t}`);
  const w = startWorker('replay', ['backfill', 'replay-1']);
  await until(async () => (await n(`SELECT uniqExact(event_key) c FROM bronze.brz_order_event`)) === before, `주문 고유 ${before}건 다시`, 120_000);
  await until(async () => (await coverageGaps()).length === 0, '다시 적재 뒤 커버리지', 60_000);
  console.log(`[F-04-3 다시 적재] 주문 고유 ${before}건 그대로, 커버리지 빈 곳 0`);
  await kill(w);
}, 240_000);
