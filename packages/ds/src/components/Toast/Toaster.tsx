'use client';
// 토스트를 그리는 자리. 셸(앱 레이아웃)에 한 번 둔다. 화면 아래 가운데에 떠 있다.
// - 바깥 영역이 role="status"(aria-live="polite")라 새 토스트를 한 번 읽는다.
// - 5초 뒤 사라지고, 마우스를 올리거나 키보드 초점이 들어오면 사라지기를 잠시 멈춘다(d2 CMP-018).
import { useEffect, useRef, useSyncExternalStore, type CSSProperties } from 'react';
import { dismissToast, toastStore, type ToastItem } from './store';
import { Toast } from './Toast';

export interface ToasterProps {
  /** 화면 아래에서 띄울 거리(px). 하단 고정 바가 있는 화면은 그 높이만큼 올린다. 기본 24 */
  bottom?: number;
}

function ToastView({ item }: { item: ToastItem }) {
  const remaining = useRef(item.duration);
  const startedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const start = () => {
    clearTimeout(timer.current);
    startedAt.current = Date.now();
    timer.current = setTimeout(() => dismissToast(item.id), remaining.current);
  };
  const pause = () => {
    clearTimeout(timer.current);
    remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current));
  };

  useEffect(() => {
    start();
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div onMouseEnter={pause} onMouseLeave={start} onFocus={pause} onBlur={start}>
      <Toast tone={item.tone} icon={item.icon} action={item.action} role={null}>
        {item.message}
      </Toast>
    </div>
  );
}

export function Toaster({ bottom = 24 }: ToasterProps) {
  const items = useSyncExternalStore(toastStore.subscribe, toastStore.getSnapshot, toastStore.getServerSnapshot);
  const style: CSSProperties = {
    position: 'fixed',
    left: '50%',
    bottom,
    transform: 'translateX(-50%)',
    zIndex: 110,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    width: 'max-content',
    maxWidth: 'calc(100vw - 32px)',
  };
  return (
    <div role="status" aria-live="polite" style={style}>
      {items.map((item) => (
        <ToastView key={item.id} item={item} />
      ))}
    </div>
  );
}
