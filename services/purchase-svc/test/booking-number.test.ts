// F-06-8 N-T27 ①·②: 예매번호 KST 날짜 8자리 + 5자리 일련번호, 99,999 상한, 503 booking-number-exhausted.
// 흉내 저장소·고정 시계. 실제 DB·Docker를 쓰지 않는다.
import { randomUUID } from 'node:crypto';
import { ProblemError, fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { CreateOrder } from '../src/modules/booking/application/create-order.js';
import * as booking from '../src/modules/booking/index.js';
import { ORDER_PROBLEMS, orderResponseOf, throwOrderProblem, type CreateOrderDeps, type NewOrder } from '../src/modules/booking/index.js';
import { AMOUNT, CONSENT_VERSION, ITEMS, NOW, okBody, okCommand, okIdem, OrderFakes } from './order-cases.js';

/** 이 시험의 예매번호 날짜(2026-10-14 KST)와 같은 호출 시각. `order-cases`의 NOW(11-05)와 섞지 않는다 */
const BOOKING_NOW = Date.parse('2026-10-14T03:00:00.000Z');

type BookingNumberAllocation = { seq: number } | { exhausted: true };
type BookingNumbers = { next(nowMs: number): Promise<BookingNumberAllocation> };
type BookingCreateDeps = CreateOrderDeps & { bookingNumbers: BookingNumbers };
type CreatedOrder = NewOrder & { bookingNo?: string };

/** 일련번호를 차례로 내주는 흉내. exhaustion이면 100,000번째를 흉내 낸다 */
function numbersOf(seqs: number[] | (() => BookingNumberAllocation)) {
  const calls: number[] = [];
  let i = 0;
  const next: BookingNumbers['next'] = async (nowMs) => {
    calls.push(nowMs);
    if (typeof seqs === 'function') return seqs();
    const seq = seqs[Math.min(i, seqs.length - 1)]!;
    i += 1;
    return { seq };
  };
  return { calls, next };
}

function useCase(o: { now?: number; seqs: number[] | (() => BookingNumberAllocation) }) {
  const clock = fakeClock({ now: o.now ?? NOW });
  const fx = new OrderFakes(clock);
  const numbers = numbersOf(o.seqs);
  let exhausted = 0;
  const signals = {
    ...fx.signals,
    bookingNumberExhausted: () => {
      exhausted += 1;
    },
  };
  const writes = {
    ...fx.writes,
    create: async (once: Parameters<typeof fx.writes.create>[0], order: NewOrder, options?: Parameters<typeof fx.writes.create>[2]) => {
      const out = await fx.writes.create(once, order, options);
      if (out.status === 'CREATED' || out.status === 'REPLAYED') {
        return { ...out, order: { ...out.order, bookingNumber: (order as CreatedOrder).bookingNo } };
      }
      return out;
    },
  };
  const deps = {
    ...fx.ports(),
    writes,
    signals,
    consentVersion: CONSENT_VERSION,
    clock,
    bookingNumbers: numbers,
  } as unknown as CreateOrderDeps;
  return { clock, fx, numbers, deps, exhausted: () => exhausted, order: new CreateOrder(deps) };
}

const created = (r: Awaited<ReturnType<CreateOrder['execute']>>): CreatedOrder => {
  expect(r.status).toBe(201);
  return (r as unknown as { status: 201; order: CreatedOrder }).order;
};

describe('F-06-8 예매번호', () => {
  test('N-T27 ① 한국 시각 2026-10-14에 만든 두 주문의 예매번호가 2026101400001·2026101400002이고 서로 다르다', async () => {
    const t = useCase({ now: BOOKING_NOW, seqs: [1, 2] });
    const first = created(await t.order.execute(okCommand({ idem: okIdem({ key: randomUUID() }), body: okBody() })));
    const second = created(await t.order.execute(okCommand({ idem: okIdem({ key: randomUUID() }), body: okBody() })));
    expect(first.bookingNo).toBe('2026101400001');
    expect(second.bookingNo).toBe('2026101400002');
    expect(first.bookingNo).not.toBe(second.bookingNo);
    expect(t.numbers.calls).toEqual([BOOKING_NOW, BOOKING_NOW]);
    expect(t.fx.created).toHaveLength(2);

    // 201 응답에도 같은 값이 실린다(openapi Order.bookingNumber)
    const response = orderResponseOf({ orderId: first.id, amount: first.amount, status: 'CONFIRMED', items: ITEMS, bookingNumber: first.bookingNo } as never) as { bookingNumber?: string };
    expect(response.bookingNumber).toBe('2026101400001');
  });

  test('N-T27 ① KST 자정 경계에서 날짜가 바뀐다', async () => {
    const before = useCase({ now: Date.parse('2026-10-14T14:59:59.999Z'), seqs: [1] });
    expect(created(await before.order.execute(okCommand({ idem: okIdem({ key: randomUUID() }), body: okBody() }))).bookingNo).toBe('2026101400001');

    const after = useCase({ now: Date.parse('2026-10-14T15:00:00.000Z'), seqs: [1] });
    expect(created(await after.order.execute(okCommand({ idem: okIdem({ key: randomUUID() }), body: okBody() }))).bookingNo).toBe('2026101500001');
  });

  test('IR068-04 멱등 재생(REPLAYED)은 원 주문 예매번호를 새 번호로 덮지 않는다', async () => {
    const clock = fakeClock({ now: BOOKING_NOW });
    const fx = new OrderFakes(clock);
    const numbers = numbersOf([1]);
    const writes = {
      ...fx.writes,
      create: async () => ({
        status: 'REPLAYED' as const,
        order: {
          orderId: '0190f3a1-7c2e-7f00-8000-0000000000f1',
          amount: AMOUNT,
          status: 'CREATED' as const,
          items: ITEMS,
          bookingNumber: '2026100199999',
        },
      }),
    };
    const deps = {
      ...fx.ports(),
      writes,
      signals: fx.signals,
      consentVersion: CONSENT_VERSION,
      clock,
      bookingNumbers: numbers,
    } as unknown as CreateOrderDeps;
    const r = await new CreateOrder(deps).execute(okCommand({ idem: okIdem({ key: randomUUID() }), body: okBody() }));
    expect(r.status).toBe(201);
    const order = (r as unknown as { order: { bookingNumber?: string; bookingNo?: string } }).order;
    expect(order.bookingNumber).toBe('2026100199999');
    expect(order.bookingNo).toBeUndefined();
  });

  test('N-T27 ② 99,999번째는 만들고 100,000번째는 503 booking-number-exhausted로 닫는다', async () => {
    const last = useCase({ now: BOOKING_NOW, seqs: [99_999] });
    expect(created(await last.order.execute(okCommand({ idem: okIdem({ key: randomUUID() }), body: okBody() }))).bookingNo).toBe('2026101499999');

    const full = useCase({ seqs: () => ({ exhausted: true }) });
    const r = await full.order.execute(okCommand({ idem: okIdem({ key: randomUUID() }), body: okBody() }));
    expect(r).toMatchObject({ status: 'REJECTED', reason: 'BOOKING_NUMBER_EXHAUSTED' });
    expect(full.fx.created).toHaveLength(0);
    expect(full.exhausted()).toBe(1);

    const problem = (ORDER_PROBLEMS as unknown as Record<string, { status: number; type: string } | undefined>).BOOKING_NUMBER_EXHAUSTED;
    expect(problem).toMatchObject({ status: 503, type: 'booking-number-exhausted' });

    // 100,000을 직접 넣어 경계를 닫는다(일련번호 어댑터가 99,999 다음을 exhausted로 닫는 근거)
    const formatBookingNo = (booking as unknown as { formatBookingNo?: (kstDay: string, seq: number) => string }).formatBookingNo;
    expect(formatBookingNo).toBeTypeOf('function');
    expect(formatBookingNo!('20261014', 99_999)).toBe('2026101499999');
    expect(() => formatBookingNo!('20261014', 100_000)).toThrow(RangeError);
    expect(() => formatBookingNo!('20261014', 0)).toThrow(RangeError);

    // 503 Problem으로 바뀌는지(HTTP가 쓰는 함수)
    const reply = {
      headers: new Map<string, string>(),
      header(name: string, value: string) {
        this.headers.set(name, value);
        return this;
      },
    };
    try {
      throwOrderProblem('BOOKING_NUMBER_EXHAUSTED' as never, reply);
      expect.unreachable('BOOKING_NUMBER_EXHAUSTED는 던져야 한다');
    } catch (e) {
      expect(e).toBeInstanceOf(ProblemError);
      expect(e).toMatchObject({ status: 503 });
      expect((e as ProblemError).slug).toBe('booking-number-exhausted');
    }
  });
});
