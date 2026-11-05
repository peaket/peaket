// 결제 결과 소비자(inbound/payment-result.handler.ts PaymentResultHandler, BUILD_ORDER PRF-163, docs/features/payment.md §2 '주문 Saga 소비자의 키 단위 동시 처리'·
// '결제 결과 반영의 첫 구현', ADR-0142). trade.payments JSON 대역 값 → 계약 zod(@peaket/contracts/asyncapi PaymentEvent) → 도메인 사건, 모양이 틀린 값은 bad(던지지 않음),
// 업무 키 = 주문 ID, 중복 제거 키 = eventKey, handle의 RangeError·오류 그대로, 그리고 platform KeyedPartition의 보류 규칙에서
// PaymentResultHeld·PaymentResultConflict·모양이 틀린 사건이 '같은 결과일 실패'(5회 뒤 보류, 같은 주문의 뒤 사건도 보류)로, DB 연결 실패가 일시 실패(파티션 멈춤)로 읽히는지 본다.
// 꼴은 inventory SeatHoldLedgerHandler 시험(trade-events.test.ts)과 같다.
import { PaymentEvent } from '@peaket/contracts/asyncapi';
import { type ConsumedMessage, type HeldEventInput, type HeldEventStore, isTransientError, KEYED_CONSUMER_DEFAULTS, KeyedPartition } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import {
  type ApplyPaymentResultOutcome,
  PAYMENT_EVENT_TYPES,
  PaymentResultConflict,
  PaymentResultHandler,
  PaymentResultHeld,
  type PaymentResultEvent,
  type PaymentResultRecord,
  TRADE_PAYMENTS_TOPIC,
} from '../src/modules/booking/index.js';
import { EVENT } from './order-cases.js';
import { CARD_BIN, EVENT_KEY, ORDER_ID, OTHER_ORDER_ID, PAYMENT_METHOD_REF, paymentEvent, wireEvent } from './payment-result-cases.js';

let offset = 0n;
/** trade.payments 레코드 하나(Kafka 키는 회차) */
const consumed = (value: Buffer | null, key: string | null = EVENT): ConsumedMessage => ({
  topic: TRADE_PAYMENTS_TOPIC,
  partition: 0,
  offset: offset++,
  key,
  value,
  headers: {},
  timestamp: 0,
});
const jsonValue = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8');

/** 쓰임새 가짜: 받은 사건을 적고, 정해 둔 답(또는 차례대로 던질 오류)을 돌려준다 */
function fakeApply(answer: (e: PaymentResultEvent, n: number) => ApplyPaymentResultOutcome | Error = () => ({ status: 'APPLIED', transition: 'T9', write: 'APPROVE' })) {
  const seen: PaymentResultEvent[] = [];
  const apply = {
    execute: async (e: PaymentResultEvent) => {
      seen.push(e);
      const a = answer(e, seen.length);
      if (a instanceof Error) throw a;
      return a;
    },
  };
  return { handler: new PaymentResultHandler(apply), seen };
}

