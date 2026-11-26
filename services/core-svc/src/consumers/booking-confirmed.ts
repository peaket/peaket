// F-06-8 `trade.orders` CONFIRMED 소비자. Kafka 값(event)을 BookingConfirmedEvent로 바꿔 intake에 넘긴다.
// 실제 Avro 복호는 플랫폼 소비자 경계(구독·오프셋 커밋)가 맡고, 이 파일은 사건 모양만 다룬다.
import type { NotificationIntake } from '../modules/notify/index.js';

export const TRADE_ORDERS_TOPIC = 'trade.orders';

export interface TradeOrderEventLike {
  type?: string;
  orderId?: string;
  eventId?: string;
  accountId?: string;
  eventKey?: string;
  occurredAt?: string;
  occurredAtMs?: number;
  amount?: number;
  items?: { tierId?: string; seatLabel?: string }[];
}

export interface ConsumedLike {
  topic: string;
  value: Buffer | null;
}

/** Kafka에서 읽은 trade.orders 값을 JSON으로 읽는다(운영 Avro 복호는 소비자 조립에서 먼저 한다) */
export class BookingConfirmedHandler {
  constructor(private readonly intake: NotificationIntake) {}

  decode(m: ConsumedLike): TradeOrderEventLike {
    if (m.topic !== TRADE_ORDERS_TOPIC) throw new Error(`trade.orders가 아닌 토픽이다: ${m.topic}`);
    if (!m.value) throw new Error('trade.orders 값이 비었다');
    const raw = JSON.parse(m.value.toString('utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) throw new Error('trade.orders 값이 객체가 아니다');
    return raw as TradeOrderEventLike;
  }

  keyOf(e: TradeOrderEventLike): string {
    return e.orderId ?? '';
  }

  eventKeyOf(e: TradeOrderEventLike): string | undefined {
    return e.eventKey;
  }

  async handle(e: TradeOrderEventLike): Promise<void> {
    if (e.type !== 'CONFIRMED') return;
    const orderId = e.orderId;
    const eventId = e.eventId;
    const accountId = e.accountId;
    const eventKey = e.eventKey;
    const occurredAtMs = e.occurredAtMs ?? (e.occurredAt ? Date.parse(e.occurredAt) : Number.NaN);
    const amount = e.amount;
    if (typeof orderId !== 'string' || typeof eventId !== 'string' || typeof accountId !== 'string' || typeof eventKey !== 'string' || !Number.isFinite(occurredAtMs) || typeof amount !== 'number') {
      throw new Error('trade.orders CONFIRMED 사건 모양이 다르다');
    }
    const items = (e.items ?? []).flatMap((i) => (typeof i.tierId === 'string' ? [{ tierId: i.tierId, ...(typeof i.seatLabel === 'string' ? { seatLabel: i.seatLabel } : {}) }] : []));
    await this.intake.bookingConfirmed({ type: 'CONFIRMED', orderId, eventId, accountId, eventKey, occurredAtMs, amount, items });
  }
}
