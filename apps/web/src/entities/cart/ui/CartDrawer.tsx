'use client';
// 데스크톱 장바구니 오른쪽 드로어(d5 §5.15 'lg: 장바구니는 오른쪽 드로어다', 보드 SCR-015-d '장바구니 드로어').
// 키트 .scrim(오른쪽 붙임) + .dialog(폭 420) 마크업. 머리에 제목과 닫기 버튼이 있어 ds Dialog 대신 같은 동작을 여기서 한다:
// 열리면 안으로 초점, Tab 가두기, Esc·바깥 누르기로 닫기, 닫히면 연 버튼으로 초점 되돌리기, 바탕 스크롤 막기.
import { useEffect, useId, useRef, type KeyboardEvent, type MouseEvent } from 'react';
import type { CartGroup } from '../model';
import { CartGroups } from './CartGroups';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface CartDrawerProps {
  open: boolean;
  onClose: () => void;
  groups: readonly CartGroup[];
  checkoutHref?: string;
}

export function CartDrawer({ open, onClose, groups, checkoutHref }: CartDrawerProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
      if (trigger && document.contains(trigger)) trigger.focus();
    };
  }, [open]);

  if (!open) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeRef.current();
      return;
    }
    if (e.key !== 'Tab' || !panelRef.current) return;
    const list = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
    if (list.length === 0) return;
    const first = list[0]!;
    const last = list[list.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  const onScrimDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) closeRef.current();
  };

  return (
    <div className="scrim" style={{ position: 'fixed', justifyContent: 'flex-end', alignItems: 'stretch' }} onMouseDown={onScrimDown}>
      <div
        ref={panelRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{ maxWidth: 420, overflowY: 'auto' }}
        onKeyDown={onKeyDown}
      >
        <div className="row between">
          <h2 className="dialog-title" id={titleId}>
            장바구니
          </h2>
          <button className="icon-btn" type="button" aria-label="장바구니 닫기" onClick={() => closeRef.current()}>
            <i className="ic ic-close" aria-hidden="true" />
          </button>
        </div>
        <CartGroups groups={groups} headingLevel={3} idPrefix="cd" checkoutHref={checkoutHref} />
      </div>
    </div>
  );
}
