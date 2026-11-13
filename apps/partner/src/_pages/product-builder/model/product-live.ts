// SCR-023 상품 목록·빌더가 계약 값을 화면 값으로 바꾸고, 저장 본문을 화면에서 먼저 검사한다.
// 서버가 다시 검사한다. 여기 검사는 빈 칸을 바로 보여 주려는 것이다(docs/api/guidelines.md §12).
import type { Fulfillment, PartnerProductDetail, PartnerProductSummary, PartnerProductUpdateBody, ProductStatus } from '@/shared/api/partner-live';

export const PRODUCT_STATUS_LABEL: Record<ProductStatus, string> = {
  DRAFT: '초안',
  NOT_STARTED: '판매 전',
  ON_SALE: '판매 중',
  SOLD_OUT: '품절',
  ENDED: '판매 끝',
  HIDDEN: '숨김',
};

export const PRODUCT_STATUS_BADGE: Record<ProductStatus, string> = {
  DRAFT: 'badge badge-outline',
  NOT_STARTED: 'badge badge-outline',
  ON_SALE: 'badge badge-success',
  SOLD_OUT: 'badge',
  ENDED: 'badge',
  HIDDEN: 'badge',
};

export const FULFILLMENT_LABEL: Record<Fulfillment, string> = {
  DELIVERY: '택배 배송',
  PICKUP: '현장 수령',
  WALLET: '월렛 이용권',
};

export function formatWon(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `₩${Math.trunc(value).toLocaleString('ko-KR')}`;
}

export interface PriceView {
  main: string;
  sub?: string;
}

/** 굿즈 스토어 목록의 표시 가격(총금액 규칙, d5 §5.15 ⑬). */
export function priceView(p: Pick<PartnerProductSummary, 'price' | 'shippingFee' | 'fulfillments'>): PriceView {
  const fee = p.shippingFee ?? 0;
  const delivery = p.fulfillments.includes('DELIVERY');
  const other = p.fulfillments.some((f) => f !== 'DELIVERY');
  if (!delivery) return { main: formatWon(p.price) };
  if (other) return { main: formatWon(p.price), sub: `택배 배송비 ${formatWon(fee)} 별도(현장 수령 무료)` };
  return { main: `배송비 포함 ${formatWon(p.price + fee)}`, sub: `상품 ${formatWon(p.price)} + 배송비 ${formatWon(fee)}` };
}

export function stockText(p: Pick<PartnerProductSummary, 'stockRemaining' | 'stockTotal'>): string {
  if (p.stockTotal === null && p.stockRemaining === null) return '한정 없음';
  if (p.stockRemaining === null) return `— / ${p.stockTotal?.toLocaleString('ko-KR') ?? '—'}`;
  if (p.stockTotal === null) return `${p.stockRemaining.toLocaleString('ko-KR')} / —`;
  return `${p.stockRemaining.toLocaleString('ko-KR')} / ${p.stockTotal.toLocaleString('ko-KR')}`;
}

export function periodText(p: Pick<PartnerProductSummary, 'saleStartsAt' | 'saleEndsAt'>): { from: string; to: string } {
  return { from: kstText(p.saleStartsAt), to: kstText(p.saleEndsAt) };
}

