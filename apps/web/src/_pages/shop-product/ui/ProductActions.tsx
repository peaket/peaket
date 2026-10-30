'use client';
// 상품 상세의 [ 장바구니 담기 ] [[ 바로 구매 ]](카드가 아니라 글자 버튼 그대로, ADR-0066).
// 휴대폰·태블릿은 화면 아래 고정 띠(.bottom-bar), 데스크톱(lg)은 고르기 칸 아래 한 줄. 두 곳에 따로 그리고 각자 토스트를 가진다
// (보이지 않는 쪽은 display:none이라 그 토스트도 보이지 않는다).
// 살 수 없을 때(티켓 미소지·품절)는 aria-disabled + 이유 글(배너·배지) id로 잇는다.
import Link from 'next/link';
import { Button } from '@peaket/ds/Button';
import { useShopToast, type ShopToastKind } from '@/entities/cart';

export interface ProductActionsProps {
  /** 'bar': 아래 고정 띠(lg 미만) · 'inline': 데스크톱 한 줄 */
  placement: 'bar' | 'inline';
  /** 살 수 없는 이유 글의 id(있으면 두 버튼을 aria-disabled로) */
  blockedReasonId?: string;
  checkoutHref?: string;
  initialToast?: { kind: ShopToastKind } | null;
}

export function ProductActions({ placement, blockedReasonId, checkoutHref = '/shop/checkout', initialToast = null }: ProductActionsProps) {
  const [toastNode, showToast] = useShopToast(initialToast);
  const buttons = (
    <>
      <Button variant="secondary" size="lg" className="grow" disabledReasonId={blockedReasonId} onClick={() => showToast('added')}>
        장바구니 담기
      </Button>
      {blockedReasonId ? (
        <Button size="lg" className="grow" disabledReasonId={blockedReasonId}>
          바로 구매
        </Button>
      ) : (
        <Link className="btn btn-primary btn-lg grow" href={checkoutHref}>
          바로 구매
        </Link>
      )}
    </>
  );
  return placement === 'bar' ? (
    <div className="bottom-bar sticky bottom-0 z-10 md:px-6 lg:hidden">
      {buttons}
      {toastNode}
    </div>
  ) : (
    <div className="row hidden lg:flex" style={{ gap: 12 }}>
      {buttons}
      {toastNode}
    </div>
  );
}
