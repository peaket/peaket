// inv-ingest 매핑 시험(docs/streaming.md §6.4·§10 ST-T21, docs/data.md '부정 예매 사후 조사의 표', F-04-10).
// [ASVS v5.0.0-1.4.2] 정수·범위, [ASVS v5.0.0-1.5.2] JSON 허용 목록, [ASVS v5.0.0-2.2.1] 입력 허용 목록.
import { describe, expect, test } from 'vitest';
import { InvSink, type DecodedInvEvent } from '../src/sink.js';
import { invRowKey, mapEvent, type InvContext } from '../src/records.js';

const ms = (iso: string) => Date.parse(iso);
const EVENT_ID = '11111111-1111-7111-8111-111111111111';
const JOURNEY = '22222222-2222-7222-8222-222222222222';
const INGESTED = '2026-12-01T10:00:00.000Z';
const RETAIN = '2026-12-31T00:00:00.000Z';

const ctx: InvContext = {
  ingestedAt: ms(INGESTED),
  eventDates: new Map([[EVENT_ID, '2026-12-01']]),
  asnTable: { version: 1, hosting: [16509], proxy: [9009] },
};

const queue = (over: Record<string, unknown> = {}) => ({
  eventId: EVENT_ID,
  queueEntryId: 'q-1',
  journeyId: JOURNEY,
  pid: 'pid-1',
  number: 1,
  entryMode: 'LOBBY',
  enteredAt: ms('2026-12-01T09:00:00.000Z'),
  firstEtaSec: null,
  turnAt: null,
  admittedAt: ms('2026-12-01T09:00:03.000Z'),
  admissionJti: 'jti-1',
  removedAt: null,
  removeReason: null,
  verifyRoute: 'DIRECT',
  eventKey: '33333333-3333-7333-8333-333333333331',
  ...over,
});
const hold = (over: Record<string, unknown> = {}) => ({
  eventId: EVENT_ID,
  purchaseSessionId: 'ps-1',
  journeyId: JOURNEY,
  mode: 'PICK',
  tierId: 'tier-1',
  sectionId: 'sec-1',
  seatIds: ['seat-1', 'seat-2'],
  result: 'HELD',
  autoResult: null,
  heldAt: ms('2026-12-01T09:00:05.000Z'),
  firstHeldInSession: true,
  retryNo: 0,
  latencyMs: 12,
  occurredAt: ms('2026-12-01T09:00:05.000Z'),
  eventKey: '33333333-3333-7333-8333-333333333332',
  ...over,
});
const seat = (over: Record<string, unknown> = {}) => ({
  eventId: EVENT_ID,
  seatId: 'seat-1',
  tierId: 'tier-1',
  sectionId: 'sec-1',
  type: 'RELEASED',
  fencingToken: null,
  sectionVersion: null,
  seatEpoch: null,
  holdId: null,
  holdKind: null,
  purchaseSessionId: 'ps-1',
  priorityGrantId: null,
  accountId: 'acct-1',
  expiresAt: null,
  occurredAt: ms('2026-12-01T09:00:07.000Z'),
  eventKey: '33333333-3333-7333-8333-333333333333',
  holdLimit: null,
  ...over,
});
const payment = (over: Record<string, unknown> = {}) => ({
  eventId: EVENT_ID,
  orderId: 'order-1',
  pg: 'TOSS',
  type: 'APPROVED',
  amount: 100_000,
  payMethodCategory: 'CARD',
  paymentMethodRef: 'k1.pay-abc',
  cardBin: '433028',
  refMissing: false,
  result: 'APPROVED',
  failureCategory: null,
  attemptNo: 1,
  latencyMs: 80,
  occurredAt: ms('2026-12-01T09:00:09.000Z'),
  eventSeq: 1,
  eventKey: '33333333-3333-7333-8333-333333333334',
  depositDueAt: null,
  orderKind: 'TICKET',
  ...over,
});
const order = (over: Record<string, unknown> = {}) => ({
  eventId: EVENT_ID,
  orderId: 'order-1',
  accountId: 'acct-1',
  type: 'CREATED',
  amount: 200_000,
  refundAmount: null,
  fanNoticeReason: null,
  postponedTo: null,
  refundWindowClosesAt: null,
  seatIds: ['seat-1', 'seat-2'],
  purchaseSessionId: 'ps-1',
  journeyId: JOURNEY,
  contactRef: 'k1.contact-xyz',
  refMissing: false,
  items: [],
  seatAssignment: 'PICK',
  firstInStage: true,
  occurredAt: ms('2026-12-01T09:00:10.000Z'),
  eventKey: '33333333-3333-7333-8333-333333333335',
  ...over,
});
const ticket = (over: Record<string, unknown> = {}) => ({
  ticketId: 'ticket-1',
  eventId: EVENT_ID,
  orderId: 'order-1',
  accountId: 'acct-1',
  type: 'TRANSFER_ACCEPTED',
  scanId: null,
  scanResult: null,
  reason: null,
  gateZone: null,
  direction: null,
  scannedAt: null,
  occurredAt: ms('2026-12-01T09:00:12.000Z'),
  eventKey: '33333333-3333-7333-8333-333333333336',
  ...over,
});
const request = (over: Record<string, unknown> = {}) => ({
  ts: '2026-12-01T09:00:00.000Z',
  requestId: 'req-1',
  gateway: 'GW_QUEUE',
  routeKind: 'QUEUE_ENTRY',
  status: 200,
  ip: '203.0.113.7',
  eventId: EVENT_ID,
  accountId: 'acct-1',
  pid: 'pid-1',
  asn: 16509,
  ja4: 't13d1516h2_8daaf6152771_b186095e22b6',
  edgeBotLabels: ['bot:verified'],
  ...over,
});
const behavior = (over: Record<string, unknown> = {}) => ({
  pid: 'pid-1',
  deviceRef: 'k1.device-abc',
  refMissing: false,
  eventId: EVENT_ID,
  journeyId: JOURNEY,
  screen: 'SEAT',
  netClass: 'OTHER',
  asn: 64500,
  features: { v: 1, windowMs: 1000, pointerMoves: 12, pointerEntropy: 1.5, inputIntervalMeanMs: 120, inputIntervalStdMs: 10, scrollEvents: 2, scrollDistancePx: 300 },
  ts: ms('2026-12-01T09:00:13.000Z'),
  eventKey: '33333333-3333-7333-8333-333333333337',
  ...over,
});
const verdict = (over: Record<string, unknown> = {}) => ({
  eventId: EVENT_ID,
  queueEntryId: 'q-1',
  pid: 'pid-1',
  journeyId: JOURNEY,
  deviceRef: 'k1.device-abc',
  refMissing: false,
  category: 'PASS',
  action: 'ALLOW',
  source: 'REALTIME',
  shadow: false,
  reviewBatch: null,
  appliedVerdict: null,
  pairedEventKey: null,
  occurredAt: ms('2026-12-01T09:00:14.000Z'),
  eventKey: '33333333-3333-7333-8333-333333333338',
  ...over,
});

