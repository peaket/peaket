// inv-ingest를 실제 Kafka(한 대가 두 클러스터 자리)·실제 ClickHouse로 돌린다(F-04-10 빠른 길, docs/streaming.md §6.4).
// 표 DDL·파기(ST-T24 ⑤)·한 여정 적재와 다시 보낸 묶음(ST-T21 ⑩)을 본다.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import avsc from 'avsc';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { avroSchemas, localSchemaIds } from '../../../packages/contracts/src/gen/avro/index.js';
import { encodeConfluent } from '../../../packages/platform/src/avro.js';
import { createKafkaProducer, type KafkaProducer } from '../../../packages/platform/src/stream-worker.js';
import { startKafka, type KafkaContainer } from '../../../packages/platform/test-int/containers.js';
import { ClickHouseHttp } from '../src/clickhouse.js';
import { migrateInv } from '../src/migrate.js';
import { purgeExpired } from '../src/purge.js';
import { localSchemaSource, startInvIngest } from '../src/worker.js';
import { CH_PASSWORD, CH_USER, startClickHouse, type ClickHouseContainer } from './clickhouse.js';

const SVC = fileURLToPath(new URL('..', import.meta.url));
const EVENT_ID = '11111111-1111-7111-8111-111111111111';
const JOURNEY = '22222222-2222-7222-8222-222222222222';
const T0 = Date.parse('2026-12-01T09:00:00.000Z');
const iso = (n: number) => new Date(T0 + n).toISOString();

const TOPICS: Record<string, number> = {
  'investigation.requests': 1,
  'telemetry.queue': 1,
  'telemetry.purchase': 1,
  'telemetry.behavior': 1,
  'telemetry.trust-verdicts': 1,
  'trade.purchase-sessions': 1,
  'trade.seats': 1,
  'trade.orders': 1,
  'trade.payments': 1,
  'trade.tickets': 1,
};

const types = new Map<string, avsc.Type>();
const typeOf = (full: string) => {
  let t = types.get(full);
  if (!t) types.set(full, (t = avsc.Type.forSchema(avroSchemas[full] as avsc.Schema)));
  return t;
};
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

let kafka: KafkaContainer;
let ch: ClickHouseContainer;
let producer: KafkaProducer;
let run: ReturnType<typeof startInvIngest>;

const n = async (sql: string) => Number((await ch.rows<{ c: string }>(sql))[0]!.c);
const send = async (topic: string, values: Buffer[]) => {
  for (let i = 0; i < values.length; i += 100) await producer.send({ topic, messages: values.slice(i, i + 100).map((value) => ({ key: null, value })) });
};
const waitFor = async (cond: () => Promise<boolean>, what: string, ms = 90_000) => {
  const end = Date.now() + ms;
  while (!(await cond().catch(() => false))) {
    if (Date.now() > end) throw new Error(`${what}이(가) ${ms}ms 안에 오지 않았다`);
    await new Promise((r) => setTimeout(r, 300));
  }
};

beforeAll(async () => {
  kafka = await startKafka();
  ch = await startClickHouse();
  for (const [topic, partitions] of Object.entries(TOPICS)) await kafka.createTopic(topic, partitions);
  producer = createKafkaProducer({ brokers: kafka.brokers, clientId: 'f0410-producer', kind: 'default' });
  await producer.connect();
  const http = new ClickHouseHttp({ baseUrl: ch.url, user: CH_USER, password: CH_PASSWORD });
  await migrateInv((sql) => http.exec(sql), fileURLToPath(new URL('../../../data/clickhouse/inv', import.meta.url)), 'single');
  run = startInvIngest({
    env: 'ci',
    pod: 'inv-ingest-it',
    brokers: kafka.brokers,
    schemas: localSchemaSource(),
    clickhouse: http,
    eventDates: new Map([[EVENT_ID, '2026-12-01']]),
    asnTable: { version: 1, hosting: [16509], proxy: [9009] },
    clock: () => Date.parse('2026-12-01T10:00:00.000Z'),
  });
  await run.started;
}, 300_000);

afterAll(async () => {
  await run?.stop().catch(() => {});
  await producer?.disconnect().catch(() => {});
  kafka?.stop();
  ch?.stop();
});

