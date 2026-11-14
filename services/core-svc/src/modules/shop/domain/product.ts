// shop 상품 도메인(BUILD_ORDER BAT-610 서버 잔여, FR-024, docs/data.md product, ADR-0101).
// 저장 상태(DRAFT·PUBLISHED·HIDDEN)와 판매 기간·재고로 화면 상태(NOT_STARTED·ON_SALE·SOLD_OUT·ENDED)를 계산한다.
export class ProductProblem extends Error {
  constructor(
    readonly type: string,
    readonly status: number,
    readonly title: string,
  ) {
    super(title);
    this.name = 'ProductProblem';
  }
}

export type StoredProductStatus = 'DRAFT' | 'PUBLISHED' | 'HIDDEN';
export type ProductStatus = StoredProductStatus | 'NOT_STARTED' | 'ON_SALE' | 'SOLD_OUT' | 'ENDED';
export type Fulfillment = 'DELIVERY' | 'PICKUP' | 'WALLET';

export interface ProductRecord {
  productId: string;
  promoterId: string;
  type: string;
  name: string;
  status: StoredProductStatus;
  price: number;
  shippingFee: number | null;
  returnShippingFee: number | null;
  returnAddress: string | null;
  limitedQty: number | null;
  /** 한정 상품의 남은 수량. 한정이 아니면 null */
  stock: number | null;
  transferable: boolean;
  ticketLinked: boolean;
  linkedEventId: string | null;
  fulfillments: Fulfillment[];
  saleStartsAt: Date | null;
  saleEndsAt: Date | null;
  commissionRateBp: number | null;
  attributes: Record<string, unknown>;
  version: number;
  publishedAt: Date | null;
  updatedAt: Date;
}

export interface ProductView {
  productId: string;
  name: string;
  type: string;
  ticketLinked: boolean;
  status: ProductStatus;
  price: number;
  shippingFee: number | null;
  fulfillments: Fulfillment[];
  stockRemaining: number | null;
  stockTotal: number | null;
  saleStartsAt: string | null;
  saleEndsAt: string | null;
  linkedProductionId: string | null;
  linkedProductionTitle: string | null;
  version: number;
  linkedEventId: string | null;
  returnShippingFee: number | null;
  returnAddress: string | null;
  limitedQty: number | null;
  transferable: boolean;
  attributes: Record<string, unknown>;
}

export interface ProductFilter {
  ticketLinked?: boolean;
  status?: readonly ProductStatus[];
  linkedProductionId?: string;
  q?: string;
  cursor?: string;
  limit: number;
}

export interface ProductInput {
  type: string;
  name: string;
  price: number;
  shippingFee?: number | null | undefined;
  returnShippingFee?: number | null | undefined;
  returnAddress?: string | null | undefined;
  ticketLinked: boolean;
  linkedEventId?: string | null | undefined;
  limitedQty?: number | null | undefined;
  fulfillments: Fulfillment[];
  transferable?: boolean | undefined;
  status: 'DRAFT' | 'PUBLISHED';
  saleStartsAt?: string | null | undefined;
  saleEndsAt?: string | null | undefined;
  attributes?: Record<string, unknown> | undefined;
}

export interface ProductPatch {
  type?: string | undefined;
  name?: string | undefined;
  price?: number | undefined;
  shippingFee?: number | null | undefined;
  returnShippingFee?: number | null | undefined;
  returnAddress?: string | null | undefined;
  ticketLinked?: boolean | undefined;
  linkedEventId?: string | null | undefined;
  limitedQty?: number | null | undefined;
  fulfillments?: Fulfillment[] | undefined;
  transferable?: boolean | undefined;
  status?: StoredProductStatus | undefined;
  saleStartsAt?: string | null | undefined;
  saleEndsAt?: string | null | undefined;
  attributes?: Record<string, unknown> | undefined;
}

const bad = (type: string, title: string): ProductProblem => new ProductProblem(type, 422, title);

