// 주문 사건(trade.orders OrderEvent)의 Avro 바이트 시험(F-04-2 계획 §6 A-T26 ①·⑤, ADR-0357 결정 3·6·8·9, docs/features/analytics.md A-T26).
// 사건은 도메인(buildOrderEvent·buildIssueDelayedEvent)과 회차 환급 팬 알림 어댑터(OutboxEventRefundFanNotifier)가 만들고, 값은 운영 조립과 같은
// avroOrderEventCodec(공용 인코더)로 만든다. 푼 쪽은 제품 인코더가 아니라 시험 도구(packages/platform/test/produced-avro.ts, avsc + 계약 판 .avsc)다.
// 단언 값은 정본에서 적는다: 공통 판정 넷(A-T26), CREATED의 journeyId·contactRef 또는 refMissing(A-T26 ①), eventKey 식(결정 6:
// SHA-256('OrderEvent:' + 주문 ID + ':' + 이력 번호)의 앞 16바이트, 버전 8), 팬 알림 칸의 x-present-when(asyncapi OrderEvent, R-583). 스키마 ID는 17.
import { createHash } from 'node:crypto';
import { avroSchemas } from '@peaket/contracts/avro';
import { AvroEncodeError, createAvroEncoder } from '@peaket/platform/avro';
import { describe, expect, test } from 'vitest';
import { countUtf8, decodeProduced } from '../../../packages/platform/test/produced-avro.js';
import {
  avroOrderEventCodec,
  buildIssueDelayedEvent,
  buildOrderEvent,
  type CreatedExtras,
  ORDER_EVENT_RECORD,
  ORDER_TRANSITIONS,
  type OrderItem,
  type OrderRow,
  type OrderTransition,
  orderEventType,
  TRADE_ORDERS_TOPIC,
} from '../src/modules/booking/index.js';
import { OutboxEventRefundFanNotifier } from '../src/modules/refund/index.js';
import type { EventCancellationRequest, EventRefundItem, EventRefundTarget } from '../src/modules/refund/domain/event-refund.js';

const SUBJECT = 'trade.orders-peaket.trade.OrderEvent';
const SCHEMA_ID = 17;
const EV = '0190f3a1-7c2e-7a00-8000-0000000000e1';
const ORDER = '0190f3a1-7c2e-7a00-8000-0000000000d1';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000acc01';
const SEAT_A = '0190f3a1-7c2e-7a00-8000-00000000a001';
const SEAT_B = '0190f3a1-7c2e-7a00-8000-00000000a002';
const JOURNEY = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const AT = Date.UTC(2026, 10, 23, 3, 4, 5, 678);

const codec = () => avroOrderEventCodec(createAvroEncoder({ schemaIds: { [SUBJECT]: SCHEMA_ID }, schemas: avroSchemas, produces: [{ topic: TRADE_ORDERS_TOPIC, record: ORDER_EVENT_RECORD }] }));