/** 보류 표 가짜(같은 키의 뒤 사건도 보류하는지 본다) */
function fakeHeldStore() {
  const keys = new Set<string>();
  const rows: HeldEventInput[] = [];
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

/** 키 단위 파티션 하나를 이 처리기로 만들고(쉬기 없음) 멈춤·다시 시작을 센다 */
async function partitionOf(handler: PaymentResultHandler) {
  const held = fakeHeldStore();
  const pauses = { pause: 0, resume: 0 };
  const p = new KeyedPartition<PaymentResultRecord>({
    topic: TRADE_PAYMENTS_TOPIC,
    partition: 0,
    handler,
    held: held.store,
    sleep: async () => {},
    onPause: () => void (pauses.pause += 1),
    onResume: () => void (pauses.resume += 1),
  });
  await p.init();
  return { p, held, pauses };
}

describe('PaymentResultHandler.decode: JSON 대역 → 계약 zod → 도메인 사건', () => {
  test('FR011_계약 모양 값은 {kind: event, event}이고, 조사용 가명 칸(paymentMethodRef·cardBin)은 버린다 [ASVS v5.0.0-2.2.1]', () => {
    expect(TRADE_PAYMENTS_TOPIC).toBe('trade.payments');
    const v = wireEvent();
    // 시험 재료가 계약을 지나는지 먼저 본다
    expect(PaymentEvent.safeParse(v).success).toBe(true);
    const { handler } = fakeApply();
    const r = handler.decode(consumed(jsonValue(v)));
    expect(r).toEqual({ kind: 'event', event: paymentEvent() });
    if (r.kind !== 'event') throw new Error('event여야 한다');
    expect(Object.keys(r.event)).not.toContain('paymentMethodRef');
    expect(Object.keys(r.event)).not.toContain('cardBin');
    expect(JSON.stringify(r)).not.toContain(PAYMENT_METHOD_REF);
    expect(JSON.stringify(r)).not.toContain(CARD_BIN);
  });

  test('FR011_refMissing이 없으면 계약 기본값 거짓이다. 선택 칸(payMethodCategory·result·failureCategory·latencyMs)이 없으면 사건에도 없다', () => {
    const { handler } = fakeApply();
    const v = wireEvent();
    for (const k of ['refMissing', 'payMethodCategory', 'result', 'failureCategory', 'latencyMs', 'paymentMethodRef', 'cardBin']) delete v[k];
    const r = handler.decode(consumed(jsonValue(v)));
    expect(r.kind).toBe('event');
    if (r.kind !== 'event') return;
    expect(r.event.refMissing).toBe(false);
    for (const k of ['payMethodCategory', 'result', 'failureCategory', 'latencyMs']) expect(r.event[k as keyof PaymentResultEvent], k).toBeUndefined();
    expect(r.event).toMatchObject({ orderId: ORDER_ID, eventSeq: 3, eventKey: EVENT_KEY, amount: paymentEvent().amount });
  });

  test('PT2_FAILED 사건의 failureCategory·result를 그대로 옮기고, refMissing 참도 그대로다', () => {
    const { handler } = fakeApply();
    const r = handler.decode(consumed(jsonValue(wireEvent({ type: 'FAILED', result: 'DECLINED', failureCategory: 'THROTTLED', refMissing: true }))));
    expect(r).toEqual({ kind: 'event', event: paymentEvent({ type: 'FAILED', result: 'DECLINED', failureCategory: 'THROTTLED', refMissing: true }) });
  });

  test('FR011_사건 종류 여덟 모두 event로 읽는다(건너뛰기·보류는 쓰임새가 정한다)', () => {
    const { handler } = fakeApply();
    for (const type of PAYMENT_EVENT_TYPES) {
      const r = handler.decode(consumed(jsonValue(wireEvent({ type }))));
      expect(r, type).toEqual({ kind: 'event', event: paymentEvent({ type }) });
    }
  });

  test('FR011_오프셋이 붙은 occurredAt(+09:00)도 지나고 글 그대로 옮긴다', () => {
    const { handler } = fakeApply();
    const occurredAt = '2026-11-05T12:00:05.000+09:00';
    expect(handler.decode(consumed(jsonValue(wireEvent({ occurredAt }))))).toEqual({ kind: 'event', event: paymentEvent({ occurredAt }) });
  });

  test('FR011_계약에 없는 칸은 도메인 사건에 옮기지 않는다(뒤 판 계약이 칸을 더해도 읽는다)', () => {
    // 정본 모호: 모르는 칸을 거절할지 버릴지 정본에 없다. 계약 zod가 object(엄격 아님)라 버리는 것으로 본다
    const { handler } = fakeApply();
    const r = handler.decode(consumed(jsonValue(wireEvent({ futureField: 'x', journeyId: 'jny-1' }))));
    expect(r).toEqual({ kind: 'event', event: paymentEvent() });
  });
});

describe('PaymentResultHandler.decode: 모양이 틀린 값은 던지지 않고 bad', () => {
  const noOrder = (() => {
    const v = wireEvent();
    delete v.orderId;
    return v;
  })();
  const noSeq = (() => {
    const v = wireEvent();
    delete v.eventSeq;
    return v;
  })();
  const cases: [string, Buffer | null, string | null, string][] = [
    // [이름, 값, Kafka 키, 기대 업무 키]
    ['값 없음', null, EVENT, `bad:${EVENT}`],
    ['JSON 아님', Buffer.from('{"orderId":', 'utf8'), EVENT, `bad:${EVENT}`],
    ['JSON 배열', jsonValue([wireEvent()]), EVENT, `bad:${EVENT}`],
    ['JSON 수', jsonValue(42), EVENT, `bad:${EVENT}`],
    ['JSON 글', jsonValue('APPROVED'), EVENT, `bad:${EVENT}`],
    ['JSON null', jsonValue(null), EVENT, `bad:${EVENT}`],
    ['orderId 없음', jsonValue(noOrder), EVENT, `bad:${EVENT}`],
    ['orderId가 수', jsonValue(wireEvent({ orderId: 7 })), EVENT, `bad:${EVENT}`],
    ['메시지 키도 없음', jsonValue(noOrder), null, 'bad:'],
    ['amount가 글', jsonValue(wireEvent({ amount: '308000' })), EVENT, ORDER_ID],
    ['amount가 정수 아님', jsonValue(wireEvent({ amount: 308000.5 })), EVENT, ORDER_ID],
    ['계약 밖 type', jsonValue(wireEvent({ type: 'REFUNDED' })), EVENT, ORDER_ID],
    ['계약 밖 pg', jsonValue(wireEvent({ pg: 'KCP' })), EVENT, ORDER_ID],
    ['계약 밖 failureCategory', jsonValue(wireEvent({ type: 'FAILED', failureCategory: 'FRAUD' })), EVENT, ORDER_ID],
    ['eventSeq 없음', jsonValue(noSeq), EVENT, ORDER_ID],
    ['eventSeq가 정수 아님', jsonValue(wireEvent({ eventSeq: 1.5 })), EVENT, ORDER_ID],
    ['eventKey가 UUID 아님', jsonValue(wireEvent({ eventKey: 'dup-1' })), EVENT, ORDER_ID],
    ['occurredAt에 오프셋 없음', jsonValue(wireEvent({ occurredAt: '2026-11-05T03:00:05' })), EVENT, ORDER_ID],
    ['refMissing이 글', jsonValue(wireEvent({ refMissing: 'false' })), EVENT, ORDER_ID],
  ];

  test.each(cases)(
    'FR011_%s → decode가 던지지 않고 bad, 업무 키는 orderId 칸이 글이면 그 값·아니면 bad: + 메시지 키, eventKeyOf 없음, handle은 RangeError이고 쓰임새를 부르지 않는다 [ASVS v5.0.0-2.2.1]',
    async (_name, value, key, businessKey) => {
      const { handler, seen } = fakeApply();
      const m = consumed(value, key);
      let r: PaymentResultRecord | undefined;
      expect(() => (r = handler.decode(m))).not.toThrow();
      expect(r!.kind).toBe('bad');
      expect(handler.keyOf(r!, m)).toBe(businessKey);
      expect(handler.eventKeyOf(r!)).toBeUndefined();
      await expect(handler.handle(r!, m)).rejects.toThrow(RangeError);
      expect(seen).toEqual([]);
    },
  );

  test('FR011_bad의 까닭(error)에는 사건 값(조사용 가명·카드 BIN)을 싣지 않는다', () => {
    const { handler } = fakeApply();
    const r = handler.decode(consumed(jsonValue(wireEvent({ amount: 'x' }))));
    expect(r.kind).toBe('bad');
    if (r.kind !== 'bad') return;
    expect(typeof r.error).toBe('string');
    expect(r.error.length).toBeGreaterThan(0);
    expect(r.error).not.toContain(PAYMENT_METHOD_REF);
    expect(r.error).not.toContain(CARD_BIN);
  });
});

describe('PaymentResultHandler: 업무 키·중복 제거 키·handle', () => {
  test('PT48_업무 키는 주문 ID다(Kafka 키는 회차라 인기 회차가 한 파티션에 몰려도 주문마다 따로 처리한다, ADR-0142)', () => {
    const { handler } = fakeApply();
    const m = consumed(jsonValue(wireEvent()), EVENT);
    expect(handler.keyOf(handler.decode(m), m)).toBe(ORDER_ID);
    const m2 = consumed(jsonValue(wireEvent({ orderId: OTHER_ORDER_ID })), EVENT);
    expect(handler.keyOf(handler.decode(m2), m2)).toBe(OTHER_ORDER_ID);
    // 이미 만든 레코드의 키(메시지 없이)
    expect(handler.keyOf({ kind: 'event', event: paymentEvent() })).toBe(ORDER_ID);
    expect(handler.keyOf({ kind: 'bad', key: 'bad:x', error: '까닭' })).toBe('bad:x');
  });

  test('ADR0052_중복 제거 키는 event면 eventKey, bad면 없다', () => {
    const { handler } = fakeApply();
    expect(handler.eventKeyOf(handler.decode(consumed(jsonValue(wireEvent()))))).toBe(EVENT_KEY);
    expect(handler.eventKeyOf({ kind: 'event', event: paymentEvent({ eventKey: '0190f3a1-7c2e-7f00-8000-0000000000e8' }) })).toBe('0190f3a1-7c2e-7f00-8000-0000000000e8');
    expect(handler.eventKeyOf({ kind: 'bad', key: ORDER_ID, error: '까닭' })).toBeUndefined();
  });

  test('FR011_handle(event)은 쓰임새 execute를 그 사건으로 한 번 부르고 결과는 버린다(SKIPPED여도 끝)', async () => {
    const { handler, seen } = fakeApply(() => ({ status: 'SKIPPED', reason: 'DUPLICATE' }));
    const m = consumed(jsonValue(wireEvent()));
    await expect(handler.handle(handler.decode(m), m)).resolves.toBeUndefined();
    expect(seen).toEqual([paymentEvent()]);
  });

  test('FR011_handle(bad)는 까닭을 글로 담은 RangeError다', async () => {
    const { handler } = fakeApply();
    await expect(handler.handle({ kind: 'bad', key: ORDER_ID, error: '모양이 틀렸다' })).rejects.toThrow(new RangeError('모양이 틀렸다'));
  });

  test('FR011_쓰임새가 던진 것(보류·경합·DB 오류)은 그대로 던진다', async () => {
    for (const err of [new PaymentResultHeld('AMOUNT_MISMATCH', ORDER_ID, 'APPROVED'), new PaymentResultConflict(ORDER_ID), Object.assign(new Error('connection terminated'), { code: '57P01' })]) {
      const { handler } = fakeApply(() => err);
      const m = consumed(jsonValue(wireEvent()));
      await expect(handler.handle(handler.decode(m), m)).rejects.toBe(err);
    }
  });
});

describe('KeyedPartition의 보류 규칙에서 읽히는 법(ADR-0142 결정 2, packages/platform keyed-consumer.ts)', () => {
  test('ADR0142_PaymentResultHeld는 같은 결과일 실패다: 5회 해 본 뒤 주문 키로 보류하고(eventKey 함께), 파티션을 멈추지 않으며, 같은 주문의 뒤 사건도 보류하고 다른 주문은 처리한다', async () => {
    const heldErr = new PaymentResultHeld('IMPOSSIBLE', ORDER_ID, 'APPROVED');
    expect(isTransientError(heldErr)).toBe(false);
    const { handler, seen } = fakeApply((e) => (e.orderId === ORDER_ID ? heldErr : { status: 'APPLIED', transition: 'T9', write: 'APPROVE' }));
    const { p, held, pauses } = await partitionOf(handler);
    const first = consumed(jsonValue(wireEvent()));
    await p.push(first);
    await p.drain();
    expect(seen.filter((e) => e.orderId === ORDER_ID)).toHaveLength(KEYED_CONSUMER_DEFAULTS.attempts);
    expect(held.rows.map((r) => [r.businessKey, r.eventKey, r.offset])).toEqual([[ORDER_ID, EVENT_KEY, first.offset]]);
    expect(held.rows[0]!.error).toContain('PaymentResultHeld');
    expect(pauses.pause).toBe(0);

    // 같은 주문의 뒤 사건은 쓰임새를 부르지 않고 보류, 같은 회차의 다른 주문은 처리한다
    const later = consumed(jsonValue(wireEvent({ eventSeq: 4, eventKey: '0190f3a1-7c2e-7f00-8000-0000000000e9', type: 'FAILED' })));
    const other = consumed(jsonValue(wireEvent({ orderId: OTHER_ORDER_ID, eventKey: '0190f3a1-7c2e-7f00-8000-0000000000ea' })));
    await p.push(later);
    await p.push(other);
    await p.drain();
    expect(held.rows.map((r) => r.businessKey)).toEqual([ORDER_ID, ORDER_ID]);
    expect(seen.filter((e) => e.orderId === ORDER_ID)).toHaveLength(KEYED_CONSUMER_DEFAULTS.attempts);
    expect(seen.filter((e) => e.orderId === OTHER_ORDER_ID)).toHaveLength(1);
    expect(p.committable()).toBe(other.offset + 1n);
  });

  test('ADR0142_PaymentResultConflict도 같은 결과일 실패다: 5회 뒤 주문 키로 보류하고 파티션을 멈추지 않는다', async () => {
    const conflict = new PaymentResultConflict(ORDER_ID);
    expect(isTransientError(conflict)).toBe(false);
    const { handler, seen } = fakeApply(() => conflict);
    const { p, held, pauses } = await partitionOf(handler);
    await p.push(consumed(jsonValue(wireEvent())));
    await p.drain();
    expect(seen).toHaveLength(KEYED_CONSUMER_DEFAULTS.attempts);
    expect(held.rows.map((r) => [r.businessKey, r.eventKey])).toEqual([[ORDER_ID, EVENT_KEY]]);
    expect(held.rows[0]!.error).toContain('PaymentResultConflict');
    expect(pauses.pause).toBe(0);
  });

  test('ADR0142_모양이 틀린 사건(orderId는 읽힘)은 쓰임새를 부르지 않고 5회 뒤 그 주문 키로 보류한다(회차 키로 다른 주문까지 보류하지 않는다)', async () => {
    const { handler, seen } = fakeApply();
    const { p, held, pauses } = await partitionOf(handler);
    await p.push(consumed(jsonValue(wireEvent({ amount: 'NaN' }))));
    await p.push(consumed(jsonValue(wireEvent({ orderId: OTHER_ORDER_ID, eventKey: '0190f3a1-7c2e-7f00-8000-0000000000eb' }))));
    await p.drain();
    expect(held.rows.map((r) => [r.businessKey, r.eventKey])).toEqual([[ORDER_ID, null]]);
    expect(held.rows[0]!.error).toContain('RangeError');
    expect(seen.map((e) => e.orderId)).toEqual([OTHER_ORDER_ID]);
    expect(pauses.pause).toBe(0);
  });

  test('ADR0142_purchase DB 연결 실패(57P01)는 일시 실패다: 파티션을 멈췄다가 되면 다시 열고, 보류하지 않는다(5회 넘게 다시 해도)', async () => {
    const n = KEYED_CONSUMER_DEFAULTS.attempts + 2;
    const { handler, seen } = fakeApply((_e, i) => (i <= n ? Object.assign(new Error('connection terminated'), { code: '57P01' }) : { status: 'APPLIED', transition: 'T9', write: 'APPROVE' }));
    const { p, held, pauses } = await partitionOf(handler);
    const m = consumed(jsonValue(wireEvent()));
    await p.push(m);
    await p.drain();
    expect(seen).toHaveLength(n + 1);
    expect(held.rows).toEqual([]);
    expect(pauses).toEqual({ pause: 1, resume: 1 });
    expect(p.committable()).toBe(m.offset + 1n);
  });
});
