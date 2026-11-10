'use client';
// 라이브 에디터의 대화상자(키트 .scrim·.dialog). 여닫기를 상태로 잇는다(퍼블리싱 Modal은 data 속성으로 잇는다). 초점 가두기·Esc 닫기.
import { useRef, type ReactNode } from 'react';
import { useFocusTrap } from '@peaket/ds/PartnerShell';

export function LiveDialog({ id, title, onClose, role = 'dialog', maxWidth = 560, children }: { id: string; title: string; onClose: () => void; role?: 'dialog' | 'alertdialog'; maxWidth?: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, onClose);
  return (
    <div className="scrim" style={{ position: 'fixed', zIndex: 200 }} onClick={(e) => e.target === e.currentTarget && role === 'dialog' && onClose()}>
      <div ref={ref} id={id} className="dialog" role={role} aria-modal="true" aria-labelledby={`${id}-h`} style={{ maxWidth, maxHeight: 'calc(100dvh - 32px)', overflowY: 'auto' }}>
        <h2 className="t-lg" id={`${id}-h`}>
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