/** 화면이 보는 상태. 저장 상태가 DRAFT·HIDDEN이면 그것이 먼저다. */
export function statusOf(p: Pick<ProductRecord, 'status' | 'limitedQty' | 'stock' | 'saleStartsAt' | 'saleEndsAt'>, now: Date): ProductStatus {
  if (p.status === 'DRAFT') return 'DRAFT';
  if (p.status === 'HIDDEN') return 'HIDDEN';
  if (p.limitedQty !== null && (p.stock ?? 0) <= 0) return 'SOLD_OUT';
  if (p.saleEndsAt && now.getTime() > p.saleEndsAt.getTime()) return 'ENDED';
  if (p.saleStartsAt && now.getTime() < p.saleStartsAt.getTime()) return 'NOT_STARTED';
  return 'ON_SALE';
}

export function toView(p: ProductRecord, now: Date, linked: { productionId: string; title: string } | undefined): ProductView {
  return {
    productId: p.productId,
    name: p.name,
    type: p.type,
    ticketLinked: p.ticketLinked,
    status: statusOf(p, now),
    price: p.price,
    shippingFee: p.shippingFee,
    fulfillments: p.fulfillments,
    stockRemaining: p.limitedQty === null ? null : (p.stock ?? 0),
    stockTotal: p.limitedQty,
    saleStartsAt: p.saleStartsAt?.toISOString() ?? null,
    saleEndsAt: p.saleEndsAt?.toISOString() ?? null,
    linkedProductionId: linked?.productionId ?? null,
    linkedProductionTitle: linked?.title ?? null,
    version: p.version,
    linkedEventId: p.linkedEventId,
    returnShippingFee: p.returnShippingFee,
    returnAddress: p.returnAddress,
    limitedQty: p.limitedQty,
    transferable: p.transferable,
    attributes: p.attributes,
  };
}

function checkTicketLink(ticketLinked: boolean, linkedEventId: string | null): void {
  if (ticketLinked !== (linkedEventId !== null)) throw bad('product-ticket-link-invalid', '티켓 연동 여부와 연결 회차가 맞지 않습니다');
}

function checkFulfillments(f: readonly Fulfillment[]): void {
  if (f.length === 0) throw bad('product-fulfillment-invalid', '수령 방식을 하나 이상 골라야 합니다');
  if (new Set(f).size !== f.length) throw bad('product-fulfillment-invalid', '수령 방식이 겹칩니다');
}

function checkDelivery(input: { fulfillments: readonly Fulfillment[]; shippingFee: number | null; returnShippingFee: number | null; returnAddress: string | null }): void {
  if (!input.fulfillments.includes('DELIVERY')) return;
  if (input.shippingFee === null) throw bad('product-shipping-fee-required', '택배 상품은 배송비가 필요합니다');
  if (input.returnShippingFee === null) throw bad('product-return-shipping-fee-required', '택배 상품은 반품 배송비가 필요합니다');
  if (!input.returnAddress) throw bad('product-return-address-required', '택배 상품은 반품 받을 주소가 필요합니다');
}

export function validateInput(input: ProductInput): void {
  const linkedEventId = input.linkedEventId ?? null;
  checkTicketLink(input.ticketLinked, linkedEventId);
  checkFulfillments(input.fulfillments);
  checkDelivery({ fulfillments: input.fulfillments, shippingFee: input.shippingFee ?? null, returnShippingFee: input.returnShippingFee ?? null, returnAddress: input.returnAddress ?? null });
  if (input.limitedQty !== null && input.limitedQty !== undefined && input.limitedQty < 0) throw bad('product-limited-qty-invalid', '한정 수량이 0보다 작습니다');
}

export function validatePatch(merged: Pick<ProductRecord, 'ticketLinked' | 'linkedEventId' | 'fulfillments' | 'shippingFee' | 'returnShippingFee' | 'returnAddress' | 'limitedQty'>): void {
  checkTicketLink(merged.ticketLinked, merged.linkedEventId);
  checkFulfillments(merged.fulfillments);
  checkDelivery(merged);
  if (merged.limitedQty !== null && merged.limitedQty < 0) throw bad('product-limited-qty-invalid', '한정 수량이 0보다 작습니다');
}

/** 상품 판 If-Match 값. ETag는 강한 ETag(`"3"`)다(guidelines §12). */
export const productEtag = (version: number): string => `"${version}"`;
