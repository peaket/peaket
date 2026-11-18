// 결제 결과 소비자가 굿즈·티켓 연동 부가 상품 결제 사건(orderKind MERCH, 회차 eventId 없음)을 반영하지 않고 건너뛰는지 본다
// (P-T56 ⑥, ADR-0299 결정 4, docs/api/asyncapi.yaml PaymentEvent.orderKind·eventId, docs/api/avro/peaket/trade/PaymentEvent.avsc).
// 정본: orderKind가 TICKET이 아닌 사건은 반영하지 않고 payment_result_skipped_total{reason}(merch·unrecognized)을 1 올린다. 이 칸 전에 낸 사건(칸 없음)은 TICKET이다.
// 값 바이트는 생산자(payment-svc)의 실제 사건 만들기(buildPaymentEvent)와 값 부호화(jsonPaymentEventCodec, 지금 trade.payments의 값 형식은 JSON 대역이다)로 만든다.
// Avro null 갈래를 JSON으로 옮긴 꼴(eventId: null)도 따로 넣는다. 반영 쓰임새는 실제 ApplyPaymentResult(포트만 메모리 가짜)라 읽기·쓰기가 0번인지 센다.
import { type ConsumedMessage, fakeClock, type HeldEventInput, type HeldEventStore, KeyedPartition, PlatformMetrics } from '@peaket/platform';
import { beforeEach, describe, expect, test } from 'vitest';
import { buildPaymentEvent } from '../../payment-svc/src/modules/payment/domain/confirm-runner.js';
import { jsonPaymentEventCodec } from '../../payment-svc/src/modules/payment/adapters/payment-events.js';
import {
  ApplyPaymentResult,
  PaymentResultHandler,
  type PaymentEventSkipReason,
  type PaymentResultRecord,
  PromPaymentEventSkipSignals,
  TRADE_PAYMENTS_TOPIC,
} from '../src/modules/booking/index.js';
import { AMOUNT, EVENT } from './order-cases.js';
import { APPLY_NOW, EVENT_KEY, ORDER_ID, paymentEvent, ResultFakes, wireEvent } from './payment-result-cases.js';

/** 굿즈 주문(core-svc shop 주문 ID, purchase-svc가 모르는 주문) */
const MERCH_ORDER = '0190f3a1-7c2e-7f00-8000-00000000b001';
const MERCH_PAYMENT = '0190f3a1-7c2e-7f00-8000-00000000b0a1';
const MERCH_AMOUNT = 47_000;

let offset = 0n;
const consumed = (value: Buffer | Uint8Array | null, key: string | null): ConsumedMessage => ({
  topic: TRADE_PAYMENTS_TOPIC,
  partition: 0,
  offset: offset++,
  key,
  value: value === null ? null : Buffer.from(value),
  headers: {},
  timestamp: 0,
});
const json = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8');

/** 생산자가 내는 굿즈 결제 사건(승인·실패 등). Kafka 키는 정본 값(굿즈는 주문 ID, ADR-0299 결정 4)을 적는다(생산자의 키 계산은 payment-svc 시험이 본다) */
function producedMerch(finish: Parameters<typeof buildPaymentEvent>[0]['finish'] = { status: 'APPROVED', result: 'APPROVED', approvedAtMs: APPLY_NOW - 1_000, payMethodCategory: 'CARD' }, seq = 2) {
  const message = buildPaymentEvent({
    target: { paymentId: MERCH_PAYMENT, orderId: MERCH_ORDER, eventId: null, orderKind: 'MERCH', attemptNo: 1, pg: 'SIMULATOR', amount: MERCH_AMOUNT },
    finish,
    seq,
    nowMs: APPLY_NOW,
  });
  return { message, key: MERCH_ORDER, bytes: jsonPaymentEventCodec.encode(message) };
}

/** 생산자가 내는 티켓 결제 사건(대조, 주문 재료와 같은 결제사·금액) */
function producedTicket() {
  const message = buildPaymentEvent({
    target: { paymentId: MERCH_PAYMENT, orderId: ORDER_ID, eventId: EVENT, orderKind: 'TICKET', attemptNo: 1, pg: 'TOSS', amount: AMOUNT },
    finish: { status: 'APPROVED', result: 'APPROVED', approvedAtMs: APPLY_NOW - 1_000 },
    seq: 3,
    nowMs: APPLY_NOW,
  });
  return { message, key: EVENT, bytes: jsonPaymentEventCodec.encode(message) };
}