/** 'YYYY-MM-DDTHH:mm:ssZ' → 'M/D(요일) HH:mm'. 값이 없으면 '—'. */
export function kstText(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('month')}/${get('day')}(${get('weekday')}) ${get('hour')}:${get('minute')}`;
}

export interface ProductFormValues {
  type: string;
  name: string;
  price: string;
  shippingFee: string;
  returnShippingFee: string;
  returnAddress: string;
  ticketLinked: boolean;
  linkedProductionId: string;
  linkedEventId: string;
  limitedQty: string;
  fulfillments: Fulfillment[];
  transferable: boolean;
  status: 'DRAFT' | 'PUBLISHED' | 'HIDDEN';
  description: string;
  options: string;
  /** 유형별 속성 가운데 화면이 모르는 칸. 고칠 때 지우지 않고 그대로 다시 보낸다. */
  attributes: Record<string, unknown>;
}

export const EMPTY_PRODUCT_FORM: ProductFormValues = {
  type: 'MERCH',
  name: '',
  price: '',
  shippingFee: '3000',
  returnShippingFee: '3000',
  returnAddress: '',
  ticketLinked: false,
  linkedProductionId: '',
  linkedEventId: '',
  limitedQty: '',
  fulfillments: ['DELIVERY', 'PICKUP'],
  transferable: false,
  status: 'PUBLISHED',
  description: '',
  options: '',
  attributes: {},
};

export function detailToForm(p: PartnerProductDetail): ProductFormValues {
  return {
    type: p.type,
    name: p.name,
    price: String(p.price),
    shippingFee: p.shippingFee === null ? '' : String(p.shippingFee),
    returnShippingFee: p.returnShippingFee === null ? '' : String(p.returnShippingFee),
    returnAddress: p.returnAddress ?? '',
    ticketLinked: p.ticketLinked,
    linkedProductionId: p.linkedProductionId ?? '',
    linkedEventId: p.linkedEventId ?? '',
    limitedQty: p.limitedQty === null ? '' : String(p.limitedQty),
    fulfillments: p.fulfillments,
    transferable: p.transferable,
    status: p.status === 'DRAFT' ? 'DRAFT' : p.status === 'HIDDEN' ? 'HIDDEN' : 'PUBLISHED',
    description: typeof p.attributes?.description === 'string' ? p.attributes.description : '',
    options: typeof p.attributes?.options === 'string' ? p.attributes.options : '',
    attributes: { ...(p.attributes ?? {}) },
  };
}

function integer(value: string): number | null {
  const t = value.replaceAll(',', '').trim();
  if (t === '') return null;
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

export interface ProductFormResult {
  body: PartnerProductUpdateBody | null;
  errors: Partial<Record<keyof ProductFormValues | 'fulfillments', string>>;
}

/** 화면 입력 → 저장 본문. 서버 검사 전에 빈 칸·범위만 본다. */
export function buildProductBody(v: ProductFormValues): ProductFormResult {
  const errors: ProductFormResult['errors'] = {};
  const name = v.name.trim();
  if (name.length < 1) errors.name = '상품명을 적어 주세요';
  else if (name.length > 100) errors.name = '상품명은 100자까지입니다';
  if (!v.type.trim()) errors.type = '상품 유형을 골라 주세요';
  const price = integer(v.price);
  if (price === null) errors.price = '가격을 숫자로 적어 주세요';
  if (v.fulfillments.length === 0) errors.fulfillments = '수령 방식을 하나 이상 골라 주세요';
  const delivery = v.fulfillments.includes('DELIVERY');
  const shippingFee = integer(v.shippingFee);
  if (delivery && shippingFee === null) errors.shippingFee = '택배 배송비를 숫자로 적어 주세요';
  const returnShippingFee = integer(v.returnShippingFee);
  if (delivery && returnShippingFee === null) errors.returnShippingFee = '반품 배송비를 숫자로 적어 주세요';
  if (delivery && !v.returnAddress.trim()) errors.returnAddress = '반품 받을 주소를 적어 주세요';
  if (v.ticketLinked && !v.linkedProductionId) errors.linkedProductionId = '연결 공연을 골라 주세요';
  if (v.ticketLinked && !v.linkedEventId) errors.linkedEventId = '연결 회차를 골라 주세요';
  const limitedQty = integer(v.limitedQty);
  if (v.limitedQty.trim() !== '' && limitedQty === null) errors.limitedQty = '한정 수량을 숫자로 적어 주세요';
  if (Object.keys(errors).length > 0 || price === null) return { body: null, errors };

  const attributes: Record<string, unknown> = { ...v.attributes };
  if (v.description.trim()) attributes.description = v.description.trim();
  else delete attributes.description;
  if (v.options.trim()) attributes.options = v.options.trim();
  else delete attributes.options;

  return {
    body: {
      type: v.type.trim(),
      name,
      price,
      shippingFee: delivery ? shippingFee : null,
      returnShippingFee: delivery ? returnShippingFee : null,
      returnAddress: delivery ? v.returnAddress.trim() : null,
      ticketLinked: v.ticketLinked,
      linkedEventId: v.ticketLinked ? v.linkedEventId : null,
      limitedQty,
      fulfillments: v.fulfillments,
      transferable: v.transferable,
      status: v.status,
      ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    },
    errors,
  };
}

/** 화면 칸의 숫자 표시(3,000). */
export function commaDigits(value: string): string {
  const t = value.replaceAll(',', '').replace(/[^\d]/g, '');
  if (t === '') return '';
  return Number(t).toLocaleString('ko-KR');
}
