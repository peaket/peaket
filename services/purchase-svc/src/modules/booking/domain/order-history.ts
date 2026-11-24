// 주문 내역의 순수 규칙(openapi GET /v1/orders·GET /v1/orders/{orderId}, docs/design/d5 §5.29, docs/frontend.md §5.29, F-07-2).
// 목록은 계정의 티켓 주문을 최신순 커서로 주고, 결제를 접수하지 않아 만료된 EXPIRED만 뺀다.
// 표시 번호·커서·등급 묶기는 저장소와 무관한 계산이라 여기서 시험한다. 어댑터는 읽기만 한다.
import type { OrderStatus } from './order.js';

/** 한 번에 받을 건수의 기본값(다른 목록과 같은 20)과 상한(openapi Limit 파라미터 최대 100) */
export const HISTORY_LIMIT_DEFAULT = 20;
export const HISTORY_LIMIT_MAX = 100;

/** 예매번호 [가정: docs/data.md purchase_order에 칸이 아직 없다]. 날짜 8자리 + 일련번호 5자리 */
export const BOOKING_NUMBER_PATTERN = /^\d{13}$/;

/** 발권 지연 판정(ADR-0106, payment-status의 같은 값) */
export const HISTORY_ISSUE_DELAYED_MS = 60_000;

/** 주문 항목 한 줄(order_item). 좌석 이름·등급 이름은 주문 때 저장하지 않는다 */
export interface OrderHistoryItemRow {
  readonly lineNo: number;
  readonly seatId: string;
  readonly tierId: string;
  readonly unitPrice: number;
  readonly ticketId: string | null;
}

/** 취소·환급 이력 한 줄(order_cancellation). 계좌 원문은 싣지 않는다 */
export interface OrderHistoryCancellationRow {
  readonly cancellationId: string;
  readonly ticketId: string | null;
  readonly requestedAt: Date;
  readonly deductionAmount: number;
  readonly refundAmount: number;
  readonly refundDueAt: Date | null;
  readonly status: 'REQUESTED' | 'REFUND_PENDING' | 'REFUNDED' | 'VOIDED';
  readonly refundAccountRequired: boolean;
}

/** 저장소가 주는 주문 하나(읽기 전용) */
export interface OrderHistoryOrder {
  readonly orderId: string;
  readonly accountId: string;
  readonly eventId: string;
  readonly status: OrderStatus;
  readonly amount: number;
  readonly createdAt: Date;
  readonly failureReason: string | null;
  readonly items: readonly OrderHistoryItemRow[];
  readonly cancellations: readonly OrderHistoryCancellationRow[];
}

/** 판매 설정에서 오는 표시 값. 없으면 공연명·회차 시작·등급 이름 없이 답한다 */
export interface OrderHistoryContext {
  readonly title?: string;
  readonly startsAtMs?: number;
  readonly entryOpensAtMs?: number;
  readonly tierNames?: Readonly<Record<string, string>>;
}

export interface OrderHistorySummary {
  orderId: string;
  bookingNumber: string;
  eventId: string;
  eventTitle?: string;
  eventStartsAt?: string;
  tiers?: { tierName: string; quantity: number }[];
  amount: number;
  status: OrderStatus;
  issueDelayed: boolean;
  failureReason: string | null;
  refundPending: boolean;
  virtualAccount: null;
  createdAt: string;
}

export interface OrderHistoryDetail extends OrderHistorySummary {
  entryOpensAt: string | null;
  seats: { seatLabel: string; tierName: string; unitPrice: number; gateZone: string | null; ticketId: string | null }[];
  cancellations: {
    cancellationId: string;
    ticketId: string | null;
    requestedAt: string;
    deductionAmount: number;
    refundAmount: number;
    refundDueAt: string | null;
    status: 'REQUESTED' | 'REFUND_PENDING' | 'REFUNDED' | 'VOIDED';
    refundAccountRequired: boolean;
  }[];
}

export interface OrderHistoryPage {
  items: OrderHistorySummary[];
  nextCursor: string | null;
}

export interface OrderHistorySummaryOptions {
  /** 이 응답을 만드는 지금(발권 지연 판정) */
  readonly nowMs: number;
  /** 회차 판매 설정에서 온 표시 값. 없으면 칸을 싣지 않는다 */
  readonly contextOf?: (eventId: string) => OrderHistoryContext | undefined;
  /** 좌석 ID와 같은 차례의 좌석 이름·등급 이름(상세만) */
  readonly seatLabels?: readonly ({ label?: string; tierName?: string } | undefined)[];
}

const kstDate8 = (ms: number): string => {
  // KST는 UTC+9 고정이라 Intl 없이 계산한다(환경 시간대에 따라 값이 달라지지 않게)
  const d = new Date(ms + 9 * 60 * 60_000);
  const y = d.getUTCFullYear().toString().padStart(4, '0');
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${y}${m}${day}`;
};

/**
 * 예매번호 표시 값 [가정]. 주문 ID(UUIDv7) 앞 48비트의 시각으로 날짜 8자리를, 뒤 32비트로 5자리를 만든다.
 * 같은 주문에는 늘 같은 값이고, 고객 문의는 이 번호가 아니라 주문 ID로 찾는다(RV-03). 정본이 칸을 정하면 그때 바꾼다.
 */
export function bookingNumberOf(orderId: string): string {
  const hex = orderId.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return `00000000${String(0).padStart(5, '0')}`;
  const ms = Number.parseInt(hex.slice(0, 12), 16);
  const tail = Number.parseInt(hex.slice(-8), 16) % 100_000;
  return `${kstDate8(ms)}${tail.toString().padStart(5, '0')}`;
}

/** 키셋 커서: createdAt + 주문 ID. 불투명 글자(base64url)로만 나간다 */
export function encodeOrderHistoryCursor(createdAt: Date, orderId: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${orderId}`, 'utf8').toString('base64url');
}