const fx = new ResultFakes();
const clock = fakeClock({ now: APPLY_NOW });

/** 건너뜀 지표 가짜: 까닭별 수 */
function countingSkips() {
  const counts: Record<PaymentEventSkipReason, number> = { merch: 0, unrecognized: 0 };
  return { counts, signals: { skipped: (r: PaymentEventSkipReason) => void (counts[r] += 1) } };
}

/** 실제 쓰임새(포트만 메모리 가짜)를 건 처리기와, 쓰임새가 받은 사건 */
function handlerWith() {
  const skips = countingSkips();
  const apply = new ApplyPaymentResult({ reads: fx.reads, writes: fx.writes, sessions: fx.sessions, saga: fx.saga, log: fx.log, clock });
  const executed: unknown[] = [];
  const spy = { execute: async (e: Parameters<ApplyPaymentResult['execute']>[0]) => (executed.push(e), apply.execute(e)) };
  return { handler: new PaymentResultHandler(spy, skips.signals), skips: skips.counts, executed };
}

function fakeHeldStore() {
  const rows: HeldEventInput[] = [];
  const keys = new Set<string>();
  const store: HeldEventStore = {
    heldKeys: async () => new Set(keys),
    isHeld: async (_t, k) => keys.has(k),
    hold: async (e) => {
      rows.push(e);
      keys.add(e.businessKey);
    },
    holdIfHeld: async (e) => {
      if (!keys.has(e.businessKey)) return false;
      rows.push(e);
      return true;
    },
  };
  return { store, rows };
}

beforeEach(() => {
  fx.reset();
});

describe('굿즈 결제 사건 건너뛰기(생산자의 실제 사건 값)', () => {
  test('P-T56 ⑥ 생산자가 낸 굿즈 승인 사건(eventId null 칸 뺌, orderKind MERCH, Kafka 키 주문 ID)은 반영하지 않고 merch로 1번 센다', async () => {
    const { message, key, bytes } = producedMerch();
    // 시험 재료가 정본 모양인지 먼저 본다(ADR-0299 결정 4)
    expect(message).toMatchObject({ eventId: null, orderKind: 'MERCH', orderId: MERCH_ORDER, type: 'APPROVED' });
    const { handler, skips, executed } = handlerWith();
    const r = handler.decode(consumed(bytes, key));
    expect(r).toEqual({ kind: 'skip', key: MERCH_ORDER, reason: 'merch', eventKey: message.eventKey });
    expect(handler.keyOf(r)).toBe(MERCH_ORDER);
    expect(handler.eventKeyOf(r)).toBe(message.eventKey);
    await handler.handle(r);
    expect(executed).toHaveLength(0);
    expect(fx.calls).toEqual([]);
    expect(skips).toEqual({ merch: 1, unrecognized: 0 });
  });

  test('P-T56 ⑥ 굿즈 사건은 종류(승인·실패·결과 모름·취소)와 상관없이 모두 건너뛰고 한 건에 1씩 센다', async () => {
    const { handler, skips, executed } = handlerWith();
    const finishes: Parameters<typeof buildPaymentEvent>[0]['finish'][] = [
      { status: 'APPROVED', result: 'APPROVED', approvedAtMs: APPLY_NOW - 1_000 },
      { status: 'FAILED', result: 'DECLINED', failureCategory: 'CARD_DECLINED' },
      { status: 'UNKNOWN', result: 'UNKNOWN' },
    ] as Parameters<typeof buildPaymentEvent>[0]['finish'][];
    let seq = 2;
    for (const f of finishes) {
      const { bytes, key } = producedMerch(f, seq++);
      const r = handler.decode(consumed(bytes, key));
      expect(r.kind, f.status).toBe('skip');
      await handler.handle(r);
    }
    // 취소 사건(CANCELED)은 승인 실행기가 내지 않으므로 JSON 값으로 넣는다(미수령 자동 취소의 결제 취소, ADR-0301 결정 5)
    const canceled = { ...wireEvent({ orderId: MERCH_ORDER, type: 'CANCELED', orderKind: 'MERCH', eventKey: '0190f3a1-7c2e-7f00-8000-00000000b0e9' }) };
    delete (canceled as Record<string, unknown>).eventId;
    await handler.handle(handler.decode(consumed(json(canceled), MERCH_ORDER)));
    expect(executed).toHaveLength(0);
    expect(fx.calls).toEqual([]);
    expect(skips).toEqual({ merch: 4, unrecognized: 0 });
  });

  test('P-T56 ⑥ Avro null 갈래를 옮긴 꼴(eventId: null)의 굿즈 사건도 건너뛴다(보류하지 않는다)', async () => {
    const { handler, skips } = handlerWith();
    const v = wireEvent({ eventId: null, orderId: MERCH_ORDER, orderKind: 'MERCH' });
    const r = handler.decode(consumed(json(v), MERCH_ORDER));
    expect(r).toEqual({ kind: 'skip', key: MERCH_ORDER, reason: 'merch', eventKey: EVENT_KEY });
    await handler.handle(r);
    expect(skips).toEqual({ merch: 1, unrecognized: 0 });
  });

  test('P-T56 ⑥ 굿즈 사건에 회차가 실려 와도(티켓 연동 부가 상품 오해) 반영하지 않고 merch로 센다', async () => {
    const { handler, skips, executed } = handlerWith();
    const r = handler.decode(consumed(json(wireEvent({ orderId: MERCH_ORDER, orderKind: 'MERCH' })), EVENT));
    expect(r).toMatchObject({ kind: 'skip', reason: 'merch', key: MERCH_ORDER });
    await handler.handle(r);
    expect(executed).toHaveLength(0);
    expect(skips).toEqual({ merch: 1, unrecognized: 0 });
  });
});

