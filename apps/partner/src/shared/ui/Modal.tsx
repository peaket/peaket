'use client';
// 키트 대화상자(14절 .scrim·.dialog)와 휴대폰 아래 시트(.sheet 모양). 초점 가두기·Esc 닫기·연 요소로 초점 돌려주기.
// 서버 부품에서도 쓰도록 여닫기를 data 속성으로 잇는다:
//   여는 버튼 <button data-modal-open="seller-req">…</button>  ·  안의 닫는 버튼 <button data-modal-close>취소</button>
// 상태 미리보기에서 열린 채로 그릴 때는 defaultOpen.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useFocusTrap } from '@peaket/ds/PartnerShell';

export interface ModalProps {
  /** data-modal-open 값과 맞춘다 */
  id: string;
  defaultOpen?: boolean;
  role?: 'dialog' | 'alertdialog';
  labelledBy: string;
  describedBy?: string;
  maxWidth?: number;
  /** 휴대폰(md 미만)에서 아래 시트로(기본 켬) */
  sheetOnMobile?: boolean;
  /** Esc·바깥 누름으로 닫지 않는다(alertdialog 등) */
  persistent?: boolean;
  className?: string;
  children: ReactNode;
}

const SHEET = 'max-md:max-w-none max-md:rounded-b-none max-md:rounded-t-[var(--r-xl)] max-md:gap-[14px] max-md:px-5 max-md:pb-6';

export function Modal({
  id,
  defaultOpen = false,
  role = 'dialog',
  labelledBy,
  describedBy,
  maxWidth = 420,
  sheetOnMobile = true,
  persistent = false,
  className,
  children,
}: ModalProps) {
  const [open, setOpen] = useState(defaultOpen);
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, open, persistent ? undefined : () => setOpen(false));

  useEffect(() => {
    function onClick(e: MouseEvent) {
      const t = e.target as Element | null;
      const opener = t?.closest('[data-modal-open]');
      if (opener && opener.getAttribute('data-modal-open') === id && opener.getAttribute('aria-disabled') !== 'true') {
        e.preventDefault();
        setOpen(true);
      }
    }
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [id]);

  if (!open) return null;
  return (
    <div
      className={`scrim${sheetOnMobile ? ' max-md:items-end max-md:p-0' : ''}`}
      style={{ position: 'fixed', zIndex: 200 }}
      onClick={(e) => {
        if (!persistent && e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        ref={ref}
        id={id}
        className={['dialog', sheetOnMobile ? SHEET : '', className ?? ''].join(' ')}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        style={{ maxWidth, maxHeight: 'calc(100dvh - 32px)', overflowY: 'auto' }}
        onClick={(e) => {
          if ((e.target as Element).closest('[data-modal-close]')) setOpen(false);
        }}
      >
        {children}
      </div>
    </div>
  );
}
