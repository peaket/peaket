'use client';
// 굿즈 스토어 카탈로그 본문(보드 SCR-015 isCatalog): 제목 줄과 장바구니 버튼 → 상품 종류 칩 → 안내 배너 → 상품 카드 격자.
// 카드의 장바구니 버튼: 옵션 없는 상품은 1개를 바로 담고 토스트, 옵션 있는 상품은 옵션 시트, 티켓 보유자 전용인데 티켓이 없거나
// 계정당 한도에 걸리면 토스트로 알린다(d5 §5.15, ADR-0066). 장바구니 버튼은 휴대폰·태블릿은 /shop/cart 링크, 데스크톱은 오른쪽 드로어.
import Link from 'next/link';
import { useState } from 'react';
import { CART_GROUPS, CartDrawer, cartLineCount, cartQuantities, useShopToast, type ShopToastKind } from '@/entities/cart';
import { PRODUCT_CATEGORIES, ProductGrid, type Product, type ProductCategory } from '@/entities/product';
import { OptionSheet } from './OptionSheet';

export interface ShopCatalogProps {
  products: readonly Product[];
  /** 지금 사용자가 티켓을 가진 회차 id(티켓 보유자 전용 상품 판단) */
  ownedPerformanceIds: readonly string[];
  /** 상태 미리보기: 처음부터 연 옵션 시트의 상품 id */
  initialSheetProductId?: string;
  initialDrawer?: boolean;
  initialToast?: { kind: ShopToastKind; limit?: number } | null;
}

const CART_HREF = '/shop/cart';

export function ShopCatalog({ products, ownedPerformanceIds, initialSheetProductId, initialDrawer = false, initialToast = null }: ShopCatalogProps) {
  const [category, setCategory] = useState<ProductCategory | 'all'>('all');
  const [sheet, setSheet] = useState<Product | null>(() => products.find((p) => p.id === initialSheetProductId) ?? null);
  const [drawer, setDrawer] = useState(initialDrawer);
  const [counts, setCounts] = useState<Record<string, number>>(() => cartQuantities(CART_GROUPS));
  const [lineCount, setLineCount] = useState(() => cartLineCount(CART_GROUPS));
  const [toastNode, showToast] = useShopToast(initialToast, CART_HREF);
  const cartLabel = `장바구니, 담은 상품 ${lineCount}개`;
  const shown = category === 'all' ? products : products.filter((p) => p.category === category);

  const add = (p: Product, quantity: number) => {
    const have = counts[p.id] ?? 0;
    if (have + quantity > p.perAccountLimit) {
      showToast('limit', p.perAccountLimit);
      return false;
    }
    setCounts((c) => ({ ...c, [p.id]: have + quantity }));
    if (have === 0) setLineCount((n) => n + 1);
    showToast('added');
    return true;
  };
  const onCart = (p: Product) => {
    if (p.ticketOnly && !(p.performanceId && ownedPerformanceIds.includes(p.performanceId))) {
      showToast('ticket');
      return;
    }
    if (p.options) {
      setSheet(p);
      return;
    }
    add(p, 1);
  };

  return (
    <>
      <div className="row between items-start gap-2 md:items-end md:gap-4">
        <div className="col" style={{ gap: 4 }}>
          <h1 className="t-xl md:text-[32px] md:leading-[42px] md:tracking-[-0.01em]">굿즈 스토어</h1>
          <p className="t-sm muted lg:text-base lg:leading-[22px]">공식 굿즈와 티켓 연동 부가 상품</p>
        </div>
        <Link className="icon-btn icon-btn-outline md:hidden" href={CART_HREF} aria-label={cartLabel}>
          <i className="ic ic-cart" aria-hidden="true" />
          <span className="count-dot" aria-hidden="true">
            {lineCount}
          </span>
        </Link>
        <Link className="btn btn-outline hidden md:inline-flex lg:hidden" href={CART_HREF} aria-label={cartLabel}>
          <i className="ic ic-cart" aria-hidden="true" />
          장바구니
          <span className="badge badge-primary" aria-hidden="true">
            {lineCount}
          </span>
        </Link>
        <button className="btn btn-outline hidden lg:inline-flex" type="button" aria-haspopup="dialog" aria-expanded={drawer} aria-label={cartLabel} onClick={() => setDrawer(true)}>
          <i className="ic ic-cart" aria-hidden="true" />
          장바구니
          <span className="badge badge-primary" aria-hidden="true">
            {lineCount}
          </span>
        </button>
      </div>

      <div className="row wrap" style={{ gap: 8 }} role="group" aria-label="상품 종류">
        {PRODUCT_CATEGORIES.map((c) => (
          <button
            key={c.key}
            className={c.key === category ? 'chip is-selected' : 'chip'}
            type="button"
            aria-pressed={c.key === category}
            onClick={() => setCategory(c.key)}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="banner banner-info">
        <i className="ic ic-info" aria-hidden="true" />
        <div className="banner-body">
          <span className="banner-title">티켓이 없어도 구매할 수 있습니다</span>
          티켓이 있으면 현장 수령 때 티켓 소지자 전용 수령 시간대를 고를 수 있습니다. 티켓 보유자 전용 상품은 티켓이 있어야 구매할 수 있습니다.
        </div>
      </div>

      <section className="pt-1 md:pt-2 lg:pt-0" aria-labelledby="h-goods">
        <h2 className="sr-only" id="h-goods">
          상품 목록
        </h2>
        <ProductGrid products={shown} onCart={onCart} />
      </section>

      <OptionSheet
        product={sheet}
        onClose={() => setSheet(null)}
        onLimit={(n) => showToast('limit', n)}
        onAdd={(p, _option, qty) => {
          if (add(p, qty)) setSheet(null);
        }}
      />
      <CartDrawer open={drawer} onClose={() => setDrawer(false)} groups={CART_GROUPS} />
      {toastNode}
    </>
  );
}