/** 커서를 푼다. 모양이 틀리면 undefined(받는 층이 400 invalid-query) */
export function decodeOrderHistoryCursor(cursor: string): { createdAt: Date; orderId: string } | undefined {
  let text: string;
  try {
    text = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
  const sep = text.indexOf('|');
  if (sep <= 0 || sep === text.length - 1) return undefined;
  const iso = text.slice(0, sep);
  const orderId = text.slice(sep + 1);
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== iso) return undefined;
  if (!/^[0-9a-f-]{36}$/.test(orderId)) return undefined;
  return { createdAt, orderId };
}

/** 목록에 넣는 주문인가. 결제를 접수하지 않아 만료된 EXPIRED만 뺀다(openapi GET /v1/orders 설명, ADR-0107) */
export function historyVisible(status: OrderStatus): boolean {
  return status !== 'EXPIRED';
}

/** 등급별 매수. 등급 이름이 없으면 등급 ID를 쓰고, 정본의 20개 상한에서 자른다(openapi tiers maxItems 20) */
export function tiersOf(items: readonly OrderHistoryItemRow[], tierNames?: Readonly<Record<string, string>>): { tierName: string; quantity: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const name = tierNames?.[item.tierId] ?? item.tierId;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].slice(0, 20).map(([tierName, quantity]) => ({ tierName, quantity }));
}

/** 결제 완료·티켓 발급 중(APPROVED가 60초 넘게 발권되지 않음, ADR-0106) */
export function historyIssueDelayed(status: OrderStatus, createdAtMs: number, nowMs: number): boolean {
  return status === 'APPROVED' && nowMs - createdAtMs >= HISTORY_ISSUE_DELAYED_MS;
}

/** 목록·상세가 함께 쓰는 요약. 취소 이력이 환급 대기면 <환급 보류>다 */
export function orderHistorySummaryOf(order: OrderHistoryOrder, o: OrderHistorySummaryOptions): OrderHistorySummary {
  const ctx = o.contextOf?.(order.eventId);
  const tiers = tiersOf(order.items, ctx?.tierNames);
  const summary: OrderHistorySummary = {
    orderId: order.orderId,
    bookingNumber: bookingNumberOf(order.orderId),
    eventId: order.eventId,
    amount: order.amount,
    status: order.status,
    issueDelayed: historyIssueDelayed(order.status, order.createdAt.getTime(), o.nowMs),
    failureReason: order.failureReason,
    refundPending: order.cancellations.some((c) => c.status === 'REQUESTED' || c.status === 'REFUND_PENDING'),
    virtualAccount: null,
    createdAt: order.createdAt.toISOString(),
  };
  if (ctx?.title) summary.eventTitle = ctx.title;
  if (ctx?.startsAtMs !== undefined) summary.eventStartsAt = new Date(ctx.startsAtMs).toISOString();
  if (tiers.length > 0) summary.tiers = tiers;
  return summary;
}

/**
 * 상세(예매 확인서). 좌석 이름·등급 이름은 판에서 오면 붙이고, 없으면 저장 값(좌석 ID·등급 ID)으로 떨어진다.
 * placeName·payment·compensation·seller는 정본에 원천이 없어 이번 범위에서 싣지 않는다(계획 RV-01).
 */
export function orderHistoryDetailOf(order: OrderHistoryOrder, o: OrderHistorySummaryOptions): OrderHistoryDetail {
  const ctx = o.contextOf?.(order.eventId);
  const seats = order.items.map((item, i) => {
    const label = o.seatLabels?.[i];
    return {
      seatLabel: label?.label ?? item.seatId,
      tierName: label?.tierName ?? ctx?.tierNames?.[item.tierId] ?? item.tierId,
      unitPrice: item.unitPrice,
      gateZone: null,
      ticketId: item.ticketId,
    };
  });
  return {
    ...orderHistorySummaryOf(order, o),
    entryOpensAt: ctx?.entryOpensAtMs === undefined ? null : new Date(ctx.entryOpensAtMs).toISOString(),
    seats,
    cancellations: order.cancellations.map((c) => ({
      cancellationId: c.cancellationId,
      ticketId: c.ticketId,
      requestedAt: c.requestedAt.toISOString(),
      deductionAmount: c.deductionAmount,
      refundAmount: c.refundAmount,
      refundDueAt: c.refundDueAt === null ? null : c.refundDueAt.toISOString(),
      status: c.status,
      refundAccountRequired: c.refundAccountRequired,
    })),
  };
}

/** 한 페이지로 자르고, 더 있으면 마지막 줄의 커서를 준다(어댑터는 limit+1개를 준다) */
export function orderHistoryPageOf(orders: readonly OrderHistoryOrder[], o: OrderHistorySummaryOptions & { limit: number }): OrderHistoryPage {
  const page = orders.slice(0, o.limit);
  const last = page.at(-1);
  return {
    items: page.map((order) => orderHistorySummaryOf(order, o)),
    nextCursor: orders.length > o.limit && last ? encodeOrderHistoryCursor(last.createdAt, last.orderId) : null,
  };
}
