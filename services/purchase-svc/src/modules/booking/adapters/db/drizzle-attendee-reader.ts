// 예매자 명단 원천(내부 HTTP, A2-03). 굿즈 주문이 아니라 결제 완료(CONFIRMED·PARTIALLY_REFUNDED) 주문과
// 아직 SOLD인 좌석(order_item·seat_sale)만 읽는다. 미결제 주문과 반환 좌석은 넣지 않는다.
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Database } from '@peaket/platform';
import { seatSale } from '../../../inventory/index.js';
import { orderItem, purchaseOrder } from './schema.js';

export interface AttendeeSeat {
  seatLabel: string;
  tier: string;
}

export interface AttendeeRow {
  orderId: string;
  eventId: string;
  buyerName: string;
  buyerPhone: string;
  seats: AttendeeSeat[];
  ticketCount: number;
}

export interface AttendeePage {
  items: AttendeeRow[];
  nextCursor: string | null;
  bookingCount: number;
  ticketCount: number;
}

const PAID = ['CONFIRMED', 'PARTIALLY_REFUNDED'] as const;
const cursorOf = (orderId: string): string => Buffer.from(orderId, 'utf8').toString('base64url');
const afterOf = (cursor: string | undefined): string | undefined => (cursor ? Buffer.from(cursor, 'base64url').toString('utf8') : undefined);

export class DrizzleAttendeeReader {
  constructor(private readonly db: Database) {}

  async list(eventId: string, limit: number, cursor?: string): Promise<AttendeePage> {
    const after = afterOf(cursor);
    const orders = await this.db.db
      .select({ id: purchaseOrder.id, buyerName: purchaseOrder.buyerName, buyerPhone: purchaseOrder.buyerPhone })
      .from(purchaseOrder)
      .where(and(eq(purchaseOrder.eventId, eventId), inArray(purchaseOrder.status, PAID), ...(after ? [gt(purchaseOrder.id, after)] : [])))
      .orderBy(asc(purchaseOrder.id))
      .limit(limit + 1);
    const page = orders.slice(0, limit);
    const ids = page.map((o) => o.id);
    if (ids.length === 0) return { items: [], nextCursor: null, bookingCount: 0, ticketCount: 0 };
    const items = await this.db.db
      .select({ orderId: orderItem.orderId, seatId: orderItem.seatId, tier: orderItem.tier })
      .from(orderItem)
      .innerJoin(purchaseOrder, eq(purchaseOrder.id, orderItem.orderId))
      .innerJoin(
        seatSale,
        and(eq(seatSale.orderId, orderItem.orderId), eq(seatSale.seatId, orderItem.seatId), eq(seatSale.eventId, purchaseOrder.eventId), eq(seatSale.status, 'SOLD')),
      )
      .where(inArray(orderItem.orderId, ids))
      .orderBy(asc(orderItem.orderId), asc(orderItem.lineNo));
    const byOrder = new Map<string, AttendeeSeat[]>();
    for (const i of items) {
      const seats = byOrder.get(i.orderId) ?? [];
      seats.push({ seatLabel: i.seatId, tier: i.tier });
      byOrder.set(i.orderId, seats);
    }
    const rows: AttendeeRow[] = [];
    for (const o of page) {
      const seats = byOrder.get(o.id);
      if (!seats || seats.length === 0) continue;
      rows.push({ orderId: o.id, eventId, buyerName: o.buyerName ?? '', buyerPhone: o.buyerPhone ?? '', seats, ticketCount: seats.length });
    }
    const next = orders.length > limit ? cursorOf(page[page.length - 1]!.id) : null;
    const counts = await this.count(eventId);
    return { items: rows, nextCursor: next, ...counts };
  }

  async count(eventId: string): Promise<{ bookingCount: number; ticketCount: number }> {
    const rows = await this.db.db
      .select({ bookings: sql<number>`count(distinct ${purchaseOrder.id})::int`, tickets: sql<number>`count(${orderItem.seatId})::int` })
      .from(purchaseOrder)
      .innerJoin(orderItem, eq(orderItem.orderId, purchaseOrder.id))
      .innerJoin(
        seatSale,
        and(eq(seatSale.orderId, orderItem.orderId), eq(seatSale.seatId, orderItem.seatId), eq(seatSale.eventId, purchaseOrder.eventId), eq(seatSale.status, 'SOLD')),
      )
      .where(and(eq(purchaseOrder.eventId, eventId), inArray(purchaseOrder.status, PAID)));
    return { bookingCount: rows[0]?.bookings ?? 0, ticketCount: rows[0]?.tickets ?? 0 };
  }
}
