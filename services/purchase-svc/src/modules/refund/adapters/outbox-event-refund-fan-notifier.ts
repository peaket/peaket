// 팬 알림 Outbox 어댑터(BAT-425 GAT-130). 실제 발송은 core-svc notify가 trade.orders를 받아 한다.
// 회차 취소·연기 확정은 대상 주문마다 한 줄, 환급 완료·실패는 그 티켓의 주문에 한 줄을 남긴다.
// 값은 주문 사건과 같은 trade.orders OrderEvent다. 운영 조립(start.ts·relay-app.ts)은 공용 Avro 인코더의 코덱(booking avroOrderEventCodec)을 넘긴다
// (한 토픽 한 형식, ADR-0357 결정 9). 인코딩 오류는 그 트랜잭션을 실패시킨다(결정 8). 코덱을 주지 않으면 JSON 대역이다(시험 조립).
import { createHash } from 'node:crypto';
import type { EventCancellationRequest, EventRefundItem, EventRefundTarget } from '../domain/event-refund.js';
import type { EventRefundFanNotifier, EventRefundOutboxMessage } from '../domain/event-refund-ports.js';

export const TRADE_ORDERS_TOPIC = 'trade.orders';

/** 같은 요청·티켓·사건 종류의 재시도가 같은 중복 제거 키를 쓰게 하는 결정적 UUID */
export function eventRefundNoticeKey(requestId: string, ticketId: string, type: string): string {
  const h = createHash('sha256').update(`event-refund-notice:${requestId}:${ticketId}:${type}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** 팬 알림 값 코덱(asyncapi OrderEvent 모양의 값을 바이트로). 계약을 채우지 못하면 던진다 */
export interface EventRefundNoticeCodec {
  encode(message: object): Uint8Array;
}

/** 시험 조립의 JSON 대역 */
const jsonNoticeCodec: EventRefundNoticeCodec = { encode: (message) => Buffer.from(JSON.stringify(message), 'utf8') };

interface NoticeExtras {
  readonly fanNoticeReason?: string;
  readonly refundAmount?: number;
  readonly postponedTo?: string;
  readonly refundWindowClosesAt?: string;
}

export class OutboxEventRefundFanNotifier implements EventRefundFanNotifier {
  constructor(private readonly codec: EventRefundNoticeCodec = jsonNoticeCodec) {}

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
    // 계약은 REFUND_FAILED에 사유를 늘 요구한다(x-present-when). 사유가 비면 실패 기록과 같은 'failed'를 싣는다(event-refund-service의 cancellationFailure와 같다)
    return this.#message(request, this.#targetOf(item, target), 'REFUND_FAILED', nowMs, { fanNoticeReason: item.lastError ?? 'failed' });
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
    return { topic: TRADE_ORDERS_TOPIC, key: request.eventId, payload: this.codec.encode(payload) };
  }
}
