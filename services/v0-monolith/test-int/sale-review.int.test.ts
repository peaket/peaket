// 새 맥락 코드 리뷰(BSL-040)가 찾은 결제·발권 v0 결함의 재현 시험(docs/architecture.md §8.6의 3).
// ① 판매가 경합 결과가 아니라 예외를 던지면 주문이 PAYING에 남았다 ② 승인이 아닌데 판매 되돌리기가 한 번 끊기면 좌석이 SOLD에 남았다
// ③ 결제사가 승인한 뒤 결제 기록이 실패하면 좌석을 되돌려 승인된 결제의 좌석을 다시 팔았다 ④ 결제 행이 이미 있으면 좌석을 되돌렸다
// ⑤ 발권 뒤 주문 확정이 실패하면 불변식 뷰의 주문 좌석에 티켓이 비어 P5가 거짓 위반을 냈다 ⑥ ①과 ② 사이에 멈춘 PAYING 주문을
// 좌석이 팔리지 않았는데도 PENDING 판매로 실었다 ⑦ 티켓 코드가 실린 응답에 Cache-Control: no-store가 없었다
// ⑧ 결제사 한도 초과·결제사 인증 오류를 카드 거절(422)로 답했다
// 결제 확정 체인은 HTTP로 만들 수 없는 실패를 넣으려고 BookingService를 실제 저장소·시뮬레이터로 직접 조립하고 한 곳만 바꾼다.
import 'reflect-metadata';
import { PROBLEM_TYPE_BASE, ProblemError, serverBusy } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DrizzleOrderStore } from '../src/modules/booking/adapters/db/drizzle-order-store.js';
import { BookingService } from '../src/modules/booking/application/booking-service.js';
import type { OrderStore } from '../src/modules/booking/domain/ports.js';
import { createSeatSales, type SeatSales } from '../src/modules/inventory/index.js';
import { DrizzlePaymentStore } from '../src/modules/payment/adapters/db/drizzle-payment-store.js';
import { paymentsWith } from '../src/modules/payment/application/payments.js';
import type { PaymentStore } from '../src/modules/payment/domain/ports.js';
import { ApprovalNotRecordedError, createV0PaymentGateway } from '../src/modules/payment/index.js';
import { createTicketAdmin, createTicketIssuer } from '../src/modules/ticket/index.js';
import { fanHeaders } from './queue-harness.js';
import { SaleHarness, staffHeaders } from './sale-harness.js';

let h: SaleHarness;

beforeAll(async () => {
  h = await SaleHarness.start();
});

afterAll(async () => {
  await h?.close();
});

const who = (pid: string) => ({ accountId: `acc-${pid}`, pid });

/** 실제 저장소·판매·결제·발권으로 결제 확정 유스케이스를 조립하고, 주어진 메서드만 바꾼다 */
function service(o: { seats?: Partial<SeatSales>; payStore?: Partial<PaymentStore>; orders?: Partial<OrderStore>; secretKey?: string } = {}): BookingService {
  const realSeats = createSeatSales(h.database);
  const seats: SeatSales = {
    holdForOrder: (...a) => realSeats.holdForOrder(...a),
    sell: (...a) => realSeats.sell(...a),
    unsell: (...a) => realSeats.unsell(...a),
    ...o.seats,
  };
  const realPay = new DrizzlePaymentStore(h.database);
  const payStore: PaymentStore = {
    insertConfirming: (r) => realPay.insertConfirming(r),
    markApproved: (id, at) => realPay.markApproved(id, at),
    markFailed: (id, f) => realPay.markFailed(id, f),
    ...o.payStore,
  };
  const realOrders = new DrizzleOrderStore(h.database);
  const orders: OrderStore = {
    prices: (...a) => realOrders.prices(...a),
    create: (...a) => realOrders.create(...a),
    find: (...a) => realOrders.find(...a),
    startPayment: (...a) => realOrders.startPayment(...a),
    transition: (...a) => realOrders.transition(...a),
    confirm: (...a) => realOrders.confirm(...a),
    setPrices: (...a) => realOrders.setPrices(...a),
    ...o.orders,
  };
  const gateway = createV0PaymentGateway({ baseUrl: h.simUrl, secretKey: o.secretKey ?? h.simKey });
  return new BookingService(orders, seats, paymentsWith(payStore, gateway), createTicketIssuer(h.database), h.clock);
}

