// 주문 v0 유스케이스(docs/features/payment.md §13 동작 1~3): 주문 만들기, 결제 확정(동기 결제 체인), 주문 보기.
// 결제 확정은 요청 하나가 판매 → 결제사 승인(응답을 기다림) → 발권을 차례로 부르고, 단계마다 트랜잭션이 따로다(K7의 v0).
// 결과 모름도 실패로 끝내고 결제사에 다시 묻지 않는다. 이것이 v0가 보여 줄 한계다.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock, ProblemError, serverBusy } from '@peaket/platform';
import { kstIso, type SeatSales, type SellResult } from '../../inventory/index.js';
import { ApprovalNotRecordedError, type PaymentResult, type Payments } from '../../payment/index.js';
import type { IssuedTicket, TicketIssuer } from '../../ticket/index.js';
import { orderNameOf, type OrderRecord, type OrderStatus, type OrderView } from '../domain/booking.js';
import { ORDER_STORE, PAYMENTS, SEAT_SALES, TICKETS, type OrderStore } from '../domain/ports.js';

/** 요청한 사람(게이트웨이 신원 머리) */
export interface Requester {
  accountId: string;
  pid: string;
}

// 오류 이름(§13 '오류 이름')
const holdNotFound = () => new ProblemError({ type: 'hold-not-found', status: 404, title: '홀드를 찾을 수 없습니다' });
const holdExpired = () => new ProblemError({ type: 'hold-expired', status: 409, title: '홀드가 끝났습니다' });
const orderExists = () => new ProblemError({ type: 'order-already-exists', status: 409, title: '이 홀드로 만든 주문이 이미 있습니다' });
const pricesNotSet = () => new ProblemError({ type: 'prices-not-set', status: 409, title: '좌석 가격이 정해지지 않았습니다' });
const orderNotFound = () => new ProblemError({ type: 'order-not-found', status: 404, title: '주문을 찾을 수 없습니다' });
const orderNotPayable = () => new ProblemError({ type: 'order-not-payable', status: 409, title: '결제할 수 있는 주문이 아닙니다' });
const amountMismatch = () => new ProblemError({ type: 'amount-mismatch', status: 400, title: '결제 금액이 주문 금액과 다릅니다' });
const paymentDeclined = () => new ProblemError({ type: 'payment-declined', status: 422, title: '결제가 거절되었습니다' });
const paymentFailed = (cause?: unknown) => new ProblemError({ type: 'payment-failed', status: 502, title: '결제를 마치지 못했습니다', cause });

/** 판매 되돌리기·주문 상태 바꾸기를 모두 몇 번 시도하는지 [가정] */
const STEP_ATTEMPTS = 3;

function view(o: OrderRecord, tickets: IssuedTicket[]): OrderView {
  // 티켓은 주문 좌석 순서로 싣는다
  const bySeat = new Map(tickets.map((t) => [t.seatId, t]));
  const ordered = o.seatIds.map((s) => bySeat.get(s)).filter((t): t is IssuedTicket => t !== undefined);
  return {
    orderId: o.orderId,
    eventId: o.eventId,
    holdId: o.holdId,
    status: o.status,
    amount: o.amount,
    orderName: o.orderName,
    seatIds: [...o.seatIds],
    createdAt: kstIso(o.createdAtMs),
    tickets: ordered.map((t) => ({ ticketId: t.ticketId, seatId: t.seatId, code: t.code })),
  };
}

