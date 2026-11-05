// 거래 토픽 보내기 어댑터(jsonTradeEventCodec·KafkaTradeEventPublisher)와 홀드 원장 적재 처리기(SeatHoldLedgerHandler)
// (BUILD_ORDER PRF-141, docs/features/seat-hold.md §6 '홀드 원장 적재의 첫 구현'의 '보내는 법'·'적재 소비자', ADR-0142).
// 생산자는 send만 있는 가짜, 원장은 apply만 적는 가짜다. 값은 JSON 대역(받는 쪽 대역 queue-svc jsonPurchaseSessionCodec은 JSON.parse(value.toString('utf8'))로 푼다).
import { createHash } from 'node:crypto';
import type { ConsumedMessage } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import {
  KafkaTradeEventPublisher,
  PURCHASE_SESSION_TOPIC,
  SEAT_TOPIC,
  SeatHoldLedgerHandler,
  type LedgerHoldEvent,
  type LedgerRecord,
  type SeatEventMessage,
  type SeatHoldLedger,
  type TradeRecord,
  jsonTradeEventCodec,
  routeStreamEntry,
  toLedgerHoldEvent,
} from '../src/modules/inventory/index.js';

const EV = '0190f3a1-7c2e-7a00-8000-0000000000e1';
const SEAT = '0190f3a1-7c2e-7a00-8000-00000000a001';
/** 시험 사건의 펜싱 토큰(eventKey 식의 마지막 조각) */
const TOKEN = 1762225200123456;
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000acc01';
const HOLD = '019a4b2c-1d00-7e00-8a00-00000000b01d';
const HELD_AT = Date.parse('2026-11-04T03:00:00.123Z');
const EXP = HELD_AT + 7 * 60_000;