test('ST-T21 ⑩ 실제 Kafka·ClickHouse에서 한 여정과 다시 보낸 묶음이 표 넷에 남는다', async () => {
  const events: [string, string, Record<string, unknown>][] = [
    ['telemetry.queue', 'peaket.telemetry.QueueEntryRecord', { eventId: EVENT_ID, queueEntryId: 'q-1', journeyId: JOURNEY, pid: 'pid-1', entryMode: 'LOBBY', enteredAt: T0, admittedAt: T0 + 3_000, admissionJti: 'jti-1', verifyRoute: 'DIRECT', eventKey: '33333333-3333-7333-8333-333333333331' }],
    ['telemetry.purchase', 'peaket.telemetry.HoldAttempt', { eventId: EVENT_ID, purchaseSessionId: 'ps-1', journeyId: JOURNEY, mode: 'PICK', tierId: 'tier-1', sectionId: 'sec-1', seatIds: ['seat-1', 'seat-2'], result: 'HELD', heldAt: T0 + 5_000, retryNo: 0, latencyMs: 12, occurredAt: T0 + 5_000, eventKey: '33333333-3333-7333-8333-333333333332' }],
    ['trade.seats', 'peaket.trade.SeatEvent', { eventId: EVENT_ID, seatId: 'seat-1', tierId: 'tier-1', sectionId: 'sec-1', type: 'RELEASED', purchaseSessionId: 'ps-1', accountId: 'acct-1', occurredAt: T0 + 7_000, eventKey: '33333333-3333-7333-8333-333333333333' }],
    ['trade.payments', 'peaket.trade.PaymentEvent', { eventId: EVENT_ID, orderId: 'order-1', pg: 'TOSS', type: 'APPROVED', amount: 100_000, paymentMethodRef: 'k1.pay-abc', cardBin: '433028', result: 'APPROVED', attemptNo: 1, latencyMs: 80, occurredAt: T0 + 9_000, eventSeq: 1, eventKey: '33333333-3333-7333-8333-333333333334' }],
    ['trade.orders', 'peaket.trade.OrderEvent', { eventId: EVENT_ID, orderId: 'order-1', accountId: 'acct-1', type: 'CREATED', amount: 200_000, seatIds: ['seat-1', 'seat-2'], purchaseSessionId: 'ps-1', journeyId: JOURNEY, contactRef: 'k1.contact-xyz', occurredAt: T0 + 10_000, eventKey: '33333333-3333-7333-8333-333333333335' }],
    ['trade.orders', 'peaket.trade.OrderEvent', { eventId: EVENT_ID, orderId: 'order-1', accountId: 'acct-1', type: 'CONFIRMED', amount: 200_000, seatIds: ['seat-1', 'seat-2'], purchaseSessionId: 'ps-1', journeyId: JOURNEY, contactRef: 'k1.contact-xyz', occurredAt: T0 + 11_000, eventKey: '33333333-3333-7333-8333-333333333339' }],
    ['trade.tickets', 'peaket.trade.TicketEvent', { ticketId: 'ticket-1', eventId: EVENT_ID, orderId: 'order-1', accountId: 'acct-1', type: 'TRANSFER_ACCEPTED', occurredAt: T0 + 12_000, eventKey: '33333333-3333-7333-8333-333333333336' }],
    ['telemetry.behavior', 'peaket.telemetry.BehaviorSignal', { pid: 'pid-1', deviceRef: 'k1.device-abc', eventId: EVENT_ID, journeyId: JOURNEY, screen: 'SEAT', netClass: 'OTHER', asn: 64500, features: { v: 1, windowMs: 1000, pointerMoves: 12, pointerEntropy: 1.5 }, ts: T0 + 13_000, eventKey: '33333333-3333-7333-8333-333333333337' }],
    ['telemetry.trust-verdicts', 'peaket.telemetry.TrustVerdict', { eventId: EVENT_ID, queueEntryId: 'q-1', pid: 'pid-1', journeyId: JOURNEY, deviceRef: 'k1.device-abc', category: 'PASS', action: 'ALLOW', source: 'REALTIME', occurredAt: T0 + 14_000, eventKey: '33333333-3333-7333-8333-333333333338' }],
  ];
  // 같은 사건을 두 번 보낸다(적어도 한 번 전달)
  for (const [topic, full, value] of events) {
    const bytes = encode(topic, full, value);
    await send(topic, [bytes, bytes]);
  }
  await send('investigation.requests', [
    Buffer.from(JSON.stringify({ ts: iso(0), requestId: 'req-1', gateway: 'GW_QUEUE', routeKind: 'QUEUE_ENTRY', status: 200, ip: '203.0.113.7', eventId: EVENT_ID, accountId: 'acct-1', pid: 'pid-1', asn: 16509 })),
    Buffer.from(JSON.stringify({ ts: iso(0), requestId: 'req-1', gateway: 'GW_QUEUE', routeKind: 'QUEUE_ENTRY', status: 200, ip: '203.0.113.7', eventId: EVENT_ID, accountId: 'acct-1', pid: 'pid-1', asn: 16509 })),
  ]);

  await waitFor(async () => (await n(`SELECT count() c FROM inv.inv_step FINAL WHERE event_id = '${EVENT_ID}'`)) >= 8, 'inv_step 8단계');
  await waitFor(async () => (await n(`SELECT count() c FROM inv.inv_request FINAL WHERE event_id = '${EVENT_ID}'`)) >= 1, 'inv_request 1건');
  const steps = await ch.rows<{ step: string }>(`SELECT step FROM inv.inv_step FINAL WHERE event_id = '${EVENT_ID}' ORDER BY ts`);
  expect(steps.map((s) => s.step)).toEqual(['QUEUE_ENTER', 'ADMIT', 'HOLD_TRY', 'HOLD_END', 'PAY_TRY', 'ORDER', 'SALE', 'TRANSFER']);
  expect(await n(`SELECT count() c FROM inv.inv_step FINAL WHERE event_id = '${EVENT_ID}'`)).toBe(8);
  expect(await n(`SELECT count() c FROM inv.inv_request FINAL WHERE event_id = '${EVENT_ID}'`)).toBe(1);
  const req = (await ch.rows<Record<string, unknown>>(`SELECT request_id, journey_id, pid, ip, net_class FROM inv.inv_request FINAL WHERE event_id = '${EVENT_ID}'`))[0]!;
  expect(req).toMatchObject({ request_id: 'req-1', journey_id: '', pid: 'pid-1', ip: '::ffff:203.0.113.7', net_class: 'HOSTING' });
  expect(await n(`SELECT count() c FROM inv.inv_behavior FINAL WHERE event_id = '${EVENT_ID}'`)).toBe(1);
  const kinds = await ch.rows<{ kind: string }>(`SELECT kind FROM inv.inv_link FINAL WHERE event_id = '${EVENT_ID}' ORDER BY kind`);
  expect(new Set(kinds.map((k) => k.kind))).toEqual(new Set(['ACCOUNT', 'CONTACT', 'DEVICE', 'PID']));
  expect(await n(`SELECT count() c FROM inv.inv_ingest_progress`)).toBeGreaterThanOrEqual(9);
  // 홀드 행에 좌석·잡은 시각, 결제 행에 결제 수단 연결값·BIN
  const rows = await ch.rows<Record<string, unknown>>(`SELECT step, seat_ids, held_at, payment_method_ref, card_bin FROM inv.inv_step FINAL WHERE event_id = '${EVENT_ID}'`);
  expect(rows.find((r) => r.step === 'HOLD_TRY')).toMatchObject({ seat_ids: ['seat-1', 'seat-2'], held_at: '2026-12-01T09:00:05.000Z' });
  expect(rows.find((r) => r.step === 'PAY_TRY')).toMatchObject({ payment_method_ref: 'k1.pay-abc', card_bin: '433028' });
}, 120_000);

