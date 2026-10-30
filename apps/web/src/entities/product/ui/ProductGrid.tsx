'use client';
// 상품 카드 격자(CMP-074 ProductCard simple·with-options, 보드 SCR-015 카탈로그). 휴대폰 2열 · 태블릿 3열 · 데스크톱 4열.
// - 글자 묶음 1행은 [상품 이름(2줄 말줄임) | 장바구니 아이콘 버튼(44×44, ic-cart)], 그 아래 줄은 두 칸을 다 쓴다(ADR-0066).
// - 카드의 링크는 상품 이름 하나다. 그 클릭 영역만 가상 요소로 카드 전체로 넓히고, 장바구니 버튼은 그 위에 따로 누른다.
// - 옵션 있는 상품의 버튼은 aria-haspopup="dialog"와 '… 옵션 고르고 장바구니에 담기', 품절은 aria-disabled + <품절> 배지로 잇는다.
// 누른 뒤의 일(옵션 시트·토스트)은 부르는 쪽(onCart)이 한다.
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { cx } from '@/shared/lib/cx';
import { displayPrice, productHref, type Product } from '../model';

const TITLE_CLAMP: CSSProperties = {
  alignSelf: 'center',
  color: 'inherit',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
};
const FULL: CSSProperties = { gridColumn: '1/-1' };
const DISABLED_BTN: CSSProperties = { alignSelf: 'start', background: 'var(--surface-disabled)', color: 'var(--text-disabled)', borderColor: 'transparent' };

export interface ProductGridProps {
  products: readonly Product[];
  /** 장바구니 아이콘 버튼을 눌렀을 때(품절이면 부르지 않는다) */
  onCart?: (product: Product) => void;
  /** 격자 목록 클래스(기본: 2·3·4열) */
  className?: string;
  /** 목록 이름을 가리킬 제목 id */
  labelledBy?: string;
}

export function ProductGrid({ products, onCart, className, labelledBy }: ProductGridProps) {
  return (
    <ul
      className={cx('grid grid-cols-2 gap-x-3 gap-y-6 md:grid-cols-3 md:gap-x-4 md:gap-y-7 lg:grid-cols-4 lg:gap-x-6 lg:gap-y-8', className)}
      aria-labelledby={labelledBy}
    >
      {products.map((p) => (
        <ProductCard key={p.id} product={p} onCart={onCart} />
      ))}
    </ul>
  );
}

function cartLabel(p: Product): string {
  if (p.options) return `${p.title} 옵션 고르고 장바구니에 담기`;
  if (p.roundText) return `${p.title} ${p.roundText} 장바구니에 담기`;
  return `${p.title} 장바구니에 담기`;
}

export function ProductCard({ product: p, onCart }: { product: Product; onCart?: (product: Product) => void }) {
  const price = displayPrice(p);
  const soldOutId = `so-${p.id}`;
  return (
    <li className="relative col gap-2.5 lg:gap-3">
      <span className="card-flat center muted" style={{ aspectRatio: 1 }} aria-hidden="true">
        <i className={`ic ic-${p.icon} ic-48 md:size-16`} />
      </span>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', columnGap: 8, rowGap: 4 }}>
        <Link className="t-sm fw-b after:absolute after:inset-0 after:content-[''] md:text-base md:leading-[22px]" href={productHref(p.id)} style={TITLE_CLAMP}>
          {p.title}
        </Link>
        {p.soldOut ? (
          <button
            className="icon-btn icon-btn-outline relative z-[1]"
            type="button"
            aria-disabled="true"
            aria-label={cartLabel(p)}
            aria-describedby={soldOutId}
            style={DISABLED_BTN}
          >
            <i className="ic ic-cart" aria-hidden="true" />
          </button>
        ) : (
          <button
            className="icon-btn icon-btn-outline relative z-[1]"
            type="button"
            aria-haspopup={p.options ? 'dialog' : undefined}
            aria-label={cartLabel(p)}
            style={{ alignSelf: 'start' }}
            onClick={() => onCart?.(p)}
          >
            <i className="ic ic-cart" aria-hidden="true" />
          </button>
        )}
        {p.roundText ? (
          <span className="t-xs muted" style={FULL}>
            {p.roundText}
          </span>
        ) : null}
        <span className="t-md fw-b num lg:text-xl lg:leading-[27px]" style={FULL}>
          {price.main}
        </span>
        {price.sub ? (
          <span className="t-xs muted num" style={FULL}>
            {price.sub}
          </span>
        ) : null}
        <span className="t-xs muted" style={FULL}>
          판매자 {p.sellerName}
        </span>
        {p.stockText || p.soldOut || p.ticketOnly ? (
          <span className="row wrap" style={{ ...FULL, gap: 4 }}>
            {p.soldOut ? (
              <span className="badge badge-danger" id={soldOutId}>
                품절
              </span>
            ) : p.stockText ? (
              <span className="badge">{p.stockText}</span>
            ) : null}
            {p.ticketOnly ? <span className="badge badge-primary">티켓 보유자 전용</span> : null}
          </span>
        ) : null}
      </div>
    </li>
  );
}
