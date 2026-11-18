// 굿즈 주문·상품 정산 원천(BUILD_ORDER BAT-610 잔여, FR-024·062, POL-037·039, settlement §4.5).
// 정본 표는 docs/data.md merch_order·merch_order_item이다. 이 파일은 다른 서비스(정산)가 읽는 원천과 정산 기준일 계산을 맡고,
// 팬 주문의 규칙은 merch-order.ts에 있다(BAT-600, ADR-0300).
// 주문 상태는 정본 상태도(docs/planning/03 §2.13 O1~O7) 값이다. 취소·환급은 항목 상태(I2·I16)다(ADR-0300 결정 9).
export type MerchOrderStatus = 'CREATED' | 'AWAITING_DEPOSIT' | 'PAID' | 'EXPIRED' | 'FAILED';
export type MerchItemStatus = 'READY' | 'SHIPPED' | 'DELIVERED' | 'PICKED_UP' | 'LOCKED' | 'RETURN_REQUESTED' | 'RETURN_RECEIVED' | 'DISPUTED' | 'CANCELLED' | 'REFUNDED';
export type MerchFulfillment = 'DELIVERY' | 'PICKUP' | 'WALLET';
export type MerchPg = 'TOSS' | 'PORTONE' | 'SIMULATOR';
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
  /** BAT-610 코드에만 있던 칸. 새 주문은 채우지 않는다(ADR-0300 결정 9) */
  buyerName: string | null;
  buyerPhone: string | null;
  status: MerchOrderStatus;
  /** 결제 접수 때 고정한 결제사. 접수 전에는 null */
  pg: MerchPg | null;
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
  /** 티켓 연동 부가 상품만. 그 이용권을 단 티켓(ADR-0301 결정 2) */
  linkedTicketId?: string | null;
  /** 취소 사유(I2). 지금은 UNCLAIMED(미수령 자동 취소)만 쓴다(ADR-0301 결정 5) */
  cancelReason?: string | null;
  /** 주문 때 고른 옵션과 상품 이름·유형·스키마 판(ADR-0101 결정 7) */
  optionSnapshot?: Record<string, unknown> | null;
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
  /** 티켓 원천이면 좌석 등급까지. 굿즈 원천은 없을 수 있다 */
  seats?: { seatLabel: string; tier: string }[];
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

/** 그날이 지나야 정산서에 들어간다(settlement §4.5 표). 넣지 않을 항목은 null이다. 주문 상태는 PAID만 보고 취소·환급은 항목 상태로 거른다(ADR-0300 결정 9) */
export function settlementBasisDate(item: MerchOrderItemRecord, order: MerchOrderRecord): string | null {
  if (order.status !== 'PAID' || order.pg === null) return null;
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

export function productSettlementItem(item: MerchOrderItemRecord, order: MerchOrderRecord, includeShipping = false): ProductSettlementItem | null {
  const basisDate = settlementBasisDate(item, order);
  if (!basisDate) return null;
  return {
    itemId: item.itemId,
    orderId: item.orderId,
    promoterId: item.promoterId,
    eventId: item.eventId,
    pg: order.pg!,
    pgStore: order.pgStore,
    productId: item.productId,
    productName: item.productName,
    quantity: item.quantity,
    grossAmount: item.unitAmount * item.quantity + (includeShipping && order.shippingFee > 0 ? order.shippingFee : 0),
    refundedAmount: item.refundedAmount,
    commissionRateBp: item.commissionRateBp,
    basisDate,
    returnStatus: item.status,
    eventEndsAt: item.eventEndsAt?.toISOString() ?? null,
  };
}

/** 한 주문의 정산 항목. 배송비는 주문에 한 번만 더한다(정산 대상이 된 첫 품목에 붙인다). */
export function productSettlementItems(items: readonly MerchOrderItemRecord[], order: MerchOrderRecord): ProductSettlementItem[] {
  let shipping = order.shippingFee > 0;
  const out: ProductSettlementItem[] = [];
  for (const item of items) {
    const row = productSettlementItem(item, order, shipping);
    if (!row) continue;
    out.push(row);
    shipping = false;
  }
  return out;
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