@Injectable()
export class BookingService {
  constructor(
    @Inject(ORDER_STORE) private readonly store: OrderStore,
    @Inject(SEAT_SALES) private readonly seats: SeatSales,
    @Inject(PAYMENTS) private readonly payments: Payments,
    @Inject(TICKETS) private readonly tickets: TicketIssuer,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** §13 동작 1: 자기 살아 있는 홀드로 주문을 만든다. 금액은 서버가 등급 가격으로 계산한다 */
  async create(who: Requester, holdId: string): Promise<OrderView> {
    const nowMs = this.clock.now();
    const h = await this.seats.holdForOrder(holdId, who.accountId, nowMs);
    if (h.kind === 'hold-not-found') throw holdNotFound();
    if (h.kind === 'hold-expired') throw holdExpired();
    const grades = [...new Set(h.hold.seats.map((s) => s.grade))];
    const prices = await this.store.prices(h.hold.eventId, grades);
    if (grades.some((g) => !prices.has(g))) throw pricesNotSet();
    const items = h.hold.seats.map((s) => ({ seatId: s.seatId, grade: s.grade, price: prices.get(s.grade)! }));
    const order: OrderRecord = {
      orderId: randomUUID(),
      eventId: h.hold.eventId,
      accountId: who.accountId,
      holdId,
      status: 'CREATED',
      amount: items.reduce((sum, i) => sum + i.price, 0),
      orderName: orderNameOf(h.hold.eventId, items.length),
      seatIds: items.map((i) => i.seatId),
      createdAtMs: nowMs,
    };
    const r = await this.store.create({ ...order, items, nowMs });
    if (r === 'order-already-exists') throw orderExists();
    return view(order, []);
  }

  /** §13 동작 2(동기 결제 체인) */
  async pay(who: Requester, orderId: string, body: { paymentKey: string; amount: number }): Promise<OrderView> {
    // ① 주문을 잠그고 CREATED·금액을 본 뒤 PAYING
    const started = await this.store.startPayment(orderId, who.accountId, body.amount, this.clock.now());
    switch (started.kind) {
      case 'order-not-found':
        throw orderNotFound();
      case 'order-not-payable':
        throw orderNotPayable();
      case 'amount-mismatch':
        throw amountMismatch();
      case 'busy':
        throw serverBusy();
      case 'paying':
        break;
    }
    const order = started.order;

    // ② 홀드를 판매로 바꾼다
    let sold: SellResult;
    try {
      sold = await this.seats.sell(order.holdId, who.accountId, order.orderId, this.clock.now());
    } catch (err) {
      // 판매가 커밋된 뒤 응답만 잃었을 수 있다(새 맥락 리뷰). 그 주문으로 판 좌석이 있으면 되돌리고 주문을 FAILED로 끝낸다(서버 오류)
      if ((await this.unsellRetrying(order)) === 'returned') {
        await this.transitionRetrying(order, 'PAYING', 'FAILED', 'seat-error');
        throw new Error(`주문 ${order.orderId}의 판매 응답을 잃어 판매를 되돌렸다`, { cause: err });
      }
      // 판 좌석이 없으면 주문을 CREATED로 되돌려 다시 확정할 수 있게 하고 원래 오류(연결 대기 초과면 429)를 그대로 낸다
      await this.transitionRetrying(order, 'PAYING', 'CREATED', 'seat-error');
      throw err;
    }
    if (sold.kind === 'busy') {
      await this.transitionRetrying(order, 'PAYING', 'CREATED', 'seat-busy');
      throw serverBusy();
    }
    if (sold.kind !== 'sold') {
      await this.transitionRetrying(order, 'PAYING', 'FAILED', 'hold-expired');
      throw holdExpired();
    }

    // ③ 결제사 승인을 부르고 응답을 기다린다
    let paid: PaymentResult;
    try {
      paid = await this.payments.confirm({ orderId: order.orderId, eventId: order.eventId, paymentKey: body.paymentKey, amount: order.amount, nowMs: this.clock.now() });
    } catch (err) {
      // 결제사가 승인했는데 기록만 못 했으면 좌석을 되돌리지 않는다(주문 PAYING·좌석 SOLD로 남고 500, P6이 센다)
      if (err instanceof ApprovalNotRecordedError) throw err;
      // 결제 행을 넣지 못했거나(결제사를 부르기 전) 승인이 아닌 결과를 적지 못했다. 승인은 없으니 판매를 되돌리고 FAILED로 끝낸다.
      // 다시 보내도 409라 원래 오류(연결 대기 초과면 429)가 아니라 502로 답한다(2차 리뷰)
      await this.fail(order, 'payment-error');
      throw paymentFailed(err);
    }
    // 그 주문의 결제 행이 이미 있다(지금 흐름에서는 닿지 않는다). 그 결제가 승인됐을 수 있으니 좌석을 되돌리지 않는다
    if (paid.kind === 'already-exists') throw new Error(`주문 ${order.orderId}의 결제 행이 이미 있다`);

    // ④ 승인이 아니면 판매를 되돌리고 실패로 끝낸다
    if (paid.kind !== 'approved') {
      await this.fail(order, paid.kind === 'declined' ? 'payment-declined' : 'payment-failed');
      throw paid.kind === 'declined' ? paymentDeclined() : paymentFailed();
    }

    // ⑤ 승인이면 APPROVED → 발권 → CONFIRMED. 발권이 실패하면 APPROVED에 남는다(다시 발권하는 장치가 없다)
    if (!(await this.store.transition(order.orderId, 'PAYING', 'APPROVED', 'payment-approved', this.clock.now()))) {
      throw new Error(`주문 ${order.orderId}이 결제 승인 때 PAYING이 아니었다`);
    }
    const tickets = await this.tickets.issue({ orderId: order.orderId, eventId: order.eventId, accountId: order.accountId, seatIds: order.seatIds, nowMs: this.clock.now() });
    if (!(await this.store.confirm(order.orderId, tickets.map((t) => ({ seatId: t.seatId, ticketId: t.ticketId })), this.clock.now()))) {
      throw new Error(`주문 ${order.orderId}이 발권 뒤 APPROVED가 아니었다`);
    }
    return view({ ...order, status: 'CONFIRMED' }, tickets);
  }

  /** §13 동작 3 */
  async view(who: Requester, orderId: string): Promise<OrderView> {
    const order = await this.store.find(orderId, who.accountId);
    if (!order) throw orderNotFound();
    return view(order, await this.tickets.ticketsOf(orderId));
  }

  /**
   * 판매를 되돌리고 주문을 FAILED로 끝낸다. 끝내 못 하면 서버 오류이고 주문은 PAYING에 남는다(되돌리기를 못 했으면 좌석도 SOLD,
   * 되돌린 뒤 FAILED로 못 바꿨으면 좌석은 AVAILABLE). 다시 보내라는 429가 아니다(새 맥락 리뷰)
   */
  private async fail(order: OrderRecord, reason: string): Promise<void> {
    await this.unsellRetrying(order);
    await this.transitionRetrying(order, 'PAYING', 'FAILED', reason);
  }

  /** 그 주문으로 판 좌석을 되돌린다. 다시 불러도 한 번만 되돌리므로 끊기면 모두 세 번 [가정] 시도하고, 끝내 못 하면 던진다 */
  private async unsellRetrying(order: OrderRecord): Promise<'returned' | 'not-sold'> {
    let last: unknown;
    for (let attempt = 1; attempt <= STEP_ATTEMPTS; attempt += 1) {
      try {
        const back = await this.seats.unsell(order.holdId, order.orderId, this.clock.now());
        if (back.kind !== 'busy') return back.kind;
        last = new Error('판매 되돌리기가 잠금 경합으로 끊겼다');
      } catch (err) {
        last = err;
      }
    }
    throw new Error(`주문 ${order.orderId}의 판매를 되돌리지 못했다`, { cause: last });
  }

  /** 주문을 from에서 to로 바꾼다. 오류로 끊기면 모두 세 번 [가정] 시도하고, 끝내 못 하거나 from이 아니면 던진다(서버 오류) */
  private async transitionRetrying(order: OrderRecord, from: OrderStatus, to: OrderStatus, reason: string): Promise<void> {
    let last: unknown;
    for (let attempt = 1; attempt <= STEP_ATTEMPTS; attempt += 1) {
      try {
        if (await this.store.transition(order.orderId, from, to, reason, this.clock.now())) return;
        last = new Error(`주문 ${order.orderId}이 ${from}이 아니었다`);
        break;
      } catch (err) {
        last = err;
      }
    }
    throw new Error(`주문 ${order.orderId}을 ${to}로 바꾸지 못했다`, { cause: last });
  }
}