describe('모르는 주문 종류와 티켓 사건(대조)', () => {
  test('P-T56 ⑥ 모르는 주문 종류는 값마다(UNRECOGNIZED·새 이름·소문자·빈 글·숫자) 반영하지 않고 unrecognized로 센다', async () => {
    const { handler, skips, executed } = handlerWith();
    const kinds: unknown[] = ['UNRECOGNIZED', 'VIP', 'ticket', 'merch', '', 1];
    for (const orderKind of kinds) {
      const v = wireEvent({ orderKind });
      delete (v as Record<string, unknown>).eventId;
      const r = handler.decode(consumed(json(v), ORDER_ID));
      expect(r, String(orderKind)).toMatchObject({ kind: 'skip', reason: 'unrecognized', key: ORDER_ID });
      await handler.handle(r);
    }
    expect(executed).toHaveLength(0);
    expect(fx.calls).toEqual([]);
    expect(skips).toEqual({ merch: 0, unrecognized: kinds.length });
  });

  test('P-T56 ⑥ 생산자가 낸 티켓 사건(orderKind TICKET, 키 = 회차)은 지금처럼 반영하고 건너뜀 수는 0이다', async () => {
    const { message, key, bytes } = producedTicket();
    const { handler, skips, executed } = handlerWith();
    const r = handler.decode(consumed(bytes, key));
    expect(r.kind).toBe('event');
    if (r.kind !== 'event') return;
    expect(r.event).toMatchObject({ eventId: EVENT, orderId: ORDER_ID, type: 'APPROVED', eventKey: message.eventKey });
    await handler.handle(r);
    expect(executed).toHaveLength(1);
    expect(fx.calls[0]).toBe('reads.read');
    expect(skips).toEqual({ merch: 0, unrecognized: 0 });
  });

  test('P-T56 ⑥ 주문 종류 칸이 없는 옛 판 사건은 TICKET으로 읽어 반영한다', async () => {
    const { handler, skips, executed } = handlerWith();
    const v = wireEvent();
    expect(Object.keys(v)).not.toContain('orderKind');
    const r = handler.decode(consumed(json(v), EVENT));
    expect(r).toEqual({ kind: 'event', event: paymentEvent() });
    await handler.handle(r);
    expect(executed).toHaveLength(1);
    expect(skips).toEqual({ merch: 0, unrecognized: 0 });
  });

  test('P-T56 ⑥ TICKET인데 회차가 없으면(칸 뺌·null) 반영도 건너뛰기도 하지 않고 모양이 틀린 사건으로 던진다(보류 길)', async () => {
    const { handler, skips, executed } = handlerWith();
    for (const eventId of [undefined, null]) {
      const v = wireEvent({ orderKind: 'TICKET', eventId });
      if (eventId === undefined) delete (v as Record<string, unknown>).eventId;
      const r = handler.decode(consumed(json(v), ORDER_ID));
      expect(r.kind, String(eventId)).toBe('bad');
      expect(handler.keyOf(r)).toBe(ORDER_ID);
      await expect(handler.handle(r)).rejects.toBeInstanceOf(RangeError);
    }
    expect(executed).toHaveLength(0);
    expect(skips).toEqual({ merch: 0, unrecognized: 0 });
  });
});

