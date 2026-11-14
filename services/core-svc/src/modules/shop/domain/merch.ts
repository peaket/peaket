// 굿즈 주문·상품 정산 원천(BUILD_ORDER BAT-610 잔여, FR-024·062, POL-037·039, settlement §4.5).
// 정본 표는 docs/data.md merch_order·merch_order_item이다. 이 모듈은 주문을 만들지 않고,
// 다른 서비스(구매·정산)가 읽는 원천과 정산 기준일 계산만 맡는다.
export type MerchOrderStatus = 'PENDING' | 'PAID' | 'CANCELLED' | 'REFUNDED';
export type MerchItemStatus = 'READY' | 'SHIPPED' | 'DELIVERED' | 'PICKED_UP' | 'LOCKED' | 'RETURN_REQUESTED' | 'RETURN_RECEIVED' | 'DISPUTED' | 'CANCELLED' | 'REFUNDED';
export type MerchFulfillment = 'DELIVERY' | 'PICKUP' | 'WALLET';
export type MerchPg = 'TOSS' | 'PORTONE';
export type MerchPgStore = 'STANDARD' | 'ESCROW';

export class MerchProblem extends Error {
  constructor(
    readonly type: string,
    readonly status: number,
    readonly title: string,
  ) {
    super(title);
    this.name = 'MerchProblem';
  }
}

export interface MerchOrderRecord {
  orderId: string;
  promoterId: string;
  eventId: string | null;
  buyerName: string;
  buyerPhone: string;
  status: MerchOrderStatus;
  pg: MerchPg;
  pgStore: MerchPgStore;
  shippingFee: number;
  purchaseConfirmedAt: Date | null;
  orderedAt: Date;
}

export interface MerchOrderItemRecord {
  itemId: string;
  orderId: string;
  promoterId: string;
  eventId: string | null;
  productId: string;
  productName: string;
  quantity: number;
  unitAmount: number;
  commissionRateBp: number;
  status: MerchItemStatus;
  fulfillment: MerchFulfillment;
  seatLabel: string | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  pickedUpAt: Date | null;
  returnRequestedAt: Date | null;
  returnResolvedAt: Date | null;
  refundedAmount: number;
  eventEndsAt: Date | null;
  ticketLinked: boolean;
}

/** 정산서에 실릴 주문 항목 한 줄(payment-svc가 계산한다, settlement §4.5 'shop에서 넘겨받는 값'). */
export interface ProductSettlementItem {
  itemId: string;
  orderId: string;
  promoterId: string;
  eventId: string | null;
  pg: MerchPg;
  pgStore: MerchPgStore;
  productId: string;
  productName: string;
  quantity: number;
  /** 결제 금액(수량 포함) + 구매자가 낸 처음 배송비 */
  grossAmount: number;
  refundedAmount: number;
  commissionRateBp: number;
  /** KST 날짜(YYYY-MM-DD) */
  basisDate: string;
  returnStatus: MerchItemStatus;
  /** 티켓 연동 부가 상품이면 연결 회차 종료일 */
  eventEndsAt: string | null;
}

export interface AttendeeRecord {
  orderId: string;
  eventId: string;
  buyerName: string;
  buyerPhone: string;
  seatLabel: string | null;
  quantity: number;
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export const kstDateOnly = (d: Date): string => new Date(d.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);

/** KST 날짜의 00:00 UTC(내부 비교용) */
export function kstDayStart(date: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new MerchProblem('invalid-query', 400, '날짜가 YYYY-MM-DD 꼴이 아닙니다');
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - KST_OFFSET_MS);
}

/** KST 날짜에 일수를 더한다(달력일). */
export function addDays(date: string, days: number): string {
  const d = kstDayStart(date);
  return kstDateOnly(new Date(d.getTime() + days * 24 * 60 * 60 * 1000));
}

/** 그날이 지나야 정산서에 들어간다(settlement §4.5 표). 넣지 않을 항목은 null이다. */
export function settlementBasisDate(item: MerchOrderItemRecord, order: MerchOrderRecord): string | null {
  if (order.status === 'CANCELLED' || order.status === 'REFUNDED') return null;
  if (item.status === 'CANCELLED' || item.status === 'REFUNDED') return null;
  if (item.status === 'RETURN_REQUESTED' || item.status === 'RETURN_RECEIVED' || item.status === 'DISPUTED') return null;
  if (item.ticketLinked) {
    if (!item.eventEndsAt) return null;
    return addDays(kstDateOnly(item.eventEndsAt), 1);
  }
  if (item.fulfillment === 'PICKUP') {
    if (!item.pickedUpAt) return null;
    return addDays(kstDateOnly(item.pickedUpAt), 8);
  }
  if (order.pgStore === 'ESCROW') {
    if (!order.purchaseConfirmedAt) return null;
    return kstDateOnly(order.purchaseConfirmedAt);
  }
  if (item.deliveredAt) return addDays(kstDateOnly(item.deliveredAt), 8);
  if (item.shippedAt) return addDays(kstDateOnly(item.shippedAt), 15);
  return null;
}

export function productSettlementItem(item: MerchOrderItemRecord, order: MerchOrderRecord): ProductSettlementItem | null {
  const basisDate = settlementBasisDate(item, order);
  if (!basisDate) return null;
  return {
    itemId: item.itemId,
    orderId: item.orderId,
    promoterId: item.promoterId,
    eventId: item.eventId,
    pg: order.pg,
    pgStore: order.pgStore,
    productId: item.productId,
    productName: item.productName,
    quantity: item.quantity,
    grossAmount: item.unitAmount * item.quantity + (order.shippingFee > 0 ? order.shippingFee : 0),
    refundedAmount: item.refundedAmount,
    commissionRateBp: item.commissionRateBp,
    basisDate,
    returnStatus: item.status,
    eventEndsAt: item.eventEndsAt?.toISOString() ?? null,
  };
}

/** 이름 가운데 글자, 휴대폰 가운데 네 자리를 가린다(SCR-027, 두 글자 이름은 끝 글자). */
export function maskName(name: string): string {
  const chars = [...name.trim()];
  if (chars.length === 0) return '';
  if (chars.length === 1) return chars[0]!;
  if (chars.length === 2) return `${chars[0]}*`;
  return `${chars[0]}${'*'.repeat(chars.length - 2)}${chars[chars.length - 1]}`;
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return phone;
  return `${digits.slice(0, 3)}-****-${digits.slice(-4)}`;
}