const map = (record: string, value: Record<string, unknown>, c = ctx) => mapEvent(record, value, c);
const rowsOf = (record: string, value: Record<string, unknown>) => map(record, value).rows;

describe('ST-T21 inv 적재 매핑', () => {
  test('ST-T21 ① 한 여정의 단계가 차례대로 남고 같은 묶음을 다시 보내도 늘지 않는다', () => {
    const events: [string, Record<string, unknown>][] = [
      ['QueueEntryRecord', queue()],
      ['HoldAttempt', hold()],
      ['SeatEvent', seat()],
      ['PaymentEvent', payment()],
      ['OrderEvent', order()],
      ['OrderEvent', order({ type: 'CONFIRMED', occurredAt: ms('2026-12-01T09:00:11.000Z'), eventKey: '33333333-3333-7333-8333-333333333339' })],
      ['TicketEvent', ticket()],
    ];
    const steps = events.flatMap(([r, v]) => rowsOf(r, v).filter((x) => x.table === 'inv.inv_step'));
    expect(steps.map((s) => s.row.step)).toEqual(['QUEUE_ENTER', 'ADMIT', 'HOLD_TRY', 'HOLD_END', 'PAY_TRY', 'ORDER', 'SALE', 'TRANSFER']);
    expect(steps.map((s) => s.row.source_key)).toEqual([
      '33333333-3333-7333-8333-333333333331:QUEUE_ENTER',
      '33333333-3333-7333-8333-333333333331:ADMIT',
      '33333333-3333-7333-8333-333333333332:HOLD_TRY',
      '33333333-3333-7333-8333-333333333333:HOLD_END',
      '33333333-3333-7333-8333-333333333334:PAY_TRY',
      '33333333-3333-7333-8333-333333333335:ORDER',
      '33333333-3333-7333-8333-333333333339:SALE',
      '33333333-3333-7333-8333-333333333336:TRANSFER',
    ]);
    // 같은 묶음을 한 번 더 매핑해도 정렬 키가 같다(ReplacingMergeTree가 지운다)
    const again = events.flatMap(([r, v]) => rowsOf(r, v));
    expect(again.map((x) => invRowKey(x.table, x.row))).toEqual(events.flatMap(([r, v]) => rowsOf(r, v)).map((x) => invRowKey(x.table, x.row)));
    expect(new Set(steps.map((s) => s.row.source_key)).size).toBe(steps.length);
  });

  test('ST-T21 ② 홀드 행에 좌석·잡은 시각, 결제 행에 결제 수단 연결값·BIN이 있다', () => {
    const [holdRow] = rowsOf('HoldAttempt', hold());
    expect(holdRow).toMatchObject({
      table: 'inv.inv_step',
      row: {
        step: 'HOLD_TRY',
        seat_ids: ['seat-1', 'seat-2'],
        held_at: '2026-12-01T09:00:05.000Z',
        result: 'HELD',
        purchase_session_id: 'ps-1',
        journey_id: JOURNEY,
        ingested_at: INGESTED,
        retain_until: RETAIN,
      },
    });
    const [payRow] = rowsOf('PaymentEvent', payment());
    expect(payRow!.row).toMatchObject({
      step: 'PAY_TRY',
      order_id: 'order-1',
      payment_method_ref: 'k1.pay-abc',
      card_bin: '433028',
      result: 'APPROVED',
    });
    // 좌석 없는 홀드 시도는 빈 배열, held_at 없음은 빈 글
    const [none] = rowsOf('HoldAttempt', hold({ seatIds: null, heldAt: null, result: 'CONFLICT' }));
    expect(none!.row).toMatchObject({ seat_ids: [], held_at: '', result: 'CONFLICT' });
  });

  test('ST-T21 ③ 대기열 경로 요청은 여정이 비어도 회차·pid로 이어 읽힌다', () => {
    const rows = rowsOf('InvestigationRequest', request());
    const req = rows.find((r) => r.table === 'inv.inv_request')!;
    expect(req.row).toMatchObject({
      request_id: 'req-1',
      event_id: EVENT_ID,
      journey_id: '',
      pid: 'pid-1',
      account_id: 'acct-1',
      ip: '::ffff:203.0.113.7',
      asn: 16509,
      net_class: 'HOSTING',
      ja4: 't13d1516h2_8daaf6152771_b186095e22b6',
      edge_bot_labels: ['bot:verified'],
      device_ref: '',
      retain_until: RETAIN,
    });
    const link = rows.find((r) => r.table === 'inv.inv_link' && r.row.kind === 'PID')!;
    expect(link.row).toMatchObject({ event_id: EVENT_ID, kind: 'PID', value: 'pid-1', pid: 'pid-1', account_id: 'acct-1', journey_id: '' });
  });

  test('ST-T21 ④ inv_link에 계정·연락처·기기 가명이 남고 빈 값은 행을 만들지 않는다', () => {
    const created = rowsOf('OrderEvent', order());
    expect(created.filter((r) => r.table === 'inv.inv_link').map((r) => [r.row.kind, r.row.value])).toEqual([
      ['ACCOUNT', 'acct-1'],
      ['CONTACT', 'k1.contact-xyz'],
    ]);
    const verdictLinks = rowsOf('TrustVerdict', verdict()).filter((r) => r.table === 'inv.inv_link');
    expect(verdictLinks.map((r) => [r.row.kind, r.row.value])).toEqual([
      ['PID', 'pid-1'],
      ['DEVICE', 'k1.device-abc'],
    ]);
    // refMissing이면 연결 행을 만들지 않고 ref_missing만 남긴다
    const missing = rowsOf('OrderEvent', order({ refMissing: true, contactRef: null }));
    expect(missing.filter((r) => r.table === 'inv.inv_link').map((r) => r.row.kind)).toEqual(['ACCOUNT']);
    expect((missing.find((r) => r.table === 'inv.inv_step')!.row as Record<string, unknown>).ref_missing).toBe(1);
    // 빈 값은 행을 만들지 않는다
    const empty = rowsOf('TrustVerdict', verdict({ pid: null, deviceRef: null }));
    expect(empty.filter((r) => r.table === 'inv.inv_link')).toHaveLength(0);
  });

  test('ST-T21 ⑤ 건너뛰는 사건도 진행 위치를 남긴다', async () => {
    const inserts: { table: string; rows: readonly Record<string, unknown>[]; token: string }[] = [];
    const ch = { insert: async (table: string, rows: readonly Record<string, unknown>[], token: string) => void inserts.push({ table, rows, token }) };
    const sink = new InvSink({ clickhouse: ch, clock: () => ms(INGESTED), eventDates: ctx.eventDates, asnTable: ctx.asnTable });
    const records: DecodedInvEvent[] = [
      { record: 'PipelinePulse', key: null, schemaId: 1, value: {} },
      { record: 'QueueAggregate', key: null, schemaId: 1, value: {} },
      { record: 'PaymentEvent', key: null, schemaId: 1, value: payment({ eventId: null }) },
      { record: 'InvestigationRequest', key: null, schemaId: null, value: request({ eventId: undefined }) },
    ];
    await sink.write({ topic: 'telemetry.purchase', partition: 3, firstOffset: '10', lastOffset: '13', dedupToken: 'telemetry.purchase:3:10:13', records: records.map((value, i) => ({ topic: 'telemetry.purchase', partition: 3, offset: String(10 + i), timestamp: String(ms(INGESTED)), value })), rejected: [] });
    const progress = inserts.find((i) => i.table === 'inv.inv_ingest_progress')!;
    expect(progress.rows).toEqual([{ topic: 'telemetry.purchase', partition: 3, offset: '14', ingested_at: INGESTED }]);
    expect(inserts.some((i) => i.table.startsWith('inv.inv_step'))).toBe(false);
  });

  test('ST-T21 ⑥ 같은 사건이 다시 와도 표마다 정렬 키가 같다', () => {
    const row = (table: Parameters<typeof invRowKey>[0], r: Record<string, unknown>) => invRowKey(table, r);
    expect(row('inv.inv_request', rowsOf('InvestigationRequest', request())[0]!.row)).toBe(`${EVENT_ID}|req-1`);
    expect(row('inv.inv_step', rowsOf('HoldAttempt', hold())[0]!.row)).toBe(`${EVENT_ID}|33333333-3333-7333-8333-333333333332:HOLD_TRY`);
    expect(row('inv.inv_behavior', rowsOf('BehaviorSignal', behavior())[0]!.row)).toBe(`${EVENT_ID}|33333333-3333-7333-8333-333333333337`);
    expect(row('inv.inv_link', rowsOf('TrustVerdict', verdict())[1]!.row)).toBe(`${EVENT_ID}|DEVICE|k1.device-abc||pid-1|${JOURNEY}`);
  });

  test('ST-T21 ⑦ 정수·범위 밖 사건은 그 사건만 버린다', () => {
    expect(map('InvestigationRequest', request({ status: 99 }))).toMatchObject({ outcome: 'REJECTED', reason: 'BAD_STATUS' });
    expect(map('InvestigationRequest', request({ asn: -1 }))).toMatchObject({ outcome: 'REJECTED', reason: 'BAD_ASN' });
    expect(map('InvestigationRequest', request({ ip: 'not-an-ip' }))).toMatchObject({ outcome: 'REJECTED', reason: 'BAD_IP' });
    const labels = Array.from({ length: 33 }, (_, i) => `l${i}`);
    expect(map('InvestigationRequest', request({ edgeBotLabels: labels }))).toMatchObject({ outcome: 'REJECTED', reason: 'BAD_LABELS' });
    expect(map('HoldAttempt', hold({ latencyMs: -1 }))).toMatchObject({ outcome: 'REJECTED', reason: 'BAD_LATENCY' });
    expect(map('InvestigationRequest', request({ asn: 0, ip: '2001:db8::1' })).rows[0]!.row).toMatchObject({ net_class: 'OTHER', ip: '2001:db8::1' });
  });

  test('ST-T21 ⑧ investigation.requests는 정한 칸만 받고 모르는 칸·__proto__를 버린다', () => {
    const unknown = JSON.parse('{"ts":"2026-12-01T09:00:00.000Z","requestId":"r2","gateway":"GW_FAN","routeKind":"HOLD","status":200,"ip":"198.51.100.1","eventId":"' + EVENT_ID + '","pid":"pid-1","extra":"x"}') as Record<string, unknown>;
    expect(map('InvestigationRequest', unknown)).toMatchObject({ outcome: 'LOADED' });
    expect(map('InvestigationRequest', unknown).rows[0]!.row).not.toHaveProperty('extra');
    const proto = JSON.parse('{"ts":"2026-12-01T09:00:00.000Z","requestId":"r3","gateway":"GW_FAN","routeKind":"HOLD","status":200,"ip":"198.51.100.1","__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(map('InvestigationRequest', proto)).toMatchObject({ outcome: 'REJECTED', reason: 'BAD_JSON' });
    expect(map('InvestigationRequest', request({ gateway: 'GW_OPS' }))).toMatchObject({ outcome: 'REJECTED', reason: 'BAD_GATEWAY' });
    expect(map('InvestigationRequest', request({ routeKind: 'UNKNOWN' }))).toMatchObject({ outcome: 'REJECTED', reason: 'BAD_ROUTE' });
    const { ip: _ip, ...missingIp } = request();
    expect(map('InvestigationRequest', missingIp)).toMatchObject({ outcome: 'REJECTED', reason: 'MISSING_FIELD' });
  });
});