describe('키 단위 소비자 안에서', () => {
  test('P-T56 ⑥ 굿즈 사건은 보류 표에 들어가지 않고 파티션을 멈추지 않으며, 같은 주문의 뒤 사건과 다른 티켓 주문 사건도 막지 않는다', async () => {
    const { handler, skips, executed } = handlerWith();
    const held = fakeHeldStore();
    const pauses = { pause: 0 };
    const p = new KeyedPartition<PaymentResultRecord>({
      topic: TRADE_PAYMENTS_TOPIC,
      partition: 0,
      handler,
      held: held.store,
      sleep: async () => {},
      onPause: () => void (pauses.pause += 1),
      onResume: () => {},
    });
    await p.init();
    const a = producedMerch(undefined, 2);
    const b = producedMerch({ status: 'FAILED', result: 'DECLINED', failureCategory: 'CARD_DECLINED' } as Parameters<typeof buildPaymentEvent>[0]['finish'], 3);
    const t = producedTicket();
    await p.push(consumed(a.bytes, a.key));
    await p.push(consumed(b.bytes, b.key));
    await p.push(consumed(t.bytes, t.key));
    await p.drain();
    expect(held.rows).toEqual([]);
    expect(pauses.pause).toBe(0);
    expect(skips).toEqual({ merch: 2, unrecognized: 0 });
    // 티켓 사건 하나만 쓰임새에 닿았다
    expect(executed).toHaveLength(1);
  });
});

describe('운영 지표(PromPaymentEventSkipSignals)', () => {
  test('P-T56 ⑥ 굿즈 사건 하나를 건너뛰면 payment_result_skipped_total{reason="merch"}가 정확히 1, unrecognized는 0이다(두 이름표는 처음부터 0으로 보인다)', async () => {
    const metrics = new PlatformMetrics('purchase-svc');
    const signals = new PromPaymentEventSkipSignals().register(metrics.registry);
    const before = await metrics.registry.getSingleMetric('payment_result_skipped_total')!.get();
    expect(Object.fromEntries(before.values.map((v) => [v.labels.reason, v.value]))).toEqual({ merch: 0, unrecognized: 0 });
    const handler = new PaymentResultHandler({ execute: async () => ({ status: 'APPLIED', transition: 'T9', write: 'APPROVE' }) as never }, signals);
    const { bytes, key } = producedMerch();
    await handler.handle(handler.decode(consumed(bytes, key)));
    const after = await metrics.registry.getSingleMetric('payment_result_skipped_total')!.get();
    expect(Object.fromEntries(after.values.map((v) => [v.labels.reason, v.value]))).toEqual({ merch: 1, unrecognized: 0 });
    const v = wireEvent({ orderKind: 'UNRECOGNIZED' });
    await handler.handle(handler.decode(consumed(json(v), ORDER_ID)));
    const last = await metrics.registry.getSingleMetric('payment_result_skipped_total')!.get();
    expect(Object.fromEntries(last.values.map((x) => [x.labels.reason, x.value]))).toEqual({ merch: 1, unrecognized: 1 });
  });
});
