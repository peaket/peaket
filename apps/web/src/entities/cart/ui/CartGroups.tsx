'use client';
// 장바구니 본문(보드 SCR-015-d '장바구니 드로어'의 마크업). 장바구니 페이지(/shop/cart)와 데스크톱 오른쪽 드로어가 함께 쓴다.
// 판매자·수령 방식별 묶음마다 상품 줄(수량 고르기·빼기)과 합계, 아래에 [주문서로 가기]. 다 빼면 빈 화면을 보인다.
import Link from 'next/link';
import { Fragment, useState } from 'react';
import { groupSubtotal, groupTotal, lineMeta, won, type CartGroup } from '../model';
import { QuantityStepper } from './QuantityStepper';
import { useShopToast } from './ShopToast';

export interface CartGroupsProps {
  groups: readonly CartGroup[];
  /** 묶음 제목 수준(페이지 h1 아래면 2, 드로어 h2 아래면 3) */
  headingLevel?: 2 | 3;
  /** 같은 화면에 둘 이상 그릴 때 id 앞말 */
  idPrefix?: string;
  checkoutHref?: string;
  /** 비었을 때 '굿즈 스토어 둘러보기' 링크 */
  shopHref?: string;
}

export function CartGroups({ groups: initial, headingLevel = 2, idPrefix = 'cg', checkoutHref = '/shop/checkout', shopHref = '/shop' }: CartGroupsProps) {
  const [groups, setGroups] = useState<CartGroup[]>(() => initial.map((g) => ({ ...g, lines: g.lines.map((l) => ({ ...l })) })));
  const [toastNode, showToast] = useShopToast(null);
  const H = headingLevel === 2 ? 'h2' : 'h3';
  const live = groups.filter((g) => g.lines.length > 0);
  const maxAll = Math.max(...initial.flatMap((g) => g.lines.map((l) => l.maxQuantity)), 1);

  const setQty = (lineId: string, quantity: number) =>
    setGroups((gs) => gs.map((g) => ({ ...g, lines: g.lines.map((l) => (l.id === lineId ? { ...l, quantity } : l)) })));
  const remove = (lineId: string) => setGroups((gs) => gs.map((g) => ({ ...g, lines: g.lines.filter((l) => l.id !== lineId) })));

  if (live.length === 0) return <CartEmpty headingLevel={headingLevel} shopHref={shopHref} />;

  return (
    <>
      <p className="hint">판매자·수령 방식별로 따로 결제합니다</p>
      {live.map((g, gi) => {
        const hId = `${idPrefix}-${g.kind}`;
        return (
          <Fragment key={g.id}>
            {gi > 0 ? <div className="divider" /> : null}
            <section className="col" style={{ gap: 8 }} aria-labelledby={hId}>
              <div className="col" style={{ gap: 2 }}>
                <H className={headingLevel === 2 ? 't-md fw-b' : 't-sm fw-b'} id={hId}>
                  {g.title}
                </H>
                {g.showSeller ? <span className="t-xs muted">판매자 {g.sellerName}</span> : null}
              </div>
              <ul className="col">
                {g.lines.map((l) => (
                  <li key={l.id} className="li" style={{ alignItems: 'flex-start' }}>
                    <span className="card-flat center muted" style={{ width: 64, height: 64, flex: 'none' }} aria-hidden="true">
                      <i className={`ic ic-${l.icon} ic-24`} />
                    </span>
                    <span className="col grow" style={{ gap: 8 }}>
                      <span className="col" style={{ gap: 2 }}>
                        <span className="t-sm fw-b">{l.title}</span>
                        <span className="li-sub">{lineMeta(l, false)}</span>
                        <span className="t-sm fw-b num">{won(l.unitPrice * l.quantity)}</span>
                      </span>
                      <QuantityStepper
                        label={`${l.title} 수량`}
                        value={l.quantity}
                        max={l.maxQuantity}
                        onChange={(q) => setQty(l.id, q)}
                        onLimit={() => showToast('limit', l.maxQuantity)}
                      />
                    </span>
                    <button className="icon-btn icon-btn-sm" type="button" aria-label={`${l.title} 장바구니에서 빼기`} onClick={() => remove(l.id)}>
                      <i className="ic ic-close" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
              <dl className="kv" aria-label={`${g.title} 합계`}>
                <dt>상품 금액</dt>
                <dd>{won(groupSubtotal(g))}</dd>
                {g.kind === 'ship' ? (
                  <>
                    <dt>배송비</dt>
                    <dd>{won(g.shippingFee ?? 0)}</dd>
                  </>
                ) : null}
                <dt className="kv-total">결제 예정 금액</dt>
                <dd className="kv-total">{won(groupTotal(g))}</dd>
              </dl>
            </section>
          </Fragment>
        );
      })}
      <p className="hint">택배 상품의 배송지는 주문서에서 입력합니다. 계정당 최대 {maxAll}개까지 구매할 수 있습니다.</p>
      <Link className="btn btn-primary btn-lg btn-block" href={checkoutHref} style={{ marginTop: 'auto' }}>
        주문서로 가기
      </Link>
      {toastNode}
    </>
  );
}

/** 빈 장바구니(보드에 없어 굿즈 스토어 빈 화면 모양을 빌렸다. 문구는 추천안) */
export function CartEmpty({ headingLevel = 2, shopHref = '/shop' }: { headingLevel?: 2 | 3; shopHref?: string }) {
  const H = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <div className="card-flat state" style={{ padding: '48px 20px' }}>
      <span className="state-icon">
        <i className="ic ic-cart" aria-hidden="true" />
      </span>
      <H className="t-lg">장바구니가 비어 있습니다</H>
      <Link className="link-more" href={shopHref}>
        굿즈 스토어 둘러보기
        <i className="ic ic-chevron-right" aria-hidden="true" />
      </Link>
    </div>
  );
}
