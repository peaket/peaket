// 팬 알림 Outbox 어댑터(BAT-425 GAT-130). 실제 발송은 core-svc notify가 trade.orders를 받아 한다.
// 회차 취소·연기 확정은 대상 주문마다 한 줄, 환급 완료·실패는 그 티켓의 주문에 한 줄을 남긴다.
import { createHash } from 'node:crypto';
import type { EventCancellationRequest, EventRefundItem, EventRefundTarget } from '../domain/event-refund.js';
import type { EventRefundFanNotifier, EventRefundOutboxMessage } from '../domain/event-refund-ports.js';

export const TRADE_ORDERS_TOPIC = 'trade.orders';

/** 같은 요청·티켓·사건 종류의 재시도가 같은 중복 제거 키를 쓰게 하는 결정적 UUID */
export function eventRefundNoticeKey(requestId: string, ticketId: string, type: string): string {
  const h = createHash('sha256').update(`event-refund-notice:${requestId}:${ticketId}:${type}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

interface NoticeExtras {
  readonly fanNoticeReason?: string;
  readonly refundAmount?: number;
  readonly postponedTo?: string;
  readonly refundWindowClosesAt?: string;
}

export class OutboxEventRefundFanNotifier implements EventRefundFanNotifier {
  confirmed(request: EventCancellationRequest, targets: readonly EventRefundTarget[], nowMs: number): readonly EventRefundOutboxMessage[] {
    const type = request.kind === 'POSTPONE' ? 'EVENT_POSTPONED' : 'EVENT_CANCELLATION_CONFIRMED';
    return targets.map((t) =>
      this.#message(request, t, type, nowMs, {
        ...(request.fanNoticeReason !== undefined ? { fanNoticeReason: request.fanNoticeReason } : {}),
        ...(request.postponedToMs !== undefined ? { postponedTo: new Date(request.postponedToMs).toISOString() } : {}),
        ...(request.refundWindowClosesAtMs !== undefined ? { refundWindowClosesAt: new Date(request.refundWindowClosesAtMs).toISOString() } : {}),
      }),
    );
  }

  refunded(request: EventCancellationRequest, item: EventRefundItem, target: EventRefundTarget | undefined, nowMs: number): EventRefundOutboxMessage {
    return this.#message(request, this.#targetOf(item, target), 'REFUNDED', nowMs, { refundAmount: target?.ticketPrice ?? 0 });
  }

  failed(request: EventCancellationRequest, item: EventRefundItem, target: EventRefundTarget | undefined, nowMs: number): EventRefundOutboxMessage {
    return this.#message(request, this.#targetOf(item, target), 'REFUND_FAILED', nowMs, { ...(item.lastError !== undefined ? { fanNoticeReason: item.lastError } : {}) });
  }

  #targetOf(item: EventRefundItem, target: EventRefundTarget | undefined): EventRefundTarget {
    if (target) return target;
    return {
      orderId: item.orderId,
      ticketId: item.ticketId,
      seatId: '',
      payerAccountId: '',
      ticketPrice: 0,
      bookedAtMs: 0,
      saleEndsAtMs: 0,
      pg: item.pg,
    };
  }

  #message(request: EventCancellationRequest, target: EventRefundTarget, type: string, nowMs: number, extras: NoticeExtras): EventRefundOutboxMessage {
    const payload = {
      eventId: request.eventId,
      orderId: target.orderId,
      accountId: target.payerAccountId,
      type,
      amount: target.ticketPrice,
      seatIds: target.seatId === '' ? [] : [target.seatId],
      refMissing: false,
      items: target.seatId === '' ? [] : [{ seatId: target.seatId, tierId: '', sectionId: '', price: target.ticketPrice }],
      seatAssignment: 'PICK',
      firstInStage: false,
      occurredAt: new Date(nowMs).toISOString(),
      eventKey: eventRefundNoticeKey(request.requestId, target.ticketId, type),
      ...extras,
    };
    return { topic: TRADE_ORDERS_TOPIC, key: request.eventId, payload: Buffer.from(JSON.stringify(payload), 'utf8') };
  }
}