test('ST-T24 ⑤ 실제 ClickHouse에서 지난 회차 파티션이 지워지고 날짜가 바뀐 회차는 남는다', async () => {
  const oldId = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
  const movedId = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
  // JSONEachRow로 두 회차를 넣는다. 표의 칸을 모두 채운다
  for (const [eventId, retain] of [
    [oldId, '2026-11-01T00:00:00.000Z'],
    [movedId, '2027-01-31T00:00:00.000Z'],
  ] as const) {
    await ch.query(
      `INSERT INTO inv.inv_request (ts, ingested_at, request_id, event_id, gateway, route_kind, status, ip, asn, net_class, ja4, edge_bot_labels, device_ref, pid, account_id, journey_id, retain_until, ingest_rank) SETTINGS date_time_input_format = 'best_effort' FORMAT JSONEachRow\n` +
        JSON.stringify({ ts: iso(0), ingested_at: iso(0), request_id: `r-${eventId}`, event_id: eventId, gateway: 'GW_QUEUE', route_kind: 'QUEUE_ENTRY', status: 200, ip: '::ffff:203.0.113.9', asn: 1, net_class: 'OTHER', ja4: '', edge_bot_labels: [], device_ref: '', pid: 'pid-9', account_id: 'acct-9', journey_id: '', retain_until: retain, ingest_rank: '1' }) +
        '\n',
    );
  }
  const logs: unknown[] = [];
  const dropped = await purgeExpired({ clickhouse: { rows: (sql, p) => ch.rows(sql, p), exec: (sql, p) => ch.query(sql, p).then(() => undefined) }, now: Date.parse('2026-12-20T00:00:00.000Z'), log: (l) => logs.push(l) });
  expect(dropped.map((d) => d.eventId)).toContain(oldId);
  expect(await n(`SELECT count() c FROM inv.inv_request FINAL WHERE event_id = '${oldId}'`)).toBe(0);
  expect(await n(`SELECT count() c FROM inv.inv_request FINAL WHERE event_id = '${movedId}'`)).toBe(1);
  expect(logs.length).toBeGreaterThanOrEqual(4);
  const partition = await ch.rows<{ partition: string }>(`SELECT partition FROM system.parts WHERE database = 'inv' AND table = 'inv_request' AND active AND partition = '${oldId}'`);
  expect(partition).toHaveLength(0);
}, 120_000);
