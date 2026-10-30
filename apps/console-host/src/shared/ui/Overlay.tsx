// 겹침(키트 14절 .scrim) 틀: 초점을 안에 가두고 Esc·바깥 누름으로 닫는다(d2 대화상자 요건).
// 보드의 대화상자·시트 마크업을 children으로 그대로 넣는다. 퍼블리싱 상태에서 열린 채로 그릴 때 쓴다.
import { useEffect, useRef, type ReactNode } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface OverlayProps {
  /** 'bottom'(휴대폰 시트) · 'left'(메뉴 서랍) · 기본은 가운데 */
  placement?: 'center' | 'bottom' | 'left';
  onClose?: () => void;
  children: ReactNode;
}

export function Overlay({ placement = 'center', onClose, children }: OverlayProps) {
  const ref = useRef<HTMLDivElement>(null);
  // 닫기 함수는 ref로 읽는다. 부모가 다시 그려 함수가 바뀌어도 초점 가두기 효과는 열 때 한 번만 돈다(초점이 튀지 않는다)
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('[autofocus], ' + FOCUSABLE);
    first?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current?.();
      if (e.key === 'Tab' && ref.current) {
        const els = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (els.length === 0) return;
        const f = els[0]!;
        const l = els[els.length - 1]!;
        if (e.shiftKey && document.activeElement === f) {
          e.preventDefault();
          l.focus();
        } else if (!e.shiftKey && document.activeElement === l) {
          e.preventDefault();
          f.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.({ preventScroll: true });
    };
  }, []);
  return (
    <div
      ref={ref}
      className={placement === 'center' ? 'scrim' : `scrim ${placement}`}
      style={{ position: 'fixed' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      {children}
    </div>
  );
}
