// 장바구니 목업(SCR-015 장바구니·주문서, d5 §5.15). 보드 SCR-015의 담은 상품 2개(티셔츠 L 택배 · 응원봉 티켓 소지자 전용 수령 시간대) 그대로다.
// 판매자·수령 방식별 묶음마다 따로 결제한다(한 결제 = 한 판매자·한 수령 방식). 다른 entities를 가져오지 않으므로 줄마다 표시 글을 들고 있다.

/** ship: 택배로 받는 상품 · site: 현장에서 받는 상품(현장 수령·티켓 소지자 전용 수령 시간대·부가 상품) */
export type CartGroupKind = 'ship' | 'site';

export interface CartLine {
  id: string;
  productId: string;
  title: string;
  /** 자리 그림 아이콘(ic-box·ic-bag) */
  icon: 'box' | 'bag';
  /** 옵션 'L' */
  optionText?: string;
  /** 수령 방식 줄 '택배 배송' · '티켓 소지자 전용 수령 시간대 10/25(일) 15:00~16:30' */
  pickupText: string;
  quantity: number;
  /** 계정당 최대 */
  maxQuantity: number;
  unitPrice: number;
}

export interface CartGroup {
  id: string;
  kind: CartGroupKind;
  /** '택배로 받는 상품' */
  title: string;
  sellerName: string;
  /** 묶음 머리에 판매자 줄을 보이는지(보드: 택배 묶음만) */
  showSeller: boolean;
  /** 택배 배송비(택배 묶음만) */
  shippingFee?: number;
  lines: CartLine[];
}

export const CART_GROUPS: readonly CartGroup[] = [
  {
    id: 'grp-ship-stella',
    kind: 'ship',
    title: '택배로 받는 상품',
    sellerName: '(주)스텔라엔터테인먼트',
    showSeller: true,
    shippingFee: 3000,
    lines: [
      {
        id: 'cl-tee-l',
        productId: 'gds-lumen-tee',
        title: 'LUMEN 투어 티셔츠',
        icon: 'bag',
        optionText: 'L',
        pickupText: '택배 배송',
        quantity: 1,
        maxQuantity: 2,
        unitPrice: 45000,
      },
    ],
  },
  {
    id: 'grp-site-stella',
    kind: 'site',
    title: '현장에서 받는 상품',
    sellerName: '(주)스텔라엔터테인먼트',
    showSeller: false,
    lines: [
      {
        id: 'cl-lightstick',
        productId: 'gds-lumen-lightstick',
        title: 'LUMEN 공식 응원봉',
        icon: 'box',
        pickupText: '티켓 소지자 전용 수령 시간대 10/25(일) 15:00~16:30',
        quantity: 1,
        maxQuantity: 2,
        unitPrice: 35000,
      },
    ],
  },
];

/** 주문서의 한정 재고 예약 끝 시각(주문 뒤 15분 [가정], ADR-0107) */
export const STOCK_HOLD_UNTIL_TEXT = '20:22';

/** 담은 상품 수(줄 수) — 셸·카탈로그의 '장바구니, 담은 상품 2개' */
export function cartLineCount(groups: readonly CartGroup[]): number {
  return groups.reduce((n, g) => n + g.lines.length, 0);
}

/** 상품 id별 담은 수량(한도 판단용) */
export function cartQuantities(groups: readonly CartGroup[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of groups) for (const l of g.lines) out[l.productId] = (out[l.productId] ?? 0) + l.quantity;
  return out;
}

export function groupSubtotal(g: CartGroup): number {
  return g.lines.reduce((n, l) => n + l.unitPrice * l.quantity, 0);
}

/** 결제 예정 금액(택배 묶음은 배송비 포함) */
export function groupTotal(g: CartGroup): number {
  return groupSubtotal(g) + (g.kind === 'ship' && g.lines.length > 0 ? (g.shippingFee ?? 0) : 0);
}

/** 줄 아래 작은 글 'L · 1개 · 택배 배송'(장바구니는 수량을 수량 고르기로 따로 보여 'L · 택배 배송') */
export function lineMeta(l: CartLine, withQuantity: boolean): string {
  return [l.optionText, withQuantity ? `${l.quantity}개` : undefined, l.pickupText].filter(Boolean).join(' · ');
}

/** '₩48,000'(entities/product의 won과 같은 모양. entities끼리 가져오지 않아 따로 둔다) */
export function won(value: number): string {
  return `₩${new Intl.NumberFormat('ko-KR').format(value)}`;
}