/** 거절된 Promise의 오류(거절되지 않으면 실패) */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('거절되지 않았다');
}

async function orderStatus(orderId: string): Promise<string> {
  const r = await h.inspect.query<{ status: string }>('select status from v0_order where order_id = $1', [orderId]);
  return r.rows[0]!.status;
}

async function seatStates(eventId: string, seatIds: string[]): Promise<string[]> {
  const r = await h.inspect.query<{ seat_id: string; status: string }>('select seat_id, status from v0_seat where event_id = $1 and seat_id = any($2)', [eventId, seatIds]);
  const by = new Map(r.rows.map((x) => [x.seat_id, x.status]));
  return seatIds.map((s) => by.get(s)!);
}

async function soldCount(eventId: string, pid: string): Promise<number> {
  const r = await h.inspect.query<{ sold: number }>('select sold from v0_quota where event_id = $1 and account_id = $2', [eventId, `acc-${pid}`]);
  return r.rows[0]!.sold;
}

describe('결제 확정 체인의 예외 경로(payment §13 동작 2)', () => {
  test('FR011_판매가경합결과가아니라예외를던져도주문은CREATED로돌아와_다시확정하면CONFIRMED다', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['rv1']);
    const prep = await h.prepareOrder(e, 'rv1', ['S-1']);
    const svc = service({ seats: { sell: () => Promise.reject(serverBusy()) } });
    const err = await rejection(svc.pay(who('rv1'), prep.order.orderId, { paymentKey: prep.paymentKey, amount: prep.order.amount }));
    expect(err).toBeInstanceOf(ProblemError);
    expect((err as ProblemError).status).toBe(429);
    expect(await orderStatus(prep.order.orderId)).toBe('CREATED');
    expect(await seatStates(e, ['S-1'])).toEqual(['HELD']);
    expect(h.confirmCallsOf(prep.order.orderId)).toEqual([]);
    const again = await h.pay(prep.order.orderId, { paymentKey: prep.paymentKey, amount: prep.order.amount }, prep.headers);
    expect(again.status, again.raw).toBe(200);
    expect(again.body.status).toBe('CONFIRMED');
  });

  test('POL013_승인이아닌데판매되돌리기가한번끊겨도다시시도해_좌석을돌려주고422결제거절이다', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['rv2']);
    const prep = await h.prepareOrder(e, 'rv2', ['S-1', 'S-2']);
    await h.addFault({ op: 'confirm', orderId: prep.order.orderId, kind: 'decline', code: 'REJECT_CARD_COMPANY' });
    const real = createSeatSales(h.database);
    let calls = 0;
    const svc = service({
      seats: {
        unsell: async (...a) => {
          calls += 1;
          return calls === 1 ? { kind: 'busy' } : real.unsell(...a);
        },
      },
    });
    const err = await rejection(svc.pay(who('rv2'), prep.order.orderId, { paymentKey: prep.paymentKey, amount: prep.order.amount }));
    expect(err).toBeInstanceOf(ProblemError);
    expect({ status: (err as ProblemError).status, type: (err as ProblemError).type }).toEqual({ status: 422, type: `${PROBLEM_TYPE_BASE}payment-declined` });
    expect(await seatStates(e, ['S-1', 'S-2'])).toEqual(['AVAILABLE', 'AVAILABLE']);
    expect(await orderStatus(prep.order.orderId)).toBe('FAILED');
    expect(await soldCount(e, 'rv2')).toBe(0);
    await h.clearFaults();
  });

  test('K7_판매되돌리기가끝내되지않으면_429가아니라서버오류로답하고주문은PAYING좌석은SOLD로남는다', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['rv3']);
    const prep = await h.prepareOrder(e, 'rv3', ['S-1']);
    await h.addFault({ op: 'confirm', orderId: prep.order.orderId, kind: 'decline', code: 'REJECT_CARD_COMPANY' });
    const svc = service({ seats: { unsell: async () => ({ kind: 'busy' }) } });
    const err = await rejection(svc.pay(who('rv3'), prep.order.orderId, { paymentKey: prep.paymentKey, amount: prep.order.amount }));
    // 다시 보내면 409라서, 다시 보내라는 429로 답하지 않는다
    expect(err instanceof ProblemError && err.status < 500).toBe(false);
    expect(await orderStatus(prep.order.orderId)).toBe('PAYING');
    expect(await seatStates(e, ['S-1'])).toEqual(['SOLD']);
    await h.clearFaults();
  });

  test('K7_결제사가승인한뒤결제기록이실패하면_좌석을되돌리지않고주문은PAYING좌석은SOLD로남으며결제사원장에승인이있다', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['rv4']);
    const prep = await h.prepareOrder(e, 'rv4', ['S-1']);
    let tries = 0;
    const svc = service({
      payStore: {
        markApproved: () => {
          tries += 1;
          return Promise.reject(new Error('시험: 결제 기록 실패'));
        },
      },
    });
    const err = await rejection(svc.pay(who('rv4'), prep.order.orderId, { paymentKey: prep.paymentKey, amount: prep.order.amount }));
    // 2차 리뷰: 오류의 종류·시도 수·결제 행 상태까지 본다
    expect(err).toBeInstanceOf(ApprovalNotRecordedError);
    expect(tries, '승인 기록은 모두 세 번 시도한다').toBe(3);
    expect((await h.paymentRows(prep.order.orderId)).map((r) => r.status)).toEqual(['CONFIRMING']);
    expect(await seatStates(e, ['S-1'])).toEqual(['SOLD']);
    expect(await orderStatus(prep.order.orderId)).toBe('PAYING');
    expect(await soldCount(e, 'rv4')).toBe(1);
    expect((await h.approvalsOf(prep.order.orderId)).length).toBe(1);
  });

  test('K7_승인뒤결제기록이한번끊겨도다시적어_200CONFIRMED이고결제행은APPROVED다', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['rv5']);
    const prep = await h.prepareOrder(e, 'rv5', ['S-1']);
    const real = new DrizzlePaymentStore(h.database);
    let calls = 0;
    const svc = service({
      payStore: {
        markApproved: async (id, at) => {
          calls += 1;
          if (calls === 1) throw new Error('시험: 결제 기록 한 번 실패');
          await real.markApproved(id, at);
        },
      },
    });
    const view = await svc.pay(who('rv5'), prep.order.orderId, { paymentKey: prep.paymentKey, amount: prep.order.amount });
    expect(view.status).toBe('CONFIRMED');
    const rows = await h.paymentRows(prep.order.orderId);
    expect(rows.map((r) => r.status)).toEqual(['APPROVED']);
  });

  test('K7_그주문의결제행이이미있으면_결제사를부르지않고좌석을되돌리지않는다', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['rv6']);
    const prep = await h.prepareOrder(e, 'rv6', ['S-1']);
    const svc = service({ payStore: { insertConfirming: async () => ({ kind: 'already-exists' }) } });
    const err = await rejection(svc.pay(who('rv6'), prep.order.orderId, { paymentKey: prep.paymentKey, amount: prep.order.amount }));
    expect(err instanceof ProblemError && err.status < 500).toBe(false);
    expect(h.confirmCallsOf(prep.order.orderId)).toEqual([]);
    expect(await seatStates(e, ['S-1'])).toEqual(['SOLD']);
    expect(await orderStatus(prep.order.orderId)).toBe('PAYING');
  });

  test('K7_결제사한도초과와결제사인증오류는카드거절이아니라_502결제실패이고좌석을돌려준다', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['rv7']);
    const prep = await h.prepareOrder(e, 'rv7', ['S-1']);
    await h.addFault({ op: 'confirm', orderId: prep.order.orderId, kind: 'throttle' });
    const r = await h.pay(prep.order.orderId, { paymentKey: prep.paymentKey, amount: prep.order.amount }, prep.headers);
    expect({ status: r.status, type: (r.body as { type?: string } | undefined)?.type }).toEqual({ status: 502, type: `${PROBLEM_TYPE_BASE}payment-failed` });
    expect(await seatStates(e, ['S-1'])).toEqual(['AVAILABLE']);
    await h.clearFaults();

    const prep2 = await h.prepareOrder(e, 'rv7', ['S-2']);
    const err = await rejection(service({ secretKey: 'sim_sk_wrongkey00000000' }).pay(who('rv7'), prep2.order.orderId, { paymentKey: prep2.paymentKey, amount: prep2.order.amount }));
    expect(err).toBeInstanceOf(ProblemError);
    expect({ status: (err as ProblemError).status, type: (err as ProblemError).type }).toEqual({ status: 502, type: `${PROBLEM_TYPE_BASE}payment-failed` });
    expect(await seatStates(e, ['S-2'])).toEqual(['AVAILABLE']);
  });
});

