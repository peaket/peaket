// 굿즈·티켓 연동 부가 상품 목업(SCR-015, d5 §5.15). 판매자는 상품 빌더(SCR-023)로 상품을 올린 파트너다(POL-037).
// 이름·값은 캔버스 보드 SCR-015 그대로이고, 보드가 [가격]처럼 비워 둔 값은 d5의 예(응원봉 ₩35,000 · 택배 배송비 ₩3,000)에 맞춰 지어 넣었다.
// 금액은 원 단위 정수. 다른 entities를 가져오지 않으므로 공연·회차·판매자는 id와 표시 글만 들고 있다(합치기는 페이지에서).

/** goods: 공식 굿즈 · addon: 티켓 연동 부가 상품(현장·월렛 이용권, 택배 없음) */
export type ProductKind = 'goods' | 'addon';
/** 칩 '상품 종류' */
export type ProductCategory = 'lightstick' | 'apparel' | 'parking' | 'etc';
/** 수령 방식: ship-only(택배만) · ship-or-site(택배 + 현장 수령) · pass(부가 상품: 현장·월렛 이용권) */
export type ProductDelivery = 'ship-only' | 'ship-or-site' | 'pass';

export interface ProductOption {
  /** '사이즈' */
  label: string;
  values: readonly string[];
  defaultValue: string;
}

export interface Product {
  id: string;
  title: string;
  kind: ProductKind;
  category: ProductCategory;
  /** 자리 그림 아이콘(키트 ic-box·ic-bag). 실제 서비스에서는 파트너가 올린 상품 사진 */
  icon: 'box' | 'bag';
  price: number;
  /** 택배 배송비(택배가 되는 상품만) */
  shippingFee?: number;
  /** 단순 변심 반품 배송비 */
  returnShippingFee?: number;
  delivery: ProductDelivery;
  options?: ProductOption;
  /** 계정당 최대 구매 수량 */
  perAccountLimit: number;
  /** 한정 재고 배지 '한정 120개 남음' */
  stockText?: string;
  /** 한정 수량 전체(인기 MD 안내 '한정 120개') */
  limitedTotal?: number;
  soldOut?: boolean;
  /** 티켓 보유자 전용(부가 상품) */
  ticketOnly?: boolean;
  /** 연결 공연(티켓 소지자 전용 수령 시간대·부가 상품 연결 판단) */
  productionId: string;
  /** 부가 상품의 연결 회차 */
  performanceId?: string;
  /** 연결 회차 줄 '10/25(일) 18:00 회차' */
  roundText?: string;
  sellerId: string;
  /** 판매자 상호(카드 줄·고지 문장) */
  sellerName: string;
  /** 인기 MD: 오픈 때 대기실 경량 페이지의 굿즈 대기(/shop/[productId]/queue)를 먼저 거친다 */
  popularQueue?: boolean;
}

const STELLA = { sellerId: 'sel-stella', sellerName: '(주)스텔라엔터테인먼트' } as const;

export const PRODUCT_CATEGORIES: readonly { key: ProductCategory | 'all'; label: string }[] = [
  { key: 'all', label: '전체' },
  { key: 'lightstick', label: '응원봉' },
  { key: 'apparel', label: '의류' },
  { key: 'parking', label: '주차권' },
];

/** 티켓 소지자 전용 수령 시간대(보드의 [수령 시간대]를 지어 넣었다) */
export const TICKET_PICKUP_SLOT = { dateText: '10/25(일)', slotText: '15:00~16:30' } as const;

