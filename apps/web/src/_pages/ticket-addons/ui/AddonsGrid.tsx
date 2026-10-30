'use client';
// 티켓 연동 부가 상품 카드 격자(굿즈 스토어 카탈로그와 같은 CMP-074 카드). 이 티켓의 회차에 붙은 상품만 보이므로 티켓 보유 차단은 없다.
// 옵션 없는 상품이라 장바구니 버튼은 1개를 바로 담고 토스트를 띄우고, 계정당 한도에 걸리면 한도 토스트를 띄운다.
import { useState } from 'react';
import { useShopToast, type ShopToastKind } from '@/entities/cart';
import { ProductGrid, type Product } from '@/entities/product';

export function AddonsGrid({ products, initialToast = null }: { products: readonly Product[]; initialToast?: { kind: ShopToastKind } | null }) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [toastNode, showToast] = useShopToast(initialToast);
  const onCart = (p: Product) => {
    const have = counts[p.id] ?? 0;
    if (have + 1 > p.perAccountLimit) {
      showToast('limit', p.perAccountLimit);
      return;
    }
    setCounts((c) => ({ ...c, [p.id]: have + 1 }));
    showToast('added');
  };
  return (
    <>
      <ProductGrid products={products} onCart={onCart} />
      {toastNode}
    </>
  );
}