describe('불변식 뷰(payment §13 \'불변식 검사\')', () => {
  test('NFR006_발권뒤주문확정이실패해도_불변식뷰의주문좌석은발권한티켓을가리킨다', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['rv8']);
    const prep = await h.prepareOrder(e, 'rv8', ['S-1']);
    const svc = service({ orders: { confirm: () => Promise.reject(new Error('시험: 주문 확정 실패')) } });
    await rejection(svc.pay(who('rv8'), prep.order.orderId, { paymentKey: prep.paymentKey, amount: prep.order.amount }));
    const tickets = await h.ticketRows({ orderId: prep.order.orderId });
    expect(tickets.length).toBe(1);
    const v = await h.inspect.query<{ ticket_id: string | null }>('select ticket_id from v0_check.order_item where order_id = $1', [prep.order.orderId]);
    expect(v.rows.map((x) => x.ticket_id)).toEqual([tickets[0]!.ticketId]);
  });

  test('NFR006_판매로바꾸기전에멈춘PAYING주문은_좌석이팔리지않았으므로PENDING판매가아니다', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['rv9', 'rv10']);
    const prep = await h.prepareOrder(e, 'rv9', ['S-1']);
    // ①과 ② 사이에 프로세스가 멈춘 것과 같다(주문 PAYING, 좌석 HELD)
    await h.inspect.query("update v0_order set status = 'PAYING' where order_id = $1", [prep.order.orderId]);
    const mine = await h.inspect.query<{ status: string }>('select status from v0_check.seat_sale where order_id = $1', [prep.order.orderId]);
    expect(mine.rows.map((x) => x.status)).toEqual(['RETURNED']);
    // 홀드가 끝난 뒤 다른 사람이 같은 좌석을 사도 한 좌석의 활성 판매는 하나다(S1 거짓 위반 없음)
    h.clock.advance(8 * 60 * 1000);
    await h.seatAdmin.expire(h.clock.now());
    await h.buy(e, 'rv10', ['S-1']);
    const active = await h.inspect.query<{ n: number }>(
      "select count(*)::int as n from v0_check.seat_sale where seat_id = md5($1 || ':' || $2)::uuid and status in ('PENDING', 'SOLD')",
      [e, 'S-1'],
    );
    expect(active.rows[0]!.n).toBe(1);
  });
});

