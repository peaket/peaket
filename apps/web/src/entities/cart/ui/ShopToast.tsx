'use client';
// 굿즈 스토어 토스트(키트 .toast, CMP-018, d5 §5.15 상태 표). 담기 결과에는 '장바구니 보기 ›' 링크가 붙어 공용 토스트(글만)와 따로 둔다.
// - 알림 자리는 늘 그려 두고(role="status") 글이 바뀌면 한 번 읽힌다. 휴대폰은 좌우 16px 꽉 찬 폭, 태블릿부터 가운데 한 줄.
// - 상태 미리보기로 처음부터 띄운 토스트는 사라지지 않고, 누른 뒤 띄운 토스트는 4초 뒤 사라진다.
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export type ShopToastKind = 'added' | 'soldout' | 'limit' | 'ticket' | 'ordered';

interface ToastState {
  id: number;
  kind: ShopToastKind;
  /** limit: 계정당 한도 */
  limit?: number;
  persist: boolean;
}

const TOAST: Record<ShopToastKind, { icon: string; text: (limit?: number) => string; cartLink?: boolean }> = {
  added: { icon: 'ic-check', text: () => '장바구니에 담았습니다', cartLink: true },
  soldout: { icon: 'ic-alert-circle', text: () => '방금 품절되었습니다' },
  limit: { icon: 'ic-info', text: (n) => `계정당 ${n ?? 2}개까지 살 수 있습니다` },
  ticket: { icon: 'ic-lock', text: () => '이 상품은 티켓 보유자만 구매할 수 있습니다' },
  ordered: { icon: 'ic-check', text: () => '주문했습니다' },
};

export type ShowShopToast = (kind: ShopToastKind, limit?: number) => void;

/** [토스트 자리, 띄우기]. initial은 상태 미리보기(사라지지 않음) */
export function useShopToast(
  initial?: { kind: ShopToastKind; limit?: number } | null,
  cartHref = '/shop/cart',
): [ReactNode, ShowShopToast] {
  const [toast, setToast] = useState<ToastState | null>(initial ? { id: 0, kind: initial.kind, limit: initial.limit, persist: true } : null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = useCallback<ShowShopToast>((kind, limit) => {
    clearTimeout(timer.current);
    setToast({ id: Date.now(), kind, limit, persist: false });
    timer.current = setTimeout(() => setToast(null), 4000);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const t = toast ? TOAST[toast.kind] : null;
  const node = (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[95] flex justify-center px-4 lg:bottom-8" role="status" aria-live="polite">
      {toast && t ? (
        <div key={toast.id} className="toast pointer-events-auto w-full md:w-auto md:whitespace-nowrap">
          <i className={`ic ${t.icon}`} aria-hidden="true" />
          <span className="grow">{t.text(toast.limit)}</span>
          {t.cartLink ? (
            <Link className="link-more" href={cartHref} style={{ color: 'var(--on-inverse)' }}>
              장바구니 보기
              <i className="ic ic-chevron-right" aria-hidden="true" />
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
  return [node, show];
}