function uuid8Of(input: string): string {
  const b = Buffer.from(createHash('sha256').update(input).digest().subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x80;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function heldMessage(over: Partial<SeatEventMessage> = {}): SeatEventMessage {
  return {
    eventId: EV,
    seatId: SEAT,
    tierId: '일반석-R',
    sectionId: 'sec-a',
    type: 'HELD',
    fencingToken: 1762225200123456,
    sectionVersion: 42,
    seatEpoch: 1762225000,
    holdId: HOLD,
    holdKind: 'FAN',
    purchaseSessionId: 'jti-abc-1',
    accountId: ACCOUNT,
    expiresAt: new Date(EXP).toISOString(),
    occurredAt: new Date(HELD_AT).toISOString(),
    eventKey: uuid8Of(`SeatEvent:HELD:${EV}:${HOLD}:${SEAT}:${TOKEN}`),
    ...over,
  };
}

const record = (topic: TradeRecord['topic'], n: number): TradeRecord => ({ topic, key: EV, value: Buffer.from(`v${n}`), headers: { 'x-n': String(n) } });

/** send만 있는 가짜 생산자: 받은 인자를 적는다. fail을 주면 그 차례의 send가 던진다 */
function fakeProducer() {
  const sends: unknown[] = [];
  const o: { fail?: (i: number) => unknown; wait?: (i: number) => Promise<void> } = {};
  const producer = {
    send: async (r: unknown) => {
      const i = sends.length;
      sends.push(r);
      await o.wait?.(i);
      const x = o.fail?.(i);
      if (x !== undefined) throw x;
      return [];
    },
  };
  const publisher = new KafkaTradeEventPublisher(producer as unknown as ConstructorParameters<typeof KafkaTradeEventPublisher>[0]);
  return { sends, o, publisher };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

describe('jsonTradeEventCodec: JSON 대역 값', () => {
  test('값은 UTF-8 JSON 바이트다: 받는 쪽처럼 JSON.parse(value.toString("utf8"))하면 같은 객체이고 한글도 깨지지 않는다(두 토픽 모두) [ASVS v5.0.0-2.2.1]', () => {
    const seat = heldMessage();
    const v = jsonTradeEventCodec.encode(SEAT_TOPIC, seat);
    expect(Buffer.isBuffer(v)).toBe(true);
    expect(JSON.parse(v.toString('utf8'))).toEqual(seat);
    expect(v.toString('utf8')).toContain('일반석-R');
    expect(v.byteLength).toBe(Buffer.byteLength(v.toString('utf8'), 'utf8'));
    const session = { eventId: EV, purchaseSessionId: 'jti-abc-1', admissionJti: 'jti-abc-1', reason: 'LEFT', endedAt: '2026-11-04T03:05:00.000Z', eventKey: uuid8Of('PurchaseSessionEnded:jti-abc-1') };
    expect(JSON.parse(jsonTradeEventCodec.encode(PURCHASE_SESSION_TOPIC, session).toString('utf8'))).toEqual(session);
  });

  test('ST5_16자리 펜싱 토큰이 JSON을 오가도 자릿수를 잃지 않는다 [S-T5]', () => {
    const m = heldMessage({ fencingToken: 9007199254740991 });
    expect((JSON.parse(jsonTradeEventCodec.encode(SEAT_TOPIC, m).toString('utf8')) as SeatEventMessage).fencingToken).toBe(9007199254740991);
  });
});

describe('KafkaTradeEventPublisher: 준 차례대로, 연이은 같은 토픽끼리 send 한 번', () => {
  test('ST5_연이은 같은 토픽은 send 한 번에 묶고, 토픽이 바뀌면 다음 send로 넘어가 차례를 지킨다(메시지는 key·value·headers 그대로) [S-T5]', async () => {
    const rs = [record(SEAT_TOPIC, 1), record(SEAT_TOPIC, 2), record(PURCHASE_SESSION_TOPIC, 3), record(SEAT_TOPIC, 4), record(SEAT_TOPIC, 5)];
    const { sends, publisher } = fakeProducer();
    await publisher.publish(rs);
    const msg = (r: TradeRecord) => ({ key: r.key, value: r.value, headers: r.headers });
    expect(sends).toEqual([
      { topic: SEAT_TOPIC, messages: [msg(rs[0]!), msg(rs[1]!)] },
      { topic: PURCHASE_SESSION_TOPIC, messages: [msg(rs[2]!)] },
      { topic: SEAT_TOPIC, messages: [msg(rs[3]!), msg(rs[4]!)] },
    ]);
    // 값 바이트는 바꾸지 않는다
    expect((sends[0] as { messages: { value: Buffer }[] }).messages[0]!.value.equals(rs[0]!.value)).toBe(true);
  });

  test('ST5_모두 같은 토픽이면 send 한 번이다 [S-T5]', async () => {
    const rs = [record(SEAT_TOPIC, 1), record(SEAT_TOPIC, 2), record(SEAT_TOPIC, 3)];
    const { sends, publisher } = fakeProducer();
    await publisher.publish(rs);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toEqual({ topic: SEAT_TOPIC, messages: rs.map((r) => ({ key: r.key, value: r.value, headers: r.headers })) });
  });

  test('빈 배열이면 send를 부르지 않는다', async () => {
    const { sends, publisher } = fakeProducer();
    await publisher.publish([]);
    expect(sends).toEqual([]);
  });

  test('send가 던지면 publish도 그 오류로 던진다(릴레이가 확인하지 않게). 뒤 묶음의 send가 던져도 같다 [ASVS v5.0.0-16.5.2]', async () => {
    const boom = new Error('kafka down');
    const one = fakeProducer();
    one.o.fail = () => boom;
    await expect(one.publisher.publish([record(SEAT_TOPIC, 1)])).rejects.toBe(boom);
    const two = fakeProducer();
    two.o.fail = (i) => (i === 1 ? boom : undefined);
    await expect(two.publisher.publish([record(SEAT_TOPIC, 1), record(PURCHASE_SESSION_TOPIC, 2)])).rejects.toBe(boom);
  });

  test('publish는 send의 확인을 받기 전에 끝나지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const { o, publisher, sends } = fakeProducer();
    let release: (() => void) | undefined;
    o.wait = () =>
      new Promise<void>((r) => {
        release = r;
      });
    let done = false;
    const p = publisher.publish([record(SEAT_TOPIC, 1)]).then(() => void (done = true));
    p.catch(() => undefined);
    for (let i = 0; i < 10; i++) await flush();
    expect(sends).toHaveLength(1);
    expect(done).toBe(false);
    release!();
    await p;
    expect(done).toBe(true);
  });
});

/** apply만 적는 가짜 원장 */
function fakeLedger() {
  const applied: LedgerHoldEvent[] = [];
  const o: { fail?: () => unknown } = {};
  const ledger: SeatHoldLedger = {
    apply: async (e) => {
      applied.push(e);
      const x = o.fail?.();
      if (x !== undefined) throw x;
    },
  };
  return { applied, o, ledger, handler: new SeatHoldLedgerHandler(ledger) };
}

const consumed = (value: Buffer | null, key: string | null = EV): ConsumedMessage => ({ topic: SEAT_TOPIC, partition: 0, offset: 7n, key, value, headers: {}, timestamp: 0 });
const jsonValue = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8');

const expectedLedger = (over: Partial<LedgerHoldEvent> = {}): LedgerHoldEvent => ({
  eventId: EV,
  seatId: SEAT,
  accountId: ACCOUNT,
  type: 'HELD',
  fencingToken: 1762225200123456,
  holdKind: 'FAN',
  occurredAtMs: HELD_AT,
  expiresAtMs: EXP,
  eventKey: uuid8Of(`SeatEvent:HELD:${EV}:${HOLD}:${SEAT}:${TOKEN}`),
  holdId: HOLD,
  purchaseSessionId: 'jti-abc-1',
  ...over,
});

describe('SeatHoldLedgerHandler.decode: 홀드 사건만 원장 사건으로 읽는다', () => {
  test('ST35_홀드 사건 값(JSON)은 {kind: hold, event: toLedgerHoldEvent 결과}다 [ASVS v5.0.0-2.2.1]', () => {
    const { handler } = fakeLedger();
    const v = heldMessage();
    const r = handler.decode(consumed(jsonTradeEventCodec.encode(SEAT_TOPIC, v)));
    expect(r).toEqual({ kind: 'hold', event: expectedLedger() });
    expect(r).toEqual({ kind: 'hold', event: toLedgerHoldEvent(JSON.parse(JSON.stringify(v))) });
  });

  test.each(['PENDING', 'SOLD', 'AVAILABLE', 'RETURNED'])('판매 사건 %s는 건너뛴다(skip, 키는 skip: + 메시지 키라 홀드 사건의 키와 섞이지 않는다)', async (type) => {
    const { handler, applied } = fakeLedger();
    const sale = { eventId: EV, seatId: SEAT, tierId: 'tier-r', sectionId: 'sec-a', type, occurredAt: '2026-11-04T03:01:00.000Z', eventKey: '0190f3a1-7c2e-7a00-8000-0000000000f1' };
    const m = consumed(jsonValue(sale), EV);
    const r = handler.decode(m);
    expect(r).toEqual({ kind: 'skip', key: `skip:${EV}` });
    await handler.handle(r as LedgerRecord, m);
    expect(applied).toEqual([]);
  });

  test('EventSaleChanged(status·version이 있고 type이 없는 값)는 건너뛴다', () => {
    const { handler } = fakeLedger();
    const changed = { eventId: EV, status: 'SOLD_OUT', previousStatus: 'ON_SALE', available: 0, held: 0, paying: 0, version: 12, changedAt: '2026-11-04T03:10:00.000Z', eventKey: '0190f3a1-7c2e-7a00-8000-0000000000f2' };
    expect(handler.decode(consumed(jsonValue(changed), EV))).toEqual({ kind: 'skip', key: `skip:${EV}` });
  });

  test('type이 없는 값은 건너뛰고, 메시지 키가 없으면 skip의 키는 "skip:"이다', () => {
    const { handler } = fakeLedger();
    expect(handler.decode(consumed(jsonValue({ eventId: EV, seatId: SEAT }), EV))).toEqual({ kind: 'skip', key: `skip:${EV}` });
    expect(handler.decode(consumed(jsonValue({ eventId: EV, seatId: SEAT }), null))).toEqual({ kind: 'skip', key: 'skip:' });
    expect(handler.decode(consumed(jsonValue({ eventId: EV, status: 'ON_SALE', version: 3 }), null))).toEqual({ kind: 'skip', key: 'skip:' });
  });

  test('값이 없거나(null) JSON이 아니거나 모양이 틀린 홀드 사건은 decode가 던지지 않고 bad로 돌려주며(업무 키를 회차 키로 잃지 않게), handle이 RangeError로 던진다(같은 결과일 실패라 키 단위 소비자가 보류한다) [ASVS v5.0.0-2.2.1]', async () => {
    const { handler, applied } = fakeLedger();
    const noAccount: Record<string, unknown> = { ...heldMessage() };
    delete noAccount.accountId;
    const cases: [ReturnType<typeof consumed>, string][] = [
      [consumed(null, EV), `bad:${EV}`],
      [consumed(Buffer.from('not json{', 'utf8'), EV), `bad:${EV}`],
      [consumed(jsonValue(heldMessage({ seatId: 'A01' })), EV), `${EV}:A01`],
      [consumed(jsonValue(noAccount), EV), `${EV}:${SEAT}`],
      [consumed(jsonValue(heldMessage({ eventId: EV.toUpperCase() })), EV), `${EV.toUpperCase()}:${SEAT}`],
    ];
    for (const [m, key] of cases) {
      const r = handler.decode(m);
      expect(r.kind, key).toBe('bad');
      expect(handler.keyOf(r, m), '모양이 틀려도 회차·좌석을 읽을 수 있으면 그 좌석의 키로 보류한다').toBe(key);
      await expect(handler.handle(r, m)).rejects.toThrow(RangeError);
    }
    expect(applied).toEqual([]);
  });
});

describe('SeatHoldLedgerHandler: 업무 키·중복 제거 키·적용', () => {
  test('ST5_업무 키는 홀드 사건이면 회차 ID:좌석 ID(같은 좌석의 사건은 차례대로, 같은 공연장 좌석을 쓰는 다른 회차와는 섞이지 않게), 건너뛸 레코드면 그 키다 [S-T5]', () => {
    const { handler } = fakeLedger();
    const m = consumed(jsonValue(heldMessage()), EV);
    const hold = handler.decode(m);
    expect(handler.keyOf(hold, m)).toBe(`${EV}:${SEAT}`);
    const other = '0190f3a1-7c2e-7a00-8000-00000000a002';
    const m2 = consumed(jsonValue(heldMessage({ seatId: other })), EV);
    expect(handler.keyOf(handler.decode(m2), m2)).toBe(`${EV}:${other}`);
    // 같은 좌석 ID를 쓰는 다른 회차(같은 공연장)는 다른 키다
    const otherEvent = '0190f3a1-7c2e-7a00-8000-0000000000e9';
    const m3 = consumed(jsonValue(heldMessage({ eventId: otherEvent })), otherEvent);
    expect(handler.keyOf(handler.decode(m3), m3)).toBe(`${otherEvent}:${SEAT}`);
    const skip: LedgerRecord = { kind: 'skip', key: `skip:${EV}` };
    expect(handler.keyOf(skip, m)).toBe(`skip:${EV}`);
  });

  test('ADR0052_중복 제거 키는 홀드 사건이면 eventKey, 건너뛸 레코드면 없다(undefined)', () => {
    const { handler } = fakeLedger();
    const m = consumed(jsonValue(heldMessage()));
    expect(handler.eventKeyOf(handler.decode(m))).toBe(uuid8Of(`SeatEvent:HELD:${EV}:${HOLD}:${SEAT}:${TOKEN}`));
    expect(handler.eventKeyOf({ kind: 'skip', key: `skip:${EV}` })).toBeUndefined();
  });

  test('ST5_handle은 홀드 사건만 ledger.apply를 한 번 부르고(받은 차례대로), 건너뛸 레코드는 아무것도 부르지 않는다 [S-T5]', async () => {
    const { handler, applied } = fakeLedger();
    const heldM = consumed(jsonValue(heldMessage()));
    const expiredMsg = heldMessage({ type: 'EXPIRED', occurredAt: new Date(EXP + 5).toISOString(), eventKey: uuid8Of(`SeatEvent:EXPIRED:${EV}:${HOLD}:${SEAT}:${TOKEN}`) });
    const expiredM = consumed(jsonValue(expiredMsg));
    await handler.handle(handler.decode(heldM), heldM);
    await handler.handle({ kind: 'skip', key: `skip:${EV}` }, consumed(null));
    await handler.handle(handler.decode(expiredM), expiredM);
    expect(applied).toEqual([expectedLedger(), expectedLedger({ type: 'EXPIRED', occurredAtMs: EXP + 5, eventKey: expiredMsg.eventKey })]);
  });

  test('ledger.apply가 던지면 handle도 그 오류로 던진다(일시 실패·같은 결과일 실패의 가름은 키 단위 소비자가 한다)', async () => {
    const { handler, o } = fakeLedger();
    const boom = Object.assign(new Error('connection terminated'), { code: '57P01' });
    o.fail = () => boom;
    const m = consumed(jsonValue(heldMessage()));
    await expect(handler.handle(handler.decode(m), m)).rejects.toBe(boom);
  });

  test('ST35_Stream HELD 칸 → 갈 곳 → JSON 값 → 처리기 → 원장 사건으로 이어도 잡은 시각(held_at)·만료 시각·토큰·계정이 그대로다 [ASVS v5.0.0-2.2.1]', async () => {
    const { handler, applied } = fakeLedger();
    const fields = {
      type: 'HELD',
      seatIdx: '17',
      seatId: SEAT,
      tierId: 'tier-r',
      sectionId: 'sec-a',
      holdId: HOLD,
      holdKind: 'FAN',
      purchaseSessionId: 'jti-abc-1',
      accountId: ACCOUNT,
      fencingToken: '1762225200123456',
      sectionVersion: '42',
      seatEpoch: '1762225000',
      occurredAtMs: String(HELD_AT),
      expiresAtMs: String(EXP),
    };
    const route = routeStreamEntry(EV, { id: '1762225200123-0', fields });
    if (route.kind !== 'send') throw new Error(`보낼 항목이어야 한다: ${route.reason}`);
    expect(route.topic).toBe(SEAT_TOPIC);
    const m = consumed(jsonTradeEventCodec.encode(route.topic, route.message), EV);
    await handler.handle(handler.decode(m), m);
    expect(applied).toEqual([expectedLedger()]);
  });
});