describe('2차 리뷰: 결제 확정 체인의 예외 경로(payment §13 동작 2)', () => {
  test('K7_판매가커밋된뒤응답만잃어도_판좌석을되돌리고주문은FAILED이며서버오류다_좌석이SOLD로남지않는다', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['rw1']);
    const prep = await h.prepareOrder(e, 'rw1', ['S-1', 'S-2']);
    const real = createSeatSales(h.database);
    const svc = service({
      seats: {
        sell: async (...a) => {
          await real.sell(...a);
          throw new Error('시험: 판매 응답 유실');
        },
      },
    });
    const err = await rejection(svc.pay(who('rw1'), prep.order.orderId, { paymentKey: prep.paymentKey, amount: prep.order.amount }));
    expect(err instanceof ProblemError && err.status < 500).toBe(false);
    expect(await seatStates(e, ['S-1', 'S-2'])).toEqual(['AVAILABLE', 'AVAILABLE']);
    expect(await orderStatus(prep.order.orderId)).toBe('FAILED');
    expect(await soldCount(e, 'rw1')).toBe(0);
    expect(h.confirmCallsOf(prep.order.orderId)).toEqual([]);
  });

  test('FR011_판매가오류를던지고주문을CREATED로되돌리지도못하면_다시보내라는429가아니라서버오류다', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['rw2']);
    const prep = await h.prepareOrder(e, 'rw2', ['S-1']);
    const realOrders = new DrizzleOrderStore(h.database);
    const svc = service({
      seats: { sell: () => Promise.reject(serverBusy()) },
      orders: { transition: (id, from, to, reason, now) => (to === 'CREATED' ? Promise.reject(serverBusy()) : realOrders.transition(id, from, to, reason, now)) },
    });
    const err = await rejection(svc.pay(who('rw2'), prep.order.orderId, { paymentKey: prep.paymentKey, amount: prep.order.amount }));
    expect(err instanceof ProblemError && err.status < 500).toBe(false);
    expect(await orderStatus(prep.order.orderId)).toBe('PAYING');
    expect(await seatStates(e, ['S-1'])).toEqual(['HELD']);
  });

  test('K7_결제사를부르기전결제행넣기가429로끊기면_좌석을돌려주고주문FAILED이며_다시보내라는429가아니라502결제실패다', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['rw3']);
    const prep = await h.prepareOrder(e, 'rw3', ['S-1']);
    const svc = service({ payStore: { insertConfirming: () => Promise.reject(serverBusy()) } });
    const err = await rejection(svc.pay(who('rw3'), prep.order.orderId, { paymentKey: prep.paymentKey, amount: prep.order.amount }));
    expect(err).toBeInstanceOf(ProblemError);
    expect({ status: (err as ProblemError).status, type: (err as ProblemError).type }).toEqual({ status: 502, type: `${PROBLEM_TYPE_BASE}payment-failed` });
    expect(await seatStates(e, ['S-1'])).toEqual(['AVAILABLE']);
    expect(await orderStatus(prep.order.orderId)).toBe('FAILED');
    expect(h.confirmCallsOf(prep.order.orderId)).toEqual([]);
  });

  test('POL013_좌석은되돌렸는데주문FAILED바꾸기를끝내못하면_서버오류이고좌석은빈좌석주문은PAYING이다', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['rw4']);
    const prep = await h.prepareOrder(e, 'rw4', ['S-1']);
    await h.addFault({ op: 'confirm', orderId: prep.order.orderId, kind: 'decline', code: 'REJECT_CARD_COMPANY' });
    const realOrders = new DrizzleOrderStore(h.database);
    const svc = service({
      orders: { transition: (id, from, to, reason, now) => (to === 'FAILED' ? Promise.reject(new Error('시험: 주문 바꾸기 실패')) : realOrders.transition(id, from, to, reason, now)) },
    });
    const err = await rejection(svc.pay(who('rw4'), prep.order.orderId, { paymentKey: prep.paymentKey, amount: prep.order.amount }));
    expect(err instanceof ProblemError && err.status < 500).toBe(false);
    expect(await seatStates(e, ['S-1'])).toEqual(['AVAILABLE']);
    expect(await orderStatus(prep.order.orderId)).toBe('PAYING');
    await h.clearFaults();
  });

  test('K7_결제사한도초과는결제행failure에실패범주가실려_카드거절과구별된다', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['rw5']);
    const prep = await h.prepareOrder(e, 'rw5', ['S-1']);
    await h.addFault({ op: 'confirm', orderId: prep.order.orderId, kind: 'throttle' });
    const r = await h.pay(prep.order.orderId, { paymentKey: prep.paymentKey, amount: prep.order.amount }, prep.headers);
    expect(r.status).toBe(502);
    const [row] = await h.paymentRows(prep.order.orderId);
    expect(row!.failure).toContain('THROTTLED');
    await h.clearFaults();
  });
});

