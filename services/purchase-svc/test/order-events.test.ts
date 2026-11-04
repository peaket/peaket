// 주문 사건 값의 JSON 대역(jsonOrderEventCodec)과 토픽 이름(BUILD_ORDER PRF-160, docs/features/payment.md §3 '주문 저장소의 첫 구현':
// '값은 Avro 인코더(BAS-030)가 오기 전까지 좌석 사건과 같은 JSON 대역이다'). 좌석 사건 jsonTradeEventCodec 시험(test/trade-events.test.ts)과 같은 꼴이다.
// 받는 쪽은 JSON.parse(value.toString('utf8'))로 푼다.
import { OrderEvent } from '@peaket/contracts/asyncapi';
import { describe, expect, test } from 'vitest';
import { jsonOrderEventCodec, type OrderEventMessage, TRADE_ORDERS_TOPIC } from '../src/modules/booking/index.js';

const EV = '0190f3a1-7c2e-7a00-8000-0000000000e1';
const ORDER = '0190f3a1-7c2e-7a00-8000-0000000000d1';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000acc01';
const SEAT_A = '0190f3a1-7c2e-7a00-8000-00000000a001';
const SEAT_B = '0190f3a1-7c2e-7a00-8000-00000000a002';

/** 손으로 쓴 주문 사건(CREATED, 한글 등급 이름 포함). buildOrderEvent를 거치지 않아 이 시험은 대역만 본다 */
function createdMessage(over: Partial<OrderEventMessage> = {}): OrderEventMessage {
  return {
    eventId: EV,
    orderId: ORDER,
    accountId: ACCOUNT,
    type: 'CREATED',
    amount: 154_000,
    seatIds: [SEAT_B, SEAT_A],
    purchaseSessionId: 'jti-abc-1',
    journeyId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
    contactRef: 'v1.c0ntactRefAbC123',
    refMissing: false,
    items: [
      { seatId: SEAT_B, tierId: '일반석-R', sectionId: 'sec-b', price: 99_000 },
      { seatId: SEAT_A, tierId: 'tier-s', sectionId: 'sec-a', price: 55_000 },
    ],
    seatAssignment: 'PICK',
    firstInStage: false,
    occurredAt: '2026-11-05T03:00:00.123Z',
    eventKey: '7d1c2a3b-4e5f-8a6b-9c7d-0e1f2a3b4c5d',
    ...over,
  };
}

const utf8 = (v: Uint8Array): string => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('utf8');

describe('jsonOrderEventCodec: 주문 사건 JSON 대역 값', () => {
  test('ADR0113_값은 UTF-8 JSON 바이트다: 받는 쪽처럼 JSON.parse(value.toString("utf8"))하면 같은 객체이고 한글도 깨지지 않는다 [ASVS v5.0.0-2.2.1]', () => {
    const m = createdMessage();
    const v = jsonOrderEventCodec.encode(m);
    expect(v).toBeInstanceOf(Uint8Array);
    const text = utf8(v);
    expect(JSON.parse(text)).toEqual(m);
    expect(text).toContain('일반석-R');
    // 바이트 수가 UTF-8 글의 바이트 수와 같다(UTF-16·Latin-1이 아니다)
    expect(v.byteLength).toBe(Buffer.byteLength(text, 'utf8'));
    expect(Buffer.from(text, 'utf8').equals(Buffer.from(v))).toBe(true);
  });

  test('ADR0113_뒤 사건(CREATED 칸 없음)도 같은 객체로 돌아오고, 푼 값은 계약 OrderEvent를 통과한다 [ASVS v5.0.0-2.2.1]', () => {
    const later = createdMessage({ type: 'DEPOSIT_REVERSED', firstInStage: false, eventKey: '1a2b3c4d-5e6f-8a7b-8c9d-0e1f2a3b4c5d' });
    delete later.purchaseSessionId;
    delete later.journeyId;
    delete later.contactRef;
    const back = JSON.parse(utf8(jsonOrderEventCodec.encode(later))) as Record<string, unknown>;
    expect(back).toEqual(later);
    for (const k of ['purchaseSessionId', 'journeyId', 'contactRef']) expect(Object.keys(back), k).not.toContain(k);
    expect(OrderEvent.safeParse(back).success).toBe(true);
    expect(OrderEvent.safeParse(JSON.parse(utf8(jsonOrderEventCodec.encode(createdMessage())))).success).toBe(true);
  });

  test('ADR0113_금액·가격 정수가 JSON을 오가도 그대로다(큰 금액 포함)', () => {
    const m = createdMessage({ amount: 2_147_483_647, items: [{ seatId: SEAT_A, tierId: 't', sectionId: 's', price: 2_147_483_647 }], seatIds: [SEAT_A] });
    const back = JSON.parse(utf8(jsonOrderEventCodec.encode(m))) as OrderEventMessage;
    expect(back.amount).toBe(2_147_483_647);
    expect(back.items[0]!.price).toBe(2_147_483_647);
  });
});

describe('TRADE_ORDERS_TOPIC', () => {
  test('ADR0113_주문 사건 토픽 이름은 trade.orders다(asyncapi·payment §3)', () => {
    expect(TRADE_ORDERS_TOPIC).toBe('trade.orders');
  });
});