export const PRODUCTS: readonly Product[] = [
  {
    id: 'gds-lumen-lightstick',
    title: 'LUMEN 공식 응원봉',
    kind: 'goods',
    category: 'lightstick',
    icon: 'box',
    price: 35000,
    shippingFee: 3000,
    returnShippingFee: 3000,
    delivery: 'ship-or-site',
    perAccountLimit: 2,
    stockText: '한정 120개 남음',
    limitedTotal: 120,
    productionId: 'prd-lumen',
    popularQueue: true,
    ...STELLA,
  },
  {
    id: 'gds-lumen-tee',
    title: 'LUMEN 투어 티셔츠',
    kind: 'goods',
    category: 'apparel',
    icon: 'bag',
    price: 45000,
    shippingFee: 3000,
    returnShippingFee: 3000,
    delivery: 'ship-or-site',
    options: { label: '사이즈', values: ['S', 'M', 'L', 'XL'], defaultValue: 'L' },
    perAccountLimit: 2,
    productionId: 'prd-lumen',
    ...STELLA,
  },
  {
    id: 'gds-lumen-photocard',
    title: 'LUMEN 포토카드 세트',
    kind: 'goods',
    category: 'etc',
    icon: 'box',
    price: 15000,
    shippingFee: 3000,
    returnShippingFee: 3000,
    delivery: 'ship-only',
    perAccountLimit: 2,
    soldOut: true,
    productionId: 'prd-lumen',
    ...STELLA,
  },
  {
    id: 'gds-lumen-hoodie',
    title: 'LUMEN 투어 후드',
    kind: 'goods',
    category: 'apparel',
    icon: 'bag',
    price: 79000,
    shippingFee: 3000,
    returnShippingFee: 3000,
    delivery: 'ship-only',
    options: { label: '사이즈', values: ['S', 'M', 'L', 'XL'], defaultValue: 'L' },
    perAccountLimit: 2,
    productionId: 'prd-lumen',
    ...STELLA,
  },
  {
    id: 'add-lumen-parking-1025',
    title: 'LUMEN 콘서트 주차권',
    kind: 'addon',
    category: 'parking',
    icon: 'box',
    price: 20000,
    delivery: 'pass',
    perAccountLimit: 1,
    ticketOnly: true,
    productionId: 'prd-lumen',
    performanceId: 'evt-lumen-1025',
    roundText: '10/25(일) 18:00 회차',
    ...STELLA,
  },
  {
    id: 'add-lumen-parking-1026',
    title: 'LUMEN 콘서트 주차권',
    kind: 'addon',
    category: 'parking',
    icon: 'box',
    price: 20000,
    delivery: 'pass',
    perAccountLimit: 1,
    ticketOnly: true,
    productionId: 'prd-lumen',
    performanceId: 'evt-lumen-1026',
    roundText: '10/26(월) 17:00 회차',
    ...STELLA,
  },
  {
    id: 'add-lumen-vip-1025',
    title: 'VIP 라운지 이용권',
    kind: 'addon',
    category: 'etc',
    icon: 'box',
    price: 50000,
    delivery: 'pass',
    perAccountLimit: 1,
    ticketOnly: true,
    productionId: 'prd-lumen',
    performanceId: 'evt-lumen-1025',
    roundText: '10/25(일) 18:00 회차',
    ...STELLA,
  },
  {
    id: 'add-lumen-fasttrack-1025',
    title: '패스트 트랙',
    kind: 'addon',
    category: 'etc',
    icon: 'box',
    price: 30000,
    delivery: 'pass',
    perAccountLimit: 1,
    ticketOnly: true,
    productionId: 'prd-lumen',
    performanceId: 'evt-lumen-1025',
    roundText: '10/25(일) 18:00 회차',
    ...STELLA,
  },
];

/** 굿즈 상세 예시 id(화면 목록의 경로) */
export const DEMO_PRODUCT_ID = 'gds-lumen-lightstick';

export function getProduct(id: string): Product | undefined {
  return PRODUCTS.find((p) => p.id === id);
}

/** 한 회차에 연결된 부가 상품(마이 티켓 ③ → /my/tickets/[ticketId]/addons) */
export function listAddonsForPerformance(performanceId: string): Product[] {
  return PRODUCTS.filter((p) => p.kind === 'addon' && p.performanceId === performanceId);
}

export function productHref(id: string): string {
  return `/shop/${encodeURIComponent(id)}`;
}

/** 상품용 중개자 고지(POL-037 원문 그대로, 판매자 = 상품을 등록한 파트너). 상품 상세 ③·주문서 결제 직전에 싣는다 */
export function productBrokerNotice(sellerName: string): string {
  return `판매자: ${sellerName}. PEAKET은 통신판매중개자로서 이 상품 거래의 당사자가 아닙니다. 상품의 제공(배송·이용)과 품질에 따른 책임은 판매자에게 있고, 주문 취소·반품과 환불은 PEAKET이 처리합니다`;
}

/** '₩35,000'(entities/production의 formatWon과 같은 모양) */
export function won(value: number): string {
  return `₩${new Intl.NumberFormat('ko-KR').format(value)}`;
}

/**
 * 목록 카드의 표시 가격 ⑬(전자상거래법 §21의2①1호, POL-016, ADR-0063): 가격이 처음 보이는 곳이라 필수 비용을 포함한 총금액.
 * 택배만 되면 '배송비 포함 ₩총액' + 작게 '상품 ₩n + 배송비 ₩n', 현장 수령(무료)도 되면 '₩n' + '택배 배송비 ₩n 별도(현장 수령 무료)'.
 */
export function displayPrice(p: Product): { main: string; sub?: string } {
  if (p.delivery === 'ship-only' && p.shippingFee) {
    return { main: `배송비 포함 ${won(p.price + p.shippingFee)}`, sub: `상품 ${won(p.price)} + 배송비 ${won(p.shippingFee)}` };
  }
  if (p.delivery === 'ship-or-site' && p.shippingFee) {
    return { main: won(p.price), sub: `택배 배송비 ${won(p.shippingFee)} 별도(현장 수령 무료)` };
  }
  return { main: won(p.price) };
}