/** 정본 eventKey 식(ADR-0357 결정 6, purchase-svc orderEventKey와 같은 계산을 시험이 따로 한다): RFC 9562 버전 8·변형 10 */
function uuid8Of(input: string): string {
  const b = createHash('sha256').update(input).digest().subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x80;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const items: OrderItem[] = [
  { seatId: SEAT_B, tierId: '일반석-R', sectionId: 'sec-b', unitPrice: 99_000 },
  { seatId: SEAT_A, tierId: 'tier-s', sectionId: 'sec-a', unitPrice: 55_000 },
];
const row = (t: OrderTransition): OrderRow => ({ id: ORDER, accountId: ACCOUNT, eventId: EV, status: t.to, amount: 154_000, eventSeq: 3, paymentEventSeq: 2, seatAssignment: 'AUTO' });
const T = (id: string): OrderTransition => ORDER_TRANSITIONS.find((t) => t.id === id)!;

/** 사건을 내는 전이 하나씩(사건 종류마다 첫 전이). REFUNDED는 아래 따로 본다 */
const byType = new Map<string, OrderTransition>();
for (const t of ORDER_TRANSITIONS) {
  const type = orderEventType(t);
  if (type !== undefined && !byType.has(type)) byType.set(type, t);
}

/** 공통 판정 ①②③(머리·필수·x-present-when·UNRECOGNIZED)과 푼 값 */
function judged(bytes: Uint8Array) {
  const p = decodeProduced(bytes, ORDER_EVENT_RECORD);
  expect(p.schemaId).toBe(SCHEMA_ID);
  expect([...bytes.subarray(0, 5)]).toEqual([0, 0, 0, 0, SCHEMA_ID]);
  expect(p.violations).toEqual([]);
  return p.value;
}

describe('A-T26 ① 주문 사건(trade.orders)', () => {
  test('A-T26 ① 주문 사건 종류마다 공통 판정을 만족하고 CREATED의 조사 칸이 맞다', () => {
    const c = codec();
    // 전이 표가 내는 사건 종류(REFUNDED 빼고)와 발권 지연 ISSUE_DELAYED. 빈 목록이 통과로 새지 않게 수를 본다
    const kinds = [...byType.keys()].filter((k) => k !== 'REFUNDED').sort();
    expect(kinds).toEqual(['ACCEPTED', 'APPROVED', 'AWAITING_DEPOSIT', 'COMPENSATED', 'CONFIRMED', 'CREATED', 'DEPOSIT_REVERSED', 'EXPIRED', 'FAILED', 'PARTIALLY_REFUNDED', 'RESERVED']);
    let seq = 1;
    for (const kind of kinds) {
      const t = byType.get(kind)!;
      seq += 1;
      const created: CreatedExtras | undefined = t.id === 'T1' ? { purchaseSessionId: 'jti-abc-1', journeyId: JOURNEY, contactRef: 'v1.c0ntactRefAbC123', refMissing: false } : undefined;
      const m = buildOrderEvent({ order: row(t), items, transition: t, seq, occurredAtMs: AT, reachedBefore: false, ...(created ? { created } : {}) })!;
      const v = judged(c.encode(m));
      expect(v, kind).toMatchObject({
        eventId: EV,
        orderId: ORDER,
        accountId: ACCOUNT,
        type: kind,
        amount: 154_000,
        seatIds: [SEAT_B, SEAT_A],
        items: [
          { seatId: SEAT_B, tierId: '일반석-R', sectionId: 'sec-b', price: 99_000 },
          { seatId: SEAT_A, tierId: 'tier-s', sectionId: 'sec-a', price: 55_000 },
        ],
        seatAssignment: 'AUTO',
        occurredAt: AT,
        eventKey: uuid8Of(`OrderEvent:${ORDER}:${seq}`),
      });
      // 회차 환급 칸은 주문 전이 사건에 없다
      expect([v.refundAmount, v.fanNoticeReason, v.postponedTo, v.refundWindowClosesAt], kind).toEqual([null, null, null, null]);
      if (kind === 'CREATED') expect(v, kind).toMatchObject({ purchaseSessionId: 'jti-abc-1', journeyId: JOURNEY, contactRef: 'v1.c0ntactRefAbC123', refMissing: false });
      else expect([v.purchaseSessionId, v.journeyId, v.contactRef, v.refMissing], kind).toEqual([null, null, null, false]);
    }
    // 연락처 가명을 계산하지 못한 CREATED: contactRef 없이 refMissing 참(x-present-when의 refMissing [false] 조건이 풀린다)
    const noRef = buildOrderEvent({ order: row(T('T1')), items, transition: T('T1'), seq: 1, occurredAtMs: AT, reachedBefore: false, created: { purchaseSessionId: 'jti-abc-2', journeyId: JOURNEY, refMissing: true } })!;
    expect(judged(c.encode(noRef))).toMatchObject({ type: 'CREATED', purchaseSessionId: 'jti-abc-2', journeyId: JOURNEY, contactRef: null, refMissing: true, eventKey: uuid8Of(`OrderEvent:${ORDER}:1`) });
    // 발권 지연(상태 전이 없음)
    const delayed = buildIssueDelayedEvent({ order: row(T('T9')), items, occurredAtMs: AT, issueGeneration: 2 });
    expect(judged(c.encode(delayed))).toMatchObject({ type: 'ISSUE_DELAYED', orderId: ORDER, occurredAt: AT, eventKey: uuid8Of(`OrderEvent:${ORDER}:ISSUE_DELAYED:2`) });
  });

  test('A-T26 ① 고객 취소로 끝난 주문의 REFUNDED(T23·T24·T26)도 공통 판정을 만족한다(refundAmount, x-present-when type REFUNDED)', () => {
    const c = codec();
    for (const id of ['T23', 'T24', 'T26']) {
      const t = T(id);
      expect(orderEventType(t), id).toBe('REFUNDED');
      const m = buildOrderEvent({ order: row(t), items, transition: t, seq: 7, occurredAtMs: AT, reachedBefore: false })!;
      const v = judged(c.encode(m));
      expect(v, id).toMatchObject({ type: 'REFUNDED', eventKey: uuid8Of(`OrderEvent:${ORDER}:7`) });
      expect(typeof v.refundAmount, id).toBe('number');
    }
  });

  test('A-T26 ⑤ 필수 칸을 비운 주문 사건은 코덱이 AvroEncodeError로 던진다(삼키지 않고 JSON으로 내지 않는다)', () => {
    const c = codec();
    const m = buildOrderEvent({ order: row(T('T1')), items, transition: T('T1'), seq: 1, occurredAtMs: AT, reachedBefore: false, created: { purchaseSessionId: 'jti-abc-3', journeyId: JOURNEY, contactRef: 'v1.ref', refMissing: false } })!;
    // CREATED인데 구매 세션 ID가 없다(x-present-when type CREATED)
    const { purchaseSessionId: _gone, ...noSession } = m;
    expect(() => c.encode(noSession)).toThrow(AvroEncodeError);
    // 계약에 없는 사건 종류
    expect(() => c.encode({ ...m, type: 'UNRECOGNIZED' })).toThrow(AvroEncodeError);
  });
});

describe('A-T26 ① 회차 환급 팬 알림(trade.orders, ADR-0357 결정 9)', () => {
  const OPERATOR = 'admin:0190f3a1-7c2e-7a00-8000-00000000ad01';
  const TICKET = '0190f3a1-7c2e-7a00-8000-0000000071c1';
  const request = (o: Partial<EventCancellationRequest> = {}): EventCancellationRequest => ({
    requestId: '0190f3a1-7c2e-7a00-8000-0000000000f1',
    eventId: EV,
    kind: 'CANCEL',
    status: 'APPROVED',
    fanNoticeReason: '공연장 안전 점검으로 회차를 취소합니다',
    targetOrders: 1,
    refundTotal: 99_000,
    compensationTargets: 0,
    compensationTotal: 0,
    progress: { total: 1, done: 0, failed: 0, notApplied: 0, perPg: [] },
    ruledBy: OPERATOR,
    confirmedBy: OPERATOR,
    createdAtMs: AT - 60_000,
    updatedAtMs: AT,
    ...o,
  });
  const target: EventRefundTarget = { orderId: ORDER, ticketId: TICKET, seatId: SEAT_A, payerAccountId: ACCOUNT, ticketPrice: 99_000, bookedAtMs: AT - 86_400_000, saleEndsAtMs: AT + 86_400_000, pg: 'TOSS' };
  const item = (o: Partial<EventRefundItem> = {}): EventRefundItem => ({ requestId: request().requestId, orderId: ORDER, ticketId: TICKET, cancellationId: '0190f3a1-7c2e-7a00-8000-0000000000c1', pg: 'TOSS', status: 'FAILED', attempts: 3, ...o });
  const POSTPONED_TO = Date.UTC(2026, 11, 24, 10, 0, 0);
  const WINDOW_CLOSES = Date.UTC(2026, 11, 1, 14, 59, 59, 999);

  test('A-T26 ① 회차 환급 팬 알림도 같은 형식이다', () => {
    const n = new OutboxEventRefundFanNotifier(codec());
    const cancelled = n.confirmed(request(), [target], AT);
    const postponed = n.confirmed(request({ kind: 'POSTPONE', fanNoticeReason: '출연자 건강 문제로 연기합니다', postponedToMs: POSTPONED_TO, refundWindowClosesAtMs: WINDOW_CLOSES }), [target], AT);
    const refunded = n.refunded(request(), item({ status: 'REFUNDED' }), target, AT);
    const failed = n.failed(request(), item({ lastError: 'PG_TIMEOUT' }), target, AT);
    const failedNoReason = n.failed(request(), item(), target, AT);
    const all = [...cancelled, ...postponed, refunded, failed, failedNoReason];
    expect(all).toHaveLength(5);
    const values = all.map((m) => {
      expect(m.topic).toBe('trade.orders');
      // 파티션 키는 회차 ID(CLAUDE.md '서비스 사이', asyncapi trade.orders)
      expect(m.key).toBe(EV);
      // 계약에 없는 칸(티켓 ID·처리자)은 바이트에 없다
      expect(countUtf8(m.payload, TICKET)).toBe(0);
      expect(countUtf8(m.payload, OPERATOR)).toBe(0);
      return judged(m.payload);
    });
    expect(values.map((v) => v.type)).toEqual(['EVENT_CANCELLATION_CONFIRMED', 'EVENT_POSTPONED', 'REFUNDED', 'REFUND_FAILED', 'REFUND_FAILED']);
    expect(values[0]).toMatchObject({ orderId: ORDER, accountId: ACCOUNT, eventId: EV, fanNoticeReason: '공연장 안전 점검으로 회차를 취소합니다', refundAmount: null, postponedTo: null, occurredAt: AT });
    expect(values[1]).toMatchObject({ fanNoticeReason: '출연자 건강 문제로 연기합니다', postponedTo: POSTPONED_TO, refundWindowClosesAt: WINDOW_CLOSES });
    expect(values[2]).toMatchObject({ refundAmount: 99_000, fanNoticeReason: null, seatIds: [SEAT_A] });
    expect(values[3]).toMatchObject({ fanNoticeReason: 'PG_TIMEOUT', refundAmount: null });
    // 사유가 빈 환급 실패도 계약(사유 필수)을 채운다
    expect(typeof values[4]!.fanNoticeReason).toBe('string');
    expect((values[4]!.fanNoticeReason as string).length).toBeGreaterThan(0);
    // 같은 요청·티켓·종류의 재시도는 같은 eventKey, 종류가 다르면 다르다
    expect(new Set(values.slice(0, 4).map((v) => v.eventKey)).size).toBe(4);
    expect(values[4]!.eventKey).toBe(values[3]!.eventKey);
  });

  test('A-T26 ⑤ 회차 취소·연기 확정에 fanNoticeReason이 없으면(연기는 새 시각이 없어도) 인코딩 오류로 던진다', () => {
    const n = new OutboxEventRefundFanNotifier(codec());
    const { fanNoticeReason: _r, ...noReason } = request();
    let e: unknown;
    try {
      n.confirmed(noReason, [target], AT);
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(AvroEncodeError);
    expect((e as AvroEncodeError).fields).toEqual(['fanNoticeReason']);
    expect(() => n.confirmed({ ...noReason, kind: 'POSTPONE', postponedToMs: POSTPONED_TO, refundWindowClosesAtMs: WINDOW_CLOSES }, [target], AT)).toThrow(AvroEncodeError);
    expect(() => n.confirmed(request({ kind: 'POSTPONE' }), [target], AT)).toThrow(AvroEncodeError);
    // 대상이 없으면 낼 것도 없다(던지지 않는다)
    expect(n.confirmed(noReason, [], AT)).toEqual([]);
  });
});