describe('티켓 코드가 실린 응답의 캐시(docs/api/guidelines.md \'인증이 필요한 경로는 no-store\')', () => {
  test('FR012_주문만들기와결제확정과주문보기와검표응답은_Cache-Control이no-store다 [ASVS v5.0.0-14.1.1]', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['rv11']);
    const headers = fanHeaders('rv11');
    const holdId = await h.holdOk(e, ['S-1'], headers);
    const created = await h.createOrder(holdId, headers);
    expect(created.status).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    const order = created.body as { orderId: string; amount: number; orderName: string };
    const paymentKey = await h.authenticate(order.orderId, order.amount, order.orderName);
    const paid = await h.pay(order.orderId, { paymentKey, amount: order.amount }, headers);
    expect(paid.status).toBe(200);
    expect(paid.headers['cache-control']).toBe('no-store');
    const viewed = await h.viewOrder(order.orderId, headers);
    expect(viewed.status).toBe(200);
    expect(viewed.headers['cache-control']).toBe('no-store');
    await createTicketAdmin(h.database).assignStaff(e, ['acc-staff-rv11']);
    const code = (paid.body as { tickets: { code: string }[] }).tickets[0]!.code;
    const scanned = await h.scan(e, { code }, staffHeaders('acc-staff-rv11'));
    expect(scanned.status).toBe(200);
    expect(scanned.headers['cache-control']).toBe('no-store');
  });
});
