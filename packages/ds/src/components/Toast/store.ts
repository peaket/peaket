// 토스트 저장소(앱 전체에 하나). toast('찜한 공연에 저장했습니다')로 띄우고 <Toaster />가 그린다.
// 서버에서는 부르지 않는다(누르기 같은 브라우저 동작에서만 부른다).
import type { ReactNode } from 'react';
import type { IconName } from '../../icons';
import type { ToastTone } from './Toast';

export interface ToastItem {
  id: number;
  message: ReactNode;
  tone: ToastTone;
  icon?: IconName;
  action?: ReactNode;
  /** 사라질 때까지(ms). 기본 5000(d2 CMP-018) */
  duration: number;
}

export interface ToastOptions {
  tone?: ToastTone;
  icon?: IconName;
  action?: ReactNode;
  duration?: number;
}

type Listener = () => void;
let items: readonly ToastItem[] = [];
let nextId = 1;
const listeners = new Set<Listener>();
const EMPTY: readonly ToastItem[] = [];

function emit() {
  for (const l of listeners) l();
}

/** 토스트를 띄우고 id를 돌려준다. 한 번에 셋까지 보이고, 넘치면 오래된 것부터 내린다 */
export function toast(message: ReactNode, options: ToastOptions = {}): number {
  const id = nextId++;
  const item: ToastItem = {
    id,
    message,
    tone: options.tone ?? 'success',
    icon: options.icon,
    action: options.action,
    duration: options.duration ?? 5000,
  };
  items = [...items, item].slice(-3);
  emit();
  return id;
}

toast.success = (message: ReactNode, options: Omit<ToastOptions, 'tone'> = {}) => toast(message, { ...options, tone: 'success' });
toast.info = (message: ReactNode, options: Omit<ToastOptions, 'tone'> = {}) => toast(message, { ...options, tone: 'info' });
toast.error = (message: ReactNode, options: Omit<ToastOptions, 'tone'> = {}) => toast(message, { ...options, tone: 'error' });

/** 토스트 하나를 내린다 */
export function dismissToast(id: number) {
  const next = items.filter((t) => t.id !== id);
  if (next.length !== items.length) {
    items = next;
    emit();
  }
}

export const toastStore = {
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => items,
  getServerSnapshot: () => EMPTY,
};
